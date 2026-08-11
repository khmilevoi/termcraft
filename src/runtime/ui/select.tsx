import { isExport } from "../model/capabilities";
import { wrap } from "../model/reatom";
import { activeTokens } from "../model/tokens";

/** One selectable row in a `Select` (spec §6.1). */
export interface SelectItem {
  /** Stable per-item id; what `onSelect`/`onHighlight` report. */
  readonly id: string;
  /** The rendered row label. */
  readonly label: string;
}

/** Props for the themed `Select` component. `id` is the mandatory stable id (§3.2). */
export interface SelectProps {
  /** Stable id the host answers geometry on and the shell selects/pins. Mandatory. */
  readonly id: string;
  /** The choices, in display order. */
  readonly items: readonly SelectItem[];
  /**
   * The highlighted item's id. A `Select` is a CURSOR, not an optional highlight: an absent or
   * unmatched id lands on the first item, unlike `List`, where no `selectedId` means no
   * selection band at all.
   */
  readonly selectedId?: string;
  /** Whether the list holds keyboard focus. Always false under export (§6.3). */
  readonly focused?: boolean;
  /** Viewport height in rows; defaults to the item count (one row per item). */
  readonly height?: number;
  /** Invoked with an item id when the cursor MOVES onto it (the intrinsic's `onChange`). */
  readonly onHighlight?: (id: string) => void;
  /** Invoked with an item id when it is COMMITTED (the intrinsic's `onSelect`, i.e. Enter). */
  readonly onSelect?: (id: string) => void;
}

/**
 * Themed single-choice list (design-system §3.2, spec §6.1). Renders one OpenTUI `<select>`,
 * one line per item, with the design's selection recipe: a `selection` back-fill and
 * `selectionFg` text on the cursor row (`design/termcraft-engine.js:499-503`, the agent/model
 * picker), `foreground` on the rest, over the terminal `background`. A focused list lifts its
 * body onto `surface` — the role its own definition calls the "lifted input body" fill; the
 * design ships no screen of an authored page's focused select, so that is a MAPPING onto
 * existing vocabulary, recorded here rather than invented as a new hue.
 *
 * CONTROLLED, WITH NO REF. `SelectRenderable`'s `selectedIndex` and `options` setters both clamp
 * and emit nothing (measured against `@opentui/core@0.4.5`), so re-passing them every render can
 * never loop back into `onHighlight`. `options` is written before `selectedIndex` so the clamp
 * sees the new list.
 *
 * DIVERGENCE, STATED RATHER THAN SILENTLY SUBSTITUTED: the cursor marker is OpenTUI's own `▶ `
 * (U+25B6). The design's marker is `▸` (U+25B8) — the glyph `List` and `Tabs` render — but
 * `SelectRenderableOptions` exposes no marker character. Descriptions are off (upstream defaults
 * them ON, which would paint a blank line per item) and the scroll indicator is off (upstream
 * draws it in a hard-coded `#666666` that no theme can reach).
 *
 * EXPORT DETERMINISM (§6.3): under `hostMode === "export"` the widget is blurred and its focused
 * fill collapses onto the unfocused one, so the frame is a function of `items` + `selectedId`
 * alone.
 */
export function Select(props: SelectProps) {
  const tokens = activeTokens();
  const exporting = isExport();
  const items = props.items;
  const found = items.findIndex((item) => item.id === props.selectedId);
  const selectedIndex = found < 0 ? 0 : found;
  const onHighlight = props.onHighlight;
  const onSelect = props.onSelect;
  // `wrap` restores the Reatom frame the terminal event loop drops (spec §6, RTM-C02). The
  // intrinsic passes `(index, option)`; the id is resolved from `items` rather than from
  // `option.value`, which upstream types as `any`.
  const handleHighlight =
    onHighlight === undefined
      ? undefined
      : wrap((index: number) => {
          const item = items[index];
          if (item !== undefined) onHighlight(item.id);
        });
  const handleSelect =
    onSelect === undefined
      ? undefined
      : wrap((index: number) => {
          const item = items[index];
          if (item !== undefined) onSelect(item.id);
        });
  return (
    <select
      id={props.id}
      height={props.height ?? items.length}
      // BEFORE `selectedIndex`: the `options` setter clamps the stored index against the NEW
      // list, so writing the list first is what makes an index into a shrunk list land safely.
      options={items.map((item) => ({ name: item.label, description: "" }))}
      selectedIndex={selectedIndex}
      // §6.3: blurred under export. `@opentui/react` turns a falsy `focused` into `blur()`.
      focused={exporting ? false : props.focused}
      showDescription={false}
      showScrollIndicator={false}
      showSelectionIndicator
      itemSpacing={0}
      wrapSelection={false}
      backgroundColor={tokens.background}
      textColor={tokens.foreground}
      // §6.3, the second half of "nothing focused": the focused fill collapses onto the
      // unfocused one under export, so the guarantee holds in the FRAME and not only in the
      // focus call above.
      focusedBackgroundColor={exporting ? tokens.background : tokens.surface}
      focusedTextColor={tokens.foreground}
      selectedBackgroundColor={tokens.selection}
      selectedTextColor={tokens.selectionFg}
      descriptionColor={tokens.foregroundMuted}
      selectedDescriptionColor={tokens.selectionFg}
      onChange={handleHighlight}
      onSelect={handleSelect}
    />
  );
}
