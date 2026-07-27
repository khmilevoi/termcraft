import { describe, expect, test } from "bun:test";

import { ANSWER_STYLE, DESIGN_CODE_RULES, PAGE_FILE_LAYOUT, ROLE } from "./prose";

describe("agent/prompt static prose", () => {
  test("DESIGN_CODE_RULES names the slug mask verbatim and the Windows-reserved names", () => {
    expect(DESIGN_CODE_RULES).toContain("^[a-z0-9][a-z0-9-]{0,31}$");
    expect(DESIGN_CODE_RULES).toContain("con, nul, aux, prn, com1-com9, lpt1-lpt9");
  });

  test("DESIGN_CODE_RULES names the single permitted import and the forbidden ones", () => {
    expect(DESIGN_CODE_RULES).toContain('"@termcraft/runtime"');
    for (const forbidden of ['"@reatom/*"', '"react"', '"@opentui/*"', '"node:*"', '"bun:*"']) {
      expect(DESIGN_CODE_RULES).toContain(forbidden);
    }
  });

  test("DESIGN_CODE_RULES bans setTimeout/setInterval/Math.random outside animation", () => {
    expect(DESIGN_CODE_RULES).toContain("setTimeout");
    expect(DESIGN_CODE_RULES).toContain("setInterval");
    expect(DESIGN_CODE_RULES).toContain("Math.random");
    expect(DESIGN_CODE_RULES).toContain("animation guarded by the export flag");
  });

  test("PAGE_FILE_LAYOUT names pages/<slug>.tsx, pages.json, and all three runtime docs", () => {
    expect(PAGE_FILE_LAYOUT).toContain("pages/<slug>.tsx");
    expect(PAGE_FILE_LAYOUT).toContain("pages.json");
    expect(PAGE_FILE_LAYOUT).toContain("RUNTIME.md");
    expect(PAGE_FILE_LAYOUT).toContain("runtime.d.ts");
    expect(PAGE_FILE_LAYOUT).toContain("REATOM.md");
  });

  /**
   * REGRESSION (defect fix, 2026-07-27): this block used to say only "inside this workspace"
   * and list bare names. Every observed turn opened by reading "/RUNTIME.md" and three more
   * leading-slash paths, all four denied by `agent/confinement` (on Windows a leading slash
   * is the drive root, which is outside the fence), then probed with a glob, then re-read
   * them relative. Six wasted tool calls per turn for a fact the prompt simply never stated.
   */
  test("PAGE_FILE_LAYOUT states that paths are relative to the workspace root", () => {
    expect(PAGE_FILE_LAYOUT).toContain("working directory IS the workspace root");
    expect(PAGE_FILE_LAYOUT).toContain("relative");
    expect(PAGE_FILE_LAYOUT).toContain("leading slash");
  });

  /**
   * The v3-vs-v1001 split is the most expensive thing an authoring agent gets wrong here —
   * it typechecks and then throws at render — so the prompt itself must warn, not only the
   * doc the agent may or may not open. See `runtime-docs.ts` for the turn this comes from.
   */
  test("PAGE_FILE_LAYOUT warns that Reatom here is v1001, with no ctx and no .spy", () => {
    expect(PAGE_FILE_LAYOUT).toContain("v1001");
    expect(PAGE_FILE_LAYOUT).toContain("ctx");
    expect(PAGE_FILE_LAYOUT).toContain(".spy");
  });

  test("ANSWER_STYLE names the markdown-lite subset and what flattens", () => {
    expect(ANSWER_STYLE).toContain("markdown-lite");
    expect(ANSWER_STYLE).toContain("bold, italic, inline code, and bullet lists");
    expect(ANSWER_STYLE).toContain("Headings flatten to bold lines");
    expect(ANSWER_STYLE).toContain("tables, code blocks, and links flatten to plain text");
  });

  test("ROLE names the fenced turn workspace and the agent's own file tools", () => {
    expect(ROLE).toContain("turn workspace");
    expect(ROLE).toContain("file tools");
  });
});
