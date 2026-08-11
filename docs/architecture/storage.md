Everything portable that termcraft persists lives in `.termcraft/` next to the
code it describes. Machine-local preferences, sessions, recovery journals,
indexes, caches, diagnostics, logs, leases, and backups are explicitly separated
and excluded from Git commit scopes. This document maps those sources of truth
and their recovery boundaries.

```mermaid
flowchart TB
    subgraph tc[".termcraft/ — one folder, one project"]
        proj["project.toml — format_version 2 · project_id · name · created_at · target_stack"]
        gi[".gitignore — generated hard exclusions"]
        subgraph pg["design/ — the canonical authored tree"]
            manifest["pages.json — ordered slug to entry bindings + requested active page"]
            entries["{entry} — each page's own file, anywhere in the tree"]
            shared["shared modules — anything no entry names"]
            dsmanifest["system/design-system.json — OPTIONAL project design-system manifest<br/>(themes + component catalog)"]
        end
        pins["pins/{stable-slug}.jsonl — append-only pin events"]
        subgraph local["machine-local and hard-excluded"]
            chats["chats/{chat-uuid}.jsonl — hard-local dialog logs (amended 2026-07-26, MVP blocker fix bundle §2.5)"]
            ws["workspace.local.toml — active page/chat · preview · backend/model/effort"]
            sess["workspace.local.toml also owns scoped vendor session checkpoints"]
            tx["transactions.local/ — prepared plans · payloads · commit intent"]
            cache["cache/ + diagnostics/ — metadata · ChatIndex · render cache · current diagnostics"]
            ops["logs/operational.jsonl + operational.{n}.jsonl — bounded rotated redacted telemetry"]
            lease["lock — OS-held ProjectLease metadata"]
        end
        subgraph ex["export/ — derived published package"]
            exptr["current.json — active generation + per-file SHA-256 manifest"]
            prompt["generations/{id}/design-prompt.md"]
            runtimeapi["generations/{id}/runtime-api.json"]
            design["generations/{id}/design/** — the whole authored tree, once"]
            closures["generations/{id}/closures/{slug}.json — the files each page reaches"]
            snapshots["generations/{id}/snapshots/ — frames per page × size"]
            layout["generations/{id}/layout/ — resolved trees"]
        end
    end
    trust["{userStateRoot} TrustStore — trust ledger outside project"]
    backups["{userStateRoot}/backups/{projectId}/{migrationActionId}/ — verified migration backups"]
    turns["{userStateRoot}/sandboxes/{projectKey}/turns/{turnId}/workspace/ — unique writable workspaces"]
    ds["{userStateRoot}/design-systems/ — sources.json, local/<systemId>/, cache/<sourceIdSegment>/<systemId>@<version>/"]
```

## Walkthrough

1. **Portable project state.** `project.toml` carries exactly `format_version` (now
   `2`), portable UUIDv7 `project_id`, `name`, UTC `created_at`, and enum
   `target_stack`. It no longer carries a page array: which pages exist, in what order,
   and which file each one lives in is `design/pages.json`'s answer alone, because
   keeping both would give page order two sources of truth and the manifest is the one
   the agent edits. `project.toml` also does not carry the active page, active chat,
   preview state, selected backend/model/effort, or cached page metadata. A page's
   static `meta` in its own entry file is the only source of title, minimum size,
   theme, and integer `kitApiVersion`.
   - *Failure:* a project still at `format_version = 1` is refused with a typed
     "must be migrated" error (`ManifestMigrationRequiredError`) rather than read
     leniently — no compatibility reader for the version-1 layout exists in the
     ORDINARY open path, deliberately. The one place that DOES understand it,
     `store/migration/model/legacy-scan.ts`'s `scanLegacyProject`, is reached only
     from the migration itself (`flows/migration.md`). A real version-1 project is
     preserved verbatim at `test-fixtures/format-v1-project/`, and it is no longer
     only a future subject: `src/store/model/migration-fixture.test.ts` runs the
     real, shipped migration against it.
2. **Local workspace state.** `workspace.local.toml` carries active page/chat,
   backend/model/effort, preview size mode and custom dimensions, theme/color
   override, static/interactive mode, fullscreen flag, and scoped session
   checkpoints, plus the bounded optional resource-limit overrides defined by the
   scale design. A dangling local
   selection falls back without mutating portable state. An agent request to
   activate a page is a local post-apply effect recorded in the same recoverable
   turn transaction, not a portable manifest change. The user's own page choice
   reaches the same field by a different route: a successful preview source
   switch — what a tab click or the page-step keys ultimately issue — writes the
   page it switched to as the active one, best-effort, so the choice survives a
   restart (`flows/interactive-prototype.md` step 5a).
3. **The design tree.** `design/` is the canonical authored tree, and it mirrors a
   turn workspace one-to-one. `design/pages.json` is the manifest: an ordered array of
   `{slug, entry}` bindings plus an optional requested active page. A page's file is
   whatever its `entry` names — anywhere inside the tree, never derived from the slug —
   and every other file in the tree is a shared module several pages may import. The
   slug remains the page's immutable identity; no page UUID or private version file
   exists. Two legal import edges exist anywhere in the tree: a static import of
   `@termcraft/runtime`, and a relative specifier resolving to a real file inside
   `design/`. A page's **closure** is the transitive set of tree files its entry
   reaches, and it — not one file's hash — is what decides whether that page changed.
   Historical Git objects are read-only inputs and are never migrated in place.
   - *Failure:* an `entry` that names no real file in the tree, escapes it, or is
     claimed by no manifest entry at all is refused before any page is validated. A
     brand-new project is seeded with `pages.json` and an EMPTY `pages` array — never a
     starter page, which would be a design nobody asked for.
   - *Design system (P2 `manifest-and-gate`, OPTIONAL).* A project may additionally own
     `system/design-system.json` — a TREE-relative path exactly like a page's own `entry`,
     never a second vocabulary — declaring the project's themes (a required core set of
     token roles plus any project tokens) and a component catalog. It is an ordinary
     file of the tree in every sense that matters here: it is part of the tree
     inventory the closure walk and `computeTreeRevision`'s Merkle fold both see, and
     its declared `components[]`, once resolved, become ADDITIONAL closure roots
     the Gate walks — a component no page yet imports still counts as reached, rather
     than reading as dead. The whole check is transitional: every design-system rule
     the Gate applies activates if and only if the tree names this manifest, so a
     project with none is validated exactly as it always was.
4. **Non-page identities.** Chat, turn, command, record, pin, action, and
   transaction identities use canonical lowercase UUIDv7. Chats are stored as
   `chats/<chatId>.jsonl`; display names and any friendly ordinal are derived and
   never used as identity.
5. **Git scopes.** Git is optional. `/commit-page` selects only the active
   page's own entry file. `/commit-infra` selects `project.toml`, generated
   `.gitignore`, and future explicitly portable project-level files.
   `/commit-all` selects every eligible non-ignored portable or derived path
   under `.termcraft/`, including pin logs, the whole design tree, and export
   artifacts.
   Chats are hard-excluded, not portable (amended 2026-07-26, MVP blocker fix
   bundle §2.5 — chat logs churn on every turn and can carry arbitrary user
   text). Local files, `transactions.local/`, `cache/`, `diagnostics/`, operations logs, lock
   metadata, and backups are hard-excluded even if Git ignore inspection fails.
   (v1; not yet implemented — no `/commit-*` command and no live commit-scope
   planner exist. Only the generated `.gitignore` courtesy mirror is real code today.)
6. **Chat records.** Each chat starts with a typed versioned header. Every
   subsequent line is UTF-8 JSON with `recordId`, ISO timestamp, and a maximum
   1,048,576-byte physical line including LF (serialized object at most 1,048,575
   bytes). User and agent records additionally carry `turnId`;
   agent records carry `changedPages` and the warnings observed at that time.
   Restore system records carry UUIDv7 `restoreActionId`, page slug, and full
   source commit id. The containing chat file remains the persisted chat
   identity; no redundant `targetChatId` field is stored in the record.
7. **Pin records.** `pins/<slug>.jsonl` is an append-only event log — one file per
   page, keyed by slug, deliberately OUTSIDE the design tree: pins are termcraft's own
   record about a page, not part of the authored design the agent edits and export
   ships. Creation and
   later open/resolved transitions have distinct `recordId`s and identify the
   stable `pinId`; old lines are never rewritten. Restore and Git history never
   restore or mutate pin state.
8. **JSONL recovery.** Readers stream and index only complete LF-terminated
   records. A final object without `\n` is an uncommitted suffix, even if its JSON
   parses. A transaction plan that proves a partial final append may truncate exactly to its recorded
   old offset/hash and replay the complete record idempotently. Unproven trailing
   bytes remain unchanged in the canonical JSONL and mutation-lock that store.
   Hash-confirmed explicit repair first creates a verified external backup and then
   truncates to the last valid LF. Invalid data in the middle is a hard corruption
   error. (`jsonl-repair` is a reserved mutation kind the transaction engine already
   accepts, but no caller yet assembles the backup-then-truncate repair plan — repair
   is mechanism-only today.)
9. **Sessions.** A vendor session entry is scoped by chat UUID, an opaque backend
   session scope (backend, model, and credential/account/workspace identity), and
   a history checkpoint of record count plus exact prefix hash. Resume requires
   all fields to match and the backend to bind the resumed run to the new turn
   workspace; otherwise a fresh session is seeded with at most 32 complete recent
   records and 64 KiB, dropping oldest whole records first.
10. **Rebuildable projections.** All three page-scoped caches are keyed on the
    page's whole CLOSURE, not on its entry file: a page is its entry plus every
    tree file that entry transitively imports, so a cache keyed on the entry's own
    bytes would serve a stale answer after an edit to a shared module. Page
    metadata is cached by page slug, closure hash, and extractor version. Current
    diagnostics are cached by page slug, closure hash, and `kitApiVersion` (no
    production caller reads or writes this store today — it is re-keyed ahead of
    one). Render artifacts use content-addressed keys whose content half is the
    closure hash, alongside `kitApiVersion`, renderer version, size, theme, and
    export flags. The closure hash is a Merkle fold over the closure's
    `(relative path, sha256)` pairs, and is *absent* when any closure member is
    missing from the tree inventory — an honest "cannot be computed", which every
    consumer treats as a forced miss, never as "unchanged". Each of the three
    stores carries its own generation stamp, all bumped from 1 to 2 when the key
    changed, so entries written under the old key are a clean miss-and-rebuild
    rather than a schema error. `ChatIndex` stores valid-prefix byte offsets
    and record/turn lookup. Every projection can be deleted and rebuilt from
    portable sources and is never a commit or recovery authority.
11. **Safe filesystem boundary.** `SafeProjectFs` mediates managed reads and
    writes in `.termcraft` and copies agent output into immutable candidates. It
    rejects absolute/traversing/UNC/alternate-stream paths, Windows normalization
    ambiguity, case collisions, symlinks, junctions, reparse points, hardlinks,
    non-regular files, and configured path/count/depth/byte limit violations.
    The Gate separately validates TypeScript and import semantics. Six root kinds
    share this boundary (`store/safe-fs/model/limits.ts`'s `ROOT_LIMITS`): the
    ordinary `.termcraft` `project` root; `workspace` and `candidate` for a turn's
    staged tree and its Gate-validated output; `export-candidate` and `backup` for
    the two other whole-tree copies termcraft produces itself; and, as of
    design-tree phase 1b, `project-migration` — the SAME `.termcraft` directory as
    `project`, opened with a widened grammar for exactly one migration, admitting
    the retired `pages/<slug>/{page.tsx,comments.jsonl}` layout that every other
    root kind refuses (`flows/migration.md`).
12. **Transactions.** Recoverable plans and payloads live under
    `transactions.local/`. Prepared plans without commit intent are discarded.
    Plans with durable commit intent roll forward idempotently before Workspace
    opens; committed journals are recognized without rechecking targets. Their GC
    waits until startup schema/tree validation and reference checks complete.
    Unexpected target hashes enter recovery conflict and are never overwritten.
    Turn apply, Restore finalization, export publication, and migration use domain
    wrappers over the same engine. Durable `rebases/*.json` markers are Restore-only
    (v1; not yet implemented — the engine's `record-pending` state and the
    `releaseAfterApplied` operation flag both carry this reservation in the schema,
    but no code writes a `rebases/` marker, since Restore itself has no writer).
    The GC ordering above is likewise a v1 target: nothing yet collects a
    recognized-complete journal's directory, so today it is simply left in place
    (`flows/launch.md`).
13. **Single writer.** A writable process holds `ProjectLease` through an OS lock
    for its lifetime. PID, process-start token, nonce, version, and timestamp are
    diagnostic metadata only. A lease is never reclaimed from PID alone; if the
    platform cannot prove ownership, writable startup refuses and offers explicit
    recovery. Writable projects on filesystems with unreliable locking are
    unsupported.
14. **Trust.** The external trust ledger keys a `TrustSubject` by canonical
    project path, project-root filesystem identity, portable `projectId`, and Git
    repository identity when available. Ordinary file edits, commits, and branch
    switches do not revoke trust; replacing the workspace or Git directory does.
    Trust is intentionally not bound to `HEAD` and is not a per-file signature.
15. **Turn workspaces.** `{userStateRoot}/sandboxes/<projectKey>/` contains unique
    `turns/<turnId>/workspace/` directories. `projectKey` is lowercase hexadecimal
    SHA-256 over `UTF-8(canonicalProjectRoot) || 0x00 || UTF-8(projectId)`; there is
    no stored salt or OS-temporary fallback. Each agent receives only its turn workspace as
    cwd/writable root. Later turns never clear or reuse it. The Gate reads a
    `SafeProjectFs`-created immutable candidate after the relevant process tree is
    confirmed exited.
16. **The design-system library.** `{userStateRoot}/design-systems/` holds the designer's own
    systems (`local/<systemId>/`, which is also the publish target), the configured sources
    (`sources.json`, into which the built-in `local` source is always re-inserted), and
    materialized remote packages (`cache/<sourceIdSegment>/<systemId>@<version>/`, keyed by
    version rather than by time, so one reference always names the same bytes). Each cache entry
    carries a content hash — a domain-separated sha256 over the package's file set — beside its
    `source:system@version` key, so a republished version is caught rather than assumed away.
    The library sits outside every project for the same reason the trust ledger does: a
    repository can copy a reference but cannot copy the bytes it was verified against. Only the
    `local` source and its adapter exist today (`store/design-systems/`); the install pipeline,
    quarantine, the breakage preview, the picker UI, the provenance record, and the update check
    are P10 work and nothing here is wired into the composition root yet.
17. **Export.** `export/` is derived and may be committed by `/commit-all`.
    `ExportPublishTransaction` assembles and verifies an immutable generation under
    `generations/<generationId>/`, including `runtime-api.json`, then replaces
    `current.json` only after every
    package file exists. Capture or assembly failure leaves the previous pointer
    active. Internal scratch and cache entries are local and excluded. Real end to
    end now (MVP gap closeout WP-5): `export.start` renders and assembles a real
    generation, `buildExportPublishOperations` builds its real create-generation
    → replace-pointer → delete-old-generation operations, and the production
    `ExportPublishPort` adapter durably publishes them; startup also validates
    `current.json` before a project reopens (`null` — no export yet — never
    blocks), and the headless `termcraft export` CLI drives the whole sequence
    with no renderer.
18. **Format versioning and migration.** Each TOML/JSON/JSONL kind has an
    independent format counter. A page's entry file instead declares `kitApiVersion`.
    The shipped migration mints its own `migrationPlanId`/`migrationActionId` pair
    inside `migrateProject` at commit time (`store/model/factory.ts`); a separate,
    read-only `planMigration` call mints its own `migrationPlanId` purely for the
    offer's PREVIEW (best-effort, never durably persisted, never reused by
    `migrateProject`, which re-scans and re-derives instead of trusting a plan
    carried over). The Kernel-command design's two-step plan-then-confirm mint, with
    the migration journal domain persisting both ids from one shared flow, remains
    unbuilt (`flows/migration.md` items 4/11) — this migration never reaches a Kernel.
    Before any old bytes are rewritten, migration creates and verifies a backup
    generation in machine-local user state outside `.termcraft`, regardless of
    Git status. Lazy migration may transform in memory, but its first write must
    add the original bytes to the verified migration backup — the LAZY mechanism
    itself remains unimplemented; the shipped migration is the BULK one, and it
    follows this exact ordering. Canonical current sources may be codemodded; Git
    historical objects never are. (The format-counter gate and the verified-backup
    protocol are implemented and tested, and, as of design-tree phase 1b, so is the
    migration itself: `MIGRATION_CHAIN` carries one real step — `project.toml`
    format 1 -> 2 — proven end to end by `src/store/model/migration-fixture.test.ts`.
    `flows/migration.md` has the whole path and what is still unbuilt.)
19. **Operations log.** Bounded rotated local telemetry may record UUIDv7
    `recordId`, backend name, model, `sessionStartMode`, timings, retries, Gate result, cancellation/exit reason,
    and host restarts. It never stores prompts, reasoning, credentials, file
    contents, `sessionScopeId`, raw vendor session ids, or full tool arguments and is
    not a source of truth. (v1; not yet implemented — no writer exists anywhere in the
    codebase. Only its resource-limit configuration keys, `operations_log_segment_bytes`
    and `operations_log_retention_segments`, are real in `workspace.local.toml`.)
20. **First shipped schema.** UUID records, canonical page paths, local-state
    separation, pin events, and explicit `kitApiVersion` are the initial shipped
    formats — implemented across `entities/`, `store/`, and `infrastructure/` and
    exercised by their own test suites. No migration from the abandoned
    numbered-page design exists — that layout never shipped, so there was never
    anything to migrate FROM it. The migration chain is no longer empty: it carries
    one real step for the format-1 layout that DID ship (`project.toml`'s own
    ordered `pages` array, flat `pages/<slug>/page.tsx` files) becoming the
    `design/` tree — see `flows/migration.md` for the whole path. The components
    that consume this storage have now landed: the assembled Kernel (`core`)
    reaches it through the `store/adapters` ring behind `core/ports`, and the
    composed UI shell drives that graph under `bun start`.

## Source anchors

- `src/store/model/factory.ts` — the composition root: wires the durability
  pre-flight, the lease, safe filesystem, journal-format gate, crash recovery,
  the migration too-new gate, schema decoders, the orphan-turn sweep, and every
  sub-store behind the `Store` port (`openProject`/`createProject`)
- `src/infrastructure/durability/model/probe.ts` — `probeDurability`: refuses a
  volume that cannot demonstrate durable writes (storage-identity §4) before
  `openProject`/`createProject` mutate anything
- `src/store/toml/model/project-toml.ts` — item 1: `project.toml`'s five
  portable fields, deterministic TOML encode/decode, and the `format_version`
  too-new gate
- `src/store/toml/model/workspace-toml.ts` — item 2: `workspace.local.toml`'s
  full local field set (active page/chat, backend/model/effort, preview,
  theme, render mode, session checkpoints, resource-limit override ranges) and
  its preserve-and-default corruption policy
- `src/core/kernel/model/handlers/preview-export.ts` — item 2's other writer of the
  active page: a successful `preview.selectPage`/`preview.selectCurrent` persists the
  page it switched to through `ProjectStore.writeWorkspaceState`, after the session is
  established and only on success; a write failure is logged, never fatal
- `src/core/kernel/model/handlers/page-descriptors.ts` — `resolveActivePageSlug`: the
  reader on the other side of that write — it keeps the persisted page active if it
  still exists, else falls back to the first in the ordered list
- `src/entities/page/model/slug.ts` — item 3: the page-slug grammar
  (directory-name mask, Windows reserved-name rejection) that is a page's only
  identity
- `src/entities/page/types.ts` — items 1, 17: `PageMeta` (`kitApiVersion`,
  `title`, `minSize`, `theme`), the only source of a page's static metadata
- `src/store/transaction/model/wrappers.ts` — items 3, 6, 7, 8, 12, 16, 17: the
  managed-path builders (`canonicalPagePath`, `pageCommentsPath`,
  `chatJsonlPath`), every domain transaction wrapper (turn
  admission/finalization/terminalization, `project-mutation` — whose
  `jsonl-repair` kind is reserved but has no caller yet — and the
  infrastructure-only `restore`/`export-publish`/`migration` builders, each
  with no MVP caller by design)
- `src/infrastructure/uuid/model/uuidv7.ts` — item 4: UUIDv7 minting and
  canonical-form validation, shared by every non-page identity
- `docs/superpowers/specs/2026-07-16-git-backed-page-history-design.md` —
  item 5: `/commit-page`, `/commit-infra`, `/commit-all`, the live
  `StoragePathPolicy` commit-scope planner, and the Restore write flow — none
  of this has shipped; the generated `.gitignore` below is the only piece with
  real code
- `src/store/toml/model/gitignore.ts` — item 5: the generated
  `.termcraft/.gitignore`, a courtesy mirror of the hard-exclusion list —
  commit-scope correctness itself rests on the not-yet-built policy planner
- `src/entities/chat/types.ts` — item 6: the chat header and every record kind
  (`user`, `agent`, `system:error`, `system:cancelled`, `system:restore`)
- `src/entities/chat/model/decode.ts` — item 6: the Zod-backed header/record
  decoders, including the `turnId`/`actionId` mutual-exclusion rule on system
  records
- `src/entities/pin/types.ts` — item 7: the comments header, the
  `pin:created`/`pin:status` event union, and the derived `Pin` shape
- `src/entities/pin/model/decode.ts` — item 7: the event decoders and
  `foldPins`, the event-sourcing fold that derives status from file order
- `src/store/jsonl/model/line-codec.ts` — item 8: the physical
  LF-terminated-line codec (UTF-8/BOM/CR/size rules)
- `src/store/jsonl/model/reader.ts` — item 8: the from-byte-zero streaming
  reader and its three-way tail classification (clean / transaction-proven
  append interruption / unproven corrupt suffix), plus the mid-file-corruption
  hard stop
- `src/store/jsonl/model/append-builder.ts` — item 8: the prepared-append
  descriptor (`buildChatAppend`/`buildPinAppend`) and `computeAfterImage`, the
  exactly-once append contract recovery proves against
- `src/store/jsonl/model/checkpoint.ts` — item 9: the session resume gate
  (`evaluateSessionResume`), the bounded fresh-session seed (32 records / 64
  KiB), and the prefix-hash computation
- `src/store/projections/model/page-meta-cache.ts` — item 10: the unbounded
  page-metadata cache keyed by `(pageSlug, closureHash, extractorVersion)`,
  generation 2
- `src/store/projections/model/diagnostics-store.ts` — item 10: the
  current-diagnostics cache keyed by `(pageSlug, closureHash, kitApiVersion)`,
  generation 2, 128 MiB default quota with least-recently-written eviction
- `src/store/projections/model/render-cache.ts` — item 10: the
  content-addressed export render cache, whose canonical key is
  `(closureHash, kitApiVersion, rendererVersion, size, theme, flags)`,
  generation 2, 512 MiB default quota with least-recently-written eviction
- `src/entities/design-tree/model/closure.ts` — item 10: `resolveClosure` and
  the `computeClosureHash`/`computeTreeRevision` Merkle folds those keys are
  built from, including the "absent when a member is missing" rule
- `src/store/jsonl/model/chat-index.ts` — item 10: `ChatIndex`, the paginated
  record-id/turn-id/timestamp/changed-pages index over a chat log
- `src/store/jsonl/model/chat-index-store.ts` — item 10: the disk persistence
  for `ChatIndex`'s pages and state, so it survives a restart instead of
  rebuilding from scratch
- `src/store/safe-fs/model/no-follow.ts` — item 11: the no-follow managed-path
  walk, reparse-point/symlink/junction rejection, and root-escape detection
- `src/store/safe-fs/model/path-rules.ts` — item 11: the path grammar
  (length/component/reserved-name limits) and NFC/case-fold collision
  detection
- `src/store/safe-fs/model/leaf-identity.ts` — item 11: file-type
  permissibility and hardlink/identity-drift checks
- `src/store/safe-fs/model/limits.ts` — item 11: per-namespace and per-root
  size/count/depth limits, checked at admission and again while streaming
- `src/store/safe-fs/model/candidate.ts` — items 11, 15: `snapshotToCandidate`,
  the immutable hashed candidate copy handed to the Gate
- `src/store/transaction/model/plan.ts` — item 12: the transaction-plan
  schema, canonical-JSON hashing, payload validation, and the
  journal-may-not-target-itself rule
- `src/store/transaction/model/engine.ts` — item 12: the core commit protocol
  (payloads → plan → intent → roll-forward → `committed.json`) and the JSONL
  append-tail classification recovery shares
- `src/store/transaction/model/recovery.ts` — item 12: the startup scan that
  classifies and resolves every unfinished transaction (discard /
  roll-forward / already-complete / conflict) before project state is exposed
- `src/store/transaction/model/journal-format.ts` — item 12: the
  whole-journal-namespace `format.json` gate, read before any transaction
  directory is listed
- `src/store/transaction/model/write-mutex.ts` — item 12: the single
  mutating-write permit and the chained recheck-before-every-step helper
- `src/store/transaction/types.ts` — item 12: the complete `TransactionState`
  machine, including the `record-pending`/`releaseAfterApplied` Restore-only
  reservations that carry no writer today
- `src/store/lease/model/lease.ts` — item 13: the Windows OS-lock acquisition,
  the bounded advisory metadata, and the never-force-broken lease contract
- `src/entities/design-tree/model/manifest.ts` — item 3: `decodePagesManifest`/
  `encodePagesManifest`, the `design/pages.json` schema and its canonical bytes
- `src/entities/design-tree/model/specifier.ts` — item 3: `resolveDesignSpecifier`,
  the two legal import edges and the narrow `.tsx`-then-`.ts` resolution
- `src/entities/design-tree/model/closure.ts` — item 3: `resolveClosure`,
  `computeClosureHash` and `computeTreeRevision`
- `src/store/safe-fs/model/limits.ts` — item 3: the `design-source` namespace covering
  `design/**` and the `pins/<slug>.jsonl` grammar
- `src/entities/design-system/types.ts` — item 3 (P2 `manifest-and-gate`): the OPTIONAL
  `system/design-system.json` manifest's own TREE-relative path
  (`DESIGN_SYSTEM_MANIFEST_RELPATH`) and shape (`DesignSystemManifestV1`) — themes,
  core token roles, and the component catalog
- `src/entities/design-system/model/manifest.ts` — item 3 (P2 `manifest-and-gate`):
  `decodeDesignSystemManifest`, the manifest's schema plus its cross-field rules
  (token-name parity across themes, `defaultTheme` naming a declared theme, no
  duplicate component name)
- `src/entities/design-system/model/components.ts` — item 3 (P2 `manifest-and-gate`):
  `designSystemComponentRelPath`/`findUnresolvedComponents` resolve a declared
  component against the SAME tree inventory a page's own `entry` is resolved against;
  `isInsideDesignSystem` is the `system/`-folder membership test the Gate's
  containment boundary and the closure's extra roots both key on
- `src/store/model/factory.ts` — item 1: `createProject` writing the
  format-2 `project.toml` and the seeded empty `design/pages.json` in ONE
  project-creation transaction
- `src/store/model/design-tree-store.ts` — item 3: the `DesignTreeStore` reads
  over the tree (`createDesignTreeStore`, `readManifestFromDisk`,
  `buildPagesManifestOperation` — split out of `src/store/model/factory.ts`,
  design-tree phase-1 closeout Task 9)
- `src/store/trust/model/subject.ts` — item 14: the `TrustSubjectV1` canonical
  byte encoding and SHA-256 keying. The ledger now records two KINDS of subject
  (project-design-systems §8.4). A project subject keeps its exact original byte
  encoding — the `termcraft-trust-subject-v1` prefix and its positional tuple — so
  every recorded grant survives unchanged. A design-system source subject uses a
  second encoding under its own `termcraft-trust-subject-source-v1` prefix, over the
  adapter family, the source id, the canonical location, and the location's
  filesystem identity when it has one. The KIND discriminator is the prefix, not a
  new first field: prepending a field would have changed every project digest and
  silently revoked every grant, and two prefixes make a cross-kind collision
  impossible by construction
- `src/store/trust/model/trust-store.ts` — item 14: `buildSubject`/
  `isGranted`/`grant`, the machine-local ledger under `{userStateRoot}/trust/`.
  Stored records follow the same kind split as `subject.ts` above — project records
  are still written with no `kind` field, source records carry `kind: "source"` —
  and each kind refuses the other on read, so a wrong-kind record grants nothing.
  Enforcing "an unrecorded remote source is never queried" in the code that
  instantiates a configured source, and widening `core/ports/trust.ts` to source
  subjects, are both P10 work — the store-side ledger capability is complete, but it
  has no `core`-side caller yet; the built-in `local` source needs no grant
- `src/store/sandbox/model/staging-store.ts` — item 15: `createTurnWorkspace`,
  the create-new turn directory, design-tree/runtime-doc staging (every tree file
  copied at the SAME tree-relative path, which is what makes an import specifier
  identical in the workspace and in `design/`),
  and `turn.json` persistence
- `src/store/sandbox/model/project-key.ts` — item 15: `computeProjectKey`, the
  SHA-256 sandbox-parent-directory derivation
- `src/store/design-systems/model/layout.ts` — item 16: the `{userStateRoot}/design-systems/`
  paths (`sources.json`, `local/<systemId>/`, `cache/<sourceIdSegment>/<systemId>@<version>/`)
- `src/store/design-systems/model/content-hash.ts` — item 16: `designSystemContentHash`,
  the domain-separated sha256 fold over a package's file set, stable across a
  re-walk of the same bytes
- `src/store/design-systems/model/sources-config.ts` — item 16: `sources.json`'s
  schema and the re-insertion of the built-in `local` source on every read, so it
  can never be configured away
- `src/store/design-systems/model/cache-entry.ts` — item 16: the cache-entry record
  paired with each materialized remote package, carrying its content hash beside
  its `source:system@version` key
- `src/store/design-systems/model/summary.ts` — item 16: a minimal, NON-EXECUTING
  manifest read (the §7 Gate fatals are out of scope here) over a deliberately
  PRIVATE manifest schema — P2's `entities/design-system` has not merged on this
  branch, so this file carries its own narrow picker-visible-facts schema and drops
  it for P2's real decoder at that sync point
- `src/store/design-systems/model/{list,fetch,publish,local-source}.ts` — item 16:
  the one stage-1 source, a local directory: `list` (never opens a `.tsx`),
  `fetch`/`publish` against the admission boundary (`model/walk.ts`), and
  `local-source.ts`'s assembly of the three into one `DesignSystemSource`
- `src/store/adapters/design-system-source.ts` — item 16: the production
  `core/ports/design-system-source.ts` adapter over the module above, mapping every
  `SourceError` onto `FailureDtoV1` (`store/adapters/failure.ts`)
- `src/core/export/model/package.ts` — item 17: `assembleExportPackage`, the
  in-memory export file list — `design-prompt.md`, `runtime-api.json`, the WHOLE
  canonical tree once under `design/<treeRelPath>`, one `closures/<slug>.json` per
  page listing what that page reaches, `snapshots/<slug>/<w>x<h>.txt`, and the real,
  non-empty, size-keyed `layout/<slug>.json` per page; the one remaining
  divergence is that a `LayoutNode` carries no `text` field yet, pending the
  runtime element catalog
- `src/core/export/model/publish-plan.ts` — item 17:
  `buildExportPublishOperations` and `serializeExportPointer` — the real
  create-generation → replace-`current.json` → delete-old-generation operations
  and the canonical `export/current.json` bytes
- `src/core/export/model/publish.ts` — item 17: `publishExport`, the
  reacquire-revalidate-then-intent publication window that reads the previous
  pointer under the write permit, builds the plan, and publishes before releasing
- `src/core/ports/export-publish.ts` — item 17:
  `ExportPointerV1`/`exportPointerV1Schema`/`EXPORT_POINTER_TARGET` — the durable
  `export/current.json` shape (schema version, generation id, per-file SHA-256
  manifest) shared by writer and reader, plus the runtime-api declaration types
- `src/host/protocol/model/embedded-declaration.ts` — item 17:
  `EMBEDDED_RUNTIME_DECLARATION`, the `runtime-api.json` content source (module
  name plus current/supported `kitApiVersion`) — a real producer now exists,
  closing the earlier gap
- `src/store/adapters/export-publish.ts` — item 17: the production
  `ExportPublishPort` — durably publishes a generation through
  `buildExportPublishTransaction`, and `readPointer` validates `current.json` on
  both open paths (shallow structural parse plus a referenced-generation-dir
  existence check; `null` — never published — never blocks)
- `src/store/migration/model/registry.ts` — item 18: the format-counter
  too-new gate shared by every durable-file kind, and `MIGRATION_CHAIN` — no
  longer empty: one step, `project.toml` format 1 -> 2 (design-tree phase 1b,
  `flows/migration.md`)
- `src/store/migration/model/legacy-scan.ts`, `model/v1-to-v2.ts` — item 18: the
  retired-layout reader and the plan/transaction builder for that one step
  (`flows/migration.md` has the full walkthrough)
- `src/store/migration/model/backup-store.ts` — item 18: the verified-backup
  protocol (copy → manifest → flush → reopen-verify → `VERIFIED` marker) under
  `{userStateRoot}/backups/<projectId>/<migrationActionId>/`, with its first
  production caller as of design-tree phase 1b (`store/model/factory.ts`'s
  `migrateProject`)
- `src/store/safe-fs/model/limits.ts` — item 11: the `project-migration` root
  kind, admitting the retired `pages/<slug>/{page.tsx,comments.jsonl}` layout
  only there (`flows/migration.md`)
- `docs/superpowers/specs/2026-07-16-projections-observability-scale-design.md`
  — item 19: the bounded rotated operations log (`logs/operational.jsonl` +
  rotation) — no writer exists anywhere in the codebase yet; only its
  resource-limit configuration keys are implemented (`workspace-toml.ts`,
  above)
