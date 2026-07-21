# termcraft architecture

Component- and process-level documentation for termcraft: a terminal application
where a designer and a local AI agent CLI design other terminal applications
together — the agent writes real design code, termcraft executes it in an
isolated preview. Written for a reader who does not read the source language —
[code-structure.md](code-structure.md) is the deliberate exception, and the only
document here that addresses how the source tree itself is laid out.

> **Status:** seven source modules have landed — `entities/`, `infrastructure/`,
> `runtime/`, `host/`, `gate/`, `store/`, and `agent/` — and the documents below
> anchor those to real source files. Of the seven components the design names, that
> makes five real: the runtime facade, the Gate, the HostSupervisor and design host,
> the Project store, and the agent gateway. Two have not landed: the Kernel
> (`core/`) and the UI shell (`ui/`), along with the `main.ts` composition root that
> would wire everything together. So nothing yet composes the landed modules into a
> running program: behavior that crosses component boundaries — a live generation
> turn, a preview a designer can see, export assembly, Git history — is still
> described ahead of the code. That is deliberate. Each document states which half
> of a claim is built and which is a design target, and anchors the unbuilt half to
> the governing specification instead of a source file; anchors keep moving to real
> paths as implementation proceeds (see the architecture-update skill).
>
> These documents also describe both the MVP foundation and the v1 target. The MVP
> has canonical page sources but no history or Git UI; v1 adds Git-backed history,
> explicit Restore, and user-confirmed scoped commits. The approved continuation
> (`docs/superpowers/specs/2026-07-16-git-backed-page-history-design.md`) governs
> canonical page identity and Current rows, history discovery/browsing, Restore
> validation, Git commit controls, and export-source selection wherever it supersedes the
> original design spec or a flow document. Every document also anchors the relevant
> production-hardening detailed designs, the master design, and any UI reference
> files under `design/`.
>
> The approved production-hardening register
> (`docs/superpowers/specs/2026-07-16-production-hardening-decisions-design.md`)
> and its linked detailed designs govern crash recovery, per-turn staging,
> Kernel command authority, host supervision, storage identity, the
> `@termcraft/runtime` page API, local projections, and bounded operation.
> Its production-storage detailed design exclusively owns the portable/local
> layout, JSONL schemas, session checkpoints, trust/lease identity, migration
> backups, and Git exclusions.

## Reading order

1. [overview.md](overview.md) — system context: the designer, the agent CLIs,
   the project folder, and the export consumer.
2. [modules.md](modules.md) — the seven components, their boundaries, and the
   runtime loop; the transport-neutral Kernel boundary, runtime facade, supervised
   design-host subprocess where agent-written code runs, and the agent gateway's
   confinement and owned process trees. Its per-component table marks which five are
   real code and which two are still contract only.
3. [storage.md](storage.md) — the `.termcraft/` folder: layout, record schemas,
   what commits to git, format versioning, and the machine-local trust ledger.
   The most fully-built area of the system, and the vocabulary the other documents
   borrow when they name a stored record.
4. [code-structure.md](code-structure.md) — the source-tree convention: entity-first
   grouping, `entities/` versus consumer-declared ports, the domain-free
   `infrastructure/` ring, and the composition root that keeps the module graph a
   DAG. Also the canonical account of which modules exist on disk today. For readers
   who write code; the rest of this set does not require it.

## Flows

One document per user-visible process:

- [flows/launch.md](flows/launch.md) — from `termcraft` in a directory to the
  Workspace: lock check, project discovery, the workspace-trust gate, first-run
  generation, and the optional v1-only first-run wizard.
- [flows/generation-turn.md](flows/generation-turn.md) — one chat turn: a unique
  fenced workspace, agent confinement and confirmed process-tree exit, immutable
  candidate, Gate retries, compare-and-swap against commit-hook drift, and
  recoverable roll-forward finalization.
- [flows/chats.md](flows/chats.md) — several conversations over one project: the
  slash menu, creating and switching chats, per-chat agent sessions, and the v1
  `/commit-page`, `/commit-infra`, and `/commit-all` triggers.
- [flows/versions.md](flows/versions.md) — v1 Git-backed page history: read-only
  browsing, explicit Restore, and slash-command-triggered scoped commits. The governing
  behavior is the continuation specification linked above.
- [flows/interactive-prototype.md](flows/interactive-prototype.md) — real
  component state inside the design host; what crosses the boundary for
  interactive mode and the Tweaks panel. The host and its supervision are built;
  the input, tweak, and navigation channels are not.
- [flows/pins-and-selection.md](flows/pins-and-selection.md) — mouse selection
  and pin comments: anchoring, lifecycle, unresolved pins.
- [flows/export.md](flows/export.md) — the export package: deterministic
  multi-size snapshots, resolved layout trees, plus exact design files.
- [flows/migration.md](flows/migration.md) — upgrading stored data: mandatory
  verified external backup, recoverable migration, and the too-new-file error.
