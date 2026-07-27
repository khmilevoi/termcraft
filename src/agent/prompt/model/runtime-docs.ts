import fs from "node:fs";
import path from "node:path";

import type { StagingRuntimeDocV1 } from "core/ports";

import type { RuntimeDocSourcesV1 } from "../types";

/**
 * `import.meta.dir` (Bun-specific, the same primitive `scripts/gen-runtime-dts.ts` already
 * uses) resolves to THIS file's own directory at runtime, whether the source tree is the
 * repository checkout or an npm-installed package — `package.json`'s `files: ["src", ...]`
 * (phase-8 WP-1) ships `src/` as one tree, so the relative layout between
 * `agent/prompt/model/` and `runtime/generated/` never changes. VERIFY-NOT-ASSUME: this is
 * proven here against the dev checkout (Step 10 below) and manually against `bun link`
 * (Step 11) — the full installed-package proof belongs to the parent plan's Task 5/Task 21
 * oracle (`src/entrypoint/model/installed-package.test.ts`), not a second one here.
 */
const MODULE_DIR = import.meta.dir;

const SOURCES: RuntimeDocSourcesV1 = {
  runtimeDeclarationPath: path.resolve(
    MODULE_DIR,
    "../../../runtime/generated/runtime.generated.d.ts",
  ),
  authoringGuidePath: path.resolve(MODULE_DIR, "runtime-authoring-guide.md"),
  reatomGuidePath: path.resolve(MODULE_DIR, "reatom-guide.md"),
};

/** Logs (never throws — `runtimeDocs()` has no failure channel per its fixed `AgentPromptSource` signature) when a source file is unexpectedly missing, so a broken build is at least visible instead of silently staging a dangling path. */
function warnIfMissing(sourcePath: string): void {
  if (!fs.existsSync(sourcePath)) {
    console.warn(
      `agent/prompt: runtime doc source "${sourcePath}" does not exist — the turn workspace ` +
        "will be staged without it",
    );
  }
}

/**
 * The runtime-doc file list `turn.start` stages into every turn workspace (phase-8 WP-3) —
 * filenames match `store/safe-fs/model/limits.ts`'s own `classifyWorkspace` exactly
 * (`AGENT_DOC_FILES`, any `*.d.ts` at the workspace root), not invented independently.
 *
 * `REATOM.md` is its own file rather than a section of `RUNTIME.md` (defect fix, 2026-07-27).
 * `runtime.d.ts` re-exports `atom`/`computed`/`action`/`reatomComponent` straight from
 * `@reatom/core` and `@reatom/react` (`runtime/generated/runtime.generated.d.ts:4-6`), and
 * neither package is staged into the fence — so their signatures are unreachable from inside
 * a turn, and `RUNTIME.md`'s one-paragraph "State" section did not fill the gap. A live turn
 * spent seven tool calls hunting for the `action` signature, gave up, wrote Reatom v3
 * (`ctx.spy`) from training data, silenced the resulting TS7006 with `ctx: any`, and shipped a
 * page that threw on its first render. The v3-vs-v1001 split is the single most expensive
 * thing an authoring agent can get wrong here, so it gets a document of its own.
 */
export function buildRuntimeDocs(): readonly StagingRuntimeDocV1[] {
  warnIfMissing(SOURCES.runtimeDeclarationPath);
  warnIfMissing(SOURCES.authoringGuidePath);
  warnIfMissing(SOURCES.reatomGuidePath);
  return [
    { relPath: "runtime.d.ts", sourcePath: SOURCES.runtimeDeclarationPath },
    { relPath: "RUNTIME.md", sourcePath: SOURCES.authoringGuidePath },
    { relPath: "REATOM.md", sourcePath: SOURCES.reatomGuidePath },
  ];
}
