import { describe, expect, test } from "bun:test";

import type { HomeAgentHealth } from "ui/home";

import type { KeyContext, KeyLike } from "./keymap";
import { resolveActiveOverlay, resolveKey } from "./keymap";

const key = (over: Partial<KeyLike>): KeyLike => ({ name: "", ctrl: false, sequence: "", ...over });
const READY_HEALTH: HomeAgentHealth = { kind: "ready", agent: "claude" };
const ctx = (over: Partial<KeyContext>): KeyContext => ({
  screen: "workspace",
  focus: "composer",
  overlay: null,
  composerValue: "",
  homeHealth: READY_HEALTH,
  turnRunning: false,
  ...over,
});

describe("resolveKey — global keys (design §3.8)", () => {
  test("Escape -> esc from any screen/focus", () => {
    expect(resolveKey(key({ name: "escape" }), ctx({ screen: "home" }))).toEqual({ kind: "esc" });
    expect(resolveKey(key({ name: "escape" }), ctx({ focus: "preview" }))).toEqual({ kind: "esc" });
  });

  test("F2 -> fullscreen even while the composer is focused", () => {
    expect(resolveKey(key({ name: "f2" }), ctx({ focus: "composer" }))).toEqual({
      kind: "action-execute",
      actionId: "preview.fullscreen",
    });
  });

  test("Ctrl+E -> export", () => {
    expect(resolveKey(key({ name: "e", ctrl: true, sequence: "\x05" }), ctx({}))).toEqual({
      kind: "action-execute",
      actionId: "export.start",
    });
  });

  test("F3/F4/Ctrl+P remain known but inert", () => {
    expect(resolveKey(key({ name: "f3" }), ctx({}))).toEqual({ kind: "none" });
    expect(resolveKey(key({ name: "f4" }), ctx({}))).toEqual({ kind: "none" });
    expect(resolveKey(key({ name: "p", ctrl: true, sequence: "\x10" }), ctx({}))).toEqual({
      kind: "none",
    });
  });
});

describe("resolveKey — Home", () => {
  test("printable chars feed the prompt", () => {
    expect(resolveKey(key({ name: "a", sequence: "a" }), ctx({ screen: "home" }))).toEqual({
      kind: "home-input",
      ch: "a",
    });
  });

  test("Enter submits, Backspace deletes", () => {
    expect(resolveKey(key({ name: "return" }), ctx({ screen: "home" }))).toEqual({
      kind: "home-submit",
    });
    expect(resolveKey(key({ name: "backspace" }), ctx({ screen: "home" }))).toEqual({
      kind: "home-backspace",
    });
  });

  test("Tab on Home does nothing", () => {
    expect(resolveKey(key({ name: "tab" }), ctx({ screen: "home" }))).toEqual({ kind: "none" });
  });

  test("r re-checks agent health on the missing-agent error screen (M15)", () => {
    expect(
      resolveKey(
        key({ name: "r", sequence: "r" }),
        ctx({ screen: "home", homeHealth: { kind: "missing", agent: "claude", detail: "x" } }),
      ),
    ).toEqual({ kind: "home-recheck" });
  });

  test("r still types into the idle Home prompt when the agent is ready", () => {
    expect(
      resolveKey(
        key({ name: "r", sequence: "r" }),
        ctx({ screen: "home", homeHealth: READY_HEALTH }),
      ),
    ).toEqual({ kind: "home-input", ch: "r" });
  });

  test("on the missing-agent error panel, only r and q are live — no submit/backspace/input affordance exists there", () => {
    const missingAgent = ctx({
      screen: "home",
      homeHealth: { kind: "missing", agent: "claude", detail: "x" },
    });
    expect(resolveKey(key({ name: "return" }), missingAgent)).toEqual({ kind: "none" });
    expect(resolveKey(key({ name: "backspace" }), missingAgent)).toEqual({ kind: "none" });
    expect(resolveKey(key({ name: "x", sequence: "x" }), missingAgent)).toEqual({ kind: "none" });
    expect(resolveKey(key({ name: "r", sequence: "r" }), missingAgent)).toEqual({
      kind: "home-recheck",
    });
    expect(resolveKey(key({ name: "q", sequence: "q" }), missingAgent)).toEqual({ kind: "exit" });
  });

  // WP-10 (phase-8, master spec §3.9/§9): design's homeErr() status bar reads
  // `[['r','re-check'],['q','quit']]` (design/termcraft-engine.js:583) — `q` belongs beside `r`.
  test("q quits on the agent-missing panel, where no prompt is focused", () => {
    const intent = resolveKey(
      key({ name: "q", sequence: "q" }),
      ctx({ screen: "home", homeHealth: { kind: "missing", agent: "claude", detail: "x" } }),
    );
    expect(intent).toEqual({ kind: "exit" });
  });

  test("q still types on the idle Home prompt", () => {
    const intent = resolveKey(
      key({ name: "q", sequence: "q" }),
      ctx({ screen: "home", homeHealth: READY_HEALTH }),
    );
    expect(intent.kind).not.toBe("exit");
  });

  // finding §2.7 (phase-8 Task 15): the five health outcomes gate Enter directly through
  // `homeSubmitAllowed`, not through a `missing`-only branch.
  describe("Enter gating across the five health outcomes", () => {
    test("checking refuses Enter — the probe hasn't resolved yet", () => {
      const checking = ctx({ screen: "home", homeHealth: { kind: "checking", agent: "claude" } });
      expect(resolveKey(key({ name: "return" }), checking)).toEqual({ kind: "none" });
    });

    // CORRECTED (fix round 1, Finding 6): `blocked` used to still accept typed input despite
    // reading as visually disabled (dimmed box, no cursor — design `homeHealth('login')`
    // `:170-173`), so `r` silently stole a printable character from anything typed. It is now
    // fully input-inert, like `missing` — matching its own appearance.
    test("blocked refuses Enter and is input-inert — only r/q are live, matching its dimmed appearance", () => {
      const blocked = ctx({
        screen: "home",
        homeHealth: { kind: "blocked", agent: "claude", panel: "login", detail: "x" },
      });
      expect(resolveKey(key({ name: "return" }), blocked)).toEqual({ kind: "none" });
      expect(resolveKey(key({ name: "x", sequence: "x" }), blocked)).toEqual({ kind: "none" });
      expect(resolveKey(key({ name: "backspace" }), blocked)).toEqual({ kind: "none" });
      expect(resolveKey(key({ name: "r", sequence: "r" }), blocked)).toEqual({
        kind: "home-recheck",
      });
      expect(resolveKey(key({ name: "q", sequence: "q" }), blocked)).toEqual({ kind: "exit" });
    });

    test("blocked/latched is input-inert the same way as blocked/login", () => {
      const latched = ctx({
        screen: "home",
        homeHealth: { kind: "blocked", agent: "claude", panel: "latched", detail: "x" },
      });
      expect(resolveKey(key({ name: "x", sequence: "x" }), latched)).toEqual({ kind: "none" });
      expect(resolveKey(key({ name: "r", sequence: "r" }), latched)).toEqual({
        kind: "home-recheck",
      });
    });

    test("r types into the prompt on checking/advisory/ready — only blocked wires it to re-check", () => {
      const checking = ctx({ screen: "home", homeHealth: { kind: "checking", agent: "claude" } });
      const advisory = ctx({
        screen: "home",
        homeHealth: { kind: "advisory", agent: "claude", panel: "shutdown", detail: "x" },
      });
      expect(resolveKey(key({ name: "r", sequence: "r" }), checking)).toEqual({
        kind: "home-input",
        ch: "r",
      });
      expect(resolveKey(key({ name: "r", sequence: "r" }), advisory)).toEqual({
        kind: "home-input",
        ch: "r",
      });
    });

    // finding §2.7, fix round 1 Finding 6: advisory's prompt stays genuinely live (design draws
    // its own blinking cursor for it too, `:173`), so `q` must still type into it — only
    // `blocked`/`missing`, whose prompts are genuinely disabled, get the literal `q`-quits key.
    test("q types into the prompt on checking/advisory/ready — only blocked/missing bind it to quit", () => {
      const advisory = ctx({
        screen: "home",
        homeHealth: { kind: "advisory", agent: "claude", panel: "sandbox", detail: "x" },
      });
      expect(resolveKey(key({ name: "q", sequence: "q" }), advisory)).toEqual({
        kind: "home-input",
        ch: "q",
      });
    });

    test("advisory allows Enter — a timeout/degraded reading proves nothing that blocks submit", () => {
      const advisory = ctx({
        screen: "home",
        homeHealth: { kind: "advisory", agent: "claude", panel: "sandbox", detail: "x" },
      });
      expect(resolveKey(key({ name: "return" }), advisory)).toEqual({ kind: "home-submit" });
    });

    test("ready allows Enter", () => {
      const ready = ctx({ screen: "home", homeHealth: READY_HEALTH });
      expect(resolveKey(key({ name: "return" }), ready)).toEqual({ kind: "home-submit" });
    });
  });
});

describe("resolveKey — too-small-terminal (enlarge)", () => {
  // design `termSmall()` (design/termcraft-engine.js:610-615): four centered lines, no chrome,
  // no input of any kind — q quits (phase-8 WP-10) since there is nothing to type into.
  test("q quits on the too-small-terminal screen", () => {
    expect(resolveKey(key({ name: "q", sequence: "q" }), ctx({ screen: "enlarge" }))).toEqual({
      kind: "exit",
    });
  });

  test("every other key is inert on the too-small-terminal screen", () => {
    const small = ctx({ screen: "enlarge" });
    expect(resolveKey(key({ name: "return" }), small)).toEqual({ kind: "none" });
    expect(resolveKey(key({ name: "x", sequence: "x" }), small)).toEqual({ kind: "none" });
    expect(resolveKey(key({ name: "tab" }), small)).toEqual({ kind: "none" });
  });

  test("Escape and known hotkeys still resolve on the too-small-terminal screen", () => {
    expect(resolveKey(key({ name: "escape" }), ctx({ screen: "enlarge" }))).toEqual({
      kind: "esc",
    });
    expect(resolveKey(key({ name: "f2" }), ctx({ screen: "enlarge" }))).toEqual({
      kind: "action-execute",
      actionId: "preview.fullscreen",
    });
  });
});

describe("resolveKey — Workspace composer", () => {
  test("printable chars feed the composer when it is focused", () => {
    expect(resolveKey(key({ name: "x", sequence: "x" }), ctx({}))).toEqual({
      kind: "composer-input",
      ch: "x",
    });
  });

  test("Enter submits the composer", () => {
    expect(resolveKey(key({ name: "return" }), ctx({}))).toEqual({ kind: "composer-submit" });
  });

  test("Tab cycles focus", () => {
    expect(resolveKey(key({ name: "tab" }), ctx({}))).toEqual({ kind: "tab" });
  });

  test("no composer input while the preview is focused", () => {
    expect(resolveKey(key({ name: "x", sequence: "x" }), ctx({ focus: "preview" }))).toEqual({
      kind: "none",
    });
  });

  test("no composer input while an overlay is open", () => {
    expect(resolveKey(key({ name: "x", sequence: "x" }), ctx({ overlay: "chat-list" }))).toEqual({
      kind: "none",
    });
  });

  test("a control byte is not treated as printable", () => {
    expect(resolveKey(key({ name: "up", sequence: "\x1b[A" }), ctx({}))).toEqual({ kind: "none" });
  });

  test("read-only never routes composer editing or submit", () => {
    expect(resolveKey(key({ name: "x", sequence: "x" }), ctx({ screen: "read-only" }))).toEqual({
      kind: "none",
    });
    expect(resolveKey(key({ name: "enter" }), ctx({ screen: "read-only" }))).toEqual({
      kind: "none",
    });
  });

  test("composer input and Enter-submit are inert while a turn is running, matching the disabled composer", () => {
    expect(resolveKey(key({ name: "x", sequence: "x" }), ctx({ turnRunning: true }))).toEqual({
      kind: "none",
    });
    expect(resolveKey(key({ name: "return" }), ctx({ turnRunning: true }))).toEqual({
      kind: "none",
    });
    expect(resolveKey(key({ name: "backspace" }), ctx({ turnRunning: true }))).toEqual({
      kind: "none",
    });
  });
});

describe("resolveKey — slash menu", () => {
  test("/ opens the menu only from an empty focused workspace composer", () => {
    expect(resolveKey(key({ sequence: "/", name: "/" }), ctx({}))).toEqual({
      kind: "slash-open",
    });
    expect(resolveKey(key({ sequence: "/", name: "/" }), ctx({ composerValue: "hello" }))).toEqual({
      kind: "composer-input",
      ch: "/",
    });
  });

  test("printable chars and backspace edit the slash filter", () => {
    expect(resolveKey(key({ sequence: "c", name: "c" }), ctx({ overlay: "slash-menu" }))).toEqual({
      kind: "slash-input",
      ch: "c",
    });
    expect(resolveKey(key({ name: "backspace" }), ctx({ overlay: "slash-menu" }))).toEqual({
      kind: "slash-backspace",
    });
  });

  test("arrows navigate, Enter submits, and Escape dismisses before lower layers", () => {
    expect(resolveKey(key({ name: "up" }), ctx({ overlay: "slash-menu" }))).toEqual({
      kind: "slash-move",
      delta: -1,
    });
    expect(resolveKey(key({ name: "down" }), ctx({ overlay: "slash-menu" }))).toEqual({
      kind: "slash-move",
      delta: 1,
    });
    expect(resolveKey(key({ name: "return" }), ctx({ overlay: "slash-menu" }))).toEqual({
      kind: "slash-submit",
    });
    expect(resolveKey(key({ name: "escape" }), ctx({ overlay: "slash-menu" }))).toEqual({
      kind: "overlay-dismiss",
    });
  });

  test("a stale slash overlay is inert after the workspace becomes read-only", () => {
    const readOnlySlash = ctx({
      screen: "read-only",
      overlay: "slash-menu",
      composerValue: "/new",
    });
    expect(resolveKey(key({ sequence: "x", name: "x" }), readOnlySlash)).toEqual({
      kind: "none",
    });
    expect(resolveKey(key({ name: "backspace" }), readOnlySlash)).toEqual({ kind: "none" });
    expect(resolveKey(key({ name: "up" }), readOnlySlash)).toEqual({ kind: "none" });
    expect(resolveKey(key({ name: "down" }), readOnlySlash)).toEqual({ kind: "none" });
    expect(resolveKey(key({ name: "enter" }), readOnlySlash)).toEqual({ kind: "none" });
    expect(resolveKey(key({ name: "escape" }), readOnlySlash)).toEqual({
      kind: "overlay-dismiss",
    });
  });
});

describe("resolveKey — modal controls", () => {
  test("pin input edits, saves, and dismisses without leaking keys below the modal", () => {
    expect(resolveKey(key({ sequence: "x", name: "x" }), ctx({ overlay: "pin-input" }))).toEqual({
      kind: "pin-input",
      ch: "x",
    });
    expect(resolveKey(key({ name: "backspace" }), ctx({ overlay: "pin-input" }))).toEqual({
      kind: "pin-backspace",
    });
    expect(resolveKey(key({ name: "enter" }), ctx({ overlay: "pin-input" }))).toEqual({
      kind: "pin-save",
    });
    expect(resolveKey(key({ name: "escape" }), ctx({ overlay: "pin-input" }))).toEqual({
      kind: "overlay-dismiss",
    });
  });

  test("a stale pin input is mutation-inert after transition to read-only", () => {
    const readOnlyPin = ctx({ screen: "read-only", overlay: "pin-input" });
    expect(resolveKey(key({ sequence: "x", name: "x" }), readOnlyPin)).toEqual({ kind: "none" });
    expect(resolveKey(key({ name: "backspace" }), readOnlyPin)).toEqual({ kind: "none" });
    expect(resolveKey(key({ name: "enter" }), readOnlyPin)).toEqual({ kind: "none" });
    expect(resolveKey(key({ name: "escape" }), readOnlyPin)).toEqual({
      kind: "overlay-dismiss",
    });
  });

  test("chat list arrows, Enter, and Escape route to chat controls", () => {
    expect(resolveKey(key({ name: "up" }), ctx({ overlay: "chat-list" }))).toEqual({
      kind: "chat-move",
      delta: -1,
    });
    expect(resolveKey(key({ name: "down" }), ctx({ overlay: "chat-list" }))).toEqual({
      kind: "chat-move",
      delta: 1,
    });
    expect(resolveKey(key({ name: "enter" }), ctx({ overlay: "chat-list" }))).toEqual({
      kind: "chat-switch",
    });
    expect(resolveKey(key({ name: "escape" }), ctx({ overlay: "chat-list" }))).toEqual({
      kind: "overlay-dismiss",
    });
  });

  test("trust Enter accepts and trust Escape declines into read-only", () => {
    expect(resolveKey(key({ name: "enter" }), ctx({ screen: "trust-prompt" }))).toEqual({
      kind: "trust-accept",
    });
    expect(resolveKey(key({ name: "escape" }), ctx({ screen: "trust-prompt" }))).toEqual({
      kind: "trust-decline",
    });
  });

  test("export popup: Enter and Escape both dismiss, and no other key leaks through", () => {
    const exportOpen = ctx({ overlay: "export" });
    expect(resolveKey(key({ name: "enter" }), exportOpen)).toEqual({ kind: "export-dismiss" });
    expect(resolveKey(key({ name: "return" }), exportOpen)).toEqual({ kind: "export-dismiss" });
    expect(resolveKey(key({ name: "escape" }), exportOpen)).toEqual({ kind: "export-dismiss" });
    expect(resolveKey(key({ name: "x", sequence: "x" }), exportOpen)).toEqual({ kind: "none" });
  });
});

describe("resolveActiveOverlay — the one precedence rule renderOverlay and resolveKey both use", () => {
  test("a stored overlay outranks an undismissed export popup", () => {
    expect(resolveActiveOverlay("chat-list", true)).toBe("chat-list");
    expect(resolveActiveOverlay("pin-input", true)).toBe("pin-input");
    expect(resolveActiveOverlay("slash-menu", true)).toBe("slash-menu");
  });

  test("the export popup applies only once no overlay is stored", () => {
    expect(resolveActiveOverlay(null, true)).toBe("export");
  });

  test("neither a stored overlay nor a showing export popup yields null", () => {
    expect(resolveActiveOverlay(null, false)).toBeNull();
  });
});

describe("resolveKey — export popup vs. another overlay (precedence bug repro)", () => {
  test("Enter/Escape route to the chat-list, not export-dismiss, while the chat-list outranks the export popup", () => {
    // Reproduces the bug at the resolveKey boundary: an `overlay` value already
    // precedence-resolved by `resolveActiveOverlay` (App.tsx folds the export popup in only
    // when no stored overlay is open) — so `resolveKey` itself can never be handed both a
    // stored overlay AND export priority at once; only one wins upstream.
    const chatListWins = ctx({ overlay: resolveActiveOverlay("chat-list", true) });
    expect(resolveKey(key({ name: "enter" }), chatListWins)).toEqual({ kind: "chat-switch" });
    expect(resolveKey(key({ name: "escape" }), chatListWins)).toEqual({ kind: "overlay-dismiss" });
  });
});
