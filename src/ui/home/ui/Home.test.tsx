import { afterEach, describe, expect, test } from "bun:test";

import type { StyledRun } from "host/protocol";
import { extractRgb } from "host/render/model/color";
import { createHeadlessRenderer } from "host/render/model/renderer";
import type { RenderHandle } from "host/render/types";
import { SHELL_PALETTE } from "ui/theme";

import type { HomeProps } from "../types";
import { homeSubmitAllowed } from "../types";
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

const frameContains = (frame: Frame, needle: string): boolean =>
  findRun(frame, needle) !== undefined;

/**
 * A right-aligned status-bar key hint's rendered state, read off the frame rather than asserted
 * from `StatusBarHintKey` directly — the same "render, then inspect" style every other test in
 * this file already uses. `startsWith`, not `includes`: a hint-key glyph run's text is ALWAYS
 * exactly ` {glyph} ` (`StatusBar.tsx`) or, once coalesced with its same-style label
 * (host/render's adjacent-run merge — see `ui/status-bar/ui/StatusBar.test.tsx`'s own comment on
 * this), ` {glyph}  {label} ` — either way the glyph starts the run. A bare `.includes` would
 * also match a status-bar HINT BADGE whose free-text body happens to embed ` {glyph} `
 * mid-sentence (e.g. "checking claude — ⏎ disabled") — a real collision this file's own
 * `checking` frame produces.
 */
function hintKeyState(frame: Frame, glyph: string): "dis" | "active" | "plain" | undefined {
  const run = frame.rows.flat().find((r) => r.text.startsWith(` ${glyph} `));
  if (run === undefined) return undefined;
  const fg = extractRgb(run.fg);
  if (fg === SHELL_PALETTE.faint) return "dis";
  if (fg === SHELL_PALETTE.bg) return "active";
  return "plain";
}

const BOLD = 0b1;

const baseProps: HomeProps = {
  id: "home",
  width: 80,
  height: 20,
  health: { kind: "ready", agent: "claude" },
  prompt: "",
  combo: { agent: "claude", model: "sonnet-4.5", effort: "high" },
};

/** Renders `Home` with `baseProps` plus overrides and returns the captured frame. */
async function renderHome(overrides: Partial<HomeProps> = {}): Promise<Frame> {
  const props: HomeProps = { ...baseProps, ...overrides };
  const handle = await createHeadlessRenderer({ w: props.width, h: props.height });
  open = handle;
  handle.mount(<Home {...props} />);
  await handle.render();
  return handle.capture();
}

describe("Home screen — idle (design home(), design/01-home.dc.html)", () => {
  test("renders the logo in bold amber", async () => {
    const frame = await renderHome();
    const run = findRun(frame, "termcraft");
    expect(run && extractRgb(run.fg)).toBe<string>(SHELL_PALETTE.amber);
    expect((run?.attrs ?? 0) & BOLD).toBe(BOLD);
  });

  test("renders the tagline dim", async () => {
    const frame = await renderHome();
    const run = findRun(frame, "design terminal UIs by describing them");
    expect(run && extractRgb(run.fg)).toBe<string>(SHELL_PALETTE.dim);
  });

  test("an empty prompt shows the faint placeholder", async () => {
    const frame = await renderHome();
    const run = findRun(frame, "Describe the TUI you want to design");
    expect(run).toBeDefined();
    expect(run && extractRgb(run.fg)).toBe<string>(SHELL_PALETTE.faint);
  });

  test("a non-empty prompt replaces the placeholder", async () => {
    const frame = await renderHome({ prompt: "a kanban board with three columns" });
    expect(findRun(frame, "a kanban board with three columns")).toBeDefined();
    expect(findRun(frame, "Describe the TUI you want to design")).toBeUndefined();
  });

  test("renders the agent/model/effort combo values in bold amberHi", async () => {
    const frame = await renderHome();
    for (const value of ["‹claude›", "‹sonnet-4.5›", "‹high›"]) {
      const run = findRun(frame, value);
      expect(run && extractRgb(run.fg)).toBe<string>(SHELL_PALETTE.amberHi);
      expect((run?.attrs ?? 0) & BOLD).toBe(BOLD);
    }
  });

  // finding §2.7, phase-8 Task 15: the old "● {agent} · agent ready" health line is gone —
  // `home()` (design/termcraft-engine.js:135-163) never drew one, and it was the single
  // assertion that was FALSE for the whole time a probe ran. See the "five health outcomes"
  // describe block below for the replacement coverage.
  test("a ready outcome renders no health line at all", async () => {
    const frame = await renderHome();
    expect(frameContains(frame, "agent ready")).toBe(false);
    expect(frameContains(frame, "●")).toBe(false);
  });

  // phase-8 Task 11 / WP-10: Home had no status bar at all before this — design
  // `home()`/`design/termcraft-engine.js:144-145` draws one; this reproduces its segments
  // through the existing `ui/status-bar` component.
  test("renders a HOME status bar naming the /exit hint, not q quit (WP-10 divergence)", async () => {
    const frame = await renderHome();
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

  test("the ⏎ create hint key is plain (not dis) on a ready outcome", async () => {
    const frame = await renderHome();
    expect(hintKeyState(frame, "⏎")).toBe("plain");
  });

  // Design home() :152 — `· / model`, faint, only when the combo row leaves room.
  test("shows the · / model hint when the combo row fits it", async () => {
    const frame = await renderHome();
    const run = findRun(frame, "· / model");
    expect(run).toBeDefined();
    expect(run && extractRgb(run.fg)).toBe<string>(SHELL_PALETTE.faint);
  });
});

describe("Home screen — checking outcome (design home('checking'), :139-161)", () => {
  const checkingHealth: HomeProps["health"] = { kind: "checking", agent: "claude" };

  test("⏎ create drops to faint and gains a live spinner note", async () => {
    const frame = await renderHome({ health: checkingHealth });
    const createHint = findRun(frame, "⏎ create");
    expect(createHint).toBeDefined();
    expect(createHint && extractRgb(createHint.fg)).toBe<string>(SHELL_PALETTE.faint);
    const note = findRun(frame, "checking claude — up to 20s");
    expect(note).toBeDefined();
    expect(note && extractRgb(note.fg)).toBe<string>(SHELL_PALETTE.amberDim);
    // The spinner's frame-0 glyph (`ui/spinner`'s own phase-shift keeps it pixel-identical to
    // the design's static `⠹`).
    expect(findRun(frame, "⠹ checking claude")).toBeDefined();
  });

  test("the prompt box itself stays live (unlike blocked) — title amberHi, cursor shown", async () => {
    const frame = await renderHome({ health: checkingHealth });
    const title = findRun(frame, "describe");
    expect(title && extractRgb(title.fg)).toBe<string>(SHELL_PALETTE.amberHi);
    expect(findRun(frame, "█")).toBeDefined();
  });

  test("renders no health panel (checking is not blocked/advisory)", async () => {
    const frame = await renderHome({ health: checkingHealth });
    expect(frameContains(frame, "not signed in")).toBe(false);
    expect(frameContains(frame, "health unconfirmed")).toBe(false);
  });
});

describe("Home screen — blocked outcome (design homeHealth('login'), :165-195)", () => {
  const blockedHealth: HomeProps["health"] = {
    kind: "blocked",
    agent: "claude",
    detail: "claude found · not signed in",
  };

  test("dims the shared prompt box: border color, dim title, faint caret, no cursor", async () => {
    const frame = await renderHome({ health: blockedHealth });
    const border = findRun(frame, "╭─");
    expect(border && extractRgb(border.fg)).toBe<string>(SHELL_PALETTE.border);
    const title = findRun(frame, "describe");
    expect(title && extractRgb(title.fg)).toBe<string>(SHELL_PALETTE.dim);
    // Exact match, not `.includes`: the LOGO ("❯ termcraft") also starts with "❯ " and renders
    // earlier in the frame, so a substring search would find the wrong run.
    const caret = frame.rows.flat().find((run) => run.text === "❯ ");
    expect(caret && extractRgb(caret.fg)).toBe<string>(SHELL_PALETTE.faint);
    expect(frameContains(frame, "█")).toBe(false);
  });

  test("⏎ create drops to faint, and the health panel renders in red", async () => {
    const frame = await renderHome({ health: blockedHealth });
    const createHint = findRun(frame, "⏎ create");
    expect(createHint && extractRgb(createHint.fg)).toBe<string>(SHELL_PALETTE.faint);
    const headline = findRun(frame, "✗ claude found · not signed in");
    expect(headline).toBeDefined();
    expect(headline && extractRgb(headline.fg)).toBe<string>(SHELL_PALETTE.red);
    expect((headline?.attrs ?? 0) & BOLD).toBe(BOLD);
    expect(findRun(frame, "run claude login, then r to re-check")).toBeDefined();
    expect(findRun(frame, "⏎ stays refused until the probe passes")).toBeDefined();
  });

  test("the ⏎ hint key is dis, and r re-check joins the status bar", async () => {
    const frame = await renderHome({ health: blockedHealth });
    expect(hintKeyState(frame, "⏎")).toBe("dis");
    expect(homeSubmitAllowed(blockedHealth)).toBe(false);
    const reCheck = frame.rows.flat().find((run) => run.text.startsWith(" r "));
    expect(reCheck).toBeDefined();
  });
});

describe("Home screen — advisory outcome (design homeHealth('shutdown'|'sandbox'), :180-187)", () => {
  const shutdownHealth: HomeProps["health"] = {
    kind: "advisory",
    agent: "claude",
    panel: "shutdown",
    detail: "claude exited without confirming shutdown",
  };
  const sandboxHealth: HomeProps["health"] = {
    kind: "advisory",
    agent: "claude",
    panel: "sandbox",
    detail: "sandbox unavailable — claude runs unconfined",
  };

  test("shutdown renders the health-unconfirmed panel in amber, submit stays allowed", async () => {
    const frame = await renderHome({ health: shutdownHealth });
    const headline = findRun(frame, "⚠ claude exited without confirming shutdown");
    expect(headline).toBeDefined();
    expect(headline && extractRgb(headline.fg)).toBe<string>(SHELL_PALETTE.amberHi);
    expect(findRun(frame, "version read · health unproven")).toBeDefined();
    expect(findRun(frame, "⏎ works — the first turn may still fail")).toBeDefined();
    expect(homeSubmitAllowed(shutdownHealth)).toBe(true);
    expect(hintKeyState(frame, "⏎")).toBe("plain");
  });

  test("sandbox renders its own panel copy, submit stays allowed", async () => {
    const frame = await renderHome({ health: sandboxHealth });
    const headline = findRun(frame, "⚠ sandbox unavailable — claude runs unconfined");
    expect(headline).toBeDefined();
    expect(findRun(frame, "writes are not contained to this folder")).toBeDefined();
    expect(findRun(frame, "⏎ works — designing is unaffected")).toBeDefined();
    expect(homeSubmitAllowed(sandboxHealth)).toBe(true);
  });

  test("the prompt box stays live (advisory is not blocking) — title amberHi, cursor shown", async () => {
    const frame = await renderHome({ health: shutdownHealth });
    const title = findRun(frame, "describe");
    expect(title && extractRgb(title.fg)).toBe<string>(SHELL_PALETTE.amberHi);
    expect(frameContains(frame, "█")).toBe(true);
  });

  test("advisory gets no r re-check hint (keymap.ts wires r only for blocked)", async () => {
    const frame = await renderHome({ health: shutdownHealth });
    const reCheck = frame.rows.flat().find((run) => run.text.startsWith(" r "));
    expect(reCheck).toBeUndefined();
  });
});

describe("Home screen — agent-missing error (design homeErr(), screen 12 err-agent-80)", () => {
  const errorProps: Partial<HomeProps> = {
    width: 80,
    height: 14,
    health: { kind: "missing", agent: "claude", detail: "claude CLI not found" },
  };

  test("renders the CLI-not-found line in bold red", async () => {
    const frame = await renderHome(errorProps);
    const run = findRun(frame, "✗ claude CLI not found");
    expect(run).toBeDefined();
    expect(run && extractRgb(run.fg)).toBe<string>(SHELL_PALETTE.red);
    expect((run?.attrs ?? 0) & BOLD).toBe(BOLD);
  });

  test("renders the install hint driven by the agent name, not a hardcoded package", async () => {
    const frame = await renderHome(errorProps);
    const run = findRun(frame, "npm i -g claude");
    expect(run).toBeDefined();
    expect(run && extractRgb(run.fg)).toBe<string>(SHELL_PALETTE.amberHi);
  });

  test("the headline renders the probe's own detail verbatim, never re-synthesized (WP-5)", async () => {
    const frame = await renderHome({
      ...errorProps,
      health: { kind: "missing", agent: "claude", detail: "agent CLI not found" },
    });
    expect(findRun(frame, "✗ agent CLI not found")).toBeDefined();
    expect(findRun(frame, "✗ claude")).toBeUndefined();
  });

  test("does not render the idle prompt box", async () => {
    const frame = await renderHome(errorProps);
    expect(findRun(frame, "describe")).toBeUndefined();
  });

  test("renders the r re-check hint in the faint hue (M15)", async () => {
    const frame = await renderHome(errorProps);
    const run = findRun(frame, "then reopen, or press r to re-check");
    expect(run).toBeDefined();
    expect(run && extractRgb(run.fg)).toBe<string>(SHELL_PALETTE.faint);
  });

  // phase-8 Task 11 / WP-10: design `homeErr()`'s status bar
  // (`design/termcraft-engine.js:583`) reads `[['r','re-check'],['q','quit']]` verbatim — this
  // screen has no text input, so `q quit` needs no divergence (unlike idle Home's `/exit`).
  test("renders a HOME status bar with the r re-check and q quit hints", async () => {
    const frame = await renderHome(errorProps);
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

  test("a re-check that flips to ready re-renders the live idle prompt (M15)", async () => {
    const missingFrame = await renderHome({ ...errorProps, width: 80, height: 20 });
    expect(findRun(missingFrame, "✗ claude CLI not found")).toBeDefined();

    const readyFrame = await renderHome();
    expect(findRun(readyFrame, "✗ claude CLI not found")).toBeUndefined();
    expect(findRun(readyFrame, "Describe the TUI you want to design")).toBeDefined();
  });
});

describe("Home screen — five health outcomes gate submit (finding §2.7, phase-8 Task 15)", () => {
  test("refuses submit while checking, and says so in the status bar (design :161)", async () => {
    const frame = await renderHome({ health: { kind: "checking", agent: "claude" } });
    expect(frameContains(frame, "⠹ checking claude — ⏎ disabled")).toBe(true);
    expect(hintKeyState(frame, "⏎")).toBe("dis");
    expect(homeSubmitAllowed({ kind: "checking", agent: "claude" })).toBe(false);
  });

  test("shows the login panel below the prompt without seizing the screen (design homeHealth('login'))", async () => {
    const frame = await renderHome({
      health: { kind: "blocked", agent: "claude", detail: "claude found but not logged in" },
    });
    expect(frameContains(frame, "Describe the TUI you want to design…")).toBe(true);
    expect(frameContains(frame, "not signed in")).toBe(true);
    expect(homeSubmitAllowed({ kind: "blocked", agent: "claude", detail: "x" })).toBe(false);
  });

  test("keeps the full-screen takeover only for a missing CLI (design homeErr)", async () => {
    const frame = await renderHome({
      health: { kind: "missing", agent: "claude", detail: "claude CLI not found" },
    });
    expect(frameContains(frame, "Describe the TUI you want to design…")).toBe(false);
    expect(frameContains(frame, "✗ claude CLI not found")).toBe(true);
  });

  test("allows submit on an advisory reading — a timeout proves nothing", () => {
    expect(
      homeSubmitAllowed({ kind: "advisory", agent: "claude", panel: "shutdown", detail: "x" }),
    ).toBe(true);
  });

  test("no longer claims `agent ready` before anything has been probed", async () => {
    const frame = await renderHome({ health: { kind: "checking", agent: "claude" } });
    expect(frameContains(frame, "agent ready")).toBe(false);
  });
});
