import { activeTokens } from "../model/tokens";
import { Text } from "./text";

/** A single table column descriptor (design-system §3.2). */
export interface TableColumn {
  /** Stable per-column id; composes into each cell's Text id. */
  readonly id: string;
  /** The header-row label. */
  readonly label: string;
  /** Fixed cell width in columns; cells pad/truncate to it when set. */
  readonly width?: number;
  /** Cell alignment within `width`; numeric columns use `right` (design convention). Defaults to `left`. */
  readonly align?: "left" | "right";
}

/** A single table data row (design-system §3.2). */
export interface TableRow {
  /** Stable per-row id; composes into each cell's Text id. */
  readonly id: string;
  /** Cell strings positional to `columns`; missing cells render empty. */
  readonly cells: readonly string[];
}

/** Props for the themed `Table` component. `id` is the mandatory stable id (§3.2). */
export interface TableProps {
  readonly id: string;
  readonly columns: readonly TableColumn[];
  readonly rows: readonly TableRow[];
  /** The currently selected row id; its row gets the design's selection recipe. */
  readonly selectedId?: string;
}

/**
 * Fit a cell string to a fixed column width: truncate when longer, pad when
 * shorter (trailing for `left`, leading for `right`), pass through untouched when
 * no width is set. Keeps columns aligned across the header and every data row.
 */
function fit(
  value: string,
  width: number | undefined,
  align: "left" | "right" | undefined,
): string {
  if (width === undefined) return value;
  if (value.length > width) return value.slice(0, width);
  return align === "right" ? value.padStart(width, " ") : value.padEnd(width, " ");
}

/**
 * A columnar table of themed cells (design-system §3.2). Composes a `column` box
 * of `row` boxes: a header row of `foregroundMuted` bold column labels (the
 * design's dim header hue), then one row per data row. The selected row follows
 * the design's selection recipe — a `selection` back-fill, a `▸` marker in
 * `accent`, and cells in `selectionFg`; unselected cells are `foreground`. Cells
 * fit to their column width and align left (or right for numeric columns). Rows
 * and cells carry stable `${id}-…` ids for host geometry + shell select/pin.
 */
export function Table(props: TableProps) {
  const tokens = activeTokens();
  return (
    <box id={props.id} flexDirection="column">
      <box id={`${props.id}-header`} flexDirection="row" gap={1}>
        <Text id={`${props.id}-header-marker`} color="foregroundMuted">
          {"  "}
        </Text>
        {props.columns.map((column) => (
          // keyed intrinsic wrapper — function components carry no `key` in this
          // repo's no-@types/react environment (runtime-api §3.3); the box takes it.
          <box key={column.id}>
            <Text id={`${props.id}-header-${column.id}`} color="foregroundMuted" bold>
              {fit(column.label, column.width, column.align)}
            </Text>
          </box>
        ))}
      </box>
      {props.rows.map((row) => {
        const selected = row.id === props.selectedId;
        return (
          <box
            key={row.id}
            id={`${props.id}-${row.id}`}
            flexDirection="row"
            gap={1}
            backgroundColor={selected ? tokens.selection : undefined}
          >
            <Text id={`${props.id}-${row.id}-marker`} color="accent">
              {selected ? "▸ " : "  "}
            </Text>
            {props.columns.map((column, index) => (
              <box key={column.id}>
                <Text
                  id={`${props.id}-${row.id}-${column.id}`}
                  color={selected ? "selectionFg" : "foreground"}
                >
                  {fit(row.cells[index] ?? "", column.width, column.align)}
                </Text>
              </box>
            ))}
          </box>
        );
      })}
    </box>
  );
}
