import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test } from "bun:test"

import { createSafeProjectFs, nodeSafeFsDeps, openManagedRoot } from "store/safe-fs"
import { sha256Hex } from "store/jsonl"

import type { TransactionBoundary, TransactionOperation, TransactionPlan } from "../types"
import { CHILD_TX_ERROR_EXIT_CODE, CRASH_EXIT_CODE, hasNoDuplicateAppendIdentity, runCrashCase, runPlanInChildProcess } from "./crash-harness"
import type { ChildPayload } from "./crash-harness"

const PAYLOAD_A = "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5da1"
const APPEND_PAYLOAD_A = "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5da3"
const RECORD_A = "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5db0"
const TS = "2026-07-20T10:00:00Z"

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

function base64Of(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64")
}

const roots: string[] = []

function freshTermcraftDir(): string {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "tc-crash-harness-"))
  const termcraftDir = path.join(scratch, ".termcraft")
  fs.mkdirSync(termcraftDir)
  roots.push(scratch)
  return termcraftDir
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

const BOUNDARIES: readonly TransactionBoundary[] = [
  "payload-installed",
  "plan-installed",
  "precondition-checked",
  "intent-installed",
  "operation-target-applied",
  "operation-marker-installed",
  "committed-installed",
]

/**
 * A three-operation plan touching every operation mode at once (replace/delete/append-jsonl)
 * — the widest surface available without a domain wrapper (T15 not yet landed; see this
 * module's own header comment). `workspace.local.toml`'s pre-existing content is written to
 * `termcraftDir` synchronously before the child ever starts, so its `oldImage` is real.
 */
function multiOpPlan(transactionId: string, termcraftDir: string): { plan: TransactionPlan; payloads: readonly ChildPayload[] } {
  const replaceBytes = bytesOf("fresh project config\n")
  const staleBytes = bytesOf("stale local state\n")
  // Carries RECORD_A's own recordId in the appended bytes, matching what a real
  // `buildChatAppend`-produced record does — `hasNoDuplicateAppendIdentity`'s string search
  // for `"<recordId>"` is otherwise trivially vacuous (minor finding #9): with no occurrence
  // of the id in the bytes at all, `countOccurrences(...) > 1` can never be true regardless
  // of whether the engine actually duplicated the append.
  const appendBytes = bytesOf(`{"kind":"chat","formatVersion":1,"recordId":"${RECORD_A}"}\n`)
  fs.writeFileSync(path.join(termcraftDir, "workspace.local.toml"), staleBytes)

  const operations: TransactionOperation[] = [
    { index: 0, target: "project.toml", mode: "replace", oldImage: { state: "absent" }, newImage: { state: "file", sha256: sha256Hex(replaceBytes), size: replaceBytes.byteLength }, payloadId: PAYLOAD_A },
    { index: 1, target: "workspace.local.toml", mode: "delete", oldImage: { state: "file", sha256: sha256Hex(staleBytes), size: staleBytes.byteLength }, newImage: { state: "absent" } },
    {
      index: 2,
      target: `chats/${transactionId}.jsonl`,
      mode: "append-jsonl",
      oldImage: { state: "absent" },
      newImage: { state: "file", sha256: sha256Hex(appendBytes), size: appendBytes.byteLength },
      append: {
        beforeLength: 0,
        beforePrefixSha256: sha256Hex(new Uint8Array(0)),
        appendedPayloadId: APPEND_PAYLOAD_A,
        appendedSha256: sha256Hex(appendBytes),
        appendedLength: appendBytes.byteLength,
        recordIds: [RECORD_A],
      },
    },
  ]

  const plan: TransactionPlan = { journalVersion: 1, transactionId, kind: "project-mutation", domain: {}, createdAt: TS, operations }
  const payloads: ChildPayload[] = [
    { payloadId: PAYLOAD_A, bytesBase64: base64Of(replaceBytes) },
    { payloadId: APPEND_PAYLOAD_A, bytesBase64: base64Of(appendBytes) },
  ]
  return { plan, payloads }
}

describe("crash-harness — control run (no crash)", () => {
  test("a real child completes the transaction normally", async () => {
    const termcraftDir = freshTermcraftDir()
    const TX_ID = "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5e00"
    const { plan, payloads } = multiOpPlan(TX_ID, termcraftDir)

    const outcome = await runCrashCase({ termcraftDir, plan, payloads, crash: { kind: "none" } })
    if (!outcome.ok) throw new Error(`fixture bug: ${outcome.error.message}`)

    expect(outcome.child.exitCode).toBe(0)
    expect(outcome.child.stdout).toContain("COMMITTED:")
    // The child already committed before dying of natural causes — recovery finds it complete
    // and takes no further action, rather than nothing to scan at all.
    expect(outcome.recovery).toEqual({ ok: true, recovered: 0, discarded: 0, alreadyComplete: 1 })
    expect(outcome.targetsState).toBe("all-new")
    expect(outcome.noDuplicateIdentity).toBe(true)
  }, 20_000)
})

describe("crash-harness — every §14.1 physical boundary the engine names", () => {
  for (const boundary of BOUNDARIES) {
    test(`a real child killed right after "${boundary}" recovers to exactly pre-intent or exactly committed — never mixed`, async () => {
      const termcraftDir = freshTermcraftDir()
      const TX_ID = "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5e10"
      const { plan, payloads } = multiOpPlan(TX_ID, termcraftDir)

      const outcome = await runCrashCase({ termcraftDir, plan, payloads, crash: { kind: "boundary", boundary } })
      if (!outcome.ok) throw new Error(`fixture bug: ${outcome.error.message}`)

      expect(outcome.child.exitCode).toBe(CRASH_EXIT_CODE)
      expect(outcome.recovery.ok).toBe(true)
      expect(outcome.targetsState === "all-old" || outcome.targetsState === "all-new").toBe(true)
      expect(outcome.noDuplicateIdentity).toBe(true)
    }, 20_000)
  }
})

describe("crash-harness — partial-append (a genuinely torn physical write)", () => {
  test("a real child that dies mid-write leaves a proven leading prefix; recovery truncates and completes it", async () => {
    const termcraftDir = freshTermcraftDir()
    const TX_ID = "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5e20"
    const prefix = bytesOf("header\n")
    fs.mkdirSync(path.join(termcraftDir, "chats"))
    fs.writeFileSync(path.join(termcraftDir, "chats", `${TX_ID}.jsonl`), prefix)

    // Carries RECORD_A's own recordId, same reasoning as `multiOpPlan` above.
    const appendBytes = bytesOf(`{"kind":"user","recordId":"${RECORD_A}"}\n`)
    const plan: TransactionPlan = {
      journalVersion: 1,
      transactionId: TX_ID,
      kind: "project-mutation",
      domain: {},
      createdAt: TS,
      operations: [
        {
          index: 0,
          target: `chats/${TX_ID}.jsonl`,
          mode: "append-jsonl",
          oldImage: { state: "file", sha256: sha256Hex(prefix), size: prefix.byteLength },
          newImage: { state: "file", sha256: sha256Hex(new Uint8Array([...prefix, ...appendBytes])), size: prefix.byteLength + appendBytes.byteLength },
          append: {
            beforeLength: prefix.byteLength,
            beforePrefixSha256: sha256Hex(prefix),
            appendedPayloadId: APPEND_PAYLOAD_A,
            appendedSha256: sha256Hex(appendBytes),
            appendedLength: appendBytes.byteLength,
            recordIds: [RECORD_A],
          },
        },
      ],
    }
    const payloads: ChildPayload[] = [{ payloadId: APPEND_PAYLOAD_A, bytesBase64: base64Of(appendBytes) }]

    const outcome = await runCrashCase({ termcraftDir, plan, payloads, crash: { kind: "partial-append", truncateAppendedBytesTo: 5 } })
    if (!outcome.ok) throw new Error(`fixture bug: ${outcome.error.message}`)

    expect(outcome.child.exitCode).toBe(CRASH_EXIT_CODE)
    expect(outcome.recovery).toEqual({ ok: true, recovered: 1, discarded: 0, alreadyComplete: 0 })
    expect(outcome.targetsState).toBe("all-new")
    expect(outcome.noDuplicateIdentity).toBe(true)
    expect(fs.readFileSync(path.join(termcraftDir, "chats", `${TX_ID}.jsonl`), "utf8")).toBe(`header\n{"kind":"user","recordId":"${RECORD_A}"}\n`)
  }, 20_000)
})

describe("hasNoDuplicateAppendIdentity — direct behavior (finding #9 regression)", () => {
  test("returns false when a target's realized bytes carry an append operation's recordId more than once", async () => {
    const termcraftDir = freshTermcraftDir()
    const TX_ID = "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5e40"
    fs.mkdirSync(path.join(termcraftDir, "chats"))
    // A hand-planted duplicate — simulates the exact bug this assertion exists to catch: the
    // engine appending the same prepared record twice.
    const duplicated = `header\n{"kind":"user","recordId":"${RECORD_A}"}\n{"kind":"user","recordId":"${RECORD_A}"}\n`
    fs.writeFileSync(path.join(termcraftDir, "chats", `${TX_ID}.jsonl`), duplicated)

    const plan: TransactionPlan = {
      journalVersion: 1,
      transactionId: TX_ID,
      kind: "turn",
      domain: {},
      createdAt: TS,
      operations: [
        {
          index: 0,
          target: `chats/${TX_ID}.jsonl`,
          mode: "append-jsonl",
          oldImage: { state: "absent" },
          newImage: { state: "file", sha256: sha256Hex(bytesOf(duplicated)), size: bytesOf(duplicated).byteLength },
          append: {
            beforeLength: 0,
            beforePrefixSha256: sha256Hex(new Uint8Array(0)),
            appendedPayloadId: APPEND_PAYLOAD_A,
            appendedSha256: sha256Hex(bytesOf(duplicated)),
            appendedLength: duplicated.length,
            recordIds: [RECORD_A],
          },
        },
      ],
    }

    const fsDeps = nodeSafeFsDeps()
    const root = openManagedRoot({ kind: "project", path: termcraftDir, deps: fsDeps })
    if (root instanceof Error) throw new Error(`fixture bug: ${root.message}`)
    const safeFs = createSafeProjectFs(root, fsDeps)

    expect(hasNoDuplicateAppendIdentity(safeFs, plan)).toBe(false)
  })
})

describe("runPlanInChildProcess — direct behavior", () => {
  test("reports a rejected plan distinctly from a crash", async () => {
    const termcraftDir = freshTermcraftDir()
    const TX_ID = "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5e30"
    const bytes = bytesOf("declared\n")
    const plan: TransactionPlan = {
      journalVersion: 1,
      transactionId: TX_ID,
      kind: "project-mutation",
      domain: {},
      createdAt: TS,
      operations: [{ index: 0, target: "project.toml", mode: "replace", oldImage: { state: "absent" }, newImage: { state: "file", sha256: sha256Hex(bytes), size: bytes.byteLength }, payloadId: PAYLOAD_A }],
    }
    const payloads: ChildPayload[] = [{ payloadId: PAYLOAD_A, bytesBase64: base64Of(bytesOf("tampered\n")) }]

    const result = await runPlanInChildProcess({ termcraftDir, plan, payloads, crash: { kind: "none" } })
    expect(result.exitCode).toBe(CHILD_TX_ERROR_EXIT_CODE)
    expect(result.stdout).toContain("TX_ERROR:JournalCorruptError")
    expect(fs.existsSync(path.join(termcraftDir, "transactions.local", TX_ID))).toBe(false)
  }, 20_000)
})
