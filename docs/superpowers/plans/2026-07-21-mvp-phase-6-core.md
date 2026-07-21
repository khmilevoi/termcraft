# MVP Phase 6 — `core/` (Kernel) — master index

Date: 2026-07-21
Branch: `phase-6-core` (base: `de50dbb`, the phase-5 merge)
Status: master index; each slice gets a JIT sub-plan before it executes.

> This is a master index, not an executable task plan — the same shape phase 2
> used (`2026-07-18-mvp-phase-2d-supervisor.md`). Each slice below gets its own
> plan document written just-in-time with `superpowers:writing-plans`, then
> executed with `superpowers:subagent-driven-development`.

## Normative sources

- **KCC** — `docs/superpowers/specs/2026-07-16-kernel-command-contract-design.md`
  (whole, 1423 lines). Governs command authority, state machines, capability/guard
  behaviour, DTOs, revisions, sequencing, deduplication, and fencing.
- **TD** — `2026-07-16-turn-durability-staging-design.md` (turn sequence, startup
  ordering, orphan-turn table, read-set CAS, workspace lifetime).
- **POS** — `2026-07-16-projections-observability-scale-design.md` (render cache
  keys, diagnostics, operations-log field rules).
- **HSP** — `2026-07-16-host-supervision-protocol-design.md` (only the Kernel-owned
  parts: `PreviewSession` control, frame-broker consumption, preview error surfacing).
- **PHD** — `2026-07-16-production-hardening-decisions-design.md`.
- **ROADMAP** — `2026-07-17-termcraft-mvp-roadmap.md` §Phase 6 and its MVP
  out-of-scope list.
- Global constraints from ROADMAP §"Global constraints" bind every slice
  (errore, Reatom v1001, module DAG, folder shape, English-only, per-task commits).

### Corrections to counts

Written against the spec text, not against prior prose summaries:
`CommandKindV1` has **43** members (KCC:425-444), `EventKindV1` has **43**
(KCC:694-713), §11.1 has **31** rejection codes, §11.2 has **30** operational
failure codes. Any exhaustiveness test asserts these numbers.

## 1. Scope resolution — the contract-vs-roadmap tension

KCC fixes **seven** machines and **closed** unions (§2.12). ROADMAP §Phase 6 names
**five** families and its out-of-scope list defers Restore, `/commit-*`, Git
history, interactive input, Tweaks, and the `/model` picker UI.

These constrain different layers — KCC constrains the *type surface and legality
tables*; ROADMAP constrains *which resource-owning services get built*. The line
this phase takes:

- **Tier A — build complete, no exceptions.** Closed unions, payload schemas,
  target extractors, guards, transition tables, rejection codes, capability
  projection, DTO codecs. All 43 command kinds, 43 event kinds, 7 machines.
- **Tier B — build the orchestration.** project/startup, turn, chats + model +
  page mutations, preview, pins, export, migration-recovery routing.
- **Tier C — machine + guard only, no service.** `restore.*`, `commit.*`,
  `history.open`, `preview.forwardInput`, `preview.setTweak`,
  `preview.setMode(→interactive)`. Their transition tables exist and are tested;
  their guards return `available: false` with a typed reason, so no service is
  ever reached.

**Why Tier A cannot be trimmed.** KCC §8.2 permits adding a kind only with "a
protocol-schema change, guard, capability mapping, transition-table entry, and
contract tests" — shipping a partial union means phase 7's UI mirror and every
contract test are written against a union that must later be re-opened. §10.2's
parity is a *type identity* (`CapabilityId === CommandKindV1`) and cannot be
partially satisfied: a missing row is a compile error in the exhaustiveness test.
§13.1 requires tests to enumerate *every* state/action pair, which a 5-machine
subset makes vacuous. Tier A is pure data plus pure functions with zero upstream
dependency — the cheapest part of the phase and the one with the most downstream
leverage.

**Why this still honours ROADMAP.** The out-of-scope list enumerates *features a
user can reach*, not types. A Tier-C command that always rejects with a typed
reason is indistinguishable from "not built" at the UI, and phase 7 gets a stable
`capability: CommandKindV1` id for the dimmed row it must render anyway
(KCC §10.4: "Other turn-locked slash rows stay visible but dimmed"). What ROADMAP
defers is the Restore/commit *services*, which is exactly what Tier C defers.

### Decision D1 — the rejection code for Tier-C commands

Deferred-family guards reject with **`CAPABILITY_UNAVAILABLE`**, §11.1's
designated "typed fallback for a guard reason that has no more specific public
code". `GIT_UNAVAILABLE` is rejected as a candidate because it asserts something
false (installed Git may be perfectly usable; termcraft simply ships no adapter).
The choice is made in exactly one place — `core/versions/model/deferred-guards.ts`
— because capability/guard parity requires the primary code to be identical on the
projection path and the dispatch path.

## 2. Blockers — upstream work this phase implies

Phase 6 is not confined to `src/core/`. Four upstream gaps must be closed, and
they are the reason slice 6D exists as a distinct, cross-module slice.

- **B1 · No geometry query anywhere.** `PreviewSession.query(frameToken, query)`
  does not exist in `host/`, and no `query-hit`/`pin-anchor` control kind exists on
  the wire. `GeometryTokenV1` can therefore never be minted and **`pin.create` is
  unimplementable**, though ROADMAP lists "pins lifecycle" as MVP. Resolution:
  add the wire query kind plus `query()` to `host` in 6D, and if that proves
  larger than budgeted, split 6G so `pin.setStatus` ships and `pin.create` follows.
  This is the one genuine MVP-scope casualty and must not be papered over.
- **B2 · `ProjectWriteCoordinator` has no reachable implementation.**
  `store/transaction`'s `WriteMutex` exists but `store/types.ts` divergence note 1
  deliberately hides it, and `OpenProject` exposes no `writeMutex`. Export's
  mandated short `ProjectWritePermit` (KCC §7.5, §12.5) cannot be taken. Resolution:
  expose the **same** instance the engine already uses. Creating a second mutex
  silently breaks single-writer exclusion and is forbidden.
- **B3 · `store`'s public surface cannot express six MVP commands.** The
  transaction builders (`buildChatAppend`, `buildPinAppend`, `computeAfterImage`,
  `encodeProjectManifest`, …) are not exported, and `core` may not import
  `store/*`. This blocks `chat.create`, `page.renameTitle`, `page.reorder`,
  `page.removeConfirm`, `pin.setStatus`, `model.select`, active-page/active-chat
  writes, and checkpoint persistence. Resolution: grow `TransactionEngine` with
  **named domain methods** inside `store/` — `core` must never learn the
  `TransactionOperation` layout.
- **B4 · `HostSupervisor.preview()` returns `PreviewHandle`, not
  `PreviewSession`.** A restart-managed, resizable, mode-settable session does not
  exist. `host/supervisor/model/preview-session.ts` records that both shapes exist
  "with no `core` yet to choose between them". Phase 6 chooses `PreviewSession`
  (the contract's shape) and `host` composes them.

## 3. Contradictions between sources — decided here

- **C1 · "Lift `store/types.ts` verbatim" is impossible.** That file imports from
  nine `store/*` submodules; a verbatim lift would make `core` import `store/*`,
  violating the DAG. **Decision:** `core/ports/` declares narrow, core-owned ports
  over `entities/` + core DTOs only, and store's tagged errors map to
  `FailureDtoV1` at the adapter boundary. Only `agent/types.ts` is genuinely
  liftable verbatim. `store/types.ts`'s header, `docs/architecture/modules.md`, and
  ROADMAP's port-placement note must all be amended in this phase.
- **C2 · May adapters import `core/ports/*`?** ROADMAP says "the adapters import
  nothing — the composition root injects" (structural typing); code-structure's
  mermaid says `store -- "implements core ports" --> core` (nominal import).
  **Decision:** type-only adapter→port imports, one definition serving both sides.
  State it explicitly in `code-structure.md`.
- **C3 · Counts.** Use the spec text: 43/43/31/30.
- **C4 · Machine scope.** Resolved by Tier A/B/C above; the resolution is written
  into `docs/architecture/modules.md` when its "Kernel — no code yet" section is
  replaced.
- **C5 · `core/` folder shape.** code-structure declares only
  `ports/ turns/ versions/ export/ chats/`; the contract needs eight more folders.
  `code-structure.md` is updated in the same slice that creates them.
- **C6 · Two `TurnReadSet` types** with the same name reach `store`'s public
  surface (sandbox's vs transaction's). Rename the sandbox one to
  `StagedTurnReadSet` in 6D; the 1:1 translation is a named core deliverable
  (`core/turns/model/read-set.ts`).

## 4. Slice plan

Ordering: pure and foundational first, resource-owning orchestration last. Every
slice ends green — `bun test` + `bun x tsc --noEmit` — and its own contract tests
are exhaustive over what it introduced.

| Slice | Name | Size | Deps | Cross-module |
|---|---|---|---|---|
| 6A | Protocol DTOs, codecs, closure tests | L | — | no |
| 6B | Counters, dedupe ledger, mailbox, revision & cancel guards | M | 6A | no |
| 6C | Seven machines, guards, capability targets, projector | L | 6A, 6B | no |
| 6D | Ports ring, fakes, adapter facades (closes B1–B4) | L | 6C | **yes** |
| 6E | Project lifecycle, startup, trust, project mutations | XL | 6D | no |
| 6F | Turn orchestration, end to end | XL | 6E | no |
| 6G | Preview session, frame broker, token chain, export | XL | 6F | no |

Baseline to hold from the first commit: **1261 pass / 0 fail**, `tsc --noEmit`
exit 0, `bun test` returns to the shell (no hang).

### 6A — Protocol DTOs, codecs, and closure tests

Everything under `core/protocol/`: the 43-member `CommandKindV1`, 43 strict
payload schemas, `CommandEnvelopeV1` + decoder + canonical-envelope hash, the
accepted/rejected result DTOs, the 31 rejection codes, the 30 operational failure
codes plus `FailureDtoV1`, `UnavailableReason` with its stable primary-reason
priority table, the 43-member `EventKindV1` with 43 payload schemas,
`EventEnvelopeV1` with its 14-field correlation block, the shared DTOs
(`FrameIdentityV1`, `PageRemovePlanV1`, `PageDescriptorV1`/`ChangeV1`,
`PinDtoV1`, `DiagnosticDtoV1`), and the `UInt64String` codec.

Tests: KCC §13.2 "DTO round trip and closure" in full — every kind has exactly one
schema, unknown discriminators and unknown keys reject, and every command, result,
event, capability reason, and error round-trips with no class or object identity
surviving. Zod per the repo's decoder-migration direction.

**Note.** `bigint` is legal internally for the two counters and never crosses a
DTO boundary; DTOs carry no `Error`, `Date`, `Map`, `Set`, class instance,
function, `undefined`, or `bigint`.

### 6B — Counters, dedupe ledger, mailbox, revision & cancel guards

`core/kernel/model/counters.ts` and all of `core/mailbox/`: the dedupe ledger
(65,536 entries / 15-minute horizon / never evict before the horizon / in-flight
promise sharing / `COMMAND_DEDUPE_CAPACITY` / `COMMAND_ID_EXPIRED` /
`COMMAND_ID_REUSE_MISMATCH`), the revision guard, the `turn.cancel` permissive
path (against an injected probe, so it needs no turn machine yet), the dispatch
pipeline against a stub guard/handler registry, the event bus (contiguous
per-transition publication, snapshot-on-subscribe, no replay buffer), and internal
signal ingress.

Tests: duplicates in flight and after completion return an identical result and
`operationId` with no extra transition/event/write; same id + different envelope
rejects; expired and capacity cases never execute; `eventSeq` strictly monotonic
while `stateRevision` changes only on authoritative transitions; the full cancel
matrix. All inside `context.start()`.

### 6C — Seven machines, guards, capability targets, projector

The seven `reatom*StateMachine` factories with trace roots `kernel.<domain>.*`,
every transition as a **named** model action, all 43 capability target extractors,
one pure guard per family, the projector calling the *same* guards,
`kernel.capabilitiesChanged` diffing, the §10.4 turn-time matrix, and
`core/versions/model/deferred-guards.ts` (decision D1's single home).

Tests: KCC §13.1 in full — every listed state/action pair asserts target, revision
delta, event kinds and changed capabilities; every unlisted pair asserts the exact
rejection code with no state/revision change and no domain event; same-state legal
actions are classified revision-changing vs explicit no-op; trust refusal ends at
`ready`/`untrusted-read-only`; each intended journal takes its `idle → recovering`
edge; Export and Migration allow `publishing → failBeforeIntent → idle` only with
journal proof of no intent. Plus §13.2 capability/guard parity property tests and
target snapshot tests that reject user text, acknowledgements, raw input,
dimensions, coordinates, fractions, and page-order permutations. Trace names
asserted on every unit.

### 6D — Ports ring, fakes, and adapter facades

Every file under `core/ports/`; the verbatim `agent/types.ts` lift; the narrow
store ports per C1; `ProjectWriteCoordinator`; gate, preview, host-supervisor and
export-render ports; `GitHistory`/`GitCommitter` declared only. **Plus the upstream
work that closes B1–B4**: `store` gains `writeMutex` on `OpenProject`, named
`TransactionEngine` domain methods, `publishExport`, candidate and
workspace-retirement exposure, and the session-checkpoint facade; `host` composes
`PreviewSession` on top of the supervisor, wires `control-queue`/`control-mailbox`
into the live path, and gains the geometry query. In-memory fakes for every port so
6E–6G are testable with zero real I/O. The TD §19 → KCC §11.2 failure-mapping table.

This is where C2's "adapters import nothing" claim either holds or is formally
amended — decide and document before writing code.

### 6E — Project lifecycle, startup, trust, project mutations

TD §12 startup ordering end to end: lease → SafeProjectFs → journal format →
`recoverTransactions` → recovery routing → migrations gate → schema validation →
the orphan-turn scan (TD §7.7's full seven-row table including `chat_corrupt`) →
manifest/pages/chats/pins/export-pointer validation → Workspace open, or the
broken-source open path. Trust: subject build, prompt routing,
`untrusted-read-only` enforcement, implicit grant on create. Page mutations and the
`PageRemovePlanV1` lifecycle. Chats. `model.select`. `selection.set/clear`.
`pin.setStatus`. `page.descriptorsChanged` assembly.

May split into 6E1 (startup + trust + recovery routing) and 6E2 (mutations) if
oversized.

### 6F — Turn orchestration, end to end

`turn.start` → admission → attempts 1–4 with a fresh `leaseNonce` each → fence
accept/drop → the 120 s silence watchdog plus the **non-resettable** absolute
deadline → progress emission → confirmed process-tree exit → fence retirement,
*then* candidate freeze → manifest-slice Gate once, then per-page Gate → retry with
Gate errors and determinism warnings folded into the prompt → mutex → deadline
recheck → CAS → `finalizeTurn` (or `terminalizeTurn`) → pin resolution filtered to
non-empty `changedPages` → settle. Session resume-or-fresh plus checkpoint advance.
The `backend-unhealthy` path and workspace quarantine.

Tests: the full fence mismatch matrix; cancellation never reaches `idle` before
confirmed exit; the deadline cannot be reset by event noise, retries, or session
fallback; exactly 3 retries then `GATE_RETRY_EXHAUSTED`; CAS produces
`APPLY_SOURCE_CHANGED` with `part:"page"|"manifest"` and `APPLY_STALE` with
`part:"chat"|"pins"`; pin resolution resolves none on an empty diff. All against 6D
fakes — no real process, no real disk.

### 6G — Preview session, frame broker, token chain, export

Preview machine wired to the composed `PreviewSession`; the capacity-1 latest-wins
frame broker; the `FrameTokenV1` ledger plus display-acknowledgement protocol; the
`GeometryTokenV1` ledger (4,096 entries / 30 s, consumed once); backpressure at
256/128; `preview.circuitOpened` exactly once; `SupervisorEvent` → Kernel events;
`pin.create`. Export: refusal ordering, the short-permit snapshot, the size ladder,
the bounded pool and render cache, package assembly, and
`ExportPublishTransaction`.

Splits if B1 is not cleared in time: 6G1 preview + broker + backpressure +
`pin.setStatus`; 6G2 export; 6G3 geometry tokens + `pin.create`.

## 5. Known divergences to document in code, not hide

- `layout/<page>.json` in the export package ships **unpopulated** — the
  conformant correlated capture awaits the 2A bulk schema. Must be a code comment.
- `OneShotResult.frame` remains the non-conformant MVP stand-in.
- `rendererVersion` (a render-cache key component per POS §5) is defined nowhere
  and must be introduced by this phase.
- `PinDtoV1` needs `createdRecordId`, `latestRecordId`, `updatedAt`, which
  `entities/pin`'s `foldPins` does not carry — either the Kernel folds record ids
  itself or `entities/pin` extends `Pin`.
- Controller-crash cleanup of an agent process tree is an open, non-gating gap
  (TD §6.5, Spike I): `backend_unhealthy_unconfirmed_exit` is a genuinely
  reachable outcome and the Kernel surfaces it honestly.
- `MIGRATION_CHAIN` is empty by design, so the live migration path cannot be
  exercised against a real migration — only recovery routing and the too-new hard
  error.
- The operations-log allowlist and forbidden-field rules (POS §13) bind every
  diagnostic the Kernel emits today, even though `OperationsLog` itself is
  deferred: reasoning text, prompts, chat bodies, credentials, raw vendor session
  ids, tool arguments, stdout/stderr, and stack dumps never enter an event DTO.

## 6. Architecture-doc debt this phase must pay

Per CLAUDE.md's architecture-docs rule, in-phase: `tsconfig.json`'s "core and ui
stay reserved" comment; the `agent/types.ts`, `store/types.ts`,
`entities/turn/types.ts`, `gate/ports/smoke-renderer.ts` and
`host/supervisor/model/preview-session.ts` anchors; the whole "Kernel — no code
yet" section of `modules.md`; `code-structure.md`'s intro line, folder tree and
mermaid status; `overview.md` lines 34/37/39/64/67; and the recorded
`PreviewHandle`-vs-`PreviewSession` choice.
