/** @jsxImportSource @opentui/react */
import { Text } from "./text"

/** A single table column descriptor (design-system §3.2). */
export interface TableColumn {
  /** Stable per-column id; composes into each cell's Text id. */
  readonly id: string
  /** The header-row label. */
  readonly label: string
  /** Fixed cell width in columns; cells pad/truncate to it when set. */
  readonly width?: number
}

/** A single table data row (design-system §3.2). */
export interface TableRow {
  /** Stable per-row id; composes into each cell's Text id. */
  readonly id: string
  /** Cell strings positional to `columns`; missing cells render empty. */
  readonly cells: readonly string[]
}

/** Props for the themed `Table` component. `id` is the mandatory stable id (§3.2). */
export interface TableProps {
  readonly id: string
  readonly columns: readonly TableColumn[]
  readonly rows: readonly TableRow[]
}

/**
 * Fit a cell string to a fixed column width: truncate when longer, pad with
 * trailing spaces when shorter, pass through untouched when no width is set.
 * Keeps columns aligned across the header and every data row.
 */
function fit(value: string, width: number | undefined): string {
  if (width === undefined) return value
  if (value.length > width) return value.slice(0, width)
  return value.padEnd(width, " ")
}

/**
 * A columnar table of themed cells (design-system §3.2). Composes a `column` box
 * of `row` boxes: a bold header row of column labels followed by one row per data
 * row, each cell a `Text` fit to its column width. Rows and cells carry stable
 * `${id}-…` ids so the host can answer geometry queries and the shell can select
 * or pin an individual row.
 */
export function Table(props: TableProps) {
  return (
    <box id={props.id} flexDirection="column">
      <box id={`${props.id}-header`} flexDirection="row" gap={1}>
        {props.columns.map((column) => (
          // keyed intrinsic wrapper — function components carry no `key` in this
          // repo's no-@types/react environment (runtime-api §3.3); the box takes it.
          <box key={column.id}>
            <Text id={`${props.id}-header-${column.id}`} bold>
              {fit(column.label, column.width)}
            </Text>
          </box>
        ))}
      </box>
      {props.rows.map((row) => (
        <box key={row.id} id={`${props.id}-${row.id}`} flexDirection="row" gap={1}>
          {props.columns.map((column, index) => (
            <box key={column.id}>
              <Text id={`${props.id}-${row.id}-${column.id}`}>
                {fit(row.cells[index] ?? "", column.width)}
              </Text>
            </box>
          ))}
        </box>
      ))}
    </box>
  )
}
