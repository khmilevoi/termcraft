# Preview render-failure surfacing and one-key repair — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A preview host that crashes while rendering surfaces as the design's `preview host · halted` panel instead of an indefinite `preparing preview…`, and `F6` writes a ready-to-send repair message into the composer.

**Architecture:** The Kernel subscribes to `HostSupervisorPort.onEvent` — the wiring that port's own header always anticipated — and maps the supervisor's `circuitOpened` onto the already-defined `preview.circuitOpened` event. The mirror and its `circuit-open` phase already exist; the UI grows a new panel, a new local action, and an ephemeral chat notice.

**Tech Stack:** Bun 1.3.14+, TypeScript 7, React 19 via `@opentui/react`, Reatom v1001, Zod 4, `errore`.

## Global Constraints

- **Test runner is `bun test`.** Tests import from `bun:test` and live beside the file under test (`foo.ts` → `foo.test.ts`). There is no `test` npm script; invoke `bun test <path>` directly.
- **The operational-failure code registry is closed at 30 members** (`src/core/protocol/model/failure.ts:10-46`, asserted by a closure test). Do not add a code. Preview crashes reuse `HOST_CIRCUIT_OPEN`.
- **Supervisor diagnostics carry no absolute paths, no environment values and no source contents** (host-supervision §13). The host's error text is already bounded to 200 characters at `src/host/supervisor/model/session.ts:462`; do not re-bound or re-truncate it.
- **All UI copy is English and comes verbatim from the design.** The authoritative method is `wsHostCrash` (`design/termcraft-engine.js:1127-1178`); the frames are `ws-host-crash-120` and `ws-host-crash-noretry-120` in `design/12-errors-edge-states.dc.html`.
- **Colours come only from `SHELL_PALETTE`** (`src/ui/theme/model/palette.ts:11-27`). Never a literal hex.
- **Cross-module imports use the tsconfig aliases** (`ui/…`, `core/…`, `host/…`, `entities/…`). Relative imports only inside one module.
- **Module shape:** `module/{ui,model}/…` with `types.ts` and `index.ts` at the module root. Nothing loose at a module root.
- **errore conventions:** return errors as values; `if (x instanceof Error) return x` on one line, no block; never swallow an error without logging it.
- **Reatom v1001:** `atom()` to read, `atom.set()` to write; every atom/action/computed is named; `wrap(...)` around any continuation that touches an atom after an `await` or `.then()`; `bind(...)` for callbacks invoked later from outside.
- **Never destroy a composer draft.** Filling the composer appends to a non-empty draft; it never overwrites.
- **Factories are named `create*`, never `make*`.**
- **Run `/reatom-audit` before reporting the work done** (Task 8).

The full design rationale is `docs/superpowers/specs/2026-07-27-preview-render-failure-repair-design.md`. Read it before Task 1.

---

### Task 1: The supervisor carries the failing incarnation's error out

Today `circuitOpened` carries only the restart policy's own `reason` (`restart budget exhausted (3 in 60000ms)`), while the real cause — `PAGE_RENDER_FAILED: TypeError: ctx.spy is not a function` — stays inside the `SupervisorError` that `onIncarnationFatal` already holds. Without this the repair message has nothing to say.

**Files:**
- Modify: `src/host/supervisor/types.ts:330-343` (the `SupervisorEvent` interface)
- Modify: `src/host/supervisor/model/supervisor.ts:156-168` (the `circuitOpened` emit)
- Modify: `src/core/ports/host-supervisor.ts:46-56` (the `SupervisorEventV1` mirror)
- Test: `src/host/supervisor/model/supervisor.test.ts`

`src/host/adapters/host-supervisor.ts` needs no change: it forwards the supervisor's event object straight through to its listeners (`:160-163`), so the two new fields flow automatically once both interfaces declare them.

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `SupervisorEvent` and `SupervisorEventV1` each gain
  `readonly failureCode?: string` and `readonly failureMessage?: string`, populated on
  `type: "circuitOpened"` only.

- [ ] **Step 1: Write the failing test**

Add to `src/host/supervisor/model/supervisor.test.ts`, inside the existing describe block that collects `events` (see the `const events: SupervisorEvent[] = []` harness at `:208` and the `circuitOpened` assertions at `:269` for the established shape):

```ts
test("circuitOpened carries the failing incarnation's code and message, not only the policy reason", async () => {
  // Drive the same crash-loop the existing budget-exhaustion test drives, but make every
  // incarnation die with a DESIGN_RENDER_FAILED whose reason is the host's own text.
  const h = createHarness();
  h.failEveryIncarnationWith(
    new SupervisorError({
      code: "DESIGN_RENDER_FAILED",
      reason: "PAGE_RENDER_FAILED: TypeError: ctx.spy is not a function",
    }),
  );
  await h.startAndExhaustBudget();

  const opened = events.find((e) => e.type === "circuitOpened");
  expect(opened).toBeDefined();
  expect(opened?.failureCode).toBe("DESIGN_RENDER_FAILED");
  expect(opened?.failureMessage).toBe(
    "PAGE_RENDER_FAILED: TypeError: ctx.spy is not a function",
  );
  // The policy reason is still reported — the two are different facts.
  expect(opened?.reason).toContain("restart budget exhausted");
});
```

Adapt `createHarness`/`failEveryIncarnationWith`/`startAndExhaustBudget` to whatever the file's existing harness actually exposes — read `supervisor.test.ts:200-300` first and reuse its own helpers rather than introducing new ones.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/host/supervisor/model/supervisor.test.ts`
Expected: FAIL — `expect(received).toBe(expected)` with `received: undefined` for `failureCode`.

- [ ] **Step 3: Declare the two fields**

In `src/host/supervisor/types.ts`, extend the `SupervisorEvent` interface:

```ts
  /** bounded reason (backoff/circuitOpened/stopped) */
  readonly reason?: string;
  /**
   * The FAILING INCARNATION's own error, on `circuitOpened` only — distinct from `reason`,
   * which reports the restart policy's verdict ("restart budget exhausted (3 in 60000ms)").
   * Without these the Kernel can say a preview stopped but never why, and the repair message
   * the UI offers has nothing to quote.
   *
   * §13-safe as-is: `session.ts` already bounds the reason to 200 characters and it carries
   * no path, environment value or source content.
   */
  readonly failureCode?: string;
  readonly failureMessage?: string;
```

Mirror the same two fields, with the same doc comment trimmed to one sentence, onto
`SupervisorEventV1` in `src/core/ports/host-supervisor.ts`.

- [ ] **Step 4: Populate them at the emit site**

In `src/host/supervisor/model/supervisor.ts`, inside `onIncarnationFatal`'s `decision.action === "open"` branch:

```ts
    if (decision.action === "open") {
      ks.state = "circuit-open";
      emit({
        type: "circuitOpened",
        key: ks.key,
        sessionId: ks.sessionId,
        pageSlug: ks.spec.pageSlug,
        sourceHashPrefix: hashPrefix(ks.spec),
        attempts: decision.attempts,
        reason: decision.reason,
        failureCode: String(error.code),
        failureMessage: error.reason,
      });
      tryDrainQueue();
      return;
    }
```

`error` is the `ProtocolError | SupervisorError` parameter already in scope; both carry `code` and `reason`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test src/host/supervisor/ src/core/ports/`
Expected: PASS, including every pre-existing supervisor test.

- [ ] **Step 6: Commit**

```bash
git add src/host/supervisor/types.ts src/host/supervisor/model/supervisor.ts src/host/supervisor/model/supervisor.test.ts src/core/ports/host-supervisor.ts
git commit -m "feat(host): carry the failing incarnation's error on circuitOpened"
```

---

### Task 2: The Kernel subscribes to the supervisor and publishes `preview.circuitOpened`

This is the defect's actual fix. `HostSupervisorPort.onEvent` has no production subscriber today, so a live session's crash-loop is invisible to everything above it.

**Files:**
- Modify: `src/core/kernel/model/handlers/preview-export.ts` (export a new entry point beside the private `openCircuitEvents` at `:583`)
- Modify: `src/core/kernel/model/kernel.ts` (subscribe near `setActivePreviewSession`, `:605`)
- Test: `src/core/kernel/model/handlers/preview-export.test.ts`, `src/core/kernel/model/kernel.integration.test.ts`

**Interfaces:**
- Consumes: `SupervisorEventV1.failureCode` / `.failureMessage` from Task 1.
- Produces:
  ```ts
  export function hostCircuitOpenedEvents(
    context: HandlerContext,
    previewSessionId: UUIDv7,
    pageSlug: PageSlug,
    sourceHash: Sha256Hex,
    attempts: number,
    safeMessage: string,
  ): readonly PublishableEventV1[];
  ```
  Returns `[]` when the preview machine cannot legally take `kernel.preview.sessionFailed`.

- [ ] **Step 1: Write the failing test**

Add to `src/core/kernel/model/handlers/preview-export.test.ts`:

```ts
describe("hostCircuitOpenedEvents — a LIVE session's host crash-loop", () => {
  test("applies sessionFailed then openCircuit and publishes preview.circuitOpened carrying the host's own message and the real attempt count", () => {
    const harness = createPreviewHarness();
    harness.handlerContext.machines.preview.apply("kernel.preview.enable");
    harness.handlerContext.machines.preview.apply("kernel.preview.beginStart");
    harness.handlerContext.machines.preview.apply("kernel.preview.sessionReady");
    expect(harness.handlerContext.machines.preview.phase()).toBe("live");

    const events = hostCircuitOpenedEvents(
      harness.handlerContext,
      PREVIEW_SESSION_ID,
      "dashboard" as PageSlug,
      SOURCE_HASH,
      4,
      "PAGE_RENDER_FAILED: TypeError: ctx.spy is not a function",
    );

    expect(harness.handlerContext.machines.preview.phase()).toBe("circuit-open");

    const opened = events.find((e) => e.kind === "preview.circuitOpened");
    expect(opened).toBeDefined();
    const payload = eventPayloadV1SchemaByKind["preview.circuitOpened"].parse(opened!.payload);
    expect(payload.attempts).toBe(4);
    expect(payload.finalFailure.code).toBe("HOST_CIRCUIT_OPEN");
    expect(payload.finalFailure.safeMessage).toBe(
      "PAGE_RENDER_FAILED: TypeError: ctx.spy is not a function",
    );
    expect(payload.retryCapability.available).toBe(true);
  });

  test("returns no events when the machine cannot legally take sessionFailed", () => {
    const harness = createPreviewHarness();
    // `disabled` — sessionFailed has no edge from here, so a duplicate or late event is dropped.
    const events = hostCircuitOpenedEvents(
      harness.handlerContext,
      PREVIEW_SESSION_ID,
      "dashboard" as PageSlug,
      SOURCE_HASH,
      4,
      "boom",
    );
    expect(events).toEqual([]);
  });
});
```

Reuse the file's own existing harness factory and constants — read its top-of-file setup (and the existing `DEFECTS 1+2 CLOSURE` describe at `:931`) before writing this, and match its names rather than inventing `createPreviewHarness` if the file calls it something else.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/core/kernel/model/handlers/preview-export.test.ts`
Expected: FAIL — `hostCircuitOpenedEvents is not defined`.

- [ ] **Step 3: Parameterize `attempts` on the private builder**

`openCircuitEvents` currently hardcodes `attempts: KERNEL_ESTABLISH_ATTEMPTS_PER_COMMAND` (`:627`) because the establish path has no real count. The supervisor now supplies one. Add a parameter with that constant as the default so the existing caller is unchanged:

```ts
function openCircuitEvents(
  context: HandlerContext,
  previewSessionId: UUIDv7,
  pageSlug: PageSlug,
  sourceHash: Sha256Hex,
  correlation: EventCorrelationV1,
  finalFailure: FailureDtoV1,
  attempts: number = KERNEL_ESTABLISH_ATTEMPTS_PER_COMMAND,
): readonly PublishableEventV1[] {
```

and use `attempts` in the payload at `:627`. Update that constant's own doc comment to record that the supervisor-driven path now passes a real count, so the stand-in applies to the establish path only.

- [ ] **Step 4: Add the exported entry point**

Beside `openCircuitEvents` in the same file:

```ts
/**
 * A LIVE preview session whose host crash-looped until the supervisor latched its circuit
 * open (`host/supervisor/model/supervisor.ts`'s `circuitOpened`). Distinct from the
 * establish-time path above: there the `HostSupervisorPort.preview` CALL itself returned
 * `HOST_CIRCUIT_OPEN`, so a command was in flight to attribute the failure to. Here the
 * command succeeded long ago and the failure arrives unsolicited, which is why this is its
 * own entry point rather than another branch of `selectCurrentSource`.
 *
 * `sessionFailed` is applied first — legal from `live` (`preview-machine.ts:80`) — and its
 * legality is the guard: from `circuit-open` it is illegal, which is exactly what makes a
 * repeated `circuitOpened` for the same key a no-op instead of a second publication.
 *
 * `finalFailure.code` is `HOST_CIRCUIT_OPEN` because the operational-failure registry is
 * closed at 30 members; the host's own message is what `safeMessage` carries.
 */
export function hostCircuitOpenedEvents(
  context: HandlerContext,
  previewSessionId: UUIDv7,
  pageSlug: PageSlug,
  sourceHash: Sha256Hex,
  attempts: number,
  safeMessage: string,
): readonly PublishableEventV1[] {
  if (!context.machines.preview.canApply("kernel.preview.sessionFailed")) return [];
  const failedOutcome = context.machines.preview.apply("kernel.preview.sessionFailed");
  if (failedOutcome.kind !== "changed") return [];

  const correlation: EventCorrelationV1 = { previewSessionId };
  const finalFailure: FailureDtoV1 = {
    code: "HOST_CIRCUIT_OPEN",
    retryable: true,
    safeMessage,
    details: { pageSlug, attempts },
  };

  return [
    previewStateChangedEvent("kernel.preview.sessionFailed", failedOutcome, correlation),
    ...openCircuitEvents(
      context,
      previewSessionId,
      pageSlug,
      sourceHash,
      correlation,
      finalFailure,
      attempts,
    ),
  ];
}
```

Match `EventCorrelationV1`'s real required fields — read how `selectCurrentSource` builds its own correlation object and copy that shape rather than assuming `{previewSessionId}` alone satisfies it.

- [ ] **Step 5: Run the handler test to verify it passes**

Run: `bun test src/core/kernel/model/handlers/preview-export.test.ts`
Expected: PASS.

- [ ] **Step 6: Write the failing subscription test**

Add to `src/core/kernel/model/kernel.integration.test.ts`:

```ts
test("a supervisor circuitOpened for the live session publishes preview.circuitOpened; a foreign key publishes nothing", async () => {
  const { kernel, supervisor } = await createKernelWithLivePreview({ pageSlug: "dashboard" });
  const envelopes: EventEnvelopeV1[] = [];
  const unsubscribe = kernel.events((envelope) => envelopes.push(envelope));

  supervisor.emit({
    type: "circuitOpened",
    key: "other-page@deadbeef",
    sessionId: "s-other",
    pageSlug: "other-page",
    sourceHashPrefix: "deadbeef",
    attempts: 4,
    reason: "restart budget exhausted (3 in 60000ms)",
    failureCode: "DESIGN_RENDER_FAILED",
    failureMessage: "boom",
  });
  await flushMicrotasks();
  expect(envelopes.filter((e) => e.kind === "preview.circuitOpened")).toHaveLength(0);

  supervisor.emit({
    type: "circuitOpened",
    key: liveKey,
    sessionId: liveSessionId,
    pageSlug: "dashboard",
    sourceHashPrefix: liveSourceHash.slice(0, 8),
    attempts: 4,
    reason: "restart budget exhausted (3 in 60000ms)",
    failureCode: "DESIGN_RENDER_FAILED",
    failureMessage: "PAGE_RENDER_FAILED: TypeError: ctx.spy is not a function",
  });
  await flushMicrotasks();

  const opened = envelopes.filter((e) => e.kind === "preview.circuitOpened");
  expect(opened).toHaveLength(1);

  unsubscribe();
});
```

`src/core/ports/fakes/host-supervisor.ts` already exposes an `emit` for exactly this
(`:41`). Build `createKernelWithLivePreview` from whatever the file's existing integration
harness already provides for establishing a preview.

- [ ] **Step 7: Run it to verify it fails**

Run: `bun test src/core/kernel/model/kernel.integration.test.ts`
Expected: FAIL — zero `preview.circuitOpened` envelopes on the matching key.

- [ ] **Step 8: Wire the subscription**

In `src/core/kernel/model/kernel.ts`, after `previewSessionCommands` and `launchOperation` both exist, add:

```ts
    /**
     * THE MISSING CONSUMER (defect fix, 2026-07-27). `HostSupervisorPort.onEvent` had no
     * production subscriber at all, so a live session whose host crash-looped latched its
     * circuit open in silence and the Workspace sat on `preparing preview…` forever. This is
     * the wiring the port's own header always named: "phase 6 wires this onto the Kernel
     * event channel."
     *
     * ONLY `circuitOpened` is mapped. `backoff` is deliberately left as a pure diagnostic: a
     * restart that succeeds must not have flashed an error on the way, and the supervisor's
     * 250/500/1000 ms backoff means the whole cycle is over in seconds, during which
     * `preparing preview…` is an accurate statement.
     *
     * Correlation is by `(pageSlug, sourceHashPrefix)` against the spec the live session was
     * established with. A non-matching key belongs to another session — or to one already
     * replaced — and is dropped rather than attributed to whatever happens to be live.
     */
    const unsubscribeSupervisor = deps.hostSupervisor.onEvent((event) => {
      if (event.type !== "circuitOpened") return;
      const spec = previewSessionCommands.currentSpec();
      const previewSessionId = previewSessionCommands.currentPreviewSessionId();
      if (spec === null || previewSessionId === null) {
        trace("kernel.preview.hostCircuitOpened", { step: "dropped", reason: "no live session" });
        return;
      }
      if (
        event.pageSlug !== spec.pageSlug ||
        !spec.sourceHash.startsWith(event.sourceHashPrefix)
      ) {
        trace("kernel.preview.hostCircuitOpened", { step: "dropped", reason: "foreign key" });
        return;
      }
      const safeMessage = event.failureMessage ?? event.reason ?? "the preview host stopped";
      launchOperation("kernel.preview.hostCircuitOpened", async () =>
        hostCircuitOpenedEvents(
          handlerContext,
          previewSessionId as UUIDv7,
          spec.pageSlug as PageSlug,
          spec.sourceHash,
          event.attempts ?? 0,
          safeMessage,
        ),
      );
    });
```

`safeMessage` falls back to the policy reason when the deterministic branch supplied no
incarnation message — never to an invented string beyond the final literal, which only runs
when neither field exists.

Register `unsubscribeSupervisor` alongside the Kernel's other teardown so a disposed Kernel
stops receiving events. Find how the existing disposal path is assembled in this file and
add to it; do not introduce a second teardown mechanism.

`handlerContext` is declared at `:745` — place this subscription after it, and after
`launchOperation` at `:704`.

- [ ] **Step 9: Run the tests to verify they pass**

Run: `bun test src/core/kernel/`
Expected: PASS, all pre-existing Kernel tests included.

- [ ] **Step 10: Commit**

```bash
git add src/core/kernel/model/handlers/preview-export.ts src/core/kernel/model/handlers/preview-export.test.ts src/core/kernel/model/kernel.ts src/core/kernel/model/kernel.integration.test.ts
git commit -m "fix(kernel): surface a live preview host's crash-loop as preview.circuitOpened"
```

---

### Task 3: The repair-prompt builder

A pure function over the mirror's preview slice — the same derivation-without-a-renderer split `workspace/model/attach.ts` and `workspace/model/tabs.ts` already use.

**Files:**
- Create: `src/ui/preview/model/repair-prompt.ts`
- Create: `src/ui/preview/model/repair-prompt.test.ts`
- Modify: `src/ui/preview/index.ts` (export the builder)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  ```ts
  export interface RepairPromptInput {
    readonly pageSlug: string;
    readonly safeMessage: string;
    /** `null` for the `failed` phase, which has no attempt count. */
    readonly attempts: number | null;
  }
  export function relativePageSourcePath(pageSlug: string): string;
  export function buildRepairPrompt(input: RepairPromptInput): string;
  ```

- [ ] **Step 1: Write the failing test**

Create `src/ui/preview/model/repair-prompt.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

import { buildRepairPrompt, relativePageSourcePath } from "./repair-prompt";

describe("relativePageSourcePath", () => {
  test("is the canonical page layout, project-relative — never absolute", () => {
    expect(relativePageSourcePath("dashboard")).toBe(".termcraft/pages/dashboard/page.tsx");
  });
});

describe("buildRepairPrompt", () => {
  const MESSAGE = "PAGE_RENDER_FAILED: TypeError: ctx.spy is not a function";

  test("names the page, the file and the verbatim error, and says this is not a Gate rejection", () => {
    const text = buildRepairPrompt({ pageSlug: "dashboard", safeMessage: MESSAGE, attempts: 4 });
    expect(text).toContain('The preview cannot render the "dashboard" page.');
    expect(text).toContain("not a Gate rejection");
    expect(text).toContain("  file:     .termcraft/pages/dashboard/page.tsx");
    expect(text).toContain(`  error:    ${MESSAGE}`);
    expect(text).toContain(
      "  attempts: 4 host incarnations failed before the preview circuit opened",
    );
    expect(text).toContain("this is a repair, not a redesign");
  });

  test("drops the attempts line when there is no attempt count", () => {
    const text = buildRepairPrompt({ pageSlug: "dashboard", safeMessage: MESSAGE, attempts: null });
    expect(text).not.toContain("attempts:");
    expect(text).toContain(`  error:    ${MESSAGE}`);
  });

  test("never emits an absolute path", () => {
    const text = buildRepairPrompt({ pageSlug: "dashboard", safeMessage: MESSAGE, attempts: 4 });
    expect(text).not.toMatch(/[A-Za-z]:\\|^\//m);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/ui/preview/model/repair-prompt.test.ts`
Expected: FAIL — cannot resolve `./repair-prompt`.

- [ ] **Step 3: Write the implementation**

Create `src/ui/preview/model/repair-prompt.ts`:

```ts
/**
 * The message `F6` writes into the composer when the preview host has stopped — the text the
 * user reads and sends. NOT sent on their behalf: `intent.ts`'s `compose-repair` effect fills
 * the composer and moves focus there, and the design says so on the frame itself
 * (`design/termcraft-engine.js`'s `wsHostCrash`: "nothing is sent — you press ⏎").
 *
 * It deliberately does not re-teach the runtime API. `reatom-guide.md` is already in the
 * agent's system prompt (`agent/prompt/model/runtime-docs.ts:26`) and covers exactly the
 * `ctx.spy is not a function` case; this message's whole job is to state the failure.
 */

/** The directory canonical project state lives in, under the project root (storage-identity §4). */
const PROJECT_STATE_DIRNAME = ".termcraft";

/**
 * CANONICAL page storage, PROJECT-RELATIVE. The Kernel's own
 * `canonicalPageSourcePath` (`core/kernel/model/handlers/preview-export.ts:157`) returns the
 * ABSOLUTE form, which the host child needs and this message must not carry: an absolute path
 * belongs neither in a §13 diagnostic nor in a line the user reads in their chat. Same layout,
 * project-relative — transcribed rather than imported, because `ui` may not reach into `core`'s
 * handler internals.
 */
export function relativePageSourcePath(pageSlug: string): string {
  return `${PROJECT_STATE_DIRNAME}/pages/${pageSlug}/page.tsx`;
}

export interface RepairPromptInput {
  readonly pageSlug: string;
  /** The host's own bounded error text, as the Kernel published it. Quoted verbatim. */
  readonly safeMessage: string;
  /** `null` for the `failed` phase, which has no attempt count to report. */
  readonly attempts: number | null;
}

export function buildRepairPrompt(input: RepairPromptInput): string {
  const lines: string[] = [
    `The preview cannot render the "${input.pageSlug}" page.`,
    "",
    "This is a runtime error from the preview host, not a Gate rejection — the page",
    "passed every static check and then threw while rendering.",
    "",
    `  file:     ${relativePageSourcePath(input.pageSlug)}`,
    `  error:    ${input.safeMessage}`,
  ];
  if (input.attempts !== null) {
    lines.push(
      `  attempts: ${input.attempts} host incarnations failed before the preview circuit opened`,
    );
  }
  lines.push(
    "",
    "Fix the render error in that file. Keep the page's behaviour and layout as they",
    "are — this is a repair, not a redesign.",
  );
  return lines.join("\n");
}
```

- [ ] **Step 4: Export it and run the test**

Add to `src/ui/preview/index.ts`:

```ts
export { buildRepairPrompt, relativePageSourcePath } from "./model/repair-prompt";
export type { RepairPromptInput } from "./model/repair-prompt";
```

Run: `bun test src/ui/preview/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/preview/model/repair-prompt.ts src/ui/preview/model/repair-prompt.test.ts src/ui/preview/index.ts
git commit -m "feat(ui): add the preview repair-prompt builder"
```

---

### Task 4: The `preview.repair` action and its `compose-repair` effect

**Files:**
- Modify: `src/ui/actions/types.ts:4-12` (the `UiActionExecution` local-effect union)
- Modify: `src/ui/actions/model/registry.ts` (a new entry beside `preview.retry`)
- Modify: `src/ui/app/model/intent.ts:382-422` (`executeAction`)
- Test: `src/ui/app/model/intent.test.ts`, `src/ui/actions/model/registry.test.ts`

**Interfaces:**
- Consumes: `buildRepairPrompt` from Task 3.
- Produces: action id `"preview.repair"`, hotkey `f6`, label `"repair"`; local effect
  `"compose-repair"`.

- [ ] **Step 1: Write the failing test**

Add to `src/ui/app/model/intent.test.ts`, following the file's own existing `deps`/`event`
harness:

```ts
describe("F6 — compose-repair", () => {
  const CRASH_MESSAGE = "PAGE_RENDER_FAILED: TypeError: ctx.spy is not a function";

  test("fills an empty composer with the repair message and moves focus there", () => {
    const deps = createDeps();
    deps.mirror.apply(circuitOpened({ pageSlug: "dashboard", attempts: 4, safeMessage: CRASH_MESSAGE }));
    deps.local.focus.set("preview");

    applyIntent({ kind: "action-execute", actionId: "preview.repair" }, deps);

    expect(deps.local.composer()).toContain('The preview cannot render the "dashboard" page.');
    expect(deps.local.composer()).toContain(CRASH_MESSAGE);
    expect(deps.local.focus()).toBe("composer");
  });

  test("appends below a blank line rather than overwriting an existing draft", () => {
    const deps = createDeps();
    deps.mirror.apply(circuitOpened({ pageSlug: "dashboard", attempts: 4, safeMessage: CRASH_MESSAGE }));
    deps.local.composer.set("my own words");

    applyIntent({ kind: "action-execute", actionId: "preview.repair" }, deps);

    expect(deps.local.composer().startsWith("my own words\n\n")).toBe(true);
    expect(deps.local.composer()).toContain(CRASH_MESSAGE);
  });

  test("no-ops when the preview is not in an error phase", () => {
    const deps = createDeps();
    applyIntent({ kind: "action-execute", actionId: "preview.repair" }, deps);
    expect(deps.local.composer()).toBe("");
  });

  test("no-ops on the read-only screen", () => {
    const deps = createDeps({ screen: "read-only" });
    deps.mirror.apply(circuitOpened({ pageSlug: "dashboard", attempts: 4, safeMessage: CRASH_MESSAGE }));
    applyIntent({ kind: "action-execute", actionId: "preview.repair" }, deps);
    expect(deps.local.composer()).toBe("");
  });
});
```

`circuitOpened` already exists in this file at `:223-226` — reuse it, widening its parameters
if it currently hardcodes the payload.

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/ui/app/model/intent.test.ts`
Expected: FAIL — the composer stays empty; `preview.repair` resolves to no registry entry.

- [ ] **Step 3: Widen the effect union**

In `src/ui/actions/types.ts`:

```ts
export type UiActionExecution =
  | {
      readonly kind: "local";
      readonly effect: "fullscreen" | "open-chats" | "exit" | "compose-repair";
    }
  | {
      readonly kind: "command";
      readonly command: "chat.create" | "export.start" | "preview.retry";
    }
  | { readonly kind: "inert" };
```

- [ ] **Step 4: Add the registry entry**

In `src/ui/actions/model/registry.ts`, directly after the `preview.retry` entry:

```ts
  {
    // The design's second route out of a halted preview (`design/termcraft-engine.js`'s
    // `wsHostCrash`: `F6 repair… · write the failure into the composer · nothing is sent —
    // you press ⏎`). `f6` and `f5` are BOTH design-named here — this closes the divergence
    // the `preview.retry` entry above records, where `f5` had been chosen in code because
    // the design had no circuit-open screen at all. It now has two.
    //
    // `kind: "local"` and `capability: null` because nothing is dispatched: the effect writes
    // the composer and moves focus, and the user sends it themselves.
    id: "preview.repair",
    execution: { kind: "local", effect: "compose-repair" },
    hotkey: { id: "preview.repair", key: "f6", label: "repair", capability: null },
  },
```

Update the `preview.retry` entry's own DIVERGENCE comment to record that the design has since
named `F5`, so the note reads as closed history rather than a live gap.

- [ ] **Step 5: Handle the effect**

In `src/ui/app/model/intent.ts`'s `executeAction`, before the trailing `open-chats` body:

```ts
  if (execution.effect === "compose-repair") {
    // The composer is the destination, so the same refusal `composer-submit` applies here:
    // filling an input that cannot send would promise an action the screen does not offer.
    if (deps.screen() === "read-only") {
      trace("ui.composeRepair.refused", { reason: "screen is read-only" });
      return;
    }
    const preview = deps.mirror.preview();
    if (preview.phase !== "circuit-open" && preview.phase !== "failed") {
      trace("ui.composeRepair.refused", { reason: `preview phase is ${preview.phase}` });
      return;
    }
    const text = buildRepairPrompt({
      pageSlug: preview.pageSlug,
      safeMessage:
        preview.phase === "circuit-open"
          ? preview.finalFailure.safeMessage
          : preview.failure.safeMessage,
      attempts: preview.phase === "circuit-open" ? preview.attempts : null,
    });
    // NEVER overwrite a draft: this codebase already carries two defect fixes built on that
    // principle (`home-submit` and `composer-submit` both clear their input only once the
    // Kernel accepted). An empty composer is filled; a non-empty one keeps every character.
    const draft = deps.local.composer();
    deps.local.composer.set(draft.length === 0 ? text : `${draft}\n\n${text}`);
    deps.local.focus.set("composer");
    return;
  }
```

Import `buildRepairPrompt` from `"ui/preview"` (an absolute alias — `intent.ts` lives in
`ui/app`, a different module).

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun test src/ui/app/ src/ui/actions/`
Expected: PASS. `registry.test.ts` may assert the entry count or the hotkey set — update those
expectations to include `preview.repair`/`f6`.

- [ ] **Step 7: Commit**

```bash
git add src/ui/actions/types.ts src/ui/actions/model/registry.ts src/ui/app/model/intent.ts src/ui/app/model/intent.test.ts src/ui/actions/model/registry.test.ts
git commit -m "feat(ui): bind F6 to compose a preview repair message"
```

---

### Task 5: The `HostCrashPanel` component

`ErrorPanel` is neither extended nor reused. It draws three centred lines and an optional
inset, and it still serves the Gate state (`wsBrokenSource`), which the design left untouched.
`wsHostCrash` draws a bordered, titled block with a gutter, a tee rule and two-line key rows.

**Files:**
- Create: `src/ui/preview/ui/HostCrashPanel.tsx`
- Create: `src/ui/preview/ui/HostCrashPanel.test.tsx`
- Modify: `src/ui/preview/index.ts`

**Interfaces:**
- Consumes: `relativePageSourcePath` from Task 3.
- Produces:
  ```ts
  export interface HostCrashPanelProps {
    readonly id: string;
    readonly width: number;
    readonly height: number;
    readonly pageSlug: string;
    /** The host's own bounded message, rendered verbatim and wrapped — never truncated. */
    readonly hostMessage: string;
    readonly attempts: number;
    readonly retryAvailable: boolean;
  }
  export function HostCrashPanel(props: HostCrashPanelProps): JSX.Element;
  ```

- [ ] **Step 1: Write the failing test**

Create `src/ui/preview/ui/HostCrashPanel.test.tsx`, following `ErrorPanel.test.tsx`'s harness
exactly (`createHeadlessRenderer`, `findRun`, `extractRgb`, the `afterEach` destroy):

```tsx
import { afterEach, describe, expect, test } from "bun:test";

import type { StyledRun } from "host/protocol";
import { extractRgb } from "host/render/model/color";
import { createHeadlessRenderer } from "host/render/model/renderer";
import type { RenderHandle } from "host/render/types";
import { SHELL_PALETTE } from "ui/theme";

import { HostCrashPanel } from "./HostCrashPanel";

let open: RenderHandle | null = null;
afterEach(() => {
  open?.destroy();
  open = null;
});

const findRun = (frame: { rows: StyledRun[][] }, needle: string) =>
  frame.rows.flat().find((run) => run.text.includes(needle));

const MESSAGE = "PAGE_RENDER_FAILED: TypeError: ctx.spy is not a function";

async function mount(retryAvailable: boolean) {
  const handle = await createHeadlessRenderer({ w: 76, h: 26 });
  open = handle;
  handle.mount(
    <HostCrashPanel
      id="crash"
      width={76}
      height={26}
      pageSlug="dashboard"
      hostMessage={MESSAGE}
      attempts={4}
      retryAvailable={retryAvailable}
    />,
  );
  await handle.render();
  return handle.capture();
}

describe("HostCrashPanel (design wsHostCrash)", () => {
  test("titles the block and opens with the red crash line", async () => {
    const frame = await mount(true);
    expect(findRun(frame, "preview host · halted")).toBeDefined();
    const headline = findRun(frame, "✗ design threw while rendering — no preview");
    expect(headline).toBeDefined();
    expect(headline && extractRgb(headline.fg)).toBe<string>(SHELL_PALETTE.red);
  });

  test("names the page and its project-relative file", async () => {
    const frame = await mount(true);
    expect(findRun(frame, ".termcraft/pages/dashboard/page.tsx")).toBeDefined();
  });

  test("reports the restart tally", async () => {
    const frame = await mount(true);
    expect(findRun(frame, "mounted 4× · 3 automatic restarts, all identical")).toBeDefined();
    expect(findRun(frame, "restarts stopped — no preview until you act")).toBeDefined();
  });

  test("renders the host message verbatim and wrapped, never truncated", async () => {
    const long = `PAGE_RENDER_FAILED: ${"x".repeat(180)}`;
    const handle = await createHeadlessRenderer({ w: 76, h: 30 });
    open = handle;
    handle.mount(
      <HostCrashPanel
        id="crash"
        width={76}
        height={30}
        pageSlug="dashboard"
        hostMessage={long}
        attempts={4}
        retryAvailable
      />,
    );
    await handle.render();
    const joined = handle
      .capture()
      .rows.flat()
      .map((run) => run.text)
      .join("");
    expect(joined).not.toContain("…");
    expect(joined.replace(/\s+/g, "")).toContain("x".repeat(180));
  });

  test("offers both keys when retry is available", async () => {
    const frame = await mount(true);
    const f5 = findRun(frame, "retry preview");
    expect(f5).toBeDefined();
    expect(f5 && extractRgb(f5.fg)).toBe<string>(SHELL_PALETTE.amberHi);
    expect(findRun(frame, "repair…")).toBeDefined();
  });

  test("draws F5 faint with its own reason when retry is unavailable", async () => {
    const frame = await mount(false);
    const f5 = findRun(frame, "retry preview");
    expect(f5).toBeDefined();
    expect(f5 && extractRgb(f5.fg)).toBe<string>(SHELL_PALETTE.faint);
    expect(findRun(frame, "unavailable in this session")).toBeDefined();
    expect(findRun(frame, "repair is the only route out")).toBeDefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/ui/preview/ui/HostCrashPanel.test.tsx`
Expected: FAIL — cannot resolve `./HostCrashPanel`.

- [ ] **Step 3: Write the component**

Create `src/ui/preview/ui/HostCrashPanel.tsx`. Transcribe every string and tone from
`wsHostCrash` (`design/termcraft-engine.js:1127-1178`); wrap the host message with the
existing text-wrapping helper the chat panel already uses rather than writing a second
wrapper (`src/ui/chat/model/text-rows.ts` — read it and reuse, or lift the shared piece).

Structure:

```tsx
import { relativePageSourcePath } from "../model/repair-prompt";
import { SHELL_PALETTE, shellAttrs } from "ui/theme";

const BOLD = shellAttrs({ bold: true });

/**
 * The preview-region panel for a host that crashed while rendering (design `wsHostCrash`,
 * `design/12-errors-edge-states.dc.html`'s `ws-host-crash-120` and
 * `ws-host-crash-noretry-120`).
 *
 * DISTINCT FROM `ErrorPanel` ON PURPOSE. `ErrorPanel` renders the GATE state
 * (`wsBrokenSource`): a candidate refused by static checks that never ran. This one renders
 * the opposite — a design that passed every check, was mounted by a live host child, and
 * threw. The design's own comment lists the distinctions it makes so the two frames cannot
 * be confused when either is read alone: a bordered report rather than bare centred text,
 * the `preview host · halted` title, an opening line naming *threw while rendering*, and
 * ` HALTED ` in the status bar instead of ` STATIC `.
 *
 * The host message is wrapped, never truncated: the runtime already bounds it to 200
 * characters, so there is no hidden text and therefore no affordance needed to reveal any.
 */
export function HostCrashPanel(props: HostCrashPanelProps) {
  // …bordered box titled "preview host · halted", red border/title;
  // …headline `✗ design threw while rendering — no preview` (red, BOLD);
  // …slug (amberHi BOLD) + ` · ${relativePageSourcePath(props.pageSlug)}` (fg);
  // …`host message` label (dim), then each wrapped line prefixed by a red `│` gutter;
  // …`mounted ${props.attempts}× · ${props.attempts - 1} automatic restarts, all identical` (dim);
  // …`restarts stopped — no preview until you act` (dim);
  // …a full-width rule, then the two key rows.
}
```

Two divergences to record in code comments as you write it, since OpenTUI's flexbox cannot
reproduce the engine's absolute cell placement — the same class of note `ErrorPanel.tsx:42-47`
already carries:
1. the engine positions the block by computed cell coordinates; a flex column centred in the
   pane is the closest faithful mapping;
2. the engine draws the tee rule by writing `├`/`┤` into the box's own border cells, which a
   flex child cannot reach — use a full-width horizontal rule inside the box instead.

- [ ] **Step 4: Export it and run the tests**

Add to `src/ui/preview/index.ts`:

```ts
export { HostCrashPanel } from "./ui/HostCrashPanel";
export type { HostCrashPanelProps } from "./ui/HostCrashPanel";
```

Run: `bun test src/ui/preview/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/preview/ui/HostCrashPanel.tsx src/ui/preview/ui/HostCrashPanel.test.tsx src/ui/preview/index.ts
git commit -m "feat(ui): add the host-crash preview panel (design wsHostCrash)"
```

---

### Task 6: Workspace wiring — panel branch, status bar, composer attach

**Files:**
- Modify: `src/ui/workspace/ui/Workspace.tsx:205-289` (`renderPreviewRegion`) and its status-bar assembly
- Modify: `src/ui/workspace/model/attach.ts:101-119` (`deriveComposerAttach`)
- Test: `src/ui/workspace/model/attach.test.ts`, `src/ui/workspace/ui/Workspace.test.tsx`

**Interfaces:**
- Consumes: `HostCrashPanel` from Task 5.
- Produces: `ComposerAttachInput` gains
  `readonly previewCrashed: null | { readonly retryAvailable: boolean }`.

- [ ] **Step 1: Write the failing attach test**

Add to `src/ui/workspace/model/attach.test.ts`:

```ts
test("a crashed preview offers the repair key, retry-aware", () => {
  expect(
    deriveComposerAttach({ ...base, previewCrashed: { retryAvailable: true } }),
  ).toEqual({ text: "F6 writes the fix · or type your own", fg: "amberHi" });

  expect(
    deriveComposerAttach({ ...base, previewCrashed: { retryAvailable: false } }),
  ).toEqual({ text: "F6 writes the fix — retry unavailable", fg: "amberHi" });
});

test("a running turn outranks the crash line — it contradicts an offer to send", () => {
  expect(
    deriveComposerAttach({
      ...base,
      turnRunning: true,
      composerValue: "draft",
      previewCrashed: { retryAvailable: true },
    }),
  ).toEqual({ text: "⏎ send disabled — draft kept", fg: "amberHi" });
});
```

`base` is the file's own existing fixture — extend it with `previewCrashed: null`.

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/ui/workspace/model/attach.test.ts`
Expected: FAIL — the crash cases return `null`.

- [ ] **Step 3: Add the attach branch**

In `src/ui/workspace/model/attach.ts`, add the field to `ComposerAttachInput`:

```ts
  /**
   * Set when the preview is in a crash/failure phase (design `wsHostCrash`'s own `attach`).
   * `null` otherwise. Carries `retryAvailable` because the design words the line differently
   * once `F5` is gone.
   */
  readonly previewCrashed: null | { readonly retryAvailable: boolean };
```

and the branch, LAST — immediately before the final `return null`:

```ts
  if (input.previewCrashed !== null) {
    return {
      text: input.previewCrashed.retryAvailable
        ? "F6 writes the fix · or type your own"
        : "F6 writes the fix — retry unavailable",
      fg: "amberHi",
    };
  }
  return null;
```

Placed last on purpose: the turn-running branches above must win, because
`⏎ send disabled — draft kept` contradicts a line offering to write something the user can
send. Extend the function's own doc-comment priority list with this new lowest entry.

- [ ] **Step 4: Run the attach tests**

Run: `bun test src/ui/workspace/model/attach.test.ts`
Expected: PASS. Every existing caller of `deriveComposerAttach` must now pass
`previewCrashed` — fix the call site in `Workspace.tsx` and any test fixture the compiler flags.

- [ ] **Step 5: Write the failing Workspace test**

Add to `src/ui/workspace/ui/Workspace.test.tsx`:

```tsx
test("a circuit-open preview renders the host-crash panel, not the Gate error panel", async () => {
  const frame = await renderWorkspaceWith({
    preview: circuitOpenMirror({ pageSlug: "dashboard", attempts: 4, retryAvailable: true }),
  });
  expect(findRun(frame, "preview host · halted")).toBeDefined();
  expect(findRun(frame, "could not render current design")).toBeUndefined();
});

test("the status bar wears the HALTED chip and lists both keys", async () => {
  const frame = await renderWorkspaceWith({
    preview: circuitOpenMirror({ pageSlug: "dashboard", attempts: 4, retryAvailable: true }),
  });
  expect(findRun(frame, "HALTED")).toBeDefined();
  expect(findRun(frame, "render crashed")).toBeDefined();
  expect(findRun(frame, "repair")).toBeDefined();
});
```

Build `circuitOpenMirror` and `renderWorkspaceWith` from the file's own existing helpers.

- [ ] **Step 6: Run it to verify it fails**

Run: `bun test src/ui/workspace/ui/Workspace.test.tsx`
Expected: FAIL — the Gate panel renders instead.

- [ ] **Step 7: Route the phase to the new panel**

In `renderPreviewRegion`, replace the `preview.phase === "circuit-open"` branch
(`Workspace.tsx:235-253`) with:

```tsx
  if (preview.phase === "circuit-open") {
    return (
      <HostCrashPanel
        id="ws-preview-crash"
        width={width}
        height={height}
        pageSlug={preview.pageSlug}
        hostMessage={preview.finalFailure.safeMessage}
        attempts={preview.attempts}
        retryAvailable={preview.retryAvailable}
      />
    );
  }
```

Leave the `failed` branch on `ErrorPanel`: that phase is the establish-time failure
(`preview-export.ts:672-673`), whose own design is `wsBrokenSource`.

In the status-bar assembly, when the phase is `circuit-open`, set the mode chip to
`{ text: " HALTED ", fg: "bg", bg: "red" }`, the hint to `render crashed` (`red` on `redDim`),
and the key row to `F5 retry · F6 repair · F2 full · F3 tweaks`, marking `F5` as
`["F5", "retry", "dis"]` when `preview.retryAvailable` is false. Read how the file already
derives `hintKeys` from `HOTKEYS` and extend that derivation rather than hand-building a
parallel array.

Pass `previewCrashed` into `deriveComposerAttach` from the same phase check.

- [ ] **Step 8: Run the workspace tests**

Run: `bun test src/ui/workspace/`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/ui/workspace/
git commit -m "feat(ui): route a halted preview to the host-crash panel and its status bar"
```

---

### Task 7: The ephemeral chat notice

The design puts two lines in the chat panel. They render as UI-local ephemeral notices, not
persisted records: `system:error` requires exactly one of `turnId`/`actionId`
(`src/entities/chat/model/decode.ts:114-121`) and a host crash is neither — it happens outside
any turn, and no user performed an action.

**Files:**
- Modify: `src/ui/mirror/types.ts` (a `previewNotice` slice)
- Modify: `src/ui/mirror/model/mirror.ts:517-528` (set it on `preview.circuitOpened`; clear it on `preview.sessionReady`)
- Create: `src/ui/chat/ui/SystemNotice.tsx`
- Create: `src/ui/chat/ui/SystemNotice.test.tsx`
- Modify: `src/ui/chat/index.ts`, `src/ui/workspace/ui/Workspace.tsx:509-516`
- Test: `src/ui/mirror/model/mirror.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  ```ts
  // ui/mirror
  export interface PreviewNoticeMirror {
    readonly headline: string;
    readonly detail: string;
  }
  // reader: mirror.previewNotice(): PreviewNoticeMirror | null
  // ui/chat
  export interface SystemNoticeProps {
    readonly id: string;
    readonly headline: string;
    readonly detail: string;
  }
  ```

- [ ] **Step 1: Write the failing mirror test**

Add to `src/ui/mirror/model/mirror.test.ts`:

```ts
test("preview.circuitOpened raises the crash notice; sessionReady clears it", () => {
  const mirror = createMirror();
  mirror.apply(
    event("preview.circuitOpened", {
      /* the same payload the existing circuitOpened test at :1088 builds */
    }),
  );
  expect(mirror.previewNotice()).toEqual({
    headline: "✗ preview crashed while rendering — halted after 3 restarts",
    detail: "the design passed Gate; the host died running it",
  });

  mirror.apply(event("preview.sessionReady", { /* … */ }));
  expect(mirror.previewNotice()).toBeNull();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/ui/mirror/model/mirror.test.ts`
Expected: FAIL — `mirror.previewNotice is not a function`.

- [ ] **Step 3: Add the mirror slice**

Declare `PreviewNoticeMirror` in `src/ui/mirror/types.ts` with a doc comment recording why it
is ephemeral rather than a chat record (cite `entities/chat/model/decode.ts:114-121`). Add a
named atom in `mirror.ts` — `atom<PreviewNoticeMirror | null>(null, "ui.mirror.previewNotice")`
— set it in the `preview.circuitOpened` case:

```ts
        previewNotice.set({
          headline: `✗ preview crashed while rendering — halted after ${p.attempts - 1} restarts`,
          detail: "the design passed Gate; the host died running it",
        });
```

and clear it (`previewNotice.set(null)`) in the `preview.sessionReady` case and wherever the
mirror resets on a fresh `kernel.snapshot`. The notice describes a live condition; leaving it
up after the preview recovers would make the chat claim a crash that no longer holds.

- [ ] **Step 4: Write the failing component test**

Create `src/ui/chat/ui/SystemNotice.test.tsx` on the same headless-renderer harness as
`HostCrashPanel.test.tsx`, asserting the headline renders in `SHELL_PALETTE.red` and the
detail in `SHELL_PALETTE.faint`.

- [ ] **Step 5: Write the component and mount it**

Create `src/ui/chat/ui/SystemNotice.tsx` — two text rows, `red` and `faint`, no border.
Export it from `src/ui/chat/index.ts`.

In `Workspace.tsx`, render it between `ChatScrollback` (`:509-515`) and the
`turn.phase === "running"` block (`:516`), reading `mirror.previewNotice()`:

```tsx
              {previewNotice !== null && (
                <SystemNotice
                  id="ws-preview-notice"
                  headline={previewNotice.headline}
                  detail={previewNotice.detail}
                />
              )}
```

Below the persisted tail, above the live turn block — chronologically the crash follows the
turn that produced the design, which is exactly where the design draws it.

- [ ] **Step 6: Run the tests**

Run: `bun test src/ui/mirror/ src/ui/chat/ src/ui/workspace/`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/ui/mirror/ src/ui/chat/ src/ui/workspace/ui/Workspace.tsx
git commit -m "feat(ui): show an ephemeral chat notice when the preview host halts"
```

---

### Task 8: Regression test, architecture docs, and the Reatom audit

**Files:**
- Test: `src/entrypoint/model/smoke.test.ts`
- Modify: `docs/architecture/flows/interactive-prototype.md`, `docs/architecture/modules.md`

- [ ] **Step 1: Write the end-to-end regression test**

Add to `src/entrypoint/model/smoke.test.ts` — the test for the reported defect:

```ts
test("a page that throws while rendering reaches the UI as a halted preview, not an endless 'preparing preview…'", async () => {
  const app = await createSmokeApp({ page: PAGE_THAT_THROWS_ON_RENDER });
  await app.openProject();
  await app.waitForPreviewCircuitOpen();

  const frame = app.frame();
  expect(frame).toContain("preview host · halted");
  expect(frame).not.toContain("preparing preview…");
});
```

Build it from the file's own existing smoke harness (`:319`, `:438` show its `kernel.events`
subscription shape). If the harness cannot yet mount a deliberately-throwing page, add that
fixture as part of this step rather than weakening the assertion.

- [ ] **Step 2: Run it to verify it passes**

Run: `bun test src/entrypoint/`
Expected: PASS.

- [ ] **Step 3: Update the architecture docs**

`docs/architecture/flows/interactive-prototype.md` and `docs/architecture/modules.md` describe
the preview flow. Both must record the Kernel's new subscription to the supervisor's event
sink and the `circuitOpened → preview.circuitOpened` mapping. Update the Mermaid diagram in
the flow doc, and each doc's `Source anchors` list.

- [ ] **Step 4: Run the whole suite and the linters**

```bash
bun test
rtk npm run lint
rtk npm run fmt:check
```
Expected: all pass.

- [ ] **Step 5: Run the Reatom audit**

Run `/reatom-audit`. `intent.ts`, `mirror.ts` and the new atoms are all Reatom code, so this
is required before reporting the work done. Fix anything it reports.

- [ ] **Step 6: Commit**

```bash
git add src/entrypoint/model/smoke.test.ts docs/architecture/
git commit -m "test: cover the halted-preview regression; sync architecture docs"
```

---

## Self-review notes

**Spec coverage.** §3.2 → Task 1. §3.3 → Task 2. §3.4's panel → Task 5, action/handler → Task 4,
status bar and attach → Task 6, chat lines → Task 7, prompt builder → Task 3. §4 → Task 3.
§5 needs no code. §6's edge cases are covered by tests in Tasks 2, 4, 5, 6, 7. §7 → all tasks.
§8 → Task 8.

**Known softness, deliberate.** Tasks 1, 2, 4, 6, 7 tell the implementer to reuse each test
file's existing harness rather than inventing helper names, because those harnesses were not
read line by line while writing this plan. Every production code block is complete; the test
scaffolding names (`createHarness`, `createDeps`, `renderWorkspaceWith`, `createSmokeApp`)
must be reconciled against the real files. That reconciliation is part of each task's first
step, not a follow-up.
