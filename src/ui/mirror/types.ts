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
/** One agent tool step (`✓`/`▸` line in the ephemeral block) — `{ kind:"tool", op, target }`. */
export type TurnToolStep = Extract<TurnProgressContent, { kind: "tool" }>;
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
      deadline: string;
      /** Tool steps in arrival order — the last is the active (`▸`) step, earlier ones done (`✓`). */
      steps: readonly TurnToolStep[];
      /** The latest reasoning-ticker line (a ticker, not a log — design §3.2). */
      reasoning: string | null;
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
