import type { PageSlug } from "entities/page";

/**
 * The portable target stack (storage-identity §5.1). It lives in `project.toml`, not in a
 * `config.toml` — the first shipped layout has no `config.toml` at all.
 */
export type TargetStack = "rust-ratatui" | "go-bubbletea" | "js-opentui" | "generic";

/** Every valid `target_stack` value, in the order storage-identity §5.1 lists them. */
export const TARGET_STACKS = ["rust-ratatui", "go-bubbletea", "js-opentui", "generic"] as const;

/**
 * `.termcraft/project.toml` — the PORTABLE project state (storage-identity §5.1), with
 * `format_version = 1` and exactly these five semantic fields. It deliberately carries no
 * active page, active chat, backend, model, effort, preview/UI setting, agent session id,
 * Git status, page title, `minSize`, theme, source hash, or extracted page metadata, so
 * changing machines never produces a workspace-navigation or backend-preference diff
 * (§5.1, §16.1). Everything omitted here lives in {@link WorkspaceLocalState}.
 */
export interface ProjectManifest {
  readonly formatVersion: 1;
  readonly projectId: string;
  readonly name: string;
  /** UTC RFC 3339. */
  readonly createdAt: string;
  readonly targetStack: TargetStack;
  /** Ordered and duplicate-free: listing and tab order, NOT page identity allocation (§5.1). */
  readonly pages: readonly PageSlug[];
}

/** Preview size mode (storage-identity §6.1; master design §8.1 item 10). */
export type PreviewSizeMode = "auto" | "preset" | "custom";

/**
 * The two shipped size presets, named exactly as master design §8.1 item 10 pins them
 * (80×24 and 120×40). Storage §6.1 names the `preset` mode but not which preset is
 * selected, so the preset id itself comes from the design spec.
 */
export type PreviewSizePreset = "80x24" | "120x40";

/** Every valid `preview_size_preset` value. */
export const PREVIEW_SIZE_PRESETS = ["80x24", "120x40"] as const;

/**
 * Preview color-capability simulation (storage-identity §6.1). The three simulated tiers
 * are named by master design §8.1 item 9 / §5.4 ("truecolor/256/16"); `null` means no
 * simulation — the terminal's real capability is used.
 */
export type ColorCapability = "truecolor" | "256" | "16";

/** Every valid `color_capability` value. */
export const COLOR_CAPABILITIES = ["truecolor", "256", "16"] as const;

/** Static preview vs. the interactive prototype (storage-identity §6.1; design §3.5/§8.1 item 11). */
export type RenderMode = "static" | "interactive";

/**
 * One `(chatId, sessionScopeId)` session checkpoint (storage-identity §6.2). `prefixHash`
 * is SHA-256 over the exact UTF-8 bytes of the chat header line plus `recordCount` record
 * lines, each including its terminating LF. Machine-local only: a checkpoint never enters
 * portable state.
 */
export interface SessionCheckpoint {
  readonly chatId: string;
  /** Backend-supplied opaque scope discriminator; never a credential or raw vendor session id (§6.2). */
  readonly sessionScopeId: string;
  /** The backend's opaque session id (§6.2). */
  readonly sessionId: string;
  /** Complete records after the chat header that the session is known to reflect. */
  readonly recordCount: number;
  /** Lowercase-hex SHA-256 of the exact prefix bytes. */
  readonly prefixHash: string;
}

/**
 * The optional typed local resource-limit overrides storage-identity §6.1 delegates to the
 * projections/scale design. Every key is absent by default (the compiled default applies);
 * an unknown key or an out-of-range value is INVALID rather than silently accepted (§6.1).
 * Ranges are the projections §16.1 limit table:
 *
 * - `diagnosticsQuotaBytes` — default 128 MiB, 32–512 MiB (projections §6.2).
 * - `renderCacheQuotaBytes` — default 512 MiB, 64 MiB–4 GiB (projections §10.2).
 * - `exportWorkers` — computed default, 1–8 (projections §10.1).
 * - `previewFps` — default 30, 1–60 (projections §11).
 * - `operationsLogSegmentBytes` — default 5 MiB, 1–20 MiB (projections §13).
 * - `operationsLogRetentionSegments` — default 5, 2–10 (projections §13).
 * - `silenceTimeoutSeconds` — default 120, 30–600 (projections §12).
 * - `absoluteTurnDeadlineMinutes` — default 30, 10–60 (projections §12).
 */
export interface ResourceLimitOverrides {
  readonly diagnosticsQuotaBytes?: number;
  readonly renderCacheQuotaBytes?: number;
  readonly exportWorkers?: number;
  readonly previewFps?: number;
  readonly operationsLogSegmentBytes?: number;
  readonly operationsLogRetentionSegments?: number;
  readonly silenceTimeoutSeconds?: number;
  readonly absoluteTurnDeadlineMinutes?: number;
}

/**
 * `.termcraft/workspace.local.toml` — the MACHINE-LOCAL workspace state
 * (storage-identity §6.1), with its own `format_version = 1`. It is hard-excluded from
 * every Git commit scope (§13) and is never copied into portable state.
 *
 * Composer drafts, focus, open popups, selection, transient errors, context-usage
 * telemetry, and Git status are deliberately NOT persisted (§6.1). Pins stay portable
 * events in each page's comments log.
 *
 * KEY SPELLINGS: §6.1 enumerates these fields in prose and fixes no TOML key names. The
 * serialized names are `snake_case` transliterations of that prose, chosen here and
 * documented per field in `model/workspace-toml.ts`; no external consumer constrains them
 * in phase 4.
 */
export interface WorkspaceLocalState {
  readonly formatVersion: 1;
  /** `null` = unset; the caller falls back to the first listed page (§6.1). */
  readonly activePageSlug: PageSlug | null;
  /** `null` = unset; the caller falls back to the newest valid chat by header `createdAt` (§6.1). */
  readonly activeChatId: string | null;
  /** Backend-owned validated strings (§6.1); `null` = the compiled default applies. */
  readonly backend: string | null;
  readonly model: string | null;
  readonly effort: string | null;
  readonly previewSizeMode: PreviewSizeMode;
  /** Present only when `previewSizeMode === "preset"`. */
  readonly previewSizePreset: PreviewSizePreset | null;
  /** Present only when `previewSizeMode === "custom"`. */
  readonly previewCustomWidth: number | null;
  readonly previewCustomHeight: number | null;
  /** Non-persistent-at-page-level theme override (§6.1; design §5.4). */
  readonly themeOverride: string | null;
  readonly colorCapability: ColorCapability | null;
  readonly renderMode: RenderMode;
  readonly fullscreenPreview: boolean;
  readonly sessionCheckpoints: readonly SessionCheckpoint[];
  readonly resourceLimits: ResourceLimitOverrides;
}
