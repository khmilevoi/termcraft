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
  });

describe("App (end-to-end, FakeKernel-driven)", () => {
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
          result: {
            pageSlug: "main",
            elementId: "network",
            rect: { x: 3, y: 2, width: 8, height: 3 },
            label: 'panel "network"',
          },
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
          result: {
            pageSlug: "main",
            elementId: "network",
            rect: { x: 3, y: 2, width: 8, height: 3 },
            label: 'panel "network"',
          },
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
      (frame) => frame.includes("chat") && frame.includes("codex"),
    );
    expect(text).toContain("chat");
    expect(text).toContain("codex");
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
          added: [{ chatId, createdAt: TEST_TS }],
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
});
