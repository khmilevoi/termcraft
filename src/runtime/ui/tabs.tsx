/** @jsxImportSource @opentui/react */
import { Text } from "./text"

/** One tab: a stable `id` and its display `label`. */
export interface TabItem {
  readonly id: string
  readonly label: string
}

/** Props for the themed `Tabs` component. `id` is the mandatory stable id (§3.2). */
export interface TabsProps {
  /** Stable id the host selects/pins on (§3.2). Mandatory on every catalog component. */
  readonly id: string
  /** The tabs to render, in display order. */
  readonly tabs: readonly TabItem[]
  /** The id of the currently active tab; its label renders bold + accent. */
  readonly activeId: string
  /**
   * Invoked with a tab id when it is selected. Accepted for the interactive path
   * (the shell dispatches it in accepted interactive mode — phase 7); the MVP
   * static render is a highlighted label row and never calls it.
   */
  readonly onSelect?: (id: string) => void
}

/**
 * Themed tab strip (design-system, runtime-api §3.2). MVP renders a STATIC
 * highlighted label row — an OpenTUI `<box flexDirection="row">` of label `Text`s;
 * the active tab is bold + `accent`, the rest `foregroundMuted`. The mandatory `id`
 * flows to the box for the host's geometry queries and the shell's select/pin, and
 * each label carries its own `${id}-tab-${tab.id}` id. `onSelect` is accepted for the
 * phase-7 interactive path and stays inert here. Colors are semantic token names.
 */
export function Tabs(props: TabsProps) {
  return (
    <box id={props.id} flexDirection="row" gap={1}>
      {props.tabs.map((tab) => {
        const active = tab.id === props.activeId
        // The React list `key` rides the intrinsic wrapper box: composed components
        // (`Text`) surface only their own props here — this project ships no
        // `@types/react`, so `key` lives on intrinsics via OpenTUI's `ReactProps`.
        return (
          <box key={tab.id} id={`${props.id}-tab-${tab.id}`}>
            <Text
              id={`${props.id}-tab-${tab.id}-label`}
              color={active ? "accent" : "foregroundMuted"}
              bold={active}
            >
              {tab.label}
            </Text>
          </box>
        )
      })}
    </box>
  )
}
