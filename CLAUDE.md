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

## Imports

Cross-module imports use absolute paths, aliased at the top-level module
boundary — never a relative import (`../..` or deeper) that climbs out of the
current module or `entities/` submodule. The aliases are configured via
`tsconfig.json`'s `compilerOptions.paths`; Bun resolves that same mapping at
runtime and inside `bun build --compile`, so no separate bundler config is
needed:

```
entities, entities/*         -> src/entities, src/entities/*
core, core/*                 -> src/core, src/core/*
store, store/*               -> src/store, src/store/*
agent, agent/*                -> src/agent, src/agent/*
gate, gate/*                  -> src/gate, src/gate/*
host, host/*                  -> src/host, src/host/*
ui, ui/*                      -> src/ui, src/ui/*
runtime, runtime/*            -> src/runtime, src/runtime/*
infrastructure, infrastructure/* -> src/infrastructure, src/infrastructure/*
```

Each module gets two `paths` entries: the bare name (for `import ... from
"host"`, resolving that module's own `index.ts`) and the `/*` wildcard (for any
subpath). The wildcard alone does not cover the bare import — TypeScript
reports `Cannot find module` for it without the paired non-wildcard entry.

- Relative imports (`./`, `../`) stay allowed only inside one module or one
  `entities/` submodule — e.g. `pin/model/decode.ts` importing `pin/types.ts`.
- The moment an import leaves that boundary — a different top-level module, or
  a different `entities/` submodule (`pin` importing `page`) — use the alias:
  `import { parsePageSlug } from "entities/page"`, not
  `import { parsePageSlug } from "../../page"`.
- Never alias under `@termcraft/*`. That scope is reserved for the real
  `@termcraft/runtime` saved-page facade specifier
  (`docs/architecture/code-structure.md` §9); reusing it for internal aliases
  would collide with a meaningful, resolver-handled import.

## Architecture docs maintenance

If a change alters behavior or structure covered by `docs/architecture/`, update
the affected docs before finishing — see the architecture-update skill. `Source
anchors` in each doc list what it describes; while the project is pre-code they
point at the design spec, and they must move to real source files as modules land.
