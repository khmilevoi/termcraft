/** @jsxImportSource @opentui/react */

/** Props for the `Row` layout container. `id` is the mandatory stable id (§3.2). */
export interface RowProps {
  /** Stable id the host selects and answers geometry on. Mandatory on every catalog component. */
  readonly id: string
  readonly children?: unknown
  /** Cells of space inserted between children (Yoga gap). */
  readonly gap?: number
  /** Uniform inner padding on all sides. */
  readonly padding?: number
  /** Cross-axis placement of children; maps to Yoga `alignItems`. */
  readonly align?: "start" | "center" | "end" | "stretch"
  /** Main-axis distribution of children; maps to Yoga `justifyContent`. */
  readonly justify?: "start" | "center" | "end" | "between" | "around"
}

/** Public prop value → Yoga `alignItems` value. `start`/`end` gain the `flex-` prefix. */
const ALIGN = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
  stretch: "stretch",
} as const

/** Public prop value → Yoga `justifyContent` value. `between`/`around` become `space-*`. */
const JUSTIFY = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
  between: "space-between",
  around: "space-around",
} as const

/**
 * A horizontal flex container (design-system §3.2). Lays its children out in a
 * row and maps the ergonomic `align`/`justify` prop vocabulary onto Yoga's
 * `alignItems`/`justifyContent`. The mandatory `id` flows to the element so the
 * host can answer geometry queries and the shell can select/pin it.
 */
export function Row(props: RowProps) {
  return (
    <box
      id={props.id}
      flexDirection="row"
      gap={props.gap}
      padding={props.padding}
      alignItems={props.align === undefined ? undefined : ALIGN[props.align]}
      justifyContent={props.justify === undefined ? undefined : JUSTIFY[props.justify]}
    >
      {props.children}
    </box>
  )
}
