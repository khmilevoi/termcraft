import { describe, expect, test } from "bun:test";

import { context } from "@reatom/core";

import type { PreviewFrameV1 } from "core/ports";
import type { CommandResultV1 } from "core/protocol";
import { uuidv7 } from "infrastructure/uuid";
import type { AgentHealth } from "ui/agent-health";
import { homeSubmitAllowed } from "ui/home";
import {
  TEST_NONCE,
  TEST_SHA,
  TEST_TS,
  createFakeKernel,
  createFakePreviewSession,
  event,
  snapshot,
} from "ui/testing";

import { UiPreviewStreamError, createUiDeps } from "./deps";
import { applyIntent } from "./intent";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
/** Longer than the frame loop's own `FRAME_POLL_MS`, so a poll-and-retry cycle can complete. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 120));

/**
 * `handlers/project.ts`'s own `blockOpen` shape: the action, plus the `{reason, failure}` it
 * publishes as this transition's `metadata`. Shared by the "blocked-open recovery" describe
 * block below and the `startupOpenPending` describe block, so both build the identical envelope.
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

  test("follows a replacement session whose predecessor's frame stream never ends", async () => {
    // REGRESSION (2026-07-27): `preview.retry` (F5) and a source change both install a NEW
    // `PreviewSession`. The predecessor is left open — nothing closes its frame stream — so a
    // loop that only re-reads `port.preview()` when the current stream ENDS stays parked on the
    // dead session forever. The preview then sits on `preparing preview…` with no frame.
    const first = createFakePreviewSession();
    const second = createFakePreviewSession();
    const kernel = createFakeKernel();
    kernel.setPreview(first.handle);
    const deps = createUiDeps(kernel, { w: 120, h: 36 });

    const unsubscribe = deps.runtime.subscribe(() => undefined);
    await tick();
    expect(first.activeFrameConsumers()).toBe(1);

    // Exactly what the Kernel does on a page edit or an F5 retry: install the successor, then
    // announce it. `selectCurrentSource` sets the active session BEFORE returning its events,
    // so by the time this envelope lands `port.preview()` already reports the successor.
    kernel.setPreview(second.handle);
    kernel.emit(
      event("preview.sessionReady", {
        previewSessionId: second.handle.previewSessionId,
        nonce: TEST_NONCE,
        pageSlug: "main",
        sourceHash: TEST_SHA,
        hostMode: "static",
        interactionMode: "static",
        size: { w: 120, h: 40 },
        theme: "dark-default",
        initialFrameSeq: "1",
      }),
    );
    const displayed = frame(second.handle.previewSessionId);
    second.pushFrame(displayed);
    await settle();
    const latest = deps.previewFrame();
    unsubscribe();

    expect(latest?.frame).toBe(displayed);
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

  // WP-9 (design-agent-feedback-loop repair, Task 11): the FULL wire, not just its two halves —
  // `applyIntent`'s `composer-submit` remembers the sent text, `applyEnvelope`'s `turn.failed`
  // branch calls `applyTurnTerminal`, and the composer draft ends up holding it. Each half also
  // has its own focused unit test (`intent.test.ts`, `primary-input.test.ts`); this is the one
  // proof they are actually wired together through `createUiDeps`'s real `applyEnvelope`.
  test("a genuine turn.failed event, delivered through the real Kernel subscription, restores the composer draft", async () => {
    // The snapshot goes through the `FakeKernel`'s OWN bootstrap delivery (`options.snapshot`),
    // not a manual `deps.mirror.apply` before subscribing — `subscribe`'s first synchronous
    // delivery is the FakeKernel's default (bare) snapshot (`fake-kernel.ts`'s own comment: "the
    // real bus delivers one snapshot synchronously, before returning the unsubscribe"), which
    // would silently overwrite a pre-subscribe manual apply and put `deps.screen()` back on
    // `"home"` — exactly the mistake this comment exists to head off for the next editor.
    const kernel = createFakeKernel({
      snapshot: { projectId: uuidv7(), activePageSlug: "main", trust: "trusted" },
    });
    const deps = createUiDeps(kernel, { w: 120, h: 36 });

    const unsubscribe = deps.runtime.subscribe(() => undefined);
    await tick();

    deps.local.composer.set("add a gpu temperature panel");
    applyIntent({ kind: "composer-submit" }, deps);
    await tick();
    expect(deps.local.composer()).toBe("");

    kernel.emit(
      event("turn.failed", {
        turnId: uuidv7(),
        outcome: "failed",
        changedPages: [],
        warnings: [],
        failure: {
          code: "BACKEND_FAILED",
          retryable: true,
          safeMessage: "backend crashed",
          details: {},
        },
      }),
    );
    await tick();

    unsubscribe();
    expect(deps.local.composer()).toBe("add a gpu temperature panel");
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
    expect(deps.local.agentHealth()).toEqual({
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

    expect(deps.local.agentHealth()).toEqual({ kind: "ready", agent: "claude" });
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
    expect(deps.local.agentHealth()).toEqual({ kind: "checking", agent: "claude" });

    await tick();

    const settled = deps.local.agentHealth();
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
  /** A fixed tree revision for the publishes whose subject is the SLUG, not the tree. */
  const TREE_REVISION_A = "a".repeat(64);
  /** A second, different revision — what any change to any tree file produces. */
  const TREE_REVISION_B = "b".repeat(64);

  const activePage = (activePageSlug: string | null) =>
    event("page.descriptorsChanged", {
      reason: "turn-apply",
      treeRevision: TREE_REVISION_A,
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
  const activePageAt = (activePageSlug: string, sourceHash: string, treeRevision: string) =>
    event("page.descriptorsChanged", {
      reason: "turn-apply",
      treeRevision,
      descriptors: [
        {
          status: "ready",
          pageSlug: activePageSlug,
          entry: `pages/${activePageSlug}.tsx`,
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

  test("re-selects the SAME page when a turn changes its entry file — the memo is keyed on content, not just the slug", async () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    const unsubscribe = deps.runtime.subscribe(() => undefined);
    await tick();

    kernel.emit(activePageAt("main", "a".repeat(64), TREE_REVISION_A));
    await tick();
    // The user asks the agent to change the page they are already looking at: same slug, new
    // bytes. A slug-keyed memo returned early here and the live session went on rendering the
    // pre-turn source — the user's own change was invisible. The entry file is one of the tree's
    // own inventory rows, so rewriting it moves the tree revision too; both move together here
    // because that is what actually happens on disk, never one without the other.
    kernel.emit(activePageAt("main", "b".repeat(64), TREE_REVISION_B));
    await tick();
    // ...and an unchanged republish must still NOT re-establish a session.
    kernel.emit(activePageAt("main", "b".repeat(64), TREE_REVISION_B));
    await tick();

    expect(selectedPages(kernel)).toEqual([{ pageSlug: "main" }, { pageSlug: "main" }]);
    unsubscribe();
  });

  /**
   * THE SHARED-MODULE EDIT (design-tree phase 2 Task 10). A turn that rewrites a module the
   * page IMPORTS moves no entry hash at all — `sourceHash` is the entry file's own digest — so a
   * `sourceHash`-keyed memo returned early and the live session went on rendering the page built
   * from the OLD shared module. FOREVER: nothing else ever re-asks for the active page. The
   * `treeRevision` covers every file in the tree, so the shared module's new bytes move it.
   */
  test("re-selects the SAME page when only the tree revision moves — a shared-module edit changes no entry hash", async () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    const unsubscribe = deps.runtime.subscribe(() => undefined);
    await tick();

    const unchangedEntryHash = "c".repeat(64);
    kernel.emit(activePageAt("main", unchangedEntryHash, TREE_REVISION_A));
    await tick();
    kernel.emit(activePageAt("main", unchangedEntryHash, TREE_REVISION_B));
    await tick();
    // ...and republishing the SAME revision must still NOT re-establish a session.
    kernel.emit(activePageAt("main", unchangedEntryHash, TREE_REVISION_B));
    await tick();

    expect(selectedPages(kernel)).toEqual([{ pageSlug: "main" }, { pageSlug: "main" }]);
    unsubscribe();
  });

  /**
   * THE FALLBACK'S DIRECTION, PINNED. `kernel.snapshot` is the second producer of
   * `pageDescriptors` and carries no tree revision, so the mirror reports `null` and the memo
   * key falls back to the slug alone. That must cost EXTRA asks, never a missed one: this test
   * fails if the mirror ever starts carrying a stale revision across a snapshot, because the
   * middle ask would then disappear.
   */
  test("a snapshot's missing tree revision biases toward MORE asks, never fewer", async () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    const unsubscribe = deps.runtime.subscribe(() => undefined);
    await tick();

    kernel.emit(activePageAt("main", "a".repeat(64), TREE_REVISION_A));
    await tick();
    // The slug is unchanged across the snapshot, so the revision going `null` is the ONLY thing
    // that can move the key here.
    kernel.emit(snapshot({ activePageSlug: "main" }));
    await tick();
    kernel.emit(activePageAt("main", "a".repeat(64), TREE_REVISION_A));
    await tick();

    expect(selectedPages(kernel)).toEqual([
      { pageSlug: "main" },
      { pageSlug: "main" },
      { pageSlug: "main" },
    ]);
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

  test("dispatches preview.selectPage for a page the user picked from the tab strip", async () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    const unsubscribe = deps.runtime.subscribe(() => undefined);
    await tick();

    kernel.emit(activePage("main"));
    await tick();
    deps.local.pageOverride.set("settings");
    await tick();

    expect(selectedPages(kernel)).toEqual([{ pageSlug: "main" }, { pageSlug: "settings" }]);
    unsubscribe();
  });

  test("does not re-establish the session when the Kernel echoes the page the user already picked", async () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    const unsubscribe = deps.runtime.subscribe(() => undefined);
    await tick();

    kernel.emit(activePage("main"));
    await tick();
    deps.local.pageOverride.set("settings");
    await tick();
    // What `preview.selectPage` persisting the slug produces on the next descriptor publish: the
    // Kernel's own active page catches up with the pick the UI already made.
    kernel.emit(activePage("settings"));
    await tick();

    expect(selectedPages(kernel)).toEqual([{ pageSlug: "main" }, { pageSlug: "settings" }]);
    expect(deps.local.pageOverride()).toBeNull();
    expect(deps.activePageSlug()).toBe("settings");
    unsubscribe();
  });

  test("a Kernel-requested page move (pages.json on apply) wins over the user's pick", async () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    const unsubscribe = deps.runtime.subscribe(() => undefined);
    await tick();

    kernel.emit(activePage("main"));
    await tick();
    deps.local.pageOverride.set("settings");
    await tick();
    kernel.emit(activePage("report"));
    await tick();

    expect(deps.activePageSlug()).toBe("report");
    expect(selectedPages(kernel)).toEqual([
      { pageSlug: "main" },
      { pageSlug: "settings" },
      { pageSlug: "report" },
    ]);
    unsubscribe();
  });

  /**
   * A terminal refusal of `preview.selectPage` must retire the optimistic tab pick.
   *
   * `ui/workspace/model/page-selection.ts` sets `pageOverride` BEFORE dispatching, and the only
   * thing that used to retire it was the KERNEL's own active slug changing — which a refusal, by
   * definition, does not do. So the tab strip went on highlighting a page the preview was never
   * showing, with no way back. Seen live on 2026-07-28 behind `STALE_REVISION`
   * (`termcraft-debug/run-2026-07-28T08-24-11-710Z-2132.jsonl`); the root fix removes that
   * particular cause, but `CAPABILITY_UNAVAILABLE` on an untrusted project (spec §2.2) is a
   * routine, by-design refusal that reaches the same branch.
   */
  const acceptedResult = (): CommandResultV1 =>
    ({
      protocolVersion: 1,
      commandId: "019fa7d3-0eb6-7000-a27a-d8181a27781e",
      status: "accepted",
      acceptedRevision: "0",
      resultingRevision: "0",
      disposition: "started",
    }) as unknown as CommandResultV1;

  const refusal = (code: string): CommandResultV1 =>
    ({
      protocolVersion: 1,
      commandId: "019fa7d3-0eb6-7000-a27a-d8181a27781e",
      status: "rejected",
      currentRevision: "0",
      code,
      reasons: [{ code }],
    }) as unknown as CommandResultV1;

  test("retires the optimistic tab pick when the Kernel refuses the page switch", async () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    const unsubscribe = deps.runtime.subscribe(() => undefined);
    await tick();

    kernel.emit(activePage("main"));
    await tick();

    kernel.setDispatchResult(refusal("CAPABILITY_UNAVAILABLE"));
    deps.local.pageOverride.set("settings");
    await tick();
    await tick();

    // The defect: the strip kept marking "settings" while the preview stayed on "main".
    expect(deps.local.pageOverride()).toBeNull();
    expect(deps.activePageSlug()).toBe("main");
    // Retiring the override puts the effective slug back on the Kernel's own page, which the
    // (now cleared) memo re-requests once. Pinning the exact list is also what proves the clear
    // cannot feed itself: the re-request is refused too, and clearing an already-null override
    // notifies nothing, so the sequence terminates here instead of spinning.
    expect(selectedPages(kernel)).toEqual([
      { pageSlug: "main" },
      { pageSlug: "settings" },
      { pageSlug: "main" },
    ]);
    unsubscribe();
  });

  test("a stale refusal does not retire a NEWER tab pick that is still in flight", async () => {
    // Two clicks in quick succession leave two `preview.selectPage` dispatches in flight (the
    // memo is keyed `slug@treeRevision`, so the second is not swallowed). If the FIRST one's refusal
    // retired the override unconditionally, it would wipe the SECOND, still-pending pick — the
    // effective slug would snap back to the Kernel's page and the strip would once again show a
    // page the user did not choose. That is the very defect this branch exists to fix,
    // reappearing under interleaving, so the retirement must be scoped to its own dispatch.
    const kernel = createFakeKernel();
    const pending: { slug: string; resolve: (result: CommandResultV1) => void }[] = [];
    const port = {
      ...kernel,
      dispatch(raw: unknown): Promise<Error | CommandResultV1> {
        // `pending` below is this test's own record of what was dispatched — the fake's
        // `dispatched` array is readonly and this port replaces its `dispatch` wholesale.
        const envelope = raw as { kind: string; payload: { pageSlug: string } };
        if (envelope.kind !== "preview.selectPage") return Promise.resolve(refusal("IGNORED"));
        return new Promise((resolve) => {
          pending.push({ slug: envelope.payload.pageSlug, resolve });
        });
      },
    };
    const deps = createUiDeps(port, { w: 120, h: 36 });
    const unsubscribe = deps.runtime.subscribe(() => undefined);
    await tick();

    kernel.emit(activePage("main"));
    await tick();
    const settle = (slug: string, result: CommandResultV1) => {
      const entry = pending.find((candidate) => candidate.slug === slug);
      if (entry === undefined) throw new Error(`fixture bug: no dispatch in flight for "${slug}"`);
      entry.resolve(result);
    };
    settle("main", acceptedResult());
    await tick();

    // Click B, then click C before B's result comes back.
    deps.local.pageOverride.set("beta");
    await tick();
    deps.local.pageOverride.set("gamma");
    await tick();
    expect(pending.map((entry) => entry.slug)).toEqual(["main", "beta", "gamma"]);

    // B is refused — but the user has already moved on to C.
    settle("beta", refusal("CAPABILITY_UNAVAILABLE"));
    await tick();
    await tick();

    expect(deps.local.pageOverride()).toBe("gamma");
    expect(deps.activePageSlug()).toBe("gamma");

    // ...and C's own refusal still retires it, because C IS the pick on screen.
    settle("gamma", refusal("CAPABILITY_UNAVAILABLE"));
    await tick();
    await tick();
    expect(deps.local.pageOverride()).toBeNull();
    expect(deps.activePageSlug()).toBe("main");
    unsubscribe();
  });

  test("retires the optimistic tab pick when the page-switch dispatch itself fails", async () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    const unsubscribe = deps.runtime.subscribe(() => undefined);
    await tick();

    kernel.emit(activePage("main"));
    await tick();

    // The transport half of the same defect: a dispatch that never produced a result at all
    // leaves the pick just as unbacked as an explicit rejection does.
    kernel.setDispatchResult(new Error("kernel port closed"));
    deps.local.pageOverride.set("settings");
    await tick();
    await tick();

    expect(deps.local.pageOverride()).toBeNull();
    expect(deps.activePageSlug()).toBe("main");
    unsubscribe();
  });

  /**
   * REGRESSION (2026-08-03, seen live in `termcraft-debug/run-2026-08-03T13-55-59-835Z-
   * 41436.jsonl`): a project's own auto-issued preview request at open time is dispatched
   * WHILE the project is still untrusted (spec §2.2's trust prompt gates it), gets rejected
   * `PROJECT_UNTRUSTED`, and clears its memo so a "later descriptor change" can retry it. But
   * `project.setTrust` changes neither `activePageSlug` nor the page's descriptor — the active
   * page is exactly what it was the instant before — so `activePageRequest` never recomputes
   * and nothing ever retries. The preview stayed blank until the user happened to pick a
   * DIFFERENT page, the only other producer of `preview.selectPage`.
   */
  test("re-requests the active page's preview once trust flips from untrusted to trusted", async () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    const unsubscribe = deps.runtime.subscribe(() => undefined);
    await tick();

    kernel.setDispatchResult(refusal("PROJECT_UNTRUSTED"));
    kernel.emit(activePage("dashboard"));
    await tick();
    expect(selectedPages(kernel)).toEqual([{ pageSlug: "dashboard" }]);

    kernel.setDispatchResult(acceptedResult());
    kernel.emit(
      event("kernel.stateChanged", {
        modelId: "kernel.project.state",
        action: "kernel.project.setTrust",
        previousTag: "ready",
        nextTag: "ready",
        metadata: { workspaceIdentity: "local", trust: "trusted" },
      }),
    );
    await tick();

    expect(selectedPages(kernel)).toEqual([{ pageSlug: "dashboard" }, { pageSlug: "dashboard" }]);
    unsubscribe();
  });
});

describe("createUiDeps refreshAgentHealth", () => {
  test("re-enters `checking` while the probe runs, so a manual `r` re-check is visible", async () => {
    // A hand-driven probe: each call hands back a promise this test settles when it chooses,
    // so the mid-probe state is observable rather than raced against.
    const pending: ((value: AgentHealth) => void)[] = [];
    const probe = () =>
      new Promise<AgentHealth>((resolve) => {
        pending.push(resolve);
      });
    const settle = (value: AgentHealth) => {
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
    expect(deps.local.agentHealth().kind).toBe("blocked");

    // The re-check itself. Without this fix the stale `blocked` verdict stayed on screen for the
    // probe's entire run (up to 20s), with nothing to say a re-check was happening at all.
    void deps.refreshAgentHealth();
    expect(deps.local.agentHealth()).toEqual({ kind: "checking", agent: "claude" });

    settle({ kind: "ready", agent: "claude" });
    await tick();
    expect(deps.local.agentHealth().kind).toBe("ready");
  });
});

describe("createUiDeps blocked-open recovery", () => {
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

describe("startupOpenPending / startupOpenFailure (spec 2026-08-02 — workspace-first launch)", () => {
  /**
   * The shape `run-app.ts`'s `result instanceof Error` branch builds — a `ProjectOpenFailure` by
   * shape only, never a Kernel-produced one (no `blockOpen` exists for a dispatch that never
   * reached the Kernel), which is exactly what the tests below pin.
   */
  const ABANDON_FAILURE = {
    reason: "startup-open-dispatch-failed",
    safeMessage: "the port was already closed",
  } as const;

  test("an existing project mounts the Workspace before any Kernel event arrives", () => {
    const deps = createUiDeps(
      createFakeKernel(),
      { w: 120, h: 36 },
      {
        root: ".",
        workspaceIdentity: "local",
        projectExists: true,
      },
    );
    expect(deps.local.startupOpenPending()).toBe(true);
    expect(deps.screen()).toBe("workspace");
  });

  test("a fresh directory still lands on Home", () => {
    const deps = createUiDeps(createFakeKernel(), { w: 120, h: 36 });
    expect(deps.local.startupOpenPending()).toBe(false);
    expect(deps.screen()).toBe("home");
  });

  test("abandonStartupOpen drops the empty shell back to Home and says why", () => {
    const deps = createUiDeps(
      createFakeKernel(),
      { w: 120, h: 36 },
      {
        root: ".",
        workspaceIdentity: "local",
        projectExists: true,
      },
    );
    expect(deps.screen()).toBe("workspace");
    deps.abandonStartupOpen(ABANDON_FAILURE);
    expect(deps.local.startupOpenPending()).toBe(false);
    expect(deps.screen()).toBe("home");
    // Branch review finding 2 (2026-08-03): dropping back to Home is only half the transition —
    // the reason has to survive it, or the user reads a bare Home. `App.tsx` composes this atom
    // into Home's `openFailure` prop, so this IS what the panel renders for this path.
    expect(deps.local.startupOpenFailure()).toEqual(ABANDON_FAILURE);
  });

  test("an abandoned startup open never fabricates the Kernel's own openFailure", () => {
    // The invariant the fix must not trade away: `ProjectMirror.openFailure` is Kernel truth,
    // written ONLY by a real `kernel.project.blockOpen` fold (`ui/mirror/model/mirror.ts`). A
    // dispatch that was never admitted cannot have been blocked, so the UI-local reading has to
    // stay a SEPARATE atom rather than being written into the mirror. This test is what would
    // fail if a later "simplification" merged the two.
    const deps = createUiDeps(
      createFakeKernel(),
      { w: 120, h: 36 },
      {
        root: ".",
        workspaceIdentity: "local",
        projectExists: true,
      },
    );
    deps.abandonStartupOpen(ABANDON_FAILURE);
    expect(deps.mirror.project().openFailure).toBeNull();
    expect(deps.local.startupOpenFailure()).toEqual(ABANDON_FAILURE);
  });

  test("a real blockOpen still wins the panel slot over an abandoned startup open", () => {
    // The `??` compose in `App.tsx` reads Kernel truth first. The two readings are mutually
    // exclusive by construction for ONE open attempt, so this ordering is only ever exercised by
    // a sequence like this one (an abandoned startup open, then a later admitted-and-blocked
    // retry) — and there the Kernel's own account must be the one on screen.
    const deps = createUiDeps(
      createFakeKernel(),
      { w: 120, h: 36 },
      {
        root: ".",
        workspaceIdentity: "local",
        projectExists: true,
      },
    );
    deps.abandonStartupOpen(ABANDON_FAILURE);
    deps.mirror.apply(blockOpen("manifest-read-failed", "project.toml could not be read"));
    expect(deps.mirror.project().openFailure ?? deps.local.startupOpenFailure()).toEqual({
      reason: "manifest-read-failed",
      safeMessage: "project.toml could not be read",
    });
  });

  test("a blocked open returns to Home even while the startup open is still pending", () => {
    const deps = createUiDeps(
      createFakeKernel(),
      { w: 120, h: 36 },
      {
        root: ".",
        workspaceIdentity: "local",
        projectExists: true,
      },
    );
    // Apply the mirror's own blockOpen fold directly — see the existing "blocked-open recovery"
    // describe block above for the shared envelope helper.
    deps.mirror.apply(blockOpen("manifest-read-failed", "project.toml could not be read"));
    expect(deps.screen()).toBe("home");
  });

  test("a successful finishOpen clears startupOpenPending — the flag stops describing a project that is already open", async () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(
      kernel,
      { w: 120, h: 36 },
      {
        root: ".",
        workspaceIdentity: "local",
        projectExists: true,
      },
    );
    // The success path is a `withComputed` on the atom itself (branch review finding 3,
    // 2026-08-03), so the clear no longer depends on `runtime` being connected at all — but the
    // KERNEL EVENT still does: nothing folds `kernel.stateChanged` into the mirror unless the
    // subscription this connect hook owns is live, same requirement as the "blocked-open
    // recovery" describe block above.
    const unsubscribe = deps.runtime.subscribe(() => undefined);
    await tick();
    expect(deps.local.startupOpenPending()).toBe(true);

    kernel.emit(
      event("kernel.stateChanged", {
        modelId: "kernel.project.state",
        action: "kernel.project.finishOpen",
        previousTag: "opening",
        nextTag: "ready",
        metadata: { projectId: uuidv7(), trust: "trusted" },
      }),
    );
    await tick();

    expect(deps.local.startupOpenPending()).toBe(false);
    unsubscribe();
  });

  test("any route to a non-null projectId clears the flag, not just the runtime subscription", () => {
    // Regression coverage for branch review finding 3 (2026-08-03). The clear used to be a
    // guarded branch inside the `mirror.project` subscriber in `createUiDeps`'s `runtime` connect
    // hook, so it ran ONLY for a project write observed through that one wiring; it is now a
    // `withComputed` keyed on `mirror.project().projectId` itself. Folding the SAME `finishOpen`
    // straight into the mirror — no `runtime.subscribe`, no connect hook, the one route that
    // deliberately bypasses the old clearer — is what tells the two implementations apart: the
    // old one leaves this `true`.
    const deps = createUiDeps(
      createFakeKernel(),
      { w: 120, h: 36 },
      {
        root: ".",
        workspaceIdentity: "local",
        projectExists: true,
      },
    );
    expect(deps.local.startupOpenPending()).toBe(true);

    deps.mirror.apply(
      event("kernel.stateChanged", {
        modelId: "kernel.project.state",
        action: "kernel.project.finishOpen",
        previousTag: "opening",
        nextTag: "ready",
        metadata: { projectId: uuidv7(), trust: "trusted" },
      }),
    );

    expect(deps.local.startupOpenPending()).toBe(false);
  });

  test("a later close with no openFailure lands on Home, not an empty Workspace shell", async () => {
    // Regression coverage for the escalated Item 1 fix: before it, `startupOpenPending` had
    // exactly one clearer (`abandonStartupOpen`, only reachable from the startup dispatch's own
    // two failure branches), so a SUCCESSFUL open left it `true` forever. Any later legitimate
    // close that is not the blocked-open recovery above — which always leaves `openFailure`
    // non-null — leaves `projectId` null with `openFailure` still null, and `deriveScreen`
    // (`projectId === null && startupOpenPending && !openFailed`) would mount an empty Workspace
    // shell with no exit. `finishClose` is used here only as a concrete, mirror-fold-accurate way
    // to reach that same (`projectId: null`, `openFailure: null`) pair — the fix does not depend
    // on `finishClose` specifically, only on projectId legitimately returning to null.
    const kernel = createFakeKernel();
    const deps = createUiDeps(
      kernel,
      { w: 120, h: 36 },
      {
        root: ".",
        workspaceIdentity: "local",
        projectExists: true,
      },
    );
    const unsubscribe = deps.runtime.subscribe(() => undefined);
    await tick();

    kernel.emit(
      event("kernel.stateChanged", {
        modelId: "kernel.project.state",
        action: "kernel.project.finishOpen",
        previousTag: "opening",
        nextTag: "ready",
        metadata: { projectId: uuidv7(), trust: "trusted" },
      }),
    );
    await tick();
    expect(deps.screen()).toBe("workspace");

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

    expect(deps.mirror.project().projectId).toBeNull();
    expect(deps.mirror.project().openFailure).toBeNull();
    expect(deps.screen()).toBe("home");
    unsubscribe();
  });
});

describe("trustPromptDismissed — the auto-shown trust prompt (spec 2026-08-03 — trust prompt on open)", () => {
  test("defaults to false, so a never-before-trusted project shows the prompt first", () => {
    const deps = createUiDeps(createFakeKernel(), { w: 120, h: 36 });
    deps.mirror.apply(
      snapshot({
        projectId: uuidv7(),
        activePageSlug: null,
        activeChatId: uuidv7(),
        trust: "untrusted-read-only",
      }),
    );
    expect(deps.local.trustPromptDismissed()).toBe(false);
    expect(deps.screen()).toBe("trust-prompt");
  });

  test("flipping it true resolves the screen the rest of the way to read-only", () => {
    const deps = createUiDeps(createFakeKernel(), { w: 120, h: 36 });
    deps.mirror.apply(
      snapshot({
        projectId: uuidv7(),
        activePageSlug: null,
        activeChatId: uuidv7(),
        trust: "untrusted-read-only",
      }),
    );
    expect(deps.screen()).toBe("trust-prompt");

    deps.local.trustPromptDismissed.set(true);
    expect(deps.screen()).toBe("read-only");
  });

  test("trust-accept resolves the screen trust-prompt -> workspace end to end", async () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(
      kernel,
      { w: 120, h: 36 },
      { root: "/project", workspaceIdentity: "workspace-id", projectExists: false },
    );
    deps.mirror.apply(
      snapshot({
        projectId: uuidv7(),
        activePageSlug: null,
        activeChatId: uuidv7(),
        trust: "untrusted-read-only",
      }),
    );
    expect(deps.screen()).toBe("trust-prompt");

    applyIntent({ kind: "trust-accept" }, deps);
    // `trustPromptDismissed` is now set only once the dispatch RESOLVES accepted (fix round 2,
    // Finding 2 — the same treatment `dispatchHomeSubmit` already gives `local.prompt`), so this
    // await is required before the mirror fold below and the final assertion.
    await tick();
    // `applyIntent`'s dispatch only reaches the FakeKernel's recorded `dispatched` list — unlike
    // a real Kernel it never folds anything back on its own — so the mirror's own trust grant is
    // simulated the same way `mirror.test.ts`'s "kernel.project.setTrust moves the screen the
    // rest of the way to workspace" test does, by applying the SAME fold the real Kernel would
    // eventually publish.
    deps.mirror.apply(
      event("kernel.stateChanged", {
        modelId: "kernel.project.state",
        action: "kernel.project.setTrust",
        previousTag: "ready",
        nextTag: "ready",
        metadata: { workspaceIdentity: "workspace-id", trust: "trusted" },
      }),
    );
    expect(deps.local.trustPromptDismissed()).toBe(true);
    expect(deps.screen()).toBe("workspace");
  });

  test("trust-decline resolves the screen trust-prompt -> read-only end to end", async () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(
      kernel,
      { w: 120, h: 36 },
      { root: "/project", workspaceIdentity: "workspace-id", projectExists: false },
    );
    deps.mirror.apply(
      snapshot({
        projectId: uuidv7(),
        activePageSlug: null,
        activeChatId: uuidv7(),
        trust: "untrusted-read-only",
      }),
    );
    expect(deps.screen()).toBe("trust-prompt");

    applyIntent({ kind: "trust-decline" }, deps);
    // Unlike accept, decline needs no Kernel round trip to observe on screen: the mirror's own
    // `trust` was already "untrusted-read-only" (that is WHY the prompt was showing), so
    // `trustPromptDismissed` flipping true is the only thing the screen atom needed — but that
    // flip itself now only happens once the dispatch RESOLVES accepted (fix round 2, Finding 2),
    // hence this await.
    await tick();
    expect(deps.local.trustPromptDismissed()).toBe(true);
    expect(deps.screen()).toBe("read-only");
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

describe("createUiDeps seedComposerText (design-systems §9)", () => {
  test("a seeded composer text is the composer's initial value", () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(
      kernel,
      { w: 120, h: 36 },
      undefined,
      undefined,
      undefined,
      null,
      "rewrite the colours",
    );
    expect(deps.local.composer()).toBe("rewrite the colours");
  });

  test("with no seed the composer starts empty", () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    expect(deps.local.composer()).toBe("");
  });
});

describe("preview resize", () => {
  const sessionReady = (previewSessionId: string, size: { w: number; h: number }) =>
    event("preview.sessionReady", {
      previewSessionId: previewSessionId as never,
      nonce: TEST_NONCE,
      pageSlug: "dashboard",
      sourceHash: TEST_SHA,
      hostMode: "preview",
      interactionMode: "static",
      size,
      theme: "dark-default",
      initialFrameSeq: "1",
    });

  const resizeEnvelopes = (kernel: { readonly dispatched: readonly unknown[] }) =>
    kernel.dispatched.filter(
      (raw) => (raw as { kind?: unknown }).kind === "preview.resize",
    ) as readonly {
      readonly payload: { previewSessionId: string; width: number; height: number };
    }[];

  test("asks the host for the region size once a session is established at a different size", async () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 34 });
    const stop = deps.runtime.subscribe(() => {});
    // The runtime's connect hook attaches through Reatom's own hook queue, which flushes on a
    // microtask (`_enqueue`, `@reatom/core`'s `withConnectHook`) — never synchronously with
    // `.subscribe()` itself. Every sibling test in this file waits one tick before the FIRST
    // Kernel emission for the same reason; this is that same wait, just against a plain
    // microtask rather than `tick()`'s `setTimeout`, since nothing here needs a macrotask.
    await Promise.resolve();
    const previewSessionId = uuidv7();
    kernel.emit(sessionReady(previewSessionId, { w: 80, h: 24 }));
    await Promise.resolve();

    expect(resizeEnvelopes(kernel)).toHaveLength(1);
    expect(resizeEnvelopes(kernel)[0]?.payload).toEqual({
      previewSessionId,
      width: 74,
      height: 28,
    });
    stop();
  });

  test("does not ask again for a size it already asked for", async () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 34 });
    const stop = deps.runtime.subscribe(() => {});
    await Promise.resolve();
    const previewSessionId = uuidv7();
    kernel.emit(sessionReady(previewSessionId, { w: 80, h: 24 }));
    await Promise.resolve();
    // A second readiness event for the SAME session and size must not re-ask.
    kernel.emit(sessionReady(previewSessionId, { w: 80, h: 24 }));
    await Promise.resolve();

    expect(resizeEnvelopes(kernel)).toHaveLength(1);
    stop();
  });

  test("asks again when the terminal is resized", async () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 34 });
    const stop = deps.runtime.subscribe(() => {});
    await Promise.resolve();
    const previewSessionId = uuidv7();
    kernel.emit(sessionReady(previewSessionId, { w: 80, h: 24 }));
    await Promise.resolve();
    deps.terminal.set({ w: 140, h: 36 });
    await Promise.resolve();

    const envelopes = resizeEnvelopes(kernel);
    expect(envelopes).toHaveLength(2);
    expect(envelopes[1]?.payload).toEqual({ previewSessionId, width: 86, height: 30 });
    stop();
  });

  test("asks again when a resize makes the region land back on the size the session was established at", async () => {
    // REGRESSION (review finding, phase-8 fix wave): `preview.size` is the size the session
    // was ESTABLISHED at and never changes afterwards, so `previewTargetSize` must never
    // treat "region equals `preview.size`" as "nothing to do" past the very first ask — an
    // ordinary window resize can land the region back on that exact number for reasons that
    // have nothing to do with the established session still being current. Before this fix,
    // that comparison short-circuited the computed before the real repeat guard (the
    // per-(session, size) memo) was ever consulted, so the host was silently never told —
    // the headline defect this whole branch exists to kill (Background table row 1),
    // reproduced here by an ordinary terminal resize, not a contrived direct call.
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 34 });
    const stop = deps.runtime.subscribe(() => {});
    await Promise.resolve();
    const previewSessionId = uuidv7();
    // Established at 80x24 — the number `preview.size` reports forever.
    kernel.emit(sessionReady(previewSessionId, { w: 80, h: 24 }));
    await Promise.resolve();
    // The 120x34 terminal's region is {w:74,h:28} — different from the established size, so
    // this first ask happens under either version of the code.
    expect(resizeEnvelopes(kernel)).toHaveLength(1);

    // 130x30 makes `previewRegionSize` compute EXACTLY {w:80,h:24} — the same numbers the
    // session was established at (chatColumnWidth(130)=48, pane=82, region.w=80;
    // region.h=30-6=24).
    deps.terminal.set({ w: 130, h: 30 });
    await Promise.resolve();

    const envelopes = resizeEnvelopes(kernel);
    expect(envelopes).toHaveLength(2);
    expect(envelopes[1]?.payload).toEqual({ previewSessionId, width: 80, height: 24 });
    stop();
  });

  test("never asks while no session is live", async () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 34 });
    const stop = deps.runtime.subscribe(() => {});
    await Promise.resolve();
    deps.terminal.set({ w: 140, h: 36 });
    await Promise.resolve();

    expect(resizeEnvelopes(kernel)).toHaveLength(0);
    stop();
  });

  test("never asks after the session leaves ready, even though a terminal resize still recomputes the guard", async () => {
    // Strengthened (review finding, phase-8 fix wave): with `terminal()`/`fullscreen()` read
    // BEFORE the `preview.phase !== "ready"` early return in `previewTargetSize`, a terminal
    // resize while a session is NOT ready still recomputes the atom — it must recompute to
    // `null` because the phase guard fires, not merely stay unread. Before that hoist this
    // test would have passed for the wrong reason: the computed never re-ran at all once the
    // early return made `terminal` a non-dependency in the non-ready state, so "no dispatch"
    // proved nothing about the guard itself.
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 34 });
    const stop = deps.runtime.subscribe(() => {});
    await Promise.resolve();
    const previewSessionId = uuidv7();
    kernel.emit(sessionReady(previewSessionId, { w: 80, h: 24 }));
    await Promise.resolve();
    // Establishing the session already asked once — what this test pins is that a resize
    // AFTER the session leaves `ready` asks for nothing further.
    expect(resizeEnvelopes(kernel)).toHaveLength(1);

    kernel.emit(
      event("preview.circuitOpened", {
        previewSessionId,
        pageSlug: "dashboard",
        sourceHash: TEST_SHA,
        attempts: 3,
        finalFailure: {
          code: "HOST_CIRCUIT_OPEN",
          retryable: true,
          safeMessage: "boom",
          details: {},
        },
        retryCapability: { available: true },
      }),
    );
    await Promise.resolve();
    deps.terminal.set({ w: 140, h: 36 });
    await Promise.resolve();

    expect(resizeEnvelopes(kernel)).toHaveLength(1);
    stop();
  });
});

describe("createUiDeps chat viewport and older page", () => {
  test("createUiDeps seeds the chat viewport empty and the older-page latch idle", () => {
    const deps = createUiDeps(createFakeKernel(), { w: 120, h: 36 });
    expect(deps.local.chatViewport()).toBeNull();
    expect(deps.local.olderPage()).toEqual({ kind: "idle" });
  });

  // Review finding C1: a failed older-page load used to latch `{kind:"failed"}` permanently —
  // `withComputed` only ever transitioned OUT of `"loading"`, so nothing reset it once the user
  // switched to an unrelated chat, and the stale banner rode along into whatever they opened
  // next. `mirror.ts`'s own `chat.changed` handler already resets `history`/
  // `lastOlderPageFailure` to their empty values on an `activeChatId` change; the fix teaches
  // this atom to recognize that reset rather than ignore it.
  test("a failed older-page load clears once the active chat switches away from it", () => {
    const CHAT_A = uuidv7();
    const CHAT_B = uuidv7();
    const deps = createUiDeps(createFakeKernel(), { w: 120, h: 36 });
    deps.mirror.apply(
      event("chat.changed", { activeChatId: CHAT_A, added: [], updated: [], removedChatIds: [] }),
    );
    deps.mirror.apply(
      event("chat.records", {
        chatId: CHAT_A,
        records: [],
        prevCursor: { generation: 1, beforeOffset: 400 },
        totalRecordCount: 40,
      }),
    );
    // Simulates the state `Workspace.tsx`'s own `maybeLoadOlder` sets right before dispatching.
    deps.local.olderPage.set({ kind: "loading" });
    deps.mirror.apply(
      event("chat.records.older", {
        chatId: CHAT_A,
        records: [],
        prevCursor: null,
        totalRecordCount: 0,
        failure: {
          code: "PERSISTENCE_FAILED",
          retryable: true,
          safeMessage: "page unreadable",
          details: {},
        },
      }),
    );
    expect(deps.local.olderPage()).toEqual({ kind: "failed", safeMessage: "page unreadable" });

    deps.mirror.apply(
      event("chat.changed", { activeChatId: CHAT_B, added: [], updated: [], removedChatIds: [] }),
    );
    expect(deps.local.olderPage()).toEqual({ kind: "idle" });
  });
});

// P10 task 13: `designSystem.installed`/`published` carry no "close the UI" instruction of their
// own — `applyEnvelope` is the one place a terminal SUCCESS for the dialog CURRENTLY open becomes
// a UI-local transition (`UiLocalState.designSystemPrompt`'s own doc comment). Exercised here,
// not in `intent.test.ts`, because this behaviour lives in the connect-hook-scoped event consumer
// and `deps.mirror.apply(...)` alone (what `intent.test.ts` uses everywhere else) never reaches it
// — only `kernel.emit(...)` through a connected `deps.runtime` does.
describe("design-system prompt auto-close on terminal success (P10 task 13)", () => {
  test("designSystem.installed closes an open install confirm back to the picker", async () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    const unsubscribe = deps.runtime.subscribe(() => undefined);
    await tick();
    deps.local.overlay.set("design-system");
    deps.local.designSystemPrompt.set("install");

    kernel.emit(
      event("designSystem.installed", { operationId: uuidv7(), ref: "local:midnight@1.2.0" }),
    );
    await tick();

    expect(deps.local.designSystemPrompt()).toBeNull();
    expect(deps.local.overlay()).toBe("design-system");
    unsubscribe();
  });

  test("designSystem.published closes an open publish confirm back to the picker", async () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    const unsubscribe = deps.runtime.subscribe(() => undefined);
    await tick();
    deps.local.overlay.set("design-system");
    deps.local.designSystemPrompt.set("publish");

    kernel.emit(
      event("designSystem.published", {
        operationId: uuidv7(),
        ref: "local:midnight@1.2.0",
        publishedAt: TEST_TS,
      }),
    );
    await tick();

    expect(deps.local.designSystemPrompt()).toBeNull();
    expect(deps.local.overlay()).toBe("design-system");
    unsubscribe();
  });

  test("a terminal success for a DIFFERENT dialog than the one open does not reach in and close it", async () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    const unsubscribe = deps.runtime.subscribe(() => undefined);
    await tick();
    deps.local.overlay.set("design-system");
    deps.local.designSystemPrompt.set("publish");

    // An install success lands while the PUBLISH confirm is the one actually open.
    kernel.emit(
      event("designSystem.installed", { operationId: uuidv7(), ref: "local:midnight@1.2.0" }),
    );
    await tick();

    expect(deps.local.designSystemPrompt()).toBe("publish");
    unsubscribe();
  });

  test("designSystem.installFailed leaves the confirm open so the failure banner can show", async () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    const unsubscribe = deps.runtime.subscribe(() => undefined);
    await tick();
    deps.local.overlay.set("design-system");
    deps.local.designSystemPrompt.set("install");

    kernel.emit(
      event("designSystem.installFailed", {
        operationId: uuidv7(),
        ref: "local:midnight@1.2.0",
        failure: {
          code: "DESIGN_SYSTEM_REJECTED",
          retryable: false,
          safeMessage: "midnight could not be installed",
          details: {},
        },
      }),
    );
    await tick();

    expect(deps.local.designSystemPrompt()).toBe("install");
    expect(deps.mirror.designSystems().failure?.safeMessage).toBe(
      "midnight could not be installed",
    );
    unsubscribe();
  });
});
