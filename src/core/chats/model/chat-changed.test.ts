import { describe, expect, test } from "bun:test";

import { eventPayloadV1SchemaByKind } from "core/protocol";

import { buildChatChangedPayload } from "./chat-changed";

describe("buildChatChangedPayload", () => {
  test("defaults added/updated/removedChatIds to empty arrays", () => {
    const payload = buildChatChangedPayload({
      activeChatId: "0192f6f0-0000-7000-8000-000000000001",
    });
    expect(payload).toEqual({
      activeChatId: "0192f6f0-0000-7000-8000-000000000001",
      added: [],
      updated: [],
      removedChatIds: [],
    });
  });

  test("carries the given added/updated/removedChatIds verbatim", () => {
    const added = [
      { chatId: "0192f6f0-0000-7000-8000-000000000002", createdAt: "2024-01-01T00:00:00.000Z" },
    ];
    const payload = buildChatChangedPayload({
      activeChatId: "0192f6f0-0000-7000-8000-000000000001",
      added,
      updated: [],
      removedChatIds: ["0192f6f0-0000-7000-8000-000000000003"],
    });
    expect(payload.added).toEqual(added);
    expect(payload.removedChatIds).toEqual(["0192f6f0-0000-7000-8000-000000000003"]);
  });

  test("produces a schema-valid chat.changed payload", () => {
    const payload = buildChatChangedPayload({
      activeChatId: "0192f6f0-0000-7000-8000-000000000001",
    });
    expect(eventPayloadV1SchemaByKind["chat.changed"].safeParse(payload).success).toBe(true);
  });
});
