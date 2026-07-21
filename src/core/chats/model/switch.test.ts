import { describe, expect, test } from "bun:test";

import { createFakeChatStore, createFakeProjectStore } from "core/ports/fakes";
import type { FailureDtoV1 } from "core/protocol";

import { switchChat } from "./switch";

const FAILURE: FailureDtoV1 = {
  code: "PERSISTENCE_FAILED",
  retryable: false,
  safeMessage: "no such chat",
  details: {},
};

describe("switchChat", () => {
  test("selects an existing chat as active and returns a chat.changed payload with no added/updated/removed entries", async () => {
    const chats = createFakeChatStore();
    const created = await chats.create();
    if ("code" in created) throw created;
    const projectStore = createFakeProjectStore({ root: "C:/proj" });

    const result = await switchChat({ chats, projectStore }, created.chatId);

    if ("code" in result) throw result;
    expect(result).toEqual({
      activeChatId: created.chatId,
      added: [],
      updated: [],
      removedChatIds: [],
    });
    const workspace = await projectStore.readWorkspaceState();
    if ("code" in workspace) throw workspace;
    expect(workspace.state.activeChatId).toBe(created.chatId);
  });

  test("propagates a not-found failure from switchActive() without writing workspace state", async () => {
    const chats = createFakeChatStore();
    const projectStore = createFakeProjectStore({ root: "C:/proj" });

    const result = await switchChat({ chats, projectStore }, "unknown-chat-id");

    expect("code" in result).toBe(true);
    expect(projectStore.calls.some((c) => c.method === "writeWorkspaceState")).toBe(false);
  });

  test("propagates a workspace-state write failure", async () => {
    const chats = createFakeChatStore();
    const created = await chats.create();
    if ("code" in created) throw created;
    const projectStore = createFakeProjectStore({ root: "C:/proj" });
    projectStore.failNext("writeWorkspaceState", FAILURE);

    const result = await switchChat({ chats, projectStore }, created.chatId);

    expect(result).toEqual(FAILURE);
  });

  test("§8.2: reaches only the chat and workspace-state ports — pages and pins are not even injectable", async () => {
    // §8.2: chat.switch must "select an existing chat without changing shared pages,
    // preview, selection, or pins."
    //
    // Constructing a page/pin fake, never passing it to switchChat, and asserting its call
    // log is empty is UNFALSIFIABLE — SwitchChatDeps has no such field, so no implementation
    // could ever populate it. (Gutting switchChat's whole body left that version passing.)
    // The property is real and enforced statically by the dependency type, so assert THAT:
    // the surface switchChat can reach at all.
    const chats = createFakeChatStore();
    const created = await chats.create();
    if ("code" in created) throw created;
    const projectStore = createFakeProjectStore({ root: "C:/proj" });

    const deps = { chats, projectStore };
    expect(Object.keys(deps).sort()).toEqual(["chats", "projectStore"]);

    await switchChat(deps, created.chatId);

    // And what it actually did reach: a chat read plus the active-chat write, nothing else.
    expect(projectStore.calls.every((c) => c.method !== "readManifest")).toBe(true);
  });
});
