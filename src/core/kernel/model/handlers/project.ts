import { wrap } from "@reatom/core";

import { buildChatRecordsPayload, truncateChatDisplayName } from "core/chats";
import type { ChatSummaryV1 } from "core/chats";
import type { TransitionOutcome } from "core/machines";
import type { PublishableEventV1 } from "core/mailbox";
import {
  type IntendedRecoveryDomainV1,
  PageDescriptorsAssemblyError,
  type TrustDecisionV1,
  buildPageDescriptorsChangedPayload,
  buildTrustStatus,
  grantImplicitTrust,
  scanOrphanTurns,
} from "core/project";
import {
  type CommandPayloadByKindV1,
  type FailureDtoV1,
  type KernelStateChangedPayloadV1,
  type PageDescriptorV1,
  isUuidv7,
} from "core/protocol";
import type { PageSlug } from "entities/page";
import { uuidv7 } from "infrastructure/uuid";

import type { CommandOutcomeV1, FamilyHandlerMap, HandlerContext, HandlerMachine } from "./types";
import { noOpOutcome, startedOutcome } from "./types";

/**
 * `project.create` / `project.open` / `project.retryOpen` / `project.close` /
 * `project.setTrust` (kernel-assembly WP-1 task 9, Step B — the `project` family).
 *
 * ALL FIVE are "started"-disposition async compositions (the task brief's own words):
 * each synchronously applies the ONE immediate project-machine transition the guard just
 * confirmed is legal, returns `startedOutcome` with that admission event, then calls
 * {@link HandlerContext.launchOperation} exactly once to run the rest — every further
 * machine transition and port call happens inside that `run` closure, never before
 * `launchOperation` is called and never after this function itself returns.
 *
 * REUSE, NOT DUPLICATION: `core/project/model/trust.ts` (subject build/grant/status),
 * `core/project/model/orphan-turn-scan.ts` (the TD §7.7 orphan scan + classifier), and
 * `core/project/model/descriptors.ts` (the `page.descriptorsChanged` diff/assembly) are
 * an ALREADY-LANDED, already-tested module this file composes verbatim — none of their
 * logic is re-derived here. Imported through `core/project` (the module's own public
 * entry, kernel-assembly Task 10) rather than a deep `core/project/model/*` path — this
 * file previously deep-imported as a documented stopgap awaiting exactly that barrel;
 * Task 10 landed it, so the deep paths are gone.
 *
 * NOT REUSED, AND WHY: `core/project/model/open-sequence.ts`'s own `runOpenSequence` is
 * the "whole thing" orchestrator TD §12 describes, but its `OpenSequenceDeps` needs SIX
 * fields `HandlerContext`/`KernelDeps` has no source for at all —
 * `openProjectStore`/`readJournalFormat`/`findIntendedRecoveryDomain`/
 * `recoverPendingMigrations`/`validateSchemas` (that file's OWN header calls these
 * "documented gaps... the composition root supplies the real implementation once `store`
 * grows the corresponding named method" — i.e. Task 10/11 or later, not this one) and
 * `promptTrustDecision` (an interactive UI round trip a ONE-SHOT command handler
 * structurally cannot perform: there is no "ask the UI a question and await the answer"
 * channel anywhere in the `CommandHandler`/`launchOperation` contract). Its own
 * `RecoveryRoutingMachines` also types every machine as the FULL `StateMachine` (with
 * `phaseAtom`), predating this contract's `HandlerMachine` fix (task-9 fix round 1) that
 * deliberately excludes it — a second, narrower type mismatch on top of the six missing
 * deps. Rather than either fabricating six deps this contract has no primitive for
 * (forbidden: "do NOT invent kernel state outside the contract") or duplicating
 * `runOpenSequence`'s own logic, this file composes the SAME already-tested BUILDING
 * BLOCKS `runOpenSequence` itself calls (`trust.ts`, `orphan-turn-scan.ts`,
 * `descriptors.ts`) directly against real `KernelDeps` ports, skipping only the steps
 * that have no port surface at all — each skip is called out at its own step below, not
 * silently dropped. `core/project/model/recovery-routing.ts`'s `routeProjectRecovery`
 * (the "discover an intended domain and route beginRecovery" step) is skipped the same
 * way, for the same reason (`findIntendedRecoveryDomain` has no port); `project.retryOpen`
 * below drives the SAME three domain machines' `retryRecovery`/`complete*`/`blockRecovery`
 * edges directly instead, since retryOpen's own payload — not a discovered domain — names
 * which one to drive.
 *
 * FLAGGED GAPS (documented here, once, rather than repeated at every call site):
 * - Journal format / pending migrations / schema validation (TD steps 3/6/7): no port
 *   exposes any of the three. For MVP (format 1 only, an empty migration chain — kernel-
 *   assembly Global Constraints) each one vacuously passes today, so skipping them changes
 *   no observable behavior; a future format/migration/schema addition needs new ports and
 *   new steps here, not a guess.
 * - Intended-recovery-domain discovery (KCC §12.7): no port names WHICH of
 *   Restore/Export/Migration an intended journal belongs to (`RecoveryService.recover()`
 *   returns only aggregate counts). This file therefore never routes a FRESH open/create
 *   into `recovering` — a real pending intended journal is a known, narrow gap until a
 *   port grows that classification; `project.retryOpen` is unaffected, since ITS domain
 *   comes from the command's own payload, not from discovery.
 * - The interactive workspace-trust prompt (KCC §7.1/§12.8, `promptTrustDecision` in
 *   `open-sequence.ts`): no round-trip channel exists in this contract. `project.open`
 *   resolves trust to `"trusted"` only when a PRIOR durable grant already covers the exact
 *   subject; otherwise it opens `ready`/`untrusted-read-only` (KCC's own safe default —
 *   "declining completes open as ready but untrusted/read-only") and leaves the interactive
 *   decision to a follow-up `project.setTrust` command, which this file fully implements.
 * - `project.setTrust`'s `workspaceIdentity` "opaque... validation" (KCC §7.1 row): no
 *   member of `HandlerContext` exposes a synchronous "the CURRENT true identity" read to
 *   validate a payload's claim against — freshness checks of this kind need an async port
 *   call (`trustGate.buildSubject`), and a handler must decide its disposition
 *   SYNCHRONOUSLY. This handler applies the transition unconditionally once the guard has
 *   confirmed phase legality (matching every other project handler's synchronous
 *   machine-driven admission), and durably persists the grant asynchronously; it does not
 *   invent a synchronous identity cache `HandlerContext` does not provide.
 * - CLOSED (§10 smoke closeout, bug 2 — `ui`'s Home -> Workspace transition was
 *   unreachable): `kernel.snapshot`'s own `projectId` field (`kernel.ts`'s
 *   `buildSnapshotPayload`) used to be hardcoded `null` unconditionally, and neither
 *   `finishOpen` nor `finishClose`'s own `kernel.stateChanged` event carried the fact at
 *   all — so NEITHER an already-subscribed client (kernel-command-contract §9: "no
 *   event-resume token, replay buffer, or reconnect promise" — there is no second
 *   `kernel.snapshot` to fall back on) NOR a late-subscriber's bootstrap snapshot could
 *   ever learn it, and `ui/mirror`'s own `deriveScreen` (gated on `projectId !== null`)
 *   could never leave `"home"`. No NEW mutator was needed — `finishOpen`/`finishClose`
 *   below now carry `metadata: {projectId, ...}` on their existing `kernel.stateChanged`
 *   event (the same free-form per-action bag `setTrust`'s own `workspaceIdentity` already
 *   used), which `kernel.ts`'s existing "growable identity" mechanism
 *   (`noteEventForCapabilityGrowth`, the SAME one that already tracks
 *   `growableActiveChatId`/`growableActivePageSlug`/`growableLivePreviewSessionId` from
 *   this file's own published events) now ALSO tracks as `growableProjectId`, feeding
 *   `buildSnapshotPayload` honestly — and which `ui/mirror/model/mirror.ts`'s `apply()`
 *   now ALSO reads directly off the event for an already-subscribed client, never waiting
 *   on a snapshot that will never come again. `setTrust`'s event gained the identical
 *   `trust` fact for the same reason (§7.1's later `project.setTrust` step is exactly what
 *   moves the screen from `trust-prompt`/`read-only` to `workspace`, and needed the same
 *   live channel).
 * - WP-10 Task 6: `runProjectReadySequence` restores the ACTIVE chat's persisted tail once
 *   the project reaches `ready` (`restoreActiveChatTail`, below), satisfying §11's relaunch
 *   requirement ("reopens the Workspace with the active chat's history restored"). At the
 *   time this landed, no port enumerated a project's OTHER chats, so the `/chats` popup's
 *   remaining rows populated lazily as the user switched to them — a documented, narrow gap.
 * - fix-bundle Gap E (spec §2.1, `listChatSummaries` below): that gap is closed. `store`'s
 *   `ChatReader.list()` now enumerates every chat the project holds, so `chat.changed` is
 *   published from the FULL project listing rather than from whatever this process happened
 *   to learn — the bug this closes was reported as "three chats on disk, one row after a
 *   restart." The listing and the active chat's tail are two INDEPENDENT reads with two
 *   independent failure modes: `chat.changed` comes from `listChatSummaries`, `chat.records`
 *   from `restoreActiveChatTail` — a listing failure degrades to the active chat alone (still
 *   logged), a tail failure costs only the scrollback, and neither one kills the other the way
 *   the single combined function used to.
 * - WP-5 Phase C task C4 (D-Q3): TD §12 step 9's "...export pointer..." is now validated
 *   HERE too, not only in `core/project/model/open-sequence.ts`'s `runOpenSequence` (task
 *   C3) — this file's header already explains why `runOpenSequence` itself is never
 *   called from the live path, so validating the pointer only there would be dead code in
 *   production. `runProjectReadySequence` calls `deps.exportPublish.readPointer()` after
 *   `buildPageDescriptors`, before `finishOpen`; a `null` pointer (no export published
 *   yet) never blocks.
 */

// --- Small, shared helpers -----------------------------------------------------------------

type ChangedOutcome<Phase extends string, Action extends string> = Extract<
  TransitionOutcome<Phase, Action>,
  { kind: "changed" }
>;

/** `KernelStateChangedPayloadV1`'s own phase-tag union, by another name — see that type's own comment for why it isn't separately exported. */
type KernelPhaseTag = KernelStateChangedPayloadV1["previousTag"];

/**
 * Applies `action` only when it is currently legal, matching every other handler's
 * "the guard already confirmed this, but defend anyway" posture (`./deferred.ts`'s own
 * `rejectDeferred` doc explains the same defensive-backstop discipline). Returns `null`
 * on illegality — never throws, never half-applies.
 */
function tryApply<Phase extends string, Action extends string>(
  machine: HandlerMachine<Phase, Action>,
  action: Action,
): ChangedOutcome<Phase, Action> | null {
  if (!machine.canApply(action)) return null;
  const outcome = machine.apply(action);
  if (outcome.kind !== "changed") return null;
  return outcome;
}

/** Builds one `kernel.stateChanged` event from an already-`"changed"` transition outcome. */
function stateChangedEvent(
  modelId: KernelStateChangedPayloadV1["modelId"],
  action: KernelStateChangedPayloadV1["action"],
  outcome: { readonly from: KernelPhaseTag; readonly to: KernelPhaseTag },
  metadata: Readonly<Record<string, unknown>> = {},
): PublishableEventV1<"kernel.stateChanged"> {
  return {
    kind: "kernel.stateChanged",
    payload: { modelId, action, previousTag: outcome.from, nextTag: outcome.to, metadata },
  };
}

// --- project.close --------------------------------------------------------------------------

function projectClose(
  _payload: CommandPayloadByKindV1["project.close"],
  context: HandlerContext,
): CommandOutcomeV1 {
  const beginOutcome = tryApply(context.machines.project, "beginClose");
  if (beginOutcome === null) {
    console.warn(
      "core/kernel/handlers/project: project.close's beginClose was illegal despite the guard confirming legality",
    );
    return noOpOutcome();
  }

  const admissionEvent = stateChangedEvent(
    "kernel.project.state",
    "kernel.project.beginClose",
    beginOutcome,
  );
  const operationId = uuidv7();

  context.launchOperation("kernel.project.close", async () => {
    // project.close's own effect on Kernel-held, project-scoped state — mirrors
    // `kernel.ts`'s own whole-object `close()`, which clears the same field on the SAME
    // grounds (a project-scoped resource must not outlive the project it belongs to).
    context.setActivePreviewSession(null);
    // `ProjectStore.close()` is typed `Promise<void>` — it has no `FailureDtoV1` channel
    // to check (`core/ports/project-store.ts`'s own signature), so there is no failure
    // branch to build here.
    await wrap(context.deps.projectStore.close());

    const finishOutcome = tryApply(context.machines.project, "finishClose");
    if (finishOutcome === null) {
      console.warn(
        "core/kernel/handlers/project: project.close's finishClose was illegal after the lease released",
      );
      return [];
    }
    // `metadata.projectId: null` — a project-scoped identity must not outlive the project it
    // belongs to (mirrors this same function's own `setActivePreviewSession(null)` call above,
    // and `kernel.ts`'s own `noteEventForCapabilityGrowth` clearing its three growable
    // identities on this exact same action). See `finishOpen`'s identical-purpose metadata
    // (above, `runProjectReadySequence`) for the full rationale.
    return [
      stateChangedEvent("kernel.project.state", "kernel.project.finishClose", finishOutcome, {
        projectId: null,
      }),
    ];
  });

  return startedOutcome([admissionEvent], operationId);
}

// --- project.setTrust -----------------------------------------------------------------------

function projectSetTrust(
  payload: CommandPayloadByKindV1["project.setTrust"],
  context: HandlerContext,
): CommandOutcomeV1 {
  const applyOutcome = tryApply(context.machines.project, "setTrust");
  if (applyOutcome === null) {
    console.warn(
      "core/kernel/handlers/project: project.setTrust's setTrust was illegal despite the guard confirming legality",
    );
    return noOpOutcome();
  }

  // The Kernel-visible trust flag flips NOW, synchronously — every other command's guard
  // (`projectUntrustedReason`) reads `readKernelState().project.trust` on its very next
  // call, and must see this decision immediately, not after an async round trip.
  context.setProjectTrust(payload.trust);

  // `metadata.trust` — the SAME already-resolved value `context.setProjectTrust` just flipped
  // synchronously above, echoed back so an already-subscribed client can mirror it (see
  // `finishOpen`'s identical-purpose metadata, `runProjectReadySequence`, for the full
  // rationale this event-metadata channel closes).
  const admissionEvent = stateChangedEvent(
    "kernel.project.state",
    "kernel.project.setTrust",
    applyOutcome,
    { workspaceIdentity: payload.workspaceIdentity, trust: payload.trust },
  );
  // Gap A (spec §2.2): the SAME shared helper `runProjectReadySequence` uses — a later
  // `setTrust` granting trust on an already-open project is the second of its two callers.
  const previewEvents = enablePreviewIfTrusted(context, payload.trust);
  const operationId = uuidv7();

  context.launchOperation("kernel.project.setTrust", async () => {
    const { deps } = context;
    const manifest = await wrap(deps.projectStore.readManifest());
    if ("code" in manifest) {
      console.warn(
        `core/kernel/handlers/project: project.setTrust could not read the manifest to persist the durable grant: ${manifest.safeMessage}`,
      );
      return [];
    }

    // `git: null` — no Git port exists in `KernelDeps` (out of MVP scope, kernel-assembly
    // Global Constraints), matching every other trust-subject build in this file.
    const subject = await wrap(
      deps.trustGate.buildSubject(deps.projectStore.root, manifest.projectId, null),
    );
    if ("code" in subject) {
      console.warn(
        `core/kernel/handlers/project: project.setTrust could not build a trust subject: ${subject.safeMessage}`,
      );
      return [];
    }

    if (payload.trust === "trusted") {
      const grantFailure = await wrap(deps.trustGate.grant(subject));
      if (grantFailure !== undefined) {
        console.warn(
          `core/kernel/handlers/project: project.setTrust could not durably persist the grant: ${grantFailure.safeMessage}`,
        );
      }
    }

    // Nothing further is Kernel-visible: the trust flag already flipped in the admission
    // step above, and the durable grant carries no event of its own in the closed §9
    // registry (`TrustGate` is machine-local persistence, not a Kernel-state fact).
    return [];
  });

  return startedOutcome([admissionEvent, ...previewEvents], operationId);
}

// --- The shared post-admission "reach ready" sequence (project.create / project.open / --
// --- project.retryOpen's continuation) --------------------------------------------------

type TrustSource =
  | { readonly kind: "create"; readonly trust: TrustDecisionV1 }
  | { readonly kind: "open" };

/** Applies `kernel.project.blockOpen` and builds its event — every failing step below funnels through this one place. */
function blockOpen(
  context: HandlerContext,
  reason: string,
  failure: FailureDtoV1,
): readonly PublishableEventV1[] {
  const outcome = tryApply(context.machines.project, "blockOpen");
  if (outcome === null) {
    console.warn(
      `core/kernel/handlers/project: blockOpen was illegal while handling "${reason}" (${failure.safeMessage})`,
    );
    return [];
  }
  return [
    stateChangedEvent("kernel.project.state", "kernel.project.blockOpen", outcome, {
      reason,
      failure,
    }),
  ];
}

/**
 * Resolves KCC §7.1/§12.8's trust decision — composes `core/project/model/trust.ts`
 * verbatim (see this file's header for the interactive-prompt gap `project.open` accepts).
 */
async function resolveTrust(
  context: HandlerContext,
  projectId: string,
  trustSource: TrustSource,
): Promise<FailureDtoV1 | TrustDecisionV1> {
  const { trustGate, projectStore } = context.deps;

  if (trustSource.kind === "create") {
    // A payload that explicitly asks for untrusted-read-only is honored as-is — no
    // implicit grant is durably recorded for a project the caller itself declined to
    // trust (`core/project/model/trust.ts`'s `grantImplicitTrust` doc: a fresh project
    // "has no external content to distrust", which is a reason to grant by DEFAULT, not a
    // reason to override an explicit refusal).
    if (trustSource.trust === "untrusted-read-only") return "untrusted-read-only";
    const subject = await wrap(
      grantImplicitTrust({ trustGate, root: projectStore.root, projectId, git: null }),
    );
    if ("code" in subject) return subject;
    return "trusted";
  }

  const status = await wrap(
    buildTrustStatus({ trustGate, root: projectStore.root, projectId, git: null }),
  );
  if ("code" in status) return status;
  // No interactive round trip exists in this contract (see this file's header) — a prior
  // grant is honored; anything else opens safely untrusted, read-only.
  return status.granted ? "trusted" : "untrusted-read-only";
}

/**
 * kernel-command-contract §7.6's own table fixes this precondition verbatim: `disabled` ->
 * `kernel.preview.enable` -> `idle`, *"Requires trusted project and completed project
 * recovery."* Those are exactly the two conditions this sequence establishes, so enabling
 * preview is a Kernel-computed fact, not a user intent — there is no `preview.enable` command
 * kind to add, no dispatcher, and no UI decision (fix-bundle spec §2.2).
 *
 * An untrusted project stays `disabled`; that IS the meaning of the state, since preview executes
 * design code. Factored as ONE helper because two callers need it — the ready sequence below and
 * a later `project.setTrust` that grants trust — and two copies would be two chances to diverge.
 */
function enablePreviewIfTrusted(
  context: HandlerContext,
  trust: TrustDecisionV1,
): readonly PublishableEventV1[] {
  if (trust !== "trusted") return [];
  const outcome = context.machines.preview.apply("kernel.preview.enable");
  if (outcome.kind !== "changed") {
    // `kernel.preview.enable`'s only listed edge is `disabled -> idle` (`preview-machine.ts`'s
    // own table) — no edge for it is flagged `noOp`, so `"no-op"` can never actually happen
    // here; in practice this branch is always `"illegal"`. That covers EVERY phase other than
    // `disabled` alike — `idle`, `starting`, `live`, `switching`, `failed`, `circuit-open` all
    // land here indistinguishably. A second `setTrust` granting trust on an already-open
    // project (already past `disabled`) is the ordinary case that hits it, not a fault — but
    // still logged (errore rule 21: an error that is not propagated must be logged).
    const currentPhase = outcome.kind === "illegal" ? outcome.from : outcome.phase;
    console.warn(
      `core/kernel/handlers/project: enablePreviewIfTrusted's kernel.preview.enable was ${outcome.kind} from "${currentPhase}"`,
    );
    return [];
  }
  return [stateChangedEvent("kernel.preview.state", "kernel.preview.enable", outcome)];
}

/** Reads one page's source and runs it through the Gate, mapping the result to a `PageDescriptorV1`. A source-read failure blocks the WHOLE open (matches `core/project/model/open-sequence.ts`'s own `validateProjectContents`); a Gate rejection produces an `"invalid"` descriptor for just that page. */
async function buildPageDescriptors(
  context: HandlerContext,
  slugs: readonly PageSlug[],
): Promise<FailureDtoV1 | readonly PageDescriptorV1[]> {
  const descriptors: PageDescriptorV1[] = [];
  for (const pageSlug of slugs) {
    const source = await wrap(context.deps.pageReader.readSource(pageSlug));
    if ("code" in source) return source;

    const result = await wrap(
      context.deps.gateRunner.runPage({
        source: new TextDecoder().decode(source.bytes),
        slug: pageSlug,
      }),
    );

    if (result.ok && result.descriptor !== null) {
      const { meta } = result.descriptor;
      descriptors.push({
        status: "ready",
        pageSlug,
        sourceHash: source.sourceHash,
        title: meta.title,
        minSize: meta.minSize,
        theme: meta.theme,
        kitApiVersion: meta.kitApiVersion,
      });
      continue;
    }

    const firstError = result.errors[0];
    descriptors.push({
      status: "invalid",
      pageSlug,
      sourceHash: source.sourceHash,
      error:
        firstError !== undefined
          ? { code: firstError.code, safeMessage: firstError.message }
          : { code: "GATE_REJECTED", safeMessage: "page failed Gate validation" },
    });
  }
  return descriptors;
}

/**
 * Whether {@link listChatSummaries}'s result can become a `chat.changed` event:
 * `ChatChangedPayloadV1.activeChatId` is non-nullable, so the event cannot be built at all
 * without a valid, listed active chat. Shared between the log-vs-stay-silent decision inside
 * `listChatSummaries` and the actual publish guard in `runProjectReadySequence` so the two never
 * drift apart.
 */
function canPublishChatChanged(
  activeChatId: string | null,
  summaries: readonly ChatSummaryV1[],
): activeChatId is string {
  return activeChatId !== null && isUuidv7(activeChatId) && summaries.length > 0;
}

/**
 * The `list()`-failure fallback: still names the active chat, but HONESTLY — `createdAt` comes
 * from `ChatReader.open`'s own header fact, never a call-time clock read. `ChatSummaryV1
 * .createdAt`'s own doc fixes it as a fact off the chat header, and it is user-visible (the
 * `/chats` popup's `WHEN` column, and the newest-first sort key) — a fabricated "now" would
 * render a month-old chat as brand new and jump it to the top of the list (review finding,
 * fix round 1). If `open` ALSO fails, no placeholder row is published at all rather than
 * inventing one — logged either way (errore rule 21), never fabricated.
 */
async function buildActiveChatFallbackSummary(
  context: HandlerContext,
  activeChatId: string | null,
): Promise<readonly ChatSummaryV1[]> {
  if (activeChatId === null || !isUuidv7(activeChatId)) return [];

  const handle = await wrap(context.deps.chatReader.open(activeChatId));
  if ("code" in handle) {
    console.warn(
      `core/kernel/handlers/project: could not open the active chatId ${activeChatId} to build a chat-listing fallback row: ${handle.safeMessage}`,
    );
    return [];
  }

  return [{ chatId: activeChatId, createdAt: handle.header.createdAt, displayName: null }];
}

/**
 * Every chat the project holds, as `chat.changed.added` (fix-bundle spec §2.1). This is the
 * event that makes `/chats` a view over the PROJECT rather than over whatever this process
 * happened to learn — the reported "three chats on disk, one row after a restart".
 *
 * INDEPENDENT OF THE TAIL, deliberately: today one failure kills both events, because
 * `restoreActiveChatTail` bails out of the whole pair. After the split, `chat.changed` is fed by
 * the listing and `chat.records` by the tail, so a tail failure costs the scrollback rather than
 * the whole list.
 *
 * A `list()` failure DEGRADES to today's behaviour — the active chat alone, one row, logged, via
 * {@link buildActiveChatFallbackSummary}. No "the chat directory could not be read" event is
 * invented here: that is the same class as finding §2.1 (a rejected command produces no
 * user-visible feedback) and belongs with the observability work, not with this listing.
 *
 * A chat id that is not a canonical UUIDv7 is dropped with a warning rather than published:
 * `chatSummaryV1Schema` requires one, and a single bad row would fail validation for the WHOLE
 * event, taking every good row down with it.
 *
 * A `list()` SUCCESS that still cannot become a `chat.changed` (no active chat yet, an active
 * chat id that failed its own UUIDv7 check, or a listing that came back with nothing usable) is
 * also logged (review finding, fix round 1) — the failure branch above already did; a good read
 * silently producing no event is the same "error that is not propagated" errore rule 21 targets,
 * just on the success side.
 */
async function listChatSummaries(
  context: HandlerContext,
  activeChatId: string | null,
): Promise<readonly ChatSummaryV1[]> {
  const listed = await wrap(context.deps.chatReader.list());
  if ("code" in listed) {
    console.warn(
      `core/kernel/handlers/project: could not list the project's chats (${listed.safeMessage}) — falling back to the active chat alone`,
    );
    return await wrap(buildActiveChatFallbackSummary(context, activeChatId));
  }

  const summaries: ChatSummaryV1[] = [];
  for (const entry of listed) {
    if (!isUuidv7(entry.chatId)) {
      console.warn(
        `core/kernel/handlers/project: chat listing dropped "${entry.chatId}" — not a canonical UUIDv7`,
      );
      continue;
    }
    summaries.push({
      chatId: entry.chatId,
      createdAt: entry.createdAt,
      displayName: truncateChatDisplayName(entry.firstUserText),
    });
  }

  if (!canPublishChatChanged(activeChatId, summaries)) {
    console.warn(
      `core/kernel/handlers/project: chat listing read ${summaries.length} row(s) but activeChatId ${
        activeChatId === null ? "is null" : `"${activeChatId}"`
      } — chat.changed will not publish this open`,
    );
  }

  return summaries;
}

/**
 * Restores `activeChatId`'s persisted TAIL — nothing else. `chat.changed` now comes from
 * {@link listChatSummaries} (fix-bundle spec §2.1), so this function no longer resolves a display
 * name at all: `resolveChatDisplayName`'s backward `loadBefore` walk to the very start of the
 * chat was both the expensive way to learn a fact that lives at the file's head AND the likeliest
 * of this function's four bail-out branches on a long history — it took the scrollback and the
 * chat list down together. `loadTail` remains, for the scrollback it is actually for.
 */
async function restoreActiveChatTail(
  context: HandlerContext,
  activeChatId: string | null,
): Promise<readonly PublishableEventV1[]> {
  if (activeChatId === null) return [];

  const handle = await wrap(context.deps.chatReader.open(activeChatId));
  if ("code" in handle) {
    console.warn(
      `core/kernel/handlers/project: could not open the active chatId ${activeChatId} to restore its tail: ${handle.safeMessage}`,
    );
    return [];
  }

  const loadResult = await wrap(handle.loadTail());
  if ("code" in loadResult) {
    console.warn(
      `core/kernel/handlers/project: could not load the active chatId ${activeChatId}'s tail: ${loadResult.safeMessage}`,
    );
    return [];
  }

  return [{ kind: "chat.records", payload: buildChatRecordsPayload(activeChatId, loadResult) }];
}

/** The full post-admission sequence: recovery, orphan scan, trust, page descriptors, `finishOpen` — shared by `project.create`, `project.open`, and `project.retryOpen`'s continuation. */
async function runProjectReadySequence(
  context: HandlerContext,
  trustSource: TrustSource,
): Promise<readonly PublishableEventV1[]> {
  const { deps, machines } = context;

  const manifest = await wrap(deps.projectStore.readManifest());
  if ("code" in manifest) return blockOpen(context, "manifest-read-failed", manifest);

  const workspaceStateResult = await wrap(deps.projectStore.readWorkspaceState());
  if ("code" in workspaceStateResult)
    return blockOpen(context, "workspace-state-read-failed", workspaceStateResult);

  const recoverOutcome = await wrap(deps.recovery.recover());
  if (!recoverOutcome.ok)
    return blockOpen(context, "transaction-recovery-failed", recoverOutcome.error);

  const orphanDecisions = await wrap(scanOrphanTurns({ recovery: deps.recovery }));
  if ("code" in orphanDecisions)
    return blockOpen(context, "orphan-turn-scan-failed", orphanDecisions);
  const corrupt = orphanDecisions.find((decision) => decision.kind === "chat-corrupt");
  if (corrupt !== undefined) {
    return blockOpen(context, "orphan-turn-chat-corrupt", {
      code: "PERSISTENCE_FAILED",
      retryable: false,
      safeMessage: `chat_corrupt: ${corrupt.reason} for turnId ${corrupt.turnId} in chatId ${corrupt.chatId}`,
      details: { chatId: corrupt.chatId, turnId: corrupt.turnId, reason: corrupt.reason },
    });
  }

  const events: PublishableEventV1[] = [];
  const trust = await wrap(resolveTrust(context, manifest.projectId, trustSource));
  // `TrustDecisionV1` is a bare string union, not an object — `"code" in x` would throw on
  // it (unlike the object-shaped `FailureDtoV1 | T` checks elsewhere in this file), so this
  // is a membership check against the two known decisions instead (same reasoning
  // `core/project/model/open-sequence.ts` uses for its own bare-string-union results).
  if (trust !== "trusted" && trust !== "untrusted-read-only") {
    return blockOpen(context, "trust-resolution-failed", trust);
  }
  context.setProjectTrust(trust);
  // Placement (spec §2.2): after trust, before `finishOpen`, so the snapshot the UI sees at
  // ready already carries preview enabled.
  events.push(...enablePreviewIfTrusted(context, trust));

  const slugs = await wrap(deps.pageReader.listSlugs());
  // `...events` carries forward whatever `enablePreviewIfTrusted` already applied above — the
  // preview machine's `disabled -> idle` transition already happened (a real machine mutation,
  // not a pending one), so a block reached AFTER it must still publish that fact rather than
  // silently drop it: an applied-but-unpublished transition would desynchronize every
  // subscriber from the Kernel's own true state.
  if ("code" in slugs) return [...events, ...blockOpen(context, "page-list-failed", slugs)];

  const descriptors = await wrap(buildPageDescriptors(context, slugs));
  if ("code" in descriptors) {
    return [...events, ...blockOpen(context, "page-source-read-failed", descriptors)];
  }

  // TD §12 step 9's "...export pointer..." (WP-5 Phase C task C4, D-Q3): this is the LIVE
  // production open path — `core/project/model/open-sequence.ts`'s own `runOpenSequence`
  // validates the same fact (task C3), but nothing here ever calls that function (see this
  // file's header), so the pointer must be validated here too or it would never run in
  // production. `null` means the project has never published an export — ABSENT IS VALID,
  // never a block.
  const pointer = await wrap(deps.exportPublish.readPointer());
  if (pointer !== null && "code" in pointer) {
    return [...events, ...blockOpen(context, "export-pointer-read-failed", pointer)];
  }

  const activePageSlug = workspaceStateResult.state.activePageSlug ?? manifest.pages[0] ?? null;
  const descriptorsPayload = buildPageDescriptorsChangedPayload(
    "project-open",
    [],
    descriptors,
    activePageSlug,
  );
  if (descriptorsPayload instanceof PageDescriptorsAssemblyError) {
    // Not otherwise propagated (errore rule 21) — the open itself still proceeds, since
    // §9's "descriptor list is complete and ordered" is a stronger guarantee than any one
    // subscriber notification; a producer bug here (a duplicate `pageSlug`, per that
    // error's own doc) should not also block a project that DID open successfully.
    console.warn(
      `core/kernel/handlers/project: could not assemble page.descriptorsChanged: ${descriptorsPayload.message}`,
    );
  } else {
    events.push({ kind: "page.descriptorsChanged", payload: descriptorsPayload });
  }

  const finishOutcome = tryApply(machines.project, "finishOpen");
  if (finishOutcome === null) {
    console.warn(
      "core/kernel/handlers/project: finishOpen was illegal after a clean open sequence — leaving the project in its current phase",
    );
    return events;
  }
  // `metadata.projectId`/`metadata.trust` close the gap this file's own header used to flag
  // ("kernel.snapshot's own projectId/... fields have NO corresponding mutator... a client
  // that subscribes AFTER a project has already opened still receives a stale, hardcoded
  // kernel.snapshot") — an ALREADY-subscribed client (never re-sent a fresh kernel.snapshot,
  // kernel-command-contract §9: "no event-resume token, replay buffer, or reconnect promise")
  // learns the just-resolved identity from THIS event's own metadata instead. Both facts are
  // already resolved, real values at this exact point (`manifest.projectId` from the read
  // above, `trust` from the resolution above) — never fabricated.
  events.push(
    stateChangedEvent("kernel.project.state", "kernel.project.finishOpen", finishOutcome, {
      projectId: manifest.projectId,
      trust,
    }),
  );

  // Spec §2.1: the chat LIST and the active chat's TAIL are now two independent reads with two
  // independent failure modes, published as two independent events.
  const activeChatId = workspaceStateResult.state.activeChatId;
  const summaries = await wrap(listChatSummaries(context, activeChatId));
  if (canPublishChatChanged(activeChatId, summaries)) {
    events.push({
      kind: "chat.changed",
      payload: { activeChatId, added: summaries, updated: [], removedChatIds: [] },
    });
  }

  const chatTailEvents = await wrap(restoreActiveChatTail(context, activeChatId));
  events.push(...chatTailEvents);

  return events;
}

/** Shared admission for `project.create`/`project.open`: apply the one immediate action, return `startedOutcome`, launch the rest. */
function beginProjectOpen(
  context: HandlerContext,
  action: "beginCreate" | "beginOpen",
  actionName: KernelStateChangedPayloadV1["action"],
  run: () => Promise<readonly PublishableEventV1[]>,
): CommandOutcomeV1 {
  const outcome = tryApply(context.machines.project, action);
  if (outcome === null) {
    console.warn(
      `core/kernel/handlers/project: project.${action === "beginCreate" ? "create" : "open"}'s ${action} was illegal despite the guard confirming legality`,
    );
    return noOpOutcome();
  }

  const admissionEvent = stateChangedEvent("kernel.project.state", actionName, outcome);
  const operationId = uuidv7();
  context.launchOperation(actionName, run);
  return startedOutcome([admissionEvent], operationId);
}

// --- project.create --------------------------------------------------------------------------

function projectCreate(
  payload: CommandPayloadByKindV1["project.create"],
  context: HandlerContext,
): CommandOutcomeV1 {
  return beginProjectOpen(context, "beginCreate", "kernel.project.beginCreate", () =>
    runProjectReadySequence(context, { kind: "create", trust: payload.creationDefaults.trust }),
  );
}

// --- project.open ----------------------------------------------------------------------------

function projectOpen(
  _payload: CommandPayloadByKindV1["project.open"],
  context: HandlerContext,
): CommandOutcomeV1 {
  return beginProjectOpen(context, "beginOpen", "kernel.project.beginOpen", () =>
    runProjectReadySequence(context, { kind: "open" }),
  );
}

// --- project.retryOpen ------------------------------------------------------------------------

function canApplyDomainRetryRecovery(
  context: HandlerContext,
  domain: IntendedRecoveryDomainV1,
): boolean {
  if (domain === "restore")
    return context.machines.restore.canApply("kernel.restore.retryRecovery");
  if (domain === "export") return context.machines.export.canApply("kernel.export.retryRecovery");
  return context.machines.migration.canApply("kernel.migration.retryRecovery");
}

function applyDomainRetryRecovery(context: HandlerContext, domain: IntendedRecoveryDomainV1) {
  if (domain === "restore") return context.machines.restore.apply("kernel.restore.retryRecovery");
  if (domain === "export") return context.machines.export.apply("kernel.export.retryRecovery");
  return context.machines.migration.apply("kernel.migration.retryRecovery");
}

function applyDomainComplete(context: HandlerContext, domain: IntendedRecoveryDomainV1) {
  if (domain === "restore") return context.machines.restore.apply("kernel.restore.complete");
  if (domain === "export") return context.machines.export.apply("kernel.export.completeRecovery");
  return context.machines.migration.apply("kernel.migration.completeRecovery");
}

function applyDomainBlockRecovery(context: HandlerContext, domain: IntendedRecoveryDomainV1) {
  if (domain === "restore") return context.machines.restore.apply("kernel.restore.blockRecovery");
  if (domain === "export") return context.machines.export.apply("kernel.export.blockRecovery");
  return context.machines.migration.apply("kernel.migration.blockRecovery");
}

function domainModelId(domain: IntendedRecoveryDomainV1): KernelStateChangedPayloadV1["modelId"] {
  if (domain === "restore") return "kernel.restore.state";
  if (domain === "export") return "kernel.export.state";
  return "kernel.migration.state";
}

function domainRetryActionName(
  domain: IntendedRecoveryDomainV1,
): KernelStateChangedPayloadV1["action"] {
  if (domain === "restore") return "kernel.restore.retryRecovery";
  if (domain === "export") return "kernel.export.retryRecovery";
  return "kernel.migration.retryRecovery";
}

function domainCompleteActionName(
  domain: IntendedRecoveryDomainV1,
): KernelStateChangedPayloadV1["action"] {
  if (domain === "restore") return "kernel.restore.complete";
  if (domain === "export") return "kernel.export.completeRecovery";
  return "kernel.migration.completeRecovery";
}

function domainBlockActionName(
  domain: IntendedRecoveryDomainV1,
): KernelStateChangedPayloadV1["action"] {
  if (domain === "restore") return "kernel.restore.blockRecovery";
  if (domain === "export") return "kernel.export.blockRecovery";
  return "kernel.migration.blockRecovery";
}

function recoveryActionId(payload: CommandPayloadByKindV1["project.retryOpen"]): string {
  if (payload.recovery.kind === "restore") return payload.recovery.restoreActionId;
  if (payload.recovery.kind === "export") return payload.recovery.operationId;
  return payload.recovery.migrationActionId;
}

/**
 * The async continuation once the named domain's `retryRecovery` admission already ran:
 * re-classify the SAME transaction (`RecoveryService.classify`, keyed by the payload's own
 * action id — the closest available stand-in for a real transaction id, since no port maps
 * one to the other; documented, not invented) and either complete the domain's recovery and
 * continue the ordinary "reach ready" sequence, or block again.
 */
async function runRetryOpenContinuation(
  context: HandlerContext,
  domain: IntendedRecoveryDomainV1,
  actionId: string,
): Promise<readonly PublishableEventV1[]> {
  const classification = await wrap(context.deps.recovery.classify(actionId));
  if ("code" in classification) {
    return blockRetryOpen(context, domain, "classify-failed", classification);
  }
  if (classification.kind === "conflict") {
    return blockRetryOpen(context, domain, "still-conflicted", {
      code: "TRANSACTION_RECOVERY_CONFLICT",
      retryable: true,
      safeMessage: `recovery for ${domain} action ${actionId} is still in conflict`,
      details: { domain, actionId },
    });
  }

  const events: PublishableEventV1[] = [];
  const completeOutcome = applyDomainComplete(context, domain);
  if (completeOutcome.kind === "changed") {
    events.push(
      stateChangedEvent(domainModelId(domain), domainCompleteActionName(domain), completeOutcome),
    );
  } else {
    console.warn(
      `core/kernel/handlers/project: project.retryOpen's domain complete action was illegal for "${domain}"`,
    );
  }

  const rest = await wrap(runProjectReadySequence(context, { kind: "open" }));
  return [...events, ...rest];
}

/** Blocks both the named domain (back to `blocked`) and the project machine, for a still-unresolved retry. */
function blockRetryOpen(
  context: HandlerContext,
  domain: IntendedRecoveryDomainV1,
  reason: string,
  failure: FailureDtoV1,
): readonly PublishableEventV1[] {
  const events: PublishableEventV1[] = [];
  const domainOutcome = applyDomainBlockRecovery(context, domain);
  if (domainOutcome.kind === "changed") {
    events.push(
      stateChangedEvent(domainModelId(domain), domainBlockActionName(domain), domainOutcome, {
        reason,
      }),
    );
  } else {
    console.warn(
      `core/kernel/handlers/project: project.retryOpen's domain blockRecovery was illegal for "${domain}" while handling "${reason}"`,
    );
  }
  return [...events, ...blockOpen(context, reason, failure)];
}

function projectRetryOpen(
  payload: CommandPayloadByKindV1["project.retryOpen"],
  context: HandlerContext,
): CommandOutcomeV1 {
  const domain = payload.recovery.kind;
  const actionId = recoveryActionId(payload);

  // Both admission edges must be legal BEFORE either is applied — an inconsistent domain
  // phase (§7.1's project-level guard says nothing about the three domain machines' own
  // phases) must not leave the project machine moved with no domain counterpart moving
  // alongside it. See this file's header on why this is checked here rather than assumed.
  if (
    !context.machines.project.canApply("retryOpen") ||
    !canApplyDomainRetryRecovery(context, domain)
  ) {
    console.warn(
      `core/kernel/handlers/project: project.retryOpen's admission pair was illegal for domain "${domain}" despite the guard confirming project-level legality`,
    );
    return noOpOutcome();
  }

  const projectOutcome = tryApply(context.machines.project, "retryOpen");
  const domainOutcome = applyDomainRetryRecovery(context, domain);
  if (projectOutcome === null || domainOutcome.kind !== "changed") {
    // Unreachable given the `canApply` pair just confirmed above — logged rather than
    // silently accepted, per the errore rule against swallowing an unexpected condition.
    console.warn(
      `core/kernel/handlers/project: project.retryOpen's admission pair became illegal between the canApply check and apply for domain "${domain}"`,
    );
    return noOpOutcome();
  }

  const events = [
    stateChangedEvent("kernel.project.state", "kernel.project.retryOpen", projectOutcome),
    stateChangedEvent(domainModelId(domain), domainRetryActionName(domain), domainOutcome),
  ];
  const operationId = uuidv7();

  context.launchOperation("kernel.project.retryOpen", () =>
    runRetryOpenContinuation(context, domain, actionId),
  );

  return startedOutcome(events, operationId);
}

// --- The family map ---------------------------------------------------------------------------

export const projectHandlers: FamilyHandlerMap<"project"> = {
  "project.create": projectCreate,
  "project.open": projectOpen,
  "project.retryOpen": projectRetryOpen,
  "project.close": projectClose,
  "project.setTrust": projectSetTrust,
};
