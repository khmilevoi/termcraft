import { describe, expect, test } from "bun:test"

import { sha256Hex } from "store/jsonl"
import { MiB, StorageLimitExceededError } from "store/safe-fs"
import type { TransactionPlan } from "../types"
import {
  JournalCorruptError,
  JournalTooNewError,
  TRANSACTIONS_LOCAL_DIR,
  computePlanHash,
  decodePlan,
  encodeCanonicalJson,
  validatePlanPayloads,
} from "./plan"

const TX_ID = "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d10"
const OTHER_TX_ID = "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d99"
const PAYLOAD_ID = "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d11"
const RECORD_ID = "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d20"
const TS = "2026-07-20T10:00:00Z"

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

function replacePlan(): TransactionPlan {
  const bytes = bytesOf("hello world")
  return {
    journalVersion: 1,
    transactionId: TX_ID,
    kind: "project-mutation",
    domain: { actionId: TX_ID },
    createdAt: TS,
    operations: [
      {
        index: 0,
        target: "project.toml",
        mode: "replace",
        oldImage: { state: "absent" },
        newImage: { state: "file", sha256: sha256Hex(bytes), size: bytes.byteLength },
        payloadId: PAYLOAD_ID,
      },
    ],
  }
}

function appendPlan(): TransactionPlan {
  const appendBytes = bytesOf('{"kind":"pin:created"}\n')
  return {
    journalVersion: 1,
    transactionId: TX_ID,
    kind: "project-mutation",
    domain: {},
    createdAt: TS,
    operations: [
      {
        index: 0,
        target: "pages/home/comments.jsonl",
        mode: "append-jsonl",
        oldImage: { state: "file", sha256: sha256Hex(bytesOf("header\n")), size: 7 },
        newImage: { state: "file", sha256: sha256Hex(bytesOf(`header\n${'{"kind":"pin:created"}\n'}`)), size: 7 + appendBytes.byteLength },
        append: {
          beforeLength: 7,
          beforePrefixSha256: sha256Hex(bytesOf("header\n")),
          appendedPayloadId: PAYLOAD_ID,
          appendedSha256: sha256Hex(appendBytes),
          appendedLength: appendBytes.byteLength,
          recordIds: [RECORD_ID],
        },
      },
    ],
  }
}

describe("encodeCanonicalJson", () => {
  test("sorts object keys recursively, independent of insertion order", () => {
    const a = encodeCanonicalJson({ b: 1, a: { d: 2, c: 3 } })
    const b = encodeCanonicalJson({ a: { c: 3, d: 2 }, b: 1 })
    expect(new TextDecoder().decode(a)).toBe(new TextDecoder().decode(b))
    expect(new TextDecoder().decode(a)).toBe('{"a":{"c":3,"d":2},"b":1}')
  })

  test("preserves array order", () => {
    const bytes = encodeCanonicalJson({ items: [3, 1, 2] })
    expect(new TextDecoder().decode(bytes)).toBe('{"items":[3,1,2]}')
  })
})

describe("computePlanHash", () => {
  test("is deterministic and independent of the operations array's key order", () => {
    const plan = replacePlan()
    const reordered: TransactionPlan = { ...plan, operations: plan.operations.map((op) => ({ ...op })) }
    expect(computePlanHash(plan)).toBe(computePlanHash(reordered))
    expect(computePlanHash(plan)).toMatch(/^[0-9a-f]{64}$/)
  })

  test("changes when any field changes", () => {
    const plan = replacePlan()
    const changed: TransactionPlan = { ...plan, createdAt: "2026-07-20T10:00:01Z" }
    expect(computePlanHash(plan)).not.toBe(computePlanHash(changed))
  })
})

describe("decodePlan", () => {
  test("round-trips a valid replace plan", () => {
    const plan = replacePlan()
    const decoded = decodePlan(encodeCanonicalJson(plan))
    expect(decoded).toEqual(plan)
  })

  test("round-trips a valid append-jsonl plan", () => {
    const plan = appendPlan()
    const decoded = decodePlan(encodeCanonicalJson(plan))
    expect(decoded).toEqual(plan)
  })

  test("rejects bytes that are not valid JSON", () => {
    const result = decodePlan(bytesOf("not json"))
    expect(result).toBeInstanceOf(JournalCorruptError)
  })

  test("rejects a plan missing journalVersion", () => {
    const result = decodePlan(bytesOf(JSON.stringify({ transactionId: TX_ID })))
    expect(result).toBeInstanceOf(JournalCorruptError)
  })

  test("rejects a journalVersion newer than supported, distinctly from a corrupt plan", () => {
    const plan = { ...replacePlan(), journalVersion: 2 }
    const result = decodePlan(encodeCanonicalJson(plan))
    expect(result).toBeInstanceOf(JournalTooNewError)
    expect(result).not.toBeInstanceOf(JournalCorruptError)
  })

  test("rejects an operation whose mode/payload combination is inconsistent", () => {
    const plan = replacePlan()
    const corrupt = { ...plan, operations: [{ ...plan.operations[0], payloadId: undefined }] }
    const result = decodePlan(encodeCanonicalJson(corrupt))
    expect(result).toBeInstanceOf(JournalCorruptError)
  })

  test("rejects an append-jsonl operation whose oldImage disagrees with append.beforeLength/beforePrefixSha256", () => {
    const plan = appendPlan()
    const op = plan.operations[0]
    if (op === undefined || op.mode !== "append-jsonl") throw new Error("fixture bug")
    const corrupt = { ...plan, operations: [{ ...op, oldImage: { state: "absent" as const } }] }
    const result = decodePlan(encodeCanonicalJson(corrupt))
    expect(result).toBeInstanceOf(JournalCorruptError)
  })

  test("rejects duplicate operation indices", () => {
    const plan = replacePlan()
    const op = plan.operations[0]
    if (op === undefined) throw new Error("fixture bug")
    const corrupt = { ...plan, operations: [op, { ...op, target: "workspace.local.toml" }] }
    const result = decodePlan(encodeCanonicalJson(corrupt))
    expect(result).toBeInstanceOf(JournalCorruptError)
  })

  test("rejects an illegal managed target path", () => {
    const plan = replacePlan()
    const op = plan.operations[0]
    if (op === undefined) throw new Error("fixture bug")
    const corrupt = { ...plan, operations: [{ ...op, target: "../escape.toml" }] }
    const result = decodePlan(encodeCanonicalJson(corrupt))
    expect(result).toBeInstanceOf(JournalCorruptError)
  })

  // A journal-namespace target is a legal §5.1 relative path, so the grammar check alone
  // admits it. It must still be refused: recovery classifies each journal directory by
  // READING it, so a plan permitted to WRITE another transaction's `committed.json` (or its
  // own `applied/NNNN.json`) could forge a classification for a transaction recovery has not
  // reached yet — turn-durability §4.6's "classify before touching a target" only holds while
  // targets and the journal are disjoint sets.
  test.each([
    ["another transaction's committed marker", `${TRANSACTIONS_LOCAL_DIR}/${OTHER_TX_ID}/committed.json`],
    ["its own applied marker", `${TRANSACTIONS_LOCAL_DIR}/${TX_ID}/applied/0000.json`],
    ["the journal root itself", `${TRANSACTIONS_LOCAL_DIR}/anything.json`],
  ])("rejects a plan whose target is %s", (_label, target) => {
    const plan = replacePlan()
    const op = plan.operations[0]
    if (op === undefined) throw new Error("fixture bug")
    const corrupt = { ...plan, operations: [{ ...op, target }] }
    const result = decodePlan(encodeCanonicalJson(corrupt))
    expect(result).toBeInstanceOf(JournalCorruptError)
  })
})

describe("validatePlanPayloads", () => {
  test("accepts a replace plan whose payload matches its declared newImage", () => {
    const plan = replacePlan()
    const payloads = new Map([[PAYLOAD_ID, bytesOf("hello world")]])
    expect(validatePlanPayloads(plan, payloads)).toBeNull()
  })

  test("rejects a missing payload distinctly (PAYLOAD_MISSING)", () => {
    const plan = replacePlan()
    const result = validatePlanPayloads(plan, new Map())
    expect(result).toBeInstanceOf(JournalCorruptError)
    expect(result instanceof JournalCorruptError && result.code).toBe("PAYLOAD_MISSING")
  })

  test("rejects a payload whose bytes do not match the declared hash (PAYLOAD_HASH_MISMATCH)", () => {
    const plan = replacePlan()
    const payloads = new Map([[PAYLOAD_ID, bytesOf("tampered bytes")]])
    const result = validatePlanPayloads(plan, payloads)
    expect(result).toBeInstanceOf(JournalCorruptError)
    expect(result instanceof JournalCorruptError && result.code).toBe("PAYLOAD_HASH_MISMATCH")
  })

  test("accepts an append-jsonl plan whose append payload matches its declared hash/length", () => {
    const plan = appendPlan()
    const op = plan.operations[0]
    if (op === undefined || op.append === undefined) throw new Error("fixture bug")
    const payloads = new Map([[op.append.appendedPayloadId, bytesOf('{"kind":"pin:created"}\n')]])
    expect(validatePlanPayloads(plan, payloads)).toBeNull()
  })

  test("rejects an append-jsonl plan whose append payload hash disagrees", () => {
    const plan = appendPlan()
    const op = plan.operations[0]
    if (op === undefined || op.append === undefined) throw new Error("fixture bug")
    const payloads = new Map([[op.append.appendedPayloadId, bytesOf("wrong bytes\n")]])
    const result = validatePlanPayloads(plan, payloads)
    expect(result).toBeInstanceOf(JournalCorruptError)
    expect(result instanceof JournalCorruptError && result.code).toBe("PAYLOAD_HASH_MISMATCH")
  })

  // turn-durability §5.3: "An action that would exceed a limit fails before intent." (major
  // finding #6): before this fix, nothing here ever compared `newImage.size` against the
  // namespace's per-file ceiling, so an oversized operation would write intent, physically
  // apply, and only then wedge permanently in `transaction_io_pending` on the post-write
  // `SafeProjectFs.readFile` size check. These prove the plan is rejected pre-intent instead.
  test("rejects a replace operation whose declared newImage.size exceeds its namespace's per-file limit — before intent, with no payload required", () => {
    const plan = replacePlan()
    const op = plan.operations[0]
    if (op === undefined) throw new Error("fixture bug")
    // "project.toml" classifies as `project-config` (1 MiB per-file limit).
    const oversized = { ...op, newImage: { state: "file" as const, sha256: op.newImage.state === "file" ? op.newImage.sha256 : "", size: 1 * MiB + 1 } }
    const plan2: TransactionPlan = { ...plan, operations: [oversized] }

    // No payload at all in the map — proves the size gate fires before the payload-presence
    // check, matching "fails before intent" rather than surfacing as PAYLOAD_MISSING.
    const result = validatePlanPayloads(plan2, new Map())
    expect(result).toBeInstanceOf(StorageLimitExceededError)
    expect(result instanceof StorageLimitExceededError && result.limit).toBe("project-config per-file")
    expect(result instanceof StorageLimitExceededError && result.measured).toBe(1 * MiB + 1)
    expect(result instanceof StorageLimitExceededError && result.allowed).toBe(1 * MiB)
  })

  test("rejects an append-jsonl operation whose declared newImage.size exceeds its namespace's per-file limit", () => {
    const plan = appendPlan()
    const op = plan.operations[0]
    if (op === undefined || op.append === undefined) throw new Error("fixture bug")
    // "pages/home/comments.jsonl" classifies as `comments-jsonl` (32 MiB per-file limit).
    const oversized = { ...op, newImage: { state: "file" as const, sha256: op.newImage.state === "file" ? op.newImage.sha256 : "", size: 32 * MiB + 1 } }
    const plan2: TransactionPlan = { ...plan, operations: [oversized] }

    const result = validatePlanPayloads(plan2, new Map())
    expect(result).toBeInstanceOf(StorageLimitExceededError)
    expect(result instanceof StorageLimitExceededError && result.limit).toBe("comments-jsonl per-file")
  })

  test("accepts a replace operation at exactly its namespace's per-file boundary", () => {
    const bytes = new Uint8Array(1 * MiB)
    const plan: TransactionPlan = {
      journalVersion: 1,
      transactionId: TX_ID,
      kind: "project-mutation",
      domain: {},
      createdAt: TS,
      operations: [
        {
          index: 0,
          target: "project.toml",
          mode: "replace",
          oldImage: { state: "absent" },
          newImage: { state: "file", sha256: sha256Hex(bytes), size: bytes.byteLength },
          payloadId: PAYLOAD_ID,
        },
      ],
    }
    const result = validatePlanPayloads(plan, new Map([[PAYLOAD_ID, bytes]]))
    expect(result).toBeNull()
  })
})
