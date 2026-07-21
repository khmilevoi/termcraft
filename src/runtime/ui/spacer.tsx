/** Props for the `Spacer`. `id` is the mandatory stable id (§3.2). */
export interface SpacerProps {
  /** Stable id the host selects and answers geometry on. Mandatory on every catalog component. */
  readonly id: string;
  /** Fixed cell size (width and height); omit for a flexible spacer. */
  readonly size?: number;
}

/**
 * Empty space between siblings (design-system §3.2). With `size` it is a fixed
 * `size`×`size` box; without it, a flexible `flexGrow: 1` box that soaks up the
 * free main-axis space and pushes its siblings apart. The mandatory `id` flows
 * to the element for host geometry.
 */
export function Spacer(props: SpacerProps) {
  if (props.size === undefined) {
    return <box id={props.id} flexGrow={1} />;
  }
  return <box id={props.id} width={props.size} height={props.size} />;
}
