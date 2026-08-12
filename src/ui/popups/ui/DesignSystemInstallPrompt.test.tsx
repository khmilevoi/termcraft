import { afterEach, describe, expect, test } from "bun:test";

import type {
  DesignSystemBreakageDtoV1,
  DesignSystemPreviewDtoV1,
  DesignSystemSummaryDtoV1,
  FailureDtoV1,
} from "core/protocol";
import type { StyledRun } from "host/protocol";
import { extractRgb } from "host/render/model/color";
import { createHeadlessRenderer } from "host/render/model/renderer";
import type { RenderHandle } from "host/render/types";
import { SHELL_PALETTE } from "ui/theme";

import type { DesignSystemInstallPromptProps } from "./DesignSystemInstallPrompt";
import {
  DesignSystemInstallPrompt,
  MAX_RENDERED_BULLETS,
  breakageBullets,
} from "./DesignSystemInstallPrompt";

let open: RenderHandle | null = null;
afterEach(() => {
  open?.destroy();
  open = null;
});

const findRun = (frame: { rows: StyledRun[][] }, needle: string): StyledRun | undefined =>
  frame.rows.flat().find((run) => run.text.includes(needle));

const SUMMARY: DesignSystemSummaryDtoV1 = {
  id: "midnight",
  name: "midnight",
  version: "1.3.0",
  kitApiVersion: 1,
  defaultTheme: "dark",
  defaultThemeTokens: [],
  componentNames: [],
};

const CLEAN_PREVIEW: DesignSystemPreviewDtoV1 = {
  verdict: "clean",
  errors: [],
  warnings: [],
};

const BREAKS_PAGES_PREVIEW: DesignSystemPreviewDtoV1 = {
  verdict: "breaks-pages",
  errors: [
    {
      code: "TOKEN_MISSING",
      message: "t.brandBlue does not exist",
      file: "pages/dashboard.tsx",
      blockedPages: ["dashboard"],
    },
  ],
  warnings: [],
};

const BLOCKED_PREVIEW: DesignSystemPreviewDtoV1 = {
  verdict: "blocked",
  errors: [
    {
      code: "MANIFEST_INVALID",
      message: "system/design-system.json failed schema validation",
      file: "system/design-system.json",
      blockedPages: [],
    },
  ],
  warnings: [],
};

const WARNINGS_ONLY_PREVIEW: DesignSystemPreviewDtoV1 = {
  verdict: "clean",
  errors: [],
  warnings: [
    {
      code: "UNUSED_TOKEN",
      message: "token t.legacyGray is unused",
      file: "system/tokens.ts",
      blockedPages: [],
    },
  ],
};

const FAILURE: FailureDtoV1 = {
  code: "DESIGN_SYSTEM_REJECTED",
  retryable: false,
  safeMessage: "midnight could not be installed",
  details: {},
};

function manyErrors(count: number): readonly DesignSystemBreakageDtoV1[] {
  return Array.from({ length: count }, (_, index) => ({
    code: "TOKEN_MISSING",
    message: `t.token${index} does not exist`,
    file: `pages/page${index}.tsx`,
    blockedPages: [],
  }));
}

const base: DesignSystemInstallPromptProps = {
  id: "ds-install",
  kind: "install",
  ref: "local:midnight@1.3.0",
  summary: SUMMARY,
  preview: null,
  failure: null,
  busyPhase: null,
};

async function draw(element: unknown) {
  const handle = await createHeadlessRenderer({ w: 96, h: 28 });
  open = handle;
  handle.mount(element);
  await handle.render();
  return handle.capture();
}

describe("breakageBullets (D6 — the designer sees the complete list)", () => {
  test("the bullet list is bounded and says how many were elided", () => {
    const bullets = breakageBullets({
      verdict: "breaks-pages",
      errors: manyErrors(30),
      warnings: [],
    });
    expect(bullets).toHaveLength(MAX_RENDERED_BULLETS + 1);
    expect(bullets.at(-1)).toContain("22 more");
  });

  test("each bullet names its file and its message", () => {
    const [first] = breakageBullets(BREAKS_PAGES_PREVIEW);
    expect(first).toContain("pages/dashboard.tsx");
    expect(first).toContain("t.brandBlue does not exist");
  });

  test("a diagnostic with no file still renders, attributed to the tree", () => {
    const [first] = breakageBullets({
      verdict: "blocked",
      errors: [
        {
          code: "TYPE_CHECK_UNAVAILABLE",
          message: "the compiler is down",
          file: null,
          blockedPages: [],
        },
      ],
      warnings: [],
    });
    expect(first).toContain("the whole tree");
  });
});

describe("DesignSystemInstallPrompt (design/16-wizard-migration.dc.html)", () => {
  test("a clean preview says so and offers install", async () => {
    const frame = await draw(<DesignSystemInstallPrompt {...base} preview={CLEAN_PREVIEW} />);
    expect(findRun(frame, "nothing breaks")).toBeDefined();
    expect(findRun(frame, "⏎ install")).toBeDefined();
  });

  test("§8.3: a breaking preview LISTS what breaks and still offers install", async () => {
    const frame = await draw(
      <DesignSystemInstallPrompt {...base} preview={BREAKS_PAGES_PREVIEW} />,
    );
    const headline = findRun(frame, "⚠");
    expect(headline && extractRgb(headline.fg)).toBe(SHELL_PALETTE.amberHi);
    expect(findRun(frame, "pages/dashboard.tsx")).toBeDefined();
    expect(findRun(frame, "⏎ install")).toBeDefined();
  });

  test("D6: a blocked preview offers NO install", async () => {
    const frame = await draw(<DesignSystemInstallPrompt {...base} preview={BLOCKED_PREVIEW} />);
    expect(findRun(frame, "⏎ install")).toBeUndefined();
    expect(findRun(frame, "esc")).toBeDefined();
  });

  test("warnings are shown below the fatals, in faint", async () => {
    const frame = await draw(
      <DesignSystemInstallPrompt {...base} preview={WARNINGS_ONLY_PREVIEW} />,
    );
    const warning = findRun(frame, "unused");
    expect(warning && extractRgb(warning.fg)).toBe(SHELL_PALETTE.faint);
  });

  test("the publish kind says publish, never install", async () => {
    const frame = await draw(<DesignSystemInstallPrompt {...base} kind="publish" preview={null} />);
    expect(findRun(frame, "⏎ publish")).toBeDefined();
    expect(findRun(frame, "install")).toBeUndefined();
  });

  test("a failure is shown in red and offers only dismissal", async () => {
    const frame = await draw(
      <DesignSystemInstallPrompt {...base} failure={FAILURE} preview={null} />,
    );
    const message = findRun(frame, FAILURE.safeMessage);
    expect(message && extractRgb(message.fg)).toBe(SHELL_PALETTE.red);
    expect(findRun(frame, "⏎ install")).toBeUndefined();
  });

  test("busy replaces the action hint so a frozen thread never looks like a dead key", async () => {
    const frame = await draw(<DesignSystemInstallPrompt {...base} busyPhase="installing" />);
    expect(findRun(frame, "installing")).toBeDefined();
    expect(findRun(frame, "⏎ install")).toBeUndefined();
  });

  // Fix round 1, Important 1: `"checking"` (D7's Gate-freeze window, BEFORE the user has
  // confirmed anything) and `"installing"` (after the confirm dispatched `designSystem.install`)
  // are both `kind === "install"` — a single boolean `busy` flag could not tell them apart, so the
  // dialog used to read "⠹ installing…" during the CHECK, which is factually wrong at that moment.
  test("checking and installing read as different verbs, even though both are kind: install", async () => {
    const checkingFrame = await draw(<DesignSystemInstallPrompt {...base} busyPhase="checking" />);
    expect(findRun(checkingFrame, "⠹ checking…")).toBeDefined();
    expect(findRun(checkingFrame, "installing")).toBeUndefined();

    const installingFrame = await draw(
      <DesignSystemInstallPrompt {...base} busyPhase="installing" />,
    );
    expect(findRun(installingFrame, "⠹ installing…")).toBeDefined();
    expect(findRun(installingFrame, "checking")).toBeUndefined();
  });
});
