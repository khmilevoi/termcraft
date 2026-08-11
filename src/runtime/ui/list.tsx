import { activeTokens } from "../model/tokens";
import { Text } from "./text";

/** One selectable row in a `List` (design-system §3.2). */
export interface ListItem {
  /** Stable per-item id; composes into each row's Text id. */
  readonly id: string;
  /** The rendered row label. */
  readonly label: string;
}

/** Props for the themed `List` component. `id` is the mandatory stable id (§3.2). */
export interface ListProps {
  /** Stable id the shell selects/pins on and each row id is derived from. */
  readonly id: string;
  readonly items: readonly ListItem[];
  /** The currently selected item id; its row gets the design's selection recipe. */
  readonly selectedId?: string;
  /** Interactive-path selection callback; inert in a static render. */
  readonly onSelect?: (id: string) => void;
}

/**
 * A vertical list of themed rows (design-system §3.2). Renders a `column` box of
 * one row per item. The selected row follows the design's selection recipe: a
 * `selection` background band, a `▸` (U+25B8) gutter marker in `accent`, and the
 * label in `selectionFg` bold; unselected rows show a blank gutter and a
 * `foreground` label. Each row carries a stable `${id}-${item.id}` so the host can
 * answer geometry queries and the shell can select/pin it. `onSelect` belongs to
 * the interactive path and does nothing here. Colors + marker match the engine.
 */
export function List(props: ListProps) {
  const tokens = activeTokens();
  return (
    <box id={props.id} flexDirection="column">
      {props.items.map((item) => {
        const selected = item.id === props.selectedId;
        // The row box carries the selection back-fill and a keyed intrinsic `key`
        // (function components take no `key` in this repo's no-@types/react env, §3.3).
        return (
          <box
            key={item.id}
            id={`${props.id}-${item.id}-row`}
            flexDirection="row"
            backgroundColor={selected ? tokens.selection : undefined}
          >
            <Text id={`${props.id}-${item.id}-marker`} color={tokens.accent}>
              {selected ? "▸ " : "  "}
            </Text>
            <Text
              id={`${props.id}-${item.id}`}
              color={selected ? tokens.selectionFg : tokens.foreground}
              bold={selected}
            >
              {item.label}
            </Text>
          </box>
        );
      })}
    </box>
  );
}
