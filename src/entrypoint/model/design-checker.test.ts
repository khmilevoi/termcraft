import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DESIGN_CHECK_CLEAN_HEADLINE,
  DESIGN_CHECK_EXCLUDED_WARNING_KINDS,
  DESIGN_CHECK_RENDERED_WARNING_KINDS,
  runDesignCheck,
} from "agent/checks";
import { createCheckDesignTool } from "agent/claude/tools";
import type { GateRunner, GateWarningKindV1 } from "core/ports";
import { encodePagesManifest } from "entities/design-tree";
import type { PagesManifestV1 } from "entities/design-tree";
import type { PageSlug } from "entities/page";
import { resolveCompilerPath } from "gate";
import type { SmokeRenderer, SmokeRequest, SmokeResult } from "gate";

import { buildGateRunner } from "./create-shell";
import { createGateDesignChecker } from "./design-checker";

/**
 * THE END-TO-END FIXTURE TURN for Task 12's `check_design`. Drives the REAL
 * `createGateRunnerAdapter` composition (through `create-shell.ts`'s own exported
 * `buildGateRunner`, the same function `interactiveShell` calls) against a REAL turn workspace
 * on disk, so what this suite measures is the shipped wiring rather than a reimplementation of
 * it — including a real `tsc` program, which is the whole reason Task 7 gates this task.
 *
 * The smoke renderer is faked because `createGateDesignChecker` never reaches it: the check runs
 * `runManifestSlice` + `runTree` only, and neither spawns a host child. It is supplied anyway so
 * a regression that DID start smoking would fail loudly instead of silently spawning processes.
 */
function createFakeSmokeRenderer(): SmokeRenderer {
  return {
    render(_request: SmokeRequest): Promise<SmokeResult> {
      return Promise.resolve({ ok: true });
    },
  };
}

const workspaces: string[] = [];
afterEach(() => {
  for (const dir of workspaces.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const HOME_SLUG = "home" as PageSlug;
const ENTRY_REL_PATH = "pages/home.tsx";

function manifestText(): string {
  const manifest: PagesManifestV1 = {
    schemaVersion: 1,
    pages: [{ slug: HOME_SLUG, entry: ENTRY_REL_PATH }],
    requestedActivePage: null,
  };
  return encodePagesManifest(manifest);
}

/** A page that passes every stage this check runs. */
const CLEAN_SOURCE = `import { definePage, reatomComponent, Panel, Text } from "@termcraft/runtime"
export const meta = definePage({ kitApiVersion: 1, title: "Home", minSize: { w: 80, h: 24 }, theme: "dark-default" })
export default reatomComponent(() => <Panel id="p"><Text id="t">hello</Text></Panel>)
`;

/**
 * The SAME page with the two defects the plan's measured run actually hit: a callback parameter
 * with no contextual type (`TS7006`, caught by the whole-tree type check) and a wall-clock read
 * (`nondeterministic-time`, caught by the whole-tree determinism lint). One fixture, two stages,
 * because "both come back in one call" is the property that makes the tool worth a turn.
 */
const TWO_DEFECT_SOURCE = `import { definePage, reatomComponent, Panel, Text } from "@termcraft/runtime"
const format = (value) => \`\${value}\`
const startedAt = Date.now()
export const meta = definePage({ kitApiVersion: 1, title: "Home", minSize: { w: 80, h: 24 }, theme: "dark-default" })
export default reatomComponent(() => <Panel id="p"><Text id="t">{format(startedAt)}</Text></Panel>)
`;

function createWorkspace(entrySource: string): string {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "termcraft-check-design-"));
  workspaces.push(workspace);
  writeEntry(workspace, entrySource);
  fs.writeFileSync(path.join(workspace, "design", "pages.json"), manifestText());
  // A runtime doc BESIDE the tree, never inside it — the check must not read the workspace
  // root as if it were the design tree.
  fs.writeFileSync(path.join(workspace, "RUNTIME.md"), "# runtime\n");
  return workspace;
}

function writeEntry(workspace: string, source: string): void {
  const entryPath = path.join(workspace, "design", ...ENTRY_REL_PATH.split("/"));
  fs.mkdirSync(path.dirname(entryPath), { recursive: true });
  fs.writeFileSync(entryPath, source);
}

function createRealChecker(): ReturnType<typeof createGateDesignChecker> {
  const tscExePath = resolveCompilerPath();
  if (tscExePath instanceof Error) throw tscExePath;
  return createGateDesignChecker(buildGateRunner(tscExePath, createFakeSmokeRenderer()));
}

/** Two real whole-tree `tsc` programs in the worst case; `create-shell.test.ts` uses the same
 *  budget for the same reason. */
const REAL_COMPILER_TIMEOUT_MS = 60_000;

describe("createGateDesignChecker over a real turn workspace", () => {
  test(
    "check_design returns the same diagnostics the Gate would produce",
    async () => {
      const workspace = createWorkspace(TWO_DEFECT_SOURCE);
      const text = await runDesignCheck(createRealChecker(), workspace);

      // The retry fold's own vocabulary: workspace-relative paths (Task 3), Task 4's kind
      // names, a `file` on every warning (Task 2).
      expect(text).toContain("TS7006");
      expect(text).toContain(`in design/${ENTRY_REL_PATH}`);
      expect(text).toContain("nondeterministic-time");
      expect(text).toContain(`- [nondeterministic-time] in design/${ENTRY_REL_PATH}`);
      // The renamed kinds, never the retired promise-a-guard names.
      expect(text).not.toContain("unguarded-timer");
      expect(text).not.toContain(DESIGN_CHECK_CLEAN_HEADLINE);
    },
    REAL_COMPILER_TIMEOUT_MS,
  );

  test(
    "check_design reads the LIVE workspace, not the frozen candidate",
    async () => {
      // The whole point: the agent edits, checks, and edits again inside ONE attempt. A check
      // against a snapshot taken at attempt start would report the code the agent already fixed.
      const workspace = createWorkspace(TWO_DEFECT_SOURCE);
      const checker = createRealChecker();

      const before = await runDesignCheck(checker, workspace);
      expect(before).toContain("TS7006");

      writeEntry(workspace, CLEAN_SOURCE);

      const after = await runDesignCheck(checker, workspace);
      expect(after).not.toContain("TS7006");
      expect(after).toContain(DESIGN_CHECK_CLEAN_HEADLINE);
    },
    REAL_COMPILER_TIMEOUT_MS,
  );

  test(
    "a check over a clean tree says so, and says nothing else",
    async () => {
      const workspace = createWorkspace(CLEAN_SOURCE);
      const text = await runDesignCheck(createRealChecker(), workspace);
      expect(text).toContain(DESIGN_CHECK_CLEAN_HEADLINE);
      expect(text).not.toContain("- [");
    },
    REAL_COMPILER_TIMEOUT_MS,
  );

  test("a workspace with no design tree at all reports that, never a clean pass", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "termcraft-check-design-empty-"));
    workspaces.push(workspace);
    const text = await runDesignCheck(createRealChecker(), workspace);
    expect(text).not.toContain(DESIGN_CHECK_CLEAN_HEADLINE);
    expect(text).toContain("could not run");
  });

  test(
    "the whole tool round-trips: the SDK tool handler returns the rendered check",
    async () => {
      const workspace = createWorkspace(TWO_DEFECT_SOURCE);
      const tool = createCheckDesignTool(createRealChecker(), workspace);
      const result = await tool.handler({}, undefined);
      const [block] = result.content;
      expect(block?.type).toBe("text");
      expect((block as { text: string }).text).toContain("TS7006");
    },
    REAL_COMPILER_TIMEOUT_MS,
  );
});

/**
 * THE CONTENT-KEYED MEMO (fix round 1, I1). Two calls with no edit between them must not pay the
 * ~100-200 ms whole-process freeze twice — but the memo must never be the reason a stale answer
 * is served, which is the one property this tool cannot lose. Both halves are pinned here.
 */
describe("createGateDesignChecker's repeat-call memo", () => {
  /** The real runner, wrapped so a test can count how many times the EXPENSIVE stage actually
   *  ran. Counting beats timing here: a wall-clock bound over a three-line fixture would pass
   *  whether or not the memo exists, which is the definition of a vacuous test. */
  function createCountingChecker(): {
    checker: ReturnType<typeof createGateDesignChecker>;
    runTreeCalls: () => number;
  } {
    const tscExePath = resolveCompilerPath();
    if (tscExePath instanceof Error) throw tscExePath;
    const real = buildGateRunner(tscExePath, createFakeSmokeRenderer());
    let calls = 0;
    const counting: GateRunner = {
      ...real,
      runTree: (input) => {
        calls += 1;
        return real.runTree(input);
      },
    };
    return { checker: createGateDesignChecker(counting), runTreeCalls: () => calls };
  }

  test(
    "an unchanged tree reuses the previous report instead of re-running the compiler",
    async () => {
      const workspace = createWorkspace(TWO_DEFECT_SOURCE);
      const { checker, runTreeCalls } = createCountingChecker();

      const first = await runDesignCheck(checker, workspace);
      const second = await runDesignCheck(checker, workspace);
      const third = await runDesignCheck(checker, workspace);

      expect(second).toBe(first);
      expect(third).toBe(first);
      // THE ASSERTION THAT MATTERS: the whole-tree pass — the blocking `tsc` program — ran once
      // for three calls.
      expect(runTreeCalls()).toBe(1);
    },
    REAL_COMPILER_TIMEOUT_MS,
  );

  test(
    "one edited byte invalidates the memo — the live-read guarantee is untouched",
    async () => {
      const workspace = createWorkspace(TWO_DEFECT_SOURCE);
      const { checker, runTreeCalls } = createCountingChecker();

      expect(await runDesignCheck(checker, workspace)).toContain("TS7006");
      writeEntry(workspace, CLEAN_SOURCE);
      expect(await runDesignCheck(checker, workspace)).toContain(DESIGN_CHECK_CLEAN_HEADLINE);
      // …and back again, so the memo cannot be "sticky after the first invalidation" either.
      writeEntry(workspace, TWO_DEFECT_SOURCE);
      expect(await runDesignCheck(checker, workspace)).toContain("TS7006");
      // Three different trees, three real passes — nothing was served from the memo.
      expect(runTreeCalls()).toBe(3);
    },
    REAL_COMPILER_TIMEOUT_MS,
  );

  test(
    "a NEW file with no effect on any page still invalidates — the key is the tree, not the entry",
    async () => {
      const workspace = createWorkspace(CLEAN_SOURCE);
      const checker = createRealChecker();
      await runDesignCheck(checker, workspace);

      // A dead module: it changes no page's closure, so a key derived from anything narrower
      // than "every file's bytes" would miss it — and it produces a real `dead-module` warning.
      fs.writeFileSync(path.join(workspace, "design", "orphan.ts"), "export const x = 1\n");
      const after = await runDesignCheck(checker, workspace);
      expect(after).toContain("dead-module");
      expect(after).not.toContain(DESIGN_CHECK_CLEAN_HEADLINE);
    },
    REAL_COMPILER_TIMEOUT_MS,
  );
});

/**
 * THE RENDERER'S KIND COVERAGE, CROSS-CHECKED FROM THE ONE PLACE THAT SEES BOTH RINGS (fix round
 * 1, M1). `agent/checks/model/render.ts` keys its sections on STRING literals — it imports no
 * `core`, so `GateWarningKindV1` is not in scope there, and a rename like Task 4's own
 * `unguarded-timer` -> `nondeterministic-time` would silently drop a whole section.
 *
 * `entrypoint` imports both, so the check lives here. The exhaustive record below fails the
 * TYPECHECK the moment a kind is added, removed or renamed; the assertions then fail at RUNTIME
 * if the renderer's literals have not been updated to match.
 */
describe("every Gate warning kind is either rendered or deliberately excluded", () => {
  const EVERY_GATE_WARNING_KIND: Record<GateWarningKindV1, true> = {
    "dropped-id": true,
    "unpointed-element": true,
    "nondeterministic-time": true,
    "nondeterministic-randomness": true,
    "unlisted-navigation": true,
    "silencing-any": true,
    "import-cycle": true,
    "dead-module": true,
  };
  const kinds = Object.keys(EVERY_GATE_WARNING_KIND);

  test("no kind is unclassified — a new kind must be a deliberate choice, not a silent drop", () => {
    const unclassified = kinds.filter(
      (kind) =>
        !DESIGN_CHECK_RENDERED_WARNING_KINDS.has(kind) &&
        !DESIGN_CHECK_EXCLUDED_WARNING_KINDS.has(kind),
    );
    expect(unclassified).toEqual([]);
  });

  test("no kind is in both sets", () => {
    const both = kinds.filter(
      (kind) =>
        DESIGN_CHECK_RENDERED_WARNING_KINDS.has(kind) &&
        DESIGN_CHECK_EXCLUDED_WARNING_KINDS.has(kind),
    );
    expect(both).toEqual([]);
  });

  test("neither set names a kind the Gate does not produce — this is what catches a RENAME", () => {
    const stale = [
      ...DESIGN_CHECK_RENDERED_WARNING_KINDS,
      ...DESIGN_CHECK_EXCLUDED_WARNING_KINDS,
    ].filter((kind) => !kinds.includes(kind));
    expect(stale).toEqual([]);
  });
});
