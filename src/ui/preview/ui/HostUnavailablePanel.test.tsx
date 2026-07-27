import { afterEach, describe, expect, test } from "bun:test";

import type { StyledRun } from "host/protocol";
import { extractRgb } from "host/render/model/color";
import { createHeadlessRenderer } from "host/render/model/renderer";
import type { RenderHandle } from "host/render/types";
import { SHELL_PALETTE } from "ui/theme";

import { HostUnavailablePanel } from "./HostUnavailablePanel";

let open: RenderHandle | null = null;
afterEach(() => {
  open?.destroy();
  open = null;
});

const findRun = (frame: { rows: StyledRun[][] }, needle: string) =>
  frame.rows.flat().find((run) => run.text.includes(needle));

async function mount(opts?: {
  failureCode?: string;
  hostMessage?: string;
  attempts?: number;
  retryAvailable?: boolean;
}) {
  const handle = await createHeadlessRenderer({ w: 78, h: 30 });
  open = handle;
  handle.mount(
    <HostUnavailablePanel
      id="unavail"
      width={78}
      height={30}
      pageSlug="dashboard"
      failureCode={opts?.failureCode ?? "MOUNT_TIMEOUT"}
      hostMessage={opts?.hostMessage ?? "no mount within 5000 ms"}
      attempts={opts?.attempts ?? 4}
      retryAvailable={opts?.retryAvailable ?? true}
    />,
  );
  await handle.render();
  return handle.capture();
}

describe("HostUnavailablePanel (design wsHostUnavailable)", () => {
  test("titles the block and says the design was never run", async () => {
    const frame = await mount();
    expect(findRun(frame, "preview host · unavailable")).toBeDefined();
    const headline = findRun(frame, "✗ preview host unavailable — your design was never run");
    expect(headline).toBeDefined();
    expect(headline && extractRgb(headline.fg)).toBe<string>(SHELL_PALETTE.red);
  });

  test("clears the page of blame with a green ✓ — the whole reason this frame exists", async () => {
    const frame = await mount();
    const mark = findRun(frame, "✓");
    expect(mark).toBeDefined();
    expect(mark && extractRgb(mark.fg)).toBe<string>(SHELL_PALETTE.green);
    // The line wraps at a long slug, so it can span runs — assert against the joined text.
    const joined = frame.rows
      .flat()
      .map((run) => run.text)
      .join("");
    expect(joined).toContain("dashboard · unchanged and not implicated");
    expect(joined).toContain("nothing to fix");
  });

  test("never names F6 — no page edit could fix this", async () => {
    const text = (await mount()).rows
      .flat()
      .map((run) => run.text)
      .join("");
    expect(text).not.toContain("F6");
    expect(text).not.toContain("repair");
    expect(findRun(await mount(), "talking to the agent cannot start a host")).toBeDefined();
  });

  test("shows the raw code and exactly one phrase from the design's closed table", async () => {
    const frame = await mount({ failureCode: "SPAWN_FAILED" });
    expect(findRun(frame, "SPAWN_FAILED")).toBeDefined();
    expect(findRun(frame, "the host process could not be started")).toBeDefined();
  });

  test("falls back to the design's own generic phrase for a code its table does not name", async () => {
    const frame = await mount({ failureCode: "SOMETHING_NEW" });
    expect(findRun(frame, "SOMETHING_NEW")).toBeDefined();
    expect(findRun(frame, "the host could not be used")).toBeDefined();
  });

  test("draws no gutter when the runtime message adds nothing — nothing looks withheld", async () => {
    const frame = await mount({ hostMessage: "" });
    expect(findRun(frame, "┊")).toBeUndefined();
  });

  test("wraps the runtime message behind the ┊ gutter when there is one", async () => {
    const frame = await mount({ hostMessage: "no mount within 5000 ms" });
    const gutter = findRun(frame, "┊");
    expect(gutter).toBeDefined();
    expect(gutter && extractRgb(gutter.fg)).toBe<string>(SHELL_PALETTE.amberDim);
    expect(findRun(frame, "no mount within 5000 ms")).toBeDefined();
  });

  test("reads correctly for a spent budget", async () => {
    const frame = await mount({ attempts: 4 });
    expect(findRun(frame, "4 starts · 3 automatic restarts")).toBeDefined();
    expect(findRun(frame, "every start failed the same way")).toBeDefined();
  });

  test("reads correctly for a deterministic failure that opened the circuit at once", async () => {
    const frame = await mount({ attempts: 1, failureCode: "RUNTIME_INTEGRITY_MISMATCH" });
    expect(findRun(frame, "1 start · 0 automatic restarts")).toBeDefined();
    expect(findRun(frame, "deterministic — a restart cannot change it")).toBeDefined();
  });

  test("offers F5 when a host can still be started", async () => {
    const frame = await mount();
    const f5 = findRun(frame, "retry host");
    expect(f5).toBeDefined();
    expect(f5 && extractRgb(f5.fg)).toBe<string>(SHELL_PALETTE.amberHi);
    expect(findRun(frame, "start a new host and mount again")).toBeDefined();
    expect(findRun(frame, "no preview until a host starts")).toBeDefined();
  });

  test("draws F5 faint and states the session is over when retry is gone", async () => {
    const frame = await mount({ retryAvailable: false });
    const f5 = findRun(frame, "retry host");
    expect(f5 && extractRgb(f5.fg)).toBe<string>(SHELL_PALETTE.faint);
    expect(findRun(frame, "no host can be started in this session")).toBeDefined();
    expect(findRun(frame, "nothing in this pane will bring it back")).toBeDefined();
    expect(findRun(frame, "no preview for this session")).toBeDefined();
    expect(findRun(frame, "this is not the agent's to fix")).toBeDefined();
  });
});
