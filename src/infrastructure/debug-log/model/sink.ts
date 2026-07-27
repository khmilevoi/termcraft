import fs from "node:fs";
import path from "node:path";

import type { TraceLine } from "../types";

/**
 * DIAGNOSTIC INSTRUMENTATION — one JSONL file per run, under `termcraft-debug/`.
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
/** The run directory, relative to the working directory, when no explicit path is given. */
const DEFAULT_DIRNAME = "termcraft-debug";
/** Run logs kept in {@link DEFAULT_DIRNAME}; older ones are pruned when a new run mints its file. */
export const MAX_RETAINED_RUNS = 20;
const RUN_FILE_PATTERN = /^run-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-\d+\.jsonl$/;

/**
 * One run's file name: its start instant plus the pid that minted it.
 *
 * The ISO instant has `:` and `.` punched out because neither is a legal Windows filename
 * character, and the substitution is chosen to keep the name sorting in start order — which is
 * what {@link selectRunsToPrune} and an operator reading `ls` both rely on. The pid is what
 * keeps two runs that start in the same millisecond apart.
 */
export function runFileName(now: Date, pid: number): string {
  return `run-${now.toISOString().replace(/[:.]/g, "-")}-${pid}.jsonl`;
}

/** What {@link resolveTraceTarget} decided: where to trace, and whether THIS process minted it. */
export interface TraceTarget {
  readonly path: string;
  /**
   * True only when this process chose the name itself. A child that inherited an already
   * resolved path through `TERMCRAFT_DEBUG_LOG` appends to it and must NOT take over managing
   * the directory it sits in — see {@link beginTraceRun}.
   */
  readonly minted: boolean;
}

/**
 * TEMPORARY: tracing is ON by default while the "Enter does nothing" investigation is open.
 * It was opt-in first, but an unset `$env:` in the launching shell is itself invisible — the
 * run simply produces no file, which is indistinguishable from "the app never got that far"
 * and costs a whole round trip to discover. Defaulting on removes that failure mode.
 *
 * Set `TERMCRAFT_DEBUG_LOG=0` (or `off`/`false`) to silence it. Flip this back to opt-in — the
 * `raw === undefined` branch returning `null` — once the investigation closes.
 *
 * ONE FILE PER RUN, IN A DIRECTORY (2026-07-27). This used to resolve to a single fixed file
 * that the entry point truncated on start, so comparing a run against the previous one was
 * impossible — the previous one was already gone the moment the app relaunched. Runs now get
 * their own file under `termcraft-debug/`, so nothing overwrites anything and history survives
 * to {@link MAX_RETAINED_RUNS}.
 *
 * THE TEST-RUNNER EXCLUSION. `bun test` sets NODE_ENV=test, and with tracing defaulting on
 * every test process traced alongside the app. One investigation's log came back interleaving
 * real lines with test fixtures (`turnId: "t1"`, `"boom"`, `"stream died"`) that read exactly
 * like production failures; the first pass of that investigation chased them. A diagnostic
 * whose own output cannot be trusted is worse than none. An EXPLICIT path still wins —
 * `TERMCRAFT_DEBUG_LOG=/tmp/x.jsonl bun test ...` traces a test run deliberately, which is a
 * real need when the thing under investigation is a test.
 *
 * Exported (rather than closed over `process`) so the decision is testable: the module-level
 * target below is resolved once at load, so a test cannot vary the environment after the fact.
 */
export function resolveTraceTarget(
  env: Readonly<Partial<Record<string, string>>>,
  cwd: string,
  run: { readonly now: Date; readonly pid: number },
): TraceTarget | null {
  const raw = env[ENV_VAR];
  if (raw === "0" || raw === "off" || raw === "false") return null;
  // Unset, `1`, or `true` all mean "mint a fresh run file"; anything else is a literal path.
  const wantsFreshRun = raw === undefined || raw.length === 0 || raw === "1" || raw === "true";
  if (!wantsFreshRun) return { path: path.resolve(cwd, raw), minted: false };
  // Only the DEFAULT is suppressed under the test runner — an explicit path is an operator
  // asking for this run specifically, and is honoured above.
  if (env["NODE_ENV"] === "test") return null;
  return { path: path.resolve(cwd, DEFAULT_DIRNAME, runFileName(run.now, run.pid)), minted: true };
}

/**
 * Which of a run directory's entries to delete so at most `cap` survive, oldest first.
 *
 * Name-based on purpose: {@link runFileName} sorts in start order, so the newest `cap` are the
 * tail of a plain sort — no stat call, and no dependence on mtimes that a copy or a restore
 * would have rewritten. An entry this module does not recognise as its own run log is never a
 * candidate: an operator's stray note in the directory is not ours to delete.
 */
export function selectRunsToPrune(fileNames: readonly string[], cap: number): string[] {
  if (cap <= 0) return [];
  const runs = fileNames.filter((name) => RUN_FILE_PATTERN.test(name)).sort();
  return runs.length <= cap ? [] : runs.slice(0, runs.length - cap);
}

/** Resolved once per process: where this process traces, or `null` when tracing is off. */
const target: TraceTarget | null = resolveTraceTarget(process.env, process.cwd(), {
  now: new Date(),
  pid: process.pid,
});

// PROPAGATION TO CHILD PROCESSES. Writing the resolved path back into the environment is what
// makes a child that inherits it trace into THIS run's file instead of minting a second one:
// `resolveTraceTarget` reads an explicit path back verbatim, unminted. A child given a
// deliberately narrowed environment does not inherit it automatically — `host/supervisor/model/
// spawn.ts`'s allowlist forwards this one variable explicitly, and says why.
if (target !== null) process.env[ENV_VAR] = target.path;

/** Whether the run directory has been created in this process yet — see {@link ensureDirectory}. */
let directoryReady = false;

/**
 * Create the run file's directory, once. Called from {@link trace} rather than only from
 * {@link beginTraceRun} so a process that never called the latter still records: an ordering
 * mistake should cost a redundant `mkdirSync`, not a whole run's diagnostics.
 */
function ensureDirectory(destination: string): void {
  if (directoryReady) return;
  directoryReady = true;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
}

/** Whether tracing is on. Call sites can skip building expensive payloads when it is not. */
export function traceEnabled(): boolean {
  return target !== null;
}

/**
 * Open this process's run log: create the run directory, then trim the directory back to
 * {@link MAX_RETAINED_RUNS}. Nothing is truncated — the run file's name is unique, so the
 * previous run's file is a separate file that simply stays.
 *
 * Pruning happens only when THIS process minted the target. A child appending to a path it
 * inherited, or a run an operator pointed at an explicit file, is a guest in that directory and
 * does not get to delete things in it.
 */
export function beginTraceRun(): void {
  if (target === null) return;
  try {
    ensureDirectory(target.path);
    if (!target.minted) return;
    // Create the file BEFORE pruning, for two reasons: this run then counts against the cap
    // (prune-then-create leaves the directory at cap+1 in steady state), and `tracePath()`
    // names something an operator can `tail -f` from the start rather than only once the
    // first line happens to be written. Append-mode so it is create-if-missing and never a
    // truncation — the same call is harmless if the file somehow already exists.
    fs.appendFileSync(target.path, "");
    const directory = path.dirname(target.path);
    for (const name of selectRunsToPrune(fs.readdirSync(directory), MAX_RETAINED_RUNS)) {
      // Never this run's own file: it is the newest name in the directory, and
      // `selectRunsToPrune` drops the oldest — but say so, since a bug here deletes the very
      // diagnostics the operator is waiting on.
      if (name === path.basename(target.path)) continue;
      fs.rmSync(path.join(directory, name), { force: true });
    }
  } catch {
    // Tracing is best-effort; see the header.
  }
}

/** The destination path, for reporting it to the operator. `null` when tracing is off. */
export function tracePath(): string | null {
  return target === null ? null : target.path;
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
    ensureDirectory(target.path);
    fs.appendFileSync(target.path, `${safeStringify(line)}\n`);
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
