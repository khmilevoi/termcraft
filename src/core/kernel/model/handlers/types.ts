import type { KernelStateSnapshot } from "core/capabilities";
import type {
  CommitAction,
  CommitState,
  ExportAction,
  ExportState,
  MigrationAction,
  MigrationState,
  PreviewAction,
  PreviewState,
  ProjectAction,
  ProjectState,
  RestoreAction,
  RestoreState,
  StateMachine,
  TurnAction,
  TurnState,
} from "core/machines";
import type { HandlerOutcome, PublishableEventV1 } from "core/mailbox";
import type { PreviewSession } from "core/ports";
import type { FrameTokenLedger, GeometryTokenLedger, PreviewSessionCommands } from "core/preview";
import type {
  CommandFamilyV1,
  CommandKindV1,
  CommandPayloadByKindV1,
  EventPayloadByKindV1,
  UUIDv7,
} from "core/protocol";

import type { KernelDeps } from "../../types";
// `core/project/index.ts` does not exist yet (kernel-assembly Task 10 owns creating it) — a
// deep import into `core/project/model/page-remove-plan` is the same documented stopgap
// `handlers/project.ts`'s own header already uses for `core/project/model/trust.ts`/
// `orphan-turn-scan.ts`/`descriptors.ts`: once Task 10 lands a public entry, this import
// should move there.
import type { PageRemovePlanLedger } from "core/project/model/page-remove-plan";

/**
 * Kernel-assembly WP-1 task 9, STEP A — the shared skeleton every per-family handler
 * module (Step B) is built against. This file is deliberately the ONLY thing a family
 * implementer needs to read beyond their own family's command list: the `HandlerContext`
 * they receive, the function shape their family module must export, and the helpers that
 * make a malformed `HandlerOutcome` impossible to construct.
 *
 * Everything here is derived FROM `core/kernel/model/kernel.ts`'s real internals (read
 * that file's own comments for the "why" behind each piece):
 * - `deps: KernelDeps` — the exact port surface `createKernel` was given (§7's ports).
 * - `machines: KernelMachines` — the same seven `StateMachine` objects `kernel.ts` holds
 *   in its own closure, so a handler drives a machine the SAME way `kernel.ts` reads its
 *   phase (`machine.apply(action)` / `machine.phase()` / `machine.canApply(action)`),
 *   never a second, parallel way to move the same state. Each machine is typed as
 *   {@link HandlerMachine}, a `Pick` that deliberately drops `phaseAtom` — the directly
 *   settable atom is not part of the type a handler can reach, so `apply()`'s
 *   transition-table legality check cannot be bypassed by a stray `.set(...)`.
 * - `readKernelState` — `kernel.ts`'s own `readKernelState`, unchanged: the guard already
 *   ran this before a handler is ever reached, but §10.2's own line ("Payload-only
 *   content/schema, freshness, token-ledger, and operation-specific mutex checks run
 *   AFTER the guard") means a handler legitimately needs a fresh read too, e.g. to decide
 *   which branch of its own operation-specific logic applies.
 * - the five named mutators — four cover the Kernel-held facts `KernelStateSnapshot` needs
 *   beyond the seven bare phases (`kernel.ts`'s own comment names them: `project.trust`,
 *   `turn.activeTurnId`, `turn.commitIntentRecorded`, `preview.sourceKind`); the fifth,
 *   `setActivePreviewSession`, covers the one piece of Kernel-held state that is NOT part
 *   of `KernelStateSnapshot` at all — `kernel.ts`'s own `activePreview` closure variable
 *   (see {@link HandlerContext}'s own comment on it). Those five are the ONLY fields a
 *   handler may ever change outside a machine's own `apply()` — one named mutator per
 *   field, deliberately, NOT a blanket `setState(patch)`: a reviewer reading this
 *   interface sees the Kernel's ENTIRE non-machine mutation surface in five lines, not an
 *   open-ended patch shape a handler could use to touch a fact it has no business touching
 *   (e.g. nothing here lets a `chat.*` handler reach into `preview.sourceKind`).
 * - `launchOperation` — the ONE way a handler may start async work (`runTurn`, the export
 *   capture/render/package/publish chain, `core/project`'s open-sequence,
 *   `hostSupervisor.preview`) and have its TERMINAL events reach subscribers once that
 *   work settles. See {@link HandlerContext}'s own comment on it for why this is declared
 *   now (Step A) even though no handler calls it yet (Step B/C do).
 *
 * `context.deps.clock` is the injected `Clock` (kernel-assembly plan's Task 7) — there is
 * no separate `clock` field on `HandlerContext` itself; it already lives on `KernelDeps`,
 * and duplicating it here would just be a second name for the same value.
 */

// --- The seven machines, grouped ---------------------------------------------------------

/**
 * The view of a `StateMachine` a handler is given — `phase`/`apply`/`canApply` only, NEVER
 * `phaseAtom`. `StateMachine` (`core/machines`) exposes `phaseAtom` as a directly settable
 * `Atom` because `state-machine.ts`'s own `apply()` needs `phaseAtom.set(edge.to)`
 * internally (`state-machine.ts:98`) — but that is an implementation detail of the factory,
 * not something a family handler may ever touch. `context.machines.<domain>.phaseAtom.set(...)`
 * would move a machine's phase WITHOUT going through `apply()`'s transition-table legality
 * check — exactly the "stray `.set(...)`" bypass `HandlerContext`'s own doc comment below
 * promises does not exist. Picking only the read/legal-transition members here is what makes
 * that promise true at the type level: a handler typed against `HandlerContext` cannot even
 * NAME `context.machines.<domain>.phaseAtom`, let alone call `.set()` on it, without first
 * writing a separate, independently-flagged unsafe cast (itself forbidden project-wide).
 */
export type HandlerMachine<Phase extends string, Action extends string> = Pick<
  StateMachine<Phase, Action>,
  "phase" | "apply" | "canApply"
>;

/**
 * The same seven `StateMachine` objects `kernel.ts`'s own `createKernel` constructs and
 * holds (`reatom*StateMachine()`, one call per domain) — injected here, never rebuilt, so
 * a handler's `apply()` call lands on the EXACT atom `readKernelState`/the capability
 * guard/the projector all observe. Typed as {@link HandlerMachine}, not the full
 * `StateMachine`, so `phaseAtom` is excluded from the surface a handler can reach (see that
 * type's own comment). `chat`/`model`/`page`/`selection`/`pin`/`history` have no machine of
 * their own among the seven (`core/capabilities/model/guards.ts`'s own `familySpecificReason`
 * header note) — their handlers only ever touch `context.deps`.
 */
export interface KernelMachines {
  readonly project: HandlerMachine<ProjectState, ProjectAction>;
  readonly turn: HandlerMachine<TurnState, TurnAction>;
  readonly restore: HandlerMachine<RestoreState, RestoreAction>;
  readonly commit: HandlerMachine<CommitState, CommitAction>;
  readonly export: HandlerMachine<ExportState, ExportAction>;
  readonly preview: HandlerMachine<PreviewState, PreviewAction>;
  readonly migration: HandlerMachine<MigrationState, MigrationAction>;
}

/** `KernelStateSnapshot["project"]["trust"]` by another name — never re-declared as a fresh literal union. */
export type ProjectTrustV1 = KernelStateSnapshot["project"]["trust"];

/** `KernelStateSnapshot["preview"]["sourceKind"]` by another name — see {@link ProjectTrustV1}. */
export type PreviewSourceKindV1 = KernelStateSnapshot["preview"]["sourceKind"];

// --- The turn family's own extra surface (Step C1) ----------------------------------------

/**
 * Everything ONLY `turn.start`/`turn.cancel` need beyond the ordinary `KernelMachines.turn`
 * (`HandlerMachine`, `phaseAtom` excluded) and the five ordinary mutators — grouped under
 * one namespaced field on {@link HandlerContext} (`turnRunner`) rather than flattened, so a
 * reviewer checking "what can ANY handler touch" sees these named together as ONE
 * clearly-scoped exception, not lost among the ordinary surface. Closes Gap 1 of the `turn`
 * family's own two reported gaps in full
 * (`.superpowers/sdd/task9-family-turn-report.md`) — see this file's own report appendix
 * ("Step C1") for that investigation and the option chosen.
 *
 * **Gap 2, Step C2 UPDATE (`.superpowers/sdd/task-9-report.md`, "Step C2 turn"):**
 * `setActiveAttempt`/`activeAttempt` are now typed against {@link TurnCancelHandle}, a
 * NARROWER, right-sized replacement for `core/turns`'s own `TurnAttemptHandle` — see that
 * type's own doc comment for why. `turn.cancel` (`./turn.ts`) is a real, legitimate
 * CONSUMER of `activeAttempt` today (Gap 2's own "genuinely stop a running attempt"
 * requirement is fully implemented and tested against a fake handle). What remains open is
 * a DIFFERENT, later-discovered gap — call it Gap 3 — blocking `turn.start` itself from ever
 * being the caller that POPULATES this slot with a real handle: composing `runTurn` end to
 * end needs `RunTurnInputV1.buildValidationInput`/`buildFinalizeInput` to read the frozen
 * candidate's own file CONTENT (Gate's `manifestText`/page `source`, and finalize's changed
 * page bytes), and `core/ports/staging.ts`'s `StagingService` exposes only hash/size
 * metadata for candidate files (`CandidatePageSetV1.files: StagedFileV1[]`), never a method
 * to read one back. That is a `core/ports` gap, outside this contract's (`core/kernel`)
 * file scope — see `./turn.ts`'s own header for the full citation and options. So
 * `turn.start` stays the documented no-op it already was; `turn.cancel`'s own correctness
 * does not depend on it (proven with a directly-injected fake handle, matching how this
 * slot's storage was proven correct before any real caller existed).
 */
export interface TurnRunnerContext {
  /**
   * The SAME real `StateMachine<TurnState, TurnAction>` object `kernel.ts` already holds
   * (never a second instance, never a cast) — exposed here FULL (`phaseAtom` included)
   * because `core/turns`'s six composed functions (`RunTurnDeps.machine`, and each of the
   * six functions' own `Deps.machine`) all require the full type structurally, even though
   * NONE of them ever actually reads or writes `phaseAtom` (verified: every call site only
   * ever uses `.apply()`/`.phase()`/`.canApply()`). Narrowing `core/turns`'s own six `Deps`
   * fields instead would touch a landed module outside this task's file scope; widening
   * `KernelMachines.turn` for every family would reopen the `phaseAtom` escape hatch Step
   * A's fix round 1 deliberately closed. This field is the surgical alternative named as
   * option 3 in the turn family's own report: ONLY `turn.start`'s `launchOperation` closure
   * (composing `runTurn`) may ever read it. Every other turn-touching handler — including
   * `turn.cancel` for every phase except a currently-attempting one — must still go through
   * `context.machines.turn`.
   */
  readonly machine: StateMachine<TurnState, TurnAction>;
  /**
   * Registers (or clears, with `null`) a live {@link TurnCancelHandle} for the ONE turn
   * `kernel.ts`'s own `activeTurnIdAtom` currently names — there is at most one live attempt
   * at a time (`turn.start`'s own admission guard, `TURN_ALREADY_ACTIVE`), so this is a
   * single kernel-held slot, not a map.
   *
   * **Step C2 update:** the ONLY thing that could ever legitimately call this with a
   * non-null handle is `turn.start`'s own `launchOperation` closure, wrapping
   * `RunTurnDeps.agentBackend` so its `startTurn` call captures the live `AgentRun` per
   * attempt (see `./turn.ts`'s own header for the exact recipe: no `core/turns` file needs
   * to change for this — the wrapping happens entirely on this side of the boundary, at
   * the ONE place `turn.start` already builds `RunTurnDeps` from `HandlerContext`). That
   * caller does not exist in THIS Kernel build yet: `turn.start` itself is blocked by a
   * different, `core/ports`-level gap (Gap 3 — see `./turn.ts`'s header), so this slot
   * reads back `null` forever until that closes. The STORAGE and its one real CONSUMER
   * (`turn.cancel`, `./turn.ts`) are both real and tested today (against a
   * directly-injected fake handle) — only the PRODUCER side is still missing.
   */
  readonly setActiveAttempt: (handle: TurnCancelHandle | null) => void;
  /**
   * Returns the CURRENTLY registered attempt handle, but ONLY when `turnId` still names the
   * turn `kernel.ts`'s own `activeTurnIdAtom` reports active — never a stale handle left over
   * from an already-settled turn. `turn.cancel`'s handler (`./turn.ts`) is the one real
   * caller: `null` here means either no attempt is currently in flight (every cancelable
   * phase except `"running"` has none — `context.machines.turn.apply("requestCancel")` is
   * the correct, complete action for those, and `turn.cancel` always applies it first,
   * uniformly, before ever consulting this method) or `turnId` no longer matches (defensive
   * only — `checkRevisionGuard`'s own `turn.cancel` rule 1 already makes this unreachable in
   * a correctly-wired Kernel). A non-null return means a live `AgentBackend` run is (or,
   * once Gap 3 closes, will be) in flight, and its own `handle.requestCancel()` traces
   * straight to the real backend cancel — never a fabricated second transition (see
   * {@link TurnCancelHandle}'s own doc comment). **Until `turn.start` itself can populate
   * this slot (Gap 3, `./turn.ts`'s header), this method can only ever return `null`** in
   * the real, wired Kernel — but that is a statement about who calls `setActiveAttempt`
   * today, not about whether this method or its one consumer are correct: `turn.cancel`'s
   * own handling of a non-null return is written and tested against a fake handle.
   */
  readonly activeAttempt: (turnId: UUIDv7) => TurnCancelHandle | null;
}

/**
 * The one capability `turn.cancel` (or anything else reading {@link TurnRunnerContext
 * .activeAttempt}) ever needs from a currently live `AgentBackend` run — deliberately
 * NARROWER than `core/turns`'s own `TurnAttemptHandle` (`{outcome, requestCancel}`,
 * `core/turns/model/attempt.ts`), which this slot used to be typed against.
 *
 * **Why narrower, not the real `TurnAttemptHandle` (Step C2, correcting C1 fix round 2's
 * finding rather than perpetuating it):** `TurnAttemptHandle.outcome` is a
 * `Promise<TurnAttemptOutcomeV1>` `attempt.ts` builds by converting the raw
 * `AgentRunOutcome` its own private `toAttemptOutcome` (unexported) produces — nothing
 * outside `attempt.ts` can construct a REAL one, and nothing that reads this slot
 * (`turn.cancel`) has ever needed to read `.outcome` at all — `runTurn`'s own loop already
 * awaits the attempt's outcome itself (`run-turn.ts`'s `started.handle.outcome`), so a
 * SECOND consumer reading the same promise a second time would only ever be redundant.
 * Keeping the wider type around, when nothing can honestly satisfy it and nothing needs it,
 * is exactly the kind of unused-but-misleading surface `C1 fix round 2` already flagged
 * once for `setActiveAttempt`'s own doc comment — this narrows the TYPE instead of merely
 * re-flagging the same gap in prose a second time.
 */
export interface TurnCancelHandle {
  /**
   * Requests cancellation of the live run this handle was registered for. A real
   * implementation traces straight to `core/turns/model/attempt.ts`'s own
   * `AgentBackend.cancel(run)` (see `./turn.ts`'s header for the exact wrapping recipe that
   * would build one) — never just a machine-phase flip; that is the whole reason Gap 2
   * exists (`.superpowers/sdd/task9-family-turn-report.md`).
   */
  readonly requestCancel: () => Promise<void>;
}

// --- The selection surface (Step C1) -------------------------------------------------------

/** `EventPayloadByKindV1["selection.changed"]`'s non-null member, by another name — matches `selection-model.ts`'s own local `SelectionDtoV1` alias, declared independently here so `types.ts` never imports FROM a family module. */
export type SelectionSnapshotV1 = NonNullable<EventPayloadByKindV1["selection.changed"]>;

// --- The handler context -----------------------------------------------------------------

/**
 * Everything a command handler is given. Every family module (Step B) and the Tier-C
 * deferred handler (this step) share this ONE shape — no family gets a bespoke context.
 *
 * The five mutators are the WHOLE Kernel-held, non-machine mutation surface:
 * - `setProjectTrust` — `project.setTrust` (and `project.create`'s creation-defaults
 *   trust) is the only legitimate caller; `kernel.ts`'s `trustAtom`.
 * - `setActiveTurnId` — `turn.start`'s admission (recording the fresh turn id) and its
 *   terminal outcomes (clearing it back to `null`) are the only legitimate callers;
 *   `kernel.ts`'s `activeTurnIdAtom`.
 * - `setCommitIntentRecorded` — the turn finalize/terminalize path that records or clears
 *   durable commit intent (§7.2's `finalizing` pre/post-intent split); `kernel.ts`'s
 *   `commitIntentRecordedAtom`.
 * - `setPreviewSourceKind` — `preview.selectPage`/`selectHistorical`/`selectCurrent` are
 *   the only legitimate callers; `kernel.ts`'s `previewSourceKindAtom`.
 * - `setActivePreviewSession` — `kernel.ts`'s own `activePreview` closure variable (its
 *   `currentPreview()` accessor already reads it; today's `close()` is the only writer,
 *   setting it `null`). NOT part of `KernelStateSnapshot`/`readKernelState` — a live
 *   `PreviewSession` is a host-facing handle (frames iterable, `resize`/`setMode`/...
 *   methods), never a DTO fact the seven machines' phases describe — so it gets its own
 *   mutator rather than being folded into `setPreviewSourceKind` (which only ever carries
 *   the closed `"current" | "historical" | null` DTO fact, §10.2). Once Step B's preview
 *   family lands: `preview.selectPage`/`selectHistorical`/`selectCurrent` are the only
 *   legitimate callers that ESTABLISH a session (via `deps.hostSupervisor.preview(...)`,
 *   `core/ports`), `preview.close` is the only legitimate caller that clears one (`null`,
 *   mirroring `kernel.ts`'s own `close()`), and `preview.retry` is the only legitimate
 *   caller that REPLACES a failed one in place. No other family may call this.
 *
 * `launchOperation` is the ONE way a handler may start async work and have its outcome
 * reach subscribers once it settles — declared now (Step A) so Step B's five async
 * families (`turn.start` composing `runTurn`; `export.start` composing the capture/
 * render/package/publish chain; `project.open`/`project.create` composing
 * `core/project`'s open-sequence; the preview family's `hostSupervisor.preview` call)
 * share ONE pattern instead of each inventing its own async-completion plumbing:
 *
 * ```ts
 * readonly launchOperation: (
 *   label: string,
 *   run: () => Promise<readonly PublishableEventV1[]>,
 * ) => void;
 * ```
 *
 * A handler that starts async work still returns synchronously, exactly like every other
 * handler — `startedOutcome(admissionEvents, operationId)` for whatever ADMISSION events
 * fire immediately (e.g. `turn.started`), then calls `context.launchOperation(label, run)`
 * once, in the same synchronous call, to kick the async chain off. `label` is a
 * Reatom-style trace name (this project's "name every atom, computed, action" rule,
 * `kernel.ts`'s own `"kernel.project.trust"`/`"mailbox.publishTransition"` style) — e.g.
 * `"kernel.turn.run"` — NOT the `operationId`; correlating a specific run's terminal
 * events back to the command that started it is `run`'s own job, via each event's
 * `correlation.operationId` (`core/mailbox`'s `EventCorrelationV1`, already carries
 * `operationId`), not a second identifier `launchOperation` invents. `run` itself must
 * NEVER reject: whatever the async composition decides — success or failure — it
 * converts to the operation's TERMINAL events itself (see {@link CommandHandler}'s own
 * doc comment on why a ran-and-failed operation still publishes events, never a bare
 * rejection) and resolves with them; Step C's implementation is a defensive backstop for
 * an unexpected throw anyway (matching `core/mailbox/model/dispatch.ts`'s own handling of
 * a misbehaving 6C dependency), never the primary contract.
 *
 * Step C's own implementation (not this step) is expected to: build one `launchOperation`
 * closure per `createKernel` call, `wrap`-capture it against the SAME Reatom frame
 * `kernel.ts` already builds everything else in (matching its own "wrap/bind captured
 * once at construction" discipline), call `run()`, and — once it resolves — publish the
 * returned events through the SAME `EventBus.publishTransition` `dispatch.ts` itself
 * calls, so a terminal async event advances `stateRevision`/`eventSeq` through the exact
 * one mechanism every other event already does, never a second, parallel publish path.
 *
 * No handler may reach a machine's `phaseAtom`, any of the five facts above, or start
 * async work through any other route — this interface IS the whole surface, so a
 * reviewer checking "what can a handler change or launch?" only has to read this
 * interface's members, never grep the whole `handlers/` tree for a stray `.set(...)` or a
 * fire-and-forget async call. This is enforced by the type, not just by this comment:
 * `KernelMachines`'s per-machine type is {@link HandlerMachine}, a `Pick` that omits
 * `phaseAtom` entirely, so `context.machines.<domain>.phaseAtom` does not type-check —
 * see that type's own comment.
 *
 * STEP C1 ADDITIONS — closing the contract gaps two family investigations proved (see
 * this file's own report appendix, "## Step C1", for the full writeup):
 * - `turnRunner` ({@link TurnRunnerContext}) — the turn family's own extra surface
 *   (Gap 1 of `.superpowers/sdd/task9-family-turn-report.md`, closed in full; Gap 2 now
 *   FULLY implemented and consumed by `turn.cancel` (Step C2, `./turn.ts`) against a
 *   right-sized {@link TurnCancelHandle} — see that type's own doc comment. What remains
 *   open is a DIFFERENT gap (Step C2's own "Gap 3") blocking `turn.start` from ever being
 *   the caller that populates this slot; `./turn.ts`'s header has the full citation).
 * - `setSelection`/`selection` — the Kernel-held "current selection" fact
 *   `.superpowers/sdd/task9-family-selection-model-report.md`'s gap 1 confirmed missing;
 *   mirrors `setActivePreviewSession`'s own "not part of `KernelStateSnapshot`, a plain
 *   Kernel-held closure fact instead" precedent, since no capability guard ever reads
 *   "the current selection" either.
 * - `currentPreviewSession` — the paired getter `setActivePreviewSession` always lacked
 *   (`.superpowers/sdd/task9-family-preview-export-report.md`'s Gap A).
 * - `previewSessionCommands`/`frameTokenLedger`/`geometryTokenLedger` — `core/preview`'s
 *   already-landed session-commands router, composed once with its real collaborators
 *   (same report's Gap A, the `SessionCommandsDeps` sub-primitives), plus the two token
 *   ledgers the `pin`/`page` family's own report (`task9-family-page-pin-report.md`, gap 2)
 *   needs shared between the not-yet-built `preview`/`pin` follow-up work.
 * - `pageRemovePlanLedger` — the per-Kernel `PageRemovePlanLedger`
 *   (`task9-family-page-pin-report.md`, gap 1) every `page.*` command in that family needs.
 */
export interface HandlerContext {
  readonly deps: KernelDeps;
  readonly machines: KernelMachines;
  /** `kernel.ts`'s own `readKernelState`, re-exposed verbatim — always a fresh read, never cached. */
  readonly readKernelState: () => KernelStateSnapshot;
  readonly setProjectTrust: (trust: ProjectTrustV1) => void;
  readonly setActiveTurnId: (turnId: UUIDv7 | null) => void;
  readonly setCommitIntentRecorded: (recorded: boolean) => void;
  readonly setPreviewSourceKind: (sourceKind: PreviewSourceKindV1) => void;
  /** `kernel.ts`'s own `activePreview` — see this interface's own comment above. */
  readonly setActivePreviewSession: (session: PreviewSession | null) => void;
  /** The one sanctioned async-launch primitive — see this interface's own comment above. */
  readonly launchOperation: (
    label: string,
    run: () => Promise<readonly PublishableEventV1[]>,
  ) => void;
  /**
   * The live-publish primitive (Step C3) — publishes `event` NOW, mid-operation, sharing
   * `launchOperation`'s own revision/publish semantics (`core/kernel/model/
   * operation-publish.ts`'s `publishOperationEvents`) but callable ANY NUMBER of times over
   * one launched operation's lifetime, not just once at settlement. Exists so a `run`
   * closure composing `core/turns`'s `runTurn` can stream `turn.attemptStarted`/
   * `turn.progress`/`turn.gateRejected` events DURING the run
   * (`RunTurnDeps.publish`, `core/turns/model/run-turn.ts:233`/`:314`) instead of only
   * batching them into `launchOperation`'s own terminal array. A plain synchronous
   * function — the CALLER is responsible for its own `wrap()` at whatever async boundary it
   * crosses before calling this, matching the five ordinary mutators' same division of
   * responsibility.
   */
  readonly publishOperationEvent: (event: PublishableEventV1) => void;
  /** The turn family's own extra surface (Step C1) — see {@link TurnRunnerContext}'s own comment. */
  readonly turnRunner: TurnRunnerContext;
  /** The Kernel-held "current selection" fact (Step C1) — see this interface's own comment above. */
  readonly setSelection: (selection: SelectionSnapshotV1 | null) => void;
  readonly selection: () => SelectionSnapshotV1 | null;
  /** The paired getter for `setActivePreviewSession` (Step C1) — `kernel.ts`'s own `activePreview`, read back. */
  readonly currentPreviewSession: () => PreviewSession | null;
  /**
   * `core/preview`'s already-landed command router (Step C1), composed ONCE inside
   * `kernel.ts` — never rebuilt per call (`createPreviewSessionCommands`'s own factory doc:
   * "two kernels — or two tests — must never share live-session state") — over the REAL
   * `PreviewState` machine plus its four collaborators (`frameBroker`/`frameTokenLedger`/
   * `geometryTokenLedger`/`backpressure`). NOT yet called by any currently-wired handler
   * (`preview-export.ts` still drives `context.machines.preview`/`setActivePreviewSession`
   * directly for its two implemented kinds) — exposed here so a follow-up revision of that
   * family can adopt it for the five kinds Gap A blocks, without this task inventing
   * behavior for a family module it does not own.
   */
  readonly previewSessionCommands: PreviewSessionCommands;
  /** The SAME `FrameTokenLedger` instance `previewSessionCommands` holds internally — shared, Kernel-held, cross-family state (Step C1) for the not-yet-built `pin.create` to consume/restore. */
  readonly frameTokenLedger: FrameTokenLedger;
  /** The SAME `GeometryTokenLedger` instance `previewSessionCommands` holds internally — see {@link frameTokenLedger}'s own comment. */
  readonly geometryTokenLedger: GeometryTokenLedger;
  /** The per-Kernel `PageRemovePlanLedger` (Step C1) — see this interface's own comment above. */
  readonly pageRemovePlanLedger: PageRemovePlanLedger;
}

// --- The well-formed outcome, made hard to get wrong ---------------------------------------

/**
 * The value every command handler returns — `HandlerOutcome` (`core/mailbox`) by another
 * name, kept as a local alias so this file's own doc comments have one name to point at.
 *
 * "Design so families cannot produce a malformed outcome" (Task 9 brief) is enforced here
 * by SHAPE, not by a branded/opaque type: a branded type can only ever be constructed by
 * bouncing an object literal through `unknown` first (TypeScript refuses a direct `as` when
 * the brand's property is entirely absent from the literal), and this project's own rule
 * is NO `unknown`/`any`-bounce cast, ever — inventing one just to brand this type would be
 * exactly the "type-laundering" the rule forbids. Instead, `noOpOutcome`/`completedOutcome`/
 * `startedOutcome` below are the only THREE outcome shapes `HandlerOutcome` actually has
 * (§8.3's three dispositions), each hard-coded to the one valid `{disposition, events}`
 * pairing for it — `noOpOutcome` does not even accept an `events` parameter, so the one
 * malformed shape `dispatch.ts`'s own `applyTransition` already defends against
 * ("no-op" with non-empty `events`) is simply not expressible by calling it. A family
 * author CAN still hand-write a raw object literal instead of calling these — nothing in
 * the type system forbids that, matching how `HandlerOutcome`'s own doc comment already
 * documents dispatch trusting (and defensively logging, never silently dropping, a
 * violation of) whatever a handler returns — but every family module Step A/B ships uses
 * only these three constructors, so a reviewer checking "did this handler build a valid
 * outcome?" only has to confirm it called one of them.
 */
export type CommandOutcomeV1 = HandlerOutcome;

/** The revision-neutral no-op every Tier-C/not-yet-implemented handler (and some real ones) returns. */
export function noOpOutcome(): CommandOutcomeV1 {
  return { disposition: "no-op", events: [] };
}

/** A completed, revision-advancing outcome — `events` publish, `operationId` is set only when supplied. */
export function completedOutcome(
  events: readonly PublishableEventV1[],
  operationId?: UUIDv7,
): CommandOutcomeV1 {
  const base = { disposition: "completed" as const, events };
  return operationId === undefined ? base : { ...base, operationId };
}

/** A started (async work kicked off), revision-advancing outcome — same shape rules as {@link completedOutcome}. */
export function startedOutcome(
  events: readonly PublishableEventV1[],
  operationId?: UUIDv7,
): CommandOutcomeV1 {
  const base = { disposition: "started" as const, events };
  return operationId === undefined ? base : { ...base, operationId };
}

// --- The per-kind handler function, and the maps families export --------------------------

/**
 * One command kind's handler: the already-decoded, already-guard-checked payload in, a
 * {@link CommandOutcomeV1} out. Never a REJECTION — by the time `dispatch.ts` calls a
 * handler, `core/capabilities`'s guard has already run (§12.1 step 3) and returned
 * `available` — and `HandlerOutcome` (`core/mailbox`) has no rejected disposition of its
 * own (see that type's own doc comment). But "the guard already said yes" does not mean a
 * handler always has something to do, or that what it does always succeeds — §10.2's own
 * line ("Payload-only content/schema, freshness, token-ledger, and operation-specific
 * mutex checks run AFTER the guard") means a handler has exactly TWO outcomes to choose
 * between, never a third "failed" shape of its own:
 *
 * - An IDEMPOTENT REFUSAL — the handler itself finds a payload-only reason not to act (a
 *   stale freshness token, a mutex already held, a repeat of an already-applied intent)
 *   and returns {@link noOpOutcome}. Nothing ran: no machine transitioned, no Kernel-held
 *   fact changed, no event fires — the exact same shape a Tier-C deferred kind's backstop
 *   returns (`./deferred.ts`'s `rejectDeferred`).
 * - RAN AND FAILED — the handler (directly, or via {@link HandlerContext.launchOperation}'s
 *   async chain) DID act — called a machine's `apply()`, changed a Kernel-held fact, or ran
 *   an operation through to its terminal state — and that action's OWN result was a
 *   failure (e.g. a turn's workspace failed to provision, an export's publish step
 *   rejected). This is STILL `"completed"`/`"started"`, never `"no-op"`: something
 *   happened, so the revision advances and a domain event publishes exactly like a
 *   success would (`dispatch.ts`'s `applyTransition` ties `"no-op"` to no transition at
 *   all; `core/mailbox`'s own §9 ties every domain event to something that DID happen).
 *   The failure is carried entirely BY the published event's own payload (a
 *   `*.failed`-shaped DTO, not a distinct disposition and never a bare exception) —
 *   {@link HandlerContext.launchOperation}'s own doc comment says the same thing about the
 *   async chain it launches: `run` must never reject, it converts success OR failure into
 *   terminal events itself.
 *
 * Collapsing a ran-and-failed operation into a `"no-op"` just because nothing the user
 * asked for ultimately happened would be wrong: the machine DID transition (e.g.
 * `running` → `failed`), and publishing that transition is the whole point — a caller
 * watching `events` needs to see it, which a `"no-op"`'s always-empty `events` array
 * cannot carry (see {@link noOpOutcome}'s own doc comment). Choosing between these two
 * shapes is the ONE place this distinction is made — nothing downstream (dispatch, the
 * event bus) can recover "did it really run?" from `disposition` alone without also
 * inspecting `events`.
 */
export type CommandHandler<K extends CommandKindV1 = CommandKindV1> = (
  payload: CommandPayloadByKindV1[K],
  context: HandlerContext,
) => CommandOutcomeV1;

/** A handler map over an arbitrary, explicit subset of `CommandKindV1` — e.g. the Tier-C deferred set, which spans four families and only PART of `preview`. */
export type CommandHandlerMap<K extends CommandKindV1> = Readonly<{
  [P in K]: CommandHandler<P>;
}>;

/** Every `CommandKindV1` member whose dot-prefix is `F` — the precise per-family kind subset. */
export type CommandKindOfFamily<F extends CommandFamilyV1> = Extract<
  CommandKindV1,
  `${F}.${string}`
>;

/**
 * The 10 Tier-C deferred kinds — `4 restore.* + 3 commit.* + history.open + 2 preview.*`
 * (`restore.plan/confirm/discardPlan/retryRecord`, `commit.plan/confirm/discardPlan`,
 * `history.open`, `preview.forwardInput`, `preview.setTweak`) — declared here, not in
 * `./deferred.ts`, purely so {@link FamilyHandlerMap} below can `Exclude` them without
 * `types.ts` importing FROM `./deferred.ts` (that file already imports `CommandHandlerMap`/
 * `noOpOutcome` from here; the reverse direction would make the two files circularly
 * dependent). `./deferred.ts` imports this exact type and re-exports it unchanged, so
 * `import { type DeferredHandlerKind } from "./deferred"` (`./index.ts`'s existing call
 * site) keeps resolving to the same type — `types.ts` is just its one declaration site now,
 * shared with `FamilyHandlerMap`'s own use below. See `./deferred.ts`'s own header comment
 * for the full "why exactly these 10, why not `migration.*`" investigation.
 */
export type DeferredHandlerKind =
  | "restore.plan"
  | "restore.confirm"
  | "restore.discardPlan"
  | "restore.retryRecord"
  | "commit.plan"
  | "commit.confirm"
  | "commit.discardPlan"
  | "history.open"
  | "preview.forwardInput"
  | "preview.setTweak";

/**
 * The shape EVERY per-family module (Step B) exports: a `Readonly` map from its own
 * family's `CommandKindV1` members to their handlers — MINUS whichever of those members
 * are already Tier-C deferred ({@link DeferredHandlerKind}, owned by `./deferred.ts`'s
 * `deferredHandlers`, never by a family module). For most families `CommandKindOfFamily<F>`
 * and `DeferredHandlerKind` don't overlap at all, so the `Exclude` is a no-op and
 * `FamilyHandlerMap<F>` is exactly what it looks like it should be.
 *
 * `"preview"` is the one family where it DOES overlap: `CommandKindOfFamily<"preview">` has
 * 11 members, 2 of which (`preview.forwardInput`, `preview.setTweak`) are Tier-C deferred —
 * so `FamilyHandlerMap<"preview">` is exactly the OTHER 9. A preview module typed against
 * it cannot even NAME the 2 deferred kinds in its own object literal (excess-property
 * checking on a literal assigned to this type rejects unknown keys), let alone accidentally
 * un-defer one by supplying a real handler for it — closing the "spread-order decides which
 * handler wins" trap that a wider `FamilyHandlerMap<"preview">` would otherwise leave open
 * at Step-B assembly (`{...deferredHandlers, ...previewFamily}`): with this narrower type
 * the two maps share zero keys, so there is nothing left for spread order to decide.
 *
 * `"restore"`/`"commit"`/`"history"` are the opposite extreme: EVERY one of their kinds is
 * Tier-C deferred, so `FamilyHandlerMap<"restore">` etc. resolve to the empty map —
 * correctly, since none of them has a Step-B family module (the task brief: "Tier-C
 * families (restore, commit, migration) ... get a single deferred-rejection handler
 * each"). `"migration"` has no member in `DeferredHandlerKind` at all (see `./deferred.ts`'s
 * header comment for why), so `FamilyHandlerMap<"migration">` is unaffected, still its full
 * 4-kind map — matching the task report's flagged not-yet-implemented (not Tier-C) status
 * for it.
 *
 * Nothing else about the shape changes — still no default export, no side effects, no
 * module-level mutable state (a family module is re-importable and re-usable across as
 * many `HandlerContext`s/tests as needed).
 */
export type FamilyHandlerMap<F extends CommandFamilyV1> = CommandHandlerMap<
  Exclude<CommandKindOfFamily<F>, DeferredHandlerKind>
>;

/** The complete, 43-kind map `createHandlerRegistry` (`./index.ts`) consumes. */
export type TotalHandlerMap = CommandHandlerMap<CommandKindV1>;
