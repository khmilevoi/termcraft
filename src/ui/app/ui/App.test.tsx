import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { EventPayloadByKindV1 } from "core/protocol";
import { createHeadlessRenderer } from "host/render/model/renderer";
import type { RenderHandle } from "host/render/types";
import { uuidv7 } from "infrastructure/uuid";
import { TEST_SHA, TEST_TS, createFakeKernel, event, resetEventSeq, snapshot } from "ui/testing";

import { createUiDeps } from "../model/deps";
import { App } from "./App";

let open: RenderHandle | null = null;
afterEach(() => {
  open?.destroy();
  open = null;
});
beforeEach(() => resetEventSeq());

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const allText = (rows: { text: string }[][]) =>
  rows
    .flat()
    .map((run) => run.text)
    .join("");

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
  test("mounts Home when no project is open", async () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    const handle = await createHeadlessRenderer({ w: 120, h: 36 });
    open = handle;
    handle.mount(<App deps={deps} />);
    await tick();
    await handle.render();
    const text = allText(handle.capture().rows);
    expect(text).toContain("termcraft");
    expect(text).toContain("agent ready");
  });

  test("mounts the enlarge placeholder below the minimum frame", async () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 60, h: 16 });
    const handle = await createHeadlessRenderer({ w: 60, h: 16 });
    open = handle;
    handle.mount(<App deps={deps} />);
    await tick();
    await handle.render();
    expect(allText(handle.capture().rows)).toContain("terminal too small");
  });

  test("transitions Home -> Workspace when the Kernel reports an open trusted project", async () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    const handle = await createHeadlessRenderer({ w: 120, h: 36 });
    open = handle;
    handle.mount(<App deps={deps} />);
    await tick();
    await handle.render();
    expect(allText(handle.capture().rows)).toContain("termcraft");

    kernel.emit(workspaceSnapshot());
    await tick();
    await handle.render();
    const text = allText(handle.capture().rows);
    expect(text).toContain("chat");
    expect(text).toContain("codex");
  });

  test("renders the ephemeral agent status block while a turn runs", async () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    const handle = await createHeadlessRenderer({ w: 120, h: 36 });
    open = handle;
    handle.mount(<App deps={deps} />);
    await tick();
    await handle.render();

    kernel.emit(workspaceSnapshot());
    await tick();
    await handle.render();

    const turnId = uuidv7();
    kernel.emit(event("turn.started", { turnId, chatId: uuidv7(), deadline: TEST_TS }));
    kernel.emit(
      event("turn.progress", {
        turnId,
        attempt: 1,
        content: { kind: "tool", op: "edit", target: "main/page.tsx" },
      }),
    );
    await tick();
    await handle.render();
    const text = allText(handle.capture().rows);
    expect(text).toContain("generating design");
    expect(text).toContain("main/page.tsx");
  });

  test("renders slash menu non-modally above the workspace composer", async () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    const handle = await createHeadlessRenderer({ w: 120, h: 36 });
    open = handle;
    handle.mount(<App deps={deps} />);
    await tick();
    kernel.emit(workspaceSnapshot());
    deps.local.composer.set("/");
    deps.local.overlay.set("slash-menu");
    await tick();
    await handle.render();
    const rows = handle.capture().rows;
    const text = allText(rows);
    expect(text).toContain("commands");
    expect(text).toContain("/new");
    const commandRow = rows.findIndex((row) => row.some((run) => run.text.includes("/new")));
    const composerRow = rows.findIndex((row) =>
      row
        .map((run) => run.text)
        .join("")
        .includes("❯ /"),
    );
    expect(commandRow).toBeGreaterThanOrEqual(0);
    expect(commandRow).toBeLessThan(composerRow);
  });

  test("centers the chat-list popup in an absolute modal layer", async () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    const chatId = uuidv7();
    const handle = await createHeadlessRenderer({ w: 120, h: 36 });
    open = handle;
    handle.mount(<App deps={deps} />);
    await tick();
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
    await tick();
    await handle.render();
    const rows = handle.capture().rows;
    const titleRow = rows.findIndex((row) => row.some((run) => run.text.includes("chats")));
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
    const handle = await createHeadlessRenderer({ w: 120, h: 36 });
    open = handle;
    handle.mount(<App deps={deps} />);
    await tick();
    await handle.render();
    const text = allText(handle.capture().rows);
    expect(text).toContain("READ-ONLY");
    expect(text).toContain("Send · Tweaks · pins disabled");
    expect(text).toContain("read-only — Send disabled");
  });
});
