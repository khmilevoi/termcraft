import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { MouseButtons } from "@opentui/core/testing";

import type { PreviewFrameV1 } from "core/ports";
import type { EventPayloadByKindV1 } from "core/protocol";
import { uuidv7 } from "infrastructure/uuid";
import type { AgentHealth } from "ui/agent-health";
import { homeSubmitAllowed } from "ui/home";
import { FRESH_CHAT_LABEL } from "ui/popups";
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
import { UI_RENDERER_CONFIG } from "../model/render-root";
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
  entry: "pages/main.tsx",
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
  test("the startup probe surfaces a missing agent without a manual recheck, and r re-checks it (M15, finding §2.7)", async () => {
    const kernel = createFakeKernel();
    // The probe itself reports the CLI missing on its first call (the startup probe
    // `createUiDeps` now fires — no manual `local.agentHealth.set` needed to reach this state,
    // reproducing a real phase-8 probe's first reading) and recovers on the second call (the
    // `r` re-check).
    let calls = 0;
    const deps = createUiDeps(kernel, { w: 120, h: 36 }, undefined, () => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve({
          kind: "missing" as const,
          agent: "claude",
          detail: "claude CLI not found",
        });
      }
      return Promise.resolve({ kind: "ready" as const, agent: "claude" });
    });
    const renderer = await createReactTestRenderer(<App deps={deps} />, {
      width: 120,
      height: 36,
    });
    open = renderer;
    await renderer.waitForFrame((frame) => frame.includes("claude CLI not found"));
    await renderer.act(() => renderer.mockInput.typeText("r"));
    // No health line exists any more (finding §2.7, phase-8 Task 15) — recovery is proven by
    // the live idle prompt replacing the full-screen missing-agent takeover. finding §2.6
    // (phase-8 Task 18): the cursor now overlaps the placeholder's first cell (design `home()`,
    // `design/termcraft-engine.js:145-146`), so the on-screen text is the cursor glyph plus the
    // REST of the placeholder — the leading "D" is the cursor, not a literal character.
    const frame = await renderer.waitForFrame((output) =>
      output.includes("escribe the TUI you want to design"),
    );
    expect(frame).toContain("escribe the TUI you want to design");
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

    // Workspace frame origin at 120 cols: round(120*.37)+border = x45; tabs+rule+gap+border =
    // y4 (task 8: design `paneShell`'s `dy = 4` — the rule row and the blank gap row between
    // the tab strip and the design area).
    await renderer.act(() => renderer.mockMouse.moveTo(49, 7));
    await renderer.act(emitHit);
    await renderer.act(() => renderer.mockMouse.pressDown(50, 8, MouseButtons.LEFT));
    await renderer.act(emitHit);
    await renderer.act(() => renderer.mockMouse.pressDown(51, 9, MouseButtons.RIGHT));

    const geometryQueries = kernel.dispatched
      .map((raw) => raw as { kind: string; payload: { query?: unknown } })
      .filter((command) => command.kind === "preview.queryGeometry");
    expect(geometryQueries.map((command) => command.payload.query)).toEqual([
      { kind: "hit", x: 4, y: 3 },
      { kind: "hit", x: 5, y: 4 },
      { kind: "pin-anchor", x: 6, y: 5 },
    ]);
  });

  // §7. The task-1 brief's own literal click target (x50/y8, "the preview column") does NOT
  // reproduce this defect: nothing in `ws-preview` is `focusable` (only `EditBufferRenderable` and
  // `ScrollBoxRenderable` are, in `@opentui/core`), so `dispatchMouseEvent`'s autoFocus walk finds
  // no ancestor to steal focus for and the click is a no-op. The chat pane's OWN scrollback,
  // `<scrollbox id="ws-chat-scroll">` (`Workspace.tsx:1035`), IS focusable by default — a fact the
  // plan's C1 correction missed (it names only `EditBufferRenderable` as focusable-by-default) —
  // so a click there is what actually exercises path 1. Confirmed by instrumenting a
  // `focused_renderable` listener during diagnosis: this exact click fired
  // `focus moved ws-chat-scroll <- ws-composer-input-editor` before the fix below.
  test("a left click in the chat's own scrollback leaves the composer able to receive typing (§7)", async () => {
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
    // Spreads the SAME renderer config production actually boots with (`UI_RENDERER_CONFIG`),
    // rather than hardcoding `autoFocus: false` here independently of it — a regression that
    // reverted or dropped the production flag must fail this test too, not just the narrower
    // `root.test.tsx` field assertion.
    const renderer = await createReactTestRenderer(<App deps={deps} />, {
      ...UI_RENDERER_CONFIG,
      width: 120,
      height: 36,
      useMouse: true,
    });
    open = renderer;
    await renderer.act(() => kernel.emit(workspaceSnapshot()));

    // Typing works before any mouse involvement — this half must pass even on a broken build, so a
    // failure here means the fixture is wrong, not that the defect reproduced.
    await renderer.act(() => renderer.mockInput.typeText("a"));
    expect(deps.local.composer()).toBe("a");

    // A left click inside the chat pane's scrollback, well clear of the composer itself and below
    // the tab/title row — lands inside `ws-chat-scroll`.
    await renderer.act(() => renderer.mockMouse.pressDown(10, 8, MouseButtons.LEFT));
    await renderer.act(() => renderer.mockInput.typeText("b"));

    expect(deps.local.composer()).toBe("ab");
  });

  test("mounts Home when no project is open", async () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    const renderer = await createReactTestRenderer(<App deps={deps} />, {
      width: 120,
      height: 36,
    });
    open = renderer;
    // No health line exists any more (finding §2.7, phase-8 Task 15) — the live prompt
    // placeholder is what proves Home settled on a `ready` outcome (Enter enabled). finding §2.6
    // (phase-8 Task 18): the cursor overlaps the placeholder's first cell, so the on-screen text
    // is missing its literal leading "D" — matched here as "escribe the TUI" instead.
    const text = await renderer.waitForFrame(
      (frame) => frame.includes("termcraft") && frame.includes("escribe the TUI"),
    );
    expect(text).toContain("termcraft");
    expect(text).toContain("escribe the TUI");
    // Phase-8 Task 13 (finding §2.7): `homeCombo` reads `local.agentSelection`, the synchronous
    // selection the composition root seeds — NOT the health probe (see `App.tsx`'s own doc
    // comment on `homeCombo`). This test injects no `agentSelection` (createUiDeps's sixth
    // parameter defaults to `null`), so `homeCombo(null)` renders the honest empty combo rather
    // than an invented identity. Asserting the empty slots is what keeps a fabricated default
    // from creeping back in.
    expect(text).toContain("‹›");
    expect(text).not.toContain("‹high›");
  });

  test("paints agent · model · effort on the first frame, before any probe resolves (finding §2.7, phase-8 Task 13)", async () => {
    const kernel = createFakeKernel();
    const neverResolves = () => new Promise<AgentHealth>(() => {});
    const deps = createUiDeps(
      kernel,
      { w: 120, h: 40 },
      { root: ".", workspaceIdentity: "ws", projectExists: false },
      neverResolves,
      () => undefined,
      { agent: "claude", model: "claude-sonnet-5", effort: "high" },
    );

    const renderer = await createReactTestRenderer(<App deps={deps} />, {
      width: 120,
      height: 40,
    });
    open = renderer;
    const frame = await renderer.waitForFrame((f) => f.includes("‹claude-sonnet-5›"));

    expect(frame).toContain("agent ‹claude›");
    expect(frame).toContain("model ‹claude-sonnet-5›");
    expect(frame).toContain("effort ‹high›");
  });

  test("Home's combo is driven by the injected agentSelection, never the health probe (finding §2.7, phase-8 Task 13)", async () => {
    const kernel = createFakeKernel();
    // The health probe's own reading carries no `model`/`effort` field to fold in — `blocked`
    // is chosen here (not `ready`, which renders no health text at all any more, finding §2.7
    // phase-8 Task 15) specifically so this probe's own distinctive `detail` text shows up
    // somewhere on screen (the `HomeHealthPanel`), proving the combo below is driven by
    // `agentSelection` and not by anything this probe reports. `agentSelection` (createUiDeps's
    // SIXTH parameter) supplies distinctive model/effort values, so a pass cannot come from the
    // combo accidentally reading the probe or a hardcoded default anywhere in the chain.
    const deps = createUiDeps(
      kernel,
      { w: 120, h: 36 },
      undefined,
      () =>
        Promise.resolve({
          kind: "blocked",
          agent: "claude",
          panel: "login",
          detail: "probe reading",
        }),
      () => undefined,
      { agent: "claude", model: "probe-model", effort: "probe-effort" },
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
          content: { kind: "tool", id: "toolu_1", op: "edit", target: "main/page.tsx" },
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

  // §3.10, phase-8 Task 17 (finding §2.4): typing `/` on the Home prompt now opens the SAME
  // slash menu, filtered to the two rows meaningful there — /model (v1.0, unavailable) and
  // /exit (the working row the acceptance runbook's step 8 relies on).
  test("opens the slash menu from the Home prompt, filtered to /model and /exit, and /exit's submit requests shutdown", async () => {
    const kernel = createFakeKernel();
    let exited = false;
    const deps = createUiDeps(kernel, { w: 120, h: 36 }, undefined, undefined, () => {
      exited = true;
    });
    const renderer = await createReactTestRenderer(<App deps={deps} />, {
      width: 120,
      height: 36,
    });
    open = renderer;
    await renderer.waitFor(() => homeSubmitAllowed(deps.local.agentHealth()));

    await renderer.act(() => renderer.mockInput.typeText("/"));
    const menu = await renderer.waitForFrame(
      (frame) => frame.includes("commands") && frame.includes("/exit"),
    );
    const rows = menu.split("\n");
    expect(menu).toContain("/model");
    expect(menu).toContain("/exit");
    // Neither of the seven other design rows leaks onto Home.
    expect(menu).not.toContain("/new");
    expect(menu).not.toContain("/commit");
    const modelRow = rows.findIndex((row) => row.includes("/model"));
    const exitRow = rows.findIndex((row) => row.includes("/exit"));
    expect(modelRow).toBeGreaterThanOrEqual(0);
    expect(exitRow).toBeGreaterThan(modelRow);

    // Selection already skipped unavailable /model onto /exit — Enter submits it directly.
    await renderer.act(() => renderer.mockInput.pressEnter());
    expect(exited).toBe(true);
    expect(deps.local.prompt()).toBe("");
    expect(deps.local.overlay()).toBeNull();
    expect(kernel.dispatched).toHaveLength(0);
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
    // Defect 2 fix: the WHEN column renders `formatChatWhen`'s relative-time vocabulary
    // (design `wsChats`, engine:1026-1039), not the raw `createdAt` ISO-8601 string — so this
    // test fixes `now` via App's injectable `clock` prop and asserts on the resulting relative
    // labels, which stay just as distinct (and just as order-revealing) as the old raw
    // timestamps did.
    const NOW_MS = Date.parse("2026-07-27T12:00:00.000Z");
    const OLD_TS = new Date(NOW_MS - 3 * 24 * 3_600_000).toISOString(); // -> "3d ago"
    const MID_TS = new Date(NOW_MS - 25 * 3_600_000).toISOString(); // -> "yesterday"
    const NEW_TS = new Date(NOW_MS - 2 * 3_600_000).toISOString(); // -> "2h ago"
    const OLD_WHEN = "3d ago";
    const MID_WHEN = "yesterday";
    const NEW_WHEN = "2h ago";
    const renderer = await createReactTestRenderer(<App deps={deps} clock={() => NOW_MS} />, {
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
    const frame = await renderer.waitForFrame((output) => output.includes(NEW_WHEN));
    expect(frame).not.toContain(NEW_TS);
    expect(frame).not.toContain(OLD_TS);
    const dataRows = frame
      .split("\n")
      .filter((row) => row.includes(OLD_WHEN) || row.includes(MID_WHEN) || row.includes(NEW_WHEN));
    expect(dataRows).toHaveLength(3);
    expect(dataRows[0]).toContain(NEW_WHEN);
    expect(dataRows[1]).toContain(MID_WHEN);
    expect(dataRows[2]).toContain(OLD_WHEN);

    // Default selection (index 0) already targets the top/newest row; round-trip ↓↓ then ↑↑ and
    // confirm ⏎ still switches to the newest chat — the rendered order and the selection index
    // the `chat-move`/`chat-switch` intents resolve must agree (both sort through the same helper).
    await renderer.act(() => renderer.mockInput.pressArrow("down"));
    await renderer.act(() => renderer.mockInput.pressArrow("down"));
    await renderer.act(() => renderer.mockInput.pressArrow("up"));
    await renderer.act(() => renderer.mockInput.pressArrow("up"));
    await renderer.act(() => renderer.mockInput.pressEnter());
    // Filtered to `chat.switch` rather than asserting the whole list's length (phase-8 Task 21):
    // the runtime hook dispatches `preview.selectPage` on its own once an active page slug
    // appears. The claim under test is unchanged — Enter switched to exactly the newest chat, once.
    const chatSwitches = kernel.dispatched.filter(
      (raw) => (raw as { kind: string }).kind === "chat.switch",
    );
    expect(chatSwitches).toHaveLength(1);
    expect((chatSwitches[0] as { payload: { chatId: string } }).payload).toEqual({
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

  // Defect 3 fix: a `displayName: null` chat (no first user record yet) shows the design's
  // ACTUAL `wsChatFresh` wording, `'new chat — fresh context'` (design/termcraft-engine.js:1078)
  // — not a `chatId.slice(0, 8)` hex fragment. `wsChats`'s own fourteen sample rows
  // (engine:1026-1039) are all descriptive names; there was never a hex-fallback row in the
  // design to fall back to.
  test("a chat with displayName: null shows the design's fresh-chat label, never a chatId hex fragment", async () => {
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
    const frame = await renderer.waitForFrame((output) => output.includes(FRESH_CHAT_LABEL));
    expect(frame).toContain(FRESH_CHAT_LABEL);
    expect(frame).not.toContain(chatId.slice(0, 8));
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
    // The precedence claim is that Enter routed to the chat list and NOT to export-dismiss, so it
    // is asserted as "exactly one chat.switch, and no export command" rather than as the length of
    // the whole dispatch list — the runtime hook's own `preview.selectPage` also lands here
    // (phase-8 Task 21).
    const routedKinds = kernel.dispatched.map((raw) => (raw as { kind: string }).kind);
    expect(routedKinds.filter((kind) => kind === "chat.switch")).toHaveLength(1);
    expect(routedKinds.filter((kind) => kind.startsWith("export."))).toHaveLength(0);

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
      { root: "/my-real-project", workspaceIdentity: "wid", projectExists: false },
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
    // The trust prompt is already answered — without this, `trust: "untrusted-read-only"` alone
    // resolves `deps.screen()` to `"trust-prompt"` (Task 1, 2026-08-03), so the app root would
    // render `TrustPrompt` instead of the read-only Workspace this test asserts on.
    deps.local.trustPromptDismissed.set(true);
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
      { root: "/project", workspaceIdentity: "workspace-id", projectExists: false },
    );
    const renderer = await createReactTestRenderer(<App deps={deps} />, {
      width: 120,
      height: 36,
      useMouse: true,
      kittyKeyboard: true,
    });
    open = renderer;

    // finding §2.6 (phase-8 Task 18): the cursor overlaps the placeholder's first cell, so the
    // on-screen text is missing its literal leading "D" (see the recovery test above).
    const home = await renderer.waitForFrame(
      (frame) => frame.includes("termcraft") && frame.includes("escribe the TUI"),
    );
    expect(home).toContain("escribe the TUI you want to design");
    // No health line exists any more (finding §2.7, phase-8 Task 15) — the placeholder above
    // renders identically during `checking`, so Enter below needs the outcome to have actually
    // settled to something that allows submit (the default test probe resolves to `advisory`,
    // never `ready` — fix round 1, Finding 1), not merely the first seeded frame.
    await renderer.waitFor(() => homeSubmitAllowed(deps.local.agentHealth()));

    await renderer.act(() => renderer.mockInput.typeText("build a dashboard"));
    expect(await renderer.waitForFrame((frame) => frame.includes("build a dashboard"))).toContain(
      "build a dashboard",
    );
    await renderer.act(() => renderer.mockInput.pressEnter());
    type DispatchedCommand = {
      protocolVersion: number;
      commandId: string;
      expectedRevision: string;
      kind: string;
      payload: unknown;
    };
    // Looked up BY KIND, not by index (phase-8 Task 21): `ui/app/model/deps.ts`'s runtime hook now
    // dispatches `preview.selectPage` on its own the moment an active page slug appears, so the
    // positions of the user-driven commands below are no longer fixed. Each assertion still names
    // exactly the command it is about.
    // Throws rather than returning `undefined`: a missing command is a fixture bug, and the
    // message names it directly instead of surfacing as `undefined` vs an object diff. Same
    // idiom the store fixtures use (`staging.test.ts`'s `throw new Error("fixture bug: …")`).
    const dispatchedOf = (kind: string): DispatchedCommand => {
      const found = kernel.dispatched.find(
        (raw): raw is DispatchedCommand => (raw as { kind: string }).kind === kind,
      );
      if (found === undefined) {
        throw new Error(
          `fixture bug: no ${kind} was dispatched (saw ${kernel.dispatched.map((raw) => (raw as { kind: string }).kind).join(", ")})`,
        );
      }
      return found;
    };
    const projectCreate = dispatchedOf("project.create");
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
      // `chat.switch` is required for the `/chats` walk below (finding §2.5, phase-8 Task 16
      // review round 1): the row's OWN capability is null (it opens a popup), but it now reads
      // chat.switch's published state, not an unconditional "available".
      capabilities: [
        { id: "chat.create", target: null, state: { available: true } },
        { id: "chat.switch", target: null, state: { available: true } },
      ],
      pageDescriptors: [readyPage()],
      agentIdentity: AGENT_IDENTITY,
    });
    await renderer.act(() => kernel.emit(workspace));
    const workspaceFrame = await renderer.waitForFrame(
      (frame) => frame.includes("chat · claude") && frame.includes("preparing preview"),
    );
    // finding §2.6 (phase-8 Task 18): the composer is empty here, so its cursor overlaps the
    // placeholder's first cell — the leading "A" is the cursor glyph, not a literal character.
    expect(workspaceFrame).toContain("sk for changes");

    await renderer.act(() => renderer.mockInput.typeText("add a network panel"));
    expect(await renderer.waitForFrame((frame) => frame.includes("add a network panel"))).toContain(
      "add a network panel",
    );
    await renderer.act(() => renderer.mockInput.pressEnter());
    const turnStart = dispatchedOf("turn.start");
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
          content: { kind: "tool", id: "toolu_1", op: "edit", target: "main/page.tsx" },
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
    // finding §2.6 (phase-8 Task 18): the composer is empty here, so its cursor overlaps the
    // placeholder's first cell — the leading "A" is the cursor glyph, not a literal character.
    expect(terminalFrame).toContain("sk for changes");

    await renderer.act(() => renderer.mockInput.typeText("/"));
    const newChatMenu = await renderer.waitForFrame(
      (frame) => frame.includes("commands") && frame.includes("/new"),
    );
    expect(newChatMenu).toContain("start a new chat");
    await renderer.act(() => renderer.mockInput.pressEnter());
    const chatCreate = dispatchedOf("chat.create");
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
    // Both chats carry `displayName: null` here, so both rows now render the SAME design
    // fresh-chat label (Defect 3 fix) rather than a distinguishing `chatId.slice(0, 8)` hex
    // fragment — wait on the popup's title (`chats · ` + row count, design `wsChats`,
    // engine:1048) instead, which is still a reliable "the popup actually rendered" signal.
    const chatPopup = await renderer.waitForFrame((frame) => frame.includes("chats · 2"));
    expect(chatPopup).toContain(FRESH_CHAT_LABEL);
    await renderer.act(() => renderer.mockInput.pressArrow("up"));
    await renderer.act(() => renderer.mockInput.pressEnter());
    const chatSwitch = dispatchedOf("chat.switch");
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

    // Workspace frame origin at 120 cols: round(120*.37)+border = x45; tabs+rule+gap+border =
    // y4 (task 8: design `paneShell`'s `dy = 4`).
    await renderer.act(() => renderer.mockMouse.pressDown(51, 9, MouseButtons.RIGHT));
    const geometryQuery = dispatchedOf("preview.queryGeometry");
    expect(geometryQuery).toEqual({
      protocolVersion: 1,
      commandId: geometryQuery.commandId,
      expectedRevision: chatChanged.stateRevision,
      kind: "preview.queryGeometry",
      payload: { frameToken, query: { kind: "pin-anchor", x: 6, y: 5 } },
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
    const pinCreate = dispatchedOf("pin.create");
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
    const trustDecline = dispatchedOf("project.setTrust");
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
      // phase-8 Task 21 (Gap A §4.7): the runtime hook asks for a preview session as soon as the
      // first `page.descriptorsChanged` names an active slug — before the user's next keystroke.
      "preview.selectPage",
      "turn.start",
      "chat.create",
      "chat.switch",
      "preview.queryGeometry",
      "pin.create",
      "project.setTrust",
    ]);
  });
});

describe("workspace-first launch (2026-08-02)", () => {
  const existingEnv = {
    root: "/tmp/existing",
    workspaceIdentity: "local",
    projectExists: true,
  } as const;

  test("an existing project mounts the Workspace shell, not Home, before anything opens", async () => {
    const deps = createUiDeps(createFakeKernel(), { w: 120, h: 36 }, existingEnv);
    const renderer = await createReactTestRenderer(<App deps={deps} clock={() => 0} />, {
      width: 120,
      height: 36,
    });
    open = renderer;

    const text = await renderer.waitForFrame(
      (frame) => frame.includes("opening project…") && frame.includes("OPENING"),
    );
    expect(text).toContain("opening project…");
    expect(text).toContain("OPENING");
    // Home is not mounted at all on this path — the cursor-adjusted "escribe the TUI…" is the
    // same substring the rest of this file uses to prove Home's placeholder is/isn't on screen
    // (the literal leading "D" is covered by the cursor whenever Home IS live).
    expect(text).not.toContain("escribe the TUI you want to design");
  });

  test("a fresh directory still lands on Home", async () => {
    const deps = createUiDeps(createFakeKernel(), { w: 120, h: 36 });
    const renderer = await createReactTestRenderer(<App deps={deps} clock={() => 0} />, {
      width: 120,
      height: 36,
    });
    open = renderer;

    const text = await renderer.waitForFrame((frame) =>
      frame.includes("escribe the TUI you want to design"),
    );
    expect(text).toContain("escribe the TUI you want to design");
  });

  test("a blockOpen drops the opening Workspace back to Home with its failure panel", async () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 }, existingEnv);
    const renderer = await createReactTestRenderer(<App deps={deps} clock={() => 0} />, {
      width: 120,
      height: 36,
    });
    open = renderer;
    // The pre-emit checkpoint: `deriveScreen` already mounts "workspace" for this pending,
    // project-less startup open (Task 3), and the Workspace's own opening chrome (Task 5's
    // "OPENING" chip) now renders for it — this guarantees the App has actually settled before
    // the blockOpen below, and confirms both the routing and the chrome it drives.
    expect(deps.screen()).toBe("workspace");
    await renderer.waitForFrame((frame) => frame.includes("OPENING"));

    await renderer.act(() =>
      kernel.emit(
        event("kernel.stateChanged", {
          modelId: "kernel.project.state",
          action: "kernel.project.blockOpen",
          previousTag: "opening",
          nextTag: "blocked",
          metadata: {
            reason: "manifest-read-failed",
            failure: {
              code: "PERSISTENCE_FAILED",
              retryable: true,
              safeMessage: "project.toml could not be read",
              details: {},
            },
          },
        }),
      ),
    );

    const text = await renderer.waitForFrame((frame) =>
      frame.includes("project.toml could not be read"),
    );
    expect(text).toContain("escribe the TUI you want to design");
    expect(text).toContain("project.toml could not be read");
    expect(text).not.toContain("OPENING");
  });

  test("an abandoned startup open lands on a Home that names the failure", async () => {
    // THE REGRESSION TEST for branch review finding 2 (2026-08-03). `run-app.ts`'s two startup
    // failure branches never reach the Kernel's `kernel.project.blockOpen`, so
    // `ProjectMirror.openFailure` stays null for them — and `HomeOpenFailurePanel`, gated on that
    // one field, used to render nothing at all here: the user was dropped on a bare Home with the
    // only diagnostic sitting in a trace file. `App.tsx` now composes the mirror's field with
    // `local.startupOpenFailure` (written by `abandonStartupOpen`) into the same prop, so the
    // panel fires for this path too.
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 }, existingEnv);
    const renderer = await createReactTestRenderer(<App deps={deps} clock={() => 0} />, {
      width: 120,
      height: 36,
    });
    open = renderer;
    await renderer.waitForFrame((frame) => frame.includes("OPENING"));

    await renderer.act(() =>
      deps.abandonStartupOpen({
        reason: "startup-open-rejected",
        safeMessage: "request rejected (PROJECT_UNTRUSTED)",
      }),
    );

    const text = await renderer.waitForFrame((frame) =>
      frame.includes("request rejected (PROJECT_UNTRUSTED)"),
    );
    // Home is live (its placeholder is on screen, cursor-adjusted as everywhere else in this
    // file) and the panel is on it, carrying both halves of the failure: the `reason` slug as the
    // box title and the message as its second line.
    expect(text).toContain("escribe the TUI you want to design");
    expect(text).toContain("startup-open-rejected");
    expect(text).toContain("request rejected (PROJECT_UNTRUSTED)");
    expect(text).toContain("this folder's project could not be opened");
    expect(text).not.toContain("OPENING");
    // The invariant the fix must not break: nothing was written into the mirror. The panel is on
    // screen purely through the UI-local reading, with Kernel truth still null.
    expect(deps.mirror.project().openFailure).toBeNull();
  });

  test("finishOpen turns the opening Workspace into a filled one", async () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 }, existingEnv);
    const renderer = await createReactTestRenderer(<App deps={deps} clock={() => 0} />, {
      width: 120,
      height: 36,
    });
    open = renderer;
    await renderer.waitForFrame((frame) => frame.includes("opening project…"));

    await renderer.act(() => kernel.emit(workspaceSnapshot()));

    const text = await renderer.waitForFrame((frame) => frame.includes("Main"));
    expect(text).not.toContain("opening project…");
    expect(text).toContain("Main");
  });
});
