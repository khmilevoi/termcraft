Export turns a design project into a package another coding agent can implement from: an implementation prompt, deterministic text snapshots of every page at several terminal sizes, resolved layout trees, and the exact canonical design sources currently on disk.

```mermaid
flowchart TD
    trigger(["Ctrl+E · /export · CLI export command"]) --> trust{"project trusted?"}
    trust -- "no" --> hint0["refused — export executes design code (CLI prints the trust error)"]
    trust -- "yes" --> busy{"turn running?"}
    busy -- "yes" --> hint1["refused — status-bar hint"]
    busy -- "no" --> empty{"zero pages?"}
    empty -- "yes" --> hint2["refused — status-bar hint"]
    empty -- "no" --> source["read every canonical current page.tsx from disk"]
    source --> snap["fresh design host per (page, size): one render, capture frame + layout tree, kill"]
    snap -- "any render or package step fails" --> fail["whole export refused — existing package remains active"]
    snap -- "all captured" --> assemble["assemble prompt, source copies, snapshots, and layout trees"]
    assemble --> publish["publish complete export/ package — history is Git's job"]
```

## Walkthrough

1. Trigger: `Ctrl+E` (a global-tier hotkey — works even while typing), the `/export` slash command in the composer, or the CLI export command.
2. Refusal checks: an untrusted project (export executes design code — the CLI form prints the trust error and points at the TUI), a running turn, or a project with zero pages; in-app refusals hint in the status bar.
   - *Failure:* export is all-or-nothing — if any page fails to render at any export size, or any package file cannot be assembled, the whole export refuses. A render error names the page, size, and failure; a package with a silently missing page would lie to the implementing agent. The previous complete `export/` remains active until a replacement package is ready.
3. Source selection: export reads every listed page's canonical `.termcraft/pages/<slug>/page.tsx` from disk. This is the Current design, including uncommitted changes. A historical preview is only a temporary read-only viewing source and is ignored by export; export never substitutes the page copy at Git `HEAD` or the selected historical commit.
4. Export sizes are a fixed ladder: the page's declared minimum size always, plus 120×40 (also a preview preset — what the user saw is what ships) and 160×40; a standard size is included only when it is at least the minimum on both axes (a page is never rendered below its minimum), and duplicates collapse. Several sizes turn resize behavior into data — the frames show which regions stretch and which stay fixed (the 120×40 → 160×40 step grows width only, isolating horizontal stretch), so the implementing agent never simulates the design's layout engine.
5. Capture: for each (page, size), the Kernel spawns a fresh design host, mounts the captured canonical current source at that size with the page's own theme, renders exactly once at t = 0, captures the frame and resolved layout tree from that same pass — consistent by construction — and kills the host. This is independent of the current preview source, size, and theme override. Determinism comes from the recipe (fresh process, single render pass) plus the design-code rules: kit components suppress animation under the export flag, and timers or randomness outside that guard are Gate warnings.
6. Package contents:
   - `design-prompt.md` — product overview, per-page structure and behavior, interactions and tweak states, theme/palette tokens, recommended libraries for the configured target stack, the embedded minimum-size frame of each page, and instructions framing the snapshot files as acceptance fixtures ("your implementation at 80×24 must render this; diff against it") plus how to read the layout trees.
   - `pages/*.tsx` — exact copies of the canonical current design sources, precise enough for an implementing agent in any target stack to read as a spec.
   - `snapshots/<page>/<WxH>.txt` — one ASCII frame per export size, as separate files so the agent can diff its own render output against them programmatically.
   - `layout/<page>.json` — the resolved layout tree at every export size: per node its id (as declared in the design, else null), kind (kit component or raw element name), computed box in terminal cells, text for text nodes, and children. No styles — colors already live in the frames and theme tokens.
7. Publication: the Kernel assembles every source copy, prompt, snapshot, and layout tree before replacing `export/`. Re-export silently publishes the complete package over the previous one; exports are derived data and their history is Git's job. No partial replacement is exposed when capture or assembly fails.
8. Removed pages are absent from the project manifest and therefore invisible to export.

## Source anchors

- `docs/superpowers/specs/2026-07-16-git-backed-page-history-design.md` — §5 canonical current-source export rule, including uncommitted changes and historical-preview independence
- `docs/superpowers/specs/2026-07-13-termcraft-design.md` — §3.7 export package and all-or-nothing behavior, §3.10 the `/export` command, §5.7 rendering determinism, §5.8 design-code rules, §3.2 turn-time locks, §6.2 manifest visibility
- `design/13-export-feedback.dc.html` — export feedback states
