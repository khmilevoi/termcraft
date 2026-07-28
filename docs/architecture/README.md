# termcraft architecture

Component- and process-level documentation for termcraft: a terminal application
where a designer and a local AI agent CLI design other terminal applications
together — the agent writes real design code, termcraft executes it in an
isolated preview. Written for a reader who does not read the source language —
[code-structure.md](code-structure.md) is the deliberate exception, and the only
document here that addresses how the source tree itself is laid out.

> **Status:** nine source modules have landed — `entities/`, `infrastructure/`,
> `runtime/`, `host/`, `gate/`, `store/`, `agent/`, `core/`, and `ui/` — and the
> documents below anchor those to real source files. All seven components the design
> names are real code today, including the Kernel (`core/`), now fully self-assembled
> behind a public `core/index.ts` boundary — `createKernel`, the seven-machine/
> mailbox/capability wiring, and a real command handler registry answering all 43
> command kinds (kernel-assembly WP-1). The executable roots (`src/main.tsx`,
> `src/demo.tsx`) and the `entrypoint/` ring that owns terminal lifetime and shutdown
> have landed too. The production adapter graph inside that composition root has also
> landed: `store`/`agent`/`gate`/`host` are mapped onto `core/ports/` to build a real
> `KernelDeps` (WP-2), and `bun start` composes that graph into a real assembled
> Kernel and mounts the UI shell against it (WP-4) — only the `demo` executable root
> still runs `ui`'s in-memory Kernel double. Behavior that crosses component
> boundaries — a live generation turn, a host-rendered preview, export assembly — now
> runs against real production adapters rather than fakes; Git history remains v1
> scope with no adapter yet. Phase 8 (npm distribution, the live Gate type check, and
> the documented-debt sweep) has landed: `KernelPort.preview()`'s `acknowledgeDisplay`
> is wired to a real frame-token ledger (Task 16); the Gate's `typeCheck` stage runs
> live in the shipped configuration (Task 7, a generated `runtimeDts` plus a resolved
> compiler path); session resume works within one live process (WP-7 — cross-restart
> resume remains a stated, deliberate limit for Claude, not a gap); `turn.failed`'s
> `failure.code` distinguishes Gate-exhaustion from a backend failure where a typed
> reason is available (WP-8 item 4); and termcraft ships as a real npm package — `npm
> pack` plus a global install runs from an empty directory on all three argv paths
> (WP-1, verified by `src/entrypoint/model/installed-package.test.ts` against an
> installed tarball). The live preview loop is now closed end to end (Gap A, spec §2.2/§4.7):
> `kernel.preview.enable` fires once trust resolves to `trusted`, the shell asks for a session
> for the active page keyed on its `(slug, sourceHash)`, `preview.sessionReady` is published as
> a real event rather than only as an internal machine transition, and a committed turn
> republishes `page.descriptorsChanged` (`reason: "turn-apply"`) so a generated or edited page
> reaches the shell's page model and re-keys that ask — which is what makes "describe a TUI and
> see it" complete, and what makes geometry/hover-to-pin queries reachable. What is still open,
> and documented as such in the relevant
> module/flow sections rather than swept under this status block:
> `migration.*` commands route to a deliberate post-MVP no-op (there is exactly one
> storage format version, so a migration step has nothing to migrate from or to —
> `docs/architecture/flows/migration.md`); the composed agent system prompt cannot yet
> carry source-extracted per-page metadata or the current selection (`agent/prompt/`,
> phase-8 WP-3); and the interactive channels layered on top of a live preview session —
> the `F4` mode toggle, input forwarding, tweaks, and *runtime-driven* page navigation — each
> remain blocked by their own named gap (`docs/architecture/flows/interactive-prototype.md`);
> *user-driven* page switching, by tab click or `Ctrl+B`/`Ctrl+N`, is live as of 2026-07-27. Each
> document states which half of a claim is built and which is a
> design target, and anchors the unbuilt half to the governing specification instead
> of a source file; anchors keep moving to real paths as implementation proceeds (see
> the architecture-update skill).
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
   confinement and owned process trees. Its per-component table and Source anchors
   mark all seven as real code today, including the production adapter graph that
   maps them onto the composition root (WP-2/WP-4); what remains are the specific
   unwired stages and dormant seams each entry documents (the runtime facade's
   tweaks/navigation wiring, `HostSupervisor`'s input forwarding, and so on).
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
  interactive mode and the Tweaks panel. The host and its supervision are built,
  and user-driven page switching with them; the input, tweak, and
  runtime-navigation channels are not.
- [flows/pins-and-selection.md](flows/pins-and-selection.md) — mouse selection
  and pin comments: anchoring, lifecycle, unresolved pins.
- [flows/export.md](flows/export.md) — the export package: deterministic
  multi-size snapshots, resolved layout trees, plus exact design files.
- [flows/migration.md](flows/migration.md) — upgrading stored data: mandatory
  verified external backup, recoverable migration, and the too-new-file error.
