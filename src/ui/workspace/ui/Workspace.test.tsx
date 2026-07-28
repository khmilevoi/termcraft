import { afterEach, describe, expect, test } from "bun:test";

import type { PageDescriptorV1, PinDtoV1 } from "core/protocol";
import type { StyledRun } from "host/protocol";
import { extractRgb } from "host/render/model/color";
import { createHeadlessRenderer } from "host/render/model/renderer";
import type { RenderHandle } from "host/render/types";
import { uuidv7 } from "infrastructure/uuid";
import { createUiDeps } from "ui/app";
import {
  TEST_SHA,
  TEST_TS,
  createFakeKernel,
  createFakePreviewSession,
  event,
  snapshot,
} from "ui/testing";
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

  test("marks the tab the user switched to, not the Kernel's own active page", async () => {
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
    deps.local.pageOverride.set("b");
    const handle = await createHeadlessRenderer({ w: 120, h: 36 });
    open = handle;
    handle.mount(<Workspace deps={deps} readOnly={false} />);
    await handle.render();
    const text = allText(handle.capture().rows);
    expect(text).toContain("▸ Bravo");
    expect(text).not.toContain("▸ Alpha");
  });

  test("every tab is a hit-testable element the mouse can land on", async () => {
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
    const rect = handle.rectOf("ws-tab-b");
    expect(rect).not.toBeNull();
    expect(rect && rect.width).toBeGreaterThan(0);
    expect(rect && handle.hitTest(rect.x, rect.y)).toBe("ws-tab-b");
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
describe("Workspace chat panel header during a running turn", () => {
  test("paints the agent presence line exactly ONCE — it used to appear twice on consecutive rows", async () => {
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
      event("turn.started", { turnId: uuidv7(), chatId: uuidv7(), deadline: TEST_TS }),
    );
    const handle = await createHeadlessRenderer({ w: 120, h: 36 });
    open = handle;
    handle.mount(<Workspace deps={deps} readOnly={false} />);
    await handle.render();

    // Design `chatSeq` (`design/termcraft-engine.js:568`) draws the presence line once at the
    // top of the chat panel; the generating block below it (`genTurn`, `:511-565`) never
    // repeats it. `AgentStatusBlock` used to draw its own copy on top of `ws-chat-agent`'s.
    const presenceRows = handle.capture().rows.filter((row) =>
      row
        .map((run) => run.text)
        .join("")
        .includes("● claude"),
    );
    expect(presenceRows).toHaveLength(1);
  });
});

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

  /**
   * DESIGN-FIDELITY GUARD (final-review Finding 3). `Workspace.tsx`'s hint row is a verbatim
   * transcription of the design's own key rows, and §3.8 names NO page key at all — so the
   * page-step entries, bound but marked `hint: false`, must never reach it.
   *
   * The `toContain` assertions above cannot see a key that was ADDED: deleting the three-line
   * `action.hint === false` filter puts `Ctrl+B prev page` and `Ctrl+N next page` on every
   * workspace screen with the whole suite still green. This asserts the EXACT row instead, so
   * the extra pair is a failure rather than an unnoticed divergence from `design/*.dc.html`.
   */
  test("draws exactly the design's idle key row — no bound-but-undrawn page-step keys", async () => {
    const deps = createUiDeps(createFakeKernel(), { w: 120, h: 36 });
    const handle = await createHeadlessRenderer({ w: 120, h: 36 });
    open = handle;
    handle.mount(<Workspace deps={deps} readOnly={false} />);
    await handle.render();
    const rows = handle.capture().rows;
    // The status bar is the frame's bottom row; its right-aligned cluster is the key row.
    const statusRow = (rows.at(-1) ?? []).map((run) => run.text).join("");
    // `^E export` never appears — `StatusBar`'s own `HIDDEN_HINT_GLYPHS` drops it (design
    // `hintKeys`, `termcraft-engine.js:413-416`), which is why the row is these four and only
    // these four: F2 fullscreen · F3 tweaks · F4 interact · Ctrl+P preview.
    expect(
      statusRow.trimEnd().endsWith(" F2  fullscreen  F3  tweaks  F4  interact  Ctrl+P  preview"),
    ).toBe(true);
    for (const absent of ["Ctrl+B", "Ctrl+N", "prev page", "next page"]) {
      expect(allText(rows)).not.toContain(absent);
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

  test("a chat far taller than the panel never overdraws the composer or the panel border", async () => {
    // The reported defect: a long agent reply grew `ws-chat-stream` past `ws-chat`, painting
    // over the composer's own placeholder row and the panel's bottom border.
    const deps = createUiDeps(createFakeKernel(), { w: 120, h: 36 });
    const chatId = uuidv7();
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
        records: Array.from({ length: 40 }, (_unused, index) => ({
          kind: "agent" as const,
          recordId: uuidv7(),
          turnId: uuidv7(),
          text: `reply ${index} — ${"словомного ".repeat(20)}`,
          changedPages: [],
          warnings: [],
          ts: TEST_TS,
        })),
        prevCursor: null,
      }),
    );
    const handle = await createHeadlessRenderer({ w: 120, h: 36 });
    open = handle;
    handle.mount(<Workspace deps={deps} readOnly={false} />);
    await handle.render();
    const rows = handle.capture().rows.map((row) => row.map((run) => run.text).join(""));

    // The composer's own placeholder still owns its row — nothing painted over it. The needle
    // drops the placeholder's first character on purpose: the design paints the block caret
    // over that column (`design/termcraft-engine.js`'s `put(b,chatX+3,composerTop+2,'█')`), so
    // the row reads `❯ █sk for changes…`.
    const composerRow = rows.findIndex((row) => row.includes("sk for changes…"));
    expect(composerRow).toBeGreaterThanOrEqual(0);

    // Every chat body row sits ABOVE the composer; none leaked past it into the border.
    const lastBodyRow = rows.findLastIndex((row) => row.includes("словомного"));
    expect(lastBodyRow).toBeLessThan(composerRow);

    // And the history that did not fit is summarised the way the design does it, rather than
    // silently vanishing.
    expect(rows.some((row) => row.includes("earlier messages"))).toBe(true);
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

// Defect 1 (Important): design/termcraft-engine.js:966 (`slashMenu(){ const rows=…;
// if(!rows.length) return 0; …}`) and :155 (`if(rows.length) this.slashBox(...)`) both refuse to
// draw the widget when there is nothing to show it. `SlashMenu` itself has no such guard — it
// always opens its bordered, titled box — so the caller must supply one, matching the precedent
// already set by `Home.tsx`'s own `props.rows.length > 0 &&` guard for the identical component.
describe("Workspace slash menu (design termcraft-engine.js:966, :155 — do not draw on an empty row set)", () => {
  test("typing a slash prefix that matches no command renders no slash-menu box at all", async () => {
    const deps = createUiDeps(createFakeKernel(), { w: 120, h: 36 });
    deps.mirror.apply(
      snapshot({
        projectId: uuidv7(),
        activePageSlug: "main",
        activeChatId: uuidv7(),
        trust: "trusted",
      }),
    );
    deps.local.overlay.set("slash-menu");
    // No registered command starts with this prefix (`UI_ACTIONS` in `ui/actions/model/
    // registry.ts` — /new, /chats, /export, /model, /commit-page, /commit-infra, /commit-all,
    // /exit), so `filterSlashRows` returns zero rows — the "forward-typed past every match" case
    // from `intent.ts`'s `slash-input` handler, which appends every character with no re-check.
    deps.local.composer.set("/nomatch-xyz");
    const handle = await createHeadlessRenderer({ w: 120, h: 36 });
    open = handle;
    handle.mount(<Workspace deps={deps} readOnly={false} />);
    await handle.render();
    const rows = handle.capture().rows;
    // `SlashMenu` titles its box with the typed text itself (`props.typed`), bold amberHi
    // (`SlashMenu.tsx`'s `titleColor={SHELL_PALETTE.amberHi}`) — a run distinct from the
    // composer's own typed-text echo, which paints at plain `fg` (`Composer.tsx`'s
    // `valueFg={SHELL_PALETTE.fg}`). Its presence is exactly the empty bordered box this
    // defect draws; its absence proves the guard fired.
    const title = rows
      .flat()
      .find((run) => run.text === "/nomatch-xyz" && extractRgb(run.fg) === SHELL_PALETTE.amberHi);
    expect(title).toBeUndefined();
  });

  test("typing a slash prefix that DOES match a command still opens the menu", async () => {
    const deps = createUiDeps(createFakeKernel(), { w: 120, h: 36 });
    deps.mirror.apply(
      snapshot({
        projectId: uuidv7(),
        activePageSlug: "main",
        activeChatId: uuidv7(),
        trust: "trusted",
      }),
    );
    deps.local.overlay.set("slash-menu");
    deps.local.composer.set("/e");
    const handle = await createHeadlessRenderer({ w: 120, h: 36 });
    open = handle;
    handle.mount(<Workspace deps={deps} readOnly={false} />);
    await handle.render();
    const text = allText(handle.capture().rows);
    expect(text).toContain("/export");
    expect(text).toContain("/exit");
  });
});

// Defect 2 (Minor): `AgentStatusBlockProps.connection` is documented as "The connection meta
// line, e.g. `ratatui · connected`" (design `chatSeq`'s `headerMeta`, `design/termcraft-
// engine.js:568`) — a DIFFERENT fact than the chat-panel title's `'❯ chat · working'` literal
// (`design/termcraft-engine.js:262,283,991`), which Workspace already renders correctly on the
// panel title. Passing the bare word "working" into `connection` paints it in the wrong slot.
describe("Workspace live-turn connection line (design termcraft-engine.js:568 headerMeta vs. :991 chatTitle)", () => {
  test("does not paint the chat-title word 'working' into the AgentStatusBlock connection line", async () => {
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
      event("turn.started", { turnId: uuidv7(), chatId: uuidv7(), deadline: TEST_TS }),
    );
    const handle = await createHeadlessRenderer({ w: 120, h: 36 });
    open = handle;
    handle.mount(<Workspace deps={deps} readOnly={false} />);
    await handle.render();
    const rows = handle.capture().rows;
    // The chat panel's own title legitimately reads "❯ chat · working" (unaffected by this fix —
    // asserted separately below); the defect is a SECOND, bare "working" run painted at
    // `SHELL_PALETTE.faint` — the connection line's own colour (`AgentStatusBlock.tsx`'s
    // `fg={SHELL_PALETTE.faint}` on `${props.id}-connection`) — which is what this asserts is gone.
    const strayConnectionWord = rows
      .flat()
      .find((run) => run.text === "working" && extractRgb(run.fg) === SHELL_PALETTE.faint);
    expect(strayConnectionWord).toBeUndefined();
    const text = allText(rows);
    expect(text).toContain("❯ chat · working");
  });
});

describe("Workspace halted preview (design wsHostCrash)", () => {
  const CRASH = "PAGE_RENDER_FAILED: TypeError: ctx.spy is not a function";

  const circuitOpened = (opts?: { hostFailureCode?: string; retryAvailable?: boolean }) =>
    event("preview.circuitOpened", {
      previewSessionId: uuidv7(),
      pageSlug: "main",
      sourceHash: TEST_SHA,
      attempts: 4,
      finalFailure: {
        code: "HOST_CIRCUIT_OPEN",
        retryable: true,
        safeMessage: CRASH,
        details: {
          pageSlug: "main",
          attempts: 4,
          ...(opts?.hostFailureCode === undefined ? {} : { hostFailureCode: opts.hostFailureCode }),
        },
      },
      retryCapability:
        opts?.retryAvailable === false
          ? { available: false, reasons: [{ code: "CAPABILITY_UNAVAILABLE" }] }
          : { available: true },
    });

  async function renderWith(applyCircuit: ReturnType<typeof circuitOpened>) {
    const deps = createUiDeps(createFakeKernel(), { w: 120, h: 36 });
    deps.mirror.apply(
      snapshot({
        projectId: uuidv7(),
        activePageSlug: "main",
        activeChatId: uuidv7(),
        trust: "trusted",
      }),
    );
    deps.mirror.apply(applyCircuit);
    const handle = await createHeadlessRenderer({ w: 120, h: 36 });
    open = handle;
    handle.mount(<Workspace deps={deps} readOnly={false} />);
    await handle.render();
    return handle.capture().rows;
  }

  test("a page that threw renders the host-crash panel, not the Gate error panel", async () => {
    const rows = await renderWith(circuitOpened({ hostFailureCode: "DESIGN_RENDER_FAILED" }));
    expect(findRun(rows, "preview host · halted")).toBeDefined();
    expect(findRun(rows, "✗ design threw while rendering")).toBeDefined();
    expect(findRun(rows, "preview stopped after repeated failures")).toBeUndefined();
    expect(allText(rows)).not.toContain("preparing preview…");
  });

  test("a host that never ran the page gets wsHostUnavailable, which clears the page of blame", async () => {
    const rows = await renderWith(circuitOpened({ hostFailureCode: "SPAWN_FAILED" }));
    expect(findRun(rows, "✗ design threw while rendering")).toBeUndefined();
    expect(findRun(rows, "preview host · unavailable")).toBeDefined();
    expect(findRun(rows, "your design was never run")).toBeDefined();
    expect(findRun(rows, "the host process could not be started")).toBeDefined();
    // No repair is offered — no page edit could make a spawn succeed.
    expect(allText(rows)).not.toContain("F6");
  });

  test("the status bar wears the HALTED chip, the render-crashed hint and both keys", async () => {
    const rows = await renderWith(circuitOpened({ hostFailureCode: "DESIGN_RENDER_FAILED" }));
    const text = allText(rows);
    expect(text).toContain("HALTED");
    expect(text).not.toContain("STATIC");
    expect(findRun(rows, "render crashed")).toBeDefined();
    expect(text).toContain("F5");
    expect(text).toContain("F6");
  });

  test("a host-unavailable state wears NO HOST, its own hint, and offers no repair anywhere", async () => {
    const rows = await renderWith(circuitOpened({ hostFailureCode: "MOUNT_TIMEOUT" }));
    const text = allText(rows);
    expect(text).toContain("NO HOST");
    expect(text).not.toContain("HALTED");
    expect(findRun(rows, "host unavailable")).toBeDefined();
    expect(findRun(rows, "render crashed")).toBeUndefined();
    expect(text).toContain("F5");
    expect(text).not.toContain("F6");
    expect(findRun(rows, "F5 retries the host · agent can't fix it")).toBeDefined();
  });

  test("the composer offers the repair key, worded for whether retry survives", async () => {
    expect(
      findRun(
        await renderWith(circuitOpened({ hostFailureCode: "DESIGN_RENDER_FAILED" })),
        "F6 writes the fix · or type your own",
      ),
    ).toBeDefined();

    expect(
      findRun(
        await renderWith(
          circuitOpened({ hostFailureCode: "DESIGN_RENDER_FAILED", retryAvailable: false }),
        ),
        "F6 writes the fix — retry unavailable",
      ),
    ).toBeDefined();
  });
});

describe("Workspace halted-preview chat notice", () => {
  test("raises the design's two system lines in the chat panel, and drops them on recovery", async () => {
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
      event("preview.circuitOpened", {
        previewSessionId: uuidv7(),
        pageSlug: "main",
        sourceHash: TEST_SHA,
        attempts: 4,
        finalFailure: {
          code: "HOST_CIRCUIT_OPEN",
          retryable: true,
          safeMessage: "PAGE_RENDER_FAILED: TypeError: ctx.spy is not a function",
          details: { pageSlug: "main", attempts: 4, hostFailureCode: "DESIGN_RENDER_FAILED" },
        },
        retryCapability: { available: true },
      }),
    );
    const handle = await createHeadlessRenderer({ w: 120, h: 36 });
    open = handle;
    handle.mount(<Workspace deps={deps} readOnly={false} />);
    await handle.render();
    const rows = handle.capture().rows;

    const headline = findRun(rows, "preview crashed while rendering");
    expect(headline).toBeDefined();
    expect(headline && extractRgb(headline.fg)).toBe(SHELL_PALETTE.red);
    // Both lines wrap inside the chat panel, so match a fragment, not the whole sentence.
    const detail = findRun(rows, "the design passed Gate");
    expect(detail).toBeDefined();
    expect(detail && extractRgb(detail.fg)).toBe(SHELL_PALETTE.faint);
  });
});

describe("Workspace preview clipping", () => {
  const readyDescriptor = (slug: string, title: string): PageDescriptorV1 => ({
    status: "ready",
    pageSlug: slug,
    sourceHash: TEST_SHA,
    title,
    minSize: { w: 60, h: 26 },
    theme: "dark-default",
    kitApiVersion: 1,
  });

  /** One frame of solid `#` cells at the requested size — deliberately larger than the pane. */
  const solidFrame = (width: number, height: number) => ({
    sessionId: uuidv7(),
    sourceHash: TEST_SHA,
    frameSeq: "1",
    width,
    height,
    rows: Array.from({ length: height }, () => [
      { text: "#".repeat(width), fg: "default" as const, bg: "default" as const, attrs: 0 },
    ]),
  });

  // NOTE: at 120×34 the fake frame (80×24) overflows the pane's WIDTH (region.w = 74) but not
  // its height (region.h = 30 > 24) — so this test exercises only the width half of the clamp.
  // The vertical half is covered separately below, at a terminal where the frame overflows both.
  test("a frame wider than the pane never paints over the pane's own right border", async () => {
    const deps = createUiDeps(createFakeKernel(), { w: 120, h: 34 });
    deps.mirror.apply(
      snapshot({
        projectId: uuidv7(),
        activePageSlug: "dashboard",
        activeChatId: uuidv7(),
        trust: "trusted",
        pageDescriptors: [readyDescriptor("dashboard", "Дашборд")],
      }),
    );
    const fake = createFakePreviewSession();
    const frame = solidFrame(80, 24);
    deps.previewFrame.set({ frame, frameToken: uuidv7() as never, handle: fake.handle });

    const handle = await createHeadlessRenderer({ w: 120, h: 34 });
    open = handle;
    handle.mount(<Workspace deps={deps} readOnly={false} />);
    await handle.render();
    const rows = handle.capture().rows;
    const lines = rows.map((row) => row.map((run) => run.text).join(""));

    // The pane's right border column survives on every row of the preview region, and the
    // frame's own cells stop before it.
    const regionRows = lines.slice(2, 32);
    for (const line of regionRows) {
      expect(line.length).toBe(120);
      expect(line[119]).not.toBe("#");
    }
    // The pane's bottom border row is intact — a rounded corner, not frame content.
    expect(lines[32]).toContain("╯");
  });

  // The Background's other named scenario: "at 100×20 it also paints over both panels' bottom
  // borders." At 100×20, chatColumnWidth(100) = 37, so the pane is 63 wide and region = {w: 61,
  // h: 16} (previewRegionSize) — the 80×24 fake frame overflows BOTH axes here, unlike the
  // 120×34 test above, so this is the one that actually exercises `height={Math.min(...)}`.
  test("a frame taller than a smaller pane never paints over the pane's own bottom border", async () => {
    const deps = createUiDeps(createFakeKernel(), { w: 100, h: 20 });
    deps.mirror.apply(
      snapshot({
        projectId: uuidv7(),
        activePageSlug: "dashboard",
        activeChatId: uuidv7(),
        trust: "trusted",
        pageDescriptors: [readyDescriptor("dashboard", "Дашборд")],
      }),
    );
    const fake = createFakePreviewSession();
    const frame = solidFrame(80, 24);
    deps.previewFrame.set({ frame, frameToken: uuidv7() as never, handle: fake.handle });

    const handle = await createHeadlessRenderer({ w: 100, h: 20 });
    open = handle;
    handle.mount(<Workspace deps={deps} readOnly={false} />);
    await handle.render();
    const rows = handle.capture().rows;
    const lines = rows.map((row) => row.map((run) => run.text).join(""));

    // frameH = h - 1 = 19, so `ws-preview` occupies rows 0..18 and its own bottom border sits
    // at row 18 — a rounded corner, never the frame's `#` content, even though the frame (24
    // rows) is 8 rows taller than the region (16 rows) it is painted into.
    const bottomBorderRow = 18;
    expect(lines[bottomBorderRow].length).toBe(100);
    expect(lines[bottomBorderRow]).toContain("╯");
    expect(lines[bottomBorderRow]).not.toContain("#");
  });
});

describe("Workspace preview placeholder sizing", () => {
  test("the empty state leaves the preview pane's right border and bottom corner intact", async () => {
    const deps = createUiDeps(createFakeKernel(), { w: 120, h: 20 });
    deps.mirror.apply(
      snapshot({
        projectId: uuidv7(),
        activePageSlug: null,
        activeChatId: uuidv7(),
        trust: "trusted",
      }),
    );
    const handle = await createHeadlessRenderer({ w: 120, h: 20 });
    open = handle;
    handle.mount(<Workspace deps={deps} readOnly={false} />);
    await handle.render();
    const lines = handle.capture().rows.map((row) => row.map((run) => run.text).join(""));

    expect(lines.join("\n")).toContain("No pages yet — describe what to build");
    // Row 1..17 are inside the pane; each must still end in the pane's own border column.
    for (const line of lines.slice(1, 18)) expect(line[119]).toBe("│");
    // The pane's bottom-right rounded corner survives.
    expect(lines[18]?.[119]).toBe("╯");
  });
});
