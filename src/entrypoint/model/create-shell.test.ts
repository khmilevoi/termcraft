import { describe, expect, test } from "bun:test";

import type { EventEnvelopeV1 } from "ui";

import { createShell } from "./create-shell";

function firstSnapshot(shell: ReturnType<typeof createShell>) {
  const received: EventEnvelopeV1[] = [];
  const unsubscribe = shell.port.subscribe((envelope) => received.push(envelope));
  if (unsubscribe instanceof Error) throw unsubscribe;
  unsubscribe();
  const snapshot = received[0];
  if (snapshot === undefined) throw new Error("no bootstrap snapshot delivered");
  return snapshot.payload as Record<string, unknown>;
}

describe("createShell", () => {
  test("the interactive shell opens on Home with the caller's project root", () => {
    const shell = createShell("interactive", { root: "C:/projects/site", workspaceIdentity: "id" });

    expect(shell.mode).toBe("interactive");
    expect(shell.env).toEqual({ root: "C:/projects/site", workspaceIdentity: "id" });
    expect(firstSnapshot(shell).projectId).toBeNull();
    expect(shell.port.preview()).toBeNull();
  });

  test("the demo shell seeds a trusted project so the workspace is reachable offline", () => {
    const shell = createShell("demo", { root: "(demo)", workspaceIdentity: "demo" });
    const payload = firstSnapshot(shell);

    expect(shell.mode).toBe("demo");
    expect(payload.projectId).not.toBeNull();
    expect(payload.trust).toBe("trusted");
    expect(payload.capabilities).not.toEqual([]);
    expect(shell.port.preview()).not.toBeNull();
  });

  test("the two modes are seeded differently", () => {
    const interactive = firstSnapshot(
      createShell("interactive", { root: ".", workspaceIdentity: "a" }),
    );
    const demo = firstSnapshot(createShell("demo", { root: ".", workspaceIdentity: "a" }));

    expect(interactive.projectId).not.toEqual(demo.projectId);
  });

  test("closing a shell is idempotent and ends its preview stream", async () => {
    const shell = createShell("demo", { root: "(demo)", workspaceIdentity: "demo" });
    const handle = shell.port.preview();
    if (handle === null) throw new Error("demo shell must expose a preview handle");

    await shell.close();
    await shell.close();

    // The seeded frame is still buffered; the stream must terminate right behind it rather
    // than leave a consumer awaiting a frame that can no longer arrive.
    const frames = handle.frames[Symbol.asyncIterator]();
    expect((await frames.next()).done).toBe(false);
    expect((await frames.next()).done).toBe(true);
  });
});
