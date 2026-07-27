import { describe, expect, test } from "bun:test";
import path from "node:path";

import { MAX_RETAINED_RUNS, resolveTraceTarget, runFileName, selectRunsToPrune } from "./sink";

const CWD = path.resolve("/projects/termcraft");
const RUN = { now: new Date("2026-07-27T11:20:00.123Z"), pid: 12345 };
const DEFAULT_TARGET = path.resolve(CWD, "termcraft-debug", runFileName(RUN.now, RUN.pid));

describe("runFileName — one name per run, sortable and unique", () => {
  test("carries the run's start instant and pid, and is a .jsonl file", () => {
    expect(runFileName(RUN.now, RUN.pid)).toBe("run-2026-07-27T11-20-00-123Z-12345.jsonl");
  });

  /**
   * Sorting the directory by name has to order runs by time, because that is what
   * {@link selectRunsToPrune} and an operator reading `ls` both rely on. `:` and `.` are not
   * legal in a Windows filename, so the ISO instant is punched out rather than used raw.
   */
  test("names sort lexicographically in start order", () => {
    const earlier = runFileName(new Date("2026-07-27T11:20:00.123Z"), 999);
    const later = runFileName(new Date("2026-07-27T11:20:00.124Z"), 1);
    const muchLater = runFileName(new Date("2026-11-03T00:00:00.000Z"), 1);
    expect([muchLater, later, earlier].sort()).toEqual([earlier, later, muchLater]);
  });

  test("two runs starting in the same millisecond stay distinct", () => {
    expect(runFileName(RUN.now, 1)).not.toBe(runFileName(RUN.now, 2));
  });

  test("the name contains no character Windows rejects in a path", () => {
    expect(runFileName(RUN.now, RUN.pid)).not.toMatch(/[:*?"<>|]/);
  });
});

describe("resolveTraceTarget — where a process traces to, if at all", () => {
  test("an unset variable mints a fresh run file under the run directory", () => {
    const resolved = resolveTraceTarget({}, CWD, RUN);
    expect(resolved).toEqual({ path: DEFAULT_TARGET, minted: true });
  });

  test("`1`/`true`/empty all mean the same freshly minted run file", () => {
    for (const raw of ["1", "true", ""]) {
      expect(resolveTraceTarget({ TERMCRAFT_DEBUG_LOG: raw }, CWD, RUN)).toEqual({
        path: DEFAULT_TARGET,
        minted: true,
      });
    }
  });

  test("`0`/`off`/`false` silence tracing entirely", () => {
    for (const raw of ["0", "off", "false"]) {
      expect(resolveTraceTarget({ TERMCRAFT_DEBUG_LOG: raw }, CWD, RUN)).toBeNull();
    }
  });

  /**
   * An explicit path is NOT minted, and that distinction is load-bearing: a child process
   * receives the parent's already-resolved run file through this same variable, and must
   * append to it rather than take over managing the directory it happens to sit in.
   */
  test("any other value is a literal file path, resolved against the cwd and never minted", () => {
    expect(resolveTraceTarget({ TERMCRAFT_DEBUG_LOG: "logs/run.jsonl" }, CWD, RUN)).toEqual({
      path: path.resolve(CWD, "logs/run.jsonl"),
      minted: false,
    });
  });

  test("an inherited absolute run file resolves back to itself, so a child shares the parent's file", () => {
    const parent = resolveTraceTarget({}, CWD, RUN);
    expect(parent).not.toBeNull();
    const child = resolveTraceTarget({ TERMCRAFT_DEBUG_LOG: parent!.path }, "/some/other/cwd", {
      now: new Date("2026-07-27T11:20:05.000Z"),
      pid: 999,
    });
    expect(child).toEqual({ path: parent!.path, minted: false });
  });

  /**
   * THE DEFECT THIS PINS (2026-07-27). `bun test` sets NODE_ENV=test and, with tracing
   * defaulting on, every test process wrote alongside the app's own diagnostics. An
   * investigation's log came back interleaving real lines with test fixtures (`turnId: "t1"`,
   * `"boom"`, `"stream died"`) that read exactly like production failures.
   */
  test("a test process does not mint a run file", () => {
    expect(resolveTraceTarget({ NODE_ENV: "test" }, CWD, RUN)).toBeNull();
    expect(resolveTraceTarget({ NODE_ENV: "test", TERMCRAFT_DEBUG_LOG: "1" }, CWD, RUN)).toBeNull();
  });

  test("an explicit path still traces under a test process — an operator asked for this run", () => {
    expect(
      resolveTraceTarget({ NODE_ENV: "test", TERMCRAFT_DEBUG_LOG: "t.jsonl" }, CWD, RUN),
    ).toEqual({ path: path.resolve(CWD, "t.jsonl"), minted: false });
  });

  test("NODE_ENV values other than test are ordinary runs", () => {
    expect(resolveTraceTarget({ NODE_ENV: "production" }, CWD, RUN)?.minted).toBe(true);
    expect(resolveTraceTarget({ NODE_ENV: "development" }, CWD, RUN)?.minted).toBe(true);
  });
});

/**
 * A directory of runs grows without bound unless something trims it, and an unbounded
 * debugging artifact eventually becomes a disk problem an operator did not ask for. Pruning
 * is deliberately name-based: the names sort in start order, so the newest N survive without
 * a single stat call.
 */
describe("selectRunsToPrune — keeping the run directory bounded", () => {
  const names = (count: number) =>
    Array.from({ length: count }, (_, i) =>
      runFileName(new Date(Date.parse("2026-07-27T00:00:00.000Z") + i * 1000), 1),
    );

  test("nothing is pruned while the directory is under the cap", () => {
    expect(selectRunsToPrune(names(MAX_RETAINED_RUNS), MAX_RETAINED_RUNS)).toEqual([]);
  });

  test("the oldest runs beyond the cap are the ones selected", () => {
    const all = names(MAX_RETAINED_RUNS + 3);
    const pruned = selectRunsToPrune(all, MAX_RETAINED_RUNS);
    expect(pruned).toEqual(all.slice(0, 3));
  });

  test("selection is independent of the order the directory listing arrives in", () => {
    const all = names(MAX_RETAINED_RUNS + 2);
    expect(selectRunsToPrune([...all].reverse(), MAX_RETAINED_RUNS)).toEqual(all.slice(0, 2));
  });

  /**
   * A stray file an operator dropped into the directory is not this code's to delete — only
   * files it recognises as its own runs are ever candidates.
   */
  test("files that are not run logs are never selected, however many there are", () => {
    const all = [...names(MAX_RETAINED_RUNS + 2), "notes.txt", "run-broken.jsonl", "README.md"];
    const pruned = selectRunsToPrune(all, MAX_RETAINED_RUNS);
    expect(pruned).toEqual(names(MAX_RETAINED_RUNS + 2).slice(0, 2));
  });

  test("a cap of zero or less prunes nothing rather than emptying the directory", () => {
    expect(selectRunsToPrune(names(5), 0)).toEqual([]);
    expect(selectRunsToPrune(names(5), -1)).toEqual([]);
  });

  /**
   * `beginTraceRun` creates this run's file before pruning, so the newest name in the listing
   * is the current run — and the newest is exactly what survives. Measured, not assumed: with
   * prune-then-create the directory settles at cap+1 instead of cap.
   */
  test("the newest run — this one — is never a candidate", () => {
    const all = names(MAX_RETAINED_RUNS + 5);
    const current = all[all.length - 1]!;
    expect(selectRunsToPrune(all, MAX_RETAINED_RUNS)).not.toContain(current);
  });
});
