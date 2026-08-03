# Workspace-first launch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An existing project mounts the Workspace immediately instead of parking on Home for the whole ~30 s Kernel ready sequence, with the agent-health probe visible in the Workspace status bar while it runs.

**Architecture:** Three separable changes. (1) `deriveScreen` gains two inputs — a UI-local `startupOpenPending` flag seeded from `UiEnv.projectExists`, and `openFailed` from `ProjectMirror.openFailure` — and routes `projectId === null && startupOpenPending && !openFailed` to `"workspace"`. (2) The Workspace renders an *opening* variant when `mirror.project().projectId === null`: a design-authored preview line, an `opening project…` page slot, an `OPENING` mode chip, a live composer with a disabled `⏎ send` key. (3) The agent-health type/atom/action move out of `ui/home` into a new `ui/agent-health` module so the Workspace can read them without depending on Home, and the reading renders as the lowest-precedence badge in the Workspace `hint` slot. `runProjectReadySequence` is untouched: the shell appears instantly, then chat/tabs/preview all arrive together at `finishOpen`.

**Tech Stack:** TypeScript 7 (strict, `verbatimModuleSyntax`, `noUncheckedIndexedAccess`), Bun (runtime + `bun:test`), React 19 via `@opentui/react`, Reatom v1001 (`@reatom/core`, `@reatom/react`), `errore` for errors-as-values, `oxlint` + `oxfmt`.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-08-02-workspace-first-launch-design.md`. It is authoritative for scope; where it left a design gap, `design/30-workspace-first-launch.dc.html` now answers it.
- **The spec's "Design gaps" section is closed.** It listed four open questions and said they would go into a prompt under `design-prompts/`. That prompt was answered — §30 exists on `main` (commit `a448c10`) and settles all four: the preview region while opening, the status bar's `page` slot, whether the chat panel shows anything (it does not), and the badge's appearance and precedence including the preview-halt collision. Do not create `design-prompts/`, and do not re-open any of the four.
- **Design is the source of truth — never invent a colour, glyph, phrase or layout.** The screens for this change are `design/30-workspace-first-launch.dc.html` and these engine methods in `design/termcraft-engine.js`: `wsOpening` (`:229-248`), `agentBadge` (`:208-218`), `badgeStrip` (`:220-227`), `workspace`'s health branch (`:271`), `wsHostCrash`'s `agentDead` branch (`:1198-1240`). Read the method before writing the component that maps it.
- **Design identity strings are sample data, not layout** (standing user decision 2026-07-23, already cited throughout `src/ui`): the design writes `codex`, `gpt5.5`, `high`; the code sources every identity from real state (`AgentHealth.agent`, `mirror.agentIdentity()`) and never hardcodes a backend name.
- **Module shape (CLAUDE.md):** group by entity/feature. `ui/`, `model/` subfolders; `types.ts` and `index.ts` at the module root. A module with no logic may hold only `types.ts` + `index.ts`.
- **Imports:** cross-module imports use the tsconfig aliases (`ui/agent-health`, `ui/status-bar`, …), never a relative path that climbs out of the current module. `ui/agent-health` needs **no** new `paths` entry — the existing `ui/*` wildcard covers it, exactly as it covers `ui/home`.
- **errore:** errors are values. `instanceof Error` early returns on one line, no `try`/`catch` for control flow, always log an error that is not propagated.
- **Reatom v1001:** name every atom/computed/action; `wrap(...)` at async boundaries; `withAsync()` on async actions; read reactive inputs before the first `await`; `reatomComponent` reads atoms lazily.
- **This worktree has no `node_modules`.** Run `bun install` once before anything else.
- **Commands:** prefix every command with `rtk` (`rtk git …`, `rtk bun test …`). Tests: `rtk bun test <path>`. Type-check: `rtk bun x tsc --noEmit` (if that binary is absent, this repo's TypeScript 7 ships `tsgo` — use `rtk bun x tsgo --noEmit`). Lint: `rtk bun x oxlint`. Format: `rtk bun x oxfmt`.
- **Commit messages:** Conventional Commits, English, one commit per task.
- **Reatom audit:** run `/reatom-audit` after Task 2 and Task 3 (both touch atoms/actions) and before reporting the plan done.
- **Architecture docs:** Task 8 is not optional — `docs/architecture/` must not describe the routing this plan replaces.

## Documented divergences from the design

Record these as code comments where they occur (CLAUDE.md: "implement the closest faithful mapping and document the divergence in a code comment"). They are listed here so no task re-litigates them.

1. **`wsOpening`'s leading combo chip.** The design's opening bar starts with a ` codex · gpt5.5 · high ` chip. `StatusBar` has no combo segment at all — every workspace frame after §07 passes `combo:false`, and `buildLeftSegments` implements exactly that — and during an open `mirror.agentIdentity()` is still `null`, so there is no honest value to draw. The segment is dropped; every other segment of the opening bar is implemented verbatim. (Task 5.)
2. **Animated spinner in the badge.** `StatusBarHintBadge` is plain text and cannot host a component, so the `⠹` in `⠹ checking …` is static. `Home.tsx:56` already documents this exact inherited limitation for the same glyph. (Task 6.)
3. **The dead-agent F6 detail line beyond `blocked/login`.** §30's collision frame draws one reading — `blocked` + `login` — and gives F6 the literal second line `codex is not signed in — nothing runs until it is`. That sentence does not generalise to `blocked/latched` or `missing`. For those two the F6 detail keeps its ordinary design wording, and the *added* red line under the tee rule — which composes generically from the badge phrase the design itself authored — carries the correction. (Task 7.)
4. **Flexbox centring.** `OpeningState` centres with flexbox where the engine uses `ctr` + absolute cell coordinates — the same note `EmptyState.tsx` already carries.

## File structure

**New**

| File | Responsibility |
| --- | --- |
| `src/ui/agent-health/types.ts` | The `AgentHealth` union — the agent CLI's five health outcomes. No logic. |
| `src/ui/agent-health/index.ts` | The module's public surface. |
| `src/ui/preview/ui/OpeningState.tsx` | The preview-region placeholder while the project opens (`wsOpening`'s two centred lines). |
| `src/ui/workspace/model/health-badge.ts` | `AgentHealth` → the Workspace status-bar badge, and → the halted-preview panel's dead-agent notice. Pure functions. |
| `src/ui/workspace/model/health-badge.test.ts` | Its tests. |

**Modified (by responsibility, not by task)**

| File | Change |
| --- | --- |
| `src/ui/home/types.ts` / `index.ts` | `HomeAgentHealth` and `HomeHealthOutcome` leave; `homeSubmitAllowed`, `HomeAgentSelection`, `HomeCombo`, `HomeProps` stay and retype. |
| `src/ui/mirror/model/screen.ts` | `ScreenInput` gains two fields; `deriveScreen` gains one branch; `createScreenAtom` gains one reader. |
| `src/ui/app/model/deps.ts` | `local.agentHealth`, `refreshAgentHealth`, `local.startupOpenPending`, `abandonStartupOpen`, screen wiring. |
| `src/ui/app/model/root.tsx` | Hoisted `createUiDeps`; `UiRootHandle.abandonStartupOpen`. |
| `src/ui/app/ui/App.tsx` | Renamed health read. |
| `src/ui/app/model/keymap.ts` / `intent.ts` | Renamed health type/action; one rewritten comment. |
| `src/ui/workspace/types.ts` | `WorkspaceLocalState` gains `agentHealth`. |
| `src/ui/workspace/ui/Workspace.tsx` | The opening branch (preview / page slot / mode chip / composer / key row) and the fifth `hint` tier. |
| `src/ui/preview/ui/HostCrashPanel.tsx` | The dead-agent F6 detail and the added red line. |
| `src/ui/preview/index.ts` | Exports `OpeningState`. |
| `src/entrypoint/model/agent-health.ts` | Retyped; `homeHealthFromAgentInfo` renamed. |
| `src/entrypoint/model/run-app.ts` | `launch.existing` predicate; `abandonStartupOpen` on both failure branches. |
| `docs/architecture/flows/launch.md`, `modules.md`, `code-structure.md` | Task 8. |

---

### Task 1: Extract `ui/agent-health` and rename the health names

The Workspace is about to read the health atom. Today the type is `HomeAgentHealth`, the atom is `local.homeHealth` and the action is `refreshHomeHealth`, all owned by `ui/home` — so `ui/workspace` would depend on `ui/home` and all three names would be false. This task is a pure move + rename with no behaviour change; the type-checker is the test.

**Files:**
- Create: `src/ui/agent-health/types.ts`, `src/ui/agent-health/index.ts`
- Modify: `src/ui/home/types.ts`, `src/ui/home/index.ts`, `src/ui/home/ui/Home.tsx`, `src/ui/home/ui/HomeHealthPanel.tsx`, `src/ui/app/model/deps.ts`, `src/ui/app/model/root.tsx`, `src/ui/app/ui/App.tsx`, `src/ui/app/model/keymap.ts`, `src/ui/app/model/intent.ts`, `src/entrypoint/model/agent-health.ts`, `src/entrypoint/model/run-app.ts`
- Test: `src/ui/home/ui/Home.test.tsx`, `src/ui/app/model/deps.test.ts`, `src/ui/app/model/keymap.test.ts`, `src/ui/app/model/intent.test.ts`, `src/ui/app/ui/App.test.tsx`, `src/entrypoint/model/agent-health.test.ts`, `src/entrypoint/model/run-app.test.ts`, `src/entrypoint/model/smoke.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  - `type AgentHealth` exported from `ui/agent-health` — the same five-member union `HomeAgentHealth` was.
  - `UiLocalState.agentHealth: Atom<AgentHealth>` (was `homeHealth`).
  - `UiDeps.refreshAgentHealth: () => Promise<void>` (was `refreshHomeHealth`).
  - `KeyContext.agentHealth: AgentHealth` (was `homeHealth`).
  - `UiRootOptions.agentHealthProbe?: () => Promise<AgentHealth>` — name unchanged, type renamed.
  - `agentHealthFromAgentInfo(info: AgentInfo): AgentHealth` in `entrypoint/model/agent-health.ts` (was `homeHealthFromAgentInfo`).
  - `homeSubmitAllowed(health: AgentHealth): boolean` — still exported from `ui/home`, unmoved.

- [ ] **Step 1: Install dependencies and record a green baseline**

This worktree has no `node_modules`.

```bash
rtk bun install
rtk bun test src/ui src/entrypoint
```

Expected: the suite passes. Record the pass/fail counts — Tasks 1–8 must never reduce them.

- [ ] **Step 2: Create `src/ui/agent-health/types.ts`**

The union and its doc comment move verbatim from `src/ui/home/types.ts:14-52`, with two edits: the opening sentence says *agent* rather than *Home*, and a paragraph records the second consumer.

```ts
/**
 * `ui/agent-health` — the agent CLI's health reading, and nothing else. Extracted from `ui/home`
 * (2026-08-02, workspace-first launch) once the Workspace status bar became its second consumer:
 * leaving the type, the atom and the action named after Home would have made `ui/workspace`
 * depend on `ui/home` and made all three names false. The module holds no logic, so it is
 * `types.ts` + `index.ts` with no subfolders (CLAUDE.md permits both files at a module root).
 *
 * Home's own submit policy (`homeSubmitAllowed`) deliberately did NOT move: the Workspace
 * composer is not gated on health (a dead CLI does not disable ⏎ there), so that function is
 * Home's rule, not this module's.
 */

/**
 * The five agent-health outcomes (finding §2.7). They divide by WHETHER SUBMIT IS REFUSED, not by
 * presence — which is why the old `present: boolean` could not express them: `checking` and
 * `blocked` both refuse while being nothing alike on screen, and `advisory` allows while being
 * visually closer to `blocked` than to `ready`.
 *
 * - `checking` — the probe is in flight. Home refuses submit. Design `home('checking')`
 *   (`termcraft-engine.js:139-161`): the `⏎ create` hint drops to faint, a `· ⠹ checking {agent} —
 *   up to 20s` note sits beside it, and the status bar carries `⠹ checking {agent} — ⏎ disabled`
 *   with the `⏎` hint key in the `dis` state. In the WORKSPACE it renders as an ordinary badge
 *   (`agentBadge('checking')`, `termcraft-engine.js:212-218`) and gates nothing.
 * - `ready` — a real, passing probe. Submit allowed. No badge on either screen.
 * - `advisory` — the probe finished without proving the agent healthy (an unconfirmed exit, a
 *   degraded sandbox, or a TIMEOUT). Submit ALLOWED: a timeout proves nothing — it does not prove
 *   the user is signed out — and the design's own `⏎ works — the first turn may still fail` panel
 *   is the honest bucket for "unproven". Design `homeHealth('shutdown'|'sandbox')`.
 * - `blocked` — the CLI is there and something positively established it cannot run right now.
 *   Home refuses submit, but the screen is NOT seized: a panel below a still-rendered (but
 *   disabled) prompt. TWO distinct reasons share this kind, told apart by `panel`: `"login"` is
 *   design's own `homeHealth('login')` (not signed in — probing again might change the answer);
 *   `"latched"` is the backend's own confirmed unconfirmed-exit lockout
 *   (`agent/claude/backend/model/backend.ts`). Design DOES mock this exact wording —
 *   `homeHealth('shutdown')` — but classifies it advisory (`design/termcraft-engine.js:165-166`'s
 *   own comment, predating the backend's latch); this union departs from that classification on
 *   purpose (`entrypoint/model/agent-health.ts`'s switch has the full argument), so `latched`'s
 *   PANEL CONTENT is still a documented divergence (`HomeHealthPanel.tsx`'s own `panelSpec`) even
 *   though its wording is design-adjacent. Collapsing `"latched"` into `advisory` (as this union
 *   briefly did) would tell the user Enter works when a real turn would be rejected.
 * - `missing` — no CLI at all. On Home it keeps the full-screen takeover (`homeErr()`). In the
 *   Workspace there is no takeover: a project is open and five of its six capabilities work
 *   without an agent, so it is a badge like the rest (`agentBadge('missing')`).
 */
export type AgentHealth =
  | Readonly<{ kind: "checking"; agent: string }>
  | Readonly<{ kind: "ready"; agent: string }>
  | Readonly<{ kind: "advisory"; agent: string; panel: "shutdown" | "sandbox"; detail: string }>
  | Readonly<{ kind: "blocked"; agent: string; panel: "login" | "latched"; detail: string }>
  | Readonly<{ kind: "missing"; agent: string; detail: string }>;
```

- [ ] **Step 3: Create `src/ui/agent-health/index.ts`**

```ts
/**
 * `ui/agent-health` — the agent CLI's health reading. Consumed by `ui/home` (its panels and its
 * submit policy), by `ui/workspace` (the status-bar badge), by `ui/app` (the atom, the probe
 * injection point and the key context) and by `entrypoint` (the real probe that produces it).
 */
export type { AgentHealth } from "./types";
```

- [ ] **Step 4: Strip the moved names out of `src/ui/home/types.ts`**

Delete the whole `HomeAgentHealth` union (lines 14-52) and the `HomeHealthOutcome` alias (lines 59-63 — an unused alias, dropped rather than carried along). Add the import and retype the two remaining references:

```ts
import type { ScoredSlashRow } from "ui/actions";
import type { AgentHealth } from "ui/agent-health";
import type { ProjectOpenFailure } from "ui/mirror";
```

```ts
/** Submit is refused exactly while the agent is unproven-and-unusable — see {@link AgentHealth}.
 *  Stays in `ui/home` on purpose: this is HOME's submit policy. The Workspace composer is
 *  deliberately not gated on health — a dead CLI does not disable ⏎ there. */
export function homeSubmitAllowed(health: AgentHealth): boolean {
  return health.kind === "ready" || health.kind === "advisory";
}
```

and in `HomeProps`:

```ts
  readonly health: AgentHealth;
```

Also update the module's own header comment (lines 4-12): Home is no longer reached merely when `.termcraft/` is absent — see Task 3, which rewrites that comment as part of the routing change. Leave it alone here.

- [ ] **Step 5: Update `src/ui/home/index.ts`**

```ts
export type { HomeAgentSelection, HomeCombo, HomeProps } from "./types";
export { homeSubmitAllowed } from "./types";
export { Home } from "./ui/Home";
```

- [ ] **Step 6: Type-check to see the failure surface**

```bash
rtk bun x tsc --noEmit
```

Expected: FAIL, with `Cannot find name 'HomeAgentHealth'` / `has no exported member 'HomeAgentHealth'` in every file listed under **Files** above. That list is the work for Step 7.

- [ ] **Step 7: Update every consumer**

Purely mechanical. In each file: change the import to `import type { AgentHealth } from "ui/agent-health";` and the type reference to `AgentHealth`.

**Do NOT rename design citations.** `homeHealth('login')`, `homeHealth('shutdown')`, `homeHealth('sandbox')` in comments name the *design engine's* function and must stay exactly as written. Only these TypeScript identifiers change:

| Old | New | Where |
| --- | --- | --- |
| `HomeAgentHealth` | `AgentHealth` | every file below |
| `HomeHealthOutcome` | *(deleted)* | `ui/home/types.ts`, `ui/home/index.ts` |
| `local.homeHealth` | `local.agentHealth` | `deps.ts`, `App.tsx`, `intent.ts`, `deps.test.ts`, `App.test.tsx` |
| `UiLocalState.homeHealth` | `UiLocalState.agentHealth` | `deps.ts` |
| `refreshHomeHealth` | `refreshAgentHealth` | `deps.ts`, `intent.ts`, `run-app.ts` comment, tests |
| `UiDeps.refreshHomeHealth` | `UiDeps.refreshAgentHealth` | `deps.ts` |
| `KeyContext.homeHealth` | `KeyContext.agentHealth` | `keymap.ts`, `App.tsx`, `keymap.test.ts` |
| `homeHealthFromAgentInfo` | `agentHealthFromAgentInfo` | `entrypoint/model/agent-health.ts` + its test |
| `DEFAULT_HOME_HEALTH` | `DEFAULT_AGENT_HEALTH` | `deps.ts` |

`UiRootOptions.agentHealthProbe` and `createAgentHealthProbe` keep their names — they were already correct.

Two doc comments need a sentence added rather than a rename, because their reasoning changes:

`deps.ts`, `UiLocalState.agentHealth`'s doc comment — replace the first sentence:

```ts
  /**
   * The agent-health reading (M15). Home's `health` prop and the Workspace status bar's badge
   * both read this — one probe, two surfaces (2026-08-02). There is no Kernel command that
   * reports agent health (Home is shown *before* any project opens, so there is no
   * `kernel.snapshot` to read either), so this atom's lifecycle is: seeded with
   * {@link DEFAULT_AGENT_HEALTH} as a synchronous pre-probe placeholder (the first paint cannot
   * await a Promise), then `createUiDeps` fires {@link UiDeps.refreshAgentHealth} once at startup
   * to replace it with the injected probe's real reading, and again on every `home-recheck` — the
   * SAME probe path, not a duplicated one. There is deliberately NO Workspace re-check: the badge
   * is the reading taken at startup and it is never refreshed for the life of the process.
   */
  readonly agentHealth: Atom<AgentHealth>;
```

`entrypoint/model/agent-health.ts:1-16` — its header explains why `entrypoint` imports a `ui` presentation type. Update the module it names:

```ts
 * and `ui/agent-health` (the presentation type — `AgentHealth`) directly, which is normally
 * forbidden…
```

and its import:

```ts
import type { AgentHealth } from "ui/agent-health";
```

`run-app.ts` line 6 likewise becomes `import type { AgentHealth } from "ui/agent-health";`, and `resolveAgentHealthProbe`'s return type becomes `(() => Promise<AgentHealth>) | undefined`. Its doc comment's first line ("Builds Home's real health probe…") becomes "Builds the real agent-health probe…".

- [ ] **Step 8: Type-check and run the suite**

```bash
rtk bun x tsc --noEmit
rtk bun test src/ui src/entrypoint
```

Expected: type-check clean; the suite matches Step 1's baseline exactly (same tests, same count, all passing). A behaviour change here is a bug — this task renames only.

- [ ] **Step 9: Lint and format**

```bash
rtk bun x oxlint
rtk bun x oxfmt
```

- [ ] **Step 10: Commit**

```bash
rtk git add src/ui/agent-health src/ui/home src/ui/app src/ui/workspace src/entrypoint
rtk git commit -F <message-file>
```

Message (write it to a scratchpad file and pass `-F` — `rtk git commit` swallows heredoc stdin):

```
refactor(ui): extract ui/agent-health from ui/home

The Workspace status bar is about to read the agent-health reading, which
would have made ui/workspace depend on ui/home and left the type, the atom
and the action all named after a screen that is no longer their only
consumer. HomeAgentHealth moves verbatim to ui/agent-health as AgentHealth;
local.homeHealth becomes local.agentHealth and refreshHomeHealth becomes
refreshAgentHealth. homeSubmitAllowed stays in ui/home: it is Home's own
submit policy, and the Workspace composer is deliberately not gated on
health. The unused HomeHealthOutcome alias is dropped.
```

---

### Task 2: `startupOpenPending` and `abandonStartupOpen`

The routing predicate the next task needs. `mirror.project().opening` cannot serve: it only turns true once the Kernel admits the command, so between UI mount and admission `projectId` is null and `opening` is false — Home would flash for a frame. The composition root knows synchronously, before the UI mounts, that it is going to open a project; `UiEnv.projectExists` is that fact, already threaded in.

`abandonStartupOpen` closes a hole `run-app.ts:132-144` already documents: the startup `project.open` dispatch can fail or be rejected, and today that is only logged — neither `finishOpen` nor `blockOpen` ever arrives, so `projectId` and `openFailure` both stay null forever. Before this change that stranded the user on Home; after Task 3, on an empty Workspace shell, which reads worse.

**Files:**
- Modify: `src/ui/app/model/deps.ts`
- Test: `src/ui/app/model/deps.test.ts`

**Interfaces:**
- Consumes: `AgentHealth` naming from Task 1 (this task touches the same file).
- Produces:
  - `UiLocalState.startupOpenPending: Atom<boolean>` — seeded `env.projectExists`.
  - `UiDeps.abandonStartupOpen: () => void` — a named Reatom action that sets it false.

- [ ] **Step 1: Write the failing tests**

Append to `src/ui/app/model/deps.test.ts`:

```ts
describe("createUiDeps startup-open tracking (workspace-first launch)", () => {
  test("seeds startupOpenPending from env.projectExists", () => {
    const existing = createUiDeps(createFakeKernel(), { w: 120, h: 36 }, {
      root: "/tmp/project",
      workspaceIdentity: "local",
      projectExists: true,
    });
    expect(existing.local.startupOpenPending()).toBe(true);
  });

  test("defaults to false for a fresh directory (and for every test/demo construction)", () => {
    const fresh = createUiDeps(createFakeKernel(), { w: 120, h: 36 });
    expect(fresh.local.startupOpenPending()).toBe(false);
  });

  test("abandonStartupOpen clears it — the startup open will never arrive", () => {
    const deps = createUiDeps(createFakeKernel(), { w: 120, h: 36 }, {
      root: "/tmp/project",
      workspaceIdentity: "local",
      projectExists: true,
    });
    deps.abandonStartupOpen();
    expect(deps.local.startupOpenPending()).toBe(false);
  });

  test("abandonStartupOpen is idempotent — both run-app failure branches may fire", () => {
    const deps = createUiDeps(createFakeKernel(), { w: 120, h: 36 }, {
      root: "/tmp/project",
      workspaceIdentity: "local",
      projectExists: true,
    });
    deps.abandonStartupOpen();
    deps.abandonStartupOpen();
    expect(deps.local.startupOpenPending()).toBe(false);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

```bash
rtk bun test src/ui/app/model/deps.test.ts
```

Expected: FAIL — `local.startupOpenPending is not a function` / `deps.abandonStartupOpen is not a function`.

- [ ] **Step 3: Declare the atom in `UiLocalState`**

In `src/ui/app/model/deps.ts`, add to the `UiLocalState` interface (after `agentSelection`):

```ts
  /**
   * Whether the composition root is going to dispatch a startup `project.open` for this run
   * (workspace-first launch, 2026-08-02) — seeded synchronously from {@link UiEnv.projectExists},
   * which `create-shell.ts` sets from `ShellLaunchV1.existing`.
   *
   * NOT `mirror.project().opening`: that only turns true once the Kernel ADMITS the command, so
   * between UI mount and admission `projectId` is null and `opening` is false — `deriveScreen`
   * would show Home for a frame. The composition root knows this fact synchronously, before the
   * UI mounts, which is why it is an injected environment fact rather than a mirror read.
   *
   * Exactly one transition: {@link UiDeps.abandonStartupOpen} sets it false when the startup
   * dispatch fails or is rejected, because in that case neither `finishOpen` nor `blockOpen` will
   * ever arrive and `projectId`/`openFailure` would both stay null forever.
   */
  readonly startupOpenPending: Atom<boolean>;
```

- [ ] **Step 4: Declare the action on `UiDeps`**

Add to the `UiDeps` interface (after `refreshAgentHealth`):

```ts
  /**
   * Records that the startup `project.open` will never arrive (workspace-first launch) — clears
   * {@link UiLocalState.startupOpenPending}, which drops the derived screen back to Home.
   *
   * A named Reatom ACTION rather than a bare `.set` because `runApp` calls it from a promise
   * continuation, outside any Reatom frame (RTM-A04). It is not an identity setter (RTM-S01): it
   * names a real transition — "the startup open will never arrive" — that exactly one caller
   * makes, on exactly two branches.
   */
  readonly abandonStartupOpen: () => void;
```

- [ ] **Step 5: Create the atom and the action**

In `createUiDeps`, immediately after `const terminal = atom(initialSize, "ui.app.terminal");` (so it is declared before `createScreenAtom` reads it in Task 3):

```ts
  // See `UiLocalState.startupOpenPending` for why this is an injected env fact and not a mirror
  // read. Declared here, above `screen`, because `createScreenAtom` below routes on it.
  const startupOpenPending = atom(env.projectExists, "ui.local.startupOpenPending");
  const abandonStartupOpen = action(() => {
    startupOpenPending.set(false);
  }, "ui.app.abandonStartupOpen");
```

Add `startupOpenPending` to the `local` object literal, and `abandonStartupOpen` to the returned `deps` object.

- [ ] **Step 6: Run the tests to verify they pass**

```bash
rtk bun test src/ui/app/model/deps.test.ts
rtk bun x tsc --noEmit
```

Expected: PASS, type-check clean.

- [ ] **Step 7: Audit, lint, format, commit**

```bash
rtk bun x oxlint
rtk bun x oxfmt
rtk git add src/ui/app/model/deps.ts src/ui/app/model/deps.test.ts
rtk git commit -F <message-file>
```

Run `/reatom-audit` over the changed file before committing.

```
feat(ui): track whether a startup project.open is still pending

deriveScreen is about to route an existing project to the Workspace before
the Kernel has published anything, and mirror.project().opening cannot be
the signal: it only turns true once the command is admitted, so Home would
flash for a frame between mount and admission. startupOpenPending is that
fact, seeded synchronously from UiEnv.projectExists. abandonStartupOpen is
its one transition, for the case run-app.ts already documents but never
handled: a startup dispatch that fails or is rejected, after which neither
finishOpen nor blockOpen ever arrives.
```

---

### Task 3: Route an existing project to the Workspace

**Files:**
- Modify: `src/ui/mirror/model/screen.ts`, `src/ui/app/model/deps.ts`, `src/ui/app/model/intent.ts`, `src/ui/home/types.ts`
- Test: `src/ui/mirror/model/screen.test.ts`, `src/ui/app/ui/App.test.tsx`

**Interfaces:**
- Consumes: `UiLocalState.startupOpenPending` (Task 2).
- Produces:
  - `ScreenInput` gains `readonly startupOpenPending: boolean` and `readonly openFailed: boolean`.
  - `createScreenAtom`'s deps object gains `readonly startupOpenPending: () => boolean`.

- [ ] **Step 1: Write the failing derivation tests**

Replace the `no project -> home` test in `src/ui/mirror/model/screen.test.ts` and extend the file. Every existing `deriveScreen({...})` call in this file must also gain `startupOpenPending: false, openFailed: false` — the two new fields are required, not optional, so a call site cannot silently fall into the old behaviour.

```ts
const IDLE = { startupOpenPending: false, openFailed: false } as const;

describe("deriveScreen (phase-7 plan D6)", () => {
  test("below the minimum frame on either axis -> enlarge, over everything else", () => {
    expect(
      deriveScreen({ ...IDLE, projectId, trust: "trusted", terminal: { w: 79, h: 40 } }),
    ).toBe("enlarge");
    expect(
      deriveScreen({ ...IDLE, projectId, trust: "trusted", terminal: { w: 120, h: 23 } }),
    ).toBe("enlarge");
    expect(
      deriveScreen({ ...IDLE, projectId: null, trust: null, terminal: { w: 10, h: 10 } }),
    ).toBe("enlarge");
  });

  test("a startup open that is still pending mounts the Workspace, not Home", () => {
    expect(
      deriveScreen({
        projectId: null,
        trust: null,
        terminal: OK,
        startupOpenPending: true,
        openFailed: false,
      }),
    ).toBe("workspace");
  });

  test("enlarge still outranks the opening Workspace", () => {
    expect(
      deriveScreen({
        projectId: null,
        trust: null,
        terminal: { w: 79, h: 40 },
        startupOpenPending: true,
        openFailed: false,
      }),
    ).toBe("enlarge");
  });

  test("a blocked open falls back to Home — Home owns the failure panel and the retry", () => {
    expect(
      deriveScreen({
        projectId: null,
        trust: null,
        terminal: OK,
        startupOpenPending: true,
        openFailed: true,
      }),
    ).toBe("home");
  });

  test("a startup dispatch that never reached the Kernel falls back to Home", () => {
    expect(
      deriveScreen({
        projectId: null,
        trust: null,
        terminal: OK,
        startupOpenPending: false,
        openFailed: false,
      }),
    ).toBe("home");
  });

  test("no project and no startup open -> home", () => {
    expect(deriveScreen({ ...IDLE, projectId: null, trust: null, terminal: OK })).toBe("home");
  });

  test("finishOpen turns the opening Workspace into a filled one", () => {
    expect(
      deriveScreen({
        projectId,
        trust: "trusted",
        terminal: OK,
        startupOpenPending: true,
        openFailed: false,
      }),
    ).toBe("workspace");
  });

  test("finishOpen with an untrusted grant lands on read-only, not the Workspace", () => {
    expect(
      deriveScreen({
        projectId,
        trust: "untrusted-read-only",
        terminal: OK,
        startupOpenPending: true,
        openFailed: false,
      }),
    ).toBe("read-only");
  });

  test("untrusted-read-only project -> read-only", () => {
    expect(
      deriveScreen({ ...IDLE, projectId, trust: "untrusted-read-only", terminal: OK }),
    ).toBe("read-only");
  });

  test("project open but trust undecided -> trust-prompt", () => {
    expect(deriveScreen({ ...IDLE, projectId, trust: null, terminal: OK })).toBe("trust-prompt");
  });

  test("trusted project at a big-enough terminal -> workspace", () => {
    expect(deriveScreen({ ...IDLE, projectId, trust: "trusted", terminal: OK })).toBe("workspace");
  });

  test("MIN_FRAME is 80x24", () => {
    expect(MIN_FRAME).toEqual({ w: 80, h: 24 });
  });
});
```

Extend the `createScreenAtom` describe block so the atom's own wiring is covered:

```ts
describe("createScreenAtom", () => {
  const EMPTY_PROJECT: ProjectMirror = {
    projectId: null,
    activePageSlug: null,
    activeChatId: null,
    trust: null,
    openFailure: null,
    opening: false,
  };

  test("recomputes as the project slice and terminal size change", () => {
    const project = atom<ProjectMirror>(EMPTY_PROJECT, "test.project");
    const terminal = atom(OK, "test.terminal");
    const startupOpenPending = atom(false, "test.startupOpenPending");
    const screen = createScreenAtom({
      project: () => project(),
      terminal: () => terminal(),
      startupOpenPending: () => startupOpenPending(),
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

  test("a pending startup open mounts the Workspace, and a blockOpen drops it back to Home", () => {
    const project = atom<ProjectMirror>(EMPTY_PROJECT, "test.project");
    const terminal = atom(OK, "test.terminal");
    const startupOpenPending = atom(true, "test.startupOpenPending");
    const screen = createScreenAtom({
      project: () => project(),
      terminal: () => terminal(),
      startupOpenPending: () => startupOpenPending(),
    });

    expect(screen()).toBe("workspace");
    project.set({
      ...EMPTY_PROJECT,
      openFailure: { reason: "manifest-read-failed", safeMessage: "project.toml unreadable" },
    });
    expect(screen()).toBe("home");
  });

  test("abandoning the startup open drops the empty Workspace back to Home", () => {
    const project = atom<ProjectMirror>(EMPTY_PROJECT, "test.project");
    const terminal = atom(OK, "test.terminal");
    const startupOpenPending = atom(true, "test.startupOpenPending");
    const screen = createScreenAtom({
      project: () => project(),
      terminal: () => terminal(),
      startupOpenPending: () => startupOpenPending(),
    });

    expect(screen()).toBe("workspace");
    startupOpenPending.set(false);
    expect(screen()).toBe("home");
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

```bash
rtk bun test src/ui/mirror/model/screen.test.ts
```

Expected: FAIL — the pending-open case returns `"home"`, and TypeScript rejects the extra `startupOpenPending` reader on `createScreenAtom`.

- [ ] **Step 3: Rewrite `deriveScreen`**

`src/ui/mirror/model/screen.ts`:

```ts
export interface ScreenInput {
  readonly projectId: UUIDv7 | null;
  readonly trust: "trusted" | "untrusted-read-only" | null;
  readonly terminal: Readonly<{ w: number; h: number }>;
  /**
   * Whether the composition root is going to open a project for this run and has not yet been
   * told otherwise (`UiLocalState.startupOpenPending`). Its DESTINATION is the Workspace, so the
   * Workspace mounts now and fills when `finishOpen` lands, instead of parking on Home for the
   * whole ready sequence.
   */
  readonly startupOpenPending: boolean;
  /** `mirror.project().openFailure !== null` — a blocked open falls back to Home, which owns the
   *  failure panel and the ⏎ retry. */
  readonly openFailed: boolean;
}

/**
 * Derives which screen the app root mounts (phase-7 plan D6, revised 2026-08-02 by the
 * workspace-first launch spec).
 *
 * APPROXIMATION (documented): `trust === null` with a project open maps to `trust-prompt`,
 * conflating the true needs-trust state with the brief pre-`ready` opening/recovering window
 * (snapshot `trust` is null throughout both). It stays exactly as unreachable as it was:
 * `kernel.project.finishOpen` folds `projectId` and `trust` in one `project.set`
 * (`ui/mirror/model/mirror.ts:400`), so there is no intermediate state where one is known and
 * the other is not.
 *
 * THE "OPENING" STATE IS NOT A NEW `ScreenKind`. It is `"workspace"` with `projectId === null`,
 * which is why the transition to a filled Workspace is a re-render rather than a remount, and why
 * only `ui/workspace` needs to know the difference.
 */
export function deriveScreen(input: ScreenInput): ScreenKind {
  // Below the minimum frame the enlarge placeholder replaces everything (design §9).
  if (input.terminal.w < MIN_FRAME.w || input.terminal.h < MIN_FRAME.h) return "enlarge";
  if (input.projectId === null) {
    // An existing project's destination IS the Workspace — mount it now and let it fill,
    // rather than parking on Home for the whole ready sequence. A blocked open drops back
    // to Home, which owns the failure panel and the ⏎ retry.
    if (input.startupOpenPending && !input.openFailed) return "workspace";
    return "home";
  }
  if (input.trust === "untrusted-read-only") return "read-only";
  if (input.trust === null) return "trust-prompt";
  return "workspace";
}
```

`createScreenAtom`:

```ts
/**
 * A reactive `ScreenKind` computed over the project slice, the UI-local terminal size, and the
 * UI-local startup-open flag. Neither the terminal size nor the flag is a mirror atom — one is a
 * render-time value and the other is an environment fact the composition root knows before the
 * Kernel exists — so the App injects both readers here.
 */
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
      // `createScreenAtom` already holds `() => mirror.project()`, so this needs no new wiring.
      openFailed: project.openFailure !== null,
    });
  }, "ui.mirror.screen");
}
```

- [ ] **Step 4: Wire it in `deps.ts`, and cover the wiring end-to-end**

```ts
  const screen = createScreenAtom({
    project: () => mirror.project(),
    terminal: () => terminal(),
    startupOpenPending: () => startupOpenPending(),
  });
```

Extend Task 2's describe block in `src/ui/app/model/deps.test.ts` — this is the spec's own "`abandonStartupOpen` flips the atom **and the derived screen**", which only becomes assertable now:

```ts
  test("the derived screen follows the flag: workspace while pending, home once abandoned", () => {
    const deps = createUiDeps(createFakeKernel(), { w: 120, h: 36 }, {
      root: "/tmp/project",
      workspaceIdentity: "local",
      projectExists: true,
    });
    expect(deps.screen()).toBe("workspace");
    deps.abandonStartupOpen();
    expect(deps.screen()).toBe("home");
  });

  test("a fresh directory derives home from the start", () => {
    expect(createUiDeps(createFakeKernel(), { w: 120, h: 36 }).screen()).toBe("home");
  });
```

- [ ] **Step 5: Run the derivation tests to verify they pass**

```bash
rtk bun test src/ui/mirror/model/screen.test.ts src/ui/app/model/deps.test.ts
rtk bun x tsc --noEmit
```

Expected: PASS, type-check clean.

- [ ] **Step 6: Write the failing App-level tests**

Append to `src/ui/app/ui/App.test.tsx`. These are the end-to-end statements of the routing change: the screen the user actually sees.

```ts
describe("workspace-first launch (2026-08-02)", () => {
  const existingEnv = {
    root: "/tmp/existing",
    workspaceIdentity: "local",
    projectExists: true,
  } as const;

  test("an existing project mounts the Workspace shell, not Home, before anything opens", async () => {
    const deps = createUiDeps(createFakeKernel(), { w: 120, h: 36 }, existingEnv);
    const renderer = await createReactTestRenderer({ w: 120, h: 36 });
    open = renderer;
    renderer.render(<App deps={deps} clock={() => 0} />);
    await renderer.settle();

    const text = renderer.text();
    expect(text).toContain("opening project…");
    expect(text).toContain("OPENING");
    expect(text).not.toContain("Describe the TUI you want to design…");
  });

  test("a fresh directory still lands on Home", async () => {
    const deps = createUiDeps(createFakeKernel(), { w: 120, h: 36 });
    const renderer = await createReactTestRenderer({ w: 120, h: 36 });
    open = renderer;
    renderer.render(<App deps={deps} clock={() => 0} />);
    await renderer.settle();

    expect(renderer.text()).toContain("Describe the TUI you want to design…");
  });

  test("a blockOpen drops the opening Workspace back to Home with its failure panel", async () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 }, existingEnv);
    const renderer = await createReactTestRenderer({ w: 120, h: 36 });
    open = renderer;
    renderer.render(<App deps={deps} clock={() => 0} />);
    await renderer.settle();
    expect(renderer.text()).toContain("OPENING");

    kernel.emit(
      event("kernel.stateChanged", {
        modelId: "kernel.project.state",
        action: "kernel.project.blockOpen",
        previousTag: "opening",
        nextTag: "blocked",
        metadata: {
          reason: "manifest-read-failed",
          failure: {
            code: "PERSISTENCE_FAILED",
            retryable: true,
            safeMessage: "project.toml could not be read",
            details: {},
          },
        },
      }),
    );
    await renderer.settle();

    const text = renderer.text();
    expect(text).toContain("Describe the TUI you want to design…");
    expect(text).toContain("project.toml could not be read");
    expect(text).not.toContain("OPENING");
  });

  test("finishOpen turns the opening Workspace into a filled one", async () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 }, existingEnv);
    const renderer = await createReactTestRenderer({ w: 120, h: 36 });
    open = renderer;
    renderer.render(<App deps={deps} clock={() => 0} />);
    await renderer.settle();
    expect(renderer.text()).toContain("opening project…");

    kernel.emit(workspaceSnapshot());
    await renderer.settle();

    const text = renderer.text();
    expect(text).not.toContain("opening project…");
    expect(text).toContain("Main");
  });
});
```

> **Adapt to the local harness before running.** `createReactTestRenderer`'s exact API (`render`/`settle`/`text`) is not the same in every file — read the existing tests at the top of `App.test.tsx` and use whatever they use to mount, flush and read the frame. The assertions above are the contract; the harness calls around them are not.

- [ ] **Step 7: Run them**

```bash
rtk bun test src/ui/app/ui/App.test.tsx
```

Expected: the "mounts the Workspace shell" and "finishOpen" tests FAIL against `OPENING`/`opening project…`, which Task 5 renders. The Home tests should already pass. **Leave the two failing tests in place and finish this task** — they are Task 5's red. Note them in the commit so nobody mistakes them for a regression.

If you prefer a strictly green tree per commit, mark the two Workspace-text assertions `test.todo` here and un-todo them in Task 5. Do not weaken them.

- [ ] **Step 8: Rewrite the two comments the routing change makes false**

`src/ui/app/model/intent.ts`, the `home-submit` case (its `deps.env.projectExists` branch): the branch existed for the existing-but-empty project. That case now routes to the Workspace, so the branch serves exactly one scenario. It is still required; its stated purpose is not.

```ts
      // Gap D/§2.4: whichever command matches what the shell actually found on disk. NARROWED
      // (workspace-first launch, 2026-08-02): this branch used to also cover the
      // existing-but-empty project, which reached Home through `hasContent`. `deriveScreen` now
      // routes every existing project to the Workspace, so Home is reached with a project on
      // disk in exactly ONE scenario — ⏎ after a startup open that failed — and that is the only
      // caller left. Still required: `create` would grant trust implicitly over a project whose
      // prior grant is the authority.
```

`src/ui/home/types.ts`, the module header (lines 4-12):

```ts
/**
 * `ui/home` — the Home screen (design `home()`/`homeErr()`, `design/01-home.dc.html`,
 * chrome-map "SURFACE: Home"). NARROWED (workspace-first launch, 2026-08-02): Home is now
 * reached in exactly two situations — a genuinely fresh directory, and a startup open that
 * failed. An existing project mounts the Workspace immediately and fills there
 * (`design/30-workspace-first-launch.dc.html`). {@link HomeProps.openFailure} is what makes the
 * second case legible instead of silent. No chat/preview split, no tab strip.
 */
```

- [ ] **Step 9: Full suite, lint, format, audit, commit**

```bash
rtk bun test src/ui src/entrypoint
rtk bun x oxlint
rtk bun x oxfmt
```

Run `/reatom-audit`, then commit:

```
feat(ui): route an existing project straight to the Workspace

deriveScreen held Home for as long as projectId was null, which is the whole
of the Kernel ready sequence — up to ~30s of a "describe the TUI you want to
design" prompt over a project that already exists. It now routes a pending
startup open to the Workspace and lets it fill there; a blocked open falls
back to Home, which keeps the failure panel and the enter-to-retry.

The opening state is not a new ScreenKind: it is "workspace" with a null
projectId, so finishOpen is a re-render, not a remount.

Two App tests for the Workspace's own opening chrome fail until the next
commit renders it.
```

---

### Task 4: Dispatch on `launch.existing`, and surrender when it fails

Routing to the Workspace on one fact while dispatching `project.open` on another would strand an existing-but-empty project in a Workspace that never opens. One predicate replaces two.

**Files:**
- Modify: `src/ui/app/model/root.tsx`, `src/entrypoint/model/run-app.ts`
- Test: `src/entrypoint/model/run-app.test.ts`

**Interfaces:**
- Consumes: `UiDeps.abandonStartupOpen` (Task 2).
- Produces: `UiRootHandle.abandonStartupOpen(): void` — beside the existing `dispose()`.

- [ ] **Step 1: Write the failing tests**

In `src/entrypoint/model/run-app.test.ts`, inside the existing `describe("the Gap D startup dispatch …")` block. The fixture helper `fakeShell(calls, registry, kernel, launch)` already takes a `launch` argument.

```ts
    test("an existing project with no content dispatches project.open — routing and dispatch share one predicate", async () => {
      const calls: string[] = [];
      const kernel = createFakeKernel();
      const app = await runApp({
        shell: fakeShell(calls, null, kernel, { existing: true, hasContent: false }),
        adapters: recordingAdapters(calls),
        process: fakeBoundary(),
      });
      expect(app).not.toBeInstanceOf(Error);
      expect(
        kernel.dispatched.filter(
          (raw) =>
            typeof raw === "object" && raw !== null && "kind" in raw && raw.kind === "project.open",
        ),
      ).toHaveLength(1);
      await (app as RunningApp).close();
    });

    test("a fresh directory dispatches nothing", async () => {
      const calls: string[] = [];
      const kernel = createFakeKernel();
      const app = await runApp({
        shell: fakeShell(calls, null, kernel, { existing: false, hasContent: false }),
        adapters: recordingAdapters(calls),
        process: fakeBoundary(),
      });
      expect(app).not.toBeInstanceOf(Error);
      expect(
        kernel.dispatched.filter(
          (raw) =>
            typeof raw === "object" && raw !== null && "kind" in raw && raw.kind === "project.open",
        ),
      ).toHaveLength(0);
      await (app as RunningApp).close();
    });

    test("a rejected startup dispatch abandons the pending open so the UI drops back to Home", async () => {
      const calls: string[] = [];
      const kernel = createFakeKernel({ rejectWith: "CAPABILITY_UNAVAILABLE" });
      const abandoned: string[] = [];
      const app = await runApp({
        shell: fakeShell(calls, null, kernel, { existing: true, hasContent: true }),
        adapters: recordingAdapters(calls),
        process: fakeBoundary(),
      });
      expect(app).not.toBeInstanceOf(Error);
      expect(abandoned).toEqual(["abandonStartupOpen"]);
      await (app as RunningApp).close();
    });
```

> **Adapt the last test to the local doubles.** `createFakeKernel`'s option for forcing a rejected dispatch, and the way `recordingAdapters` captures what `runApp` did to the `UiRootHandle`, must both be read from the file. The existing `capturingAdapters`/`selectionCapturingAdapters` helpers at the top of the file show the pattern: return an adapter whose `createRoot` records the handle so the test can assert against it. Add an `abandonCapturingAdapters` in the same shape — the contract to assert is "`runApp` called `abandonStartupOpen()` exactly once on both failure branches, and never on the success branch". If `createFakeKernel` cannot be made to reject, drive the failure branch through a dispatch that throws instead; either branch is acceptable coverage as long as both are exercised.

- [ ] **Step 2: Run them to verify they fail**

```bash
rtk bun test src/entrypoint/model/run-app.test.ts
```

Expected: FAIL — the `existing: true, hasContent: false` case dispatches nothing (there is an existing test asserting exactly that, which this task deliberately inverts — delete it), and `abandonStartupOpen` does not exist on the handle.

- [ ] **Step 3: Extend `UiRootHandle` and hoist `createUiDeps`**

`src/ui/app/model/root.tsx`:

```ts
export interface UiRootHandle {
  /** Idempotently tear down the React tree before releasing the terminal renderer. */
  dispose(): void;
  /**
   * Tells the mounted UI that the composition root's startup `project.open` will never arrive
   * (workspace-first launch) — see `UiDeps.abandonStartupOpen`. `runApp` calls this on both
   * failure branches of that dispatch, in addition to its own `console.error`: without it the
   * user sits on an empty Workspace shell forever, because neither `finishOpen` nor `blockOpen`
   * will ever set `projectId` or `openFailure`.
   */
  abandonStartupOpen(): void;
}
```

In `createUiRoot`, hoist the deps out of the JSX so the returned handle can close over them (today the `createUiDeps(...)` call is inline in `<App deps={…} />`):

```ts
  // Hoisted out of the JSX below so the returned handle can close over it — `abandonStartupOpen`
  // has to reach the SAME `UiDeps` the mounted tree is reading.
  const deps = createUiDeps(
    options.port,
    { w: renderer.width, h: renderer.height },
    options.env,
    options.agentHealthProbe,
    options.requestExit,
    options.agentSelection,
  );

  const mounted = errore.try(() => root.render(<App deps={deps} />));
```

and in the returned handle:

```ts
  let disposed = false;
  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      try {
        root.unmount();
        renderer.destroy();
      } finally {
        resumeConsolePassthrough();
      }
    },
    abandonStartupOpen(): void {
      deps.abandonStartupOpen();
    },
  };
```

- [ ] **Step 4: Switch the predicate and handle both failures in `run-app.ts`**

Replace the whole Gap D block. The long comment about the missing in-app surface goes: this change IS that surface.

```ts
  // Gap D, revised by the workspace-first launch spec (2026-08-02): an EXISTING project — one
  // with `.termcraft/` on disk — opens straight into the Workspace. The predicate is
  // `launch.existing`, not `launch.hasContent`, because `deriveScreen` routes on the same fact:
  // routing to the Workspace on one fact while dispatching on another would strand an
  // existing-but-empty project in a Workspace that never opens. This is the ONE interactive
  // caller of `project.open` — before it, the whole of `src` had exactly one
  // (`entrypoint/model/run-export.ts`, the headless export driver).
  //
  // A FAILED STARTUP DISPATCH now has a real surface. The two `console.error` calls below still
  // run while the renderer owns the terminal, so `infrastructure/debug-log`'s pass-through gate
  // swallows them — which is why they are no longer the only handling. `abandonStartupOpen`
  // clears the UI's pending-open flag, and `deriveScreen` drops back to Home: the screen that
  // owns `HomeOpenFailurePanel`, the `project.close` recovery and the ⏎ retry. Without it the
  // user would sit on an empty Workspace shell forever, since neither `finishOpen` nor
  // `blockOpen` ever arrives on this path.
  //
  // Placed AFTER `startShutdownPath` (fix round 1): that call registers the SIGINT/SIGTERM
  // handlers this function awaits nothing before. Dispatching first, as this used to, meant a
  // Ctrl-C during the (up to ~30s) open sequence had no handler to catch it.
  if (shell.launch.existing) {
    const dispatcher = createDispatcher({
      port: shell.port,
      revision: () => peekStateRevision(shell.port),
    });
    const result = await dispatcher.dispatch("project.open", { root: shell.env.root });
    if (result instanceof Error) {
      console.error(
        `termcraft: the startup project.open failed to dispatch: ${result.message}`,
        result,
      );
      root.abandonStartupOpen();
    } else if (result.status === "rejected") {
      console.error(`termcraft: the startup project.open was rejected (${result.code})`);
      root.abandonStartupOpen();
    }
  }
```

`ShellLaunchV1.hasContent` stays on the type and stays computed — nothing else reads it today, but removing it is a separate decision from this spec's scope. Add one line to its doc comment in `src/entrypoint/types.ts` so the next reader is not misled:

```ts
 * NO LONGER THE ROUTING PREDICATE (workspace-first launch, 2026-08-02): `existing` is. Both
 * `run-app.ts`'s startup dispatch and `deriveScreen` read `existing`, because routing on one
 * fact while dispatching on the other would strand an existing-but-empty project in a Workspace
 * that never opens. `hasContent` is still computed and still reported; nothing reads it.
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
rtk bun test src/entrypoint/model/run-app.test.ts
rtk bun x tsc --noEmit
```

Expected: PASS. `bun test src/entrypoint` must stay green too — `smoke.test.ts` constructs a `UiRootHandle` double and will need `abandonStartupOpen` added to it.

- [ ] **Step 6: Lint, format, commit**

```bash
rtk bun x oxlint
rtk bun x oxfmt
rtk git add src/ui/app/model/root.tsx src/entrypoint
rtk git commit -F <message-file>
```

```
feat(entrypoint): dispatch the startup open on launch.existing

deriveScreen now routes every existing project to the Workspace, so the
startup dispatch has to read the same fact: routing on `existing` while
dispatching on `hasContent` would strand an existing-but-empty project in a
Workspace that never opens. One predicate replaces two.

The failure branches stop being logged-and-forgotten. run-app.ts already
documented that a rejected startup dispatch leaves projectId and openFailure
null forever; before this change that stranded the user on Home, and after
it would have stranded them on an empty Workspace shell. Both branches now
call the UI's abandonStartupOpen, which routes back to Home and its failure
panel.
```

---

### Task 5: The Workspace while the project is opening

The state is `mirror.project().projectId === null`. No new flag: `Workspace` is a `reatomComponent` and already reads the project slice.

Design: `design/30-workspace-first-launch.dc.html` "Mid-open" and "80×24 — the floor"; engine `wsOpening` (`design/termcraft-engine.js:229-248`).

**Tabs and the chat panel need no change, and that is a decision, not an omission.** `deriveTabs` is empty because `descriptors` is empty, and the ghost tab requires a running turn — the design draws an empty strip with no ghost, which falls out for free. The chat panel's `● {agent}` header line is already suppressed by `agentLabel === ""` (`mirror.agentIdentity()` is null until the open finishes), matching `chatSeq`'s own `header:false`. §30 answers its own design question 3 explicitly: **no line is added to the empty panel** — §28's `╌╌╌ start of chat ╌╌╌` marker means "you scrolled up and there is nothing more to load", a claim about paging that does not apply to a project with no chat loaded at all. Do not add one.

**Files:**
- Create: `src/ui/preview/ui/OpeningState.tsx`
- Modify: `src/ui/preview/index.ts`, `src/ui/workspace/ui/Workspace.tsx`
- Test: `src/ui/workspace/ui/Workspace.test.tsx`, `src/ui/app/ui/App.test.tsx` (un-todo Task 3's two assertions)

**Interfaces:**
- Consumes: the routing from Task 3 (the Workspace is now mounted with `projectId === null`).
- Produces: `OpeningState` (props `{ id: string; width: number; height: number }`), exported from `ui/preview`.

- [ ] **Step 1: Write the failing tests**

Append to `src/ui/workspace/ui/Workspace.test.tsx`:

```ts
describe("Workspace while the project is opening (design 30-workspace-first-launch, wsOpening)", () => {
  /** `mirror.project().projectId === null` is the whole condition — a fresh `UiDeps` with no
   *  snapshot applied is exactly that state. */
  const openingDeps = () => createUiDeps(createFakeKernel(), { w: 120, h: 36 });

  test("the preview centres the design's own two lines and never the zero-pages EmptyState", async () => {
    const handle = await createHeadlessRenderer({ w: 120, h: 36 });
    open = handle;
    handle.mount(<Workspace deps={openingDeps()} readOnly={false} />);
    await handle.render();
    const text = allText(handle.capture().rows);

    expect(text).toContain("opening project…");
    expect(text).toContain("reading .termcraft — preview arrives when it's ready");
    // §20's line asserts a DIFFERENT fact — a finished project that genuinely has no pages.
    expect(text).not.toContain("No pages yet — describe what to build");
  });

  test("no spinner: a spinner is turn vocabulary and nothing here is a turn", async () => {
    const handle = await createHeadlessRenderer({ w: 120, h: 36 });
    open = handle;
    handle.mount(<Workspace deps={openingDeps()} readOnly={false} />);
    await handle.render();
    const rows = handle.capture().rows;

    expect(findRun(rows, "⠹ generating")).toBeUndefined();
    const line = findRun(rows, "opening project…");
    expect(line && extractRgb(line.fg)).toBe(SHELL_PALETTE.amber);
  });

  test("the page slot carries the opening phrase and the mode chip reads OPENING, not STATIC", async () => {
    const handle = await createHeadlessRenderer({ w: 120, h: 36 });
    open = handle;
    handle.mount(<Workspace deps={openingDeps()} readOnly={false} />);
    await handle.render();
    const text = allText(handle.capture().rows);

    expect(text).toContain("OPENING");
    expect(text).not.toContain("STATIC");
  });

  test("the composer stays live with the opening placeholder and a disabled send key", async () => {
    const handle = await createHeadlessRenderer({ w: 120, h: 36 });
    open = handle;
    handle.mount(<Workspace deps={openingDeps()} readOnly={false} />);
    await handle.render();
    const rows = handle.capture().rows;
    const text = allText(rows);

    expect(text).toContain("project opening…");
    expect(text).toContain("send");
    const sendKey = findRun(rows, " ⏎ ");
    expect(sendKey && extractRgb(sendKey.fg)).toBe(SHELL_PALETTE.faint);
    // F2/F3/F4 have nothing to act on yet — no preview, no page to tweak or interact with.
    expect(text).not.toContain("tweaks");
    expect(text).not.toContain("act");
  });

  test("at the 80-column floor the size segment drops and the phrase shortens", async () => {
    const handle = await createHeadlessRenderer({ w: 80, h: 24 });
    open = handle;
    handle.mount(<Workspace deps={createUiDeps(createFakeKernel(), { w: 80, h: 24 })} readOnly={false} />);
    await handle.render();
    const text = allText(handle.capture().rows);

    expect(text).toContain("opening…");
    expect(text).not.toContain("opening project…");
    expect(text).not.toContain("80×24");
  });

  test("an open project renders the ordinary Workspace, not the opening chrome", async () => {
    const deps = createUiDeps(createFakeKernel(), { w: 120, h: 36 });
    deps.mirror.apply(
      snapshot({
        projectId: uuidv7(),
        activePageSlug: "main",
        activeChatId: uuidv7(),
        trust: "trusted",
      }),
    );
    const handle = await createHeadlessRenderer({ w: 120, h: 36 });
    open = handle;
    handle.mount(<Workspace deps={deps} readOnly={false} />);
    await handle.render();
    const text = allText(handle.capture().rows);

    expect(text).not.toContain("OPENING");
    expect(text).not.toContain("opening project…");
    expect(text).toContain("STATIC");
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

```bash
rtk bun test src/ui/workspace/ui/Workspace.test.tsx
```

Expected: FAIL — the preview renders `No pages yet — describe what to build`, the chip reads `STATIC`, the placeholder reads `tab → focus composer` or `Ask for changes…`.

- [ ] **Step 3: Create `src/ui/preview/ui/OpeningState.tsx`**

```tsx
import { SHELL_PALETTE, shellAttrs } from "ui/theme";

/** Props for the {@link OpeningState} project-opening preview placeholder. */
export interface OpeningStateProps {
  /** Stable id the host selects and answers geometry on. */
  readonly id: string;
  readonly width: number;
  readonly height: number;
}

const BOLD = shellAttrs({ bold: true });

/**
 * The preview region while the project is still opening (design `wsOpening`,
 * `design/30-workspace-first-launch.dc.html`'s `ws-open-checking-120`). Shown when
 * `mirror.project().projectId` is null — the Workspace has mounted and is waiting for the
 * Kernel's ready sequence to publish descriptors.
 *
 * DISTINCT FROM `EmptyState` AND FROM THE GENERATING BLOCK, on purpose — §30's own prose:
 * §20's `No pages yet` is a FINISHED project that genuinely has none, and §14's
 * `⠹ generating first page…` is a running, cancellable turn. Neither is true here.
 *
 * NOTHING SPINS. A spinner is turn vocabulary (§14); this state has no cancel and nothing
 * measurable, so drawing one would borrow a promise it cannot keep. Two static lines, the first
 * amber and bold, the second faint.
 */
export function OpeningState(props: OpeningStateProps) {
  return (
    <box
      id={props.id}
      width={props.width}
      height={props.height}
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
    >
      {/* divergence: design centres at `dy+floor(dh/2)-1` and `+1` via absolute placement
          (engine `ctr`); flexbox centring on both axes with a blank row between is the closest
          faithful mapping in OpenTUI's box layout — the same note `EmptyState.tsx` carries. */}
      <text id={`${props.id}-headline`} fg={SHELL_PALETTE.amber} attributes={BOLD}>
        opening project…
      </text>
      <text id={`${props.id}-spacer`}> </text>
      <text id={`${props.id}-detail`} fg={SHELL_PALETTE.faint}>
        {"reading .termcraft — preview arrives when it's ready"}
      </text>
    </box>
  );
}
```

Export it from `src/ui/preview/index.ts`, beside `EmptyState`:

```ts
export type { OpeningStateProps } from "./ui/OpeningState";
export { OpeningState } from "./ui/OpeningState";
```

- [ ] **Step 4: Branch the preview region**

In `src/ui/workspace/ui/Workspace.tsx`, import `OpeningState` from `ui/preview`, add an `opening` parameter to `renderPreviewRegion` and branch on it first:

```ts
function renderPreviewRegion(
  preview: PreviewMirror,
  uiFrame: UiPreviewFrame | null,
  hasPages: boolean,
  opening: boolean,
  region: CellSize,
  interaction: Readonly<{ /* unchanged — the existing inline type */ }>,
) {
  // FIRST, ahead of every other branch. "There are no pages" and "the pages have not been read
  // yet" are different facts, and only this one is true while `projectId` is null — the preview
  // machine cannot have failed or halted for a project that has not opened, so no branch below
  // is being pre-empted. Design `wsOpening` (`design/30-workspace-first-launch.dc.html`).
  if (opening) {
    return <OpeningState id="ws-preview-opening" width={region.w} height={region.h} />;
  }
  // every existing branch below stays exactly as it is: failed -> circuit-open -> !hasPages ->
  // frame -> "preparing preview…"
```

and at the call site:

```tsx
          {renderPreviewRegion(preview, uiFrame, descriptors.length > 0, opening, previewRegion, {
```

- [ ] **Step 5: Derive `opening` and drive the status bar and composer**

Near the other reads at the top of the component (after `const preview = mirror.preview();`):

```ts
  // `projectId === null` inside a mounted Workspace means exactly one thing: `deriveScreen`
  // routed a pending startup open here and the Kernel's ready sequence has not published
  // anything yet (`ui/mirror/model/screen.ts`). No new flag is needed for it.
  const opening = mirror.project().projectId === null;
  // design `wsOpening`'s own `narrow` (`termcraft-engine.js:235`): at the floor the size segment
  // is dropped and the phrase shortens, the same restraint the idle shell already applies below
  // 100 columns.
  const narrow = size.w < 100;
```

Composer placeholder — add the opening arm ahead of the rest:

```ts
  const composerPlaceholder = opening
    ? "project opening…"
    : props.readOnly
      ? "read-only — Send disabled"
      : turn.phase === "running"
        ? "generating… esc to cancel"
        : composerFocused
          ? "Ask for changes…"
          : "tab → focus composer";
```

Leave `disabled` alone: the design keeps the composer live while it is opening ("The composer stays live"), and default focus is already `"composer"`.

Status bar:

```tsx
      <StatusBar
        id="ws-status"
        width={w}
        mode={
          // design `wsOpening`: ` OPENING `, not ` STATIC `. STATIC asserts a finished,
          // unchanging design, which is exactly the claim this state cannot make.
          opening
            ? { text: "OPENING", fg: "bg", bg: "amber" }
            : modeChip(turn, fullscreen, props.readOnly, previewHalt)
        }
        page={
          // The page slot is FILLED, not dropped: there is no page slug yet, so it carries
          // Home's own phrase for the same state, verbatim (design `wsOpening`, and
          // `Home.tsx:335` for the identical slot choice).
          opening
            ? { text: narrow ? "opening…" : "opening project…", fg: "amber", bold: true }
            : activePageSlug !== null
              ? { text: activePageSlug, fg: "dim" }
              : null
        }
        // design `wsOpening`: the size segment is one of the two things dropped at the floor.
        size={opening && narrow ? null : { w, h, min: minSize }}
        ctx={ctx}
        ctxCaution={ctx !== null && ctx >= 80}
        // Leave the existing four-tier `hint` expression exactly as it is — Task 6 replaces the
        // whole prop with the five-tier chain. Touching it here would only create a conflict.
        hint={/* the existing expression, verbatim */}
        hintKeys={
          // design `wsOpening`: `keys:[['⏎','send','dis']]` and nothing else. F2/F3/F4 are
          // dropped rather than drawn inert — none of the three has anything to act on yet (no
          // preview, no page to tweak or interact with), and Home's own `checking` state shows
          // the same restraint.
          opening ? OPENING_HINT_KEYS : hintKeys(turn, fullscreen, previewHalt)
        }
      />
```

with, beside the other module constants near `hintKeys`:

```ts
/** design `wsOpening`'s own key row (`design/termcraft-engine.js:247`). */
const OPENING_HINT_KEYS: readonly StatusBarHintKey[] = [["⏎", "send", "dis"]];
```

> **The dropped combo chip.** `wsOpening` also draws a leading ` codex · gpt5.5 · high ` chip. Add this note above the `mode` prop and do not implement it — see the plan's Divergences §1:
>
> ```ts
> // DIVERGENCE (design sample data + no runtime source): `wsOpening` opens its bar with a
> // ` codex · gpt5.5 · high ` chip. `StatusBar` has no combo segment at all — every workspace
> // frame after §07 passes `combo:false`, which is exactly what `buildLeftSegments` implements —
> // and while the project is opening `mirror.agentIdentity()` is still null, so there is no
> // honest value to draw. The segment is dropped; every other segment of the opening bar is
> // implemented verbatim.
> ```

- [ ] **Step 6: Run the Workspace and App tests to verify they pass**

```bash
rtk bun test src/ui/workspace/ui/Workspace.test.tsx src/ui/app/ui/App.test.tsx
rtk bun x tsc --noEmit
```

Expected: PASS, including Task 3's two previously-failing App assertions. Un-todo them if you marked them `test.todo`.

- [ ] **Step 7: Lint, format, commit**

```bash
rtk bun x oxlint
rtk bun x oxfmt
rtk git add src/ui/preview src/ui/workspace src/ui/app/ui/App.test.tsx
rtk git commit -F <message-file>
```

```
feat(ui): render the Workspace while the project is still opening

The Workspace now mounts with a null projectId, and three of its regions
asserted something false for that state. The preview said "No pages yet",
which is a claim about a finished project; it now carries design 30's own
two static lines, with no spinner — a spinner is turn vocabulary and this
state has no cancel and nothing measurable. The page slot, free because
there is no active slug yet, carries Home's own "opening project…" phrase.
The mode chip reads OPENING rather than STATIC, which would assert a
finished design. The composer stays live with a disabled send key, and
F2/F3/F4 drop rather than draw inert — none of them has anything to act on.
```

---

### Task 6: The agent-health badge in the Workspace status bar

The Workspace starts reading the health atom, which today has exactly one consumer. `checking` is rendered, not just the error states — that is the visible result of this whole change: the Workspace appears instantly and the status bar shows the agent check running beside it.

Design: `design/30-workspace-first-launch.dc.html` "The long-lived badge" and "The badge vocabulary"; engine `agentBadge` (`:208-218`) and `badgeStrip` (`:220-227`).

**Files:**
- Create: `src/ui/workspace/model/health-badge.ts`, `src/ui/workspace/model/health-badge.test.ts`
- Modify: `src/ui/workspace/types.ts`, `src/ui/workspace/ui/Workspace.tsx`
- Test: `src/ui/workspace/ui/Workspace.test.tsx`

**Interfaces:**
- Consumes: `AgentHealth` (Task 1), `UiLocalState.agentHealth` (Task 1), the `opening` flag (Task 5).
- Produces:
  - `agentHealthBadge(health: AgentHealth, short: boolean): StatusBarHintBadge | null`
  - `WorkspaceLocalState.agentHealth: Atom<AgentHealth>`

- [ ] **Step 1: Write the failing badge tests**

`src/ui/workspace/model/health-badge.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

import type { AgentHealth } from "ui/agent-health";

import { agentHealthBadge } from "./health-badge";

const CLAUDE = "claude";

describe("agentHealthBadge (design 30, engine agentBadge :208-218)", () => {
  test("ready draws nothing, matching Home", () => {
    expect(agentHealthBadge({ kind: "ready", agent: CLAUDE }, false)).toBeNull();
  });

  test("checking reads amberHi on line and names the agent", () => {
    expect(agentHealthBadge({ kind: "checking", agent: CLAUDE }, false)).toEqual({
      text: "⠹ checking claude",
      fg: "amberHi",
      bg: "line",
    });
  });

  test("advisory tells its two panels apart", () => {
    const sandbox: AgentHealth = {
      kind: "advisory",
      agent: CLAUDE,
      panel: "sandbox",
      detail: "sandbox unavailable",
    };
    const shutdown: AgentHealth = {
      kind: "advisory",
      agent: CLAUDE,
      panel: "shutdown",
      detail: "exited without confirming shutdown",
    };
    expect(agentHealthBadge(sandbox, false)?.text).toBe("⚠ sandbox degraded");
    expect(agentHealthBadge(shutdown, false)?.text).toBe("⚠ health unconfirmed");
    expect(agentHealthBadge(shutdown, false)?.bg).toBe("line");
  });

  test("blocked reads bg-on-red and tells login from latched", () => {
    const login: AgentHealth = {
      kind: "blocked",
      agent: CLAUDE,
      panel: "login",
      detail: "not signed in",
    };
    const latched: AgentHealth = {
      kind: "blocked",
      agent: CLAUDE,
      panel: "latched",
      detail: "unconfirmed exit lockout",
    };
    expect(agentHealthBadge(login, false)).toEqual({
      text: "✗ claude not signed in",
      fg: "bg",
      bg: "red",
    });
    expect(agentHealthBadge(latched, false)?.text).toBe("✗ claude unavailable");
  });

  test("missing gets a badge here — no full-screen takeover in the Workspace", () => {
    expect(agentHealthBadge({ kind: "missing", agent: CLAUDE, detail: "not on PATH" }, false)).toEqual(
      { text: "✗ claude not found", fg: "bg", bg: "red" },
    );
  });

  test("short drops the agent name for the 80-column floor", () => {
    expect(agentHealthBadge({ kind: "checking", agent: CLAUDE }, true)?.text).toBe("⠹ checking");
    expect(
      agentHealthBadge({ kind: "blocked", agent: CLAUDE, panel: "login", detail: "x" }, true)?.text,
    ).toBe("✗ not signed in");
    expect(
      agentHealthBadge({ kind: "blocked", agent: CLAUDE, panel: "latched", detail: "x" }, true)
        ?.text,
    ).toBe("✗ unavailable");
    expect(
      agentHealthBadge({ kind: "missing", agent: CLAUDE, detail: "x" }, true)?.text,
    ).toBe("✗ not found");
    // The advisory phrases never carry the agent name, so `short` cannot change them.
    expect(
      agentHealthBadge({ kind: "advisory", agent: CLAUDE, panel: "sandbox", detail: "x" }, true)
        ?.text,
    ).toBe("⚠ sandbox degraded");
  });
});
```

Append to `src/ui/workspace/ui/Workspace.test.tsx`:

```ts
describe("Workspace agent-health badge (design 30, the badge vocabulary)", () => {
  const withHealth = (health: AgentHealth) => {
    const deps = createUiDeps(createFakeKernel(), { w: 120, h: 36 });
    deps.mirror.apply(
      snapshot({
        projectId: uuidv7(),
        activePageSlug: "main",
        activeChatId: uuidv7(),
        trust: "trusted",
      }),
    );
    deps.local.agentHealth.set(health);
    return deps;
  };

  test("renders the badge for a blocked agent over an otherwise working project", async () => {
    const handle = await createHeadlessRenderer({ w: 120, h: 36 });
    open = handle;
    handle.mount(
      <Workspace
        deps={withHealth({ kind: "blocked", agent: "claude", panel: "login", detail: "x" })}
        readOnly={false}
      />,
    );
    await handle.render();
    const rows = handle.capture().rows;

    expect(allText(rows)).toContain("✗ claude not signed in");
    // No takeover: the project's own chrome is untouched.
    expect(allText(rows)).toContain("STATIC");
    const badge = findRun(rows, "✗ claude not signed in");
    expect(badge && extractRgb(badge.bg)).toBe(SHELL_PALETTE.red);
  });

  test("renders checking while the probe runs — the point of the whole change", async () => {
    const handle = await createHeadlessRenderer({ w: 120, h: 36 });
    open = handle;
    handle.mount(
      <Workspace deps={withHealth({ kind: "checking", agent: "claude" })} readOnly={false} />,
    );
    await handle.render();
    expect(allText(handle.capture().rows)).toContain("⠹ checking claude");
  });

  test("renders nothing for ready", async () => {
    const handle = await createHeadlessRenderer({ w: 120, h: 36 });
    open = handle;
    handle.mount(
      <Workspace deps={withHealth({ kind: "ready", agent: "claude" })} readOnly={false} />,
    );
    await handle.render();
    const text = allText(handle.capture().rows);
    expect(text).not.toContain("⠹ checking");
    expect(text).not.toContain("✗ claude");
  });

  test("a running turn outranks health — the agent is alive by demonstration", async () => {
    const deps = withHealth({ kind: "blocked", agent: "claude", panel: "login", detail: "x" });
    deps.mirror.apply(
      event("turn.started", { turnId: uuidv7(), chatId: uuidv7(), deadline: TEST_TS }),
    );
    const handle = await createHeadlessRenderer({ w: 120, h: 36 });
    open = handle;
    handle.mount(<Workspace deps={deps} readOnly={false} />);
    await handle.render();
    const text = allText(handle.capture().rows);

    expect(text).toContain("⚠ turn running — send disabled");
    expect(text).not.toContain("✗ claude not signed in");
  });

  test("read-only outranks health", async () => {
    const deps = withHealth({ kind: "blocked", agent: "claude", panel: "login", detail: "x" });
    const handle = await createHeadlessRenderer({ w: 120, h: 36 });
    open = handle;
    handle.mount(<Workspace deps={deps} readOnly />);
    await handle.render();
    const text = allText(handle.capture().rows);

    expect(text).toContain("Send · Tweaks · pins disabled");
    expect(text).not.toContain("✗ claude not signed in");
  });

  test("the badge shows during the open, beside the OPENING chip", async () => {
    const deps = createUiDeps(createFakeKernel(), { w: 120, h: 36 });
    deps.local.agentHealth.set({ kind: "checking", agent: "claude" });
    const handle = await createHeadlessRenderer({ w: 120, h: 36 });
    open = handle;
    handle.mount(<Workspace deps={deps} readOnly={false} />);
    await handle.render();
    const text = allText(handle.capture().rows);

    expect(text).toContain("OPENING");
    expect(text).toContain("⠹ checking claude");
  });

  test("at the floor the badge drops the agent name", async () => {
    const deps = createUiDeps(createFakeKernel(), { w: 80, h: 24 });
    deps.local.agentHealth.set({ kind: "checking", agent: "claude" });
    const handle = await createHeadlessRenderer({ w: 80, h: 24 });
    open = handle;
    handle.mount(<Workspace deps={deps} readOnly={false} />);
    await handle.render();
    const text = allText(handle.capture().rows);

    expect(text).toContain("⠹ checking");
    expect(text).not.toContain("⠹ checking claude");
  });
});
```

`AgentHealth` and `TEST_TS` need importing at the top of the test file (`import type { AgentHealth } from "ui/agent-health";`, and `TEST_TS` from `ui/testing` beside `TEST_SHA`).

- [ ] **Step 2: Run them to verify they fail**

```bash
rtk bun test src/ui/workspace
```

Expected: FAIL — `health-badge.ts` does not exist, and `deps.local.agentHealth` is not on `WorkspaceLocalState`.

- [ ] **Step 3: Create `src/ui/workspace/model/health-badge.ts`**

```ts
import type { AgentHealth } from "ui/agent-health";
import type { StatusBarHintBadge } from "ui/status-bar";

/**
 * The agent-health reading as the Workspace status bar's `hint` badge (design
 * `design/30-workspace-first-launch.dc.html`'s "The badge vocabulary", engine `agentBadge`
 * `design/termcraft-engine.js:208-218`).
 *
 * Five outcomes, four shapes. `ready` draws NOTHING, matching Home. `checking` and `advisory`
 * read amberHi on `line`; `blocked` and `missing` read `bg` on `red`. `missing` has no badge on
 * Home at all — it takes over the whole screen there — and §30 invents its Workspace shape from
 * the takeover's own words, because hiding a working project behind a problem that blocks one
 * capability out of six is wrong.
 *
 * DIVERGENCE (design sample data, not layout): the design writes `codex` (user decision
 * 2026-07-23). The agent name comes from the reading itself.
 *
 * DIVERGENCE (inherited): `StatusBarHintBadge` is plain text and cannot host a component
 * (`ui/home/ui/Home.tsx:56` already documents this), so the `⠹` is static, not animated. Home
 * lives with it; so does this.
 *
 * `short` is the design's own `opt.short` — at the 80-column floor the agent name is dropped
 * (`⠹ checking`, not `⠹ checking codex`), the same restraint the idle shell already applies.
 * The two advisory phrases never carried the name, so `short` cannot change them.
 */
export function agentHealthBadge(health: AgentHealth, short: boolean): StatusBarHintBadge | null {
  if (health.kind === "ready") return null;
  if (health.kind === "checking") {
    return {
      text: short ? "⠹ checking" : `⠹ checking ${health.agent}`,
      fg: "amberHi",
      bg: "line",
    };
  }
  if (health.kind === "advisory") {
    return {
      text: health.panel === "sandbox" ? "⚠ sandbox degraded" : "⚠ health unconfirmed",
      fg: "amberHi",
      bg: "line",
    };
  }
  if (health.kind === "blocked") {
    const text =
      health.panel === "latched"
        ? short
          ? "✗ unavailable"
          : `✗ ${health.agent} unavailable`
        : short
          ? "✗ not signed in"
          : `✗ ${health.agent} not signed in`;
    return { text, fg: "bg", bg: "red" };
  }
  return {
    text: short ? "✗ not found" : `✗ ${health.agent} not found`,
    fg: "bg",
    bg: "red",
  };
}
```

- [ ] **Step 4: Add the atom to `WorkspaceLocalState`**

`src/ui/workspace/types.ts` — add the import and the field. `UiLocalState` (Task 1) already satisfies it structurally, so `ui/app` needs no change.

```ts
import type { AgentHealth } from "ui/agent-health";
```

```ts
  /**
   * The agent-health reading, shown as the lowest-precedence badge in the status bar's `hint`
   * slot (workspace-first launch, 2026-08-02). Read-only from this module's point of view: the
   * probe runs once at startup and is NEVER refreshed, so a bad reading rides the bar for the
   * life of the process. That is a deliberate trade, recorded in the spec — a `/recheck` action
   * was considered and declined.
   */
  readonly agentHealth: Atom<AgentHealth>;
```

- [ ] **Step 5: Add the fifth `hint` tier**

In `src/ui/workspace/ui/Workspace.tsx`, read the atom beside the other local reads and rewrite the `hint` prop. The chain is now five tiers, design's own order: read-only → turn running → preview halt → agent health → none.

```ts
  const healthBadge = agentHealthBadge(local.agentHealth(), narrow);
```

```tsx
        hint={
          // design 30, "The badge vocabulary": precedence, highest first — read-only, turn
          // running, preview halt, agent health, none.
          //
          // `turn running` MUST outrank health by rule, not by taste: while a turn runs the agent
          // is alive by demonstration, and a stale `✗ … not signed in` sitting under it would
          // contradict what is happening on screen in the same second.
          //
          // Preview halt outranks health because it is the more urgent, more specific fact — and
          // §30 answers the collision directly: the halt keeps the slot, and the halt PANEL says
          // what health would have said (see `HostCrashPanel`'s `agentDead`).
          props.readOnly
            ? { text: "Send · Tweaks · pins disabled", fg: "faint", bg: "line" }
            : turn.phase === "running"
              ? { text: "⚠ turn running — send disabled", fg: "amberHi", bg: "line" }
              : previewHalt !== null
                ? {
                    text: previewHalt.designAtFault ? "render crashed" : "host unavailable",
                    fg: "red",
                    bg: "redDim",
                  }
                : healthBadge
        }
```

Keep the two existing citation comments (`finding §2.5`, "Each halted screen's own hint") on their arms — they are still true; only the chain's tail is new.

- [ ] **Step 6: Run the tests to verify they pass**

```bash
rtk bun test src/ui/workspace
rtk bun x tsc --noEmit
```

Expected: PASS.

- [ ] **Step 7: Lint, format, commit**

```bash
rtk bun x oxlint
rtk bun x oxfmt
rtk git add src/ui/workspace
rtk git commit -F <message-file>
```

```
feat(ui): show the agent-health reading in the Workspace status bar

Removing Home from the launch path removed the only surface the health probe
had, so a dead agent CLI would have produced no on-screen signal at all. The
reading becomes the lowest tier of the status bar's hint slot: read-only,
turn running and preview halt all outrank it. A running turn must, by rule —
it demonstrates the agent is alive, so a stale bad reading under it would
contradict the screen.

checking renders, not just the failures: the Workspace appearing instantly
with the agent check running beside it is the visible result of this change.
No takeover for missing — a project is open, and five of its six
capabilities work without an agent.
```

---

### Task 7: The halted-preview panel stops promising a repair the agent cannot run

Both can be true at once: the preview host has crashed and latched, and the agent probe separately read blocked. The hint slot holds one badge and the halt keeps it — but the halt block's F6 route reads `repair…` and promises a turn, and with the agent dead that turn cannot run.

Design: `design/30-workspace-first-launch.dc.html` "The collision"; engine `wsHostCrash`'s `agentDead` branch (`:1198-1240`).

**Files:**
- Modify: `src/ui/workspace/model/health-badge.ts`, `src/ui/preview/ui/HostCrashPanel.tsx`, `src/ui/workspace/ui/Workspace.tsx`
- Test: `src/ui/workspace/model/health-badge.test.ts`, `src/ui/workspace/ui/Workspace.test.tsx`

**Interfaces:**
- Consumes: `agentHealthBadge` (Task 6).
- Produces:
  - `interface AgentDeadNotice { readonly f6Detail: string | null; readonly line: string }`
  - `agentDeadNotice(health: AgentHealth): AgentDeadNotice | null`
  - `HostCrashPanelProps.agentDead: AgentDeadNotice | null`

- [ ] **Step 1: Write the failing tests**

Append to `src/ui/workspace/model/health-badge.test.ts`:

```ts
describe("agentDeadNotice (design 30, the collision)", () => {
  test("a healthy or merely advisory agent produces no notice", () => {
    expect(agentDeadNotice({ kind: "ready", agent: "claude" })).toBeNull();
    expect(agentDeadNotice({ kind: "checking", agent: "claude" })).toBeNull();
    expect(
      agentDeadNotice({ kind: "advisory", agent: "claude", panel: "shutdown", detail: "x" }),
    ).toBeNull();
  });

  test("blocked/login gets the design's own F6 detail and its red line", () => {
    expect(
      agentDeadNotice({ kind: "blocked", agent: "claude", panel: "login", detail: "x" }),
    ).toEqual({
      f6Detail: "claude is not signed in — nothing runs until it is",
      line: "✗ claude not signed in — F6 fills the composer, but nothing runs yet",
    });
  });

  test("latched and missing get the generic line, and leave F6's own detail alone", () => {
    expect(
      agentDeadNotice({ kind: "blocked", agent: "claude", panel: "latched", detail: "x" }),
    ).toEqual({
      f6Detail: null,
      line: "✗ claude unavailable — F6 fills the composer, but nothing runs yet",
    });
    expect(agentDeadNotice({ kind: "missing", agent: "claude", detail: "x" })).toEqual({
      f6Detail: null,
      line: "✗ claude not found — F6 fills the composer, but nothing runs yet",
    });
  });
});
```

Append to `src/ui/workspace/ui/Workspace.test.tsx`. The fixture is the one the existing `describe("Workspace halted preview (design wsHostCrash)")` block already builds (`Workspace.test.tsx:858-899`) — `circuitOpened` and `renderWith` — with one addition: the health atom is set before the mount.

```ts
describe("Workspace halted preview + dead agent (design 30, the collision)", () => {
  const CRASH = "PAGE_RENDER_FAILED: TypeError: ctx.spy is not a function";

  const crashed = () =>
    event("preview.circuitOpened", {
      previewSessionId: uuidv7(),
      pageSlug: "main",
      sourceHash: TEST_SHA,
      attempts: 4,
      finalFailure: {
        code: "HOST_CIRCUIT_OPEN",
        retryable: true,
        safeMessage: CRASH,
        details: { pageSlug: "main", attempts: 4, hostFailureCode: "DESIGN_RENDER_FAILED" },
      },
      retryCapability: { available: true },
    });

  async function renderHalted(health: AgentHealth) {
    const deps = createUiDeps(createFakeKernel(), { w: 120, h: 36 });
    deps.mirror.apply(
      snapshot({
        projectId: uuidv7(),
        activePageSlug: "main",
        activeChatId: uuidv7(),
        trust: "trusted",
      }),
    );
    deps.mirror.apply(crashed());
    deps.local.agentHealth.set(health);
    const handle = await createHeadlessRenderer({ w: 120, h: 36 });
    open = handle;
    handle.mount(<Workspace deps={deps} readOnly={false} />);
    await handle.render();
    return handle.capture().rows;
  }

  test("the halt keeps the hint slot and the panel says the repair cannot run", async () => {
    const rows = await renderHalted({
      kind: "blocked",
      agent: "claude",
      panel: "login",
      detail: "not signed in",
    });
    const text = allText(rows);

    // One badge, and the halt's own is the more urgent, more specific fact.
    expect(findRun(rows, "render crashed")).toBeDefined();
    expect(text).toContain("HALTED");
    // The panel carries the correction the hint slot cannot.
    expect(text).toContain("claude is not signed in — nothing runs until it is");
    expect(text).toContain("✗ claude not signed in — F6 fills the composer, but nothing runs yet");
    expect(text).not.toContain("nothing is sent — you press ⏎");
  });

  test("a latched agent gets the generic line and keeps F6's ordinary detail", async () => {
    const text = allText(
      await renderHalted({
        kind: "blocked",
        agent: "claude",
        panel: "latched",
        detail: "unconfirmed exit lockout",
      }),
    );
    expect(text).toContain("✗ claude unavailable — F6 fills the composer, but nothing runs yet");
    expect(text).toContain("nothing is sent — you press ⏎");
  });

  test("a healthy agent leaves the halt panel exactly as it was", async () => {
    const text = allText(await renderHalted({ kind: "ready", agent: "claude" }));
    expect(text).toContain("nothing is sent — you press ⏎");
    expect(text).not.toContain("nothing runs yet");
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

```bash
rtk bun test src/ui/workspace
```

Expected: FAIL — `agentDeadNotice` is not exported, and the panel renders its unconditional F6 detail.

- [ ] **Step 3: Add `agentDeadNotice` to `health-badge.ts`**

```ts
/** The halted-preview panel's dead-agent correction — see {@link agentDeadNotice}. */
export interface AgentDeadNotice {
  /**
   * The F6 row's second line, when the design supplies one for this reading. `null` keeps the
   * panel's ordinary wording — see the divergence note on {@link agentDeadNotice}.
   */
  readonly f6Detail: string | null;
  /** The red line under the tee rule (design 30, "The collision"). */
  readonly line: string;
}

/**
 * The correction the halted-preview panel needs when the agent probe has separately read the
 * agent as unusable (design `design/30-workspace-first-launch.dc.html`'s "The collision", engine
 * `wsHostCrash`'s `agentDead` branch, `design/termcraft-engine.js:1198-1240`).
 *
 * A crashed preview's own repair path is F6 → a turn → the agent. With the agent dead that turn
 * cannot run, so the block's `repair…` route promises something it cannot deliver — and the
 * composer would quietly swallow an ⏎ that goes nowhere. The hint slot is NOT the place to say
 * so: the halt's own `render crashed` badge keeps it, being the more urgent and more specific
 * fact, and the panel carries the correction instead.
 *
 * `null` for `ready`, `checking` and `advisory`: only a positively-established "cannot run"
 * reading justifies contradicting the panel's own repair route.
 *
 * DIVERGENCE (the design draws one reading): §30's frame is `blocked` + `login`, and its F6 line
 * — `codex is not signed in — nothing runs until it is` — does not generalise to `latched` or
 * `missing`. Those two keep the panel's ordinary F6 wording (which is still TRUE: F6 does not
 * send) and rely on {@link AgentDeadNotice.line}, which composes from the badge phrase the design
 * itself authored plus §30's own tail, so nothing is invented.
 */
export function agentDeadNotice(health: AgentHealth): AgentDeadNotice | null {
  if (health.kind !== "blocked" && health.kind !== "missing") return null;
  // Built FROM the badge so the panel line and the badge can never disagree about how this
  // reading is named.
  const badge = agentHealthBadge(health, false);
  if (badge === null) return null; // unreachable: neither kind above maps to a null badge
  const line = `${badge.text} — F6 fills the composer, but nothing runs yet`;
  if (health.kind === "blocked" && health.panel === "login") {
    return { f6Detail: `${health.agent} is not signed in — nothing runs until it is`, line };
  }
  return { f6Detail: null, line };
}
```

- [ ] **Step 4: Take the notice in `HostCrashPanel`**

`src/ui/preview/ui/HostCrashPanel.tsx` — the panel must not import from `ui/workspace`, so declare the shape it needs locally and let structural typing connect them:

```ts
/** The dead-agent correction (`ui/workspace/model/health-badge.ts`'s `AgentDeadNotice`), taken
 *  structurally so `ui/preview` does not import `ui/workspace`. */
export interface HostCrashAgentNotice {
  readonly f6Detail: string | null;
  readonly line: string;
}

// …and one new field on the existing HostCrashPanelProps, after `retryAvailable`:
  /**
   * The agent-health correction, or `null` when the agent can actually run the repair (design 30,
   * "The collision"). `null` renders this panel byte-identically to every frame drawn before that
   * iteration.
   */
  readonly agentDead: HostCrashAgentNotice | null;
```

Required, not optional: the one call site must decide, and a silently-omitted `undefined` would quietly re-hide the very promise this task exists to correct.

The F6 row:

```tsx
        <KeyRow
          id={`${props.id}-f6`}
          hotkey="F6"
          label="repair…"
          note="write the failure into the composer"
          // design 30: F6's own promise to run is the one line that would otherwise be false.
          detail={props.agentDead?.f6Detail ?? "nothing is sent — you press ⏎"}
          keyFg={SHELL_PALETTE.amber}
          labelFg={SHELL_PALETTE.amberHi}
          noteFg={SHELL_PALETTE.dim}
          bold
        />
        {props.agentDead !== null && (
          <>
            {/* design 30: a blank row, then the correction, rather than letting the composer
                quietly swallow an ⏎ that goes nowhere. */}
            <text id={`${props.id}-agent-dead-spacer`}> </text>
            <text id={`${props.id}-agent-dead`} fg={SHELL_PALETTE.red}>
              {props.agentDead.line}
            </text>
          </>
        )}
```

Export the new interface from `src/ui/preview/index.ts` beside `HostCrashPanelProps`.

- [ ] **Step 5: Pass it from the Workspace**

In `Workspace.tsx`, compute it once beside `healthBadge` and thread it through `renderPreviewRegion`'s `interaction`-style parameter list:

```ts
  const agentDead = agentDeadNotice(local.agentHealth());
```

```ts
function renderPreviewRegion(
  preview: PreviewMirror,
  uiFrame: UiPreviewFrame | null,
  hasPages: boolean,
  opening: boolean,
  agentDead: AgentDeadNotice | null,
  region: CellSize,
  interaction: Readonly<{ /* unchanged — the existing inline type */ }>,
) {
```

```tsx
        <HostCrashPanel
          id="ws-preview-crash"
          width={region.w}
          height={region.h}
          pageSlug={preview.pageSlug}
          hostMessage={preview.finalFailure.safeMessage}
          attempts={preview.attempts}
          retryAvailable={preview.retryAvailable}
          agentDead={agentDead}
        />
```

`HostUnavailablePanel` is deliberately untouched: `wsHostUnavailable` names no repair key at all, so it makes no promise to correct.

- [ ] **Step 6: Run the tests to verify they pass**

```bash
rtk bun test src/ui/workspace src/ui/preview
rtk bun x tsc --noEmit
```

Expected: PASS.

- [ ] **Step 7: Lint, format, commit**

```bash
rtk bun x oxlint
rtk bun x oxfmt
rtk git add src/ui/workspace src/ui/preview
rtk git commit -F <message-file>
```

```
fix(ui): stop the halted-preview panel promising a repair the agent cannot run

A crashed preview's repair path is F6, then a turn, then the agent. Now that
the agent's health is visible in the same bar, the two can be seen to
collide: the halt keeps the hint slot, being the more urgent and more
specific fact, while F6's own line still promised a turn that a dead agent
cannot run. The panel says so instead of letting the composer quietly
swallow an enter that goes nowhere. A healthy agent renders the panel
exactly as before.
```

---

### Task 8: Update the architecture docs

`docs/architecture/flows/launch.md` needs real edits, not a touch-up. It currently describes the routing this plan replaced.

**Files:**
- Modify: `docs/architecture/flows/launch.md`, `docs/architecture/modules.md`, `docs/architecture/code-structure.md`

**Interfaces:**
- Consumes: everything Tasks 1–7 produced.
- Produces: docs that match the code.

- [ ] **Step 1: Load the architecture-update skill**

Use `architecture:architecture-update`. It knows this repository's conventions for `Source anchors` and for keeping diagrams honest.

- [ ] **Step 2: Fix the first mermaid diagram in `flows/launch.md`**

`launch.md:5-9`: the `findq -- "present" --> lockq` path no longer ends at Home. Redraw so a present `.termcraft/` reaches the Workspace shell immediately and the lock/recovery/format steps fill it, with the blocked-open edge dropping back to Home. The spec's own state diagram (`docs/superpowers/specs/2026-08-02-workspace-first-launch-design.md`, "Screen routing") is the shape to transcribe.

- [ ] **Step 3: Rewrite the Gap D section (`launch.md:52-102`)**

It describes `hasContent` as the routing predicate. Replace with: `existing` is the predicate for BOTH the startup dispatch and `deriveScreen`; `hasContent` is still computed and no longer read; the `existing && !hasContent → Home` branch is gone; the Workspace mounts before the Kernel publishes anything and fills in one jump at `finishOpen`; a blocked open or a startup dispatch that never reached the Kernel falls back to Home.

State the consequence plainly, as the spec does: the ~30 s wait does not shrink. What changes is that the user waits on the right screen, watching the one check that is genuinely running.

- [ ] **Step 4: Rewrite walkthrough steps 6, 7, 9 and 11**

- **Step 6** (`launch.md:171`) describes Home as the ordinary landing screen. Narrow it to its two remaining situations: a genuinely fresh directory, and a startup open that failed.
- **Step 7** (`:172-187`) describes the create/open choice as if both were reached from Home. `project.open` from Home is now only the ⏎ retry after a failed startup open.
- **Step 9** (`:190`) says the health check "surfaces the problem in the status bar; on Home's error state, `r` re-runs the check in place". Add: in the Workspace the reading is a badge in the `hint` slot, below read-only, turn-running and preview-halt; `checking` is rendered there too; and there is NO re-check — the probe runs once at startup and the badge can be stale for the life of the process. Record that staleness as a deliberate trade, not an oversight.
- **Step 11** (`:195`) describes an open that cannot finish. Add the two fallbacks: `blockOpen` drops the mounted Workspace back to Home with its failure panel, and a startup dispatch that fails or is rejected calls `abandonStartupOpen`, which does the same.

- [ ] **Step 5: Update the source anchors**

In `launch.md`'s `## Source anchors`:
- `src/entrypoint/model/run-app.ts` (`:219`) — the predicate is `shell.launch.existing`; both failure branches call `root.abandonStartupOpen()`.
- `src/entrypoint/model/create-shell.ts` (`:218`) — `hasContent` is still computed but no longer routes.
- `src/ui/app/model/deps.ts` (`:249`) — add `local.startupOpenPending`, `abandonStartupOpen`, and the renamed `local.agentHealth` / `refreshAgentHealth`.
- `src/ui/app/model/intent.ts` (`:248`) — Home submit's `project.open` branch now serves only the post-failure retry.
- Add `src/ui/mirror/model/screen.ts` — `deriveScreen`'s opening branch.
- Add `src/ui/app/model/root.tsx` — `UiRootHandle.abandonStartupOpen`.
- Add `src/ui/workspace/ui/Workspace.tsx` and `src/ui/workspace/model/health-badge.ts` — the opening chrome and the badge.
- Add `src/ui/agent-health/types.ts`.
- Add `design/30-workspace-first-launch.dc.html` as the design anchor.

- [ ] **Step 6: Add `ui/agent-health` to `modules.md` and `code-structure.md`**

One row/entry each, in the same shape the neighbouring `ui/*` modules use: a leaf type module with no logic, consumed by `ui/home`, `ui/workspace`, `ui/app` and `entrypoint`.

- [ ] **Step 7: Verify and commit**

```bash
rtk bun test src/ui src/entrypoint
rtk bun x oxlint
rtk git add docs/architecture
rtk git commit -F <message-file>
```

```
docs(architecture): describe the workspace-first launch

flows/launch.md still routed a present .termcraft/ to Home and named
hasContent as the predicate. Both are now false: existing is the predicate
for the startup dispatch and for deriveScreen alike, and an existing project
mounts the Workspace before the Kernel has published anything. Walkthrough
steps 6, 7, 9 and 11 and the source anchors follow. modules.md and
code-structure.md gain ui/agent-health.
```

---

## Verification before reporting done

- [ ] `rtk bun test src` — full suite green, no fewer tests than Task 1 Step 1's baseline.
- [ ] `rtk bun x tsc --noEmit` — clean.
- [ ] `rtk bun x oxlint` — clean.
- [ ] `rtk bun x oxfmt --check` — clean.
- [ ] `/reatom-audit` — clean over everything this branch changed.
- [ ] Run the app in a directory that already has `.termcraft/` and confirm by eye: the Workspace shell appears immediately, the status bar reads `opening project…` with `OPENING` and a `⠹ checking …` badge, `⏎ send` is faint, and the whole thing fills in one jump when the open finishes. Use the `run` skill.
- [ ] Run it in an empty directory and confirm Home is unchanged.

## Known limitations to state, not hide

Report these with the work rather than letting them be rediscovered:

1. **The ~30 s wait does not shrink.** `runProjectReadySequence` is deliberately out of scope: publishing `finishOpen` early, or gating the active page ahead of the rest, would weaken the "descriptors are complete and ordered at `ready`" invariant the capability guards rely on. That belongs in its own spec.
2. **The health badge is never refreshed.** If the user signs in to the agent CLI in another terminal, the badge stays red until termcraft restarts. A `/recheck` slash action (~30 lines, reusing `refreshAgentHealth`) was considered and declined. The design's own §30 prose states the same thing.
3. **A dead agent does not disable ⏎ in the Workspace.** The badge states the fact and the user decides; gating on `checking` alone would lock the composer for up to 20 s at every launch.
4. **The dropped combo chip** (Divergences §1) — the opening bar has no agent/model segment, because there is no honest source for one while the project opens.
5. **§30 draws the halted-preview collision for one health reading only** (Divergences §3) — `blocked/latched` and `missing` get the generic corrective line but keep F6's ordinary detail.
