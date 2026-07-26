import { type Atom, atom } from "@reatom/core";

import {
  type CommandKindV1,
  type DiagnosticDtoV1,
  type PageDescriptorV1,
  type PinDtoV1,
  type UInt64String,
  type UUIDv7,
  isUuidv7,
} from "core/protocol";
import type { AnyEventEnvelope } from "ui/kernel";

import type {
  AgentIdentity,
  CapabilityState,
  ChatRecord,
  ChatsMirror,
  ExportMirror,
  PreviewMirror,
  ProjectMirror,
  SelectionMirror,
  TurnMirror,
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

/** Safely reads `metadata.trust` as one of the two known decisions, never a cast — see {@link readMetadataProjectId}'s identical rationale. */
function readMetadataTrust(
  metadata: Readonly<Record<string, unknown>>,
): "trusted" | "untrusted-read-only" | undefined {
  const raw = metadata.trust;
  return raw === "trusted" || raw === "untrusted-read-only" ? raw : undefined;
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
        timeline: [...current.timeline, { kind: "step", op: content.op, target: content.target }],
      });
    } else if (content.kind === "reasoning") {
      // Appended, never overwritten (spec §4.6): the ticker kept only the latest thought.
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
        const next = new Map(capabilities());
        for (const entry of envelope.payload.changed) next.set(entry.id, entry.state);
        for (const removed of envelope.payload.removed) next.delete(removed.id);
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
          // nowhere). `turn.started`'s own case below unconditionally overwrites this the moment
          // it fires, with the REAL `deadline` this branch cannot honestly report yet — see
          // `TurnMirror`'s own `deadline: string | null` doc comment for why it stays `null`
          // here rather than inventing a bound.
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
            timeline: [],
            startedAt: now(),
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
          project.set({ ...project(), projectId, ...(trust !== undefined ? { trust } : {}) });
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
          // identities on this exact same action.
          project.set(EMPTY_PROJECT);
        }
        return;
      }
      case "page.descriptorsChanged": {
        pageDescriptors.set(envelope.payload.descriptors);
        project.set({ ...project(), activePageSlug: envelope.payload.activePageSlug });
        return;
      }
      case "turn.started": {
        turn.set({
          phase: "running",
          turnId: envelope.payload.turnId,
          attempt: 1,
          deadline: envelope.payload.deadline,
          timeline: [],
          startedAt: now(),
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
