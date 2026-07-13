# Claude Design prompt — termcraft UI

Design the interface of **termcraft**, a terminal application (TUI) that is an analog
of Claude Design for terminal apps: the user describes an interface in chat, a local
AI agent generates the design, and it renders live right in the terminal. You are
designing the tool itself, not the designs it produces.

## Medium and visual constraints — read first

This is a **terminal UI**. Every mockup must look like a real terminal application and
obey terminal physics:

- Everything sits on a monospace character grid. All sizes are in character cells.
  No pixel-precise elements, no smooth gradients, no rounded corners beyond
  box-drawing glyphs, no font size changes, no shadows.
- Chrome is drawn with box-drawing characters (`┌ ─ ┐ │ └ ┘ ├ ┤`, rounded `╭ ╮ ╰ ╯`),
  block elements (`▂ ▄ █ ▆`), and glyphs (`▸ ▾ ● ○ ⏳ ✓ ✗`).
- Dark theme is the default. Use a restrained palette: one accent color for focus,
  selection, and primary actions; muted grays for secondary text; semantic red/green
  sparingly. Assume 256-color terminal.
- Mouse is fully supported (hover, click, right-click, scroll) alongside keyboard.
- Produce two size variants for key screens: minimal **80×24** and comfortable
  **120×36**.

The app is built in Rust with the ratatui library; components should look like ratatui
widgets: bordered blocks with titles in the border, tab bars, list/table widgets,
gauges, sparklines, one-line status bar at the bottom.

## Screens to design

### 1. Home

- Large centered prompt input: "Describe the TUI you want to design…"
- Below: list of existing projects (name, last updated, page count), arrow/mouse
  navigable, Enter/click opens.
- Bottom status bar with hotkey hints.
- Empty state (no projects yet) and populated state.

### 2. First-run wizard

Shown when the launch directory has no `.termcraft` folder: short steps to create it —
agent check (Codex CLI found / not found), target stack select (rust-ratatui /
go-bubbletea / generic), preview defaults. Design it as a compact centered dialog flow.

### 3. Workspace — the main screen

- Left ~35%: chat with the agent (user messages, agent replies, streamed status while
  generating). Composer input at the bottom of the panel.
- Right: live preview of the current design page.
- Above the preview: page tabs (e.g. `Main │ Settings │ Login`), mouse-clickable.
- Bottom status bar: agent name, page + version (`main · v4`), preview size, mode
  (STATIC / INTERACTIVE), hotkeys (`F2 fullscreen · F3 tweaks · F4 interact · [ ] versions · Ctrl+E export`).

Design these Workspace states:

1. **Idle** — a finished design in the preview (use a plausible example: a system
   monitor dashboard with gauges, a sparkline, a process table).
2. **Generating** — agent status streaming in chat (spinner, step lines), preview
   showing the previous version with a subtle "generating…" indicator.
3. **Element selected** — user clicked an element in the preview: highlighted border
   around it, and a chip in the composer like `▣ gauge "CPU"` showing the next message
   will reference it.
4. **Pin comments** — numbered pins (①②③) anchored on the preview after right-clicks;
   a small popup input at the click point while typing a comment; open pins also
   listed in the chat panel; sent pins shown as resolved.
5. **Tweaks panel open (F3)** — a right-side panel listing state controls:
   toggles (`[x] Error state`), selects (`Density: ‹comfortable›`), text inputs
   (`Search text: [____]`). Flipping one instantly changes the preview (e.g. error
   banner appears, input border turns red).
6. **Interactive mode (F4)** — badge in the status bar; a dropdown menu open inside
   the previewed design; focused input with a visible cursor.
7. **Fullscreen preview (F2)** — chat hidden, thin overlay strip for exiting.
8. **Version history** — switching versions with `[` / `]`; a compact history popup
   (version, time, prompt excerpt, "rollback to this").

### 4. Error and edge states

- Agent CLI not installed / not logged in (message with instructions).
- Agent returned an invalid design after retries (chat error bubble; design intact).
- Terminal window smaller than the design's minimum size (placeholder screen).
- Bulk data migration offer when opening a `.termcraft` from an older version.

### 5. Export

- Export confirmation/summary (what was written where:
  `.termcraft/exports/<project>/design-prompt.md` + page files) — as a toast or a
  small dialog.

## Interaction notes

- Hover highlights element boundaries in the preview.
- Left click = select element; right click = pin a comment; Esc = deselect/cancel.
- Everything reachable by keyboard too; hotkeys shown in the status bar.
- Chat scrolls with the mouse wheel.

## Deliverables

A consistent design system across all screens above: one dark theme, one accent color,
consistent borders/typography/spacing, the same status bar language everywhere. Key
screens (Home, Workspace idle, Workspace with tweaks open) in both 80×24 and 120×36.
