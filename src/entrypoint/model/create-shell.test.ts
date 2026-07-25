import { afterEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Kernel } from "core/kernel";
import type { GateRunResultV1, PreviewFrameV1, PreviewIdentityV1 } from "core/ports";
import { createFakePreviewSession } from "core/ports/fakes";
import { FrameAckError, PreviewNoLiveSessionError, createFrameTokenLedger } from "core/preview";
import type { PageSlug } from "entities/page";
import { resolveCompilerPath } from "gate";
import type { SmokeRenderer, SmokeRequest, SmokeResult } from "gate";
import { uuidv7 } from "infrastructure/uuid";
import type { EventEnvelopeV1 } from "ui";

import {
  ShellTeardownError,
  buildGateRunner,
  closeShellResources,
  createShell,
  toPreviewSessionHandle,
} from "./create-shell";
import type { ShellDeps, ShellTeardownStep } from "./create-shell";

/** Never actually invoked: constructing a shell never spawns the design host (only a live
 *  `.preview()` call does) — provided defensively so a regression fails loudly instead of
 *  silently touching a real child process. */
const NEVER_SPAWN: ShellDeps["spawn"] = () => {
  throw new Error("spawn must not be called while merely composing a shell");
};

function testShellDeps(scratch: string): ShellDeps {
  return {
    userStateRoot: path.join(scratch, "user-state"),
    execPath: "bun",
    srcRoot: "src/main.tsx",
    spawn: NEVER_SPAWN,
  };
}

const scratchDirs: string[] = [];
function makeScratchDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function firstSnapshot(port: {
  subscribe(handler: (envelope: EventEnvelopeV1) => void): Error | (() => void);
}): Promise<Record<string, unknown>> {
  const received: EventEnvelopeV1[] = [];
  const unsubscribe = port.subscribe((envelope) => received.push(envelope));
  if (unsubscribe instanceof Error) throw unsubscribe;
  unsubscribe();
  const snapshot = received[0];
  if (snapshot === undefined) throw new Error("no bootstrap snapshot delivered");
  return snapshot.payload as Record<string, unknown>;
}

describe("createShell", () => {
  test("the demo shell seeds a trusted project so the workspace is reachable offline", async () => {
    const shell = await createShell("demo", { root: "(demo)", workspaceIdentity: "demo" });
    if (shell instanceof Error) throw shell;
    const payload = await firstSnapshot(shell.port);

    expect(shell.mode).toBe("demo");
    expect(payload.projectId).not.toBeNull();
    expect(payload.trust).toBe("trusted");
    expect(payload.capabilities).not.toEqual([]);
    expect(shell.port.preview()).not.toBeNull();
    await shell.close();
  });

  test("closing the demo shell is idempotent and ends its preview stream", async () => {
    const shell = await createShell("demo", { root: "(demo)", workspaceIdentity: "demo" });
    if (shell instanceof Error) throw shell;
    const handle = shell.port.preview();
    if (handle === null) throw new Error("demo shell must expose a preview handle");

    await shell.close();
    await shell.close();

    const frames = handle.frames[Symbol.asyncIterator]();
    expect((await frames.next()).done).toBe(false);
    expect((await frames.next()).done).toBe(true);
  });

  test("the interactive shell composes a real Kernel, not ui/testing's FakeKernel", async () => {
    const scratch = makeScratchDir("termcraft-shell-real-");
    const root = path.join(scratch, "project");

    const shell = await createShell(
      "interactive",
      { root, workspaceIdentity: root },
      testShellDeps(scratch),
    );
    if (shell instanceof Error) throw shell;

    expect(shell.mode).toBe("interactive");
    // The one behavioral proof `createFakeKernel()` cannot fake: a malformed raw envelope
    // must fail the real decode pipeline. The fake's `dispatch` echoes an "accepted" result
    // for ANY input, real or not.
    const result = await shell.port.dispatch({});
    expect(result).toBeInstanceOf(Error);

    await shell.close();
  });

  test("the interactive shell opens on Home with the caller's project root", async () => {
    const scratch = makeScratchDir("termcraft-shell-home-");
    const root = path.join(scratch, "project");

    const shell = await createShell(
      "interactive",
      { root, workspaceIdentity: "placeholder" },
      testShellDeps(scratch),
    );
    if (shell instanceof Error) throw shell;

    expect(shell.env.root).toBe(root);
    // `projectId` is null here NOT because `buildSnapshotPayload` hardcodes it — the §10
    // smoke-closeout fix (`core/kernel/model/kernel.ts`'s own `growableProjectId`) already
    // makes it track the real open project for any subscriber, late or not. It's null because
    // `createShell` only opens the project at the store level and never dispatches the kernel's
    // own `project.open` command, so `growableProjectId` is simply never populated on this
    // bootstrap path. `activePageSlug`/`activeChatId` DO still stay hardcoded `null` in
    // `buildSnapshotPayload` (a separate, still-open gap) — so every bootstrap snapshot opens
    // on Home (`ui/mirror/model/screen.ts`'s `projectId === null` branch) regardless of whether
    // a real project was opened.
    expect((await firstSnapshot(shell.port)).projectId).toBeNull();
    expect(shell.port.preview()).toBeNull();

    await shell.close();
  });

  test("a fresh directory becomes a real on-disk project, and workspaceIdentity is its durable projectId", async () => {
    const scratch = makeScratchDir("termcraft-shell-create-");
    const root = path.join(scratch, "brand-new");

    const shell = await createShell(
      "interactive",
      { root, workspaceIdentity: root },
      testShellDeps(scratch),
    );
    if (shell instanceof Error) throw shell;

    expect(fs.existsSync(path.join(root, ".termcraft"))).toBe(true);
    expect(shell.env.workspaceIdentity).not.toBe(root);
    expect(shell.env.workspaceIdentity.length).toBeGreaterThan(0);

    await shell.close();
  });

  test("re-opening the same on-disk project reports the same durable workspaceIdentity", async () => {
    const scratch = makeScratchDir("termcraft-shell-reopen-");
    const root = path.join(scratch, "project");

    const first = await createShell(
      "interactive",
      { root, workspaceIdentity: root },
      testShellDeps(scratch),
    );
    if (first instanceof Error) throw first;
    const firstIdentity = first.env.workspaceIdentity;
    await first.close();

    const second = await createShell(
      "interactive",
      { root, workspaceIdentity: root },
      testShellDeps(scratch),
    );
    if (second instanceof Error) throw second;

    expect(second.env.workspaceIdentity).toBe(firstIdentity);
    await second.close();
  });

  test("closing the interactive shell releases the project lease so it can be reopened", async () => {
    const scratch = makeScratchDir("termcraft-shell-close-");
    const root = path.join(scratch, "project");

    const shell = await createShell(
      "interactive",
      { root, workspaceIdentity: root },
      testShellDeps(scratch),
    );
    if (shell instanceof Error) throw shell;
    await shell.close();
    await shell.close();

    const reopened = await createShell(
      "interactive",
      { root, workspaceIdentity: root },
      testShellDeps(scratch),
    );
    expect(reopened).not.toBeInstanceOf(Error);
    if (reopened instanceof Error) throw reopened;
    await reopened.close();
  });

  test("the interactive shell exposes its real agent registry (Task 9 / WP-5's probe seam)", async () => {
    const scratch = makeScratchDir("termcraft-shell-registry-");
    const root = path.join(scratch, "project");

    const shell = await createShell(
      "interactive",
      { root, workspaceIdentity: root },
      testShellDeps(scratch),
    );
    if (shell instanceof Error) throw shell;

    expect(shell.agentRegistry).not.toBeNull();
    const capabilities = shell.agentRegistry?.list() ?? [];
    expect(capabilities).toHaveLength(1);
    expect(shell.agentRegistry?.get(capabilities[0]?.backendId ?? "")).not.toBeNull();

    await shell.close();
  });

  test("the demo shell exposes no agent registry — there is no real agent to probe offline", async () => {
    const shell = await createShell("demo", { root: "(demo)", workspaceIdentity: "demo" });
    if (shell instanceof Error) throw shell;

    expect(shell.agentRegistry).toBeNull();

    await shell.close();
  });

  test("the two modes are seeded differently", async () => {
    const scratch = makeScratchDir("termcraft-shell-diff-");
    const root = path.join(scratch, "project");

    const interactive = await createShell(
      "interactive",
      { root, workspaceIdentity: root },
      testShellDeps(scratch),
    );
    if (interactive instanceof Error) throw interactive;
    const demo = await createShell("demo", { root: ".", workspaceIdentity: "a" });
    if (demo instanceof Error) throw demo;

    const interactivePayload = await firstSnapshot(interactive.port);
    const demoPayload = await firstSnapshot(demo.port);
    expect(interactivePayload.projectId).not.toEqual(demoPayload.projectId);

    await interactive.close();
    await demo.close();
  });
});

/**
 * phase-8 Task 16 — `toPreviewSessionHandle`, exported specifically so this suite can
 * exercise it directly (see its own doc comment in `create-shell.ts`). A real `Kernel`
 * cannot reach a live preview session through `createShell("interactive", ...)` today —
 * `kernel.test.ts`'s own "Kernel.publishFrame / Kernel.acknowledgeDisplay" suite documents
 * why (`kernel.preview.enable` is never dispatched by any currently-wired handler, a
 * pre-existing gap unrelated to this task) — so these tests use a minimal `Kernel` double
 * narrowed to exactly the two methods `toPreviewSessionHandle` calls, backed by a REAL
 * `createFrameTokenLedger()` (the exact production ledger, not a stub): this is enough to
 * prove the composition root's own wiring — no fabricated token, a genuinely minted token
 * round-trips through acknowledgement, and an unknown token is still refused.
 */
describe("toPreviewSessionHandle (frame-token wiring)", () => {
  const IDENTITY: PreviewIdentityV1 = {
    mode: "preview",
    pageSlug: "home",
    sourceHash: "a".repeat(64),
    kitApiVersion: 1,
    sessionId: "fake-session-1",
  };

  function ledgerBackedKernel(): Pick<Kernel, "acknowledgeDisplay" | "publishFrame"> {
    const ledger = createFrameTokenLedger();
    return {
      publishFrame: (frame: PreviewFrameV1) =>
        ledger.mint({
          previewSessionId: uuidv7(),
          nonce: "a".repeat(32),
          sourceHash: frame.sourceHash,
          frameSeq: frame.frameSeq,
        }),
      acknowledgeDisplay: (frameToken) => ledger.acknowledge(frameToken),
    };
  }

  function pushedFrame(): PreviewFrameV1 {
    return {
      sessionId: IDENTITY.sessionId,
      sourceHash: IDENTITY.sourceHash,
      frameSeq: "1",
      width: 80,
      height: 24,
      rows: [],
    };
  }

  test("every yielded frame carries a token the ledger recognises; acknowledging it succeeds, and a never-minted token still fails", async () => {
    const kernel = ledgerBackedKernel();
    const session = createFakePreviewSession(IDENTITY);
    const handle = toPreviewSessionHandle(kernel, session);

    session.emitFrame(pushedFrame());
    session.close();

    const iterator = handle.frames[Symbol.asyncIterator]();
    const first = await iterator.next();
    if (first.done === true) throw new Error("expected one frame");
    const uiFrame = first.value;

    // Before acknowledgement the token is only PENDING, not yet the ledger's current one
    // (`frame-token-ledger.ts`'s own §13.3 contract: "unusable before display
    // acknowledgement") — proves the token genuinely came from the ledger's `mint`, not an
    // arbitrary string that happens to look right.
    expect(uiFrame.frameToken).not.toBe("");

    const acked = handle.acknowledgeDisplay(uiFrame.frameToken);
    if (acked instanceof Error) throw acked;
    expect(acked.sourceHash).toBe(IDENTITY.sourceHash);
    expect(acked.frameSeq).toBe("1");

    // That last assertion is what proves the ledger is real rather than a rubber stamp —
    // an unknown/never-minted token must still fail.
    const neverMinted = "0192f6f0-0000-7000-8000-0000000000ff";
    const rejected = handle.acknowledgeDisplay(neverMinted);
    expect(rejected).toBeInstanceOf(FrameAckError);

    const done = await iterator.next();
    expect(done.done).toBe(true);
  });

  test("a frame published with no live Kernel session is dropped and logged, never yielded with an invented token", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const kernel: Pick<Kernel, "acknowledgeDisplay" | "publishFrame"> = {
      publishFrame: () =>
        new PreviewNoLiveSessionError({ reason: "no live session in this fixture" }),
      acknowledgeDisplay: () => new FrameAckError({ reason: "unused in this fixture" }),
    };
    const session = createFakePreviewSession(IDENTITY);
    const handle = toPreviewSessionHandle(kernel, session);

    session.emitFrame(pushedFrame());
    session.close();

    const iterator = handle.frames[Symbol.asyncIterator]();
    const result = await iterator.next();

    // The generator skips straight to completion — no frame with a fabricated token was
    // ever yielded.
    expect(result.done).toBe(true);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });
});

/**
 * WP-2 / Task 7 acceptance (phase-8 design §WP-2: "the Gate catches a deliberate type error on
 * a fixture page against the real generated declaration, in the shipped configuration") — the
 * composed Gate's `typeCheck` stage is genuinely LIVE, not just non-throwing.
 *
 * `AppShell`/`KernelPort` expose no seam to reach the Kernel's own internally-wired
 * `gateRunner` directly: the only way to drive it live is a full `turn.start`, which needs a
 * real or fake agent, and `ShellDeps` (this file's own `ShellDeps`) has no seam to inject one
 * either — the exact same gap `smoke.test.ts`'s own header documents as the reason IT
 * re-composes `KernelDeps` one level below `createShell` instead of calling `createShell`
 * itself. So this suite proves the wiring two ways instead: (1) `createShell("interactive", ...)`
 * itself must still succeed under the real `resolveCompilerPath()` (`create-shell.ts` now
 * returns a `ShellCompositionError` instead of a shell when that resolution fails, so a
 * successful construction here already exercises that guard on the happy path); (2)
 * `runGateOnFixture` below calls `create-shell.ts`'s own EXPORTED `buildGateRunner` — the exact
 * production function `interactiveShell` itself calls to build `kernelDeps.gateRunner` — with a
 * fake `smokeRenderer` so no real host process spawns, and runs a fixture through its `runPage`
 * entry. That makes this test depend on `create-shell.ts`'s real Task 7 wiring, not a
 * reimplementation of it: reverting `buildGateRunner`'s body would fail this test too.
 */
describe("createShell + the composed Gate's type-check stage (phase-8 WP-2)", () => {
  /** Always reports a clean render, never spawning a real host process. Mirrors
   *  `smoke.test.ts`'s own `createFakeSmokeRenderer` (this file's sibling suite) — that file's
   *  header documents the same deliberate choice: fake the host/smoke side, keep the
   *  type-check-relevant stages real. Reused here rather than inventing a second staging path.
   *  Doubly moot for the type-error fixture below regardless: `gate/model/gate.ts`'s own
   *  pipeline only reaches the smoke stage when there are zero fatal errors so far, and a
   *  `type`-kind error is fatal — smoke never runs for that fixture either way. */
  function createFakeSmokeRenderer(): SmokeRenderer {
    return {
      render(_request: SmokeRequest): Promise<SmokeResult> {
        return Promise.resolve({ ok: true });
      },
    };
  }

  /** Runs one fixture through `create-shell.ts`'s own exported `buildGateRunner` — the real
   *  production composition, not a local reimplementation — paired with a fake `smokeRenderer`.
   *  Throws on a failed compiler resolution (a fixture-setup failure, not an assertion this test
   *  is making) so a broken install fails loudly instead of the type check silently reporting no
   *  errors. */
  async function runGateOnFixture(fixture: {
    readonly slug: PageSlug;
    readonly source: string;
  }): Promise<GateRunResultV1> {
    const tscExePath = resolveCompilerPath();
    if (tscExePath instanceof Error) throw tscExePath;
    const gateRunner = buildGateRunner(tscExePath, createFakeSmokeRenderer());
    return gateRunner.runPage({ source: fixture.source, slug: fixture.slug });
  }

  const HOME_SLUG = "home" as PageSlug;

  /** The same page shape `gate/model/gate.test.ts`'s own `cleanSource` fixture uses — proven
   *  there to pass the full source-only pipeline standalone. */
  const CLEAN_SOURCE = `import { definePage, reatomComponent, Panel, Text } from "@termcraft/runtime"
export const meta = definePage({ kitApiVersion: 1, title: "Home", minSize: { w: 80, h: 24 }, theme: "dark-default" })
export default reatomComponent(() => <Panel id="p"><Text id="t">hello from the composed gate runner</Text></Panel>)
`;

  /** `CLEAN_SOURCE` plus one deliberately type-incompatible top-level statement — the import
   *  scan, page contract, and default export all stay untouched, so only the `typeCheck`
   *  stage's own diagnostic should surface. */
  const TYPE_ERROR_SOURCE = `import { definePage, reatomComponent, Panel, Text } from "@termcraft/runtime"
const n: number = "not a number"
export const meta = definePage({ kitApiVersion: 1, title: "Home", minSize: { w: 80, h: 24 }, theme: "dark-default" })
export default reatomComponent(() => <Panel id="p"><Text id="t">hello from the composed gate runner</Text></Panel>)
`;

  // Two real `typescript/unstable/sync` invocations (one per fixture) plus a full
  // interactive-shell composition against a real on-disk project — observed at ~1.1s locally,
  // but the default 5000ms per-test timeout leaves little margin for a colder cache or a
  // loaded CI box. 30_000ms matches the timeout `gate/model/type-check.test.ts` and
  // `gate/model/tsc-extract.test.ts` already use for real-compiler assertions.
  const TYPE_CHECK_TEST_TIMEOUT_MS = 30_000;

  test(
    "the composed gate runner rejects a page with a type error, and passes a clean page with none",
    async () => {
      const scratch = makeScratchDir("termcraft-shell-gate-");
      const root = path.join(scratch, "project");

      const shell = await createShell(
        "interactive",
        { root, workspaceIdentity: root },
        testShellDeps(scratch),
      );
      if (shell instanceof Error) throw shell;

      const typed = await runGateOnFixture({ slug: HOME_SLUG, source: TYPE_ERROR_SOURCE });
      expect(typed.errors.some((e) => e.kind === "type")).toBe(true);

      // The mirror assertion: a test that only proves rejection cannot distinguish "the
      // checker works" from "the checker rejects everything".
      const clean = await runGateOnFixture({ slug: HOME_SLUG, source: CLEAN_SOURCE });
      expect(clean.errors.some((e) => e.kind === "type")).toBe(false);

      await shell.close();
    },
    TYPE_CHECK_TEST_TIMEOUT_MS,
  );
});

describe("closeShellResources", () => {
  test("kernel.close rejecting still releases the lease, and the failure surfaces only after every step ran", async () => {
    const order: string[] = [];
    const cause = new Error("kernel.close boom");
    const steps: ShellTeardownStep[] = [
      {
        name: "kernel.close",
        run: () => {
          order.push("kernel.close");
          return Promise.reject(cause);
        },
      },
      {
        name: "hostSupervisor.stopAll",
        run: async () => {
          order.push("hostSupervisor.stopAll");
        },
      },
      {
        name: "open.close",
        run: async () => {
          order.push("open.close");
        },
      },
    ];

    const teardown = closeShellResources(steps);

    await expect(teardown).rejects.toBeInstanceOf(ShellTeardownError);
    // The lease-release step (`open.close`) ran even though the first step rejected.
    expect(order).toEqual(["kernel.close", "hostSupervisor.stopAll", "open.close"]);

    const failure = await teardown.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ShellTeardownError);
    expect((failure as ShellTeardownError).step).toBe("kernel.close");
    expect((failure as ShellTeardownError).cause).toBe(cause);
  });

  test("reports only the FIRST failure when multiple steps reject", async () => {
    const firstCause = new Error("kernel.close boom");
    const secondCause = new Error("open.close boom");

    const teardown = closeShellResources([
      { name: "kernel.close", run: () => Promise.reject(firstCause) },
      { name: "hostSupervisor.stopAll", run: () => Promise.resolve() },
      { name: "open.close", run: () => Promise.reject(secondCause) },
    ]);

    const failure = await teardown.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ShellTeardownError);
    expect((failure as ShellTeardownError).step).toBe("kernel.close");
  });

  test("resolves cleanly when every step succeeds", async () => {
    await expect(
      closeShellResources([
        { name: "a", run: () => Promise.resolve() },
        { name: "b", run: () => Promise.resolve() },
      ]),
    ).resolves.toBeUndefined();
  });
});
