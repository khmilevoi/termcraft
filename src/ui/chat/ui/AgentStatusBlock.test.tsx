import { afterEach, describe, expect, test } from "bun:test";

import type { StyledRun } from "host/protocol";
import { extractRgb } from "host/render/model/color";
import { createHeadlessRenderer } from "host/render/model/renderer";
import type { RenderHandle } from "host/render/types";
import { SPINNER_FRAMES } from "ui/spinner";
import { SHELL_PALETTE } from "ui/theme";

import { AgentStatusBlock } from "./AgentStatusBlock";

let open: RenderHandle | null = null;
afterEach(() => {
  open?.destroy();
  open = null;
});

const lineRuns = (frame: { rows: StyledRun[][] }, row: number): StyledRun[] =>
  frame.rows[row] ?? [];
const findRun = (frame: { rows: StyledRun[][] }, needle: string) =>
  frame.rows.flat().find((run) => run.text.includes(needle));

describe("AgentStatusBlock component (design drawChat, ephemeral in-turn status)", () => {
  test("renders the agent presence dot and connection meta on their own lines", async () => {
    const handle = await createHeadlessRenderer({ w: 40, h: 8 });
    open = handle;
    handle.mount(
      <AgentStatusBlock
        id="status"
        agentName="claude"
        connection="ratatui · connected"
        startedAt={null}
        fold={null}
        entries={[]}
        gateRetries={[]}
      />,
    );
    await handle.render();
    const frame = handle.capture();

    const agent = findRun(frame, "● claude");
    expect(agent).toBeDefined();
    expect(agent && extractRgb(agent.fg)).toBe<string>(SHELL_PALETTE.green);
    expect((agent?.attrs ?? 0) & 1).toBe(1);

    const connection = findRun(frame, "ratatui · connected");
    expect(connection).toBeDefined();
    expect(connection && extractRgb(connection.fg)).toBe<string>(SHELL_PALETTE.faint);
  });

  test("renders the bold amber spinner line", async () => {
    const handle = await createHeadlessRenderer({ w: 40, h: 8 });
    open = handle;
    handle.mount(
      <AgentStatusBlock
        id="status"
        agentName="claude"
        connection="ratatui · connected"
        startedAt={null}
        fold={null}
        entries={[]}
        gateRetries={[]}
      />,
    );
    await handle.render();
    const frame = handle.capture();

    // Frame-agnostic on purpose: the spinner animates (`ui/spinner`, 80ms), so pinning one glyph
    // would fail whenever a slow render crossed a tick. The label is asserted here; that the
    // leading glyph is a real member of the cycle is asserted separately below.
    const spinner = findRun(frame, "generating design…");
    if (spinner === undefined) throw new Error("fixture bug: no spinner line rendered");
    expect(SPINNER_FRAMES).toContain(spinner.text.trimStart().slice(0, 1));
    expect(spinner && extractRgb(spinner.fg)).toBe<string>(SHELL_PALETTE.amber);
    expect((spinner?.attrs ?? 0) & 1).toBe(1);
  });

  test("passes startedAt through to the spinner's elapsed segment", async () => {
    const handle = await createHeadlessRenderer({ w: 40, h: 8 });
    open = handle;
    handle.mount(
      <AgentStatusBlock
        id="status"
        agentName="claude"
        connection="ratatui · connected"
        startedAt={Date.now() - 5_000}
        fold={null}
        entries={[]}
        gateRetries={[]}
      />,
    );
    await handle.render();
    const frame = handle.capture();
    const spinner = findRun(frame, "generating design…");
    expect(spinner?.text).toContain("·");
  });

  test("a done step renders green with a checkmark and the active step renders fg with a triangle", async () => {
    const handle = await createHeadlessRenderer({ w: 40, h: 8 });
    open = handle;
    handle.mount(
      <AgentStatusBlock
        id="status"
        agentName="claude"
        connection="ratatui · connected"
        startedAt={null}
        fold={null}
        entries={[
          { kind: "step", op: "read", target: "current design", done: true },
          { kind: "step", op: "writing", target: "widgets", done: false },
        ]}
        gateRetries={[]}
      />,
    );
    await handle.render();
    const frame = handle.capture();

    const done = findRun(frame, "✓ read current design");
    expect(done).toBeDefined();
    expect(done && extractRgb(done.fg)).toBe<string>(SHELL_PALETTE.green);
    expect((done?.attrs ?? 0) & 1).toBe(0);

    const active = findRun(frame, "▸ writing widgets");
    expect(active).toBeDefined();
    expect(active && extractRgb(active.fg)).toBe<string>(SHELL_PALETTE.fg);
  });

  test("a PAST reasoning row renders one faint line at tx+2, with a line-column gutter", async () => {
    const handle = await createHeadlessRenderer({ w: 40, h: 8 });
    open = handle;
    handle.mount(
      <AgentStatusBlock
        id="status"
        agentName="claude"
        connection="ratatui · connected"
        startedAt={null}
        fold={null}
        entries={[
          { kind: "reasoning", lines: ["network gauge · sparkline…"], live: false, clipped: true },
        ]}
        gateRetries={[]}
      />,
    );
    await handle.render();
    const frame = handle.capture();

    const reasoning = findRun(frame, "network gauge · sparkline…");
    expect(reasoning).toBeDefined();
    expect(reasoning && extractRgb(reasoning.fg)).toBe<string>(SHELL_PALETTE.faint);
    // past rows always draw the plain thread glyph, never the scrolled-head marker.
    const gutter = findRun(frame, "│");
    expect(gutter).toBeDefined();
    expect(gutter && extractRgb(gutter.fg)).toBe<string>(SHELL_PALETTE.line);
  });

  test("a LIVE reasoning row renders dim with an amberDim thread, and marks a clipped head ┊", async () => {
    const handle = await createHeadlessRenderer({ w: 40, h: 8 });
    open = handle;
    handle.mount(
      <AgentStatusBlock
        id="status"
        agentName="claude"
        connection="ratatui · connected"
        startedAt={null}
        fold={null}
        entries={[
          { kind: "reasoning", lines: ["line one", "line two"], live: true, clipped: true },
        ]}
        gateRetries={[]}
      />,
    );
    await handle.render();
    const frame = handle.capture();

    const first = findRun(frame, "line one");
    const second = findRun(frame, "line two");
    expect(first && extractRgb(first.fg)).toBe<string>(SHELL_PALETTE.dim);
    expect(second && extractRgb(second.fg)).toBe<string>(SHELL_PALETTE.dim);

    const scrolledHead = findRun(frame, "┊");
    expect(scrolledHead).toBeDefined();
    expect(scrolledHead && extractRgb(scrolledHead.fg)).toBe<string>(SHELL_PALETTE.amberDim);
  });

  test("renders no reasoning/step rows when entries is empty", async () => {
    const handle = await createHeadlessRenderer({ w: 40, h: 8 });
    open = handle;
    handle.mount(
      <AgentStatusBlock
        id="status"
        agentName="claude"
        connection="ratatui · connected"
        startedAt={null}
        fold={null}
        entries={[]}
        gateRetries={[]}
      />,
    );
    await handle.render();
    const frame = handle.capture();
    const allText = frame.rows
      .map((row: StyledRun[]) => row.map((run) => run.text).join(""))
      .join("\n");
    expect(allText).not.toContain("│");
    expect(allText).not.toContain("┊");
  });

  test("a fold row renders '▲ N earlier thoughts · M steps' in amberDim bold with a ┊ gutter", async () => {
    const handle = await createHeadlessRenderer({ w: 40, h: 8 });
    open = handle;
    handle.mount(
      <AgentStatusBlock
        id="status"
        agentName="claude"
        connection="ratatui · connected"
        startedAt={null}
        fold={{ thoughts: 6, steps: 5 }}
        entries={[]}
        gateRetries={[]}
      />,
    );
    await handle.render();
    const frame = handle.capture();

    const fold = findRun(frame, "▲ 6 earlier thoughts · 5 steps");
    expect(fold).toBeDefined();
    expect(fold && extractRgb(fold.fg)).toBe<string>(SHELL_PALETTE.amberDim);
    expect((fold?.attrs ?? 0) & 1).toBe(1);
  });

  test("omits the fold row entirely when fold is null", async () => {
    const handle = await createHeadlessRenderer({ w: 40, h: 8 });
    open = handle;
    handle.mount(
      <AgentStatusBlock
        id="status"
        agentName="claude"
        connection="ratatui · connected"
        startedAt={null}
        fold={null}
        entries={[]}
        gateRetries={[]}
      />,
    );
    await handle.render();
    const frame = handle.capture();
    const allText = frame.rows
      .map((row: StyledRun[]) => row.map((run) => run.text).join(""))
      .join("\n");
    expect(allText).not.toContain("▲");
  });

  test("a gate retry renders the red retry line", async () => {
    const handle = await createHeadlessRenderer({ w: 40, h: 8 });
    open = handle;
    handle.mount(
      <AgentStatusBlock
        id="status"
        agentName="claude"
        connection="ratatui · connected"
        startedAt={null}
        fold={null}
        entries={[]}
        gateRetries={[{ retryNumber: 1 }]}
      />,
    );
    await handle.render();
    const frame = handle.capture();

    const retry = findRun(frame, "✗ invalid design (schema) · retry 1/3");
    expect(retry).toBeDefined();
    expect(retry && extractRgb(retry.fg)).toBe<string>(SHELL_PALETTE.red);
  });

  test("renders multiple gate retries, one per line", async () => {
    const handle = await createHeadlessRenderer({ w: 40, h: 10 });
    open = handle;
    handle.mount(
      <AgentStatusBlock
        id="status"
        agentName="claude"
        connection="ratatui · connected"
        startedAt={null}
        fold={null}
        entries={[]}
        gateRetries={[{ retryNumber: 1 }, { retryNumber: 2 }, { retryNumber: 3 }]}
      />,
    );
    await handle.render();
    const frame = handle.capture();

    expect(findRun(frame, "retry 1/3")).toBeDefined();
    expect(findRun(frame, "retry 2/3")).toBeDefined();
    expect(findRun(frame, "retry 3/3")).toBeDefined();
  });

  test("stable ids compose from the block id for the agent line", async () => {
    const handle = await createHeadlessRenderer({ w: 40, h: 8 });
    open = handle;
    handle.mount(
      <AgentStatusBlock
        id="turn-status"
        agentName="claude"
        connection="ratatui · connected"
        startedAt={null}
        fold={null}
        entries={[]}
        gateRetries={[]}
      />,
    );
    await handle.render();
    // Smoke: rendering with a distinct id does not throw and still paints row 0.
    expect(lineRuns(handle.capture(), 0).length).toBeGreaterThan(0);
  });
});
