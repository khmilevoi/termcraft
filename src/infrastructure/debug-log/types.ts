/**
 * A single appended trace line. `channel` names the call site (e.g. `"ui.keymap"`), `data`
 * carries whatever that site wants recorded. Serialized as one JSON object per line so the
 * file stays greppable and machine-readable while a session is running.
 */
export interface TraceLine {
  readonly ts: string;
  readonly channel: string;
  readonly data: Record<string, unknown>;
}
