import { afterEach, describe, expect, test } from "bun:test";

import type { StyledRun } from "host/protocol";
import { extractRgb } from "host/render/model/color";
import { createHeadlessRenderer } from "host/render/model/renderer";
import type { RenderHandle } from "host/render/types";
import { SHELL_PALETTE } from "ui/theme";

import { HostCrashPanel } from "./HostCrashPanel";

let open: RenderHandle | null = null;
afterEach(() => {
  open?.destroy();
  open = null;
});

const findRun = (frame: { rows: StyledRun[][] }, needle: string) =>
  frame.rows.flat().find((run) => run.text.includes(needle));

const MESSAGE = "PAGE_RENDER_FAILED: TypeError: ctx.spy is not a function";

async function mount(opts?: {
  retryAvailable?: boolean;
  hostMessage?: string;
  attempts?: number;
  w?: number;
  h?: number;
}) {
  const width = opts?.w ?? 76;
  const height = opts?.h ?? 26;
  const handle = await createHeadlessRenderer({ w: width, h: height });
  open = handle;
  handle.mount(
    <HostCrashPanel
      id="crash"
      width={width}
      height={height}
      pageSlug="dashboard"
      hostMessage={opts?.hostMessage ?? MESSAGE}
      attempts={opts?.attempts ?? 4}
      retryAvailable={opts?.retryAvailable ?? true}
    />,
  );
  await handle.render();
  return handle.capture();
}

describe("HostCrashPanel (design wsHostCrash)", () => {
  test("titles the block and opens with the red crash line", async () => {
    const frame = await mount();
    expect(findRun(frame, "preview host · halted")).toBeDefined();
    const headline = findRun(frame, "✗ design threw while rendering — no preview");
    expect(headline).toBeDefined();
    expect(headline && extractRgb(headline.fg)).toBe<string>(SHELL_PALETTE.red);
    expect((headline?.attrs ?? 0) & 1).toBe(1);
  });

  test("names the page and its project-relative file", async () => {
    const frame = await mount();
    const slug = findRun(frame, "dashboard");
    expect(slug).toBeDefined();
    expect(slug && extractRgb(slug.fg)).toBe<string>(SHELL_PALETTE.amberHi);
    expect(findRun(frame, ".termcraft/pages/dashboard/page.tsx")).toBeDefined();
  });

  test("reports the restart tally", async () => {
    const frame = await mount();
    expect(findRun(frame, "mounted 4× · 3 automatic restarts, all identical")).toBeDefined();
    expect(findRun(frame, "restarts stopped — no preview until you act")).toBeDefined();
  });

  test("reports one mount and no restarts when the circuit opened on the first failure", async () => {
    // A deterministic failure never gets a restart. The design's own line is written for the
    // budgeted case; stating "mounted 1× · 0 automatic restarts, all identical" would be a
    // fabrication about a loop that never happened.
    const frame = await mount({ attempts: 1 });
    expect(findRun(frame, "mounted once · no restart was attempted")).toBeDefined();
    expect(findRun(frame, "automatic restarts")).toBeUndefined();
  });

  test("labels the host message block", async () => {
    const frame = await mount();
    const label = findRun(frame, "host message");
    expect(label).toBeDefined();
    expect(label && extractRgb(label.fg)).toBe<string>(SHELL_PALETTE.dim);
  });

  test("renders the host message verbatim and wrapped, never truncated", async () => {
    // A REALISTIC worst case, not one long unbroken token: the runtime bounds the message to
    // 200 characters and every real one is prose with spaces, which is what a word wrapper can
    // actually break. Asserting on `"x".repeat(180)` would test a case that cannot occur and
    // would fail for a reason the component is not responsible for.
    const long =
      "PAGE_RENDER_FAILED: TypeError: ctx.spy is not a function while mounting the ProcessTable widget declared in the dashboard page, and the host exited with status 1 before any frame was captured";
    const frame = await mount({ hostMessage: long, h: 32 });
    const joined = frame.rows
      .flat()
      .map((run) => run.text)
      .join(" ");
    // Every word of the message survives, across however many lines it wrapped onto. This IS
    // the no-truncation proof: a truncated message loses its tail words, ellipsis or not.
    for (const word of long.split(" ")) expect(joined).toContain(word);
    // And it really did wrap rather than overflow one row: first and last word land on
    // different rows.
    const rowText = frame.rows.map((row) => row.map((run) => run.text).join(""));
    const firstWordRow = rowText.findIndex((row) => row.includes("PAGE_RENDER_FAILED"));
    const lastWordRow = rowText.findIndex((row) => row.includes("captured"));
    expect(firstWordRow).toBeGreaterThan(-1);
    expect(lastWordRow).toBeGreaterThan(firstWordRow);
  });

  test("offers both keys when retry is available", async () => {
    const frame = await mount();
    const f5 = findRun(frame, "retry preview");
    expect(f5).toBeDefined();
    expect(f5 && extractRgb(f5.fg)).toBe<string>(SHELL_PALETTE.amberHi);
    expect(findRun(frame, "re-establish the host and mount again")).toBeDefined();
    expect(findRun(frame, "repair…")).toBeDefined();
    expect(findRun(frame, "nothing is sent — you press ⏎")).toBeDefined();
  });

  test("draws F5 faint with its own reason when retry is unavailable", async () => {
    const frame = await mount({ retryAvailable: false });
    const f5 = findRun(frame, "retry preview");
    expect(f5).toBeDefined();
    expect(f5 && extractRgb(f5.fg)).toBe<string>(SHELL_PALETTE.faint);
    expect(findRun(frame, "unavailable in this session")).toBeDefined();
    expect(findRun(frame, "repair is the only route out")).toBeDefined();
  });
});
