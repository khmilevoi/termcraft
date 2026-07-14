Export turns a design project into a package another coding agent can implement from: an implementation prompt with deterministic text snapshots of every page, plus the exact machine-readable design files.

```mermaid
flowchart TD
    trigger(["Ctrl+E or the export command"]) --> busy{"turn running?"}
    busy -- "yes" --> hint1["refused — status-bar hint"]
    busy -- "no" --> empty{"zero pages?"}
    empty -- "yes" --> hint2["refused — status-bar hint"]
    empty -- "no" --> snap["render each page at its minSize (deterministic, theme-independent)"]
    snap --> prompt["assemble design-prompt.md: overview, per-page structure, interactions, theme, stack advice, snapshots"]
    prompt --> copy["copy head-version design files to export/pages/"]
    copy --> done["export/ overwritten in place — history is git's job"]
```

## Walkthrough

1. Trigger: `Ctrl+E` (a global-tier hotkey — works even while typing) or the CLI export command.
2. Refusal checks, each hinted in the status bar: a running turn, or a project with zero pages.
3. Snapshot rendering: the Kernel calls the Renderer to render every page at the page's declared minimum size, independent of the current preview size or theme override — possible because rendering is a pure function of (document, area, theme), so snapshots are byte-reproducible.
4. `design-prompt.md` contents: product overview, per-page structure and behavior, interactions and tweak states, theme/palette, recommended libraries for the configured target stack, and the ASCII snapshot of each page.
5. `pages/*.json`: exact head-version design documents — the machine-readable source of truth.
6. Re-export silently overwrites `export/` in place: exports are derived data; their history is git's job.
7. Removed pages are unlisted from the manifest and therefore invisible to export.

## Source anchors

- `docs/superpowers/specs/2026-07-13-termcraft-design.md` — §3.7 export package, §5.7 rendering determinism, §3.2 turn-time locks, §6.2 manifest visibility
- `design/13-export-feedback.dc.html` — export feedback states
