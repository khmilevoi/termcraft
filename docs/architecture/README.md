# termcraft architecture

Component- and process-level documentation for termcraft: a terminal application
where a designer and a local AI agent CLI design other terminal applications
together — the agent writes real design code, termcraft executes it in an
isolated preview. Written for a reader who does not read the source language.

> **Status:** these documents describe the v1.0 target architecture ahead of the
> code. Source anchors point at the design spec
> (`docs/superpowers/specs/2026-07-13-termcraft-design.md`) and the UI reference
> files under `design/`; they move to real source files as implementation
> proceeds (see the architecture-update skill).

## Reading order

1. [overview.md](overview.md) — system context: the designer, the agent CLIs,
   the project folder, and the export consumer.
2. [modules.md](modules.md) — the seven components, their boundaries, and the
   runtime loop; the Kernel boundary that becomes the future IPC, and the
   design-host subprocess where agent-written code runs.
3. [storage.md](storage.md) — the `.termcraft/` folder: layout, record schemas,
   what commits to git, format versioning, and the machine-local trust ledger.

## Flows

One document per user-visible process:

- [flows/launch.md](flows/launch.md) — from `termcraft` in a directory to the
  Workspace: lock check, project discovery, the workspace-trust gate, first-run
  wizard, first generation.
- [flows/generation-turn.md](flows/generation-turn.md) — one chat turn: the
  staging directory the agent edits in, the validation gate with retries,
  atomic apply.
- [flows/chats.md](flows/chats.md) — several conversations over one project: the
  slash menu, creating and switching chats, per-chat agent sessions.
- [flows/versions.md](flows/versions.md) — append-only page versions: browsing,
  the history popup, rollback by copy-forward.
- [flows/interactive-prototype.md](flows/interactive-prototype.md) — real
  component state inside the design host; what crosses the boundary for
  interactive mode and the Tweaks panel.
- [flows/pins-and-selection.md](flows/pins-and-selection.md) — mouse selection
  and pin comments: anchoring, lifecycle, unresolved pins.
- [flows/export.md](flows/export.md) — the export package: deterministic
  snapshots plus exact design files.
- [flows/migration.md](flows/migration.md) — upgrading stored data: lazy and
  bulk migration, backups, the too-new-file error.
