import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import {
  type ClientHelloV1,
  PROTOCOL_HARD_LIMITS,
  decodeHostHello,
  encodeClientHello,
} from "host/protocol";
import { parseHostArgs } from "host/session";
import { FrameDecoder, type WireFrame } from "infrastructure/framing";

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
      stderr: "ignore",
    });

    try {
      child.stdin.write(clientHelloFrame());
      await Promise.resolve(child.stdin.flush());

      const decoder = new FrameDecoder();
      const frames: WireFrame[] = [];
      // Bun's real spawned-child `stdout` is a `ReadableStream<Uint8Array>` that supports
      // `for await` at runtime; the narrower `AsyncIterable` cast matches the same
      // established pattern `host/supervisor/model/spawn.ts` uses for the injected
      // `SpawnedChild` port.
      const stdout = child.stdout as unknown as AsyncIterable<Uint8Array>;
      await withTimeout(
        (async () => {
          for await (const chunk of stdout) {
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
      expect(exitCode).toBe(0);
    } finally {
      // Guarantees the child never survives this test, even when an assertion above throws.
      child.kill();
    }
  }, 20_000);
});
