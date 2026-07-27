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
