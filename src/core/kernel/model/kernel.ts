import { atom, bind, context, wrap } from "@reatom/core";

import {
  type KernelStateSnapshot as CapabilityKernelStateSnapshot,
  type CapabilityRecord,
  diffCapabilities,
  evaluateCapabilityGuard,
  extractCapabilityTarget,
  projectCapabilities,
  projectCapability,
} from "core/capabilities";
import {
  type TurnState,
  reatomCommitStateMachine,
  reatomExportStateMachine,
  reatomMigrationStateMachine,
  reatomPreviewStateMachine,
  reatomProjectStateMachine,
  reatomRestoreStateMachine,
  reatomTurnStateMachine,
} from "core/machines";
import {
  type ActiveTurnCancelState,
  type EventBus,
  type EventBusPayloadError,
  type EventEnvelopeV1,
  type GuardRegistry,
  type HandlerRegistry,
  type PublishableEventV1,
  type TargetExtractor,
  type TurnCancelPhase,
  type TurnCancelProbe,
  createDedupeLedger,
  createDispatch,
  createEventBus,
} from "core/mailbox";
import type { PreviewSession } from "core/ports";
import {
  createFrameBroker,
  createFrameTokenLedger,
  createGeometryTokenLedger,
  createPreviewBackpressure,
  createPreviewSessionCommands,
} from "core/preview";
// `core/project/index.ts` does not exist yet (kernel-assembly Task 10) — the same
// documented deep-import stopgap `handlers/project.ts`'s own header already uses.
import { createPageRemovePlanLedger } from "core/project/model/page-remove-plan";
import type { CapabilityEntryV1, CommandKindV1, EventPayloadByKindV1, UUIDv7 } from "core/protocol";
import type { TurnAttemptHandle } from "core/turns";

import type { Kernel, KernelDeps } from "../types";
import { createKernelCounters } from "./counters";
import { createHandlerRegistry, totalHandlers } from "./handlers";
import type { HandlerContext, SelectionSnapshotV1 } from "./handlers/types";

/**
 * `createKernel` (kernel-assembly WP-1, task 8) — assembles the whole Kernel graph inside
 * ONE Reatom `context.start(...)` frame: the seven state machines, the Kernel-held facts
 * `readKernelState` layers on top of them, the capability target/guard adapters bound to
 * `core/capabilities`'s real functions, the full `kernel.snapshot` builder, the event bus,
 * the dedupe ledger, a MINIMAL handler registry (Task 9 replaces it), and the dispatch
 * pipeline. Every atom this module touches — the seven `phaseAtom`s plus the four
 * Kernel-held facts below — lives ONLY inside that one frame; every value the returned
 * `Kernel` exposes for use OUTSIDE this function's own call stack (`events`) is
 * `bind`-captured against that exact frame at construction time, matching the same
 * "wrap/bind captured once at construction" discipline `core/mailbox/model/dispatch.ts`
 * and `signal-ingress.ts` already use for their own externally-callable entry points.
 *
 * `dispatch` needs no such wrapping of its own: `createDispatch`'s two async continuations
 * are already `wrap`-captured inside `createDispatch` itself (built here, inside this same
 * frame), and `dispatch`'s synchronous prologue (decode, then the dedupe ledger's plain
 * `Map` lookup) never touches an atom directly — every atom read happens inside one of
 * those two already-wrapped continuations. `currentPreview`/`close` read/write only a
 * plain closure variable, never an atom, so they need no wrapping either.
 */
export function createKernel(deps: KernelDeps): Kernel {
  return context.start(() => {
    // Step 1: the two independent Kernel counters (`stateRevision`/`eventSeq`).
    const counters = createKernelCounters();

    // Step 2: the seven machines, held so their `phaseAtom`s feed `readKernelState` below.
    const projectMachine = reatomProjectStateMachine();
    const turnMachine = reatomTurnStateMachine();
    const restoreMachine = reatomRestoreStateMachine();
    const commitMachine = reatomCommitStateMachine();
    const exportMachine = reatomExportStateMachine();
    const previewMachine = reatomPreviewStateMachine();
    const migrationMachine = reatomMigrationStateMachine();

    // The four Kernel-held facts `KernelStateSnapshot` needs beyond the seven bare
    // phases (`capabilities/types.ts`'s own field comments name exactly these four).
    // Task 9 Step C1 wires the `project`/`preview` handlers that actually mutate
    // `trustAtom`/`previewSourceKindAtom` (`project.setTrust`, `preview.select*`); `turn`
    // stays on the not-yet-implemented stand-in (Step C2), so `activeTurnIdAtom`/
    // `commitIntentRecordedAtom` still never move in THIS Kernel build.
    const trustAtom = atom<"trusted" | "untrusted-read-only" | null>(null, "kernel.project.trust");
    const activeTurnIdAtom = atom<UUIDv7 | null>(null, "kernel.turn.activeTurnId");
    const commitIntentRecordedAtom = atom<boolean>(false, "kernel.turn.commitIntentRecorded");
    const previewSourceKindAtom = atom<"current" | "historical" | null>(
      null,
      "kernel.preview.sourceKind",
    );

    // The live preview session, if any — a plain closure reference, never an atom:
    // `PreviewSession` is an external host-facing object, not Kernel model state
    // `readKernelState` needs to see (only `preview.sourceKind`, above, is). Declared here,
    // ahead of `currentCapabilityRequests`/`close`, both of which read it.
    let activePreview: PreviewSession | null = null;
    let closed = false;

    // Step C1's Kernel-held "current selection" fact (closes the `selection`/`model`
    // family's own reported gap 1) and the single-slot turn-attempt registry storage the
    // `turn` family's own reported Gap 2 needs (storage only — see `handlers/types.ts`'s
    // own `TurnRunnerContext` comment for the still-open plumbing gap C1 fix round 2
    // found) — see `handlers/types.ts`'s own comments on `HandlerContext.selection`/
    // `turnRunner` for why each is a plain closure fact rather than part of
    // `KernelStateSnapshot`.
    let currentSelection: SelectionSnapshotV1 | null = null;
    let activeTurnAttempt: TurnAttemptHandle | null = null;

    // Step C1's capability-growth identity trackers: which `(id, target)` requests beyond
    // the nine null-target kinds are worth projecting right now, because their identity has
    // actually come into existence. Populated by inspecting the SAME events a transition
    // already publishes (`noteEventForCapabilityGrowth`, below `publishAndTrackCapabilities`)
    // — never a second, independent source of truth, and never touched by any handler
    // directly. See this file's own "## Step C1" report appendix for the full design.
    let growableActiveChatId: UUIDv7 | null = null;
    let growableActivePageSlug: string | null = null;
    let growableLivePreviewSessionId: UUIDv7 | null = null;

    // Step 3: `readKernelState` — the real value behind the mailbox seam's `unknown`
    // `KernelStateSnapshot`/`GuardTarget` aliases. Returning this concrete, narrower type
    // from a function whose seam-declared return type is `unknown` type-checks by plain
    // return-type covariance, no cast: see `../types.ts`'s own header note and the task
    // report's variance investigation.
    function readKernelState(): CapabilityKernelStateSnapshot {
      return {
        project: { phase: projectMachine.phase(), trust: trustAtom() },
        turn: {
          phase: turnMachine.phase(),
          activeTurnId: activeTurnIdAtom(),
          commitIntentRecorded: commitIntentRecordedAtom(),
        },
        restore: { phase: restoreMachine.phase() },
        commit: { phase: commitMachine.phase() },
        export: { phase: exportMachine.phase() },
        preview: { phase: previewMachine.phase(), sourceKind: previewSourceKindAtom() },
        migration: { phase: migrationMachine.phase() },
      };
    }

    // Step 3, continued: the turn-cancel probe `checkRevisionGuard` (inside `createDispatch`)
    // needs — the same "active turn, cancel-relevant phase" slice `revision-guard.ts`'s own
    // `TurnCancelProbe` seam is built for. Built from the SAME turn phase/held facts
    // `readKernelState` reads, never a second, independent source of truth.
    function activeTurnCancelState(): ActiveTurnCancelState | null {
      const phase = turnMachine.phase();
      if (!isTurnCancelPhase(phase)) return null;
      const turnId = activeTurnIdAtom();
      if (turnId === null) {
        // A non-idle, non-settled turn phase with no active turn id is a broken invariant
        // (every such phase implies an active turn) — logged per the errore rule against
        // silently swallowing an unexpected condition, not silently treated as "no turn".
        console.warn(`core/kernel: turn.phase is "${phase}" (cancelable) but activeTurnId is null`);
        return null;
      }
      return { turnId, phase, durableIntentRecorded: commitIntentRecordedAtom() };
    }

    const cancelProbe: TurnCancelProbe = { activeTurn: activeTurnCancelState };

    // Step 4: `extractTarget` adapts `extractCapabilityTarget`'s `Error | target` return
    // into the mailbox `TargetExtractor` shape, which has no error channel of its own
    // (`GuardTarget = unknown`, never `Error | unknown`). `decodeCommandEnvelope` (run by
    // `dispatch()` before this is ever reached) already validated `payload` against the
    // exact same per-kind schema `extractCapabilityTarget` re-validates internally, so this
    // throw is unreachable in a well-formed Kernel — but it IS reachable in principle
    // (a decode/extractor schema drifting apart), and `dispatch.ts`'s own `runFirstSeen`
    // already converts any throw from an injected seam (this one included) into a
    // well-formed `CAPABILITY_UNAVAILABLE` rejection, never letting it escape. That
    // documented conversion — not a return value this seam's own type cannot express — is
    // exactly how "a failed extraction dispatches as a rejection".
    const extractTarget: TargetExtractor = (kind, payload) => {
      const target = extractCapabilityTarget(kind, payload);
      if (target instanceof Error) throw target;
      return target;
    };

    // Step 5: `evaluateGuard` calls the real `evaluateCapabilityGuard` — no reimplementation,
    // no cast. A DIRECT `evaluateGuard = evaluateCapabilityGuard` assignment does NOT
    // type-check here (verified): the mailbox `GuardRegistry` seam's `state` parameter is
    // `unknown`, and function parameters are checked contravariantly, so a function whose
    // OWN `state` parameter is the concrete `KernelStateSnapshot` interface is not
    // assignable to a signature declaring `state: unknown` — accepting that assignment
    // would be unsound (nothing stops a mailbox-side caller passing an arbitrary `unknown`
    // that is not actually shaped like `KernelStateSnapshot`). The narrower, cast-free fix:
    // this adapter simply does not use its own injected (widened-to-`unknown`) `state`
    // parameter at all — it reads the SAME real state directly via `readKernelState()`,
    // the exact function `dispatch.ts` itself also calls (see `applyTransition`'s
    // `deps.readKernelState()` call) and passes as that very `state` argument. Both routes
    // observe the identical live state; this only avoids re-deriving it through the
    // seam's own widened, unproven `unknown` value.
    const evaluateGuard: GuardRegistry = (kind, target) =>
      evaluateCapabilityGuard(kind, target, readKernelState());

    // Step 6: `buildSnapshotPayload` — everything `KernelSnapshotPayloadV1` needs minus
    // `eventSeq` (the event bus stamps that itself on every delivery).
    function buildSnapshotPayload(): Omit<EventPayloadByKindV1["kernel.snapshot"], "eventSeq"> {
      const state = readKernelState();
      return {
        // `CapabilityKernelStateSnapshot` mirrors `KernelModelsSnapshotV1` field for field
        // (`capabilities/types.ts`'s own header note) — the same seven keys, the same
        // per-domain shape — so the read state IS the models snapshot, not a second copy.
        models: state,
        // No project has ever been opened/created yet in a freshly-assembled Kernel —
        // Task 9's `project.open`/`project.create` handlers are what will ever populate
        // these from `core/project`'s open-sequence.
        projectId: null,
        activePageSlug: null,
        activeChatId: null,
        trust: state.project.trust,
        capabilities: buildCapabilities(state),
        pageDescriptors: [],
        // TODO(6C follow-up, unchanged from the M21 placeholder): no Git port is wired
        // into `KernelDeps` (out of MVP scope, Global Constraints) — this stays the
        // retained placeholder value until a real Git status projection lands.
        gitStatus: PLACEHOLDER_GIT_STATUS,
        agentIdentity: buildAgentIdentity(),
      };
    }

    // Step 6b (Step C1): every `(id, target)` request worth projecting right now — the
    // static nine null-target kinds `buildCapabilities`/`SNAPSHOT_CAPABILITY_KINDS` already
    // cover, PLUS whichever of the four growable identities (active chat, the active page,
    // a live preview session, the active turn) currently exist. Used ONLY for
    // `kernel.capabilitiesChanged` diffing below — `buildSnapshotPayload`'s own bootstrap
    // `capabilities` field is deliberately left unchanged (still the static nine, via
    // `buildCapabilities`), documented as a known, separate staleness gap in this file's
    // "## Step C1" report appendix (mirrors `handlers/project.ts`'s own already-documented
    // "a late subscriber sees a stale kernel.snapshot" gap).
    function currentCapabilityRequests(): readonly Readonly<{
      id: CommandKindV1;
      target: unknown;
    }>[] {
      const requests: Readonly<{ id: CommandKindV1; target: unknown }>[] =
        SNAPSHOT_CAPABILITY_KINDS.map((kind) => ({ id: kind, target: null }));

      if (growableActiveChatId !== null) {
        requests.push({ id: "chat.switch", target: { chatId: growableActiveChatId } });
      }

      if (growableActivePageSlug !== null) {
        const target = { pageSlug: growableActivePageSlug };
        requests.push({ id: "page.renameTitle", target });
        requests.push({ id: "page.removePlan", target });
        requests.push({ id: "preview.selectPage", target });
        requests.push({ id: "preview.selectCurrent", target });
      }

      // Gated on `activePreview !== null` too (not just the last-captured id): once a
      // session closes (`preview.close`/`project.close`, both call `setActivePreviewSession
      // (null)`), the LAST minted `previewSessionId` must stop being projectable even though
      // this tracker itself is only ever cleared by `noteEventForCapabilityGrowth`'s own
      // `kernel.project.finishClose` case, not by every session-close route.
      if (growableLivePreviewSessionId !== null && activePreview !== null) {
        const target = { previewSessionId: growableLivePreviewSessionId };
        requests.push({ id: "preview.close", target });
        requests.push({ id: "preview.retry", target });
        requests.push({ id: "preview.resize", target });
      }

      const activeTurnId = activeTurnIdAtom();
      if (activeTurnId !== null) {
        requests.push({ id: "turn.cancel", target: { turnId: activeTurnId } });
      }

      return requests;
    }

    /**
     * The ONLY place this module inspects an already-published event's payload for
     * capability-growth purposes — a narrowing cast per branch, never a blanket one,
     * matching `core/mailbox/model/dispatch.ts`'s own precedented `toRevisionGuardCommand`
     * cast (`envelope.payload as CommandPayloadByKindV1["turn.cancel"]`): `PublishableEventV1`
     * is one generic object type, not a distributed union, so checking `event.kind` against
     * a literal does not itself narrow `event.payload`'s type — a cast is required at this
     * exact narrowing point regardless, and each one here asserts a shape the event's own
     * kind ALREADY guarantees at runtime (validated by `eventPayloadV1SchemaByKind` before
     * this function ever sees the event, since it only ever receives ALREADY-`publishTransition`d
     * envelopes — see `publishAndTrackCapabilities`, below). Never a blanket `unknown` bounce.
     */
    function noteEventForCapabilityGrowth(event: PublishableEventV1): void {
      if (event.kind === "chat.changed") {
        const payload = event.payload as EventPayloadByKindV1["chat.changed"];
        growableActiveChatId = payload.activeChatId;
        return;
      }
      if (event.kind === "page.descriptorsChanged") {
        const payload = event.payload as EventPayloadByKindV1["page.descriptorsChanged"];
        growableActivePageSlug = payload.activePageSlug;
        return;
      }
      if (event.kind === "preview.sourceChanged") {
        const payload = event.payload as EventPayloadByKindV1["preview.sourceChanged"];
        growableLivePreviewSessionId = payload.previewSessionId;
        return;
      }
      if (event.kind === "kernel.stateChanged") {
        const payload = event.payload as EventPayloadByKindV1["kernel.stateChanged"];
        // `project.close`'s own `finishClose` transition is the one point every growable
        // identity must not outlive (mirrors `projectClose`'s own `setActivePreviewSession
        // (null)` call — a project-scoped resource must not outlive the project it belongs
        // to, `handlers/project.ts`'s own header note).
        if (
          payload.modelId === "kernel.project.state" &&
          payload.action === "kernel.project.finishClose"
        ) {
          growableActiveChatId = null;
          growableActivePageSlug = null;
          growableLivePreviewSessionId = null;
        }
      }
    }

    // Step 7: the event bus — publication/subscription plus the bootstrap `kernel.snapshot`.
    const rawEventBus = createEventBus({ counters, buildSnapshotPayload });

    // The baseline `kernel.capabilitiesChanged` diffs against — computed once, right after
    // construction, from the SAME `currentCapabilityRequests()` every later diff uses. At
    // this exact point every growable tracker is still at its initial `null`, so this
    // equals the static nine `buildCapabilities` independently computes for the bootstrap
    // snapshot — the first REAL growth-worthy transition is the first one that ever diffs
    // against something other than itself.
    let previousCapabilityRecords: readonly CapabilityRecord[] = projectCapabilities(
      currentCapabilityRequests(),
      readKernelState(),
    );

    /**
     * Wraps `rawEventBus.publishTransition`: publishes exactly what was asked, THEN (only if
     * something was actually published) inspects the published events for identity growth,
     * re-projects {@link currentCapabilityRequests}, diffs against
     * {@link previousCapabilityRecords} via `core/capabilities`'s own `diffCapabilities` (no
     * reimplementation), and — only when the diff is non-empty — publishes ONE more
     * `kernel.capabilitiesChanged` event through the SAME bus. That second publish deliberately
     * does NOT call `counters.advanceRevision()` again: `drainBatches()` (`event-bus.ts`) reads
     * `stateRevision()` fresh per batch, so without a second bump this event naturally shares
     * the revision the transition that grew it already established — a capability becoming
     * projectable is a consequence of that SAME transition, not a second one of its own. This
     * is `launchOperation`'s own `eventBus.publishTransition` too (see below), so growth is
     * tracked identically whether the triggering transition was synchronous (dispatch) or an
     * async completion.
     *
     * `diffCapabilities`'s own `CapabilityRecord`/`{id, target: unknown}` shapes are the
     * documented "loosely-typed sibling" of `CapabilityEntryV1`/`CapabilityTargetV1`
     * (`core/capabilities/types.ts`'s own comment) — a single narrowing cast per field,
     * right here, at the one boundary converting the heterogeneous diff result back into the
     * closed wire DTO, mirrors the SAME precedented category of cast as
     * `noteEventForCapabilityGrowth`'s own (never an incompatible-type bounce: every value on
     * the `unknown` side was ALREADY built by `projectCapability`/`evaluateCapabilityGuard`
     * with the real, correctly-shaped target for its own `id`).
     */
    function publishAndTrackCapabilities(
      events: readonly PublishableEventV1[],
    ): EventBusPayloadError | readonly EventEnvelopeV1[] {
      const published = rawEventBus.publishTransition(events);
      if (published instanceof Error) return published;
      if (published.length === 0) return published;

      for (const event of published) noteEventForCapabilityGrowth(event);

      const nextRecords = projectCapabilities(currentCapabilityRequests(), readKernelState());
      const diff = diffCapabilities(previousCapabilityRecords, nextRecords);
      previousCapabilityRecords = nextRecords;

      if (diff.changed.length === 0 && diff.removed.length === 0) return published;

      const growthEvent: PublishableEventV1<"kernel.capabilitiesChanged"> = {
        kind: "kernel.capabilitiesChanged",
        payload: {
          changed: diff.changed as readonly CapabilityEntryV1[],
          removed: diff.removed as readonly Readonly<{
            id: CommandKindV1;
            target: CapabilityEntryV1["target"];
          }>[],
        },
      };
      const growthPublished = rawEventBus.publishTransition([growthEvent]);
      if (growthPublished instanceof Error) {
        console.error(
          `core/kernel: kernel.capabilitiesChanged failed its own schema — ${growthPublished.message}`,
        );
        return published;
      }
      return [...published, ...growthPublished];
    }

    const eventBus: EventBus = {
      publishTransition: publishAndTrackCapabilities,
      subscribe: rawEventBus.subscribe,
    };

    // Step 8: the dedupe ledger (a plain closure `Map`, NOT a Reatom atom — see its own
    // header comment on why `context.start()`'s per-frame atom isolation would break its
    // exactly-once guarantee).
    const dedupeLedger = createDedupeLedger({ clock: deps.clock });

    // Step 9 (Step C1): the real `HandlerContext` + `HandlerRegistry`.

    // The per-Kernel `PageRemovePlanLedger` (`core/project/model/page-remove-plan.ts`) —
    // its own factory doc forbids module-level construction ("two kernels, or two tests,
    // must never share one plan slot"), so exactly one is built here, per `createKernel`
    // call, matching every other per-Kernel factory above.
    const pageRemovePlanLedger = createPageRemovePlanLedger();

    // The preview family's four `SessionCommandsDeps` collaborators, plus the router
    // itself — built ONCE, over the SAME real `previewMachine` this Kernel already holds
    // (never a second instance). `frameTokenLedger`/`geometryTokenLedger` are ALSO exposed
    // directly on `HandlerContext` (below), shared Kernel-held state the not-yet-built
    // `pin.create` will consume/restore (`task9-family-page-pin-report.md`, gap 2).
    const frameBroker = createFrameBroker();
    const frameTokenLedger = createFrameTokenLedger();
    const geometryTokenLedger = createGeometryTokenLedger({ clock: deps.clock });
    const backpressure = createPreviewBackpressure();
    const previewSessionCommands = createPreviewSessionCommands({
      machine: previewMachine,
      hostSupervisor: deps.hostSupervisor,
      frameBroker,
      frameTokenLedger,
      geometryTokenLedger,
      backpressure,
    });

    // The five named Kernel-held-fact mutators `handlers/types.ts`'s `HandlerContext`
    // declares — plain functions wrapping each atom's own `.set(...)` (Reatom rule RTM-S01:
    // prefer a direct `atom.set(...)` call over an "identity setter action"; these are
    // exactly that direct call, just given a name a handler can call without reaching the
    // atom itself), plus `setActivePreviewSession` for the plain `activePreview` closure
    // variable.
    function setProjectTrust(trust: "trusted" | "untrusted-read-only" | null): void {
      trustAtom.set(trust);
    }
    function setActiveTurnId(turnId: UUIDv7 | null): void {
      activeTurnIdAtom.set(turnId);
    }
    function setCommitIntentRecorded(recorded: boolean): void {
      commitIntentRecordedAtom.set(recorded);
    }
    function setPreviewSourceKind(sourceKind: "current" | "historical" | null): void {
      previewSourceKindAtom.set(sourceKind);
    }
    function setActivePreviewSession(session: PreviewSession | null): void {
      activePreview = session;
    }
    function currentPreviewSession(): PreviewSession | null {
      return activePreview;
    }

    // Step C1's Kernel-held "current selection" fact — see `handlers/types.ts`'s own
    // `HandlerContext.selection`/`setSelection` comment.
    function setSelection(selection: SelectionSnapshotV1 | null): void {
      currentSelection = selection;
    }
    function selection(): SelectionSnapshotV1 | null {
      return currentSelection;
    }

    // The turn family's own extra surface (`handlers/types.ts`'s `TurnRunnerContext`) —
    // `machine` is the SAME `turnMachine` object above, exposed FULL (never a second
    // instance, never a cast); `setActiveAttempt`/`activeAttempt` are the single-slot
    // registry the turn family's own reported Gap 2 needs, keyed by `activeTurnIdAtom`
    // (never a second, independent turnId). NOT a full closure of Gap 2 by itself — see
    // `TurnRunnerContext`'s own doc comment (`handlers/types.ts`) for the still-open
    // plumbing gap this task's C1 fix round 2 found: nothing today can call
    // `setActiveAttempt` with a live handle, since `core/turns`'s `runTurn` never
    // surfaces the `TurnAttemptHandle` it creates internally.
    function setActiveAttempt(handle: TurnAttemptHandle | null): void {
      activeTurnAttempt = handle;
    }
    function activeAttempt(turnId: UUIDv7): TurnAttemptHandle | null {
      if (activeTurnIdAtom() !== turnId) return null;
      return activeTurnAttempt;
    }
    const turnRunner = { machine: turnMachine, setActiveAttempt, activeAttempt };

    /**
     * The one sanctioned async-launch primitive (`handlers/types.ts`'s own doc comment
     * documents the contract in full; this is Step C's implementation of it). `run` never
     * rejects by its own contract, but the continuation is defended anyway — a family
     * module misbehaving here is uncontrolled code at THIS boundary, matching
     * `core/mailbox/model/dispatch.ts`'s own handling of an injected 6C dependency that
     * throws.
     *
     * `run()`'s OWN returned promise is `wrap`-ed at its own await point (Reatom rule
     * RTM-A04: "wrap(...) for promises ... that touch Reatom", the SAME pattern
     * `core/preview/model/session-commands.ts`'s own `await wrap(deps.hostSupervisor.
     * preview(spec))` already uses) — NOT the whole `async` function wrapped once as a
     * FUNCTION (verified empirically these are NOT interchangeable: wrapping the outer
     * function only preserves context for the synchronous portion up to `run()`'s own
     * `await`; the continuation after an UNWRAPPED `await run()` resumes outside the
     * captured frame entirely, so `counters.advanceRevision()` silently failed to persist
     * into the SAME `stateRevisionAtom` `dispatch.ts` reads back — a later `STALE_REVISION`
     * rejection proved the bump never actually landed. `await wrap(run())` fixes this: per
     * `wrap`'s own contract, "Promise wrapping: Returns a new promise that preserves
     * context through its chain," so the code after this specific await IS back in the
     * Kernel's own frame).
     *
     * REVISION SEMANTICS (this file's own report appendix documents the choice in full):
     * `stateRevision` advances if AND ONLY IF `run()` resolves with at least one event —
     * never a bare, unexplained bump. This differs from `dispatch.ts`'s own SYNCHRONOUS
     * rule (`applyTransition` advances on disposition alone, even for a `startedOutcome([])`
     * admission with zero events) because that rule's own invariant does not extend to a
     * LATER, async completion that ships with genuinely nothing to publish (the `selection`/
     * `model` family's own documented "no failure event exists" boundary case) — advancing
     * anyway would break "a revision bump is always explained by at least one published
     * event," an invariant every client recovering from `STALE_REVISION` relies on.
     */
    async function runLaunchedOperation(
      label: string,
      run: () => Promise<readonly PublishableEventV1[]>,
    ): Promise<void> {
      const events = await wrap(run());
      if (events.length === 0) return;
      counters.advanceRevision();
      const published = eventBus.publishTransition(events);
      if (published instanceof Error) {
        console.error(
          `core/kernel: launchOperation "${label}" produced events that failed to publish: ${published.message}`,
        );
      }
    }

    function launchOperation(
      label: string,
      run: () => Promise<readonly PublishableEventV1[]>,
    ): void {
      void runLaunchedOperation(label, run).catch((cause: unknown) => {
        console.error(
          `core/kernel: launchOperation "${label}" threw unexpectedly:`,
          cause instanceof Error ? cause.message : String(cause),
        );
      });
    }

    const handlerContext: HandlerContext = {
      deps,
      machines: {
        project: projectMachine,
        turn: turnMachine,
        restore: restoreMachine,
        commit: commitMachine,
        export: exportMachine,
        preview: previewMachine,
        migration: migrationMachine,
      },
      readKernelState,
      setProjectTrust,
      setActiveTurnId,
      setCommitIntentRecorded,
      setPreviewSourceKind,
      setActivePreviewSession,
      launchOperation,
      turnRunner,
      setSelection,
      selection,
      currentPreviewSession,
      previewSessionCommands,
      frameTokenLedger,
      geometryTokenLedger,
      pageRemovePlanLedger,
    };

    // `deferredHandlers` (10 kinds) + the four landed families' maps (`chat`, `selection`+
    // `model`, `project`, `preview`+`export`, 20 kinds) + `notYetImplementedHandlers` (13:
    // `turn`, `page`, `pin`, `migration`) — see `./handlers/index.ts`'s own header.
    const handle: HandlerRegistry = createHandlerRegistry(handlerContext, totalHandlers);

    // Step 10: the dispatch pipeline, composed from everything above.
    const dispatch = createDispatch({
      counters,
      dedupeLedger,
      eventBus,
      cancelProbe,
      readKernelState,
      extractTarget,
      evaluateGuard,
      handle,
    }).dispatch;

    // `events` is `eventBus.subscribe`, `bind`-captured against THIS frame (the "current
    // top frame" at this exact point in `createKernel`'s own construction) so a caller
    // invoking it later — after this `context.start(...)` call has already returned —
    // safely re-enters this Kernel's own frame instead of silently reading a different,
    // untouched one (verified empirically; see the task report).
    const events = bind(eventBus.subscribe);

    function currentPreview(): PreviewSession | null {
      return activePreview;
    }

    async function close(): Promise<void> {
      if (closed) return;
      closed = true;
      const preview = activePreview;
      activePreview = null;
      // "Dispose the frame": Reatom v1001 exposes no explicit per-frame teardown API
      // beyond the global `context.reset()` (which would tear down every OTHER Kernel/test
      // sharing this process, not just this one) — so disposal here means releasing this
      // closure's own last references to the frame-bound state above (the machines, the
      // held atoms, the dedupe ledger's map, the event bus's subscriber set) once `close`
      // returns, letting them become garbage-collectable. There is nothing further to
      // actively tear down.
      if (preview !== null) await preview.close();
    }

    return { dispatch, events, currentPreview, close };
  });
}

// --- Turn-cancel phase check (mirrors `revision-guard.ts`'s `TurnCancelPhase`) -----------

const TURN_CANCEL_PHASE_SET: Readonly<Record<TurnCancelPhase, true>> = {
  admitting: true,
  "workspace-ready": true,
  running: true,
  stopping: true,
  snapshotting: true,
  validating: true,
  finalizing: true,
  terminalizing: true,
};

/** True for every `TurnState` phase `TurnCancelPhase` covers (excludes idle/settled phases). */
function isTurnCancelPhase(phase: TurnState): phase is TurnCancelPhase {
  return phase in TURN_CANCEL_PHASE_SET;
}

// --- The snapshot's `capabilities` --------------------------------------------------------

/**
 * The nine kinds whose §10.1 target is the literal `null` (`capabilities/model/target.ts`'s
 * own `nullTarget()` rows) — the only capabilities a freshly-assembled Kernel, with no
 * project/turn/preview/pin/plan ever having existed, can meaningfully project without
 * inventing a runtime identity (a turnId, a pageSlug, a previewSessionId, ...) it does not
 * have. Every other kind's target names exactly such an identity, so it only becomes
 * projectable once something (a future handler) actually creates one — `kernel.
 * capabilitiesChanged` is where that incremental growth belongs, not this static list.
 */
const SNAPSHOT_CAPABILITY_KINDS = [
  "project.create",
  "project.open",
  "project.close",
  "turn.start",
  "chat.create",
  "page.reorder",
  "selection.clear",
  "export.start",
  "migration.plan",
] as const satisfies readonly CommandKindV1[];

/**
 * Projects the nine null-target kinds through the REAL `projectCapability`, one call per
 * kind so each keeps its own precise `K` (and therefore its own precisely-typed `null`
 * target) — the batch `projectCapabilities` widens `target` to `unknown` for its
 * heterogeneous return type, which would need a cast to fit back into the snapshot DTO's
 * closed `CapabilityEntryV1[]`; this per-kind form does not.
 */
function buildCapabilities(
  state: CapabilityKernelStateSnapshot,
): readonly EventPayloadByKindV1["kernel.snapshot"]["capabilities"][number][] {
  return SNAPSHOT_CAPABILITY_KINDS.map((kind) => projectCapability(kind, null, state));
}

// --- Git status (retained placeholder) and agent identity ---------------------------------

/** TODO(6C follow-up): no Git port exists yet (out of MVP scope) — the retained M21 placeholder. */
const PLACEHOLDER_GIT_STATUS: EventPayloadByKindV1["kernel.snapshot"]["gitStatus"] = {
  repositoryId: "unknown",
  head: null,
  sequencerState: "none",
  scopes: {},
};

/**
 * M22's composer-chip agent identity. No selection mechanism exists yet — `model.select`
 * (Task 9) is the only command that will ever pick a backend/model pair — so this is
 * always `null` for now, matching `AgentIdentityV1`'s own "null before any backend is
 * selected" contract; `deps.agentRegistry` stays unused in this task's minimal build.
 */
function buildAgentIdentity(): EventPayloadByKindV1["kernel.snapshot"]["agentIdentity"] {
  return null;
}
