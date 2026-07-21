import { describe, expect, test } from "bun:test"
import { context, wrap } from "@reatom/core"

import type { FailureDtoV1 } from "core/protocol"
import { createFakeChatStore, createFakeProjectStore } from "core/ports/fakes"

import { createChatDirectory } from "./chat-directory"
import { createChat } from "./create"

/**
 * Same testing note as `core/project/model/page-mutations.test.ts`: `ChatDirectory` is
 * Reatom-backed, and `context.start(cb)` pops its isolated frame the instant `cb()`
 * returns. Every test below calls `createChat(...)` SYNCHRONOUSLY inside
 * `context.start(() => {...})` (capturing the returned promise, never awaiting inside the
 * callback) and reads `directory.newestFirst()` only through a `wrap(...)`-captured
 * reader — never a bare post-await call.
 */

const FAILURE: FailureDtoV1 = { code: "PERSISTENCE_FAILED", retryable: false, safeMessage: "disk unavailable", details: {} }

describe("createChat", () => {
  test("creates a chat, selects it as active, and returns a chat.changed payload adding it", async () => {
    const { call, projectStore } = context.start(() => {
      const chats = createFakeChatStore()
      const projectStore = createFakeProjectStore({ root: "C:/proj" })
      const directory = createChatDirectory()
      return { call: createChat({ chats, projectStore, directory }), projectStore }
    })

    const result = await call

    if ("code" in result) throw result
    expect(result.added).toHaveLength(1)
    expect(result.added[0]?.chatId).toBe(result.activeChatId)
    expect(result.updated).toEqual([])
    expect(result.removedChatIds).toEqual([])

    const workspace = await projectStore.readWorkspaceState()
    if ("code" in workspace) throw workspace
    expect(workspace.state.activeChatId).toBe(result.activeChatId)
  })

  test("calls chats.create() BEFORE writing the new active chat id — one Kernel transaction, in order", async () => {
    const { call, order } = context.start(() => {
      const chats = createFakeChatStore()
      const projectStore = createFakeProjectStore({ root: "C:/proj" })
      const directory = createChatDirectory()
      const order: string[] = []
      const tracedChats: typeof chats = {
        ...chats,
        create: async () => {
          order.push("chats.create")
          return chats.create()
        },
      }
      const tracedProjectStore: typeof projectStore = {
        ...projectStore,
        writeWorkspaceState: async (patch) => {
          order.push("projectStore.writeWorkspaceState")
          return projectStore.writeWorkspaceState(patch)
        },
      }
      return { call: createChat({ chats: tracedChats, projectStore: tracedProjectStore, directory }), order }
    })

    await call

    expect(order).toEqual(["chats.create", "projectStore.writeWorkspaceState"])
  })

  test("records the new chat in the directory, newest first", async () => {
    const { call, readDirectory } = context.start(() => {
      const chats = createFakeChatStore()
      const projectStore = createFakeProjectStore({ root: "C:/proj" })
      const directory = createChatDirectory()
      return {
        call: createChat({ chats, projectStore, directory }),
        readDirectory: wrap(() => directory.newestFirst()),
      }
    })

    const result = await call
    if ("code" in result) throw result

    expect(readDirectory().map((c) => c.chatId)).toEqual([result.activeChatId])
  })

  test("propagates a chat-store failure without writing workspace state", async () => {
    const { call, projectStore, readDirectory } = context.start(() => {
      const chats = createFakeChatStore()
      chats.failNext("create", FAILURE)
      const projectStore = createFakeProjectStore({ root: "C:/proj" })
      const directory = createChatDirectory()
      return {
        call: createChat({ chats, projectStore, directory }),
        projectStore,
        readDirectory: wrap(() => directory.newestFirst()),
      }
    })

    const result = await call

    expect(result).toEqual(FAILURE)
    expect(projectStore.calls.some((c) => c.method === "writeWorkspaceState")).toBe(false)
    expect(readDirectory()).toEqual([])
  })

  test("propagates a workspace-state write failure", async () => {
    const { call } = context.start(() => {
      const chats = createFakeChatStore()
      const projectStore = createFakeProjectStore({ root: "C:/proj" })
      projectStore.failNext("writeWorkspaceState", FAILURE)
      const directory = createChatDirectory()
      return { call: createChat({ chats, projectStore, directory }) }
    })

    const result = await call

    expect(result).toEqual(FAILURE)
  })
})
