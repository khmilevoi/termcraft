import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { LanguageVariant, createScanner } from "typescript/unstable/ast";

import { readStaticImportSpecifier } from "./import-scan";
import { readJsxTextRanges } from "./jsx";
import { SK, type Tok } from "./lexer";
import { parsesJsx, scanModuleEdges, scanTreeImports } from "./tree-scan";

/**
 * THE DIFFERENTIAL ORACLE (task 14b) — the harness that decides whether `./lexer`'s invariant
 * actually holds, rather than whether one more reviewer-supplied input is handled.
 *
 * Three formulations of this fix shipped before it existed, each closing the single input a
 * reviewer had found and each defeated by the next shape. What broke the cycle on task 12b was
 * measuring the real thing against an oracle instead of reasoning about a predicate, and this is
 * the analogue: for every input it compares
 *
 *  - what **Bun** does with the file — `Bun.Transpiler.transformSync` for accept/reject, and
 *    `Bun.Transpiler.scanImports`, which is Bun's OWN parse of the module's runtime import
 *    edges (`import type` is correctly absent from it, because it is not one); against
 *  - what the **gate** sees — the real `scanTreeImports` perimeter and the real
 *    `scanModuleEdges` closure-edge reader.
 *
 * THE WITNESS, and why the metric is sound. Every generated fixture's payload is one statement
 * pair, `import "node:fs"; eval("1");`. Bun reporting `node:fs` is GROUND TRUTH that the payload
 * region is executable code in the parse the runtime runs — established independently of
 * anything the gate believes. Two failures are then measurable against it:
 *
 *  - **UNDER-IMPORT** — Bun accepts, its parse holds specifier S, the gate did not refuse the
 *    file, and the gate mentions S nowhere (neither as a closure edge nor in any reported
 *    violation). The gate saw less than all of it.
 *  - **UNDER-EVAL** — the same row, and the gate additionally failed to report `EVAL_CALL` for
 *    the `eval("1")` sitting in that same proven-executable region.
 *
 * and the opposite direction, which this branch has paid for twice:
 *
 *  - **OVER-FATAL** — the gate reported a fatal on a payload-free control fixture, or refused a
 *    repository source. A guard that rejects legal input is a defect, not a trade-off.
 *
 * A REFUSAL IS NEVER AN UNDER-SCAN. `UNSCANNABLE_SOURCE` is the invariant working: the gate said
 * "I could not read this", the candidate is rejected, and nothing was vouched for.
 *
 * COUNTED HONESTLY (task 14b fix round 1, M6). The corpus SIZE and the rows actually SCANNED
 * are different numbers, because `Bun.Transpiler` panics — uncatchably — on a few fuzz shapes,
 * and because the corpora grew between measurements. Each figure below says which it is, and
 * which corpora it covers; the report carries the same arithmetic.
 *
 * NON-VACUITY is not a claim here, it is a test: {@link legacyEdges} below reproduces the
 * pre-task-14b code-mode lexing, and the last describe block asserts the oracle FLAGS it on the
 * very shapes it was blind to. If that block ever passes silently, this file has stopped
 * measuring anything.
 */

const PAYLOAD_SPEC = "node:fs";
const PAYLOAD = `import "${PAYLOAD_SPEC}"; eval("1");`;

/**
 * Every spelling of the §5.8 capability, because the metric is only as good as the payload
 * (task 14b fix round 2, Important 1). The first version of this file used ONE payload whose
 * `eval(` was precisely the spelling the then-current suppression rule still caught — so the
 * fiction fired on shape 26 and the oracle reported zero anyway. Each of these was measured LIVE
 * through the real perimeter before the suppression rule was deleted.
 *
 * `import "node:fs"` rides along in every row as the WITNESS: Bun reporting that edge is what
 * proves the region is executable code in the parse the runtime runs.
 */
const PAYLOAD_SPELLINGS: readonly (readonly [string, string])[] = [
  ["adjacent call", `import "${PAYLOAD_SPEC}"; eval("1");`],
  ["space before paren", `import "${PAYLOAD_SPEC}"; eval ("1");`],
  ["newline before paren", `import "${PAYLOAD_SPEC}"; eval\n("1");`],
  ["bare reference", `import "${PAYLOAD_SPEC}"; const e = eval;`],
  ["computed access", `import "${PAYLOAD_SPEC}"; (globalThis as any)["eval"]("1");`],
  ["global receiver", `import "${PAYLOAD_SPEC}"; (globalThis as any).eval("1");`],
  ["new Function with a space", `import "${PAYLOAD_SPEC}"; new Function ("return 1");`],
  ["parenthesised Function", `import "${PAYLOAD_SPEC}"; (Function)("return 1");`],
  ["unicode-escaped identifier", `import "${PAYLOAD_SPEC}"; \\u0065val("1");`],
];

/**
 * Carriers that make the JSX reader confirm an element the RUNTIME does not see, so everything
 * between them is a FICTIONAL children-text run. `%s` is where the payload goes.
 */
const FICTION_CARRIERS: readonly (readonly [string, string])[] = [
  ["type annotation", `let identity: <T>(x: T) => T = (x) => x;\n%s\n// </T>\n`],
  ["object-type method", `type O = { m: <T>(x: T) => T };\n%s\nconst end = "</T>";\n`],
  ["as-cast", `const v = 1 as unknown as <T>(x: T) => T;\n%s\n// </T>\n`],
  [
    "statement-position regex",
    `export function f(s: string) { if (1) /<b>/.test(s); }\n%s\n// </b>\n`,
  ],
  // REGEX HOLDING A QUOTE inside the fictional run — generated by no earlier shape, and the
  // second Critical of fix round 2: with `/` read as division the quote opened a string that
  // closed at the next regex and physically removed the payload from the stream, edge included.
  [
    "regex with an apostrophe",
    `let identity: <T>(x: T) => T = (x) => x;\nconst re = /it's/; %s const re2 = /don't/;\n// </T>\n`,
  ],
  [
    "regex with a backtick",
    `let identity: <T>(x: T) => T = (x) => x;\nconst re = /a\`b/;\n%s\nconst re2 = /c\`d/;\n// </T>\n`,
  ],
  [
    "regex with a double quote",
    `let identity: <T>(x: T) => T = (x) => x;\nconst re = /a"b/; %s const re2 = /c"d/;\n// </T>\n`,
  ],

  // THE PAYLOAD AFTER A BOUNDARY THAT LANDS INSIDE A GENUINE STRING (task 14b fix round 3,
  // Critical 1). Every carrier above closes its fictional run with a `</T>` written in a comment
  // AFTER the payload, so the payload always sat INSIDE the run. The missing axis is exactly
  // that transposition: close the run with a `</T>` inside a real STRING LITERAL and put the
  // payload after it. The boundary then bisects that literal, the next window's quote parity is
  // off by one against Bun's reading, and everything following becomes the interior of string
  // tokens — measured at `6a83f3f` as 112 of 112 rows losing every diagnostic AND every closure
  // edge, while coverage accounting reported the file whole. Coverage is not visibility.
  [
    "parity: type alias, tag in a string",
    `type X = <T extends unknown>(x: T) => T;\nconst s = "</T>"; %s\nexport const probe = 1;\n`,
  ],
  [
    "parity: generic arrow, tag in a string",
    `const f = <T extends unknown>(x: T) => x;\nconst s = "</T>"; %s\nexport const probe = 1;\n`,
  ],
  [
    "parity: annotation, tag in a string",
    `const g: <T>(x: T) => T = (x) => x;\nconst s = "</T>"; %s\nexport const probe = 1;\n`,
  ],
  [
    "parity: object-type method, tag in a string",
    `type O = { m: <T>(x: T) => T };\nconst s = "</T>"; %s\nexport const probe = 1;\n`,
  ],
  [
    "parity: as-cast, tag in a string",
    `const v = 1 as unknown as <T>(x: T) => T;\nconst s = "</T>"; %s\nexport const probe = 1;\n`,
  ],
  // A `{`-in-a-string variant is deliberately ABSENT: measured, an intervening `{` makes
  // `skipExpressionContainer` fail, so the element is never confirmed and the row would carry no
  // fiction at all — it would pass by testing ordinary code. The non-vacuity test below is what
  // caught that, which is exactly why it exists.
];

/**
 * Every (carrier x spelling x loader) row. This is the corpus the two Criticals of fix round 2
 * lived in and which no earlier generator could produce.
 */
function fictionCorpus(): Row[] {
  const rows: Row[] = [];
  let n = 0;
  for (const [carrierName, carrier] of FICTION_CARRIERS) {
    for (const [spellingName, payload] of PAYLOAD_SPELLINGS) {
      for (const [extension, loader] of [
        [".tsx", "tsx"],
        [".ts", "ts"],
      ] as const) {
        rows.push({
          name: `fiction[${carrierName} / ${spellingName} / ${extension}]`,
          source: carrier.replace("%s", payload),
          loader,
          relPath: `lib/x${n++}${extension}`,
          kind: "payload",
        });
      }
    }
  }
  return rows;
}

interface Divergence {
  readonly name: string;
  readonly source: string;
  readonly underImport: readonly string[];
  readonly underEval: boolean;
  readonly overFatal: readonly string[];
}

interface Row {
  readonly name: string;
  readonly source: string;
  readonly loader: "tsx" | "ts";
  readonly relPath: string;
  readonly kind: "repo" | "payload" | "control";
}

const transpilers = {
  tsx: new Bun.Transpiler({ loader: "tsx" }),
  ts: new Bun.Transpiler({ loader: "ts" }),
};

/** Bun's own reading: does it accept the file, and which runtime import edges does its parse hold? */
function bunView(row: Row): { accepts: boolean; specs: readonly string[] } {
  const transpiler = transpilers[row.loader];
  try {
    transpiler.transformSync(row.source);
  } catch {
    return { accepts: false, specs: [] };
  }
  try {
    const imports = transpiler.scanImports(row.source);
    return {
      accepts: true,
      specs: imports
        .filter(
          // `import-statement` and `dynamic-import` are both author-written runtime edges the
          // gate reports with a specifier. `require-call` is deliberately NOT here: Bun's own
          // JSX transform injects `react`/`react-jsx-runtime` requires into `scanImports`'
          // output for every `.tsx` source, which are not author edges — including them made
          // the metric report 90 phantom under-scans across the repository corpus alone.
          (i) => i.kind === "import-statement" || i.kind === "dynamic-import",
        )
        .map((i) => i.path),
    };
  } catch {
    return { accepts: true, specs: [] };
  }
}

/** The gate's reading, through the real whole-tree perimeter and the real closure-edge reader. */
function gateView(row: Row): { refused: boolean; specs: ReadonlySet<string>; codes: string[] } {
  const files = new Map([[row.relPath, row.source]]);
  const errors = scanTreeImports({ files, has: (p) => files.has(p) });
  const edges = scanModuleEdges(row.source, parsesJsx(row.relPath));
  const specs = new Set<string>(edges instanceof Error ? [] : edges);
  for (const error of errors) if (error.specifier !== "") specs.add(error.specifier);
  return {
    refused: errors.some((e) => e.code === "UNSCANNABLE_SOURCE"),
    specs,
    codes: errors.map((e) => e.code),
  };
}

function judge(row: Row): Divergence | null {
  const bun = bunView(row);
  const gate = gateView(row);
  const live = bun.accepts && !gate.refused;
  const underImport = live ? bun.specs.filter((s) => !gate.specs.has(s)) : [];
  const witnessed = live && row.kind === "payload" && bun.specs.includes(PAYLOAD_SPEC);
  // Any §5.8 code counts: the payload spellings reach the capability through `eval`, through
  // `Function`, and through a computed access, and a metric keyed to one of them is how the
  // first version of this oracle reported zero on a live bypass.
  const underEval =
    witnessed && !gate.codes.some((c) => c === "EVAL_CALL" || c === "FUNCTION_CALL");
  // The OVER metric's ground truth differs per corpus: a REPOSITORY file is legal Bun-accepted
  // source whose imports are genuinely forbidden inside a design tree, so its only over-fire is
  // a refusal; a CONTROL fixture carries no payload at all, so any fatal is a false rejection.
  // Only a source the RUNTIME accepts can be over-fired on: refusing what Bun refuses is the
  // guard agreeing with reality, not a false rejection. Without this the `.ts` control rows —
  // which are JSX in a non-JSX file, and which Bun rejects outright — read as 12 over-fires.
  const overFatal = !bun.accepts
    ? []
    : row.kind === "repo"
      ? gate.codes.filter((c) => c === "UNSCANNABLE_SOURCE")
      : row.kind === "control"
        ? gate.codes
        : [];
  if (underImport.length === 0 && !underEval && overFatal.length === 0) return null;
  return { name: row.name, source: row.source, underImport, underEval, overFatal };
}

function runCorpus(rows: readonly Row[]): Divergence[] {
  const found: Divergence[] = [];
  for (const row of rows) {
    const divergence = judge(row);
    if (divergence !== null) found.push(divergence);
  }
  return found;
}

/** A failure message that names the shapes, so a regression says WHAT reopened, not just how many. */
function report(found: readonly Divergence[]): string[] {
  return found
    .slice(0, 12)
    .map(
      (d) =>
        `${d.name} under=${JSON.stringify(d.underImport)} eval=${d.underEval} over=${JSON.stringify(d.overFatal)} src=${JSON.stringify(d.source)}`,
    );
}

// ---------------------------------------------------------------------------------------------
// Corpus 1 — the repository's own sources.
// ---------------------------------------------------------------------------------------------

function repositoryCorpus(): Row[] {
  const root = path.resolve(import.meta.dir, "../../..");
  const rows: Row[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        walk(p);
        continue;
      }
      if (!/\.(ts|tsx|mts|cts)$/.test(entry.name)) continue;
      const jsx = /\.tsx$/.test(entry.name);
      rows.push({
        name: path.relative(root, p),
        source: fs.readFileSync(p, "utf8"),
        loader: jsx ? "tsx" : "ts",
        relPath: `lib/${rows.length}${jsx ? ".tsx" : ".ts"}`,
        kind: "repo",
      });
    }
  };
  walk(path.join(root, "src"));
  return rows;
}

// ---------------------------------------------------------------------------------------------
// Corpus 2 — a systematic grid over the constructs a TS lexer and a JSX parser read differently.
// ---------------------------------------------------------------------------------------------

/** Every fragment measured to lex differently in code position and in JSX children position. */
const TRAPS: readonly string[] = [
  "plain",
  "it's",
  "don't do it",
  "a // b",
  "a /* b",
  "a */ b",
  "a /* b */ c",
  "#7ad7ff",
  "#",
  "# heading",
  "`tick",
  "`a${b}c`",
  '"quote',
  "'apos",
  "50% > 40%",
  "a < b",
  "x -- y",
  "\\ backslash",
  "�",
  "&amp;",
  "3 / 4",
  "/re/",
  "?? nullish",
  "a ?. b",
  "</closer",
  "0x{",
  "}brace",
  "$${",
  "e.g. eval",
  "<!-- html -->",
];

/** Where the trap sits: children, nested children, a fragment, an attribute, a regex, a comment. */
const SHAPES: readonly ((trap: string, payload: string) => string)[] = [
  (t, p) => `export const T = () => <p>${t}</p>;\n${p}\n`,
  (t, p) => `export const T = () => <p>${t}</p>; ${p}\n`,
  (t, p) => `export const T = () => <p><b>${t}</b></p>; ${p}\n`,
  (t, p) => `export const T = () => <>${t}</>; ${p}\n`,
  (t, p) => `export const T = () => <p>a{1}${t}</p>; ${p}\n`,
  (t, p) => `export const T = () => <p id="x">${t}</p>; ${p}\n`,
  (t, p) => `export const T = () => <p>{"z"}${t}</p>; ${p}\n`,
  (t, p) => `export const T = () => <p>${t}<b/>${t}</p>; ${p}\n`,
  (t, p) => `export const T = () => <p>\n  ${t}\n</p>;\n${p}\n`,
  (t, p) => `/* ok */ export const T = () => <p>${t}</p>; ${p}\n`,
  (t, p) => `export const T = () => <p>${t}</p>;\nexport const U = () => <p>${t}</p>;\n${p}\n`,
  (t, p) => `export const T = () => <p>${t}</p>;\n${p}\nexport const V = () => <p>${t}</p>;\n`,
  (t, p) => `const s = \`\${/[{]/.test("x")}\`; // ${t}\n${p}\n`,
  (t, p) => `const s = \`\${/[}]/.test("x")}\`; // ${t}\n${p}\n`,
  (t, p) => `function f(){ if (1) /re/.test("${t.slice(0, 2)}"); }\n${p}\n`,
  (t, p) => `const a = 1; const b = a /2/ 1; // ${t}\n${p}\n`,
  (t, p) => `export const T = () => <p title="${t.replaceAll('"', "'")}">z</p>; ${p}\n`,
  // CONTAINER-POSITION shapes, added after the first version of this file MISSED a live bypass.
  // A boundary-moving gap inside a JSX expression container swallows the container's tail
  // without touching any top-level import, so a witness sitting after the element proves
  // nothing about it. These put the witness INSIDE the container, which is only possible
  // because a dynamic `import(...)` is an expression — and `scanImports` reports it, so Bun's
  // parse still supplies the ground truth. Two shapes here were measured live and are what
  // `./jsx`'s `jsxPunctuation` distinction closed.
  (t, p) => `export const el = <box id="b">a{0 < ${cls(t)}.test("s") && ${p}}b</box>;\n`,
  (t, p) => `export const el = <box id="b">a{f() ${cls(t)}.test("s") && ${p}}b</box>;\n`,
  (t, p) => `export const el = <box id="b">a{ {} ${cls(t)}.test("s") && ${p}}b</box>;\n`,
  (t, p) =>
    `export const el = <box id="b">{(function(){ if (1) /[}]/.test("a"); return ${p} })()}</box>;\n`,
  (t, p) => `export const el = <box id="b">${t}{${p}}</box>;\n`,
  (t, p) => `const s = \`\${0 < /[{]/.test("x")}\`; // ${t}\n${p};\n`,
  (t, p) => `const s = \`\${0 < /[}]/.test("x")}\`; // ${t}\n${p};\n`,
  // CLOSING TAG AFTER THE PAYLOAD (task 14b fix round 1, Important 2). Every shape above puts
  // its closing tag before the payload, so none of them could produce the class Critical 1 was:
  // an "element" a JSX reader confirms across the payload, using a `</…>` written later in a
  // comment, a string, or bare. In a `.ts` file that element is pure fiction; in a `.tsx` file
  // it is fiction whenever the `<` opened a type-parameter list rather than an element.
  (t, p) => `let a: <T>(x: T) => T; // ${t}\n${p}\n// </T>\n`,
  (t, p) => `type O = { m: <T>(x: T) => T }; // ${t}\n${p}\nconst end = "</T>";\n`,
  (t, p) => `const v = 1 as unknown as <T>(x: T) => T; // ${t}\n${p}\n// </T>\n`,
  (t, p) => `export function f(s: string) { if (1) /<b>/.test(s); } // ${t}\n${p}\n// </b>\n`,
  (t, p) => `const w = a < b; // ${t}\n${p}\n// </b>\n`,
  (t, p) => `export const T = () => <p>${t}</p>;\n${p}\n// </p>\n`,
];

/** The index of the first CONTAINER-POSITION shape, which takes the expression payload. */
const FIRST_CONTAINER_SHAPE = 17;

/** A regular-expression character class holding a brace, which is what desynchronises a lexer. */
function cls(trap: string): string {
  return `/[${["}", "{", "]", "["][trap.length % 4]}]/`;
}

/** The payload as an EXPRESSION, so it can sit inside a JSX expression container. */
const CONTAINER_PAYLOAD = `(import("${PAYLOAD_SPEC}"), eval("1"))`;

function systematicCorpus(): Row[] {
  const rows: Row[] = [];
  let n = 0;
  // BOTH LOADERS (task 14b fix round 1, Important 2). The first version of this file generated
  // every row as `.tsx`, so HALF the differential space was unmeasured — and that half is where
  // Critical 1 lived: Bun parses no JSX in a `.ts` file while the gate parsed it in every file.
  // A generator that cannot produce a class is not evidence about that class.
  for (const [extension, loader] of [
    [".tsx", "tsx"],
    [".ts", "ts"],
  ] as const) {
    for (const trap of TRAPS) {
      for (const [index, shape] of SHAPES.entries()) {
        const payload = index >= FIRST_CONTAINER_SHAPE ? CONTAINER_PAYLOAD : PAYLOAD;
        rows.push({
          name: `sys[${extension} trap=${JSON.stringify(trap)} shape=${index}]`,
          source: shape(trap, payload),
          loader,
          relPath: `lib/g${n++}${extension}`,
          kind: "payload",
        });
        // The over-fire control: the identical shape with NO payload. Any fatal is a false
        // rejection of a page whose display copy merely spells something alarming.
        rows.push({
          name: `ctl[${extension} trap=${JSON.stringify(trap)} shape=${index}]`,
          source: shape(trap, ""),
          loader,
          relPath: `lib/c${n++}${extension}`,
          kind: "control",
        });
      }
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------------------------
// Corpus 3 — every code point in U+0000..U+02FF, in code position and in JSX-text position.
// ---------------------------------------------------------------------------------------------

function charSweepCorpus(): Row[] {
  const shapes = [
    (x: string) => `const a = 1;\n${x}\n${PAYLOAD}\n`,
    (x: string) => `export const T = () => <p>${x}</p>;\n${PAYLOAD}\n`,
    (x: string) => `export const T = () => <p>${x}</p>; ${PAYLOAD}\n`,
    (x: string) => `const a = 1; ${x} ${PAYLOAD}\n`,
  ];
  const rows: Row[] = [];
  let n = 0;
  for (let code = 0; code < 0x300; code += 1) {
    const char = String.fromCharCode(code);
    for (const [index, shape] of shapes.entries()) {
      rows.push({
        name: `char[U+${code.toString(16).padStart(4, "0")} shape=${index}]`,
        source: shape(char),
        loader: "tsx",
        relPath: `lib/h${n++}.tsx`,
        kind: "payload",
      });
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------------------------
// Corpus 4 — seeded randomized fuzzing over the same alphabet.
// ---------------------------------------------------------------------------------------------

const FUZZ_ATOMS: readonly string[] = [
  "<p>",
  "</p>",
  "<b/>",
  "<>",
  "</>",
  "{",
  "}",
  "{x}",
  "'",
  '"',
  "`",
  "//",
  "/*",
  "*/",
  "#",
  "/",
  "\\",
  "\n",
  " ",
  "a",
  "1",
  "(",
  ")",
  "[",
  "]",
  ";",
  "=",
  "<",
  ">",
  "${",
  "�",
  "&",
  "-",
  "...",
  "=>",
  "const t =",
  "export default",
  "return",
  "typeof",
  "/re/",
  "id=",
  "<p id='a'>",
];

/** A seeded PRNG, so a failing fuzz row is reproducible from the seed alone. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fuzzCorpus(count: number, seed: number): Row[] {
  const rand = mulberry32(seed);
  const rows: Row[] = [];
  for (let i = 0; i < count; i += 1) {
    const length = 3 + Math.floor(rand() * 22);
    let body = "";
    for (let j = 0; j < length; j += 1) body += FUZZ_ATOMS[Math.floor(rand() * FUZZ_ATOMS.length)]!;
    // SPLICED, not only glued (task 14b fix round 1, Important 2). Gluing the payload before or
    // after the whole body cannot produce a body that BRACKETS it, which is exactly the shape
    // Critical 1 needed. A random interior cut can, and it costs nothing.
    const cut = Math.floor(rand() * (body.length + 1));
    const spliced = `${body.slice(0, cut)}\n${PAYLOAD}\n${body.slice(cut)}\n`;
    const jsx = rand() < 0.5;
    rows.push({
      name: `fuzz#${i}`,
      source: spliced,
      loader: jsx ? "tsx" : "ts",
      relPath: `lib/f${i}${jsx ? ".tsx" : ".ts"}`,
      kind: "payload",
    });
  }
  return rows;
}

describe("the differential oracle — Bun's parse against the gate's view", () => {
  test("the repository's own 953 sources: zero under-scans and zero refusals", () => {
    const found = runCorpus(repositoryCorpus());
    expect(report(found)).toEqual([]);
  });

  test("the systematic grid of JSX/TS lexing traps, in BOTH loaders: zero under-scans and zero false fatals", () => {
    const rows = systematicCorpus();
    // Asserted so a shape or a trap silently disappearing is a failure, not a quieter run.
    expect(rows.length).toBe(TRAPS.length * SHAPES.length * 2 * 2);
    expect(rows.filter((r) => r.relPath.endsWith(".ts")).length).toBe(rows.length / 2);
    const found = runCorpus(rows);
    expect(report(found)).toEqual([]);
  });

  test("every code point in U+0000..U+02FF, in code position and in JSX text: zero under-scans", () => {
    const rows = charSweepCorpus();
    expect(rows.length).toBe(0x300 * 4);
    const found = runCorpus(rows);
    expect(report(found)).toEqual([]);
  });

  test("fictional prose runs, every payload spelling and both loaders: zero under-scans", () => {
    // THE CORPUS THE TWO CRITICALS OF FIX ROUND 2 LIVED IN. Its size is computed from the
    // generators rather than written down, so a carrier or a spelling silently disappearing is a
    // failure here instead of a quieter run (Minor 1 of that review).
    const rows = fictionCorpus();
    expect(rows.length).toBe(FICTION_CARRIERS.length * PAYLOAD_SPELLINGS.length * 2);
    expect(rows.filter((r) => r.relPath.endsWith(".ts")).length).toBe(rows.length / 2);
    const found = runCorpus(rows);
    expect(report(found)).toEqual([]);
  });

  test("the corpus really does carry the fiction — otherwise the row above proves nothing", () => {
    // NON-VACUITY for this corpus specifically: the carriers must actually make the JSX reader
    // confirm an element the runtime does not see. If a Bun or TypeScript upgrade stopped the
    // reader seeing one, these rows would pass by testing ordinary code.
    const carriers = fictionCorpus().filter((r) => r.relPath.endsWith(".tsx"));
    const withFiction = carriers.filter((r) => readJsxTextRanges(r.source).length > 0);
    expect(withFiction.length).toBe(carriers.length);
  });

  test("…and the parity carriers really do put a boundary INSIDE a string literal", () => {
    // The second non-vacuity property, for the axis fix round 3 added. A parity row only tests
    // anything if its run actually ends inside the `"</T>"` literal; if the reader stopped
    // drawing the boundary there, the rows would pass by testing ordinary code again.
    const parity = fictionCorpus().filter(
      (r) => r.name.includes("parity:") && r.relPath.endsWith(".tsx"),
    );
    expect(parity.length).toBeGreaterThan(0);
    for (const row of parity) {
      const ranges = readJsxTextRanges(row.source);
      const quote = row.source.indexOf('"');
      const closingQuote = row.source.indexOf('"', quote + 1);
      const bisects =
        ranges.some((r) => r.pos > quote && r.pos <= closingQuote) ||
        ranges.some((r) => r.end > quote && r.end <= closingQuote);
      expect([row.name, bisects]).toEqual([row.name, true]);
    }
  });

  test("seeded fuzz over the same alphabet: zero under-scans", () => {
    // BOUNDED HERE, not exhaustive: 20 000 rows were run at task 14b's base commit and again
    // after the fix; this slice is what the suite can afford on every run. The seed is fixed so
    // a failure is reproducible, and `Bun.Transpiler` is known to PANIC (not throw, and so not
    // catchable) on roughly 3 in 10 000 of these shapes — measured, 6 of 20 000 — which is why
    // the shipped slice is small enough to have been verified panic-free rather than wrapped in
    // subprocess machinery this file does not otherwise need.
    // `ORACLE_FUZZ` lets the same generator be swept far wider out of band without a second
    // copy of it drifting from this one — task 14b's report quotes a 20 000-row run made this
    // way. The default is what the suite can afford on every run.
    const count = Number(process.env["ORACLE_FUZZ"] ?? 1500);
    const found = runCorpus(fuzzCorpus(count, 0x14b));
    expect(report(found)).toEqual([]);
  });
});

/**
 * `tokenize` AS IT WAS AT `fd9ec53` — a plain CODE-mode lex with no knowledge of where JSX text
 * is and no regular-expression re-scan, reproduced here for ONE purpose: proving the oracle
 * above can fail.
 *
 * A harness that reports zero divergences is worthless unless it is shown to report non-zero on
 * a reading that really is blind, and "I ran it against the old commit once" is not a property
 * a suite can keep. The block below feeds the same corpus through this reading and asserts the
 * oracle's own metric flags it, on the exact shapes that were measured live.
 */
function legacyEdges(source: string): readonly string[] {
  const toks: Tok[] = [];
  const scanner = createScanner(true, LanguageVariant.Standard);
  scanner.setText(source);
  const braces: ("brace" | "template")[] = [];
  for (let guard = 0; guard <= source.length + 1; guard += 1) {
    const kind = ((): number => {
      const scanned = scanner.scan();
      if (scanned === SK.OpenBraceToken) braces.push("brace");
      else if (scanned === SK.TemplateHead) braces.push("template");
      else if (scanned === SK.CloseBraceToken) {
        if (braces[braces.length - 1] !== "template") {
          braces.pop();
          return scanned;
        }
        const resumed = scanner.reScanTemplateToken(false);
        if (resumed !== SK.TemplateMiddle) braces.pop();
        return resumed;
      }
      return scanned;
    })();
    if (kind === SK.EndOfFile) break;
    if (scanner.getTokenEnd() === scanner.getTokenStart()) {
      scanner.resetTokenState(scanner.getTokenStart() + 1);
      continue;
    }
    toks.push({
      kind,
      value: kind === SK.StringLiteral ? scanner.getTokenValue() : "",
      pos: scanner.getTokenStart(),
    });
  }
  const edges: string[] = [];
  for (let i = 0; i < toks.length; i += 1) {
    if (toks[i]?.kind !== SK.ImportKeyword) continue;
    const next = toks[i + 1];
    if (next?.kind === SK.DotToken || next?.kind === SK.OpenParenToken) continue;
    const specifier = readStaticImportSpecifier(toks, i);
    if (specifier !== null) edges.push(specifier);
  }
  return edges;
}

describe("the oracle is NOT vacuous — it flags the reading this fix replaced", () => {
  /** The shapes measured LIVE at `fd9ec53`: Bun executed all of them, the gate reported nothing. */
  const HISTORICAL: readonly (readonly [string, string])[] = [
    ["JSX text, unterminated `/*`", `export const T = () => <p>a /* b</p>; ${PAYLOAD}\n`],
    [
      "JSX text, `/*` with a later `*/`",
      `export const T = () => <p>a /* b</p>; ${PAYLOAD}\n/* x */\n`,
    ],
    ["JSX text, an apostrophe", `export const T = () => <p>it's</p>; ${PAYLOAD}\n`],
    ["JSX text, `//`", `export const T = () => <p>see // here</p>; ${PAYLOAD}\n`],
    ["JSX text, a backtick", `export const T = () => <p>\`tick</p>; ${PAYLOAD}\n`],
    [
      "nested JSX text, unterminated `/*`",
      `export const T = () => <p><b>a /* b</b></p>; ${PAYLOAD}\n`,
    ],
    ["fragment JSX text, unterminated `/*`", `export const T = () => <>a /* b</>; ${PAYLOAD}\n`],
    [
      "KNOWN GAP 6b, a `{` in a regex character class",
      `const s = \`\${/[{]/.test("x")}\`;\n${PAYLOAD}\n`,
    ],
    [
      "KNOWN GAP 6b reached through a relational `<`",
      `const s = \`\${0 < /[{]/.test("x")}\`;\n${PAYLOAD}\n`,
    ],
  ];

  test("Bun accepts every historical shape — otherwise none of them was ever a bypass", () => {
    for (const [name, source] of HISTORICAL) {
      expect(() => transpilers.tsx.transformSync(source)).not.toThrow();
      expect(transpilers.tsx.scanImports(source).map((i) => i.path)).toContain(PAYLOAD_SPEC);
      expect(name).toBeTruthy();
    }
  });

  test("the pre-fix code-mode reading loses the payload on EVERY historical shape", () => {
    // If this ever reports "blind on 0", the simulation has drifted and the non-vacuity claim
    // below it means nothing — so it asserts the count, not merely "some".
    const blind = HISTORICAL.filter(([, source]) => !legacyEdges(source).includes(PAYLOAD_SPEC));
    expect(blind.map(([name]) => name)).toEqual(HISTORICAL.map(([name]) => name));
  });

  test("…and the shipped reading finds it on every one of them", () => {
    for (const [name, source] of HISTORICAL) {
      const edges = scanModuleEdges(source, "jsx");
      if (edges instanceof Error) throw new Error(`${name}: unexpected refusal — ${edges.message}`);
      expect([name, [...edges]]).toEqual([name, [PAYLOAD_SPEC]]);
      const files = new Map([["lib/theme.tsx", source]]);
      const codes = scanTreeImports({ files, has: (p) => files.has(p) }).map((e) => e.code);
      expect([name, codes.includes("EVAL_CALL")]).toEqual([name, true]);
    }
  });
});
