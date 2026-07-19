# termcraft

## Mandatory skills for code sessions

Before any session that may inspect, analyze, review, debug, test, edit, or
otherwise interact with project code, you MUST load and read both `/reatom`
and `/errore` before the first code-related action. Follow both skills
throughout the entire session. This requirement applies unconditionally to
all code work in this repository.

## Design is a source of truth — never invent it

The project already has a complete, authoritative design system. All visual
decisions — colors, palette/token hues, layout, spacing, borders, glyphs,
component states, status-bar language — MUST be taken from it, never invented or
approximated with placeholder values.

- The canonical palette lives in [`design/termcraft-engine.js`](design/termcraft-engine.js):
  the dark theme is the `pal` object; the light theme is `lightPal()`. Use those
  exact `#rrggbb` values.
- The per-screen visual source of truth is `design/*.dc.html` (27 screens) plus
  the engine's draw methods; `design/Termcraft UI.dc.html` is the overview.
- Before writing or changing any UI/token/component code, read the relevant
  design source and match it exactly. If the design does not cover a case, ask or
  flag the gap explicitly — do not guess a color, hue, glyph, or layout.
- When a design value cannot be reproduced 1:1 in the current runtime (e.g. glyph
  rules vs. color bands), implement the closest faithful mapping and document the
  divergence in a code comment; never silently substitute an invented value.

## Code style

Group code by entity/feature, not by technical layer. Each module is a folder
shaped like this:

```
module/
  ui/
  model/
  types.ts
  index.ts
```

- `ui/` is the presentation layer; omit it when the module has no UI.
- Even when a module has no `ui/` layer, its code still lives in subfolders
  (e.g. `model/`) — never loose at the module root.
- `types.ts` and `index.ts` sit at the module root: `types.ts` holds the
  module's shared types, `index.ts` is its public entry point.
- Write atomic code: small, single-purpose functions. Split for clarity, not
  for its own sake — don't over-fragment.

How these modules compose into layers — the `entities/` vocabulary, ports declared
by the module that consumes them, the domain-free `infrastructure/` ring, and the
composition root — is fixed in
[`docs/architecture/code-structure.md`](docs/architecture/code-structure.md).

## Architecture docs maintenance

If a change alters behavior or structure covered by `docs/architecture/`, update
the affected docs before finishing — see the architecture-update skill. `Source
anchors` in each doc list what it describes; while the project is pre-code they
point at the design spec, and they must move to real source files as modules land.
