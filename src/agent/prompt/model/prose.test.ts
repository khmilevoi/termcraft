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

  /**
   * The check is synchronous all the way down and freezes termcraft's UI, not only the agent's
   * own progress (measured: 88-330 ms, with a 10 ms interval firing zero times throughout —
   * `entrypoint/model/design-checker.ts`'s header). The prompt must say so with the MEASURED
   * figure, and must not encourage per-line checking.
   */
  test("SELF_CHECK discloses the real, measured cost and that the pause is termcraft's", () => {
    expect(SELF_CHECK).toContain("0.1-0.35 seconds");
    expect(SELF_CHECK).toContain("termcraft's whole interface is paused");
    expect(SELF_CHECK).toContain("not only your own progress");
    // The inflated guess an earlier draft carried, and the per-line instruction it paired with.
    expect(SELF_CHECK).not.toContain("a few seconds");
    expect(SELF_CHECK).not.toContain("after every round of edits");
    expect(SELF_CHECK).toContain("after each round of edits");
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

  /**
   * RETRACTION, PINNED (final whole-branch review, I1, 2026-08-10). This test used to assert
   * `toContain("animation guarded by the export flag")` — the exact claim Task 4 declared FALSE
   * ("no kind name promises a guard": `gate/model/lints.ts`'s `lintDeterminism` is a token scan
   * with no scope analysis, so no `isExport()` wrapper can ever clear a warning) and Task 6
   * replaced in both authoring guides. The system prompt kept teaching it for one reason worth
   * recording: Task 4's rename sweep was `rg -n "unguarded" src`, which checks the KIND NAME and
   * returns nothing against a line that says "guarded", and Task 6's pairing test covered the two
   * `.md` guides but never this file. The assertion is RETARGETED at the corrected wording rather
   * than deleted — the same convention every other retraction in this plan followed.
   *
   * The old line also omitted `Date.now()`/`performance.now()`/`new Date()` entirely, which is
   * exactly the gap spike 13 measured two `examples/clock` authors reasoning incorrectly from.
   * The construct list is pinned against `gate/model/lints.ts`'s own sets in
   * `runtime-authoring-guide.test.ts`, so a future rename cannot silently miss this file again.
   */
  test("DESIGN_CODE_RULES states the sealed-render time rule, not the retracted export-flag guard", () => {
    expect(DESIGN_CODE_RULES).toContain("a page renders once per commit");
    expect(DESIGN_CODE_RULES).toContain("no tick");
    expect(DESIGN_CODE_RULES).toContain("does not belong in a page at all");
    for (const construct of [
      "Date.now()",
      "performance.now()",
      "new Date()",
      "Math.random()",
      "setTimeout",
      "setInterval",
      "setImmediate",
      "requestAnimationFrame",
    ]) {
      expect(DESIGN_CODE_RULES).toContain(construct);
    }
    // The seeded exemption, so the rule does not read as "avoid dates" instead of "avoid the clock".
    expect(DESIGN_CODE_RULES).toContain("new Date(ms)");
    // The retracted claim, in the exact words the prompt used to carry.
    expect(DESIGN_CODE_RULES).not.toContain("guarded by the export flag");
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
