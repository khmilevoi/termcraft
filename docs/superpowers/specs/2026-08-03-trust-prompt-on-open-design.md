# Trust prompt on `project.open` — design

## Problem

Opening an existing project whose `.termcraft/` has never been granted trust on
this exact machine+path (per the storage-identity §8 trust-subject key: canonical
path + filesystem identity + `projectId`) silently lands the Workspace in
`untrusted-read-only` mode. `preview.selectPage` is then refused with
`PROJECT_UNTRUSTED` forever, and `Workspace.tsx`'s preview pane has no branch for
"preview is disabled" — it falls through to the generic `preparing preview…` text,
which never resolves. The only visible signal is a small `READ-ONLY` chip in the
status bar.

Root cause, confirmed against a real run's `termcraft-debug/run-*.jsonl` trace: a
project opened from a git worktree copy of `examples/clock` (a physically
different directory than the originally-trusted checkout) resolved trust to
`untrusted-read-only` and every `preview.selectPage` was rejected
`PROJECT_UNTRUSTED`. The user tried `/` looking for a command to fix it; the
slash menu is disabled on the `read-only` screen.

This is not a deliberate MVP cut. The original spec
(`docs/superpowers/specs/2026-07-13-termcraft-design.md`, §3.1, restated in §8.2's
MVP-cut list) requires exactly this: *"a `.termcraft/` this machine has not
trusted yet ... shows a trust prompt — 'designs in this project are code and will
run; trust this folder?' — before anything renders."* The popup itself
(`src/ui/popups/ui/TrustPrompt.tsx`) and the full `trust-accept`/`trust-decline` →
`project.setTrust` path (`ui/app/model/keymap.ts`, `ui/app/model/intent.ts`)
already exist and work — nothing in the Kernel needs to change
(`project.setTrust` is already legal from `untrusted-read-only`,
`core/capabilities/model/guards.ts`). The gap is purely that
`ui/mirror/model/screen.ts`'s `deriveScreen` never routes to the existing
`"trust-prompt"` screen for the `project.open` path: `resolveTrust`'s `"open"`
branch (`core/kernel/model/handlers/project.ts`) always resolves synchronously to
a terminal `"trusted"`/`"untrusted-read-only"` value before publishing, so the
mirror's `trust` field is never observably `null` for this path — the one value
`deriveScreen` currently maps to `"trust-prompt"`.

## Decisions (confirmed with the user)

- The prompt shows **automatically**, the first time a `project.open` resolves to
  `untrusted-read-only`, matching spec §3.1's "before anything renders."
- Declining (`Esc`) is a **session-scoped** decision only. There is no in-app way
  to re-open the prompt or grant trust later in the same run; the only way to see
  it again is relaunching termcraft (`project.open` re-resolves trust fresh, and
  the new UI-local dismissal flag starts `false` again on every process start).
  A later `/trust`-style re-ask affordance is out of scope for this fix.

## Design

### 1. Screen routing

`src/ui/mirror/types.ts` — no change (`ScreenKind` already has both
`"trust-prompt"` and `"read-only"`).

`src/ui/mirror/model/screen.ts`:

- `ScreenInput` gains a new field:
  ```ts
  readonly trustPromptDismissed: boolean;
  ```
- `deriveScreen`'s trust branch changes from:
  ```ts
  if (input.trust === "untrusted-read-only") return "read-only";
  if (input.trust === null) return "trust-prompt";
  ```
  to:
  ```ts
  if (input.trust === "untrusted-read-only") {
    return input.trustPromptDismissed ? "read-only" : "trust-prompt";
  }
  if (input.trust === null) return "trust-prompt";
  ```
  The `trust === null` branch (the brief pre-`ready` opening/recovering window,
  per this function's existing "APPROXIMATION" doc comment) is unchanged.
- `createScreenAtom`'s `deps` gains `trustPromptDismissed: () => boolean`, read
  inside the returned `computed` and passed through to `deriveScreen`.

### 2. UI-local state

`src/ui/app/model/deps.ts`:

- `UiLocalState` gains:
  ```ts
  /**
   * Whether the auto-shown trust prompt (spec §3.1) has been answered this
   * session — set by `trust-accept`/`trust-decline` (`ui/app/model/intent.ts`).
   * Starts `false` on every process launch, and only ever goes `false -> true`:
   * the only way to see the prompt again is relaunching termcraft, which
   * re-resolves trust from a fresh `project.open` and rebuilds this atom fresh
   * (confirmed with the user — no in-session re-ask affordance).
   */
  readonly trustPromptDismissed: Atom<boolean>;
  ```
  A plain atom (`atom(false, "ui.local.trustPromptDismissed")`), same shape as
  the other simple UI-local flags in this file (e.g. `fullscreen`). No
  `withComputed` derivation: nothing should flip it back to `false` mid-process.
- `createUiDeps` constructs it and passes it into the existing
  `createScreenAtom({...})` call as `trustPromptDismissed: () => trustPromptDismissed()`.

### 3. Intent handling

`src/ui/app/model/intent.ts` — both existing branches gain one line:

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

No `wrap`/`bind` needed — both are plain synchronous `.set()` calls inside the
same handler frame as the dispatch call, exactly like every other case arm in
this switch.

### 4. Preview-pane messaging

`src/ui/workspace/ui/Workspace.tsx`:

- `renderPreviewRegion` gains a `readOnly: boolean` parameter (its call site at
  line ~825 passes `props.readOnly`, threaded the same way `filling` and
  `agentBlocked` already are).
- A new branch, placed after the `!hasPages`/live-frame checks and before the
  final `preparing preview…` fallback:
  ```tsx
  if (readOnly) {
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
  ```
  Styled after the existing `filling` branch immediately above it in the same
  function (amber headline, one blank spacer row, faint detail line, no
  spinner — nothing is pending here, so nothing should look like it is loading).
  **Divergence, documented inline as a comment**: no `design/*.dc.html` mock
  covers this exact copy, matching the precedent `TrustPrompt.tsx` already set
  for undesigned trust-related states — colors and layout are reused from
  already-approved elements, no new hue or glyph is invented.

### Net effect

- A never-before-trusted existing project now shows the popup itself, the very
  first frame the Workspace could paint it on — no more silent, unexplained
  `preparing preview…`.
- Accept → `project.setTrust: trusted` durably grants trust (already
  implemented in `core/kernel/model/handlers/project.ts`'s `projectSetTrust`) →
  `enablePreviewIfTrusted` flips the preview machine `disabled -> idle` →
  the existing page-request subscriber (`ui/app/model/deps.ts`) issues
  `preview.selectPage`, which now succeeds → the real frame arrives.
- Decline → `read-only` for the rest of this run, now with an explicit preview
  message instead of a misleading one.
- No Kernel, protocol, or capability-guard changes. Everything is UI-side:
  one new field threaded through screen derivation, one new local atom, two
  one-line additions to existing intent handlers, and one new render branch.

## Test plan

- `ui/mirror/model/screen.test.ts`: new cases —
  `trust: "untrusted-read-only", trustPromptDismissed: false` → `"trust-prompt"`;
  same with `trustPromptDismissed: true` → `"read-only"`. Existing
  `trust === null` and `trust === "trusted"` cases stay green untouched.
- `ui/app/model/deps.test.ts`: `trust-accept`/`trust-decline` (via `applyIntent`
  or a direct `createUiDeps` harness) flip `local.trustPromptDismissed()` to
  `true`, and the exposed `screen` atom reflects the transition end to end
  (`"trust-prompt"` -> accept -> `"workspace"`; `"trust-prompt"` -> decline ->
  `"read-only"`).
- `ui/app/model/intent.test.ts`: unit-level coverage of the two case arms
  setting the new atom, independent of the screen wiring.
- `ui/workspace/ui/Workspace.test.tsx`: new case — `readOnly=true`, at least one
  page descriptor, no live frame — renders `ws-preview-read-only` and does
  **not** render `preparing preview…` (the existing "not stuck forever" test at
  line ~924 already asserts the negative half of this for a different scenario;
  add the read-only-specific positive assertion alongside it).
- No new integration/smoke-test coverage is required for this fix: the existing
  `entrypoint/model/smoke.test.ts` fakes the host/preview side entirely and does
  not model the trust ledger's filesystem-identity matching, so it cannot
  exercise this path either before or after the fix. The unit-level coverage
  above pins the screen-derivation and messaging logic directly.
