# Trust Prompt on `project.open` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `deriveScreen` show the existing `TrustPrompt` popup the first time a `project.open` resolves `untrusted-read-only`, instead of silently landing the Workspace in a dead-end read-only mode with no explanation.

**Architecture:** Thread one new boolean, "has the auto-shown trust prompt been answered this session," through the existing screen-derivation pure function, a new UI-local Reatom atom, and the two intent handlers that already dispatch `project.setTrust`. Give the read-only preview pane an explicit message instead of the generic "preparing preview…" that never resolves. No Kernel, protocol, or capability-guard changes.

**Tech Stack:** TypeScript, Reatom v1001 (`@reatom/core`), Bun test, OpenTUI/React (`@opentui/react`, `reatomComponent`).

## Global Constraints

- The prompt shows **automatically**, the first time `project.open` resolves to `untrusted-read-only` — spec §3.1's "before anything renders" (source spec: `docs/superpowers/specs/2026-07-13-termcraft-design.md` §3.1; design decision restated in `docs/superpowers/specs/2026-08-03-trust-prompt-on-open-design.md`).
- Declining (`Esc`) is a **session-scoped** decision only. There is no in-app way to re-open the prompt or grant trust later in the same run — only relaunching termcraft resets it (a fresh `project.open` re-resolves trust, and the new UI-local flag starts `false` again).
- No Kernel, protocol, or capability-guard changes anywhere in this plan — `project.setTrust` is already legal from `untrusted-read-only` (`core/capabilities/model/guards.ts`), and the popup itself (`src/ui/popups/ui/TrustPrompt.tsx`) already exists and works.
- No new design values invented: the read-only preview message reuses colors/layout already approved elsewhere in the same file (the `filling` branch's amber headline / faint detail pattern), matching the precedent `TrustPrompt.tsx` already set for undesigned trust-related states (CLAUDE.md "design is a source of truth — never invent it").
- Every file that adds a required field to `ScreenInput` or a parameter to `createScreenAtom`/`deriveScreen` must update every existing call site in the same task — a partial update breaks compilation or silently changes an untouched test's meaning.

---

### Task 1: Screen routing — `deriveScreen` gains `trustPromptDismissed`

**Files:**
- Modify: `src/ui/mirror/model/screen.ts:13-29` (`ScreenInput`), `:45-59` (`deriveScreen`), `:66-81` (`createScreenAtom`)
- Modify: `src/ui/mirror/model/mirror.test.ts:89-127,159-167,202-209` (three direct `deriveScreen(...)` calls that predate this field, one of which currently pins the exact bug this task fixes)
- Test: `src/ui/mirror/model/screen.test.ts` (full-file rewrite — every existing `deriveScreen`/`createScreenAtom` call gains the field, plus new cases)

**Interfaces:**
- Consumes: nothing new — `ProjectMirror.trust` (`"trusted" | "untrusted-read-only" | null`), already read.
- Produces: `ScreenInput.trustPromptDismissed: boolean` and `createScreenAtom(deps: { ..., trustPromptDismissed: () => boolean })` — Task 2 wires the real atom into this deps shape.

- [ ] **Step 1: Write the failing tests**

Replace the entire contents of `src/ui/mirror/model/screen.test.ts` with:

```ts
import { describe, expect, test } from "bun:test";

import { atom } from "@reatom/core";

import { uuidv7 } from "infrastructure/uuid";

import type { ProjectMirror } from "../types";
import { MIN_FRAME, createScreenAtom, deriveScreen } from "./screen";

const OK = { w: 120, h: 40 };
const projectId = uuidv7();

describe("deriveScreen (phase-7 plan D6)", () => {
  test("below the minimum frame on either axis -> enlarge, over everything else", () => {
    expect(
      deriveScreen({
        projectId,
        trust: "trusted",
        terminal: { w: 79, h: 40 },
        startupOpenPending: false,
        openFailed: false,
        trustPromptDismissed: false,
      }),
    ).toBe("enlarge");
    expect(
      deriveScreen({
        projectId,
        trust: "trusted",
        terminal: { w: 120, h: 23 },
        startupOpenPending: false,
        openFailed: false,
        trustPromptDismissed: false,
      }),
    ).toBe("enlarge");
    expect(
      deriveScreen({
        projectId: null,
        trust: null,
        terminal: { w: 10, h: 10 },
        startupOpenPending: false,
        openFailed: false,
        trustPromptDismissed: false,
      }),
    ).toBe("enlarge");
  });

  test("no project -> home", () => {
    expect(
      deriveScreen({
        projectId: null,
        trust: null,
        terminal: OK,
        startupOpenPending: false,
        openFailed: false,
        trustPromptDismissed: false,
      }),
    ).toBe("home");
  });

  test("untrusted-read-only project, prompt not yet dismissed -> trust-prompt (spec 2026-08-03 — trust prompt on open)", () => {
    expect(
      deriveScreen({
        projectId,
        trust: "untrusted-read-only",
        terminal: OK,
        startupOpenPending: false,
        openFailed: false,
        trustPromptDismissed: false,
      }),
    ).toBe("trust-prompt");
  });

  test("untrusted-read-only project, prompt already dismissed -> read-only (spec 2026-08-03 — trust prompt on open)", () => {
    expect(
      deriveScreen({
        projectId,
        trust: "untrusted-read-only",
        terminal: OK,
        startupOpenPending: false,
        openFailed: false,
        trustPromptDismissed: true,
      }),
    ).toBe("read-only");
  });

  test("project open but trust undecided -> trust-prompt", () => {
    expect(
      deriveScreen({
        projectId,
        trust: null,
        terminal: OK,
        startupOpenPending: false,
        openFailed: false,
        trustPromptDismissed: false,
      }),
    ).toBe("trust-prompt");
  });

  test("trusted project at a big-enough terminal -> workspace", () => {
    expect(
      deriveScreen({
        projectId,
        trust: "trusted",
        terminal: OK,
        startupOpenPending: false,
        openFailed: false,
        trustPromptDismissed: false,
      }),
    ).toBe("workspace");
  });

  test("MIN_FRAME is 80x24", () => {
    expect(MIN_FRAME).toEqual({ w: 80, h: 24 });
  });
});

describe("createScreenAtom", () => {
  test("recomputes as the project slice and terminal size change", () => {
    const project = atom<ProjectMirror>(
      {
        projectId: null,
        activePageSlug: null,
        activeChatId: null,
        trust: null,
        openFailure: null,
        opening: false,
      },
      "test.project",
    );
    const terminal = atom(OK, "test.terminal");
    const screen = createScreenAtom({
      project: () => project(),
      terminal: () => terminal(),
      startupOpenPending: () => false,
      trustPromptDismissed: () => false,
    });

    expect(screen()).toBe("home");
    project.set({
      projectId,
      activePageSlug: "main",
      activeChatId: uuidv7(),
      trust: "trusted",
      openFailure: null,
      opening: false,
    });
    expect(screen()).toBe("workspace");
    terminal.set({ w: 40, h: 20 });
    expect(screen()).toBe("enlarge");
  });

  test("recomputes to workspace when startupOpenPending flips true", () => {
    const project = atom<ProjectMirror>(
      {
        projectId: null,
        activePageSlug: null,
        activeChatId: null,
        trust: null,
        openFailure: null,
        opening: false,
      },
      "test.project.startupOpenPending",
    );
    const terminal = atom(OK, "test.terminal.startupOpenPending");
    const startupOpenPending = atom(false, "test.startupOpenPending");
    const screen = createScreenAtom({
      project: () => project(),
      terminal: () => terminal(),
      startupOpenPending: () => startupOpenPending(),
      trustPromptDismissed: () => false,
    });

    expect(screen()).toBe("home");
    startupOpenPending.set(true);
    expect(screen()).toBe("workspace");
  });

  test("recomputes to trust-prompt then read-only as trustPromptDismissed flips (spec 2026-08-03 — trust prompt on open)", () => {
    const project = atom<ProjectMirror>(
      {
        projectId,
        activePageSlug: null,
        activeChatId: null,
        trust: "untrusted-read-only",
        openFailure: null,
        opening: false,
      },
      "test.project.trustPromptDismissed",
    );
    const terminal = atom(OK, "test.terminal.trustPromptDismissed");
    const trustPromptDismissed = atom(false, "test.trustPromptDismissed");
    const screen = createScreenAtom({
      project: () => project(),
      terminal: () => terminal(),
      startupOpenPending: () => false,
      trustPromptDismissed: () => trustPromptDismissed(),
    });

    expect(screen()).toBe("trust-prompt");
    trustPromptDismissed.set(true);
    expect(screen()).toBe("read-only");
  });
});

const OPENING = { projectId: null, trust: null, terminal: OK } as const;

describe("deriveScreen — the workspace-first opening state (spec 2026-08-02)", () => {
  test("a startup open in flight mounts the Workspace, not Home", () => {
    expect(
      deriveScreen({
        ...OPENING,
        startupOpenPending: true,
        openFailed: false,
        trustPromptDismissed: false,
      }),
    ).toBe("workspace");
  });

  test("no startup open pending still parks on Home — a genuinely fresh directory", () => {
    // Also the shape `startupOpenPending` lands in once a startup `project.open` dispatch is
    // abandoned (`run-app.ts`'s dispatch failed or was rejected): neither `finishOpen` nor
    // `blockOpen` will ever arrive for it, so `startupOpenPending` going false is the only thing
    // that can end that state — `deriveScreen` is a pure function of these same inputs either way,
    // so there is no separate case to cover here.
    expect(
      deriveScreen({
        ...OPENING,
        startupOpenPending: false,
        openFailed: false,
        trustPromptDismissed: false,
      }),
    ).toBe("home");
  });

  test("a blocked open drops back to Home, which owns the failure panel and the retry", () => {
    expect(
      deriveScreen({
        ...OPENING,
        startupOpenPending: true,
        openFailed: true,
        trustPromptDismissed: false,
      }),
    ).toBe("home");
  });

  test("the enlarge placeholder still outranks the opening state", () => {
    expect(
      deriveScreen({
        ...OPENING,
        terminal: { w: 79, h: 40 },
        startupOpenPending: true,
        openFailed: false,
        trustPromptDismissed: false,
      }),
    ).toBe("enlarge");
  });

  test("finishOpen resolves the opening state to a real Workspace, and to read-only when untrusted and already dismissed", () => {
    expect(
      deriveScreen({
        projectId,
        trust: "trusted",
        terminal: OK,
        startupOpenPending: true,
        openFailed: false,
        trustPromptDismissed: false,
      }),
    ).toBe("workspace");
    expect(
      deriveScreen({
        projectId,
        trust: "untrusted-read-only",
        terminal: OK,
        startupOpenPending: true,
        openFailed: false,
        trustPromptDismissed: true,
      }),
    ).toBe("read-only");
  });
});
```

Then apply these three edits to `src/ui/mirror/model/mirror.test.ts` (it also calls `deriveScreen` directly, bypassing `createScreenAtom`):

Edit A — old:
```ts
    expect(
      deriveScreen({
        projectId: m.project().projectId,
        trust: m.project().trust,
        terminal: TERMINAL,
        startupOpenPending: false,
        openFailed: false,
      }),
    ).toBe("home");

    const projectId = uuidv7();
```
new:
```ts
    expect(
      deriveScreen({
        projectId: m.project().projectId,
        trust: m.project().trust,
        terminal: TERMINAL,
        startupOpenPending: false,
        openFailed: false,
        trustPromptDismissed: false,
      }),
    ).toBe("home");

    const projectId = uuidv7();
```

Edit B — this is the one assertion whose EXPECTED VALUE changes, because it currently pins the exact bug this task fixes (a live subscriber's project resolving to `untrusted-read-only` used to land silently on `"read-only"`; it must now land on `"trust-prompt"` first). Old:
```ts
    expect(m.project().projectId).toBe(projectId);
    expect(m.project().trust).toBe("untrusted-read-only");
    // The transition genuinely left "home" (to "read-only", since trust is not yet granted)
    // — the exact condition the bug report named as "can never become true for a live
    // subscriber".
    expect(
      deriveScreen({
        projectId: m.project().projectId,
        trust: m.project().trust,
        terminal: TERMINAL,
        startupOpenPending: false,
        openFailed: false,
      }),
    ).toBe("read-only");
  });
```
new:
```ts
    expect(m.project().projectId).toBe(projectId);
    expect(m.project().trust).toBe("untrusted-read-only");
    // The transition genuinely left "home" (to "trust-prompt", not silently "read-only" —
    // spec 2026-08-03's trust-prompt-on-open fix: a never-before-trusted project must show
    // the trust popup before landing read-only, and `trustPromptDismissed` starts `false`
    // every session) — the exact condition the bug report named as "can never become true
    // for a live subscriber".
    expect(
      deriveScreen({
        projectId: m.project().projectId,
        trust: m.project().trust,
        terminal: TERMINAL,
        startupOpenPending: false,
        openFailed: false,
        trustPromptDismissed: false,
      }),
    ).toBe("trust-prompt");
  });
```

Edit C — old:
```ts
    expect(
      deriveScreen({
        projectId: m.project().projectId,
        trust: m.project().trust,
        terminal: TERMINAL,
        startupOpenPending: false,
        openFailed: false,
      }),
    ).toBe("workspace");
  });
```
new:
```ts
    expect(
      deriveScreen({
        projectId: m.project().projectId,
        trust: m.project().trust,
        terminal: TERMINAL,
        startupOpenPending: false,
        openFailed: false,
        trustPromptDismissed: false,
      }),
    ).toBe("workspace");
  });
```

Edit D — old:
```ts
    expect(
      deriveScreen({
        projectId: m.project().projectId,
        trust: m.project().trust,
        terminal: TERMINAL,
        startupOpenPending: false,
        openFailed: false,
      }),
    ).toBe("home");
  });

  test("kernel.project.blockOpen records the reason, survives finishClose, and clears on a later finishOpen", () => {
```
new:
```ts
    expect(
      deriveScreen({
        projectId: m.project().projectId,
        trust: m.project().trust,
        terminal: TERMINAL,
        startupOpenPending: false,
        openFailed: false,
        trustPromptDismissed: false,
      }),
    ).toBe("home");
  });

  test("kernel.project.blockOpen records the reason, survives finishClose, and clears on a later finishOpen", () => {
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `bun test src/ui/mirror/model/screen.test.ts src/ui/mirror/model/mirror.test.ts`
Expected: FAIL — the two new `screen.test.ts` cases ("prompt not yet dismissed -> trust-prompt", the `createScreenAtom` reactivity case) and `mirror.test.ts`'s Edit B assertion (now expecting `"trust-prompt"`) all fail against the current `deriveScreen`, which still returns `"read-only"` unconditionally for `trust === "untrusted-read-only"`.

- [ ] **Step 3: Implement `deriveScreen`/`createScreenAtom`**

In `src/ui/mirror/model/screen.ts`, add the field to `ScreenInput` right after `openFailed`:

```ts
  /** `ProjectMirror.openFailure !== null` — a blocked open, which Home owns. */
  readonly openFailed: boolean;
  /**
   * Whether the auto-shown trust prompt (spec §3.1, 2026-08-03 trust-prompt-on-open fix) has
   * already been answered this session (`ui/app/model/deps.ts`'s `UiLocalState
   * .trustPromptDismissed`, set by the `trust-accept`/`trust-decline` intents). Starts `false` on
   * every process launch — see that atom's own doc comment for why there is no in-session way
   * to flip it back.
   */
  readonly trustPromptDismissed: boolean;
}
```

Change `deriveScreen`'s trust branch from:
```ts
  if (input.trust === "untrusted-read-only") return "read-only";
  if (input.trust === null) return "trust-prompt";
  return "workspace";
```
to:
```ts
  if (input.trust === "untrusted-read-only") {
    return input.trustPromptDismissed ? "read-only" : "trust-prompt";
  }
  if (input.trust === null) return "trust-prompt";
  return "workspace";
```

Change `createScreenAtom` from:
```ts
export function createScreenAtom(deps: {
  readonly project: () => ProjectMirror;
  readonly terminal: () => Readonly<{ w: number; h: number }>;
  readonly startupOpenPending: () => boolean;
}): Computed<ScreenKind> {
  return computed(() => {
    const project = deps.project();
    return deriveScreen({
      projectId: project.projectId,
      trust: project.trust,
      terminal: deps.terminal(),
      startupOpenPending: deps.startupOpenPending(),
      openFailed: project.openFailure !== null,
    });
  }, "ui.mirror.screen");
}
```
to:
```ts
export function createScreenAtom(deps: {
  readonly project: () => ProjectMirror;
  readonly terminal: () => Readonly<{ w: number; h: number }>;
  readonly startupOpenPending: () => boolean;
  readonly trustPromptDismissed: () => boolean;
}): Computed<ScreenKind> {
  return computed(() => {
    const project = deps.project();
    return deriveScreen({
      projectId: project.projectId,
      trust: project.trust,
      terminal: deps.terminal(),
      startupOpenPending: deps.startupOpenPending(),
      openFailed: project.openFailure !== null,
      trustPromptDismissed: deps.trustPromptDismissed(),
    });
  }, "ui.mirror.screen");
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `bun test src/ui/mirror/model/screen.test.ts src/ui/mirror/model/mirror.test.ts`
Expected: PASS — every case, including the two changed in this task.

Note: `src/ui/app/model/deps.ts` still calls `createScreenAtom` without the new `trustPromptDismissed` deps field at this point in the plan — that call site is fixed in Task 2, and until then `bun test` on the WHOLE suite (not just these two files) will fail at runtime wherever `deps.ts`'s `screen` atom is exercised (it calls `deps.trustPromptDismissed()`, `undefined` until Task 2 lands). Running the two files named above in isolation is what this step checks.

- [ ] **Step 5: Commit**

```bash
git add src/ui/mirror/model/screen.ts src/ui/mirror/model/screen.test.ts src/ui/mirror/model/mirror.test.ts
git commit -m "feat(ui): deriveScreen shows trust-prompt before read-only until dismissed"
```

---

### Task 2: UI-local `trustPromptDismissed` atom wired into `createUiDeps`

**Files:**
- Modify: `src/ui/app/model/deps.ts:57-152` (`UiLocalState`), `:346-357` (atom declaration + `createScreenAtom` call), `:833-848` (`local: UiLocalState = {...}`)
- Test: `src/ui/app/model/deps.test.ts` (new describe block; new import)

**Interfaces:**
- Consumes: `ScreenInput.trustPromptDismissed` / `createScreenAtom`'s `trustPromptDismissed: () => boolean` deps field (Task 1).
- Produces: `UiLocalState.trustPromptDismissed: Atom<boolean>` — Task 3's `trust-accept`/`trust-decline` intent handlers call `.set(true)` on it.

- [ ] **Step 1: Write the failing test**

In `src/ui/app/model/deps.test.ts`, change the import line:

old:
```ts
import {
  TEST_NONCE,
  TEST_SHA,
  createFakeKernel,
  createFakePreviewSession,
  event,
} from "ui/testing";
```
new:
```ts
import {
  TEST_NONCE,
  TEST_SHA,
  createFakeKernel,
  createFakePreviewSession,
  event,
  snapshot,
} from "ui/testing";
```

Then insert this new describe block right after the `startupOpenPending / startupOpenFailure` describe block closes and before `describe("createUiDeps requestExit ...)`:

old:
```ts
    expect(deps.screen()).toBe("home");
    unsubscribe();
  });
});

describe("createUiDeps requestExit (phase-8 Task 11 / WP-10)", () => {
```
new:
```ts
    expect(deps.screen()).toBe("home");
    unsubscribe();
  });
});

describe("trustPromptDismissed — the auto-shown trust prompt (spec 2026-08-03 — trust prompt on open)", () => {
  test("defaults to false, so a never-before-trusted project shows the prompt first", () => {
    const deps = createUiDeps(createFakeKernel(), { w: 120, h: 36 });
    deps.mirror.apply(
      snapshot({
        projectId: uuidv7(),
        activePageSlug: null,
        activeChatId: uuidv7(),
        trust: "untrusted-read-only",
      }),
    );
    expect(deps.local.trustPromptDismissed()).toBe(false);
    expect(deps.screen()).toBe("trust-prompt");
  });

  test("flipping it true resolves the screen the rest of the way to read-only", () => {
    const deps = createUiDeps(createFakeKernel(), { w: 120, h: 36 });
    deps.mirror.apply(
      snapshot({
        projectId: uuidv7(),
        activePageSlug: null,
        activeChatId: uuidv7(),
        trust: "untrusted-read-only",
      }),
    );
    expect(deps.screen()).toBe("trust-prompt");

    deps.local.trustPromptDismissed.set(true);
    expect(deps.screen()).toBe("read-only");
  });
});

describe("createUiDeps requestExit (phase-8 Task 11 / WP-10)", () => {
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `bun test src/ui/app/model/deps.test.ts`
Expected: FAIL with a thrown error such as `deps.local.trustPromptDismissed is not a function` — `UiLocalState` has no such field yet, and `createScreenAtom`'s deps object built inside `createUiDeps` does not supply `trustPromptDismissed` either (Task 1 made it required), so `deps.screen()` itself throws.

- [ ] **Step 3: Implement the atom and wire it through `createUiDeps`**

In `src/ui/app/model/deps.ts`, add the field to `UiLocalState` right after `startupOpenFailure`:

old:
```ts
  readonly startupOpenFailure: Atom<ProjectOpenFailure | null>;
}
```
new:
```ts
  readonly startupOpenFailure: Atom<ProjectOpenFailure | null>;
  /**
   * Whether the auto-shown trust prompt (spec §3.1) has been answered this
   * session — set by `trust-accept`/`trust-decline` (`ui/app/model/intent.ts`).
   * Starts `false` on every process launch, and only ever goes `false -> true`:
   * the only way to see the prompt again is relaunching termcraft, which
   * re-resolves trust from a fresh `project.open` and rebuilds this atom fresh
   * (confirmed with the user — no in-session re-ask affordance).
   */
  readonly trustPromptDismissed: Atom<boolean>;
}
```

Declare the atom above `screen` and thread it into `createScreenAtom`'s deps — old:
```ts
  const startupOpenFailure = atom<ProjectOpenFailure | null>(null, "ui.local.startupOpenFailure");
  const screen = createScreenAtom({
    project: () => mirror.project(),
    terminal: () => terminal(),
    startupOpenPending: () => startupOpenPending(),
  });
```
new:
```ts
  const startupOpenFailure = atom<ProjectOpenFailure | null>(null, "ui.local.startupOpenFailure");
  // The auto-shown trust prompt's own answered flag (spec §3.1, 2026-08-03 trust-prompt-on-open
  // fix) — see `UiLocalState.trustPromptDismissed`'s doc comment for the full lifecycle. Declared
  // here, above `screen`, because `createScreenAtom` reads it on every recompute.
  const trustPromptDismissed = atom(false, "ui.local.trustPromptDismissed");
  const screen = createScreenAtom({
    project: () => mirror.project(),
    terminal: () => terminal(),
    startupOpenPending: () => startupOpenPending(),
    trustPromptDismissed: () => trustPromptDismissed(),
  });
```

Add it to the `local: UiLocalState = {...}` object — old:
```ts
    startupOpenPending,
    startupOpenFailure,
  };
```
new:
```ts
    startupOpenPending,
    startupOpenFailure,
    trustPromptDismissed,
  };
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `bun test src/ui/app/model/deps.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/app/model/deps.ts src/ui/app/model/deps.test.ts
git commit -m "feat(ui): wire trustPromptDismissed into createUiDeps' screen atom"
```

---

### Task 3: `trust-accept` / `trust-decline` mark the prompt answered

**Files:**
- Modify: `src/ui/app/model/intent.ts:262-279`
- Modify: `src/ui/app/model/intent.test.ts:649-662`
- Modify: `src/ui/app/model/deps.test.ts` (extend Task 2's new describe block; new import)

**Interfaces:**
- Consumes: `UiLocalState.trustPromptDismissed: Atom<boolean>` (Task 2).
- Produces: nothing new — this is the last piece that makes the flag observable end to end through the existing intents.

- [ ] **Step 1: Write the failing tests**

In `src/ui/app/model/intent.test.ts`, change the existing test — old:
```ts
  test("trust accept and decline dispatch the exact project.setTrust payloads", () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(
      kernel,
      { w: 120, h: 36 },
      { root: "/project", workspaceIdentity: "workspace-id", projectExists: false },
    );
    applyIntent({ kind: "trust-accept" }, deps);
    applyIntent({ kind: "trust-decline" }, deps);
    expect(kernel.dispatched.map((raw) => (raw as { payload: unknown }).payload)).toEqual([
      { trust: "trusted", workspaceIdentity: "workspace-id" },
      { trust: "untrusted-read-only", workspaceIdentity: "workspace-id" },
    ]);
  });
```
new:
```ts
  test("trust accept and decline dispatch the exact project.setTrust payloads and mark the prompt answered", () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(
      kernel,
      { w: 120, h: 36 },
      { root: "/project", workspaceIdentity: "workspace-id", projectExists: false },
    );
    expect(deps.local.trustPromptDismissed()).toBe(false);
    applyIntent({ kind: "trust-accept" }, deps);
    expect(deps.local.trustPromptDismissed()).toBe(true);
    applyIntent({ kind: "trust-decline" }, deps);
    expect(kernel.dispatched.map((raw) => (raw as { payload: unknown }).payload)).toEqual([
      { trust: "trusted", workspaceIdentity: "workspace-id" },
      { trust: "untrusted-read-only", workspaceIdentity: "workspace-id" },
    ]);
    expect(deps.local.trustPromptDismissed()).toBe(true);
  });
```

In `src/ui/app/model/deps.test.ts`, add the import:

old:
```ts
import { UiPreviewStreamError, createUiDeps } from "./deps";
```
new:
```ts
import { UiPreviewStreamError, createUiDeps } from "./deps";
import { applyIntent } from "./intent";
```

Then extend the `trustPromptDismissed` describe block Task 2 added, inserting two end-to-end tests before its closing brace — old:
```ts
    deps.local.trustPromptDismissed.set(true);
    expect(deps.screen()).toBe("read-only");
  });
});

describe("createUiDeps requestExit (phase-8 Task 11 / WP-10)", () => {
```
new:
```ts
    deps.local.trustPromptDismissed.set(true);
    expect(deps.screen()).toBe("read-only");
  });

  test("trust-accept resolves the screen trust-prompt -> workspace end to end", () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(
      kernel,
      { w: 120, h: 36 },
      { root: "/project", workspaceIdentity: "workspace-id", projectExists: false },
    );
    deps.mirror.apply(
      snapshot({
        projectId: uuidv7(),
        activePageSlug: null,
        activeChatId: uuidv7(),
        trust: "untrusted-read-only",
      }),
    );
    expect(deps.screen()).toBe("trust-prompt");

    applyIntent({ kind: "trust-accept" }, deps);
    // `applyIntent`'s dispatch only reaches the FakeKernel's recorded `dispatched` list — unlike
    // a real Kernel it never folds anything back on its own — so the mirror's own trust grant is
    // simulated the same way `mirror.test.ts`'s "kernel.project.setTrust moves the screen the
    // rest of the way to workspace" test does, by applying the SAME fold the real Kernel would
    // eventually publish.
    kernel.emit(
      event("kernel.stateChanged", {
        modelId: "kernel.project.state",
        action: "kernel.project.setTrust",
        previousTag: "ready",
        nextTag: "ready",
        metadata: { workspaceIdentity: "workspace-id", trust: "trusted" },
      }),
    );
    expect(deps.local.trustPromptDismissed()).toBe(true);
    expect(deps.screen()).toBe("workspace");
  });

  test("trust-decline resolves the screen trust-prompt -> read-only end to end", () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(
      kernel,
      { w: 120, h: 36 },
      { root: "/project", workspaceIdentity: "workspace-id", projectExists: false },
    );
    deps.mirror.apply(
      snapshot({
        projectId: uuidv7(),
        activePageSlug: null,
        activeChatId: uuidv7(),
        trust: "untrusted-read-only",
      }),
    );
    expect(deps.screen()).toBe("trust-prompt");

    applyIntent({ kind: "trust-decline" }, deps);
    // Unlike accept, decline needs no Kernel round trip to observe on screen: the mirror's own
    // `trust` was already "untrusted-read-only" (that is WHY the prompt was showing), so
    // `trustPromptDismissed` flipping true is the only thing the screen atom needed.
    expect(deps.local.trustPromptDismissed()).toBe(true);
    expect(deps.screen()).toBe("read-only");
  });
});

describe("createUiDeps requestExit (phase-8 Task 11 / WP-10)", () => {
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `bun test src/ui/app/model/intent.test.ts src/ui/app/model/deps.test.ts`
Expected: FAIL — every new assertion on `deps.local.trustPromptDismissed()` reads `false` where `true` is expected, because `intent.ts`'s `trust-accept`/`trust-decline` arms do not yet touch that atom.

- [ ] **Step 3: Implement the two intent handlers**

In `src/ui/app/model/intent.ts`, old:
```ts
    case "trust-accept":
      dispatchAndReport(
        dispatcher.dispatch("project.setTrust", {
          trust: "trusted",
          workspaceIdentity: deps.env.workspaceIdentity,
        }),
        "project.setTrust:trusted",
      );
      return;
    case "trust-decline":
      dispatchAndReport(
        dispatcher.dispatch("project.setTrust", {
          trust: "untrusted-read-only",
          workspaceIdentity: deps.env.workspaceIdentity,
        }),
        "project.setTrust:untrusted-read-only",
      );
      return;
```
new:
```ts
    case "trust-accept":
      dispatchAndReport(
        dispatcher.dispatch("project.setTrust", {
          trust: "trusted",
          workspaceIdentity: deps.env.workspaceIdentity,
        }),
        "project.setTrust:trusted",
      );
      local.trustPromptDismissed.set(true);
      return;
    case "trust-decline":
      dispatchAndReport(
        dispatcher.dispatch("project.setTrust", {
          trust: "untrusted-read-only",
          workspaceIdentity: deps.env.workspaceIdentity,
        }),
        "project.setTrust:untrusted-read-only",
      );
      local.trustPromptDismissed.set(true);
      return;
```

(No `wrap`/`bind` needed — both are plain synchronous `.set()` calls inside the same handler frame as the dispatch call, exactly like every other case arm in this switch. `local` is already destructured at the top of `applyIntent`.)

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `bun test src/ui/app/model/intent.test.ts src/ui/app/model/deps.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/app/model/intent.ts src/ui/app/model/intent.test.ts src/ui/app/model/deps.test.ts
git commit -m "feat(ui): trust-accept/trust-decline mark the auto-shown trust prompt answered"
```

---

### Task 4: Workspace read-only preview messaging

**Files:**
- Modify: `src/ui/workspace/ui/Workspace.tsx:302-430` (`renderPreviewRegion`), `:825-841` (call site)
- Test: `src/ui/workspace/ui/Workspace.test.tsx`

**Interfaces:**
- Consumes: `props.readOnly: boolean` (already a `Workspace` prop, already computed by `App.tsx` as `screen === "read-only"` — no change needed there).
- Produces: nothing consumed by a later task — this task is independent of Tasks 1-3 and can be done in any order relative to them.

- [ ] **Step 1: Write the failing test**

Insert this new describe block into `src/ui/workspace/ui/Workspace.test.tsx` right after the "Workspace read-only presentation" describe block closes — old:
```tsx
    const attach = findRun(rows, "read-only — Send disabled");
    expect(attach && extractRgb(attach.fg)).toBe(SHELL_PALETTE.red);
  });
});

describe("Workspace tab-strip overflow indicators (design 18-tab-management.dc.html, drawTabs o.scroll)", () => {
```
new:
```tsx
    const attach = findRun(rows, "read-only — Send disabled");
    expect(attach && extractRgb(attach.fg)).toBe(SHELL_PALETTE.red);
  });
});

describe("Workspace read-only preview messaging (spec 2026-08-03 — trust prompt on open)", () => {
  test("a read-only project with pages and no live frame shows the disabled-preview message, never 'preparing preview…'", async () => {
    const deps = createUiDeps(createFakeKernel(), { w: 120, h: 36 });
    deps.mirror.apply(
      snapshot({
        projectId: uuidv7(),
        activePageSlug: "main",
        activeChatId: uuidv7(),
        trust: "untrusted-read-only",
        pageDescriptors: [
          {
            status: "ready",
            pageSlug: "main",
            sourceHash: TEST_SHA,
            title: "Main",
            minSize: { w: 80, h: 24 },
            theme: "dark-default",
            kitApiVersion: 1,
          },
        ],
      }),
    );
    const handle = await createHeadlessRenderer({ w: 120, h: 36 });
    open = handle;
    handle.mount(<Workspace deps={deps} readOnly />);
    await handle.render();
    const rows = handle.capture().rows;
    const text = allText(rows);
    expect(text).toContain("preview disabled");
    expect(text).toContain("project is read-only — relaunch to be asked again");
    expect(text).not.toContain("preparing preview…");
    const headline = findRun(rows, "preview disabled");
    expect(headline && extractRgb(headline.fg)).toBe(SHELL_PALETTE.amber);
  });
});

describe("Workspace tab-strip overflow indicators (design 18-tab-management.dc.html, drawTabs o.scroll)", () => {
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `bun test src/ui/workspace/ui/Workspace.test.tsx -t "read-only preview messaging"`
Expected: FAIL — the pane currently falls through to the generic `ws-preview-ready` block and renders "preparing preview…" for this scenario (pages exist, no live frame, `preview.phase` is `"none"`), because `renderPreviewRegion` has no `readOnly` branch yet.

- [ ] **Step 3: Implement the `renderPreviewRegion` branch**

In `src/ui/workspace/ui/Workspace.tsx`, add the parameter — old:
```tsx
  filling: boolean,
  agentBlocked: ReturnType<typeof agentBlockedNote>,
) {
  if (filling) {
```
new:
```tsx
  filling: boolean,
  agentBlocked: ReturnType<typeof agentBlockedNote>,
  readOnly: boolean,
) {
  if (filling) {
```

Add the new branch right before the final fallback — old:
```tsx
  return (
    <box id="ws-preview-ready" flexGrow={1} alignItems="center" justifyContent="center">
      <text id="ws-preview-ready-text" fg={SHELL_PALETTE.faint}>
        preparing preview…
      </text>
    </box>
  );
}
```
new:
```tsx
  if (readOnly) {
    // A never-before-trusted project that declined the trust prompt (spec §3.1) keeps preview
    // execution disabled for the rest of this run (`ui/app/model/deps.ts`'s
    // `createScreenAtom`/`ScreenInput.trustPromptDismissed`) — this replaces the generic
    // "preparing preview…" fallback below, which never resolves for a project the Kernel will
    // never render. DIVERGENCE (no `design/*.dc.html` mock covers this exact copy, matching the
    // precedent `TrustPrompt.tsx` already set for undesigned trust-related states): colors and
    // layout are reused from the already-approved `filling` branch above — amber headline, one
    // blank spacer row, faint detail line, no spinner, since nothing here is pending.
    return (
      <box
        id="ws-preview-read-only"
        flexGrow={1}
        flexDirection="column"
        alignItems="center"
        justifyContent="center"
      >
        <text id="ws-preview-read-only-headline" fg={SHELL_PALETTE.amber} attributes={BOLD}>
          preview disabled
        </text>
        <text id="ws-preview-read-only-spacer"> </text>
        <text id="ws-preview-read-only-detail" fg={SHELL_PALETTE.faint}>
          project is read-only — relaunch to be asked again
        </text>
      </box>
    );
  }
  return (
    <box id="ws-preview-ready" flexGrow={1} alignItems="center" justifyContent="center">
      <text id="ws-preview-ready-text" fg={SHELL_PALETTE.faint}>
        preparing preview…
      </text>
    </box>
  );
}
```

Thread `props.readOnly` at the call site — old:
```tsx
          {renderPreviewRegion(
            preview,
            uiFrame,
            descriptors.length > 0,
            previewRegion,
            {
              pins,
              pendingPin,
              selectionRect,
              hover,
              onRendered: acknowledgeRenderedFrame,
              onMouseMove: onPreviewMouseMove,
              onMouseDown: onPreviewMouseDown,
            },
            filling,
            agentBlocked,
          )}
```
new:
```tsx
          {renderPreviewRegion(
            preview,
            uiFrame,
            descriptors.length > 0,
            previewRegion,
            {
              pins,
              pendingPin,
              selectionRect,
              hover,
              onRendered: acknowledgeRenderedFrame,
              onMouseMove: onPreviewMouseMove,
              onMouseDown: onPreviewMouseDown,
            },
            filling,
            agentBlocked,
            props.readOnly,
          )}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `bun test src/ui/workspace/ui/Workspace.test.tsx`
Expected: PASS — including the new case AND every pre-existing test in the file (in particular, the "Workspace read-only presentation" test at the top of the file has `activePageSlug: null` with no `pageDescriptors`, so it hits the earlier `!hasPages` branch — `EmptyState` — and is unaffected by this new branch, which sits after both the `hasPages` and `uiFrame` checks).

- [ ] **Step 5: Commit**

```bash
git add src/ui/workspace/ui/Workspace.tsx src/ui/workspace/ui/Workspace.test.tsx
git commit -m "feat(ui): name the disabled-preview state on a read-only Workspace"
```

---

### Task 5: Update `docs/architecture/flows/launch.md` for the fix

This change alters behavior the doc already describes in detail (per-project CLAUDE.md: "If a change alters behavior or structure covered by `docs/architecture/`, update the affected docs before finishing"). One paragraph currently documents the exact bug this plan fixes as if it were correct, permanent behavior; two source-anchor bullets describe `deriveScreen`/`intent.ts` without the new field. The two Mermaid diagrams in this file need NO changes — the main flowchart already models an interactive `trustq` decision with "prompt accepted"/"prompt declined" branches; this fix is what finally makes the code match that diagram instead of contradicting it.

**Files:**
- Modify: `docs/architecture/flows/launch.md` (three prose edits — no diagram changes)

**Interfaces:**
- Consumes: the finished behavior from Tasks 1-4 (do this task last).
- Produces: nothing — documentation only.

- [ ] **Step 1: Fix the paragraph that documents the bug as correct behavior**

Old:
```md
Trust is not a complication here: an existing project opened on the machine that created it
resolves `trusted` and goes straight to the Workspace; a moved or copied workspace resolves
`untrusted-read-only` and lands on the read-only screen — the correct destination, and still not
Home. Interaction with Gap C: once both land, Home is reached only from a genuinely fresh
directory or a startup open that failed (Gap D above, step 11 below) — an existing-but-empty
project is no longer a Home case at all — and its Enter is the only entry into the first turn.
```
New:
```md
Trust is not a complication for an already-trusted project: an existing project opened on the
machine that created it resolves `trusted` and goes straight to the Workspace. A moved, copied,
or otherwise never-before-trusted workspace resolves `untrusted-read-only` instead, and —
CORRECTED (trust-prompt-on-open fix, 2026-08-03; spec §3.1 required this from the start) — the
Workspace mounts the existing `TrustPrompt` popup for it before anything else renders, rather
than landing silently on the read-only screen the way it used to: `deriveScreen`
(`src/ui/mirror/model/screen.ts`) now checks a session-scoped `trustPromptDismissed` flag
(`UiLocalState.trustPromptDismissed`, `src/ui/app/model/deps.ts`) alongside `trust`, so an
`untrusted-read-only` resolution shows `"trust-prompt"` until the designer actually answers it,
and only THEN can it become `"read-only"`. Enter (`trust-accept`) grants trust and the Workspace
fills exactly as an already-trusted project would; `Esc` (`trust-decline`) sets the flag and
lands on `"read-only"` for the rest of this run, with the preview pane now naming that state
explicitly instead of hanging on the generic "preparing preview…" text. The decision is
session-scoped only — there is no in-app way to re-open the prompt or grant trust later in the
same run; relaunching termcraft is what re-resolves trust fresh and shows it again. Interaction
with Gap C: once both land, Home is reached only from a genuinely fresh directory or a startup
open that failed (Gap D above, step 11 below) — an existing-but-empty project is no longer a Home
case at all — and its Enter is the only entry into the first turn.
```

- [ ] **Step 2: Extend the `screen.ts` source anchor**

Old:
```md
- `src/ui/mirror/model/screen.ts` — `deriveScreen` (spec 2026-08-02): which screen the app root mounts — `enlarge` below the minimum frame; with no `projectId` yet, `workspace` when `startupOpenPending` is true and `openFailed` is false, else `home`; otherwise `trust-prompt`/`read-only`/`workspace` from `trust` (an approximation until the typed snapshot lands). `ScreenInput` gained the two fields that make this work: `startupOpenPending` — whether the composition root's own startup `project.open` (Gap D, `run-app.ts`) is still expected to land, known synchronously (seeded from `UiEnv.projectExists` before the UI even mounts) rather than waited for — and `openFailed` (`ProjectMirror.openFailure !== null`, set only by a genuine `kernel.project.blockOpen`). `deriveScreen` no longer waits for `finishOpen` to leave Home: an existing project mounts the Workspace on the very first frame, and the ready sequence (steps 2-4 above) fills it in — a re-render, not a remount, since this is the SAME `"workspace"` `ScreenKind` reached earlier, not a new one.
```
New:
```md
- `src/ui/mirror/model/screen.ts` — `deriveScreen` (spec 2026-08-02, extended by the trust-prompt-on-open fix, 2026-08-03): which screen the app root mounts — `enlarge` below the minimum frame; with no `projectId` yet, `workspace` when `startupOpenPending` is true and `openFailed` is false, else `home`; otherwise `workspace` when `trust === "trusted"`, `trust-prompt` when `trust === null` OR (`trust === "untrusted-read-only"` and the prompt has not yet been answered this session), and `read-only` once `trust === "untrusted-read-only"` and it has. `ScreenInput` gained three fields that make this work: `startupOpenPending` — whether the composition root's own startup `project.open` (Gap D, `run-app.ts`) is still expected to land, known synchronously (seeded from `UiEnv.projectExists` before the UI even mounts) rather than waited for — `openFailed` (`ProjectMirror.openFailure !== null`, set only by a genuine `kernel.project.blockOpen`) — and `trustPromptDismissed` (trust-prompt-on-open fix, 2026-08-03), read from `UiLocalState.trustPromptDismissed` (`src/ui/app/model/deps.ts`), a session-scoped flag the `trust-accept`/`trust-decline` intents set and nothing else ever clears — the only way to see the prompt again is relaunching termcraft, which rebuilds the flag `false` from scratch. Before this fix, an `untrusted-read-only` resolution mapped straight to `read-only` with no prompt ever shown, silently missing spec §3.1's "before anything renders" trust prompt for exactly the case it exists for — a project never before trusted on this machine+path. `deriveScreen` no longer waits for `finishOpen` to leave Home: an existing project mounts the Workspace on the very first frame, and the ready sequence (steps 2-4 above) fills it in — a re-render, not a remount, since this is the SAME `"workspace"` `ScreenKind` reached earlier, not a new one.
```

- [ ] **Step 3: Extend the `intent.ts` source anchor**

Old (the last sentence of that bullet):
```md
The composer's first send → `turn.start`; the trust prompt's accept/decline → `project.setTrust`.
```
New:
```md
The composer's first send → `turn.start`; the trust prompt's accept/decline → `project.setTrust`, and (trust-prompt-on-open fix, 2026-08-03) both arms also set `local.trustPromptDismissed` true, the session-scoped flag `deriveScreen` reads to stop re-showing the prompt for the rest of this run.
```

- [ ] **Step 4: Re-read the whole edited section for accuracy**

Read `docs/architecture/flows/launch.md` end to end once more and confirm every remaining sentence about trust (the walkthrough's step 3, the Kernel-level "one-shot open command cannot block on a round trip" claim) is still true after this plan — it is: the Kernel still resolves `project.open`/`project.setTrust` synchronously in one shot exactly as before; only the UI's screen derivation changed.

- [ ] **Step 5: Commit**

```bash
git add docs/architecture/flows/launch.md
git commit -m "docs(architecture): describe the trust-prompt-on-open fix in the launch flow"
```
