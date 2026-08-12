import { describe, expect, test } from "bun:test";

import type { AgentPromptContextV1 } from "../agent-prompt";
import { createFakeAgentPromptSource } from "./agent-prompt";

const CONTEXT: AgentPromptContextV1 = {
  activePageSlug: null,
  pageOrder: [],
  kitApiVersion: 1,
  openPins: [],
  designSystem: null,
};

describe("createFakeAgentPromptSource", () => {
  test("records every systemPrompt/runtimeDocs call, in order", () => {
    const fake = createFakeAgentPromptSource();
    fake.runtimeDocs();
    fake.systemPrompt(CONTEXT);
    expect(fake.calls).toEqual([
      { method: "runtimeDocs" },
      { method: "systemPrompt", context: CONTEXT },
    ]);
  });

  test("defaults runtimeDocs() to an honest empty list", () => {
    expect(createFakeAgentPromptSource().runtimeDocs()).toEqual([]);
  });

  test("is programmable: a caller-supplied systemPromptText/runtimeDocs override the defaults", () => {
    const docs = [{ relPath: "RUNTIME.md", sourcePath: "/fake/RUNTIME.md" }];
    const fake = createFakeAgentPromptSource({
      systemPromptText: () => "custom prompt",
      runtimeDocs: docs,
    });
    expect(fake.systemPrompt(CONTEXT)).toBe("custom prompt");
    expect(fake.runtimeDocs()).toEqual(docs);
  });
});
