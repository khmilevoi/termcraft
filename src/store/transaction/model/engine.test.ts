import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { sha256Hex } from "store/jsonl"
import { createSafeProjectFs, nodeSafeFsDeps, openManagedRoot } from "store/safe-fs"
import type { SafeProjectFs } from "store/safe-fs"
import type { TransactionBoundary, TransactionOperation, TransactionPlan } from "../types"
import { JournalCorruptError } from "./plan"
import { WritePermitInvalidError, createWriteMutex } from "./write-mutex"
import {
  TransactionRecoveryConflictError,
  classifyAppendTail,
  loadTransactionPayloads,
  nodeTransactionFsDeps,
  readPlan,
  runTransaction,
} from "./engine"

const TX_ID = "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d10"
const PAYLOAD_A = "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5da1"
const PAYLOAD_B = "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5da2"
const APPEND_PAYLOAD = "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5da3"
const RECORD_ID = "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5db0"
const TS = "2026-07-20T10:00:00Z"

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

let scratch = ""
let termcraftDir = ""

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "tc-transaction-"))
  termcraftDir = path.join(scratch, ".termcraft")
  fs.mkdirSync(termcraftDir)
})

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true })
})

function openSafeFs(): SafeProjectFs {
  const deps = nodeSafeFsDeps()
  const root = openManagedRoot({ kind: "project", path: termcraftDir, deps })
  if (root instanceof Error) throw new Error(`openManagedRoot failed: ${root.message}`)
  return createSafeProjectFs(root, deps)
}

function blankPlan(operations: readonly TransactionOperation[], transactionId = TX_ID): TransactionPlan {
  return {
    journalVersion: 1,
    transactionId,
    kind: "project-mutation",
    domain: { actionId: transactionId },
    createdAt: TS,
    operations,
  }
}

describe("classifyAppendTail", () => {
  const prefix = bytesOf("header\n")
  const appendBytes = bytesOf('{"kind":"pin:created"}\n')
  const append = {
    beforeLength: prefix.byteLength,
    beforePrefixSha256: sha256Hex(prefix),
    appendedPayloadId: APPEND_PAYLOAD,
    appendedSha256: sha256Hex(appendBytes),
    appendedLength: appendBytes.byteLength,
    recordIds: [RECORD_ID],
  }

  test("classifies an unstarted append (exact old prefix, no suffix)", () => {
    expect(classifyAppendTail({ currentBytes: prefix, append, appendBytes })).toBe("not-started")
  })

  test("classifies a complete append (full prefix + full append bytes)", () => {
    const full = new Uint8Array([...prefix, ...appendBytes])
    expect(classifyAppendTail({ currentBytes: full, append, appendBytes })).toBe("complete")
  })

  test("classifies an interrupted partial append as a proven leading-prefix", () => {
    const partial = new Uint8Array([...prefix, ...appendBytes.subarray(0, 5)])
    expect(classifyAppendTail({ currentBytes: partial, append, appendBytes })).toBe("leading-prefix")
  })

  test("classifies a rewritten prefix as a conflict", () => {
    const rewritten = new Uint8Array([...bytesOf("HEADER\n"), ...appendBytes])
    expect(classifyAppendTail({ currentBytes: rewritten, append, appendBytes })).toBe("conflict")
  })

  test("classifies a suffix that diverges from the prepared bytes as a conflict", () => {
    const diverged = new Uint8Array([...prefix, ...bytesOf("not the prepared bytes\n")])
    expect(classifyAppendTail({ currentBytes: diverged, append, appendBytes })).toBe("conflict")
  })

  test("classifies truncation before the old prefix length as a conflict", () => {
    expect(classifyAppendTail({ currentBytes: prefix.subarray(0, 3), append, appendBytes })).toBe("conflict")
  })
})

describe("runTransaction — replace", () => {
  test("installs a brand-new file (oldImage absent) and commits", async () => {
    const safeFs = openSafeFs()
    const deps = nodeTransactionFsDeps(safeFs)
    const mutex = createWriteMutex()
    const permit = await mutex.acquire()

    const bytes = bytesOf('format_version = 1\nproject_id = "x"\n')
    const plan = blankPlan([
      {
        index: 0,
        target: "project.toml",
        mode: "replace",
        oldImage: { state: "absent" },
        newImage: { state: "file", sha256: sha256Hex(bytes), size: bytes.byteLength },
        payloadId: PAYLOAD_A,
      },
    ])

    const result = await runTransaction(deps, { mutex, permit, plan, payloads: new Map([[PAYLOAD_A, bytes]]) })
    if (result instanceof Error) throw new Error(`unexpected error: ${result.message}`)

    const firstOp = plan.operations[0]
    if (firstOp === undefined) throw new Error("fixture bug")
    expect(result.operations).toEqual([{ index: 0, realizedImage: firstOp.newImage }])
    expect(fs.readFileSync(path.join(termcraftDir, "project.toml"))).toEqual(Buffer.from(bytes))
    expect(fs.existsSync(path.join(termcraftDir, "transactions.local", TX_ID, "committed.json"))).toBe(true)
  })

  test("replaces an existing file (oldImage a real prior file)", async () => {
    fs.writeFileSync(path.join(termcraftDir, "project.toml"), "old contents\n")
    const safeFs = openSafeFs()
    const deps = nodeTransactionFsDeps(safeFs)
    const mutex = createWriteMutex()
    const permit = await mutex.acquire()

    const oldBytes = bytesOf("old contents\n")
    const newBytes = bytesOf("new contents\n")
    const plan = blankPlan([
      {
        index: 0,
        target: "project.toml",
        mode: "replace",
        oldImage: { state: "file", sha256: sha256Hex(oldBytes), size: oldBytes.byteLength },
        newImage: { state: "file", sha256: sha256Hex(newBytes), size: newBytes.byteLength },
        payloadId: PAYLOAD_A,
      },
    ])

    const result = await runTransaction(deps, { mutex, permit, plan, payloads: new Map([[PAYLOAD_A, newBytes]]) })
    if (result instanceof Error) throw new Error(`unexpected error: ${result.message}`)
    expect(fs.readFileSync(path.join(termcraftDir, "project.toml"), "utf8")).toBe("new contents\n")
  })
})

describe("runTransaction — delete", () => {
  test("deletes an existing file", async () => {
    fs.writeFileSync(path.join(termcraftDir, "workspace.local.toml"), "local state\n")
    const safeFs = openSafeFs()
    const deps = nodeTransactionFsDeps(safeFs)
    const mutex = createWriteMutex()
    const permit = await mutex.acquire()

    const oldBytes = bytesOf("local state\n")
    const plan = blankPlan([
      {
        index: 0,
        target: "workspace.local.toml",
        mode: "delete",
        oldImage: { state: "file", sha256: sha256Hex(oldBytes), size: oldBytes.byteLength },
        newImage: { state: "absent" },
      },
    ])

    const result = await runTransaction(deps, { mutex, permit, plan, payloads: new Map() })
    if (result instanceof Error) throw new Error(`unexpected error: ${result.message}`)
    expect(fs.existsSync(path.join(termcraftDir, "workspace.local.toml"))).toBe(false)
  })
})

describe("runTransaction — append-jsonl", () => {
  test("creates a brand-new JSONL file from an empty append (beforeLength 0)", async () => {
    const safeFs = openSafeFs()
    const deps = nodeTransactionFsDeps(safeFs)
    const mutex = createWriteMutex()
    const permit = await mutex.acquire()

    const appendBytes = bytesOf('{"kind":"chat","formatVersion":1}\n')
    const plan = blankPlan([
      {
        index: 0,
        target: `chats/${TX_ID}.jsonl`,
        mode: "append-jsonl",
        oldImage: { state: "absent" },
        newImage: { state: "file", sha256: sha256Hex(appendBytes), size: appendBytes.byteLength },
        append: {
          beforeLength: 0,
          beforePrefixSha256: sha256Hex(new Uint8Array(0)),
          appendedPayloadId: APPEND_PAYLOAD,
          appendedSha256: sha256Hex(appendBytes),
          appendedLength: appendBytes.byteLength,
          recordIds: [RECORD_ID],
        },
      },
    ])

    const result = await runTransaction(deps, { mutex, permit, plan, payloads: new Map([[APPEND_PAYLOAD, appendBytes]]) })
    if (result instanceof Error) throw new Error(`unexpected error: ${result.message}`)
    expect(fs.readFileSync(path.join(termcraftDir, "chats", `${TX_ID}.jsonl`), "utf8")).toBe('{"kind":"chat","formatVersion":1}\n')
  })

  test("appends to an existing JSONL file", async () => {
    const chatPath = path.join(termcraftDir, "chats")
    fs.mkdirSync(chatPath)
    fs.writeFileSync(path.join(chatPath, `${TX_ID}.jsonl`), "header-line\n")

    const safeFs = openSafeFs()
    const deps = nodeTransactionFsDeps(safeFs)
    const mutex = createWriteMutex()
    const permit = await mutex.acquire()

    const prefix = bytesOf("header-line\n")
    const appendBytes = bytesOf('{"kind":"user"}\n')
    const plan = blankPlan([
      {
        index: 0,
        target: `chats/${TX_ID}.jsonl`,
        mode: "append-jsonl",
        oldImage: { state: "file", sha256: sha256Hex(prefix), size: prefix.byteLength },
        newImage: { state: "file", sha256: sha256Hex(new Uint8Array([...prefix, ...appendBytes])), size: prefix.byteLength + appendBytes.byteLength },
        append: {
          beforeLength: prefix.byteLength,
          beforePrefixSha256: sha256Hex(prefix),
          appendedPayloadId: APPEND_PAYLOAD,
          appendedSha256: sha256Hex(appendBytes),
          appendedLength: appendBytes.byteLength,
          recordIds: [RECORD_ID],
        },
      },
    ])

    const result = await runTransaction(deps, { mutex, permit, plan, payloads: new Map([[APPEND_PAYLOAD, appendBytes]]) })
    if (result instanceof Error) throw new Error(`unexpected error: ${result.message}`)
    expect(fs.readFileSync(path.join(chatPath, `${TX_ID}.jsonl`), "utf8")).toBe('header-line\n{"kind":"user"}\n')
  })
})

describe("runTransaction — multi-file plan, applied in index order", () => {
  test("replace + delete + append in one transaction", async () => {
    fs.writeFileSync(path.join(termcraftDir, "workspace.local.toml"), "stale\n")
    const safeFs = openSafeFs()
    const deps = nodeTransactionFsDeps(safeFs)
    const mutex = createWriteMutex()
    const permit = await mutex.acquire()

    const replaceBytes = bytesOf("fresh project toml\n")
    const staleBytes = bytesOf("stale\n")
    const appendBytes = bytesOf('{"kind":"chat"}\n')

    // Operations are listed OUT of index order to prove the engine sorts by `index`, not array position.
    const plan = blankPlan([
      {
        index: 2,
        target: `chats/${TX_ID}.jsonl`,
        mode: "append-jsonl",
        oldImage: { state: "absent" },
        newImage: { state: "file", sha256: sha256Hex(appendBytes), size: appendBytes.byteLength },
        append: {
          beforeLength: 0,
          beforePrefixSha256: sha256Hex(new Uint8Array(0)),
          appendedPayloadId: APPEND_PAYLOAD,
          appendedSha256: sha256Hex(appendBytes),
          appendedLength: appendBytes.byteLength,
          recordIds: [RECORD_ID],
        },
      },
      {
        index: 0,
        target: "project.toml",
        mode: "replace",
        oldImage: { state: "absent" },
        newImage: { state: "file", sha256: sha256Hex(replaceBytes), size: replaceBytes.byteLength },
        payloadId: PAYLOAD_A,
      },
      {
        index: 1,
        target: "workspace.local.toml",
        mode: "delete",
        oldImage: { state: "file", sha256: sha256Hex(staleBytes), size: staleBytes.byteLength },
        newImage: { state: "absent" },
      },
    ])

    const result = await runTransaction(deps, {
      mutex,
      permit,
      plan,
      payloads: new Map([
        [PAYLOAD_A, replaceBytes],
        [APPEND_PAYLOAD, appendBytes],
      ]),
    })
    if (result instanceof Error) throw new Error(`unexpected error: ${result.message}`)

    expect(result.operations.map((op) => op.index)).toEqual([0, 1, 2])
    expect(fs.readFileSync(path.join(termcraftDir, "project.toml"), "utf8")).toBe("fresh project toml\n")
    expect(fs.existsSync(path.join(termcraftDir, "workspace.local.toml"))).toBe(false)
    expect(fs.readFileSync(path.join(termcraftDir, "chats", `${TX_ID}.jsonl`), "utf8")).toBe('{"kind":"chat"}\n')
  })
})

describe("runTransaction — old/new/neither image branches", () => {
  test("new-image branch: a target already installed before its marker is an ambiguous prior install, marked without rewriting", async () => {
    const bytes = bytesOf("already installed\n")
    fs.writeFileSync(path.join(termcraftDir, "project.toml"), bytes)

    const safeFs = openSafeFs()
    const deps = nodeTransactionFsDeps(safeFs)
    const mutex = createWriteMutex()
    const permit = await mutex.acquire()

    const plan = blankPlan([
      {
        index: 0,
        target: "project.toml",
        mode: "replace",
        oldImage: { state: "absent" }, // the planned OLD image never matched — target already shows the NEW image
        newImage: { state: "file", sha256: sha256Hex(bytes), size: bytes.byteLength },
        payloadId: PAYLOAD_A,
      },
    ])

    // The payload must still match the declared newImage (§4.3 step 3 validates that
    // regardless of target state) — but a spy on `durableWrite` proves the engine never
    // issues a physical write for this operation: the ambiguous-install branch only marks.
    let durableWrites = 0
    const spiedDeps = { ...deps, durableWrite: (absPath: string, content: Uint8Array) => { durableWrites += 1; return deps.durableWrite(absPath, content) } }
    const result = await runTransaction(spiedDeps, { mutex, permit, plan, payloads: new Map([[PAYLOAD_A, bytes]]) })
    if (result instanceof Error) throw new Error(`unexpected error: ${result.message}`)

    expect(fs.readFileSync(path.join(termcraftDir, "project.toml"), "utf8")).toBe("already installed\n")
    // The journal writes (payload, plan, intent, applied marker, committed = 5) DO go through
    // durableWrite; only the TARGET write is skipped. A sixth call would mean it re-wrote the target.
    expect(durableWrites).toBe(5)
  })

  test("neither branch: an unrelated target state is a durable recovery conflict, never overwritten", async () => {
    fs.writeFileSync(path.join(termcraftDir, "project.toml"), "unrelated hostile content\n")

    const safeFs = openSafeFs()
    const deps = nodeTransactionFsDeps(safeFs)
    const mutex = createWriteMutex()
    const permit = await mutex.acquire()

    const oldBytes = bytesOf("expected old\n")
    const newBytes = bytesOf("expected new\n")
    const plan = blankPlan([
      {
        index: 0,
        target: "project.toml",
        mode: "replace",
        oldImage: { state: "file", sha256: sha256Hex(oldBytes), size: oldBytes.byteLength },
        newImage: { state: "file", sha256: sha256Hex(newBytes), size: newBytes.byteLength },
        payloadId: PAYLOAD_A,
      },
    ])

    const result = await runTransaction(deps, { mutex, permit, plan, payloads: new Map([[PAYLOAD_A, newBytes]]) })
    expect(result).toBeInstanceOf(TransactionRecoveryConflictError)
    expect(fs.readFileSync(path.join(termcraftDir, "project.toml"), "utf8")).toBe("unrelated hostile content\n")
    expect(fs.existsSync(path.join(termcraftDir, "transactions.local", TX_ID, "conflict.json"))).toBe(true)
    // Never reaches committed — the conflict is durable and terminal.
    expect(fs.existsSync(path.join(termcraftDir, "transactions.local", TX_ID, "committed.json"))).toBe(false)
  })
})

describe("runTransaction — rejected distinctly before any target is touched", () => {
  test("a missing payload is rejected and nothing is written to the journal", async () => {
    const safeFs = openSafeFs()
    const deps = nodeTransactionFsDeps(safeFs)
    const mutex = createWriteMutex()
    const permit = await mutex.acquire()

    const bytes = bytesOf("x")
    const plan = blankPlan([
      { index: 0, target: "project.toml", mode: "replace", oldImage: { state: "absent" }, newImage: { state: "file", sha256: sha256Hex(bytes), size: 1 }, payloadId: PAYLOAD_A },
    ])

    const result = await runTransaction(deps, { mutex, permit, plan, payloads: new Map() })
    expect(result).toBeInstanceOf(JournalCorruptError)
    expect(result instanceof JournalCorruptError && result.code).toBe("PAYLOAD_MISSING")
    expect(fs.existsSync(path.join(termcraftDir, "transactions.local", TX_ID))).toBe(false)
  })

  test("a wrong payload hash is rejected distinctly and nothing is written to the journal", async () => {
    const safeFs = openSafeFs()
    const deps = nodeTransactionFsDeps(safeFs)
    const mutex = createWriteMutex()
    const permit = await mutex.acquire()

    const declared = bytesOf("declared bytes")
    const plan = blankPlan([
      {
        index: 0,
        target: "project.toml",
        mode: "replace",
        oldImage: { state: "absent" },
        newImage: { state: "file", sha256: sha256Hex(declared), size: declared.byteLength },
        payloadId: PAYLOAD_A,
      },
    ])

    const result = await runTransaction(deps, { mutex, permit, plan, payloads: new Map([[PAYLOAD_A, bytesOf("tampered")]]) })
    expect(result).toBeInstanceOf(JournalCorruptError)
    expect(result instanceof JournalCorruptError && result.code).toBe("PAYLOAD_HASH_MISMATCH")
    expect(fs.existsSync(path.join(termcraftDir, "transactions.local", TX_ID))).toBe(false)
  })
})

describe("runTransaction — write-mutex integration", () => {
  test("an invalidated (released) permit is rejected before writing anything", async () => {
    const safeFs = openSafeFs()
    const deps = nodeTransactionFsDeps(safeFs)
    const mutex = createWriteMutex()
    const permit = await mutex.acquire()
    mutex.release(permit)

    const bytes = bytesOf("x")
    const plan = blankPlan([
      { index: 0, target: "project.toml", mode: "replace", oldImage: { state: "absent" }, newImage: { state: "file", sha256: sha256Hex(bytes), size: 1 }, payloadId: PAYLOAD_A },
    ])

    const result = await runTransaction(deps, { mutex, permit, plan, payloads: new Map([[PAYLOAD_A, bytes]]) })
    expect(result).toBeInstanceOf(WritePermitInvalidError)
    expect(fs.existsSync(path.join(termcraftDir, "transactions.local", TX_ID))).toBe(false)
  })

  test("a stale writer whose permit was superseded by a later acquirer is denied", async () => {
    const safeFs = openSafeFs()
    const deps = nodeTransactionFsDeps(safeFs)
    const mutex = createWriteMutex()
    const stale = await mutex.acquire()
    mutex.release(stale)
    await mutex.acquire() // someone else now holds the mutex

    const bytes = bytesOf("x")
    const plan = blankPlan([
      { index: 0, target: "project.toml", mode: "replace", oldImage: { state: "absent" }, newImage: { state: "file", sha256: sha256Hex(bytes), size: 1 }, payloadId: PAYLOAD_A },
    ])

    const result = await runTransaction(deps, { mutex, permit: stale, plan, payloads: new Map([[PAYLOAD_A, bytes]]) })
    expect(result).toBeInstanceOf(WritePermitInvalidError)
  })
})

describe("runTransaction — crash-boundary hook + idempotent resume", () => {
  test("onBoundary fires once per named boundary, in protocol order", async () => {
    const safeFs = openSafeFs()
    const seen: TransactionBoundary[] = []
    const deps = nodeTransactionFsDeps(safeFs)
    const mutex = createWriteMutex()
    const permit = await mutex.acquire()

    const bytes = bytesOf("x")
    const plan = blankPlan([
      { index: 0, target: "project.toml", mode: "replace", oldImage: { state: "absent" }, newImage: { state: "file", sha256: sha256Hex(bytes), size: 1 }, payloadId: PAYLOAD_A },
    ])

    const result = await runTransaction(
      { ...deps, onBoundary: (name) => seen.push(name) },
      { mutex, permit, plan, payloads: new Map([[PAYLOAD_A, bytes]]) },
    )
    if (result instanceof Error) throw new Error(`unexpected error: ${result.message}`)

    expect(seen).toEqual([
      "payload-installed",
      "plan-installed",
      "precondition-checked",
      "intent-installed",
      "operation-target-applied",
      "operation-marker-installed",
      "committed-installed",
    ])
  })

  test("resuming after a simulated crash right after intent completes the same transaction idempotently", async () => {
    const safeFs = openSafeFs()
    const mutex = createWriteMutex()

    const bytesA = bytesOf("aaaa")
    const bytesB = bytesOf("bbbb")
    const plan = blankPlan([
      { index: 0, target: "project.toml", mode: "replace", oldImage: { state: "absent" }, newImage: { state: "file", sha256: sha256Hex(bytesA), size: 4 }, payloadId: PAYLOAD_A },
      { index: 1, target: "workspace.local.toml", mode: "replace", oldImage: { state: "absent" }, newImage: { state: "file", sha256: sha256Hex(bytesB), size: 4 }, payloadId: PAYLOAD_B },
    ])
    const payloads = new Map([
      [PAYLOAD_A, bytesA],
      [PAYLOAD_B, bytesB],
    ])

    class SimulatedCrash extends Error {}
    const crashingDeps = { ...nodeTransactionFsDeps(safeFs), onBoundary: (name: TransactionBoundary) => {
      if (name === "intent-installed") throw new SimulatedCrash("boundary crash")
    } }

    const firstPermit = await mutex.acquire()
    await expect(runTransaction(crashingDeps, { mutex, permit: firstPermit, plan, payloads })).rejects.toBeInstanceOf(SimulatedCrash)

    // Neither target landed — intent was the last durable artifact.
    expect(fs.existsSync(path.join(termcraftDir, "project.toml"))).toBe(false)
    expect(fs.existsSync(path.join(termcraftDir, "transactions.local", TX_ID, "intent.json"))).toBe(true)
    expect(fs.existsSync(path.join(termcraftDir, "transactions.local", TX_ID, "committed.json"))).toBe(false)

    // "Reopen": read the durable plan back and resume with a plain (non-crashing) deps object.
    mutex.release(firstPermit)
    const secondPermit = await mutex.acquire()
    const reopenedDeps = nodeTransactionFsDeps(safeFs)
    const reopenedPlan = readPlan(reopenedDeps, TX_ID)
    if (reopenedPlan instanceof Error) throw new Error(`unexpected error: ${reopenedPlan.message}`)
    if (reopenedPlan === null) throw new Error("expected plan.json to already be durable")
    const reopenedPayloads = loadTransactionPayloads(reopenedDeps, reopenedPlan)
    if (reopenedPayloads instanceof Error) throw new Error(`unexpected error: ${reopenedPayloads.message}`)

    const resumed = await runTransaction(reopenedDeps, { mutex, permit: secondPermit, plan: reopenedPlan, payloads: reopenedPayloads })
    if (resumed instanceof Error) throw new Error(`unexpected error: ${resumed.message}`)

    expect(fs.readFileSync(path.join(termcraftDir, "project.toml"), "utf8")).toBe("aaaa")
    expect(fs.readFileSync(path.join(termcraftDir, "workspace.local.toml"), "utf8")).toBe("bbbb")
    expect(fs.existsSync(path.join(termcraftDir, "transactions.local", TX_ID, "committed.json"))).toBe(true)
  })
})
