import * as errore from "errore"
import { z } from "zod"

import { pageSlugSchema } from "entities/page"
import { canonicalUuidv7Schema } from "infrastructure/uuid"
import { COLOR_CAPABILITIES, PREVIEW_SIZE_PRESETS } from "../types"
import type { ResourceLimitOverrides, SessionCheckpoint, WorkspaceLocalState } from "../types"
import { parseToml, readFormatVersion, tomlLine } from "./project-toml"

/** The machine-local state file's name inside `.termcraft/` (storage-identity §6.1). */
export const WORKSPACE_STATE_FILENAME = "workspace.local.toml"

/** `workspace.local.toml` carries its OWN format counter, independent of `project.toml` (§12). */
export const WORKSPACE_STATE_FORMAT_VERSION = 1

/**
 * `workspace.local.toml` is unreadable: not TOML, a bad `format_version`, an unknown key,
 * or an out-of-range value (storage-identity §6.1 — "Unknown keys or out-of-range values
 * are invalid rather than silently accepted"). Per §6.1 the corrupt file is PRESERVED and
 * REPORTED while in-memory defaults are used; see {@link loadWorkspaceLocalState}.
 */
export class WorkspaceStateCorruptError extends errore.createTaggedError({
  name: "WorkspaceStateCorruptError",
  message: "$file is not valid local workspace state [$code]: $reason",
}) {}

/**
 * `workspace.local.toml` declares a newer `format_version` than this binary supports
 * (storage-identity §12). {@link decodeWorkspaceLocalState} surfaces it as its own tagged
 * error so a caller that wants §12's hard-stop treatment can distinguish it from ordinary
 * corruption; {@link loadWorkspaceLocalState} folds it into the §6.1 preserve-and-default
 * path, because §6.1 governs this specific file and machine-local navigation preferences
 * must never block opening a project whose PORTABLE state is perfectly readable.
 */
export class WorkspaceStateTooNewError extends errore.createTaggedError({
  name: "WorkspaceStateTooNewError",
  message: "$file has format_version $found, newer than the supported version $supported",
}) {}

const KiB = 1024
const MiB = 1024 * KiB
const GiB = 1024 * MiB

/**
 * The §6.1 resource-limit override ranges, sourced from the projections/scale design's
 * §16.1 limit table (§6.1 delegates the key set and the ranges to that design). Each entry
 * is `[serialized snake_case key, minimum, maximum]`; every bound is inclusive.
 */
const RESOURCE_LIMIT_RANGES = {
  diagnosticsQuotaBytes: ["diagnostics_quota_bytes", 32 * MiB, 512 * MiB], // projections §6.2
  renderCacheQuotaBytes: ["render_cache_quota_bytes", 64 * MiB, 4 * GiB], // projections §10.2
  exportWorkers: ["export_workers", 1, 8], // projections §10.1
  previewFps: ["preview_fps", 1, 60], // projections §11
  operationsLogSegmentBytes: ["operations_log_segment_bytes", 1 * MiB, 20 * MiB], // projections §13
  operationsLogRetentionSegments: ["operations_log_retention_segments", 2, 10], // projections §13
  silenceTimeoutSeconds: ["silence_timeout_seconds", 30, 600], // projections §12
  absoluteTurnDeadlineMinutes: ["absolute_turn_deadline_minutes", 10, 60], // projections §12
} as const satisfies Record<keyof ResourceLimitOverrides, readonly [string, number, number]>

type ResourceLimitKey = keyof typeof RESOURCE_LIMIT_RANGES

const RESOURCE_LIMIT_KEYS = Object.keys(RESOURCE_LIMIT_RANGES) as readonly ResourceLimitKey[]

/**
 * An in-range integer override. Zero, negative, fractional, and out-of-range values are
 * all rejected, which is what makes it impossible to disable either mandatory turn timer
 * through local configuration (projections §12).
 */
function overrideSchema(key: ResourceLimitKey) {
  const [, min, max] = RESOURCE_LIMIT_RANGES[key]
  return z.number().int().min(min).max(max).optional()
}

const resourceLimitsSchema = z.strictObject({
  diagnostics_quota_bytes: overrideSchema("diagnosticsQuotaBytes"),
  render_cache_quota_bytes: overrideSchema("renderCacheQuotaBytes"),
  export_workers: overrideSchema("exportWorkers"),
  preview_fps: overrideSchema("previewFps"),
  operations_log_segment_bytes: overrideSchema("operationsLogSegmentBytes"),
  operations_log_retention_segments: overrideSchema("operationsLogRetentionSegments"),
  silence_timeout_seconds: overrideSchema("silenceTimeoutSeconds"),
  absolute_turn_deadline_minutes: overrideSchema("absoluteTurnDeadlineMinutes"),
})

/** Lowercase-hex SHA-256, the form every termcraft digest is written in (storage-identity §8, §6.2). */
const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/, { error: "must be a lowercase-hex SHA-256 digest" })

const sessionCheckpointSchema = z.strictObject({
  chat_id: canonicalUuidv7Schema,
  // §6.2: the scope is a backend-supplied opaque discriminator. It is deliberately not
  // pattern-constrained — no credential or vendor session id may enter it, but its shape
  // belongs to the backend adapter.
  session_scope_id: z.string().min(1),
  session_id: z.string().min(1),
  record_count: z.number().int().min(0),
  prefix_hash: sha256HexSchema,
})

/**
 * The §6.1 local field set. KEY SPELLINGS: §6.1 enumerates these in prose and pins no TOML
 * key names, so each is a `snake_case` transliteration of the prose phrase it comes from:
 *
 * - `active_page_slug` / `active_chat_id` — "optional `active_page_slug` and `active_chat_id`"
 *   (the only two §6.1 spells out verbatim).
 * - `backend` / `model` / `effort` — "backend, model, and effort selections as
 *   backend-owned validated strings".
 * - `preview_size_mode`, `preview_custom_width`, `preview_custom_height` — "preview size
 *   mode (`auto`, `preset`, or `custom`), custom width and height when the mode is
 *   `custom`".
 * - `preview_size_preset` — §6.1 names the `preset` MODE but never says which preset is
 *   selected. SPEC GAP: the mode is unusable without the selection, so the key is added
 *   here and its value domain is taken from master design §8.1 item 10 (80×24 and 120×40),
 *   the design-side source of truth for the preset ladder.
 * - `theme_override` — "theme override".
 * - `color_capability` — "color-capability simulation"; values from design §8.1 item 9
 *   ("16/256/truecolor simulation"). Absent = no simulation.
 * - `render_mode` — "static or interactive mode"; the default is `static` because
 *   interactive is entered explicitly with `F4` (design §8.1 item 11).
 * - `fullscreen_preview` — "whether fullscreen preview was active".
 * - `session_checkpoints` — "zero or more session checkpoints defined in §6.2".
 * - `resource_limits` — "optional typed local resource-limit overrides owned by the
 *   projections/scale design".
 *
 * `strictObject` throughout implements §6.1's "Unknown keys ... are invalid rather than
 * silently accepted". Composer drafts, focus, open popups, selection, transient errors,
 * context-usage telemetry, and Git status therefore cannot be smuggled in.
 */
const workspaceStateSchema = z
  .strictObject({
    format_version: z.literal(WORKSPACE_STATE_FORMAT_VERSION),
    active_page_slug: pageSlugSchema.optional(),
    active_chat_id: canonicalUuidv7Schema.optional(),
    backend: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    effort: z.string().min(1).optional(),
    preview_size_mode: z.enum(["auto", "preset", "custom"]).optional(),
    preview_size_preset: z.enum(PREVIEW_SIZE_PRESETS).optional(),
    // Bounded by the projections §11 protocol hard maximum of 2,048 cells per axis; the
    // negotiated ceiling (512×256 by default) is enforced at preview-negotiation time, not
    // in persisted state, so a saved custom size survives a ceiling change.
    preview_custom_width: z.number().int().min(1).max(2048).optional(),
    preview_custom_height: z.number().int().min(1).max(2048).optional(),
    theme_override: z.string().min(1).optional(),
    color_capability: z.enum(COLOR_CAPABILITIES).optional(),
    render_mode: z.enum(["static", "interactive"]).optional(),
    fullscreen_preview: z.boolean().optional(),
    resource_limits: resourceLimitsSchema.optional(),
    session_checkpoints: z.array(sessionCheckpointSchema).optional(),
  })
  .superRefine((state, ctx) => {
    if (state.preview_size_mode === "custom" && (state.preview_custom_width === undefined || state.preview_custom_height === undefined)) {
      ctx.addIssue({ code: "custom", message: "`custom` preview size mode requires both `preview_custom_width` and `preview_custom_height`" })
    }
    if (state.preview_size_mode === "preset" && state.preview_size_preset === undefined) {
      ctx.addIssue({ code: "custom", message: "`preset` preview size mode requires `preview_size_preset`" })
    }
  })

/**
 * The deterministic defaults §6.1 mandates when `workspace.local.toml` is absent or
 * unusable. Every navigation field is `null` rather than guessed: §6.1's "first listed page
 * / newest valid chat by header `createdAt`" fallback needs the PORTABLE manifest and the
 * chat headers, which this module never reads — resolving it here would be exactly the
 * portable/local coupling §5.1 forbids. The caller resolves `null` against portable state.
 */
export function defaultWorkspaceLocalState(): WorkspaceLocalState {
  return {
    formatVersion: WORKSPACE_STATE_FORMAT_VERSION,
    activePageSlug: null,
    activeChatId: null,
    backend: null,
    model: null,
    effort: null,
    previewSizeMode: "auto",
    previewSizePreset: null,
    previewCustomWidth: null,
    previewCustomHeight: null,
    themeOverride: null,
    colorCapability: null,
    renderMode: "static",
    fullscreenPreview: false,
    sessionCheckpoints: [],
    resourceLimits: {},
  }
}

/** Emit `key = value` only when the value is set; an unset local choice is an ABSENT key, never a sentinel. */
function optionalLine(key: string, value: string | number | null): readonly string[] {
  if (value === null) return []
  return [tomlLine(key, value)]
}

/** The `[resource_limits]` sub-table, emitted only when at least one override is set. */
function resourceLimitLines(limits: ResourceLimitOverrides): readonly string[] {
  const entries = RESOURCE_LIMIT_KEYS.flatMap((key) => {
    const value = limits[key]
    if (value === undefined) return []
    return [tomlLine(RESOURCE_LIMIT_RANGES[key][0], value)]
  })
  if (entries.length === 0) return []
  return ["", "[resource_limits]", ...entries]
}

/** One `[[session_checkpoints]]` array-of-tables entry per checkpoint, in list order. */
function sessionCheckpointLines(checkpoints: readonly SessionCheckpoint[]): readonly string[] {
  return checkpoints.flatMap((checkpoint) => [
    "",
    "[[session_checkpoints]]",
    tomlLine("chat_id", checkpoint.chatId),
    tomlLine("session_scope_id", checkpoint.sessionScopeId),
    tomlLine("session_id", checkpoint.sessionId),
    tomlLine("record_count", checkpoint.recordCount),
    tomlLine("prefix_hash", checkpoint.prefixHash),
  ])
}

/**
 * Serialize machine-local workspace state as `.termcraft/workspace.local.toml`
 * (storage-identity §6.1). Deterministic: fixed key order, unset fields omitted, sub-table
 * and array-of-tables sections last so a scalar edit never reorders the file. This file is
 * hard-excluded from every Git commit scope (§13), so its diff shape is a local-tooling
 * concern only.
 */
export function encodeWorkspaceLocalState(state: WorkspaceLocalState): string {
  return [
    tomlLine("format_version", state.formatVersion),
    ...optionalLine("active_page_slug", state.activePageSlug),
    ...optionalLine("active_chat_id", state.activeChatId),
    ...optionalLine("backend", state.backend),
    ...optionalLine("model", state.model),
    ...optionalLine("effort", state.effort),
    tomlLine("preview_size_mode", state.previewSizeMode),
    ...optionalLine("preview_size_preset", state.previewSizePreset),
    ...optionalLine("preview_custom_width", state.previewCustomWidth),
    ...optionalLine("preview_custom_height", state.previewCustomHeight),
    ...optionalLine("theme_override", state.themeOverride),
    ...optionalLine("color_capability", state.colorCapability),
    tomlLine("render_mode", state.renderMode),
    tomlLine("fullscreen_preview", state.fullscreenPreview),
    ...resourceLimitLines(state.resourceLimits),
    ...sessionCheckpointLines(state.sessionCheckpoints),
    "",
  ].join("\n")
}

/** Maps the first Zod issue onto a `WorkspaceStateCorruptError`. */
function toCorruptError(file: string, error: z.ZodError): WorkspaceStateCorruptError {
  const issue = error.issues[0]
  const code = issue !== undefined && issue.path.length > 0 ? issue.path.join(".") : "SHAPE"
  return new WorkspaceStateCorruptError({ file, code, reason: issue?.message ?? "invalid input" })
}

/** Narrow the parsed `[resource_limits]` table back to the camelCase override record. */
function toResourceLimits(table: z.infer<typeof resourceLimitsSchema> | undefined): ResourceLimitOverrides {
  if (table === undefined) return {}
  return Object.fromEntries(
    RESOURCE_LIMIT_KEYS.flatMap((key) => {
      const value = table[RESOURCE_LIMIT_RANGES[key][0]]
      if (value === undefined) return []
      return [[key, value] as const]
    }),
  )
}

/**
 * Parse and validate `.termcraft/workspace.local.toml` (storage-identity §6.1). Same
 * ordering as the portable manifest: TOML parse, then the `format_version` gate, then the
 * strict field schema. This is the STRICT decoder — most callers want
 * {@link loadWorkspaceLocalState}, which applies §6.1's preserve-and-default policy.
 */
export function decodeWorkspaceLocalState(
  text: string,
  file: string = WORKSPACE_STATE_FILENAME,
): WorkspaceLocalState | WorkspaceStateCorruptError | WorkspaceStateTooNewError {
  const parsed = parseToml(text)
  if (parsed instanceof Error) {
    return new WorkspaceStateCorruptError({ file, code: "TOML_PARSE", reason: "file is not valid TOML", cause: parsed })
  }

  const version = readFormatVersion(parsed.value)
  if (version === null) {
    return new WorkspaceStateCorruptError({ file, code: "format_version", reason: "missing or non-integer `format_version`" })
  }
  if (version > WORKSPACE_STATE_FORMAT_VERSION) {
    return new WorkspaceStateTooNewError({ file, found: version, supported: WORKSPACE_STATE_FORMAT_VERSION })
  }

  const result = workspaceStateSchema.safeParse(parsed.value)
  if (!result.success) return toCorruptError(file, result.error)

  const data = result.data
  return {
    formatVersion: WORKSPACE_STATE_FORMAT_VERSION,
    activePageSlug: data.active_page_slug ?? null,
    activeChatId: data.active_chat_id ?? null,
    backend: data.backend ?? null,
    model: data.model ?? null,
    effort: data.effort ?? null,
    previewSizeMode: data.preview_size_mode ?? "auto",
    previewSizePreset: data.preview_size_preset ?? null,
    previewCustomWidth: data.preview_custom_width ?? null,
    previewCustomHeight: data.preview_custom_height ?? null,
    themeOverride: data.theme_override ?? null,
    colorCapability: data.color_capability ?? null,
    renderMode: data.render_mode ?? "static",
    fullscreenPreview: data.fullscreen_preview ?? false,
    sessionCheckpoints: (data.session_checkpoints ?? []).map((entry) => ({
      chatId: entry.chat_id,
      sessionScopeId: entry.session_scope_id,
      sessionId: entry.session_id,
      recordCount: entry.record_count,
      prefixHash: entry.prefix_hash,
    })),
    resourceLimits: toResourceLimits(data.resource_limits),
  }
}

/** The outcome of reading `workspace.local.toml` under the §6.1 policy. */
export interface WorkspaceStateLoad {
  /** Always usable: the decoded state, or the deterministic defaults. */
  readonly state: WorkspaceLocalState
  /** `true` when no file existed — defaults apply and nothing is reported (§6.1). */
  readonly missing: boolean
  /**
   * Non-null when the file existed but was unusable. The caller REPORTS this; it must not
   * rewrite, clear, or reset the file — §6.1 preserves it "until the user explicitly
   * resets it".
   */
  readonly corrupt: WorkspaceStateCorruptError | WorkspaceStateTooNewError | null
  /** The exact on-disk text when `corrupt` is set, so a reporter can quote it without re-reading. */
  readonly preservedText: string | null
}

/**
 * Read machine-local workspace state under the storage-identity §6.1 policy.
 *
 * - A MISSING file yields deterministic defaults and touches nothing — in particular it
 *   never writes `project.toml`, so an absent local file cannot produce a portable diff.
 * - A CORRUPT (or too-new) file is preserved and reported while in-memory defaults are
 *   used. Preservation is structural here: this function is pure, so there is no code path
 *   through which it could rewrite or delete the file.
 * - Nothing decoded from this file is ever copied into portable state: the two decoders
 *   share no field, and `project.toml`'s strict schema rejects every local key.
 *
 * It is pure by design (`text` in, value out) — the impure read belongs to the caller's
 * `SafeProjectFs`, which owns the managed-path rules.
 */
export function loadWorkspaceLocalState(input: { readonly text: string | null; readonly file?: string }): WorkspaceStateLoad {
  const file = input.file ?? WORKSPACE_STATE_FILENAME
  if (input.text === null) {
    return { state: defaultWorkspaceLocalState(), missing: true, corrupt: null, preservedText: null }
  }

  const decoded = decodeWorkspaceLocalState(input.text, file)
  if (decoded instanceof Error) {
    return { state: defaultWorkspaceLocalState(), missing: false, corrupt: decoded, preservedText: input.text }
  }

  return { state: decoded, missing: false, corrupt: null, preservedText: null }
}
