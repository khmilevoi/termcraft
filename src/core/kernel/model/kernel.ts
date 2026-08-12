import { atom, bind, computed, context, wrap } from "@reatom/core";
import type { z } from "zod";

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
import type { HostSessionSpecV1, PreviewFrameV1, PreviewSession } from "core/ports";
import {
  type FrameAckError,
  type PreviewNoLiveSessionError,
  createFrameBroker,
  createFrameTokenLedger,
  createGeometryTokenLedger,
  createPreviewBackpressure,
  createPreviewSessionCommands,
} from "core/preview";
import { createPageRemovePlanLedger } from "core/project";
import {
  type CommandKindV1,
  type EventKindV1,
  type EventPayloadByKindV1,
  type FrameIdentityV1,
  type FrameTokenV1,
  type PageDescriptorV1,
  type UUIDv7,
  eventPayloadV1SchemaByKind,
  isUuidv7,
} from "core/protocol";
import { parsePageSlug } from "entities/page";
import { log, trace } from "infrastructure/debug-log";

import type { Kernel, KernelDeps } from "../types";
import { createKernelCounters } from "./counters";
import { createHandlerRegistry, totalHandlers } from "./handlers";
import { hostCircuitOpenedEvents } from "./handlers/preview-export";
import {
  type HandlerContext,
  type SelectionSnapshotV1,
  type TurnCancelHandle,
  createDesignSystemInstallLedger,
} from "./handlers/types";
import { publishOperationEvents } from "./operation-publish";

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
 * those two already-wrapped continuations. `currentPreview`/`close`/`publishFrame`/
 * `acknowledgeDisplay` (kernel-assembly Task 16 added the last two) read/write only a
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
    // `trustAtom`/`previewSourceKindAtom` (`project.setTrust`, `preview.select*`). CORRECTED
    // (fixlane-K1-turn-spine.json's kernel finding — the prior text here was stale): `turn`
    // is REAL now too. `activeTurnIdAtom` moves via `handlers/turn.ts`'s own
    // `context.setActiveTurnId` (`turn.start`'s admission/terminal outcomes); `
    // commitIntentRecordedAtom` moves via that SAME file's `context.setCommitIntentRecorded`,
    // wired onto `core/turns`'s `RunTurnDeps.onCommitIntentRecorded` hook (`handlers/turn.ts`'s
    // own header, "THE COMMIT-INTENT BIT — NOW WIRED", has the full recipe and its one
    // honest, documented timing limitation).
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
    // `turn` family's own reported Gap 2 needs — see `handlers/types.ts`'s own comments on
    // `HandlerContext.selection`/`turnRunner` for why each is a plain closure fact rather
    // than part of `KernelStateSnapshot`. Step C2 (`handlers/turn.ts`) is this slot's one
    // real consumer (`turn.cancel`); `turn.start` remains the still-blocked producer — see
    // `handlers/types.ts`'s `TurnRunnerContext.setActiveAttempt` doc comment and
    // `handlers/turn.ts`'s own header for the current, corrected status.
    let currentSelection: SelectionSnapshotV1 | null = null;
    let activeTurnAttempt: TurnCancelHandle | null = null;

    // Step C1's capability-growth identity trackers: which `(id, target)` requests beyond
    // the nine null-target kinds are worth projecting right now, because their identity has
    // actually come into existence. Populated by inspecting the SAME events a transition
    // already publishes (`noteEventForCapabilityGrowth`, below `publishAndTrackCapabilities`)
    // — never a second, independent source of truth, and never touched by any handler
    // directly. See this file's own "## Step C1" report appendix for the full design.
    //
    // `growableActiveChatId`/`growableActivePageSlug` are named atoms, not plain closure
    // `let`s (Task 17 fix): `buildSnapshotPayload`'s `activeIdentities` computed, below,
    // derives `kernel.snapshot`'s `activeChatId`/`activePageSlug` from them on every call —
    // "derived state is computed, not copied" (Reatom rule RTM-S02) — rather than the
    // hand-copied `null` this file used to hardcode there (see that computed's own comment
    // for the full defect this replaces). `growableLivePreviewSessionId`/`growableProjectId`
    // stay plain closure facts: nothing downstream needs them through a `computed`, only a
    // direct read at call time (`currentCapabilityRequests`/`buildSnapshotPayload`'s own
    // `projectId` field, unchanged by this fix).
    const growableActiveChatIdAtom = atom<UUIDv7 | null>(null, "kernel.growable.activeChatId");
    const growableActivePageSlugAtom = atom<string | null>(null, "kernel.growable.activePageSlug");
    let growableLivePreviewSessionId: UUIDv7 | null = null;
    /**
     * The descriptor list of the LAST `page.descriptorsChanged` this Kernel published — the
     * "before" side any later producer needs to diff against, tracked here for the same reason
     * as its `activePageSlug` sibling above: by inspecting the events this Kernel already
     * publishes, never as a second independent source of truth.
     *
     * Added so `handlers/turn.ts` can publish an HONEST `turn-apply` diff after a commit.
     * Without a real before-list its `changes` array could only have been fabricated, and §9
     * requires that "every change carries its exact before/after source-hash binding".
     */
    let growablePageDescriptors: readonly PageDescriptorV1[] = [];
    // (§10 smoke closeout, bug 2) The currently-open project's id — the ONE `kernel.snapshot`
    // field with no other live source anywhere in this Kernel (unlike `activeChatId`/
    // `activePageSlug` above, both of which now have their own named atom, or `trust`, which
    // `trustAtom` already tracks reactively for guards): no capability target ever needs it
    // (every `project.*` capability target is `null`, kernel-command-contract §10.1's own
    // table), so it lives here as a fourth growable-identity closure fact, not inside
    // `readKernelState`/`CapabilityKernelStateSnapshot`. Populated the SAME way the other
    // three are — by inspecting `handlers/project.ts`'s own already-published
    // `kernel.stateChanged` event, never a second, independent source of truth
    // (`noteEventForCapabilityGrowth`, below).
    let growableProjectId: UUIDv7 | null = null;

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
        log.warn(`core/kernel: turn.phase is "${phase}" (cancelable) but activeTurnId is null`);
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

    // Step 6 (Task 17 fix): the named computed `kernel.snapshot`'s `activePageSlug`/
    // `activeChatId` derive from — `growableActivePageSlugAtom`/`growableActiveChatIdAtom`
    // above, re-read fresh every time this computed is read, never a value captured once.
    // Closes the SAME defect shape `buildSnapshotPayload`'s own `projectId` field already
    // closed (§10 smoke closeout, bug 2): a subscriber attaching AFTER the active page or
    // chat changed used to still read the `null` this file hardcoded at construction time
    // — `page.descriptorsChanged`/`chat.changed` genuinely are the live channel for an
    // ALREADY-subscribed client (`ui/mirror`'s own `apply()`), exactly as the comment this
    // replaces said, but that says nothing about what a LATE subscriber's own bootstrap
    // `kernel.snapshot` carries, which is this computed's own job.
    const activeIdentitiesComputed = computed(
      () => ({
        activePageSlug: growableActivePageSlugAtom(),
        activeChatId: growableActiveChatIdAtom(),
      }),
      "kernel.snapshot.activeIdentities",
    );

    // Step 6: `buildSnapshotPayload` — everything `KernelSnapshotPayloadV1` needs minus
    // `eventSeq` (the event bus stamps that itself on every delivery).
    function buildSnapshotPayload(): Omit<EventPayloadByKindV1["kernel.snapshot"], "eventSeq"> {
      const state = readKernelState();
      const activeIdentities = activeIdentitiesComputed();
      return {
        // `CapabilityKernelStateSnapshot` mirrors `KernelModelsSnapshotV1` field for field
        // (`capabilities/types.ts`'s own header note) — the same seven keys, the same
        // per-domain shape — so the read state IS the models snapshot, not a second copy.
        models: state,
        // `growableProjectId` (§10 smoke closeout, bug 2) — the currently-open project's
        // real id once `finishOpen` has published it, `null` again once `finishClose` has
        // (both tracked above, `noteEventForCapabilityGrowth`'s own new case). Fixes this
        // exact field for a LATE subscriber too (a client subscribing after a project has
        // already opened used to still see a hardcoded `null` here) — not only the
        // already-subscribed case `mirror.ts`'s own `kernel.stateChanged` handling closes.
        projectId: growableProjectId,
        // `activePageSlug`/`activeChatId` (Task 17 fix, see `activeIdentitiesComputed` above):
        // Task 9's `page.descriptorsChanged`/`chat.changed` events remain the live channel an
        // ALREADY-subscribed client reads both through (`ui/mirror`'s own `apply()`), but a
        // LATE subscriber's own bootstrap snapshot now carries the SAME current identities too
        // — no second, independent source of truth, just this computed re-read on every call.
        activePageSlug: activeIdentities.activePageSlug,
        activeChatId: activeIdentities.activeChatId,
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

      const growableActiveChatId = growableActiveChatIdAtom();
      if (growableActiveChatId !== null) {
        requests.push({ id: "chat.switch", target: { chatId: growableActiveChatId } });
      }

      const growableActivePageSlug = growableActivePageSlugAtom();
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
     * Logs (never throws, never propagates) a growth-tracking payload that failed the exact
     * schema its own `kind` already guarantees. This branch is provably dead in practice — see
     * `noteEventForCapabilityGrowth`'s own comment — but errore's own "never silently swallow"
     * rule (rule 21) still applies to the branch that would fire if that invariant were ever
     * violated by a future change.
     */
    function warnOnGrowthPayloadMismatch(kind: EventKindV1, error: z.ZodError): void {
      log.error(
        `core/kernel: ${kind} payload failed its own schema during capability-growth tracking — ${error.message}`,
      );
    }

    /**
     * The ONLY place this module inspects an already-published event's payload for
     * capability-growth purposes. `PublishableEventV1` is one generic object type, not a
     * distributed union, so checking `event.kind` against a literal does not itself narrow
     * `event.payload`'s type — a plain `as` cast would need to assert past that gap, the same
     * way `core/mailbox/model/dispatch.ts`'s `toRevisionGuardCommand` already does for
     * `CommandEnvelopeV1`. This function avoids that cast entirely instead: each branch
     * re-validates `event.payload` through `eventPayloadV1SchemaByKind`'s OWN schema for that
     * literal `kind` (`eventPayloadV1SchemaByKind["chat.changed"].safeParse(...)`, etc.), which
     * narrows the payload for real, at the type level, with no assertion anywhere. The
     * re-validation is provably redundant at runtime — every event `noteEventForCapabilityGrowth`
     * ever receives already passed this EXACT schema inside `rawEventBus.publishTransition`'s
     * own `validateBatch` before `publishAndTrackCapabilities` (below) ever calls this function —
     * so the `safeParse` failure branch below is defensive only, never expected to run; see
     * `warnOnGrowthPayloadMismatch`.
     */
    function noteEventForCapabilityGrowth(event: PublishableEventV1): void {
      if (event.kind === "chat.changed") {
        const parsed = eventPayloadV1SchemaByKind["chat.changed"].safeParse(event.payload);
        if (!parsed.success) return warnOnGrowthPayloadMismatch(event.kind, parsed.error);
        growableActiveChatIdAtom.set(parsed.data.activeChatId);
        return;
      }
      if (event.kind === "page.descriptorsChanged") {
        const parsed = eventPayloadV1SchemaByKind["page.descriptorsChanged"].safeParse(
          event.payload,
        );
        if (!parsed.success) return warnOnGrowthPayloadMismatch(event.kind, parsed.error);
        growableActivePageSlugAtom.set(parsed.data.activePageSlug);
        growablePageDescriptors = parsed.data.descriptors;
        return;
      }
      if (event.kind === "preview.sourceChanged") {
        const parsed = eventPayloadV1SchemaByKind["preview.sourceChanged"].safeParse(event.payload);
        if (!parsed.success) return warnOnGrowthPayloadMismatch(event.kind, parsed.error);
        growableLivePreviewSessionId = parsed.data.previewSessionId;
        return;
      }
      if (event.kind === "kernel.stateChanged") {
        const parsed = eventPayloadV1SchemaByKind["kernel.stateChanged"].safeParse(event.payload);
        if (!parsed.success) return warnOnGrowthPayloadMismatch(event.kind, parsed.error);
        // `project.close`'s own `finishClose` transition is the one point every growable
        // identity must not outlive (mirrors `projectClose`'s own `setActivePreviewSession
        // (null)` call — a project-scoped resource must not outlive the project it belongs
        // to, `handlers/project.ts`'s own header note).
        if (
          parsed.data.modelId === "kernel.project.state" &&
          parsed.data.action === "kernel.project.finishClose"
        ) {
          growableActiveChatIdAtom.set(null);
          growableActivePageSlugAtom.set(null);
          growablePageDescriptors = [];
          growableLivePreviewSessionId = null;
          growableProjectId = null;
          // A held design-system preparation is project-scoped (it names a candidate for THIS
          // project's `design/system/**`) and must not outlive the project it was previewed
          // against — the same rule this branch already applies to every growable identity
          // above. `clear()` discards the quarantine directory too, so a preparation abandoned
          // by a project switch never leaks (project-design-systems Wave 3 / P10).
          designSystemLedger.clear();
          return;
        }
        // (§10 smoke closeout, bug 2) `handlers/project.ts`'s own `runProjectReadySequence`
        // now carries the just-opened project's real id in THIS event's own `metadata`
        // (see that file's header) — `metadata` is an untyped `Record<string, unknown>`
        // (kernel-command-contract §9's own table: "the action's closed bounded `metadata`
        // union" is closed per-action in prose, not enforced by this loose protocol type),
        // so the value is re-validated as an honest `UUIDv7` here, never cast. A malformed
        // or missing value is logged and simply leaves `growableProjectId` at whatever it
        // already was — never a fabricated identity.
        if (
          parsed.data.modelId === "kernel.project.state" &&
          parsed.data.action === "kernel.project.finishOpen"
        ) {
          const rawProjectId = parsed.data.metadata.projectId;
          if (typeof rawProjectId !== "string" || !isUuidv7(rawProjectId)) {
            log.warn(
              `core/kernel: kernel.project.finishOpen's metadata.projectId was not a valid UUIDv7 (${JSON.stringify(rawProjectId)}) — growableProjectId left unchanged`,
            );
            return;
          }
          growableProjectId = rawProjectId;
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
     * (`core/capabilities/types.ts`'s own comment) — converting the heterogeneous diff result
     * back into the closed wire DTO used to be a single narrowing cast per field; it is now a
     * `safeParse` through `eventPayloadV1SchemaByKind["kernel.capabilitiesChanged"]` (the SAME
     * schema `rawEventBus.publishTransition` re-validates the published event against a few
     * lines below), for the same reason `noteEventForCapabilityGrowth` re-validates instead of
     * casting: every value on the `unknown` side was ALREADY built by
     * `projectCapability`/`evaluateCapabilityGuard` with the real, correctly-shaped target for
     * its own `id`, so the failure branch below is defensive only, never expected to run.
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

      const parsedGrowthPayload = eventPayloadV1SchemaByKind[
        "kernel.capabilitiesChanged"
      ].safeParse({
        changed: diff.changed,
        removed: diff.removed,
      });
      if (!parsedGrowthPayload.success) {
        warnOnGrowthPayloadMismatch("kernel.capabilitiesChanged", parsedGrowthPayload.error);
        return published;
      }

      const growthEvent: PublishableEventV1<"kernel.capabilitiesChanged"> = {
        kind: "kernel.capabilitiesChanged",
        payload: parsedGrowthPayload.data,
      };
      const growthPublished = rawEventBus.publishTransition([growthEvent]);
      if (growthPublished instanceof Error) {
        log.error(
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

    // The per-Kernel `DesignSystemInstallLedger` (`./handlers/types.ts`, project-design-systems
    // Wave 3 / P10) — same "exactly one per `createKernel` call" discipline as
    // `pageRemovePlanLedger` just above. Its `replace`/`clear` reach `deps.designSystemQuarantine
    // .discard` directly, so an abandoned quarantine preparation is never leaked.
    const designSystemLedger = createDesignSystemInstallLedger(deps.designSystemQuarantine);

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
    // RTM-S01 exception, reviewed: these four are deliberate identity-forwarding
    // functions, not Reatom setter sugar — the atoms are closure-private to this frame,
    // and the named mutators are the reviewed `HandlerContext` access boundary onto them.
    // The `phaseAtom` escape hatch (`ed1d208`) was removed by review for bypassing exactly
    // this same surface.
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
    // kernel-assembly Task 16: this is ALSO the one place that keeps
    // `previewSessionCommands`'s own frame-token incarnation identity in step with the
    // REAL Kernel-tracked session — see `PreviewSessionCommands.noteSessionEstablished`'s
    // own doc comment (`core/preview/model/session-commands.ts`) for why this external
    // notification exists: `handlers/preview-export.ts` still calls THIS function
    // directly to establish/close a session (Gap A), never `previewSessionCommands`'s own
    // `selectPage`/`close`, so `publishFrame`/`acknowledgeDisplay` would otherwise never
    // see a live incarnation to mint/acknowledge against.
    // DEFECT 2 CLOSURE (`core/preview/model/session-commands.ts`'s own
    // `noteSessionEstablished` doc comment has the full "why"): `spec` is forwarded
    // verbatim, never reconstructed — the ONLY thing this function adds over its own
    // prior shape is passing through the second parameter `handlers/preview-export.ts`
    // now supplies.
    function setActivePreviewSession(
      session: PreviewSession | null,
      spec?: HostSessionSpecV1,
    ): void {
      const previous = activePreview;
      activePreview = session;
      if (session === null) {
        previewSessionCommands.noteSessionClosed();
        return;
      }
      previewSessionCommands.noteSessionEstablished(session, spec);
      // DEFECT FIX (2026-07-27): this used to overwrite `activePreview` and walk away, so the
      // session it displaced was never closed by ANYONE. `HostSupervisor.preview` keys by page
      // + source hash, so every page edit mints a new key, a new relay and a new session — the
      // displaced one kept its host subprocess alive against the §13 ≤10 global limit (about
      // ten edits then fail with `HOST_CAPACITY`) and, because a relay only ends on close, kept
      // its frame stream open forever. The UI's frame loop leaves a stream only when it ENDS,
      // so an abandoned predecessor froze the preview on `preparing preview…` for the rest of
      // the run — the whole agent-edits-the-page loop, dead.
      //
      // Identity-guarded: `HostSupervisor.preview` returns the SAME stable session for an
      // unchanged key (a mere size/theme change re-selects without a swap), and closing that
      // would tear down the live preview this call is establishing.
      //
      // THE GUARD IS OBJECT IDENTITY, AND THE PORT NOW PROMISES IT (2026-08-09). It used to be
      // an unwritten agreement with `host/supervisor`, and `host/adapters/host-supervisor.ts`
      // broke it in between by wrapping each `preview()` result in a fresh object — so this
      // condition was ALWAYS true and every page switch closed its own live preview. Since the
      // key became `treeRevision` alone (design-tree phase 3 Task 5), a same-revision switch IS
      // the unchanged-key case, which is what turned a latent mismatch into a dead preview pane.
      // `core/ports/host-supervisor.ts`'s `preview` states the contract now; the adapter's
      // `wrappers` cache honours it. Anything reintroducing a per-call wrapper below this port
      // reintroduces that defect, and no fake-backed test here can see it.
      //
      // Fire-and-forget with a logged failure, never a swallowed one (errore rule 21): this
      // setter is synchronous by contract — every `HandlerContext` mutator is — and the
      // establishing path must not block on the predecessor's teardown. `preview.close`'s own
      // path closes through `previewSessionCommands.close()` and then lands here with `null`,
      // which is why the null branch above deliberately closes nothing a second time.
      if (previous !== null && previous !== session) {
        void previous.close().catch((cause: unknown) => {
          log.warn("kernel: closing the replaced preview session failed:", cause);
        });
      }
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
    // (never a second, independent turnId). Step C2 (`handlers/turn.ts`) made this slot's
    // consumer (`turn.cancel`) real and tested; nothing in THIS Kernel build calls
    // `setActiveAttempt` with a live handle yet, since `turn.start` itself is still blocked
    // by a `core/ports`-level gap (`handlers/turn.ts`'s own header) — the storage/consumer
    // pair is correct and ready for the day that closes.
    function setActiveAttempt(handle: TurnCancelHandle | null): void {
      activeTurnAttempt = handle;
    }
    function activeAttempt(turnId: UUIDv7): TurnCancelHandle | null {
      if (activeTurnIdAtom() !== turnId) return null;
      return activeTurnAttempt;
    }
    const turnRunner = { machine: turnMachine, setActiveAttempt, activeAttempt };

    // The export family's own extra surface (`handlers/types.ts`'s `ExportRunnerContext`,
    // Gap B closure) — `machine` is the SAME `exportMachine` object above, exposed FULL
    // (never a second instance, never a cast). Mirrors `turnRunner`'s own precedent, kept
    // even narrower: `export.start` has no sibling command needing a live-handle registry.
    const exportRunner = { machine: exportMachine };

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
     * REVISION SEMANTICS: `stateRevision` advances if AND ONLY IF `run()` resolves with at
     * least one event — never a bare, unexplained bump. It covers the case an async completion
     * makes easy to hit (the `selection`/`model` family's own documented "no failure event
     * exists" boundary case, which resolves with genuinely nothing to publish), and advancing
     * anyway would break "a revision bump is always explained by at least one published event,"
     * an invariant every client recovering from `STALE_REVISION` relies on.
     *
     * `dispatch.ts`'s SYNCHRONOUS half states the same rule (2026-07-28). It used to advance on
     * the handler's disposition alone — a `startedOutcome([])` admission moved the Kernel and
     * published nothing, and the UI mirror, which learns revisions only from published
     * envelopes, could never catch up; every later command was refused `STALE_REVISION` for the
     * rest of the process. That was a deviation from KCC §6/§7.6/§12.1/§13.3, not a deliberately
     * different rule, and it is gone: both halves of the Kernel now share one invariant, and
     * `operation-publish.ts` is where the shared implementation of it lives.
     */
    async function runLaunchedOperation(
      label: string,
      run: () => Promise<readonly PublishableEventV1[]>,
    ): Promise<void> {
      // DIAGNOSTIC (infrastructure/debug-log): distinguishes the two ways an operation can go
      // quiet — it RESOLVED with an empty event list (a silent refusal deep in the handler), or
      // it never resolved at all (a stalled await). Without this marker both look identical from
      // outside: no event, no console line, nothing on disk.
      trace("kernel.operation", { label, step: "run() started" });
      const events = await wrap(run());
      trace("kernel.operation", { label, step: "run() resolved", eventCount: events.length });
      const published = publishOperationEvents({ counters, eventBus }, events);
      if (published instanceof Error) {
        log.error(
          `core/kernel: launchOperation "${label}" produced events that failed to publish: ${published.message}`,
        );
      }
    }

    function launchOperation(
      label: string,
      run: () => Promise<readonly PublishableEventV1[]>,
    ): void {
      void runLaunchedOperation(label, run).catch((cause: unknown) => {
        log.error(
          `core/kernel: launchOperation "${label}" threw unexpectedly:`,
          cause instanceof Error ? cause.message : String(cause),
        );
      });
    }

    /**
     * The live-publish primitive (kernel-assembly Task 9 Step C3 deliverable B) —
     * `HandlerContext.publishOperationEvent`'s real implementation. Unlike `launchOperation`
     * (a terminal batch, published exactly once when `run()` settles), this may be called
     * ANY NUMBER OF TIMES over one launched operation's own lifetime, so a composition like
     * `core/turns`'s `runTurn` can stream `turn.attemptStarted`/`turn.progress`/
     * `turn.gateRejected` events DURING the run (`RunTurnDeps.publish`,
     * `core/turns/model/run-turn.ts:233`/`:314`) instead of only at the very end. Shares the
     * exact same revision/publish semantics `runLaunchedOperation`'s own tail uses —
     * `publishOperationEvents` (`./operation-publish.ts`) is the ONE helper both call, never
     * two independently hand-rolled copies of "advance iff non-empty, then publish through
     * the same bus."
     *
     * A plain, synchronous function — no `wrap()` of its own — matching the same division of
     * responsibility the five ordinary Kernel-held mutators already have: the CALLER is
     * responsible for `wrap()`-ing whatever async boundary it crosses before invoking this
     * (e.g. `attempt.ts`'s own `wrap((fencedEvent) => {...deps.publish(...)...})`), since this
     * function itself touches no `await` and needs none once called from an already-live
     * Reatom frame.
     */
    function publishOperationEvent(event: PublishableEventV1): void {
      const published = publishOperationEvents({ counters, eventBus }, [event]);
      if (published instanceof Error) {
        log.error(
          `core/kernel: a mid-operation "${event.kind}" event failed to publish: ${published.message}`,
        );
      }
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
      publishOperationEvent,
      turnRunner,
      exportRunner,
      setSelection,
      selection,
      currentPreviewSession,
      currentPageDescriptors: () => growablePageDescriptors,
      previewSessionCommands,
      frameTokenLedger,
      geometryTokenLedger,
      pageRemovePlanLedger,
      designSystemLedger,
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

    /**
     * Fix round 1, Finding 3: the Kernel-minted `previewSessionId` for the SAME live session
     * `currentPreview()` returns, or `null` when none is established. `previewSessionCommands
     * .currentPreviewSessionId()` is a plain `string` internally (that module mints it before
     * `UUIDv7` was in scope there); re-validated with `isUuidv7` here rather than passed
     * through unchecked — a malformed value is reported as "no id" (`null`), never a
     * fabricated-looking pass-through. `setActivePreviewSession` (below) is the only place
     * `activePreview` ever becomes non-null, and it always calls `previewSessionCommands
     * .noteSessionEstablished` in the SAME synchronous step, so this and `currentPreview()`
     * never disagree about whether a session is live — see `entrypoint/model/create-shell.ts`'s
     * `toKernelPort().preview()`, the one caller that needs both to agree, for what happens if
     * they ever did.
     */
    function currentPreviewSessionId(): UUIDv7 | null {
      const id = previewSessionCommands.currentPreviewSessionId();
      if (id === null || !isUuidv7(id)) return null;
      return id;
    }

    /**
     * THE MISSING CONSUMER (defect fix, 2026-07-27). `HostSupervisorPort.onEvent` had no
     * production subscriber at all — only tests — so a live session whose host crash-looped
     * latched its circuit open in silence: the mirror stayed `ready`, no frame ever arrived,
     * and the Workspace fell through to `preparing preview…` forever. This is the wiring the
     * port's own header always named: "phase 6 wires this onto the Kernel event channel."
     *
     * ONLY `circuitOpened` is mapped. `backoff` is deliberately left a pure diagnostic: a
     * restart that succeeds must not have flashed an error on the way, and the supervisor's
     * 250/500/1000 ms backoff means the whole cycle is over in about two seconds, during which
     * `preparing preview…` is an accurate statement.
     *
     * Correlation is by `(pageSlug, sourceHashPrefix)` against the spec the live session was
     * established with. A non-matching key belongs to another session — or to one this page has
     * already replaced — and is dropped rather than attributed to whatever happens to be live.
     *
     * `bind` because the supervisor invokes this listener from OUTSIDE this Kernel's Reatom
     * frame (a child process died; no dispatch is in flight), and the work it launches applies
     * real preview-machine transitions. Same reason `events` above is `bind(eventBus.subscribe)`.
     */
    const unsubscribeSupervisor = deps.hostSupervisor.onEvent(
      bind((event) => {
        if (event.type !== "circuitOpened") return;
        const spec = previewSessionCommands.currentSpec();
        const previewSessionId = currentPreviewSessionId();
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
        const pageSlug = parsePageSlug(spec.pageSlug);
        if (pageSlug instanceof Error) {
          // Defensive only: the spec was built from a parsed slug on the way in. Reported
          // rather than swallowed — a slug that stopped parsing is a real inconsistency.
          trace("kernel.preview.hostCircuitOpened", { step: "dropped", reason: "unparsable slug" });
          return;
        }
        // `?? reason` covers a `SupervisorEventV1` whose optional `failureMessage` is absent.
        // The production emitter always populates it, so this only runs for another port
        // implementation — never for an invented string beyond the final literal.
        const safeMessage =
          event.failureMessage ?? event.reason ?? "the preview host stopped unexpectedly";
        launchOperation("kernel.preview.hostCircuitOpened", async () =>
          hostCircuitOpenedEvents(handlerContext, previewSessionId, pageSlug, spec.sourceHash, {
            attempts: event.attempts ?? 1,
            safeMessage,
            hostFailureCode: event.failureCode,
          }),
        );
      }),
    );

    // kernel-assembly Task 16 — the Kernel's own frame-token authority surface. Both are
    // plain, synchronous delegations to `previewSessionCommands` (itself touching only
    // plain closures, never a Reatom atom — see that module's own header), so neither
    // needs `wrap`/`bind`: the same reasoning `currentPreview`/`close` above already rely
    // on ("read/write only a plain closure variable ... need no wrapping either").
    // `types.ts`'s own `Kernel.publishFrame` doc comment records the Step-1 surface
    // decision and its rejected alternatives in full.
    function publishFrame(frame: PreviewFrameV1): PreviewNoLiveSessionError | FrameTokenV1 {
      return previewSessionCommands.publishFrame(frame);
    }

    function acknowledgeDisplay(frameToken: FrameTokenV1): FrameAckError | FrameIdentityV1 {
      return previewSessionCommands.acknowledgeDisplay(frameToken);
    }

    async function close(): Promise<void> {
      if (closed) return;
      closed = true;
      // Before anything else: a disposed Kernel must stop receiving supervisor events. The
      // teardown below tears down the preview session, which makes the supervisor emit — and
      // a listener still attached would try to drive machines this frame is releasing.
      unsubscribeSupervisor();
      // Whole-Kernel teardown discards any held design-system preparation too — mirrors
      // `setActivePreviewSession(null)` just below for the identical reason (project-scoped
      // state must not outlive the Kernel that scoped it).
      designSystemLedger.clear();
      const preview = activePreview;
      // Routed through `setActivePreviewSession(null)` (not a bare `activePreview = null`
      // assignment) so this teardown path ALSO invalidates `previewSessionCommands`'s own
      // frame-token incarnation identity — the same cleanup `handlers/project.ts`'s
      // `project.close`/`handlers/preview-export.ts`'s `preview.close` already get by
      // calling that function themselves (see its own comment, above).
      setActivePreviewSession(null);
      // "Dispose the frame": Reatom v1001 exposes no explicit per-frame teardown API
      // beyond the global `context.reset()` (which would tear down every OTHER Kernel/test
      // sharing this process, not just this one) — so disposal here means releasing this
      // closure's own last references to the frame-bound state above (the machines, the
      // held atoms, the dedupe ledger's map, the event bus's subscriber set) once `close`
      // returns, letting them become garbage-collectable. There is nothing further to
      // actively tear down.
      if (preview !== null) await preview.close();
    }

    return {
      dispatch,
      events,
      currentPreview,
      currentPreviewSessionId,
      publishFrame,
      acknowledgeDisplay,
      close,
    };
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
