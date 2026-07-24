import { type Atom, atom } from "@reatom/core";

import type {
  CommandKindV1,
  DiagnosticDtoV1,
  PageDescriptorV1,
  PinDtoV1,
  UInt64String,
  UUIDv7,
} from "core/protocol";
import type { AnyEventEnvelope } from "ui/kernel";

import type {
  AgentIdentity,
  CapabilityState,
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

export function createMirror(): Mirror {
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
      turn.set({ ...current, steps: [...current.steps, content] });
    } else if (content.kind === "reasoning") {
      turn.set({ ...current, reasoning: content.text });
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
        // selection, export, pins, diagnostics) are rebuilt from the events that follow it —
        // there is no replay (§9), so a subscription started mid-turn simply starts idle.
        turn.set(IDLE_TURN);
        preview.set(NO_PREVIEW);
        selection.set(null);
        exportAtom.set(IDLE_EXPORT);
        pinsByPage.set(new Map());
        diagnostics.set(new Map());
        return;
      }
      case "kernel.capabilitiesChanged": {
        const next = new Map(capabilities());
        for (const entry of envelope.payload.changed) next.set(entry.id, entry.state);
        for (const removed of envelope.payload.removed) next.delete(removed.id);
        capabilities.set(next);
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
          steps: [],
          reasoning: null,
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
        // A retry re-runs the agent: the step/reasoning stream restarts, but the accumulated
        // gate-retry lines persist so the chat shows the full `retry 1/3 … 2/3` history.
        turn.set({
          ...current,
          attempt: envelope.payload.attempt,
          deadline: envelope.payload.deadline,
          steps: [],
          reasoning: null,
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
        let summaries = new Map(chats().summaries);
        for (const added of p.added) summaries.set(added.chatId, added);
        for (const updated of p.updated) summaries.set(updated.chatId, updated);
        for (const removed of p.removedChatIds) summaries.delete(removed);
        chats.set({ activeChatId: p.activeChatId, summaries });
        project.set({ ...project(), activeChatId: p.activeChatId });
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
      // Out-of-MVP-scope kinds (kernel.stateChanged is advisory until the typed snapshot lands
      // — plan D6; restore/commit/migration are deferred; git/backpressure/geometry/removePlan
      // /applyStarted have no mirror slice yet). The two counters were already advanced above.
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
    pinsByPage,
    selection,
    diagnostics,
    export: exportAtom,
    agentIdentity,
    apply,
  };
}
