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
  health: { present: true, detail: "agent ready", agent: "claude" },
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
    const run = findRun(handle.capture(), "● claude · agent ready");
    expect(run).toBeDefined();
    expect(run && extractRgb(run.fg)).toBe<string>(SHELL_PALETTE.green);
    expect((run?.attrs ?? 0) & BOLD).toBe(BOLD);
  });

  // phase-8 Task 11 / WP-10: Home had no status bar at all before this — design
  // `home()`/`design/termcraft-engine.js:144-145` draws one; this reproduces its segments
  // through the existing `ui/status-bar` component.
  test("renders a HOME status bar naming the /exit hint, not q quit (WP-10 divergence)", async () => {
    const handle = await createHeadlessRenderer({ w: 80, h: 20 });
    open = handle;
    handle.mount(<Home {...baseProps} />);
    await handle.render();
    const frame = handle.capture();
    const mode = findRun(frame, "HOME");
    expect(mode).toBeDefined();
    expect(mode && extractRgb(mode.bg)).toBe<string>(SHELL_PALETTE.amber);
    expect(findRun(frame, "no project yet")).toBeDefined();
    // The live combo, not the design's Codex sample ("gpt5.5 · high").
    expect(findRun(frame, "sonnet-4.5 · high")).toBeDefined();
    expect(findRun(frame, "/exit")).toBeDefined();
    // `q` never appears as its own key-hint glyph on idle Home — it still types (see keymap.ts).
    expect(findRun(frame, " q ")).toBeUndefined();
  });

  test("an absent agent name renders the neutral empty text, never an invented fallback (M22)", async () => {
    const handle = await createHeadlessRenderer({ w: 80, h: 20 });
    open = handle;
    const noAgentProps: HomeProps = {
      ...baseProps,
      health: { present: true, detail: "agent ready" },
    };
    handle.mount(<Home {...noAgentProps} />);
    await handle.render();
    const frame = handle.capture();
    expect(findRun(frame, "● claude")).toBeUndefined();
    expect(findRun(frame, " · agent ready")).toBeDefined();
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

  test("the headline renders the probe's own detail verbatim; an absent agent name still avoids an invented fallback elsewhere (WP-5)", async () => {
    const handle = await createHeadlessRenderer({ w: 80, h: 14 });
    open = handle;
    const noAgentProps: HomeProps = {
      ...errorProps,
      health: { present: false, detail: "agent CLI not found" },
    };
    handle.mount(<Home {...noAgentProps} />);
    await handle.render();
    const frame = handle.capture();
    // The headline is `health.detail` verbatim (WP-5, Home.tsx's own comment on
    // `agent-missing`) — never re-synthesized from `agentName` — so an absent `health.agent`
    // cannot make the HEADLINE invent one either.
    expect(findRun(frame, "✗ agent CLI not found")).toBeDefined();
    expect(findRun(frame, "✗ claude")).toBeUndefined();
    // The other two lines DO still derive from `agentName` (`neutralAgentName`) — this is
    // where the "never an invented fallback" guarantee still lives.
    expect(findRun(frame, "termcraft needs the  agent on your PATH.")).toBeDefined();
  });

  test("distinguishes the three not-present reasons via the probe's own detail text, not a single hardcoded string (WP-5)", async () => {
    const reasons = [
      "claude CLI not found",
      "claude CLI found but not logged in",
      "claude exited without confirming shutdown; locked out until restarted",
    ];
    for (const detail of reasons) {
      const handle = await createHeadlessRenderer({ w: 80, h: 14 });
      handle.mount(<Home {...errorProps} health={{ present: false, detail, agent: "claude" }} />);
      await handle.render();
      expect(findRun(handle.capture(), `✗ ${detail}`)).toBeDefined();
      handle.destroy();
    }
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

  // phase-8 Task 11 / WP-10: design `homeErr()`'s status bar
  // (`design/termcraft-engine.js:583`) reads `[['r','re-check'],['q','quit']]` verbatim — this
  // screen has no text input, so `q quit` needs no divergence (unlike idle Home's `/exit`).
  test("renders a HOME status bar with the r re-check and q quit hints", async () => {
    const handle = await createHeadlessRenderer({ w: 80, h: 14 });
    open = handle;
    handle.mount(<Home {...errorProps} />);
    await handle.render();
    const frame = handle.capture();
    const mode = findRun(frame, "HOME");
    expect(mode).toBeDefined();
    expect(mode && extractRgb(mode.bg)).toBe<string>(SHELL_PALETTE.amber);
    // The panel headline AND the status-bar badge both render the same honest detail text
    // (two separate runs — the panel and the status bar are different chrome).
    const badgeRuns = frame.rows.flat().filter((r) => r.text.includes("✗ claude CLI not found"));
    expect(badgeRuns).toHaveLength(2);
    expect(extractRgb(badgeRuns[1]!.bg)).toBe<string>(SHELL_PALETTE.red);
    expect(findRun(frame, " re-check ")).toBeDefined();
    expect(findRun(frame, " quit ")).toBeDefined();
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
    expect(findRun(frame, "● claude · agent ready")).toBeDefined();
  });
});
