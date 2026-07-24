// WP-11 (gap B7, deliverable C): the completeness proof for the embedded lib chain. Spike C's
// FINDINGS.md, "The embedded lib file list — 88 files": "no fixture can prove the lib chain is
// complete... the 87-walked == 87-asked cross-check is the real evidence [for completeness],
// not the fixtures." This module runs one real type-check with the pinned `lib: ["esnext"]`
// tsconfig, records the DISTINCT lib basenames the compiler actually reads (via the same
// virtual-FS `readFile` hook `gate/model/type-check.ts` installs — the callback fires for lib
// reads too even though they are answered `undefined` = "read the real disk"), and diffs that
// set against the curated embedded set. `askedButNotEmbedded` is the load-bearing field: a
// non-empty result means a real page would hit the Go compiler's `noembed` startup panic or a
// silent "cannot find name" the moment it touched that lib's declarations.
import os from "node:os";
import path from "node:path";

import * as errore from "errore";
import { API } from "typescript/unstable/sync";

import { materializeCompiler } from "gate";

import { resolveCompilerAssets } from "./embed-assets";
import { tscLibNames } from "./tsc-libs.generated";

/** The compiler subprocess crashed or produced no project — never a silent "asked for nothing". */
export class LibCrossCheckError extends errore.createTaggedError({
  name: "LibCrossCheckError",
  message: "the TypeScript compiler subprocess failed during the lib cross-check",
}) {}

export interface LibCrossCheckResult {
  readonly distinctLibsAsked: readonly string[];
  readonly askedButNotEmbedded: readonly string[];
  readonly embeddedButNeverAsked: readonly string[];
}

/** A `lib.*.d.ts` basename, matching Spike C's own tracking pattern. */
const LIB_RE = /^lib\..*\.d\.ts$/;

function norm(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * Pure diff: which asked-for lib names are missing from the embedded set (the completeness
 * failure this whole check exists to catch), and which embedded names the compiler never
 * touched (informational — Spike C found exactly one, the `lib.d.ts` startup sentinel, which
 * is stat'd but never read for content).
 */
export function diffLibs(params: {
  readonly asked: readonly string[];
  readonly embedded: readonly string[];
}): { readonly askedButNotEmbedded: string[]; readonly embeddedButNeverAsked: string[] } {
  const embeddedSet = new Set(params.embedded);
  const askedSet = new Set(params.asked);
  return {
    askedButNotEmbedded: params.asked.filter((name) => !embeddedSet.has(name)),
    embeddedButNeverAsked: params.embedded.filter((name) => !askedSet.has(name)),
  };
}

/**
 * Run one real type-check against a minimal fixture, with the SAME pinned `lib: ["esnext"]`
 * tsconfig `gate/model/type-check.ts` uses. Spike C: with `lib` pinned, the Program loads
 * every declared lib file unconditionally as part of building the global scope — regardless
 * of what the fixture's own code uses — so even a near-empty fixture asks for the full chain.
 */
export function runLibCrossCheckAgainst(params: {
  readonly tscExePath: string;
  readonly embeddedLibNames: readonly string[];
}): LibCrossCheckError | LibCrossCheckResult {
  const { tscExePath, embeddedLibNames } = params;
  const cwd = norm(os.tmpdir());
  const candidatePath = `${cwd}/termcraft-lib-cross-check-fixture.ts`;
  const tsconfigPath = `${cwd}/tsconfig.termcraft-lib-cross-check.json`;
  // No @termcraft/runtime import here on purpose: this check is ONLY about the lib chain, not
  // the runtime ambient declaration (a separate, still-unwired concern — see WP-11's report).
  const fixtureSource = [
    "export const m: Map<string, number> = new Map()",
    'export const p: Promise<string> = Promise.resolve("x")',
    "export const f: Float16Array = new Float16Array(1)",
    "",
  ].join("\n");
  const tsconfig = JSON.stringify({
    compilerOptions: {
      strict: true,
      noEmit: true,
      target: "esnext",
      module: "esnext",
      moduleResolution: "bundler",
      lib: ["esnext"],
      types: [],
      skipLibCheck: true,
    },
    files: [candidatePath],
  });

  const asked = new Set<string>();
  const virtualFs = {
    readFile(fileName: string): string | null | undefined {
      const n = norm(fileName);
      const base = path.basename(n);
      if (LIB_RE.test(base)) asked.add(base);
      if (n === tsconfigPath) return tsconfig;
      if (n === candidatePath) return fixtureSource;
      return undefined; // libs (and anything else) come off the real disk
    },
    fileExists(fileName: string): boolean | undefined {
      const n = norm(fileName);
      if (n === tsconfigPath || n === candidatePath) return true;
      return undefined;
    },
    realpath(p: string): string | undefined {
      const n = norm(p);
      if (n === tsconfigPath || n === candidatePath) return n;
      return undefined;
    },
  };

  // Raw try/catch, not `errore.try`: the Bun/Go subprocess bridge can throw non-Error values
  // (mirrors `gate/model/type-check.ts`'s own boundary, same reasoning).
  try {
    const api = new API({ cwd, tsserverPath: tscExePath, fs: virtualFs });
    try {
      const snapshot = api.updateSnapshot({ openProjects: [tsconfigPath] });
      const project = snapshot.getProject(tsconfigPath) ?? snapshot.getProjects()[0];
      if (project === undefined) {
        return new LibCrossCheckError({
          cause: new Error("no project loaded from the synthesized tsconfig"),
        });
      }
      // Force the compiler to actually build the program (and so read every declared lib) —
      // the diagnostic getters are what drive that in `typescript/unstable/sync`.
      project.program.getSemanticDiagnostics();
      project.program.getGlobalDiagnostics();
      const distinctLibsAsked = [...asked].sort();
      const { askedButNotEmbedded, embeddedButNeverAsked } = diffLibs({
        asked: distinctLibsAsked,
        embedded: embeddedLibNames,
      });
      return { distinctLibsAsked, askedButNotEmbedded, embeddedButNeverAsked };
    } finally {
      try {
        api.close();
      } catch (closeCause) {
        console.warn(
          "lib-cross-check: api.close() failed:",
          closeCause instanceof Error ? closeCause.message : String(closeCause),
        );
      }
    }
  } catch (cause) {
    return new LibCrossCheckError({ cause });
  }
}

if (import.meta.main) {
  const assets = resolveCompilerAssets();
  if (assets instanceof Error) {
    console.error(JSON.stringify({ error: assets.message }));
    process.exit(1);
  }

  const exePath = materializeCompiler(assets);
  if (exePath instanceof Error) {
    console.error(JSON.stringify({ error: exePath.message }));
    process.exit(1);
  }

  const result = runLibCrossCheckAgainst({ tscExePath: exePath, embeddedLibNames: tscLibNames });
  if (result instanceof Error) {
    console.error(JSON.stringify({ error: result.message, cause: String(result.cause) }));
    process.exit(1);
  }

  console.log(JSON.stringify(result, null, 2));
  process.exit(result.askedButNotEmbedded.length === 0 ? 0 : 1);
}
