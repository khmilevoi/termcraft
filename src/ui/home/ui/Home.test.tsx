import { afterEach, describe, expect, test } from "bun:test";

import type { StyledRun } from "host/protocol";
import { extractRgb } from "host/render/model/color";
import { createHeadlessRenderer } from "host/render/model/renderer";
import type { RenderHandle } from "host/render/types";
import { SHELL_PALETTE } from "ui/theme";

import type { HomeProps } from "../types";
import { Home } from "./Home";

let open: RenderHandle | null = null;
afterEach(() => {
  open?.destroy();
  open = null;
});

interface Frame {
  readonly rows: StyledRun[][];
}

const findRun = (frame: Frame, needle: string): StyledRun | undefined =>
  frame.rows.flat().find((run) => run.text.includes(needle));

const BOLD = 0b1;

const baseProps: HomeProps = {
  id: "home",
  width: 80,
  height: 20,
  health: { present: true, version: "0.34", detail: "agent ready", agent: "claude" },
  prompt: "",
  combo: { agent: "claude", model: "sonnet-4.5", effort: "high" },
};

describe("Home screen — idle (design home(), design/01-home.dc.html)", () => {
  test("renders the logo in bold amber", async () => {
    const handle = await createHeadlessRenderer({ w: 80, h: 20 });
    open = handle;
    handle.mount(<Home {...baseProps} />);
    await handle.render();
    const run = findRun(handle.capture(), "termcraft");
    expect(run && extractRgb(run.fg)).toBe<string>(SHELL_PALETTE.amber);
    expect((run?.attrs ?? 0) & BOLD).toBe(BOLD);
  });

  test("renders the tagline dim", async () => {
    const handle = await createHeadlessRenderer({ w: 80, h: 20 });
    open = handle;
    handle.mount(<Home {...baseProps} />);
    await handle.render();
    const run = findRun(handle.capture(), "design terminal UIs by describing them");
    expect(run && extractRgb(run.fg)).toBe<string>(SHELL_PALETTE.dim);
  });

  test("an empty prompt shows the faint placeholder", async () => {
    const handle = await createHeadlessRenderer({ w: 80, h: 20 });
    open = handle;
    handle.mount(<Home {...baseProps} />);
    await handle.render();
    const run = findRun(handle.capture(), "Describe the TUI you want to design");
    expect(run).toBeDefined();
    expect(run && extractRgb(run.fg)).toBe<string>(SHELL_PALETTE.faint);
  });

  test("a non-empty prompt replaces the placeholder", async () => {
    const handle = await createHeadlessRenderer({ w: 80, h: 20 });
    open = handle;
    handle.mount(<Home {...baseProps} prompt="a kanban board with three columns" />);
    await handle.render();
    const frame = handle.capture();
    expect(findRun(frame, "a kanban board with three columns")).toBeDefined();
    expect(findRun(frame, "Describe the TUI you want to design")).toBeUndefined();
  });

  test("renders the agent/model/effort combo values in bold amberHi", async () => {
    const handle = await createHeadlessRenderer({ w: 80, h: 20 });
    open = handle;
    handle.mount(<Home {...baseProps} />);
    await handle.render();
    const frame = handle.capture();
    for (const value of ["‹claude›", "‹sonnet-4.5›", "‹high›"]) {
      const run = findRun(frame, value);
      expect(run && extractRgb(run.fg)).toBe<string>(SHELL_PALETTE.amberHi);
      expect((run?.attrs ?? 0) & BOLD).toBe(BOLD);
    }
  });

  test("renders the agent health line in bold green", async () => {
    const handle = await createHeadlessRenderer({ w: 80, h: 20 });
    open = handle;
    handle.mount(<Home {...baseProps} />);
    await handle.render();
    const run = findRun(handle.capture(), "● claude 0.34 · agent ready");
    expect(run).toBeDefined();
    expect(run && extractRgb(run.fg)).toBe<string>(SHELL_PALETTE.green);
    expect((run?.attrs ?? 0) & BOLD).toBe(BOLD);
  });

  test("an absent agent name renders the neutral empty text, never an invented fallback (M22)", async () => {
    const handle = await createHeadlessRenderer({ w: 80, h: 20 });
    open = handle;
    const noAgentProps: HomeProps = {
      ...baseProps,
      health: { present: true, version: "0.34", detail: "agent ready" },
    };
    handle.mount(<Home {...noAgentProps} />);
    await handle.render();
    const frame = handle.capture();
    expect(findRun(frame, "● claude")).toBeUndefined();
    expect(findRun(frame, "0.34 · agent ready")).toBeDefined();
  });
});

describe("Home screen — agent-missing error (design homeErr(), screen 12 err-agent-80)", () => {
  const errorProps: HomeProps = {
    ...baseProps,
    width: 80,
    height: 14,
    health: { present: false, detail: "claude CLI not found", agent: "claude" },
  };

  test("renders the CLI-not-found line in bold red", async () => {
    const handle = await createHeadlessRenderer({ w: 80, h: 14 });
    open = handle;
    handle.mount(<Home {...errorProps} />);
    await handle.render();
    const run = findRun(handle.capture(), "✗ claude CLI not found");
    expect(run).toBeDefined();
    expect(run && extractRgb(run.fg)).toBe<string>(SHELL_PALETTE.red);
    expect((run?.attrs ?? 0) & BOLD).toBe(BOLD);
  });

  test("renders the install hint driven by the agent name, not a hardcoded package", async () => {
    const handle = await createHeadlessRenderer({ w: 80, h: 14 });
    open = handle;
    handle.mount(<Home {...errorProps} />);
    await handle.render();
    const run = findRun(handle.capture(), "npm i -g claude");
    expect(run).toBeDefined();
    expect(run && extractRgb(run.fg)).toBe<string>(SHELL_PALETTE.amberHi);
  });

  test("an absent agent name renders the neutral empty CLI-not-found line, never an invented fallback", async () => {
    const handle = await createHeadlessRenderer({ w: 80, h: 14 });
    open = handle;
    const noAgentProps: HomeProps = {
      ...errorProps,
      health: { present: false, detail: "agent CLI not found" },
    };
    handle.mount(<Home {...noAgentProps} />);
    await handle.render();
    const frame = handle.capture();
    expect(findRun(frame, "✗ claude")).toBeUndefined();
    expect(findRun(frame, "✗  CLI not found")).toBeDefined();
  });

  test("does not render the idle prompt box", async () => {
    const handle = await createHeadlessRenderer({ w: 80, h: 14 });
    open = handle;
    handle.mount(<Home {...errorProps} />);
    await handle.render();
    expect(findRun(handle.capture(), "describe")).toBeUndefined();
  });

  test("renders the r re-check hint in the faint hue (M15)", async () => {
    const handle = await createHeadlessRenderer({ w: 80, h: 14 });
    open = handle;
    handle.mount(<Home {...errorProps} />);
    await handle.render();
    const run = findRun(handle.capture(), "then reopen, or press r to re-check");
    expect(run).toBeDefined();
    expect(run && extractRgb(run.fg)).toBe<string>(SHELL_PALETTE.faint);
  });

  test("a re-check that flips present:true renders the idle health line instead (M15)", async () => {
    const handle = await createHeadlessRenderer({ w: 80, h: 20 });
    open = handle;
    handle.mount(<Home {...errorProps} width={80} height={20} />);
    await handle.render();
    expect(findRun(handle.capture(), "✗ claude CLI not found")).toBeDefined();

    handle.mount(<Home {...baseProps} />);
    await handle.render();
    const frame = handle.capture();
    expect(findRun(frame, "✗ claude CLI not found")).toBeUndefined();
    expect(findRun(frame, "● claude 0.34 · agent ready")).toBeDefined();
  });
});
