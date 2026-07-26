import { afterEach, describe, expect, test } from "bun:test";

import type { StyledRun } from "host/protocol";
import { extractRgb } from "host/render/model/color";
import { createHeadlessRenderer } from "host/render/model/renderer";
import type { RenderHandle } from "host/render/types";
import type { ScoredSlashRow } from "ui/actions";
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

/** The row index (top-to-bottom) of the first row containing `needle`, or -1. */
const rowIndexOf = (frame: Frame, needle: string): number =>
  frame.rows.findIndex((row) => row.some((run) => run.text.includes(needle)));

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
  rows: [],
  selectedIndex: -1,
};

// §3.10, phase-8 Task 17: the exact two rows `filterSlashRows("/", {..., screen: "home"})`
// produces — pinned by hand here (not imported from `ui/actions`) so this file tests Home's OWN
// rendering of whatever rows it is given, independent of the registry's own filtering logic
// (covered separately by `ui/actions/model/registry.test.ts`).
const HOME_SLASH_ROWS: readonly ScoredSlashRow[] = [
  {
    command: {
      cmd: "/model",
      desc: "agent · model · effort",
      order: 4,
      capability: "model.select",
      screens: ["workspace", "home"],
    },
    state: { visible: true, availability: "unavailable", hint: { code: "CAPABILITY_UNAVAILABLE" } },
  },
  {
    command: {
      cmd: "/exit",
      desc: "quit termcraft",
      order: 8,
      capability: null,
      screens: ["workspace", "home"],
    },
    state: { visible: true, availability: "available", hint: null },
  },
];

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
  // `home()`/`design/termcraft-engine.js:161` (CORRECTED fix round 2, was miscited `:144-145`,
  // the caret draw and the `typed` ternary — see `Home.tsx`'s own `homeIdleHintKeys` for the
  // fix round 1 correction of this exact citation) draws one; this reproduces its segments
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

describe("Home screen — slash menu (§3.10, design/23-slash-menu.dc.html, phase-8 Task 17)", () => {
  test("renders nothing extra when rows is empty — the menu simply does not open", async () => {
    const frame = await renderHome({ prompt: "/zzz" });
    expect(frameContains(frame, "commands")).toBe(false);
    expect(frameContains(frame, "/model")).toBe(false);
    // Not a bare "/exit" check — the status bar's own `/exit  quit` hint (`homeIdleHintKeys`)
    // legitimately contains that substring regardless of the menu; the row's DESCRIPTION text
    // is what only the slash box itself would ever render.
    expect(frameContains(frame, "quit termcraft")).toBe(false);
  });

  test("renders the given rows, below the combo row, once open", async () => {
    const frame = await renderHome({ prompt: "/", rows: HOME_SLASH_ROWS, selectedIndex: 1 });
    expect(findRun(frame, "/model")).toBeDefined();
    expect(findRun(frame, "/exit")).toBeDefined();
    // design/23-slash-menu.dc.html: anchored BELOW the whole bordered "describe" block, which in
    // the design's own absolute canvas already contains the combo selectors near its bottom row
    // (`home()`, `termcraft-engine.js:149-151` draws them at `iy+4`, still inside the box's
    // `iy..iy+5` span) — so the menu's rows render on a LATER screen row than the combo values.
    const comboRow = rowIndexOf(frame, "sonnet-4.5");
    const modelRow = rowIndexOf(frame, "/model");
    expect(comboRow).toBeGreaterThanOrEqual(0);
    expect(modelRow).toBeGreaterThan(comboRow);
  });

  test("/model shows the design's own unavailable styling; /exit is the one selectable row", async () => {
    const frame = await renderHome({ prompt: "/", rows: HOME_SLASH_ROWS, selectedIndex: 1 });
    const modelCmd = findRun(frame, "/model");
    expect(modelCmd && extractRgb(modelCmd.fg)).toBe<string>(SHELL_PALETTE.faint);
    const exitCmd = findRun(frame, "/exit");
    // Selected (index 1, matching firstEnabledIndex skipping the unavailable /model row).
    expect(exitCmd && extractRgb(exitCmd.fg)).toBe<string>(SHELL_PALETTE.selFg);
  });

  // Review fix round 1 (Minor): pins the ACTUAL text drawn, not just its color. Design's own
  // literal reason (`termcraft-engine.js:943`, `'v1.0 — not in this build'`) cannot survive
  // through `UnavailableReason` (`registry.ts`'s own documented divergence, `slashRowState`) —
  // this asserts the row renders the generic `CAPABILITY_UNAVAILABLE` label instead of either
  // the unreachable design string OR its own normal description.
  test("pins /model's rendered reason as the generic 'unavailable' label, replacing its description", async () => {
    const frame = await renderHome({ prompt: "/", rows: HOME_SLASH_ROWS, selectedIndex: 1 });
    const modelRowIndex = rowIndexOf(frame, "/model");
    expect(modelRowIndex).toBeGreaterThanOrEqual(0);
    const modelRowText = frame.rows[modelRowIndex]?.map((run) => run.text).join("") ?? "";
    expect(modelRowText).toContain("unavailable");
    expect(modelRowText).not.toContain("agent · model · effort");
    expect(modelRowText).not.toContain("v1.0 — not in this build");
  });

  test("does not render the slash menu on the agent-missing full-screen takeover", async () => {
    // `HomeAgentMissing` never receives `rows` at all (its own props type has no such field) —
    // this pins that the menu cannot appear there even if the caller passed non-empty rows.
    const frame = await renderHome({
      health: { kind: "missing", agent: "claude", detail: "claude CLI not found" },
      rows: HOME_SLASH_ROWS,
      selectedIndex: 1,
    });
    expect(frameContains(frame, "/model")).toBe(false);
    expect(frameContains(frame, "commands")).toBe(false);
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

describe("Home screen — blocked/login outcome (design homeHealth('login'), :165-195)", () => {
  const blockedHealth: HomeProps["health"] = {
    kind: "blocked",
    agent: "claude",
    panel: "login",
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

  // fix round 1, Finding 5: the status-bar badge (design `:191`) and the `r re-check` hint key
  // (design `:194`) both belong to `blocked`.
  test("the ⏎ hint key is dis, r re-check joins the status bar, and the red badge shows", async () => {
    const frame = await renderHome({ health: blockedHealth });
    expect(hintKeyState(frame, "⏎")).toBe("dis");
    expect(homeSubmitAllowed(blockedHealth)).toBe(false);
    const reCheck = frame.rows.flat().find((run) => run.text.startsWith(" r "));
    expect(reCheck).toBeDefined();
    const badge = findRun(frame, "✗ claude not signed in");
    expect(badge).toBeDefined();
    expect(badge && extractRgb(badge.fg)).toBe<string>(SHELL_PALETTE.bg);
    expect(badge && extractRgb(badge.bg)).toBe<string>(SHELL_PALETTE.red);
  });
});

// fix round 1, Finding 3: `blocked/latched` has no design mock — the backend's own confirmed
// unconfirmed-exit lockout, told apart from `blocked/login` by `panel`. Closest faithful mapping
// of design's `login` panel shape, with honest, undesigned wording (`HomeHealthPanel.tsx`'s own
// divergence comment).
describe("Home screen — blocked/latched outcome (no design mock, fix round 1 Finding 3)", () => {
  const latchedHealth: HomeProps["health"] = {
    kind: "blocked",
    agent: "claude",
    panel: "latched",
    detail: "claude exited without confirming shutdown; locked out until restarted",
  };

  test("renders honest lockout wording, never the login panel's copy", async () => {
    const frame = await renderHome({ health: latchedHealth });
    // This detail is long enough to word-wrap inside the panel at the test's default 80-column
    // width (verified by inspection) — the wrap is graceful, faithful rendering of real text
    // (never truncated/fabricated), so the assertion below checks the un-wrapped prefix that is
    // guaranteed to stay in the FIRST run rather than the full string.
    const headline = findRun(frame, "✗ claude exited without confirming shutdown");
    expect(headline).toBeDefined();
    expect(headline && extractRgb(headline.fg)).toBe<string>(SHELL_PALETTE.red);
    expect(frameContains(frame, "restarted")).toBe(true);
    expect(findRun(frame, "restart termcraft to clear the lockout")).toBeDefined();
    expect(findRun(frame, "⏎ stays refused until you restart")).toBeDefined();
    // Never the login-panel's own copy — it would be actively wrong advice for this cause.
    expect(frameContains(frame, "run claude login")).toBe(false);
  });

  test('submit is refused and the status-bar badge names the lockout, not "not signed in"', async () => {
    const frame = await renderHome({ health: latchedHealth });
    expect(homeSubmitAllowed(latchedHealth)).toBe(false);
    expect(hintKeyState(frame, "⏎")).toBe("dis");
    const badge = findRun(frame, "✗ claude locked out");
    expect(badge).toBeDefined();
    expect(frameContains(frame, "not signed in")).toBe(false);
  });
});

describe("Home screen — advisory outcome (design homeHealth('shutdown'|'sandbox'), :180-187)", () => {
  // fix round 1, Finding 3: this detail now names the genuinely UNPROVEN case (the probe itself
  // reached no verdict) — "exited without confirming shutdown" is `blocked/latched`'s own
  // wording now (a confirmed lockout), not advisory's.
  const shutdownHealth: HomeProps["health"] = {
    kind: "advisory",
    agent: "claude",
    panel: "shutdown",
    detail: "claude's health probe ended without a confirmed verdict",
  };
  const sandboxHealth: HomeProps["health"] = {
    kind: "advisory",
    agent: "claude",
    panel: "sandbox",
    detail: "sandbox unavailable — claude runs unconfined",
  };

  test("shutdown renders the health-unconfirmed panel in amber, submit stays allowed", async () => {
    const frame = await renderHome({ health: shutdownHealth });
    const headline = findRun(frame, "⚠ claude's health probe ended without a confirmed verdict");
    expect(headline).toBeDefined();
    expect(headline && extractRgb(headline.fg)).toBe<string>(SHELL_PALETTE.amberHi);
    // CORRECTED (fix round 1, Finding 4): never "version read" — this runtime reads no version.
    expect(findRun(frame, "no confirmed verdict — health unproven")).toBeDefined();
    expect(frameContains(frame, "version read")).toBe(false);
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

  // fix round 1, Finding 5: the status-bar badge IS shown for advisory (design `:192`), but no
  // `r` hint key (keymap.ts wires no `r` handler for advisory — Finding 6's own reasoning: its
  // prompt stays genuinely live, so a bare `r` would steal a typed character).
  test("shows the ⚠ health unconfirmed badge but no r re-check hint", async () => {
    const frame = await renderHome({ health: shutdownHealth });
    const badge = findRun(frame, "⚠ health unconfirmed");
    expect(badge).toBeDefined();
    expect(badge && extractRgb(badge.fg)).toBe<string>(SHELL_PALETTE.amberHi);
    expect(badge && extractRgb(badge.bg)).toBe<string>(SHELL_PALETTE.line);
    const reCheck = frame.rows.flat().find((run) => run.text.startsWith(" r "));
    expect(reCheck).toBeUndefined();
  });

  test("sandbox shows the ⚠ sandbox degraded badge", async () => {
    const frame = await renderHome({ health: sandboxHealth });
    const badge = findRun(frame, "⚠ sandbox degraded");
    expect(badge).toBeDefined();
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

  // phase-8 Task 11 / WP-10: design `homeErr()`'s status bar (`design/termcraft-engine.js:727`
  // — CORRECTED fix round 2, was miscited `:583`, a chat-colour branch inside `chatSeq()`
  // unrelated to Home — see `keymap.ts`'s own fix round 1 correction of this exact citation)
  // reads `[['r','re-check'],['q','quit']]` verbatim — this screen has no text input, so `q
  // quit` needs no divergence (unlike idle Home's `/exit`).
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
      health: {
        kind: "blocked",
        agent: "claude",
        panel: "login",
        detail: "claude found but not logged in",
      },
    });
    expect(frameContains(frame, "Describe the TUI you want to design…")).toBe(true);
    expect(frameContains(frame, "not signed in")).toBe(true);
    expect(
      homeSubmitAllowed({ kind: "blocked", agent: "claude", panel: "login", detail: "x" }),
    ).toBe(false);
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
