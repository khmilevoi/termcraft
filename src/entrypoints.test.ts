import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ExportRefusedError,
  TRUST_REFUSAL_MESSAGE,
  formatExportOutcome,
  parseExportArgs,
} from "entrypoint";

import {
  type ClientHelloV1,
  PROTOCOL_HARD_LIMITS,
  decodeHostHello,
  encodeClientHello,
} from "host/protocol";
import { parseHostArgs } from "host/session";
import { FrameDecoder, type WireFrame } from "infrastructure/framing";
import { cleanupScratchRoots, createRealProjectFixture } from "store/adapters/test-support";

/**
 * The executable-surface contract: `package.json`'s commands and the two runnable roots must
 * stay in sync. A script that points at a deleted root, or a root that starts the terminal on
 * plain `import`, both break the documented workflow without failing any module's own tests.
 */

const repoRoot = path.resolve(import.meta.dir, "..");
const ENTRYPOINT_MODULE_URL = Bun.pathToFileURL(
  path.join(repoRoot, "src/entrypoint/index.ts"),
).href;

/**
 * Races `promise` against a timer so a hang fails fast with a clear message instead of
 * blocking the rest of the suite. Always clears the timer, so a race the real promise wins
 * never leaves a dangling timeout alive past this test.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out ${label} after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const SESSION_ID = "01920000-0000-7000-8000-000000000000";
const NONCE = "0123456789abcdef0123456789abcdef";

/** A minimal framed `client.hello` — same shape and codec `host/session/model/entry.test.ts`
 *  uses for the in-memory-transport version of this same handshake. */
function clientHelloFrame(): Uint8Array {
  const hello: ClientHelloV1 = {
    framingVersion: 1,
    kind: "client.hello",
    sessionId: SESSION_ID,
    nonce: NONCE,
    offeredFramingVersions: [1],
    offeredProtocolVersions: [1],
    mode: "preview",
    pageSlug: "dashboard",
    sourceHash: "a".repeat(64),
    sourceKitApiVersion: 1,
    runtimeDeclaration: {
      module: "@termcraft/runtime",
      currentKitApiVersion: 1,
      supportedKitApiVersions: [1],
      publicCapabilityIds: [],
    },
    limits: PROTOCOL_HARD_LIMITS,
  };
  const framed = encodeClientHello(hello);
  if (framed instanceof Error) throw framed;
  return framed;
}

function readJson(relative: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relative), "utf8")) as Record<
    string,
    unknown
  >;
}

const scripts = readJson("package.json").scripts as Record<string, string>;

/** Every `src/...` path a script names, so the assertion follows the script, not a hardcoded list. */
function referencedRoots(command: string): readonly string[] {
  return [...command.matchAll(/src\/[\w./-]+/g)].map((match) => match[0]);
}

describe("package entrypoints", () => {
  test("declares the three documented commands", () => {
    expect(Object.keys(scripts)).toEqual(expect.arrayContaining(["start", "dev", "demo"]));
  });

  test.each(["start", "dev", "demo"])("`%s` points at an existing root", (name) => {
    const roots = referencedRoots(scripts[name] ?? "");
    expect(roots).not.toEqual([]);
    for (const root of roots) expect(fs.existsSync(path.join(repoRoot, root))).toBe(true);
  });

  test("`dev` runs the interactive root under watch mode", () => {
    expect(scripts.dev).toContain("--watch");
    expect(referencedRoots(scripts.dev ?? "")).toEqual(referencedRoots(scripts.start ?? ""));
  });

  test.each(["src/main.tsx", "src/demo.tsx"])("%s only starts under import.meta.main", (root) => {
    expect(fs.readFileSync(path.join(repoRoot, root), "utf8")).toContain("import.meta.main");
  });

  test("`_host --stdio` argv is recognized by parseHostArgs", () => {
    expect(parseHostArgs(["exe", "_host", "--stdio"])).toBe(true);
  });

  test("a real spawned `_host --stdio` child negotiates host.hello over real stdio and exits when stdin closes", async () => {
    // The one guarantee this WP exists to deliver: `main.tsx`'s first `import.meta.main`
    // branch must route a `_host --stdio` argv into the real protocol loop against REAL
    // process stdio — never the interactive bootstrap — and the child must not outlive its
    // stdin closing. A source-position check on `parseHostArgs` vs `bootstrap("interactive"`
    // (the previous version of this test) would still pass if the dispatch branch were
    // deleted; only actually spawning the binary and observing the real handshake proves it.
    // `cmd` matches the dev `SpawnCommand` shape `createHostSpawnCommand` builds (Spike E,
    // `docs/spikes/05-host-respawn/FINDINGS.md`): `[execPath, srcRoot, "_host", "--stdio"]`.
    const child = Bun.spawn({
      cmd: [process.execPath, path.join(repoRoot, "src/main.tsx"), "_host", "--stdio"],
      cwd: repoRoot,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    // Drained continuously (not just read on a failure path) so the child's stderr pipe never
    // backs up — and so a crash surfaces its real cause in the assertions below instead of only
    // the generic "waiting for..." timeout/exit-code message `stderr: "ignore"` used to leave.
    const stderrPromise = new Response(child.stderr).text();

    try {
      child.stdin.write(clientHelloFrame());
      await Promise.resolve(child.stdin.flush());

      const decoder = new FrameDecoder();
      const frames: WireFrame[] = [];
      await withTimeout(
        (async () => {
          // `{ preventCancel: true }` keeps the underlying pipe open across the early `return`
          // below: without it, `for await`'s implicit `break` calls the stream's `cancel()`,
          // closing the child's stdout read end while the child is still alive. The `_host`
          // child emits a heartbeat every second (`host/session/model/entry.ts`'s
          // `HEARTBEAT_INTERVAL_MS`) — a heartbeat write landing after that cancel hits a
          // broken pipe (EPIPE), which used to be able to flake this test's `exitCode` assertion
          // by making the child's own panic handler exit 1 instead of the clean 0 below.
          for await (const chunk of child.stdout.values({ preventCancel: true })) {
            const fed = decoder.feed(chunk);
            if (fed instanceof Error) throw fed;
            frames.push(...fed);
            if (frames.length > 0) return;
          }
        })(),
        8_000,
        "waiting for a framed host.hello on the child's stdout",
      );

      expect(frames.length).toBeGreaterThanOrEqual(1);
      const hostHello = decodeHostHello(frames[0]!.payload);
      if (hostHello instanceof Error) throw hostHello;
      expect(hostHello.kind).toBe("host.hello");
      expect(hostHello.sessionId).toBe(SESSION_ID);

      // Closing stdin simulates the parent process dying (its pipe going away) — the ONLY
      // signal the `_host` child ever gets in that case. It must exit itself (Important 3 of
      // the WP-3 fix pass, `entry.ts`'s "stdin closed" `performExit` path); nothing else is
      // left to kill it.
      await Promise.resolve(child.stdin.end());
      const exitCode = await withTimeout(child.exited, 8_000, "waiting for the child to exit");
      const stderrText = await stderrPromise;
      expect(exitCode, `child stderr:\n${stderrText}`).toBe(0);
    } finally {
      // Guarantees the child never survives this test, even when an assertion above throws.
      child.kill();
    }
  }, 20_000);
});

/**
 * `termcraft export` (M8, WP-5 Phase D, Task D2). Most of the driver's own logic is unit-tested
 * against an injected `KernelPort` in `entrypoint/model/run-export.test.ts`; this suite proves
 * the pieces that only exist at the real `main.tsx` root: argv routing (not `_host`, not
 * interactive), the CLI-output formatting `main.tsx` prints/exits with, and — the closeout's
 * own WP-5 acceptance (Gate 2) — a REAL spawned `termcraft export` child refusing an untrusted
 * project with the exact §3.1 message on stderr and a non-zero exit code.
 */
describe("the `termcraft export` CLI (WP-5 Phase D)", () => {
  afterEach(cleanupScratchRoots);

  test("`export <dir>` argv is recognized by parseExportArgs, and is distinct from `_host --stdio`", () => {
    expect(parseExportArgs(["exe", "export", "/some/project"])).toEqual({
      rootArg: "/some/project",
    });
    expect(parseExportArgs(["exe", "export"])).toEqual({ rootArg: undefined });
    expect(parseExportArgs(["exe", "_host", "--stdio"])).toBeNull();
    expect(parseHostArgs(["exe", "export", "/some/project"])).toBe(false);
  });

  test("formatExportOutcome prints the resolved package directory to stdout and exits 0 on success", () => {
    const formatted = formatExportOutcome({
      destination: "C:/proj/.termcraft/export/generations/g1",
    });
    expect(formatted).toEqual({
      stream: "stdout",
      text: "C:/proj/.termcraft/export/generations/g1",
      exitCode: 0,
    });
  });

  test("formatExportOutcome prints the §3.1 trust refusal to stderr and exits non-zero", () => {
    const formatted = formatExportOutcome(
      new ExportRefusedError({ reason: TRUST_REFUSAL_MESSAGE }),
    );
    expect(formatted.stream).toBe("stderr");
    expect(formatted.exitCode).toBe(1);
    expect(formatted.text).toContain("designs in this project are code and will run");
  });

  test("a real spawned `termcraft export` child refuses an untrusted project with the exact §3.1 message and a non-zero exit code", async () => {
    // The fixture project is created (and thereby implicitly trust-granted, storage-identity
    // §8) under its OWN throwaway user-state root — a store-level fact this test never reads.
    // What matters is that the SPAWNED child below runs against a DIFFERENT, freshly-minted
    // user-state root (via `LOCALAPPDATA`, `create-shell.ts`'s own `resolveDefaultUserStateRoot`
    // source) whose trust ledger has no grant for this project at all, so `project.open`'s real
    // `resolveTrust` resolves `untrusted-read-only` (no interactive prompt exists in this
    // headless contract) regardless of how the project itself came to exist on disk.
    const fixture = await createRealProjectFixture({ targetStack: "js-opentui" });
    const projectRoot = fixture.open.root;
    await fixture.open.close();

    const childUserState = fs.mkdtempSync(path.join(os.tmpdir(), "tc-export-cli-userstate-"));

    const child = Bun.spawn({
      cmd: [process.execPath, path.join(repoRoot, "src/main.tsx"), "export", projectRoot],
      cwd: repoRoot,
      env: { ...process.env, LOCALAPPDATA: childUserState },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    try {
      const [stdout, stderr, exitCode] = await withTimeout(
        Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]),
        15_000,
        "waiting for the spawned `termcraft export` child to exit",
      );

      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("designs in this project are code and will run");
      expect(stderr).toContain(TRUST_REFUSAL_MESSAGE);
      expect(stdout).toBe("");
    } finally {
      // Guarantees the child never survives this test, even when an assertion above throws.
      child.kill();
      fs.rmSync(childUserState, { recursive: true, force: true });
    }
  }, 20_000);
});

/**
 * Phase-8 Task 11 / WP-10 "the exit must actually exit" fix, proven end to end. A prior
 * investigation established: (1) `runApp`'s `close()` releases every resource correctly, but
 * nothing terminated the OS process on the interactive path — `@reatom/core`'s ESM bundle opens
 * an unref'd `BroadcastChannel` at import time (`node_modules/@reatom/core/dist/index.js`,
 * confirmed by bisection and `async_hooks`, reproduces under Node too, not fixable from `src/**`)
 * — so the event loop never drains on its own once the renderer is destroyed; (2) `run-app.ts`'s
 * `RunAppOptions.exit` now fires a real `process.exit()` AFTER `close()` finishes, closing that
 * gap. This suite proves fact (2) empirically, against a REAL separate OS process, not merely a
 * unit test with a recording double (`run-app.test.ts` already covers ordering and wiring that
 * way — this is deliberately the OTHER kind of proof).
 *
 * TWO DELIBERATE SCOPE DECISIONS, verified before being made — read before changing this test:
 *
 * 1. TRIGGER: a genuinely EXTERNAL SIGINT/SIGTERM cannot be delivered to a separate Bun child
 *    process on Windows through any standard API — verified empirically (bisected outside this
 *    file, not fabricated): `Bun.spawn(...).kill("SIGINT"|"SIGTERM")` and Node's own
 *    `process.kill(childPid, signal)` both unconditionally hard-terminate the child (exit codes
 *    130/143) WITHOUT its registered `process.on("SIGINT"|"SIGTERM", ...)` handler ever running;
 *    `taskkill /PID <pid>` (no `/F`) is flatly refused ("This process can only be terminated
 *    forcefully"); `taskkill /F` is the same unconditional hard kill. This matches Node's own
 *    documented Windows behavior for `child_process.kill()` (signals other than plain
 *    termination are not implemented on Windows). So instead, the spawned child SELF-delivers
 *    the signal via `process.emit("SIGINT")` once it is confirmed up — this invokes the EXACT
 *    SAME listener `createProcessBoundary`'s `target.once("SIGINT", handler)` registered on the
 *    real global `process` (verified: `process.kill(process.pid, "SIGINT")`, the "real" Windows
 *    self-signal API, ALSO hard-terminates on this Bun build with no handler run — `.emit()` is
 *    the only mechanism on this platform that actually invokes the registered listener instead
 *    of bypassing it). What is being proven — "does the process registered for this event
 *    actually terminate once that handler runs" — does not depend on how the event arrived; the
 *    interactive `/exit` keystroke itself (a different trigger, same `close()`) is covered by
 *    Task 21's manual runbook, not here, exactly as the interactive argv path already is
 *    (`installed-package.test.ts`'s own header comment states the identical limit).
 * 2. MODE: `demo`, not `interactive` — this test's subject is process-lifecycle plumbing
 *    (`bootstrap` -> `runApp` -> `createProcessBoundary`/`close()`/the injected `exit` seam),
 *    genuinely imported and run in a separate process exactly as `main.tsx` composes them; it is
 *    NOT project/Gate/host composition (already covered elsewhere). `demo` exercises the
 *    identical shutdown machinery `interactive` does — `runApp`'s `close()` does not branch on
 *    mode — while needing no real project directory, Gate compiler resolution, or host
 *    supervisor, keeping this test fast and isolated to what Task 11 actually changed. What is
 *    NOT re-executed here is `main.tsx`'s own few-line `interactiveExit` glue constant (its
 *    shape is the SAME flush-then-exit write the already-proven `_host`/`export` branches use,
 *    verified by direct reading, not by inference).
 */
function shutdownHarnessScript(signal: "SIGINT" | "SIGTERM"): string {
  return [
    `const mod = await import(${JSON.stringify(ENTRYPOINT_MODULE_URL)})`,
    `const boundary = mod.createProcessBoundary(process)`,
    `const app = await mod.bootstrap("demo", {`,
    `  argv: [],`,
    `  cwd: () => process.cwd(),`,
    `  process: boundary,`,
    // The SAME flush-then-exit shape `main.tsx`'s own `interactiveExit` uses (and the `_host`/
    // `export` branches before it) — an empty trailing write's callback fires only after every
    // earlier queued write's callback already has.
    `  exit: (code) => { process.stdout.write(new Uint8Array(0), () => process.exit(code)) },`,
    `})`,
    `if (app instanceof Error) { process.stdout.write("STARTUP_ERROR:" + app.message + "\\n"); process.exit(2) }`,
    `process.stdout.write("READY\\n")`,
    `process.emit(${JSON.stringify(signal)})`,
  ].join("\n");
}

describe("the interactive shutdown path actually terminates the process (Task 11 / WP-10)", () => {
  test.each(["SIGINT", "SIGTERM"] as const)(
    "close()'s own %s path ends the process on its own, within a bounded time, without this test killing it",
    async (signal) => {
      const child = Bun.spawn({
        cmd: [process.execPath, "-e", shutdownHarnessScript(signal)],
        cwd: repoRoot,
        stdout: "pipe",
        stderr: "pipe",
      });

      try {
        const stdoutPromise = new Response(child.stdout).text();
        const stderrPromise = new Response(child.stderr).text();

        // Only a timeout kills the child (in `finally`, below) — a clean self-triggered exit
        // resolves `child.exited` on its own, well before that, and `withTimeout` fails the
        // test with a clear message if it does not.
        const exitCode = await withTimeout(
          child.exited,
          15_000,
          `waiting for the interactive shutdown path to end the process on its own after ${signal}`,
        );

        const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
        expect(stdout, `child stderr:\n${stderr}`).toContain("READY");
        expect(stdout).not.toContain("STARTUP_ERROR");
        expect(exitCode, `child stderr:\n${stderr}`).toBe(0);
      } finally {
        // Guarantees the child never survives this test, even when an assertion above throws —
        // a no-op on an already-exited process, matching every other spawn test in this file.
        child.kill();
      }
    },
    20_000,
  );
});
