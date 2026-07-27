import { describe, expect, test } from "bun:test";

import { context } from "@reatom/core";

import type { PreviewFrameV1 } from "core/ports";
import type { HomeAgentHealth } from "ui/home";
import { homeSubmitAllowed } from "ui/home";
import { TEST_SHA, createFakeKernel, createFakePreviewSession, event } from "ui/testing";

import { UiPreviewStreamError, createUiDeps } from "./deps";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function frame(sessionId: string): PreviewFrameV1 {
  return {
    sessionId,
    sourceHash: TEST_SHA,
    frameSeq: "1",
    width: 1,
    height: 1,
    rows: [[{ text: "x", fg: "default", bg: "default", attrs: 0 }]],
  };
}

describe("createUiDeps runtime", () => {
  test("removes its Kernel subscription when the runtime atom disconnects", async () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });

    const unsubscribe = deps.runtime.subscribe(() => undefined);
    await tick();
    expect(kernel.subscriberCount()).toBe(1);

    unsubscribe();
    await tick();
    expect(kernel.subscriberCount()).toBe(0);
  });

  test("keeps a Kernel subscription failure in runtimeError", async () => {
    const subscriptionFailure = new Error("snapshot unavailable");
    const kernel = createFakeKernel();
    const port = { ...kernel, subscribe: () => subscriptionFailure };
    const deps = createUiDeps(port, { w: 120, h: 36 });

    const unsubscribe = deps.runtime.subscribe(() => undefined);
    await tick();
    expect(deps.runtimeError()).toBe(subscriptionFailure);
    unsubscribe();
  });

  test("turns a frame-stream rejection into UiPreviewStreamError", async () => {
    const sourceFailure = new Error("stream lost");
    const preview = createFakePreviewSession();
    const rejectedFrames: AsyncIterable<never> = {
      [Symbol.asyncIterator]() {
        return { next: () => Promise.reject(sourceFailure) };
      },
    };
    const handle = {
      ...preview.handle,
      session: { ...preview.handle.session, frames: rejectedFrames },
      frames: rejectedFrames,
    };
    const kernel = createFakeKernel();
    kernel.setPreview(handle);
    const deps = createUiDeps(kernel, { w: 120, h: 36 });

    const unsubscribe = deps.runtime.subscribe(() => undefined);
    await tick();
    const runtimeError = deps.runtimeError();
    unsubscribe();

    expect(runtimeError).toBeInstanceOf(UiPreviewStreamError);
    expect(runtimeError?.cause).toBe(sourceFailure);
  });

  test("keeps the displayed frame bundle intact", async () => {
    const preview = createFakePreviewSession();
    const kernel = createFakeKernel();
    kernel.setPreview(preview.handle);
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    const displayed = frame(preview.handle.previewSessionId);

    const unsubscribe = deps.runtime.subscribe(() => undefined);
    preview.pushFrame(displayed);
    await tick();
    const latest = deps.previewFrame();
    unsubscribe();

    expect(latest?.frame).toBe(displayed);
    expect(latest?.frameToken).toBe(preview.frameTokenFor(displayed));
    expect(latest?.handle).toBe(preview.handle);
  });

  test("keeps an asynchronously received frame in the runtime's scoped context", async () => {
    const preview = createFakePreviewSession();
    const kernel = createFakeKernel();
    kernel.setPreview(preview.handle);
    const scoped = context.start();
    let unsubscribe: (() => void) | null = null;

    const deps = scoped.run(() => {
      const created = createUiDeps(kernel, { w: 120, h: 36 });
      unsubscribe = created.runtime.subscribe(() => undefined);
      return created;
    });
    await tick();
    const displayed = frame(preview.handle.previewSessionId);
    preview.pushFrame(displayed);
    await tick();

    expect(scoped.run(() => deps?.previewFrame()?.frame)).toBe(displayed);
    expect(deps.previewFrame()).toBeNull();
    scoped.run(() => unsubscribe?.());
  });

  test("keeps an asynchronously received stream failure in the runtime's scoped context", async () => {
    const sourceFailure = new Error("scoped stream lost");
    const preview = createFakePreviewSession();
    const rejectedFrames: AsyncIterable<never> = {
      [Symbol.asyncIterator]() {
        return { next: () => Promise.reject(sourceFailure) };
      },
    };
    const kernel = createFakeKernel();
    kernel.setPreview({ ...preview.handle, frames: rejectedFrames });
    const scoped = context.start();
    let unsubscribe: (() => void) | null = null;

    const deps = scoped.run(() => {
      const created = createUiDeps(kernel, { w: 120, h: 36 });
      unsubscribe = created.runtime.subscribe(() => undefined);
      return created;
    });
    await tick();

    expect(scoped.run(() => deps?.runtimeError())).toBeInstanceOf(UiPreviewStreamError);
    expect(deps.runtimeError()).toBeNull();
    scoped.run(() => unsubscribe?.());
  });

  test("keeps externally delivered Kernel events in the runtime's scoped mirror", async () => {
    const kernel = createFakeKernel();
    const scoped = context.start();
    let unsubscribe: (() => void) | null = null;
    const deps = scoped.run(() => {
      const created = createUiDeps(kernel, { w: 120, h: 36 });
      unsubscribe = created.runtime.subscribe(() => undefined);
      return created;
    });
    await tick();

    kernel.emit(
      event("selection.changed", { pageSlug: "main", elementId: "cpu", sourceHash: TEST_SHA }),
    );

    expect(scoped.run(() => deps.mirror.selection()?.elementId)).toBe("cpu");
    expect(deps.mirror.selection()).toBeNull();
    scoped.run(() => unsubscribe?.());
  });

  test("disconnect terminates a blocked frame consumer", async () => {
    const preview = createFakePreviewSession();
    const kernel = createFakeKernel();
    kernel.setPreview(preview.handle);
    const deps = createUiDeps(kernel, { w: 120, h: 36 });

    const unsubscribe = deps.runtime.subscribe(() => undefined);
    await tick();
    expect(preview.activeFrameConsumers()).toBe(1);

    unsubscribe();
    await tick();
    expect(preview.activeFrameConsumers()).toBe(0);
  });
});

describe("createUiDeps Home health probe (M15)", () => {
  test("runs the injected probe once at startup, through the same path home-recheck uses", async () => {
    const kernel = createFakeKernel();
    let calls = 0;
    const deps = createUiDeps(kernel, { w: 120, h: 36 }, undefined, () => {
      calls += 1;
      return Promise.resolve({ kind: "missing", agent: "claude", detail: "claude CLI not found" });
    });

    await tick();

    // A real probe reporting a missing agent surfaces without a manual `r` re-check.
    expect(calls).toBeGreaterThanOrEqual(1);
    expect(deps.local.homeHealth()).toEqual({
      kind: "missing",
      agent: "claude",
      detail: "claude CLI not found",
    });
  });

  test("a startup probe reporting the agent ready overwrites the pre-probe placeholder", async () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 }, undefined, () =>
      Promise.resolve({ kind: "ready", agent: "claude" }),
    );

    await tick();

    expect(deps.local.homeHealth()).toEqual({ kind: "ready", agent: "claude" });
  });

  // REGRESSION GUARD for fix round 1, Finding 1 (CRITICAL): the DEFAULT probe (no
  // `agentHealthProbe` injected — the 4th parameter is omitted here on purpose) is REACHABLE IN
  // PRODUCTION for demo mode and an empty catalog (`entrypoint/model/run-app.ts`'s
  // `resolveAgentHealthProbe` returns `undefined` for both, and `ui/app/model/root.tsx` forwards
  // that `undefined` straight into this same default parameter). It must never settle on
  // `ready` — that would claim a passed health check with no probe ever having run, the exact
  // fabrication finding §2.7 exists to remove, reachable from a live path this test pins.
  // Reverting `deps.ts`'s `DEFAULT_PROBE_RESOLUTION` back to `{ kind: "ready", ... }` (its
  // original, wrong value) fails this test.
  test("the DEFAULT probe (none injected) settles to an honest advisory reading, never ready (fix round 1, Finding 1)", async () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 }); // no agentHealthProbe: the production demo-mode / empty-catalog path

    // The synchronous pre-probe seed — honest `checking`, never `ready` (finding §2.7 itself).
    expect(deps.local.homeHealth()).toEqual({ kind: "checking", agent: "claude" });

    await tick();

    const settled = deps.local.homeHealth();
    expect(settled.kind).not.toBe("ready");
    expect(settled.kind).toBe("advisory");
    // Still usable — advisory permits submit — just never on a fabricated "verified" claim.
    expect(homeSubmitAllowed(settled)).toBe(true);
  });
});

describe("createUiDeps preview session (phase-8 Task 21 / Gap A §4.7)", () => {
  /**
   * `page.descriptorsChanged` is the one event that moves `ProjectMirror.activePageSlug`
   * (`ui/mirror/model/mirror.ts`'s `case "page.descriptorsChanged"`). The descriptor list itself is
   * irrelevant to this subscriber — only the active slug is — so it stays empty here.
   */
  const activePage = (activePageSlug: string | null) =>
    event("page.descriptorsChanged", {
      reason: "turn-apply",
      descriptors: [],
      changes: [],
      activePageSlug,
    });

  const selectedPages = (kernel: ReturnType<typeof createFakeKernel>): readonly unknown[] =>
    kernel.dispatched
      .filter(
        (raw): raw is { kind: string; payload: { pageSlug: string } } =>
          typeof raw === "object" &&
          raw !== null &&
          "kind" in raw &&
          raw.kind === "preview.selectPage",
      )
      .map((raw) => raw.payload);

  test("dispatches preview.selectPage when the active page slug appears, and again when it changes", async () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    const unsubscribe = deps.runtime.subscribe(() => undefined);
    await tick();

    kernel.emit(activePage("main"));
    await tick();
    kernel.emit(activePage("settings"));
    await tick();
    // Unchanged — the subscriber must not ask the Kernel to re-establish the same session.
    kernel.emit(activePage("settings"));
    await tick();

    expect(selectedPages(kernel)).toEqual([{ pageSlug: "main" }, { pageSlug: "settings" }]);
    unsubscribe();
  });

  /** The same event, but carrying a real descriptor for the active page — what the Kernel publishes after a turn commits. */
  const activePageWithHash = (activePageSlug: string, sourceHash: string) =>
    event("page.descriptorsChanged", {
      reason: "turn-apply",
      descriptors: [
        {
          status: "ready",
          pageSlug: activePageSlug,
          sourceHash,
          title: activePageSlug,
          minSize: { w: 80, h: 24 },
          theme: "dark",
          kitApiVersion: 1,
        },
      ],
      changes: [],
      activePageSlug,
    });

  test("re-selects the SAME page when a turn changes its source — the memo is keyed on content, not just the slug", async () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    const unsubscribe = deps.runtime.subscribe(() => undefined);
    await tick();

    kernel.emit(activePageWithHash("main", "a".repeat(64)));
    await tick();
    // The user asks the agent to change the page they are already looking at: same slug, new
    // bytes. A slug-keyed memo returned early here and the live session went on rendering the
    // pre-turn source — the user's own change was invisible.
    kernel.emit(activePageWithHash("main", "b".repeat(64)));
    await tick();
    // ...and an unchanged republish must still NOT re-establish a session.
    kernel.emit(activePageWithHash("main", "b".repeat(64)));
    await tick();

    expect(selectedPages(kernel)).toEqual([{ pageSlug: "main" }, { pageSlug: "main" }]);
    unsubscribe();
  });

  test("stops dispatching once the runtime disconnects (RTM-L01)", async () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    const unsubscribe = deps.runtime.subscribe(() => undefined);
    await tick();

    kernel.emit(activePage("main"));
    await tick();
    unsubscribe();
    await tick();
    kernel.emit(activePage("settings"));
    await tick();

    expect(selectedPages(kernel)).toEqual([{ pageSlug: "main" }]);
  });
});

describe("createUiDeps refreshHomeHealth", () => {
  test("re-enters `checking` while the probe runs, so a manual `r` re-check is visible", async () => {
    // A hand-driven probe: each call hands back a promise this test settles when it chooses,
    // so the mid-probe state is observable rather than raced against.
    const pending: ((value: HomeAgentHealth) => void)[] = [];
    const probe = () =>
      new Promise<HomeAgentHealth>((resolve) => {
        pending.push(resolve);
      });
    const settle = (value: HomeAgentHealth) => {
      const resolve = pending.shift();
      if (resolve === undefined) throw new Error("fixture bug: no probe in flight to settle");
      resolve(value);
    };
    const deps = createUiDeps(createFakeKernel(), { w: 120, h: 36 }, undefined, probe);
    await tick();

    // Settle the startup probe on a BLOCKING verdict — the state a user would be looking at
    // when they fix the cause and press `r`.
    settle({ kind: "blocked", agent: "claude", panel: "login", detail: "not signed in" });
    await tick();
    expect(deps.local.homeHealth().kind).toBe("blocked");

    // The re-check itself. Without this fix the stale `blocked` verdict stayed on screen for the
    // probe's entire run (up to 20s), with nothing to say a re-check was happening at all.
    void deps.refreshHomeHealth();
    expect(deps.local.homeHealth()).toEqual({ kind: "checking", agent: "claude" });

    settle({ kind: "ready", agent: "claude" });
    await tick();
    expect(deps.local.homeHealth().kind).toBe("ready");
  });
});

describe("createUiDeps blocked-open recovery", () => {
  /**
   * `handlers/project.ts`'s own `blockOpen` shape: the action, plus the `{reason, failure}` it
   * publishes as this transition's `metadata`.
   */
  const blockOpen = (reason: string, safeMessage: string) =>
    event("kernel.stateChanged", {
      modelId: "kernel.project.state",
      action: "kernel.project.blockOpen",
      previousTag: "opening",
      nextTag: "blocked",
      metadata: {
        reason,
        failure: { code: "PERSISTENCE_FAILED", retryable: true, safeMessage, details: {} },
      },
    });

  const closes = (kernel: ReturnType<typeof createFakeKernel>): number =>
    kernel.dispatched.filter(
      (raw) =>
        typeof raw === "object" && raw !== null && "kind" in raw && raw.kind === "project.close",
    ).length;

  test("closes the blocked project so Home's Enter becomes legal again", async () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    const unsubscribe = deps.runtime.subscribe(() => undefined);
    await tick();

    kernel.emit(blockOpen("manifest-read-failed", "project.toml could not be read"));
    await tick();

    // Without this dispatch the project machine stays in `blocked`, where `beginOpen`/
    // `beginCreate` are both illegal — so every Enter on Home is rejected silently, forever.
    expect(closes(kernel)).toBe(1);
    expect(deps.mirror.project().openFailure).toEqual({
      reason: "manifest-read-failed",
      safeMessage: "project.toml could not be read",
    });
    unsubscribe();
  });

  test("does not loop: the recovery's own finishClose preserves the reason but re-dispatches nothing", async () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    const unsubscribe = deps.runtime.subscribe(() => undefined);
    await tick();

    kernel.emit(blockOpen("page-list-failed", "pages/ could not be listed"));
    await tick();
    // `finishClose` leaves `projectId` null and DELIBERATELY keeps `openFailure` — exactly the
    // pair the subscriber tests, so a value-blind guard would dispatch `project.close` again
    // (illegal from `closed`) on every project write from here on.
    kernel.emit(
      event("kernel.stateChanged", {
        modelId: "kernel.project.state",
        action: "kernel.project.finishClose",
        previousTag: "closing",
        nextTag: "closed",
        metadata: { projectId: null },
      }),
    );
    await tick();

    expect(closes(kernel)).toBe(1);
    // The panel outlives the recovery — that is the whole point of carrying it across.
    expect(deps.mirror.project().openFailure).not.toBeNull();
    unsubscribe();
  });

  test("a SECOND block recovers again — the latch is per failure, not once per process", async () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    const unsubscribe = deps.runtime.subscribe(() => undefined);
    await tick();

    kernel.emit(blockOpen("page-list-failed", "pages/ could not be listed"));
    await tick();
    kernel.emit(blockOpen("page-list-failed", "pages/ could not be listed"));
    await tick();

    expect(closes(kernel)).toBe(2);
    unsubscribe();
  });
});

describe("createUiDeps requestExit (phase-8 Task 11 / WP-10)", () => {
  test("defaults to a no-op so every existing UiDeps construction keeps compiling", () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    expect(() => deps.requestExit()).not.toThrow();
  });

  test("the injected requestExit is exposed verbatim, not wrapped", () => {
    const kernel = createFakeKernel();
    let calls = 0;
    const requestExit = () => {
      calls += 1;
    };
    const deps = createUiDeps(kernel, { w: 120, h: 36 }, undefined, undefined, requestExit);
    deps.requestExit();
    expect(calls).toBe(1);
  });
});
