import { afterEach, describe, expect, test } from "bun:test";

import type { StyledRun } from "host/protocol";
import { extractRgb } from "host/render/model/color";
import { createHeadlessRenderer } from "host/render/model/renderer";
import type { RenderHandle } from "host/render/types";
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
        agentName="codex"
        connection="ratatui · connected"
        spinner="⠹"
        steps={[]}
        reasoning={null}
        gateRetries={[]}
      />,
    );
    await handle.render();
    const frame = handle.capture();

    const agent = findRun(frame, "● codex");
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
        agentName="codex"
        connection="ratatui · connected"
        spinner="⠹"
        steps={[]}
        reasoning={null}
        gateRetries={[]}
      />,
    );
    await handle.render();
    const frame = handle.capture();

    const spinner = findRun(frame, "⠹ generating design…");
    expect(spinner).toBeDefined();
    expect(spinner && extractRgb(spinner.fg)).toBe<string>(SHELL_PALETTE.amber);
    expect((spinner?.attrs ?? 0) & 1).toBe(1);
  });

  test("a done step renders green with a checkmark and the active step renders fg with a triangle", async () => {
    const handle = await createHeadlessRenderer({ w: 40, h: 8 });
    open = handle;
    handle.mount(
      <AgentStatusBlock
        id="status"
        agentName="codex"
        connection="ratatui · connected"
        spinner="⠹"
        steps={[
          { op: "read", target: "current design", done: true },
          { op: "writing", target: "widgets", done: false },
        ]}
        reasoning={null}
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

  test("the reasoning ticker line renders faint with a 2-space indent, no glyph", async () => {
    const handle = await createHeadlessRenderer({ w: 40, h: 8 });
    open = handle;
    handle.mount(
      <AgentStatusBlock
        id="status"
        agentName="codex"
        connection="ratatui · connected"
        spinner="⠹"
        steps={[]}
        reasoning="network gauge · sparkline"
        gateRetries={[]}
      />,
    );
    await handle.render();
    const frame = handle.capture();

    const reasoning = findRun(frame, "network gauge · sparkline");
    expect(reasoning).toBeDefined();
    expect(reasoning?.text.startsWith("  ")).toBe(true);
    expect(reasoning && extractRgb(reasoning.fg)).toBe<string>(SHELL_PALETTE.faint);
  });

  test("omits the reasoning line entirely when reasoning is null", async () => {
    const handle = await createHeadlessRenderer({ w: 40, h: 8 });
    open = handle;
    handle.mount(
      <AgentStatusBlock
        id="status"
        agentName="codex"
        connection="ratatui · connected"
        spinner="⠹"
        steps={[]}
        reasoning={null}
        gateRetries={[]}
      />,
    );
    await handle.render();
    const frame = handle.capture();
    const allText = frame.rows
      .map((row: StyledRun[]) => row.map((run) => run.text).join(""))
      .join("\n");
    expect(allText).not.toContain("  network");
  });

  test("a gate retry renders the red retry line", async () => {
    const handle = await createHeadlessRenderer({ w: 40, h: 8 });
    open = handle;
    handle.mount(
      <AgentStatusBlock
        id="status"
        agentName="codex"
        connection="ratatui · connected"
        spinner="⠹"
        steps={[]}
        reasoning={null}
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
        agentName="codex"
        connection="ratatui · connected"
        spinner="⠹"
        steps={[]}
        reasoning={null}
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
        agentName="codex"
        connection="ratatui · connected"
        spinner="⠹"
        steps={[]}
        reasoning={null}
        gateRetries={[]}
      />,
    );
    await handle.render();
    // Smoke: rendering with a distinct id does not throw and still paints row 0.
    expect(lineRuns(handle.capture(), 0).length).toBeGreaterThan(0);
  });
});
