import { afterEach, describe, expect, test } from "bun:test";

import type { StyledRun } from "host/protocol";
import { extractRgb } from "host/render/model/color";
import { createHeadlessRenderer } from "host/render/model/renderer";
import type { RenderHandle } from "host/render/types";
import { SHELL_PALETTE } from "ui/theme";

import { ExportFailurePopup, ExportPopup } from "./ExportPopup";

let open: RenderHandle | null = null;
afterEach(() => {
  open?.destroy();
  open = null;
});

const lineRuns = (frame: { rows: StyledRun[][] }, row: number): StyledRun[] =>
  frame.rows[row] ?? [];
const lineText = (frame: { rows: StyledRun[][] }, row: number) =>
  lineRuns(frame, row)
    .map((run) => run.text)
    .join("");
const findRun = (frame: { rows: StyledRun[][] }, needle: string): StyledRun | undefined =>
  frame.rows.flat().find((run) => run.text.includes(needle));

const PROJECT_NAME = "system-monitor";
const PATHS = [
  ".termcraft/export/design-prompt.md",
  ".termcraft/export/pages/*.tsx",
  ".termcraft/export/snapshots/  layout/",
];
const CAVEAT = "reads current page.tsx on disk · incl uncommitted";

describe("ExportPopup component (design wsExport, 13-export-feedback.dc.html)", () => {
  test('renders the "export ^E" titled box', async () => {
    const handle = await createHeadlessRenderer({ w: 62, h: 11 });
    open = handle;
    handle.mount(
      <ExportPopup id="export" projectName={PROJECT_NAME} paths={PATHS} caveat={CAVEAT} />,
    );
    await handle.render();
    expect(lineText(handle.capture(), 0)).toContain("export ^E");
  });

  test("renders the success line in bold green", async () => {
    const handle = await createHeadlessRenderer({ w: 62, h: 11 });
    open = handle;
    handle.mount(
      <ExportPopup id="export" projectName={PROJECT_NAME} paths={PATHS} caveat={CAVEAT} />,
    );
    await handle.render();
    const run = findRun(handle.capture(), `✓ exported ${PROJECT_NAME}`);
    expect(run).toBeDefined();
    expect(run && extractRgb(run.fg)).toBe<string>(SHELL_PALETTE.green);
    expect((run?.attrs ?? 0) & 1).toBe(1);
  });

  test("renders a path line in the dim hue", async () => {
    const handle = await createHeadlessRenderer({ w: 62, h: 11 });
    open = handle;
    handle.mount(
      <ExportPopup id="export" projectName={PROJECT_NAME} paths={PATHS} caveat={CAVEAT} />,
    );
    await handle.render();
    const frame = handle.capture();
    for (const path of PATHS) {
      const run = findRun(frame, path.trim());
      expect(run).toBeDefined();
      expect(run && extractRgb(run.fg)).toBe<string>(SHELL_PALETTE.dim);
    }
  });

  test("renders the caveat line in the faint hue", async () => {
    const handle = await createHeadlessRenderer({ w: 62, h: 11 });
    open = handle;
    handle.mount(
      <ExportPopup id="export" projectName={PROJECT_NAME} paths={PATHS} caveat={CAVEAT} />,
    );
    await handle.render();
    const run = findRun(handle.capture(), CAVEAT);
    expect(run).toBeDefined();
    expect(run && extractRgb(run.fg)).toBe<string>(SHELL_PALETTE.faint);
  });

  test('renders the "⏎ ok" dismiss line in bold amber', async () => {
    const handle = await createHeadlessRenderer({ w: 62, h: 11 });
    open = handle;
    handle.mount(
      <ExportPopup id="export" projectName={PROJECT_NAME} paths={PATHS} caveat={CAVEAT} />,
    );
    await handle.render();
    const run = findRun(handle.capture(), "⏎ ok");
    expect(run).toBeDefined();
    expect(run && extractRgb(run.fg)).toBe<string>(SHELL_PALETTE.amber);
    expect((run?.attrs ?? 0) & 1).toBe(1);
  });
});

describe("ExportFailurePopup component (M14 — no design failure mock; closest faithful mapping onto the ErrorPanel red band)", () => {
  test('renders the "export ^E" titled box', async () => {
    const handle = await createHeadlessRenderer({ w: 62, h: 11 });
    open = handle;
    handle.mount(
      <ExportFailurePopup
        id="export-fail"
        pageSlug="main"
        sizeBytes={4096}
        safeMessage="disk full"
      />,
    );
    await handle.render();
    expect(lineText(handle.capture(), 0)).toContain("export ^E");
  });

  test("renders the bold red ✗ headline naming the page slug", async () => {
    const handle = await createHeadlessRenderer({ w: 62, h: 11 });
    open = handle;
    handle.mount(
      <ExportFailurePopup
        id="export-fail"
        pageSlug="main"
        sizeBytes={4096}
        safeMessage="disk full"
      />,
    );
    await handle.render();
    const run = findRun(handle.capture(), "✗ export failed main");
    expect(run).toBeDefined();
    expect(run && extractRgb(run.fg)).toBe<string>(SHELL_PALETTE.red);
    expect((run?.attrs ?? 0) & 1).toBe(1);
  });

  test("renders a generic headline when no page slug was retained", async () => {
    const handle = await createHeadlessRenderer({ w: 62, h: 11 });
    open = handle;
    handle.mount(
      <ExportFailurePopup
        id="export-fail"
        pageSlug={null}
        sizeBytes={null}
        safeMessage="disk full"
      />,
    );
    await handle.render();
    const run = findRun(handle.capture(), "✗ export failed");
    expect(run).toBeDefined();
    expect(run?.text).not.toContain("null");
  });

  test("renders the retained size and the failure's safeMessage", async () => {
    const handle = await createHeadlessRenderer({ w: 62, h: 11 });
    open = handle;
    handle.mount(
      <ExportFailurePopup
        id="export-fail"
        pageSlug="main"
        sizeBytes={4096}
        safeMessage="disk full"
      />,
    );
    await handle.render();
    const frame = handle.capture();
    expect(findRun(frame, "4096")).toBeDefined();
    expect(findRun(frame, "disk full")).toBeDefined();
  });

  test('renders the "⏎ ok" dismiss line in bold amber', async () => {
    const handle = await createHeadlessRenderer({ w: 62, h: 11 });
    open = handle;
    handle.mount(
      <ExportFailurePopup
        id="export-fail"
        pageSlug="main"
        sizeBytes={4096}
        safeMessage="disk full"
      />,
    );
    await handle.render();
    const run = findRun(handle.capture(), "⏎ ok");
    expect(run).toBeDefined();
    expect(run && extractRgb(run.fg)).toBe<string>(SHELL_PALETTE.amber);
    expect((run?.attrs ?? 0) & 1).toBe(1);
  });
});
