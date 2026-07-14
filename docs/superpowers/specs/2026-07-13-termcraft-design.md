# termcraft — Design Spec

Date: 2026-07-13
Status: approved for planning

## 1. Overview

termcraft is a terminal-native analog of Claude Design for TUI applications. The user
describes an interface in natural language; a locally installed CLI agent (Codex first,
Claude Code later) generates a declarative design description; termcraft renders it live
in the terminal. Iteration happens through chat; the mouse is used to select elements,
pin comments, and flip state tweaks. The final deliverable is an export package: a
prompt file describing the interface plus the exact DSL files, ready to be fed to a
coding agent that implements the real application.

Core principles:

- **Pure AI generator.** No manual WYSIWYG editing. All changes to design content —
  page documents, their elements, geometry, styles — go through the agent. The mouse
  annotates and inspects; it never edits geometry directly. Project structure (page
  order, titles, removal) is ordinary bookkeeping, manageable from both the UI and
  agent operations.
- **No API keys.** Agents are driven through their locally installed CLIs in headless
  mode, using whatever auth the user already has.
- **Local-first storage.** Everything lives in a `.termcraft/` folder in the directory
  where termcraft is launched, so designs sit next to the code they describe and are
  committed to the same repository. One `.termcraft/` holds exactly one project — the
  design of this codebase's TUI. Separate tools (e.g. in a monorepo) get their own
  folders; design experiments are git branches.
- **Data outlives binaries.** Every stored file carries a format version; migrations are
  part of the architecture from day one.

## 2. Non-goals (v1.0)

- Manual drag/resize editing of elements.
- Spatial multi-frame canvases (Figma-style boards). The model is a flat list of pages.
- Code generation (ratatui/bubbletea source output). The export is a prompt + DSL.
- Daemon mode and multi-client operation (architecture must allow it later, see §4).
- Agent-side diffs/patches; the agent always returns full page documents.
- Data-driven logic in prototypes (real lists, conditions, arithmetic). Simulated
  interactivity only.
- Multi-project workspaces: one `.termcraft/` is one project (§3.1); a global user
  config is backlog.
- Watching for external file changes while running; termcraft is the folder's single
  writer (§7.1).
- Keyboard-driven element selection and pin placement; selection and pins are
  mouse-only in v1.0 (§3.2).

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
  combo (`m` or a mouse click opens the picker, §3.6). Pressing Enter creates
  `.termcraft/` with default config and a project manifest with zero pages, writes
  the first `user` record to the project's first chat (`chats/c1.jsonl`, §3.9), opens
  the Workspace, and starts the first generation. The project name is the prompt's first line truncated to ~60 chars —
  cosmetic only, stored in `project.toml`. A failed first turn rolls none of this
  back: the error lands in chat and the user simply sends the next message. The
  agent CLI check (`codex --version`) runs in the background at startup and shows in
  the status bar; a missing agent produces a clear error on send. MVP has no wizard.
  The v1.0 first-run wizard adds the explicit choices: target stack for exports
  (rust-ratatui | go-bubbletea | generic) and preview defaults.
- Present → the Workspace opens directly with the active chat's history restored
  (§3.9). There is no project picker; separate projects live in separate directories.
- Present but older format → offers bulk migration (see §7).

### 3.2 Workspace

Layout: chat panel on the left (~35%, showing the active chat — §3.9), live preview
on the right, status bar at the bottom (agent name, page + version, preview size,
mode, context usage (§3.9), hotkey hints). Page tabs above
the preview. `F2` toggles fullscreen preview. With zero pages (a brand-new or
all-failed project) the preview shows an empty-state placeholder ("No pages yet —
describe what to build") and the tab strip is empty.

While the agent works, its status streams into the chat; the preview updates when a new
version is applied. Generation is cancellable (`Esc`, per the focus rules in §3.8).
Typing the next message while a turn runs is allowed, but sending is disabled (the
status bar hints why) — there is no message queue. Version switching, rollback,
export (§3.7), the agent picker (§3.6), and chat creation and switching (§3.9) are
locked while a turn runs; each refused action hints why in the status bar.

Mouse in the preview:

- **Hover** (static mode) highlights element boundaries.
- **Left click** (static mode) selects an element (deepest hit); a chip like
  `chart "CPU Usage"` is attached to the chat composer, so "make it blue" reaches the
  agent with context. `Esc` deselects. The selection is stored as (page, element id);
  the rect is recomputed every frame. It survives version switches while the id
  resolves in the viewed version and is silently cleared when the element disappears;
  switching page tabs clears it. The chip is included in the prompt only if the id
  resolves in the active page's head at send time.
- **Right click** (works in both modes, §3.5) drops a **pin comment**: a mini input
  opens at the click point over a dimmed preview (§3.8); the comment is stored
  anchored to (element id, fractional position fx/fy ∈ [0..1] inside the element's
  rect) and shown as a numbered pin on the preview and as a list in the chat panel.
  On render the pin sits at `rect.origin + (fx·width, fy·height)`, clamped inside the
  rect — pins stay proportionally where they were dropped when the element resizes.
  Open pins whose anchor resolves are sent with the next message; pins attached to a
  successfully applied message are marked resolved (user can reopen them).

Pins are anchored to element ids, not versions. A pin is drawn on the preview only
when the viewed version contains its element; otherwise it disappears from the preview
but stays in the chat panel's pin list with an orphan marker ("element missing in
v3"). Orphaned pins are never deleted automatically and are skipped when sending to
the agent.

Selection and pins are mouse-only in v1.0; keyboard element navigation is backlog
(§8.3).

### 3.3 Pages

Project → **Pages** (one design screen each) → per-page version history. Tabs switch
pages. The agent manages pages itself through operations (§6): it can add a "Settings"
page, edit the active one, rename, reorder or remove pages. Removal only unlists — the
page's files stay on disk, and adding the same slug resurrects its history (§6.2). In
v1.0 pages are also formally linked by `goTo` interactions, forming a clickable
prototype flow.

### 3.4 Versions

Every applied agent turn creates exactly one new `vN.json` for each page it changed —
versions map 1:1 to chat messages, and each turn's record in the chat log carries an
`applied` map (`{"main": 5}`) linking the message to the versions it produced. The
head of a page is simply its highest version; there is no head pointer.

Browsing is free: `[` / `]` switch prev/next version read-only, the status bar shows
a caution-tinted `vN/total ‹read-only›`, nothing is written. `Enter` (with no text
input focused) jumps back to head; `Esc` exits browsing the same way (§3.8). Sending
a message while viewing a non-head version first auto-rolls that version back to
head — the agent always edits what the user sees.

Rollback ("make v3 the head") copies v3 forward as the new highest version — history
stays linear and append-only, nothing is deleted (the git-revert model). Rollbacks,
auto or explicit, are recorded as system entries in the chat. MVP: `[` / `]` switching
only. v1.0: a history popup — opened with `v` or by clicking the version segment in
the status bar (the same pattern as the agent chip and `m`, §3.6) — listing versions
with timestamps and prompt excerpts (found by scanning the project's chats for the
agent record whose `applied` map names the version), with explicit rollback.
It renders over the dimmed workspace (§3.8) and is locked while a turn runs (§3.2).

### 3.5 Interactive prototype (v1.0)

`F4` toggles static ↔ interactive mode. In interactive mode clicks drive the design
instead of selecting: buttons fire their `interactions`, tabs switch (via their
`<id>.active` variable, §5.5), menus/dialogs open and close, `goTo:` navigates between
pages, focus traverses with `Tab` in document order (depth-first over elements with
`bind` or `interactions`; `Shift+Tab` reverses), and bound inputs accept real typing
with Enter firing `submit`. `F3` opens the Tweaks panel (§5.6) in either mode.
Right-click pin comments keep working in interactive mode — the user can annotate
mid-flow. A `goTo:` whose target page has since been removed is a no-op with a
quiet notice above the composer (per the UI reference).

### 3.6 Agent · model · effort picker (v1.0)

Pressing `m` (Home or Workspace, when no text input is focused — §3.8) or clicking
the status-bar chip / Home inline selectors opens a popup over the dimmed screen
listing selectable (agent, model, reasoning effort) combinations — one row each,
current choice marked. The chosen triple is stored in `config.toml` and shown as a
chip in the status bar everywhere (`codex · gpt5.5 · high`) and as inline selectors on
the Home prompt. On Home, before `.termcraft/` exists, the choice is held in memory
and written to `config.toml` when the project is created. Each `AgentBackend` reports its available models/efforts and maps the
triple to its CLI flags. Switching agent or model starts a fresh agent session (§6.2);
chat history is unaffected. While a turn runs the picker is locked (§3.2).

### 3.7 Export

`Ctrl+E` (or `termcraft export`) writes to `.termcraft/export/`:

- `design-prompt.md` — implementation prompt: product overview, per-page structure and
  behavior, interactions and tweak states, theme/palette, recommended libraries for the
  configured target stack, and an ASCII snapshot of each page rendered by termcraft
  itself at the page's `minSize` (deterministic — independent of the current preview
  size or theme override).
- `pages/*.json` — the exact head-version DSL files (machine-readable source of truth).

Re-export silently overwrites `export/` in place: exports are derived data, and their
history is git's job. Export is refused while a turn runs (§3.2) and when the project
has zero pages — both hinted in the status bar.

### 3.8 Focus and hotkeys

Hotkeys come in two tiers:

- **Global** — `F2`/`F3`/`F4`, `Ctrl+E`, `Ctrl+P` (preview controls popup: theme
  override and size presets, §8.1 items 9–10): work always, even while a text input
  is focused.
- **Single-char** — `m`, `v` (version history popup, §3.4), `[`, `]`, arrow
  navigation, `r` (re-check agent health, on the Home agent-error state): work only
  when no text input is focused.

All popups (the picker, the pin input, preview controls) render over a dimmed
backdrop, so their inputs never blend with the design underneath. In the preview
controls popup the `custom` size preset expands an inline `W×H` input (`100x30`,
`100 30`, and `100×30` all parse); Enter applies, invalid input shows an inline error
and applies nothing; the last custom size is remembered in `config.toml`.

Exactly one widget owns focus. The Home prompt is focused on entry; the Workspace
composer is focused by default; `Tab` cycles focus between the composer and the
preview. Anything reachable by a single-char hotkey is also reachable by mouse.

`Esc` follows a strict layered priority — one press pops the topmost layer:

1. an open popup (picker, history, pin input, preview controls) → close it;
2. a focused text input → unfocus;
3. an active version-browse view (§3.4) → return to head;
4. a running generation → cancel it;
5. a selected element → deselect.

### 3.9 Chats

A project holds one or more **chats** — independent conversation lines over the same
pages. A chat is only a conversation: switching chats swaps the visible history and
the agent session (§6.2) and touches nothing else — active page, preview state,
selection, and pins all stay put. Pages are shared state; whichever chat sends the
next message sees the current heads, and the prefetch and unseen-head guard
(§6.2–6.3) already handle edits made from another chat exactly as they handle
rollbacks. One turn runs at a time per project regardless of chat; system records
(rollbacks, errors, cancellations) land in the chat that was active when they
happened.

Starting a new chat is the context-reset gesture: a fresh chat file and a fresh agent
session, no carried context. termcraft never trims or compacts a conversation itself —
the CLI owns its own context management, and the context budget is the user's call.
The status bar's context-usage segment is the prompt to make that call: it is fed by
token usage the backend reports in its event stream (§6.1), and a backend that
reports nothing simply hides the segment.

Chat ids are termcraft-assigned (`c1`, `c2`, …, create-new semantics like version
files). A chat's display name is derived, not stored: the first line of its first
`user` record, truncated to ~60 chars (the project-name rule, §3.1).

MVP ships the full storage model plus minimal management: create a new chat and
switch between existing ones. The exact management surface (list layout, hotkey,
status-bar affordance) is deliberately unspecified here — it lands with the next
UI-reference iteration (`design/`, §3), following the existing popup pattern
(§3.6, §3.8). Rename, deletion, and AI-generated titles are backlog (§8.3).

## 4. Architecture

Single binary crate, Rust + ratatui + crossterm + tokio. Elm architecture in the UI
(Model / Msg / update / view). Strict module boundaries; each module is extractable
into a workspace crate later without rewrites:

- `dsl` — design document types, serde models, JSON Schema, validation, format version.
- `render` — DSL → ratatui: layout engine, widget drawing, color degradation
  (truecolor → 256 → 16), and **hit-testing** (per-frame map `element id → Rect`,
  click → deepest element).
- `agent` — `AgentBackend` trait (start task, stream events, cancel) + `CodexCli`
  implementation (MVP); `ClaudeCli` later. Spawns CLI processes; no API keys.
- `store` — everything under `.termcraft/`: the project manifest, pages, versions,
  comments, chats, config; atomic writes (tmp + rename); the migration registry (§7).
- `core` — the kernel: accepts **Commands** from the UI (create project, send message,
  switch version, toggle tweak, export…), orchestrates agents, applies operations,
  emits **Events** (agent status stream, version applied, error…).
- `ui` — ratatui app: Home and Workspace screens, mouse/keyboard handling, Tweaks
  panel, pins. All user-triggerable actions are declared in a single **action
  table** — `id`, label, hotkey, `available(state)` predicate, and the Msg/Command
  it dispatches. The keyboard handler resolves keys through this table (honoring
  the two hotkey tiers of §3.8, including the turn-time locks), and the status-bar
  hint row renders from it — an action's availability decides whether its hint
  shows or dims. Nothing binds a key or checks a lock anywhere else. A future
  command palette (backlog, §8.3) is just another view over the same table.

**The kernel boundary is the future IPC.** UI and core communicate exclusively through
a pair of async channels (`Command` → core, `Event` → UI). When daemon mode arrives,
this contract becomes the wire protocol and the UI does not change. Terminal events and
core events merge in a single tokio select loop.

Diagram: [`docs/architecture/modules.md`](../../architecture/modules.md) — module
graph with the kernel boundary marked as the future IPC.

## 5. The design DSL

Goals: trivial for an LLM to emit reliably; deterministic to render; every element
addressable (selection, pins, diffs); able to draw "anything" via an escape hatch.

### 5.1 Page document

```json
{
  "schemaVersion": 1,
  "page": "main",
  "title": "Dashboard",
  "minSize": { "w": 80, "h": 24 },
  "theme": "dark-default",
  "tweaks": [],
  "root": { "id": "root", "type": "column", "children": [] }
}
```

### 5.2 Elements

Every node: `id` (required, stable — the agent is instructed to preserve ids of
surviving elements across iterations, otherwise pins and selection would detach),
`type`, `label`, `layout`, `style`, `children`, plus the reactive fields of §5.5.

Catalog:

| Tier | Elements |
|------|----------|
| MVP containers | `row`, `column`, `panel` (border + title), `tabs` |
| MVP primitives | `text` (styled spans), `button`, `input`, `list`, `table`, `gauge`, `sparkline`, `separator`, `spacer` |
| MVP escape hatch | `canvas` — rows of styled character runs (text + fg/bg) for ASCII art, logos, custom widgets |
| v1.0 additions | `modal`, `menu`, `tree`, `progress`, `chart` (bar/line), scroll container |

Content fields per element:

| Element | Fields |
|---------|--------|
| `text` | `text: string \| span[]` — a span is `{ "text": "…", "style": {…} }`; an array mixes styles inline |
| `button` | `label` |
| `input` | `label`, `placeholder`, `text` (initial value), `bind` (§5.5) |
| `list` | `items: string[]` |
| `table` | `headers: string[]`, `rows: string[][]` |
| `gauge` | `value: 0..100` |
| `sparkline` | `data: number[]` |
| `tabs` | children are the tabs (tab title from `label`), `active` — the **id** of the initially active tab child (id, not index — stable across reorders, matches `<id>.active`, §5.5) |
| `canvas` | rows of runs `{ "text": "…", "fg": …, "bg": … }` |

The JSON Schema shipped with the `dsl` module is generated from these types and is the
machine-readable contract; this table normalizes the semantics.

Unknown fields are ignored with a warning during validation (forward compatibility on
top of the migration system).

### 5.3 Layout

Mirrors ratatui's model 1:1 (LLMs handle it well): containers split their area among
children with constraints — `"30%"`, `12` (fixed cells), `"fill"`, `"min:10"` — plus
`padding`. Direction comes from the container type (`row` / `column`); alignment is
expressed with `spacer` elements and constraints. `padding` is either a number
(uniform) or `{"x": …, "y": …}` (per-axis — the common horizontal-only case in a 2:1
cell grid); there is no per-side form — asymmetry is expressed with `spacer`s.

### 5.4 Styles and themes

Elements reference **palette roles** — the closed set: `background`, `surface`,
`text`, `text-muted`, `text-faint`, `border`, `primary`, `accent`, `selection`, `ok`,
`error`. Unknown role names are validation errors. Themes come from a built-in
registry: `dark-default` (MVP; palette values from the UI design file) and
`light-default` (v1.0). A theme is a named palette bound at page level via the `theme`
field; switching themes never touches the tree, and the preview theme switcher
(§8.1) is a non-persistent override for checking — it never rewrites the document.
Agent-defined palettes are backlog (§8.3); until then raw hex values are the escape
hatch. The renderer degrades colors to the terminal's capability. Style fields: fg/bg
(role or hex), modifiers (bold, dim, italic, underline), border (none | plain |
rounded | double | thick; default rounded). `border` is meaningful on `panel` and
`input`; `none` suppresses the frame — a borderless panel renders its `label` as a
muted header line above the content, a borderless input renders as a single
`label value` line with the value underlined. On other elements `border` is ignored
with a validation warning.

### 5.5 Reactive variable system (v1.0)

One **variable store per page**: `map<name, bool | string>`. It is session runtime
state — never written into `vN.json`, reset on version switch.

Variables are implicit — there is no declaration block; a variable exists by being
referenced. Initial values resolve in priority order:

1. a tweak's `default`, if a tweak declares the variable (§5.6);
2. element-derived initials: an input's `text` initializes its bound variable, a tabs'
   `active` initializes `<id>.active`, and visibility auto-variables (`<id>.visible`)
   default to `false` — dialogs and menus start hidden;
3. otherwise the type's zero: `false` / `""`.

Everything that "moves" in a prototype reads and writes this single map:

- **Conditions.** `visibleWhen: {"var": "show-error"}` or
  `{"var": "density", "equals": "compact"}` (plus `"not": true`) controls element
  visibility — the mechanism behind initially hidden dialogs, menus, dropdowns, error
  banners. A bare `{"var": …}` means truthiness: `true` for bools, non-empty for
  strings.
- **Overrides.** Per element: `overrides: [{"when": {…}, "style": {…}, "text": "…"}]` —
  an error state can recolor an existing input's border, not just reveal hidden nodes.
- **Interactions.** Per element: `interactions: [{"on": "click" | "submit",
  "action": "…"}]` with actions `goTo:<page>`, `open:<id>`, `close:<id>`,
  `toggle:<id>`, `set:<var>=<value>`. In `set:`, the values `true`/`false` parse as
  bools; anything else is a string.
- **Bound inputs.** `input` may declare `bind: "<var>"`. In interactive mode the input
  is real: click/Tab focuses it, typing writes the variable (visible live anywhere the
  variable is referenced), Enter fires the `submit` interaction.

**Element runtime state lives in the same map, as auto-variables.** A widget with
runtime state exposes it under `<element-id>.<slot>`: tabs keep their active tab in
`<id>.active` (the value is the child element's id — stable across reorders; the
doc's `active` field is only the initial value), visibility sugar uses `<id>.visible`.
`bind` overrides the auto-name. Conditions, overrides, and tweaks reference these like
any variable — a hint can appear only on the Settings tab. Keyboard focus is UI
chrome, not part of the map.

**`open:<id>` / `close:<id>` / `toggle:<id>` are pure sugar:** they expand to
`set:<id>.visible=true/false/invert`. If the target element declares no `visibleWhen`
of its own, it implicitly gets `visibleWhen: {"var": "<id>.visible"}` — the common
"button opens dialog" case needs zero boilerplate, and the dialog starts hidden. If
the target declares a custom `visibleWhen`, the sugar does not try to inverse-solve
it — validation warns, and the agent should use `set:` directly.

Variable hygiene is lint, not errors (§6.3): a variable read but never written (no
tweak, no `set:`, no `bind`), or written but never read, produces a warning fed back
to the agent — the typical typo surfaces on the next turn.

Because rendering is immediate-mode, reactivity is simply "re-render the frame after
every mutation"; conditions are evaluated during render. No dependency graph.

Diagram: [`docs/architecture/flows/interactive-prototype.md`](../../architecture/flows/interactive-prototype.md) —
three mutation sources feeding one variable map, read by the render pass.

### 5.6 Tweaks (v1.0)

Declared per page; each tweak is a labeled control over the same variable map:

```json
{ "id": "density", "label": "Density", "kind": "select",
  "options": ["comfortable", "compact"], "default": "comfortable" }
```

Kinds: **toggle** (bool), **select** (enum string), **text** (free string, typically
bound to the same variable as some input, e.g. to preview long/empty/cyrillic values).
The Tweaks panel (`F3`) lists these controls, mouse-clickable. Tweak controls, design
interactions, and bound inputs all mutate variables through the same
`core` code path — three doors into one room.

### 5.7 Rendering determinism

Rendering is a pure function of (document, area, theme): the same input produces a
byte-identical buffer, which is what makes the export snapshots (§3.7) reproducible.
Only `text` wraps (word wrap, spaces preserved); every other content field — button
labels, list items, table cells, input values, tab and panel titles, canvas rows —
renders on a single line hard-clipped at its area boundary, no ellipsis.

## 6. Agent integration

### 6.1 Backend abstraction

```rust
trait AgentBackend {
    fn start(&self, task: AgentTask) -> AgentRun;  // streams AgentEvent
    fn cancel(&self, run: &AgentRun);
    fn health_check(&self) -> Result<AgentInfo>;   // installed? logged in?
}
```

MVP implementation: **Codex CLI** in headless mode (`codex exec`, JSONL event stream on
stdout, session resume for conversation continuity; sandbox read-only — the agent needs
no file access, exact flags verified during implementation). Claude Code CLI becomes
the second backend once/if its terms permit headless embedding; the trait is designed
against it from the start.

`AgentTask` carries the configured (model, reasoning effort) from the picker triple
(§3.6); each backend maps them to its own CLI flags and reports which combinations it
supports.

The `AgentEvent` stream also carries the backend's reported token usage when the CLI
emits it; this feeds the status bar's context-usage segment (§3.9). Reporting is
optional per backend — no usage events, no segment.

### 6.2 Task protocol

Each turn termcraft sends: role system prompt (TUI designer), the DSL JSON Schema and
output rules, the project manifest (pages with titles, head version numbers, active
page), the full DSL of the **active page**, the current selection, open pins (only
those whose anchors resolve), and the user message. If the combined size of all pages'
head documents is small (≈32 KB — an implementation constant, checked per turn), all
pages are prefetched into the prompt; prefetch policy is a per-turn decision, not a
protocol mode.

The agent replies with a JSON **operations list** — the same shape as kernel commands:

```json
{ "ops": [
  { "op": "read_page",       "page": "settings" },
  { "op": "add_page",        "page": "settings", "title": "Settings", "doc": { } },
  { "op": "update_page",     "page": "main",     "doc": { } },
  { "op": "remove_page",     "page": "old" },
  { "op": "rename_page",     "page": "main", "title": "Overview" },
  { "op": "reorder_pages",   "order": ["main", "settings"] },
  { "op": "set_active_page", "page": "settings" }
] }
```

`doc` payloads are full page documents (no diffs in v1.0). `op.page` must equal
`doc.page`; a mismatch is a validation error. `reorder_pages` must list a permutation
of the manifest.

**Read-before-edit.** A response consisting of `read_page` ops continues the turn:
termcraft replies (via session resume) with the requested head documents and waits for
the next response — at most 3 read rounds per turn, then an honest error. A response
consisting of mutation ops ends the turn; mixing reads and mutations is a validation
error. termcraft tracks which head version of each page the agent has seen — in
memory, per agent session — via prefetch, `read_page`, or authorship of an applied
`update_page`. An `update_page` against a page whose current head the agent has not
seen fails validation ("page changed since last read — read it first") and enters the
retry loop. `add_page` and the metadata ops (`rename_page`, `reorder_pages`,
`remove_page`, `set_active_page`) require no read.

`remove_page` only unlists the page from the project manifest; its directory
(versions, comments) stays on disk, invisible to the UI, export, and validation.
The manifest is the protocol's universe: every op except `add_page` must name a page
currently in it — an unlisted slug is an "unknown page" validation error. `add_page`
with the same slug is the only door back: the page returns to the manifest and
version numbering continues where it left off.

Page slugs are agent-chosen and validated: `^[a-z0-9][a-z0-9-]{0,31}$`, minus
Windows-reserved device names (`con`, `nul`, `aux`, `prn`, `com1`–`com9`,
`lpt1`–`lpt9`) — a slug is a directory name on disk. The mask is stated in the
system prompt; a violation is a normal validation error.

The turn's context (active page, selection, pins) is snapshotted at send time —
switching tabs mid-turn does not change what the agent sees. Tab switching stays
free while a turn runs (it is read-only); on apply, the UI moves to another page
only on an explicit `set_active_page` — `add_page` alone does not switch, and
without the op the user stays on whatever tab they are viewing.

**Sessions.** Conversation continuity uses the CLI's session resume; each chat (§3.9)
has its own session, and the chat → session id map is stored in a local, non-versioned
file (§7.1). Switching chats resumes that chat's session. If resume fails (stale
session, another machine, switched backend), termcraft silently starts a fresh session
and includes a short excerpt of the recent chat for continuity (the last N
`user`/`agent` records from that chat's log; N is an implementation constant).
Switching agent or model starts a fresh session for the active chat — other chats'
stored session ids simply fail resume later and take the same fallback. The
seen-versions map resets with any fresh session. After a termcraft restart the map
starts empty — safe by construction, and cheap because the active page is always sent.

### 6.3 Validation and application

Response → JSON parse → schema validation → semantic checks (unique ids, pages known
to the manifest for every op except `add_page`, the page slug mask, `op.page` =
`doc.page`, the unseen-head guard, unknown palette roles, `tabs.active` naming one of
the element's children, `open:/close:/toggle:` targets existing in the same document,
`goTo:` targets present in the manifest as it stands after the whole ops list).
Variable hygiene (read-but-never-written, written-but-never-read, sugar targeting a
custom `visibleWhen`) produces warnings fed back to the agent, not errors — as do
`border` on non-bordered elements and a `remove_page` that leaves dangling `goTo:`
references on other pages.
Invalid → automatic retry with the validation errors appended to the prompt (one
initial attempt plus at most 3 retries), then an honest error in chat. Valid → ops
applied atomically by the kernel; each changed page gets exactly one new `vN.json`
written via tmp + rename. The last valid version is never lost.

Diagram: [`docs/architecture/flows/generation-turn.md`](../../architecture/flows/generation-turn.md) —
the full turn from user message to applied version, including the retry loop.

## 7. Storage and data versioning

### 7.1 Layout

```
.termcraft/
  .gitignore                  # written by termcraft: lock, *.local.toml, backup-*/
  config.toml                 # format_version, agent+model+effort, target_stack,
                              #   preview defaults (incl. last custom size, §3.8)
  lock                        # single-instance lock file (holds the owner's PID)
  project.toml                # format_version, name, dates, ordered pages, active page,
                              #   active chat
  chats/c1.jsonl … cN.jsonl   # dialog logs, one file per chat (record schema below)
  session.local.toml          # chat → agent session id map — machine-local, never committed
  pages/<page>/
    v1.json … vN.json         # page documents (schemaVersion inside)
    comments.jsonl            # pins (record schema below)
  export/
    design-prompt.md
    pages/*.json
```

All plain text. Files matched by the generated `.gitignore` (`lock`, `*.local.toml`,
`backup-*/`) are machine-local state; everything else diffs and commits alongside the
target project's code. There is no global user config; per-project `config.toml` is
the only configuration (a `~/.config/termcraft` with defaults for new projects is
backlog, §8.3).

The chat list is the directory scan of `chats/` ordered by id; `project.toml` names
the active chat, and a dangling reference falls back to the newest chat on disk (or a
fresh `c1` when none exist). Each chat file starts with the header
`{"kind":"chat","version":1}`, then one record per line, each with an ISO 8601 `ts`:

- `{"kind":"user", "text", "selection"?, "pins":[…]}` — exactly what was sent to the
  agent: the message, the selection chip's element id, the ids of the pins included.
- `{"kind":"agent", "text", "applied":{"<page>": N}}` — the agent's final message and
  the versions the turn produced (empty map if the turn failed). Streaming status
  (reasoning, command execution) is ephemeral UI and is never persisted.
- `{"kind":"system", "event":"rollback"|"error"|"cancelled", "text"}` — rollbacks
  (auto and explicit), honest post-retry errors, cancellations.

`comments.jsonl` starts with `{"kind":"comments","version":1}`; pin records are
`{"id", "element", "fx", "fy", "text", "status":"open"|"resolved", "ts"}` (§3.2).

A running termcraft is the folder's single writer: external modifications (a
`git pull`, a manual edit) while it runs are unsupported — restart to pick them up;
file watching is backlog (§8.3). As a data-loss guard, version files are written
create-new: if `vN.json` unexpectedly exists, termcraft rescans the directory and
writes the next free number — with append-only history the worst case is a duplicate
version, never an overwrite.

### 7.2 Format versioning and migrations

- Every JSON file carries top-level `schemaVersion`; every JSONL file starts with a
  typed header line; every TOML carries `format_version`. Each file kind has its own
  independent counter.
- `store::migrate` holds an ordered registry of `N → N+1` steps per file kind. Reading
  any old file runs the chain to the current in-memory model; writing always emits the
  current version.
- Triggers: lazily on read, plus explicit `termcraft migrate` for the whole folder; the
  wizard offers bulk migration when opening an old `.termcraft`. Bulk migration backs
  up to `.termcraft/backup-<timestamp>/` first (or just warns if the folder is under
  git).
- A file *newer* than the binary understands → hard error naming the file ("update
  termcraft"), no partial reads. Downgrades unsupported.
- Tests keep fixtures of **every historical version** of every file kind and run them
  through the chain, validating against the current schema.

## 8. Feature scope

### 8.1 v1.0

1. Home: prompt input when no project exists; an existing project opens straight
   into the Workspace (§3.1).
2. `.termcraft` wizard: setup, agent health check, target stack, bulk migrations.
3. Workspace: chat + live preview, `F2` fullscreen, status bar.
4. Agents behind `AgentBackend`: Codex CLI (primary); Claude Code CLI second, terms
   permitting.
5. Full DSL catalog incl. `modal`, `menu`, `tree`, `progress`, `chart`, scroll.
6. Mouse: hover highlight, click-select with composer chip, right-click pin comments.
7. Multiple pages with tabs; agent-driven page operations; page rename/remove/reorder
   from the UI.
8. Per-page version history popup (`v` / click the version segment; timestamps,
   prompt excerpts) with explicit rollback.
9. Preview palette/theme switching (light/dark, 16/256/truecolor simulation).
10. Preview size presets: 80×24, 120×40, custom (inline `W×H` input, §3.8), auto.
11. Interactive prototype: focus traversal, `goTo` page transitions, open/close/toggle
    for menus/dropdowns/dialogs, bound inputs with typing + Enter, Tweaks panel with
    toggle/select/text controls over the reactive variable store.
12. Export: `design-prompt.md` + DSL files + ASCII page snapshots.
13. Agent · model · effort picker (`m`): popup selection, status-bar chip, inline
    selectors on Home (§3.6).
14. Multiple chats per project (§3.9): new chat, chat switching and list, per-chat
    agent sessions, status-bar context-usage segment.

### 8.2 MVP cut

- Home prompt when no project exists; `.termcraft` created lazily on the first
  prompt, with default config (target stack `rust-ratatui`); an existing project
  opens straight into the Workspace; background agent presence check (no wizard).
- Workspace: chat + preview + status bar + `F2`. Codex only with its default model; no
  picker UI, but the (agent, model, effort) triple already lives in `config.toml` so
  the format needs no migration when the picker lands.
- Multiple pages with tabs; agent ops `add_page` / `update_page` / `set_active_page`;
  every turn prefetches all pages (MVP projects sit under the size threshold), so
  `read_page` and the seen-version guard land with v1.0.
- DSL without the reactive system (§5.5–5.6 fields reserved): MVP catalog of §5.2, one
  dark theme, color degradation.
- Mouse: hover, click-select, right-click **pin comments** (explicitly in MVP).
- Versions written from day one; `[` / `]` prev/next switching; sending from a
  non-head view auto-rolls back (§3.4).
- Multiple chats (§3.9) from day one: the `chats/` layout, new-chat command, and chat
  switching, with per-chat CLI sessions and the context-usage status segment. The
  management surface stays minimal (the §3.9 open point); rename, deletion, and AI
  titles are backlog.
- Export: `design-prompt.md` + DSL + ASCII snapshots (renderer already exists — cheap
  and high-value for the implementing agent).
- Migration infrastructure live from the first commit (even with zero migrations).
- Preview auto-sized to the available area; when it is smaller than the page's
  `minSize`, the status-bar size indicator turns error-colored (`78×22 < 80×24`) and
  `F2` fullscreen shows the true-size view. Rendering never blanks out — constraints
  simply squeeze.

### 8.3 Backlog (post-1.0)

Daemon + IPC, workspace crate split, agent diffs/patches, ratatui code generation,
additional agent backends (Gemini CLI behind the same trait), spatial canvas boards,
agent-defined palettes/themes, multi-project workspaces + a global user config
(`~/.config/termcraft` with defaults for new projects), version compare (change
highlighting between versions), chat management extras (rename, deletion/archival,
AI-generated chat titles), file watching / reload of external edits, keyboard
element navigation (selection and pins without a mouse), command palette
(`Ctrl+Shift+P`): a filterable popup over the `ui` action table (§4) — same entries,
labels, hotkeys, and availability predicates.

## 9. Error handling

- **Agent missing / not logged in** → clear message with install instructions; checked
  in the background at startup and before each send. The Home error state offers `r`
  to re-run the health check without restarting.
- **Invalid agent output** → auto-retry with validation errors (≤3), then chat error.
  Head version untouched; new versions are written atomically post-validation.
- **Cancelled / hung generation** → process killed on `Esc` or after stream inactivity
  (no JSONL events for 120 s); status in chat; project state intact.
- **Corrupt or too-new file** → error naming the file; a broken page version is
  skipped and the project opens at the last valid one.
- **Terminal too small for the app frame** → "enlarge the window" placeholder screen.
  (A preview merely smaller than the page's `minSize` is the status-bar warning of
  §8.2, not this placeholder.)
- **Second instance** → the lock file (holding the owner's PID) refuses politely; a
  lock whose owner process is dead is removed automatically on startup.
- **Panic** → panic hook restores the terminal (raw mode off, mouse capture off) and
  reports via color-eyre. The user's terminal is never left broken.

## 10. Testing

- `dsl`: serde roundtrips, schema validation, migration fixtures for all historical
  versions (§7.2).
- `render`: snapshot tests via ratatui `TestBackend` (DSL fixture → buffer → golden);
  hit-testing unit tests.
- `agent`: JSONL stream parser units over recorded real `codex exec` output; retry,
  read-round, and cancel pipelines against a fake agent.
- `core`: Command/Event contract tests over the channels — doubles as the future IPC
  contract test suite.
- Smoke: app driven on a test backend with injected events (open project → prompt →
  fake agent → render → export).

## 11. Success criteria (MVP)

From an empty directory: `termcraft` → the Home prompt opens → "a system monitor
dashboard" → Enter creates `.termcraft` (the project) → Codex generates pages →
live render → right-click pin "make this gauge red" → send → new version applies →
`Ctrl+E` → `design-prompt.md` + DSL that a coding agent can implement from without
seeing termcraft. Relaunching in the same directory reopens the Workspace with chat
and design intact.
