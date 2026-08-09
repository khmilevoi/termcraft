import { describe, expect, test } from "bun:test";

import { DESIGN_DIRNAME } from "entities/design-tree";

import { ANSWER_STYLE, DESIGN_CODE_RULES, PAGE_FILE_LAYOUT, ROLE, SELF_CHECK } from "./prose";

describe("agent/prompt static prose", () => {
  /**
   * A TOOL THE PROMPT DOES NOT MENTION IS A TOOL THE AGENT DOES NOT USE (Task 12, Step 7).
   * The measured saving this whole task exists to produce depends on the agent calling
   * `check_design` unprompted, before it finishes — so the prompt has to name it, say what it
   * costs relative to a rejected turn, and say that calling it is expected.
   */
  test("SELF_CHECK names the tool, its cost, and that calling it before finishing is expected", () => {
    expect(SELF_CHECK).toContain("check_design");
    expect(SELF_CHECK).toContain("before you finish");
    // Honest about the scope: a clean check is not a guaranteed Gate pass.
    expect(SELF_CHECK).toContain("smoke render");
  });

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

  test("PAGE_FILE_LAYOUT names pages.json, the entry binding, and all three runtime docs", () => {
    expect(PAGE_FILE_LAYOUT).toContain("pages.json");
    expect(PAGE_FILE_LAYOUT).toContain('"entry"');
    expect(PAGE_FILE_LAYOUT).toContain("RUNTIME.md");
    expect(PAGE_FILE_LAYOUT).toContain("runtime.d.ts");
    expect(PAGE_FILE_LAYOUT).toContain("REATOM.md");
  });

  /**
   * THE BINDING IS THE WHOLE POINT (multi-file design tree §4, task 16). A slug-derived path
   * is exactly what this design retires, so the prompt must state that `pages.json`'s `entry`
   * decides where a page lives — an agent that assumes `pages/<slug>.tsx` is mandatory will
   * write a file no manifest names and see it treated as a shared module.
   */
  test("PAGE_FILE_LAYOUT states that the manifest's entry decides a page's file, not its slug", () => {
    expect(PAGE_FILE_LAYOUT).toContain("can live anywhere in the tree");
    expect(PAGE_FILE_LAYOUT).toContain("A file this manifest does not name is a shared module");
  });

  test("PAGE_FILE_LAYOUT invites shared modules rather than treating them as a workaround", () => {
    expect(PAGE_FILE_LAYOUT).toContain("shared modules");
    expect(PAGE_FILE_LAYOUT).toContain("lib/");
    expect(PAGE_FILE_LAYOUT).toContain("relative specifier");
  });

  test("DESIGN_CODE_RULES names BOTH legal import edges and the exact resolution rules", () => {
    expect(DESIGN_CODE_RULES).toContain("STATIC import of the bare specifier");
    expect(DESIGN_CODE_RULES).toContain("RELATIVE specifier");
    expect(DESIGN_CODE_RULES).toContain('"<spec>.tsx"');
    expect(DESIGN_CODE_RULES).toContain('"<spec>.ts"');
    expect(DESIGN_CODE_RULES).toContain("no directory-index resolution");
  });

  /**
   * REQUIRED BY design §13's fourth trade-off, through §9.5: shared module state is genuinely
   * shared within a revision and resets across one, and the design says that must be STATED so
   * it is not discovered as a bug. The plan's own words: "do not paraphrase it away." Pinned
   * here on both halves, because a prompt that mentions only one of them teaches the wrong
   * mental model just as effectively as silence.
   */
  test("DESIGN_CODE_RULES states the shared-module state rule, both halves", () => {
    expect(DESIGN_CODE_RULES).toContain("SHARED ACROSS PAGES within one design revision");
    expect(DESIGN_CODE_RULES).toContain("RESETS when the design changes");
  });

  /**
   * REGRESSION (defect fix, 2026-07-27): this block used to say only "inside this workspace"
   * and list bare names. Every observed turn opened by reading "/RUNTIME.md" and three more
   * leading-slash paths, all four denied by `agent/confinement` (on Windows a leading slash
   * is the drive root, which is outside the fence), then probed with a glob, then re-read
   * them relative. Six wasted tool calls per turn for a fact the prompt simply never stated.
   */
  test("PAGE_FILE_LAYOUT states that paths are relative to the workspace root", () => {
    expect(PAGE_FILE_LAYOUT).toContain("working directory is the WORKSPACE ROOT");
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

  test("the layout prose names the design tree's real root", () => {
    expect(PAGE_FILE_LAYOUT).toContain(`${DESIGN_DIRNAME}/pages.json`);
    expect(PAGE_FILE_LAYOUT).toContain(`${DESIGN_DIRNAME}/pages/dashboard.tsx`);
    // The retired claim, in the exact words the measured run acted on.
    expect(PAGE_FILE_LAYOUT).not.toContain("it IS the design tree");
  });

  test("no example path is stated without its tree prefix", () => {
    // Every quoted path that looks tree-relative must carry the prefix. `pages.json` appears
    // inside prose about the manifest too, so match the QUOTED forms the agent copies.
    for (const bare of ['"pages.json"', '"pages/dashboard.tsx"', '"lib/theme.ts"']) {
      expect(PAGE_FILE_LAYOUT).not.toContain(bare);
    }
  });

  test("the existing leading-slash warning survives", () => {
    expect(PAGE_FILE_LAYOUT).toContain("A leading slash escapes the workspace and is refused.");
  });

  test("the runtime docs are stated at the workspace root, beside the tree and not inside it", () => {
    expect(PAGE_FILE_LAYOUT).toContain("RUNTIME.md and runtime.d.ts, at the workspace root");
    expect(PAGE_FILE_LAYOUT).not.toContain(`${DESIGN_DIRNAME}/RUNTIME.md`);
  });
});
