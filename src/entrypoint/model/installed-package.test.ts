import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * This suite's subject is the INSTALLED package (phase-8 design §7, promoted to a phase
 * constraint: "Acceptance oracles must exercise the shipped artifact in the shipped mode").
 * `bun run src/main.tsx` from this checkout does not exercise `package.json`'s `files`
 * allowlist at all, so it cannot catch a file missing from that allowlist.
 *
 * `bun link` is also NOT a valid substitute, even though it is the mechanism the plan's
 * original sketch for this file used. `bun link` registers a symlink to the WHOLE repository
 * checkout, so every file in the working tree — including everything `files` deliberately
 * excludes — is reachable from the "installed" copy. Two real regressions this phase hit were
 * invisible to a `bun link` probe and surfaced only under a real `npm pack` install:
 * `tsconfig.json` was missing from `files` (Bun reads its `compilerOptions.paths` at runtime,
 * so `main.tsx`'s first aliased import died), and `create-shell.ts` eagerly imported
 * `scripts/embed-assets`, which `npm pack` never ships because `scripts/` is outside `files`.
 * `bun link` would still resolve both, because both paths exist in the real checkout it
 * symlinks to.
 *
 * The install sequence that actually exercises the shipped tarball, verified by hand against
 * this repository:
 *
 *   npm pack
 *   bun add -g "$(pwd)/termcraft-<version>.tgz"
 *
 * `npm pack` builds the real tarball from the `files` allowlist (the same artifact `npm
 * publish` would upload); `bun add -g` installs FROM that tarball rather than from the
 * checkout, and puts `termcraft` on PATH so `Bun.which("termcraft")` below finds it. The path
 * MUST be absolute — verified by hand: `bun add -g ./termcraft-<version>.tgz` fails with
 * `error: ENOENT extracting tarball from ./termcraft-<version>.tgz` because a global install
 * resolves a relative specifier against Bun's global install location, not the caller's cwd.
 * Undo with `bun remove -g termcraft`.
 *
 * `Bun.which("termcraft")` gates every test in this file so `bun test` stays honest on a
 * fresh checkout: the suite SKIPS rather than failing red for an install step nobody ran. The
 * skip is loud on purpose — it is printed even when nobody is looking at the test output, and
 * it repeats the exact command sequence above, because Task 21's acceptance runbook repeats
 * this same warning. Task 21's own exit-criteria check additionally requires this file to have
 * ACTUALLY RUN (not skipped) before criterion 2 counts as satisfied — see that runbook.
 */
const installed = Bun.which("termcraft");
if (installed === null) {
  console.warn(
    "installed-package.test.ts SKIPPED: `termcraft` is not on PATH, so this file did NOT " +
      "run and does NOT discharge phase-8 exit criterion 2. `bun link` is not a substitute " +
      "(see this file's header comment). To run it for real:\n" +
      "  1. npm pack\n" +
      '  2. bun add -g "$(pwd)/termcraft-<version>.tgz"   # path MUST be absolute\n' +
      "  3. bun test src/entrypoint/model/installed-package.test.ts\n" +
      "  4. bun remove -g termcraft   # undo the global install afterwards",
  );
}
const describeInstalled = installed === null ? describe.skip : describe;

const TIMEOUT_MS = 120_000;

/** How long an argv path that is expected to block (`_host --stdio`, waiting for the parent
 *  supervisor's handshake frame) is allowed to run before this test kills it. Bounded well
 *  under `TIMEOUT_MS` so a hang is reported as "killed after 5s, here is what it printed"
 *  rather than as an opaque bun:test timeout with no captured output. */
const HOST_STDIO_BOUND_MS = 5_000;

/** A directory that contains nothing — the design's §11 starting condition. */
function emptyDir(name: string): string {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "termcraft-")), name);
  fs.mkdirSync(dir);
  return dir;
}

/**
 * The strings an installed-package module-resolution failure actually spells out. The plan's
 * original sketch for this file checked only `"Cannot find package"`. That check would have
 * MISSED the real blocker this phase hit: `create-shell.ts` eagerly importing
 * `scripts/embed-assets` (a file `npm pack` never ships) failed with
 * `Cannot find module 'scripts/embed-assets'` — a distinct string Bun uses for a missing
 * relative/aliased module, as opposed to a missing package. `"Failed to resolve"` covers a
 * third shape: this project's own `Bun.plugin`-based resolver
 * (`src/host/session/model/resolver.ts`, `registerRuntimeResolver`) reports failures in that
 * form rather than Bun's own `ResolveMessage` wording. All three are checked, every time,
 * because any one of them alone would have let a real regression through.
 */
const RESOLUTION_FAILURE_STRINGS = [
  "Cannot find package",
  "Cannot find module",
  "Failed to resolve",
] as const;

function assertNoResolutionFailure(stderr: string): void {
  for (const needle of RESOLUTION_FAILURE_STRINGS) {
    expect(stderr).not.toContain(needle);
  }
}

/**
 * Reads `child`'s stderr to completion, but never past `HOST_STDIO_BOUND_MS`: `_host --stdio`
 * writes its first byte only once IT receives the parent supervisor's own hello frame
 * (`host-state-machine.ts`'s `awaiting-hello` phase — the child responds, it does not announce
 * itself unprompted), and this test sends no such frame. Reading `child.stderr` to EOF without
 * a bound would therefore hang until bun:test's own suite timeout, reporting a bare timeout
 * with no captured output instead of "here is what came back before the kill". Verified by hand
 * (not merely reasoned about): spawning this exact argv from an empty directory with a piped
 * stdin that is never closed blocks for the full bound and returns exit code 143 (SIGTERM) with
 * empty stdout/stderr — i.e. module resolution succeeded and the process is genuinely waiting
 * on its input, not crashing silently.
 */
async function readStderrBounded(
  child: Bun.Subprocess<Bun.SpawnOptions.Writable, Bun.SpawnOptions.Readable, "pipe">,
  boundMs: number,
): Promise<string> {
  const timer = setTimeout(() => child.kill(), boundMs);
  const [stderr] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  clearTimeout(timer);
  return stderr;
}

describeInstalled("the installed package", () => {
  test(
    "starts the _host stdio path from an empty directory without a resolution failure",
    async () => {
      const cwd = emptyDir("host");
      const child = Bun.spawn({
        cmd: ["termcraft", "_host", "--stdio"],
        cwd,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });

      const stderr = await readStderrBounded(child, HOST_STDIO_BOUND_MS);
      assertNoResolutionFailure(stderr);
    },
    TIMEOUT_MS,
  );

  test(
    "runs the export CLI in an untrusted empty directory without a resolution failure",
    async () => {
      const cwd = emptyDir("export");
      const child = Bun.spawn({ cmd: ["termcraft", "export"], cwd, stderr: "pipe" });
      const stderr = await readStderrBounded(child, HOST_STDIO_BOUND_MS);
      // A business-logic refusal — e.g. "the project has zero pages; export refuses with
      // nothing to package" — IS a pass here: it proves the entry resolved and ran. Only a
      // module-resolution failure is asserted against.
      assertNoResolutionFailure(stderr);
    },
    TIMEOUT_MS,
  );

  // The interactive argv path (no `_host`/`export` in argv) is deliberately NOT exercised
  // here. It calls `bootstrap("interactive", ...)`, which mounts OpenTUI's `CliRenderer` and
  // negotiates raw-mode/mouse-capture against a real terminal (`src/main.tsx`'s `else`
  // branch) — behavior that does not exist, and cannot be asserted, from a non-TTY `bun test`
  // process. It was still attempted BY HAND from an empty directory as part of writing this
  // file (see the task transcript), which is the only honest way to observe it; that manual
  // check is re-run as part of Task 21's §11 acceptance runbook, not automated here. Faking a
  // passing assertion for a path this process cannot actually exercise would be worse than
  // not asserting it at all.
});
