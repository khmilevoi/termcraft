/**
 * The design-system picker's view model.
 *
 * DESIGN GAP, FLAGGED (CLAUDE.md: "if the design does not cover a case, ask or flag the gap
 * explicitly — do not guess"). None of the 27 `design/*.dc.html` screens covers browsing or
 * installing a design system, and `design/termcraft-engine.js` has no swatch-row helper. The
 * closest existing vocabulary is `design/06-agent-model-picker.dc.html` — engine `agentPicker`,
 * lines 474–514 — and this module reproduces it exactly: a centred modal in `amber` with an
 * `amberHi` title, a `faint` bold header row, `▸` markers, `●`/`○` state dots, a `sel`/`selFg`
 * selection band, a `├`…`┤` rule, and an `↑↓ select · ⏎ … · esc close` footer. `ChatListPopup`
 * already realizes that vocabulary in code and is the structural model for the component.
 *
 * THE ONE INVENTED ELEMENT IS THE SWATCH ROW, and it is built from vocabulary the engine already
 * uses rather than from a new idea: a run of `█` — the engine's own filled-cell glyph (`bar()`,
 * `termcraft-engine.js:58`) — one cell per token, painted with that token's `#rrggbb`, in the
 * manifest's DECLARATION order (§8.1: "the picker draws a swatch row, and the row's order is the
 * manifest's order — which is why this is an ordered list rather than a record"). Recorded here as
 * a divergence, per CLAUDE.md's rule for a value the design cannot supply.
 */

import type {
  DesignSystemSummaryDtoV1,
  DesignSystemTokenSwatchDtoV1,
  SourceListingDtoV1,
} from "core/protocol";

/** The picker's fixed row capacity — same cap the agent/model picker and `/chats` popup share. */
export const DESIGN_SYSTEM_VIEWPORT_CAP = 6;

/** The engine's own filled-cell glyph (`bar()`, `design/termcraft-engine.js:58`) — one per swatch. */
export const SWATCH_GLYPH = "█";

/** A granted, listed but empty source "says so rather than vanishing" (§8.4) — this is that note. */
export const DESIGN_SYSTEM_EMPTY_NOTE = "no design systems available";

/** One row of the picker's list — either an installable system, or a source's own status. */
export interface DesignSystemRow {
  /** `${sourceId}:${systemId}` for a system row — stable, unique, id-safe. */
  readonly key: string;
  readonly sourceId: string;
  readonly sourceLabel: string;
  /** `null` for a source-status row (ungranted/unavailable/empty). */
  readonly systemId: string | null;
  readonly name: string;
  readonly version: string;
  readonly state: "installable" | "ungranted" | "unavailable" | "empty";
  readonly swatches: readonly DesignSystemTokenSwatchDtoV1[];
  readonly contents: readonly string[];
  readonly note: string | null;
}

/** Builds the one status row a degraded or empty source produces instead of vanishing. */
function statusRow(
  source: SourceListingDtoV1,
  state: "ungranted" | "unavailable" | "empty",
  note: string | null,
): DesignSystemRow {
  return {
    key: `${source.sourceId}:${state}`,
    sourceId: source.sourceId,
    sourceLabel: source.label,
    systemId: null,
    name: source.label,
    version: "",
    state,
    swatches: [],
    contents: [],
    note,
  };
}

/** Builds one installable-system row from its source and summary. */
function installableRow(
  source: SourceListingDtoV1,
  system: DesignSystemSummaryDtoV1,
): DesignSystemRow {
  return {
    key: `${source.sourceId}:${system.id}`,
    sourceId: source.sourceId,
    sourceLabel: source.label,
    systemId: system.id,
    name: system.name,
    version: system.version,
    state: "installable",
    swatches: system.defaultThemeTokens,
    contents: system.componentNames,
    note: null,
  };
}

/** The rows one source contributes: one status row when degraded or empty, else its sorted systems. */
function rowsForSource(source: SourceListingDtoV1): readonly DesignSystemRow[] {
  if (source.state === "ungranted") return [statusRow(source, "ungranted", source.reason)];
  if (source.state === "unavailable") return [statusRow(source, "unavailable", source.reason)];
  if (source.systems.length === 0) return [statusRow(source, "empty", DESIGN_SYSTEM_EMPTY_NOTE)];
  // Sorted by id so the list is stable across runs (§8.1) — the SOURCE order stays exactly the
  // configured order the caller passed in; only the systems INSIDE one source are re-ordered.
  return [...source.systems]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((system) => installableRow(source, system));
}

/**
 * Flattens every configured source into the picker's row list. Sources stay in the caller's own
 * (configured) order; only the systems inside one source are sorted. A source with no listed
 * systems — whether because it is genuinely empty, ungranted, or unavailable — always produces
 * exactly ONE row rather than nothing, so a degraded source stays visible (§8.4).
 */
export function designSystemRows(
  sources: readonly SourceListingDtoV1[],
): readonly DesignSystemRow[] {
  return sources.flatMap(rowsForSource);
}

/** Truncates a swatch row to the cells actually available, keeping the manifest's declaration order. */
export function visibleSwatches(
  swatches: readonly DesignSystemTokenSwatchDtoV1[],
  cells: number,
): readonly DesignSystemTokenSwatchDtoV1[] {
  if (cells <= 0) return [];
  return swatches.slice(0, cells);
}

/**
 * Formats a system's component names for the CONTENTS column, eliding names that do not fit and
 * saying how many were elided rather than silently truncating text mid-name.
 */
export function formatContents(componentNames: readonly string[], width: number): string {
  if (componentNames.length === 0) return "no components";

  const full = componentNames.join(" · ");
  if (full.length <= width) return full;

  for (let count = componentNames.length - 1; count >= 1; count--) {
    const remaining = componentNames.length - count;
    const candidate = `${componentNames.slice(0, count).join(" · ")} +${remaining}`;
    if (candidate.length <= width) return candidate;
  }

  const remaining = componentNames.length - 1;
  return remaining > 0 ? `${componentNames[0]} +${remaining}` : (componentNames[0] ?? "");
}

/**
 * Truncates a fixed-width column value with a trailing `…` when it does not fit, rather than
 * letting it overflow into the next column — the same truncate-with-ellipsis idiom
 * `ChatListPopup.tsx`'s own `formatLabel` uses for its CHAT column, and the one
 * {@link formatContents} above already applies to the CONTENTS column. NAME/VERSION need it too:
 * `String.padEnd` alone never truncates, so an over-long system name used to overflow into the
 * swatch/contents columns instead of clipping (fix round 1, Minor 2 — a real rendering defect,
 * not a cosmetic one, on plausible input).
 */
export function truncateColumn(value: string, width: number): string {
  if (width <= 0) return "";
  if (value.length <= width) return value;
  if (width === 1) return "…";
  return `${value.slice(0, width - 1)}…`;
}

/** Props for the design-system picker overlay (task 9's DTOs feed this through the mirror, task 13). */
export interface DesignSystemPickerProps {
  readonly id: string;
  readonly rows: readonly DesignSystemRow[];
  readonly selectedIndex: number;
  /** Whether the SELECTED row's system may be published back to `local` — gates the `p publish` hint. */
  readonly canPublishSelected: boolean;
  readonly updateNote: string | null;
  /** D7: the Gate pass freezes the shell; this is set before the freeze so "checking…" paints first. */
  readonly busy: boolean;
}
