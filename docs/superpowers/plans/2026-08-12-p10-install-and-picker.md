# P10 `install-and-picker` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking. Load `/reatom` and `/errore` before any code-related
> action (CLAUDE.md mandate). Every task ends green and is one commit.

**Goal:** A designer can browse the design systems a configured source offers, see each one's
colors and contents without any foreign code being read or executed, install one through
quarantine → safe-fs limits → an immutable hashed candidate → the full Gate → a breakage preview
→ one recoverable store transaction, publish the project's own system back to the local library,
and be told when the source has a newer version than the one the project recorded.

**Architecture:** Installing never copies into the design tree. `DesignSystemSource.fetch` returns
bytes only; P10 materializes them into a per-install **quarantine** under the user-state root
(never inside the project), snapshots that into an **immutable hashed candidate** through
`store/safe-fs`'s `snapshotToCandidate` — which is what applies the real `design-source` limit
budget and the no-follow walk — composes the Gate's candidate tree **in memory** by splicing the
candidate's `system/**` over the canonical tree index, runs the whole-tree Gate once, reports what
breaks, and only then commits every file plus the provenance record in ONE
`runProjectMutation` transaction. A crash anywhere before `intent.json` leaves the project
byte-identical; a crash after it is rolled forward by the recovery scan that already runs at
`openProject`. The picker is an ordinary shell overlay in the `ChatListPopup` vocabulary, driven
by four new Kernel commands modelled on `export.start`'s `launchOperation` +
`publishOperationEvent` shape.

**Tech Stack:** Bun ≥ 1.3.14, TypeScript 7.0.2 (`tsgo` via `typescript/unstable/sync`),
`zod@4.4.3`, `errore@0.14.1`, `@reatom/core@1001`, `@opentui/react@0.4.5`, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-08-11-project-design-systems-design.md` — §8.1, §8.2, §8.3,
§8.4, §8.5, §8.6, §10.1 Wave 3 (P10), §11 (install tests), §12, §13.

---

## Global Constraints

Every task's requirements implicitly include this section.

- **Errors as values (errore).** `import * as errore from "errore"` — namespace import, never
  destructured. No `throw` for an expected failure. Every fallible function returns
  `TaggedError | T`; check with `if (x instanceof Error) return x` **on one line, no block**. Happy
  path stays at root indentation; no `else`, no `else if` chains. `errore.try` only at genuinely
  uncontrolled boundaries, in the repo's object form:
  `errore.try({ try: () => …, catch: (cause) => … })`. An error branch that does not propagate
  MUST log (`log.warn`/`log.error` from `infrastructure/debug-log`) — never a silent swallow.
  New domain errors are `errore.createTaggedError({ name, message: "… $field …" })`.
- **Reatom.** New UI state is Reatom. Selection is a plain `Atom<number>` on `UiLocalState`, moved
  by one named model action (RTM-S04) — never two `atom.set` calls at a call site, never an
  identity setter (`setX = action((v) => x.set(v))` is forbidden, RTM-S01). Mirror folds are one
  grouped `atom.set(...)` per event. No atom is created inside a React component body. Every atom,
  computed and action is **named** (RTM-S05). Every React event handler that touches Reatom goes
  through the adapter binding the existing popups already use. `reatomComponent` reads atoms
  **lazily, after early-return guards** (RTM-C01). `/reatom-audit` is part of finishing this plan
  (Task 15).
- **Zod.** `zod@4.4.3`. `z.strictObject` for every named object. **Never call `.finite()`** —
  `z.number()` already rejects `NaN`/`Infinity` in v4 and `.finite()` is a no-op.
- **No `any`. No `as` casts** except the two shapes the repo already uses:
  `JSON.parse(text) as unknown`, and the `Record<string, unknown>` widening idiom.
- **Factories are `create*`, never `make*`** (repository-wide naming rule).
- **Imports.** Cross-module imports use the top-level aliases (`entities/design-system`,
  `entities/design-system-ref`, `store/design-systems`, `core/ports`, `ui/theme`, …). Relative
  imports only inside one module or one `entities/` submodule. **No `tsconfig.json` change is
  needed by this plan and none may be made.** Never alias under `@termcraft/*`.
- **Path vocabulary.** A **tree-relative** path is relative to `design/` (`system/design-system.json`).
  A **project-relative** path is relative to `.termcraft/` and is what a `TransactionOperation.target`
  carries; the `design/` prefix is added ONLY by
  `store/transaction`'s `designFilePath(treeRelPath)`. A **package-relative** path is relative to
  the package root (`design-system.json`, `components/Button.tsx`) — `store/design-systems`'
  vocabulary. Never mix them; every function that crosses the boundary says which it takes.
- **Design is a source of truth.** Every colour, glyph and layout value comes from
  `design/termcraft-engine.js`'s `pal` (via `ui/theme`'s `SHELL_PALETTE`) and the named `.dc.html`
  screens. Nothing is invented. Where the design does not cover a case, Decision **D8** below
  records the gap explicitly and names the closest existing vocabulary; do not widen it.
- **Diagnostics are bounded plain text**, never terminal control sequences. `FailureDtoV1.details`
  values are `string | number | boolean | null` only.
- **`examples/` is NEVER edited by this plan.** `examples/clock` migrates at runtime, in the
  closeout, by being opened.
- **Append-only facade discipline does not apply here.** This plan makes **no** change to
  `src/runtime` and regenerates no `.d.ts`. If a task finds it needs one, STOP and report it as a
  scope escape rather than making it.
- **Tests.** `rtk bun run test <path>` per task (the wrapper classifies a Bun segfault as
  `crashed`, which is never a pass; a `bun test` segfault is a known flake — re-run once before
  calling it a regression). **`src/ui` and `src/entrypoint` render tests run as two separate
  commands**; a combined run produces random failures under load. OpenTUI render tests flake under
  load — a single failing render assertion in an otherwise-green run is re-run before being
  treated as real.
- **Every added or deleted `.ts`/`.tsx` file under `src/` changes the lexer corpus canary.**
  Task 15 fixes it once, at the end, for the whole plan: `src/gate/model/lexer.test.ts`'s
  `expect(files.length).toBe(1027)` and the prose count in `src/gate/model/lexer.oracle.test.ts`'s
  `"the repository's own 1027 sources"`. Do **not** touch those numbers in Tasks 1–14; a task's own
  run of `src/gate` will fail that one assertion and that is expected and correct. **Every task
  that adds or deletes a file states the delta in its report** so Task 15's arithmetic is
  auditable.
- **Commands are prefixed with `rtk`** (CLAUDE.md), inside chains too. `rtk git commit` swallows
  heredoc stdin — use single-line `-m`, or write a multi-line message to a scratch file and pass
  `-F <path>`. `rtk git diff` compacts output and is not a valid patch; use plain
  `git --no-pager diff` when a diff must round-trip.
- **Every task ends with `rtk bun run lint` and `rtk bun run fmt:check` clean**, then one commit.

---

## Scope

**In scope (P10, Track C, Wave 3):**

1. The real `PackageAdmission` budget over `store/safe-fs`'s `createLimitBudget`, and P3's parked
   minor **M5** (a symlinked `local/<id>` is readable through `fetch`).
2. P3's parked minor **M11** (publish's destructive remove→rename window).
3. The provenance record — `source:system@version` + content hash — in project state **outside**
   `design/` (§8.5).
4. Quarantine materialization and the immutable hashed candidate (§8.3).
5. The install transaction: one recoverable `project-mutation` writing every `design/system/**`
   file and the provenance record together.
6. The core install pipeline: trust → fetch → quarantine → candidate → full Gate → breakage
   preview → commit.
7. The bounded-timeout multi-source list and the update check (§8.4, §8.5).
8. Four Kernel commands and their events; the mirror slice.
9. The picker overlay: swatch row, system contents, `canPublish`-gated publish, degraded source.
10. The breakage-preview / install-confirm dialog, and publish to `local`.
11. Composition-root wiring, architecture docs, the Reatom audit, the lexer canary.

**Explicitly NOT in scope — another plan or another spec owns them:**

| Not here | Owner |
| --- | --- |
| `Color`, `useTokens<T>()`, `ThemeId`, the fourteen components retyped, `.d.ts` regeneration | **P1** (merged) |
| The manifest entity + Zod schema, every §7 fatal, the type-check VFS/`resolveJsonModule`, the `components[]` closure roots, `system/` containment | **P2** (merged) |
| The `DesignSystemSource` port, `sources.json`, cache layout, the local adapter's `list`/`fetch`/`publish`, the kind-discriminated trust-subject variant | **P3** (merged) |
| Host token wiring, the project-create scaffold, the mechanical migration and its prompt, the §7 warnings, the agent-prompt section | **P4** (merges before this plan executes) |
| OpenTUI wrappers, the `Box` layout expansion | **P5–P9** |
| A GitHub adapter; theme switching UI; a visual design-system editor | Out of the spec entirely |
| `recoverPendingMigrations` (interrupted-migration completion) | Accepted unbuilt gap, spec §12 |

---

## Interfaces this plan binds to (verified on branch `project-design-systems`)

**From `entities/design-system-ref` (P3):**

```ts
export interface DesignSystemRef {
  readonly sourceId: SourceId; readonly systemId: DesignSystemId; readonly version: DesignSystemVersion;
}
export function formatDesignSystemRef(ref: DesignSystemRef): string;   // "local:midnight@1.2.0"
export function parseDesignSystemRef(raw: string): InvalidDesignSystemRefError | DesignSystemRef;
export const designSystemRefSchema: z.ZodType<DesignSystemRef>;
export class InvalidDesignSystemRefError extends errore.createTaggedError({ … }) {}
```

**From `entities/design-system` (P2):**

```ts
export const DESIGN_SYSTEM_DIRNAME = "system";
export const DESIGN_SYSTEM_MANIFEST_RELPATH = "system/design-system.json";
export function decodeDesignSystemManifest(text: string): DesignSystemManifestInvalidError | DesignSystemManifestV1;
export function isInsideDesignSystem(relPath: string): boolean;   // tree-relative
```

**From `store/design-systems` (P3):**

```ts
export interface PackageFile { readonly relPath: string; readonly bytes: Uint8Array }   // package-relative
export interface PackageAdmission {
  admitFile(input: { relPath: string; declaredSize: number; depth: number }): Error | null;
  observeBytes(input: { relPath: string; bytesRead: number }): Error | null;
}
export interface DesignSystemFsDeps { listDir; statFile; readFile; mkdirAll; durableWrite; removeDir; renameDir }
export interface LocalDesignSystemSourceDeps {
  readonly userStateRoot: AbsPath; readonly fs: DesignSystemFsDeps;
  readonly admission: PackageAdmission;      // REQUIRED, no default
  readonly clock: Clock;
}
export interface DesignSystemSummary {
  id; name; version; kitApiVersion; defaultTheme;
  readonly defaultThemeTokens: readonly TokenSwatch[];   // DECLARATION ORDER
  readonly componentNames: readonly string[];
}
export interface FetchedPackage { ref; contentHash; files: readonly PackageFile[]; summary }
export interface LocalPackage { systemId; version; files: readonly PackageFile[] }
export interface PublishReceipt { ref; contentHash; publishedAt }
export function createLocalDesignSystemSource(deps: LocalDesignSystemSourceDeps): DesignSystemSource;
export function designSystemContentHash(files: readonly PackageFile[]): Sha256Hex | DuplicatePackageFileError;
export function normalizePackageRelPath(raw: string): string;
export function localLibraryDir(userStateRoot: AbsPath): AbsPath;
export function localSystemDir(userStateRoot: AbsPath, systemId: DesignSystemId): AbsPath;
export function designSystemsRoot(userStateRoot: AbsPath): AbsPath;
export const LOCAL_SOURCE_ID: SourceId; export const LOCAL_SOURCE_LABEL = "Local library";
export const MANIFEST_FILENAME = "design-system.json";
export const nodeDesignSystemFsDeps: DesignSystemFsDeps;
export const allowAllPackageAdmission: PackageAdmission;   // TESTS ONLY
```

**From `store/safe-fs`:**

```ts
export function createLimitBudget(rootKind: ManagedRootKind): LimitBudget;
export interface LimitBudget {
  admitFile(input: { relPath: string; namespace: ManagedNamespace; declaredSize: number; depth: number }): StorageLimitExceededError | null;
  observeBytes(input: { relPath: string; namespace: ManagedNamespace; bytesSoFar: number }): StorageLimitExceededError | null;
}
export function classifyNamespace(rootKind: ManagedRootKind, relPath: string): ManagedNamespace | UnknownNamespaceError;
export function openManagedRoot(input: { kind: ManagedRootKind; path: string; deps: NoFollowDeps }): ManagedRoot | SafeFsError;
export function snapshotToCandidate(input: { source: ManagedRoot; destRoot: string; deps: CandidateDeps }): SafeFsError | CandidateSnapshot;
export interface CandidateSnapshot { readonly root: string; readonly files: readonly CandidateFile[]; readonly totalBytes: number }
export interface CandidateFile { readonly relPath: string; readonly namespace: ManagedNamespace; readonly sha256: string; readonly size: number }
export function nodeCandidateDeps(): CandidateDeps;
export function nodeSafeFsDeps(): SafeProjectFsDeps;
// NAMESPACE_LIMITS["design-source"] = { perFileBytes: 2 MiB, maxFiles: 512, aggregateBytes: 64 MiB, maxDepth: 8 }
```

**From `store/transaction`:**

```ts
export function designFilePath(treeRelPath: string): string;                  // `design/${treeRelPath}`
export function observeFileImage(fs: TransactionFsDeps, relPath: string): SafeFsError | FileImage;
export async function runProjectMutation(deps: TransactionWrapperDeps, input: ProjectMutationInput): Promise<Error | CommittedMarker>;
export type ProjectMutationKind = "project-creation" | "local-state-write" | "title-edit" | "pin-event"
  | "jsonl-repair" | "chat-creation" | "page-reorder" | "page-remove";      // Task 5 appends one member
export interface TransactionOperation {
  readonly index: number; readonly target: string;                            // PROJECT-relative
  readonly mode: "replace" | "delete" | "append-jsonl";
  readonly oldImage: FileImage; readonly newImage: FileImage; readonly payloadId?: string;
}
export interface BuiltPageOperation { readonly operation: TransactionOperation; readonly payload?: readonly [string, Uint8Array] }
```

**From `core/ports`:**

```ts
export interface DesignSystemSource {
  readonly id: string; readonly label: string; readonly canPublish: boolean;
  list(): Promise<FailureDtoV1 | readonly DesignSystemSummaryV1[]>;
  fetch(ref: DesignSystemRef): Promise<FailureDtoV1 | FetchedPackageV1>;
  publish(pkg: LocalPackageV1): Promise<FailureDtoV1 | PublishReceiptV1>;
}
export interface GateRunner {
  runTree(input: { files: ReadonlyMap<string, string>; treePaths: readonly string[]; pages: readonly PageEntryV1[] }): Promise<RunTreeResultV1>;
  runManifestSlice(input: { manifestText: string; treePaths: readonly string[] }): Promise<ManifestSliceResultV1>;
}
export interface RunTreeResultV1 { readonly errors: readonly GateErrorV1[]; readonly warnings: readonly GateWarningV1[]; readonly closures: readonly GateClosureV1[] }
export interface GateErrorV1 { readonly kind: GateErrorKindV1; readonly code: string; readonly message: string; readonly file?: string; readonly line?: number; readonly column?: number; readonly blockedPages?: readonly PageSlug[] }
export interface DesignTreeReader {
  readTreeFile(relPath: string): Promise<FailureDtoV1 | DesignTreeFileV1>;
  listTree(): Promise<FailureDtoV1 | readonly { relPath: string; sha256: Sha256Hex; size: number }[]>;
  readManifest(): Promise<FailureDtoV1 | PagesManifestV1>;
}
export interface TrustGate { /* project trust + P3's buildSourceSubject/isSourceGranted/grantSource */ }
```

**From `core/project`:**

```ts
export async function readCanonicalTreeIndex(deps: { designReader: DesignTreeReader; gateRunner: GateRunner }):
  Promise<FailureDtoV1 | CanonicalTreeIndexV1>;
export interface CanonicalTreeIndexV1 {
  readonly inventory: DesignTreeInventoryV1; readonly treeRevision: string;
  readonly pages: readonly PageEntryV1[]; readonly files: ReadonlyMap<string, string>;  // TREE-relative
  readonly closureHashOf: (slug: PageSlug) => string | null;
  readonly errors: readonly GateErrorV1[]; readonly warnings: readonly GateWarningV1[];
}
```

**If any name above differs at merge time**, adapt to the merged reality and say so in the task
report — never re-declare a second copy.

---

## Decisions this plan makes

Each was read in the code on branch `project-design-systems` and is cited. They are
implementation-level rulings the spec left open, plus the two P3-minor rulings the brief requires.

### D1 — The provenance record lives at `.termcraft/design-system-source.json`

§8.5 says "project state **outside** `design/`", and not in the manifest. Four candidates exist and
three are refused:

- **`project.toml`** is `z.strictObject` with a closed portable field set gated by
  `PROJECT_MANIFEST_FORMAT_VERSION` (`store/toml/model/project-toml.ts`). Adding a field means a
  format bump plus a migration step — and P4 is already stepping it 2 → 3. A second competing bump
  in the same feature branch is exactly the collision the wave model exists to avoid. **Refused.**
- **`workspace.local.toml`** is machine-local and hard-excluded from every Git commit scope
  (`.termcraft/.gitignore` lists `/workspace.local.toml` and `*.local*`). Provenance must travel
  with the project — a teammate opening the repo must see where the design system came from.
  **Refused.**
- **`cache/`** is gitignored (`/cache/`) and is, by name, discardable. Provenance is not a cache.
  **Refused.**
- **A new top-level `.termcraft/design-system-source.json`** — portable, not gitignored, carries
  its own `schemaVersion: 1`, needs no migration step (absence means "no recorded source", which is
  the truth for a project P4 scaffolded or migrated from the compiled seed — P4's own scope table
  states it writes no provenance record). **Chosen.**

Cost, stated: `store/safe-fs`'s `classifyProject` admits exactly three top-level `.termcraft`
files (`project.toml`, `workspace.local.toml`, `.gitignore`) and returns `null` — i.e.
`UnknownNamespaceError` — for anything else. Task 3 adds `design-system-source.json` to that list
as `project-config`. That is one line in a closed grammar that is *designed* to grow with the
feature set, and without it the transaction's own payload/limit check refuses the write.

The name is `design-system-**source**.json`, not `design-system.json`, so it can never be confused
with `design/system/design-system.json` — the manifest, which is content, not address.

**Assumption to reconcile at merge:** P4 creates no file under `.termcraft/` for design systems. If
P4 landed one, Task 3's implementer adopts it instead of creating a second and reports the change.

### D2 — M5 (`fetch` does not no-follow the package ROOT): **FIXED here**

`readPackageDirectory` refuses a symlinked *entry* (`walk.ts`, `entry.isSymbolicLink` →
`DesignSystemPackageInvalidError`), and `listLocalSystems` refuses a symlinked *library entry*
(`list.ts`: `if (!entry.isDirectory || entry.isSymbolicLink) { log.warn(…); continue; }`). But
`fetchLocalPackage` reaches the package by `deps.fs.listDir(localSystemDir(...))` — which follows a
symlinked `local/<id>` — so a link planted in the library is readable through `fetch` and would
reach the candidate. This is on P10's own install path, so P10 fixes it, and the fix needs **no**
`DesignSystemFsDeps` change: list the *parent* (`localLibraryDir`) and apply exactly the predicate
`list.ts` already applies to the `<id>` entry. Task 1.

### D3 — M11 (publish's destructive remove→rename window): **FIXED here**

`publishLocalPackage` currently does `removeDir(target)` then `renameDir(staging, target)`. A crash
between them destroys an already-published system with nothing left to recover. Task 2 replaces it
with a three-step swap that never deletes live data before the replacement is in place:

1. `renameDir(target → .retiring-<systemId>)` — the old system survives under a `.`-prefixed name
   that `parseDesignSystemId` refuses, so `list` cannot see it (the same property the existing
   `.publishing-` prefix relies on);
2. `renameDir(staging → target)`;
3. `removeDir(.retiring-<systemId>)`.

Plus a pre-flight sweep at the top of `publishLocalPackage`: if `.retiring-<systemId>` exists and
`target` does not, rename it back before doing anything else — so a crash between steps 1 and 2 is
repaired by the next publish instead of being permanent. The window does not become zero (no
filesystem primitive available here makes it zero, which is why the local library is deliberately
outside the transaction engine), but **data is never destroyed**, which is the property that was
missing. The `publish.ts` header comment is rewritten to state exactly this instead of the current
"THE WINDOW BETWEEN REMOVE AND RENAME IS REAL".

### D4 — Quarantine is shaped like a design tree, under the user-state root

`{userStateRoot}/design-systems/quarantine/<installId>/staging/design/system/**` then
`.../candidate/`. Two consequences, both deliberate:

- The `design/` prefix is what makes `classifyNamespace("workspace", "design/system/…")` return
  `design-source`, so `snapshotToCandidate`'s `createLimitBudget("workspace")` applies exactly the
  row §8.3 names — 512 files, 64 MiB aggregate, depth 8, 2 MiB per file — with no new namespace and
  no change to `NAMESPACE_LIMITS`.
- Quarantine is under `userStateRoot`, beside `sandboxes/` and `trust/`, **never** inside the
  project. A crash at any point before the transaction's `intent.json` therefore leaves the project
  byte-identical, and cleanup is `removeTree` on a directory nothing else owns.

`installId` is a UUIDv7, and the staging directory is created with `mkdirNew` (create-new), so a
collision is an error rather than a silent reuse — the same discipline
`store/sandbox`'s `createTurnWorkspace` uses.

### D5 — The Gate's candidate tree is composed in memory; the candidate on disk is the byte source

`GateRunner.runTree` takes `files: ReadonlyMap<string, string>` — an in-memory tree-relative map —
so materializing the *whole* design tree into quarantine to run the Gate would be pure waste; the
canonical tree is already in memory as `readCanonicalTreeIndex().files`.

What IS materialized is the untrusted package, because that is what quarantine, the limit budget
and the no-follow walk exist for. The candidate tree is then
`currentIndex.files` minus every key `isInsideDesignSystem(...)` accepts, plus the candidate
snapshot's files read back off disk.

The load-bearing part: **the bytes the Gate checks and the bytes the transaction writes are read
from the immutable candidate snapshot in one pass and never read again.** Re-reading the source
directory between the check and the commit would be a TOCTOU window on foreign input; reading the
candidate twice would be one too. Task 4 returns both the text map and the raw bytes from a single
read, and Task 7 threads that one object through the Gate and into the transaction.

### D6 — A fatal inside `system/` refuses the install; a fatal outside it is breakage the designer confirms

§8.3: "Replacing an installed system breaks pages that reference tokens the new one lacks. That is
not avoidable and is not hidden … the designer sees the list and decides." §12 restates it:
"Replacing a design system can break pages. Surfaced before commit; not prevented."

But that licence is about **pages**, not about a package that is itself broken. A manifest failing
its schema, a `components[]` entry that does not resolve, an import escaping `system/` — those are
§7 fatals about the package, and offering to install one would be offering to install something the
Gate has already said is not a design system. So:

- A `GateErrorV1` whose `file` is inside `system/` (per `isInsideDesignSystem`), **or whose `file`
  is absent** (a whole-tree fatal with no attribution), makes the preview `blocked`. The install
  command refuses with `DESIGN_SYSTEM_REJECTED`.
- Every other fatal is **breakage**: listed in full, confirmable, installed on confirmation.

Both cases show the designer the same complete list. `warnings` are always informational and never
block.

### D7 — The Gate pass freezes the shell, and the picker paints before it

`runTree`'s type stage drives `typescript/unstable/sync` on the calling thread.
`src/entrypoint/model/design-checker.ts`'s own header records the measurement: "ZERO ticks of a
10 ms interval across every run, i.e. a genuine freeze, not a slowdown", and the turn path
(`core/turns/model/validation.ts`) already takes the same freeze on every turn.

This plan does not fix that (it is not P10's defect and fixing it means moving the type check off
thread, a change to `gate` no plan in this feature owns). It DOES refuse to make it look like a
hang: the preview handler publishes `designSystem.previewStarted` **before** awaiting `runTree`, so
the picker has already painted "checking…" when the thread stops. Task 9 asserts the ordering in a
test, because an event published after the await would be indistinguishable from a crash.

### D8 — Picker design vocabulary: an explicit gap, filled from the two closest screens

**GAP, flagged per CLAUDE.md: `design/` has no design-system-picker screen.** None of the 27
`.dc.html` screens covers browsing, swatches, or installing a design system, and
`design/termcraft-engine.js` has no swatch-row helper. Nothing here may be invented; the two
closest existing vocabularies are used verbatim and the gap is recorded in the architecture docs
(Task 15) so a future design pass has somewhere to land.

**For the picker itself — `design/06-agent-model-picker.dc.html`, engine `agentPicker(w,h)`
(`design/termcraft-engine.js:474`–514):** a centred modal `box` with `fg: pal.amber` and
`titleFg: pal.amberHi`; a column-header row in `pal.faint` **bold**; rows carrying a `▸` marker in
`pal.amber` bold at `lx-1` and a `●`/`○` state dot (`pal.amber` when selected, `pal.dim`
otherwise); the selected row painted edge to edge with `bg: pal.sel` and text `pal.selFg` bold;
a `├`…`┤` rule in `pal.line` with `pal.amber` tees above the footer; and a footer hint reading
`↑↓ select   ⏎ apply   esc close` with the keys in `pal.amber` bold and the labels in `pal.dim`.

**For the breakage preview — `design/16-wizard-migration.dc.html`, engine `migrate(w,h)`
(`design/termcraft-engine.js:880`–892):** a `⚠ …` headline in `pal.amberHi` bold; a dim
"will … :" lead-in; `• ` bullets in `pal.fg`; a `pal.faint` consequence line; the same
`├`…`┤` rule; and a footer of `⏎ <verb>` in `pal.amber` bold followed by `· esc <alternative>` in
`pal.dim`.

**In code**, `src/ui/popups/ui/ChatListPopup.tsx` already renders that first vocabulary faithfully
(the `▸`/`●` markers, the `SHELL_PALETTE.sel`/`selFg` selection band, the right-aligned trailing
column) and `src/ui/setup/ui/MigratePrompt.tsx` renders the second. Both new components mirror
those files rather than deriving layout afresh, and take **every** colour from `ui/theme`'s
`SHELL_PALETTE` — which is itself transcribed verbatim from `termcraft-engine.js`'s `pal`.

The one genuinely new element is the **swatch row**. It has no design precedent, so it is built
from vocabulary the engine already uses for coloured cells: a run of `█` glyphs (the engine's own
filled-cell glyph — `bar()` at `termcraft-engine.js:58`, and the cursor block throughout), each
painted `fg` with one token's `#rrggbb` value, in the manifest's declaration order, truncated to
the width available. Recorded as a divergence in the component's header comment.

### D9 — Trust: every source is granted before it is queried; `local` is granted, not assumed

§8.4: "Adding a source is an explicit, recorded decision; an unrecorded remote source is never
queried." P3 landed `buildSourceSubject`/`isSourceGranted`/`grantSource`.

- Before `list()` or `fetch()`, the core-side lister calls `isSourceGranted(buildSourceSubject(...))`.
  An ungranted source is **not queried** and is reported to the picker as `ungranted` — the picker
  shows it, greyed, with the reason, and offers to grant.
- `local` is the user's own directory under their own state root, so the shell grants it
  **without a prompt** on first use — but it still calls `grantSource`, so the ledger stays the
  single authority on what was decided and a later kind change or path change is a fresh decision.
  Silently special-casing `local` as "always granted, never recorded" would put one source outside
  the mechanism the spec says every source is inside.
- `canonicalLocation` for `local` is `localLibraryDir(userStateRoot)`;
  `locationFilesystemIdentity` is `infrastructure/fs-guard`'s identity for that directory, or
  `null` when unavailable (the encoding already has an `absent` tag for it).

### D10 — An unreachable source degrades under a 3 s bound (§8.4)

The port has no `signal`, so the bound is a `Promise.race` in `core/design-systems` against a timer
resolved in a `finally`, with the loser abandoned (documented; a local `list` is bounded by the
filesystem anyway, and a network source that ignores a race is a bug in that adapter). The timeout
error is a tagged error extending `errore.AbortError` so `errore.isAbortError` finds it through a
`cause` chain. `DESIGN_SYSTEM_LIST_TIMEOUT_MS = 3000`. A timed-out or failed source becomes an
`unavailable` row in the picker with its `safeMessage`; the other sources still list.

### D11 — Install is `runProjectMutation`, not a new transaction kind

The engine's `project-mutation` wrapper already carries an arbitrary operation list, per-operation
CAS via `observeFileImage`, the payload/limit pre-check that "fails before intent", and the
idempotent roll-forward that `recoverTransactions` replays at `openProject`. A new top-level
transaction `kind` would duplicate all of it. Task 5 appends one `ProjectMutationKind` member,
`"design-system-install"`, exactly as phase-6 blocker B3 appended `"chat-creation"`,
`"page-reorder"` and `"page-remove"` "without disturbing any already-shipped kind's meaning".

---

## File structure

| File | Responsibility | Task |
| --- | --- | --- |
| `src/store/design-systems/model/admission.ts` (new) | `createDesignSourceAdmission()` — the real budget over `createLimitBudget` | 1 |
| `src/store/design-systems/model/fetch.ts` (modify) | M5: no-follow the package root | 1 |
| `src/store/design-systems/model/publish.ts` (modify) | M11: three-step swap + `.retiring-` sweep | 2 |
| `src/store/design-systems/model/provenance.ts` (new) | provenance record: schema, encode/decode, path constant | 3 |
| `src/store/safe-fs/model/limits.ts` (modify) | admit `design-system-source.json` as `project-config` | 3 |
| `src/store/design-systems/model/quarantine.ts` (new) | materialize → `snapshotToCandidate` → read back once | 4 |
| `src/store/transaction/model/wrappers.ts` (modify) | `"design-system-install"` kind + `buildDesignSystemInstallOperations` | 5 |
| `src/store/model/factory.ts` (modify) | `TransactionEngine.installDesignSystem` | 5 |
| `src/core/design-systems/model/candidate.ts` (new) | splice the candidate tree; classify Gate output into a preview | 6 |
| `src/core/design-systems/model/sources.ts` (new) | trust gate, bounded list, update detection | 7 |
| `src/core/design-systems/model/install.ts` (new) | the pipeline: fetch → quarantine → candidate → Gate → commit | 8 |
| `src/core/design-systems/{index.ts,types.ts}` (new) | module barrel and shared DTOs | 6 |
| `src/core/protocol/model/{command-kind,command-payload,event-kind,event-payload,failure}.ts` (modify) | 4 commands, 9 events, 1 failure code | 9 |
| `src/core/kernel/model/handlers/design-system.ts` (new) | the four handlers | 9 |
| `src/ui/mirror/{types.ts,model/mirror.ts}` (modify) | the `designSystems` slice | 10 |
| `src/ui/popups/model/design-system-picker.ts` (new) | swatch/contents/row view-model math | 11 |
| `src/ui/popups/ui/DesignSystemPicker.tsx` (new) | the picker overlay | 11 |
| `src/ui/popups/ui/DesignSystemInstallPrompt.tsx` (new) | breakage preview + install/publish confirm | 12 |
| `src/ui/{workspace/model/focus.ts,app/model/deps.ts,app/model/keymap.ts,app/model/intent.ts,app/ui/App.tsx,actions/model/registry.ts}` (modify) | overlay, selection atom, keys, intents, render, slash command | 13 |
| `src/entrypoint/model/create-shell.ts` (modify) | compose the local source, the admission budget, the port adapter | 14 |
| `docs/architecture/**` (modify) | the install pipeline, the provenance record, the picker design gap | 15 |

---

## Tasks

### Task 1: The real admission budget, and M5

**Files:**
- Create: `src/store/design-systems/model/admission.ts`
- Create: `src/store/design-systems/model/admission.test.ts`
- Modify: `src/store/design-systems/model/fetch.ts`
- Modify: `src/store/design-systems/model/fetch.test.ts`
- Modify: `src/store/design-systems/index.ts` (export the factory)

**Interfaces:**
- Consumes: `store/safe-fs`'s `createLimitBudget`, `LimitBudget`; `store/design-systems`'
  `PackageAdmission`, `LocalDesignSystemSourceDeps`, `localLibraryDir`, `localSystemDir`.
- Produces:
  ```ts
  export function createDesignSourceAdmission(): PackageAdmission;
  ```
  Task 14 hands its result to `createLocalDesignSystemSource`.

- [ ] **Step 1: Write the failing admission tests**

`src/store/design-systems/model/admission.test.ts`:

```ts
import { expect, test } from "bun:test";

import { createDesignSourceAdmission } from "./admission";

test("admits an ordinary package file", () => {
  const admission = createDesignSourceAdmission();
  expect(
    admission.admitFile({ relPath: "design-system.json", declaredSize: 1024, depth: 1 }),
  ).toBeNull();
  expect(admission.observeBytes({ relPath: "design-system.json", bytesRead: 1024 })).toBeNull();
});

test("refuses a file over the design-source per-file budget (2 MiB)", () => {
  const admission = createDesignSourceAdmission();
  const refusal = admission.admitFile({
    relPath: "components/Huge.tsx",
    declaredSize: 3 * 1024 * 1024,
    depth: 2,
  });
  expect(refusal).toBeInstanceOf(Error);
});

test("refuses a package past the 512-file cap", () => {
  const admission = createDesignSourceAdmission();
  const results = Array.from({ length: 600 }, (_unused, index) =>
    admission.admitFile({ relPath: `components/C${index}.tsx`, declaredSize: 8, depth: 2 }),
  );
  expect(results.slice(0, 512).every((result) => result === null)).toBe(true);
  expect(results[512]).toBeInstanceOf(Error);
});

test("refuses a file deeper than the design-source depth cap (8)", () => {
  const admission = createDesignSourceAdmission();
  expect(
    admission.admitFile({ relPath: "a/b/c/d/e/f/g/h/i.tsx", declaredSize: 8, depth: 9 }),
  ).toBeInstanceOf(Error);
});

test("observeBytes catches a file that grew past its declared size", () => {
  const admission = createDesignSourceAdmission();
  expect(admission.admitFile({ relPath: "big.tsx", declaredSize: 16, depth: 1 })).toBeNull();
  expect(
    admission.observeBytes({ relPath: "big.tsx", bytesRead: 3 * 1024 * 1024 }),
  ).toBeInstanceOf(Error);
});

test("each call returns a FRESH budget — two fetches never share an aggregate", () => {
  const first = createDesignSourceAdmission();
  const second = createDesignSourceAdmission();
  for (let index = 0; index < 400; index += 1) {
    first.admitFile({ relPath: `c${index}.tsx`, declaredSize: 8, depth: 1 });
  }
  expect(second.admitFile({ relPath: "c0.tsx", declaredSize: 8, depth: 1 })).toBeNull();
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `rtk bun run test src/store/design-systems/model/admission.test.ts`
Expected: FAIL — `Cannot find module "./admission"`.

- [ ] **Step 3: Write `admission.ts`**

```ts
import { createLimitBudget } from "store/safe-fs";

import type { PackageAdmission } from "../types";

/**
 * The REAL package budget (design §8.3, §13: "safe-fs limits sit between `fetch` and the
 * candidate"). P3 declared `PackageAdmission` REQUIRED and defaultless precisely so this could
 * not be forgotten; this is the function that satisfies it in production.
 *
 * `createLimitBudget("candidate")` is the root row an install's bytes are admitted under, and the
 * namespace is pinned to `"design-source"` — the one namespace a design system's files can ever
 * occupy (512 files, 64 MiB aggregate, depth 8, 2 MiB per file). `PackageAdmission` deliberately
 * carries no namespace, so it is supplied here rather than asked of every caller.
 *
 * A FRESH BUDGET PER CALL, never a module-level singleton: the aggregate counters are stateful,
 * and a shared instance would make the second fetch in one session fail because of the first.
 *
 * `observeBytes` maps `bytesRead` onto `LimitBudget`'s `bytesSoFar`. The two names differ because
 * `store/design-systems` reads whole files at once while `store/safe-fs` streams chunks; for a
 * whole-file read the running total IS the file's length, so the mapping is exact.
 */
export function createDesignSourceAdmission(): PackageAdmission {
  const budget = createLimitBudget("candidate");
  return {
    admitFile(input) {
      return budget.admitFile({
        relPath: input.relPath,
        namespace: "design-source",
        declaredSize: input.declaredSize,
        depth: input.depth,
      });
    },
    observeBytes(input) {
      return budget.observeBytes({
        relPath: input.relPath,
        namespace: "design-source",
        bytesSoFar: input.bytesRead,
      });
    },
  };
}
```

Export it from `src/store/design-systems/index.ts` beside `allowAllPackageAdmission`:

```ts
export { allowAllPackageAdmission, nodeDesignSystemFsDeps } from "./model/fs-deps";
export { createDesignSourceAdmission } from "./model/admission";
```

- [ ] **Step 4: Run the admission tests — green**

Run: `rtk bun run test src/store/design-systems/model/admission.test.ts`
Expected: PASS (6 tests).

If `createLimitBudget("candidate")`'s root row caps files/bytes below the `design-source` row, the
tighter of the two wins and the assertions above still hold; if a threshold differs, adjust the
test's numbers to the values in `src/store/safe-fs/model/limits.ts` and say so in the report — do
not change `limits.ts`.

- [ ] **Step 5: Write the failing M5 test**

Append to `src/store/design-systems/model/fetch.test.ts`, using that file's existing fixture
helpers (`src/store/design-systems/model/test-support.ts` — read it first and reuse its fake
`DesignSystemFsDeps` rather than writing a second one):

```ts
test("M5: a symlinked local/<id> is refused instead of being read through", async () => {
  const deps = createFixtureDeps({
    // `local/` lists `midnight` as a SYMLINK; the link target holds a perfectly valid package.
    library: [{ name: "midnight", isFile: false, isDirectory: true, isSymbolicLink: true }],
    systems: { midnight: validMidnightPackage() },
  });

  const fetched = await fetchLocalPackage(deps, {
    sourceId: LOCAL_SOURCE_ID,
    systemId: parsedId("midnight"),
    version: parsedVersion("1.2.0"),
  });

  expect(fetched).toBeInstanceOf(DesignSystemPackageInvalidError);
  expect(String((fetched as Error).message)).toContain("never links");
});

test("M5: a package root that is a plain directory still fetches", async () => {
  const deps = createFixtureDeps({
    library: [{ name: "midnight", isFile: false, isDirectory: true, isSymbolicLink: false }],
    systems: { midnight: validMidnightPackage() },
  });
  const fetched = await fetchLocalPackage(deps, {
    sourceId: LOCAL_SOURCE_ID,
    systemId: parsedId("midnight"),
    version: parsedVersion("1.2.0"),
  });
  expect(fetched).not.toBeInstanceOf(Error);
});
```

- [ ] **Step 6: Run it and watch the first case fail**

Run: `rtk bun run test src/store/design-systems/model/fetch.test.ts`
Expected: the symlink case FAILS (the fetch succeeds today).

- [ ] **Step 7: Fix M5 in `fetch.ts`**

Replace the current root probe:

```ts
  const packageRoot = localSystemDir(deps.userStateRoot, ref.systemId);
  const present = deps.fs.listDir(packageRoot);
  if (present instanceof Error) return present;
  if (present === null) {
```

with a check of the root's own directory ENTRY, read from the parent listing — the same predicate
`listLocalSystems` already applies (`list.ts`), so `list` and `fetch` can never disagree about what
the library contains:

```ts
  // NO-FOLLOW AT THE PACKAGE ROOT (design §13; P3 minor M5). `readPackageDirectory` refuses a
  // symlinked ENTRY, but the root itself was never checked — `listDir(local/<id>)` follows a
  // planted junction straight into a directory outside the library, and those bytes would reach
  // the candidate. `DesignSystemFsDeps` has no `lstat`, and it does not need one: the parent
  // listing already carries `isSymbolicLink` for the `<id>` entry, and this is the exact predicate
  // `listLocalSystems` applies, so the two can never disagree about what the library holds.
  const libraryDir = localLibraryDir(deps.userStateRoot);
  const libraryEntries = deps.fs.listDir(libraryDir);
  if (libraryEntries instanceof Error) return libraryEntries;
  if (libraryEntries === null) {
    return new DesignSystemRefRejectedError({
      ref: formatDesignSystemRef(ref),
      reason: "no such design system in the local library",
    });
  }

  const rootEntry = libraryEntries.find((entry) => entry.name === ref.systemId);
  if (rootEntry === undefined) {
    return new DesignSystemRefRejectedError({
      ref: formatDesignSystemRef(ref),
      reason: "no such design system in the local library",
    });
  }
  if (rootEntry.isSymbolicLink || !rootEntry.isDirectory) {
    return new DesignSystemPackageInvalidError({
      path: ref.systemId,
      reason: "package entries must be regular files or directories, never links",
    });
  }

  const packageRoot = localSystemDir(deps.userStateRoot, ref.systemId);
  const present = deps.fs.listDir(packageRoot);
  if (present instanceof Error) return present;
  if (present === null) {
```

Add `localLibraryDir` to the `./layout` import.

- [ ] **Step 8: Run the fetch tests — green**

Run: `rtk bun run test src/store/design-systems`
Expected: PASS, every existing test still green.

- [ ] **Step 9: Lint, format, commit**

```bash
rtk bun run lint && rtk bun run fmt:check
rtk git add src/store/design-systems && rtk git commit -m "feat(store): the real design-source admission budget, and no-follow at the package root"
```

Report: **+2 files** (`admission.ts`, `admission.test.ts`).

---

### Task 2: M11 — publish swaps instead of destroying

**Files:**
- Modify: `src/store/design-systems/model/publish.ts`
- Modify: `src/store/design-systems/model/publish.test.ts`

**Interfaces:**
- Consumes: `DesignSystemFsDeps.renameDir`/`removeDir`/`listDir` (all already present).
- Produces: no signature change — `publishLocalPackage`'s contract is unchanged; only its
  failure behaviour improves.

- [ ] **Step 1: Write the failing tests**

Append to `src/store/design-systems/model/publish.test.ts` (reuse the file's existing fixture
helpers):

```ts
test("M11: the existing system is renamed aside, never removed before the replacement lands", async () => {
  const calls: string[] = [];
  const deps = createFixtureDeps({
    existing: { midnight: previousMidnightPackage() },
    onFs: (op, target) => calls.push(`${op}:${path.basename(target)}`),
  });

  const receipt = await publishLocalPackage(deps, midnightPackage("1.3.0"));
  expect(receipt).not.toBeInstanceOf(Error);

  // The old system must move ASIDE before the new one moves IN, and only then be removed.
  const swap = calls.filter((entry) => entry.startsWith("rename") || entry.startsWith("remove"));
  expect(swap).toEqual([
    "remove:.publishing-midnight",
    "rename:.retiring-midnight",
    "rename:midnight",
    "remove:.retiring-midnight",
  ]);
});

test("M11: a crash between the two renames is repaired by the next publish", async () => {
  // Simulate the post-crash state: the target is gone, `.retiring-<id>` holds the old bytes.
  const deps = createFixtureDeps({
    retiring: { midnight: previousMidnightPackage() },
    existing: {},
  });

  const receipt = await publishLocalPackage(deps, midnightPackage("1.3.0"));
  expect(receipt).not.toBeInstanceOf(Error);
  // The sweep restored the old system first, so the publish replaced real data, not a hole.
  expect(deps.recordedSweep).toEqual(["rename:.retiring-midnight->midnight"]);
});

test("M11: `.retiring-` is invisible to `list`", async () => {
  const deps = createFixtureDeps({ retiring: { midnight: previousMidnightPackage() } });
  const listed = await listLocalSystems(deps);
  expect(listed).not.toBeInstanceOf(Error);
  expect((listed as readonly DesignSystemSummary[]).map((s) => s.id)).toEqual([]);
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `rtk bun run test src/store/design-systems/model/publish.test.ts`
Expected: FAIL — today's order is `remove:midnight` then `rename:midnight`, and there is no sweep.

- [ ] **Step 3: Add the retiring-directory helper and the pre-flight sweep**

In `publish.ts`, beside the existing staging path computation:

```ts
/**
 * Where a system being REPLACED is parked while the replacement moves in (P3 minor M11). A
 * `.`-prefixed name can never be mistaken for a system — `parseDesignSystemId` refuses a leading
 * `.`, so `list` skips it — which is the same property `.publishing-` already relies on.
 */
function retiringDir(userStateRoot: string, systemId: string): string {
  return path.join(localLibraryDir(userStateRoot), `.retiring-${systemId}`);
}
```

- [ ] **Step 4: Replace the destructive swap**

Replace:

```ts
  const removed = deps.fs.removeDir(target);
  if (removed instanceof Error) return removed;

  const renamed = deps.fs.renameDir(staging, target);
  if (renamed instanceof Error) return renamed;
```

with:

```ts
  // THREE-STEP SWAP (P3 minor M11). The old system is renamed ASIDE and only removed once the
  // replacement is in place, so no crash point deletes live data with nothing left to recover:
  //   crash after (1) -> `.retiring-<id>` holds the old bytes and the sweep above restores them;
  //   crash after (2) -> the new system is already installed and `.retiring-<id>` is litter.
  // The window is not zero — no primitive available at this layer makes it zero, which is why the
  // user's own library is deliberately outside the store's transaction engine (P10's INSTALL is
  // the transactional path, and it touches a design tree). What changed is that DATA IS NEVER
  // DESTROYED.
  const retiring = retiringDir(deps.userStateRoot, pkg.systemId);
  const clearedRetiring = deps.fs.removeDir(retiring);
  if (clearedRetiring instanceof Error) return clearedRetiring;

  const targetPresent = deps.fs.listDir(target);
  if (targetPresent instanceof Error) return targetPresent;
  if (targetPresent !== null) {
    const parked = deps.fs.renameDir(target, retiring);   // (1)
    if (parked instanceof Error) return parked;
  }

  const renamed = deps.fs.renameDir(staging, target);      // (2)
  if (renamed instanceof Error) return renamed;

  const discarded = deps.fs.removeDir(retiring);           // (3)
  if (discarded instanceof Error) {
    // Litter, not a fault: the publish succeeded and the next one clears it. Logged, never
    // swallowed (errore rule 21).
    log.warn("design-systems: could not remove the retired system directory:", discarded.message);
  }
```

Add `import { log } from "infrastructure/debug-log";` if it is not already imported.

- [ ] **Step 5: Add the pre-flight sweep**

Immediately after the `pkg.systemId`/`pkg.version` agreement check and before any file is written
(i.e. before `const cleared = deps.fs.removeDir(staging);`):

```ts
  // PRE-FLIGHT SWEEP (M11). A crash between the two renames leaves the target gone and the old
  // system parked at `.retiring-<id>`. Restoring it here makes that state transient rather than
  // permanent — and restoring BEFORE anything is written means a publish that then fails leaves
  // the library exactly as it found it.
  const retiringBefore = retiringDir(deps.userStateRoot, pkg.systemId);
  const strandedRetiring = deps.fs.listDir(retiringBefore);
  if (strandedRetiring instanceof Error) return strandedRetiring;
  if (strandedRetiring !== null) {
    const targetBefore = deps.fs.listDir(localSystemDir(deps.userStateRoot, pkg.systemId));
    if (targetBefore instanceof Error) return targetBefore;
    if (targetBefore === null) {
      const restored = deps.fs.renameDir(
        retiringBefore,
        localSystemDir(deps.userStateRoot, pkg.systemId),
      );
      if (restored instanceof Error) return restored;
    }
  }
```

- [ ] **Step 6: Rewrite the header comment**

The current header says "THE WINDOW BETWEEN REMOVE AND RENAME IS REAL and is stated rather than
hidden". Replace that paragraph with the truth after this task:

```
 * STAGE, SWAP, THEN DISCARD. Files land in `local/.publishing-<systemId>/`; the existing system is
 * renamed aside to `local/.retiring-<systemId>/`; the staging directory is renamed into place; the
 * retired copy is removed. A crash at any point leaves either the old system or the new one whole,
 * and a crash between the two renames is repaired by the next publish's pre-flight sweep. This is
 * NOT a transaction — the user's own library is deliberately outside the store's transaction
 * engine, and the transactional path is P10's INSTALL (§8.3), which is the one that touches a
 * design tree — but it never destroys data it cannot recover.
```

- [ ] **Step 7: Run — green**

Run: `rtk bun run test src/store/design-systems`
Expected: PASS.

- [ ] **Step 8: Lint, format, commit**

```bash
rtk bun run lint && rtk bun run fmt:check
rtk git add src/store/design-systems && rtk git commit -m "fix(store): publish swaps the retired system aside instead of deleting it first"
```

Report: **+0 files**.

---

### Task 3: The provenance record

**Files:**
- Create: `src/store/design-systems/model/provenance.ts`
- Create: `src/store/design-systems/model/provenance.test.ts`
- Modify: `src/store/safe-fs/model/limits.ts` (one line in `classifyProject`)
- Modify: `src/store/safe-fs/model/limits.test.ts`
- Modify: `src/store/design-systems/index.ts`

**Interfaces:**
- Consumes: `entities/design-system-ref`'s `DesignSystemRef`, `formatDesignSystemRef`,
  `parseDesignSystemRef`; `store/design-systems`' `Sha256Hex`.
- Produces:
  ```ts
  export const DESIGN_SYSTEM_PROVENANCE_FILENAME = "design-system-source.json";   // PROJECT-relative, top level of `.termcraft/`
  export const DESIGN_SYSTEM_PROVENANCE_SCHEMA_VERSION = 1;
  export interface DesignSystemProvenanceV1 {
    readonly schemaVersion: typeof DESIGN_SYSTEM_PROVENANCE_SCHEMA_VERSION;
    readonly ref: DesignSystemRef;
    readonly contentHash: Sha256Hex;
    /** RFC 3339 UTC. */
    readonly installedAt: string;
  }
  export class DesignSystemProvenanceInvalidError extends errore.createTaggedError({ … }) {}
  export function encodeDesignSystemProvenance(record: DesignSystemProvenanceV1): Uint8Array;
  export function decodeDesignSystemProvenance(bytes: Uint8Array): DesignSystemProvenanceInvalidError | DesignSystemProvenanceV1;
  ```
  Task 5 writes it inside the install transaction; Task 7 reads it for the update check.

- [ ] **Step 1: Write the failing tests**

`src/store/design-systems/model/provenance.test.ts`:

```ts
import { expect, test } from "bun:test";

import { parseDesignSystemRef } from "entities/design-system-ref";

import {
  DESIGN_SYSTEM_PROVENANCE_FILENAME,
  DESIGN_SYSTEM_PROVENANCE_SCHEMA_VERSION,
  DesignSystemProvenanceInvalidError,
  decodeDesignSystemProvenance,
  encodeDesignSystemProvenance,
} from "./provenance";

const REF = parseDesignSystemRef("local:midnight@1.2.0");
const HASH = "a".repeat(64);

function record() {
  if (REF instanceof Error) throw REF;
  return {
    schemaVersion: DESIGN_SYSTEM_PROVENANCE_SCHEMA_VERSION,
    ref: REF,
    contentHash: HASH,
    installedAt: "2026-08-12T10:00:00.000Z",
  } as const;
}

test("the file sits at the top of `.termcraft/`, never inside `design/`", () => {
  expect(DESIGN_SYSTEM_PROVENANCE_FILENAME).toBe("design-system-source.json");
  expect(DESIGN_SYSTEM_PROVENANCE_FILENAME).not.toContain("/");
});

test("round-trips through encode/decode", () => {
  const decoded = decodeDesignSystemProvenance(encodeDesignSystemProvenance(record()));
  expect(decoded).toEqual(record());
});

test("the reference is stored as its canonical `source:system@version` text", () => {
  const text = new TextDecoder().decode(encodeDesignSystemProvenance(record()));
  expect(JSON.parse(text) as unknown).toMatchObject({ ref: "local:midnight@1.2.0" });
});

test("a newer schemaVersion is rejected, never silently accepted", () => {
  const bytes = new TextEncoder().encode(
    JSON.stringify({ ...record(), ref: "local:midnight@1.2.0", schemaVersion: 2 }),
  );
  expect(decodeDesignSystemProvenance(bytes)).toBeInstanceOf(DesignSystemProvenanceInvalidError);
});

test("an unparseable reference is rejected", () => {
  const bytes = new TextEncoder().encode(
    JSON.stringify({ ...record(), ref: "not a reference", schemaVersion: 1 }),
  );
  expect(decodeDesignSystemProvenance(bytes)).toBeInstanceOf(DesignSystemProvenanceInvalidError);
});

test("an unknown key is rejected (strictObject)", () => {
  const bytes = new TextEncoder().encode(
    JSON.stringify({ ...record(), ref: "local:midnight@1.2.0", installedBy: "someone" }),
  );
  expect(decodeDesignSystemProvenance(bytes)).toBeInstanceOf(DesignSystemProvenanceInvalidError);
});

test("a non-hex content hash is rejected", () => {
  const bytes = new TextEncoder().encode(
    JSON.stringify({ ...record(), ref: "local:midnight@1.2.0", contentHash: "zz" }),
  );
  expect(decodeDesignSystemProvenance(bytes)).toBeInstanceOf(DesignSystemProvenanceInvalidError);
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `rtk bun run test src/store/design-systems/model/provenance.test.ts`
Expected: FAIL — `Cannot find module "./provenance"`.

- [ ] **Step 3: Write `provenance.ts`**

Model it on `src/store/design-systems/model/cache-entry.ts` — read that file first and match its
decode shape (`errore.try({ try, catch })` around `JSON.parse`, a `z.strictObject`, an
`InvalidError` carrying `$path`/`$reason`), so the two records are recognisably siblings.

```ts
import * as errore from "errore";
import { z } from "zod";

import type { DesignSystemRef } from "entities/design-system-ref";
import { formatDesignSystemRef, parseDesignSystemRef } from "entities/design-system-ref";
import { rfc3339UtcSchema } from "infrastructure/clock";

import type { Sha256Hex } from "../types";

/**
 * The project's record of WHERE its design system came from (design §8.5), in project state
 * OUTSIDE `design/`.
 *
 * NOT INSIDE THE MANIFEST, by the spec's own argument: "a package published back out would then
 * carry a claim about its own origin that stops being true on the first republish."
 *
 * NOT INSIDE `project.toml`: that file is the PORTABLE manifest, a `z.strictObject` gated by
 * `PROJECT_MANIFEST_FORMAT_VERSION`, so a new field costs a format bump and a migration step.
 * NOT INSIDE `workspace.local.toml`: that file is machine-local and excluded from every commit
 * scope, and provenance has to travel with the project. NOT UNDER `cache/`: gitignored, and
 * discardable by name. So: its own small, versioned, portable file at the top of `.termcraft/`.
 *
 * ABSENCE IS MEANINGFUL AND IS NOT AN ERROR. A project whose design system came from the compiled
 * seed — every project P4 scaffolds or migrates — has no source to record, and says so by having
 * no file. Only an install writes one.
 *
 * The `contentHash` beside the reference is what makes the address checkable rather than trusted
 * (§8.2, §8.5): a source can republish a version, and re-fetching the same address later is
 * compared against the bytes the project actually installed, not just the version string.
 */
export const DESIGN_SYSTEM_PROVENANCE_FILENAME = "design-system-source.json";

export const DESIGN_SYSTEM_PROVENANCE_SCHEMA_VERSION = 1;

export interface DesignSystemProvenanceV1 {
  readonly schemaVersion: typeof DESIGN_SYSTEM_PROVENANCE_SCHEMA_VERSION;
  readonly ref: DesignSystemRef;
  readonly contentHash: Sha256Hex;
  /** RFC 3339 UTC. */
  readonly installedAt: string;
}

export class DesignSystemProvenanceInvalidError extends errore.createTaggedError({
  name: "DesignSystemProvenanceInvalidError",
  message: "$path is not a valid design-system provenance record [$code]: $reason",
}) {}

const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);

/** The reference is stored as its CANONICAL TEXT, so the file reads as the address it names. */
const provenanceSchema = z.strictObject({
  schemaVersion: z.literal(DESIGN_SYSTEM_PROVENANCE_SCHEMA_VERSION),
  ref: z.string().min(1),
  contentHash: sha256HexSchema,
  installedAt: rfc3339UtcSchema,
});

export function encodeDesignSystemProvenance(record: DesignSystemProvenanceV1): Uint8Array {
  return new TextEncoder().encode(
    `${JSON.stringify(
      {
        schemaVersion: record.schemaVersion,
        ref: formatDesignSystemRef(record.ref),
        contentHash: record.contentHash,
        installedAt: record.installedAt,
      },
      null,
      2,
    )}\n`,
  );
}

export function decodeDesignSystemProvenance(
  bytes: Uint8Array,
): DesignSystemProvenanceInvalidError | DesignSystemProvenanceV1 {
  const text = errore.try({
    try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    catch: (cause) =>
      new DesignSystemProvenanceInvalidError({
        path: DESIGN_SYSTEM_PROVENANCE_FILENAME,
        code: "NOT_UTF8",
        reason: "the file is not valid UTF-8",
        cause,
      }),
  });
  if (text instanceof Error) return text;

  const parsed = errore.try({
    try: () => JSON.parse(text) as unknown,
    catch: (cause) =>
      new DesignSystemProvenanceInvalidError({
        path: DESIGN_SYSTEM_PROVENANCE_FILENAME,
        code: "NOT_JSON",
        reason: "the file is not JSON",
        cause,
      }),
  });
  if (parsed instanceof Error) return parsed;

  const shape = provenanceSchema.safeParse(parsed);
  if (!shape.success) {
    return new DesignSystemProvenanceInvalidError({
      path: DESIGN_SYSTEM_PROVENANCE_FILENAME,
      code: "SHAPE",
      reason: shape.error.issues.map((issue) => issue.message).join("; "),
    });
  }

  const ref = parseDesignSystemRef(shape.data.ref);
  if (ref instanceof Error) {
    return new DesignSystemProvenanceInvalidError({
      path: DESIGN_SYSTEM_PROVENANCE_FILENAME,
      code: "REF",
      reason: ref.message,
      cause: ref,
    });
  }

  return {
    schemaVersion: shape.data.schemaVersion,
    ref,
    contentHash: shape.data.contentHash,
    installedAt: shape.data.installedAt,
  };
}
```

If `rfc3339UtcSchema` is not exported from `infrastructure/clock` under that name, use whatever
`src/store/toml/model/project-toml.ts` imports for `created_at` and say so in the report.

- [ ] **Step 4: Run — green**

Run: `rtk bun run test src/store/design-systems/model/provenance.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Write the failing `limits.ts` test**

Append to `src/store/safe-fs/model/limits.test.ts` (match the file's existing call style for
`classifyNamespace`):

```ts
test("`.termcraft/design-system-source.json` is admitted as project-config", () => {
  expect(classifyNamespace("project", "design-system-source.json")).toBe("project-config");
});

test("an arbitrary new top-level file is still refused", () => {
  expect(classifyNamespace("project", "whatever.json")).toBeInstanceOf(Error);
});
```

- [ ] **Step 6: Run and watch the first fail**

Run: `rtk bun run test src/store/safe-fs/model/limits.test.ts`
Expected: the first case FAILS with an `UnknownNamespaceError`.

- [ ] **Step 7: Admit the file in `classifyProject`**

In `src/store/safe-fs/model/limits.ts`, in `classifyProject`'s `components.length === 1` branch,
extend the closed list:

```ts
  if (components.length === 1) {
    // `design-system-source.json` is the project's provenance record (project-design-systems
    // §8.5): the `source:system@version` its design system came from, plus that package's content
    // hash. Portable and Git-tracked like `project.toml`, but versioned by its OWN `schemaVersion`
    // rather than by `format_version`, so it needs no migration step and its absence simply means
    // "this project's design system came from the compiled seed, not from a source".
    if (
      first === "project.toml" ||
      first === "workspace.local.toml" ||
      first === ".gitignore" ||
      first === "design-system-source.json"
    )
      return "project-config";
    return null;
  }
```

Do **not** import `DESIGN_SYSTEM_PROVENANCE_FILENAME` here — `store/safe-fs` sits below
`store/design-systems` and importing upward would invert the dependency. The literal is duplicated
deliberately; `provenance.test.ts` pins the constant and `limits.test.ts` pins the literal, so a
divergence fails a test.

- [ ] **Step 8: Run both suites — green**

Run: `rtk bun run test src/store/safe-fs src/store/design-systems`
Expected: PASS.

- [ ] **Step 9: Export, lint, format, commit**

Add to `src/store/design-systems/index.ts`:

```ts
export type { DesignSystemProvenanceV1 } from "./model/provenance";
export {
  DESIGN_SYSTEM_PROVENANCE_FILENAME,
  DESIGN_SYSTEM_PROVENANCE_SCHEMA_VERSION,
  DesignSystemProvenanceInvalidError,
  decodeDesignSystemProvenance,
  encodeDesignSystemProvenance,
} from "./model/provenance";
```

```bash
rtk bun run lint && rtk bun run fmt:check
rtk git add src/store && rtk git commit -m "feat(store): the design-system provenance record at .termcraft/design-system-source.json"
```

Report: **+2 files** (`provenance.ts`, `provenance.test.ts`).

---

### Task 4: Quarantine and the immutable candidate

**Files:**
- Create: `src/store/design-systems/model/quarantine.ts`
- Create: `src/store/design-systems/model/quarantine.test.ts`
- Modify: `src/store/design-systems/index.ts`

**Interfaces:**
- Consumes: `store/safe-fs`'s `openManagedRoot`, `snapshotToCandidate`, `nodeCandidateDeps`,
  `nodeSafeFsDeps`, `CandidateSnapshot`; `store/design-systems`' `PackageFile`,
  `designSystemsRoot`, `designSystemContentHash`.
- Produces:
  ```ts
  export const QUARANTINE_DIRNAME = "quarantine";
  export interface QuarantineDeps {
    readonly userStateRoot: string;
    readonly fs: QuarantineFsDeps;
  }
  export interface QuarantineFsDeps {
    readonly mkdirAll: (absDir: string) => Error | undefined;
    readonly mkdirNew: (absDir: string) => Error | undefined;
    readonly durableWrite: (absPath: string, bytes: Uint8Array) => Error | undefined;
    readonly readFile: (absPath: string) => Uint8Array | Error;
    readonly removeTree: (absPath: string) => void;
    readonly openRoot: (absDir: string) => ManagedRoot | Error;
    readonly snapshot: (input: { source: ManagedRoot; destRoot: string }) => Error | CandidateSnapshot;
  }
  export function nodeQuarantineFsDeps(): QuarantineFsDeps;
  export class QuarantineFailedError extends errore.createTaggedError({ … }) {}
  /** Every file of the admitted candidate, package-relative, read exactly once. */
  export interface AdmittedPackage {
    readonly installId: string;
    readonly quarantineRoot: string;
    readonly contentHash: Sha256Hex;
    readonly files: readonly PackageFile[];   // package-relative, e.g. "design-system.json"
    readonly totalBytes: number;
  }
  export function admitPackageThroughQuarantine(
    deps: QuarantineDeps,
    input: { readonly installId: string; readonly files: readonly PackageFile[] },
  ): QuarantineFailedError | Error | AdmittedPackage;
  export function discardQuarantine(deps: QuarantineDeps, installId: string): void;
  ```
  Task 8 calls both.

- [ ] **Step 1: Write the failing tests**

`src/store/design-systems/model/quarantine.test.ts` — use a real temporary directory
(`fs.mkdtempSync(path.join(os.tmpdir(), "termcraft-quarantine-"))` in `beforeEach`, removed in
`afterEach`) and `nodeQuarantineFsDeps()`, because the whole point of this unit is the real
`snapshotToCandidate` walk:

```ts
test("materializes the package under design/system/ and returns it read back from the candidate", () => {
  const admitted = admitPackageThroughQuarantine(deps, {
    installId: INSTALL_ID,
    files: [
      { relPath: "design-system.json", bytes: encode(MANIFEST_TEXT) },
      { relPath: "components/Button.tsx", bytes: encode("export const Button = () => null;\n") },
    ],
  });
  expect(admitted).not.toBeInstanceOf(Error);
  const value = admitted as AdmittedPackage;
  expect(value.files.map((f) => f.relPath).sort()).toEqual([
    "components/Button.tsx",
    "design-system.json",
  ]);
  expect(decode(value.files[1]!.bytes)).toBe(MANIFEST_TEXT);
});

test("the content hash equals designSystemContentHash over the same files", () => {
  const files = [{ relPath: "design-system.json", bytes: encode(MANIFEST_TEXT) }];
  const admitted = admitPackageThroughQuarantine(deps, { installId: INSTALL_ID, files });
  expect((admitted as AdmittedPackage).contentHash).toBe(designSystemContentHash(files));
});

test("§11: a package exceeding the safe-fs limits is REJECTED BEFORE it reaches the candidate", () => {
  const oversize = new Uint8Array(3 * 1024 * 1024);   // per-file cap is 2 MiB
  const admitted = admitPackageThroughQuarantine(deps, {
    installId: INSTALL_ID,
    files: [
      { relPath: "design-system.json", bytes: encode(MANIFEST_TEXT) },
      { relPath: "components/Huge.tsx", bytes: oversize },
    ],
  });
  expect(admitted).toBeInstanceOf(Error);
  // The candidate directory must not exist — the limits ran before it was created.
  expect(fs.existsSync(path.join(quarantineDirFor(INSTALL_ID), "candidate"))).toBe(false);
});

test("§11: a package past the 512-file cap is rejected before the candidate", () => {
  const files = [
    { relPath: "design-system.json", bytes: encode(MANIFEST_TEXT) },
    ...Array.from({ length: 600 }, (_unused, index) => ({
      relPath: `components/C${index}.tsx`,
      bytes: encode("export const C = () => null;\n"),
    })),
  ];
  expect(
    admitPackageThroughQuarantine(deps, { installId: INSTALL_ID, files }),
  ).toBeInstanceOf(Error);
  expect(fs.existsSync(path.join(quarantineDirFor(INSTALL_ID), "candidate"))).toBe(false);
});

test("a path escaping the package root is refused", () => {
  expect(
    admitPackageThroughQuarantine(deps, {
      installId: INSTALL_ID,
      files: [{ relPath: "../outside.tsx", bytes: encode("x") }],
    }),
  ).toBeInstanceOf(Error);
});

test("quarantine lives under the user-state root, never inside a project", () => {
  admitPackageThroughQuarantine(deps, {
    installId: INSTALL_ID,
    files: [{ relPath: "design-system.json", bytes: encode(MANIFEST_TEXT) }],
  });
  expect(quarantineDirFor(INSTALL_ID).startsWith(userStateRoot)).toBe(true);
});

test("discardQuarantine removes the whole install directory and is idempotent", () => {
  admitPackageThroughQuarantine(deps, {
    installId: INSTALL_ID,
    files: [{ relPath: "design-system.json", bytes: encode(MANIFEST_TEXT) }],
  });
  discardQuarantine(deps, INSTALL_ID);
  expect(fs.existsSync(quarantineDirFor(INSTALL_ID))).toBe(false);
  discardQuarantine(deps, INSTALL_ID);   // no throw, no error
});

test("a second install with the same id is a collision, never a silent reuse", () => {
  const files = [{ relPath: "design-system.json", bytes: encode(MANIFEST_TEXT) }];
  expect(admitPackageThroughQuarantine(deps, { installId: INSTALL_ID, files })).not.toBeInstanceOf(Error);
  expect(admitPackageThroughQuarantine(deps, { installId: INSTALL_ID, files })).toBeInstanceOf(Error);
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `rtk bun run test src/store/design-systems/model/quarantine.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `quarantine.ts`**

```ts
import path from "node:path";

import * as errore from "errore";

import { log } from "infrastructure/debug-log";
import type { CandidateSnapshot, ManagedRoot } from "store/safe-fs";
import {
  nodeCandidateDeps,
  nodeSafeFsDeps,
  openManagedRoot,
  snapshotToCandidate,
} from "store/safe-fs";

import type { PackageFile, Sha256Hex } from "../types";
import { designSystemContentHash, normalizePackageRelPath } from "./content-hash";
import { designSystemsRoot } from "./layout";

/**
 * QUARANTINE (design §8.3). `fetch` returns bytes and writes nothing; this is where those bytes
 * are first written down, and it is deliberately NOT inside the project:
 * `{userStateRoot}/design-systems/quarantine/<installId>/`, beside `sandboxes/` and `trust/`. A
 * crash at any point before the install transaction's `intent.json` therefore leaves the project
 * byte-identical, and cleanup is a `removeTree` on a directory nothing else owns.
 *
 * THE `design/` PREFIX IS LOAD-BEARING. Files are staged at
 * `<installId>/staging/design/system/<packageRelPath>` so that
 * `classifyNamespace("workspace", …)` returns `design-source` — which is exactly the row §8.3
 * names (512 files, 64 MiB aggregate, depth 8, 2 MiB per file). No new namespace, no change to
 * `NAMESPACE_LIMITS`, and the limits that apply to an agent's turn workspace apply here verbatim.
 *
 * THE CANDIDATE IS WHERE THE LIMITS ACTUALLY BITE. `snapshotToCandidate` enumerates the whole
 * staging tree against `createLimitBudget("candidate")` and against the no-follow walk BEFORE it
 * creates the destination directory at all — so an oversized or over-numerous package is refused
 * with no candidate ever existing, which is §11's "a fetched package exceeding safe-fs limits is
 * rejected before it reaches the candidate", asserted rather than asserted-about.
 *
 * THE BYTES ARE READ BACK EXACTLY ONCE, out of the immutable candidate, and that one read feeds
 * both the Gate and the install transaction. Reading the staging tree for the Gate and the
 * candidate for the commit — or reading the candidate twice — would be a TOCTOU window on foreign
 * input for no benefit.
 */
export const QUARANTINE_DIRNAME = "quarantine";

/** Inside the staging tree, the package sits where it will sit in the project. */
const STAGED_PACKAGE_PREFIX = "design/system";

export class QuarantineFailedError extends errore.createTaggedError({
  name: "QuarantineFailedError",
  message: "quarantine $stage failed for $path: $reason",
}) {}

export interface QuarantineFsDeps {
  readonly mkdirAll: (absDir: string) => Error | undefined;
  readonly mkdirNew: (absDir: string) => Error | undefined;
  readonly durableWrite: (absPath: string, bytes: Uint8Array) => Error | undefined;
  readonly readFile: (absPath: string) => Uint8Array | Error;
  readonly removeTree: (absPath: string) => void;
  readonly openRoot: (absDir: string) => ManagedRoot | Error;
  readonly snapshot: (input: {
    readonly source: ManagedRoot;
    readonly destRoot: string;
  }) => Error | CandidateSnapshot;
}

export interface QuarantineDeps {
  readonly userStateRoot: string;
  readonly fs: QuarantineFsDeps;
}

export interface AdmittedPackage {
  readonly installId: string;
  readonly quarantineRoot: string;
  readonly contentHash: Sha256Hex;
  /** PACKAGE-relative, read once out of the immutable candidate. */
  readonly files: readonly PackageFile[];
  readonly totalBytes: number;
}

export function quarantineRootDir(userStateRoot: string): string {
  return path.join(designSystemsRoot(userStateRoot), QUARANTINE_DIRNAME);
}

export function quarantineInstallDir(userStateRoot: string, installId: string): string {
  return path.join(quarantineRootDir(userStateRoot), installId);
}

/** The real Node wiring, built from `store/safe-fs`'s own primitives so no second fs vocabulary appears. */
export function nodeQuarantineFsDeps(): QuarantineFsDeps { /* implemented in Step 4 */ }

export function admitPackageThroughQuarantine(
  deps: QuarantineDeps,
  input: { readonly installId: string; readonly files: readonly PackageFile[] },
): QuarantineFailedError | Error | AdmittedPackage {
  const installDir = quarantineInstallDir(deps.userStateRoot, input.installId);
  const stagingDir = path.join(installDir, "staging");
  const candidateDir = path.join(installDir, "candidate");

  const parent = deps.fs.mkdirAll(quarantineRootDir(deps.userStateRoot));
  if (parent instanceof Error)
    return new QuarantineFailedError({ stage: "mkdir", path: installDir, reason: parent.message, cause: parent });

  // CREATE-NEW, never reuse: a collision is a fault, exactly as it is in `store/sandbox`'s
  // `createTurnWorkspace`. From here on this directory is owned, so every failure discards it.
  const created = deps.fs.mkdirNew(installDir);
  if (created instanceof Error)
    return new QuarantineFailedError({ stage: "create", path: installDir, reason: created.message, cause: created });

  const discard = () => deps.fs.removeTree(installDir);

  for (const file of input.files) {
    const relPath = normalizePackageRelPath(file.relPath);
    const segments = relPath.split("/");
    if (relPath === "" || segments.includes("..") || segments.includes(".") || segments.includes("")) {
      discard();
      return new QuarantineFailedError({
        stage: "stage",
        path: file.relPath,
        reason: "package paths must stay inside the package root",
      });
    }
    const absPath = path.join(stagingDir, STAGED_PACKAGE_PREFIX, ...segments);
    const dir = deps.fs.mkdirAll(path.dirname(absPath));
    if (dir instanceof Error) {
      discard();
      return new QuarantineFailedError({ stage: "stage", path: absPath, reason: dir.message, cause: dir });
    }
    const wrote = deps.fs.durableWrite(absPath, file.bytes);
    if (wrote instanceof Error) {
      discard();
      return new QuarantineFailedError({ stage: "stage", path: absPath, reason: wrote.message, cause: wrote });
    }
  }

  const root = deps.fs.openRoot(stagingDir);
  if (root instanceof Error) {
    discard();
    return root;
  }

  // THE LIMITS. `snapshotToCandidate` enumerates and admits every entry BEFORE creating
  // `candidateDir`, so a refusal here leaves no candidate at all.
  const snapshot = deps.fs.snapshot({ source: root, destRoot: candidateDir });
  if (snapshot instanceof Error) {
    discard();
    return snapshot;
  }

  const files: PackageFile[] = [];
  for (const entry of snapshot.files) {
    const packageRelPath = entry.relPath.startsWith(`${STAGED_PACKAGE_PREFIX}/`)
      ? entry.relPath.slice(STAGED_PACKAGE_PREFIX.length + 1)
      : null;
    if (packageRelPath === null) {
      discard();
      return new QuarantineFailedError({
        stage: "read-back",
        path: entry.relPath,
        reason: `candidate holds a file outside ${STAGED_PACKAGE_PREFIX}/`,
      });
    }
    const bytes = deps.fs.readFile(path.join(snapshot.root, ...entry.relPath.split("/")));
    if (bytes instanceof Error) {
      discard();
      return new QuarantineFailedError({
        stage: "read-back",
        path: entry.relPath,
        reason: bytes.message,
        cause: bytes,
      });
    }
    files.push({ relPath: packageRelPath, bytes });
  }

  const contentHash = designSystemContentHash(files);
  if (contentHash instanceof Error) {
    discard();
    return contentHash;
  }

  return {
    installId: input.installId,
    quarantineRoot: installDir,
    contentHash,
    files,
    totalBytes: snapshot.totalBytes,
  };
}

/** Best-effort and idempotent: quarantine is disposable by construction, so a failure to clear it is litter, not a fault. */
export function discardQuarantine(deps: QuarantineDeps, installId: string): void {
  deps.fs.removeTree(quarantineInstallDir(deps.userStateRoot, installId));
  log.info("design-systems: discarded quarantine", installId);
}
```

- [ ] **Step 4: Write `nodeQuarantineFsDeps`**

Build it on `store/safe-fs`'s own primitives — do NOT hand-roll a second `fs` vocabulary:

```ts
export function nodeQuarantineFsDeps(): QuarantineFsDeps {
  const candidateDeps = nodeCandidateDeps();
  const noFollowDeps = nodeSafeFsDeps();
  return {
    mkdirAll: (absDir) => candidateDeps.mkdirAll(absDir),
    mkdirNew: (absDir) => candidateDeps.mkdirNew(absDir),
    durableWrite: (absPath, bytes) => {
      const sink = candidateDeps.createNewSink(absPath);
      if (sink instanceof Error) return sink;
      const wrote = sink.write(bytes);
      if (wrote instanceof Error) {
        sink.close();
        return wrote;
      }
      return sink.close();
    },
    readFile: (absPath) => {
      const handle = candidateDeps.openSource(absPath);
      if (handle instanceof Error) return handle;
      const chunks: Uint8Array[] = [];
      for (;;) {
        const chunk = handle.read();
        if (chunk instanceof Error) {
          handle.close();
          return chunk;
        }
        if (chunk === null) break;
        chunks.push(chunk);
      }
      handle.close();
      const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
      const out = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return out;
    },
    removeTree: (absPath) => candidateDeps.removeTree(absPath),
    openRoot: (absDir) => openManagedRoot({ kind: "workspace", path: absDir, deps: noFollowDeps }),
    snapshot: (input) =>
      snapshotToCandidate({ source: input.source, destRoot: input.destRoot, deps: candidateDeps }),
  };
}
```

If `CandidateDeps`' `SourceHandle.read()` has different chunking semantics than assumed, adapt to
its real contract (read `src/store/safe-fs/model/candidate.ts` first) and report the divergence.

- [ ] **Step 5: Run — green**

Run: `rtk bun run test src/store/design-systems/model/quarantine.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 6: Export, lint, format, commit**

Add the module's public names to `src/store/design-systems/index.ts`, then:

```bash
rtk bun run lint && rtk bun run fmt:check
rtk git add src/store/design-systems && rtk git commit -m "feat(store): quarantine a fetched design system into an immutable, limit-checked candidate"
```

Report: **+2 files**.

---

### Task 5: The install transaction

**Files:**
- Modify: `src/store/transaction/model/wrappers.ts`
- Modify: `src/store/transaction/index.ts`
- Modify: `src/store/model/factory.ts`
- Modify: `src/store/types.ts` (the `TransactionEngine` interface + the input type)
- Create: `src/store/model/design-system-install.test.ts`

**Interfaces:**
- Consumes: `runProjectMutation`, `observeFileImage`, `designFilePath`, `BuiltPageOperation`;
  `store/design-systems`' `DESIGN_SYSTEM_PROVENANCE_FILENAME`, `encodeDesignSystemProvenance`.
- Produces:
  ```ts
  // store/transaction
  export type ProjectMutationKind = … | "design-system-install";
  export interface DesignSystemInstallFile { readonly treeRelPath: string; readonly bytes: Uint8Array }   // TREE-relative, e.g. "system/design-system.json"
  export function buildDesignSystemInstallOperations(
    deps: TransactionWrapperDeps,
    input: {
      readonly nextFiles: readonly DesignSystemInstallFile[];
      readonly removedTreeRelPaths: readonly string[];
      readonly provenanceBytes: Uint8Array;
    },
  ): SafeFsError | readonly BuiltPageOperation[];

  // store (TransactionEngine)
  export interface InstallDesignSystemInput {
    readonly transactionId: string; readonly actionId: string;
    readonly nextFiles: readonly DesignSystemInstallFile[];
    readonly removedTreeRelPaths: readonly string[];
    readonly provenanceBytes: Uint8Array;
    readonly createdAt: string;
  }
  installDesignSystem(input: InstallDesignSystemInput): Promise<Error | CommittedMarker>;
  ```

- [ ] **Step 1: Write the failing operation-builder test**

`src/store/model/design-system-install.test.ts` — build on the harness
`src/store/model/transaction-engine-methods.test.ts` already uses (read it first; reuse its
temp-project setup verbatim rather than writing a second one).

```ts
test("writes every new system file, deletes every removed one, and the provenance record", async () => {
  const built = await engine.installDesignSystem({
    transactionId: uuidv7(),
    actionId: uuidv7(),
    nextFiles: [
      { treeRelPath: "system/design-system.json", bytes: encode(NEXT_MANIFEST) },
      { treeRelPath: "system/components/Button.tsx", bytes: encode(BUTTON) },
    ],
    removedTreeRelPaths: ["system/components/Legacy.tsx"],
    provenanceBytes: encodeDesignSystemProvenance(PROVENANCE),
    createdAt: NOW,
  });
  expect(built).not.toBeInstanceOf(Error);

  expect(readProjectFile("design/system/design-system.json")).toBe(NEXT_MANIFEST);
  expect(readProjectFile("design/system/components/Button.tsx")).toBe(BUTTON);
  expect(existsProjectFile("design/system/components/Legacy.tsx")).toBe(false);
  expect(readProjectFile("design-system-source.json")).toContain("local:midnight@1.2.0");
});

test("targets are PROJECT-relative and go through designFilePath — never a raw tree path", () => {
  const operations = buildDesignSystemInstallOperations(wrapperDeps, {
    nextFiles: [{ treeRelPath: "system/design-system.json", bytes: encode(NEXT_MANIFEST) }],
    removedTreeRelPaths: [],
    provenanceBytes: encode("{}"),
  });
  expect(operations).not.toBeInstanceOf(Error);
  expect((operations as readonly BuiltPageOperation[]).map((b) => b.operation.target)).toEqual([
    "design/system/design-system.json",
    "design-system-source.json",
  ]);
});

test("nothing outside `system/` may be written", () => {
  expect(
    buildDesignSystemInstallOperations(wrapperDeps, {
      nextFiles: [{ treeRelPath: "pages/dashboard.tsx", bytes: encode("x") }],
      removedTreeRelPaths: [],
      provenanceBytes: encode("{}"),
    }),
  ).toBeInstanceOf(Error);
});

test("nothing outside `system/` may be deleted", () => {
  expect(
    buildDesignSystemInstallOperations(wrapperDeps, {
      nextFiles: [],
      removedTreeRelPaths: ["pages.json"],
      provenanceBytes: encode("{}"),
    }),
  ).toBeInstanceOf(Error);
});

test("the provenance record and the system files land in ONE transaction", async () => {
  // Provenance that disagreed with the installed bytes would be worse than no provenance, so
  // there must be exactly one plan, not two.
  const plans = await listJournalPlans();
  expect(plans).toHaveLength(1);
  expect(plans[0]?.domain).toMatchObject({ mutationKind: "design-system-install" });
});
```

- [ ] **Step 2: Write the failing crash test**

Same file, using `src/store/transaction/model/crash-harness.ts`'s `runCrashCase` — read that file
and follow `crash-harness.test.ts`'s call shape exactly:

```ts
test("§11: a crash between quarantine and commit never leaves a half-replaced system", async () => {
  for (const boundary of [
    "payload-installed",
    "plan-installed",
    "precondition-checked",
    "intent-installed",
    "operation-target-applied",
    "operation-marker-installed",
    "committed-installed",
  ] as const) {
    const outcome = await runCrashCase({
      termcraftDir,
      plan: designSystemInstallPlan,
      payloads: designSystemInstallPayloads,
      crash: { kind: "boundary", boundary },
    });
    // Recovery ran from a cold start; every target is unanimously old or unanimously new.
    expect(outcome.targetsState).not.toBe("mixed");
    expect(outcome.recovery.ok).toBe(true);
  }
});
```

- [ ] **Step 3: Run and watch both fail**

Run: `rtk bun run test src/store/model/design-system-install.test.ts`
Expected: FAIL — `installDesignSystem` does not exist.

- [ ] **Step 4: Append the mutation kind**

In `src/store/transaction/model/wrappers.ts`:

```ts
export type ProjectMutationKind =
  | "project-creation"
  | "local-state-write"
  | "title-edit"
  | "pin-event"
  | "jsonl-repair"
  | "chat-creation"
  | "page-reorder"
  | "page-remove"
  // project-design-systems §8.3: installing a design system replaces `design/system/**` and
  // writes the provenance record in ONE recoverable transaction, so "a crash mid-install cannot
  // leave a half-replaced system". Appended without disturbing any already-shipped kind's meaning.
  | "design-system-install";
```

- [ ] **Step 5: Write the operation builder**

In the same file, beside `buildChangedFileOperation` (which it reuses — do not duplicate it):

```ts
/** One file of the incoming design system, at a TREE-relative path (`system/design-system.json`). */
export interface DesignSystemInstallFile {
  readonly treeRelPath: string;
  readonly bytes: Uint8Array;
}

/**
 * Every operation of a design-system install (project-design-systems §8.3, §8.5): a `replace` per
 * incoming file, a `delete` per file the outgoing system had and the incoming one does not, and
 * ONE `replace` of `.termcraft/design-system-source.json`.
 *
 * The provenance record rides the SAME plan as the files it describes. Two transactions would open
 * a window in which the project claims an origin its bytes do not have — worse than no provenance
 * at all, because it is a claim rather than a silence.
 *
 * CONTAINMENT IS ENFORCED HERE, not assumed from the caller: every path this builder touches is
 * inside `system/` (the design system is the unit that moves, §3.1) or is the provenance record.
 * An install that could reach a page would be an install that could rewrite the project.
 */
export function buildDesignSystemInstallOperations(
  deps: TransactionWrapperDeps,
  input: {
    readonly nextFiles: readonly DesignSystemInstallFile[];
    readonly removedTreeRelPaths: readonly string[];
    readonly provenanceBytes: Uint8Array;
  },
): SafeFsError | DesignSystemInstallInputError | readonly BuiltPageOperation[] {
  const built: BuiltPageOperation[] = [];

  for (const file of input.nextFiles) {
    if (!isInsideDesignSystem(file.treeRelPath))
      return new DesignSystemInstallInputError({ relPath: file.treeRelPath, reason: "outside system/" });
    const operation = buildChangedFileOperation(deps, {
      relPath: file.treeRelPath,
      change: "replace",
      newBytes: file.bytes,
    });
    if (operation instanceof Error) return operation;
    built.push(operation);
  }

  for (const relPath of input.removedTreeRelPaths) {
    if (!isInsideDesignSystem(relPath))
      return new DesignSystemInstallInputError({ relPath, reason: "outside system/" });
    const operation = buildChangedFileOperation(deps, { relPath, change: "delete" });
    if (operation instanceof Error) return operation;
    built.push(operation);
  }

  const provenanceTarget = DESIGN_SYSTEM_PROVENANCE_FILENAME;
  const oldImage = observeFileImage(deps.fs, provenanceTarget);
  if (oldImage instanceof Error) return oldImage;
  const payloadId = deps.append.newPayloadId();
  built.push({
    operation: {
      index: 0,
      target: provenanceTarget,
      mode: "replace",
      oldImage,
      newImage: {
        state: "file",
        sha256: sha256Hex(input.provenanceBytes),
        size: input.provenanceBytes.byteLength,
      },
      payloadId,
    },
    payload: [payloadId, input.provenanceBytes],
  });

  return built;
}
```

Add the tagged error beside the file's other input errors:

```ts
export class DesignSystemInstallInputError extends errore.createTaggedError({
  name: "DesignSystemInstallInputError",
  message: "design-system install refuses $relPath: $reason",
}) {}
```

Import `isInsideDesignSystem` from `entities/design-system` and
`DESIGN_SYSTEM_PROVENANCE_FILENAME` from `store/design-systems`. **If that import direction is
refused by the module DAG** (`store/transaction` sitting below `store/design-systems`), duplicate
the literal here with a comment naming `provenance.ts` as its authority and a test in
`design-system-install.test.ts` asserting the two agree — the same treatment Task 3 gives
`limits.ts`. Report which route was taken.

- [ ] **Step 6: Add the engine method**

In `src/store/model/factory.ts`, beside `reorderPages`, following its exact `withPermit` shape:

```ts
    /**
     * `designSystem.install` (project-design-systems §8.3): replaces `design/system/**` and writes
     * `.termcraft/design-system-source.json` in ONE `project-mutation`. Every operation carries a
     * CAS `oldImage`, so a tree that changed between the Gate pass and the commit is refused
     * rather than overwritten; a crash is rolled forward or discarded by the recovery scan that
     * already runs at `openProject`, so a half-replaced system is not a reachable state.
     */
    async installDesignSystem(input: InstallDesignSystemInput) {
      return withPermit(mutex, async (permit) => {
        const built = buildDesignSystemInstallOperations(wrapperDeps, {
          nextFiles: input.nextFiles,
          removedTreeRelPaths: input.removedTreeRelPaths,
          provenanceBytes: input.provenanceBytes,
        });
        if (built instanceof Error) return built;

        return runProjectMutation(wrapperDeps, {
          mutex,
          permit,
          transactionId: input.transactionId,
          actionId: input.actionId,
          mutationKind: "design-system-install",
          operations: indexPageOperations(built),
          payloads: collectPagePayloads(built),
          createdAt: input.createdAt,
        });
      });
    },
```

Declare `InstallDesignSystemInput` and the method on `TransactionEngine` in `src/store/types.ts`
beside `ReorderPagesInput`/`reorderPages`, and re-export
`buildDesignSystemInstallOperations`/`DesignSystemInstallFile`/`DesignSystemInstallInputError`
from `src/store/transaction/index.ts`.

- [ ] **Step 7: Run — green**

Run: `rtk bun run test src/store/model src/store/transaction`
Expected: PASS. The crash sweep is slow (it spawns one child per boundary) — allow it to finish;
a `crashed` verdict from the wrapper is never a pass.

- [ ] **Step 8: Lint, format, commit**

```bash
rtk bun run lint && rtk bun run fmt:check
rtk git add src/store && rtk git commit -m "feat(store): install a design system and its provenance record in one recoverable transaction"
```

Report: **+1 file** (`design-system-install.test.ts`).

---

### Task 6: The candidate tree and the breakage preview (pure)

**Files:**
- Create: `src/core/design-systems/types.ts`
- Create: `src/core/design-systems/index.ts`
- Create: `src/core/design-systems/model/candidate.ts`
- Create: `src/core/design-systems/model/candidate.test.ts`

**Interfaces:**
- Consumes: `entities/design-system`'s `isInsideDesignSystem`, `DESIGN_SYSTEM_MANIFEST_RELPATH`;
  `core/ports`' `GateErrorV1`, `GateWarningV1`, `RunTreeResultV1`, `PackageFileV1`.
- Produces:
  ```ts
  // types.ts
  export interface DesignSystemCandidateTreeV1 {
    /** TREE-relative → source text. The Gate's input. */
    readonly files: ReadonlyMap<string, string>;
    readonly treePaths: readonly string[];
    /** TREE-relative paths the outgoing system had and the incoming one does not. */
    readonly removedTreeRelPaths: readonly string[];
    /** TREE-relative → bytes, for the transaction's payloads. The SAME bytes as `files`. */
    readonly nextFiles: readonly { readonly treeRelPath: string; readonly bytes: Uint8Array }[];
  }
  export type DesignSystemPreviewVerdictV1 = "clean" | "breaks-pages" | "blocked";
  export interface DesignSystemBreakageItemV1 {
    readonly code: string;
    readonly message: string;
    readonly file: string | null;
    readonly blockedPages: readonly string[];
  }
  export interface DesignSystemPreviewV1 {
    readonly verdict: DesignSystemPreviewVerdictV1;
    readonly errors: readonly DesignSystemBreakageItemV1[];
    readonly warnings: readonly DesignSystemBreakageItemV1[];
  }
  // model/candidate.ts
  export class DesignSystemCandidateError extends errore.createTaggedError({
    name: "DesignSystemCandidateError",
    message: "design-system candidate refuses $relPath: $reason",
  }) {}
  export const MAX_PREVIEW_ITEMS = 40;
  export function composeDesignSystemCandidate(input: {
    readonly currentFiles: ReadonlyMap<string, string>;   // TREE-relative
    readonly currentTreePaths: readonly string[];
    readonly packageFiles: readonly PackageFileV1[];      // PACKAGE-relative
  }): DesignSystemCandidateError | DesignSystemCandidateTreeV1;
  export function summarizeGatePass(pass: RunTreeResultV1): DesignSystemPreviewV1;
  ```

- [ ] **Step 1: Write the failing tests**

`src/core/design-systems/model/candidate.test.ts`:

```ts
test("replaces system/** wholesale and leaves every other file untouched", () => {
  const candidate = composeDesignSystemCandidate({
    currentFiles: new Map([
      ["pages.json", "{}"],
      ["pages/dashboard.tsx", "export default null;"],
      ["system/design-system.json", OLD_MANIFEST],
      ["system/components/Legacy.tsx", "export const Legacy = () => null;"],
    ]),
    currentTreePaths: [
      "pages.json",
      "pages/dashboard.tsx",
      "system/design-system.json",
      "system/components/Legacy.tsx",
    ],
    packageFiles: [
      { relPath: "design-system.json", bytes: encode(NEW_MANIFEST) },
      { relPath: "components/Button.tsx", bytes: encode(BUTTON) },
    ],
  });
  expect(candidate).not.toBeInstanceOf(Error);
  const value = candidate as DesignSystemCandidateTreeV1;
  expect([...value.files.keys()].sort()).toEqual([
    "pages.json",
    "pages/dashboard.tsx",
    "system/components/Button.tsx",
    "system/design-system.json",
  ]);
  expect(value.files.get("system/design-system.json")).toBe(NEW_MANIFEST);
  expect(value.removedTreeRelPaths).toEqual(["system/components/Legacy.tsx"]);
});

test("treePaths is sorted and matches the composed file set exactly", () => {
  const value = composeDesignSystemCandidate(SAMPLE_INPUT) as DesignSystemCandidateTreeV1;
  expect(value.treePaths).toEqual([...value.files.keys()].sort());
});

test("nextFiles carries the same bytes the file map carries as text", () => {
  const value = composeDesignSystemCandidate(SAMPLE_INPUT) as DesignSystemCandidateTreeV1;
  for (const file of value.nextFiles) {
    expect(decode(file.bytes)).toBe(value.files.get(file.treeRelPath));
  }
});

test("a package with no manifest is refused", () => {
  expect(
    composeDesignSystemCandidate({
      currentFiles: new Map(),
      currentTreePaths: [],
      packageFiles: [{ relPath: "components/Button.tsx", bytes: encode(BUTTON) }],
    }),
  ).toBeInstanceOf(DesignSystemCandidateError);
});

test("a package path escaping the package root is refused", () => {
  expect(
    composeDesignSystemCandidate({
      currentFiles: new Map(),
      currentTreePaths: [],
      packageFiles: [
        { relPath: "design-system.json", bytes: encode(NEW_MANIFEST) },
        { relPath: "../pages/dashboard.tsx", bytes: encode("owned") },
      ],
    }),
  ).toBeInstanceOf(DesignSystemCandidateError);
});

test("a non-UTF-8 package file is refused rather than mojibaked into the Gate", () => {
  expect(
    composeDesignSystemCandidate({
      currentFiles: new Map(),
      currentTreePaths: [],
      packageFiles: [
        { relPath: "design-system.json", bytes: encode(NEW_MANIFEST) },
        { relPath: "components/Bad.tsx", bytes: new Uint8Array([0xff, 0xfe, 0xfd]) },
      ],
    }),
  ).toBeInstanceOf(DesignSystemCandidateError);
});

test("D6: a clean pass is `clean`", () => {
  expect(summarizeGatePass({ errors: [], warnings: [], closures: [] }).verdict).toBe("clean");
});

test("D6: a fatal naming a PAGE is breakage the designer can confirm", () => {
  const preview = summarizeGatePass({
    errors: [
      {
        kind: "type",
        code: "TYPE_ERROR",
        message: "t.brandBlue does not exist",
        file: "pages/dashboard.tsx",
        blockedPages: ["dashboard"],
      },
    ],
    warnings: [],
    closures: [],
  });
  expect(preview.verdict).toBe("breaks-pages");
  expect(preview.errors[0]).toEqual({
    code: "TYPE_ERROR",
    message: "t.brandBlue does not exist",
    file: "pages/dashboard.tsx",
    blockedPages: ["dashboard"],
  });
});

test("D6: a fatal INSIDE system/ blocks — the package itself is broken", () => {
  expect(
    summarizeGatePass({
      errors: [
        {
          kind: "manifest",
          code: "MISSING_CORE_ROLE",
          message: "theme dark omits dangerDim",
          file: "system/design-system.json",
        },
      ],
      warnings: [],
      closures: [],
    }).verdict,
  ).toBe("blocked");
});

test("D6: an UNATTRIBUTED fatal blocks — an unplaceable failure is never assumed to be a page's", () => {
  expect(
    summarizeGatePass({
      errors: [{ kind: "type", code: "TYPE_CHECK_UNAVAILABLE", message: "the compiler is down" }],
      warnings: [],
      closures: [],
    }).verdict,
  ).toBe("blocked");
});

test("warnings never change the verdict", () => {
  expect(
    summarizeGatePass({
      errors: [],
      warnings: [{ kind: "dead-module", message: "unused", file: "system/x.tsx" }],
      closures: [],
    }).verdict,
  ).toBe("clean");
});

test("the preview is bounded — a flood of diagnostics is truncated, not streamed", () => {
  const errors = Array.from({ length: 200 }, (_unused, index) => ({
    kind: "type" as const,
    code: "TYPE_ERROR",
    message: `e${index}`,
    file: "pages/a.tsx",
  }));
  expect(summarizeGatePass({ errors, warnings: [], closures: [] }).errors).toHaveLength(
    MAX_PREVIEW_ITEMS,
  );
});

test("truncation can never soften the verdict", () => {
  // 60 page fatals then ONE inside `system/`: the blocking one falls outside the truncation
  // window, and the verdict must still be `blocked`.
  const errors = [
    ...Array.from({ length: 60 }, (_unused, index) => ({
      kind: "type" as const,
      code: "TYPE_ERROR",
      message: `e${index}`,
      file: "pages/a.tsx",
    })),
    { kind: "manifest" as const, code: "MISSING_CORE_ROLE", message: "x", file: "system/design-system.json" },
  ];
  expect(summarizeGatePass({ errors, warnings: [], closures: [] }).verdict).toBe("blocked");
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `rtk bun run test src/core/design-systems`
Expected: FAIL — `Cannot find module`.

- [ ] **Step 3: Write `types.ts` and `candidate.ts`**

`candidate.ts`'s header must state the three load-bearing facts:

```ts
/**
 * THE CANDIDATE TREE IS COMPOSED IN MEMORY (decision D5). `GateRunner.runTree` takes
 * `ReadonlyMap<treeRelPath, text>`, and the canonical tree is already in memory as
 * `readCanonicalTreeIndex().files`, so materializing the whole tree into quarantine just to run
 * the Gate would be pure waste. What IS materialized is the untrusted package — that is what
 * quarantine, the limit budget and the no-follow walk exist for
 * (`store/design-systems`' `admitPackageThroughQuarantine`).
 *
 * ONE BYTE SOURCE, TWO CONSUMERS. `packageFiles` are the bytes read once out of the immutable
 * candidate; this function turns them into the Gate's TEXT map and the transaction's BYTE list in
 * the same pass, so what was checked is exactly what is written. Re-reading between the check and
 * the commit would be a TOCTOU window on foreign input, for no benefit.
 *
 * `system/` IS REPLACED WHOLESALE (§4.4: "an install replaces the folder wholesale"), never
 * merged. A merge would leave a file from the outgoing system inside the incoming one, and the
 * unit that moves between projects is the folder (§3.1).
 */
```

`composeDesignSystemCandidate`, in order, each check an early return:

1. Normalize every package path (`/`-separated; a `\` anywhere is a refusal) and reject `""`, a
   `..`, a `.`, or an empty segment.
2. Reject a duplicate normalized path.
3. Require `design-system.json` to be present — a package without its manifest is not a design
   system, and the Gate would report it as a tree fatal instead of as the package problem it is.
4. Decode each file with `new TextDecoder("utf-8", { fatal: true })` inside
   `errore.try({ try, catch })`; refuse on failure.
5. `nextFiles` = `{ treeRelPath: \`${DESIGN_SYSTEM_DIRNAME}/${relPath}\`, bytes }`.
6. `files` = every `currentFiles` entry whose key `isInsideDesignSystem` REJECTS, plus every
   decoded new entry.
7. `removedTreeRelPaths` = every `currentTreePaths` entry `isInsideDesignSystem` accepts that the
   incoming set does not contain, sorted.
8. `treePaths` = `[...files.keys()].sort()`.

`summarizeGatePass` maps each `GateErrorV1`/`GateWarningV1` to a `DesignSystemBreakageItemV1`
(`file: diagnostic.file ?? null`, `blockedPages: [...(diagnostic.blockedPages ?? [])]`, `message`
truncated to 400 characters), and derives the verdict **over the FULL error list, before
truncation** — a truncated tail must never turn `blocked` into `breaks-pages`:

```ts
  const blocking = pass.errors.some(
    (error) => error.file === undefined || isInsideDesignSystem(error.file),
  );
  const verdict = blocking ? "blocked" : pass.errors.length > 0 ? "breaks-pages" : "clean";
```

`index.ts` re-exports the types and both functions.

- [ ] **Step 4: Run — green**

Run: `rtk bun run test src/core/design-systems`
Expected: PASS (13 tests).

- [ ] **Step 5: Lint, format, commit**

```bash
rtk bun run lint && rtk bun run fmt:check
rtk git add src/core/design-systems && rtk git commit -m "feat(core): compose the design-system candidate tree and classify the Gate's answer"
```

Report: **+4 files**.

---

### Task 7: Sources — trust, the bounded list, and the update check

**Files:**
- Create: `src/core/design-systems/model/sources.ts`
- Create: `src/core/design-systems/model/sources.test.ts`
- Modify: `src/core/design-systems/{types.ts,index.ts}`
- Modify: `src/core/ports/fakes/design-system-source.ts` — add a controllable delay and a
  controllable `FailureDtoV1`, **only if the fake does not already offer them**; read it first.

**Interfaces:**
- Consumes: `core/ports`' `DesignSystemSource`, `DesignSystemSummaryV1`;
  `store/design-systems`' provenance type (reached through `DesignSystemInstallPort`, Task 8);
  `entities/design-system-ref`.
- Produces:
  ```ts
  export const DESIGN_SYSTEM_LIST_TIMEOUT_MS = 3000;
  export class DesignSystemSourceTimeoutError extends errore.createTaggedError({
    name: "DesignSystemSourceTimeoutError",
    message: "source $sourceId did not answer within $timeoutMs ms",
    extends: errore.AbortError,
  }) {}
  export type SourceListStateV1 = "listed" | "ungranted" | "unavailable";
  export interface SourceListingV1 {
    readonly sourceId: string; readonly label: string; readonly canPublish: boolean;
    readonly state: SourceListStateV1;
    readonly systems: readonly DesignSystemSummaryV1[];
    readonly reason: string | null;
  }
  export interface DesignSystemUpdateV1 {
    readonly installedRef: DesignSystemRef;
    readonly available: DesignSystemSummaryV1;
    readonly reason: "different-version";
  }
  export function sourceKindOf(sourceId: string): string;
  export async function listGrantedSources(deps: {
    readonly sources: readonly DesignSystemSource[];
    readonly isGranted: (source: DesignSystemSource) => Promise<boolean>;
    readonly timeoutMs?: number;
  }): Promise<readonly SourceListingV1[]>;
  export function detectDesignSystemUpdate(input: {
    readonly installedRef: DesignSystemRef | null;
    readonly listings: readonly SourceListingV1[];
  }): DesignSystemUpdateV1 | null;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
test("§8.4: an UNGRANTED source is never queried", async () => {
  const source = createRecordingSource({ id: "github:acme/ds" });
  const listings = await listGrantedSources({ sources: [source], isGranted: async () => false });
  expect(source.listCalls).toBe(0);                 // the property that matters, not the label
  expect(listings[0]?.state).toBe("ungranted");
  expect(listings[0]?.systems).toEqual([]);
});

test("a granted source lists", async () => {
  const source = createRecordingSource({ id: "local", systems: [MIDNIGHT_SUMMARY] });
  const listings = await listGrantedSources({ sources: [source], isGranted: async () => true });
  expect(listings[0]?.state).toBe("listed");
  expect(listings[0]?.systems).toEqual([MIDNIGHT_SUMMARY]);
});

test("§8.4: an unreachable source degrades under the bound — the others still list", async () => {
  const slow = createRecordingSource({ id: "github:acme/ds", delayMs: 10_000 });
  const local = createRecordingSource({ id: "local", systems: [MIDNIGHT_SUMMARY] });
  const listings = await listGrantedSources({
    sources: [slow, local],
    isGranted: async () => true,
    timeoutMs: 20,
  });
  const bySource = new Map(listings.map((listing) => [listing.sourceId, listing]));
  expect(bySource.get("github:acme/ds")?.state).toBe("unavailable");
  expect(bySource.get("github:acme/ds")?.reason).toContain("did not answer");
  expect(bySource.get("local")?.state).toBe("listed");
});

test("the timeout error is an errore AbortError, findable through a cause chain", () => {
  const error = new DesignSystemSourceTimeoutError({ sourceId: "x", timeoutMs: 1 });
  expect(errore.isAbortError(error)).toBe(true);
  expect(errore.isAbortError(new Error("wrapped", { cause: error }))).toBe(true);
});

test("a source that FAILS is unavailable with its safeMessage, never a thrown error", async () => {
  const failing = createRecordingSource({
    id: "local",
    failure: { code: "PERSISTENCE_FAILED", retryable: true, safeMessage: "library unreadable", details: {} },
  });
  const listings = await listGrantedSources({ sources: [failing], isGranted: async () => true });
  expect(listings[0]?.state).toBe("unavailable");
  expect(listings[0]?.reason).toBe("library unreadable");
});

test("listings keep the configured source order, so the picker is stable across runs", async () => {
  const listings = await listGrantedSources({
    sources: [createRecordingSource({ id: "local" }), createRecordingSource({ id: "github:acme/ds" })],
    isGranted: async () => true,
  });
  expect(listings.map((listing) => listing.sourceId)).toEqual(["local", "github:acme/ds"]);
});

test("sourceKindOf splits the adapter family off the id", () => {
  expect(sourceKindOf("local")).toBe("local");
  expect(sourceKindOf("github:acme/design-systems")).toBe("github");
});

test("§8.5: a different version at the recorded address is an available update", () => {
  const update = detectDesignSystemUpdate({
    installedRef: refOf("local:midnight@1.2.0"),
    listings: [listing("local", [{ ...MIDNIGHT_SUMMARY, version: "1.3.0" }])],
  });
  expect(update?.reason).toBe("different-version");
  expect(update?.available.version).toBe("1.3.0");
});

test("the same version is not an update", () => {
  expect(
    detectDesignSystemUpdate({
      installedRef: refOf("local:midnight@1.2.0"),
      listings: [listing("local", [MIDNIGHT_SUMMARY])],
    }),
  ).toBeNull();
});

test("no provenance means no update check, never a false offer", () => {
  expect(
    detectDesignSystemUpdate({ installedRef: null, listings: [listing("local", [MIDNIGHT_SUMMARY])] }),
  ).toBeNull();
});

test("an update is only offered from the SOURCE the project recorded", () => {
  expect(
    detectDesignSystemUpdate({
      installedRef: refOf("local:midnight@1.2.0"),
      listings: [listing("github:acme/ds", [{ ...MIDNIGHT_SUMMARY, version: "9.9.9" }])],
    }),
  ).toBeNull();
});

test("an unavailable source never produces an update", () => {
  expect(
    detectDesignSystemUpdate({
      installedRef: refOf("local:midnight@1.2.0"),
      listings: [
        { sourceId: "local", label: "Local library", canPublish: true, state: "unavailable", systems: [], reason: "timed out" },
      ],
    }),
  ).toBeNull();
});

test("a same-version REPUBLISH is not detectable from a summary — documented, not silently missed", () => {
  // `DesignSystemSummaryV1` carries no content hash: a summary is ONE `design-system.json`, and the
  // hash is over the whole file set (§8.2). So a republish at the same version is caught at the
  // next `fetch`, whose `contentHash` the install compares against the provenance record — not
  // here. Recorded as a decision rather than left as an oversight. WIDENING THE PORT'S SUMMARY TO
  // CARRY A HASH IS NOT AN OPTION: the port must not change (§10).
  expect(
    detectDesignSystemUpdate({
      installedRef: refOf("local:midnight@1.2.0"),
      listings: [listing("local", [MIDNIGHT_SUMMARY])],
    }),
  ).toBeNull();
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `rtk bun run test src/core/design-systems/model/sources.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `sources.ts`**

`listGrantedSources` runs the sources **concurrently** (`Promise.all` over one async function per
source) so one slow source does not serialize behind another:

```ts
async function listOne(source: DesignSystemSource, timeoutMs: number): Promise<SourceListingV1> {
  const head = { sourceId: source.id, label: source.label, canPublish: source.canPublish } as const;

  const granted = await deps.isGranted(source);
  // §8.4: "an unrecorded remote source is NEVER QUERIED" — the call is not made at all, not made
  // and then ignored. That distinction is the whole point of the grant.
  if (!granted)
    return { ...head, state: "ungranted", systems: [], reason: "this source has not been granted" };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<DesignSystemSourceTimeoutError>((resolve) => {
    timer = setTimeout(
      () => resolve(new DesignSystemSourceTimeoutError({ sourceId: source.id, timeoutMs })),
      timeoutMs,
    );
  });
  // THE PORT HAS NO `signal`, so the loser of this race is ABANDONED rather than cancelled. Stated
  // rather than hidden: a local `list` is bounded by the filesystem, and a network adapter that
  // ignores its own bound is a bug in that adapter, which no race here can repair. Adding a
  // `signal` would be a port change, and the port must not change (§10).
  const raced = await Promise.race([source.list(), timeout]).finally(() => clearTimeout(timer));

  if (raced instanceof Error) {
    log.warn("design-systems: source unavailable:", source.id, raced.message);
    return { ...head, state: "unavailable", systems: [], reason: raced.message };
  }
  // This ring narrows a `FailureDtoV1` with `"code" in result`, never `instanceof Error` — the DTO
  // is a plain object (`core/project/model/trust.ts` sets the idiom).
  if ("code" in raced) {
    log.warn("design-systems: source failed:", source.id, raced.safeMessage);
    return { ...head, state: "unavailable", systems: [], reason: raced.safeMessage };
  }
  return { ...head, state: "listed", systems: raced, reason: null };
}
```

`detectDesignSystemUpdate` finds the listing whose `sourceId === installedRef.sourceId` **and**
whose `state === "listed"`, then the summary whose `id === installedRef.systemId`, then compares
`version` by **string inequality, not semver ordering**:

```ts
  // A reference's version is OPAQUE (`source:system@version`, §8.1). Inventing a semver ordering
  // here would make `1.10.0` older than `1.9.0` for any system that does not use semver, so the
  // answer is "the source offers a DIFFERENT version", not "a newer one" — and the shell's copy
  // says exactly that.
  if (available.version === installedRef.version) return null;
```

`sourceKindOf(sourceId)` returns the part before the first `:`, or the whole id when there is none.

- [ ] **Step 4: Run — green**

Run: `rtk bun run test src/core/design-systems`
Expected: PASS.

- [ ] **Step 5: Lint, format, commit**

```bash
rtk bun run lint && rtk bun run fmt:check
rtk git add src/core && rtk git commit -m "feat(core): grant-gated source listing under a bound, and the design-system update check"
```

Report: **+2 files**.

---

### Task 8: The install pipeline

**Files:**
- Create: `src/core/ports/design-system-install.ts`
- Create: `src/core/ports/design-system-install.test.ts`
- Create: `src/core/ports/fakes/design-system-install.ts`
- Create: `src/core/design-systems/model/install.ts`
- Create: `src/core/design-systems/model/install.test.ts`
- Modify: `src/core/ports/index.ts`, `src/core/design-systems/{types.ts,index.ts}`

**Interfaces:**
- Consumes: Tasks 3–7's output, `readCanonicalTreeIndex`, `GateRunner.runTree`,
  `DesignSystemSource.fetch`.
- Produces:
  ```ts
  // core/ports/design-system-install.ts — `core` may not import `store`, so quarantine and the
  // install transaction each reach it as a port, like every other store capability.
  export interface DesignSystemQuarantinePort {
    admit(input: { readonly installId: string; readonly files: readonly PackageFileV1[] }):
      Promise<FailureDtoV1 | { readonly contentHash: Sha256Hex; readonly files: readonly PackageFileV1[] }>;
    discard(installId: string): void;
  }
  export interface DesignSystemProvenanceRecordV1 {
    readonly ref: DesignSystemRef; readonly contentHash: Sha256Hex; readonly installedAt: string;
  }
  export interface DesignSystemInstallPort {
    install(input: {
      readonly nextFiles: readonly { readonly treeRelPath: string; readonly bytes: Uint8Array }[];
      readonly removedTreeRelPaths: readonly string[];
      readonly provenanceBytes: Uint8Array;
    }): Promise<FailureDtoV1 | undefined>;
    encodeProvenance(record: DesignSystemProvenanceRecordV1): Uint8Array;
    /** `null` when the project has never installed from a source — NOT an error (§8.5). */
    readProvenance(): Promise<FailureDtoV1 | DesignSystemProvenanceRecordV1 | null>;
  }

  // core/design-systems/model/install.ts
  export interface DesignSystemInstallPortsV1 {
    readonly source: DesignSystemSource;
    readonly designReader: DesignTreeReader;
    readonly gateRunner: GateRunner;
    readonly quarantine: DesignSystemQuarantinePort;
    readonly install: DesignSystemInstallPort;
    readonly clock: Clock;
    readonly newInstallId: () => string;
  }
  export interface DesignSystemPreparedInstallV1 {
    readonly installId: string;
    readonly ref: DesignSystemRef;
    readonly contentHash: Sha256Hex;
    readonly summary: DesignSystemSummaryV1;
    readonly preview: DesignSystemPreviewV1;
    readonly candidate: DesignSystemCandidateTreeV1;
  }
  export async function prepareDesignSystemInstall(
    ports: DesignSystemInstallPortsV1, ref: DesignSystemRef,
  ): Promise<FailureDtoV1 | DesignSystemPreparedInstallV1>;
  export async function commitDesignSystemInstall(
    ports: DesignSystemInstallPortsV1, prepared: DesignSystemPreparedInstallV1,
  ): Promise<FailureDtoV1 | { readonly ref: DesignSystemRef }>;
  export function discardPreparedInstall(ports: DesignSystemInstallPortsV1, installId: string): void;
  ```

- [ ] **Step 1: Write the failing tests**

Drive the whole pipeline through fakes — `core/ports/fakes/gate-runner.ts`,
`core/ports/fakes/design-store.ts`, `core/ports/fakes/design-system-source.ts` (read each and
extend rather than replacing), plus the new `fakes/design-system-install.ts`. Follow
`src/core/ports/fakes/trust.test.ts`'s shape for the fake's own test.

```ts
test("the pipeline runs in order: fetch → quarantine → Gate — and never writes before the Gate", async () => {
  const trace: string[] = [];
  const ports = createFakePorts({ trace });
  const prepared = await prepareDesignSystemInstall(ports, MIDNIGHT_REF);
  expect(prepared).not.toHaveProperty("code");
  expect(trace).toEqual(["fetch", "quarantine", "runTree"]);
  expect(ports.recordedInstalls).toEqual([]);
});

test("§8.3: fetch's bytes never reach the tree — the CANDIDATE's bytes do", async () => {
  const ports = createFakePorts({ quarantineRewritesTo: REWRITTEN_MANIFEST });
  const prepared = (await prepareDesignSystemInstall(ports, MIDNIGHT_REF)) as DesignSystemPreparedInstallV1;
  expect(prepared.candidate.files.get("system/design-system.json")).toBe(REWRITTEN_MANIFEST);
});

test("§11: a package refused by the limits fails BEFORE the Gate is asked", async () => {
  const trace: string[] = [];
  const ports = createFakePorts({
    trace,
    quarantineFailure: { code: "RESOURCE_LIMIT_EXCEEDED", retryable: false, safeMessage: "too large", details: {} },
  });
  const result = await prepareDesignSystemInstall(ports, MIDNIGHT_REF);
  expect(result).toHaveProperty("code", "RESOURCE_LIMIT_EXCEEDED");
  expect(trace).toEqual(["fetch", "quarantine"]);
});

test("D6: a fatal inside system/ prepares with verdict `blocked`", async () => {
  const ports = createFakePorts({
    gateErrors: [{ kind: "manifest", code: "MISSING_CORE_ROLE", message: "x", file: "system/design-system.json" }],
  });
  const prepared = (await prepareDesignSystemInstall(ports, MIDNIGHT_REF)) as DesignSystemPreparedInstallV1;
  expect(prepared.preview.verdict).toBe("blocked");
});

test("D6: committing a `blocked` preparation is refused with DESIGN_SYSTEM_REJECTED", async () => {
  const ports = createFakePorts({
    gateErrors: [{ kind: "manifest", code: "MISSING_CORE_ROLE", message: "x", file: "system/design-system.json" }],
  });
  const prepared = (await prepareDesignSystemInstall(ports, MIDNIGHT_REF)) as DesignSystemPreparedInstallV1;
  expect(await commitDesignSystemInstall(ports, prepared)).toHaveProperty("code", "DESIGN_SYSTEM_REJECTED");
  expect(ports.recordedInstalls).toEqual([]);
});

test("D6: committing a `breaks-pages` preparation SUCCEEDS — surfaced, not prevented", async () => {
  const ports = createFakePorts({
    gateErrors: [{ kind: "type", code: "TYPE_ERROR", message: "x", file: "pages/a.tsx" }],
  });
  const prepared = (await prepareDesignSystemInstall(ports, MIDNIGHT_REF)) as DesignSystemPreparedInstallV1;
  expect(await commitDesignSystemInstall(ports, prepared)).not.toHaveProperty("code");
  expect(ports.recordedInstalls).toHaveLength(1);
});

test("§8.5: the commit writes the provenance record with the ref AND the content hash", async () => {
  const ports = createFakePorts({});
  const prepared = (await prepareDesignSystemInstall(ports, MIDNIGHT_REF)) as DesignSystemPreparedInstallV1;
  await commitDesignSystemInstall(ports, prepared);
  expect(ports.recordedProvenance[0]).toMatchObject({
    ref: MIDNIGHT_REF,
    contentHash: prepared.contentHash,
  });
});

test("the commit removes every file the outgoing system had and the incoming one lacks", async () => {
  const ports = createFakePorts({
    currentSystemFiles: ["system/design-system.json", "system/components/Legacy.tsx"],
  });
  const prepared = (await prepareDesignSystemInstall(ports, MIDNIGHT_REF)) as DesignSystemPreparedInstallV1;
  await commitDesignSystemInstall(ports, prepared);
  expect(ports.recordedInstalls[0]!.removedTreeRelPaths).toEqual(["system/components/Legacy.tsx"]);
});

test("quarantine is discarded after a commit AND after an abandonment", async () => {
  const ports = createFakePorts({});
  const first = (await prepareDesignSystemInstall(ports, MIDNIGHT_REF)) as DesignSystemPreparedInstallV1;
  await commitDesignSystemInstall(ports, first);
  expect(ports.discarded).toEqual([first.installId]);

  const second = (await prepareDesignSystemInstall(ports, MIDNIGHT_REF)) as DesignSystemPreparedInstallV1;
  discardPreparedInstall(ports, second.installId);
  expect(ports.discarded).toEqual([first.installId, second.installId]);
});

test("quarantine is discarded when the commit itself fails", async () => {
  const ports = createFakePorts({
    installFailure: { code: "PERSISTENCE_FAILED", retryable: true, safeMessage: "disk full", details: {} },
  });
  const prepared = (await prepareDesignSystemInstall(ports, MIDNIGHT_REF)) as DesignSystemPreparedInstallV1;
  expect(await commitDesignSystemInstall(ports, prepared)).toHaveProperty("code", "PERSISTENCE_FAILED");
  expect(ports.discarded).toEqual([prepared.installId]);
});

test("a fetch failure surfaces as-is and leaves no quarantine behind", async () => {
  const ports = createFakePorts({
    fetchFailure: { code: "PERSISTENCE_FAILED", retryable: false, safeMessage: "package declares aurora@2.0.0", details: {} },
  });
  const result = await prepareDesignSystemInstall(ports, MIDNIGHT_REF);
  expect(result).toMatchObject({ safeMessage: "package declares aurora@2.0.0" });
  expect(ports.discarded).toEqual([]);   // nothing was created, so nothing is discarded
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `rtk bun run test src/core/design-systems/model/install.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the two ports and their fake**

`core/ports/design-system-install.ts` carries the header the existing
`core/ports/design-system-source.ts` implies: that file declares "only where packages come from and
where they go"; this one declares what happens between. Export both interfaces from
`core/ports/index.ts` and add the `AssertConforms` pattern the ring uses.

`core/ports/fakes/design-system-install.ts` records `install(...)` calls, decodes the provenance
bytes it was handed (so the test can assert on the record, not on opaque bytes), records
`discard(...)` calls in order, and can be primed with a `FailureDtoV1` for either method.

- [ ] **Step 4: Write `install.ts`**

`prepareDesignSystemInstall`, in order, each step an early return:

1. `const fetched = await ports.source.fetch(ref); if ("code" in fetched) return fetched;`
2. `const installId = ports.newInstallId();`
   `const admitted = await ports.quarantine.admit({ installId, files: fetched.files });`
   `if ("code" in admitted) return admitted;` — the port discards its own directory on failure, so
   do **not** discard again here.
3. `const index = await readCanonicalTreeIndex({ designReader, gateRunner });`
   `if ("code" in index) { ports.quarantine.discard(installId); return index; }`
   With this comment:
   ```ts
   // TWO WHOLE-TREE TYPE CHECKS PER PREPARATION, stated rather than hidden.
   // `readCanonicalTreeIndex` runs `runTree` itself (that is what makes its `pages`/`files`
   // trustworthy), and step 5 runs a second pass over the candidate because §8.3 requires the
   // Gate's answer to be about the CANDIDATE, not about the current tree. Both freeze the thread
   // (decision D7). Accepted: correctness of the preview is what the whole pipeline exists for.
   ```
4. `composeDesignSystemCandidate({ currentFiles: index.files, currentTreePaths: index.inventory.files.map(f => f.relPath), packageFiles: admitted.files })`
   → on error, discard quarantine and return a `DESIGN_SYSTEM_REJECTED` `FailureDtoV1` carrying the
   error's message as `safeMessage`.
5. `const pass = await ports.gateRunner.runTree({ files: candidate.files, treePaths: candidate.treePaths, pages: index.pages });`
6. Return `{ installId, ref, contentHash: admitted.contentHash, summary: fetched.summary, preview: summarizeGatePass(pass), candidate }`.
   **Quarantine is deliberately NOT discarded here** — the caller either commits or abandons.

`commitDesignSystemInstall`:

1. `if (prepared.preview.verdict === "blocked")` → discard, return `DESIGN_SYSTEM_REJECTED` whose
   `safeMessage` names the first blocking diagnostic (`code` + `file`).
2. `const provenanceBytes = ports.install.encodeProvenance({ ref: prepared.ref, contentHash: prepared.contentHash, installedAt: ports.clock.now().toISOString() });`
3. `const failure = await ports.install.install({ nextFiles: prepared.candidate.nextFiles, removedTreeRelPaths: prepared.candidate.removedTreeRelPaths, provenanceBytes });`
4. Discard quarantine on **both** paths, then return the failure or `{ ref: prepared.ref }`. Use
   `await using cleanup = new errore.AsyncDisposableStack()` with
   `cleanup.defer(() => { discardPreparedInstall(ports, prepared.installId); })` so the discard
   cannot be forgotten on a new early return added later.

- [ ] **Step 5: Run — green**

Run: `rtk bun run test src/core`
Expected: PASS.

- [ ] **Step 6: Lint, format, commit**

```bash
rtk bun run lint && rtk bun run fmt:check
rtk git add src/core && rtk git commit -m "feat(core): the design-system install pipeline — quarantine, candidate, Gate, preview, commit"
```

Report: **+5 files**.

---

### Task 9: Protocol and Kernel handlers

**Files:**
- Modify: `src/core/protocol/model/command-kind.ts` (+1 family, +4 kinds, +count)
- Modify: `src/core/protocol/model/command-payload.ts` (+4 schemas)
- Modify: `src/core/protocol/model/event-kind.ts` (+9 kinds, +count)
- Modify: `src/core/protocol/model/event-payload.ts` (+DTOs, +interfaces, +schemas, +map entries)
- Modify: `src/core/protocol/model/failure.ts` (+`DESIGN_SYSTEM_REJECTED`, count +1)
- Modify: `src/core/protocol/model/closure.test.ts`, `src/core/protocol/model/failure.test.ts`
- Create: `src/core/kernel/model/handlers/design-system.ts`
- Create: `src/core/kernel/model/handlers/design-system.test.ts`
- Modify: `src/core/kernel/model/handlers/index.ts`, `src/core/kernel/model/handlers/types.ts`
- Modify: `src/core/kernel/types.ts`, `src/core/kernel/model/kernel.ts`

**Interfaces:**
- Produces the exact protocol surface Tasks 10–13 bind to:
  ```ts
  // commands (payload schemas are z.strictObject)
  "designSystem.list":    {}
  "designSystem.preview": { readonly ref: string }          // canonical `source:system@version`
  "designSystem.install": { readonly installId: string }    // a previously previewed preparation
  "designSystem.publish": { readonly sourceId: string }

  // events
  "designSystem.listed":         { operationId; sources: readonly SourceListingDtoV1[]; update: DesignSystemUpdateDtoV1 | null }
  "designSystem.listFailed":     { operationId; failure: FailureDtoV1 }
  "designSystem.previewStarted": { operationId; ref: string }
  "designSystem.previewed":      { operationId; installId: string; ref: string; summary: DesignSystemSummaryDtoV1; preview: DesignSystemPreviewDtoV1 }
  "designSystem.previewFailed":  { operationId; ref: string; failure: FailureDtoV1 }
  "designSystem.installed":      { operationId; ref: string }
  "designSystem.installFailed":  { operationId; ref: string; failure: FailureDtoV1 }
  "designSystem.published":      { operationId; ref: string; publishedAt: string }
  "designSystem.publishFailed":  { operationId; sourceId: string; failure: FailureDtoV1 }
  ```

- [ ] **Step 1: Extend the protocol — read the pinned counts first**

Open `src/core/protocol/model/closure.test.ts` and `failure.test.ts` and **write down the numbers
actually there** before editing (at time of writing: `COMMAND_KIND_COUNT` 44,
`EVENT_KIND_COUNT` 45, `OPERATIONAL_FAILURE_CODE_COUNT` 30). Then:

- append `"designSystem"` to `COMMAND_FAMILIES_V1`, and the four kinds to `COMMAND_KINDS_V1`;
  `COMMAND_KIND_COUNT` += 4;
- append the nine event kinds to `EVENT_KINDS_V1`; `EVENT_KIND_COUNT` += 9;
- append `"DESIGN_SYSTEM_REJECTED"` to `OPERATIONAL_FAILURE_CODES_V1`;
  `OPERATIONAL_FAILURE_CODE_COUNT` += 1, with this comment:
  ```ts
  // The Gate refused the CANDIDATE ITSELF — a §7 fatal inside `system/`, or a whole-tree fatal
  // with no file attribution (decision D6). Deliberately distinct from a package the Gate accepted
  // that BREAKS PAGES: that is not a failure at all, it is a preview the designer confirms
  // (§8.3, §12 — "surfaced before commit; not prevented").
  ```
- update both closure assertions to the new numbers.

- [ ] **Step 2: Declare the payload DTOs**

In `event-payload.ts`, follow that file's own two-declaration convention exactly — a hand-written
`interface` **and** a matching `z.strictObject`, plus one entry in `EventPayloadByKindV1` and one in
`eventPayloadV1SchemaByKind`. Model them on `ExportProgressPayloadV1`/`ExportTerminalPayloadV1`:

```ts
/** One token of a theme, in DECLARATION ORDER — the picker's swatch row is drawn in this order (§8.1). */
export interface DesignSystemTokenSwatchDtoV1 { readonly name: string; readonly value: string }

export interface DesignSystemSummaryDtoV1 {
  readonly id: string; readonly name: string; readonly version: string;
  readonly kitApiVersion: number; readonly defaultTheme: string;
  readonly defaultThemeTokens: readonly DesignSystemTokenSwatchDtoV1[];
  readonly componentNames: readonly string[];
}

export interface SourceListingDtoV1 {
  readonly sourceId: string; readonly label: string; readonly canPublish: boolean;
  readonly state: "listed" | "ungranted" | "unavailable";
  readonly systems: readonly DesignSystemSummaryDtoV1[];
  readonly reason: string | null;
}

export interface DesignSystemBreakageDtoV1 {
  readonly code: string; readonly message: string;
  readonly file: string | null; readonly blockedPages: readonly string[];
}

export interface DesignSystemPreviewDtoV1 {
  readonly verdict: "clean" | "breaks-pages" | "blocked";
  readonly errors: readonly DesignSystemBreakageDtoV1[];
  readonly warnings: readonly DesignSystemBreakageDtoV1[];
}

export interface DesignSystemUpdateDtoV1 {
  readonly installedRef: string; readonly availableRef: string; readonly reason: string;
}
```

**Every string the shell renders is bounded in `core`, before publication, never in a component**
(Global Constraints): `message` ≤ 400 characters, `blockedPages` ≤ 20 entries, `errors`/`warnings`
≤ `MAX_PREVIEW_ITEMS`, `componentNames` ≤ 64, `defaultThemeTokens` ≤ 256. Encode those bounds in
the Zod schemas (`.max(...)`) so a violation is a decode failure rather than a wide render.

- [ ] **Step 3: Write the failing handler tests**

`src/core/kernel/model/handlers/design-system.test.ts`, on
`src/core/kernel/model/handlers/preview-export.test.ts`'s harness — read it and reuse
`harness.handlerContext`, do not build a second harness:

```ts
test("designSystem.list returns `started` and publishes `designSystem.listed`", async () => {
  const outcome = designSystemHandlers["designSystem.list"]({}, harness.handlerContext);
  expect(outcome.disposition).toBe("started");
  await harness.settleOperations();
  expect(harness.publishedKinds()).toEqual(["designSystem.listed"]);
});

test("designSystem.listed carries the update offer when the source has a different version", async () => {
  harness.installPort.provenance = { ref: MIDNIGHT_REF, contentHash: HASH, installedAt: NOW };
  harness.source.systems = [{ ...MIDNIGHT_SUMMARY, version: "1.3.0" }];
  designSystemHandlers["designSystem.list"]({}, harness.handlerContext);
  await harness.settleOperations();
  expect(harness.lastPayload("designSystem.listed").update).toMatchObject({
    installedRef: "local:midnight@1.2.0",
    availableRef: "local:midnight@1.3.0",
  });
});

test("D7: `designSystem.previewStarted` is published BEFORE runTree is awaited", async () => {
  // `runTree` freezes the thread (`design-checker.ts`: zero ticks of a 10 ms interval). A
  // "checking…" state that only arrived afterwards would be indistinguishable from a hang.
  const order: string[] = [];
  harness.gateRunner.onRunTree = () => order.push("runTree");
  harness.onPublish = (kind: string) => order.push(kind);
  designSystemHandlers["designSystem.preview"]({ ref: "local:midnight@1.2.0" }, harness.handlerContext);
  await harness.settleOperations();
  expect(order.indexOf("designSystem.previewStarted")).toBeGreaterThanOrEqual(0);
  expect(order.indexOf("designSystem.previewStarted")).toBeLessThan(order.indexOf("runTree"));
});

test("a malformed ref is rejected without ever reaching the source", async () => {
  designSystemHandlers["designSystem.preview"]({ ref: "not a ref" }, harness.handlerContext);
  await harness.settleOperations();
  expect(harness.publishedKinds()).toEqual(["designSystem.previewStarted", "designSystem.previewFailed"]);
  expect(harness.source.fetchCalls).toBe(0);
});

test("designSystem.install commits the prepared installId and publishes `designSystem.installed`", async () => {
  designSystemHandlers["designSystem.preview"]({ ref: "local:midnight@1.2.0" }, harness.handlerContext);
  await harness.settleOperations();
  const installId = harness.lastPayload("designSystem.previewed").installId;
  designSystemHandlers["designSystem.install"]({ installId }, harness.handlerContext);
  await harness.settleOperations();
  expect(harness.publishedKinds()).toContain("designSystem.installed");
});

test("designSystem.install with an unknown installId FAILS rather than silently re-preparing", async () => {
  designSystemHandlers["designSystem.install"]({ installId: uuidv7() }, harness.handlerContext);
  await harness.settleOperations();
  expect(harness.publishedKinds()).toEqual(["designSystem.installFailed"]);
  expect(harness.source.fetchCalls).toBe(0);
});

test("a second preparation evicts and DISCARDS the first — no quarantine is leaked", async () => {
  designSystemHandlers["designSystem.preview"]({ ref: "local:midnight@1.2.0" }, harness.handlerContext);
  await harness.settleOperations();
  const first = harness.lastPayload("designSystem.previewed").installId;
  designSystemHandlers["designSystem.preview"]({ ref: "local:aurora@2.0.0" }, harness.handlerContext);
  await harness.settleOperations();
  expect(harness.quarantinePort.discarded).toContain(first);
});

test("designSystem.publish is refused when the source declares canPublish false", async () => {
  harness.source.canPublish = false;
  designSystemHandlers["designSystem.publish"]({ sourceId: "local" }, harness.handlerContext);
  await harness.settleOperations();
  expect(harness.publishedKinds()).toEqual(["designSystem.publishFailed"]);
  expect(harness.source.publishCalls).toBe(0);
});

test("designSystem.publish sends the project's OWN system/**, package-relative", async () => {
  designSystemHandlers["designSystem.publish"]({ sourceId: "local" }, harness.handlerContext);
  await harness.settleOperations();
  expect(harness.source.lastPublished?.files.map((file) => file.relPath).sort()).toEqual([
    "components/Button.tsx",
    "design-system.json",
  ]);
});

test("a project with no design system cannot publish", async () => {
  harness.designReader.tree = [{ relPath: "pages.json", sha256: HASH, size: 2 }];
  designSystemHandlers["designSystem.publish"]({ sourceId: "local" }, harness.handlerContext);
  await harness.settleOperations();
  expect(harness.publishedKinds()).toEqual(["designSystem.publishFailed"]);
  expect(harness.source.publishCalls).toBe(0);
});
```

- [ ] **Step 4: Run and watch them fail**

Run: `rtk bun run test src/core/kernel/model/handlers/design-system.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 5: Write the handlers**

`src/core/kernel/model/handlers/design-system.ts`. Every handler is **synchronous**, calls
`context.launchOperation(label, run)` exactly once from its own body, and returns
`startedOutcome([], operationId)` — the `export.start` shape verbatim
(`preview-export.ts`'s `handleExportStart`). Live progress uses `context.publishOperationEvent`;
the terminal event is the single-element array `run` resolves with. `run` never rejects: it turns
every outcome into an event itself.

`designSystem.preview`'s body order is load-bearing (D7):

```ts
function designSystemPreview(
  payload: CommandPayloadByKindV1["designSystem.preview"],
  context: HandlerContext,
): CommandOutcomeV1 {
  const operationId = uuidv7();
  context.launchOperation("kernel.designSystem.preview", async () => {
    // PUBLISHED BEFORE ANY AWAIT THAT CAN FREEZE THE THREAD (decision D7). `runTree`'s type stage
    // runs `typescript/unstable/sync` on this thread; a "checking…" state published after it would
    // reach the shell only once the freeze ended, which is exactly when it stops being useful.
    context.publishOperationEvent({
      kind: "designSystem.previewStarted",
      payload: { operationId, ref: payload.ref },
    });

    const ref = parseDesignSystemRef(payload.ref);
    if (ref instanceof Error) return [previewFailedEvent(operationId, payload.ref, refFailure(ref))];

    const prepared = await prepareDesignSystemInstall(installPortsOf(context), ref);
    if ("code" in prepared) return [previewFailedEvent(operationId, payload.ref, prepared)];

    context.designSystemLedger.replace(prepared);   // evicts + discards any earlier preparation
    return [previewedEvent(operationId, prepared)];
  });
  return startedOutcome([], operationId);
}
```

The preparation ledger is reached through `HandlerContext` the same way `pageRemovePlanLedger`
already is — **read how `pageRemovePlanLedger` is declared in `handlers/types.ts` and wired in
`kernel.ts`, and copy that shape exactly**, including where it is cleared. Its rules:

- `replace(prepared)` evicts any held preparation and calls `discardPreparedInstall` on it, so an
  abandoned quarantine is never leaked;
- `take(installId)` returns and removes the held preparation, or `null` for an unknown id
  (which is `designSystem.installFailed`, never a silent re-prepare — a command that quietly did
  different work from what it names is the shape a confirmation dialog cannot protect against);
- it is cleared, with a discard, when the project closes.

`designSystem.publish` reads the project's own system through `context.deps.designReader`:
`listTree()` → filter by `isInsideDesignSystem` → `readTreeFile` each → strip the
`system/` prefix to get package-relative paths. `systemId`/`version` come from
`decodeDesignSystemManifest` over `system/design-system.json`. Refuse **before** calling
`publish` when `source.canPublish` is false or the tree has no `system/`.

`KernelDeps` gains exactly three fields, one per `core/ports` contract:

```ts
  readonly designSystemSource: DesignSystemSource;
  readonly designSystemQuarantine: DesignSystemQuarantinePort;
  readonly designSystemInstall: DesignSystemInstallPort;
```

Register the family map in `handlers/index.ts`:

```ts
export const totalHandlers = {
  …,
  ...designSystemHandlers,
} satisfies TotalHandlerMap;
```

- [ ] **Step 6: Run — green**

Run: `rtk bun run test src/core`
Expected: PASS. `satisfies TotalHandlerMap` makes a missing handler a compile error, not a review
finding — a `tsc` failure here means a kind was added without a handler.

- [ ] **Step 7: Lint, format, commit**

```bash
rtk bun run lint && rtk bun run fmt:check
rtk git add src/core && rtk git commit -m "feat(core): four designSystem commands, nine events and their handlers"
```

Report: **+2 files**.

---

### Task 10: The mirror slice

**Files:**
- Modify: `src/ui/mirror/types.ts`
- Modify: `src/ui/mirror/model/mirror.ts`
- Modify: `src/ui/mirror/model/mirror.test.ts`

**Interfaces:**
- Consumes: the nine event kinds Task 9 published.
- Produces:
  ```ts
  // src/ui/mirror/types.ts
  export type DesignSystemPhase = "idle" | "listing" | "listed" | "checking" | "previewed" | "installing" | "failed";
  export interface DesignSystemMirror {
    readonly phase: DesignSystemPhase;
    readonly sources: readonly SourceListingDtoV1[];
    readonly update: DesignSystemUpdateDtoV1 | null;
    /** Set once a preview lands; the install command needs it. */
    readonly installId: string | null;
    readonly previewRef: string | null;
    readonly previewSummary: DesignSystemSummaryDtoV1 | null;
    readonly preview: DesignSystemPreviewDtoV1 | null;
    readonly failure: FailureDtoV1 | null;
    readonly publishedAt: string | null;
  }
  // src/ui/mirror/model/mirror.ts
  export interface Mirror { …; readonly designSystems: Atom<DesignSystemMirror> }
  export const EMPTY_DESIGN_SYSTEM_MIRROR: DesignSystemMirror;
  ```

- [ ] **Step 1: Write the failing tests**

Append to `src/ui/mirror/model/mirror.test.ts`, matching the file's existing `envelope(...)` helper:

```ts
test("designSystem.listed fills the sources and the update offer in ONE transition", () => {
  const mirror = createMirror();
  mirror.apply(envelope("designSystem.listed", { operationId: OP, sources: [LOCAL_LISTING], update: null }));
  expect(mirror.designSystems()).toMatchObject({ phase: "listed", sources: [LOCAL_LISTING], update: null });
});

test("designSystem.previewStarted puts the picker into `checking` before the freeze", () => {
  const mirror = createMirror();
  mirror.apply(envelope("designSystem.previewStarted", { operationId: OP, ref: "local:midnight@1.2.0" }));
  expect(mirror.designSystems()).toMatchObject({ phase: "checking", previewRef: "local:midnight@1.2.0" });
});

test("designSystem.previewed carries the installId the install command needs", () => {
  const mirror = createMirror();
  mirror.apply(envelope("designSystem.previewed", PREVIEWED_PAYLOAD));
  expect(mirror.designSystems()).toMatchObject({
    phase: "previewed",
    installId: PREVIEWED_PAYLOAD.installId,
    preview: PREVIEWED_PAYLOAD.preview,
  });
});

test("a previewed state keeps the source list — the picker must not blank behind the dialog", () => {
  const mirror = createMirror();
  mirror.apply(envelope("designSystem.listed", { operationId: OP, sources: [LOCAL_LISTING], update: null }));
  mirror.apply(envelope("designSystem.previewed", PREVIEWED_PAYLOAD));
  expect(mirror.designSystems().sources).toEqual([LOCAL_LISTING]);
});

test("designSystem.installed clears the preparation so a stale installId can never be re-sent", () => {
  const mirror = createMirror();
  mirror.apply(envelope("designSystem.previewed", PREVIEWED_PAYLOAD));
  mirror.apply(envelope("designSystem.installed", { operationId: OP, ref: "local:midnight@1.2.0" }));
  expect(mirror.designSystems()).toMatchObject({ phase: "idle", installId: null, preview: null });
});

test("every *Failed event lands the failure and the `failed` phase", () => {
  for (const kind of ["designSystem.listFailed", "designSystem.previewFailed", "designSystem.installFailed", "designSystem.publishFailed"] as const) {
    const mirror = createMirror();
    mirror.apply(envelope(kind, failurePayloadFor(kind)));
    expect(mirror.designSystems()).toMatchObject({ phase: "failed", failure: FAILURE });
  }
});

test("designSystem.published records publishedAt", () => {
  const mirror = createMirror();
  mirror.apply(envelope("designSystem.published", { operationId: OP, ref: "local:midnight@1.2.0", publishedAt: NOW }));
  expect(mirror.designSystems().publishedAt).toBe(NOW);
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `rtk bun run test src/ui/mirror`
Expected: FAIL — `designSystems` does not exist on `Mirror`.

- [ ] **Step 3: Add the slice**

Add `DesignSystemMirror`/`DesignSystemPhase` to `src/ui/mirror/types.ts`, and to `mirror.ts` a
**named** atom created in `createMirror()`:

```ts
const designSystemsAtom = atom<DesignSystemMirror>(EMPTY_DESIGN_SYSTEM_MIRROR, "mirror.designSystems");
```

then one `case` per event kind, each **one grouped `atom.set(...)`** (RTM-S04 — never two sets for
one event, never an identity setter). Follow the `export.*` cases' shape verbatim, including their
stale-operation guard:

```ts
    case "designSystem.previewed": {
      const p = envelope.payload;
      designSystemsAtom.set({
        ...designSystemsAtom(),
        phase: "previewed",
        installId: p.installId,
        previewRef: p.ref,
        previewSummary: p.summary,
        preview: p.preview,
        failure: null,
      });
      return;
    }
```

- [ ] **Step 4: Run — green**

Run: `rtk bun run test src/ui/mirror`
Expected: PASS.

- [ ] **Step 5: Lint, format, commit**

```bash
rtk bun run lint && rtk bun run fmt:check
rtk git add src/ui/mirror && rtk git commit -m "feat(ui): fold the designSystem events into a mirror slice"
```

Report: **+0 files**.

---

### Task 11: The picker

**Files:**
- Create: `src/ui/popups/model/design-system-picker.ts`
- Create: `src/ui/popups/model/design-system-picker.test.ts`
- Create: `src/ui/popups/ui/DesignSystemPicker.tsx`
- Create: `src/ui/popups/ui/DesignSystemPicker.test.tsx`
- Modify: `src/ui/popups/index.ts`

**Design source of truth (decision D8 — read it before writing a line of this task).** The picker
has **no `.dc.html` screen**; the gap is flagged and the vocabulary comes from
`design/06-agent-model-picker.dc.html` / `design/termcraft-engine.js`'s `agentPicker(w,h)`
(lines 474–514), realized in code the way `src/ui/popups/ui/ChatListPopup.tsx` already realizes it.
**Read `ChatListPopup.tsx` first and mirror its structure**; every colour comes from
`ui/theme`'s `SHELL_PALETTE`.

**Interfaces:**
- Consumes: `ui/popups/model/chat-list.ts`'s `computeChatListViewport`/`ChatListViewport` (pure
  windowing math, reused rather than duplicated — say so in a comment); `ui/theme`'s
  `SHELL_PALETTE`, `shellAttrs`; the Task 9 DTOs.
- Produces:
  ```ts
  export const DESIGN_SYSTEM_VIEWPORT_CAP = 6;
  export const SWATCH_GLYPH = "█";
  export interface DesignSystemRow {
    readonly key: string;                 // `${sourceId}:${systemId}` — stable, unique, id-safe
    readonly sourceId: string;
    readonly sourceLabel: string;
    readonly systemId: string | null;     // null for a source-status row (ungranted/unavailable)
    readonly name: string;
    readonly version: string;
    readonly state: "installable" | "ungranted" | "unavailable" | "empty";
    readonly swatches: readonly DesignSystemTokenSwatchDtoV1[];
    readonly contents: readonly string[];
    readonly note: string | null;
  }
  export function designSystemRows(sources: readonly SourceListingDtoV1[]): readonly DesignSystemRow[];
  export function visibleSwatches(swatches: readonly DesignSystemTokenSwatchDtoV1[], cells: number): readonly DesignSystemTokenSwatchDtoV1[];
  export function formatContents(componentNames: readonly string[], width: number): string;
  export interface DesignSystemPickerProps {
    readonly id: string;
    readonly rows: readonly DesignSystemRow[];
    readonly selectedIndex: number;
    readonly canPublishSelected: boolean;
    readonly updateNote: string | null;
    readonly busy: boolean;
  }
  ```

- [ ] **Step 1: Write the failing model tests**

```ts
test("every listed system becomes a row, grouped under its source in configured order", () => {
  const rows = designSystemRows([
    listing("local", "Local library", true, [MIDNIGHT_SUMMARY, AURORA_SUMMARY]),
    listing("github:acme/ds", "acme", false, [SLATE_SUMMARY]),
  ]);
  expect(rows.map((row) => row.key)).toEqual([
    "local:aurora",
    "local:midnight",
    "github:acme/ds:slate",
  ]);
});

test("systems are sorted within a source so the list is stable across runs", () => {
  const rows = designSystemRows([listing("local", "Local library", true, [MIDNIGHT_SUMMARY, AURORA_SUMMARY])]);
  expect(rows.map((row) => row.systemId)).toEqual(["aurora", "midnight"]);
});

test("an ungranted source becomes ONE status row carrying its reason, never a phantom system", () => {
  const rows = designSystemRows([
    { sourceId: "github:acme/ds", label: "acme", canPublish: false, state: "ungranted", systems: [], reason: "this source has not been granted" },
  ]);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ state: "ungranted", systemId: null, note: "this source has not been granted" });
});

test("an unavailable source becomes ONE status row carrying its reason", () => {
  const rows = designSystemRows([
    { sourceId: "github:acme/ds", label: "acme", canPublish: false, state: "unavailable", systems: [], reason: "did not answer within 3000 ms" },
  ]);
  expect(rows[0]).toMatchObject({ state: "unavailable", note: "did not answer within 3000 ms" });
});

test("a granted but empty source says so rather than vanishing", () => {
  const rows = designSystemRows([listing("local", "Local library", true, [])]);
  expect(rows[0]).toMatchObject({ state: "empty", systemId: null });
});

test("the swatch row keeps the manifest's DECLARATION order and truncates to the cells available", () => {
  const swatches = [
    { name: "background", value: "#0b0f14" },
    { name: "accent", value: "#4cc9f0" },
    { name: "brandBlue", value: "#4cc9f0" },
  ];
  expect(visibleSwatches(swatches, 2)).toEqual([swatches[0], swatches[1]]);
  expect(visibleSwatches(swatches, 10)).toEqual(swatches);
  expect(visibleSwatches(swatches, 0)).toEqual([]);
});

test("contents lists component names and says how many were elided", () => {
  expect(formatContents(["Button", "PageShell", "Card"], 40)).toBe("Button · PageShell · Card");
  expect(formatContents(["Button", "PageShell", "Card"], 12)).toBe("Button +2");
  expect(formatContents([], 40)).toBe("no components");
});

test("the viewport windows the rows with the shared chat-list math", () => {
  const viewport = computeChatListViewport({ total: 20, selectedIndex: 12, cap: DESIGN_SYSTEM_VIEWPORT_CAP });
  expect(viewport.visibleCount).toBe(DESIGN_SYSTEM_VIEWPORT_CAP);
  expect(viewport.start).toBeLessThanOrEqual(12);
  expect(viewport.start + viewport.visibleCount).toBeGreaterThan(12);
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `rtk bun run test src/ui/popups/model/design-system-picker.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the model**

Header comment must carry the D8 gap:

```ts
/**
 * The design-system picker's view model.
 *
 * DESIGN GAP, FLAGGED (CLAUDE.md: "if the design does not cover a case, ask or flag the gap
 * explicitly — do not guess"). None of the 27 `design/*.dc.html` screens covers browsing or
 * installing a design system, and `design/termcraft-engine.js` has no swatch-row helper. The
 * closest existing vocabulary is `design/06-agent-model-picker.dc.html` — engine `agentPicker`,
 * lines 474–514 — and this module reproduces it exactly: a centred modal in `amber` with an
 * `amberHi` title, a `faint` bold header row, `▸` markers, `●`/`○` state dots, a `sel`/`selFg`
 * selection band, a `├`…`┤` rule, and an `↑↓ select · ⏎ … · esc close` footer. `ChatListPopup`
 * already realizes that vocabulary in code and is the structural model for the component.
 *
 * THE ONE INVENTED ELEMENT IS THE SWATCH ROW, and it is built from vocabulary the engine already
 * uses rather than from a new idea: a run of `█` — the engine's own filled-cell glyph (`bar()`,
 * `termcraft-engine.js:58`) — one cell per token, painted with that token's `#rrggbb`, in the
 * manifest's DECLARATION order (§8.1: "the picker draws a swatch row, and the row's order is the
 * manifest's order — which is why this is an ordered list rather than a record"). Recorded here as
 * a divergence, per CLAUDE.md's rule for a value the design cannot supply.
 */
```

`designSystemRows` iterates the sources **in configured order**, sorting only the systems inside
each source. A source with no systems produces exactly one status row rather than nothing, so a
degraded source is visible instead of silently absent (§8.4).

- [ ] **Step 4: Run the model tests — green**

Run: `rtk bun run test src/ui/popups/model/design-system-picker.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Write the failing render tests**

`src/ui/popups/ui/DesignSystemPicker.test.tsx`, on the `createHeadlessRenderer` harness
`src/ui/popups/ui/ChatListPopup.test.tsx` already uses (`handle.mount`, `await handle.render()`,
`handle.capture()`, `extractRgb`, `handle.rectOf(id)`):

```ts
test("the modal title is drawn in amberHi", async () => {
  const handle = await createHeadlessRenderer({ w: 96, h: 28 });
  open = handle;
  handle.mount(<DesignSystemPicker {...baseProps} />);
  await handle.render();
  const title = findRun(handle.capture(), "design systems");
  expect(title && extractRgb(title.fg)).toBe(SHELL_PALETTE.amberHi);
});

test("the selected row is painted with the selection band", async () => {
  handle.mount(<DesignSystemPicker {...baseProps} selectedIndex={1} />);
  await handle.render();
  const selected = findRun(handle.capture(), "aurora");
  expect(selected && extractRgb(selected.bg)).toBe(SHELL_PALETTE.sel);
  expect(selected && extractRgb(selected.fg)).toBe(SHELL_PALETTE.selFg);
});

test("each swatch cell carries its token's own hex, in declaration order", async () => {
  handle.mount(<DesignSystemPicker {...baseProps} />);
  await handle.render();
  const swatchRuns = handle.capture().rows.flat().filter((run) => run.text.includes(SWATCH_GLYPH));
  expect(swatchRuns.map((run) => extractRgb(run.fg))).toEqual([
    "#0b0f14",
    "#4cc9f0",
    "#7b2cbf",
  ]);
});

test("system contents are rendered beside the colours", async () => {
  handle.mount(<DesignSystemPicker {...baseProps} />);
  await handle.render();
  expect(findRun(handle.capture(), "Button · PageShell")).toBeDefined();
});

test("canPublish false draws NO publish hint", async () => {
  handle.mount(<DesignSystemPicker {...baseProps} canPublishSelected={false} />);
  await handle.render();
  expect(findRun(handle.capture(), "publish")).toBeUndefined();
});

test("canPublish true draws the publish hint", async () => {
  handle.mount(<DesignSystemPicker {...baseProps} canPublishSelected={true} />);
  await handle.render();
  const hint = findRun(handle.capture(), "publish");
  expect(hint).toBeDefined();
});

test("an unavailable source shows its reason in amberHi, and offers no install", async () => {
  handle.mount(<DesignSystemPicker {...baseProps} rows={[UNAVAILABLE_ROW]} selectedIndex={0} />);
  await handle.render();
  const note = findRun(handle.capture(), "did not answer");
  expect(note && extractRgb(note.fg)).toBe(SHELL_PALETTE.amberHi);
  expect(findRun(handle.capture(), "⏎ install")).toBeUndefined();
});

test("an ungranted source offers `⏎ add source`, not `⏎ install`", async () => {
  handle.mount(<DesignSystemPicker {...baseProps} rows={[UNGRANTED_ROW]} selectedIndex={0} />);
  await handle.render();
  expect(findRun(handle.capture(), "add source")).toBeDefined();
  expect(findRun(handle.capture(), "⏎ install")).toBeUndefined();
});

test("the footer carries the agent-picker hint vocabulary", async () => {
  handle.mount(<DesignSystemPicker {...baseProps} />);
  await handle.render();
  const frame = handle.capture();
  expect(findRun(frame, "↑↓")).toBeDefined();
  expect(findRun(frame, "esc")).toBeDefined();
});

test("an available update is announced above the list", async () => {
  handle.mount(<DesignSystemPicker {...baseProps} updateNote="local:midnight@1.3.0 is available" />);
  await handle.render();
  expect(findRun(handle.capture(), "1.3.0 is available")).toBeDefined();
});

test("busy shows the checking state — D7's paint-before-the-freeze", async () => {
  handle.mount(<DesignSystemPicker {...baseProps} busy={true} />);
  await handle.render();
  expect(findRun(handle.capture(), "checking")).toBeDefined();
});

test("every row gets a distinct, stable id", async () => {
  handle.mount(<DesignSystemPicker {...baseProps} />);
  await handle.render();
  expect(handle.rectOf("ds-picker-row-local:midnight")).not.toEqual(
    handle.rectOf("ds-picker-row-local:aurora"),
  );
});
```

- [ ] **Step 6: Run and watch them fail**

Run: `rtk bun run test src/ui/popups/ui/DesignSystemPicker.test.tsx`
Expected: FAIL — module not found. OpenTUI render tests flake under load; a single unexplained
failure in an otherwise-green run is re-run once before being treated as real.

- [ ] **Step 7: Write `DesignSystemPicker.tsx`**

Mirror `ChatListPopup.tsx`'s structure exactly: a pure presentational `reatomComponent`-free
component (`ChatListPopup` is a plain function component — match whatever it is), taking
`DesignSystemPickerProps` and reading **no** atoms. Every colour from `SHELL_PALETTE`; bold via
`shellAttrs`. Layout per D8:

- outer `<box>` with `borderColor={SHELL_PALETTE.amber}`, title `design systems`, titled
  `SHELL_PALETTE.amberHi`;
- an update line above the list when `updateNote !== null`, in `SHELL_PALETTE.amberHi` bold;
- a header row `SOURCE  SYSTEM  VERSION  COLORS  CONTENTS` in `SHELL_PALETTE.faint` bold;
- one row per visible entry, id `ds-picker-row-${row.key}`, with the `▸`/`●`/`○` markers and the
  `sel`/`selFg` band for the selected row;
- the swatch run of `SWATCH_GLYPH` cells, one `<text>` per swatch so each carries its own `fg`;
- a `├`…`┤` rule, then a footer built from the row's `state`: `⏎ install` for `installable`,
  `⏎ add source` for `ungranted`, nothing for `unavailable`/`empty`; `↑↓ select` always;
  `p publish` only when `canPublishSelected`; `esc close` always; `checking…` in place of the
  action hint when `busy`.

- [ ] **Step 8: Run — green**

Run: `rtk bun run test src/ui/popups`
Expected: PASS.

- [ ] **Step 9: Export, lint, format, commit**

Add the component, its props and the model exports to `src/ui/popups/index.ts`.

```bash
rtk bun run lint && rtk bun run fmt:check
rtk git add src/ui/popups && rtk git commit -m "feat(ui): the design-system picker, with swatches and system contents"
```

Report: **+4 files**.

---

### Task 12: The breakage preview and the confirmations

**Files:**
- Create: `src/ui/popups/ui/DesignSystemInstallPrompt.tsx`
- Create: `src/ui/popups/ui/DesignSystemInstallPrompt.test.tsx`
- Modify: `src/ui/popups/index.ts`

**Design source of truth (D8).** `design/16-wizard-migration.dc.html` / engine `migrate(w,h)`
(`design/termcraft-engine.js:880`–892), realized in code by
`src/ui/setup/ui/MigratePrompt.tsx` — **read that file first and mirror it**, including its
`migrateBullets(view)` helper shape.

**Interfaces:**
- Produces:
  ```ts
  export type DesignSystemPromptKind = "install" | "publish";
  export interface DesignSystemInstallPromptProps {
    readonly id: string;
    readonly kind: DesignSystemPromptKind;
    readonly ref: string;
    readonly summary: DesignSystemSummaryDtoV1 | null;
    readonly preview: DesignSystemPreviewDtoV1 | null;
    readonly failure: FailureDtoV1 | null;
    readonly busy: boolean;
  }
  /** The `• ` lines, derived from the preview — one per diagnostic, plus a truncation line. */
  export function breakageBullets(preview: DesignSystemPreviewDtoV1): readonly string[];
  export const MAX_RENDERED_BULLETS = 8;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
test("a clean preview says so and offers install", async () => {
  handle.mount(<DesignSystemInstallPrompt {...base} preview={CLEAN_PREVIEW} />);
  await handle.render();
  expect(findRun(handle.capture(), "nothing breaks")).toBeDefined();
  expect(findRun(handle.capture(), "⏎ install")).toBeDefined();
});

test("§8.3: a breaking preview LISTS what breaks and still offers install", async () => {
  handle.mount(<DesignSystemInstallPrompt {...base} preview={BREAKS_PAGES_PREVIEW} />);
  await handle.render();
  const headline = findRun(handle.capture(), "⚠");
  expect(headline && extractRgb(headline.fg)).toBe(SHELL_PALETTE.amberHi);
  expect(findRun(handle.capture(), "pages/dashboard.tsx")).toBeDefined();
  expect(findRun(handle.capture(), "⏎ install")).toBeDefined();
});

test("D6: a blocked preview offers NO install", async () => {
  handle.mount(<DesignSystemInstallPrompt {...base} preview={BLOCKED_PREVIEW} />);
  await handle.render();
  expect(findRun(handle.capture(), "⏎ install")).toBeUndefined();
  expect(findRun(handle.capture(), "esc")).toBeDefined();
});

test("the bullet list is bounded and says how many were elided", () => {
  const bullets = breakageBullets({ verdict: "breaks-pages", errors: manyErrors(30), warnings: [] });
  expect(bullets).toHaveLength(MAX_RENDERED_BULLETS + 1);
  expect(bullets.at(-1)).toContain("22 more");
});

test("each bullet names its file and its message", () => {
  const [first] = breakageBullets(BREAKS_PAGES_PREVIEW);
  expect(first).toContain("pages/dashboard.tsx");
  expect(first).toContain("t.brandBlue does not exist");
});

test("a diagnostic with no file still renders, attributed to the tree", () => {
  const [first] = breakageBullets({
    verdict: "blocked",
    errors: [{ code: "TYPE_CHECK_UNAVAILABLE", message: "the compiler is down", file: null, blockedPages: [] }],
    warnings: [],
  });
  expect(first).toContain("the whole tree");
});

test("warnings are shown below the fatals, in faint", async () => {
  handle.mount(<DesignSystemInstallPrompt {...base} preview={WARNINGS_ONLY_PREVIEW} />);
  await handle.render();
  const warning = findRun(handle.capture(), "unused");
  expect(warning && extractRgb(warning.fg)).toBe(SHELL_PALETTE.faint);
});

test("the publish kind says publish, never install", async () => {
  handle.mount(<DesignSystemInstallPrompt {...base} kind="publish" preview={null} />);
  await handle.render();
  expect(findRun(handle.capture(), "⏎ publish")).toBeDefined();
  expect(findRun(handle.capture(), "install")).toBeUndefined();
});

test("a failure is shown in red and offers only dismissal", async () => {
  handle.mount(<DesignSystemInstallPrompt {...base} failure={FAILURE} preview={null} />);
  await handle.render();
  const message = findRun(handle.capture(), FAILURE.safeMessage);
  expect(message && extractRgb(message.fg)).toBe(SHELL_PALETTE.red);
  expect(findRun(handle.capture(), "⏎ install")).toBeUndefined();
});

test("busy replaces the action hint so a frozen thread never looks like a dead key", async () => {
  handle.mount(<DesignSystemInstallPrompt {...base} busy={true} />);
  await handle.render();
  expect(findRun(handle.capture(), "installing")).toBeDefined();
  expect(findRun(handle.capture(), "⏎ install")).toBeUndefined();
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `rtk bun run test src/ui/popups/ui/DesignSystemInstallPrompt.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the component**

Layout per D8's second vocabulary: `⚠ <verdict headline>` in `amberHi` bold; a `dim` lead-in
(`"will replace design/system/ with midnight 1.3.0:"`); `• ` bullets in `SHELL_PALETTE.fg` (fatals)
then `SHELL_PALETTE.faint` (warnings); a `faint` consequence line
(`"pages that fail keep their last good render until they are fixed"`); the `├`…`┤` rule; and the
footer `⏎ install` / `⏎ publish` in `amber` bold followed by `· esc cancel` in `dim`.

Copy the exact headline wording pattern from `MigratePrompt.tsx` — do not invent a second voice for
the same dialog family.

- [ ] **Step 4: Run — green**

Run: `rtk bun run test src/ui/popups`
Expected: PASS.

- [ ] **Step 5: Export, lint, format, commit**

```bash
rtk bun run lint && rtk bun run fmt:check
rtk git add src/ui/popups && rtk git commit -m "feat(ui): the design-system breakage preview and install/publish confirmations"
```

Report: **+2 files**.

---

### Task 13: Shell wiring — overlay, keys, intents, render

**Files:**
- Modify: `src/ui/workspace/model/focus.ts` (`OverlayKind`)
- Modify: `src/ui/app/model/deps.ts` (`UiLocalState`)
- Modify: `src/ui/app/model/keymap.ts` (+`KeyIntent` members, +overlay branch)
- Modify: `src/ui/app/model/intent.ts` (+`applyIntent` cases)
- Modify: `src/ui/app/ui/App.tsx` (`renderOverlay`)
- Modify: `src/ui/actions/model/registry.ts` and `src/ui/actions/types.ts` (the slash command)
- Modify: each of the above files' `.test.ts`/`.tsx`

**Interfaces:**
- Produces:
  ```ts
  export type OverlayKind = … | "design-system";
  // UiLocalState
  readonly designSystemSelection: Atom<number>;
  readonly designSystemPrompt: Atom<DesignSystemPromptKind | null>;   // null = the picker itself
  // KeyIntent
  | { kind: "design-system-move"; delta: -1 | 1 }
  | { kind: "design-system-activate" }
  | { kind: "design-system-publish" }
  ```

- [ ] **Step 1: Write the failing keymap tests**

Append to `src/ui/app/model/keymap.test.ts`, matching its existing `resolveKey(...)` call shape:

```ts
test("the design-system overlay routes up/down/enter/esc", () => {
  const context = { ...baseContext, overlay: "design-system" as const };
  expect(resolveKey(key("up"), context)).toEqual({ kind: "design-system-move", delta: -1 });
  expect(resolveKey(key("down"), context)).toEqual({ kind: "design-system-move", delta: 1 });
  expect(resolveKey(key("return"), context)).toEqual({ kind: "design-system-activate" });
  expect(resolveKey(key("escape"), context)).toEqual({ kind: "overlay-dismiss" });
});

test("`p` publishes only from the picker, never from a confirmation", () => {
  expect(resolveKey(key("p"), { ...baseContext, overlay: "design-system", designSystemPrompt: null }))
    .toEqual({ kind: "design-system-publish" });
  expect(resolveKey(key("p"), { ...baseContext, overlay: "design-system", designSystemPrompt: "install" }))
    .toBeNull();
});

test("the trust-prompt screen still wins over any overlay", () => {
  expect(resolveKey(key("down"), { ...baseContext, screen: "trust-prompt", overlay: "design-system" }))
    .toEqual({ kind: "trust-decline" });   // or whatever the existing first branch yields — assert the EXISTING behaviour
});
```

- [ ] **Step 2: Write the failing intent tests**

Append to `src/ui/app/model/intent.test.ts`:

```ts
test("design-system-move wraps around the row count", () => {
  local.designSystemSelection.set(0);
  applyIntent({ kind: "design-system-move", delta: -1 }, deps);
  expect(local.designSystemSelection()).toBe(rowCount - 1);
});

test("design-system-activate on an installable row dispatches designSystem.preview", async () => {
  await applyIntent({ kind: "design-system-activate" }, deps);
  expect(kernel.dispatched).toEqual([["designSystem.preview", { ref: "local:midnight@1.2.0" }]]);
});

test("design-system-activate on a PREVIEWED prompt dispatches designSystem.install with the installId", async () => {
  mirror.designSystems.set({ ...EMPTY_DESIGN_SYSTEM_MIRROR, phase: "previewed", installId: INSTALL_ID, preview: BREAKS_PAGES_PREVIEW });
  local.designSystemPrompt.set("install");
  await applyIntent({ kind: "design-system-activate" }, deps);
  expect(kernel.dispatched).toEqual([["designSystem.install", { installId: INSTALL_ID }]]);
});

test("D6: activate on a BLOCKED preview dispatches nothing", async () => {
  mirror.designSystems.set({ ...EMPTY_DESIGN_SYSTEM_MIRROR, phase: "previewed", installId: INSTALL_ID, preview: BLOCKED_PREVIEW });
  local.designSystemPrompt.set("install");
  await applyIntent({ kind: "design-system-activate" }, deps);
  expect(kernel.dispatched).toEqual([]);
});

test("design-system-publish dispatches only when the selected source can publish", async () => {
  await applyIntent({ kind: "design-system-publish" }, deps);          // local, canPublish true
  expect(kernel.dispatched).toEqual([["designSystem.publish", { sourceId: "local" }]]);
});

test("overlay-dismiss from a confirmation returns to the picker, not to the workspace", () => {
  local.overlay.set("design-system");
  local.designSystemPrompt.set("install");
  applyIntent({ kind: "overlay-dismiss" }, deps);
  expect(local.designSystemPrompt()).toBeNull();
  expect(local.overlay()).toBe("design-system");
});

test("overlay-dismiss from the picker closes the overlay", () => {
  local.overlay.set("design-system");
  local.designSystemPrompt.set(null);
  applyIntent({ kind: "overlay-dismiss" }, deps);
  expect(local.overlay()).toBeNull();
});

test("opening the overlay dispatches designSystem.list once", async () => {
  await runAction("design-system.open", deps);
  expect(local.overlay()).toBe("design-system");
  expect(kernel.dispatched).toEqual([["designSystem.list", {}]]);
});
```

- [ ] **Step 3: Run and watch them fail**

Run: `rtk bun run test src/ui/app`
Expected: FAIL.

- [ ] **Step 4: Wire it**

- `OverlayKind` gains `"design-system"`.
- `UiLocalState` gains the two atoms, both **named** and both created in `createUiDeps`
  (`atom(0, "ui.designSystemSelection")`, `atom<DesignSystemPromptKind | null>(null, "ui.designSystemPrompt")`).
  No atom is created in a component body.
- `resolveKey` gains one `context.overlay === "design-system"` branch, placed with the other
  overlay branches and **after** the `screen === "trust-prompt"` branch, so trust still wins.
- `applyIntent` gains the three cases. Selection movement reuses the existing `wrapIndex` helper
  the `chat-move` case uses — do not write a second one. `design-system-activate` branches on
  `local.designSystemPrompt()`: `null` → preview the selected row (or grant an ungranted source);
  `"install"` → dispatch `designSystem.install` **only** when the mirror's verdict is not
  `"blocked"`; `"publish"` → dispatch `designSystem.publish`.
- `renderOverlay` in `App.tsx` gains one branch returning either `DesignSystemPicker` or
  `DesignSystemInstallPrompt` depending on `local.designSystemPrompt()`, with rows computed from
  `mirror.designSystems().sources` through `designSystemRows`.
- `ui/actions` gains one entry, `design-system.open`, so the overlay is reachable by slash command
  and hotkey the way every other overlay is. Its execution effect sets the overlay **and**
  dispatches `designSystem.list` — the picker must never render an empty list it will not fill.

Every handler that touches Reatom goes through the adapter binding the existing popup handlers
already use; no bare callback reads or writes an atom.

- [ ] **Step 5: Run — green, as two separate commands**

```bash
rtk bun run test src/ui
rtk bun run test src/entrypoint
```

Expected: PASS. A combined run produces random failures under load — never combine them.

- [ ] **Step 6: Lint, format, commit**

```bash
rtk bun run lint && rtk bun run fmt:check
rtk git add src/ui && rtk git commit -m "feat(ui): reach the design-system picker from the shell"
```

Report: **+0 files**.

---

### Task 14: The composition root

**Files:**
- Modify: `src/entrypoint/model/create-shell.ts`
- Modify: `src/entrypoint/model/create-shell.test.ts`
- Create: `src/store/adapters/design-system-install.ts`
- Create: `src/store/adapters/design-system-install.test.ts`
- Modify: `src/store/adapters/index.ts` (or wherever the adapters are barrelled — check)

**Interfaces:**
- Produces:
  ```ts
  export function createDesignSystemQuarantineAdapter(deps: {
    readonly userStateRoot: string;
  }): DesignSystemQuarantinePort;
  export function createDesignSystemInstallAdapter(deps: StoreAdapterDeps): DesignSystemInstallPort;
  ```

- [ ] **Step 1: Write the failing adapter tests**

Follow `src/store/adapters/trust.test.ts`'s shape (an `AssertConforms` check plus behaviour):

```ts
test("the quarantine adapter maps a limit refusal to RESOURCE_LIMIT_EXCEEDED", async () => {
  const result = await adapter.admit({ installId: uuidv7(), files: [oversizeFile()] });
  expect(result).toHaveProperty("code", "RESOURCE_LIMIT_EXCEEDED");
});

test("the quarantine adapter maps any other fault to PERSISTENCE_FAILED", async () => { /* … */ });

test("the install adapter writes design/system/** and the provenance record in one transaction", async () => { /* … */ });

test("readProvenance returns null for a project that never installed — NOT an error", async () => {
  expect(await adapter.readProvenance()).toBeNull();
});

test("readProvenance surfaces a CORRUPT record as a failure, never as null", async () => {
  // A corrupt record is not the same fact as an absent one: reporting it as "no source" would
  // silently retract a claim the project made.
  writeProjectFile("design-system-source.json", "{ not json");
  expect(await adapter.readProvenance()).toHaveProperty("code");
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `rtk bun run test src/store/adapters/design-system-install.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the two adapters**

Both map their tagged errors through `store/adapters/failure.ts`'s `toFailureDto` — the same
relationship `createDesignSystemSourceAdapter` has (read it; it is 60 lines and is the template).
A `StorageLimitExceededError` (or a `DesignSystemPackageTooLargeError` in its `cause` chain) becomes
`RESOURCE_LIMIT_EXCEEDED`; everything else becomes `PERSISTENCE_FAILED`. Close each file with the
ring's `AssertConforms` type check.

`createDesignSystemInstallAdapter`'s `install(...)` calls `open.transactions.installDesignSystem`
with a fresh `transactionId`/`actionId` (`deps.uuidv7()`) and `deps.clock.now().toISOString()`,
exactly as `createTurnTransactionsAdapter` does. `readProvenance()` reads
`DESIGN_SYSTEM_PROVENANCE_FILENAME` through the project's `SafeProjectFs`, returns `null` on
not-found, and decodes with `decodeDesignSystemProvenance`.

- [ ] **Step 4: Write the failing composition test**

Append to `src/entrypoint/model/create-shell.test.ts`:

```ts
test("the local design-system source is composed with the REAL admission budget", async () => {
  // A source built with `allowAllPackageAdmission` in production would read an unbounded package.
  const shell = await interactiveShell(testDeps);
  expect(shell.kernelDeps.designSystemSource.id).toBe("local");
  expect(shell.kernelDeps.designSystemSource.canPublish).toBe(true);
});

test("the design-system library lives under the SAME userStateRoot as trust and sandboxes", async () => {
  const shell = await interactiveShell({ ...testDeps, userStateRoot: SCRATCH });
  expect(designSystemsRoot(SCRATCH)).toBe(path.join(SCRATCH, "design-systems"));
  expect(fs.existsSync(path.join(SCRATCH, "trust"))).toBe(true);
});
```

- [ ] **Step 5: Wire the composition root**

In `interactiveShell`'s `kernelDeps` object literal, immediately before `const kernel = createKernel(kernelDeps);`:

```ts
  // project-design-systems §8.2: the library lives under the SAME per-user root as `trust/`,
  // `sandboxes/` and `backups/`, resolved ONCE (`resolveDefaultUserStateRoot`) and shared, so the
  // ledger and the library can never disagree about which machine they are on.
  designSystemSource: createDesignSystemSourceAdapter(
    createLocalDesignSystemSource({
      userStateRoot,
      fs: nodeDesignSystemFsDeps,
      // REQUIRED and defaultless by P3's design, so an unbudgeted fetch does not compile.
      admission: createDesignSourceAdmission(),
      clock: systemClock,
    }),
  ),
  designSystemQuarantine: createDesignSystemQuarantineAdapter({ userStateRoot }),
  designSystemInstall: createDesignSystemInstallAdapter(storeAdapterDeps),
```

`userStateRoot` must be the **same binding** the store deps already use
(`deps?.userStateRoot ?? resolveDefaultUserStateRoot()`, line ~126) — never a second call to
`resolveDefaultUserStateRoot()`. If that value is not in scope as a `const`, hoist it into one and
pass it to `nodeStoreDeps` as well, so there is exactly one resolution. Say so in the report.

**Grant `local` on composition (decision D9):** after the source is built, call
`trustStore.grantSource(trustStore.buildSourceSubject({ sourceKind: "local", sourceId: "local", canonicalLocation: localLibraryDir(userStateRoot), locationFilesystemIdentity: <fs identity or null> }))` if it
is not already granted. Log and continue on failure — an ungranted `local` degrades to an
`ungranted` row in the picker, which is legible, and refusing to start the shell over a trust-ledger
write would be disproportionate.

- [ ] **Step 6: Run — as two separate commands**

```bash
rtk bun run test src/store
rtk bun run test src/entrypoint
```

Expected: PASS.

- [ ] **Step 7: Lint, format, commit**

```bash
rtk bun run lint && rtk bun run fmt:check
rtk git add src/store src/entrypoint && rtk git commit -m "feat(entrypoint): compose the local design-system source, its quarantine and its install transaction"
```

Report: **+2 files**.

---

### Task 15: Architecture docs, the canary, and the audit

**Files:**
- Modify: `docs/architecture/**` (whichever documents' `Source anchors` now name changed files)
- Modify: `src/gate/model/lexer.test.ts` (the corpus count)
- Modify: `src/gate/model/lexer.oracle.test.ts` (the prose count)

- [ ] **Step 1: Fix the corpus canary — count, never assume**

```bash
rtk bun run test src/gate/model/lexer.test.ts
```

The failure names the real count. Set `expect(files.length).toBe(<observed>)` and the prose
`"the repository's own <observed> sources"` in `lexer.oracle.test.ts` to that number. The arithmetic
from Tasks 1–14's reports (`+2 +0 +2 +2 +1 +4 +2 +5 +2 +0 +4 +2 +0 +2` = **+28**, so 1027 → 1055)
is the audit trail — if the observed number differs, a task's report was wrong and the discrepancy
must be explained in this task's report, not silently absorbed.

- [ ] **Step 2: Update the architecture docs**

Per CLAUDE.md's architecture-docs rule, and using the architecture-update skill. At minimum:

- the install pipeline as a Mermaid diagram matching §8.3's, with the real function names
  (`fetch` → `admitPackageThroughQuarantine` → `composeDesignSystemCandidate` → `runTree` →
  `summarizeGatePass` → `installDesignSystem`);
- the provenance record: its path, its schema version, why it is not in `project.toml`;
- the `design-system-install` mutation kind in whichever document lists the transaction kinds;
- **the D8 design gap, recorded explicitly**: `design/` has no design-system picker screen, the
  picker borrows `06-agent-model-picker` and `16-wizard-migration`, and the swatch row is a
  documented divergence. A future design pass needs somewhere to find this.
- Move any `Source anchors` entry that still points at the spec to the real file it now describes.

- [ ] **Step 3: Run the Reatom audit**

```
/reatom-audit
```

It audits changed TypeScript only. Tasks 10–13 touched Reatom (a new mirror atom, two new
`UiLocalState` atoms, new intent cases), so this is not optional. **The audit router consumes its
cache** — a second `--changed` run reports "already audited" though no auditor ran, so if a
follow-up edit is needed, re-run with explicit paths (`/reatom-audit src/ui/mirror src/ui/app src/ui/popups`).
Fix every finding; re-run over the files you changed.

- [ ] **Step 4: Full verification**

```bash
rtk bun run lint
rtk bun run fmt:check
rtk bun run test src/entities src/store src/core src/gate src/runtime src/host src/agent src/infrastructure
rtk bun run test src/ui
rtk bun run test src/entrypoint
```

`src/ui` and `src/entrypoint` **must** be separate commands. A `crashed` verdict is never a pass;
a `bun test` segfault is a known flake — re-run once before calling it a regression. OpenTUI render
tests flake under load — re-run a single unexplained render failure before treating it as real.

- [ ] **Step 5: Commit**

```bash
rtk bun run lint && rtk bun run fmt:check
rtk git add docs src/gate && rtk git commit -m "docs(architecture): record the design-system install pipeline, the provenance record and the picker design gap"
```

Report: **+0 files**.

---

## Final verification

Before this plan is reported complete, every line below must have been **run** and its output
**observed** — evidence before assertions (superpowers:verification-before-completion).

**Commands, in order:**

```bash
rtk bun run lint
rtk bun run fmt:check
rtk bun run test src/entities src/store src/core src/gate src/runtime src/host src/agent src/infrastructure
rtk bun run test src/ui
rtk bun run test src/entrypoint
```

**Spec obligations, each traceable to a task and a test:**

| Spec | Obligation | Task | Test |
| --- | --- | --- | --- |
| §8.3 | `fetch` materializes into quarantine, never into the tree | 4, 8 | "quarantine lives under the user-state root", "fetch's bytes never reach the tree" |
| §8.3, §11 | A package exceeding safe-fs limits is rejected **before** the candidate | 4, 8 | "rejected BEFORE it reaches the candidate", "fails BEFORE the Gate is asked" |
| §8.3 | An immutable hashed candidate with `design/system/` replaced | 4, 6 | "the content hash equals designSystemContentHash", "replaces system/** wholesale" |
| §8.3 | The FULL Gate runs on the candidate | 8 | "the pipeline runs in order: fetch → quarantine → Gate" |
| §8.3 | A breakage preview built from the Gate's answer | 6 | the four `summarizeGatePass` verdict tests |
| §8.3, §11 | A crash mid-install cannot leave a half-replaced system | 5 | the `runCrashCase` sweep over every `TransactionBoundary` |
| §8.3 | No foreign code executes before commit | 4, 8 | nothing in the pipeline compiles or evaluates a package file; the Gate's type check is the only reader |
| §11 | `list` never opens a `.tsx` | P3 (merged) + 7 | P3's recording-filesystem test still green; Task 7's "an UNGRANTED source is never queried" |
| §8.4 | Sources are trust subjects; an unrecorded source is never queried | 7, 14 | "an UNGRANTED source is never queried"; the composition-root grant |
| §8.4 | An unreachable source degrades under a bounded timeout | 7 | "the others still list" |
| §8.1 | The picker's swatch row is in declaration order | 11 | "keeps the manifest's DECLARATION order" |
| §8.1 | System contents beside the colours | 11 | "system contents are rendered beside the colours" |
| §8.1 | `canPublish` gates the publish button | 11, 9 | "canPublish false draws NO publish hint"; "refused when the source declares canPublish false" |
| §8.6 | Publish to `local`, through the port | 9 | "sends the project's OWN system/**" |
| §8.5 | Provenance is `source:system@version` + content hash, outside `design/` | 3, 8 | the round-trip suite; "writes the provenance record with the ref AND the content hash" |
| §8.5 | Update check = compare a source summary's version against the recorded one | 7 | "a different version at the recorded address is an available update" |
| §8.5 | An update offer is the same install pipeline | 13 | activate on the update row dispatches `designSystem.preview` |
| §12 | Replacing a design system can break pages — surfaced, not prevented | 6, 8, 12 | "committing a `breaks-pages` preparation SUCCEEDS" |
| P3 M5 | `fetch` no-follows the package root | 1 | "a symlinked local/<id> is refused" |
| P3 M11 | Publish never destroys data it cannot recover | 2 | the swap-order and crash-repair tests |

**Manual check the tests cannot make (do it, then report what was seen):** launch the shell against
a scratch project (`rtk bun run start`), open the picker, and confirm the "checking…" state paints
**before** the Gate's freeze (decision D7). A test can assert the event ordering; only a human eye
can confirm it reaches the terminal in time.

---

## Open risks

1. **P4 has not merged at the time of writing.** This plan assumes P4 creates no file under
   `.termcraft/` for design systems (its own scope table says so) and that
   `entities/design-system`'s names are as P2 landed them. Task 3's implementer reconciles D1
   against the merged reality first and reports any change.
2. **Two whole-tree Gate passes per preparation**, both of which freeze the thread (D7). Accepted
   and documented; not fixed here. If the freeze proves intolerable in the manual check, that is a
   finding for the closeout, not a scope expansion of this plan.
3. **`DesignSystemSummaryV1` carries no content hash**, so a same-version republish is invisible to
   the update check and is only caught at the next `fetch` (Task 7, Step 1's last test). Widening
   the summary would be a port change and is forbidden.
4. **The `list` timeout abandons rather than cancels** its loser (D10), because the port has no
   `signal`. Harmless for `local`; a GitHub adapter must bound itself.
5. **`store/transaction` may not be allowed to import `store/design-systems`** (Task 5, Step 5).
   The fallback — a duplicated literal pinned by a test — is specified, but the implementer must
   check the module DAG rather than assume.
6. **The protocol surface grows by four commands and nine events**, touching six closure-tested
   files. Their pinned counts must be read, not assumed, and the counts in this plan are the values
   observed on 2026-08-12.

---

## Self-review

Run after the plan is written, before it is executed (writing-plans skill).

**1. Spec coverage.** Every P10 obligation in §8.3, §8.4, §8.5, §8.6, §10.1 and §11 appears in the
Final verification table with a task and a named test. §8.1's port and §8.2's storage layout are
P3's and are consumed unchanged. §7's fatals are P2's and are consumed through `runTree`.

**2. Placeholder scan.** No task says "TBD", "add appropriate error handling", "write tests for the
above", or "similar to Task N". Every code step carries real code or a numbered, named procedure
over named functions. Three places deliberately instruct the implementer to *read then adapt* — the
`pageRemovePlanLedger` shape (Task 9), the `SourceHandle.read()` contract (Task 4), and the
`store/transaction` import direction (Task 5) — and each names exactly what to read, what to do if
it differs, and that the divergence goes in the report.

**3. Type consistency.** `DesignSystemCandidateTreeV1`, `DesignSystemPreviewV1`,
`DesignSystemPreparedInstallV1`, `SourceListingV1`, `DesignSystemInstallFile` and the nine event
payloads keep the same field names from the task that defines them through every task that consumes
them. The store-side `PackageFile`, the port-side `PackageFileV1` and the quarantine's read-back all
use `{ relPath, bytes }`. Tree-relative, project-relative and package-relative paths are named
distinctly at every boundary and the Global Constraints fix the vocabulary once.
