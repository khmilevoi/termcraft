import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test } from "bun:test"

import { parsePageSlug } from "entities/page"
import type { PageSlug } from "entities/page"
import type { PinCreatedEvent } from "entities/pin"
import { uuidv7 } from "infrastructure/uuid"
import { computeSessionPrefixHash } from "store/jsonl"

import type { StoreDeps } from "../types"
import { createStore, nodeStoreDeps } from "./factory"

// Blocker B3 (phase-6 plan §2): six MVP commands (`chat.create`, `page.renameTitle`,
// `page.reorder`, `page.removeConfirm`, `pin.setStatus`, `model.select`) plus active-page/
// active-chat writes and checkpoint persistence have no legal path while `store`'s public
// surface only exposes the four turn-shaped `TransactionEngine` methods. These tests prove
// each NAMED domain method actually round-trips through the real engine against a real
// project on disk — never a fake, since the whole point is proving the durable write lands.

const TS = "2026-07-21T10:00:00Z"

const scratchRoots: string[] = []

function freshScratch(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  scratchRoots.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of scratchRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function testDeps(userStateRoot: string): StoreDeps {
  return nodeStoreDeps({ userStateRoot })
}

function slug(value: string): PageSlug {
  const parsed = parsePageSlug(value)
  if (parsed instanceof Error) throw new Error(`fixture bug: ${parsed.message}`)
  return parsed
}

async function freshOpenProject() {
  const userStateRoot = freshScratch("tc-engine-methods-userstate-")
  const projectRoot = freshScratch("tc-engine-methods-project-")
  const store = createStore(testDeps(userStateRoot))
  const opened = await store.createProject({ root: projectRoot, name: "Engine Methods", targetStack: "generic" })
  if (opened instanceof Error) throw new Error(`fixture bug: createProject failed: ${opened.message}`)
  return opened
}

describe("TransactionEngine — named domain methods (phase-6 blocker B3)", () => {
  test("createChat mints a new chat header — chat.create", async () => {
    const opened = await freshOpenProject()
    try {
      const manifest = await opened.manifest.read()
      if (manifest instanceof Error) throw new Error(`fixture bug: ${manifest.message}`)

      const chatId = uuidv7()
      const result = await opened.transactions.createChat({
        transactionId: uuidv7(),
        actionId: uuidv7(),
        chatId,
        projectId: manifest.projectId,
        createdAt: TS,
      })
      if (result instanceof Error) throw result

      const handle = await opened.chats.open(chatId)
      if (handle instanceof Error) throw new Error(`fixture bug: chat unopenable: ${handle.message}`)
      expect(handle.header).toEqual({ kind: "chat", formatVersion: 1, projectId: manifest.projectId, chatId, createdAt: TS })
    } finally {
      await opened.close()
    }
  }, 20_000)

  test("createChat refuses to silently overwrite an existing chat at the same chatId", async () => {
    const opened = await freshOpenProject()
    try {
      const manifest = await opened.manifest.read()
      if (manifest instanceof Error) throw new Error(`fixture bug: ${manifest.message}`)
      const chatId = uuidv7()

      const first = await opened.transactions.createChat({ transactionId: uuidv7(), actionId: uuidv7(), chatId, projectId: manifest.projectId, createdAt: TS })
      if (first instanceof Error) throw first

      // A genuinely DIFFERENT second header at the same chatId (a different createdAt) — a
      // byte-identical replay of the exact same plan is idempotent by design (turn-durability
      // §4.3), so the collision this proves must actually differ from what is already there.
      const second = await opened.transactions.createChat({ transactionId: uuidv7(), actionId: uuidv7(), chatId, projectId: manifest.projectId, createdAt: "2026-07-21T11:00:00Z" })
      expect(second instanceof Error).toBe(true)
    } finally {
      await opened.close()
    }
  }, 20_000)

  test("setActiveChat writes workspace.local.toml's active_chat_id — active-chat writes", async () => {
    const opened = await freshOpenProject()
    try {
      const chatId = uuidv7()
      const result = await opened.transactions.setActiveChat({ transactionId: uuidv7(), actionId: uuidv7(), activeChatId: chatId, createdAt: TS })
      if (result instanceof Error) throw result

      const state = await opened.workspaceState.read()
      if (state instanceof Error) throw new Error(`fixture bug: ${state.message}`)
      expect(state.state.activeChatId).toBe(chatId)

      const cleared = await opened.transactions.setActiveChat({ transactionId: uuidv7(), actionId: uuidv7(), activeChatId: null, createdAt: TS })
      if (cleared instanceof Error) throw cleared
      const stateAfterClear = await opened.workspaceState.read()
      if (stateAfterClear instanceof Error) throw new Error(`fixture bug: ${stateAfterClear.message}`)
      expect(stateAfterClear.state.activeChatId).toBeNull()
    } finally {
      await opened.close()
    }
  }, 20_000)

  test("setActiveChat and setActivePage preserve every unrelated local field", async () => {
    // turn-durability §7.4: the workspace-local patch is "composed from the THEN-CURRENT
    // local file so unrelated preferences/session checkpoints are preserved". These two
    // methods ship a HARDCODED patch, so unlike setWorkspaceLocal they can silently
    // clobber siblings — and sessionCheckpoints drives 6F's resume-or-fresh decision, so
    // losing it would degrade every subsequent turn to a fresh session with no signal.
    const opened = await freshOpenProject()
    try {
      const seeded = await opened.transactions.setWorkspaceLocal({
        transactionId: uuidv7(),
        actionId: uuidv7(),
        patch: { backend: "claude-code", model: "sonnet-5" },
        createdAt: TS,
      })
      if (seeded instanceof Error) throw seeded

      const before = await opened.workspaceState.read()
      if (before instanceof Error) throw new Error(`fixture bug: ${before.message}`)

      const chatId = uuidv7()
      const chatWrite = await opened.transactions.setActiveChat({ transactionId: uuidv7(), actionId: uuidv7(), activeChatId: chatId, createdAt: TS })
      if (chatWrite instanceof Error) throw chatWrite

      const pageWrite = await opened.transactions.setActivePage({ transactionId: uuidv7(), actionId: uuidv7(), activePageSlug: slug("home"), createdAt: TS })
      if (pageWrite instanceof Error) throw pageWrite

      const after = await opened.workspaceState.read()
      if (after instanceof Error) throw new Error(`fixture bug: ${after.message}`)

      // The two fields each method OWNS moved...
      expect(after.state.activeChatId).toBe(chatId)
      expect(after.state.activePageSlug).toBe(slug("home"))
      // ...and every sibling survived both writes.
      expect(after.state.backend).toBe(before.state.backend)
      expect(after.state.model).toBe(before.state.model)
      expect(after.state.sessionCheckpoints).toEqual(before.state.sessionCheckpoints)
    } finally {
      await opened.close()
    }
  }, 20_000)

  test("setActivePage writes workspace.local.toml's active_page_slug — active-page writes", async () => {
    const opened = await freshOpenProject()
    try {
      const home = slug("home")
      const result = await opened.transactions.setActivePage({ transactionId: uuidv7(), actionId: uuidv7(), activePageSlug: home, createdAt: TS })
      if (result instanceof Error) throw result

      const state = await opened.workspaceState.read()
      if (state instanceof Error) throw new Error(`fixture bug: ${state.message}`)
      expect(state.state.activePageSlug).toBe(home)
    } finally {
      await opened.close()
    }
  }, 20_000)

  test("renamePageTitle replaces one canonical page's source bytes — page.renameTitle, both create and edit", async () => {
    const opened = await freshOpenProject()
    try {
      const home = slug("home")
      const v1 = new TextEncoder().encode("export const meta = { title: 'Home' }\n")
      const created = await opened.transactions.renamePageTitle({ transactionId: uuidv7(), actionId: uuidv7(), pageSlug: home, newBytes: v1, createdAt: TS })
      if (created instanceof Error) throw created

      const readV1 = await opened.pages.readSource(home)
      if (readV1 instanceof Error) throw new Error(`fixture bug: ${readV1.message}`)
      expect(new TextDecoder().decode(readV1.bytes)).toBe("export const meta = { title: 'Home' }\n")

      // Edit: the SAME page, new bytes — proves the oldImage CAS is observed fresh each call,
      // not merely a create-new that would conflict on a second write.
      const v2 = new TextEncoder().encode("export const meta = { title: 'Welcome Home' }\n")
      const edited = await opened.transactions.renamePageTitle({ transactionId: uuidv7(), actionId: uuidv7(), pageSlug: home, newBytes: v2, createdAt: TS })
      if (edited instanceof Error) throw edited

      const readV2 = await opened.pages.readSource(home)
      if (readV2 instanceof Error) throw new Error(`fixture bug: ${readV2.message}`)
      expect(new TextDecoder().decode(readV2.bytes)).toBe("export const meta = { title: 'Welcome Home' }\n")
    } finally {
      await opened.close()
    }
  }, 20_000)

  test("reorderPages rewrites project.toml's page order — page.reorder, including the already-current no-op", async () => {
    const opened = await freshOpenProject()
    try {
      const manifestEmpty = await opened.manifest.read()
      if (manifestEmpty instanceof Error) throw new Error(`fixture bug: ${manifestEmpty.message}`)
      expect(manifestEmpty.pages).toEqual([])

      const home = slug("home")
      const about = slug("about")
      const added = await opened.transactions.reorderPages({ transactionId: uuidv7(), actionId: uuidv7(), manifestBefore: manifestEmpty, orderedSlugs: [home, about], createdAt: TS })
      if (added instanceof Error) throw added

      const manifestAdded = await opened.manifest.read()
      if (manifestAdded instanceof Error) throw new Error(`fixture bug: ${manifestAdded.message}`)
      expect(manifestAdded.pages).toEqual([home, about])

      // Reorder to the opposite order.
      const reordered = await opened.transactions.reorderPages({ transactionId: uuidv7(), actionId: uuidv7(), manifestBefore: manifestAdded, orderedSlugs: [about, home], createdAt: TS })
      if (reordered instanceof Error) throw reordered
      const manifestReordered = await opened.manifest.read()
      if (manifestReordered instanceof Error) throw new Error(`fixture bug: ${manifestReordered.message}`)
      expect(manifestReordered.pages).toEqual([about, home])

      // Already-current order: a legal no-op transaction, not a special-cased rejection.
      const noop = await opened.transactions.reorderPages({ transactionId: uuidv7(), actionId: uuidv7(), manifestBefore: manifestReordered, orderedSlugs: [about, home], createdAt: TS })
      if (noop instanceof Error) throw noop
      expect(noop.operations).toEqual([])
      const manifestAfterNoop = await opened.manifest.read()
      if (manifestAfterNoop instanceof Error) throw new Error(`fixture bug: ${manifestAfterNoop.message}`)
      expect(manifestAfterNoop.pages).toEqual([about, home])
    } finally {
      await opened.close()
    }
  }, 20_000)

  test("removePage drops a page from the manifest and deletes its canonical source and comments log — page.removeConfirm", async () => {
    const opened = await freshOpenProject()
    try {
      const home = slug("home")
      const about = slug("about")

      const manifestEmpty = await opened.manifest.read()
      if (manifestEmpty instanceof Error) throw new Error(`fixture bug: ${manifestEmpty.message}`)
      const added = await opened.transactions.reorderPages({ transactionId: uuidv7(), actionId: uuidv7(), manifestBefore: manifestEmpty, orderedSlugs: [home, about], createdAt: TS })
      if (added instanceof Error) throw added

      const homeBytes = new TextEncoder().encode("export const meta = { title: 'Home' }\n")
      const wroteHome = await opened.transactions.renamePageTitle({ transactionId: uuidv7(), actionId: uuidv7(), pageSlug: home, newBytes: homeBytes, createdAt: TS })
      if (wroteHome instanceof Error) throw wroteHome

      const event: PinCreatedEvent = { kind: "pin:created", recordId: uuidv7(), pinId: uuidv7(), element: "button-1", fx: 0.5, fy: 0.5, text: "note", ts: TS }
      const pinned = await opened.transactions.appendPinEvent({ transactionId: uuidv7(), actionId: uuidv7(), pageSlug: home, projectId: manifestEmpty.projectId, event, createdAt: TS })
      if (pinned instanceof Error) throw pinned

      const manifestBefore = await opened.manifest.read()
      if (manifestBefore instanceof Error) throw new Error(`fixture bug: ${manifestBefore.message}`)
      const removed = await opened.transactions.removePage({ transactionId: uuidv7(), actionId: uuidv7(), manifestBefore, pageSlug: home, createdAt: TS })
      if (removed instanceof Error) throw removed

      const manifestAfter = await opened.manifest.read()
      if (manifestAfter instanceof Error) throw new Error(`fixture bug: ${manifestAfter.message}`)
      expect(manifestAfter.pages).toEqual([about])

      const sourceAfter = await opened.pages.readSource(home)
      expect(sourceAfter instanceof Error).toBe(true) // canonical source is gone

      const pinsAfter = await opened.pins.fold(home)
      expect(pinsAfter).toEqual([]) // comments log is gone too — folding an absent log is `[]`
    } finally {
      await opened.close()
    }
  }, 20_000)

  test("removePage on a page with no canonical source/comments yet is a clean no-op delete, not an error", async () => {
    const opened = await freshOpenProject()
    try {
      const home = slug("home")
      const manifestEmpty = await opened.manifest.read()
      if (manifestEmpty instanceof Error) throw new Error(`fixture bug: ${manifestEmpty.message}`)
      const added = await opened.transactions.reorderPages({ transactionId: uuidv7(), actionId: uuidv7(), manifestBefore: manifestEmpty, orderedSlugs: [home], createdAt: TS })
      if (added instanceof Error) throw added

      const manifestBefore = await opened.manifest.read()
      if (manifestBefore instanceof Error) throw new Error(`fixture bug: ${manifestBefore.message}`)
      const removed = await opened.transactions.removePage({ transactionId: uuidv7(), actionId: uuidv7(), manifestBefore, pageSlug: home, createdAt: TS })
      if (removed instanceof Error) throw removed

      const manifestAfter = await opened.manifest.read()
      if (manifestAfter instanceof Error) throw new Error(`fixture bug: ${manifestAfter.message}`)
      expect(manifestAfter.pages).toEqual([])
    } finally {
      await opened.close()
    }
  }, 20_000)

  test("appendPinEvent appends one comments-log event — pin.setStatus and standalone pin:created", async () => {
    const opened = await freshOpenProject()
    try {
      const manifest = await opened.manifest.read()
      if (manifest instanceof Error) throw new Error(`fixture bug: ${manifest.message}`)
      const home = slug("home")
      const pinId = uuidv7()
      const created: PinCreatedEvent = { kind: "pin:created", recordId: uuidv7(), pinId, element: "button-1", fx: 0.25, fy: 0.75, text: "looks off", ts: TS }
      const createdResult = await opened.transactions.appendPinEvent({ transactionId: uuidv7(), actionId: uuidv7(), pageSlug: home, projectId: manifest.projectId, event: created, createdAt: TS })
      if (createdResult instanceof Error) throw createdResult

      const pinsAfterCreate = await opened.pins.fold(home)
      if (pinsAfterCreate instanceof Error) throw new Error(`fixture bug: ${pinsAfterCreate.message}`)
      expect(pinsAfterCreate).toEqual([{ pinId, element: "button-1", fx: 0.25, fy: 0.75, text: "looks off", status: "open" }])

      // pin.setStatus: a user-driven resolve, `actionId` set (not `turnId`). The log already
      // exists after the create above, so this exercises the single-operation append branch.
      const resolved = await opened.transactions.appendPinEvent({
        transactionId: uuidv7(),
        actionId: uuidv7(),
        pageSlug: home,
        projectId: manifest.projectId,
        event: { kind: "pin:status", recordId: uuidv7(), pinId, status: "resolved", actionId: uuidv7(), ts: TS },
        createdAt: TS,
      })
      if (resolved instanceof Error) throw resolved

      const pinsAfterResolve = await opened.pins.fold(home)
      if (pinsAfterResolve instanceof Error) throw new Error(`fixture bug: ${pinsAfterResolve.message}`)
      expect(pinsAfterResolve).toEqual([{ pinId, element: "button-1", fx: 0.25, fy: 0.75, text: "looks off", status: "resolved" }])
    } finally {
      await opened.close()
    }
  }, 20_000)

  test("setWorkspaceLocal shallow-merges onto current state — model.select and every other local field", async () => {
    const opened = await freshOpenProject()
    try {
      const first = await opened.transactions.setWorkspaceLocal({ transactionId: uuidv7(), actionId: uuidv7(), patch: { backend: "claude-code" }, createdAt: TS })
      if (first instanceof Error) throw first

      // model.select: a SECOND call naming only `model` must not clobber the FIRST call's `backend`.
      const second = await opened.transactions.setWorkspaceLocal({ transactionId: uuidv7(), actionId: uuidv7(), patch: { model: "sonnet-5" }, createdAt: TS })
      if (second instanceof Error) throw second

      const state = await opened.workspaceState.read()
      if (state instanceof Error) throw new Error(`fixture bug: ${state.message}`)
      expect(state.state.backend).toBe("claude-code")
      expect(state.state.model).toBe("sonnet-5")
    } finally {
      await opened.close()
    }
  }, 20_000)

  test("advanceSessionCheckpoint hashes the target chat's current prefix and durably records it — checkpoint persistence", async () => {
    const opened = await freshOpenProject()
    try {
      const chatFiles = fs.readdirSync(path.join(opened.root, ".termcraft", "chats"))
      const chatId = chatFiles[0]?.replace(/\.jsonl$/, "")
      if (chatId === undefined) throw new Error("fixture bug: no chat file")

      const userRecord = { kind: "user" as const, recordId: uuidv7(), turnId: uuidv7(), text: "hello", ts: TS }
      const admitted = await opened.transactions.admitTurn({ transactionId: uuidv7(), turnId: userRecord.turnId, targetChatId: chatId, userRecord, createdAt: TS })
      if (admitted instanceof Error) throw admitted

      const sessionScopeId = "scope-a"
      const sessionId = uuidv7()
      const result = await opened.transactions.advanceSessionCheckpoint({
        transactionId: uuidv7(),
        actionId: uuidv7(),
        chatId,
        sessionScopeId,
        sessionId,
        recordCount: 1,
        createdAt: TS,
      })
      if (result instanceof Error) throw result

      const chatBytes = fs.readFileSync(path.join(opened.root, ".termcraft", "chats", `${chatId}.jsonl`))
      const expectedHash = computeSessionPrefixHash({ chunks: [chatBytes], recordCount: 1 })
      if (expectedHash instanceof Error) throw new Error(`fixture bug: ${expectedHash.message}`)

      const state = await opened.workspaceState.read()
      if (state instanceof Error) throw new Error(`fixture bug: ${state.message}`)
      expect(state.state.sessionCheckpoints).toEqual([{ chatId, sessionScopeId, sessionId, recordCount: 1, prefixHash: expectedHash.prefixHash }])

      // A second, DIFFERENT session scope on the same chat coexists alongside the first.
      const otherScopeId = "scope-b"
      const otherSessionId = uuidv7()
      const secondResult = await opened.transactions.advanceSessionCheckpoint({
        transactionId: uuidv7(),
        actionId: uuidv7(),
        chatId,
        sessionScopeId: otherScopeId,
        sessionId: otherSessionId,
        recordCount: 1,
        createdAt: TS,
      })
      if (secondResult instanceof Error) throw secondResult
      const stateAfterSecond = await opened.workspaceState.read()
      if (stateAfterSecond instanceof Error) throw new Error(`fixture bug: ${stateAfterSecond.message}`)
      expect(stateAfterSecond.state.sessionCheckpoints).toHaveLength(2)

      // Re-advancing the FIRST scope replaces its entry rather than appending a duplicate.
      const secondUserRecord = { kind: "user" as const, recordId: uuidv7(), turnId: uuidv7(), text: "again", ts: TS }
      const admittedAgain = await opened.transactions.admitTurn({ transactionId: uuidv7(), turnId: secondUserRecord.turnId, targetChatId: chatId, userRecord: secondUserRecord, createdAt: TS })
      if (admittedAgain instanceof Error) throw admittedAgain

      const readvanced = await opened.transactions.advanceSessionCheckpoint({
        transactionId: uuidv7(),
        actionId: uuidv7(),
        chatId,
        sessionScopeId,
        sessionId,
        recordCount: 2,
        createdAt: TS,
      })
      if (readvanced instanceof Error) throw readvanced
      const finalState = await opened.workspaceState.read()
      if (finalState instanceof Error) throw new Error(`fixture bug: ${finalState.message}`)
      expect(finalState.state.sessionCheckpoints).toHaveLength(2)
      const scopeAEntry = finalState.state.sessionCheckpoints.find((entry) => entry.sessionScopeId === sessionScopeId)
      expect(scopeAEntry?.recordCount).toBe(2)
    } finally {
      await opened.close()
    }
  }, 20_000)
})
