import { describe, expect, test } from "bun:test";

import type { AgentHealth } from "ui/agent-health";

import type { KeyContext, KeyLike } from "./keymap";
import { isClaimedKey, resolveActiveOverlay, resolveKey } from "./keymap";

const key = (over: Partial<KeyLike>): KeyLike => ({
  name: "",
  ctrl: false,
  shift: false,
  meta: false,
  sequence: "",
  ...over,
});
const READY_HEALTH: AgentHealth = { kind: "ready", agent: "claude" };
const ctx = (over: Partial<KeyContext>): KeyContext => ({
  screen: "workspace",
  focus: "composer",
  overlay: null,
  composerValue: "",
  agentHealth: READY_HEALTH,
  homePrompt: "",
  turnRunning: false,
  projectOpening: false,
  projectOpen: true,
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

  test("Ctrl+B / Ctrl+N -> the previous / next page tab, even while the composer is focused", () => {
    // C0 control bytes (0x02 / 0x0E) — a single byte no terminal can fail to deliver, unlike a
    // CSI-encoded ctrl+arrow chord (HANDOFF Finding 3).
    expect(
      resolveKey(key({ name: "b", ctrl: true, sequence: "\x02" }), ctx({ focus: "composer" })),
    ).toEqual({
      kind: "action-execute",
      actionId: "page.prev",
    });
    expect(
      resolveKey(key({ name: "n", ctrl: true, sequence: "\x0e" }), ctx({ focus: "composer" })),
    ).toEqual({
      kind: "action-execute",
      actionId: "page.next",
    });
  });

  test("Ctrl+Left / Ctrl+Right are NOT page steps — they move the cursor by word (G1)", () => {
    // The aliases were dropped when the composer became a real editor: `ctrl+b`/`ctrl+n` are the
    // page-step keys (the registry's own comment already names them the reliable primary, "one
    // byte, no encoding to get wrong"), and neither arrow chord is drawn anywhere — both entries
    // carry `hint: false`. Keeping them would have made Ctrl+Left switch pages inside a text
    // editor, which is the "advertised but wrong" trap this codebase has already fixed twice.
    expect(resolveKey(key({ name: "left", ctrl: true }), ctx({ focus: "composer" }))).toEqual({
      kind: "none",
    });
    expect(resolveKey(key({ name: "right", ctrl: true }), ctx({ focus: "composer" }))).toEqual({
      kind: "none",
    });
  });

  test("unmodified arrows are NOT page switches — they stay free for in-surface navigation", () => {
    expect(resolveKey(key({ name: "left" }), ctx({ focus: "composer" }))).toEqual({ kind: "none" });
    expect(resolveKey(key({ name: "right" }), ctx({ focus: "composer" }))).toEqual({
      kind: "none",
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

  test("PgUp/PgDn and their ctrl aliases resolve to the chat scroll actions", () => {
    const context = ctx({}); // reuse this file's own context builder
    expect(
      resolveKey(key({ name: "pageup", ctrl: false, sequence: "\x1b[5~" }), context),
    ).toEqual({
      kind: "action-execute",
      actionId: "chat.scroll-up",
    });
    expect(
      resolveKey(key({ name: "pagedown", ctrl: false, sequence: "\x1b[6~" }), context),
    ).toEqual({
      kind: "action-execute",
      actionId: "chat.scroll-down",
    });
    expect(resolveKey(key({ name: "u", ctrl: true, sequence: "\x15" }), context)).toEqual({
      kind: "action-execute",
      actionId: "chat.scroll-up",
    });
    expect(resolveKey(key({ name: "d", ctrl: true, sequence: "\x04" }), context)).toEqual({
      kind: "action-execute",
      actionId: "chat.scroll-down",
    });
  });
});

describe("resolveKey — Home", () => {
  test("Tab on Home does nothing", () => {
    expect(resolveKey(key({ name: "tab" }), ctx({ screen: "home" }))).toEqual({ kind: "none" });
  });

  test("r re-checks agent health on the missing-agent error screen (M15)", () => {
    expect(
      resolveKey(
        key({ name: "r", sequence: "r" }),
        ctx({ screen: "home", agentHealth: { kind: "missing", agent: "claude", detail: "x" } }),
      ),
    ).toEqual({ kind: "home-recheck" });
  });

  // `home-input` is gone (§6.1/§6.4): a live `r` now falls through to `none`, letting the mounted
  // editor type it, rather than resolving to an intent.
  test("r falls through to the editor on the idle Home prompt when the agent is ready", () => {
    expect(
      resolveKey(
        key({ name: "r", sequence: "r" }),
        ctx({ screen: "home", agentHealth: READY_HEALTH }),
      ),
    ).toEqual({ kind: "none" });
  });

  test("on the missing-agent error panel, only r and q are live — no submit/backspace/input affordance exists there", () => {
    const missingAgent = ctx({
      screen: "home",
      agentHealth: { kind: "missing", agent: "claude", detail: "x" },
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
      ctx({ screen: "home", agentHealth: { kind: "missing", agent: "claude", detail: "x" } }),
    );
    expect(intent).toEqual({ kind: "exit" });
  });

  test("q still types on the idle Home prompt", () => {
    const intent = resolveKey(
      key({ name: "q", sequence: "q" }),
      ctx({ screen: "home", agentHealth: READY_HEALTH }),
    );
    expect(intent.kind).not.toBe("exit");
  });

  // finding §2.7 (phase-8 Task 15): the five health outcomes gate Enter directly through
  // `homeSubmitAllowed`, not through a `missing`-only branch.
  describe("Enter gating across the five health outcomes", () => {
    test("checking refuses Enter — the probe hasn't resolved yet", () => {
      const checking = ctx({ screen: "home", agentHealth: { kind: "checking", agent: "claude" } });
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
        agentHealth: { kind: "blocked", agent: "claude", panel: "login", detail: "x" },
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
        agentHealth: { kind: "blocked", agent: "claude", panel: "login", detail: "x" },
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
      const blockedHealth: AgentHealth = {
        kind: "blocked",
        agent: "claude",
        panel: "login",
        detail: "x",
      };
      // Step 1: two characters typed before the transition — q is inert, but backspace works.
      const twoChars = ctx({ screen: "home", agentHealth: blockedHealth, homePrompt: "ab" });
      expect(resolveKey(key({ name: "q", sequence: "q" }), twoChars)).toEqual({ kind: "none" });
      expect(resolveKey(key({ name: "backspace" }), twoChars)).toEqual({ kind: "home-backspace" });

      // Step 2: one character left (as `intent.ts`'s `home-backspace` would leave it after the
      // first backspace above) — still inert to q, backspace still works.
      const oneChar = ctx({ screen: "home", agentHealth: blockedHealth, homePrompt: "a" });
      expect(resolveKey(key({ name: "q", sequence: "q" }), oneChar)).toEqual({ kind: "none" });
      expect(resolveKey(key({ name: "backspace" }), oneChar)).toEqual({ kind: "home-backspace" });

      // Step 3: prompt now empty (after the second backspace) — q reaches the exit this whole
      // sequence exists to prove reachable.
      const empty = ctx({ screen: "home", agentHealth: blockedHealth, homePrompt: "" });
      expect(resolveKey(key({ name: "q", sequence: "q" }), empty)).toEqual({ kind: "exit" });
    });

    test("blocked/latched has the same key set as blocked/login: r, q (guarded), and backspace", () => {
      const latched = ctx({
        screen: "home",
        agentHealth: { kind: "blocked", agent: "claude", panel: "latched", detail: "x" },
        homePrompt: "x",
      });
      expect(resolveKey(key({ name: "x", sequence: "x" }), latched)).toEqual({ kind: "none" });
      expect(resolveKey(key({ name: "r", sequence: "r" }), latched)).toEqual({
        kind: "home-recheck",
      });
      expect(resolveKey(key({ name: "backspace" }), latched)).toEqual({ kind: "home-backspace" });
      expect(resolveKey(key({ name: "q", sequence: "q" }), latched)).toEqual({ kind: "none" }); // prompt still "x"
    });

    // finding §2.7, fix round 1 Finding 6: advisory's prompt stays genuinely live (design draws
    // its own blinking cursor for it too, `:173`), so `r`/`q` must reach the editor rather than
    // resolving to `home-recheck`/`exit` — only `blocked`/`missing`, whose prompts are genuinely
    // disabled, bind those literally. `home-input` is gone (§6.1/§6.4): a live `r`/`q` now falls
    // through to `none`, letting the mounted editor type it, rather than resolving to an intent.
    test("r/q fall through to the editor on checking/advisory/ready — only blocked/missing bind them", () => {
      const checking = ctx({ screen: "home", agentHealth: { kind: "checking", agent: "claude" } });
      const advisory = ctx({
        screen: "home",
        agentHealth: { kind: "advisory", agent: "claude", panel: "sandbox", detail: "x" },
      });
      expect(resolveKey(key({ name: "r", sequence: "r" }), checking)).toEqual({ kind: "none" });
      expect(resolveKey(key({ name: "r", sequence: "r" }), advisory)).toEqual({ kind: "none" });
      expect(resolveKey(key({ name: "q", sequence: "q" }), advisory)).toEqual({ kind: "none" });
    });

    test("advisory allows Enter — a timeout/degraded reading proves nothing that blocks submit", () => {
      const advisory = ctx({
        screen: "home",
        agentHealth: { kind: "advisory", agent: "claude", panel: "sandbox", detail: "x" },
      });
      expect(resolveKey(key({ name: "return" }), advisory)).toEqual({ kind: "home-submit" });
    });

    test("ready allows Enter", () => {
      const ready = ctx({ screen: "home", agentHealth: READY_HEALTH });
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

    test("falls through to the editor as literal text once the Home prompt already holds content", () => {
      expect(
        resolveKey(key({ sequence: "/", name: "/" }), ctx({ screen: "home", homePrompt: "abc" })),
      ).toEqual({ kind: "none" });
    });

    // The `missing`/`blocked` branches return above this check for every key but `r`/`q`
    // (/`backspace` for `blocked`) — `/` is none of those, so it is fully inert on both, not
    // merely refused as a slash-open. The menu is reachable only when the prompt is genuinely
    // live (Task 15's health gate), which this falls out of for free from branch ORDER alone.
    test("is inert on missing/blocked — those prompts are not live", () => {
      const missing = ctx({
        screen: "home",
        agentHealth: { kind: "missing", agent: "claude", detail: "x" },
      });
      expect(resolveKey(key({ sequence: "/", name: "/" }), missing)).toEqual({ kind: "none" });

      const blocked = ctx({
        screen: "home",
        agentHealth: { kind: "blocked", agent: "claude", panel: "login", detail: "x" },
        homePrompt: "",
      });
      expect(resolveKey(key({ sequence: "/", name: "/" }), blocked)).toEqual({ kind: "none" });
    });

    test("opens on checking and advisory too — every outcome but missing/blocked keeps a live prompt", () => {
      const checking = ctx({
        screen: "home",
        agentHealth: { kind: "checking", agent: "claude" },
        homePrompt: "",
      });
      expect(resolveKey(key({ sequence: "/", name: "/" }), checking)).toEqual({
        kind: "slash-open",
      });
      const advisory = ctx({
        screen: "home",
        agentHealth: { kind: "advisory", agent: "claude", panel: "sandbox", detail: "x" },
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
  test("keeps typing, backspace, / and Enter-submit reaching the editor for the whole turn (§3.2)", () => {
    const running = ctx({ turnRunning: true, composerValue: "" });
    expect(resolveKey(key({ name: "a", sequence: "a" }), running)).toEqual({ kind: "none" });
    expect(resolveKey(key({ name: "backspace" }), { ...running, composerValue: "ab" })).toEqual({
      kind: "none",
    });
    expect(resolveKey(key({ sequence: "/", name: "/" }), running)).toEqual({
      kind: "slash-open",
    });
    expect(resolveKey(key({ name: "return" }), running)).toEqual({ kind: "composer-submit" });
  });
});

describe("the Workspace's opening state (spec 2026-08-02)", () => {
  test("Enter is refused while the project is still opening", () => {
    expect(
      resolveKey(
        key({ name: "return" }),
        ctx({ screen: "workspace", focus: "composer", projectOpen: false }),
      ),
    ).toEqual({ kind: "none" });
  });

  test("typing is not — only sending is refused", () => {
    expect(
      resolveKey(
        key({ name: "a", sequence: "a" }),
        ctx({ screen: "workspace", focus: "composer", projectOpen: false }),
      ),
    ).toEqual({ kind: "none" });
    expect(
      resolveKey(
        key({ name: "backspace" }),
        ctx({ screen: "workspace", focus: "composer", projectOpen: false }),
      ),
    ).toEqual({ kind: "none" });
  });

  test("an open project sends as before", () => {
    expect(
      resolveKey(
        key({ name: "return" }),
        ctx({ screen: "workspace", focus: "composer", projectOpen: true }),
      ),
    ).toEqual({ kind: "composer-submit" });
  });
});

describe("resolveKey — slash menu", () => {
  test("/ opens the menu only from an empty focused workspace composer", () => {
    expect(resolveKey(key({ sequence: "/", name: "/" }), ctx({}))).toEqual({
      kind: "slash-open",
    });
    expect(resolveKey(key({ sequence: "/", name: "/" }), ctx({ composerValue: "hello" }))).toEqual({
      kind: "none",
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

describe("the claim rule — preventDefault iff resolveKey returned something other than none (§6.4)", () => {
  test("isClaimedKey is exactly 'the intent is not none'", () => {
    expect(isClaimedKey({ kind: "none" })).toBe(false);
    expect(isClaimedKey({ kind: "composer-submit" })).toBe(true);
    expect(isClaimedKey({ kind: "esc" })).toBe(true);
    expect(isClaimedKey({ kind: "action-execute", actionId: "preview.fullscreen" })).toBe(true);
  });

  const reachesTheEditor: ReadonlyArray<readonly [string, KeyLike, Partial<KeyContext>]> = [
    ["a printable in the composer", key({ name: "a", sequence: "a" }), {}],
    ["Backspace in the composer", key({ name: "backspace" }), {}],
    ["Left with no menu open", key({ name: "left" }), {}],
    ["Right with no menu open", key({ name: "right" }), {}],
    ["Ctrl+Left (word back)", key({ name: "left", ctrl: true }), {}],
    ["Ctrl+Right (word forward)", key({ name: "right", ctrl: true }), {}],
    ["Ctrl+W (delete word back)", key({ name: "w", ctrl: true, sequence: "\u0017" }), {}],
    ["Ctrl+Backspace", key({ name: "backspace", ctrl: true }), {}],
    ["Ctrl+Delete", key({ name: "delete", ctrl: true }), {}],
    ["Shift+Enter", key({ name: "return", shift: true }), {}],
    ["Alt+Enter", key({ name: "return", meta: true }), {}],
    ["Ctrl+J", key({ name: "linefeed", sequence: "\n" }), {}],
    ["Ctrl+Z (undo)", key({ name: "z", ctrl: true, sequence: "\u001a" }), {}],
    ["Ctrl+Y (redo)", key({ name: "y", ctrl: true, sequence: "\u0019" }), {}],
    ["Ctrl+A (select all)", key({ name: "a", ctrl: true, sequence: "\u0001" }), {}],
    ["Home", key({ name: "home" }), {}],
    ["End", key({ name: "end" }), {}],
    ["a printable in the Home prompt", key({ name: "x", sequence: "x" }), { screen: "home" }],
    ["Backspace in the Home prompt", key({ name: "backspace" }), { screen: "home" }],
    [
      "a printable while the slash menu is open",
      key({ name: "e", sequence: "e" }),
      { overlay: "slash-menu", composerValue: "/" },
    ],
    [
      "Backspace while the slash menu is open",
      key({ name: "backspace" }),
      { overlay: "slash-menu", composerValue: "/e" },
    ],
    [
      "Ctrl+Left while the slash menu is open",
      key({ name: "left", ctrl: true }),
      { overlay: "slash-menu", composerValue: "/e" },
    ],
    ["a printable in the pin input", key({ name: "p", sequence: "p" }), { overlay: "pin-input" }],
    ["Backspace in the pin input", key({ name: "backspace" }), { overlay: "pin-input" }],
  ];

  for (const [label, pressed, context] of reachesTheEditor) {
    test(`${label} resolves to none and falls through`, () => {
      expect(resolveKey(pressed, ctx(context))).toEqual({ kind: "none" });
    });
  }

  const claimed: ReadonlyArray<readonly [string, KeyLike, Partial<KeyContext>]> = [
    ["Enter in the composer", key({ name: "return" }), {}],
    ["numpad Enter in the composer", key({ name: "kpenter" }), {}],
    ["Escape", key({ name: "escape" }), {}],
    ["Tab", key({ name: "tab" }), {}],
    ["F2", key({ name: "f2" }), {}],
    ["Ctrl+E", key({ name: "e", ctrl: true, sequence: "\u0005" }), {}],
    ["Ctrl+B", key({ name: "b", ctrl: true, sequence: "\u0002" }), {}],
    ["/ on an empty composer", key({ name: "/", sequence: "/" }), {}],
    ["Up while the slash menu is open", key({ name: "up" }), { overlay: "slash-menu" }],
    ["Down while the slash menu is open", key({ name: "down" }), { overlay: "slash-menu" }],
    ["Enter while the slash menu is open", key({ name: "return" }), { overlay: "slash-menu" }],
    ["Enter in the pin input", key({ name: "return" }), { overlay: "pin-input" }],
  ];

  for (const [label, pressed, context] of claimed) {
    test(`${label} is claimed by the App`, () => {
      expect(isClaimedKey(resolveKey(pressed, ctx(context)))).toBe(true);
    });
  }

  // The table above only asserts that the key is CLAIMED, which any non-`none` kind satisfies —
  // a mapping that regressed to, say, `overlay-dismiss` would still pass. Every other kind it
  // covers is pinned to its exact intent somewhere else in this file; `pin-save` was the one that
  // was not, so it is pinned here rather than left resting on the weaker assertion.
  test("Enter in the pin input resolves to pin-save specifically, not merely to something claimed", () => {
    expect(resolveKey(key({ name: "return" }), ctx({ overlay: "pin-input" }))).toEqual({
      kind: "pin-save",
    });
  });
});

describe("dead-binding guard — the two editor defaults the App shadows (§4.7)", () => {
  test("Ctrl+B and Ctrl+E resolve to registry actions, so the editor's defaults are unreachable", () => {
    // PAIRED with `key-bindings.test.ts`: the editor's own map still resolves ctrl+b to move-left
    // and ctrl+e to line-end, because `mergeKeyBindings` can shadow but never remove. Together
    // the two assertions mean "unreachable by construction". If someone later drops ctrl+e from
    // the registry, THIS assertion fails and points straight at the collision instead of letting
    // export silently become "go to end of line".
    expect(resolveKey(key({ name: "b", ctrl: true, sequence: "\u0002" }), ctx({}))).toEqual({
      kind: "action-execute",
      actionId: "page.prev",
    });
    expect(resolveKey(key({ name: "e", ctrl: true, sequence: "\u0005" }), ctx({}))).toEqual({
      kind: "action-execute",
      actionId: "export.start",
    });
  });
});

describe("Home while the agent is blocked — the one surviving editing intent", () => {
  test("backspace still resolves to home-backspace, the only way to empty a non-empty prompt", () => {
    const blocked: AgentHealth = {
      kind: "blocked",
      agent: "claude",
      panel: "login",
      detail: "not signed in",
    };
    expect(
      resolveKey(
        key({ name: "backspace" }),
        ctx({ screen: "home", agentHealth: blocked, homePrompt: "typed" }),
      ),
    ).toEqual({ kind: "home-backspace" });
  });

  test("a printable is still inert there — the editor is blurred and the intent is gone", () => {
    const blocked: AgentHealth = {
      kind: "blocked",
      agent: "claude",
      panel: "login",
      detail: "not signed in",
    };
    expect(
      resolveKey(key({ name: "d", sequence: "d" }), ctx({ screen: "home", agentHealth: blocked })),
    ).toEqual({ kind: "none" });
  });
});
