import { describe, expect, test } from "bun:test";

import type { AgentPromptContextV1 } from "core/ports";
import type { PageSlug } from "entities/page";

import { buildSystemPrompt } from "./system-prompt";

const EMPTY_CONTEXT: AgentPromptContextV1 = {
  activePageSlug: null,
  pageOrder: [],
  kitApiVersion: 1,
  openPins: [],
};

describe("buildSystemPrompt", () => {
  test("with no active page and no pages yet, says so honestly rather than fabricating one", () => {
    const prompt = buildSystemPrompt(EMPTY_CONTEXT);
    expect(prompt).toContain("No page is currently active.");
    expect(prompt).toContain("This project has no pages yet");
  });

  test("tells the agent the self-check tool exists (Task 12) — the prompt is what makes it get used", () => {
    expect(buildSystemPrompt(EMPTY_CONTEXT)).toContain("check_design");
  });

  test("names the active page, the full portable order, and the kit API version to declare", () => {
    const context: AgentPromptContextV1 = {
      activePageSlug: "home" as PageSlug,
      pageOrder: ["home" as PageSlug, "about" as PageSlug],
      kitApiVersion: 1,
      openPins: [],
    };
    const prompt = buildSystemPrompt(context);
    expect(prompt).toContain('The currently active page is "home".');
    expect(prompt).toContain("home, about");
    expect(prompt).toContain("meta.kitApiVersion: 1");
  });

  test("lists every open pin with its page slug and its exact text", () => {
    const context: AgentPromptContextV1 = {
      ...EMPTY_CONTEXT,
      activePageSlug: "home" as PageSlug,
      openPins: [{ pageSlug: "home" as PageSlug, text: "make this gauge red" }],
    };
    const prompt = buildSystemPrompt(context);
    expect(prompt).toContain("(home) make this gauge red");
  });

  test("says so honestly when no pins are open", () => {
    expect(buildSystemPrompt(EMPTY_CONTEXT)).toContain("No pins are currently open.");
  });

  test("still carries every static section (design-code rules, page-file layout, answer style)", () => {
    const prompt = buildSystemPrompt(EMPTY_CONTEXT);
    expect(prompt).toContain("^[a-z0-9][a-z0-9-]{0,31}$");
    expect(prompt).toContain("pages/<slug>.tsx");
    expect(prompt).toContain("bold, italic, inline code, and bullet lists");
  });
});
