/** Host-supervision §5: `1` = control, `2` = frame/bulk data. */
export type MessageClass = "control" | "data";

/** One framed message; payload bytes are opaque to this layer. */
export interface WireFrame {
  readonly messageClass: MessageClass;
  readonly payload: Uint8Array;
}
