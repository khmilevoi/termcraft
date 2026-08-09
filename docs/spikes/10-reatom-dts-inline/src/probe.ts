// Spike 10 — does inlining the real `@reatom/core` declarations into the Gate's ambient
// declaration make atom reads typed, and at what cost?
//
// Run from the REPOSITORY ROOT so the tsconfig path aliases resolve:
//   bun run docs/spikes/10-reatom-dts-inline/src/probe.ts
//
// MEASURES THE REAL SEAM, NOT A REPLICA. `createTreeTypeChecker` + `resolveCompilerPath()` +
// the committed `RUNTIME_DTS` is exactly what `entrypoint/model/create-shell.ts:287` wires in
// production. Rebuilding the Gate's synthesized options here by hand would answer a question
// about the replica, and the options (`types: []`, `lib: ["esnext"]`, `skipLibCheck: true`,
// `cwd = os.tmpdir()`) are the load-bearing part of the question.
import fs from "node:fs";
import path from "node:path";

import { createTreeTypeChecker, resolveCompilerPath } from "gate";
import { RUNTIME_DTS } from "runtime/generated/runtime-dts";

const REATOM_CORE_SPECIFIER = "@reatom/core";

/**
 * Resolve the installed package's own declaration through MODULE RESOLUTION, never a hand-built
 * `node_modules/...` path — the same rule `scripts/gen-runtime-dts.ts:124-139` follows for the
 * platform compiler. If the real generator ever adopts this, it must resolve the same way.
 */
function resolveReatomCoreDts(): string | Error {
  try {
    const manifest = Bun.resolveSync(`${REATOM_CORE_SPECIFIER}/package.json`, process.cwd());
    const dts = path.join(path.dirname(manifest), "dist", "index.d.ts");
    if (!fs.existsSync(dts)) return new Error(`${dts} does not exist`);
    return dts;
  } catch (cause) {
    return new Error(`cannot resolve ${REATOM_CORE_SPECIFIER}`, { cause });
  }
}

/**
 * The `declare global { … }` block and its extent, so the probe can test the declaration BOTH
 * with and without it. Located by its opening line rather than by a line number, because the
 * package's own layout is not ours to pin.
 *
 * Brace-counted from the opening line, so a nested brace inside the block cannot end it early.
 */
function findGlobalBlock(lines: readonly string[]): { start: number; end: number } | null {
  const start = lines.findIndex((line) => /^declare global\s*\{/.test(line));
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
    if (depth === 0) return { start, end: i };
  }
  return null;
}

/**
 * Wrap the package's declaration in `declare module "@reatom/core" { … }`.
 *
 * ONE TRANSFORMATION ONLY: the leading `declare ` is stripped from each top-level declaration,
 * for exactly the reason `gen-runtime-dts.ts:213-231` documents — a nested `declare` inside an
 * already-ambient block is TS1038. Everything else is passed through byte-for-byte, including the
 * final `export { … }` surface list. Nothing is invented, nothing is rewritten.
 */
function buildReatomBlock(dtsPath: string, dropGlobal: boolean): string {
  const raw = fs.readFileSync(dtsPath, "utf8").replace(/\r\n/g, "\n");
  const lines = raw.split("\n");

  const kept = (() => {
    if (!dropGlobal) return lines;
    const block = findGlobalBlock(lines);
    if (block === null) return lines;
    return [...lines.slice(0, block.start), ...lines.slice(block.end + 1)];
  })();

  const body = kept
    .map((line) => (line.startsWith("declare ") ? line.slice("declare ".length) : line))
    .map((line) => (line.trim().length === 0 ? "" : `  ${line}`))
    .join("\n");

  return `declare module "${REATOM_CORE_SPECIFIER}" {\n${body}\n}\n`;
}

/** The four fixtures, each a whole tree the checker sees at once. */
const FIXTURES: readonly { name: string; expect: "clean" | "type-error"; files: Record<string, string> }[] = [
  {
    // The measured `alarm.tsx:98` shape: a method call directly on an atom read.
    name: "measured-map",
    expect: "clean",
    files: {
      "pages/a.tsx": `
import { atom, reatomComponent } from "@termcraft/runtime";
interface Item { readonly name: string }
const itemsAtom = atom<readonly Item[]>([], "itemsAtom");
export const meta = { title: "A", kitApiVersion: 1 };
export default reatomComponent(() => (
  <box id="root">{itemsAtom().map((i) => i.name).join(",")}</box>
), "A");
`,
    },
  },
  {
    // The measured `alarm.tsx:102` and `stopwatch.tsx:126` shapes: `.filter` on an atom read,
    // and `.map` over a const BINDING of one — the second is what proves the fix is about the
    // atom's type and not about the call expression's shape.
    name: "measured-filter-and-binding",
    expect: "clean",
    files: {
      "pages/a.tsx": `
import { atom, reatomComponent } from "@termcraft/runtime";
interface Alarm { readonly at: string; readonly on: boolean }
const alarmsAtom = atom<readonly Alarm[]>([], "alarmsAtom");
const lapsAtom = atom<readonly number[]>([], "lapsAtom");
export const meta = { title: "A", kitApiVersion: 1 };
export default reatomComponent(() => {
  const enabled = alarmsAtom().filter((a) => a.on);
  const laps = lapsAtom();
  const rows = laps.map((lapMs, i) => \`\${i}:\${lapMs}\`);
  return <box id="root">{\`\${enabled.length} \${rows.join(",")}\`}</box>;
}, "A");
`,
    },
  },
  {
    // THE OTHER DIRECTION. A check that passes everything is not a check. If this comes back
    // clean the inline has DISABLED type checking, which looks identical to success everywhere
    // else — this fixture is the only thing that can tell the two apart.
    name: "real-type-error",
    expect: "type-error",
    files: {
      "pages/a.tsx": `
import { atom, reatomComponent } from "@termcraft/runtime";
interface Item { readonly name: string }
const itemsAtom = atom<readonly Item[]>([], "itemsAtom");
export const meta = { title: "A", kitApiVersion: 1 };
export default reatomComponent(() => (
  <box id="root">{itemsAtom().map((i) => i.nope).join(",")}</box>
), "A");
`,
    },
  },
  {
    // The measured site that was NOT flagged (`alarm.tsx:115`): the spread yields `any[]`, whose
    // signatures type the parameters contextually. It must stay clean AFTER the inline too —
    // otherwise the fix has merely re-deranged which sites are wrong.
    name: "spread-sort",
    expect: "clean",
    files: {
      "pages/a.tsx": `
import { atom, reatomComponent } from "@termcraft/runtime";
interface Item { readonly rank: number }
const itemsAtom = atom<readonly Item[]>([], "itemsAtom");
export const meta = { title: "A", kitApiVersion: 1 };
export default reatomComponent(() => (
  <box id="root">{[...itemsAtom()].sort((a, b) => a.rank - b.rank).length}</box>
), "A");
`,
    },
  },
];

interface Variant {
  readonly name: string;
  readonly dts: string;
}

async function main(): Promise<number> {
  const tscExePath = resolveCompilerPath();
  if (tscExePath instanceof Error) {
    console.error(`cannot resolve the compiler: ${tscExePath.message}`);
    return 1;
  }

  const dtsPath = resolveReatomCoreDts();
  if (dtsPath instanceof Error) {
    console.error(dtsPath.message);
    return 1;
  }

  const withGlobal = buildReatomBlock(dtsPath, false);
  const withoutGlobal = buildReatomBlock(dtsPath, true);

  const variants: readonly Variant[] = [
    { name: "baseline", dts: RUNTIME_DTS },
    { name: "inlined", dts: `${RUNTIME_DTS}\n${withGlobal}` },
    { name: "inlined-no-global", dts: `${RUNTIME_DTS}\n${withoutGlobal}` },
  ];

  console.log("=== Q4b: declaration sizes (bytes) ===");
  for (const v of variants) console.log(`  ${v.name.padEnd(20)} ${v.dts.length}`);
  console.log(`  @reatom/core source  ${fs.statSync(dtsPath).size}  (${dtsPath})`);
  console.log();

  console.log("=== Q1/Q2/Q3: diagnostics per fixture per variant ===");
  for (const variant of variants) {
    const check = createTreeTypeChecker({ tscExePath, runtimeDts: variant.dts });
    for (const fixture of FIXTURES) {
      const files = new Map(Object.entries(fixture.files));
      const started = performance.now();
      const diagnostics = await check({ files });
      const ms = Math.round(performance.now() - started);

      const codes = diagnostics.map((d) => `${d.code}${d.file === undefined ? "" : `@${d.file}`}`);
      const typeErrors = diagnostics.filter((d) => d.kind === "type");
      const verdict = (() => {
        if (fixture.expect === "clean") return diagnostics.length === 0 ? "PASS" : "FAIL";
        return typeErrors.length > 0 ? "PASS" : "FAIL (check is disabled, not fixed)";
      })();

      console.log(
        `  ${variant.name.padEnd(20)} ${fixture.name.padEnd(30)} ${String(ms).padStart(6)}ms  ` +
          `expect=${fixture.expect.padEnd(10)} ${verdict}`,
      );
      // EVERY diagnostic verbatim: Q3 is an enumeration question, so a count is not an answer.
      for (const d of diagnostics) {
        console.log(`      [${d.kind}/${d.code}] ${d.file ?? "<no file>"}: ${d.message}`);
      }
      if (diagnostics.length > 0 && codes.length === 0) console.log("      (no codes)");
    }
    console.log();
  }

  // Q4: the same tree, five runs each, so the reported cost is a median and not one sample.
  // A five-page tree with a shared module is what a real project's check looks like; a
  // one-page fixture would understate the parse cost the inline adds per check.
  console.log("=== Q4: median wall-clock over a five-page tree with a shared module (5 runs) ===");
  const realistic = new Map<string, string>([
    ["lib/theme.ts", `export const ACCENT = "#e0a03a";\nexport const rows = <T,>(xs: readonly T[]) => xs.length;\n`],
    ...["a", "b", "c", "d", "e"].map((slug): [string, string] => [
      `pages/${slug}.tsx`,
      `
import { atom, reatomComponent } from "@termcraft/runtime";
import { ACCENT, rows } from "../lib/theme";
interface Item { readonly name: string }
const itemsAtom = atom<readonly Item[]>([], "items_${slug}");
export const meta = { title: "${slug}", kitApiVersion: 1 };
export default reatomComponent(() => (
  <box id="root-${slug}" style={{ borderColor: ACCENT }}>
    {itemsAtom().map((i) => i.name).join(",")}{rows(itemsAtom())}
  </box>
), "P${slug}");
`,
    ]),
  ]);

  for (const variant of variants) {
    const check = createTreeTypeChecker({ tscExePath, runtimeDts: variant.dts });
    const samples: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const started = performance.now();
      const diagnostics = await check({ files: realistic });
      samples.push(performance.now() - started);
      if (i === 0) {
        console.log(`  ${variant.name}: ${String(diagnostics.length)} diagnostics on run 1`);
        for (const d of diagnostics) console.log(`      [${d.kind}/${d.code}] ${d.message}`);
      }
    }
    const sorted = [...samples].sort((x, y) => x - y);
    console.log(
      `  ${variant.name.padEnd(20)} median ${String(Math.round(sorted[2] ?? 0)).padStart(6)}ms  ` +
        `min ${String(Math.round(sorted[0] ?? 0))}ms  max ${String(Math.round(sorted[4] ?? 0))}ms`,
    );
  }

  console.log("\nCopy this output verbatim into SPIKE.md's Findings table before implementing.");
  return 0;
}

process.exit(await main());
