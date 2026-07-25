import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { MouseButtons } from "@opentui/core/testing";

import type { PreviewFrameV1 } from "core/ports";
import type { EventPayloadByKindV1 } from "core/protocol";
import { uuidv7 } from "infrastructure/uuid";
import { requestGeometry } from "ui/preview";
import {
  type ReactTestRenderer,
  TEST_NONCE,
  TEST_SHA,
  TEST_TS,
  createFakeKernel,
  createFakePreviewSession,
  createReactTestRenderer,
  event,
  resetEventSeq,
  snapshot,
} from "ui/testing";

import { createUiDeps } from "../model/deps";
import { App } from "./App";

let open: ReactTestRenderer | null = null;
afterEach(async () => {
  await open?.destroy();
  open = null;
});
beforeEach(() => resetEventSeq());

const readyPage = (): EventPayloadByKindV1["kernel.snapshot"]["pageDescriptors"][number] => ({
  status: "ready",
  pageSlug: "main",
  sourceHash: TEST_SHA,
  title: "Main",
  minSize: { w: 80, h: 24 },
  theme: "dark-default",
  kitApiVersion: 1,
});

// M22 fixture: the kernel snapshot's agentIdentity, exercised through the mirror the same way
// production data would arrive — not a hardcoded "codex" literal in Workspace (user decision
// 2026-07-23: the design frames' identity strings are sample data, not layout).
const AGENT_IDENTITY = { backendId: "claude", modelLabel: "sonnet-4.5" } as const;

// The fake re-emits a full kernel.snapshot to model the Kernel re-broadcasting project/trust
// state after project.create — a stand-in for the typed state events that land with the phase-8
// wiring (plan D6). The mirror handles kernel.snapshot as a re-seed whether at subscribe or later.
const workspaceSnapshot = () =>
  snapshot({
    projectId: uuidv7(),
    activePageSlug: "main",
    activeChatId: uuidv7(),
    trust: "trusted",
    pageDescriptors: [readyPage()],
    agentIdentity: AGENT_IDENTITY,
  });

describe("App (end-to-end, FakeKernel-driven)", () => {
  test("the startup probe surfaces a missing agent without a manual recheck, and r re-checks it (M15)", async () => {
    const kernel = createFakeKernel();
    // The probe itself reports the CLI missing on its first call (the startup probe
    // `createUiDeps` now fires — no manual `local.homeHealth.set` needed to reach this state,
    // reproducing a real phase-8 probe's first reading) and recovers on the second call (the
    // `r` re-check).
    let calls = 0;
    const deps = createUiDeps(kernel, { w: 120, h: 36 }, undefined, () => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve({
          present: false,
          agent: "claude",
          detail: "claude CLI not found",
        });
      }
      return Promise.resolve({
        present: true,
        agent: "claude",
        version: "0.34",
        detail: "agent ready",
      });
    });
    const renderer = await createReactTestRenderer(<App deps={deps} />, {
      width: 120,
      height: 36,
    });
    open = renderer;
    await renderer.waitForFrame((frame) => frame.includes("claude CLI not found"));
    await renderer.act(() => renderer.mockInput.typeText("r"));
    const frame = await renderer.waitForFrame((output) => output.includes("agent ready"));
    expect(frame).toContain("agent ready");
    expect(frame).not.toContain("claude CLI not found");
  });

  test("acknowledges a painted frame and opens pin input from its matching geometry result", async () => {
    const kernel = createFakeKernel();
    const preview = createFakePreviewSession();
    kernel.setPreview(preview.handle);
    kernel.setSnapshot({
      projectId: uuidv7(),
      activePageSlug: "main",
      activeChatId: uuidv7(),
      trust: "trusted",
      pageDescriptors: [readyPage()],
    });
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    const renderer = await createReactTestRenderer(<App deps={deps} />, {
      width: 120,
      height: 36,
    });
    open = renderer;
    const rendered: PreviewFrameV1 = {
      sessionId: preview.handle.previewSessionId,
      sourceHash: TEST_SHA,
      frameSeq: "1",
      width: 20,
      height: 10,
      rows: [[{ text: "preview", fg: "default", bg: "default", attrs: 0 }]],
    };
    await renderer.act(() => preview.pushFrame(rendered));
    const frameToken = preview.frameTokenFor(rendered);
    await renderer.waitFor(() => deps.previewFrame()?.frame === rendered);
    await renderer.waitForFrame((frame) => frame.includes("preview"));
    await renderer.waitFor(() => preview.acknowledgements.length > 0);
    expect(deps.previewFrame()?.frame).toBe(rendered);
    expect(preview.acknowledgements).toEqual([frameToken]);

    await renderer.act(() => requestGeometry(deps, "pin", 4, 5));
    const geometryToken = uuidv7();
    await renderer.act(() =>
      kernel.emit(
        event("preview.geometryResult", {
          previewSessionId: preview.handle.previewSessionId,
          frameTokenId: frameToken,
          frameIdentity: {
            previewSessionId: preview.handle.previewSessionId,
            nonce: TEST_NONCE,
            sourceHash: TEST_SHA,
            frameSeq: "1",
          },
          queryKind: "pin-anchor",
          // M21's closed `GeometryQueryResultV1` (`core/protocol`): a bare `checkHit`
          // carries only an element id — no `pageSlug`/`rect`/`label` — but neither
          // this integration test's pin flow (which gates on `geometryToken` alone,
          // `ui/preview/model/interaction.ts`'s `handleGeometryResult`) nor its hover/
          // select flow inspects `result`'s content, so its exact shape is inert here.
          result: { kind: "checkHit", hit: { id: "network" } },
          geometryToken,
        }),
      ),
    );
    expect(await renderer.waitForFrame((frame) => frame.includes("new pin"))).toContain("new pin");
  });

  test("converts absolute preview mouse cells once for hover, selection, and right-click pin", async () => {
    const kernel = createFakeKernel();
    const preview = createFakePreviewSession();
    kernel.setPreview(preview.handle);
    kernel.setSnapshot({
      projectId: uuidv7(),
      activePageSlug: "main",
      activeChatId: uuidv7(),
      trust: "trusted",
      pageDescriptors: [readyPage()],
    });
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    const renderer = await createReactTestRenderer(<App deps={deps} />, {
      width: 120,
      height: 36,
      useMouse: true,
    });
    open = renderer;
    const rendered: PreviewFrameV1 = {
      sessionId: preview.handle.previewSessionId,
      sourceHash: TEST_SHA,
      frameSeq: "1",
      width: 20,
      height: 10,
      rows: [[{ text: "preview", fg: "default", bg: "default", attrs: 0 }]],
    };
    await renderer.act(() => preview.pushFrame(rendered));
    await renderer.waitFor(() => deps.previewFrame()?.frame === rendered);
    await renderer.waitForFrame((frame) => frame.includes("preview"));
    await renderer.waitFor(() => preview.acknowledgements.length > 0);
    const frameToken = preview.frameTokenFor(rendered);
    const emitHit = () =>
      kernel.emit(
        event("preview.geometryResult", {
          previewSessionId: preview.handle.previewSessionId,
          frameTokenId: frameToken,
          frameIdentity: {
            previewSessionId: preview.handle.previewSessionId,
            nonce: TEST_NONCE,
            sourceHash: TEST_SHA,
            frameSeq: "1",
          },
          queryKind: "hit",
          // M21's closed `GeometryQueryResultV1` (`core/protocol`): a bare `checkHit`
          // carries only an element id — no `pageSlug`/`rect`/`label` — but neither
          // this integration test's pin flow (which gates on `geometryToken` alone,
          // `ui/preview/model/interaction.ts`'s `handleGeometryResult`) nor its hover/
          // select flow inspects `result`'s content, so its exact shape is inert here.
          result: { kind: "checkHit", hit: { id: "network" } },
          geometryToken: null,
        }),
      );

    // Workspace frame origin at 120 cols: round(120*.37)+border = x45; tabs+border = y2.
    await renderer.act(() => renderer.mockMouse.moveTo(49, 7));
    await renderer.act(emitHit);
    await renderer.act(() => renderer.mockMouse.pressDown(50, 8, MouseButtons.LEFT));
    await renderer.act(emitHit);
    await renderer.act(() => renderer.mockMouse.pressDown(51, 9, MouseButtons.RIGHT));

    const geometryQueries = kernel.dispatched
      .map((raw) => raw as { kind: string; payload: { query?: unknown } })
      .filter((command) => command.kind === "preview.queryGeometry");
    expect(geometryQueries.map((command) => command.payload.query)).toEqual([
      { kind: "hit", x: 4, y: 5 },
      { kind: "hit", x: 5, y: 6 },
      { kind: "pin-anchor", x: 6, y: 7 },
    ]);
  });

  test("mounts Home when no project is open", async () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    const renderer = await createReactTestRenderer(<App deps={deps} />, {
      width: 120,
      height: 36,
    });
    open = renderer;
    const text = await renderer.waitForFrame(
      (frame) => frame.includes("termcraft") && frame.includes("agent ready"),
    );
    expect(text).toContain("termcraft");
    expect(text).toContain("agent ready");
    // WP-4/Task 9: `homeCombo`'s `model`/`effort` are genuine live reads of the health reading
    // (see `App.tsx`'s own doc comment on `homeCombo`). This test injects NO probe, so it paints
    // `createUiDeps`'s pre-probe placeholder (`DEFAULT_HOME_HEALTH`, `ui/app/model/deps.ts`),
    // which deliberately carries NEITHER — both can only come from a probe, so the placeholder
    // renders them honestly empty rather than briefly showing a value the probe would replace.
    // Asserting the empty slots is what keeps a fabricated placeholder from creeping back in.
    expect(text).toContain("‹›");
    expect(text).not.toContain("‹high›");
  });

  test("Home's combo reads the injected probe's model and effort once it resolves", async () => {
    const kernel = createFakeKernel();
    // The live path the placeholder above deliberately does not exercise: `createUiDeps`'s
    // fourth parameter is the agent-health probe the composition root supplies
    // (`entrypoint/model/run-app.ts`'s `resolveAgentHealthProbe`, which folds
    // `claudeCapabilities().defaultSelection` into the reading). Distinctive values — not the
    // real catalog's — so a pass cannot come from a hardcoded default anywhere in the chain.
    const deps = createUiDeps(kernel, { w: 120, h: 36 }, undefined, () =>
      Promise.resolve({
        present: true,
        agent: "claude",
        version: null,
        detail: "probe reading",
        model: "probe-model",
        effort: "probe-effort",
      }),
    );
    const renderer = await createReactTestRenderer(<App deps={deps} />, {
      width: 120,
      height: 36,
    });
    open = renderer;
    const text = await renderer.waitForFrame((frame) => frame.includes("probe reading"));
    expect(text).toContain("‹probe-model›");
    expect(text).toContain("‹probe-effort›");
  });

  test("mounts the enlarge placeholder below the minimum frame", async () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 60, h: 16 });
    const renderer = await createReactTestRenderer(<App deps={deps} />, {
      width: 60,
      height: 16,
    });
    open = renderer;
    expect(await renderer.waitForFrame((frame) => frame.includes("terminal too small"))).toContain(
      "terminal too small",
    );
  });

  test("transitions Home -> Workspace when the Kernel reports an open trusted project", async () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    const renderer = await createReactTestRenderer(<App deps={deps} />, {
      width: 120,
      height: 36,
    });
    open = renderer;
    expect(await renderer.waitForFrame((frame) => frame.includes("termcraft"))).toContain(
      "termcraft",
    );

    await renderer.act(() => kernel.emit(workspaceSnapshot()));
    const text = await renderer.waitForFrame(
      (frame) => frame.includes("chat") && frame.includes("claude"),
    );
    expect(text).toContain("chat");
    expect(text).toContain("claude");
  });

  test("renders the ephemeral agent status block while a turn runs", async () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    const renderer = await createReactTestRenderer(<App deps={deps} />, {
      width: 120,
      height: 36,
    });
    open = renderer;

    await renderer.act(() => kernel.emit(workspaceSnapshot()));
    await renderer.waitForFrame((frame) => frame.includes("chat"));

    const turnId = uuidv7();
    await renderer.act(() => {
      kernel.emit(event("turn.started", { turnId, chatId: uuidv7(), deadline: TEST_TS }));
      kernel.emit(
        event("turn.progress", {
          turnId,
          attempt: 1,
          content: { kind: "tool", op: "edit", target: "main/page.tsx" },
        }),
      );
    });
    const text = await renderer.waitForFrame(
      (frame) => frame.includes("generating design") && frame.includes("main/page.tsx"),
    );
    expect(text).toContain("generating design");
    expect(text).toContain("main/page.tsx");
  });

  test("renders slash menu non-modally above the workspace composer", async () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    const renderer = await createReactTestRenderer(<App deps={deps} />, {
      width: 120,
      height: 36,
    });
    open = renderer;
    await renderer.act(() => {
      kernel.emit(workspaceSnapshot());
      deps.local.composer.set("/");
      deps.local.overlay.set("slash-menu");
    });
    const text = await renderer.waitForFrame(
      (frame) => frame.includes("commands") && frame.includes("/new"),
    );
    const rows = text.split("\n");
    expect(text).toContain("commands");
    expect(text).toContain("/new");
    const commandRow = rows.findIndex((row) => row.includes("/new"));
    const composerRow = rows.findIndex((row) => row.includes("❯ /"));
    expect(commandRow).toBeGreaterThanOrEqual(0);
    expect(commandRow).toBeLessThan(composerRow);
  });

  test("centers the chat-list popup in an absolute modal layer", async () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    const chatId = uuidv7();
    const renderer = await createReactTestRenderer(<App deps={deps} />, {
      width: 120,
      height: 36,
    });
    open = renderer;
    await renderer.act(() => {
      kernel.emit(workspaceSnapshot());
      kernel.emit(
        event("chat.changed", {
          activeChatId: chatId,
          added: [{ chatId, createdAt: TEST_TS, displayName: null }],
          updated: [],
          removedChatIds: [],
        }),
      );
      deps.local.overlay.set("chat-list");
    });
    const frame = await renderer.waitForFrame((output) => output.includes("chats"));
    const titleRow = frame.split("\n").findIndex((row) => row.includes("chats"));
    expect(titleRow).toBeGreaterThan(8);
    expect(titleRow).toBeLessThan(25);
  });

  test("sorts the chat-list popup newest-first and keeps ↑/↓/⏎ selection in agreement (design 24-chats.dc.html, wsChats)", async () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    const oldChatId = uuidv7();
    const midChatId = uuidv7();
    const newChatId = uuidv7();
    // uuidv7 embeds a millisecond timestamp, so three ids minted back-to-back in one test can
    // share their first 8 hex chars (the row `label`) — identify rows by `createdAt` instead,
    // which this test controls directly and keeps distinct.
    const OLD_TS = "2026-07-20T00:00:00.000Z";
    const MID_TS = "2026-07-21T00:00:00.000Z";
    const NEW_TS = "2026-07-22T00:00:00.000Z";
    const renderer = await createReactTestRenderer(<App deps={deps} />, {
      width: 120,
      height: 36,
    });
    open = renderer;
    await renderer.act(() => {
      kernel.emit(workspaceSnapshot());
      kernel.emit(
        event("chat.changed", {
          activeChatId: oldChatId,
          added: [
            { chatId: oldChatId, createdAt: OLD_TS, displayName: null },
            { chatId: midChatId, createdAt: MID_TS, displayName: null },
            { chatId: newChatId, createdAt: NEW_TS, displayName: null },
          ],
          updated: [],
          removedChatIds: [],
        }),
      );
      deps.local.overlay.set("chat-list");
    });
    const frame = await renderer.waitForFrame((output) => output.includes(NEW_TS));
    const dataRows = frame
      .split("\n")
      .filter((row) => row.includes(OLD_TS) || row.includes(MID_TS) || row.includes(NEW_TS));
    expect(dataRows).toHaveLength(3);
    expect(dataRows[0]).toContain(NEW_TS);
    expect(dataRows[1]).toContain(MID_TS);
    expect(dataRows[2]).toContain(OLD_TS);

    // Default selection (index 0) already targets the top/newest row; round-trip ↓↓ then ↑↑ and
    // confirm ⏎ still switches to the newest chat — the rendered order and the selection index
    // the `chat-move`/`chat-switch` intents resolve must agree (both sort through the same helper).
    await renderer.act(() => renderer.mockInput.pressArrow("down"));
    await renderer.act(() => renderer.mockInput.pressArrow("down"));
    await renderer.act(() => renderer.mockInput.pressArrow("up"));
    await renderer.act(() => renderer.mockInput.pressArrow("up"));
    await renderer.act(() => renderer.mockInput.pressEnter());
    expect(kernel.dispatched).toHaveLength(1);
    expect((kernel.dispatched[0] as { payload: { chatId: string } }).payload).toEqual({
      chatId: newChatId,
    });
  });

  test("the /chats popup shows a chat's derived displayName (design 24-chats.dc.html, WP-10 Task 9)", async () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    const namedChatId = uuidv7();
    const renderer = await createReactTestRenderer(<App deps={deps} />, {
      width: 120,
      height: 36,
    });
    open = renderer;
    await renderer.act(() => {
      kernel.emit(workspaceSnapshot());
      kernel.emit(
        event("chat.changed", {
          activeChatId: namedChatId,
          added: [
            { chatId: namedChatId, createdAt: TEST_TS, displayName: "build a system monitor" },
          ],
          updated: [],
          removedChatIds: [],
        }),
      );
      deps.local.overlay.set("chat-list");
    });
    const frame = await renderer.waitForFrame((output) =>
      output.includes("build a system monitor"),
    );
    expect(frame).toContain("build a system monitor");
    expect(frame).not.toContain(namedChatId.slice(0, 8));
  });

  test("a chat with displayName: null still falls back to chatId.slice(0, 8)", async () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    const chatId = uuidv7();
    const renderer = await createReactTestRenderer(<App deps={deps} />, {
      width: 120,
      height: 36,
    });
    open = renderer;
    await renderer.act(() => {
      kernel.emit(workspaceSnapshot());
      kernel.emit(
        event("chat.changed", {
          activeChatId: chatId,
          added: [{ chatId, createdAt: TEST_TS, displayName: null }],
          updated: [],
          removedChatIds: [],
        }),
      );
      deps.local.overlay.set("chat-list");
    });
    const frame = await renderer.waitForFrame((output) => output.includes(chatId.slice(0, 8)));
    expect(frame).toContain(chatId.slice(0, 8));
  });

  test("the chat-list overlay outranks an undismissed export popup for both render and keys (precedence bug repro)", async () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    const chatId = uuidv7();
    const operationId = uuidv7();
    const renderer = await createReactTestRenderer(<App deps={deps} />, {
      width: 120,
      height: 36,
    });
    open = renderer;
    await renderer.act(() => {
      kernel.emit(workspaceSnapshot());
      kernel.emit(
        event("chat.changed", {
          activeChatId: chatId,
          added: [{ chatId, createdAt: TEST_TS, displayName: null }],
          updated: [],
          removedChatIds: [],
        }),
      );
      deps.local.overlay.set("chat-list");
    });
    await renderer.waitForFrame((frame) => frame.includes("chats"));

    // An export terminal event arrives WHILE the chat-list overlay is open.
    await renderer.act(() => {
      kernel.emit(
        event("export.completed", {
          operationId,
          phase: "publishing",
          destination: ".termcraft/export",
          generationId: null,
          failure: null,
        }),
      );
    });

    // The chat-list stays the visible overlay — the export popup must not paint over it.
    const stillChatList = await renderer.waitForFrame((frame) => frame.includes("chats"));
    expect(stillChatList).not.toContain("export ^E");

    // Enter must route to the chat-list (chat-switch), not export-dismiss.
    await renderer.act(() => renderer.mockInput.pressEnter());
    expect(kernel.dispatched).toHaveLength(1);
    expect((kernel.dispatched[0] as { kind: string }).kind).toBe("chat.switch");

    // Only now that the overlay above it closed does the export popup show, and Enter dismisses
    // it — it was never dismissed by the Enter that switched chats.
    const exportShown = await renderer.waitForFrame((frame) => frame.includes("export ^E"));
    expect(exportShown).not.toContain("chats");
    await renderer.act(() => renderer.mockInput.pressEnter());
    const exportDismissed = await renderer.waitForFrame((frame) => !frame.includes("export ^E"));
    expect(exportDismissed).not.toContain("export ^E");
  });

  test("shows the export popup on export.completed and Enter dismisses it (M14)", async () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    const operationId = uuidv7();
    const renderer = await createReactTestRenderer(<App deps={deps} />, {
      width: 120,
      height: 36,
    });
    open = renderer;
    await renderer.act(() => {
      kernel.emit(workspaceSnapshot());
      kernel.emit(
        event("export.completed", {
          operationId,
          phase: "publishing",
          destination: ".termcraft/export",
          generationId: null,
          failure: null,
        }),
      );
    });
    await renderer.waitForFrame((frame) => frame.includes("export ^E"));
    await renderer.act(() => renderer.mockInput.pressEnter());
    const dismissed = await renderer.waitForFrame((frame) => !frame.includes("export ^E"));
    expect(dismissed).not.toContain("export ^E");
  });

  test("the export success popup renders the real export.completed result, not the hardcoded 'design' sample (App.tsx:89)", async () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(
      kernel,
      { w: 120, h: 36 },
      { root: "/my-real-project", workspaceIdentity: "wid" },
    );
    const operationId = uuidv7();
    const renderer = await createReactTestRenderer(<App deps={deps} />, {
      width: 120,
      height: 36,
    });
    open = renderer;
    await renderer.act(() => {
      kernel.emit(workspaceSnapshot());
      kernel.emit(
        event("export.completed", {
          operationId,
          phase: "publishing",
          destination: ".termcraft/export/my-real-output",
          generationId: null,
          failure: null,
        }),
      );
    });
    const frame = await renderer.waitForFrame((f) => f.includes("export ^E"));
    // The real `export.completed` destination the mirror actually retained — never the
    // fabricated `.termcraft/export/design-prompt.md`/`pages/*.tsx` glob literals.
    expect(frame).toContain(".termcraft/export/my-real-output");
    expect(frame).not.toContain("design-prompt.md");
    expect(frame).not.toContain("pages/*.tsx");
    // The real project identity available to the UI (`env.root`, the same folder identity
    // `TrustPrompt` already shows) — never the design's hardcoded "design" sample name.
    expect(frame).toContain("/my-real-project");
    expect(frame).not.toContain("exported design");
  });

  test("shows the export failure popup on export.failed, naming the retained page/size, and Escape dismisses it (M14)", async () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    const operationId = uuidv7();
    const renderer = await createReactTestRenderer(<App deps={deps} />, {
      width: 120,
      height: 36,
      kittyKeyboard: true,
    });
    open = renderer;
    await renderer.act(() => {
      kernel.emit(workspaceSnapshot());
      kernel.emit(
        event("export.started", {
          operationId,
          sourceSnapshotDigest: TEST_SHA,
          pageCount: 1,
          renderJobCount: 2,
          destination: ".termcraft/export",
        }),
      );
      kernel.emit(
        event("export.progress", {
          operationId,
          phase: "rendering",
          completedJobs: 1,
          totalJobs: 2,
          pageSlug: "main",
          sizeBytes: 2048,
        }),
      );
      kernel.emit(
        event("export.failed", {
          operationId,
          phase: "rendering",
          destination: ".termcraft/export",
          generationId: null,
          failure: {
            code: "EXPORT_RENDER_FAILED",
            retryable: false,
            safeMessage: "disk full",
            details: {},
          },
        }),
      );
    });
    const frame = await renderer.waitForFrame((output) => output.includes("export failed"));
    expect(frame).toContain("export failed main");
    expect(frame).toContain("2048");
    expect(frame).toContain("disk full");
    await renderer.act(() => renderer.mockInput.pressEscape());
    const dismissed = await renderer.waitForFrame((output) => !output.includes("export failed"));
    expect(dismissed).not.toContain("export failed");
  });

  test("passes read-only state into the workspace presentation", async () => {
    const kernel = createFakeKernel();
    kernel.setSnapshot({
      projectId: uuidv7(),
      activePageSlug: "main",
      activeChatId: uuidv7(),
      trust: "untrusted-read-only",
      pageDescriptors: [readyPage()],
    });
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    const renderer = await createReactTestRenderer(<App deps={deps} />, {
      width: 120,
      height: 36,
    });
    open = renderer;
    const text = await renderer.waitForFrame(
      (frame) =>
        frame.includes("READ-ONLY") &&
        frame.includes("Send · Tweaks · pins disabled") &&
        frame.includes("read-only — Send disabled"),
    );
    expect(text).toContain("READ-ONLY");
    expect(text).toContain("Send · Tweaks · pins disabled");
    expect(text).toContain("read-only — Send disabled");
  });

  test("walks the complete phase-7 command and event flow through the rendered App", async () => {
    const kernel = createFakeKernel();
    const preview = createFakePreviewSession();
    kernel.setPreview(preview.handle);
    const deps = createUiDeps(
      kernel,
      { w: 120, h: 36 },
      { root: "/project", workspaceIdentity: "workspace-id" },
    );
    const renderer = await createReactTestRenderer(<App deps={deps} />, {
      width: 120,
      height: 36,
      useMouse: true,
      kittyKeyboard: true,
    });
    open = renderer;

    const home = await renderer.waitForFrame(
      (frame) => frame.includes("termcraft") && frame.includes("agent ready"),
    );
    expect(home).toContain("Describe the TUI you want to design");

    await renderer.act(() => renderer.mockInput.typeText("build a dashboard"));
    expect(await renderer.waitForFrame((frame) => frame.includes("build a dashboard"))).toContain(
      "build a dashboard",
    );
    await renderer.act(() => renderer.mockInput.pressEnter());
    const projectCreate = kernel.dispatched[0] as {
      protocolVersion: number;
      commandId: string;
      expectedRevision: string;
      kind: string;
      payload: unknown;
    };
    expect(projectCreate).toEqual({
      protocolVersion: 1,
      commandId: projectCreate.commandId,
      expectedRevision: "0",
      kind: "project.create",
      payload: {
        root: "/project",
        creationDefaults: { trust: "trusted", workspaceIdentity: "workspace-id" },
        text: "build a dashboard",
      },
    });

    const projectId = uuidv7();
    const initialChatId = uuidv7();
    const workspace = snapshot({
      projectId,
      activePageSlug: "main",
      activeChatId: initialChatId,
      trust: "trusted",
      capabilities: [{ id: "chat.create", target: null, state: { available: true } }],
      pageDescriptors: [readyPage()],
      agentIdentity: AGENT_IDENTITY,
    });
    await renderer.act(() => kernel.emit(workspace));
    const workspaceFrame = await renderer.waitForFrame(
      (frame) => frame.includes("chat · claude") && frame.includes("preparing preview"),
    );
    expect(workspaceFrame).toContain("Ask for changes");

    await renderer.act(() => renderer.mockInput.typeText("add a network panel"));
    expect(await renderer.waitForFrame((frame) => frame.includes("add a network panel"))).toContain(
      "add a network panel",
    );
    await renderer.act(() => renderer.mockInput.pressEnter());
    const turnStart = kernel.dispatched[1] as typeof projectCreate;
    expect(turnStart).toEqual({
      protocolVersion: 1,
      commandId: turnStart.commandId,
      expectedRevision: workspace.stateRevision,
      kind: "turn.start",
      payload: { text: "add a network panel" },
    });

    const turnId = uuidv7();
    await renderer.act(() => {
      kernel.emit(event("turn.started", { turnId, chatId: initialChatId, deadline: TEST_TS }));
      kernel.emit(
        event("turn.progress", {
          turnId,
          attempt: 1,
          content: { kind: "tool", op: "edit", target: "main/page.tsx" },
        }),
      );
    });
    const progressFrame = await renderer.waitForFrame(
      (frame) => frame.includes("generating design") && frame.includes("main/page.tsx"),
    );
    expect(progressFrame).toContain("generating… esc to cancel");

    const completed = event("turn.completed", {
      turnId,
      outcome: "completed",
      changedPages: [{ pageSlug: "main", sourceHash: TEST_SHA }],
      warnings: [],
      failure: null,
    });
    await renderer.act(() => kernel.emit(completed));
    const terminalFrame = await renderer.waitForFrame(
      (frame) => frame.includes("✓ updated main") && !frame.includes("generating design"),
    );
    expect(terminalFrame).toContain("Ask for changes");

    await renderer.act(() => renderer.mockInput.typeText("/"));
    const newChatMenu = await renderer.waitForFrame(
      (frame) => frame.includes("commands") && frame.includes("/new"),
    );
    expect(newChatMenu).toContain("start a new chat");
    await renderer.act(() => renderer.mockInput.pressEnter());
    const chatCreate = kernel.dispatched[2] as typeof projectCreate;
    expect(chatCreate).toEqual({
      protocolVersion: 1,
      commandId: chatCreate.commandId,
      expectedRevision: completed.stateRevision,
      kind: "chat.create",
      payload: {},
    });

    const newChatId = uuidv7();
    const chatChanged = event("chat.changed", {
      activeChatId: newChatId,
      added: [
        { chatId: initialChatId, createdAt: TEST_TS, displayName: null },
        { chatId: newChatId, createdAt: TEST_TS, displayName: null },
      ],
      updated: [],
      removedChatIds: [],
    });
    await renderer.act(() => kernel.emit(chatChanged));
    await renderer.act(() => renderer.mockInput.typeText("/chats"));
    expect(
      await renderer.waitForFrame(
        (frame) => frame.includes("/chats") && frame.includes("switch or list chats"),
      ),
    ).toContain("/chats");
    await renderer.act(() => renderer.mockInput.pressEnter());
    const chatPopup = await renderer.waitForFrame((frame) => frame.includes(newChatId.slice(0, 8)));
    expect(chatPopup).toContain("chats");
    await renderer.act(() => renderer.mockInput.pressArrow("up"));
    await renderer.act(() => renderer.mockInput.pressEnter());
    const chatSwitch = kernel.dispatched[3] as typeof projectCreate;
    expect(chatSwitch).toEqual({
      protocolVersion: 1,
      commandId: chatSwitch.commandId,
      expectedRevision: chatChanged.stateRevision,
      kind: "chat.switch",
      payload: { chatId: initialChatId },
    });

    const rendered: PreviewFrameV1 = {
      sessionId: preview.handle.previewSessionId,
      sourceHash: TEST_SHA,
      frameSeq: "1",
      width: 20,
      height: 10,
      rows: [[{ text: "network preview", fg: "default", bg: "default", attrs: 0 }]],
    };
    await renderer.act(() => preview.pushFrame(rendered));
    const frameToken = preview.frameTokenFor(rendered);
    expect(await renderer.waitForFrame((frame) => frame.includes("network preview"))).toContain(
      "network preview",
    );
    await renderer.waitFor(() => preview.acknowledgements.length === 1);
    expect(preview.acknowledgements).toEqual([frameToken]);

    // Workspace frame origin at 120 cols: round(120*.37)+border = x45; tabs+border = y2.
    await renderer.act(() => renderer.mockMouse.pressDown(51, 9, MouseButtons.RIGHT));
    const geometryQuery = kernel.dispatched[4] as typeof projectCreate;
    expect(geometryQuery).toEqual({
      protocolVersion: 1,
      commandId: geometryQuery.commandId,
      expectedRevision: chatChanged.stateRevision,
      kind: "preview.queryGeometry",
      payload: { frameToken, query: { kind: "pin-anchor", x: 6, y: 7 } },
    });

    const geometryToken = uuidv7();
    const geometryResult = event("preview.geometryResult", {
      previewSessionId: preview.handle.previewSessionId,
      frameTokenId: frameToken,
      frameIdentity: {
        previewSessionId: preview.handle.previewSessionId,
        nonce: TEST_NONCE,
        sourceHash: TEST_SHA,
        frameSeq: "1",
      },
      queryKind: "pin-anchor",
      // M21's closed `GeometryQueryResultV1` (`core/protocol`): the pin flow gates
      // only on `geometryToken` (`handleGeometryResult`'s `purpose === "pin"`
      // branch never reads `result`), so a bare resolved `checkHit` is enough here.
      result: { kind: "checkHit", hit: { id: "network" } },
      geometryToken,
    });
    await renderer.act(() => kernel.emit(geometryResult));
    expect(await renderer.waitForFrame((frame) => frame.includes("new pin"))).toContain("new pin");
    await renderer.act(() => renderer.mockInput.typeText("keep this visible"));
    expect(await renderer.waitForFrame((frame) => frame.includes("keep this visible"))).toContain(
      "keep this visible",
    );
    await renderer.act(() => renderer.mockInput.pressEnter());
    const pinCreate = kernel.dispatched[5] as typeof projectCreate;
    expect(pinCreate).toEqual({
      protocolVersion: 1,
      commandId: pinCreate.commandId,
      expectedRevision: geometryResult.stateRevision,
      kind: "pin.create",
      payload: { geometryToken, text: "keep this visible" },
    });

    const trustPending = snapshot({
      projectId,
      activePageSlug: "main",
      activeChatId: initialChatId,
      trust: null,
      pageDescriptors: [readyPage()],
    });
    await renderer.act(() => kernel.emit(trustPending));
    const trustFrame = await renderer.waitForFrame(
      (frame) => frame.includes("trust this folder") && frame.includes("esc read-only"),
    );
    expect(trustFrame).toContain("/project");
    await renderer.act(() => renderer.mockInput.pressEscape());
    const trustDecline = kernel.dispatched[6] as typeof projectCreate;
    expect(trustDecline).toEqual({
      protocolVersion: 1,
      commandId: trustDecline.commandId,
      expectedRevision: trustPending.stateRevision,
      kind: "project.setTrust",
      payload: { trust: "untrusted-read-only", workspaceIdentity: "workspace-id" },
    });

    const readOnly = snapshot({
      projectId,
      activePageSlug: "main",
      activeChatId: initialChatId,
      trust: "untrusted-read-only",
      pageDescriptors: [readyPage()],
    });
    await renderer.act(() => kernel.emit(readOnly));
    const readOnlyFrame = await renderer.waitForFrame(
      (frame) => frame.includes("READ-ONLY") && frame.includes("read-only — Send disabled"),
    );
    expect(readOnlyFrame).toContain("Send · Tweaks · pins disabled");
    expect(kernel.dispatched.map((raw) => (raw as { kind: string }).kind)).toEqual([
      "project.create",
      "turn.start",
      "chat.create",
      "chat.switch",
      "preview.queryGeometry",
      "pin.create",
      "project.setTrust",
    ]);
  });
});
