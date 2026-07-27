import { type Atom, type Computed, atom, computed } from "@reatom/core";

import {
  type CommandKindV1,
  type DiagnosticDtoV1,
  type FailureDtoV1,
  type PageDescriptorV1,
  type PinDtoV1,
  type UInt64String,
  type UUIDv7,
  isUuidv7,
} from "core/protocol";
import type { AnyEventEnvelope } from "ui/kernel";
import { hostFailureCodeOf, isDesignRenderFailure } from "ui/preview";

import type {
  AgentIdentity,
  CapabilityState,
  ChatRecord,
  ChatsMirror,
  ExportMirror,
  PreviewMirror,
  PreviewNoticeMirror,
  ProjectMirror,
  ProjectOpenFailure,
  SelectionMirror,
  TurnMirror,
  TurnTimelineEntry,
} from "../types";
import { agentIdentityFromSnapshot, capabilitiesFromSnapshot, projectFromSnapshot } from "./seed";

/**
 * The UI mirror — a UI-owned Reatom graph of named atoms fed by the Kernel event stream
 * (phase-7 plan D3). It is a read-model, not a Kernel state machine: `apply` updates atoms
 * with `atom.set` (the proven UI write path, `host/render`'s `reactive.test.tsx`), grouping
 * one event's writes in a single named function so components never scatter sets (RTM-S04).
 * It imports no Kernel atoms — only the `EventEnvelopeV1` DTOs (design §3.2/§3.3, two graphs).
 */
export interface Mirror {
  readonly stateRevision: Atom<UInt64String>;
  readonly eventSeq: Atom<UInt64String>;
  readonly project: Atom<ProjectMirror>;
  readonly capabilities: Atom<ReadonlyMap<CommandKindV1, CapabilityState>>;
  readonly pageDescriptors: Atom<readonly PageDescriptorV1[]>;
  readonly turn: Atom<TurnMirror>;
  readonly preview: Atom<PreviewMirror>;
  /**
   * The chat panel's ephemeral crash notice (design `wsHostCrash`'s own `chatSeq` system lines).
   * `null` whenever the preview is not halted.
   *
   * DELIBERATELY NOT A `ChatRecord`. A persisted `system:error` requires exactly one of
   * `turnId`/`actionId` (`entities/chat/model/decode.ts`) and a host crash is neither — it
   * happens outside any turn, and no user performed an action. It is also a description of a
   * LIVE condition, not a historical fact: it must disappear the moment the preview recovers,
   * which a persisted record could not do.
   */
  readonly previewNotice: Computed<PreviewNoticeMirror | null>;
  readonly chats: Atom<ChatsMirror>;
  /**
   * The ACTIVE chat's persisted tail (WP-10 Task 7), fed by `chat.records`. A single bulk-replace
   * atom, not a keyed `Map<chatId, records[]>` cache: the slice deliberately holds only the
   * active chat's records (the Reatom "bulk replace is `atom.set`" guidance, RTM rules) — a
   * re-switch back to a chat reloads its tail from a fresh `chat.records` (Task 5/6) rather than
   * showing a cached copy, trading one re-load for avoiding unbounded UI memory (MVP tradeoff).
   */
  readonly records: Atom<readonly ChatRecord[]>;
  readonly pinsByPage: Atom<ReadonlyMap<string, readonly PinDtoV1[]>>;
  readonly selection: Atom<SelectionMirror>;
  readonly diagnostics: Atom<ReadonlyMap<UUIDv7, DiagnosticDtoV1>>;
  readonly export: Atom<ExportMirror>;
  /** The agent-identity slice (M22) — `{ backendId, modelLabel } | null`, seeded from the
   * snapshot's `agentIdentity` field. `Workspace` reads this to drive every rendered identity
   * text (chip, presence, title, record header, status block) instead of a hardcoded literal. */
  readonly agentIdentity: Atom<AgentIdentity>;
  /** Applies one Kernel event, advancing every affected atom. */
  readonly apply: (envelope: AnyEventEnvelope) => void;
}

const IDLE_TURN: TurnMirror = { phase: "idle" };
const NO_PREVIEW: PreviewMirror = { phase: "none" };
const IDLE_EXPORT: ExportMirror = { phase: "idle" };
const EMPTY_PROJECT: ProjectMirror = {
  projectId: null,
  activePageSlug: null,
  activeChatId: null,
  trust: null,
  openFailure: null,
  opening: false,
};

/** Upserts a keyed value into a copy of `source`, returning a new immutable map. */
function withEntry<K, V>(source: ReadonlyMap<K, V>, key: K, value: V): ReadonlyMap<K, V> {
  const next = new Map(source);
  next.set(key, value);
  return next;
}

/**
 * Safely reads `metadata.projectId` as an honest `UUIDv7`, never a cast — `metadata` is an
 * untyped `Readonly<Record<string, unknown>>` (kernel-command-contract §9's own table
 * describes it as a "closed bounded metadata union" per action, but the protocol type
 * itself is an open bag), so a missing/malformed value is a genuine possibility this
 * reader must handle rather than assume away. `undefined` means "not a valid UUIDv7" —
 * the caller logs and leaves the mirror's own prior value unchanged rather than fabricate
 * one (`handlers/project.ts`'s own `runProjectReadySequence`, "the fix", is this field's
 * one legitimate producer).
 */
function readMetadataProjectId(metadata: Readonly<Record<string, unknown>>): UUIDv7 | undefined {
  const raw = metadata.projectId;
  return typeof raw === "string" && isUuidv7(raw) ? raw : undefined;
}

/**
 * Safely reads `kernel.project.blockOpen`'s own `{reason, failure}` metadata (built by
 * `core/kernel/model/handlers/project.ts`'s `blockOpen`) — never a cast, same rationale as
 * {@link readMetadataProjectId}. Returns `undefined` when either half is missing or the wrong
 * shape, so the caller leaves the previous value alone instead of showing an invented cause.
 */
function readMetadataOpenFailure(
  metadata: Readonly<Record<string, unknown>>,
): ProjectOpenFailure | undefined {
  const reason = metadata.reason;
  const failure = metadata.failure;
  if (typeof reason !== "string" || reason.length === 0) return undefined;
  if (typeof failure !== "object" || failure === null) return undefined;
  const safeMessage = (failure as { readonly safeMessage?: unknown }).safeMessage;
  if (typeof safeMessage !== "string" || safeMessage.length === 0) return undefined;
  return { reason, safeMessage };
}

/** Safely reads `metadata.trust` as one of the two known decisions, never a cast — see {@link readMetadataProjectId}'s identical rationale. */
function readMetadataTrust(
  metadata: Readonly<Record<string, unknown>>,
): "trusted" | "untrusted-read-only" | undefined {
  const raw = metadata.trust;
  return raw === "trusted" || raw === "untrusted-read-only" ? raw : undefined;
}

/**
 * The turn's own clock (`startedAt`) and its ordered `timeline` must not reseed just because a
 * SECOND event establishes the same turn as running. `kernel.turn.beginAdmission` sets both
 * first in the common case; `turn.started` fires moments later for that SAME `turnId` and used
 * to overwrite both unconditionally — visibly snapping the elapsed-time spinner backwards once
 * the admission window crossed a whole second (fix-bundle Task 19 review round 1, Finding 1).
 * Returns the PRIOR `timeline`/`startedAt` when `current` is already `running` for this exact
 * `turnId`; seeds a fresh `timeline: []`/`startedAt: now()` only when this is genuinely the
 * first event to see the turn running — the ordinary case when `turn.started` arrives with no
 * preceding admission fold (the producer/consumer-seam tests below cover that path).
 */
function seedOrPreserveClock(
  current: TurnMirror,
  turnId: UUIDv7,
  now: () => number,
): Readonly<{ timeline: readonly TurnTimelineEntry[]; startedAt: number }> {
  if (current.phase === "running" && current.turnId === turnId) {
    return { timeline: current.timeline, startedAt: current.startedAt };
  }
  return { timeline: [], startedAt: now() };
}

/**
 * The chat-panel lines for a halted preview — each screen's own `chatSeq` system entries,
 * verbatim from the design: `wsHostCrash` when the page threw, `wsHostUnavailable` when the host
 * never ran it (spec §3.2.1).
 *
 * The ONE thing not taken verbatim is the restart count. The design's line is written for the
 * budgeted loop ("halted after 3 restarts"); a deterministic failure opens the circuit on the
 * first try, and "halted after 0 restarts" would describe a loop that never happened.
 */
function previewNoticeFor(attempts: number, finalFailure: FailureDtoV1): PreviewNoticeMirror {
  if (!isDesignRenderFailure(finalFailure)) {
    // `wsHostUnavailable`'s own `chatSeq` system lines. The headline names the raw code, which
    // is the stable thing a user can quote; `UNKNOWN` stands in when the event carried none
    // rather than dropping the line's second half and leaving a dangling dash.
    return {
      headline: `✗ preview host unavailable — ${hostFailureCodeOf(finalFailure) ?? "UNKNOWN"}`,
      detail: "the design was never run — nothing in it to repair",
    };
  }
  const restarts = Math.max(attempts - 1, 0);
  return {
    headline:
      restarts === 0
        ? "✗ preview crashed while rendering — halted immediately"
        : `✗ preview crashed while rendering — halted after ${restarts} restarts`,
    detail: "the design passed Gate; the host died running it",
  };
}

/**
 * `now` is injected so a test can pin `TurnMirror.startedAt` — the one value in this read-model
 * that comes from the UI's own clock rather than from an event payload (see that field's doc).
 */
export function createMirror(now: () => number = () => Date.now()): Mirror {
  const stateRevision = atom<UInt64String>("0", "ui.mirror.stateRevision");
  const eventSeq = atom<UInt64String>("0", "ui.mirror.eventSeq");
  const project = atom<ProjectMirror>(EMPTY_PROJECT, "ui.mirror.project");
  const capabilities = atom<ReadonlyMap<CommandKindV1, CapabilityState>>(
    new Map(),
    "ui.mirror.capabilities",
  );
  const pageDescriptors = atom<readonly PageDescriptorV1[]>([], "ui.mirror.pageDescriptors");
  const turn = atom<TurnMirror>(IDLE_TURN, "ui.mirror.turn");
  const preview = atom<PreviewMirror>(NO_PREVIEW, "ui.mirror.preview");
  /**
   * DERIVED, not a second source (RTM-S02, reatom audit 2026-07-27). A first pass held this as
   * its own atom, `.set` from three arms of `apply` — and the hand-sync was already incomplete:
   * `preview.failed` replaced the preview state without clearing the notice, leaving a stale
   * "preview crashed while rendering" line in the chat under the Gate panel. As a computed the
   * notice cannot drift from the phase it describes, and every clear falls out for free.
   */
  const previewNotice = computed<PreviewNoticeMirror | null>(() => {
    const current = preview();
    return current.phase === "circuit-open"
      ? previewNoticeFor(current.attempts, current.finalFailure)
      : null;
  }, "ui.mirror.previewNotice");
  const chats = atom<ChatsMirror>({ activeChatId: null, summaries: new Map() }, "ui.mirror.chats");
  const records = atom<readonly ChatRecord[]>([], "ui.mirror.records");
  const pinsByPage = atom<ReadonlyMap<string, readonly PinDtoV1[]>>(
    new Map(),
    "ui.mirror.pinsByPage",
  );
  const selection = atom<SelectionMirror>(null, "ui.mirror.selection");
  const diagnostics = atom<ReadonlyMap<UUIDv7, DiagnosticDtoV1>>(
    new Map(),
    "ui.mirror.diagnostics",
  );
  const exportAtom = atom<ExportMirror>(IDLE_EXPORT, "ui.mirror.export");
  const agentIdentity = atom<AgentIdentity>(null, "ui.mirror.agentIdentity");

  /** Merges gate-progress content into the running turn; a no-op when no turn matches. */
  function applyTurnProgress(envelope: Extract<AnyEventEnvelope, { kind: "turn.progress" }>): void {
    const current = turn();
    if (current.phase !== "running" || current.turnId !== envelope.payload.turnId) return;
    const content = envelope.payload.content;
    if (content.kind === "tool") {
      turn.set({
        ...current,
        timeline: [
          ...current.timeline,
          { kind: "step", id: content.id, op: content.op, target: content.target, failed: false },
        ],
      });
    } else if (content.kind === "tool-failed") {
      // Flip the ONE matching step entry (by id), leaving every other entry untouched — never
      // guessed at by position (design `03-workspace-generating.dc.html:44`'s third glyph, ✗
      // failed; `entities/turn`'s `AgentEvent` doc explains why only the failure is emitted).
      // A failure naming an id this timeline never saw a `tool` step for is dropped and logged
      // rather than fabricating a step to attach it to.
      const index = current.timeline.findIndex(
        (entry) => entry.kind === "step" && entry.id === content.id,
      );
      if (index === -1) {
        console.warn(
          `ui/mirror: turn.progress tool-failed named id ${content.id}, which is not a step in the current timeline — dropped`,
        );
        return;
      }
      const nextTimeline = current.timeline.map((entry, i) => {
        if (i !== index || entry.kind !== "step") return entry;
        return { ...entry, failed: true };
      });
      turn.set({ ...current, timeline: nextTimeline });
    } else if (content.kind === "reasoning") {
      // An empty block is not a thought the agent reported — the protocol schema permits it
      // (`event-payload.ts`'s `text: z.string()` has no `.min(1)`) and `normalize.ts` forwards
      // any string, including `""`, because IT drops only non-string content, not empty
      // content. Before `query-options.ts`'s `display: "summarized"` was set, EVERY `thinking`
      // block was zero-length (the brief's own measured live run); appending one here would
      // become a permanently empty thought block once Task 20 renders it, so the mirror is the
      // layer that decides an empty string is not worth surfacing (fix-bundle Task 19 review
      // round 1, Finding 2). Appended, never overwritten otherwise (spec §4.6): the old ticker
      // kept only the latest thought.
      //
      // WHITESPACE COUNTS AS EMPTY (defect fix, 2026-07-26): the test was exact `=== ""`, so a
      // block of `"\n"` or `"   "` survived it and became a blank row in the timeline — visually
      // identical to the empty block this guard exists to suppress, and it consumes one of the
      // eleven rows the fold budget allows (`ui/workspace/model/agent-block-budget.ts`). The
      // ENTRY keeps the agent's own untrimmed text; only the emptiness TEST is trimmed, so
      // nothing the agent actually wrote is altered on its way to the screen.
      if (content.text.trim() === "") return;
      turn.set({
        ...current,
        timeline: [...current.timeline, { kind: "reasoning", text: content.text }],
      });
    } else if (content.kind === "final") {
      turn.set({ ...current, finalText: content.text });
    } else if (content.kind === "usage") {
      turn.set({ ...current, usage: content.tokens });
    } else {
      turn.set({ ...current, errorText: content.message });
    }
  }

  function apply(envelope: AnyEventEnvelope): void {
    // Every envelope advances the two counters, regardless of kind (§9).
    stateRevision.set(envelope.stateRevision);
    eventSeq.set(envelope.eventSeq);

    switch (envelope.kind) {
      case "kernel.snapshot": {
        const payload = envelope.payload;
        project.set(projectFromSnapshot(payload));
        capabilities.set(capabilitiesFromSnapshot(payload));
        pageDescriptors.set(payload.pageDescriptors);
        chats.set({ activeChatId: payload.activeChatId, summaries: new Map() });
        agentIdentity.set(agentIdentityFromSnapshot(payload));
        // A fresh snapshot is the authoritative reset point; transient slices (turn, preview,
        // selection, export, pins, diagnostics, records) are rebuilt from the events that follow
        // it — there is no replay (§9), so a subscription started mid-turn simply starts idle.
        turn.set(IDLE_TURN);
        preview.set(NO_PREVIEW);
        selection.set(null);
        exportAtom.set(IDLE_EXPORT);
        pinsByPage.set(new Map());
        diagnostics.set(new Map());
        records.set([]);
        return;
      }
      case "kernel.capabilitiesChanged": {
        // `removed` MUST apply before `changed`. This map is keyed by capability `id` alone,
        // but the Kernel diffs `(id, target)` pairs (`core/capabilities`'s `diffCapabilities`) —
        // a growable identity retargeting (e.g. `chat.switch` moving to a newly created chat,
        // `kernel.ts`'s `currentCapabilityRequests`) publishes BOTH a `removed` entry for the
        // stale target and a `changed` entry for the current one under the SAME `id` in one
        // event. Applying `changed` first let the later `removed` pass delete the fresh state
        // it had just set, leaving the id absent (read as "unavailable" by `ui/actions`'
        // `capabilityRowState`) — this is the defect reported as "/chats becomes unavailable
        // right after creating a new chat". Removing first means a same-id `changed` entry
        // always wins, and a removal with no matching `changed` (a target that is genuinely
        // gone, e.g. a closed preview session) still deletes as before.
        const next = new Map(capabilities());
        for (const removed of envelope.payload.removed) next.delete(removed.id);
        for (const entry of envelope.payload.changed) next.set(entry.id, entry.state);
        capabilities.set(next);
        return;
      }
      case "kernel.stateChanged": {
        // NARROW, TARGETED EXCEPTION to this switch's own `default` comment ("kernel.stateChanged
        // is advisory until the typed snapshot lands — plan D6"): a fresh `kernel.snapshot` is
        // NEVER re-sent to an already-subscribed client (kernel-command-contract §9: "no
        // event-resume token, replay buffer, or reconnect promise"), so `project.projectId`/
        // `project.trust` — the two facts `deriveScreen` (`./screen.ts`) gates the whole
        // Home -> Workspace transition on — would otherwise never advance for a live
        // subscriber once a project genuinely opens/closes or its trust is decided
        // (§10 smoke closeout, bug 2: "deriveScreen's projectId !== null condition can never
        // become true for a live subscriber"). This does NOT become the general
        // `kernel.stateChanged` handler plan D6 describes — only these three named
        // `kernel.project.state` actions, plus (below) ONE named `kernel.turn.state` action
        // (fix-bundle Task 11 fix round 1, Finding 2), whose real facts their own producers
        // now publish as this event's own `metadata`/`correlation` for exactly this reason.
        const p = envelope.payload;

        if (p.modelId === "kernel.turn.state" && p.action === "kernel.turn.beginAdmission") {
          // The mirror must reflect a running turn from the MOMENT admission begins, not only
          // once `turn.started` synthesizes on the first `turn.attemptStarted` — real admission
          // (a store read, workspace staging, a durable user-record transaction) is hundreds of
          // milliseconds or more, and every `turnRunning` derivation in `ui` reads
          // `mirror.turn().phase === "running"` (`ui/app/model/keymap.ts`'s own doc on its
          // `turnRunning` field has the full mechanism this closes: without this fold, the
          // composer stays enabled through the whole admission window, Enter fires a second
          // `turn.start` the guard rejects `TURN_ALREADY_ACTIVE`, and the rejection surfaces
          // nowhere). `turn.started`'s own case below unconditionally overwrites `deadline` the
          // moment it fires, with the REAL bound this branch cannot honestly report yet — see
          // `TurnMirror`'s own `deadline: string | null` doc comment for why it stays `null`
          // here rather than inventing a bound. `startedAt`/`timeline`, in contrast, are NOT
          // overwritten by that later event for this same turn — see {@link seedOrPreserveClock}.
          const turnId = envelope.correlation?.turnId;
          if (turnId === undefined) {
            console.warn(
              "ui/mirror: kernel.turn.beginAdmission carried no correlation.turnId — turn phase left unchanged",
            );
            return;
          }
          turn.set({
            phase: "running",
            turnId,
            attempt: 1,
            deadline: null,
            ...seedOrPreserveClock(turn(), turnId, now),
            finalText: null,
            errorText: null,
            usage: null,
            gateRetries: [],
          });
          return;
        }

        if (p.modelId !== "kernel.project.state") return;
        if (p.action === "kernel.project.finishOpen") {
          const projectId = readMetadataProjectId(p.metadata);
          if (projectId === undefined) {
            console.warn(
              "ui/mirror: kernel.project.finishOpen's metadata.projectId was not a valid UUIDv7 — project.projectId left unchanged",
            );
            return;
          }
          const trust = readMetadataTrust(p.metadata);
          project.set({
            ...project(),
            projectId,
            ...(trust !== undefined ? { trust } : {}),
            // An open that actually succeeded supersedes whatever an earlier one failed on.
            openFailure: null,
            opening: false,
          });
          return;
        }
        if (p.action === "kernel.project.beginOpen" || p.action === "kernel.project.beginCreate") {
          // The ONLY signal that an open is under way. See {@link ProjectMirror.opening} for
          // what its absence cost: a Home that claimed "no project yet" over a project actively
          // loading, and an Enter the Kernel rejected with nothing on screen to explain it.
          project.set({ ...project(), opening: true });
          return;
        }
        if (p.action === "kernel.project.blockOpen") {
          // WITHOUT THIS ARM THE APP DEADLOCKS SILENTLY (defect fix, 2026-07-26).
          //
          // `handlers/project.ts` funnels nine distinct startup failures — manifest read,
          // workspace-state read, transaction recovery, the orphan-turn scan, a corrupt chat,
          // trust resolution, the page list, a page source read, the export pointer — through
          // one `blockOpen`. Nothing in `src/ui` folded it, so `projectId` stayed `null`,
          // `deriveScreen` held Home, and Home rendered as if nothing had happened. Worse, the
          // project machine was now in `blocked`, where `beginOpen`/`beginCreate` are both
          // illegal — so every subsequent Enter was rejected `CAPABILITY_UNAVAILABLE` and did
          // nothing, forever, with no message. Recording the cause here is what lets Home say
          // what went wrong and what lets `ui/app/model/deps.ts` take the one legal exit
          // (`project.close`, back to `closed`) so Enter works again.
          const openFailure = readMetadataOpenFailure(p.metadata);
          if (openFailure === undefined) {
            console.warn(
              "ui/mirror: kernel.project.blockOpen carried no readable {reason, failure} metadata — project.openFailure left unchanged",
            );
            return;
          }
          project.set({ ...project(), openFailure, opening: false });
          return;
        }
        if (p.action === "kernel.project.setTrust") {
          const trust = readMetadataTrust(p.metadata);
          if (trust === undefined) {
            console.warn(
              'ui/mirror: kernel.project.setTrust\'s metadata.trust was neither "trusted" nor "untrusted-read-only" — project.trust left unchanged',
            );
            return;
          }
          project.set({ ...project(), trust });
          return;
        }
        if (p.action === "kernel.project.finishClose") {
          // A project-scoped identity must not outlive the project it belongs to — mirrors
          // `kernel.ts`'s own `noteEventForCapabilityGrowth` clearing its growable
          // identities on this exact same action. `openFailure` is the one field carried
          // across: closing is how the app escapes `blocked`, so the reason must outlive the
          // escape — see {@link ProjectMirror.openFailure}.
          project.set({ ...EMPTY_PROJECT, openFailure: project().openFailure });
        }
        return;
      }
      case "page.descriptorsChanged": {
        pageDescriptors.set(envelope.payload.descriptors);
        project.set({ ...project(), activePageSlug: envelope.payload.activePageSlug });
        return;
      }
      case "turn.started": {
        // `deadline` is always the fresh, real bound this event alone carries. `startedAt`/
        // `timeline` are NOT always fresh: when `kernel.turn.beginAdmission` already put this
        // same turnId into `running` moments earlier, this event must preserve them rather than
        // reseed — see {@link seedOrPreserveClock} (fix-bundle Task 19 review round 1, Finding 1).
        turn.set({
          phase: "running",
          turnId: envelope.payload.turnId,
          attempt: 1,
          deadline: envelope.payload.deadline,
          ...seedOrPreserveClock(turn(), envelope.payload.turnId, now),
          finalText: null,
          errorText: null,
          usage: null,
          gateRetries: [],
        });
        return;
      }
      case "turn.attemptStarted": {
        const current = turn();
        if (current.phase !== "running" || current.turnId !== envelope.payload.turnId) return;
        // A retry re-runs the agent: the timeline restarts, but `startedAt` (the turn's own
        // clock) and the accumulated gate-retry lines persist so the chat shows the full
        // `retry 1/3 … 2/3` history and the elapsed-time spinner keeps counting from the
        // turn's true start, not from this attempt's.
        turn.set({
          ...current,
          attempt: envelope.payload.attempt,
          deadline: envelope.payload.deadline,
          timeline: [],
          finalText: null,
          errorText: null,
        });
        return;
      }
      case "turn.progress": {
        applyTurnProgress(envelope);
        return;
      }
      case "turn.gateRejected": {
        const current = turn();
        if (current.phase !== "running" || current.turnId !== envelope.payload.turnId) return;
        turn.set({
          ...current,
          gateRetries: [
            ...current.gateRetries,
            {
              retryNumber: envelope.payload.retryNumber,
              diagnostics: envelope.payload.diagnostics,
            },
          ],
        });
        return;
      }
      case "turn.completed":
      case "turn.failed":
      case "turn.cancelled": {
        const p = envelope.payload;
        turn.set({
          phase: "terminal",
          turnId: p.turnId,
          outcome: p.outcome,
          changedPages: p.changedPages,
          warnings: p.warnings,
          failure: p.failure,
        });
        return;
      }
      case "preview.sessionReady": {
        const p = envelope.payload;
        preview.set({
          phase: "ready",
          previewSessionId: p.previewSessionId,
          pageSlug: p.pageSlug,
          sourceHash: p.sourceHash,
          size: p.size,
          interactionMode: p.interactionMode,
          theme: p.theme,
        });
        return;
      }
      case "preview.sourceChanged": {
        const current = preview();
        if (
          current.phase === "ready" &&
          current.previewSessionId === envelope.payload.previewSessionId
        ) {
          preview.set({
            ...current,
            pageSlug: envelope.payload.pageSlug,
            sourceHash: envelope.payload.sourceHash,
          });
        }
        return;
      }
      case "preview.failed": {
        const p = envelope.payload;
        preview.set({
          phase: "failed",
          previewSessionId: p.previewSessionId,
          pageSlug: p.pageSlug,
          sourceHash: p.sourceHash,
          lifecycle: p.phase,
          failure: p.failure,
        });
        return;
      }
      case "preview.circuitOpened": {
        const p = envelope.payload;
        preview.set({
          phase: "circuit-open",
          previewSessionId: p.previewSessionId,
          pageSlug: p.pageSlug,
          attempts: p.attempts,
          finalFailure: p.finalFailure,
          retryAvailable: p.retryCapability.available,
        });
        return;
      }
      case "chat.changed": {
        const p = envelope.payload;
        const previousActiveChatId = chats().activeChatId;
        let summaries = new Map(chats().summaries);
        for (const added of p.added) summaries.set(added.chatId, added);
        for (const updated of p.updated) summaries.set(updated.chatId, updated);
        for (const removed of p.removedChatIds) summaries.delete(removed);
        chats.set({ activeChatId: p.activeChatId, summaries });
        project.set({ ...project(), activeChatId: p.activeChatId });
        // The mirror's `records` slice holds only the ACTIVE chat's tail (Task 7 design
        // decision) — moving `activeChatId` to a different chat makes the current tail stale
        // (it belongs to the chat that was just left). The newly-active chat's own tail arrives
        // as a follow-on `chat.records` from the same Kernel operation (Task 5/6), so clearing
        // here never leaves the UI without an eventual correct tail.
        if (p.activeChatId !== previousActiveChatId) records.set([]);
        return;
      }
      case "chat.records": {
        const p = envelope.payload;
        // Fenced to the active chat, the same pattern the turn cases use for a stale/late
        // arrival (`mirror.ts`'s turnId fence): a tail for a since-switched-away chat is a no-op.
        if (p.chatId === chats().activeChatId) records.set(p.records);
        return;
      }
      case "selection.changed": {
        selection.set(envelope.payload);
        return;
      }
      case "pins.changed": {
        const p = envelope.payload;
        const existing = pinsByPage().get(p.pageSlug) ?? [];
        const byId = new Map(existing.map((pin) => [pin.pinId, pin] as const));
        for (const pin of p.affectedPins) byId.set(pin.pinId, pin);
        pinsByPage.set(withEntry(pinsByPage(), p.pageSlug, [...byId.values()]));
        return;
      }
      case "diagnostics.changed": {
        const next = new Map(diagnostics());
        for (const upsert of envelope.payload.upserts) next.set(upsert.diagnosticId, upsert);
        for (const removed of envelope.payload.removedDiagnosticIds) next.delete(removed);
        diagnostics.set(next);
        return;
      }
      case "export.started": {
        const p = envelope.payload;
        exportAtom.set({
          phase: "running",
          operationId: p.operationId,
          lifecycle: "rendering",
          completedJobs: 0,
          totalJobs: p.renderJobCount,
          pageSlug: null,
          sizeBytes: null,
        });
        return;
      }
      case "export.progress": {
        const current = exportAtom();
        if (current.phase !== "running" || current.operationId !== envelope.payload.operationId)
          return;
        exportAtom.set({
          ...current,
          lifecycle: envelope.payload.phase,
          completedJobs: envelope.payload.completedJobs,
          totalJobs: envelope.payload.totalJobs,
          pageSlug: envelope.payload.pageSlug,
          sizeBytes: envelope.payload.sizeBytes,
        });
        return;
      }
      case "export.completed": {
        const p = envelope.payload;
        exportAtom.set({
          phase: "done",
          operationId: p.operationId,
          destination: p.destination,
          generationId: p.generationId,
        });
        return;
      }
      case "export.failed": {
        // ExportTerminalPayloadV1 (export.completed/export.failed's shared payload) carries
        // neither pageSlug nor sizeBytes — retain them from the last `running` state (M14), the
        // same "retain across the terminal transition" pattern M11 uses for finalText.
        const current = exportAtom();
        const carried =
          current.phase === "running"
            ? { pageSlug: current.pageSlug, sizeBytes: current.sizeBytes }
            : { pageSlug: null, sizeBytes: null };
        exportAtom.set({
          phase: "failed",
          operationId: envelope.payload.operationId,
          failure: envelope.payload.failure,
          ...carried,
        });
        return;
      }
      // Out-of-MVP-scope kinds (kernel.stateChanged is handled above for its own narrow
      // `kernel.project.state` exception ONLY — every other model/action stays advisory
      // until the typed snapshot lands, plan D6; restore/commit/migration are deferred;
      // git/backpressure/geometry/removePlan/applyStarted have no mirror slice yet). The
      // two counters were already advanced above.
      default:
        return;
    }
  }

  return {
    stateRevision,
    eventSeq,
    project,
    capabilities,
    pageDescriptors,
    turn,
    preview,
    previewNotice,
    chats,
    records,
    pinsByPage,
    selection,
    diagnostics,
    export: exportAtom,
    agentIdentity,
    apply,
  };
}
