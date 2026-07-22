# MVP Phase 7 — `ui/` (OpenTUI shell) — master index

> **For agentic workers:** This is a master index in the shape phase 2/phase 6
> used, not a fully granular task list. Each slice below is executed with TDD
> (superpowers:executing-plans / subagent-driven-development), every file paired
> 1:1 with a `*.test.tsx`/`*.test.ts` as the rest of the repo is, and every slice
> ends green: `bun test` + `bun x tsc --noEmit` exit 0, `bun test` returns to the
> shell (no hang).

Date: 2026-07-22
Branch: `phase-7-ui` (base: `525ed6b`, the phase-6-core merge). Current working tree.
Status: complete — repository gate green at 2559 tests across 265 files.

**Goal:** Ship the termcraft MVP UI — the OpenTUI shell that renders Home,
Workspace (chat + preview + pins/selection), the action table / slash menu, the
ephemeral agent status block, composer, chats popup, trust prompt, and the
edge/error/enlarge states — driven entirely through the Kernel command/event
boundary, per ROADMAP §Phase 7 and design spec §3.x/§9.

**Architecture:** `ui/` is a **leaf presentation module**. It imports only
`core`'s boundary types (Command/Result/Event DTOs) and the `PreviewSession`
facade — never `store`, `host`, `agent`, `gate`, or `runtime`. It declares a
narrow `KernelPort` it depends on; the phase-8 composition root satisfies it, and
tests satisfy it with an in-module `FakeKernel`. UI keeps its **own** Reatom graph
(the "mirror"), seeded by the `kernel.snapshot` event and advanced by subsequent
`EventEnvelopeV1`s — it never imports Kernel atoms (design §3.2/§3.3, two graphs).

**Tech Stack:** `@opentui/react` 0.4.5 intrinsics (`<box>/<text>/<input>/…`),
`reatomComponent` from `@reatom/react@1001`, `@reatom/core@1001` atoms/actions,
`errore` at any fallible boundary, `zod` only where a DTO is re-validated (it is
not — the Kernel owns validation). Component tests use the existing headless
render harness; App integration uses the canonical React/OpenTUI adapter in
`src/ui/testing/model/react-renderer.ts`, which centralizes `testRender`, React
`act`, and bounded `waitForFrame` scheduling.

---

## Global Constraints (inherited from ROADMAP §"Global constraints")

- **Bun** `>=1.3.14`; `bun test`; `bun x tsc --noEmit` (TS 7.0.2). Baseline to
  hold from the first commit: `tsc --noEmit` exit 0, whole suite green.
- **errore** mandatory at fallible boundaries: namespace import, `Error | T`
  unions, `createTaggedError`, `.catch()`/`errore.try` only at boundaries, flat
  control flow, `| null` optionals, one-line `instanceof Error` returns. Pure
  presentational code (like `runtime/ui`) needs no errore; the `KernelPort`
  adapter seam and any async frame consumption do.
- **Reatom v1001**: every atom/computed/action **named** (second trace-string
  arg); `wrap(...)` at every async boundary; `withComputed` for dependent
  writable state, never `useEffect` sync; direct `atom.set`, no identity setters;
  `reatomComponent(() => jsx, "trace.Name")` with a mandatory trace name;
  read atoms lazily after early-return guards; long-lived subscriptions owned by
  a lifetime (connection hook / explicit dispose), never a bare module `effect`.
- **Module DAG** (`code-structure.md` items 10/11): `ui` imports `core` boundary
  types + `PreviewSession` and **nothing else** from any module. Forbidden:
  `ui` importing `store`/`host`/`gate`/`agent`/Git, or importing `core/mailbox`/
  `core/capabilities`/`core/machines` **internals** — only `core/protocol` DTOs,
  the provisional `EventEnvelopeV1`/`EventCorrelationV1` types (today exported
  from `core/mailbox`'s barrel — see D2), and `core/ports`' `PreviewSession`
  type. Component tests may import `host/render`'s harness; App integration must
  use `ui/testing`'s React/OpenTUI adapter rather than manual renderer ticks.
- **Module folder shape** (`CLAUDE.md`): every `ui/` submodule is
  `ui/<feature>/{ui/,model/,types.ts,index.ts}`; code always inside subfolders,
  never loose at a module root; atomic single-purpose functions. Every catalog/
  screen component takes a typed `Props` with a `readonly id: string`.
- **Design is the source of truth**: all colors/glyphs/labels/segment order taken
  verbatim from `design/termcraft-engine.js` (`pal`) and `design/*.dc.html`.
  Distilled reference: the phase-7 understanding maps (kernel/chrome/flows/
  rendering). Where a design value cannot be reproduced 1:1 in OpenTUI, implement
  the closest faithful mapping and document the divergence in a code comment
  (see §"GAP decisions").
- **Language**: all code/comments/commit messages/docs in English. Commits
  frequent, per unit, `feat:`/`test:`/`docs:` prefixes, Claude co-author trailer.
- **Architecture docs**: this phase lands the `ui/` module → move the `ui/`
  Source anchors in `docs/architecture/` from spec sections to real source files
  and flip the "ui — no code yet" status (slice 7F).

---

## The binding model (locked)

Ground truth from the kernel map: **no composed Kernel object exists** (dispatch
has opaque injected deps, `HandlerRegistry` unimplemented, no `main.ts`). Phase 7
therefore binds to *shapes*, not a running singleton.

### D1 — `KernelPort` (declared by `ui`, injected by phase 8, faked in tests)

```ts
// ui/types.ts
import type { CommandResultV1 } from "core/protocol";
import type { EventEnvelopeV1 } from "core/mailbox"; // provisional home (D2)
import type { CommandDecodeError } from "core/protocol";

export interface KernelPort {
  // raw envelope in; Kernel decodes/validates. UI builds { protocolVersion:1,
  // commandId:UUIDv7, expectedRevision:UInt64String, kind, payload }.
  dispatch(raw: unknown): Promise<CommandDecodeError | CommandResultV1>;
  // first delivery is synchronous kernel.snapshot BEFORE the unsubscribe returns.
  subscribe(handler: (envelope: EventEnvelopeV1) => void): (() => void) | Error;
  // a live PreviewSession the Kernel hands the UI for the active preview.
  preview(): PreviewSessionHandle | null;
}
```

`PreviewSessionHandle` wraps `core/ports`' `PreviewSession` (frames async-iterable
+ `resize/setMode/setTheme/retry/close/query` + `acknowledgeDisplay`). UI never
inspects frame/geometry token internals; it displays frames, acks, and issues
`preview.queryGeometry` / `pin.create` commands with the opaque tokens.

### D2 — event envelope import path

`EventEnvelopeV1`/`EventCorrelationV1` live in `core/mailbox`'s barrel today (the
file flags a future `core/protocol/model/event-envelope.ts`). UI imports them
from `core/mailbox` **as types only** and centralizes the import in exactly one
file (`ui/kernel/model/events.ts`) so the eventual move is a one-line change.
This is the single tolerated `core/mailbox` type import; nothing else in `ui`
touches `core/mailbox`.

### D3 — the mirror (UI-owned Reatom graph)

`ui/mirror/` holds named atoms seeded from `kernel.snapshot` and advanced by a
pure reducer keyed on `envelope.kind`. Atoms (all named `ui.mirror.*`):
`stateRevisionAtom`, `capabilitiesAtom` (Map<CommandKindV1, CapabilityState>),
`projectAtom` ({projectId, activePageSlug, activeChatId, trust}),
`pageDescriptorsAtom`, `turnAtom` (idle | running{turnId,attempt,deadline,steps[],
reasoning[],gateRetry?} | terminal), `previewAtom` (session state + last frame +
failure/circuit), `chatsAtom`, `pinsByPageAtom`, `diagnosticsAtom`,
`exportAtom`, `selectionAtom`. A top-level `screenAtom` computed derives
`home | trust-prompt | workspace | read-only | enlarge` from `projectAtom`,
`trust`, terminal-size, and turn/preview state (see D6 for why this is UI-derived,
not read from the still-placeholder `kernel.snapshot.models`).

### D4 — dispatcher

`ui/kernel/model/dispatcher.ts` `createDispatcher(port, mirror)` exposes
`dispatch(kind, payload)` that mints `commandId` via `infrastructure/uuid`
(`randomUuidV7`), reads `stateRevisionAtom` for `expectedRevision`, builds the raw
envelope, `await wrap(port.dispatch(raw))`, and returns the typed result. All UI
command issuance goes through it — no component builds an envelope by hand.

### D5 — action table (single registry, three views)

`ui/actions/` declares `UiActionEntry[]`:
`{ id, label, hotkey?, slash?: {cmd,desc,order}, capability: CommandKindV1|null,
visibleOn: (screen)=>bool, locallyApplicable: (mirror)=>bool,
build?: (mirror,input)=>{kind,payload} }`. Derived views: the keyboard resolver
(hotkey→entry), the status-bar hint row, the slash menu. Per row:
`enabled = visible && locallyApplicable && capabilityAvailable(id)`;
`hint = localReason ?? primaryReason(capabilityReasons(id))`. Deferred Tier-C
kinds render **dimmed, never hidden** (§10.3/§13.5). `capability:null` actions
(menu open/close, focus move) never consult the Kernel.

### D6 — screen selection is UI-derived until the typed snapshot lands

`kernel.snapshot.models` (7-way machine tags) and `kernel.stateChanged`'s
`action/tags` are still `unknown`/`string` placeholders in the landed event layer
(kernel map GAP 3). Phase 7 derives `screenAtom` from typed signals that DO exist
— `projectId` (null → home), `trust` (`untrusted-read-only` → read-only), the
absence of a project + a pending trust decision surfaced via
`project.setTrust` capability, terminal dimensions vs the app min frame
(80×24) → enlarge, and the domain turn/preview events. Documented in a header
comment on `screenAtom`; when phase 8's typed snapshot lands, the derivation
tightens without changing the screen set. Tests drive the `FakeKernel` with the
real DTO shapes so this stays honest.

---

## GAP decisions (from the understanding maps — decided here, not hidden)

- **Status-bar segment order**: adopt the spec §3.2 canonical order —
  `page/version → size (error-colored below minSize) → mode chip → ctx%` on the
  left cluster, right-aligned key hints. The dead status-bar **combo chip** is
  omitted (model chip lives only on the composer border). Documented in
  `ui/status-bar`'s header.
- **Hint-key filter**: `^E` (export), `m` (model), `/` (slash) are structurally
  excluded from the hint row (spec "deliberately not hinted"), plus the
  drop-trailing-keys-to-fit degrade. Adopted as intentional policy.
- **Frame junctions `┬`/`┴`**: OpenTUI flex siblings can't auto-tee their
  borders. Closest faithful mapping — adjacent bordered boxes sharing the divider
  column; the tee glyphs at the seam are approximated (or drawn as an explicit
  1-col divider `<box>`). Divergence documented on the workspace shell.
- **Focus ordering**: OpenTUI exposes no `tabIndex`. Focus is driven declaratively
  by a `focusTargetAtom` (`composer | preview | popup`) mapped to the React
  `focused` prop, with a global `useKeyboard` handler owning `Tab` cycling and the
  5-layer `Esc` stack (§3.8). Documented on `ui/workspace/model/focus.ts`.
- **Trust prompt**: no design mock exists. Use the spec §3.1 copy
  ("designs in this project are code and will run; trust this folder?") in a
  centered Yes/No prompt box styled like `wizard()`/`migrate()` popups, and reuse
  the `READ-ONLY` vocabulary (amber `READ-ONLY` mode chip, `P.line`-bg hint,
  disabled composer with red attach line) for the declined state. Divergence
  documented on `ui/popups/trust-prompt`.
- **Preview error panel**: generalize the single `wsBrokenSource` mock (red
  headline + file/cause line + faint next-step line + optional restore inset) to
  cover host-crash, broken-source, and Gate-fail origins; the cause line text is
  supplied by the `preview.failed`/`turn.gateRejected` payload. Composer stays
  enabled (repair turn). Documented on `ui/preview/model/error-panel`.
- **Markdown-lite**: implement the `✓/✗/▸/⠹`-glyph one-liner summary format the
  mocks show, plus flattening of bold/italic/inline-code/bullet lists and
  headings→bold, tables/code/links→plain (spec §3.2). Richer content is
  best-effort. Documented on `ui/chat/model/markdown-lite`.
- **Shell theme**: shell chrome renders in dark `pal` only; `ui` defines its own
  `SHELL_PALETTE` constant (exact `pal` hexes) — it does **not** import
  `runtime`'s page tokens. Light `pal` values are recorded for completeness but
  unused by the shell.

---

## Slice plan

Dependency-ordered; pure/foundational first, resource-owning screens last. Every
slice ends green and its own tests are exhaustive over what it introduced.

| Slice | Name | Deps | Key deliverables |
|---|---|---|---|
| 7A | Foundations: port, theme, mirror, dispatcher, FakeKernel | — | `ui/types.ts`, `ui/kernel/`, `ui/theme/`, `ui/mirror/`, `ui/testing/` |
| 7B | Action table + status bar + slash menu | 7A | `ui/actions/`, `ui/status-bar/`, `ui/slash-menu/` |
| 7C | Home screen | 7B | `ui/home/` |
| 7D | Workspace chrome + chat panel + composer + focus/Esc | 7B | `ui/workspace/`, `ui/chat/` |
| 7E | Preview region + pins/selection/mouse + popups | 7D | `ui/preview/`, `ui/popups/` |
| 7F | App root + integration + architecture docs | 7A–7E | `ui/app/`, `ui/index.ts`, docs sweep |

### 7A — Foundations

- `ui/theme/` — `SHELL_PALETTE` (dark `pal`, all 16 tokens verbatim), text-
  attribute helpers (`bold`, `dim`, `faint` → `TextAttributes` mask reused from
  `@opentui/core`), and small style helpers. Tests: token hex equality, mask
  values.
- `ui/kernel/` — `model/events.ts` (the single `EventEnvelopeV1` type re-export
  + a typed `EventOf<K>` narrower), `model/dispatcher.ts` (D4), `types.ts`
  (`KernelPort`, `PreviewSessionHandle`). Tests: dispatcher builds a well-formed
  envelope (protocolVersion 1, UUIDv7 commandId, mirrored revision), maps a
  rejected/accepted result.
- `ui/mirror/` — named atoms (D3) + `model/reduce.ts` pure reducer
  `applyEvent(mirror, envelope)` + `model/seed.ts` from `kernel.snapshot` +
  `model/screen.ts` (`screenAtom`, D6). Tests: seed from a snapshot; each event
  kind the UI consumes advances the right atom(s); revision monotonic; screen
  derivation across home/trust/workspace/read-only/enlarge.
- `ui/testing/` — `FakeKernel` implementing `KernelPort`: a scriptable event
  emitter (push `EventEnvelopeV1`s, incl. the initial snapshot), a recording
  `dispatch` (returns a pre-seeded `CommandResultV1`, records raw envelopes for
  assertions), and a `FakePreviewSession`. This is `ui`-owned test infra (not
  `core/ports/fakes`, which `ui` may not import). Tests: emits snapshot on
  subscribe, records dispatched envelopes.

### 7B — Action table + status bar + slash menu

- `ui/actions/` — the `UiActionEntry` registry for every MVP action (D5), the
  keyboard resolver, and the `enabled/hint` computation reading `capabilitiesAtom`
  + `primaryReason`. Tests: for each action, enabled/dimmed/hidden across
  available/turn-locked/deferred capability states; hotkey resolution; slash
  ordering; deferred Tier-C rows always dimmed.
- `ui/status-bar/` — `StatusBar` reatomComponent: mode chip (all 6 literals),
  page/version segment, size segment (error-colored below minSize), ctx%
  (≥100 cols or caution), right-aligned hint keys (filter + drop-to-fit). Tests:
  segment order + hexes; below-minSize red; ctx caution flip; `^E`/`m`/`/`
  filtered; narrow degrade.
- `ui/slash-menu/` — `SlashMenu` reatomComponent: prefix filter, dimmed disabled
  rows, `▸` selection, anchored-above-composer (non-modal, no dim). Tests: filter
  by `/ch`; turn-locked dims non-commit rows; selection highlight hexes.

### 7C — Home

- `ui/home/` — `Home` reatomComponent (centered logo/tagline/prompt box, inline
  `agent ‹codex› model ‹gpt-5.5› effort ‹high›` display-only combo, agent health
  line, `r` re-check) + the error variant (agent missing, `✗ codex CLI not
  found`, install hint, `r`). Submitting the prompt dispatches `project.create`
  with `{root, creationDefaults, text}`. Tests: idle snapshot (logo/prompt/health
  hexes), error snapshot, `r` re-check action, prompt-submit builds
  `project.create`.

### 7D — Workspace chrome + chat + composer + focus

- `ui/workspace/` — `Workspace` shell: chat box (~37%, `round(w*0.37)`), preview
  box, divider/junctions (closest-faithful), tab strip (`drawTabs` semantics:
  `▸` active amber-bold, dim inactive, ghost, `‹›` overflow), status bar mount,
  F2 fullscreen (hide chat, keep tabs+bar), `model/focus.ts` (`focusTargetAtom`,
  Tab cycle, 5-layer Esc). Tests: layout proportions + border hexes; tab states;
  focus border/title swap (`❯` prefix drop when unfocused); Esc layer order;
  fullscreen hides chat.
- `ui/chat/` — chat header (`● codex` green + meta), message stream:
  `model/markdown-lite.ts` (collapsed records, `P.dim`), the ephemeral agent
  status block (`⠹` spinner, `✓` green done steps, `▸` current, faint reasoning
  ticker, `✗ … retry n/3` gate line, `⟲ … cancelled/failed` system lines), pins
  section, composer + ctx (model chip on border, ctx% with caution flip,
  placeholder swaps for idle/generating/disabled). Tests: markdown-lite flatten
  units; ephemeral block snapshot (fed via FakeKernel `turn.progress` events);
  composer states; ctx caution.

### 7E — Preview + pins/selection/mouse + popups

- `ui/preview/` — `Preview`: composite the current `PreviewFrameV1` rows into
  styled `<text>`/`<span>` runs; overlays (`position:absolute`) for open-pin
  badges, selection corner glyphs `⌜⌝⌞⌟`, hover name label; empty state
  (`No pages yet — describe what to build`); `model/error-panel.ts` (generalized
  broken-source/host-crash/Gate panel + restore inset); enlarge placeholder
  (`⚠ terminal too small` full takeover); the geometry-query→pin flow
  (ack frame, `preview.queryGeometry`, `pin.create` with the returned geometry
  token). Tests: frame row compositing; overlays at anchors; empty/error/enlarge
  snapshots; pin-create dispatch carries the opaque geometry token.
- `ui/popups/` — chat-list popup (`/chats`, dimmed backdrop, selection, footer
  hints, `/new`), pin-input popup (dimmed backdrop + non-dimmed input box +
  badge), export-feedback popup (paths, success line), trust-prompt (Yes/No +
  declined read-only, per GAP decision). Tests: each popup snapshot; `/chats`
  switch dispatch; trust grant/decline dispatch (`project.setTrust`); pin-input
  save dispatch.

### 7F — App root + integration + docs

- `ui/app/` — `App` root: subscribe to `port` on mount (own the unsubscribe
  lifetime), feed the mirror reducer, mount the screen selected by `screenAtom`
  (home/trust/workspace/read-only/enlarge), install the global keyboard handler
  (action resolver + Esc stack). `ui/index.ts` — public surface (`App`,
  `KernelPort`, `PreviewSessionHandle`, `createUiRoot(options)` mount helper).
- Integration test: a scripted `FakeKernel` walk — snapshot(home) → `project.create`
  → snapshot/events(workspace) → `turn.start` → `turn.progress`×N →
  `turn.completed` → assert the rendered frames at each step through the canonical
  React/OpenTUI test adapter.
- Architecture docs sweep: flip `docs/architecture/modules.md` "ui — no code yet",
  move `code-structure.md`/`overview.md` `ui` Source anchors to real files, update
  the mermaid status; note the documented divergences (junctions, focus, trust,
  error panel, markdown-lite).

---

## Cross-slice interface registry (names fixed here)

| Name | Declared in | Consumed by |
|---|---|---|
| `KernelPort`, `PreviewSessionHandle` | 7A `ui/types.ts` | app, all screens, phase-8 root |
| `EventEnvelopeV1` re-export, `EventOf<K>` | 7A `ui/kernel/model/events.ts` | mirror, all screens |
| `createDispatcher`, `Dispatcher` | 7A `ui/kernel/model/dispatcher.ts` | all screens |
| mirror atoms + `applyEvent` + `screenAtom` | 7A `ui/mirror/` | actions, all screens, app |
| `FakeKernel`, `FakePreviewSession` | 7A `ui/testing/` | every test |
| `SHELL_PALETTE`, attr helpers | 7A `ui/theme/` | every component |
| `UiActionEntry`, `resolveHotkey`, `actionEnabled`, `actionHint` | 7B `ui/actions/` | status bar, slash menu, app |
| `StatusBar` | 7B `ui/status-bar/` | workspace, home |
| `SlashMenu` | 7B `ui/slash-menu/` | workspace |
| `Home` | 7C `ui/home/` | app |
| `Workspace`, `focusTargetAtom`, `escStack` | 7D `ui/workspace/` | app |
| `ChatPanel`, `Composer`, `markdownLite` | 7D `ui/chat/` | workspace |
| `Preview`, `errorPanel` | 7E `ui/preview/` | workspace |
| popups (`ChatListPopup`, `PinInputPopup`, `ExportPopup`, `TrustPrompt`) | 7E `ui/popups/` | app, workspace |
| `App`, `createUiRoot` | 7F `ui/app/`, `ui/index.ts` | phase-8 root |

## Completion status (2026-07-22)

Phase 7 is complete. The repository suite passes 2559 tests across 265 files. The
public root and interaction anchors handed to phase 8 are:

- `src/ui/index.ts` — the leaf module surface, including `App`, `createUiDeps`,
  `createUiRoot`, `KernelPort`, and the root option/handle types.
- `src/ui/app/model/root.tsx` — the injectable, disposable OpenTUI root boundary;
  production composition supplies its real `KernelPort` in phase 8.
- `src/ui/app/ui/App.tsx`, `src/ui/app/model/keymap.ts`, and
  `src/ui/app/model/intent.ts` — screen composition and keyboard-to-command flow.
- `src/ui/preview/model/interaction.ts` — displayed-frame acknowledgement,
  geometry-query ownership, and opaque geometry-token pin flow.
- `src/ui/app/ui/App.test.tsx` — the complete `FakeKernel` DTO walk covering Home,
  Workspace, turn progress/completion collapse, slash chat create/switch, frame
  acknowledgement, geometry, pin creation, and trust decline/read-only.

`src/main.tsx` and all production dependency composition remain phase-8 work.
`docs/superpowers/specs/2026-07-22-application-entrypoints-design.md` is the
authority for that entrypoint work; phase 7 does not pre-compose or bypass it.

## Out of scope (ROADMAP MVP exclusions, mirrored here)

Codex backend UI, `/model` picker popup (inline display-only combo only), Git
history/Restore/`/commit-*` (dimmed rows only), interactive input forwarding
(`F4` inert), Tweaks panel (`F3` inert), `Ctrl+P` preview controls, light-theme
shell, first-run wizard, chat rename/delete/AI titles, keyboard element
selection. Tier-C command kinds render as dimmed action rows and are never
reachable.
