// Spike 13 — how many NEW determinism warnings do Tasks 4 and 5 produce on a real, shipped tree?
//
//   bun run docs/spikes/13-determinism-blast-radius/src/probe.ts
//
// No network, no SDK, no turn. Runs the REAL `lintDeterminism`/`lintSilencingAny` from
// `gate/model/lints.ts` over the REAL `examples/clock/.termcraft/design/` tree in two
// configurations — entries only (today) and every code file (after Task 5) — and diffs them.
//
// The `new Date()` column is MEASURED, not asserted: the probe runs the proposed shapes past the
// CURRENT lint to confirm they are unflagged today, so "new" means new rather than assumed-new.
import fs from "node:fs";
import path from "node:path";

import { isCodeFile, parsesJsx } from "entities/design-tree";
import { lintDeterminism, lintSilencingAny } from "gate";

const TREE_ROOT = path.join(process.cwd(), "examples/clock/.termcraft/design");
const MANIFEST = path.join(TREE_ROOT, "pages.json");

interface Finding {
  readonly file: string;
  readonly kind: string;
  readonly line: number | undefined;
  readonly message: string;
}

/** Every file in the tree, tree-relative with forward slashes, sorted. */
function walkTree(dir: string, prefix = ""): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      return entry.isDirectory() ? walkTree(path.join(dir, entry.name), rel) : [rel];
    })
    .sort();
}

function lintOne(relPath: string, source: string): Finding[] {
  const syntax = parsesJsx(relPath);
  const out: Finding[] = [];
  for (const lint of [lintDeterminism(source, syntax), lintSilencingAny(source, syntax)]) {
    if (lint instanceof Error) {
      console.error(`  !! ${relPath} could not be scanned: ${lint.message}`);
      continue;
    }
    for (const w of lint) out.push({ file: relPath, kind: w.kind, line: w.line, message: w.message });
  }
  return out;
}

/**
 * A page's closure, derived from its relative imports. A DELIBERATE APPROXIMATION: the real
 * resolver is `entities/design-tree`'s `resolveClosure`, which this probe does not drive because
 * it wants only a fan-out ESTIMATE for Q4. Task 5's own test asserts the real attribution against
 * the real resolver — do not lift this walk into production.
 */
function approximateClosure(entryRelPath: string, sources: ReadonlyMap<string, string>): Set<string> {
  const closure = new Set<string>();
  const queue = [entryRelPath];
  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined || closure.has(current)) continue;
    closure.add(current);
    const source = sources.get(current);
    if (source === undefined) continue;
    for (const match of source.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
      const spec = match[1];
      if (spec === undefined) continue;
      const resolvedBase = path.posix.normalize(path.posix.join(path.posix.dirname(current), spec));
      const candidate = [resolvedBase, `${resolvedBase}.tsx`, `${resolvedBase}.ts`].find((c) =>
        sources.has(c),
      );
      if (candidate !== undefined) queue.push(candidate);
    }
  }
  return closure;
}

function main(): number {
  if (!fs.existsSync(MANIFEST)) {
    console.error(`no manifest at ${MANIFEST} — run this from the repository root`);
    return 1;
  }

  const entries = (
    JSON.parse(fs.readFileSync(MANIFEST, "utf8")) as {
      pages: { slug: string; entry: string }[];
    }
  ).pages;

  const sources = new Map<string, string>();
  for (const relPath of walkTree(TREE_ROOT)) {
    if (!isCodeFile(relPath)) continue;
    sources.set(relPath, fs.readFileSync(path.join(TREE_ROOT, relPath), "utf8"));
  }

  console.log(`=== tree: ${TREE_ROOT}`);
  console.log(`    ${String(sources.size)} code files, ${String(entries.length)} pages\n`);

  // ── TODAY: entries only. This is what `gate/model/gate.ts:208-220` reaches.
  const entryPaths = new Set(entries.map((e) => e.entry));
  const today: Finding[] = [];
  for (const relPath of entryPaths) {
    const source = sources.get(relPath);
    if (source === undefined) continue;
    today.push(...lintOne(relPath, source));
  }

  // ── AFTER TASK 5: every code file in the tree.
  const after: Finding[] = [];
  for (const [relPath, source] of sources) after.push(...lintOne(relPath, source));

  const key = (f: Finding): string => `${f.file}:${String(f.line)}:${f.kind}`;
  const todayKeys = new Set(today.map(key));
  const newFromClosure = after.filter((f) => !todayKeys.has(key(f)));

  console.log("=== Q1a: what the CURRENT lint reports, entries only (today) ===");
  console.log(today.length === 0 ? "    (none)" : "");
  for (const f of today) console.log(`    ${f.file}:${String(f.line)} [${f.kind}]`);

  console.log("\n=== Q1b: what the SAME lint reports over every file (Task 5 alone) ===");
  console.log(`    total ${String(after.length)}, of which NEW: ${String(newFromClosure.length)}`);
  for (const f of newFromClosure) console.log(`    + ${f.file}:${String(f.line)} [${f.kind}]`);

  // ── Task 4's addition, measured against the CURRENT lint so "new" is a measurement.
  console.log("\n=== Q1c: `new Date()` sites Task 4 adds — confirmed unflagged TODAY ===");
  const dateSites: { file: string; line: number; text: string; seeded: boolean }[] = [];
  for (const [relPath, source] of sources) {
    source.split("\n").forEach((text, i) => {
      for (const m of text.matchAll(/new\s+Date\s*\(([^)]*)\)/g)) {
        // A `//`-comment match is trivia to the tokenizer; recorded so Q3 can be checked by eye.
        const beforeMatch = text.slice(0, m.index ?? 0);
        const inComment = beforeMatch.includes("//") || beforeMatch.trimStart().startsWith("*");
        if (inComment) continue;
        dateSites.push({
          file: relPath,
          line: i + 1,
          text: text.trim(),
          seeded: (m[1] ?? "").trim().length > 0,
        });
      }
    });
  }
  const argless = dateSites.filter((s) => !s.seeded);
  const seeded = dateSites.filter((s) => s.seeded);
  console.log(`    argument-less (Task 4 FLAGS these): ${String(argless.length)}`);
  for (const s of argless) console.log(`    + ${s.file}:${String(s.line)}  ${s.text}`);
  console.log(`\n=== Q2: seeded (Task 4 SPARES these): ${String(seeded.length)} ===`);
  for (const s of seeded) console.log(`      ${s.file}:${String(s.line)}  ${s.text}`);
  console.log("    ^ if this list is non-empty, the seeded exemption is load-bearing, not cosmetic:");
  console.log("      without it these would all warn for the one clock-free way to build a date.");

  const alreadyFlagged = after.filter((f) => /new Date/.test(f.message));
  console.log(
    `\n    sanity: the CURRENT lint already reports ${String(alreadyFlagged.length)} \`new Date\` ` +
      `warnings (expected 0 — that is what makes Task 4's additions NEW)`,
  );

  // ── Q3: comments and strings must stay out.
  console.log("\n=== Q3: comment/string sites that must NOT be flagged ===");
  let commentSites = 0;
  for (const [relPath, source] of sources) {
    source.split("\n").forEach((text, i) => {
      const trimmed = text.trim();
      if (!trimmed.startsWith("//") && !trimmed.startsWith("*")) return;
      if (!/Date\.now|setInterval|setTimeout|new Date|Math\.random|performance\.now/.test(text)) return;
      commentSites += 1;
      const flagged = after.some((f) => f.file === relPath && f.line === i + 1);
      console.log(`    ${flagged ? "FLAGGED (BUG)" : "clean        "} ${relPath}:${String(i + 1)}`);
    });
  }
  console.log(`    ${String(commentSites)} comment sites checked`);

  // ── Q4: fan-out of a shared-module warning.
  console.log("\n=== Q4: fan-out — which pages a shared-module warning would name ===");
  const sharedWarnings = after.filter((f) => !entryPaths.has(f.file));
  if (sharedWarnings.length === 0) console.log("    (no shared-module warnings)");
  for (const w of sharedWarnings) {
    const reaching = entries
      .filter((e) => approximateClosure(e.entry, sources).has(w.file))
      .map((e) => e.slug);
    console.log(
      `    ${w.file}:${String(w.line)} [${w.kind}] -> blocks: ${
        reaching.length === 0 ? "(none — orphan module)" : reaching.join(", ")
      }`,
    );
  }

  const grandTotal = after.length + argless.length;
  console.log("\n=== SUMMARY ===");
  console.log(`    today:                       ${String(today.length)} warnings`);
  console.log(`    after Task 5 (whole closure): ${String(after.length)}`);
  console.log(`    after Task 4 as well (+ new Date): ~${String(grandTotal)}`);
  console.log(`    pages in the tree:           ${String(entries.length)}`);
  if (grandTotal > entries.length)
    console.log(
      "\n    MORE WARNINGS THAN PAGES. Per SPIKE.md, this triggers an operator decision the\n" +
        "    plan does not currently make: are a pre-existing tree's warnings surfaced on OPEN,\n" +
        "    or only on the next turn that touches a page? Flag it; do not pick it in a task.",
    );
  console.log("\nCopy this output verbatim into SPIKE.md's Findings table.");
  return 0;
}

process.exit(main());
