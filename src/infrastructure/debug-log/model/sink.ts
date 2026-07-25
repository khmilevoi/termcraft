import fs from "node:fs";
import path from "node:path";

import type { TraceLine } from "../types";

/**
 * DIAGNOSTIC INSTRUMENTATION — opt-in, off unless `TERMCRAFT_DEBUG_LOG` is set.
 *
 * The interactive shell owns the terminal (raw mode + alternate screen), so `console.*` output
 * is either invisible or corrupts the frame. This appends to a file instead, which is the only
 * way to observe a live run. Everything here is deliberately synchronous: a crash or a forced
 * exit must not lose the last lines, which are exactly the interesting ones.
 *
 * Never throws. A logger that can break the app it is diagnosing is worse than no logger, so
 * every failure degrades to "tracing silently stops" rather than propagating.
 */

const ENV_VAR = "TERMCRAFT_DEBUG_LOG";
const DEFAULT_FILENAME = "termcraft-debug.jsonl";

/** Resolved once per process: the destination path, or `null` when tracing is off. */
const target: string | null = resolveTarget();

/**
 * TEMPORARY: tracing is ON by default while the "Enter does nothing" investigation is open.
 * It was opt-in first, but an unset `$env:` in the launching shell is itself invisible — the
 * run simply produces no file, which is indistinguishable from "the app never got that far"
 * and costs a whole round trip to discover. Defaulting on removes that failure mode.
 *
 * Set `TERMCRAFT_DEBUG_LOG=0` (or `off`/`false`) to silence it. Flip this back to opt-in — the
 * `raw === undefined` branch returning `null` — once the investigation closes.
 */
function resolveTarget(): string | null {
  const raw = process.env[ENV_VAR];
  if (raw === "0" || raw === "off" || raw === "false") return null;
  // Unset, `1`, or `true` all mean "trace to the fixed file"; anything else is a literal path.
  const relative =
    raw === undefined || raw.length === 0 || raw === "1" || raw === "true" ? DEFAULT_FILENAME : raw;
  return path.resolve(process.cwd(), relative);
}

/** Whether tracing is on. Call sites can skip building expensive payloads when it is not. */
export function traceEnabled(): boolean {
  return target !== null;
}

/** Truncates whatever a previous run left behind, so one file is one session. */
export function resetTrace(): void {
  if (target === null) return;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "");
  } catch {
    // Tracing is best-effort; see the header.
  }
}

/** The destination path, for reporting it to the operator. `null` when tracing is off. */
export function tracePath(): string | null {
  return target;
}

/**
 * Appends one line. `data` is passed through a replacer that survives the values a live shell
 * actually carries — `undefined`, functions, circular graphs, `Error`s — because a trace that
 * throws on an unexpected value records nothing at the moment it matters most.
 */
export function trace(channel: string, data: Record<string, unknown>): void {
  if (target === null) return;
  const line: TraceLine = { ts: new Date().toISOString(), channel, data };
  try {
    fs.appendFileSync(target, `${safeStringify(line)}\n`);
  } catch {
    // See the header.
  }
}

function safeStringify(line: TraceLine): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(line, (_key, value: unknown) => {
      if (value instanceof Error) return { name: value.name, message: value.message };
      if (typeof value === "function") return "[function]";
      if (typeof value === "bigint") return value.toString();
      if (typeof value === "object" && value !== null) {
        if (seen.has(value)) return "[circular]";
        seen.add(value);
      }
      return value;
    });
  } catch {
    return JSON.stringify({ ts: line.ts, channel: line.channel, data: "[unserializable]" });
  }
}
