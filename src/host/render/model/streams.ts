import { Readable, Writable } from "node:stream";

import type { Size } from "../../types";

/**
 * Fake TTY streams for a headless renderer. `columns`/`rows` are set to the
 * requested size because `createCliRenderer` sizes as `stdout.columns ||
 * config.width` — the stream value OUTRANKS the config (Spike B trap). `isTTY`
 * and `setRawMode` are load-bearing: `setupTerminal()` calls both.
 */
export function makeHeadlessStreams(size: Size) {
  const stdout = Object.assign(
    new Writable({ write: (_chunk, _encoding, callback) => callback() }),
    {
      isTTY: true as const,
      columns: size.w,
      rows: size.h,
      getColorDepth: () => 24,
    },
  );
  const stdin: Readable & { isTTY: true; setRawMode: (raw: boolean) => unknown } = Object.assign(
    new Readable({ read() {} }),
    {
      isTTY: true as const,
      setRawMode(_raw: boolean) {
        return stdin;
      },
    },
  );
  return { stdin, stdout };
}
