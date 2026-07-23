import { atom, bind, context } from "@reatom/core";

import {
  type KernelStateSnapshot as CapabilityKernelStateSnapshot,
  evaluateCapabilityGuard,
  extractCapabilityTarget,
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
  type GuardRegistry,
  type HandlerRegistry,
  type TargetExtractor,
  type TurnCancelPhase,
  type TurnCancelProbe,
  createDedupeLedger,
  createDispatch,
  createEventBus,
} from "core/mailbox";
import type { PreviewSession } from "core/ports";
import type { CommandKindV1, EventPayloadByKindV1, UUIDv7 } from "core/protocol";

import type { Kernel, KernelDeps } from "../types";
import { createKernelCounters } from "./counters";

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
    // Nothing in this task's MINIMAL handler registry ever mutates them — Task 9's real
    // handlers (`turn.start`/`project.setTrust`/`preview.select*`/finalize) are what
    // eventually will — so they stay at their machines'-matching initial values for the
    // whole lifetime of a Task-8-only Kernel.
    const trustAtom = atom<"trusted" | "untrusted-read-only" | null>(null, "kernel.project.trust");
    const activeTurnIdAtom = atom<UUIDv7 | null>(null, "kernel.turn.activeTurnId");
    const commitIntentRecordedAtom = atom<boolean>(false, "kernel.turn.commitIntentRecorded");
    const previewSourceKindAtom = atom<"current" | "historical" | null>(
      null,
      "kernel.preview.sourceKind",
    );

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

    // Step 7: the event bus — publication/subscription plus the bootstrap `kernel.snapshot`.
    const eventBus = createEventBus({ counters, buildSnapshotPayload });

    // Step 8: the dedupe ledger (a plain closure `Map`, NOT a Reatom atom — see its own
    // header comment on why `context.start()`'s per-frame atom isolation would break its
    // exactly-once guarantee).
    const dedupeLedger = createDedupeLedger({ clock: deps.clock });

    // Step 9: a MINIMAL handler registry — Task 9 replaces this. `HandlerOutcome` has no
    // "rejected" disposition of its own (that is the guard's job, which already ran before
    // `handle` is ever called); the well-formed, total, non-throwing stand-in for "no real
    // handler exists yet" is an explicitly empty, revision-neutral no-op for every kind —
    // never a throw (an unhandled throw here would still convert to a value via
    // `dispatch.ts`'s own `errore.try` wrapper, but the brief is explicit that this
    // registry itself must not rely on that path).
    const handle: HandlerRegistry = (envelope) => {
      console.warn(
        `core/kernel: no handler registered yet for "${envelope.kind}" (Task 9 replaces this ` +
          "minimal registry) — accepting as a no-op",
      );
      return { disposition: "no-op", events: [] };
    };

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

    // The live preview session, if any — a plain closure reference, never an atom: no
    // `preview.select*` handler exists yet in this task's minimal registry to ever set it,
    // and `PreviewSession` itself is an external host-facing object, not Kernel model state
    // `readKernelState` needs to see (only `preview.sourceKind`, above, is).
    let activePreview: PreviewSession | null = null;
    let closed = false;

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
