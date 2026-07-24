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
  test("declares the four documented commands", () => {
    expect(Object.keys(scripts)).toEqual(expect.arrayContaining(["start", "dev", "demo", "build"]));
  });

  test.each(["start", "dev", "demo", "build"])("`%s` points at an existing root", (name) => {
    const roots = referencedRoots(scripts[name] ?? "");
    expect(roots).not.toEqual([]);
    for (const root of roots) expect(fs.existsSync(path.join(repoRoot, root))).toBe(true);
  });

  test("`dev` runs the interactive root under watch mode", () => {
    expect(scripts.dev).toContain("--watch");
    expect(referencedRoots(scripts.dev ?? "")).toEqual(referencedRoots(scripts.start ?? ""));
  });

  test("`build` compiles a standalone executable", () => {
    expect(scripts.build).toContain("--compile");
    expect(scripts.build).toContain("dist/termcraft");
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
