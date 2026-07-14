# termcraft architecture

Component- and process-level documentation for termcraft: a terminal application
where a designer and a local AI agent CLI design other terminal applications
together. Written for a reader who does not read the source language.

> **Status:** these documents describe the v1.0 target architecture ahead of the
> code. Source anchors point at the design spec
> (`docs/superpowers/specs/2026-07-13-termcraft-design.md`) and the UI reference
> files under `design/`; they move to real source files as implementation
> proceeds (see the architecture-update skill).

## Reading order

1. [overview.md](overview.md) — system context: the designer, the agent CLIs,
   the project folder, and the export consumer.
2. [modules.md](modules.md) — the six components, their boundaries, and the
   runtime loop; the Kernel boundary that becomes the future IPC.
3. [storage.md](storage.md) — the `.termcraft/` folder: layout, record schemas,
   what commits to git, format versioning.

## Flows

One document per user-visible process:

- [flows/launch.md](flows/launch.md) — from `termcraft` in a directory to the
  Workspace: lock check, project discovery, first-run wizard, first generation.
- [flows/generation-turn.md](flows/generation-turn.md) — one chat turn: prompt
  assembly, the operations protocol, validation with retries, atomic apply.
- [flows/versions.md](flows/versions.md) — append-only page versions: browsing,
  the history popup, rollback by copy-forward.
- [flows/interactive-prototype.md](flows/interactive-prototype.md) — the
  reactive variable map behind interactive mode and the Tweaks panel.
- [flows/pins-and-selection.md](flows/pins-and-selection.md) — mouse selection
  and pin comments: anchoring, lifecycle, orphans.
- [flows/export.md](flows/export.md) — the export package: deterministic
  snapshots plus exact design files.
- [flows/migration.md](flows/migration.md) — upgrading stored data: lazy and
  bulk migration, backups, the too-new-file error.
