# Live Page Switching Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make tab-click page switching work in a real interactive run — by first restoring the
diagnostic log that currently cannot see why it doesn't, then fixing the host-handshake crash
loop that freezes the app, and only then committing the page-switching change.

**Architecture:** Four independent repairs, ordered by what unblocks what. (1) The interactive
process's console tee is destroyed by OpenTUI's own console capture, so every `console.warn` after
the renderer starts is discarded — that is fixed at the renderer config (the host renderer already
does exactly this) plus a tee that survives a foreign override. (2) The `preview.selectPage`
dispatch gets an explicit trace so the live run answers Finding 2 outright. (3) Page stepping gets
key bindings no terminal can swallow. (4) The host handshake gets a budget it can meet, its spawn
gap becomes measurable inside the run log, and its scratch directories get cleaned up.

**Tech Stack:** Bun (runtime + test runner), TypeScript, React + `@opentui/react`, Reatom v1001,
`errore` (errors as values), `oxlint`/`oxfmt`.

**Source of requirements:** `HANDOFF.md` (2026-07-27, branch `phase-8`, HEAD `1f39f14`) —
Findings 1–5 and its "Next steps". Read it before starting; its "What didn't work" section names
three hypotheses that are already closed and must not be re-derived.

## Global Constraints

- **Prefix every shell command with `rtk`** — including inside `&&` chains (`rtk git add …`,
  `rtk bun test …`).
- **The page-switching change in the working tree stays uncommitted until Task 8.** Twenty
  modified files and three untracked paths are already in the tree. Every commit step below uses
  an explicit path list — never `git add .`, never `git add -A`.
- **`errore` conventions are binding** (`/errore` skill): errors are returned, not thrown; one-line
  `if (x instanceof Error) return x`; an error that is not propagated must be logged (rule 21).
- **Reatom v1001 conventions are binding** (`/reatom` skill). After any task that touches Reatom
  code, run `/reatom-audit <the exact paths you changed>` — the `--changed` form consumes its cache
  and then falsely reports "already audited" (`MEMORY.md`). Tasks 2 and 3 touch Reatom code; the
  others do not.
- **Design is the source of truth** (`CLAUDE.md`). No new colour, glyph, layout or status-bar row
  is invented in this plan. The one design extension it touches — keyboard page stepping — is
  already recorded as an extension in `src/ui/actions/model/registry.ts` and stays `hint: false`.
- **Module shape:** `module/{ui,model}/…` plus `types.ts` and `index.ts` at the module root.
  Cross-module imports use the `tsconfig` path aliases, never `../..`.
- **Test runner:** `rtk bun test <path>`. `bun test` sets `NODE_ENV=test`, which turns tracing OFF
  by default (`src/infrastructure/debug-log/model/sink.ts:86`) — so nothing in a test suite may
  depend on the real trace sink; inject a fake instead.
- **Architecture docs:** if a task changes behaviour or structure covered by `docs/architecture/`,
  update the affected doc in the same commit (architecture-update skill).

---

## File Structure

| File | Responsibility | Task |
| --- | --- | --- |
| `src/infrastructure/debug-log/types.ts` | add `TeeSink` — the injectable trace seam | 1 |
| `src/infrastructure/debug-log/model/console-tee.ts` | re-installable tee, all five console methods | 1 |
| `src/infrastructure/debug-log/model/console-tee.test.ts` | **new** — proves the tee survives a foreign override | 1 |
| `src/infrastructure/debug-log/index.ts` | export `TeeSink` | 1 |
| `src/ui/app/model/root.tsx` | `consoleMode: "disabled"` + re-install the tee after the renderer exists | 1 |
| `src/ui/app/model/root.test.tsx` | pins the renderer config | 1 |
| `src/ui/app/model/deps.ts` | trace the `preview.selectPage` dispatch and its outcome | 2 |
| `src/ui/app/ui/App.tsx` | record every key modifier in `ui.onKey` | 3 |
| `src/ui/actions/types.ts` | `HotkeyAction.aliases` | 4 |
| `src/ui/actions/model/registry.ts` | page keys → `ctrl+b`/`ctrl+n`, arrows kept as aliases | 4 |
| `src/ui/actions/model/registry.test.ts` | alias resolution | 4 |
| `src/ui/app/model/keymap.test.ts` | the new page-key resolutions | 4 |
| `src/host/supervisor/model/timeouts.ts` | **new** — one handshake budget, one reason string | 5 |
| `src/host/supervisor/model/timeouts.test.ts` | **new** — the reason string tracks the constant | 5 |
| `src/host/supervisor/model/session.ts` | use the shared budget; trace the handshake wait | 5, 6 |
| `src/host/supervisor/model/one-shot.ts` | use the shared budget | 5 |
| `src/host/supervisor/model/spawn.ts` | trace the spawn; delete the scratch dir on exit; sweep strays | 6, 7 |
| `src/host/supervisor/model/spawn.test.ts` | `selectStaleScratchDirs` | 7 |
| `src/host/supervisor/index.ts` | export `sweepStaleScratchDirs` | 7 |
| `src/entrypoint/model/create-shell.ts` | call the sweep once, on the production spawn path | 7 |

---

### Task 1: Restore the interactive console tee

**Why this is first:** `HANDOFF.md` Finding 1. `installConsoleTee()` runs at `src/main.tsx:74`, but
`createCliRenderer` sets `this.consoleMode = config.consoleMode ?? "console-overlay"`
(`node_modules/@opentui/core/chunk-bun-tkm837n2.js:7301`), whose setter calls `console.activate()`
→ `overrideConsoleMethods()` (`:4480-4499`), which replaces `console.log/info/warn/error/debug`
with functions that never call through. Every `console.warn` the UI and Kernel emit after the
renderer starts is discarded. **Until this is fixed, the absence of a warning in the run log proves
nothing** — which is exactly what burned the previous session.

The fix is already precedented in this repo: `src/host/render/model/renderer.ts:27` passes
`consoleMode: "disabled"`, which is why `_host` children have an intact tee and the UI process does
not. `deactivate()` only calls `restoreOriginalConsole()`, and `_originalConsole` is set solely
inside `activate()` — so with `"disabled"` nothing ever touches `console` and the tee survives. The
re-installable tee is the belt to that braces: it also covers `console.info`/`console.debug`, which
the tee never mirrored at all.

**Files:**
- Modify: `src/infrastructure/debug-log/types.ts`
- Modify: `src/infrastructure/debug-log/model/console-tee.ts`
- Create: `src/infrastructure/debug-log/model/console-tee.test.ts`
- Modify: `src/infrastructure/debug-log/index.ts`
- Modify: `src/ui/app/model/root.tsx:70` (`defaultAdapters`) and `createUiRoot`
- Modify: `src/ui/app/model/root.test.tsx`

**Interfaces:**
- Produces: `TeeSink` (`{ enabled(): boolean; trace(channel: string, data: Record<string, unknown>): void }`),
  `installConsoleTee(sink?: TeeSink): void`, `UI_RENDERER_CONFIG`.
- Consumes: `trace`, `traceEnabled` from `./sink`.

- [ ] **Step 1: Add the injectable sink type**

In `src/infrastructure/debug-log/types.ts`, append:

```ts
/**
 * The trace seam {@link installConsoleTee} writes through.
 *
 * Injectable because the real sink resolves its target ONCE at module load, and under
 * `bun test` (`NODE_ENV=test`) that target is `null` — so a tee test can neither enable
 * tracing after the fact nor assert against a file. A fake sink makes the tee testable
 * without an environment variable and without touching disk.
 */
export interface TeeSink {
  readonly enabled: () => boolean;
  readonly trace: (channel: string, data: Record<string, unknown>) => void;
}
```

- [ ] **Step 2: Write the failing test**

Create `src/infrastructure/debug-log/model/console-tee.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test";

import type { TeeSink } from "../types";
import { installConsoleTee } from "./console-tee";

const ORIGINALS = {
  log: console.log,
  info: console.info,
  warn: console.warn,
  error: console.error,
  debug: console.debug,
} as const;

afterEach(() => {
  Object.assign(console, ORIGINALS);
});

function recordingSink(lines: string[]): TeeSink {
  return {
    enabled: () => true,
    trace: (channel, data) => lines.push(`${channel}:${JSON.stringify(data.args)}`),
  };
}

describe("installConsoleTee", () => {
  test("mirrors a warning into the sink and still calls the original through", () => {
    const lines: string[] = [];
    const said: unknown[] = [];
    console.warn = (...args: unknown[]) => said.push(...args);

    installConsoleTee(recordingSink(lines));
    console.warn("hello");

    expect(lines).toEqual(['console.warn:["hello"]']);
    expect(said).toEqual(["hello"]);
  });

  test("re-installs over a foreign override — OpenTUI's overrideConsoleMethods", () => {
    const lines: string[] = [];
    const sink = recordingSink(lines);
    installConsoleTee(sink);

    // Exactly what `@opentui/core`'s `overrideConsoleMethods` does: assign a new function that
    // never calls the previous one. The first install's wrapper is gone at this point.
    const overlay: unknown[] = [];
    console.warn = (...args: unknown[]) => overlay.push(...args);

    installConsoleTee(sink);
    console.warn("after the renderer started");

    expect(lines).toEqual(['console.warn:["after the renderer started"]']);
    expect(overlay).toEqual(["after the renderer started"]);
  });

  test("installing twice over its own wrapper does not double-record", () => {
    const lines: string[] = [];
    const sink = recordingSink(lines);
    installConsoleTee(sink);
    installConsoleTee(sink);
    console.warn("once");

    expect(lines).toEqual(['console.warn:["once"]']);
  });

  test("covers every method OpenTUI overrides, including info and debug", () => {
    const lines: string[] = [];
    installConsoleTee(recordingSink(lines));
    console.info("i");
    console.debug("d");

    expect(lines).toEqual(['console.info:["i"]', 'console.debug:["d"]']);
  });

  test("does nothing at all when tracing is off", () => {
    const untouched = console.warn;
    installConsoleTee({ enabled: () => false, trace: () => undefined });

    expect(console.warn).toBe(untouched);
  });

  test("flattens an Error argument with its cause chain", () => {
    const lines: string[] = [];
    installConsoleTee(recordingSink(lines));
    console.error("failed:", new Error("outer", { cause: new Error("inner") }));

    expect(lines[0]).toContain('"message":"inner"');
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `rtk bun test src/infrastructure/debug-log/model/console-tee.test.ts`
Expected: FAIL — `installConsoleTee` takes no argument, records only after the first install, and
does not touch `console.info`/`console.debug`.

- [ ] **Step 4: Rewrite the tee**

Replace the body of `src/infrastructure/debug-log/model/console-tee.ts` (keep the existing
`describe` helper verbatim):

```ts
import type { TeeSink } from "../types";
import { trace, traceEnabled } from "./sink";

/**
 * DIAGNOSTIC INSTRUMENTATION — see `sink.ts`'s header.
 *
 * The codebase already reports through `console.warn`/`console.error`/`console.log` from 75
 * files, and in a live interactive run every one of those lines is lost behind the alternate
 * screen. Rather than edit hundreds of call sites, this mirrors them into the trace file.
 *
 * The original methods are still called, so behavior is unchanged and this can be left in place
 * or removed without altering what the app does.
 *
 * IDEMPOTENT BY WRAPPER IDENTITY, NOT BY A FLAG (2026-07-27, HANDOFF Finding 1). The old
 * `installed` boolean made the SECOND install a no-op — which is precisely wrong, because
 * `@opentui/core`'s `overrideConsoleMethods` (`chunk-bun-tkm837n2.js:4480`) replaces
 * `console.log/info/warn/error/debug` wholesale AFTER this runs and never calls through, so the
 * interactive process traced nothing from the moment its renderer started. Keying on "is
 * `console[method]` still the wrapper WE installed" makes a re-install a no-op when nothing
 * replaced us and a genuine repair when something did. `info` and `debug` are covered too:
 * OpenTUI overrides them, so leaving them out left two silent channels.
 */

type ConsoleMethod = "log" | "info" | "warn" | "error" | "debug";

const METHODS: readonly ConsoleMethod[] = ["log", "info", "warn", "error", "debug"];

/** The wrapper this module last installed per method — the identity a re-install compares against. */
const installedWrappers = new Map<ConsoleMethod, unknown>();

const defaultSink: TeeSink = { enabled: traceEnabled, trace };

/** Install (or re-install) the tee. Safe to call at any point in the process's life. */
export function installConsoleTee(sink: TeeSink = defaultSink): void {
  if (!sink.enabled()) return;

  for (const method of METHODS) {
    if ((console[method] as unknown) === installedWrappers.get(method)) continue;
    const original = console[method].bind(console);
    const wrapper = (...args: unknown[]): void => {
      sink.trace(`console.${method}`, { args: args.map(describe) });
      original(...args);
    };
    console[method] = wrapper;
    installedWrappers.set(method, wrapper);
  }
}
```

- [ ] **Step 5: Export the type**

In `src/infrastructure/debug-log/index.ts`, extend the type re-export:

```ts
export type { TeeSink, TraceLine } from "./types";
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `rtk bun test src/infrastructure/debug-log/`
Expected: PASS (both `console-tee.test.ts` and the existing `sink.test.ts`).

- [ ] **Step 7: Write the failing renderer-config test**

Add to `src/ui/app/model/root.test.tsx`:

```ts
import { UI_RENDERER_CONFIG, UiRootError, createUiRoot } from "./root";

describe("UI_RENDERER_CONFIG", () => {
  // HANDOFF Finding 1: OpenTUI's default `consoleMode: "console-overlay"` replaces
  // console.log/info/warn/error/debug with an overlay writer that never calls through, which
  // silently destroys the debug-log tee for the whole interactive run. The host renderer
  // (`host/render/model/renderer.ts`) already disables it; the UI must too.
  test("disables OpenTUI's console overlay so the debug-log tee survives", () => {
    expect(UI_RENDERER_CONFIG.consoleMode).toBe("disabled");
  });

  test("keeps ctrl+c under the app's own control", () => {
    expect(UI_RENDERER_CONFIG.exitOnCtrlC).toBe(false);
  });
});
```

- [ ] **Step 8: Run it to verify it fails**

Run: `rtk bun test src/ui/app/model/root.test.tsx`
Expected: FAIL — `UI_RENDERER_CONFIG` is not exported from `./root`.

- [ ] **Step 9: Disable the overlay and re-install the tee after the renderer exists**

In `src/ui/app/model/root.tsx`, add the import and replace `defaultAdapters`:

```ts
import { installConsoleTee } from "infrastructure/debug-log";

/**
 * The interactive renderer's config. Exported so it is assertable — the `consoleMode` line is a
 * diagnostics-critical decision, not a style preference.
 *
 * `consoleMode: "disabled"` (HANDOFF Finding 1, 2026-07-27): OpenTUI's default
 * `"console-overlay"` calls `overrideConsoleMethods` at construction, replacing every
 * `console.*` method with an overlay writer that does NOT call through — which discards the
 * debug-log tee installed back in `main.tsx` and blinds the entire interactive run. The app
 * never shows OpenTUI's overlay, so nothing is lost by turning it off, and
 * `host/render/model/renderer.ts` already makes exactly this choice for the same reason.
 */
export const UI_RENDERER_CONFIG = { exitOnCtrlC: false, consoleMode: "disabled" } as const;

const defaultAdapters: UiRootAdapters = {
  createRenderer: () => createCliRenderer(UI_RENDERER_CONFIG),
  createRoot: (renderer) => createRoot(renderer as CliRenderer),
};
```

Then, inside `createUiRoot`, immediately after the `renderer instanceof Error` guard:

```ts
  if (renderer instanceof Error) return renderer;
  // Belt to `UI_RENDERER_CONFIG`'s braces: any renderer construction — including an injected
  // adapter, or a future OpenTUI version that re-overrides console outside `consoleMode` — gets
  // the tee put back over whatever it left behind. A no-op when nothing replaced it.
  installConsoleTee();
```

- [ ] **Step 10: Run the tests to verify they pass**

Run: `rtk bun test src/ui/app/model/root.test.tsx src/infrastructure/debug-log/`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
rtk git add src/infrastructure/debug-log/types.ts src/infrastructure/debug-log/index.ts src/infrastructure/debug-log/model/console-tee.ts src/infrastructure/debug-log/model/console-tee.test.ts src/ui/app/model/root.tsx src/ui/app/model/root.test.tsx
rtk git commit -m "fix(debug-log): keep the console tee alive past renderer startup"
```

---

### Task 2: Trace the preview.selectPage dispatch end to end

**Why:** `HANDOFF.md` Finding 2. `ui.page.select {calendar}` fires, but
`kernel.preview.selectCurrentSource` never starts — on any of four clicks across two runs. The
model layer is already exonerated (a scratch reproduction against `FakeKernel` dispatched
correctly; `deps.test.ts` is 24/24), so the answer is in one of the two swallowed warns at
`deps.ts:428` / `deps.ts:436` — or the dispatch is accepted and the Kernel handler is the one
dropping it. Today the accepted path logs **nothing at all**, so the log cannot tell those two
apart. `page-selection.ts:44` already traces its own dispatch result as `ui.dispatch.result`;
this is the same shape for the other producer.

This task is instrumentation only — no behaviour change, no new test. Its verification is the live
run in Task 8.

**Files:**
- Modify: `src/ui/app/model/deps.ts` (inside `requestPreviewForActivePage`, ~lines 407-439)

**Interfaces:**
- Consumes: `trace` (already imported at `deps.ts:20`), the `ui.dispatch.result` channel shape from
  `src/ui/workspace/model/page-selection.ts:44`.
- Produces: two new trace channels — `ui.preview.request` and `ui.dispatch.result`
  (`kind: "preview.selectPage"`).

- [ ] **Step 1: Trace the request before it is dispatched**

In `requestPreviewForActivePage`, immediately after the `parsePageSlug` guard's `lastRequestedPageKey = pageKey;`:

```ts
        lastRequestedPageKey = pageKey;
        // DIAGNOSTIC (HANDOFF Finding 2): the ONE place a page choice becomes a Kernel command.
        // Without this the log could not distinguish "the memo swallowed the click", "the
        // dispatch was made and refused", and "the dispatch was accepted and the handler never
        // ran" — three different bugs that all look identical as silence.
        trace("ui.preview.request", { pageSlug, sourceHash, pageKey });
        void dispatcher.dispatch("preview.selectPage", { pageSlug }).then((result) => {
```

- [ ] **Step 2: Trace the accepted outcome**

At the end of the same `.then` callback, after the `result.status === "rejected"` branch:

```ts
          if (result.status === "rejected") {
            console.warn(`UI preview.selectPage was rejected for "${pageSlug}" (${result.code})`);
            lastRequestedPageKey = null;
            return;
          }
          // The accepted path used to be silent, which is what made Finding 2 unreadable: an
          // accepted dispatch and a never-attempted one left the same (empty) evidence. Same
          // channel and shape `page-selection.ts` already uses for `selection.clear`.
          trace("ui.dispatch.result", { kind: "preview.selectPage", pageSlug, result });
```

(Note the `rejected` branch now `return`s — it previously fell out of the callback, which is
equivalent, but the early return keeps the happy path at the root per the `errore` flat-control-flow
rule.)

- [ ] **Step 3: Verify nothing regressed**

Run: `rtk bun test src/ui/app/model/deps.test.ts`
Expected: PASS, 24 pass / 0 fail (unchanged — tracing is a no-op under `NODE_ENV=test`).

- [ ] **Step 4: Audit the Reatom code you touched**

Run: `/reatom-audit src/ui/app/model/deps.ts`
Expected: no new findings. (`trace` is a synchronous side-effect-free-to-Reatom call inside an
already-`bind`-wrapped callback; it introduces no reactive read.)

- [ ] **Step 5: Commit**

```bash
rtk git add src/ui/app/model/deps.ts
rtk git commit -m "diag(ui): trace the preview.selectPage dispatch and its outcome"
```

> **Careful:** `deps.ts` is one of the twenty files already modified by the uncommitted
> page-switching change. This commit therefore lands part of that change early. That is the one
> deliberate exception in this plan — the trace is unreachable without the surrounding
> `activePageRequest` wiring — and it is why this task is placed before any run. Everything else in
> the working tree stays uncommitted until Task 8.

---

### Task 3: Record every key modifier in the key trace

**Why:** `HANDOFF.md` Finding 3 concludes that "the terminal delivers a bare CSI `[C` with
`ctrl:false`". The evidence for that is `trace("ui.onKey", { key: { name, sequence, ctrl } })` —
which records only `ctrl`. So the log cannot distinguish "the terminal dropped the modifier" from
"the maintainer pressed an unmodified arrow because `hint: false` meant nothing on screen ever
told them a page key existed". `KeyEvent implements ParsedKey`
(`node_modules/@opentui/core/lib/parse.keypress.d.ts:5-23`), which carries `shift`, `meta`,
`option`, `raw` and `eventType` — all already available at the call site, all currently thrown away.

**Files:**
- Modify: `src/ui/app/ui/App.tsx:201-203`

**Interfaces:**
- Consumes: `KeyEvent` from `@opentui/core` (already imported at `App.tsx:1`).
- Produces: a widened `ui.onKey` payload. No resolver semantics change — `resolveKey` still reads
  only `name`/`ctrl`/`sequence` through `KeyLike`.

- [ ] **Step 1: Widen the recorded key**

Replace the `key:` line of the `trace("ui.onKey", …)` call:

```ts
    trace("ui.onKey", {
      // EVERY modifier the terminal reported, not just `ctrl` (HANDOFF Finding 3). Recording one
      // modifier made "the terminal swallowed the chord" and "no chord was pressed" the same
      // line in the log, and a whole finding was drawn from that ambiguity. `raw` is the bytes
      // as received, which is the only way to tell a CSI-encoded chord from a bare arrow.
      key: {
        name: key.name,
        sequence: key.sequence,
        raw: key.raw,
        ctrl: key.ctrl,
        shift: key.shift,
        meta: key.meta,
        option: key.option,
        eventType: key.eventType,
      },
      context,
```

- [ ] **Step 2: Verify the suite is green**

Run: `rtk bun test src/ui/app/`
Expected: PASS (no test asserts the trace payload; this is a pure widening).

- [ ] **Step 3: Type-check**

Run: `rtk bunx tsc --noEmit`
Expected: no errors — every field read exists on `KeyEvent`.

- [ ] **Step 4: Audit the Reatom code you touched**

Run: `/reatom-audit src/ui/app/ui/App.tsx`
Expected: no new findings (`onKey` is already `useWrap`-wrapped, RTM-C02).

- [ ] **Step 5: Commit**

```bash
rtk git add src/ui/app/ui/App.tsx
rtk git commit -m "diag(ui): record every key modifier and the raw bytes in ui.onKey"
```

---

### Task 4: Bind page stepping to keys every terminal delivers

**Why:** `HANDOFF.md` Finding 3 — page stepping is dead on this terminal. `ctrl+left`/`ctrl+right`
depend on the terminal encoding a modifier into a CSI sequence (`\x1b[1;5C`), which not every
terminal, multiplexer or ConPTY path does. `ctrl+b` and `ctrl+n` are C0 control characters
(`0x02`, `0x0E`) — a single byte the terminal cannot fail to deliver, and the same class of key as
the already-bound `ctrl+e` (export) and `ctrl+p` (preview). Neither is bound today, and neither can
steal a character from the composer: `printableChar` (`keymap.ts`) rejects every code below `0x20`.

The arrows stay bound as **aliases**, so the chord keeps working wherever the terminal does encode
it — the gesture the maintainer reached for first is not taken away, it just stops being the only
one.

**Files:**
- Modify: `src/ui/actions/types.ts` (`HotkeyAction`)
- Modify: `src/ui/actions/model/registry.ts` (the two page rows + `HOTKEY_BY_KEY`)
- Modify: `src/ui/actions/model/registry.test.ts`
- Modify: `src/ui/app/model/keymap.test.ts`

**Interfaces:**
- Produces: `HotkeyAction.aliases?: readonly string[]`; `resolveHotkey` resolves aliases as well as
  canonical keys. `page.prev` → `ctrl+b` (aliases `ctrl+left`), `page.next` → `ctrl+n` (aliases
  `ctrl+right`).
- Consumes: `hotkeyName` (`keymap.ts:156`), unchanged — it already spells exactly `ctrl+<name>`.

- [ ] **Step 1: Write the failing tests**

In `src/ui/actions/model/registry.test.ts`, inside `describe("resolveHotkey", …)`:

```ts
  test("page stepping resolves from both its canonical key and its arrow alias", () => {
    expect(resolveHotkey("ctrl+b")?.id).toBe("page.prev");
    expect(resolveHotkey("ctrl+n")?.id).toBe("page.next");
    expect(resolveHotkey("ctrl+left")?.id).toBe("page.prev");
    expect(resolveHotkey("ctrl+right")?.id).toBe("page.next");
  });
```

In `src/ui/app/model/keymap.test.ts`, replace the `"Ctrl+Left / Ctrl+Right -> …"` test with:

```ts
  test("Ctrl+B / Ctrl+N -> the previous / next page tab, even while the composer is focused", () => {
    // C0 control bytes (0x02 / 0x0E) — a single byte no terminal can fail to deliver, unlike a
    // CSI-encoded ctrl+arrow chord (HANDOFF Finding 3).
    expect(resolveKey(key({ name: "b", ctrl: true, sequence: "\x02" }), ctx({ focus: "composer" }))).toEqual({
      kind: "action-execute",
      actionId: "page.prev",
    });
    expect(resolveKey(key({ name: "n", ctrl: true, sequence: "\x0e" }), ctx({ focus: "composer" }))).toEqual({
      kind: "action-execute",
      actionId: "page.next",
    });
  });

  test("Ctrl+Left / Ctrl+Right still step pages where the terminal encodes the chord", () => {
    expect(resolveKey(key({ name: "left", ctrl: true }), ctx({ focus: "composer" }))).toEqual({
      kind: "action-execute",
      actionId: "page.prev",
    });
    expect(resolveKey(key({ name: "right", ctrl: true }), ctx({ focus: "composer" }))).toEqual({
      kind: "action-execute",
      actionId: "page.next",
    });
  });
```

Leave the existing `"unmodified arrows are NOT page switches"` test exactly as it is.

- [ ] **Step 2: Run them to verify they fail**

Run: `rtk bun test src/ui/actions/model/registry.test.ts src/ui/app/model/keymap.test.ts`
Expected: FAIL — `resolveHotkey("ctrl+b")` is `null`, and `ctrl+b`/`ctrl+n` resolve to
`{ kind: "none" }`.

- [ ] **Step 3: Add the alias field**

In `src/ui/actions/types.ts`, inside `HotkeyAction`, after `key`:

```ts
  /**
   * Extra key spellings that resolve to this same action, lowercase.
   *
   * Exists for one reason (2026-07-27, HANDOFF Finding 3): a chord like `ctrl+left` reaches the
   * app only if the terminal encodes the modifier into a CSI sequence, and not every terminal,
   * multiplexer or ConPTY path does. A C0 control byte (`ctrl+b` = 0x02) always arrives. Binding
   * both means the guaranteed key is canonical — it is what the label and any future hint would
   * name — while the intuitive chord keeps working wherever it is delivered.
   */
  readonly aliases?: readonly string[];
```

- [ ] **Step 4: Rebind the two page rows**

In `src/ui/actions/model/registry.ts`, replace the two `hotkey` objects (keeping the long
"PAGE SWITCHING FROM THE KEYBOARD" comment above them, and adding to it the sentence noted below):

```ts
    id: "page.prev",
    execution: { kind: "local", effect: "page-prev" },
    hotkey: {
      id: "page.prev",
      key: "ctrl+b",
      aliases: ["ctrl+left"],
      label: "prev page",
      capability: null,
      hint: false,
    },
  },
  {
    id: "page.next",
    execution: { kind: "local", effect: "page-next" },
    hotkey: {
      id: "page.next",
      key: "ctrl+n",
      aliases: ["ctrl+right"],
      label: "next page",
      capability: null,
      hint: false,
    },
  },
```

Replace the "WHY `ctrl+left`/`ctrl+right` specifically" bullet block in that comment with:

```
  // WHY `ctrl+b`/`ctrl+n` CANONICAL, ARROWS AS ALIASES (CORRECTED 2026-07-27, HANDOFF Finding 3):
  //   - it must be GLOBAL tier: the composer owns focus by default, so a single-char key
  //     (§3.8's other tier) would steal characters from ordinary typing — exactly the bug
  //     `keymap.ts`'s own `home-recheck` comment records for bare `r`;
  //   - `ctrl+left`/`ctrl+right` were the original binding and were DEAD on the maintainer's
  //     terminal: a ctrl+arrow reaches the app only when the terminal encodes the modifier into
  //     a CSI sequence (`\x1b[1;5C`), and this one delivered a bare `\x1b[C`. `ctrl+b`/`ctrl+n`
  //     are C0 control bytes (0x02 / 0x0E) — one byte, no encoding to get wrong;
  //   - neither can be typed into the composer: `printableChar` rejects every code below 0x20;
  //   - the arrows stay as aliases, so the chord still works wherever it IS encoded;
  //   - `ctrl+e` (export) and `ctrl+p` (preview) already establish the ctrl+letter vocabulary.
```

- [ ] **Step 5: Index the aliases**

In `src/ui/actions/model/registry.ts`, replace the `HOTKEY_BY_KEY` construction:

```ts
const HOTKEY_BY_KEY: ReadonlyMap<string, HotkeyAction> = new Map(
  HOTKEYS.flatMap((h) => [
    [h.key, h] as const,
    ...(h.aliases ?? []).map((alias) => [alias, h] as const),
  ]),
);
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `rtk bun test src/ui/actions/ src/ui/app/model/keymap.test.ts src/ui/app/model/intent.test.ts`
Expected: PASS. (`registry.test.ts:60-61` asserts the two `execution` entries, not their keys, so it
is unaffected; `intent.test.ts:227-241` drives the actions by id and is unaffected.)

- [ ] **Step 7: Commit**

```bash
rtk git add src/ui/actions/types.ts src/ui/actions/model/registry.ts src/ui/actions/model/registry.test.ts src/ui/app/model/keymap.test.ts
rtk git commit -m "fix(ui): bind page stepping to keys every terminal delivers"
```

---

### Task 5: Give the host handshake a budget it can actually meet

**Why:** `HANDOFF.md` Finding 4, and it explains the freeze exactly. The child is spawned as
`bun <srcRoot> _host --stdio` (`spawn-command.ts:25`) — a full transpile-and-load of the whole
application graph — and measured **2–3 s just to reach the first statement of `main.tsx`**, against
a `HANDSHAKE_TIMEOUT_MS` of `3_000`. A `HANDSHAKE_TIMEOUT` is classified **budgeted** by
`restart-policy.ts` (only `PROTOCOL_FLOOD`, `STDERR_FLOOD` and `CONTROL_BACKPRESSURE` are
deterministic), so the supervisor restarts up to `MAX_AUTOMATIC_RESTARTS = 3` times — four
incarnations, which is exactly the "run 1 spawned 4 host processes" the handoff counted. The freeze
is that crash loop.

`10_000` matches `MOUNT_TIMEOUT_MS`, which is the existing precedent for "this child needs real
time"; it bounds the worst-case loop at ~40 s instead of leaving it permanently unable to start.
Task 6 makes the real number measurable, so this is a floor to revisit with data, not a guess to
keep forever.

Both call sites hardcode the string `"no host.hello within 3s"`, which would silently lie after the
change — so the constant and the reason move together into one module.

**Files:**
- Create: `src/host/supervisor/model/timeouts.ts`
- Create: `src/host/supervisor/model/timeouts.test.ts`
- Modify: `src/host/supervisor/model/session.ts:49, 192, 205-208`
- Modify: `src/host/supervisor/model/one-shot.ts:20, 104, 116-119`
- Modify: `src/host/supervisor/model/session.test.ts:197-215`
- Modify: `src/host/supervisor/model/one-shot.test.ts:237-252`

**Interfaces:**
- Produces: `HANDSHAKE_TIMEOUT_MS: number`, `HANDSHAKE_TIMEOUT_REASON: string` from
  `./timeouts`.
- Consumes: nothing new.

- [ ] **Step 1: Write the failing test**

Create `src/host/supervisor/model/timeouts.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

import { HANDSHAKE_TIMEOUT_MS, HANDSHAKE_TIMEOUT_REASON } from "./timeouts";

describe("handshake budget", () => {
  // The reason string is operator-facing (it reaches the UI through
  // `ui/preview/model/host-failure-phrase.ts`) and used to be a hand-written literal at two
  // call sites, both saying "3s". Deriving it is what stops the next change to the budget from
  // shipping a message that lies about it.
  test("the reason text is derived from the constant", () => {
    expect(HANDSHAKE_TIMEOUT_REASON).toBe(
      `no host.hello within ${HANDSHAKE_TIMEOUT_MS / 1_000}s`,
    );
  });

  test("the budget clears the measured 2-3 s spawn-to-first-statement gap", () => {
    expect(HANDSHAKE_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `rtk bun test src/host/supervisor/model/timeouts.test.ts`
Expected: FAIL — `Cannot find module './timeouts'`.

- [ ] **Step 3: Create the shared budget**

Create `src/host/supervisor/model/timeouts.ts`:

```ts
/**
 * The handshake budget, shared by the long-lived session driver (`session.ts`) and the one-shot
 * smoke/export driver (`one-shot.ts`).
 *
 * RAISED FROM 3 s (2026-07-27, HANDOFF Finding 4). The design host is this same binary
 * re-invoked as `bun <srcRoot> _host --stdio` (`spawn-command.ts`), so every spawn transpiles and
 * loads the whole application graph before reaching the first statement of `main.tsx` — measured
 * at 2-3 s on the maintainer's machine, against a 3 s budget. A `HANDSHAKE_TIMEOUT` is a
 * BUDGETED failure (`restart-policy.ts`), so missing it does not fail once: it burns all three
 * automatic restarts, spawning four incarnations that each die the same way. That crash loop is
 * what the maintainer experienced as the app freezing.
 *
 * 10 s matches `MOUNT_TIMEOUT_MS`, the existing precedent for "this child legitimately needs
 * seconds". It is a floor chosen to clear a measurement, not a ceiling: `session.ts` now traces
 * the actual wait (`host.handshake`), so the next revision of this number can come from data.
 */
export const HANDSHAKE_TIMEOUT_MS = 10_000;

/** The operator-facing failure reason, derived so it can never drift from the budget above. */
export const HANDSHAKE_TIMEOUT_REASON = `no host.hello within ${HANDSHAKE_TIMEOUT_MS / 1_000}s`;
```

- [ ] **Step 4: Point both drivers at it**

In `src/host/supervisor/model/session.ts`: delete the local `const HANDSHAKE_TIMEOUT_MS = 3_000;`
(line 49), add `import { HANDSHAKE_TIMEOUT_MS, HANDSHAKE_TIMEOUT_REASON } from "./timeouts";` next
to the other `./` imports, change the section comment at line 192 to
`// --- negotiate: send client.hello, await host.hello within the handshake budget ---`, and replace
the literal reason:

```ts
      new SupervisorError({ code: "HANDSHAKE_TIMEOUT", reason: HANDSHAKE_TIMEOUT_REASON }),
```

Do the same in `src/host/supervisor/model/one-shot.ts`: delete its own
`const HANDSHAKE_TIMEOUT_MS = 3_000;` (line 20), import from `./timeouts`, change the section
comment at line 104 to `// --- negotiate: client.hello → host.hello within the handshake budget ---`,
and use `HANDSHAKE_TIMEOUT_REASON` at line 119.

- [ ] **Step 5: Fix the two tests that hardcode the old budget**

Both advance a manual clock by exactly `3_000`, which no longer reaches the deadline.

In `src/host/supervisor/model/session.test.ts`, add the import and update the test body:

```ts
import { HANDSHAKE_TIMEOUT_MS } from "./timeouts";
```

```ts
    // Block until start() is parked in "negotiating" with the handshake timer armed.
    await waitUntil(
      () => session.phase === "negotiating" && clock.pending() >= 1,
      "handshake timer armed",
    );
    clock.advance(HANDSHAKE_TIMEOUT_MS);
```

In `src/host/supervisor/model/one-shot.test.ts`, add the same import, rename the test to
`"no host.hello within the handshake budget is a HANDSHAKE_TIMEOUT"`, and replace
`clock.advance(3_000)` with `clock.advance(HANDSHAKE_TIMEOUT_MS)`.

- [ ] **Step 6: Run the supervisor suite**

Run: `rtk bun test src/host/supervisor/`
Expected: PASS, including `timeouts.test.ts`, `session.test.ts` and `one-shot.test.ts`.

- [ ] **Step 7: Commit**

```bash
rtk git add src/host/supervisor/model/timeouts.ts src/host/supervisor/model/timeouts.test.ts src/host/supervisor/model/session.ts src/host/supervisor/model/one-shot.ts src/host/supervisor/model/session.test.ts src/host/supervisor/model/one-shot.test.ts
rtk git commit -m "fix(host): give the handshake a budget the child can meet"
```

---

### Task 6: Measure the spawn→first-statement gap inside the run log

**Why:** `HANDOFF.md` "What worked" records that the 2–3 s gap of Finding 4 **does not exist in the
log at all** — it had to be reconstructed from the mtimes of `%TEMP%\termcraft-host-*` directories
against the child's own `main.start`. That archaeology should not be needed twice, and it cannot be
done at all for a spawn whose scratch directory Task 7 deletes. The parent and the child already
append to the SAME run file (`spawn.ts`'s `buildChildEnv` forwards `TERMCRAFT_DEBUG_LOG`), so both
ends of the measurement can live in one log.

**Files:**
- Modify: `src/host/supervisor/model/spawn.ts`
- Modify: `src/host/supervisor/model/session.ts` (the handshake wait)

**Interfaces:**
- Produces: trace channels `host.spawn` (`{ scratch, cmd }`) and `host.handshake`
  (`{ sessionId, waitedMs, outcome }`).
- Consumes: `trace` from `infrastructure/debug-log`; `deps.clock.now()` in `session.ts`.

- [ ] **Step 1: Trace the spawn**

In `src/host/supervisor/model/spawn.ts`, add `import { trace } from "infrastructure/debug-log";`
and, immediately after `Bun.spawn` returns:

```ts
        const proc = Bun.spawn({ /* unchanged */ });
        // DIAGNOSTIC: the parent-side instant of the spawn. The child writes `main.start` into
        // this SAME run file (`buildChildEnv` forwards TERMCRAFT_DEBUG_LOG), so the gap between
        // these two lines is the child's startup cost — the number HANDOFF Finding 4 had to
        // reconstruct from scratch-directory mtimes because neither end was logged.
        trace("host.spawn", { scratch, cmd: command.cmd });
        return proc as unknown as SpawnedChild;
```

- [ ] **Step 2: Trace how long the handshake actually waited**

In `src/host/supervisor/model/session.ts`, add `import { trace } from "infrastructure/debug-log";`
and wrap the hello wait:

```ts
    const handshakeStartedAt = deps.clock.now();
    const handshakeDeadlineAt = handshakeStartedAt + HANDSHAKE_TIMEOUT_MS;
    const helloMessage = await nextInbound(
      handshakeDeadlineAt,
      new SupervisorError({ code: "HANDSHAKE_TIMEOUT", reason: HANDSHAKE_TIMEOUT_REASON }),
    );
    // DIAGNOSTIC: the measured wait against the budget, on BOTH outcomes. A timeout that is
    // budgeted (`restart-policy.ts`) is invisible as a single event — it shows up only as four
    // spawns and a frozen app — so the number that decides it belongs in the log.
    trace("host.handshake", {
      sessionId: identity.sessionId,
      waitedMs: deps.clock.now() - handshakeStartedAt,
      budgetMs: HANDSHAKE_TIMEOUT_MS,
      outcome: helloMessage instanceof Error ? helloMessage.code : "hello",
    });
    if (helloMessage instanceof Error) return failWith(helloMessage);
```

> `helloMessage` can be a `SupervisorError` or a `ProtocolError`; both carry `code`. If TypeScript
> narrows `code` to a union that will not stringify cleanly, wrap it: `String(helloMessage.code)`.

- [ ] **Step 3: Run the supervisor suite**

Run: `rtk bun test src/host/supervisor/`
Expected: PASS — tracing is a no-op under `NODE_ENV=test`, so no assertion changes.

- [ ] **Step 4: Type-check**

Run: `rtk bunx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
rtk git add src/host/supervisor/model/spawn.ts src/host/supervisor/model/session.ts
rtk git commit -m "diag(host): log the spawn instant and the measured handshake wait"
```

---

### Task 7: Delete host scratch directories

**Why:** `HANDOFF.md` Finding 5 — `%TEMP%` holds **899** empty `termcraft-host-*` directories.
`defaultScratchDir()` (`spawn.ts:35`) mkdtemps one per spawn and nothing ever removes it. With
Finding 4's crash loop spawning four to six children per run, this grows fast.

Two halves: delete this process's own directories when their child exits, and sweep the strays that
already exist. The sweep only touches directories matching the mkdtemp shape **and** older than a
day, so it can never race a live sibling process's fresh scratch dir; every removal is
failure-tolerant, because on Windows a directory that is still some process's cwd refuses deletion
and that refusal is the correct outcome.

**Files:**
- Modify: `src/host/supervisor/model/spawn.ts`
- Modify: `src/host/supervisor/model/spawn.test.ts`
- Modify: `src/host/supervisor/index.ts`
- Modify: `src/entrypoint/model/create-shell.ts:145`

**Interfaces:**
- Produces: `selectStaleScratchDirs(entries, nowMs, maxAgeMs): string[]` and
  `sweepStaleScratchDirs(): void`, both exported from `host/supervisor`.
- Consumes: `os.tmpdir()`, `fs.readdirSync`/`statSync`/`rmSync`.

- [ ] **Step 1: Write the failing test**

Add to `src/host/supervisor/model/spawn.test.ts`:

```ts
import { buildChildEnv, createBunSpawn, selectStaleScratchDirs } from "./spawn";

describe("selectStaleScratchDirs", () => {
  const DAY = 24 * 60 * 60 * 1_000;
  const now = 1_000 * DAY;

  test("selects only this module's own directories, and only old ones", () => {
    const stale = selectStaleScratchDirs(
      [
        { name: "termcraft-host-4zvjjo", mtimeMs: now - 2 * DAY },
        { name: "termcraft-host-08Z6eW", mtimeMs: now - 60_000 },
        { name: "termcraft-debug", mtimeMs: now - 90 * DAY },
        { name: "some-other-tool-cache", mtimeMs: now - 90 * DAY },
        { name: "termcraft-host-", mtimeMs: now - 90 * DAY },
      ],
      now,
      DAY,
    );

    expect(stale).toEqual(["termcraft-host-4zvjjo"]);
  });

  test("a directory exactly at the age limit is not yet stale", () => {
    expect(
      selectStaleScratchDirs([{ name: "termcraft-host-abcdef", mtimeMs: now - DAY }], now, DAY),
    ).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `rtk bun test src/host/supervisor/model/spawn.test.ts`
Expected: FAIL — `selectStaleScratchDirs` is not exported from `./spawn`.

- [ ] **Step 3: Implement the cleanup**

In `src/host/supervisor/model/spawn.ts`, add below `defaultScratchDir`:

```ts
const SCRATCH_PREFIX = "termcraft-host-";
/** `fs.mkdtempSync` appends exactly six random characters to the prefix. */
const SCRATCH_DIR_PATTERN = /^termcraft-host-[A-Za-z0-9]{6}$/;
/** Old enough that no live incarnation could still be using it — see {@link sweepStaleScratchDirs}. */
const SCRATCH_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

/**
 * Which temp entries are abandoned scratch directories of ours.
 *
 * Pure and name-based, in the same spirit as `debug-log`'s own `selectRunsToPrune`: an entry this
 * module does not recognise as its own is never a candidate, so an operator's directory in
 * `%TEMP%` is not ours to delete. The age bound is what makes this safe against a CONCURRENT
 * termcraft: a sibling's live scratch dir is minutes old, never a day.
 */
export function selectStaleScratchDirs(
  entries: readonly { readonly name: string; readonly mtimeMs: number }[],
  nowMs: number,
  maxAgeMs: number,
): string[] {
  return entries
    .filter((entry) => SCRATCH_DIR_PATTERN.test(entry.name) && nowMs - entry.mtimeMs > maxAgeMs)
    .map((entry) => entry.name);
}

/** Remove one scratch directory; a failure is never worth propagating (see {@link sweepStaleScratchDirs}). */
function removeScratchDir(directory: string): void {
  try {
    fs.rmSync(directory, { recursive: true, force: true });
  } catch {
    // On Windows a directory that is still a live process's cwd refuses deletion. Leaving it is
    // the correct outcome — the next sweep collects it — and a cleanup that could throw into the
    // spawn path would be strictly worse than a stray directory.
  }
}

/**
 * Delete abandoned `termcraft-host-*` directories left by earlier runs (HANDOFF Finding 5: 899 of
 * them had accumulated). Call ONCE per process, from the composition root — never per spawn.
 *
 * A run that dies without reaping — a crash, a kill, a power loss — cannot delete its own
 * directory on exit, so the per-child cleanup below can never be complete on its own.
 */
export function sweepStaleScratchDirs(nowMs: number = Date.now()): void {
  const tmp = os.tmpdir();
  try {
    const entries = fs
      .readdirSync(tmp, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(SCRATCH_PREFIX))
      .map((entry) => ({
        name: entry.name,
        mtimeMs: fs.statSync(path.join(tmp, entry.name)).mtimeMs,
      }));
    for (const name of selectStaleScratchDirs(entries, nowMs, SCRATCH_MAX_AGE_MS)) {
      removeScratchDir(path.join(tmp, name));
    }
  } catch {
    // Best-effort housekeeping: an unreadable %TEMP% must not stop the app from starting.
  }
}
```

Then, in `createBunSpawn`'s success path, attach the per-child cleanup right after the spawn trace
added in Task 6:

```ts
        trace("host.spawn", { scratch, cmd: command.cmd });
        // The scratch dir is this child's cwd, so it can only go once the child is gone.
        // `exited` resolves on every ending — clean exit, SIGTERM from the supervisor's own
        // forced stop, or a crash.
        void proc.exited.then(() => removeScratchDir(scratch));
        return proc as unknown as SpawnedChild;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `rtk bun test src/host/supervisor/model/spawn.test.ts`
Expected: PASS.

- [ ] **Step 5: Export and call the sweep once**

In `src/host/supervisor/index.ts`:

```ts
export { buildChildEnv, createBunSpawn, sweepStaleScratchDirs } from "./model/spawn";
```

In `src/entrypoint/model/create-shell.ts`, add `sweepStaleScratchDirs` to the existing
`host/supervisor` import block and extend line 145:

```ts
  const spawn = deps.spawn ?? createBunSpawn();
  // Once per process, and ONLY on the production spawn path: a test that injects its own `spawn`
  // has no host children and must never reach into the real %TEMP%. Removes directories left by
  // runs that died without reaping (HANDOFF Finding 5).
  if (deps.spawn === undefined) sweepStaleScratchDirs();
```

- [ ] **Step 6: Run the affected suites**

Run: `rtk bun test src/host/supervisor/ src/entrypoint/`
Expected: PASS.

- [ ] **Step 7: Sweep the existing 899 strays once, by hand**

Run: `rtk bun -e "import {sweepStaleScratchDirs} from './src/host/supervisor'; sweepStaleScratchDirs(); console.log('swept')"`
Then confirm: `rtk bash -c 'ls "$TEMP" | grep -c termcraft-host- || true'`
Expected: a much smaller count (only directories younger than a day, plus any Windows refused).

- [ ] **Step 8: Update the architecture docs**

`docs/architecture/` describes the host supervision flow. Check whether the spawn/scratch lifecycle
appears there:

Run: `rtk bash -c 'grep -rln "scratch" docs/architecture/ || true'`

If it does, add the cleanup and the sweep to that document in this commit (architecture-update
skill). If it does not, no doc change is needed — record that in the commit body.

- [ ] **Step 9: Commit**

```bash
rtk git add src/host/supervisor/model/spawn.ts src/host/supervisor/model/spawn.test.ts src/host/supervisor/index.ts src/entrypoint/model/create-shell.ts
rtk git commit -m "fix(host): delete scratch directories on exit and sweep the strays"
```

---

### Task 8: Verify live, then commit the page-switching change

**Why:** `HANDOFF.md` says it plainly — the page-switching change "should not be committed while
its headline feature does not work in the real app". Tasks 1–7 exist to make one run answer that.

**Files:**
- Modify: none by default. If the run exposes a defect, fix it here (or in a follow-up task) before
  the commit.
- Commit: the remaining working-tree change.

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Confirm the whole suite is green before touching the terminal**

Run: `rtk bun test`
Expected: PASS. A red suite makes every observation in the run below ambiguous.

- [ ] **Step 2: Run the app against the two-page fixture**

Run: `rtk bun run src/main.tsx examples/clock`

`examples/clock/.termcraft/pages/calendar/` is the second page (untracked, generated in an earlier
run) that makes the tab strip worth clicking. Then, in the app:

1. wait for the preview to settle;
2. **click** the second tab with the mouse;
3. press **Ctrl+B**, then **Ctrl+N**;
4. press **Ctrl+Left**, then **Ctrl+Right**;
5. quit with `q`.

- [ ] **Step 3: Read the run log**

Run: `rtk bash -c 'ls -t termcraft-debug/*.jsonl | head -1'`
Then read that file. It is JSONL; `rtk json` can filter it.

Check, in this order:

| Channel | What its presence or absence means |
| --- | --- |
| `console.warn` / `console.error` lines after the first UI frame | **Task 1 worked.** If there are none at all across the whole run, do not proceed — the tee is still blind and every conclusion below is worthless. |
| `ui.page.select` | The click reached `selectPage` and both its guards passed. |
| `ui.preview.request` | `requestPreviewForActivePage` was entered and the memo did not swallow the click. **Absent** ⇒ the memo or the subscriber is the culprit, not the Kernel. |
| `ui.dispatch.result {kind:"preview.selectPage"}` | The dispatch was **accepted**. If this is present and `kernel.preview.selectCurrentSource` still never starts, the defect is inside the Kernel handler's entry, not the UI. |
| a `console.warn` naming `preview.selectPage dispatch failed` or `was rejected` | The dispatch was refused — the warn now carries the reason, which closes Finding 2 outright. |
| `ui.onKey` for the four key presses | Read `raw`, `ctrl`, `shift`: this is what finally settles whether the terminal encodes ctrl+arrow at all, and whether Ctrl+B/Ctrl+N resolved to `action-execute`. |
| `host.spawn` vs the child's `main.start` | The startup gap, now measurable in one file. |
| `host.handshake` | `waitedMs` against `budgetMs`. If `waitedMs` still hits the budget, 10 s is not enough and the number needs raising again with this evidence. |
| how many `host.spawn` lines the run has | 1–2 is healthy. 4+ means the crash loop is still running. |

- [ ] **Step 4: Record the outcome**

Update `HANDOFF.md` (gitignored — local only, so it is never part of a commit): move Findings 1, 3,
4 and 5 into "Closed work", and replace Finding 2 with
whatever the log actually showed. If a new defect appeared, write it up there with the same
evidence discipline — a defect is a defect, not a "documented limitation".

- [ ] **Step 5: Fix what the run exposed, if anything**

If the switch still fails, the log now names which of the three layers it dies in. Debug it with
`superpowers:systematic-debugging` — do NOT re-derive the three hypotheses `HANDOFF.md` already
closed (`noOpOutcome` in `selectCurrentSource`, the Reatom wiring of
`pageOverride`/`activePageRequest`, and reasoning from an absent warn).

- [ ] **Step 6: Commit the page-switching change**

Only once a tab click demonstrably switches the preview in the real app:

```bash
rtk git add src/ui/workspace/ src/ui/app/model/intent.ts src/ui/app/model/intent.test.ts src/ui/app/model/deps.ts src/ui/app/model/deps.test.ts src/core/kernel/model/handlers/preview-export.ts src/core/kernel/model/handlers/preview-export.test.ts src/ui/actions/ examples/clock/ docs/architecture/
rtk git status --short
rtk git commit -m "feat(ui): switch pages from the tab strip"
```

`rtk git status --short` before the commit is not ceremony: it is the check that nothing unrelated
was swept in, and that nothing intended was left behind.

- [ ] **Step 7: Audit and lint**

Run: `/reatom-audit src/ui/app/model/deps.ts src/ui/workspace/model/tabs.ts src/ui/workspace/model/page-selection.ts src/ui/workspace/ui/Workspace.tsx`
Run: `rtk bun run lint && rtk bun run fmt:check`
Expected: clean. Fix and amend if not.

---

## Flagged design gaps (for the maintainer, not for an implementer)

Per `CLAUDE.md` — "If the design does not cover a case, ask or flag the gap explicitly — do not
guess."

1. **Keyboard page stepping is undiscoverable.** The keys stay `hint: false` because
   `Workspace.tsx`'s hint row is a verbatim transcription of the design's own key rows, and design
   §3.8 names no page key at all — adding one would diverge from every screen in `design/*.dc.html`.
   The consequence is real, though, and this plan does not fix it: nothing on screen tells a user
   the keys exist, which is very likely why the run log shows unmodified arrows being pressed. This
   is a UX defect, not an acceptable limitation. Deciding it needs a design answer — either a
   design-sanctioned hint, or an explicit decision that page switching is mouse-first and the keys
   are a power-user extra.
2. **`HANDSHAKE_TIMEOUT_MS = 10_000` is a floor chosen from one machine's measurement.** Task 6
   makes the real distribution visible. Revisit with data rather than leaving 10 s as folklore.
3. **The child's 2-3 s startup is treated as a constant here, not fixed.** The host is spawned as
   `bun <srcRoot> _host --stdio`, transpiling the whole application graph per spawn, with an env
   allowlist (`buildChildEnv`) that forwards almost nothing — worth checking whether Bun's
   transpiler cache is reachable in that environment at all. That is a separate investigation, out
   of scope for this plan.

## Self-review

- **Spec coverage** — `HANDOFF.md`'s six "Next steps" map to: 1 → Tasks 1 and 2; 2 → Task 8;
  3 → Tasks 5 and 6; 4 → Task 7; 5 → Task 4; 6 → Task 8 Step 6. Findings 1–5 each have a task.
- **Placeholders** — none: every code step carries the actual code, every run step the actual
  command and its expected result. The one genuinely unknowable part (what the live run shows) is
  Task 8's decision table, which enumerates the outcomes rather than deferring them.
- **Type consistency** — `TeeSink` (Task 1) is used with the same field names in Task 1's tests;
  `HotkeyAction.aliases` (Task 4) is read only in `HOTKEY_BY_KEY`; `HANDSHAKE_TIMEOUT_MS` /
  `HANDSHAKE_TIMEOUT_REASON` (Task 5) are consumed by name in Tasks 5 and 6;
  `selectStaleScratchDirs` / `sweepStaleScratchDirs` (Task 7) keep one signature across `spawn.ts`,
  its test, `index.ts` and `create-shell.ts`.
