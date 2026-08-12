import { afterEach, describe, expect, test } from "bun:test";

import type { StyledRun } from "host/protocol";
import { extractRgb } from "host/render/model/color";
import { createHeadlessRenderer } from "host/render/model/renderer";
import type { RenderHandle } from "host/render/types";
import { SHELL_PALETTE } from "ui/theme";

import type { DesignSystemPickerProps, DesignSystemRow } from "../model/design-system-picker";
import { SWATCH_GLYPH } from "../model/design-system-picker";
import { DesignSystemPicker } from "./DesignSystemPicker";

let open: RenderHandle | null = null;
afterEach(() => {
  open?.destroy();
  open = null;
});

const findRun = (frame: { rows: StyledRun[][] }, needle: string): StyledRun | undefined =>
  frame.rows.flat().find((run) => run.text.includes(needle));

const MIDNIGHT_ROW: DesignSystemRow = {
  key: "local:midnight",
  sourceId: "local",
  sourceLabel: "Local library",
  systemId: "midnight",
  name: "midnight",
  version: "1.2.0",
  state: "installable",
  swatches: [
    { name: "background", value: "#0b0f14" },
    { name: "accent", value: "#4cc9f0" },
    { name: "brandPurple", value: "#7b2cbf" },
  ],
  contents: ["Button", "PageShell", "Card"],
  note: null,
};

const AURORA_ROW: DesignSystemRow = {
  key: "local:aurora",
  sourceId: "local",
  sourceLabel: "Local library",
  systemId: "aurora",
  name: "aurora",
  version: "1.0.0",
  state: "installable",
  // No swatches of its own — the swatch-order render test asserts exactly MIDNIGHT_ROW's three
  // colors, and both rows are visible together (the list fits inside the viewport cap).
  swatches: [],
  contents: ["Card"],
  note: null,
};

const UNAVAILABLE_ROW: DesignSystemRow = {
  key: "github:acme/ds:unavailable",
  sourceId: "github:acme/ds",
  sourceLabel: "acme",
  systemId: null,
  name: "acme",
  version: "",
  state: "unavailable",
  swatches: [],
  contents: [],
  note: "did not answer within 3000 ms",
};

const UNGRANTED_ROW: DesignSystemRow = {
  key: "github:acme/ds:ungranted",
  sourceId: "github:acme/ds",
  sourceLabel: "acme",
  systemId: null,
  name: "acme",
  version: "",
  state: "ungranted",
  swatches: [],
  contents: [],
  note: "this source has not been granted",
};

const baseProps: DesignSystemPickerProps = {
  id: "ds-picker",
  rows: [MIDNIGHT_ROW, AURORA_ROW],
  selectedIndex: 0,
  canPublishSelected: true,
  updateNote: null,
  busy: false,
};

describe("DesignSystemPicker component (design gap, D8 — filled from 06-agent-model-picker.dc.html)", () => {
  test("the modal title is drawn in amberHi", async () => {
    const handle = await createHeadlessRenderer({ w: 96, h: 28 });
    open = handle;
    handle.mount(<DesignSystemPicker {...baseProps} />);
    await handle.render();
    const title = findRun(handle.capture(), "design systems");
    expect(title && extractRgb(title.fg)).toBe(SHELL_PALETTE.amberHi);
  });

  test("the selected row is painted with the selection band", async () => {
    const handle = await createHeadlessRenderer({ w: 96, h: 28 });
    open = handle;
    handle.mount(<DesignSystemPicker {...baseProps} selectedIndex={1} />);
    await handle.render();
    const selected = findRun(handle.capture(), "aurora");
    expect(selected && extractRgb(selected.bg)).toBe(SHELL_PALETTE.sel);
    expect(selected && extractRgb(selected.fg)).toBe(SHELL_PALETTE.selFg);
  });

  test("each swatch cell carries its token's own hex, in declaration order", async () => {
    const handle = await createHeadlessRenderer({ w: 96, h: 28 });
    open = handle;
    handle.mount(<DesignSystemPicker {...baseProps} />);
    await handle.render();
    const swatchRuns = handle
      .capture()
      .rows.flat()
      .filter((run) => run.text.includes(SWATCH_GLYPH));
    expect(swatchRuns.map((run) => extractRgb(run.fg))).toEqual(["#0b0f14", "#4cc9f0", "#7b2cbf"]);
  });

  test("system contents are rendered beside the colours", async () => {
    const handle = await createHeadlessRenderer({ w: 96, h: 28 });
    open = handle;
    handle.mount(<DesignSystemPicker {...baseProps} />);
    await handle.render();
    expect(findRun(handle.capture(), "Button · PageShell")).toBeDefined();
  });

  test("canPublish false draws NO publish hint", async () => {
    const handle = await createHeadlessRenderer({ w: 96, h: 28 });
    open = handle;
    handle.mount(<DesignSystemPicker {...baseProps} canPublishSelected={false} />);
    await handle.render();
    expect(findRun(handle.capture(), "publish")).toBeUndefined();
  });

  test("canPublish true draws the publish hint", async () => {
    const handle = await createHeadlessRenderer({ w: 96, h: 28 });
    open = handle;
    handle.mount(<DesignSystemPicker {...baseProps} canPublishSelected={true} />);
    await handle.render();
    const hint = findRun(handle.capture(), "publish");
    expect(hint).toBeDefined();
  });

  test("an unavailable source shows its reason in amberHi, and offers no install", async () => {
    const handle = await createHeadlessRenderer({ w: 96, h: 28 });
    open = handle;
    handle.mount(<DesignSystemPicker {...baseProps} rows={[UNAVAILABLE_ROW]} selectedIndex={0} />);
    await handle.render();
    const note = findRun(handle.capture(), "did not answer");
    expect(note && extractRgb(note.fg)).toBe(SHELL_PALETTE.amberHi);
    expect(findRun(handle.capture(), "⏎ install")).toBeUndefined();
  });

  test("an ungranted source offers `⏎ add source`, not `⏎ install`", async () => {
    const handle = await createHeadlessRenderer({ w: 96, h: 28 });
    open = handle;
    handle.mount(<DesignSystemPicker {...baseProps} rows={[UNGRANTED_ROW]} selectedIndex={0} />);
    await handle.render();
    expect(findRun(handle.capture(), "add source")).toBeDefined();
    expect(findRun(handle.capture(), "⏎ install")).toBeUndefined();
  });

  test("the footer carries the agent-picker hint vocabulary", async () => {
    const handle = await createHeadlessRenderer({ w: 96, h: 28 });
    open = handle;
    handle.mount(<DesignSystemPicker {...baseProps} />);
    await handle.render();
    const frame = handle.capture();
    expect(findRun(frame, "↑↓")).toBeDefined();
    expect(findRun(frame, "esc")).toBeDefined();
  });

  test("an available update is announced above the list", async () => {
    const handle = await createHeadlessRenderer({ w: 96, h: 28 });
    open = handle;
    handle.mount(
      <DesignSystemPicker {...baseProps} updateNote="local:midnight@1.3.0 is available" />,
    );
    await handle.render();
    expect(findRun(handle.capture(), "1.3.0 is available")).toBeDefined();
  });

  test("busy shows the checking state — D7's paint-before-the-freeze", async () => {
    const handle = await createHeadlessRenderer({ w: 96, h: 28 });
    open = handle;
    handle.mount(<DesignSystemPicker {...baseProps} busy={true} />);
    await handle.render();
    expect(findRun(handle.capture(), "checking")).toBeDefined();
  });

  test("every row gets a distinct, stable id", async () => {
    const handle = await createHeadlessRenderer({ w: 96, h: 28 });
    open = handle;
    handle.mount(<DesignSystemPicker {...baseProps} />);
    await handle.render();
    expect(handle.rectOf("ds-picker-row-local:midnight")).not.toEqual(
      handle.rectOf("ds-picker-row-local:aurora"),
    );
  });
});
