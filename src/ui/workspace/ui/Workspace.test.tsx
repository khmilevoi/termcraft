import { afterEach, describe, expect, test } from "bun:test";

import type { PageDescriptorV1, PinDtoV1 } from "core/protocol";
import type { StyledRun } from "host/protocol";
import { extractRgb } from "host/render/model/color";
import { createHeadlessRenderer } from "host/render/model/renderer";
import type { RenderHandle } from "host/render/types";
import { uuidv7 } from "infrastructure/uuid";
import { createUiDeps } from "ui/app";
import { TEST_SHA, createFakeKernel, event, snapshot } from "ui/testing";
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
