import { describe, expect, test } from "bun:test";
import path from "node:path";

import { EMBEDDED_RUNTIME_DECLARATION } from "../../protocol";
import type { FrameIdentity } from "../../protocol";
import { computeSourceHash } from "../../session";
import {
  createBunSpawn,
  createHostSession,
  createHostSpawnCommand,
  createSystemClock,
} from "../../supervisor";
import type { SpawnFn, SpawnedChild } from "../../supervisor";
import type { HostSessionSpec } from "../../types";
import type { LayoutNode } from "../types";

/**
 * M20 (host-supervision determinism, design §5.7/§10): "same page + size + theme must
 * produce a byte-identical frame and layout tree across fresh runs." §5.7's literal recipe
 * is one-shot (`renderOnce` at t=0, frame + layout tree captured from that SAME pass, host
 * killed) — but the wire protocol's `smoke`/`export` one-shot modes exit the child the
 * instant the sealed frame is sent (`host-state-machine.ts`'s `handleMount`: "smoke and
 * export are one-shot... deps.requestExit" runs in the SAME call that sends `ready`+frame),
 * before any correlated request could reach it — WP-5 Task A1 closed that gap for the
 * layout tree specifically: `handleMount` now seals `renderer.layoutTree()` straight into
 * the `ready` body for `smoke`/`export` mounts (`ReadyBody.layout`), so a one-shot
 * incarnation DOES hand back both frame and layout tree today, from that same single pass.
 *
 * This suite still exercises `preview` mode rather than `smoke`/`export`, deliberately: it
 * is the one surface that also proves determinism over the SEPARATE `query-layout` round
 * trip (`resolveGeometry`/`layoutTreeOf` walk the CURRENTLY mounted tree, over a second read
 * from a REAL, freshly spawned `_host --stdio` process, past the ready reply) — a genuinely
 * different code path than the one-shot's single-message seal, and one still worth its own
 * determinism proof independent of Task A1's coverage. Both mechanisms read the identical
 * geometry off the same live, already-rendered `RenderHandle` (nothing has touched it since
 * the render — no resize, no interaction), so it is the same pass either way, just a second
 * round trip instead of `smoke`/`export`'s one bulk reply. KNOWN DIVERGENCE (documented per
 * CLAUDE.md): `preview` mode's mount body does
 * not set the wire `deterministic` flag (only `smoke`/`export` do — see `session.ts`'s
 * mount construction); irrelevant for this fixture, which is static JSX with no timers or
 * randomness (§5.8 bans both outside explicit animation), so nothing depends on that flag.
 *
 * Every render below is a genuinely independent OS process (`createBunSpawn`'s real
 * `Bun.spawn`, exactly `entrypoints.test.ts`'s pattern) — never an in-process one-shot
 * call, whose module-level state (e.g. `@opentui/react`'s per-type id counter) could leak
 * across "runs" inside the SAME process and fake determinism that a fresh process would not
 * actually have.
 */

const repoRoot = path.resolve(import.meta.dir, "../../../..");
const FIXTURE_DIR = path.join(repoRoot, "src/host/session/fixtures");
const FIXTURE_RELPATH = "probe-page.tsx";
const FIXTURE_PATH = path.join(FIXTURE_DIR, FIXTURE_RELPATH);
const MAIN_ENTRY = path.join(repoRoot, "src/main.tsx");

// Generous outer ceilings around the session's OWN internal bounded deadlines (3s
// handshake, 10s mount, 2s query, 1s shutdown-ack + 1s reap) — never used to let a run
// succeed slowly, only so a genuinely wedged child fails this test instead of hanging it
// (mirrors `entrypoints.test.ts`'s `withTimeout` helper).
const STEP_TIMEOUT_MS = 15_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out ${label} after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function buildSpec(): Promise<HostSessionSpec> {
  const bytes = await Bun.file(FIXTURE_PATH).bytes();
  return {
    mode: "preview",
    interactionMode: "static",
    pageSlug: "determinism-probe",
    // The fixture directory read as a design-tree root: the fixture's own name is its
    // tree-relative entry, and the inventory holds exactly that one file (task 15).
    treeRoot: FIXTURE_DIR,
    entryRelPath: FIXTURE_RELPATH,
    expectedFiles: [{ relPath: FIXTURE_RELPATH, sha256: computeSourceHash(bytes) }],
    sourceHash: computeSourceHash(bytes),
    kitApiVersion: 1,
    size: { w: 20, h: 5 },
    theme: "dark-default", // the fixture's own `meta.theme` (probe-page.tsx)
    capabilities: { colorDepth: 24 },
  };
}

/** Tracks the real spawned child so the caller can force-kill it in a `finally`, past
 *  whatever `session.stop()` itself already does — a genuine safety net, not a duplicate
 *  of internal teardown (`SpawnedChild.kill()` is documented idempotent, D2). */
function createTrackedSpawn(): { spawn: SpawnFn; current: () => SpawnedChild | null } {
  const realSpawn = createBunSpawn();
  let current: SpawnedChild | null = null;
  const spawn: SpawnFn = (command) => {
    const spawned = realSpawn(command);
    if (!(spawned instanceof Error)) current = spawned;
    return spawned;
  };
  return { spawn, current: () => current };
}

interface RenderArtifacts {
  readonly frame: { readonly width: number; readonly height: number; readonly rows: unknown };
  readonly layoutTree: LayoutNode;
}

/** Byte-for-byte serialization of the rendered visual payload — never the wire envelope's
 *  identity fields (sessionId/nonce), which are freshly minted per incarnation by design
 *  (§3.1) and are not part of "the frame" in the design's rendered-snapshot sense. */
function canonicalFrameBytes(frame: RenderArtifacts["frame"]): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(frame));
}

/** Spawn ONE fresh, independent `_host --stdio` process, mount the given spec, capture the
 *  sealed first frame plus a `query-layout` reply against it, then gracefully stop. */
async function renderIndependently(spec: HostSessionSpec): Promise<Error | RenderArtifacts> {
  const tracked = createTrackedSpawn();
  const session = createHostSession(spec, {
    spawn: tracked.spawn,
    command: createHostSpawnCommand({
      execPath: process.execPath,
      srcRoot: MAIN_ENTRY,
    }),
    clock: createSystemClock(),
    runtimeDeclaration: EMBEDDED_RUNTIME_DECLARATION,
  });

  try {
    const ready = await withTimeout(session.start(), STEP_TIMEOUT_MS, "session.start()");
    if (ready instanceof Error) return ready;
    const firstFrame = ready.firstFrame;
    if (firstFrame === null) return new Error("ready arrived with no captured first frame");

    const frameIdentity: FrameIdentity = {
      sessionId: ready.identity.sessionId,
      nonce: ready.identity.nonce,
      sourceHash: ready.identity.sourceHash,
      frameSeq: firstFrame.frameSeq,
    };
    const layout = await withTimeout(
      session.query(frameIdentity, { kind: "layout" }),
      STEP_TIMEOUT_MS,
      "session.query(layout)",
    );
    if (layout instanceof Error) return layout;
    if (!layout.ok) return new Error(`layout query refused: ${layout.code} (${layout.reason})`);

    return {
      frame: { width: firstFrame.width, height: firstFrame.height, rows: firstFrame.rows },
      layoutTree: layout.result.tree as LayoutNode,
    };
  } finally {
    // `session.stop()` never rejects and bounds itself internally (1s ack + 1s reap); the
    // wrapper here only guards against an unforeseen internal deadlock. The explicit kill()
    // afterward is what actually guarantees no process outlives this test, regardless of
    // whether stop() finished, timed out, or the try-block threw before it was ever called.
    await withTimeout(session.stop(), STEP_TIMEOUT_MS, "session.stop()").catch(() => {});
    tracked.current()?.kill();
  }
}

describe("host render determinism (M20, design §5.7/§10)", () => {
  test("the same page + size + theme renders a byte-identical frame and an identical layout tree across two independently spawned host processes", async () => {
    const spec = await buildSpec();

    const runA = await renderIndependently(spec);
    if (runA instanceof Error) throw runA;
    const runB = await renderIndependently(spec);
    if (runB instanceof Error) throw runB;

    const bytesA = canonicalFrameBytes(runA.frame);
    const bytesB = canonicalFrameBytes(runB.frame);
    expect(Buffer.compare(bytesA, bytesB)).toBe(0);
    // Structural cross-check too: a byte mismatch alone gives an opaque failure, `toEqual`
    // gives a readable diff on top of the byte-identity assertion above.
    expect(runA.frame).toEqual(runB.frame);

    expect(runA.layoutTree).toEqual(runB.layoutTree);
  }, 45_000);
});
