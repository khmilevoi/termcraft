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

  test("PAGE_FILE_LAYOUT names pages/<slug>.tsx, pages.json, and the two runtime docs", () => {
    expect(PAGE_FILE_LAYOUT).toContain("pages/<slug>.tsx");
    expect(PAGE_FILE_LAYOUT).toContain("pages.json");
    expect(PAGE_FILE_LAYOUT).toContain("RUNTIME.md");
    expect(PAGE_FILE_LAYOUT).toContain("runtime.d.ts");
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
