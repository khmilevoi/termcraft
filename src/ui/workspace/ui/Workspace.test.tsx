import { afterEach, describe, expect, test } from "bun:test";

import type { PageDescriptorV1, PinDtoV1 } from "core/protocol";
import type { StyledRun } from "host/protocol";
import { extractRgb } from "host/render/model/color";
import { createHeadlessRenderer } from "host/render/model/renderer";
import type { RenderHandle } from "host/render/types";
import { uuidv7 } from "infrastructure/uuid";
import { createUiDeps } from "ui/app";
import { TEST_SHA, TEST_TS, createFakeKernel, event, snapshot } from "ui/testing";
import { SHELL_PALETTE } from "ui/theme";

import { Workspace } from "./Workspace";

let open: RenderHandle | null = null;
afterEach(() => {
  open?.destroy();
  open = null;
});

const allText = (rows: StyledRun[][]) =>
  rows
    .flat()
    .map((run) => run.text)
    .join("");
const findRun = (rows: StyledRun[][], needle: string) =>
  rows.flat().find((run) => run.text.includes(needle));

describe("Workspace read-only presentation", () => {
  test("disables composer affordances and uses only approved read-only vocabulary/colors", async () => {
    const deps = createUiDeps(createFakeKernel(), { w: 120, h: 36 });
    deps.mirror.apply(
      snapshot({
        projectId: uuidv7(),
        activePageSlug: null,
        activeChatId: uuidv7(),
        trust: "untrusted-read-only",
      }),
    );
    const handle = await createHeadlessRenderer({ w: 120, h: 36 });
    open = handle;
    handle.mount(<Workspace deps={deps} readOnly />);
    await handle.render();
    const rows = handle.capture().rows;
    const text = allText(rows);
    expect(text).toContain("READ-ONLY");
    expect(text).toContain("Send · Tweaks · pins disabled");
    expect(text).toContain("read-only — Send disabled");
    expect(text).not.toContain("█");
    const attach = findRun(rows, "read-only — Send disabled");
    expect(attach && extractRgb(attach.fg)).toBe(SHELL_PALETTE.red);
  });
});

describe("Workspace tab-strip overflow indicators (design 18-tab-management.dc.html, drawTabs o.scroll)", () => {
  const ready = (slug: string, title: string): PageDescriptorV1 => ({
    status: "ready",
    pageSlug: slug,
    sourceHash: TEST_SHA,
    title,
    minSize: { w: 80, h: 24 },
    theme: "dark-default",
    kitApiVersion: 1,
  });

  test("paints ‹ › in amber-bold when the tab strip overflows the available width", async () => {
    const deps = createUiDeps(createFakeKernel(), { w: 40, h: 10 });
    deps.mirror.apply(
      snapshot({
        projectId: uuidv7(),
        activePageSlug: "a",
        activeChatId: uuidv7(),
        trust: "trusted",
        pageDescriptors: [
          ready("a", "Alpha"),
          ready("b", "Bravo"),
          ready("c", "Charlie"),
          ready("d", "Delta"),
        ],
      }),
    );
    const handle = await createHeadlessRenderer({ w: 40, h: 10 });
    open = handle;
    handle.mount(<Workspace deps={deps} readOnly={false} />);
    await handle.render();
    const rows = handle.capture().rows;
    const left = findRun(rows, "‹");
    const right = findRun(rows, "›");
    expect(left).toBeDefined();
    expect(right).toBeDefined();
    expect(left && extractRgb(left.fg)).toBe(SHELL_PALETTE.amber);
    expect(right && extractRgb(right.fg)).toBe(SHELL_PALETTE.amber);
    expect((left?.attrs ?? 0) & 1).toBe(1);
    expect((right?.attrs ?? 0) & 1).toBe(1);
  });

  test("omits the scroll indicators when the tab strip fits", async () => {
    const deps = createUiDeps(createFakeKernel(), { w: 120, h: 36 });
    deps.mirror.apply(
      snapshot({
        projectId: uuidv7(),
        activePageSlug: "a",
        activeChatId: uuidv7(),
        trust: "trusted",
        pageDescriptors: [ready("a", "Alpha"), ready("b", "Bravo")],
      }),
    );
    const handle = await createHeadlessRenderer({ w: 120, h: 36 });
    open = handle;
    handle.mount(<Workspace deps={deps} readOnly={false} />);
    await handle.render();
    const text = allText(handle.capture().rows);
    expect(text).not.toContain("‹");
    expect(text).not.toContain("›");
  });
});

describe("Workspace fullscreen preview sizing (F2, design paneShell noChat:true)", () => {
  const ready = (slug: string, title: string): PageDescriptorV1 => ({
    status: "ready",
    pageSlug: slug,
    sourceHash: TEST_SHA,
    title,
    minSize: { w: 80, h: 24 },
    theme: "dark-default",
    kitApiVersion: 1,
  });

  test("the tab strip is sized to the FULL terminal width in fullscreen, not width minus the (unrendered) chat column", async () => {
    const deps = createUiDeps(createFakeKernel(), { w: 60, h: 20 });
    deps.mirror.apply(
      snapshot({
        projectId: uuidv7(),
        activePageSlug: "a",
        activeChatId: uuidv7(),
        trust: "trusted",
        pageDescriptors: [
          ready("a", "AlphaPage"),
          ready("b", "BravoPage"),
          ready("c", "CharliePage"),
        ],
      }),
    );
    deps.local.fullscreen.set(true);
    const handle = await createHeadlessRenderer({ w: 60, h: 20 });
    open = handle;
    handle.mount(<Workspace deps={deps} readOnly={false} />);
    await handle.render();
    const text = allText(handle.capture().rows);
    // paneShell's `noChat:true` branch (design engine.js:392-401) gives the preview pane the
    // FULL width `w` once the chat column is gone — at w=60 all three tabs fit with no overflow;
    // the pre-fix `w - chatW` (38) would overflow this same tab set and paint a spurious ‹ / ›.
    expect(text).not.toContain("‹");
    expect(text).not.toContain("›");
    expect(text).toContain("AlphaPage");
    expect(text).toContain("CharliePage");
  });
});

describe("Workspace pin list (design 08-pin-comments.dc.html, M12)", () => {
  const pin = (overrides: Partial<PinDtoV1>): PinDtoV1 => ({
    pinId: uuidv7(),
    pageSlug: "main",
    elementId: "gauge-cpu",
    fx: 0.5,
    fy: 0.5,
    text: "make this gauge red",
    status: "open",
    createdRecordId: uuidv7(),
    latestRecordId: uuidv7(),
    updatedAt: "2026-07-22T00:00:00.000Z",
    ...overrides,
  });

  test("lists the active page's pins in the chat panel, above the composer", async () => {
    const deps = createUiDeps(createFakeKernel(), { w: 120, h: 36 });
    deps.mirror.apply(
      snapshot({
        projectId: uuidv7(),
        activePageSlug: "main",
        activeChatId: uuidv7(),
        trust: "trusted",
      }),
    );
    deps.mirror.apply(
      event("pins.changed", {
        pageSlug: "main",
        affectedPins: [
          pin({ text: "table · why always top?" }),
          pin({ status: "resolved", text: "network · add labels · reopen" }),
        ],
        affectedRecordIds: [],
        causeId: uuidv7(),
      }),
    );
    const handle = await createHeadlessRenderer({ w: 120, h: 36 });
    open = handle;
    handle.mount(<Workspace deps={deps} readOnly={false} />);
    await handle.render();
    const text = allText(handle.capture().rows);
    expect(text).toContain("PINS · main");
    expect(text).toContain("table · why always top?");
    expect(text).toContain("network · add labels · reopen");
  });

  test("numbers the open pin's badge among open pins only, matching PreviewOverlays' numbering", async () => {
    const deps = createUiDeps(createFakeKernel(), { w: 120, h: 36 });
    deps.mirror.apply(
      snapshot({
        projectId: uuidv7(),
        activePageSlug: "main",
        activeChatId: uuidv7(),
        trust: "trusted",
      }),
    );
    deps.mirror.apply(
      event("pins.changed", {
        pageSlug: "main",
        // A resolved pin precedes the (only) open pin in the mirror's array order.
        affectedPins: [
          pin({ status: "resolved", text: "resolved first" }),
          pin({ text: "open second" }),
        ],
        affectedRecordIds: [],
        causeId: uuidv7(),
      }),
    );
    const handle = await createHeadlessRenderer({ w: 120, h: 36 });
    open = handle;
    handle.mount(<Workspace deps={deps} readOnly={false} />);
    await handle.render();
    const rows = handle.capture().rows;
    // The open pin is the FIRST (and only) open pin, so its badge must read "1" — never "2",
    // which numbering by position in the full (open+resolved) array would produce, and which
    // PreviewOverlays (numbering among open pins only) would never draw for this scenario.
    const badge = rows
      .flat()
      .find((run) => run.text === "1" && extractRgb(run.bg) === SHELL_PALETTE.amber);
    expect(badge).toBeDefined();
  });
});

describe("Workspace composer attach chip (design 07-selection-hover.dc.html / 08-pin-comments.dc.html, M13)", () => {
  test("a live selection renders the ▣ chip line in the composer, at selFg", async () => {
    const deps = createUiDeps(createFakeKernel(), { w: 120, h: 36 });
    deps.mirror.apply(
      snapshot({
        projectId: uuidv7(),
        activePageSlug: "main",
        activeChatId: uuidv7(),
        trust: "trusted",
      }),
    );
    deps.mirror.apply(
      event("selection.changed", {
        pageSlug: "main",
        elementId: "gauge-cpu",
        sourceHash: TEST_SHA,
      }),
    );
    const handle = await createHeadlessRenderer({ w: 120, h: 36 });
    open = handle;
    handle.mount(<Workspace deps={deps} readOnly={false} />);
    await handle.render();
    const rows = handle.capture().rows;
    const chip = findRun(rows, "▣ gauge-cpu");
    expect(chip).toBeDefined();
    expect(chip && extractRgb(chip.fg)).toBe(SHELL_PALETTE.selFg);
  });

  test("a selection on ANOTHER page does not render its chip in this page's composer", async () => {
    const deps = createUiDeps(createFakeKernel(), { w: 120, h: 36 });
    deps.mirror.apply(
      snapshot({
        projectId: uuidv7(),
        activePageSlug: "main",
        activeChatId: uuidv7(),
        trust: "trusted",
      }),
    );
    // The mirror only clears `selection` on a fresh kernel.snapshot, not on a page switch — a
    // selection made while page "other" was active must not chip the composer for page "main".
    deps.mirror.apply(
      event("selection.changed", {
        pageSlug: "other",
        elementId: "gauge-cpu",
        sourceHash: TEST_SHA,
      }),
    );
    const handle = await createHeadlessRenderer({ w: 120, h: 36 });
    open = handle;
    handle.mount(<Workspace deps={deps} readOnly={false} />);
    await handle.render();
    const text = allText(handle.capture().rows);
    expect(text).not.toContain("▣");
  });

  test("open pins with no selection render the 'N open pins attached' line at amberHi", async () => {
    const deps = createUiDeps(createFakeKernel(), { w: 120, h: 36 });
    deps.mirror.apply(
      snapshot({
        projectId: uuidv7(),
        activePageSlug: "main",
        activeChatId: uuidv7(),
        trust: "trusted",
      }),
    );
    const pin = (overrides: Partial<PinDtoV1>): PinDtoV1 => ({
      pinId: uuidv7(),
      pageSlug: "main",
      elementId: "gauge-cpu",
      fx: 0.5,
      fy: 0.5,
      text: "make this gauge red",
      status: "open",
      createdRecordId: uuidv7(),
      latestRecordId: uuidv7(),
      updatedAt: "2026-07-22T00:00:00.000Z",
      ...overrides,
    });
    deps.mirror.apply(
      event("pins.changed", {
        pageSlug: "main",
        affectedPins: [pin({}), pin({})],
        affectedRecordIds: [],
        causeId: uuidv7(),
      }),
    );
    const handle = await createHeadlessRenderer({ w: 120, h: 36 });
    open = handle;
    handle.mount(<Workspace deps={deps} readOnly={false} />);
    await handle.render();
    const rows = handle.capture().rows;
    const attach = findRun(rows, "2 open pins attached · sent next");
    expect(attach).toBeDefined();
    expect(attach && extractRgb(attach.fg)).toBe(SHELL_PALETTE.amberHi);
  });
});

// finding §2.5 (phase-8 Task 16): the composer stays live for the whole turn — design draws two
// distinct states (`wsGenTyping`/`wsSlashTurn`, `design/03-workspace-generating.dc.html`), keyed
// on whether the composer holds a draft.
describe("Workspace composer during a running turn (finding §2.5)", () => {
  test("an empty composer stays visually disabled — faint placeholder, no cursor", async () => {
    const deps = createUiDeps(createFakeKernel(), { w: 120, h: 36 });
    deps.mirror.apply(
      snapshot({
        projectId: uuidv7(),
        activePageSlug: "main",
        activeChatId: uuidv7(),
        trust: "trusted",
      }),
    );
    deps.mirror.apply(
      event("turn.started", { turnId: uuidv7(), chatId: uuidv7(), deadline: TEST_TS }),
    );
    const handle = await createHeadlessRenderer({ w: 120, h: 36 });
    open = handle;
    handle.mount(<Workspace deps={deps} readOnly={false} />);
    await handle.render();
    const rows = handle.capture().rows;
    const text = allText(rows);
    expect(text).toContain("generating… esc to cancel");
    expect(text).not.toContain("█");
    expect(text).toContain("⚠ turn running — send disabled");
  });

  test("a non-empty draft renders live — amber caret, blinking cursor, the draft text itself, and the design's draft-kept line", async () => {
    const deps = createUiDeps(createFakeKernel(), { w: 120, h: 36 });
    deps.mirror.apply(
      snapshot({
        projectId: uuidv7(),
        activePageSlug: "main",
        activeChatId: uuidv7(),
        trust: "trusted",
      }),
    );
    deps.mirror.apply(
      event("turn.started", { turnId: uuidv7(), chatId: uuidv7(), deadline: TEST_TS }),
    );
    deps.local.composer.set("and label the peaks");
    const handle = await createHeadlessRenderer({ w: 120, h: 36 });
    open = handle;
    handle.mount(<Workspace deps={deps} readOnly={false} />);
    await handle.render();
    const rows = handle.capture().rows;
    const text = allText(rows);
    expect(text).toContain("and label the peaks");
    expect(text).toContain("█");
    expect(text).toContain("⏎ send disabled — draft kept");
    // Exact-text match, not substring: the chat panel's own focused title also starts with
    // "❯ chat..." (`SHELL_PALETTE.amberHi`), which `findRun`'s `.includes` would match FIRST —
    // the composer caret's own text node content is exactly "❯ ", nothing longer.
    const caret = rows.flat().find((run) => run.text === "❯ ");
    expect(caret && extractRgb(caret.fg)).toBe(SHELL_PALETTE.amber);
  });

  test("the status bar shows a faint dis'd ⏎ send and a live esc cancel, no F2, while a turn runs", async () => {
    const deps = createUiDeps(createFakeKernel(), { w: 120, h: 36 });
    deps.mirror.apply(
      snapshot({
        projectId: uuidv7(),
        activePageSlug: "main",
        activeChatId: uuidv7(),
        trust: "trusted",
      }),
    );
    deps.mirror.apply(
      event("turn.started", { turnId: uuidv7(), chatId: uuidv7(), deadline: TEST_TS }),
    );
    const handle = await createHeadlessRenderer({ w: 120, h: 36 });
    open = handle;
    handle.mount(<Workspace deps={deps} readOnly={false} />);
    await handle.render();
    const rows = handle.capture().rows;
    const text = allText(rows);
    expect(text).toContain("send");
    expect(text).toContain("cancel");
    expect(text).not.toContain("fullscreen");
    // The renderer merges adjacent same-style runs — the disabled `⏎`/`send` glyph+label share
    // one faint style and collapse into a single " ⏎  send " run, so match by substring here;
    // the LIVE `esc`/`cancel` pair does NOT merge (different styles per run), so an exact match
    // on the glyph's own " esc " text node is unambiguous (the empty composer's own placeholder
    // also contains the substring "esc" — "generating… esc to cancel" — which `findRun`'s
    // `.includes` would otherwise match first).
    const sendGlyph = rows.flat().find((run) => run.text.includes("⏎"));
    expect(sendGlyph && extractRgb(sendGlyph.fg)).toBe(SHELL_PALETTE.faint);
    const cancelGlyph = rows.flat().find((run) => run.text === " esc ");
    expect(cancelGlyph && extractRgb(cancelGlyph.fg)).toBe(SHELL_PALETTE.amber);
  });
});

describe("Workspace action-derived hotkey hints", () => {
  test("keeps F2 active while F3, F4, and Ctrl+P remain visible but faint", async () => {
    const deps = createUiDeps(createFakeKernel(), { w: 120, h: 36 });
    const handle = await createHeadlessRenderer({ w: 120, h: 36 });
    open = handle;
    handle.mount(<Workspace deps={deps} readOnly={false} />);
    await handle.render();
    const rows = handle.capture().rows;
    const text = allText(rows);
    for (const label of ["F2", "F3", "F4", "Ctrl+P"]) expect(text).toContain(label);

    const active = findRun(rows, "F2");
    expect(active && extractRgb(active.fg)).toBe(SHELL_PALETTE.amber);
    expect((active?.attrs ?? 0) & 1).toBe(1);
    for (const label of ["F3", "F4", "Ctrl+P"]) {
      const inert = findRun(rows, label);
      expect(inert && extractRgb(inert.fg)).toBe(SHELL_PALETTE.faint);
      expect((inert?.attrs ?? 0) & 1).toBe(0);
    }
  });
});

describe("Workspace chat scrollback (design §3.2 — persisted records above the ephemeral block, WP-10 Task 8)", () => {
  test("a chat.records tail renders as ChatRecords above the running turn's ephemeral status block", async () => {
    const deps = createUiDeps(createFakeKernel(), { w: 120, h: 36 });
    const chatId = uuidv7();
    // Events are applied before mount (matching this file's existing pattern throughout) —
    // no post-mount Reatom write here, so no `act()` wrap is needed.
    deps.mirror.apply(
      snapshot({
        projectId: uuidv7(),
        activePageSlug: "main",
        activeChatId: chatId,
        trust: "trusted",
        agentIdentity: { backendId: "claude", modelLabel: "sonnet-4.5" },
      }),
    );
    deps.mirror.apply(
      event("chat.records", {
        chatId,
        records: [
          {
            kind: "user",
            recordId: uuidv7(),
            turnId: uuidv7(),
            text: "build a system monitor",
            selection: null,
            pins: [],
            ts: TEST_TS,
          },
          {
            kind: "agent",
            recordId: uuidv7(),
            turnId: uuidv7(),
            text: "created **page main**",
            changedPages: ["main"],
            warnings: [],
            ts: TEST_TS,
          },
        ],
        prevCursor: null,
      }),
    );
    deps.mirror.apply(event("turn.started", { turnId: uuidv7(), chatId, deadline: TEST_TS }));
    const handle = await createHeadlessRenderer({ w: 120, h: 36 });
    open = handle;
    handle.mount(<Workspace deps={deps} readOnly={false} />);
    await handle.render();
    const rows = handle.capture().rows;
    const findRow = (needle: string) =>
      rows.findIndex((row) => row.some((run) => run.text.includes(needle)));

    const youRow = findRow("❯ you");
    const boldRow = findRow("page main");
    const generatingRow = findRow("generating design");
    expect(youRow).toBeGreaterThanOrEqual(0);
    expect(boldRow).toBeGreaterThan(youRow);
    // The persisted scrollback sits ABOVE the ephemeral status block (design §3.2).
    expect(generatingRow).toBeGreaterThan(boldRow);

    const boldRun = rows[boldRow]?.find((run) => run.text.includes("page main"));
    expect((boldRun?.attrs ?? 0) & 1).toBe(1);
  });
});

describe("Workspace agent identity (M22 — data-driven, not the design's codex/gpt5.5 sample)", () => {
  test("renders the kernel-snapshot identity in the chat title, presence, chip, and terminal record", async () => {
    const deps = createUiDeps(createFakeKernel(), { w: 120, h: 36 });
    deps.mirror.apply(
      snapshot({
        projectId: uuidv7(),
        activePageSlug: "main",
        activeChatId: uuidv7(),
        trust: "trusted",
        agentIdentity: { backendId: "claude", modelLabel: "sonnet-4.5" },
      }),
    );
    deps.mirror.apply(
      event("turn.completed", {
        turnId: uuidv7(),
        outcome: "completed",
        changedPages: [{ pageSlug: "main", sourceHash: TEST_SHA }],
        warnings: [],
        failure: null,
      }),
    );
    const handle = await createHeadlessRenderer({ w: 120, h: 36 });
    open = handle;
    handle.mount(<Workspace deps={deps} readOnly={false} />);
    await handle.render();
    const text = allText(handle.capture().rows);
    expect(text).toContain("chat · claude");
    expect(text).toContain("● claude");
    expect(text).toContain("claude · sonnet-4.5");
    expect(text).not.toContain("codex");
    expect(text).not.toContain("gpt5");
  });

  test("a null identity (no backend selected yet) renders the neutral empty text, never an invented fallback", async () => {
    const deps = createUiDeps(createFakeKernel(), { w: 120, h: 36 });
    deps.mirror.apply(
      snapshot({
        projectId: uuidv7(),
        activePageSlug: "main",
        activeChatId: uuidv7(),
        trust: "trusted",
        agentIdentity: null,
      }),
    );
    const handle = await createHeadlessRenderer({ w: 120, h: 36 });
    open = handle;
    handle.mount(<Workspace deps={deps} readOnly={false} />);
    await handle.render();
    const text = allText(handle.capture().rows);
    expect(text).toContain("chat");
    expect(text).not.toContain("codex");
    expect(text).not.toContain("claude");
  });

  // TRIAGE #38: a null identity is the DEFAULT wiring today (buildAgentIdentity() always
  // returns null — core/kernel/model/kernel.ts), not a rare edge case, so the chat-panel title
  // and the presence line must not paint a dangling separator/bullet for it.
  test("a null identity paints no dangling ' · ' separator on the chat title, nor a bare '●' presence line (TRIAGE #38)", async () => {
    const deps = createUiDeps(createFakeKernel(), { w: 120, h: 36 });
    deps.mirror.apply(
      snapshot({
        projectId: uuidv7(),
        activePageSlug: "main",
        activeChatId: uuidv7(),
        trust: "trusted",
        agentIdentity: null,
      }),
    );
    const handle = await createHeadlessRenderer({ w: 120, h: 36 });
    open = handle;
    handle.mount(<Workspace deps={deps} readOnly={false} />);
    await handle.render();
    const text = allText(handle.capture().rows);
    expect(text).not.toContain("chat ·");
    expect(text).not.toContain("●");
  });
});
