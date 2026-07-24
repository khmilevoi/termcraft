import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { EventEnvelopeV1 } from "ui";

import { ShellTeardownError, closeShellResources, createShell } from "./create-shell";
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
    isCompiled: false,
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
