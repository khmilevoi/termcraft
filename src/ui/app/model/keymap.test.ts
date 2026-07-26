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
  homePrompt: "",
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
  // `[['r','re-check'],['q','quit']]` (design/termcraft-engine.js:727 — CORRECTED fix round 2,
  // was miscited `:583`, a chat-colour branch inside `chatSeq()`) — `q` belongs beside `r`.
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

    // CORRECTED (fix round 1, Finding 6): `blocked` used to still accept PRINTABLE typed input
    // despite reading as visually disabled (dimmed box, no cursor — design `homeHealth('login')`
    // `:170-173`), so `r` silently stole a printable character from anything typed. It refuses
    // printables and Enter like `missing` — matching its own appearance for composition — but,
    // CORRECTED again (fix round 3), stays live for `backspace`: see the escape-route test below
    // for why.
    test("blocked refuses Enter/printables and is input-inert for those — only r/q/backspace are live", () => {
      // `homePrompt: ""` (the `ctx()` default) — the empty-prompt case; the non-empty / escape
      // route case is its own test below (fix round 2 Minor finding, corrected fix round 3).
      const blocked = ctx({
        screen: "home",
        homeHealth: { kind: "blocked", agent: "claude", panel: "login", detail: "x" },
      });
      expect(resolveKey(key({ name: "return" }), blocked)).toEqual({ kind: "none" });
      expect(resolveKey(key({ name: "x", sequence: "x" }), blocked)).toEqual({ kind: "none" });
      expect(resolveKey(key({ name: "backspace" }), blocked)).toEqual({ kind: "home-backspace" });
      expect(resolveKey(key({ name: "r", sequence: "r" }), blocked)).toEqual({
        kind: "home-recheck",
      });
      expect(resolveKey(key({ name: "q", sequence: "q" }), blocked)).toEqual({ kind: "exit" });
    });

    // fix round 2, Minor finding: `checking` (the outcome that precedes `blocked` on every real
    // transition) keeps the prompt live, so a user can be mid-keystroke the instant the probe
    // resolves to `blocked` — the very next `q` they type is a LETTER, not a quit gesture, and
    // must not silently exit termcraft with their typed prompt still unsaved.
    test("blocked's q does NOT exit while the prompt still holds unsaved text", () => {
      const blockedWithPrompt = ctx({
        screen: "home",
        homeHealth: { kind: "blocked", agent: "claude", panel: "login", detail: "x" },
        homePrompt: "a system monitor for my q",
      });
      expect(resolveKey(key({ name: "q", sequence: "q" }), blockedWithPrompt)).toEqual({
        kind: "none",
      });
      // r re-check stays live regardless — it never destroys anything.
      expect(resolveKey(key({ name: "r", sequence: "r" }), blockedWithPrompt)).toEqual({
        kind: "home-recheck",
      });
    });

    // REGRESSION GUARD, fix round 3: round 2's guard on its own turned `blocked` into a dead end
    // — no printable input, no Enter, and (before this round) no backspace either, so a
    // non-empty `homePrompt` could never shrink back to empty and `q` stayed permanently inert.
    // "Ctrl+C remains available" (round 2's justification) does not hold: `root.tsx` passes
    // `exitOnCtrlC: false` and no `ctrl+c` hotkey is registered, so an unhandled ctrl+c resolves
    // to `{kind:"none"}` here like any other key. This test pins the actual finite escape
    // sequence: `backspace` (live even while `blocked`) shrinks the prompt; once it reaches
    // empty, `q` exits — `resolveKey` is pure/stateless, so each step is asserted against the
    // context that step's own prior keystrokes would have produced in the real, stateful app
    // (`intent.ts`'s `home-backspace` handler pops one character off `local.prompt` per call).
    test("blocked has a finite escape: backspace shrinks the prompt, then q exits", () => {
      const blockedHealth: HomeAgentHealth = {
        kind: "blocked",
        agent: "claude",
        panel: "login",
        detail: "x",
      };
      // Step 1: two characters typed before the transition — q is inert, but backspace works.
      const twoChars = ctx({ screen: "home", homeHealth: blockedHealth, homePrompt: "ab" });
      expect(resolveKey(key({ name: "q", sequence: "q" }), twoChars)).toEqual({ kind: "none" });
      expect(resolveKey(key({ name: "backspace" }), twoChars)).toEqual({ kind: "home-backspace" });

      // Step 2: one character left (as `intent.ts`'s `home-backspace` would leave it after the
      // first backspace above) — still inert to q, backspace still works.
      const oneChar = ctx({ screen: "home", homeHealth: blockedHealth, homePrompt: "a" });
      expect(resolveKey(key({ name: "q", sequence: "q" }), oneChar)).toEqual({ kind: "none" });
      expect(resolveKey(key({ name: "backspace" }), oneChar)).toEqual({ kind: "home-backspace" });

      // Step 3: prompt now empty (after the second backspace) — q reaches the exit this whole
      // sequence exists to prove reachable.
      const empty = ctx({ screen: "home", homeHealth: blockedHealth, homePrompt: "" });
      expect(resolveKey(key({ name: "q", sequence: "q" }), empty)).toEqual({ kind: "exit" });
    });

    test("blocked/latched has the same key set as blocked/login: r, q (guarded), and backspace", () => {
      const latched = ctx({
        screen: "home",
        homeHealth: { kind: "blocked", agent: "claude", panel: "latched", detail: "x" },
        homePrompt: "x",
      });
      expect(resolveKey(key({ name: "x", sequence: "x" }), latched)).toEqual({ kind: "none" });
      expect(resolveKey(key({ name: "r", sequence: "r" }), latched)).toEqual({
        kind: "home-recheck",
      });
      expect(resolveKey(key({ name: "backspace" }), latched)).toEqual({ kind: "home-backspace" });
      expect(resolveKey(key({ name: "q", sequence: "q" }), latched)).toEqual({ kind: "none" }); // prompt still "x"
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

  // §3.10, phase-8 Task 17 (finding §2.4): the Home prompt is a primary input, exactly like the
  // Workspace composer — `/` on an empty one opens the slash menu.
  describe("/ opens the slash menu (§3.10)", () => {
    test("opens the slash menu on an empty, live Home prompt", () => {
      expect(
        resolveKey(key({ sequence: "/", name: "/" }), ctx({ screen: "home", homePrompt: "" })),
      ).toEqual({ kind: "slash-open" });
    });

    test("types as literal text once the Home prompt already holds content", () => {
      expect(
        resolveKey(key({ sequence: "/", name: "/" }), ctx({ screen: "home", homePrompt: "abc" })),
      ).toEqual({ kind: "home-input", ch: "/" });
    });

    // The `missing`/`blocked` branches return above this check for every key but `r`/`q`
    // (/`backspace` for `blocked`) — `/` is none of those, so it is fully inert on both, not
    // merely refused as a slash-open. The menu is reachable only when the prompt is genuinely
    // live (Task 15's health gate), which this falls out of for free from branch ORDER alone.
    test("is inert on missing/blocked — those prompts are not live", () => {
      const missing = ctx({
        screen: "home",
        homeHealth: { kind: "missing", agent: "claude", detail: "x" },
      });
      expect(resolveKey(key({ sequence: "/", name: "/" }), missing)).toEqual({ kind: "none" });

      const blocked = ctx({
        screen: "home",
        homeHealth: { kind: "blocked", agent: "claude", panel: "login", detail: "x" },
        homePrompt: "",
      });
      expect(resolveKey(key({ sequence: "/", name: "/" }), blocked)).toEqual({ kind: "none" });
    });

    test("opens on checking and advisory too — every outcome but missing/blocked keeps a live prompt", () => {
      const checking = ctx({
        screen: "home",
        homeHealth: { kind: "checking", agent: "claude" },
        homePrompt: "",
      });
      expect(resolveKey(key({ sequence: "/", name: "/" }), checking)).toEqual({
        kind: "slash-open",
      });
      const advisory = ctx({
        screen: "home",
        homeHealth: { kind: "advisory", agent: "claude", panel: "sandbox", detail: "x" },
        homePrompt: "",
      });
      expect(resolveKey(key({ sequence: "/", name: "/" }), advisory)).toEqual({
        kind: "slash-open",
      });
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

  // CORRECTED (finding §2.5, phase-8 Task 16): this test used to pin the OPPOSITE — every key
  // resolving to `none` while `turnRunning` — matching the old blunt freeze this task removes.
  // Master §3.2: "Typing the next message while a turn runs is allowed, but sending is
  // disabled." `composer-submit` still resolves normally here; the refusal moves to
  // `applyIntent` (`intent.ts`), which no-ops without clearing the draft (see `intent.test.ts`).
  test("keeps typing, backspace, / and Enter-submit live for the whole turn (§3.2)", () => {
    const running = ctx({ turnRunning: true, composerValue: "" });
    expect(resolveKey(key({ name: "a", sequence: "a" }), running)).toEqual({
      kind: "composer-input",
      ch: "a",
    });
    expect(resolveKey(key({ name: "backspace" }), { ...running, composerValue: "ab" })).toEqual({
      kind: "composer-backspace",
    });
    expect(resolveKey(key({ sequence: "/", name: "/" }), running)).toEqual({
      kind: "slash-open",
    });
    expect(resolveKey(key({ name: "return" }), running)).toEqual({ kind: "composer-submit" });
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
