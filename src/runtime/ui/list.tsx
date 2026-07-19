/** @jsxImportSource @opentui/react */
import { Text } from "./text"

/** One selectable row in a `List` (design-system §3.2). */
export interface ListItem {
  /** Stable per-item id; composes into each row's Text id. */
  readonly id: string
  /** The rendered row label. */
  readonly label: string
}

/** Props for the themed `List` component. `id` is the mandatory stable id (§3.2). */
export interface ListProps {
  /** Stable id the shell selects/pins on and each row id is derived from. */
  readonly id: string
  readonly items: readonly ListItem[]
  /** The currently selected item id; its row renders bold + `accent`. */
  readonly selectedId?: string
  /** Interactive-path selection callback; inert in a static render. */
  readonly onSelect?: (id: string) => void
}

/**
 * A vertical list of themed rows (design-system §3.2). Renders a `column` box of
 * one `Text` per item; the selected row is bold and `accent`-hued while the rest
 * stay `foreground`. Each row carries a stable `${id}-${item.id}` so the host can
 * answer geometry queries and the shell can select/pin an individual row. The
 * `onSelect` callback belongs to the interactive path and does nothing here.
 */
export function List(props: ListProps) {
  return (
    <box id={props.id} flexDirection="column">
      {props.items.map((item) => {
        const selected = item.id === props.selectedId
        // Wrap the composed Text in a keyed intrinsic box: React needs a `key` for
        // stable list reconciliation, but function components carry no `key` prop
        // in this repo's declaration environment (no @types/react — runtime-api
        // §3.3 keeps react ambient types out of the facade), whereas the `<box>`
        // intrinsic takes `key` via OpenTUI's ReactProps.
        return (
          <box key={item.id}>
            <Text
              id={`${props.id}-${item.id}`}
              color={selected ? "accent" : "foreground"}
              bold={selected}
            >
              {item.label}
            </Text>
          </box>
        )
      })}
    </box>
  )
}
