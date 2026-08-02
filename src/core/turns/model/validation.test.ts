import { describe, expect, test } from "bun:test";

import { context, wrap } from "@reatom/core";

import {
  type StateMachine,
  type TurnAction,
  type TurnAttempt,
  type TurnState,
  reatomTurnStateMachine,
} from "core/machines";
import type { GateRunResultV1, GateRunner, ManifestSliceResultV1 } from "core/ports";
import { createFakeGateRunner } from "core/ports/fakes";
import { type UUIDv7, isUuidv7 } from "core/protocol";
import type { PageEntryV1 } from "entities/design-tree";
import { type PageSlug, parsePageSlug } from "entities/page";

import { type TurnValidationDeps, runTurnValidation } from "./validation";

/**
 * `runTurnValidation` against 6D's fake `GateRunner` only, matching
 * `admission.test.ts`'s/`finalize.test.ts`'s own harness style.
 *
 * THE OTHER HALF OF THE SECURITY PROOF. This file pins what THIS module does — that the
 * whole-tree import scan is called at all, once, with the whole tree, and that its errors are
 * fatal to the turn. It cannot prove the scanner itself catches anything: `core` may not
 * import `gate`. `src/entrypoint/model/turn-import-perimeter.test.ts` drives the REAL adapter
 * end to end for each forbidden form in a shared module; the two together are the wiring
 * proof red-debt.md's SECURITY-CRITICAL entry demands.
 */

function slug(value: string): PageSlug {
  const parsed = parsePageSlug(value);
  if (parsed instanceof Error) throw parsed;
  return parsed;
}

const PAGE_HOME = slug("home");
const PAGE_ABOUT = slug("about");
const TURN_ID = "0192f6f0-0000-7000-8000-00000000aaaa" as UUIDv7;

/**
 * ENTRIES DELIBERATELY NOT DERIVABLE FROM THE SLUG. `design/pages.json` binds identity to an
 * arbitrary tree path, so a fixture using `pages/<slug>.tsx` would keep passing against code
 * that computed the path instead of reading the manifest — the exact regression every caller
 * migrated in task 14 had to stop being able to make.
 */
const HOME_ENTRY = "screens/landing/main.tsx";
const ABOUT_ENTRY = "screens/marketing/about-us.tsx";
/** A module BOTH pages reach and NEITHER names as its entry — the design tree's whole point. */
const SHARED_MODULE = "lib/theme.ts";

const HOME_SOURCE = "export default function Home() {}";
const ABOUT_SOURCE = "export default function About() {}";
const SHARED_SOURCE = "export const accent = 1";

function machineAtValidating(): StateMachine<TurnState, TurnAction> {
  const m = reatomTurnStateMachine();
  m.apply("beginAdmission");
  m.apply("finishAdmission");
  m.apply("beginAttempt");
  m.apply("beginStopping");
  m.apply("beginSnapshot");
  m.apply("candidateCaptured");
  return m;
}

type PublishedEvent = Parameters<TurnValidationDeps["publish"]>[0];

function harness() {
  const machine = machineAtValidating();
  const gateRunner = createFakeGateRunner();
  const published: PublishedEvent[] = [];
  const deps: TurnValidationDeps = {
    machine,
    gateRunner,
    publish: (event) => published.push(event),
  };
  return { deps, machine, gateRunner, published };
}

/** The default tree: two pages plus one shared module neither of them names as an entry. */
function treeFiles(): Map<string, string> {
  return new Map([
    ["pages.json", "{}"],
    [HOME_ENTRY, HOME_SOURCE],
    [ABOUT_ENTRY, ABOUT_SOURCE],
    [SHARED_MODULE, SHARED_SOURCE],
  ]);
}

function sliceOf(...pages: readonly PageEntryV1[]): ManifestSliceResultV1 {
  return { errors: [], slice: { pages, active: null } };
}

const HOME_ENTRY_V1: PageEntryV1 = { slug: PAGE_HOME, entry: HOME_ENTRY };
const ABOUT_ENTRY_V1: PageEntryV1 = { slug: PAGE_ABOUT, entry: ABOUT_ENTRY };

function baseInput(attempt: TurnAttempt, files = treeFiles()) {
  return {
    turnId: TURN_ID,
    attempt,
    manifestText: '{"schemaVersion":1,"pages":[]}',
    treePaths: [...files.keys()],
    files,
    designRoot: "/candidate/0192f6f0/design",
  };
}

const FAILING_PAGE_RESULT: GateRunResultV1 = {
  ok: false,
  errors: [{ kind: "type", code: "TS2322", message: "type error" }],
  warnings: [],
  descriptor: null,
};

/** `GateErrorV1`'s optional `file`/`line`/`column`/`blockedPages` widened to the Kernel DTO's `.nullable()` shape — see `validation.ts`'s own `toGateErrorDto` note. */
const FAILING_PAGE_ERRORS_DTO = [
  {
    kind: "type" as const,
    code: "TS2322",
    message: "type error",
    file: null,
    line: null,
    column: null,
    blockedPages: null,
  },
];

describe("runTurnValidation — the whole-tree stages", () => {
  test("runs the manifest slice ONCE, then the whole-tree import scan ONCE, then one runPage per MANIFEST ENTRY", async () => {
    // TWO pages, deliberately: with one, "ran once" is trivially satisfied by an
    // implementation that runs either whole-tree stage per page. The whole ordered sequence
    // pins once-ness, ordering (design §8's steps 1 -> 4 -> per-entry) and non-interleaving.
    await context.start(async () => {
      const h = harness();
      h.gateRunner.queueRunManifestSliceResult(sliceOf(HOME_ENTRY_V1, ABOUT_ENTRY_V1));
      await wrap(runTurnValidation(h.deps, baseInput(1)));

      expect(h.gateRunner.calls.map((c) => c.method)).toEqual([
        "runManifestSlice",
        "runTreeImports",
        "runPage",
        "runPage",
      ]);
    });
  });

  test("hands the whole tree to BOTH whole-tree stages — every file, the shared module included, and the validated entries", async () => {
    await context.start(async () => {
      const h = harness();
      h.gateRunner.queueRunManifestSliceResult(sliceOf(HOME_ENTRY_V1, ABOUT_ENTRY_V1));
      await wrap(runTurnValidation(h.deps, baseInput(1)));

      // 4 files / 4 treePaths: `pages.json`, both entries, AND `lib/theme.ts` — the module no
      // page names. A `files` map narrowed to the manifest's own entries would read `2` here
      // and would leave every shared module unscanned, which is exactly the hole
      // `runTreeImports` exists to close.
      expect(h.gateRunner.calls[0]).toEqual({ method: "runManifestSlice", treePathCount: 4 });
      expect(h.gateRunner.calls[1]).toEqual({
        method: "runTreeImports",
        fileCount: 4,
        treePathCount: 4,
        pageCount: 2,
      });
    });
  });

  test("SECURITY: a whole-tree import error fails the turn even when every page's own runPage passes", async () => {
    // The wiring proof, at this module's own boundary: `runPage` returns `ok` for both pages
    // (the fake's default), so the ONLY thing that can reject this turn is the whole-tree
    // scan. Before task 14 this module never called `runTreeImports` at all, and this exact
    // input passed.
    await context.start(async () => {
      const h = harness();
      h.gateRunner.queueRunManifestSliceResult(sliceOf(HOME_ENTRY_V1, ABOUT_ENTRY_V1));
      h.gateRunner.queueRunTreeImportsResult({
        errors: [
          {
            kind: "import",
            code: "FORBIDDEN_IMPORT",
            message: 'specifier "lodash" in lib/theme.ts is rejected',
            file: SHARED_MODULE,
            blockedPages: [PAGE_HOME, PAGE_ABOUT],
          },
        ],
        closures: [],
      });

      const result = await wrap(runTurnValidation(h.deps, baseInput(1)));

      if (result.kind !== "retry") throw new Error(`expected retry, got ${JSON.stringify(result)}`);
      expect(result.diagnostics.errors).toEqual([
        {
          kind: "import",
          code: "FORBIDDEN_IMPORT",
          message: 'specifier "lodash" in lib/theme.ts is rejected',
          file: SHARED_MODULE,
          line: null,
          column: null,
          // CARRIED ACROSS THE DTO BOUNDARY (task-13 review round 4, M-4): before task 14
          // `toGateErrorDto` listed fields by name and silently dropped this, and
          // `turnGateErrorV1Schema` was a `z.strictObject` that could not have accepted it.
          blockedPages: [PAGE_HOME, PAGE_ABOUT],
        },
      ]);
    });
  });

  test("an UNATTRIBUTABLE whole-tree diagnostic is still reported, never dropped", async () => {
    // Dropping the unattributable would be a silent fail-open: a blocked page is already
    // absent from `closures`, so its diagnostic is the only remaining signal it was excluded.
    await context.start(async () => {
      const h = harness();
      h.gateRunner.queueRunManifestSliceResult(sliceOf(HOME_ENTRY_V1));
      h.gateRunner.queueRunTreeImportsResult({
        errors: [
          {
            kind: "import",
            code: "FORBIDDEN_IMPORT",
            message: "a violation in a module no page reaches",
            file: "lib/orphan.ts",
          },
        ],
        closures: [],
      });

      const result = await wrap(runTurnValidation(h.deps, baseInput(1)));

      if (result.kind !== "retry") throw new Error(`expected retry, got ${JSON.stringify(result)}`);
      expect(result.diagnostics.errors).toHaveLength(1);
      expect(result.diagnostics.errors[0]?.code).toBe("FORBIDDEN_IMPORT");
      expect(result.diagnostics.errors[0]?.blockedPages).toBeNull();
    });
  });

  test("the whole-tree import scan STILL runs when the manifest itself failed to decode", async () => {
    // Otherwise a manifest typo hides every import violation behind it, and the agent burns
    // one of only four attempts learning about one of the two problems.
    await context.start(async () => {
      const h = harness();
      h.gateRunner.queueRunManifestSliceResult({
        errors: [{ kind: "manifest", code: "SCHEMA_INVALID", message: "not JSON" }],
        slice: null,
      });

      const result = await wrap(runTurnValidation(h.deps, baseInput(1)));

      expect(h.gateRunner.calls.map((c) => c.method)).toEqual([
        "runManifestSlice",
        // No `runPage`: an undecodable manifest names no entries, so there is no page to run.
        "runTreeImports",
      ]);
      // …and it was told there are no validated entries, rather than a fabricated page list.
      expect(h.gateRunner.calls[1]).toMatchObject({ pageCount: 0 });
      if (result.kind !== "retry") throw new Error(`expected retry, got ${JSON.stringify(result)}`);
    });
  });
});

describe("runTurnValidation — the per-entry stage", () => {
  test("drives runPage from the MANIFEST's entry, not from the slug: source, fileName, entryRelPath and sourcePath all come from `entry`", async () => {
    await context.start(async () => {
      const machine = machineAtValidating();
      const runPageCalls: {
        slug: PageSlug;
        source: string;
        fileName?: string;
        sourcePath?: string;
        entryRelPath?: string;
      }[] = [];
      const gateRunner: GateRunner = {
        async runManifestSlice() {
          return sliceOf(HOME_ENTRY_V1);
        },
        async extractPageMeta() {
          return {
            meta: null,
            errors: [
              { kind: "contract", code: "NOT_STUBBED", message: "extractPageMeta is not stubbed" },
            ],
          };
        },
        async runTreeImports() {
          return { errors: [], closures: [] };
        },
        async runPage(input) {
          runPageCalls.push({
            slug: input.slug,
            source: input.source,
            ...(input.fileName === undefined ? {} : { fileName: input.fileName }),
            ...(input.sourcePath === undefined ? {} : { sourcePath: input.sourcePath }),
            ...(input.entryRelPath === undefined ? {} : { entryRelPath: input.entryRelPath }),
          });
          return {
            ok: false,
            errors: [{ kind: "type", code: "TS2322", message: "type error", file: input.fileName }],
            warnings: [],
            descriptor: null,
          };
        },
      };
      const deps: TurnValidationDeps = { machine, gateRunner, publish: () => {} };

      const result = await wrap(runTurnValidation(deps, baseInput(1)));

      expect(runPageCalls).toEqual([
        {
          slug: PAGE_HOME,
          source: HOME_SOURCE,
          fileName: HOME_ENTRY,
          entryRelPath: HOME_ENTRY,
          sourcePath: `/candidate/0192f6f0/design/${HOME_ENTRY}`,
        },
      ]);
      // The SHORT, tree-relative name reaches the agent's diagnostic — never the absolute path.
      if (result.kind !== "retry") throw new Error(`expected retry, got ${JSON.stringify(result)}`);
      expect(result.diagnostics.errors[0]?.file).toBe(HOME_ENTRY);
    });
  });

  test("threads only a PROVEN-COMPLETE closure to runPage, and returns every closure on a pass", async () => {
    await context.start(async () => {
      const h = harness();
      h.gateRunner.queueRunManifestSliceResult(sliceOf(HOME_ENTRY_V1, ABOUT_ENTRY_V1));
      h.gateRunner.queueRunTreeImportsResult({
        errors: [],
        // `about` is absent — but with zero errors that shape cannot occur through the real
        // adapter (its CONTRACT pairs every omission with a diagnostic). Scripted here purely
        // to observe that a slug with no closure is simply not given one, rather than being
        // handed a fabricated or another page's file list.
        closures: [{ slug: PAGE_HOME, files: [HOME_ENTRY, SHARED_MODULE] }],
      });

      const result = await wrap(runTurnValidation(h.deps, baseInput(1)));

      if (result.kind !== "passed")
        throw new Error(`expected passed, got ${JSON.stringify(result)}`);
      expect(result.closures).toEqual([{ slug: PAGE_HOME, files: [HOME_ENTRY, SHARED_MODULE] }]);
    });
  });

  test.each([
    ["an EXTENSIONLESS entry", "screens/landing/main"],
    ["a .jsx entry", "screens/landing/main.jsx"],
  ])(
    "%s works end to end — `entryPathSchema` allows it and the tree scan calls it code",
    async (_label, entry) => {
      // Task-14-supplement §2's own named requirement. The lookup is by EXACT tree path, so an
      // implementation that appended or assumed `.tsx` would find no source here.
      await context.start(async () => {
        const h = harness();
        const files = new Map([
          ["pages.json", "{}"],
          [entry, HOME_SOURCE],
        ]);
        h.gateRunner.queueRunManifestSliceResult(sliceOf({ slug: PAGE_HOME, entry }));
        h.gateRunner.queueRunTreeImportsResult({
          errors: [],
          closures: [{ slug: PAGE_HOME, files: [entry] }],
        });

        const result = await wrap(runTurnValidation(h.deps, baseInput(1, files)));

        if (result.kind !== "passed")
          throw new Error(`expected passed, got ${JSON.stringify(result)}`);
        expect(result.descriptors).toEqual([{ slug: PAGE_HOME, meta: expect.anything() }]);
        expect(result.closures).toEqual([{ slug: PAGE_HOME, files: [entry] }]);
      });
    },
  );

  test("a manifest entry that resolved in the tree but whose source this turn does not hold is a typed fatal, never a runPage on empty text", async () => {
    await context.start(async () => {
      const h = harness();
      const files = new Map([["pages.json", "{}"]]);
      h.gateRunner.queueRunManifestSliceResult(sliceOf(HOME_ENTRY_V1));

      const result = await wrap(runTurnValidation(h.deps, baseInput(1, files)));

      if (result.kind !== "retry") throw new Error(`expected retry, got ${JSON.stringify(result)}`);
      expect(result.diagnostics.errors.map((e) => e.code)).toEqual(["ENTRY_SOURCE_MISSING"]);
      expect(result.diagnostics.errors[0]?.file).toBe(HOME_ENTRY);
      // …and `runPage` was never called with a fabricated empty source.
      expect(h.gateRunner.calls.some((c) => c.method === "runPage")).toBe(false);
    });
  });
});

describe("runTurnValidation — the verdict", () => {
  test("the happy path: every stage clean -> passed, with the slice, descriptors, warnings and closures; no rejection event, no machine transition", async () => {
    await context.start(async () => {
      const h = harness();
      h.gateRunner.queueRunManifestSliceResult(sliceOf(HOME_ENTRY_V1));
      const result = await wrap(runTurnValidation(h.deps, baseInput(1)));

      if (result.kind !== "passed")
        throw new Error(`expected passed, got ${JSON.stringify(result)}`);
      expect(result.slice).toEqual({ pages: [HOME_ENTRY_V1], active: null });
      expect(result.descriptors).toEqual([{ slug: PAGE_HOME, meta: expect.anything() }]);
      expect(result.warnings).toEqual([]);
      expect(h.published).toEqual([]);
      expect(h.machine.phase()).toBe("validating");
    });
  });

  test("aggregates errors and warnings across every entry, and every ok page still contributes a descriptor", async () => {
    await context.start(async () => {
      const h = harness();
      h.gateRunner.queueRunManifestSliceResult(sliceOf(HOME_ENTRY_V1, ABOUT_ENTRY_V1));
      h.gateRunner.queueRunPageResult(FAILING_PAGE_RESULT);
      h.gateRunner.queueRunPageResult({
        ok: true,
        errors: [],
        warnings: [
          { kind: "unguarded-timer", message: "setTimeout without a guard", line: 12, column: 3 },
        ],
        descriptor: {
          slug: PAGE_ABOUT,
          meta: { kitApiVersion: 1, title: "About", minSize: { w: 80, h: 24 }, theme: "default" },
        },
      });

      const result = await wrap(runTurnValidation(h.deps, baseInput(1)));

      if (result.kind !== "retry") throw new Error(`expected retry, got ${JSON.stringify(result)}`);
      expect(result.diagnostics.errors).toEqual(FAILING_PAGE_ERRORS_DTO);
      expect(result.diagnostics.warnings).toEqual([
        { kind: "unguarded-timer", message: "setTimeout without a guard", line: 12, column: 3 },
      ]);
    });
  });

  test("on rejection with attempt < 4: emits turn.gateRejected, drives retryAfterGate, and returns retry with the next attempt", async () => {
    await context.start(async () => {
      const h = harness();
      h.gateRunner.queueRunManifestSliceResult(sliceOf(HOME_ENTRY_V1));
      h.gateRunner.queueRunPageResult(FAILING_PAGE_RESULT);

      const result = await wrap(runTurnValidation(h.deps, baseInput(2)));

      if (result.kind !== "retry") throw new Error(`expected retry, got ${JSON.stringify(result)}`);
      expect(result.nextAttempt).toBe(3);
      expect(result.diagnostics).toEqual({ errors: FAILING_PAGE_ERRORS_DTO, warnings: [] });

      expect(h.published).toEqual([
        {
          kind: "turn.gateRejected",
          payload: {
            turnId: TURN_ID,
            attempt: 2,
            retryNumber: 1,
            diagnostics: { errors: FAILING_PAGE_ERRORS_DTO, warnings: [] },
          },
          correlation: { turnId: TURN_ID },
        },
      ]);
      expect(h.machine.phase()).toBe("workspace-ready");
    });
  });

  test("exhausting the retry budget at attempt 4: emits turn.gateRejected, does NOT retry, and returns GATE_RETRY_EXHAUSTED", async () => {
    await context.start(async () => {
      const h = harness();
      h.gateRunner.queueRunManifestSliceResult(sliceOf(HOME_ENTRY_V1));
      h.gateRunner.queueRunPageResult(FAILING_PAGE_RESULT);

      const result = await wrap(runTurnValidation(h.deps, baseInput(4)));

      if (result.kind !== "exhausted")
        throw new Error(`expected exhausted, got ${JSON.stringify(result)}`);
      expect(result.failure.code).toBe("GATE_RETRY_EXHAUSTED");
      expect(result.failure.retryable).toBe(false);

      expect(h.published.length).toBe(1);
      expect(h.published[0]).toMatchObject({
        kind: "turn.gateRejected",
        payload: { attempt: 4, retryNumber: 3 },
      });
      // Never retried past the budget: the machine stays in "validating", not workspace-ready.
      expect(h.machine.phase()).toBe("validating");
    });
  });

  test("every retryNumber emitted is exactly attempt - 1 (§9's 0-3 bound)", async () => {
    await context.start(async () => {
      for (const attempt of [1, 2, 3, 4] as const) {
        const h = harness();
        h.gateRunner.queueRunManifestSliceResult(sliceOf(HOME_ENTRY_V1));
        h.gateRunner.queueRunPageResult(FAILING_PAGE_RESULT);
        await wrap(runTurnValidation(h.deps, baseInput(attempt)));
        expect(h.published[0]).toMatchObject({ payload: { retryNumber: attempt - 1 } });
      }
    });
  });

  test("turnId in the emitted event is a genuine UUIDv7, never re-derived", async () => {
    await context.start(async () => {
      const h = harness();
      h.gateRunner.queueRunManifestSliceResult(sliceOf(HOME_ENTRY_V1));
      h.gateRunner.queueRunPageResult(FAILING_PAGE_RESULT);
      await wrap(runTurnValidation(h.deps, baseInput(1)));
      const event = h.published[0];
      if (event === undefined || event.kind !== "turn.gateRejected")
        throw new Error("expected a turn.gateRejected event");
      expect(isUuidv7(event.payload.turnId)).toBe(true);
      expect(event.payload.turnId).toBe(TURN_ID);
    });
  });
});
