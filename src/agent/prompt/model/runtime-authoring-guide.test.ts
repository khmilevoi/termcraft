import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { DESIGN_CODE_RULES } from "./prose";

const GUIDE_PATH = path.resolve(import.meta.dir, "runtime-authoring-guide.md");
const GUIDE = fs.readFileSync(GUIDE_PATH, "utf8");

/**
 * THE MODEL THIS PINS (design-systems §4.3, §4.5; task 14, 2026-08-11). The guide used to teach
 * "Colors are semantic token names from one closed set — never raw hex", then a closed list of
 * seventeen names, then "The MVP ships a single theme". That is the model this branch replaces:
 * colours are now concrete values read through `useTokens()` from a project-owned
 * `design-system.json`, a raw hex is legal (if usually the wrong call), and a page may pin a
 * theme or leave `meta.theme` unset. An authoring agent reading the old prose would write
 * `color="accent"`, which no longer type-checks.
 */
describe("the colours section teaches the design-system model (design-systems §4.3, §4.5)", () => {
  test("no longer forbids hex, and no longer claims a closed token set", () => {
    expect(GUIDE).not.toContain("never raw hex");
    expect(GUIDE).not.toContain("one closed set");
    expect(GUIDE).not.toContain("the only names that resolve");
  });

  test("teaches the useTokens() import and read", () => {
    expect(GUIDE).toContain('import { useTokens } from "../system/tokens"');
    expect(GUIDE).toContain("const t = useTokens()");
    expect(GUIDE).toContain("color={t.");
  });

  test("says where the token names come from", () => {
    expect(GUIDE).toContain("design/system/design-system.json");
  });

  test("warns against a module-scope read, in the same words the Gate warns in", () => {
    expect(GUIDE).toContain("inside the component");
  });

  test("the seventeen core roles are still named — they are the catalog's own defaults", () => {
    for (const role of ["background", "foregroundFaint", "accentDim", "statusBg"])
      expect(GUIDE).toContain(role);
  });

  test("no longer claims a single shipped theme", () => {
    expect(GUIDE).not.toContain("The MVP ships a single theme");
  });

  test("meta.theme is documented as optional", () => {
    expect(GUIDE).toContain("meta.theme");
    expect(GUIDE).toContain("optional");
  });

  test("the minimal-shape example omits theme", () => {
    // The example is what the agent copies. Leaving `theme: "dark-default"` in it would teach
    // every new page to pin a theme name that a project's manifest may not declare.
    expect(GUIDE).not.toContain('theme: "dark-default"');
  });

  test("the determinism section is untouched — it is still correct", () => {
    expect(GUIDE).toContain("Time and the sealed render");
    expect(GUIDE).toContain("requestAnimationFrame");
  });
});

describe("RUNTIME.md points at the Reatom guide", () => {
  test("the State section sends the reader to REATOM.md before writing state", () => {
    const start = GUIDE.indexOf("## State");
    const end = GUIDE.indexOf("\n## ", start + 1);
    expect(GUIDE.slice(start, end)).toContain("REATOM.md");
  });
});

/**
 * `gate` sits alongside `agent` as a sibling adapter in the module DAG — both implement
 * `core` ports, and there is no import edge between them (`docs/architecture/code-structure.md`'s
 * flowchart: `agent -> core`, `gate -> core`, nothing pointing across). An `agent`-side test
 * importing `gate/model/lints.ts` to pull its determinism vocabulary would introduce exactly
 * that missing edge, in a test file, to avoid a text parse — the plan's Step 3 explicitly
 * rejects this trade.
 *
 * So this file reads `lints.ts` as TEXT instead, the same pairing discipline
 * `store/safe-fs/model/limits.ts:104` documents for `AGENT_DOC_FILES` (a constant that layer
 * cannot import either, for the same reason): two lists linked by a comment instead of an
 * import are linked by a test that fails the moment either one drifts alone. `extractLintIdentifiers`
 * below re-derives the Gate's own flagged-construct set from `lints.ts`'s source text — the
 * `TIMER_IDENTIFIERS`/`NOW_OBJECTS` set literals plus the two hardcoded "new Date()" /
 * "Math.random()" constructs — without ever importing the module that declares them.
 */
const LINTS_PATH = path.resolve(import.meta.dir, "../../../gate/model/lints.ts");
const LINTS_SOURCE = fs.readFileSync(LINTS_PATH, "utf8");

const REATOM_GUIDE_PATH = path.resolve(import.meta.dir, "reatom-guide.md");
const REATOM_GUIDE = fs.readFileSync(REATOM_GUIDE_PATH, "utf8");

/**
 * The determinism paragraph both guides must carry byte-identical (plan Step 5): both files
 * are staged into every turn workspace (`runtime-docs.ts:58-62`), so a disagreement between
 * them is a disagreement the authoring agent has to resolve mid-turn instead of being told
 * once, consistently, by whichever doc it read first.
 */
const DETERMINISM_PARAGRAPH =
  "A page renders once per commit. There is no tick, no animation frame, no interval, no\n" +
  "clock. Nothing in the runtime calls your component again on its own. Any value that would\n" +
  "change with time lives in an atom and advances only from an action.";

/** Every double-quoted string literal inside `block`. */
function extractQuotedStrings(block: string): string[] {
  return [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
}

/** The string-literal contents of `const <constName> = new Set<string>([...])` in `source`. */
function extractSetLiteral(source: string, constName: string): string[] {
  const re = new RegExp(`const ${constName}\\s*=\\s*new Set<string>\\(\\[([\\s\\S]*?)\\]\\)`);
  const match = source.match(re);
  if (match === null) return [];
  return extractQuotedStrings(match[1]!);
}

/**
 * Re-derives the exact set of constructs `lintDeterminism` (`gate/model/lints.ts`) flags,
 * straight from its source text: `TIMER_IDENTIFIERS` names itself, `NOW_OBJECTS` combines with
 * `.now()`, and the two hardcoded constructs (`new Date()`, `Math.random()`) are detected by
 * their literal appearance in the lint's own warning-message text.
 */
function extractLintIdentifiers(source: string): Set<string> {
  const timers = extractSetLiteral(source, "TIMER_IDENTIFIERS");
  const nowObjects = extractSetLiteral(source, "NOW_OBJECTS");
  const identifiers = new Set<string>(timers);
  for (const obj of nowObjects) identifiers.add(`${obj}.now()`);
  if (source.includes("new Date()")) identifiers.add("new Date()");
  if (source.includes("Math.random()")) identifiers.add("Math.random()");
  return identifiers;
}

/**
 * The construct list a document states under "Time and the sealed render", read from the
 * quote-delimited spans on the paragraph that starts "The Gate flags:" — the same paragraph
 * `extractLintIdentifiers` above is checked against, never an import.
 *
 * `quote` differs per document because the two speak different notations for the same fact: the
 * markdown guides backtick their identifiers, and `prose.ts`'s `DESIGN_CODE_RULES` is plain text
 * the agent reads inside a system prompt, where every identifier is double-quoted
 * (`"@termcraft/runtime"`, `"reatomComponent"`, `"<spec>.tsx"`). One extractor, two notations —
 * never two lists.
 */
function extractFlaggedConstructs(text: string, quote: "`" | '"'): Set<string> {
  const marker = "The Gate flags:";
  const idx = text.indexOf(marker);
  if (idx === -1) return new Set();
  const after = text.slice(idx);
  const end = after.indexOf("\n\n");
  const scope = end === -1 ? after : after.slice(0, end);
  return new Set(
    [...scope.matchAll(new RegExp(`${quote}([^${quote}]+)${quote}`, "g"))].map((m) => m[1]!),
  );
}

describe("RUNTIME.md's determinism vocabulary matches the Gate's own", () => {
  test("the guide's flagged-construct list equals the lint's own", () => {
    const listed = extractFlaggedConstructs(GUIDE, "`");
    const linted = extractLintIdentifiers(LINTS_SOURCE);
    expect(listed).toEqual(linted);
  });

  test("the guide states there is no tick", () => {
    expect(GUIDE).toMatch(/no tick/i);
    expect(GUIDE).toMatch(/renders once per commit/i);
  });
});

/**
 * THE ANCHOR-ROT GUARD (task 14, 2026-08-11). `lintModuleScopeTokens` (`gate/model/lints.ts`)
 * cites RUNTIME.md by section name — `see RUNTIME.md's "<heading>"` — so a reader following the
 * warning lands on the right prose. Before this task the cited heading was `"Colors"`, which has
 * never existed in this guide (its headings are Minimal shape, State, Layout and style, Time and
 * the sealed render, What not to do, Element catalog additions); the colour material actually
 * lives under "Layout and style". Same text-only pairing discipline as the determinism block
 * above — `LINTS_SOURCE` is read as TEXT, never imported, for the `agent -> core`, `gate -> core`
 * DAG reason documented there — so this test re-derives the citation from the lint's own source
 * and checks it against a real `## ` heading in the guide, instead of hardcoding the string on
 * both sides where it could drift again.
 */
function extractRuntimeMdCitation(source: string, kind: string): string | null {
  const kindIdx = source.indexOf(`kind: "${kind}"`);
  if (kindIdx === -1) return null;
  const after = source.slice(kindIdx);
  const match = after.match(/RUNTIME\.md\\?'s "([^"]+)"/);
  return match === null ? null : match[1]!;
}

describe("the Gate's RUNTIME.md citation names a heading the guide actually has", () => {
  test("lintModuleScopeTokens's cited section exists in the guide", () => {
    const citation = extractRuntimeMdCitation(LINTS_SOURCE, "module-scope-tokens");
    expect(citation).not.toBeNull();
    expect(GUIDE).toContain(`## ${citation}`);
  });
});

/**
 * THE THIRD DOCUMENT IN THE PAIRING, AND THE ONE THE AGENT CANNOT SKIP (final whole-branch
 * review, I1, 2026-08-10).
 *
 * WHY THIS TEST EXISTS. Task 4 renamed `unguarded-timer`/`unguarded-randomness` because the old
 * names promised a guard a token scan can never observe being cleared, and Task 6 rewrote both
 * authoring guides accordingly — but `prose.ts`'s `DESIGN_CODE_RULES` went on saying "never use
 * setTimeout, setInterval, or Math.random outside animation guarded by the export flag" for the
 * whole plan. Two independent sweeps missed it: Task 4's was `rg -n "unguarded" src` (a KIND-NAME
 * search, and that line says "guarded", not "unguarded"), and Task 6's pairing — the describe
 * directly above — covered `runtime-authoring-guide.md` and `reatom-guide.md` and stopped there.
 * The missed file is the one the agent reads on EVERY turn, and its list also omitted
 * `Date.now()`/`performance.now()`/`new Date()` entirely, which is the exact gap spike 13
 * measured two `examples/clock` authors reasoning incorrectly from.
 *
 * SAME DISCIPLINE, SAME DAG REASON. `lints.ts` is still read as TEXT, never imported: `gate` and
 * `agent` are sibling adapters over `core` in the module DAG (`docs/architecture/code-structure.md`'s
 * flowchart — `agent -> core`, `gate -> core`, nothing across), so an `agent`-side test importing
 * `gate/model/lints.ts` would introduce exactly that missing edge to avoid a text parse. `prose.ts`
 * needs no such care and is imported directly: it is a sibling FILE in this very module, the same
 * way `prose.test.ts` imports it.
 */
describe("the SYSTEM PROMPT's determinism vocabulary matches the Gate's own", () => {
  test("DESIGN_CODE_RULES's flagged-construct list equals the lint's own", () => {
    const listed = extractFlaggedConstructs(DESIGN_CODE_RULES, '"');
    const linted = extractLintIdentifiers(LINTS_SOURCE);
    expect(listed).toEqual(linted);
  });

  test("DESIGN_CODE_RULES states the same rule the guides do, and no longer promises a guard", () => {
    expect(DESIGN_CODE_RULES).toMatch(/no tick/i);
    expect(DESIGN_CODE_RULES).toMatch(/renders once per commit/i);
    expect(DESIGN_CODE_RULES).not.toContain("guarded by the export flag");
  });
});

describe("RUNTIME.md and REATOM.md do not disagree about determinism", () => {
  test("the mirrored paragraph is byte-identical in both files", () => {
    expect(GUIDE).toContain(DETERMINISM_PARAGRAPH);
    expect(REATOM_GUIDE).toContain(DETERMINISM_PARAGRAPH);
  });
});
