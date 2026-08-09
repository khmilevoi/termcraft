import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { RUNTIME_DTS } from "./runtime-dts";

// The generator resolves `@typescript/typescript-${process.platform}-${process.arch}/package.json`
// (`scripts/gen-runtime-dts.ts`) and exits 1 when that per-platform package is absent, so the
// drift check below can only run on a host that has it. Mirrors `gate/model/type-check.test.ts`'s
// HAS_TSC/withTsc guard for the same reason: an environment-dependent native package must not
// hard-fail a suite that would otherwise be portable.
const PLATFORM_TSC_PACKAGE = path.join(
  process.cwd(),
  `node_modules/@typescript/typescript-${process.platform}-${process.arch}/package.json`,
);
const HAS_PLATFORM_TSC = fs.existsSync(PLATFORM_TSC_PACKAGE);
const withPlatformTsc = HAS_PLATFORM_TSC ? test : test.skip;

/** The PROMPT copy: staged into the agent's workspace by path (phase-8 WP-3). */
const PROMPT_COPY = path.join(process.cwd(), "src/runtime/generated/runtime.generated.d.ts");
const REATOM_BLOCK_OPENER = 'declare module "@reatom/core" {';

describe("the generated runtime declaration", () => {
  test("declares the @termcraft/runtime module", () => {
    expect(RUNTIME_DTS).toContain('declare module "@termcraft/runtime"');
  });

  test("carries the page contract and the component catalog", () => {
    for (const name of ["definePage", "PageMeta", "reatomComponent", "Gauge", "Sparkline"]) {
      expect(RUNTIME_DTS).toContain(name);
    }
  });

  if (!HAS_PLATFORM_TSC) {
    console.warn(
      `runtime-dts.test.ts: skipping the fresh-emit drift check — ${PLATFORM_TSC_PACKAGE} is ` +
        "absent on this host, so scripts/gen-runtime-dts.ts cannot run. This does NOT mean the " +
        "committed RUNTIME_DTS is verified fresh; rerun on a host with the platform package, or " +
        "regenerate with `bun run gen:runtime-dts`.",
    );
  }

  withPlatformTsc(
    "the GATE copy matches a fresh `--stdout=gate` emit — regenerate with bun run gen:runtime-dts",
    async () => {
      const fresh = await Bun.$`bun run scripts/gen-runtime-dts.ts --stdout=gate`.text();
      expect(RUNTIME_DTS.trim()).toBe(fresh.trim());
    },
  );

  withPlatformTsc(
    "the PROMPT copy matches a fresh `--stdout` emit, and bare `--stdout` still means the prompt copy",
    async () => {
      // Task 7 split one artifact into two, so `--stdout` grew a selector. The choice made
      // there — bare `--stdout` keeps printing the PROMPT copy rather than becoming ambiguous or
      // silently switching to the gate copy — is asserted HERE rather than left to a reader of
      // the generator: this test fails the moment the default flips.
      const fresh = await Bun.$`bun run scripts/gen-runtime-dts.ts --stdout`.text();
      const committed = fs.readFileSync(PROMPT_COPY, "utf8");
      expect(committed.trim()).toBe(fresh.trim());
      expect(fresh).not.toContain(REATOM_BLOCK_OPENER);
    },
  );
});

// ── Task 7 (2026-08-09, spec WP-4): the two copies and what separates them ──────────────────
//
// The declaration is emitted ONCE and written TWICE, to two artifacts with two audiences:
//
//  - the PROMPT copy (`runtime.generated.d.ts`), staged into the agent's turn workspace as
//    `runtime.d.ts` — a prompt attachment, so its SIZE is a first-class constraint;
//  - the GATE copy (`RUNTIME_DTS`), fed only to the hermetic compiler — where fidelity is the
//    constraint and size is nearly free, so it carries the real `@reatom/core` declarations
//    inline and the prompt copy does not.
//
// Both halves are pinned below, because the failure mode of getting this wrong is silent: a
// generator that wrote the gate copy to both paths would tenfold the prompt attachment and
// nothing else in the suite would notice.
describe("the prompt copy and the gate copy are separate artifacts (Task 7)", () => {
  test("the PROMPT copy does not grow", () => {
    // The whole reason the split exists. A comfortable ceiling rather than an exact byte count:
    // this pins "still a prompt-sized attachment", not "unchanged", so an ordinary surface change
    // to `src/runtime` does not have to touch this number.
    expect(fs.readFileSync(PROMPT_COPY).length).toBeLessThan(40_000);
  });

  test("the PROMPT copy carries no inlined @reatom/core block", () => {
    expect(fs.readFileSync(PROMPT_COPY, "utf8")).not.toContain(REATOM_BLOCK_OPENER);
  });

  test("the GATE copy declares @reatom/core rather than importing it unresolved", () => {
    expect(RUNTIME_DTS).toContain(REATOM_BLOCK_OPENER);
  });

  test("the GATE copy is the PROMPT copy plus exactly that one block", () => {
    // Not merely "both contain the facade": the gate copy must be a byte-exact EXTENSION of the
    // prompt copy, so the agent's reference and the Gate's declaration can never disagree about
    // the facade itself. Anything the two do not share is the `@reatom/core` block and nothing
    // else.
    const prompt = fs.readFileSync(PROMPT_COPY, "utf8");
    expect(RUNTIME_DTS.startsWith(prompt)).toBe(true);
    expect(RUNTIME_DTS.slice(prompt.length).trimStart().startsWith(REATOM_BLOCK_OPENER)).toBe(true);
  });
});

// ── The honest-values fence ─────────────────────────────────────────────────────────────────
//
// `scripts/gen-runtime-dts.ts`'s header rejects hand-written structural stand-ins for
// `Atom`/`Computed` outright, and inlining the real package is only acceptable because it is
// EMITTED, never authored. This test is what makes that checkable rather than a claim in a
// comment: every line of the inlined block must trace to a line of the installed package's own
// `dist/index.d.ts`, modulo exactly two documented transformations — the leading `declare ` strip
// (a nested `declare` inside an already-ambient block is TS1038) and the two-space indent.
//
// It deliberately does NOT import the generator's transformation helpers. Re-deriving the
// expected text from the package here means a bug in the generator cannot also alter what the
// test expects.
describe("the gate copy declares nothing this repository authored by hand", () => {
  test("every inlined line traces to the installed @reatom/core declaration", () => {
    const manifest = Bun.resolveSync("@reatom/core/package.json", process.cwd());
    const source = fs.readFileSync(path.join(path.dirname(manifest), "dist", "index.d.ts"), "utf8");
    const expected = source
      .replace(/\r\n/g, "\n")
      .split("\n")
      .map((line) => (line.startsWith("declare ") ? line.slice("declare ".length) : line))
      .map((line) => (line.trim().length === 0 ? "" : `  ${line}`));

    const start = RUNTIME_DTS.indexOf(REATOM_BLOCK_OPENER);
    expect(start).toBeGreaterThan(-1);
    const block = RUNTIME_DTS.slice(start).split("\n");
    // First line is the opener, last non-empty line is the closing brace this repository adds;
    // everything between them is the package's own text.
    expect(block[0]).toBe(REATOM_BLOCK_OPENER);
    const body = block.slice(1, 1 + expected.length);
    expect(body).toEqual(expected);
    expect(block[1 + expected.length]).toBe("}");
  });
});
