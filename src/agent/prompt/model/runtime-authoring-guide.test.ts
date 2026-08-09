import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { DEFAULT_THEME_ID, themeTokens } from "runtime";

const GUIDE_PATH = path.resolve(import.meta.dir, "runtime-authoring-guide.md");
const GUIDE = fs.readFileSync(GUIDE_PATH, "utf8");

/**
 * The palette paragraph, isolated by its own heading. Slicing the section rather than
 * scanning the whole file keeps `Row`/`Column`/`Spacer` and every other backticked
 * identifier in the document out of the comparison.
 */
function paletteSection(): string {
  const start = GUIDE.indexOf("## Layout and style");
  expect(start).toBeGreaterThan(-1);
  const end = GUIDE.indexOf("\n## ", start + 1);
  return end === -1 ? GUIDE.slice(start) : GUIDE.slice(start, end);
}

/** Every backticked name in the palette section that looks like a token (not a prop or component). */
function documentedTokens(): Set<string> {
  const section = paletteSection();
  const listStart = section.indexOf("the only names that resolve");
  expect(listStart).toBeGreaterThan(-1);
  const names = section.slice(listStart).matchAll(/`([A-Za-z][A-Za-z0-9]*)`/g);
  return new Set([...names].map((m) => m[1]!));
}

/**
 * THE DEFECT THIS PINS (2026-07-27). This document used to list a palette that does not
 * exist: `text`, `text-muted`, `text-faint`, `primary`, `ok`, `error` — six invented names
 * out of eleven, none of them a key of `ThemeTokens`. It is the only colour reference an
 * authoring agent can read inside the turn fence, so every hue it named was a hue the page
 * could not resolve. CLAUDE.md's own rule covers exactly this: "Design is a source of truth
 * — never invent it."
 *
 * Comparing BOTH directions is the point. Checking only "documented ⊆ real" would let the
 * list quietly go stale as tokens are added; checking only the reverse would let an invented
 * name survive next to the real ones.
 */
describe("RUNTIME.md's palette list against the real theme tokens", () => {
  const real = new Set(Object.keys(themeTokens(DEFAULT_THEME_ID)));

  test("every documented token name is a real ThemeTokens key", () => {
    const invented = [...documentedTokens()].filter((name) => !real.has(name));
    expect(invented).toEqual([]);
  });

  test("every real ThemeTokens key is documented", () => {
    const documented = documentedTokens();
    const missing = [...real].filter((name) => !documented.has(name));
    expect(missing).toEqual([]);
  });

  test("the invented names the old list carried are gone", () => {
    for (const gone of ["`text-muted`", "`text-faint`", "`primary`", "`ok`"]) {
      expect(GUIDE).not.toContain(gone);
    }
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
 * The construct list the guide documents under "Time and the sealed render", read from the
 * backtick-quoted spans on the sentence that starts "The Gate flags:" — the same sentence
 * `extractLintIdentifiers` above is checked against, never an import.
 */
function extractFlaggedConstructs(text: string): Set<string> {
  const marker = "The Gate flags:";
  const idx = text.indexOf(marker);
  if (idx === -1) return new Set();
  const after = text.slice(idx);
  const end = after.indexOf("\n\n");
  const scope = end === -1 ? after : after.slice(0, end);
  return new Set([...scope.matchAll(/`([^`]+)`/g)].map((m) => m[1]!));
}

describe("RUNTIME.md's determinism vocabulary matches the Gate's own", () => {
  test("the guide's flagged-construct list equals the lint's own", () => {
    const listed = extractFlaggedConstructs(GUIDE);
    const linted = extractLintIdentifiers(LINTS_SOURCE);
    expect(listed).toEqual(linted);
  });

  test("the guide states there is no tick", () => {
    expect(GUIDE).toMatch(/no tick/i);
    expect(GUIDE).toMatch(/renders once per commit/i);
  });
});

describe("RUNTIME.md and REATOM.md do not disagree about determinism", () => {
  test("the mirrored paragraph is byte-identical in both files", () => {
    expect(GUIDE).toContain(DETERMINISM_PARAGRAPH);
    expect(REATOM_GUIDE).toContain(DETERMINISM_PARAGRAPH);
  });
});
