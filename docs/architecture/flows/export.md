Export turns a design project into a package another coding agent can implement from: an implementation prompt, deterministic text snapshots of every page at several terminal sizes, resolved layout trees, and the exact design sources.

```mermaid
flowchart TD
    trigger(["Ctrl+E · /export · CLI export command"]) --> trust{"project trusted?"}
    trust -- "no" --> hint0["refused — export executes design code (CLI prints the trust error)"]
    trust -- "yes" --> busy{"turn running?"}
    busy -- "yes" --> hint1["refused — status-bar hint"]
    busy -- "no" --> empty{"zero pages?"}
    empty -- "yes" --> hint2["refused — status-bar hint"]
    empty -- "no" --> snap["fresh design host per (page, size): one render, capture frame + layout tree, kill"]
    snap -- "any render fails" --> fail["whole export refused — names the page, the size, and the error"]
    snap -- "all captured" --> write["write snapshots/ (one frame per size) and layout/ (resolved boxes per size)"]
    write --> prompt["assemble design-prompt.md: overview, per-page structure, interactions, theme tokens, stack advice, minSize frames + fixture instructions"]
    prompt --> copy["copy head-version design sources to export/pages/"]
    copy --> done["export/ overwritten in place — history is git's job"]
```

## Walkthrough

1. Trigger: `Ctrl+E` (a global-tier hotkey — works even while typing), the `/export` slash command in the composer, or the CLI export command.
2. Refusal checks: an untrusted project (export executes design code — the CLI form prints the trust error and points at the TUI), a running turn, or a project with zero pages; in-app refusals hint in the status bar.
   - *Failure:* export is all-or-nothing — if any page fails to render at any export size (a head broken by rollback or kit drift), the whole export refuses, naming the page, the size, and the error; a package with a silently missing page would lie to the implementing agent.
3. Export sizes are a fixed ladder: the page's declared minimum size always, plus 120×40 (also a preview preset — what the user saw is what ships) and 160×40; a standard size is included only when it is at least the minimum on both axes (a page is never rendered below its minimum), and duplicates collapse. Several sizes turn resize behavior into data — the frames show which regions stretch and which stay fixed (the 120×40 → 160×40 step grows width only, isolating horizontal stretch), so the implementing agent never simulates the design's layout engine.
4. Capture: the Kernel spawns a fresh design host per (page, size), mounts the head version at that size with the page's own theme, renders exactly once at t = 0, captures the frame and the resolved layout tree from that same pass — consistent by construction — and kills the host, independent of the current preview size or theme override. Determinism comes from the recipe (fresh process, single render pass) plus the design-code rules: kit components suppress animation under the export flag, and timers or randomness outside that guard are gate warnings.
5. Package contents:
   - `design-prompt.md` — product overview, per-page structure and behavior, interactions and tweak states, theme/palette tokens, recommended libraries for the configured target stack, the embedded minimum-size frame of each page, and instructions framing the snapshot files as acceptance fixtures ("your implementation at 80×24 must render this; diff against it") plus how to read the layout trees.
   - `pages/*.tsx` — exact head-version design sources, precise enough for an implementing agent in any target stack to read as a spec.
   - `snapshots/<page>/<WxH>.txt` — one ASCII frame per export size, as separate files so the agent can diff its own render output against them programmatically.
   - `layout/<page>.json` — the resolved layout tree at every export size: per node its id (as declared in the design, else null), kind (kit component or raw element name), computed box in terminal cells, text for text nodes, and children. No styles — colors already live in the frames and theme tokens.
6. Re-export silently overwrites `export/` in place: exports are derived data; their history is git's job.
7. Removed pages are unlisted from the project manifest and therefore invisible to export.

## Source anchors

- `docs/superpowers/specs/2026-07-13-termcraft-design.md` — §3.7 export package, §3.10 the /export command, §5.7 rendering determinism, §5.8 design-code rules, §3.2 turn-time locks, §6.2 manifest visibility
- `design/13-export-feedback.dc.html` — export feedback states
