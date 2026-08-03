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
  agentBlocked?: { readonly line: string; readonly f6Detail: string } | null;
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
      agentBlocked={opts?.agentBlocked ?? null}
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

  const AGENT_BLOCKED = {
    line: "✗ claude not signed in — F6 fills the composer, but nothing runs yet",
    f6Detail: "claude is not signed in — nothing runs until it is",
  } as const;

  test("the F6 row stops promising a turn the agent cannot run", async () => {
    const frame = await mount({ agentBlocked: AGENT_BLOCKED });
    // The block's content width is fixed (`BLOCK_MAX_WIDTH`), so this real message wraps across
    // two lines the same way the host message above does — no truncation, both halves render.
    // Asserted as two exact runs rather than the joined phrase, since the phrase itself never
    // lands in one contiguous run once wrapped.
    expect(findRun(frame, "claude is not signed in — nothing runs")).toBeDefined();
    expect(findRun(frame, "until it is")).toBeDefined();
    // The default detail is a promise F6 cannot keep while the agent is dead — it must be
    // replaced, not merely joined by the new line.
    expect(findRun(frame, "nothing is sent — you press ⏎")).toBeUndefined();
  });

  test("a line under the tee rule says it plainly", async () => {
    const frame = await mount({ agentBlocked: AGENT_BLOCKED });
    // Same wrap as above; both halves must be present and both must be red.
    const firstHalf = findRun(frame, "✗ claude not signed in — F6 fills the composer, but");
    const secondHalf = findRun(frame, "nothing runs yet");
    expect(firstHalf).toBeDefined();
    expect(firstHalf && extractRgb(firstHalf.fg)).toBe<string>(SHELL_PALETTE.red);
    expect(secondHalf).toBeDefined();
    expect(secondHalf && extractRgb(secondHalf.fg)).toBe<string>(SHELL_PALETTE.red);
  });

  test("a healthy agent renders the panel exactly as before", async () => {
    const frame = await mount({ agentBlocked: null });
    // This is the exact string the unmodified panel renders for the F6 detail line — proven by
    // the "offers both keys when retry is available" test above, which asserts on it with no
    // `agentBlocked` prop involved at all.
    expect(findRun(frame, "nothing is sent — you press ⏎")).toBeDefined();
    expect(findRun(frame, "nothing runs until it is")).toBeUndefined();
  });

  test("KNOWN DEFECT: at 74×18 (a 120×24 terminal's preview region) the blocked variant needs 4 more rows than the region gives it", async () => {
    // Pins the exact regression measured by branch review finding 1 (2026-08-02 fix wave) — see
    // `HostCrashPanel.tsx`'s own DIVERGENCE 3 comment for the full analysis, the worse numbers
    // at the real 80×24/100×24 floors (this test exercises only the 120-column geometry, NOT
    // the smallest supported width), and why a real fix is a bigger change than this wave
    // carries. `previewRegionSize({w:120,h:24}, false)` is `{w:74, h:18}`
    // (`src/ui/workspace/model/preview-geometry.ts`) — 18 rows IS the smallest supported region
    // height at any width (`previewRegionSize`'s height depends only on terminal height), but
    // 74 columns is not the narrowest supported region width. Measured via `rectOf`, not
    // screen-scraped text, so this pin is independent of which specific rows the ancestor
    // `overflow="hidden"` happens to clip for any one message length.
    const width = 74;
    const height = 18;
    const handle = await createHeadlessRenderer({ w: width, h: height });
    open = handle;
    const panel = (agentBlocked: { readonly line: string; readonly f6Detail: string } | null) => (
      <HostCrashPanel
        id="crash"
        width={width}
        height={height}
        pageSlug="dashboard"
        hostMessage={MESSAGE}
        attempts={4}
        retryAvailable={true}
        agentBlocked={agentBlocked}
      />
    );

    handle.mount(panel(null));
    await handle.render();
    const nullRect = handle.rectOf("crash-block");
    // The `null` variant exactly fills the region — no slack to begin with, at THIS width.
    expect(nullRect?.height).toBe(height);

    handle.mount(panel(AGENT_BLOCKED));
    await handle.render();
    const blockedRect = handle.rectOf("crash-block");
    // The `agentBlocked` variant needs 4 more rows than the region provides — the defect.
    expect(blockedRect?.height).toBe(22);
  });
});
