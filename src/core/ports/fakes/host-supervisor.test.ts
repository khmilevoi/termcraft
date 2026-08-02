import { describe, expect, test } from "bun:test";

import type { FailureDtoV1 } from "core/protocol";

import type { HostSessionSpecV1 } from "../host-supervisor";
import { createFakeHostSupervisorPort } from "./host-supervisor";

const spec: HostSessionSpecV1 = {
  mode: "preview",
  interactionMode: "static",
  pageSlug: "home",
  treeRoot: "/proj/.termcraft/design",
  entryRelPath: "pages/home.tsx",
  expectedFiles: [{ relPath: "pages/home.tsx", sha256: "0".repeat(64) }],
  sourceHash: "a".repeat(64),
  kitApiVersion: 1,
  size: { w: 80, h: 24 },
  theme: "default",
  capabilities: { colorDepth: 8 },
};

const FAILURE: FailureDtoV1 = {
  code: "HOST_START_FAILED",
  retryable: true,
  safeMessage: "spawn failed",
  details: {},
};

describe("createFakeHostSupervisorPort", () => {
  test("preview() composes a live PreviewSession and increases liveCount()", async () => {
    const supervisor = createFakeHostSupervisorPort();
    expect(supervisor.liveCount()).toBe(0);
    const result = await supervisor.preview(spec);
    if ("code" in result) throw new Error("unexpected failure");
    expect(supervisor.liveCount()).toBe(1);
    expect(result.identity.pageSlug).toBe("home");
  });

  test("closing a composed session lowers liveCount() (the fake wires close-through)", async () => {
    const supervisor = createFakeHostSupervisorPort();
    const result = await supervisor.preview(spec);
    if ("code" in result) throw new Error("unexpected failure");
    await result.close();
    expect(supervisor.liveCount()).toBe(0);
  });

  test("stopAll() closes every live session", async () => {
    const supervisor = createFakeHostSupervisorPort();
    await supervisor.preview(spec);
    await supervisor.preview({ ...spec, pageSlug: "about" });
    expect(supervisor.liveCount()).toBe(2);
    await supervisor.stopAll();
    expect(supervisor.liveCount()).toBe(0);
  });

  test("onEvent() receives a lifecycle event when a session becomes ready", async () => {
    const supervisor = createFakeHostSupervisorPort();
    const seen: string[] = [];
    const unsubscribe = supervisor.onEvent((event) => seen.push(event.type));
    await supervisor.preview(spec);
    unsubscribe();
    expect(seen).toContain("ready");
  });

  test("failNext() queues one failure for preview()", async () => {
    const supervisor = createFakeHostSupervisorPort();
    supervisor.failNext("preview", FAILURE);
    const first = await supervisor.preview(spec);
    expect(first).toEqual(FAILURE);
    const second = await supervisor.preview(spec);
    expect("code" in second).toBe(false);
  });

  test("records preview/liveCount/stopAll calls in order", async () => {
    const supervisor = createFakeHostSupervisorPort();
    await supervisor.preview(spec);
    supervisor.liveCount();
    await supervisor.stopAll();
    expect(supervisor.calls.map((c) => c.method)).toEqual(["preview", "liveCount", "stopAll"]);
  });
});
