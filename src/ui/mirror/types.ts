import type {
  CommandKindV1,
  DiagnosticDtoV1,
  EventPayloadByKindV1,
  FailureDtoV1,
  PageDescriptorV1,
  PinDtoV1,
  Sha256Hex,
  UUIDv7,
} from "core/protocol";

/**
 * The UI-owned read-model ("mirror") shapes (phase-7 plan D3). The mirror is a SEPARATE
 * Reatom graph (design §3.2/§3.3): it never imports Kernel atoms, only reads the
 * `EventEnvelopeV1` DTO stream. Every value type here is derived from `core/protocol`'s
 * closed DTOs — mostly via indexed access into `EventPayloadByKindV1`, so a contract change
 * to an event payload surfaces as a compile error here rather than silent drift.
 *
 * `CapabilityState`/`CapabilityEntry` come from the event payload placeholder shapes
 * (`kernel.capabilitiesChanged`) rather than `core/capabilities` internals — that is the
 * exact type the UI receives on the wire, and `ui` may not import `core/capabilities`.
 */

/** A capability entry as `kernel.snapshot`/`kernel.capabilitiesChanged` carry it. */
export type CapabilityEntry = EventPayloadByKindV1["kernel.capabilitiesChanged"]["changed"][number];
/** `{ available: true } | { available: false; reasons: [...] }` — the UI row-enable input. */
export type CapabilityState = CapabilityEntry["state"];

/** Whole normalized turn-progress content union (reasoning | tool | final | usage | error). */
export type TurnProgressContent = EventPayloadByKindV1["turn.progress"]["content"];
/**
 * One entry in the turn's SINGLE ordered timeline — the design's `genTurn`
 * (`design/termcraft-engine.js:515-548`) returns exactly this: one array of `{status}` and
 * `{think}` entries in the order they happened.
 *
 * Two parallel collections (`steps[]` plus a one-slot `reasoning` ticker) could not express it:
 * only the latest thought survived, and its position relative to the tool calls was destroyed on
 * arrival. Merging them makes ordering hold BY CONSTRUCTION rather than by reconciling two lists.
 */
export type TurnTimelineEntry =
  | Readonly<{ kind: "step"; op: string; target: string }>
  | Readonly<{ kind: "reasoning"; text: string }>;
/** Normalized token usage — drives the composer ctx% indicator. */
export type TurnUsage = Extract<TurnProgressContent, { kind: "usage" }>["tokens"];
/** The terminal turn payload (`turn.completed`/`failed`/`cancelled` share it). */
export type TurnTerminalPayload = EventPayloadByKindV1["turn.completed"];
/** Bounded Gate diagnostics carried on a `turn.gateRejected`. */
export type TurnGateDiagnostics = EventPayloadByKindV1["turn.gateRejected"]["diagnostics"];

/** The project identity/active-selection slice, seeded from `kernel.snapshot`. */
export interface ProjectMirror {
  readonly projectId: UUIDv7 | null;
  readonly activePageSlug: string | null;
  readonly activeChatId: UUIDv7 | null;
  readonly trust: "trusted" | "untrusted-read-only" | null;
}

/** The turn slice — the ephemeral agent status block reads this. */
export type TurnMirror =
  | Readonly<{ phase: "idle" }>
  | Readonly<{
      phase: "running";
      turnId: UUIDv7;
      attempt: number;
      /**
       * `null` for the brief admission window before the real bound is known (fix-bundle
       * Task 11 fix round 1, Finding 2) — `kernel.turn.beginAdmission` carries only the
       * turn's id, never a deadline; `turn.started`'s own handler (below) always overwrites
       * this with the real absolute bound moments later. Nothing in production renders this
       * field, so the transient `null` never reaches the screen — it exists only so this
       * union member's own honesty holds at every moment a subscriber could observe it.
       */
      deadline: string | null;
      /** Tool steps and reasoning blocks in one arrival-ordered list — see {@link TurnTimelineEntry}. */
      timeline: readonly TurnTimelineEntry[];
      /**
       * When this turn FIRST became `running`, in ms from the UI's own clock. Seeded by
       * whichever event establishes that first — usually `kernel.turn.beginAdmission` (Task 11),
       * since it fires before `turn.started`; but `turn.started` seeds it itself when a turn
       * reaches the mirror with no preceding admission fold. Once set for a `turnId`, later
       * events for that SAME turn (`turn.started` overwriting the fold, `turn.attemptStarted` on
       * a retry) preserve it rather than reseeding — reseeding would make the elapsed-time
       * spinner visibly jump backwards mid-turn (fix-bundle Task 19 review round 1, Finding 1;
       * see `mirror.ts`'s `seedOrPreserveClock`). The design's long-turn frame shows elapsed time
       * in the spinner (`⠹ generating design… · 2m 40s`, `design/termcraft-engine.js:547`), but
       * no Kernel event carries a "started at" fact — `turn.started` carries only an absolute
       * `deadline` — so elapsed is derived client-side from this. It is honestly the UI's own
       * clock, not a Kernel fact, which is why it is named as new mirror state rather than
       * smuggled in as a payload field.
       */
      startedAt: number;
      finalText: string | null;
      errorText: string | null;
      usage: TurnUsage | null;
      /** One entry per Gate rejection in this turn (`✗ … retry 1/3`, `2/3`, `3/3`). */
      gateRetries: readonly Readonly<{ retryNumber: number; diagnostics: TurnGateDiagnostics }>[];
    }>
  | Readonly<{
      phase: "terminal";
      turnId: UUIDv7;
      outcome: TurnTerminalPayload["outcome"];
      changedPages: TurnTerminalPayload["changedPages"];
      warnings: TurnTerminalPayload["warnings"];
      failure: FailureDtoV1 | null;
    }>;

/** The preview slice — session metadata + failure/circuit. Frames flow via `PreviewSession`, not here. */
export type PreviewMirror =
  | Readonly<{ phase: "none" }>
  | Readonly<{
      phase: "ready";
      previewSessionId: UUIDv7;
      pageSlug: string;
      sourceHash: Sha256Hex;
      size: Readonly<{ w: number; h: number }>;
      interactionMode: "static" | "interactive";
      theme: string;
    }>
  | Readonly<{
      phase: "failed";
      previewSessionId: UUIDv7;
      pageSlug: string;
      sourceHash: Sha256Hex;
      lifecycle: "starting" | "switching" | "live";
      failure: FailureDtoV1;
    }>
  | Readonly<{
      phase: "circuit-open";
      previewSessionId: UUIDv7;
      pageSlug: string;
      attempts: number;
      finalFailure: FailureDtoV1;
      retryAvailable: boolean;
    }>;

/** A chat summary as `chat.changed` carries it. */
export type ChatSummary = EventPayloadByKindV1["chat.changed"]["added"][number];

/** The chats slice. */
export interface ChatsMirror {
  readonly activeChatId: UUIDv7 | null;
  readonly summaries: ReadonlyMap<UUIDv7, ChatSummary>;
}

/**
 * One persisted chat record as `chat.records` carries it (WP-10 Task 7) — the closed,
 * DTO-derived `ChatRecordDtoV1` union (`core/protocol/model/chat-record.ts`), reached the
 * same way every other mirror slice reaches its wire shape: indexed access into
 * `EventPayloadByKindV1`, never a re-declared or cast copy.
 */
export type ChatRecord = EventPayloadByKindV1["chat.records"]["records"][number];

/** The selection slice — the `selection.changed` DTO or null. */
export type SelectionMirror = EventPayloadByKindV1["selection.changed"];

/**
 * The export slice — the export-feedback popup and status refusal read this. The `failed`
 * variant retains the `pageSlug`/`sizeBytes` from the last `export.progress` before the
 * terminal transition (M14): `export.failed`'s own payload (`ExportTerminalPayloadV1`) carries
 * neither, so without retention the failure popup could not name the page it failed on.
 */
export type ExportMirror =
  | Readonly<{ phase: "idle" }>
  | Readonly<{
      phase: "running";
      operationId: UUIDv7;
      lifecycle: EventPayloadByKindV1["export.progress"]["phase"];
      completedJobs: number;
      totalJobs: number;
      pageSlug: string | null;
      sizeBytes: number | null;
    }>
  | Readonly<{
      phase: "done";
      operationId: UUIDv7;
      destination: string;
      generationId: UUIDv7 | null;
    }>
  | Readonly<{
      phase: "failed";
      operationId: UUIDv7;
      failure: FailureDtoV1 | null;
      pageSlug: string | null;
      sizeBytes: number | null;
    }>;

/** The screen the app root mounts (phase-7 plan D6 — UI-derived until the typed snapshot lands). */
export type ScreenKind = "home" | "trust-prompt" | "workspace" | "read-only" | "enlarge";

/**
 * The agent-identity slice a `kernel.snapshot` carries (M22) — `{ backendId, modelLabel } |
 * null`, derived structurally from the snapshot payload (no cast). `null` means no backend is
 * selected yet (e.g. pre-`ready`, or before `model.select` has run); the UI renders that as the
 * design-sourced neutral empty text, never an invented fallback identity (see `Workspace`'s
 * divergence comment).
 */
export type AgentIdentity = EventPayloadByKindV1["kernel.snapshot"]["agentIdentity"];

export type { CommandKindV1, DiagnosticDtoV1, PageDescriptorV1, PinDtoV1 };
