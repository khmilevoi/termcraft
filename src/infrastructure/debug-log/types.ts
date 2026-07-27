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

/**
 * The trace seam {@link installConsoleTee} writes through.
 *
 * Injectable because the real sink resolves its target ONCE at module load, and under
 * `bun test` (`NODE_ENV=test`) that target is `null` — so a tee test can neither enable
 * tracing after the fact nor assert against a file. A fake sink makes the tee testable
 * without an environment variable and without touching disk.
 */
export interface TeeSink {
  readonly enabled: () => boolean;
  readonly trace: (channel: string, data: Record<string, unknown>) => void;
}
