# termcraft — Design Spec

Date: 2026-07-13
Status: approved design, production-hardening revision integrated
Continuation: [`2026-07-16-git-backed-page-history-design.md`](2026-07-16-git-backed-page-history-design.md)
defines the v1 optional-Git history, Restore, and scoped-commit details now
summarized in this document.
Production hardening: [`2026-07-16-production-hardening-decisions-design.md`](2026-07-16-production-hardening-decisions-design.md)
and its linked detailed designs provide the normative transaction, staging,
command-authority, host, storage, runtime, recovery, and scale contracts summarized
here.
Revised: 2026-07-16 — the production-hardened design-runtime pivot. Designs are
real TSX modules with Reatom-first models against `@termcraft/runtime`, not a closed
declarative DSL; the facade's private renderer is OpenTUI/React and termcraft itself is
TypeScript on Bun; the agent edits files directly in a sandboxed staging
directory instead of emitting an operations list. Rationale: a closed element
catalog caps design fidelity and turns every new widget into a termcraft
release, while agent CLIs are at their most reliable editing real code files —
the same bet Claude Design makes for the web.

## 1. Overview

termcraft is a terminal-native analog of Claude Design for TUI applications. The user
describes an interface in natural language; a locally installed CLI agent (Codex first,
Claude Code second) writes real design code against the versioned
`@termcraft/runtime` facade — Reatom-first page models plus supported terminal
components — and termcraft renders it live in the terminal.
Iteration happens through chat; the mouse is used to select elements, pin comments,
and flip state tweaks. The final deliverable is an export package: a prompt file
describing the interface plus the exact design sources, deterministic text
snapshots at several sizes, and resolved layout trees, ready to be fed to a coding
agent that implements the real application.

Core principles:

- **Pure AI generator.** No manual WYSIWYG editing. All changes to design content —
  page components, their structure, styles — go through the agent. The mouse
  annotates and inspects; it never edits the design directly. Project structure (page
  order, titles, removal) is ordinary bookkeeping, manageable from both the UI and
  agent turns — retitling from the UI is the one mechanical code edit termcraft
  itself performs: a literal rewrite of the page's `meta.title` (§3.3).
- **Designs are code, running in a cage.** A page is a TSX module. The facade's
  supported component and low-level primitive surface keeps terminal rendering
  expressive at the price of
  execution: design code runs only inside an isolated design-host subprocess, under
  an import allowlist, behind a workspace-trust gate (§4.2, §5.8, §9).
- **No API keys.** Agents are driven through their locally installed CLIs via the
  vendors' official TypeScript SDKs, inheriting whatever auth the user already has.
- **Local-first storage.** Portable project state and project-local recovery evidence
  live in a `.termcraft/` folder in the directory where termcraft is launched, so
  designs sit next to the code they describe. One `.termcraft/` holds exactly one project — the
  design of this codebase's TUI. Separate tools (e.g. in a monorepo) get their own
  folders; design experiments are git branches. The project folder needs no
  `package.json` or `node_modules`: the runtime and its private Reatom, React, and
  OpenTUI implementation ship embedded in the termcraft binary. The per-user
  `{userStateRoot}` separately owns the machine trust ledger, verified migration and
  repair backups, and per-project turn sandboxes; none can be shipped by the
  repository (§7.1).
- **Data outlives binaries.** Every stored data file carries a format version;
  migrations are part of the architecture from day one. Page sources are code and
  declare a static integer `kitApiVersion` for the public runtime surface (§7.2).

## 2. Non-goals (v1.0)

- Manual drag/resize editing of elements.
- Spatial multi-frame canvases (Figma-style boards). The model is a flat list of pages.
- Implementation code generation for the target stack (ratatui/bubbletea source
  output). The export is a prompt plus design sources, snapshots, and layout trees
  (§3.7); the design is a prototype, not the product.
- Daemon mode and multi-client operation (architecture must allow it later, see §4).
- Real data in prototypes: designs must not fetch, read files, or talk to processes —
  held by the cage's layers (§4.2): the import allowlist (§5.8), the global scrub,
  and the design-code conventions. Simulated data lives in the component.
- Multi-project workspaces: one `.termcraft/` is one project (§3.1); a global user
  config is backlog.
- Watching for external file changes while running; termcraft is the folder's single
  writer (§7.1).
- Keyboard-driven element selection and pin placement; selection and pins are
  mouse-only in v1.0 (§3.2).
- A hard OS security sandbox for design code. Isolation is process-level plus static
  checks plus workspace trust (§4.2); the threat model and its honest limits are
  stated there.

## 3. User flows

UI reference: `design/Termcraft UI.dc.html` (Claude Design source; index over the
per-section `design/NN-*.dc.html` files) — visual source of truth for screens,
states, palette, and status-bar language.

### 3.1 Launch and Home screen

One `.termcraft/` = one project. `termcraft` looks for `.termcraft/` in the current
working directory.

- Missing → the Home screen opens: a large centered prompt input ("Describe the TUI
  you want to design"), focused on entry; `Esc`/`Tab` unfocuses it (focus rules:
  §3.8). Inline selectors under the prompt show the current agent · model · effort
  combo (`/model` (§3.10) or a mouse click opens the picker — v1.0, §3.6; in MVP the
  combo is display-only). Pressing Enter creates
  `.termcraft/` with default config and a project manifest with zero pages, writes
  the first `user` record to the project's first UUIDv7-named chat (§3.9), opens
  the Workspace, and starts the first generation. The project name is the prompt's first line truncated to ~60 chars —
  cosmetic only, stored in `project.toml`. A failed first turn rolls none of this
  back: the error lands in chat and the user simply sends the next message. The
  agent health check (SDK-reported: installed? logged in?) runs in the background at
  startup and shows in the status bar; a missing agent produces a clear error on
  send. MVP has no wizard.
  The v1.0 first-run wizard adds the explicit choices: target stack for exports
  (rust-ratatui | go-bubbletea | js-opentui | generic) and preview defaults.
- Present → acquire `ProjectLease` and complete mandatory journal recovery, then
  perform the **workspace trust check before design-code execution**: designs are
  code and rendering executes them, so a `.termcraft/` this machine has not trusted yet (created elsewhere, e.g.
  arrived via `git clone`) shows a trust prompt — "designs in this project are code
  and will run; trust this folder?" — before anything renders. Decline completes open
  as ready but untrusted/read-only: chat and history remain visible, execution and
  preview stay disabled, and the lease remains held until explicit close. The decision persists in
  machine-local user state **outside** the project folder, so a repository cannot
  ship its own trust grant (§7.1). A project created on this machine is trusted
  implicitly. Then the Workspace opens with the active chat's history restored
  (§3.9). There is no project picker; separate projects live in separate directories.
- Present but older format → offers bulk migration (see §7).

### 3.2 Workspace

Layout: chat panel on the left (~35%, showing the active chat — §3.9), live preview
on the right, status bar at the bottom. The composer's top border carries the
conversation-level indicators: the model chip (agent · model · effort — click opens
the picker, v1.0, §3.6) on the left and the context-usage indicator (§3.9, hidden when
the backend reports none) on the right. The status bar's composition is fixed, left
to right: the page + Current/history segment (click opens Git-backed history,
v1.0, §3.4),
preview size (error-colored when smaller than the page's `minSize`, §8.2), and mode;
a short hint row rendered from the action table (§4) — only the few live view keys —
sits right-aligned.
Slash commands are deliberately not hinted in the status bar; the slash menu is its
own discoverability (§3.10). The Current/history segment is the status bar's only clickable
segment; the model chip keeps its click on the composer border. Everything else is
display. Page tabs above
the preview. `F2` toggles fullscreen preview. With zero pages (a brand-new or
all-failed project) the preview shows an empty-state placeholder ("No pages yet —
describe what to build") and the tab strip is empty.

The preview region displays frames streamed from the design host (§4.2) — the
isolated subprocess that actually executes the page's code. The shell composits
pins and selection highlights over those frames; a host crash shows an error panel
in the preview region only, never taking down the app (§9).

While the agent works, its status streams into the chat as an ephemeral block
under the agent's header, rendered from the normalized `AgentEvent` stream
(§6.1): a spinner line; the turn's tool steps accumulating beneath it
(`✓ read main.tsx` done, `▸ editing main.tsx` current); and below those, one to
three faint lines carrying the *latest* reasoning chunk — each new chunk
replaces the previous, a ticker, not a log, so the chat stays compact while
still visibly alive. Gate retries add a kernel-emitted line
(`✗ invalid design · retry 2/3`). When the turn ends the block collapses into
the persisted agent record (§7.1): the final message rendered in markdown-lite —
bold, italic, inline code, and bullet lists; headings flatten to bold lines;
tables, code blocks, and links flatten to plain text — plus a compact list of page
slugs in `changedPages`. Ephemeral lines are always plain text. The preview updates
after the recoverable turn transaction commits. Generation is cancellable (`Esc`,
per the focus rules in §3.8).
Typing the next message while a turn runs is allowed, but sending is disabled (the
status bar hints why) — there is no message queue. History browsing, Restore,
export (§3.7), the agent picker (§3.6), and chat creation and switching (§3.9) are
locked while a turn runs. `/commit-page`, `/commit-infra`, and `/commit-all` remain
available according to Kernel capability; their actual Git writes serialize with
final apply through the project-write mutex.

Mouse in the preview:

- **Hover** (static mode) highlights element boundaries, resolved through the design
  host's hit grid (`checkHit(x, y) → id`).
- **Left click** (static mode) selects an element (deepest hit); a chip like
  `gauge "CPU Usage"` (component kind + label, reported by the host) is attached to
  the chat composer, so "make it blue" reaches the
  agent with context. `Esc` deselects. The selection is stored as (page, element id);
  the rect is re-queried from `PreviewSession` for a named `frameSeq`. It remains
  visible on a historical snapshot only while the id resolves there, without
  changing the stored Current-design selection; switching page tabs clears it. The
  chip is included in the prompt only if the id resolves in the active page's
  canonical Current source at send time.
- **Right click** (works in both modes, §3.5) drops a **pin comment**: a mini input
  opens at the click point over a dimmed preview (§3.8); the comment is stored
  anchored to (element id, fractional position fx/fy ∈ [0..1] inside the element's
  rect) and shown as a numbered pin on the preview and as a list in the chat panel.
  On render the pin sits at `rect.origin + (fx·width, fy·height)`, clamped inside the
  rect — pins stay proportionally where they were dropped when the element resizes.
  Open pins whose anchor resolves are sent with the next message; after a successful
  apply the Kernel appends resolved events only for sent pins whose page appears in
  non-empty `changedPages`, in the same `TurnTransaction` as source and chat. An
  empty design diff leaves pins open. The UI only reflects committed state.

Pins are anchored to element ids, not source snapshots. A pin is drawn on the preview
exactly when its anchor resolves in the host's current render (`rectOf`, §4.2);
otherwise it stays in the chat panel's pin list marked "not visible in the current
render (hidden or removed)" — no claim is made about the version, because the
design's own state can hide and reveal elements: a pin inside a closed dialog
reappears when the dialog opens. Unresolved pins are never deleted automatically
and are skipped when sending to the agent.

Selection and pins are mouse-only in v1.0; keyboard element navigation is backlog
(§8.3).

### 3.3 Pages

Project → **Pages** (one design screen each) → optional Git history for each
canonical page path. Tabs switch pages. A page slug is its stable identity and maps
to `.termcraft/pages/<slug>/page.tsx`; there is no page UUID or private numbered
version store. The agent manages pages through its unique turn workspace (§6.2):
creating `pages/<slug>.tsx` proposes a page, deleting it proposes removal, and
editing `pages.json` proposes the portable order or a local active-page effect. A
page's title lives only in its static `meta` export (§5.1). UI rename is a mechanical
Kernel transaction that rewrites `meta.title` in canonical source without inventing
page-history identity. Removing a page deletes its canonical current path;
Git retains committed history, and recreating the same slug deliberately resurrects
that identity. In v1.0 pages are linked by runtime navigation calls (§5.5).

### 3.4 Current design and Git history

MVP has only the canonical Current design and no history UI. v1 adds optional Git
history when `.termcraft/` belongs to a repository. The history popup queries the
active page path lazily in bounded, first-parent pages; each row is a Git commit,
not a termcraft version and not a prompt. Uncommitted canonical source is shown as
the distinct Current row. History browsing materializes a read-only temporary
snapshot for `PreviewSession`; it never changes project or local workspace state.

`Restore` is explicit. Planning selects the exact Git blob, validates it through the
current Gate and matching host, stores the hash-bound attestation, and builds
confirmation. When `restore.confirm` is accepted, the Kernel captures `targetChatId`,
mints UUIDv7 `restoreActionId`, revalidates the attestation and freshness under the
project-write mutex, then uses a durable
`RestoreTransaction` to replace the canonical `page.tsx` and append exactly one
audit record to the captured chat. Unexpected source/index drift rejects before
commit intent. After intent, startup recovery rolls the plan forward; no
auto-rollback exists. Sending is allowed only from Current design.

Termcraft never commits implicitly and never maps commits to prompts. The only Git
write triggers are `/commit-page`, `/commit-infra`, and `/commit-all`; each shows an
exact path preview and editable message before execution. Commit hooks may mutate
managed files, so final turn apply later revalidates its captured hashes under the
same project-write mutex instead of overwriting hook side effects.

### 3.5 Interactive prototype (v1.0)

`F4` toggles static ↔ interactive mode. The design is real code, so interactivity is
native: in interactive mode the shell forwards mouse and keyboard input to the design
host instead of interpreting it — buttons fire their real `onClick` handlers, tabs
switch their own state, dialogs open and close, runtime navigation calls (§5.5) switch
pages, focus traverses with `Tab` through OpenTUI's focus system, and inputs accept
real typing. In static mode input is not forwarded at all — the shell interprets it
instead: clicks select (§3.2). The preview stays live in both modes (an animated
design animates in static mode too); the modes differ only in where input goes. `F3` opens the Tweaks panel (§5.6) in either mode.
`Esc` is never forwarded: it follows the shell's layer rules (§3.8) and doubles as
the keyboard exit from the interactive preview.
Right-click pin comments keep working in interactive mode — the user can annotate
mid-flow. A navigation call whose target page has since been removed is a no-op with
a quiet notice above the composer (per the UI reference).

### 3.6 Agent · model · effort picker (v1.0)

Typing `/model` (§3.10) or clicking the composer's model chip / Home inline
selectors opens a popup over the dimmed screen
listing selectable (agent, model, reasoning effort) combinations — one row each,
current choice marked. The chosen triple is stored in machine-local
`workspace.local.toml` and shown as a
chip on the Workspace composer's border (`codex · gpt5.5 · high`) and as inline
selectors on the Home prompt. On Home, before `.termcraft/` exists, the choice is held in memory
and written to local workspace state when the project is created. Each `AgentBackend` reports its available models/efforts and maps the
triple to its SDK options. Switching agent or model starts a fresh agent session (§6.2);
chat history is unaffected. While a turn runs the picker is locked (§3.2).

### 3.7 Export

`Ctrl+E` (or `termcraft export`) publishes an immutable generation beneath
`.termcraft/export/generations/<generationId>/` and returns that resolved package
directory. `.termcraft/export/current.json` selects the active generation. Relative
to the resolved package, contents are:

- `design-prompt.md` — implementation prompt: product overview, per-page structure and
  behavior, interactions and tweak states, theme/palette tokens, recommended libraries
  for the configured target stack, and — embedded per page — the canonical ASCII
  snapshot at the page's `minSize`. The prompt frames the snapshot files as
  acceptance fixtures ("your implementation at 80×24 must render
  `snapshots/checkout/80x24.txt`; diff your output against it") and explains how to
  read `layout/*.json` (boxes in terminal cells; ids match the ids in the sources —
  the code ↔ geometry link).
- `pages/*.tsx` — the exact canonical Current design sources, including uncommitted
  changes (machine-readable source of
  truth; precise enough for an implementing agent in any target stack to read as a
  spec).
- `runtime-api.json` — the pinned `@termcraft/runtime` compatibility contract used to
  interpret those sources: `kitApiVersion`, renderer identity, supported capabilities,
  and the export flag contract.
- `snapshots/<page>/<WxH>.txt` — one ASCII frame per export size, rendered by the
  design host (deterministic — independent of the current preview size or theme
  override, §5.7). Separate files so the implementing agent can diff its own render
  output against them programmatically.
- `layout/<page>.json` — the resolved layout tree at every export size: per node its
  `id` (as declared in the design, else `null`), `kind` (runtime component or raw
  element name), computed `box` (`x`/`y`/`w`/`h` in cells), `text` for text nodes,
  and `children`. No styles — colors already live in the frames and the theme
  tokens; the tree answers exactly "which box is where", so an implementing agent
  never has to simulate flexbox.

Export sizes are a fixed ladder: the page's `minSize` always, plus 120×40 (also a
preview preset, §8.1 — what the user saw is what ships) and 160×40; a standard
size is included only when it is at least `minSize` on both axes (a page is never
rendered below its minimum), and duplicates collapse. Several sizes turn resize
behavior into data instead of code: the frames show which regions stretch and
which stay fixed, without the agent reading flexbox props — and the
120×40 → 160×40 step grows width only, isolating horizontal stretch.

Rendering uses a bounded worker pool and a content-addressed local render cache.
`ExportPublishTransaction` assembles and verifies a complete generation away from
the active package, persists publication intent, creates the immutable generation,
and changes `current.json` only after all package files exist. A crash cannot leave
a visible mixture of old and new files. Export is all-or-nothing: if any page fails to render at any
export size, the whole export
refuses, naming the page, the size, and the error — a package with a silently
missing page would lie to the implementing agent. Export is likewise refused while a turn runs
(§3.2), when the project has zero pages, and on an untrusted project — export
executes design code, so `termcraft export` on an untrusted folder prints the trust
error and points at the TUI (§3.1). In-app refusals hint in the status bar.

### 3.8 Focus and hotkeys

Hotkeys come in two tiers:

- **Global** — `F2`/`F3`/`F4`, `Ctrl+E`, `Ctrl+P` (preview controls popup: theme
  override and size presets — v1.0, §8.1 items 9–10): work always, even while a text
  input is focused.
- **Single-char** — `v` (Git history popup in v1, §3.4), arrow navigation inside
  the active surface, and `r` (re-check agent health on the Home agent-error state): work only
  when no text input is focused. Configuration- and conversation-level actions have
  no single-char keys — they are slash commands (§3.10).

In interactive mode (§3.5) the shell claims its own keys first (the global tier,
`Esc` per the layer rules below); everything else forwards to the design host.

All popups (the picker, the pin input, preview controls) render over a dimmed
backdrop, so their inputs never blend with the design underneath. In the preview
controls popup the `custom` size preset expands an inline `W×H` input (`100x30`,
`100 30`, and `100×30` all parse); Enter applies, invalid input shows an inline error
and applies nothing; the last custom size is remembered in `workspace.local.toml`.

Exactly one widget owns focus. The Home prompt is focused on entry; the Workspace
composer is focused by default; `Tab` cycles focus between the composer and the
preview. Anything reachable by a single-char hotkey is also reachable by mouse.

`Esc` follows a strict layered priority — one press pops the topmost layer:

1. an open popup or the slash menu (picker, Git history, pin input, preview controls,
   §3.10) → close it;
2. a focused text input — or the preview focused in interactive mode — → unfocus,
   returning focus to the composer;
3. an active historical browse view (§3.4) → return to Current design;
4. a running generation → cancel it;
5. a selected element → deselect.

### 3.9 Chats

A project holds one or more **chats** — independent conversation lines over the same
pages. A chat is only a conversation: switching chats swaps the visible history and
the agent session (§6.2) and touches nothing else — active page, preview state,
selection, and pins all stay put. Pages are shared state; whichever chat sends the
next message sees the canonical Current sources as they stand at send time (§6.2).
One turn runs at a time per project regardless of chat. Each asynchronous action
captures its target chat when admitted, so switching tabs later cannot redirect its
agent, error, cancellation, rename, or Restore record.

Starting a new chat is the context-reset gesture: a fresh chat file and a fresh agent
session, no carried context. termcraft never trims or compacts a conversation itself —
the CLI owns its own context management, and the context budget is the user's call.
The composer's context-usage indicator (§3.2) is the prompt to make that call: it is
fed by token usage the backend's SDK reports in its event stream (§6.1), and a
backend that reports nothing simply hides the indicator.

Chat ids are termcraft-assigned UUIDv7 values. A chat's display name is derived, not stored: the first line of its first
`user` record, truncated to ~60 chars (the project-name rule, §3.1).

MVP ships the full storage model, managed through slash commands (§3.10): `/new`
starts a fresh chat and switches to it; `/chats` opens the chat list popup — chats
listed by derived name with timestamps, newest first, the active chat marked, Enter
switches — following the existing popup pattern (§3.6, §3.8; UI reference:
`design/24-chats.dc.html`). Rename, deletion, and AI-generated titles are backlog
(§8.3).

### 3.10 Composer commands

Typing `/` as the first character of an empty primary input (the Workspace composer
or the Home prompt) opens the **slash menu**: an autocomplete list anchored to the
input, filtering as you type, each command with a one-line description. Enter runs
the highlighted command; Esc closes the menu (§3.8). The menu is not a modal popup —
it never dims the screen — and it is just another view over the §4 action table. A
command whose availability predicate fails shows dimmed with the same hint the
status bar would give; a command meaningless on the current screen is hidden (on
Home only `/model` applies, and when nothing applies the menu simply does not
open). While a turn runs, ordinary message sending remains disabled but `/` on an
otherwise empty composer still opens local command mode: the v1 `/commit-*`
commands remain available according to Git scope state while other turn-locked
commands stay dimmed. On Enter, composer text that exactly names a known command
runs it; anything else is sent as a chat message when sending is available.

Commands are argument-less; each dispatches its action-table entry and any
hotkey or mouse twin where one exists:

- `/new` — start a new chat and switch to it (§3.9). MVP.
- `/chats` — open the chat list popup (§3.9). MVP.
- `/export` — run the export, same as `Ctrl+E` (§3.7). MVP.
- `/model` — open the agent · model · effort picker (§3.6). v1.0.
- `/commit-page` — open scoped commit confirmation for the active page's
  canonical `page.tsx`. v1.0; governed by the continuation.
- `/commit-infra` — open scoped commit confirmation for portable termcraft
  infrastructure. v1.0; governed by the continuation.
- `/commit-all` — open scoped commit confirmation for every eligible changed
  path under `.termcraft/`. v1.0; governed by the continuation.

The set is deliberately small: slash commands cover conversation,
configuration, and explicit scoped commits, while live view controls stay on
keys. The composer's model chip and the v1 Current-design/history segment keep
their mouse and keyboard entry points, but commit commands deliberately have no
persistent button or mouse twin.

## 4. Architecture

### 4.1 Components

TypeScript on Bun; the shell UI is OpenTUI (React bindings). One `bun build
--compile` binary ships the shell, the design host entry, and the embedded
`@termcraft/runtime`; its Reatom, React, and OpenTUI implementation stays
private — the user's project folder never grows a `package.json`. OpenTUI's native
core ships inside that binary. The TypeScript compiler does not: at `typescript@7`
it is a per-platform native executable that cannot be spawned from a Bun embedded
path, so it and its lib files are embedded, extracted once to a per-user directory
on first use, and run as a subprocess — which also makes the build per-platform.

**The TypeScript version is pinned exactly, and the major is load-bearing.**
`typescript@7` is the native Go port: it exposes no `ts.createProgram` and no
`CompilerHost`, so TypeScript 5's JavaScript compiler API does not exist there and no
design that assumes it survives the switch. The Gate is built on
`typescript/unstable/sync` — a subpath whose name is its own stability warning — and
the lib chain and platform-package layout are version-specific. `bun.lock` is the
source of truth for every version; the verified toolchain table lives in the spike
findings. TypeScript 5 was never probed: it remains the unexplored escape hatch if
per-platform builds or the extraction step prove intolerable, and re-opening it means
a real probe rather than an assumption.

The three load-bearing claims here were spike-verified on 2026-07-17 and all three
hold: dynamic TSX import with embedded-module resolution from the compiled binary
(Windows included), styled cell-frame capture from the headless renderer, and
running the TypeScript check inside the compiled binary. See
[`docs/spikes/2026-07-17-findings.md`](../../spikes/2026-07-17-findings.md) for the
verdicts, the amendments each forces, and the lockfile-verified toolchain. Strict
module boundaries; each module is extractable into a workspace package later
without rewrites:

- `runtime` — `@termcraft/runtime`: the only import surface for saved pages —
  selected Reatom v1001 primitives, `reatomComponent`, themed components with
  mandatory stable `id`s, palette tokens, tweaks, navigation, and runtime
  capabilities (§5). Shipped embedded; designs resolve it from the binary.
- `gate` — the validation gate for agent output: TypeScript checking, the import
  allowlist lint, page-contract checks, smoke rendering, id lints (§6.3).
- `host` — `HostSupervisor`, `PreviewSession`, and the design-host subprocess
  protocol: executes one selected source snapshot headlessly, streams bounded
  styled frames, answers hit-test and rect queries, receives
  forwarded input and tweak changes (§4.2).
- `agent` — the `AgentBackend` interface over the vendors' official TypeScript SDKs:
  `@openai/codex-sdk` (MVP) and `@anthropic-ai/claude-agent-sdk` (v1.0). Health
  checks, session continuity, per-turn confinement configuration (§6.1).
- `store` — portable project state, local workspace state, canonical pages,
  comments, chats, recoverable project transactions, safe filesystem access, and
  migrations (§7); the machine-local trust ledger lives outside the project (§7.1).
- `core` — the kernel: accepts versioned **Commands** from the UI (create project,
  send message, select source, toggle tweak, export…), authoritatively validates
  every transition, publishes capabilities and state revisions, orchestrates agent turns and the
  staging lifecycle, runs the gate, applies results, owns the design host's
  lifecycle, emits **Events** (agent status stream, version applied, error…).
- `ui` — the OpenTUI shell: Home and Workspace screens, mouse/keyboard handling,
  Tweaks panel, pins, preview compositing of host frames. All user-triggerable
  actions are declared in a single **action table** — `id`, label, hotkey,
  local applicability predicate, and the Command it dispatches. The keyboard handler
  resolves keys through this table, and the status-bar hint row renders from it.
  Enabled state combines the Kernel-published capability with local screen, focus,
  and modal applicability. The slash menu (§3.10) is another view over the same
  table. UI availability is advisory; the Kernel repeats every domain guard.

**The kernel boundary is transport-neutral, not a finished IPC protocol.** UI and
core communicate through serializable, versioned Command/Result/Event DTOs over
in-process async channels. `commandId`, `stateRevision`, and `eventSeq` make stale,
duplicate, and reordered work explicit. Daemon authentication, reconnect, and
multi-client semantics remain out of scope. Host frames use a separate bounded
preview stream so they cannot starve domain events.

**State and logic are Reatom.** termcraft's logic, including saved page models,
kernel state and turn orchestration in `core`, and screen/action-table state in
`ui`, is written with
Reatom v1001 (`@reatom/core@1001`): named atoms and computeds for state, actions
for commands, `wrap` at every async boundary so reactive context survives awaits
and callbacks, async flows through `withAsync`/`withAsyncData` instead of manual
loading/error flags. Long-lived UI subscriptions may use connection hooks with
cleanup, but critical process, cancellation, and transaction lifetimes are owned
explicitly by supervisors and transaction services. Reatom does not
blur the kernel boundary: each side holds its own atoms, and only Commands and
Events cross the channel — the UI mirrors kernel state from Events, never imports
kernel atoms. The OpenTUI shell and page components bind through
`reatomComponent`; React hooks are used minimally, primarily to obtain scoped
models from context. Saved pages import only `@termcraft/runtime` (§5.8), never
Reatom, React, or OpenTUI packages directly.

Diagram: [`docs/architecture/modules.md`](../../architecture/modules.md) — module
graph with the transport-neutral Kernel boundary and host process seam.

### 4.2 The design host

Design code never runs in the shell process. The Kernel-owned `HostSupervisor`
spawns the termcraft binary as a subprocess (`termcraft _host`) for the selected
source snapshot. Switching page or source kills the host and spawns a fresh one —
zero prototype state leaks between sources. The UI receives a typed
`PreviewSession`; it never owns subprocess handles or stdio.

**Respawn-per-source is a correctness requirement, not an isolation preference.**
Bun's module cache returns the stale module for a re-imported path, and query
cache-busting does not cure it — Bun ignores `?v=` as a module key, so a busted
import hands back the same module object. A directory-listing cache compounds it: a
file created inside an already-resolved directory stays invisible. A host that
outlived a source edit would therefore render the previous source while reporting
success. Nothing short of a fresh process fixes this; respawn does.

The host: re-checks the import allowlist (§5.8), dynamically imports the page module
(Bun transpiles TSX in-process, including from a compiled binary), mounts it in an
OpenTUI headless renderer at the preview's size, and speaks a length-prefixed,
versioned protocol with the supervisor. A handshake binds `sessionId`, nonce,
`sourceHash`, `kitApiVersion`, negotiated limits, and protocol version; requests
carry ids and frames carry a monotonic `frameSeq`:

- **host → supervisor**: styled cell frames (char + fg + bg + the 8 text attributes) on
  change; a heartbeat; the page's evaluated `meta` and tweak declarations after mount
  (§5.1, §5.6); page-emitted events (runtime navigation calls, §5.5).
- **supervisor → host**: resize, theme and capability override (§8.1), forwarded input
  (interactive mode, §3.5), tweak changes (§5.6), and queries — `checkHit(x, y) →
  id`, `rectOf(id) → Rect` (selection and pins, §3.2), `describe(id) →
  component kind + label` (the selection chip, §3.2), and `layoutTree() → the
  resolved node tree` (id, kind, box, text, children — export capture, §3.7).

**What a styled cell frame carries, scoped to what was measured.** A full grid
reconstructs losslessly from the renderer's span capture for char + fg + bg + the 8
text attributes — the tuple above, and no more. Hyperlink ids are *not* in that
tuple: span capture masks attributes to their low 8 bits and drops the link id.
Nothing in the MVP needs them; if that changes, they are recoverable from the render
buffer's attributes plus the renderer's link lookup, and this contract widens by
amendment rather than by accident. Two rules the capture implementation cannot
violate:

- **Frame text comes from the span API, never from the render buffer's `char` array.**
  For ASCII the two agree, but a wide character carries no codepoint in `char` — the
  cell holds a packed marker, and only the *trailing* column carries the continuation
  flag. Reading either column as a codepoint throws. OpenTUI's own span reader refuses
  to read text from `char` for exactly this reason.
- **Cell width is display width, not codepoint count** (`日本語ab` is 5 codepoints and
  width 8). This is the one place the protocol can silently corrupt a frame while every
  type still checks.

**The production capture path is OpenTUI's public API, not its `/testing` export.**
The obvious shortcut — building the host on `@opentui/core/testing`'s test renderer —
puts a testing-scoped export of a pre-1.0 package under a production requirement. The
public rebuild loses nothing: the intermediate-render call is public and paints, the
CLI renderer accepts fake streams, and with memory-buffered output no feed is
allocated, so the backpressure the harness appears to manage is moot rather than
dropped. Two traps in that recipe: the CLI renderer resolves its size as
`stdout.columns || config.width || 80`, so a fake stream's `columns` silently
*overrides* the preview size it was asked for, and terminal setup puts stdin in raw
mode, so the stream shim must implement `setRawMode`.

**Preview cost is process spawn, not import.** One preview is one spawn at 44–52 ms,
of which import and render are about 1 ms — spawn dominates by ~50×. Any
preview design that optimizes import is optimizing 2% of the budget. Treat 45 ms as a
*floor*: it was measured on a minimal probe binary without OpenTUI's native core
aboard, so the robust claim is the ratio, not the absolute number.

Protocol message sizes and queues are bounded. Preview delivery keeps at most the
latest pending full frame; a newer frame replaces an undelivered older one. Resize,
mouse-move, and hover work coalesce, while key/click input and responses remain
ordered. Geometry responses name the `frameSeq` they describe, so stale replies are
ignored. Frame deltas remain deferred until benchmarks justify their complexity.

Isolation layers, each with its honest job:

1. **Process isolation** (stability — the load-bearing layer): a crash or hang in
   design code kills only the host. The supervisor applies bounded startup,
   heartbeat, request, and shutdown timeouts, a restart budget with backoff, and a
   circuit breaker instead of unbounded respawn (§9).
2. **Process hygiene**: scrubbed environment (no inherited secrets), cwd in a
   scratch directory, the page source passed read-only by path.
3. **Static import allowlist**, enforced twice — at the Gate (§6.3) and again by the
   host before importing (catches files edited by hand): saved designs may import
   only `@termcraft/runtime` (§5.8).
4. **Best-effort global scrub** before the design module loads (`fetch`, `Bun`,
   process internals) — a guard against accidents, documented as not a security
   boundary.
5. **Workspace trust** (§3.1) — the real answer to the real threat: designs travel
   through git and execute on whoever opens the project. Same trust model as
   VS Code workspace trust, direnv, or npm scripts.

Honest threat-model note: Bun has no runtime permission model, so a determined
malicious design in a trusted folder is not containable — the same is true of every
dev tool that executes repository code. The layers above make accidents survivable
and foreign repositories explicit; they do not make hostile code safe.

## 5. The design language

Goals: nothing renderable is out of reach (designs are real Reatom-first code
against a stable terminal runtime); consistent by default (runtime components and
tokens); every element addressable
(selection, pins); deterministic to snapshot; safe to execute (the cage of §4.2).

### 5.1 Page modules

A page is one canonical TSX module at `.termcraft/pages/<slug>/page.tsx`,
materialized as `pages/<slug>.tsx` in a unique turn workspace (§6.2). The contract:

```tsx
import {
  atom,
  definePage,
  Gauge,
  Panel,
  reatomComponent,
  Row,
} from "@termcraft/runtime"

export const meta = definePage({
  kitApiVersion: 1,
  title: "Dashboard",          // tab label, the page's display name
  minSize: { w: 80, h: 24 },   // smallest export size, status-bar warning threshold
  theme: "dark-default",       // token palette (§5.4)
})

const cpu = atom(42, "dashboard.cpu")

export default reatomComponent(function Page() {
  return (
    <Row id="root">
      <Panel id="cpu-panel" title="CPU">
        <Gauge id="cpu-gauge" label="CPU Usage" value={cpu()} />
      </Panel>
    </Row>
  )
})
```

`meta` must be a plain object literal of constants — no computed values; the Gate
rejects anything else (§6.3). The source is authoritative for `kitApiVersion`,
title, minimum size, and theme. Tabs and status derive them from a rebuildable
machine-local cache keyed by source hash and extractor version; `project.toml`
does not duplicate them. A UI rename mechanically rewrites `meta.title` (§3.3).
The default export is a `reatomComponent` page. `@termcraft/runtime` re-exports
`reatomComponent` from `@reatom/react@1001.0.0` (not `@reatom/core`, which does
not export it); round 2 Spike D (`docs/spikes/04-reatom-opentui/FINDINGS.md`)
verified it drives re-renders through OpenTUI's own React reconciler, not
`react-dom`, in a compiled binary on Windows. Page state, derivation, and
transitions live in named atoms, computeds, and actions; hooks are minimal and
mainly retrieve scoped models from runtime context. The optional `tweaks` export
is §5.6. Helper models and components remain in the same file.

One page = one file. Shared visual ideas are expressed through the runtime; designs
do not import each other (§5.8), so pages stay independently renderable and their
paths remain independently reviewable in Git.

### 5.2 The runtime component catalog

`@termcraft/runtime` components carry the design system: palette tokens, consistent
borders and spacing, and a mandatory stable `id` prop on every visible component —
ids are how selection, pins, and chat references address the design (§3.2). The
agent is instructed to preserve the ids of surviving elements across iterations;
the gate warns when an iteration drops previously present ids (§6.3).

Ids must be unique among simultaneously rendered elements, enforced where each case
is detectable: duplicates visible at the gate's smoke render are validation errors
(§6.3); duplicates that only appear later — a dialog opened, a tweak flipped — are
reported by the host as warnings into the same channel as gate warnings, and
`checkHit`/`rectOf` deterministically resolve to the first mounted element.

| Tier | Components |
|------|-----------|
| MVP containers | `Row`, `Column`, `Panel` (border + title), `Tabs` |
| MVP primitives | `Text` (styled spans), `Button`, `Input`, `List`, `Table`, `Gauge`, `Sparkline`, `Separator`, `Spacer` |
| v1.0 additions | `Modal`, `Menu`, `Tree`, `Progress`, `Chart` (bar/line), `Scroll` |

**The escape hatch remains inside the stable facade:** the runtime exposes supported
low-level terminal primitives for custom components, ASCII art, and bespoke widgets
without exposing OpenTUI imports. High-level components are the default vocabulary,
not a wall. Low-level visible elements should still carry `id`s where the designer
is expected to point at them; the Gate reminds, not rejects (§6.3).

### 5.3 Layout

The runtime's flexbox surface maps to the embedded renderer's Yoga layout:
direction, grow/shrink/basis, gaps, padding, and alignment — expressed as ordinary
style props on runtime containers and low-level primitives
alike. LLMs know flexbox cold; no bespoke layout micro-syntax exists for them to get
wrong. `Row`/`Column` are thin flex-direction presets; `Spacer` is `flexGrow: 1`.

### 5.4 Styles and themes

Runtime components consume **palette tokens** — the closed set: `background`, `surface`,
`text`, `text-muted`, `text-faint`, `border`, `primary`, `accent`, `selection`,
`ok`, `error`. Themes come from a built-in registry: `dark-default` (MVP; palette
values from the UI design file) and `light-default` (v1.0). A theme is bound at page
level via `meta.theme`; the preview theme switcher (§8.1) is a non-persistent
override — the host re-renders with a different token binding, the source is never
touched. Inside design code tokens are reachable through runtime context for
supported low-level primitives; raw color values remain an escape hatch.
Agent-defined palettes are
backlog (§8.3). Terminal color handling (truecolor/256/16) is OpenTUI's; the preview
capability simulation (§8.1) constrains the host's output to preview degradation.

### 5.5 Interactivity

Designs are Reatom models rendered as components: named atoms hold prototype state,
computeds derive it, and named actions implement handlers and grouped transitions.
Conditional rendering and controlled inputs read those atoms through
`reatomComponent`; React hook orchestration is not the state model. Two behaviors
cross the design/shell boundary and go through runtime APIs:

- **Navigation.** `usePages().goTo("settings")` — the runtime emits a page-navigation
  event through the host protocol; the shell switches tabs. A target missing from
  the project manifest is a no-op with a quiet notice (§3.5). This is what links pages into
  a clickable prototype flow.
- **Tweaks.** `useTweak("density")` retrieves the scoped tweak model from runtime
  context; page logic reads and derives its atoms (§5.6).

Interactivity runs only in interactive mode (§3.5), when input is forwarded; in
static mode the same code still renders — animations included — but receives no
input.

### 5.6 Tweaks (v1.0)

Tweaks are disabled while a historical Git snapshot is selected and re-enabled
after the user returns to Current design.

Declared per page as an export; each tweak is a labeled control the shell renders in
the Tweaks panel (`F3`):

```tsx
export const tweaks = defineTweaks([
  { id: "density", label: "Density", kind: "select",
    options: ["comfortable", "compact"], default: "comfortable" },
])
```

Kinds: **toggle** (bool), **select** (enum string), **text** (free string — e.g. to
preview long/empty/cyrillic values in some input). The host reads the export and
reports it to the shell; flipping a control sends the value back through the host
protocol, and the scoped tweak model updates the design's atoms. Tweak state is
session runtime state — never written to the canonical source or a historical
snapshot, and reset whenever the selected-source host respawns (§4.2).

### 5.7 Rendering determinism

Export snapshots must be reproducible. The recipe: a fresh host process per
(page, size), the page mounted at that size with the page's own theme, exactly one
render pass (`renderOnce` at t = 0), the frame and the resolved layout tree both
captured from that same pass — consistent by construction — and the host killed.
Runtime components
suppress animation under the host's export flag; design-code conventions (§5.8) ban
timers and randomness outside explicit animation, so the first frame is stable.
Deviations are visible in export diffs — derived data under git review.

### 5.8 Design-code rules

Enforced by the gate (§6.3) and re-checked by the host (§4.2):

- **Import allowlist (error):** only `@termcraft/runtime`. Direct imports from
  `@termcraft/kit`, `@reatom/*`, `react`, `react/jsx-runtime`, `@opentui/*`,
  `node:*`, and `bun:*` are forbidden, as are relative imports of other pages,
  other npm packages, all dynamic imports, and all re-exports, including ones that
  name `@termcraft/runtime`; `eval` and `new Function` are also forbidden.
- **Page contract (error):** a default-export `reatomComponent` page and a valid
  static `meta` export including supported integer `kitApiVersion`; the file
  typechecks against embedded runtime types.
- **Conventions (warnings, fed back to the agent):** stable ids across iterations;
  ids on pointable raw elements; no `setTimeout`/`setInterval`/`Math.random` outside
  animation guarded by the export flag; simulated data lives in the component.

## 6. Agent integration

### 6.1 Backend abstraction

```ts
interface AgentBackend {
  startTurn(task: AgentTask): AgentRun   // bound to one fenced turn workspace
  cancel(run: AgentRun): Promise<void>   // resolves only after process-tree exit
  healthCheck(): Promise<AgentInfo>      // installed? logged in? sandbox effective?
  capabilities(): BackendCapabilities    // models × efforts; confinement mechanism
}
```

Implementations wrap the vendors' official TypeScript SDKs — `@openai/codex-sdk`
(MVP) and `@anthropic-ai/claude-agent-sdk` (v1.0, terms permitting) — which drive
the locally installed CLIs and inherit their auth; termcraft holds no API keys.

**The backend contract is mechanism-blind.** A backend's obligation is: stream
`AgentEvent`s, and by the end of the run have the turn's proposed changes present
in the staging directory — nothing else touched. *How* the changes get there is
the backend's private business. Codex and Claude Code fulfill it natively — the
CLI edits staging files with its own tools under its own confinement. A future
backend whose agent cannot edit files usably (a bare LLM API, a CLI without file
tools or without confinement) fulfills the same contract by emulation: it asks
the model for full-file structured output and writes the files into staging
itself. The kernel, the diff, the gate, and the apply pipeline are identical
either way — adding such a backend touches nothing outside its own module.
Retries follow the same rule: the kernel hands the gate errors to the backend as
turn feedback, and the backend decides how to carry them into its conversation.

`AgentTask` carries the unique turn workspace path and fencing identity, the system prompt, the user message
(with selection and pins), and the configured (model, reasoning effort) from the
picker triple (§3.6); each backend maps them to its SDK options and reports which
combinations it supports.

**Confinement** is per-backend, best-native:

- Codex: `workspace-write` sandbox rooted at staging, network restricted (its
  default). On Windows the sandbox is experimental and silently downgrades
  `workspace-write` to read-only when disabled — the health check probes an actual
  write in a scratch dir and reports the degradation honestly instead of letting
  turns silently produce nothing (§9).
- Claude Code: permission rules — file tools only, edits confined to staging, Bash
  and web tools denied; the SDK's per-call permission callback gives termcraft an
  in-process veto on every tool use, platform-independent.

Confinement is defense-in-depth, not the load-bearing wall: correctness comes from
the gate only accepting what landed in staging and validated (§6.3).

Round 2 Spike H (`docs/spikes/08-agent-confinement/FINDINGS.md`) tried to verify
both confinement claims on Windows 11. **The Claude sentence is confirmed
accurate**: a deny-everything `canUseTool` callback fired before every one of 6
tool-use attempts across 5 attack cases — an in-staging write, an absolute path
outside staging, a `../`-relative escape, a `Bash` call, and a `WebFetch` call —
and every denial held, cross-checked against the SDK's own independent
`permission_denials` audit trail and a post-hoc filesystem check, identically in
both `bun run` and a `bun build --compile` binary. **The Codex sentence is
unverified, neither confirmed nor refuted**: the write-probe mechanism itself
(create a scratch dir per `sandboxMode`, run one write-only task, inspect the
filesystem rather than trust the transcript) ran to completion for all three
sandbox modes without crashing and reached the OpenAI API, but every turn failed
before attempting a write because the test account's Codex usage quota was
exhausted — confirmed independently via the raw CLI, ruling out an SDK or probe
bug. This must be re-run before shipping the Codex health-check copy in §9 as
written. Separately, `@openai/codex-sdk` exposes no health/status method at all
(only `Codex`/`Thread` with a `sandboxMode` option) — the write-probe in a
scratch dir is confirmed to be the only way to implement `healthCheck()`'s
"sandbox effective?" for Codex, not one option among several.

**The `AgentEvent` stream** is the turn's only live output — everything the UI
shows while an agent works derives from it:

```ts
type AgentEvent =
  | { kind: "reasoning", text: string }   // a chunk of the model's reasoning summary
  | { kind: "tool", op: "read" | "edit" | "run" | "search" | "other", target: string }
  | { kind: "final", text: string }       // the agent's final message for the turn
  | { kind: "usage", tokens: TokenUsage } // backend-reported token usage
  | { kind: "error", message: string }    // a backend-level failure
```

Normalization is each backend's job — the kernel and the UI never see vendor
event shapes. Codex maps reasoning-summary items to `reasoning`; command
executions, file changes, and web searches to `tool`; the closing agent message
to `final`; turn usage to `usage`. Claude Code maps thinking blocks and interim
assistant text to `reasoning`, `tool_use` blocks to `tool` (tool name → `op`,
primary argument → `target`), and the result message to `final` plus `usage`.
Vendor events with no mapping are dropped silently — forward-compatible by
default. A backend that emits no `reasoning` events is legal — the chat simply
shows less while it works (§3.2). Usage reporting stays optional per backend: it
feeds the composer's context-usage indicator (§3.2, §3.9) — no usage events, no
indicator. Any event resets the 120-second stream-silence watchdog (§9), but never
the non-resettable absolute turn deadline, which covers the initial attempt and all
Gate retries together.

### 6.2 Turn protocol

Each turn gets a unique **turn workspace** below
`{userStateRoot}/sandboxes/{projectKey}/turns/{turnId}/workspace`, never inside
`.termcraft/`. `projectKey` is lowercase hexadecimal SHA-256 over
`UTF-8(canonicalProjectRoot) || 0x00 || UTF-8(projectId)`. A writable turn directory
is never cleared for, or reused by, a later turn. It is populated at send time with:

- `pages/<slug>.tsx` — every canonical Current page, flat by slug;
- `pages.json` — the manifest slice: ordered slugs and optional requested active
  slug (a machine-local effect, not a portable manifest field);
- `RUNTIME.md` + runtime type declarations — the design-language reference the agent codes
  against.

Terminology, used consistently: the **project manifest** is `project.toml` (§7.1);
the **manifest slice** is this staging `pages.json`.

The backend receives this workspace as its cwd and only writable root. Native
vendor-session resume is used only when the backend can rebind the resumed run to
the new workspace; otherwise a fresh vendor session is seeded from persisted chat.
Each run is fenced by `{turnId, attempt, leaseNonce}`. Late events are ignored, and
cancellation completes only after confirmed process-tree exit. Failed workspaces
are quarantined for bounded diagnostics or garbage-collected; they are never reused.

The agent runs against the turn workspace with its native file tools — reading
whatever it wants, editing in place. The prompt contains the role, design-code rules
(§5.8), portable page order, source-extracted metadata, the local active page, the
outstanding diagnostics (from the Gate and host-reported runtime lints, §5.2), the
current selection,
open pins (only those whose anchors resolve), answer-style guidance (keep the
final message short and in light markdown — the chat renders only the
markdown-lite subset of §3.2), and the user message. No prefetch
policy, no read protocol, no seen-version bookkeeping: reading files is the agent's
own business now.

Page management is file management: a new `pages/<slug>.tsx` adds a page; deleting
one removes it from the portable order and deletes its canonical Current source;
recreating the slug later resurrects its Git identity. Reordering slugs or
requesting a local active page is a `pages.json` edit; retitling edits
`meta.title` in page source.

Page slugs are agent-chosen and validated: `^[a-z0-9][a-z0-9-]{0,31}$`, minus
Windows-reserved device names (`con`, `nul`, `aux`, `prn`, `com1`–`com9`,
`lpt1`–`lpt9`) — a slug is a directory name on disk. The mask is stated in the
system prompt; a violation is a normal gate error.

The turn's context (active page, selection, pins, canonical source hashes) is snapshotted into
staging at send time — switching tabs or chats mid-turn does not change what the
agent sees. Tab switching stays free while a turn runs (it is read-only); on apply,
the UI moves to another page only when `pages.json` requests an active page — adding a
page alone does not switch, and without that edit the user stays on whatever tab
they are viewing.

**Sessions.** Conversation continuity uses SDK resume only when the chat UUID,
opaque backend session scope (backend, model, and credential/account/workspace
identity), and exact chat-history checkpoint (record count plus prefix hash) match.
The map is machine-local (§7.1). If the checkpoint or workspace binding is stale,
termcraft starts a fresh session
and includes at most the newest 32 complete records before the current user record,
capped at 64 KiB by dropping oldest whole records first.
Switching agent or model starts a fresh session for the active chat — other chats'
stored session ids simply fail resume later and take the same fallback.

### 6.3 The gate: validation and application

The CLI exits → termcraft diffs staging against the turn's snapshot. The diff is the
proposal: changed/added/deleted page files plus `pages.json` edits. The gate runs:

1. **Manifest-slice checks** — `pages.json` parses, slugs match the mask, order is a
   permutation of listed pages, and the optional requested active page exists.
2. **Per changed page** — runtime-only import allowlist (§5.8), TypeScript check
   against embedded runtime types, page contract (`meta` as a static literal with
   `kitApiVersion`, default `reatomComponent` export),
   **smoke render**: the
   host mounts the page once at `minSize` — import errors, render crashes, contract
   violations, and duplicate ids visible in that render surface here, before
   anything is applied.
3. **Lints (warnings, not errors)** — dropped ids that selection or open pins
   currently reference, pointable raw elements without ids, timer/randomness use
   outside the export-flag guard, navigation to unlisted pages.

**Three requirements on step 2's TypeScript check, each earned by a measured failure.**

- **The diagnostic set must include global diagnostics, not just per-file and program
  ones.** The natural union of the latter two omits the bucket where missing-lib errors
  land: with `lib.es5.d.ts` deliberately broken, all four `Cannot find global type`
  diagnostics arrived in the global bucket and zero anywhere else. A Gate built on the
  natural union returns *clean* for a program that has no `Object` type — the exact
  failure the wall exists to prevent.
- **Diagnostics must be deduped on `(code, fileName, pos)`.** The union double-reports;
  at least one code lands in both the program and global buckets.
- **The Gate must distinguish "the compiler crashed" from "the page is clean."** Both
  produce an empty diagnostic array. An unguarded `try`/`catch` around the check reads a
  spawn failure as success, so a crash must be a typed Gate failure and never an apply.

A related limit constrains how this can be tested at all: a broken lib link is
**silent unless the page happens to use that lib**, so no fixture can prove the lib
chain is complete. The only evidence that can is a build-time cross-check that every
lib the compiler asks for is embedded — which is why that check ships with the build
rather than the test suite.

Errors → automatic retry: the errors are appended to the conversation and the agent
continues in the same turn workspace only after the prior attempt's process tree is
confirmed exited (one initial attempt plus at most 3 retries), then an honest error
record and no apply. Valid → the Kernel freezes an immutable candidate through
`SafeProjectFs`, acquires the project-write mutex, and revalidates canonical source
and record preconditions. This compare-and-swap check catches manual changes and
side effects from `/commit-*` Git hooks that ran during the turn. Drift produces a
typed stale/source-changed failure and overwrites nothing.

With current preconditions, `TurnTransaction` prepares complete payloads and
old/new hashes for changed canonical `page.tsx` files, portable manifest changes,
the local active-page effect, the agent chat record, and pin-status append events.
A durable commit intent makes the operation roll-forward-only; each write is
idempotent and startup completes an interrupted commit before opening the
Workspace. An empty diff remains valid and records `"changedPages":[]`. Per-file
rename is an implementation primitive, not a claim of simultaneous cross-file
atomicity.

Diagram: [`docs/architecture/flows/generation-turn.md`](../../architecture/flows/generation-turn.md) —
the full turn from user message to applied version, including the retry loop.

## 7. Storage and data versioning

### 7.1 Layout

```
.termcraft/
  .gitignore
  project.toml                # portable project id/name/target stack/page order
  workspace.local.toml        # active page/chat, preview and backend preferences
                              # scoped SDK resume checkpoints live in workspace.local.toml
  lock                        # diagnostic metadata; OS handle proves ownership
  transactions.local/         # durable plans, payloads, intent, committed markers
  cache/                      # rebuildable metadata/chat/render projections
  diagnostics/                # source-hash-keyed current diagnostics
  logs/operational.jsonl      # bounded allowlisted operational facts
  chats/<chat-uuid>.jsonl     # portable append-only conversations
  pages/<slug>/
    page.tsx                  # one canonical Current design source
    comments.jsonl            # append-only pin facts and status events
  export/
    current.json              # active generation id + complete manifest hash
    generations/<generationId>/
      design-prompt.md
      runtime-api.json
      pages/*.tsx             # exact canonical Current source copies
      snapshots/<page>/<WxH>.txt  # ASCII frames, one per export size (§3.7)
      layout/<page>.json      # resolved layout trees (§3.7)
```

`project.toml` is portable and contains no active tab, preview size, backend/model,
session id, cached metadata, lock, or recovery state. Those belong to explicitly
ignored local files. Page slugs are the only page identities; project, chat, turn,
command, record, pin, action, and transaction identities use UUIDv7. There is no
`config.toml`, page UUID, `cN` id, or `vN.tsx` store.

The generated exclusions hard-ignore local state, transactions, caches,
diagnostics, operations logs, leases, temporary generations, and backups.
`/commit-infra` includes portable `project.toml` plus generated exclusions;
`/commit-all` includes every eligible non-ignored path under `.termcraft/`, including
the published export. The project carries no `package.json` or `node_modules`.

Chats and comments are typed JSONL. Every record has a UUIDv7 `recordId`, timestamp,
and kind; agent records carry `turnId` and `changedPages`, while pin status changes
append new events instead of rewriting old lines. The reader accepts only a valid
prefix with a 1 MiB line limit. A transaction-proven partial final append can be
completed automatically; otherwise a corrupt suffix requires explicit repair and
mid-file corruption is fatal. `ChatIndex` supplies lazy record offsets and is always
rebuildable from canonical JSONL.

The single supported writer holds an OS-backed `ProjectLease`; PID/start metadata
is diagnostic only. A `TrustSubject` combines canonical path, filesystem identity,
portable `projectId`, and Git repository identity when available. Trust, verified
migration backups, and per-turn sandbox roots live in machine-local user state
outside `.termcraft/`; backups use
`{userStateRoot}/backups/{projectId}/{migrationActionId}/` and sandboxes use
`{userStateRoot}/sandboxes/{projectKey}/`. A repository cannot ship any of them. Every writable turn
directory is unique to one `turnId` and is never reused by a later turn; retries use
that same directory only after confirmed prior-process exit and receive a fresh
`{attempt, leaseNonce}` fence.

`SafeProjectFs` rejects traversal, absolute/UNC/device/ADS paths, case-fold
collisions, symlinks, junctions, reparse points, hardlinks, non-regular files, and
configured count/size limits before copying a candidate into an immutable snapshot.
It validates filesystem shape; the Gate separately validates imports, types, page
contract, and smoke rendering. Detailed normative storage rules are in
[`2026-07-16-production-storage-identity-design.md`](2026-07-16-production-storage-identity-design.md).

### 7.2 Format versioning and migrations

- Every JSON data file carries top-level `schemaVersion`; every JSONL file starts
  with a typed header line; every TOML carries `format_version`. Each file kind has
  its own independent counter.
- `store.migrate` holds an ordered registry of `N → N+1` steps per file kind. Reading
  any old file runs the chain to the current in-memory model; writing always emits the
  current version.
- **Page sources are code with a static integer `kitApiVersion`**, not a data-file
  `schemaVersion`. The embedded runtime supports an explicit API range; a breaking
  change ships with a codemod registered for canonical current page sources. Git
  historical objects are never rewritten.
- Triggers: lazily on read, plus explicit `termcraft migrate` for the whole folder;
  the wizard offers bulk migration when opening an old `.termcraft`. Planning mints
  `migrationPlanId`; confirmation mints `migrationActionId`. Before any migrated
  bytes are rewritten, `MigrationTransaction` creates and verifies the corresponding
  machine-local backup outside `.termcraft`, regardless of Git status.
- A file *newer* than the binary understands → hard error naming the file ("update
  termcraft"), no partial reads. Downgrades unsupported.
- Tests keep fixtures of **every historical version** of every file kind and run them
  through the chain, validating against the current schema.

## 8. Feature scope

### 8.1 v1.0

1. Home: prompt input when no project exists; an existing project opens straight
   into the Workspace (§3.1) after the trust check.
2. `.termcraft` wizard: setup, agent health check, target stack, bulk migrations.
3. Workspace: chat + live preview via the design host, `F2` fullscreen, status bar.
4. Agents behind `AgentBackend`: Codex SDK (primary); Claude Code via the Agent SDK
   second, terms permitting.
5. Full runtime catalog incl. `Modal`, `Menu`, `Tree`, `Progress`, `Chart`, `Scroll`.
6. Mouse: hover highlight, click-select with composer chip, right-click pin comments.
7. Multiple pages with tabs; agent-driven page management through staging; page
   rename/remove/reorder from the UI.
8. Per-page, path-limited Git history popup (`v` / click the Current/history
   segment) with read-only browse and validated explicit Restore; no prompt
   correlation or private versions.
9. Preview palette/theme switching (light/dark, 16/256/truecolor simulation).
10. Preview size presets: 80×24, 120×40, custom (inline `W×H` input, §3.8), auto.
11. Interactive prototype (`F4`): input forwarding to the design host — real
    handlers, focus traversal, runtime navigation between pages, typing in inputs;
    Tweaks panel (`F3`) with toggle/select/text controls.
12. Export: `design-prompt.md` + design sources + multi-size ASCII snapshots +
    resolved layout trees.
13. Agent · model · effort picker (via `/model` or the composer's model chip):
    popup selection, composer chip, inline selectors on Home (§3.6).
14. Multiple chats per project (§3.9): `/new`, `/chats` with the chat list popup,
    per-chat agent sessions, the composer's context-usage indicator.
15. Composer slash menu (§3.10) with the full v1.0 command set: `/new`, `/chats`,
    `/export`, `/model`, `/commit-page`, `/commit-infra`, `/commit-all`.

### 8.2 MVP cut

- Home prompt when no project exists; `.termcraft` created lazily on the first
  prompt, with portable target stack `rust-ratatui`; an existing project
  opens straight into the Workspace; background agent presence check (no wizard).
- Workspace trust check from day one — it guards code execution, which exists from
  the first render (§3.1, §4.2).
- Workspace: chat + preview + status bar + `F2`. Codex only with its default model; no
  picker UI, but the (agent, model, effort) triple already lives in
  `workspace.local.toml` so
  the format needs no migration when the picker lands.
- Multiple pages with tabs; page management through staging works in full (it is
  just files, §6.2).
- Runtime MVP catalog (§5.2), one dark theme, and supported low-level runtime
  primitives from day one; direct OpenTUI imports remain forbidden.
- Static preview only: the host protocol ships frames and answers hit/rect queries;
  input forwarding, tweaks, and runtime navigation land with v1.0 (`F4`/`F3` inert in
  MVP). The `tweaks` export and runtime navigation APIs are defined but dormant.
- Mouse: hover, click-select, right-click **pin comments** (explicitly in MVP).
- One canonical `page.tsx` per slug from day one; MVP has no history UI, Restore,
  private versions, or version hotkeys (§3.4).
- Multiple chats (§3.9) from day one: the `chats/` layout with per-chat SDK sessions
  and the composer's context-usage indicator, managed through `/new` and `/chats`;
  rename, deletion, and AI titles are backlog.
- Composer slash menu (§3.10) with `/new`, `/chats`, `/export` (`/model` arrives
  with the picker in v1.0).
- Export: `design-prompt.md` + sources + multi-size ASCII snapshots + resolved
  layout trees (the host already renders and computes layout — cheap and
  high-value for the implementing agent).
- Migration infrastructure live from the first commit (even with zero migrations).
- Preview auto-sized to the available area; when it is smaller than the page's
  `minSize`, the status-bar size indicator turns error-colored (`78×22 < 80×24`) and
  `F2` fullscreen shows the true-size view. Rendering never blanks out — flexbox
  simply squeezes.

### 8.3 Backlog (post-1.0)

Daemon + IPC, workspace package split, MCP-based agent interface (tool calls into a
running termcraft instead of the staging contract), additional agent backends
(Gemini CLI behind the same interface), spatial canvas boards, agent-defined
palettes/themes, multi-project workspaces + user-level defaults for new projects,
  Git revision compare (change highlighting between snapshots), chat management extras
(rename, deletion/archival, AI-generated chat titles), file watching / reload of
external edits, keyboard element navigation (selection and pins without a mouse),
  interactive codemod tooling beyond the required runtime migrations, a typecheck toolchain inside staging
so agents can self-check before ending a turn, and OS-level sandboxing of the design
host where platforms allow it. A separate command palette
is no longer planned — the slash menu (§3.10) is that view over the action table.

## 9. Error handling

- **Agent missing / not logged in** → clear message with install instructions; checked
  in the background at startup and before each send. The Home error state offers `r`
  to re-run the health check without restarting.
- **Codex sandbox degraded (Windows)** → the health check write-probes the sandbox;
  a silent `workspace-write` → read-only downgrade is reported as an explicit error
  with the config fix, instead of turns that mysteriously change nothing (§6.1).
- **Gate-rejected turn** → automatic retry with the errors in context (≤3), then an
  honest error in chat. Canonical sources are untouched; the unique turn workspace
  is discarded or quarantined and never reused.
- **Cancelled / hung generation** → the SDK run is aborted on `Esc`, after stream
  inactivity (no events for 120 s), or at the non-resettable absolute deadline;
  cancellation completes only after process-tree exit is confirmed. Once durable
  commit intent exists, the UI shows finishing-save and recovery must roll forward.
- **Design host crash or hang** → the supervisor kills and restarts the host within
  a bounded restart budget; backoff and a circuit breaker stop crash loops. The
  preview region shows an error panel with the failure (compile error text, crash
  stack) while the rest of the app keeps working. A canonical Current source that
  no longer loads remains visible as broken state; after confirmation the user may
  send it to the agent for repair. Termcraft does not silently substitute a previous
  Git object or mutate Current source.
- **Untrusted project** → the trust prompt (§3.1), keyed by canonical path,
  filesystem/project identity, and Git identity when available; declining leaves the
  project ready but untrusted/read-only with chat and history visible, rendering and
  export disabled, and the lease held until explicit close. The `termcraft export`
  CLI form reports the same trust refusal (§3.7).
- **Corrupt or too-new data file** → error naming the file. JSONL loads only its
  valid prefix; a transaction-proven partial final append is repaired, unproven
  trailing bytes require explicit recovery, and mid-file corruption is fatal.
- **Terminal too small for the app frame** → "enlarge the window" placeholder screen.
  (A preview merely smaller than the page's `minSize` is the status-bar warning of
  §8.2, not this placeholder.)
- **Second instance** → an OS-held `ProjectLease` refuses politely. PID metadata is
  diagnostic only; no lock is removed as stale from PID alone.
- **Panic-equivalent** → a top-level exception handler restores the terminal (raw
  mode off, mouse capture off, alternate screen exited) and prints the failure. The
  user's terminal is never left broken.

## 10. Testing
- `runtime`: component snapshot tests via the private headless renderer (runtime fixture →
  `captureCharFrame` → golden), token/theming units.
- `gate`: fixtures of invalid and hostile page sources (bad imports, missing meta,
  type errors, render crashes) → exact error output; id-lint and warning cases.
- `host`: protocol contract tests — fragmented/oversized frames, handshake,
  request ids, frame sequencing, bounded slow-consumer behavior, input forwarding,
  watchdog/backoff/circuit-breaker behavior — against scripted pages; determinism
  test: same page + size +
  theme → byte-identical snapshot and layout tree across fresh host runs.
- `agent`: backends against SDK fakes — event-stream normalization (scripted
  vendor events → the exact expected `AgentEvent` sequence, per backend), session
  resume/checkpoint/workspace-rebind fallback, confinement configuration, fencing,
  confirmed process-tree cancel, silence and absolute deadlines.
- `store`: migration fixtures and verified backups (§7.2); UUIDv7 records, JSONL
  valid-prefix recovery, `SafeProjectFs`, OS lease, trust-subject reads, and
  transaction fault injection after every durability boundary.
- `core`: versioned Command/Result/Event contract tests, transition tables,
  capability/guard parity, stale revisions, duplicate command ids, late-event
  filtering, commit-during-turn CAS, retry, and no-change pipelines.
- `ui`: action-table units — local applicability combined with Kernel capabilities,
  hotkey resolution through the two tiers, status-bar hints and slash-menu dimming
  derived from the same entries; markdown-lite rendering units and ephemeral
  status-block snapshots (turn running, gate retry, collapse into the persisted
  record).
- Smoke: app driven on a scripted terminal with injected events (open project →
  prompt → fake agent edits staging → gate → render → export).

## 11. Success criteria (MVP)

From an empty directory: `termcraft` → the Home prompt opens → "a system monitor
dashboard" → Enter creates `.termcraft` (the project) → Codex writes page code →
live render via the design host → right-click pin "make this gauge red" → send →
the canonical Current design updates recoverably → `Ctrl+E` → the export package —
`design-prompt.md`, TSX sources,
multi-size ASCII snapshots, layout trees — that a coding agent can implement from
without seeing termcraft. Relaunching in the same directory
reopens the Workspace with chat and design intact.
