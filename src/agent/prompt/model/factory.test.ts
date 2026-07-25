import { describe, expect, test } from "bun:test";

import type { AgentPromptContextV1 } from "core/ports";

import { createProductionAgentPromptSource } from "./factory";

const CONTEXT: AgentPromptContextV1 = {
  activePageSlug: null,
  pageOrder: [],
  kitApiVersion: 1,
  openPins: [],
};

describe("createProductionAgentPromptSource (phase-8 WP-3 contract test)", () => {
  test("the composed system prompt names the slug mask, the single permitted import, and the answer-style rule", () => {
    const prompt = createProductionAgentPromptSource().systemPrompt(CONTEXT);
    expect(prompt).toContain("^[a-z0-9][a-z0-9-]{0,31}$");
    expect(prompt).toContain('"@termcraft/runtime"');
    expect(prompt).toContain("markdown-lite");
  });

  test("runtimeDocs() names RUNTIME.md and runtime.d.ts, both resolving to real files", () => {
    const docs = createProductionAgentPromptSource().runtimeDocs();
    expect(docs.map((d) => d.relPath).sort()).toEqual(["RUNTIME.md", "runtime.d.ts"]);
  });
});
