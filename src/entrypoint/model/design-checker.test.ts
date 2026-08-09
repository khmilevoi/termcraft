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
import { TYPE_CHECK_UNAVAILABLE_CODE, resolveCompilerPath } from "gate";
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
 * ~0.1-0.35 s whole-process freeze twice — but the memo must never be the reason a stale answer
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

  test("a compiler-unavailable failure is NEVER served from cache, and the retry sees it recover", async () => {
    // `TYPE_CHECK_UNAVAILABLE` is the one Gate fatal that is not a fact about the tree's bytes —
    // it reports whether the compiler process is up. Cached under a content key it would stick
    // until the agent happened to edit something, so the natural recovery from a transient
    // hiccup (call again, unchanged, to see whether it passed) would be answered with the very
    // failure being retried.
    //
    // A SCRIPTED `GateRunner`, not the real one with a bogus compiler path: making the real
    // `typescript/unstable/sync` API fail to spawn raises an ASYNCHRONOUS `error` event that
    // escapes `type-check.ts`'s own try/catch and fails the run for an unrelated reason. That
    // is unreachable in production — `create-shell.ts` resolves and validates the compiler
    // before any project I/O and aborts the whole shell if it cannot — so provoking it here
    // would test the harness, not the memo. `TYPE_CHECK_UNAVAILABLE_CODE` is IMPORTED from
    // `gate`, so the code this asserts on is the one the Gate really emits, by construction
    // rather than by a matching literal.
    const workspace = createWorkspace(CLEAN_SOURCE);
    let runTreeCalls = 0;
    const flaky: GateRunner = {
      runManifestSlice: () => Promise.resolve({ errors: [], slice: { pages: [], active: null } }),
      runTree: () => {
        runTreeCalls += 1;
        // Unavailable on the first call, healthy on every later one — the transient hiccup.
        return Promise.resolve({
          errors:
            runTreeCalls === 1
              ? [
                  {
                    kind: "type" as const,
                    code: TYPE_CHECK_UNAVAILABLE_CODE,
                    message: "the compiler could not be started",
                  },
                ]
              : [],
          warnings: [],
          closures: [],
        });
      },
      runPage: () => {
        throw new Error("runPage must not be called by the design check");
      },
      extractPageMeta: () => {
        throw new Error("extractPageMeta must not be called by the design check");
      },
    };
    const checker = createGateDesignChecker(flaky);

    const first = await runDesignCheck(checker, workspace);
    expect(first).toContain(TYPE_CHECK_UNAVAILABLE_CODE);
    expect(first).not.toContain(DESIGN_CHECK_CLEAN_HEADLINE);

    // Identical tree bytes, so a naive content memo would replay the failure forever.
    const second = await runDesignCheck(checker, workspace);
    expect(runTreeCalls).toBe(2);
    expect(second).toContain(DESIGN_CHECK_CLEAN_HEADLINE);
    expect(second).not.toContain(TYPE_CHECK_UNAVAILABLE_CODE);

    // …and the now-healthy result IS cached, so the guard is scoped to the failure rather than
    // disabling the memo outright.
    const third = await runDesignCheck(checker, workspace);
    expect(runTreeCalls).toBe(2);
    expect(third).toBe(second);
  });

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
 * THE "HARD FREEZE, NOT JUST SLOW" CLAIM, PINNED BY A TEST RATHER THAN BY PROSE (fix round 2).
 *
 * Four places now tell a reader — and the agent — that one `check_design` call blocks the whole
 * process: `design-checker.ts`'s header, the tool's description, `SELF_CHECK`, and
 * `flows/generation-turn.md` step 3a. All four rested on a measurement run once from a throwaway
 * probe. This is that measurement as a committed regression test, in the repo's own spirit of
 * keeping a spike's probe rather than only its conclusion.
 *
 * NOT FLAKY, and the direction matters: a synchronous section provably cannot let a timer fire,
 * so `0` is deterministic rather than merely typical, and load makes the call SLOWER — which
 * widens the window the interval would have fired in, strengthening the assertion instead of
 * weakening it. The guard below fails loudly if the call ever gets fast enough for the tick
 * assertion to become vacuous, rather than letting it quietly stop proving anything.
 */
describe("one check_design call blocks the event loop for its whole duration", () => {
  test(
    "a 10 ms interval fires ZERO times while the check runs",
    async () => {
      const workspace = createWorkspace(TWO_DEFECT_SOURCE);
      const checker = createRealChecker();

      const ticks: number[] = [];
      const timer = setInterval(() => ticks.push(performance.now()), 10);
      // Prove the interval is alive BEFORE the blocking work — otherwise "zero ticks during"
      // would also be satisfied by a timer that never worked at all.
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(ticks.length).toBeGreaterThan(0);

      const startedAt = performance.now();
      await runDesignCheck(checker, workspace);
      const elapsed = performance.now() - startedAt;
      clearInterval(timer);

      const ticksDuring = ticks.filter((t) => t > startedAt && t < startedAt + elapsed).length;
      // THE CLAIM: not "few", ZERO. A loop that merely ran slowly would still fire.
      expect(ticksDuring).toBe(0);
      // …and the window was long enough for a live loop to have fired several times, so the
      // assertion above is not vacuously true of a call that finished in under a tick.
      expect(elapsed).toBeGreaterThan(25);
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
