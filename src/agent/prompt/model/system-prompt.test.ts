import { describe, expect, test } from "bun:test";

import type { AgentPromptContextV1 } from "core/ports";
import { createSeedManifest } from "entities/design-system";
import type { DesignSystemManifestV1 } from "entities/design-system";
import type { PageSlug } from "entities/page";

import { buildSystemPrompt } from "./system-prompt";

const EMPTY_CONTEXT: AgentPromptContextV1 = {
  activePageSlug: null,
  pageOrder: [],
  kitApiVersion: 1,
  openPins: [],
  designSystem: null,
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
      designSystem: null,
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

describe("the design-system section (design-systems §5)", () => {
  const withSystem = (manifest: DesignSystemManifestV1) =>
    buildSystemPrompt({ ...EMPTY_CONTEXT, designSystem: manifest });

  test("names the system, its default theme, and every token", () => {
    const prompt = withSystem(createSeedManifest({ kitApiVersion: 1 }));
    expect(prompt).toContain("design/system/design-system.json");
    expect(prompt).toContain("dark-default");
    expect(prompt).toContain("foregroundMuted");
    expect(prompt).toContain("#e6a23c");
  });

  test("lists the declared components with their import specifiers", () => {
    const manifest = {
      ...createSeedManifest({ kitApiVersion: 1 }),
      components: [{ name: "Button", module: "components/Button.tsx", export: "Button" }],
    };
    const prompt = withSystem(manifest);
    expect(prompt).toContain("Button");
    expect(prompt).toContain("system/components/Button.tsx");
  });

  test("says so honestly when a project declares no components", () => {
    expect(withSystem(createSeedManifest({ kitApiVersion: 1 }))).toContain(
      "declares no shared components yet",
    );
  });

  test("names every theme when there is more than one", () => {
    // The manifest is a MAP of themes from day one (§4.2); the agent must know which names exist
    // before it can write a `meta.theme`.
    const manifest = createSeedManifest({ kitApiVersion: 1 });
    const two = {
      ...manifest,
      themes: {
        ...manifest.themes,
        light: { label: "Light", tokens: manifest.themes["dark-default"]!.tokens },
      },
    };
    expect(withSystem(two)).toContain("light");
  });

  test("a project with NO design system gets no section and no fabricated one", () => {
    const prompt = buildSystemPrompt({ ...EMPTY_CONTEXT, designSystem: null });
    expect(prompt).not.toContain("design/system/design-system.json");
    expect(prompt).not.toContain("useTokens");
  });

  test("every static section survives", () => {
    // The existing contract test, re-run with the new field present.
    const prompt = buildSystemPrompt({ ...EMPTY_CONTEXT, designSystem: null });
    expect(prompt).toContain("^[a-z0-9][a-z0-9-]{0,31}$");
    expect(prompt).toContain("pages/<slug>.tsx");
  });
});
