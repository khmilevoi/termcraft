import { describe, expect, test } from "bun:test";

import { context, wrap } from "@reatom/core";

import {
  type StateMachine,
  type TurnAction,
  type TurnAttempt,
  type TurnState,
  reatomTurnStateMachine,
} from "core/machines";
import type { GateRunResultV1, GateRunner } from "core/ports";
import { createFakeGateRunner } from "core/ports/fakes";
import { type UUIDv7, isUuidv7 } from "core/protocol";
import { type PageSlug, parsePageSlug } from "entities/page";

import {
  type TurnValidationDeps,
  type TurnValidationPageInputV1,
  runTurnValidation,
} from "./validation";

/**
 * `runTurnValidation` against 6D's fake `GateRunner` only, matching
 * `admission.test.ts`'s/`finalize.test.ts`'s own harness style.
 */

function slug(value: string): PageSlug {
  const parsed = parsePageSlug(value);
  if (parsed instanceof Error) throw parsed;
  return parsed;
}

const PAGE_HOME = slug("home");
const PAGE_ABOUT = slug("about");
const TURN_ID = "0192f6f0-0000-7000-8000-00000000aaaa" as UUIDv7;

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

function onePage(
  overrides: Partial<TurnValidationPageInputV1> = {},
): readonly TurnValidationPageInputV1[] {
  return [{ pageSlug: PAGE_HOME, source: "export default function Home() {}", ...overrides }];
}

function baseInput(attempt: TurnAttempt, pages = onePage()) {
  return { turnId: TURN_ID, attempt, manifestText: "[]", pages };
}

const FAILING_PAGE_RESULT: GateRunResultV1 = {
  ok: false,
  errors: [{ kind: "type", code: "TS2322", message: "type error" }],
  warnings: [],
  descriptor: null,
};

/** `GateErrorV1`'s optional `file`/`line`/`column` widened to the Kernel DTO's `.nullable()` shape — see `validation.ts`'s own `toGateErrorDto` note. */
const FAILING_PAGE_ERRORS_DTO = [
  {
    kind: "type" as const,
    code: "TS2322",
    message: "type error",
    file: null,
    line: null,
    column: null,
  },
];

describe("runTurnValidation", () => {
  test("runs the manifest-slice check ONCE, BEFORE any per-page runPage call", async () => {
    // TWO pages, deliberately: with one page, "ran once" is trivially satisfied by an
    // implementation that runs the manifest check per page, and calls[0] is still the
    // manifest call. The whole ordered sequence pins both once-ness and non-interleaving.
    await context.start(async () => {
      const h = harness();
      const pages = [
        { pageSlug: PAGE_HOME, source: "a" },
        { pageSlug: PAGE_ABOUT, source: "b" },
      ];
      await wrap(runTurnValidation(h.deps, baseInput(1, pages)));

      expect(h.gateRunner.calls.map((c) => c.method)).toEqual([
        "runManifestSlice",
        "runPage",
        "runPage",
      ]);
    });
  });

  test("passes presentSlugs derived from the input pages to runManifestSlice", async () => {
    await context.start(async () => {
      const h = harness();
      const pages = [
        { pageSlug: PAGE_HOME, source: "a" },
        { pageSlug: PAGE_ABOUT, source: "b" },
      ];
      await wrap(runTurnValidation(h.deps, baseInput(1, pages)));

      expect(h.gateRunner.calls[0]).toEqual({ method: "runManifestSlice", presentSlugCount: 2 });
    });
  });

  test("the happy path: every page ok -> passed, with the slice, descriptors, and warnings; no rejection event, no machine transition", async () => {
    await context.start(async () => {
      const h = harness();
      const result = await wrap(runTurnValidation(h.deps, baseInput(1, onePage())));

      if (result.kind !== "passed")
        throw new Error(`expected passed, got ${JSON.stringify(result)}`);
      expect(result.slice).toEqual({ pages: [PAGE_HOME], active: null });
      expect(result.descriptors).toEqual([{ slug: PAGE_HOME, meta: expect.anything() }]);
      expect(result.warnings).toEqual([]);
      expect(h.published).toEqual([]);
      expect(h.machine.phase()).toBe("validating");
    });
  });

  test("aggregates errors and warnings across multiple pages, and every ok page still contributes a descriptor", async () => {
    await context.start(async () => {
      const h = harness();
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

      const pages = [
        { pageSlug: PAGE_HOME, source: "a" },
        { pageSlug: PAGE_ABOUT, source: "b" },
      ];
      const result = await wrap(runTurnValidation(h.deps, baseInput(1, pages)));

      if (result.kind !== "retry") throw new Error(`expected retry, got ${JSON.stringify(result)}`);
      expect(result.diagnostics.errors).toEqual(FAILING_PAGE_ERRORS_DTO);
      expect(result.diagnostics.warnings).toEqual([
        { kind: "unguarded-timer", message: "setTimeout without a guard", line: 12, column: 3 },
      ]);
    });
  });

  test("threads fileName (short display name) and sourcePath (absolute staged path) to runPage as two separate fields, and the diagnostic reports the short name in `file`", async () => {
    // A bespoke local GateRunner double (not core/ports/fakes' shared one, out of this task's
    // file set) that both records what runPage actually received AND echoes `fileName` into
    // the returned error's `file` the way the real `gate/model/gate.ts` does — the only way to
    // observe, from this side of the port, that `fileName` and `sourcePath` reach `runPage` as
    // genuinely separate fields rather than one value doing double duty.
    await context.start(async () => {
      const machine = machineAtValidating();
      const runPageCalls: { fileName?: string; sourcePath?: string }[] = [];
      const gateRunner: GateRunner = {
        async runManifestSlice(input) {
          return { errors: [], slice: { pages: input.presentSlugs, active: null } };
        },
        async runPage(input) {
          runPageCalls.push({ fileName: input.fileName, sourcePath: input.sourcePath });
          return {
            ok: false,
            errors: [{ kind: "type", code: "TS2322", message: "type error", file: input.fileName }],
            warnings: [],
            descriptor: null,
          };
        },
      };
      const published: PublishedEvent[] = [];
      const deps: TurnValidationDeps = {
        machine,
        gateRunner,
        publish: (event) => published.push(event),
      };
      const pages = onePage({
        fileName: "home/index.tsx",
        sourcePath: "C:/workspace/turn-0192f6f0/pages/home/index.tsx",
      });

      const result = await wrap(runTurnValidation(deps, baseInput(1, pages)));

      expect(runPageCalls).toEqual([
        {
          fileName: "home/index.tsx",
          sourcePath: "C:/workspace/turn-0192f6f0/pages/home/index.tsx",
        },
      ]);
      if (result.kind !== "retry") throw new Error(`expected retry, got ${JSON.stringify(result)}`);
      expect(result.diagnostics.errors[0]?.file).toBe("home/index.tsx");
    });
  });

  test("on rejection with attempt < 4: emits turn.gateRejected, drives retryAfterGate, and returns retry with the next attempt", async () => {
    await context.start(async () => {
      const h = harness();
      h.gateRunner.queueRunPageResult(FAILING_PAGE_RESULT);

      const result = await wrap(runTurnValidation(h.deps, baseInput(2, onePage())));

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
      h.gateRunner.queueRunPageResult(FAILING_PAGE_RESULT);

      const result = await wrap(runTurnValidation(h.deps, baseInput(4, onePage())));

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
        h.gateRunner.queueRunPageResult(FAILING_PAGE_RESULT);
        await wrap(runTurnValidation(h.deps, baseInput(attempt, onePage())));
        expect(h.published[0]).toMatchObject({ payload: { retryNumber: attempt - 1 } });
      }
    });
  });

  test("turnId in the emitted event is a genuine UUIDv7, never re-derived", async () => {
    await context.start(async () => {
      const h = harness();
      h.gateRunner.queueRunPageResult(FAILING_PAGE_RESULT);
      await wrap(runTurnValidation(h.deps, baseInput(1, onePage())));
      const event = h.published[0];
      if (event === undefined || event.kind !== "turn.gateRejected")
        throw new Error("expected a turn.gateRejected event");
      expect(isUuidv7(event.payload.turnId)).toBe(true);
      expect(event.payload.turnId).toBe(TURN_ID);
    });
  });
});
