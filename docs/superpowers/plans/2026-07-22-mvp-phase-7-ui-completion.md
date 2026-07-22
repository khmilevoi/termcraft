# MVP Phase 7 UI Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining gaps between the landed `src/ui/` code and the binding phase-7 master plan: a disposable OpenTUI mount, one action-driven keyboard/slash path, functional trust/chat/pin interactions, read-only presentation, and the frame-token to geometry-token pin chain.

**Architecture:** `ui/` stays a leaf. `createUiRoot` owns only OpenTUI/React lifetime; `createUiDeps` owns the UI Reatom graph and the injected `KernelPort` subscription. Kernel commands still cross only through `Dispatcher`, while geometry results return through `EventEnvelopeV1` and update UI-local pending interaction atoms before the mirror reducer sees the same event.

**Tech Stack:** Bun 1.3.14, TypeScript 7.0.2, `@opentui/core`/`@opentui/react` 0.4.5, Reatom v1001, `errore` 0.14.

## Global Constraints

- Keep `ui` imports limited to OpenTUI, Reatom, `errore`, `core` boundary types, `entities` DTO types, and `infrastructure/uuid`; never import store, host, gate, or agent implementations.
- Name every Reatom atom/action/computed, keep long-lived work in `withConnectHook`, and wrap async continuations that touch atoms.
- Convert external throws/rejections to tagged error values at their lowest boundary; log an error when it cannot be propagated.
- Preserve the exact dark-shell palette and copy/glyphs from `design/termcraft-engine.js`; no new visual tokens.
- Production `main.ts`, `_host`, export CLI, and compiled binaries remain phase 8 per `2026-07-17-termcraft-mvp-roadmap.md`.
- Each task follows RED -> GREEN -> focused typecheck, then the final task runs the whole repository gate.

---

### Task 1: Disposable UI runtime and displayed-frame boundary

**Files:**
- Modify: `src/ui/kernel/types.ts`
- Modify: `src/ui/testing/model/fake-preview.ts`
- Modify: `src/ui/app/model/deps.ts`
- Create: `src/ui/app/model/deps.test.ts`
- Create: `src/ui/app/model/root.tsx`
- Create: `src/ui/app/model/root.test.tsx`
- Modify: `src/ui/app/index.ts`
- Modify: `src/ui/index.ts`

**Interfaces:**
- Produces: `UiPreviewFrame = { frame: PreviewFrameV1; frameToken: FrameTokenV1; handle: PreviewSessionHandle }`.
- Produces: `PreviewSessionHandle.frames: AsyncIterable<UiPreviewFrame>`; phase 8 adapts Kernel `publishFrame()` output into this stream.
- Produces: `createUiRoot(options): Promise<UiRootError | UiRootHandle>`, where `UiRootHandle.dispose()` is idempotent and unmounts React before destroying the renderer.
- Preserves: `createUiDeps(port, initialSize, env)` for all existing callers.

- [x] **Step 1: Write failing displayed-frame and lifetime tests**

Add tests which prove the fake emits the whole `{ frame, frameToken, handle }` bundle, a successful subscription is removed when the runtime atom disconnects, a subscription error is retained in `runtimeError`, and a frame-stream rejection becomes a tagged `UiPreviewStreamError` rather than an unhandled rejection.

```ts
const preview = createFakePreviewSession()
preview.pushFrame(frame)
const next = await preview.handle.frames[Symbol.asyncIterator]().next()
expect(next.value?.frameToken).toBe(preview.frameTokenFor(frame))
expect(next.value?.frame).toBe(frame)
```

- [x] **Step 2: Run the focused tests and verify RED**

Run: `bun test src/ui/testing/model/fake-preview.test.ts src/ui/app/model/deps.test.ts src/ui/app/model/root.test.tsx`

Expected: failures for the absent bundled frame stream, runtime error atom, and root factory.

- [x] **Step 3: Implement the token-bearing stream and safe runtime**

Move frame consumption from `handle.session.frames` to `handle.frames`. In `createUiDeps`, define these named atoms before the connect hook:

```ts
const previewFrame = atom<UiPreviewFrame | null>(null, "ui.app.previewFrame")
const runtimeError = atom<Error | null>(null, "ui.app.runtimeError")
```

Handle `port.subscribe(...) instanceof Error` immediately. Wrap the polling delay and every atom write after an async boundary. Map an iterator rejection to:

```ts
export class UiPreviewStreamError extends errore.createTaggedError({
  name: "UiPreviewStreamError",
  message: "UI preview stream failed",
}) {}
```

Store the error and `console.error` it because the connection hook cannot return an error value to a caller.

- [x] **Step 4: Implement and test `createUiRoot`**

Use injected adapters in tests and these production defaults:

```ts
const renderer = await createCliRenderer({ exitOnCtrlC: false }).catch(
  (cause) => new UiRootError({ operation: "create renderer", cause }),
)
if (renderer instanceof Error) return renderer
const root = createRoot(renderer)
root.render(<App deps={createUiDeps(options.port, { w: renderer.width, h: renderer.height }, options.env)} />)
```

`dispose()` calls `root.unmount()` once and then `renderer.destroy()` once. A sync mount failure is converted with `errore.try`, destroys the partially acquired renderer, and returns `UiRootError`.

- [x] **Step 5: Run the focused gate**

Run: `bun test src/ui/testing/model/fake-preview.test.ts src/ui/app/model/deps.test.ts src/ui/app/model/root.test.tsx && bun x tsc --noEmit`

Expected: all focused tests pass and TypeScript exits 0.

---

### Task 2: One action path, slash/chat/trust controls, and read-only state

**Files:**
- Modify: `src/ui/actions/types.ts`
- Modify: `src/ui/actions/model/registry.ts`
- Modify: `src/ui/actions/model/registry.test.ts`
- Modify: `src/ui/app/model/deps.ts`
- Modify: `src/ui/app/model/keymap.ts`
- Modify: `src/ui/app/model/keymap.test.ts`
- Modify: `src/ui/app/model/intent.ts`
- Modify: `src/ui/app/model/intent.test.ts`
- Modify: `src/ui/app/ui/App.tsx`
- Modify: `src/ui/app/ui/App.test.tsx`
- Modify: `src/ui/workspace/types.ts`
- Modify: `src/ui/workspace/ui/Workspace.tsx`
- Create: `src/ui/workspace/ui/Workspace.test.tsx`
- Modify: `src/ui/popups/ui/ChatListPopup.tsx`
- Modify: `src/ui/popups/ui/ChatListPopup.test.tsx`

**Interfaces:**
- Produces: one `UI_ACTIONS: readonly UiActionEntry[]`; `SLASH_COMMANDS` and `HOTKEYS` become derived views, not independent registries.
- Produces: local atoms `slashSelection`, `chatSelection`, and `pinDraft`, each named `ui.local.*`.
- Produces: key intents for slash editing/navigation/submit, chat navigation/switch, trust/decline, and popup dismissal.
- Preserves: phase-7 out-of-scope F3/F4/Ctrl+P and `/model`/commit actions as visible but inert/dimmed entries.

- [x] **Step 1: Write failing registry and key-routing tests**

Prove every exported slash/hotkey row originates from `UI_ACTIONS`, `/` opens `slash-menu`, printable characters filter it, arrows move only onto enabled rows, Enter executes the selected row, and Escape closes the menu before any lower Esc layer.

```ts
expect(SLASH_COMMANDS).toEqual(UI_ACTIONS.flatMap((entry) => entry.slash ? [entry.slash] : []))
expect(resolveKey(key({ sequence: "/", name: "/" }), ctx({}))).toEqual({ kind: "slash-open" })
```

- [x] **Step 2: Run focused tests and verify RED**

Run: `bun test src/ui/actions/model/registry.test.ts src/ui/app/model/keymap.test.ts src/ui/app/model/intent.test.ts`

Expected: failures for `UI_ACTIONS` and the new intents.

- [x] **Step 3: Implement the single registry and intent table**

Give each entry an exact local/command execution description:

```ts
type UiActionExecution =
  | { readonly kind: "local"; readonly effect: "fullscreen" | "open-chats" }
  | { readonly kind: "command"; readonly command: "chat.create" | "export.start" }
  | { readonly kind: "inert" }
```

Derive views from `UI_ACTIONS`, resolve global hotkeys through `resolveHotkey`, and keep all command issuance in `applyIntent` through `deps.dispatcher`.

- [x] **Step 4: Implement popup and trust command behavior**

`ChatListRow` gains `chatId`. Enter in the chat popup dispatches `chat.switch({ chatId })`; `/new` dispatches `chat.create({})`; `/export` dispatches `export.start({})`. Trust Enter and trust Escape dispatch exactly:

```ts
{ trust: "trusted", workspaceIdentity: deps.env.workspaceIdentity }
{ trust: "untrusted-read-only", workspaceIdentity: deps.env.workspaceIdentity }
```

Modal popups mount in an absolute, centered overlay layer. Slash menu remains non-modal and anchored above the composer.

- [x] **Step 5: Implement the read-only workspace presentation**

Pass `readOnly` explicitly from `App` to `Workspace`. In read-only state, disable composer input and submit, show the exact `READ-ONLY` mode chip, render `Send · Tweaks · pins disabled`, and use the red attach line/copy from the approved read-only vocabulary. Do not add a new color.

- [x] **Step 6: Run the focused gate**

Run: `bun test src/ui/actions src/ui/app src/ui/popups src/ui/workspace && bun x tsc --noEmit`

Expected: all focused tests pass and TypeScript exits 0.

---

### Task 3: Display acknowledgement, geometry results, pins, selection, and overlays

**Files:**
- Modify: `src/ui/app/model/deps.ts`
- Create: `src/ui/preview/model/interaction.ts`
- Create: `src/ui/preview/model/interaction.test.ts`
- Create: `src/ui/preview/ui/PreviewOverlays.tsx`
- Create: `src/ui/preview/ui/PreviewOverlays.test.tsx`
- Modify: `src/ui/preview/index.ts`
- Modify: `src/ui/preview/ui/FrameView.tsx`
- Modify: `src/ui/preview/ui/FrameView.test.tsx`
- Modify: `src/ui/workspace/types.ts`
- Modify: `src/ui/workspace/ui/Workspace.tsx`
- Modify: `src/ui/app/model/keymap.ts`
- Modify: `src/ui/app/model/intent.ts`
- Modify: `src/ui/app/model/intent.test.ts`
- Modify: `src/ui/app/ui/App.test.tsx`
- Modify: `src/ui/testing/model/fake-preview.ts`

**Interfaces:**
- Produces: `GeometryIntent = hover | select | pin`, stored as one latest pending query with `frameToken`, local coordinates, and purpose.
- Produces: `acknowledgeFrame(deps, uiFrame)`; it calls `handle.acknowledgeDisplay(frameToken)` once after `FrameView`'s `renderAfter` callback and records the displayed token.
- Produces: `requestGeometry(deps, purpose, x, y)`; it dispatches `preview.queryGeometry` only for the currently displayed frame.
- Consumes: `preview.geometryResult` from the subscription; a non-null pin token opens pin input, a selected hit dispatches `selection.set`, and rect/label data updates overlay atoms after structural narrowing.

- [x] **Step 1: Write failing token-chain tests**

Prove no query is sent before display acknowledgement, acknowledgement uses the exact frame token, a pin request dispatches `preview.queryGeometry` with the same token and local coordinates, a matching result opens `pin-input`, and save dispatches only the opaque token plus text:

```ts
expect(command.payload).toEqual({ geometryToken, text: "why is this always on top?" })
expect(command.payload).not.toHaveProperty("pageSlug")
expect(command.payload).not.toHaveProperty("elementId")
```

- [x] **Step 2: Run focused tests and verify RED**

Run: `bun test src/ui/preview/model/interaction.test.ts src/ui/preview/ui/PreviewOverlays.test.tsx src/ui/app/model/intent.test.ts src/ui/app/ui/App.test.tsx`

Expected: failures for absent acknowledgement/query/pin behavior and overlay components.

- [x] **Step 3: Implement the interaction model**

Use named atoms for `displayedFrameToken`, `pendingGeometry`, `pinDraft`, `pendingPin`, `hover`, and `selectionRect`. Keep parsing of the currently placeholder geometry `result` in small type guards that return `null` on any wrong field; never cast unknown payload fields directly.

`requestGeometry` calls:

```ts
void deps.dispatcher.dispatch("preview.queryGeometry", {
  frameToken: displayed.frameToken,
  query: { kind: purpose === "pin" ? "pin-anchor" : "hit", x, y },
})
```

The event handler matches `frameTokenId` and `queryKind` against the pending request before changing local atoms, so a superseded hover result cannot open a stale pin popup.

- [x] **Step 4: Render exact design overlays and mouse bindings**

Render numbered open-pin badges at `pinAnchor(fx, fy, frame rect)`, the `⌜⌝⌞⌟` selection glyphs from `selectionCorners`, and the amber-on-line hover label. Bind `onMouseMove` to hover, left mouse-down to selection, and right mouse-down (`MouseButton.RIGHT`) to pin. Convert absolute mouse cells to frame-local coordinates once in `Workspace` and clamp through the pure interaction helper.

- [x] **Step 5: Run the focused gate**

Run: `bun test src/ui/preview src/ui/app src/ui/workspace src/ui/testing && bun x tsc --noEmit`

Expected: all focused tests pass and TypeScript exits 0.

---

### Task 4: End-to-end phase-7 walk, status docs, and repository gate

**Files:**
- Modify: `src/ui/app/ui/App.test.tsx`
- Modify: `docs/superpowers/plans/2026-07-22-mvp-phase-7-ui.md`
- Modify: `.superpowers/sdd/progress.md`
- Modify if source anchors changed: `docs/architecture/code-structure.md`
- Modify if behavior text changed: `docs/architecture/modules.md`

**Interfaces:**
- Consumes all prior task surfaces without adding another public boundary.
- Produces one scripted integration walk covering home, workspace, turn progress/completion, slash chat switch, trust decline/read-only, displayed-frame acknowledgement, geometry result, and `pin.create`.

- [ ] **Step 1: Extend the integration test and verify it fails before the final wiring**

Drive only real DTO envelopes through `FakeKernel`. Assert visible frame text after each transition and exact recorded command payloads at each user interaction. The final completion sequence must include `turn.completed` and verify that the ephemeral block collapses into a terminal record.

- [ ] **Step 2: Run the app integration test to GREEN**

Run: `bun test src/ui/app/ui/App.test.tsx`

Expected: the complete scripted walk passes and the test process returns normally.

- [ ] **Step 3: Update completion status and architecture wording**

Mark the phase-7 master plan complete with the test count and list the public root/interaction anchors. Append a concise phase-7 completion entry to `.superpowers/sdd/progress.md`. Keep `main.ts` and production composition explicitly in phase 8; the application-entrypoints design remains the phase-8 design authority.

- [ ] **Step 4: Run the full repository gate**

Run, in order:

```text
bun test
bun x tsc --noEmit
bun run lint
bun run fmt:check
git diff --check
```

Expected: 0 failures; all commands exit 0; `bun test` returns to the shell; the worktree contains only the phase-7 completion changes.
