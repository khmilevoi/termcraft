/**
 * The whole-suite gate. `bun test` alone is NOT one: it dies intermittently with
 * `panic(main thread): Segmentation fault` inside `Bun.Transpiler` (reached by
 * `gate/model/lexer.oracle.test.ts`'s fuzz corpus), and a crashed run prints no `(fail)` lines
 * at all — so every "did anything fail?" reading of its output says no. This wrapper makes a
 * crash a first-class, loud outcome distinct from both pass and fail.
 *
 * It does not retry: a re-run is a human decision, because "it passed the second time" is
 * evidence about the panic, not about the change under test.
 */

/** What one `bun test` invocation actually did. `"crashed"` is never a pass. */
export type BunTestVerdictV1 = "pass" | "fail" | "crashed";

/** Bun's own end-of-run summary. Its ABSENCE is the signal — a run that produced no summary
 * did not finish, whatever its exit code says. That means anything that can make a PRESENT
 * summary look absent — such as an ANSI colour escape sitting where `^` expects the line to
 * start — is a false crash, so the text is stripped of escapes (see ANSI_ESCAPE) before this
 * pattern ever sees it. */
const SUMMARY_LINE = /^\s*\d+\s+pass\s*$/m;

/** Bun's panic banner, and the shell's own report of a signal death (128 + SIGSEGV/SIGABRT). */
const PANIC_MARKER = /panic\(|Bun has crashed|Segmentation fault/;
const SIGNAL_EXIT_CODES: ReadonlySet<number> = new Set([134, 139]);

/** ANSI colour/style escapes, e.g. `\x1b[32m`. Bun emits these around the summary line whenever
 * colour is requested (`FORCE_COLOR=1` is common in shell profiles and some CI), even though the
 * CLI path below also asks the child process not to. Stripped before classifying so the function
 * is correct for any caller handing it coloured text, not only for that one spawn. */
// oxlint-disable-next-line no-control-regex -- the ESC control character is exactly what needs matching here.
const ANSI_ESCAPE = /\x1b\[[0-9;]*m/g;

/**
 * Classify one finished run. Pure, so it is testable without provoking a real segfault —
 * which is not reproducible on demand, being roughly a 1-in-4000 property of the fuzz shapes.
 */
export function classifyBunTestRun(input: {
  readonly exitCode: number;
  readonly output: string;
}): BunTestVerdictV1 {
  const plainOutput = input.output.replace(ANSI_ESCAPE, "");
  if (PANIC_MARKER.test(plainOutput)) return "crashed";
  if (SIGNAL_EXIT_CODES.has(input.exitCode)) return "crashed";
  if (!SUMMARY_LINE.test(plainOutput)) return "crashed";
  return input.exitCode === 0 ? "pass" : "fail";
}

const CRASH_ADVICE =
  "the test run CRASHED and is NOT a pass — it printed no failures because it never finished.\n" +
  "This is the known `Bun.Transpiler` panic reached by gate/model/lexer.oracle.test.ts.\n" +
  "Re-run to get a verdict; never read a crashed run as green.";

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  const child = Bun.spawnSync(["bun", "test", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    // Ask the child not to colour its output. Belt-and-suspenders with the ANSI_ESCAPE strip
    // above: this keeps the common case cheap, the strip keeps the classifier correct regardless.
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
  });
  const output = `${child.stdout.toString()}${child.stderr.toString()}`;
  process.stdout.write(output);

  const verdict = classifyBunTestRun({ exitCode: child.exitCode, output });
  if (verdict === "crashed") {
    process.stderr.write(`\nrun-tests: ${CRASH_ADVICE}\n`);
    process.exit(2);
  }
  process.exit(verdict === "pass" ? 0 : 1);
}
