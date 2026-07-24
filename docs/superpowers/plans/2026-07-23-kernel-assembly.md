# Kernel Assembly Implementation Plan (WP-1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for
> tracking. Load `/reatom` and `/errore` before any code (CLAUDE.md mandate).

**Goal:** Assemble `createKernel(deps: KernelDeps): Kernel` — the composed core
that wires the seven state machines, the capability projector/guards, the event
bus with a full `kernel.snapshot`, the dedupe ledger, a handler registry for
every MVP command, the dispatch pipeline, and a composed turn driver — and close
the M21 event-DTO placeholders that block a real snapshot. Closes B1, B2, B6, M21, m6.

**Architecture:** Almost everything the Kernel needs already exists and is ready
to inject: the machines (`core/machines`), counters/bus/dedupe/dispatch
(`core/mailbox`), the capability projector/guards/target-table
(`core/capabilities`), the six turn functions (`core/turns`), the export model
(`core/export`), and the full port set + fakes (`core/ports`). The Kernel is
assembly: bind the mailbox `Dispatch`'s injected seams
(`extractTarget`/`evaluateGuard`/`readKernelState`/`handle`) to the real
capabilities functions and a handler registry, build `readKernelState` from the
seven machines' `phaseAtom`s, and compose the turn functions into a retry loop.
The whole graph is constructed inside one Reatom `context.start(...)` frame owned
by the Kernel.

**Tech Stack:** TypeScript 7.0.2 on Bun ≥1.3.14, `@reatom/core` ^1001.1.0,
`errore` ^0.14.1, `zod` ^4.4.3.

## Global Constraints

- `bun test`, `bun x tsc --noEmit`, `bun run fmt:check`, `bun run lint` all green
  at every task boundary. (`bun test` has pre-existing stderr noise from the
  type-check and agent process-tree suites — do not chase it, add none.)
- **errore mandatory**: namespace import, errors as values (`Error | T`),
  `createTaggedError` for domain errors, `.catch()`/`errore.try` only at
  uncontrolled boundaries, flat control flow, one-line `instanceof Error` early
  returns, always pass `cause`. NO `as unknown as` or any type-laundering cast —
  read the real declaration and use it; the user calls the cast heresy.
- **Reatom v1001**: named atoms/computeds/actions; `wrap(...)` at every async
  boundary; the dedupe ledger's map and the dispatch pipeline are NOT reatom
  atoms (a `context.start()` frame would isolate their state and break dedupe).
- **Module DAG**: `core` imports only `entities/` and its own submodules +
  `core/ports/`; never `store`/`gate`/`host`/`agent`. Within `core`, the
  existing import direction is `capabilities → protocol` — do not reverse it
  (Task 1 exists to keep it that way).
- **Do not duplicate.** Reuse the existing machines, mailbox pieces,
  capabilities functions, and turn functions — this package injects and composes
  them, it does not reimplement them.
- **Out of MVP scope** stays unbuilt: `git-history` and `git-committer` are NOT
  `KernelDeps` fields (no git command handler is registered; the capability
  projector reports git capabilities unavailable via the existing Tier-C
  deferred guard). Restore/commit/migration commands are Tier-C deferred: their
  handlers reject with the deferred capability reason, they do not drive their
  machines.
- Commits: frequent, per task, `feat:`/`fix:`/`refactor:`/`docs:` prefixed, each
  ending with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Use the
  `rtk` prefix for git.

---

## Reference map

A full structural map of `core/` was produced during planning and is the
authoritative source for every signature this plan names. Key anchors:

- Machines: `core/machines/model/*-machine.ts`, factory
  `createStateMachine` (`machines/model/state-machine.ts:72`), transition
  outcome `TransitionOutcome` (`state-machine.ts:39-47`).
- Mailbox: `createKernelCounters` (`kernel/model/counters.ts:51`),
  `createEventBus` (`mailbox/model/event-bus.ts:207`), `createDedupeLedger`
  (`mailbox/model/dedupe-ledger.ts:122`), `checkRevisionGuard`
  (`mailbox/model/revision-guard.ts:124`), `createSignalIngress`
  (`mailbox/model/signal-ingress.ts:92`), `createDispatch`
  (`mailbox/model/dispatch.ts:127`), seam types `mailbox/types.ts`.
- Capabilities: `extractCapabilityTarget` (`capabilities/model/target.ts:260`),
  `evaluateCapabilityGuard` (`capabilities/model/guards.ts:35`),
  `projectCapabilities`/`diffCapabilities` (`capabilities/model/projector.ts`),
  `KernelStateSnapshot` (`capabilities/types.ts:82-103`),
  `CapabilityTargetByKindV1` (`capabilities/model/target.ts:56-103`).
- Turns: `runAdmission` (`turns/model/admission.ts:107`), `startTurnAttempt`
  (`turns/model/attempt.ts:121`), `freezeTurnCandidate`
  (`turns/model/candidate.ts:150`), `runTurnValidation`
  (`turns/model/validation.ts:125`), `finalizeTurn` (`turns/model/finalize.ts:95`),
  `terminalizeTurn` (`turns/model/terminalize.ts:96`); helpers `createTurnFence`
  (`fence.ts:69`), `createTurnDeadlines` (`deadlines.ts:64`),
  `foldGateDiagnosticsIntoPrompt` (`prompt.ts:83`), session-plan
  (`turns/model/session-plan.ts`).
- Export: `publishExport` (`export/model/publish.ts:98`),
  `assembleExportPackage`/`package.ts:113` (the `{}` layout stub — NOT this
  package; M7 is WP-5), `buildExportPublishTransaction`
  (`store/transaction/model/wrappers.ts:1066`).
- Protocol placeholders (M21): `event-payload.ts` —
  `KernelModelsSnapshotV1Placeholder` (`:225-243`),
  `CapabilityEntryV1Placeholder.target` (`:185-195`),
  `KernelStateChangedPayloadV1` (`:137-151`), `PreviewGeometryResultPayloadV1`
  (`:1030-1037`), `GitStatusProjectionV1Placeholder` (`:205-217`, STAYS a
  placeholder). Union-count tests: `protocol/model/closure.test.ts`.
- Ports: `AssertConforms` (`ports/index.ts:189`), full fake set
  (`core/ports/fakes/`), UI-side `KernelPort` (`ui/kernel/types.ts:24-41`) and
  `createFakeKernel` (`ui/testing/model/fake-kernel.ts:55`).

---

## Task 1: Move the capability-target DTO to `core/protocol` (resolve the cycle)

M21 must give `CapabilityEntryV1Placeholder.target` its real type,
`CapabilityTargetByKindV1`. That type lives in `core/capabilities/model/target.ts`,
but `core/capabilities` already imports `core/protocol` (verified:
`capabilities/model/target.ts:7` imports `CommandKindV1` from `core/protocol`).
Having `protocol/event-payload.ts` import from `capabilities` would create a
`protocol → capabilities → protocol` cycle, and the event schema needs the
*runtime* Zod value for `target`, not just the type. Resolution: the target DTO
is fundamentally a protocol wire type (it appears inside `kernel.snapshot`), so
move the **type + its Zod schema** to `core/protocol`, and have `capabilities`
import them from there — matching the existing import direction.

**Files:**
- Modify: `src/core/protocol/model/` — add a `capability-target.ts` defining
  `CapabilityTargetByKindV1` (the 43-row map, verbatim from
  `capabilities/model/target.ts:56-103`) plus a `capabilityTargetByKindV1Schema`
  Zod value covering it. Export both from `src/core/protocol/index.ts`.
- Modify: `src/core/capabilities/model/target.ts` — delete the local
  `CapabilityTargetByKindV1` definition; import it from `core/protocol`. Keep
  `capabilityTargetExtractors` and `extractCapabilityTarget` here (they import
  the type from protocol now). `RecoveryTargetV1`/`GeometryQueryKindV1` move with
  the type if the type references them.
- Modify: `src/core/capabilities/index.ts` — re-export the type from its new
  home (or drop the re-export if nothing external depended on capabilities owning
  it; check first).
- Test: `src/core/protocol/model/capability-target.test.ts` — the schema parses
  every one of the 43 kinds' target shape and rejects a wrong shape.

**Interfaces:**
- Produces: `CapabilityTargetByKindV1` (moved to `core/protocol`),
  `capabilityTargetByKindV1Schema`.
- Consumes: nothing new.

- [ ] **Step 1:** Read `capabilities/model/target.ts:36-103` (the type, the
      `CapabilityId` proof, the 43-row `CapabilityTargetByKindV1`) and the
      companion types `RecoveryTargetV1`/`GeometryQueryKindV1`.
- [ ] **Step 2:** Write the failing schema test in
      `protocol/model/capability-target.test.ts`: import the (not-yet-moved)
      `capabilityTargetByKindV1Schema` and assert it parses a sample of each
      target shape (`null`, a page-slug target, a geometry-query target, etc.).
      Run `bun test src/core/protocol` — FAIL (module/export not found).
- [ ] **Step 3:** Create `protocol/model/capability-target.ts` with the moved
      type and a Zod schema; export from `protocol/index.ts`. Repoint
      `capabilities/model/target.ts` to import the type from `core/protocol`.
- [ ] **Step 4:** Run `bun test src/core/protocol src/core/capabilities` and
      `bun x tsc --noEmit` — PASS / exit 0. Confirm no import cycle:
      `capabilities → protocol` only.
- [ ] **Step 5:** `bun run fmt:check` + `bun run lint`; commit
      `refactor(core): move the capability-target DTO to protocol`.

---

## Task 2: Close the snapshot / state-changed / capability-entry placeholders (M21)

Replace the three `TODO(6C)` placeholders whose real types now exist. The seven
model DTOs become the machines' state shapes; the state-changed tags become the
machines' phase/action unions; the capability-entry target becomes Task 1's DTO.
Also add the agent-identity field the composer chip (M22) needs.

**Files:**
- Modify: `src/core/protocol/model/event-payload.ts`:
  - `KernelModelsSnapshotV1Placeholder` (`:225-243`) → `KernelModelsSnapshotV1`:
    seven fields typed as each machine's snapshot shape. Use the shapes from
    `KernelStateSnapshot` (`capabilities/types.ts:82-103`): `project: { phase:
    ProjectState; trust }`, `turn: { phase: TurnState; activeTurnId;
    commitIntentRecorded }`, `restore: { phase: RestoreState }`, `commit: {
    phase: CommitState }`, `export: { phase: ExportState }`, `preview: { phase:
    PreviewState; sourceKind }`, `migration: { phase: MigrationState }`. Import
    the phase unions from `core/machines`. Give each a Zod schema built from the
    machine's phase enum (`z.enum([...])` over the machine's exported states).
  - `CapabilityEntryV1Placeholder.target` (`:187`) → `CapabilityTargetByKindV1`
    from Task 1; `target` schema → `capabilityTargetByKindV1Schema`. Rename the
    interface to `CapabilityEntryV1`; likewise `CapabilityStateV1Placeholder` →
    `CapabilityStateV1` (it already mirrors `CapabilityState`).
  - `KernelStateChangedPayloadV1` (`:137-151`): `action`, `previousTag`,
    `nextTag` from free `z.string().min(1)` to closed unions. `previousTag` /
    `nextTag` = the union of all seven machines' phase types (a page in the
    snapshot already keys the model via `modelId`, so a flat union over all
    phases is acceptable; if you prefer a discriminated-by-`modelId` union, do
    that — state the choice). `action` = the union of all seven machines' action
    types. Build the schemas from the machines' exported action/state constants.
  - Add an **agent-identity** field to `KernelSnapshotPayloadV1` (M22): a
    `{ backendId: string; modelLabel: string } | null` (name it
    `AgentIdentityV1`), sourced from the selected `AgentRegistry` entry's
    `BackendCapabilities`. Null when no backend is selected. Add its schema.
- Modify: `src/core/protocol/index.ts` — export the renamed types and
  `AgentIdentityV1`.
- Modify/verify: `src/core/protocol/model/closure.test.ts` and any
  `event-payload` test — the union counts (`EVENT_KIND_COUNT === 43`) do not
  change (no new event kind), but the snapshot/state-changed schema tests must
  now assert the closed shapes parse and reject. Update deliberately.
- `GitStatusProjectionV1Placeholder` (`:205-217`) — **unchanged**, keep its TODO.

**Interfaces:**
- Produces: `KernelModelsSnapshotV1`, `CapabilityEntryV1`, `CapabilityStateV1`,
  the closed `KernelStateChangedPayloadV1`, `AgentIdentityV1`.
- Consumes: Task 1's `CapabilityTargetByKindV1`; the machines' exported
  phase/action unions.

- [ ] **Step 1:** Read `event-payload.ts:117-260` (the snapshot payload, the
      model-id constant, the state-changed payload, the capability entry) and the
      machines' exported state/action unions from `core/machines/index.ts`.
- [ ] **Step 2:** Write failing tests: the snapshot schema rejects a wrong-phase
      model and accepts a valid one; the state-changed schema rejects a tag
      outside the phase union; the capability entry schema uses the real target.
      Run `bun test src/core/protocol` — FAIL.
- [ ] **Step 3:** Replace the placeholders with the closed types + schemas; add
      `AgentIdentityV1`. Update `protocol/index.ts` exports.
- [ ] **Step 4:** Run `bun test src/core/protocol` + `bun x tsc --noEmit` — PASS.
      Fix any downstream consumer the rename touched.
- [ ] **Step 5:** fmt + lint; commit `feat(protocol): close the kernel snapshot
      and state-changed DTOs`.

---

## Task 3: Close the preview geometry-result DTO (M21)

`PreviewGeometryResultPayloadV1.result` (`event-payload.ts:1035`) and the port
twin `PreviewGeometryQueryResultV1.result` (`ports/preview-session.ts:78`) are
`Readonly<Record<string, unknown>>`. Close them to the union of the four §4.2
geometry queries: `checkHit`, `rectOf`, `describe`, `layoutTree`. The host's own
`GeometryQueryResult.result` (`host/supervisor/types.ts:144`) is also still
open — `core` closes its own DTO by value (the same "structural echo, not a type
import" precedent the protocol already uses for gate errors at
`event-payload.ts:422-431`), so this does not wait on the host.

**Files:**
- Modify: `src/core/protocol/model/event-payload.ts` — replace the geometry
  result placeholder with a discriminated union keyed by the geometry-query kind:
  `checkHit → { kind: "checkHit"; hit: { id: string } | null }`;
  `rectOf → { kind: "rectOf"; rect: { x; y; w; h } | null }`;
  `describe → { kind: "describe"; element: { id; kind; rect } | null }`;
  `layoutTree → { kind: "layoutTree"; tree: LayoutNodeV1 }` where `LayoutNodeV1`
  is a recursive `{ id?: string; kind: string; rect; children: readonly
  LayoutNodeV1[] }`. Take the exact field names from design §4.2 and the host's
  `layoutTreeOf` in `host/render/model/geometry.ts` (read it — do not invent
  field names; document any divergence). Add the Zod schema (a recursive schema
  via `z.lazy`).
- Modify: `src/core/ports/preview-session.ts` — the port's
  `PreviewGeometryQueryResultV1.result` takes the same closed union (import it
  from protocol).
- Test: extend `event-payload` tests — each of the four result variants parses;
  a wrong-kind field is rejected; the recursive tree parses at depth ≥ 2.

**Interfaces:**
- Produces: the closed `GeometryQueryResultV1` union + `LayoutNodeV1`.
- Consumes: nothing new.

- [ ] **Step 1:** Read design §4.2, `host/render/model/geometry.ts`'s
      `layoutTreeOf`, and the current placeholder. Fix the exact field names.
- [ ] **Step 2:** Write the four-variant + recursive-tree failing schema test.
      Run `bun test src/core/protocol` — FAIL.
- [ ] **Step 3:** Implement the union + `z.lazy` schema; repoint the port DTO.
- [ ] **Step 4:** `bun test src/core/protocol src/core/ports` + `tsc` — PASS.
- [ ] **Step 5:** fmt + lint; commit `feat(protocol): close the geometry-result DTO`.

---

## Task 4: The `export-publish` port + fake (B6, part 1)

The Kernel's export flow must actually write the publication. `store` already
has `buildExportPublishTransaction` (`store/transaction/model/wrappers.ts:1066`);
`core` needs a port wrapping it. Follow the shape of the existing ports and their
fakes exactly (read `core/ports/turn-transactions.ts` + its fake as the model).

**Files:**
- Create: `src/core/ports/export-publish.ts` — `ExportPublishPort` with
  `publish(plan): Promise<FailureDtoV1 | ExportPublicationV1>`, where the plan
  and result DTOs match what `publishExport` produces and what
  `buildExportPublishTransaction` consumes (read both; define `ExportPublishPlanV1`
  and `ExportPublicationV1` here). End with the port interface; adapters supply
  `AssertConforms` in WP-2.
- Create: `src/core/ports/fakes/export-publish.ts` — `createFakeExportPublish`:
  in-memory, records `calls`, programmable `failNext`, returns a synthetic
  `ExportPublicationV1`, ends with `AssertConforms<ExportPublishPort, ...>`.
- Modify: `src/core/ports/index.ts` and `src/core/ports/fakes/index.ts` — export
  both.
- Test: `src/core/ports/fakes/export-publish.test.ts` — the fake records the
  plan and returns/refuses per programming.

**Interfaces:**
- Produces: `ExportPublishPort`, `ExportPublishPlanV1`, `ExportPublicationV1`,
  `createFakeExportPublish`.

- [ ] **Step 1:** Read `publishExport` (`export/model/publish.ts:47-98`) — its
      `ExportPublicationIntentV1` — and `buildExportPublishTransaction`'s input.
- [ ] **Step 2:** Write the failing fake test. Run `bun test src/core/ports` — FAIL.
- [ ] **Step 3:** Create the port + fake; wire the barrels.
- [ ] **Step 4:** `bun test src/core/ports` + `tsc` — PASS.
- [ ] **Step 5:** fmt + lint; commit `feat(core): add the export-publish port`.

---

## Task 5: Wire `publishExport` to the port under the reacquired mutex (B6, part 2)

`publishExport` (`export/model/publish.ts:98`) currently builds the in-memory
intent and flips the state machine but never writes. Add the `ExportPublishPort`
to its deps and call it under the reacquired `ProjectWriteCoordinator` permit,
between building the intent and completing the machine transition.

**Files:**
- Modify: `src/core/export/model/publish.ts` — add `exportPublish:
  ExportPublishPort` to `PublishExportDeps`; after building the intent and while
  holding the reacquired permit, call `exportPublish.publish(plan)`; on a
  `FailureDtoV1` return `failed`/`stale` per the existing branches without
  completing; on success `complete` the machine and return `published{intent}`.
  Keep flat errore control flow; do not swallow the failure.
- Modify: `src/core/export/index.ts` — export any new plan/result type surfaced.
- Test: `src/core/export/model/publish.test.ts` — with a fake port that succeeds,
  the machine reaches `idle` and the port received the plan once; with a fake
  that fails, the machine does NOT complete and the failure is returned.

**Interfaces:**
- Consumes: Task 4's `ExportPublishPort`.

- [ ] **Step 1:** Read `publish.ts` fully; identify the permit-held region.
- [ ] **Step 2:** Write the failing "port is called under the permit, failure
      blocks completion" test. Run `bun test src/core/export` — FAIL.
- [ ] **Step 3:** Thread the port through; call it in the permit region.
- [ ] **Step 4:** `bun test src/core/export` + `tsc` — PASS.
- [ ] **Step 5:** fmt + lint; commit `fix(core): write the export publication
      through its port`.

---

## Task 6: The composed turn driver `runTurn` (B2)

Compose the six turn functions into the retry loop the spec requires: admission →
attempt loop (≤4 attempts, gate errors + determinism warnings folded into the
retry prompt) → candidate freeze → validation → `finalizeTurn` on pass /
`terminalizeTurn` on exhaustion, cancellation, or staleness. This is pure
composition over the existing functions — do not reach into a machine directly
except through the functions' own deps.

**Files:**
- Create: `src/core/turns/model/run-turn.ts` — `runTurn(deps: RunTurnDeps, input:
  RunTurnInputV1): Promise<RunTurnResultV1>`. `RunTurnDeps` aggregates the six
  functions' deps (the shared `machine`, `clock`, `pinReader`,
  `turnTransactions`, `staging`, `agentBackend`, `gateRunner`, `deadlines`, the
  `publish` callback) plus `foldGateDiagnosticsIntoPrompt`. The loop:
  1. `runAdmission` → on non-`admitted`, return.
  2. attempt = 1; loop while attempt ≤ 4:
     - `startTurnAttempt` → await its outcome; on `cancelled`/`failed`/
       `backend-unhealthy` → `terminalizeTurn` and return.
     - `freezeTurnCandidate` → on `illegal`/`failed` → `terminalizeTurn`.
     - `runTurnValidation` → `passed` → break to finalize; `retry` (attempt<4) →
       fold diagnostics into the next prompt, `attempt = nextAttempt`, continue;
       `exhausted` → `terminalizeTurn` and return.
  3. `finalizeTurn` → return `committed`/`failed`.
  Respect cancellation and staleness at each await (check the fence / deadline).
- Create: `src/core/turns/index.ts` — public entry exporting `runTurn`, the six
  functions, and the helper types the Kernel needs.
- Test: `src/core/turns/model/run-turn.test.ts` — drive it with the fakes:
  (a) happy path admit→attempt→freeze→validate-pass→finalize→committed;
  (b) one gate retry then pass (validation returns `retry` once, prompt fold
  observed, second attempt passes);
  (c) exhaustion after 4 failed validations → `terminalizeTurn` with
  `GATE_RETRY_EXHAUSTED`;
  (d) mid-attempt cancellation → `terminalizeTurn` with `cancelled`.

**Interfaces:**
- Produces: `runTurn`, `RunTurnDeps`, `RunTurnInputV1`, `RunTurnResultV1`;
  `core/turns` public entry.
- Consumes: the six turn functions and their helper types (from the map).

- [ ] **Step 1:** Read all six turn functions' signatures and result unions and
      `foldGateDiagnosticsIntoPrompt`. Enumerate every terminal branch.
- [ ] **Step 2:** Write failing test (a) — the happy path. Run
      `bun test src/core/turns` — FAIL (module not found).
- [ ] **Step 3:** Implement `runTurn`'s admission + single-attempt + finalize path.
- [ ] **Step 4:** Run (a) — PASS. Commit `feat(core): compose the turn driver`.
- [ ] **Step 5:** Add tests (b), (c), (d); implement the retry loop, exhaustion,
      and cancellation branches to green each. Commit after each is green.
- [ ] **Step 6:** Create `core/turns/index.ts`; `tsc` + fmt + lint;
      commit `feat(core): give core/turns a public entry`.

---

## Task 7: `KernelDeps` and `core/kernel/types.ts` (B1, part 1)

Declare the dependency surface `createKernel` consumes: one field per
`core/ports` contract the MVP command set uses, plus the `Clock` and the
`AgentRegistry`. Git ports are excluded (see Global Constraints).

**Files:**
- Create: `src/core/kernel/types.ts`:
  - `KernelDeps` — one field per port the MVP consumes: `projectStore`,
    `chatReader`, `chatMutations`, `pageReader`, `pageMutations`, `pinReader`,
    `pinMutations`, `turnTransactions`, `projectWrite`, `staging`, `trustGate`,
    `projections` (or the three caches), `sessionCheckpoint`, `recovery`,
    `gateRunner`, `hostSupervisor`, `exportRender`, `exportPublish` (Task 4),
    `agentRegistry`, plus `clock`. NO `gitHistory`/`gitCommitter`. Match each
    field's type to the port interface exactly (from the map).
  - `Kernel` — `{ dispatch(raw): Promise<CommandDecodeError | CanonicalHashError
    | CommandResultV1>; events: EventBus["subscribe"] shape (subscribe(handler):
    Error | (() => void)); currentPreview(): PreviewSession | null; close():
    Promise<void> }`. (The composition root adapts `Kernel` → the UI's
    `KernelPort` in WP-4; do not build that adapter here.)
- Create: `src/core/kernel/index.ts` (stub for now, filled in Task 10) — or defer
  its creation to Task 10. Prefer creating it in Task 10.

**Interfaces:**
- Produces: `KernelDeps`, `Kernel`.

- [ ] **Step 1:** From the map, list every port the MVP command set consumes and
      its exact interface type. Confirm none is a git port.
- [ ] **Step 2:** Write `kernel/types.ts` with `KernelDeps` and `Kernel`. There
      is no behavior to test yet; the gate is `tsc` — every field type resolves
      and matches its port.
- [ ] **Step 3:** `bun x tsc --noEmit` — exit 0. fmt + lint.
- [ ] **Step 4:** Commit `feat(core): declare KernelDeps and the Kernel interface`.

---

## Task 8: `createKernel` — assemble the graph (B1, part 2)

Compose everything inside one Reatom frame. This is the core of the package.

**Files:**
- Create: `src/core/kernel/model/kernel.ts` — `createKernel(deps: KernelDeps):
  Kernel`. Construction, in order, inside the Kernel's own `context.start(...)`
  frame:
  1. `createKernelCounters()`.
  2. The seven machines (`reatom*StateMachine()`), held so their `phaseAtom`s
     feed `readKernelState`.
  3. `readKernelState: () => KernelStateSnapshot` — read the seven `phaseAtom`s
     plus the Kernel-held `trust` / `activeTurnId` / `commitIntentRecorded` /
     preview `sourceKind`. This is the real value behind the mailbox
     `KernelStateSnapshot = unknown` seam; because `evaluateCapabilityGuard`'s
     signature already IS `(kind, target, state: KernelStateSnapshot) =>
     CapabilityState` and the mailbox seam is `unknown`, the assignment
     type-checks without a cast (the real function is narrower than the
     `unknown` seam — verify, do not cast).
  4. `extractTarget` — adapt `extractCapabilityTarget` into the mailbox
     `TargetExtractor` shape, handling its `CapabilityTargetExtractionError`
     return (a failed extraction dispatches as a rejection).
  5. `evaluateGuard = evaluateCapabilityGuard`.
  6. A `buildSnapshotPayload()` that assembles the full `kernel.snapshot`: the
     seven model DTOs (from `readKernelState`), the capabilities via
     `projectCapabilities`, the agent identity (from
     `agentRegistry.get(selected)?.capabilities()`), git status projection
     (the retained placeholder value), etc. — everything
     `KernelSnapshotPayloadV1` requires minus `eventSeq`.
  7. `createEventBus({ counters, buildSnapshotPayload })`.
  8. `createDedupeLedger({ clock: deps.clock })`.
  9. The handler registry (Task 9).
  10. `createDispatch({ counters, dedupeLedger, eventBus, cancelProbe,
      readKernelState, extractTarget, evaluateGuard, handle })`.
  11. `close()` — stop any live preview session, dispose the frame.
  Return `{ dispatch, events: eventBus.subscribe, currentPreview, close }`.
- Test: `src/core/kernel/model/kernel.test.ts` — construction succeeds; an
  immediate `subscribe` delivers one `kernel.snapshot` whose seven model DTOs
  carry the machines' initial phases and whose `stateRevision` starts at the
  counter's base.

**Interfaces:**
- Produces: `createKernel`.
- Consumes: everything from the map + Task 7 + Task 9.

- [ ] **Step 1:** Read `createDispatch`'s `DispatchDeps` and `createEventBus`'s
      `EventBusDeps` in full; confirm each seam's exact type.
- [ ] **Step 2:** Write the failing construction + snapshot test. Run
      `bun test src/core/kernel` — FAIL.
- [ ] **Step 3:** Implement construction through step 10 with a MINIMAL handler
      registry (Task 9 fills it); build `buildSnapshotPayload` and
      `readKernelState`.
- [ ] **Step 4:** Run the test — PASS. `tsc` + fmt + lint.
- [ ] **Step 5:** Commit `feat(core): assemble the kernel graph`.

---

## Task 9: The MVP command handler registry (B1, part 3)

The `handle: HandlerRegistry` seam that Task 8's dispatch calls. One handler per
`CommandKindV1` (43). Each returns a `HandlerOutcome` (`{ disposition, events,
operationId? }`). Group by family; wire each to its port(s) / model function per
the map's §9 command→port table.

**Files:**
- Create: `src/core/kernel/model/handlers/` — one file per command family
  (project, chat, page, pin, selection, turn, preview, export, model), each
  exporting the family's handlers; an `index.ts` assembling the full
  `HandlerRegistry`. Tier-C families (restore, commit, migration) and the git
  commands get a single deferred-rejection handler each (they reject with the
  Tier-C deferred capability reason — do not drive their machines).
- Test: one test file per family — each handler, driven with the fakes, produces
  the right disposition and events for a representative accepted command and a
  representative rejected one.

**Interfaces:**
- Produces: `createHandlerRegistry(deps, machines, kernelInternals):
  HandlerRegistry`.
- Consumes: the ports (via `KernelDeps`), the machines, `runTurn` (turn.start),
  the export model functions (export.start), the project startup functions
  (project.open/create), the page/pin model functions.

This task is large; split its commits by family. The turn.start handler composes
`runTurn` (Task 6); the export.start handler composes the export capture/render/
package/publish chain; project.open/create compose `core/project`'s
`open-sequence`. Selection/pin/page/chat/model are direct port calls.

- [ ] **Step 1:** From the map §9, write the command→handler→port table for all
      43 kinds. Confirm which are Tier-C deferred.
- [ ] **Step 2:** Per family, TDD: failing handler test → implement → green →
      commit `feat(core): handle <family> commands`. Start with the leaf
      families (chat, selection, pin, page, model), then project, then turn, then
      export.
- [ ] **Step 3:** Assemble `createHandlerRegistry`; wire it into `createKernel`
      (replace Task 8's minimal registry). Run `bun test src/core/kernel` — PASS.
- [ ] **Step 4:** `tsc` + fmt + lint; commit `feat(core): assemble the handler
      registry`.

---

## Task 10: Public entries — `core/index.ts`, `core/types.ts`, submodule indexes (B1, m6)

Give `core` the boundary the interface registry names, so `core/types.ts` stops
being a fiction (m6) and `ui` can import a real boundary.

**Files:**
- Create: `src/core/kernel/index.ts` — export `createKernel`, `KernelDeps`,
  `Kernel`.
- Create: `src/core/project/index.ts` — export the project startup surface
  (`open-sequence`, page-mutation, page-remove-plan functions + their types) the
  handler registry consumes.
- Create: `src/core/types.ts` — the module's shared boundary types: the
  Command/Result/Event DTO re-exports `ui` needs + `KernelDeps`. Match exactly
  what `ui` imports today (`core/protocol`, `core/mailbox`, `core/ports`) so the
  interface-registry `core/types.ts` row becomes real (m6).
- Create: `src/core/index.ts` — public entry: `createKernel`, the boundary
  types, and nothing else.
- Test: `src/core/index.test.ts` — the public surface exports `createKernel` and
  the named boundary types; nothing internal leaks.

- [ ] **Step 1:** List exactly what `ui` imports from `core/*` today
      (`grep -rn "from \"core"` under `src/ui`). Those are the boundary types
      `core/types.ts` must re-export.
- [ ] **Step 2:** Write the failing surface test. Run `bun test src/core` — FAIL.
- [ ] **Step 3:** Create the four index/types files.
- [ ] **Step 4:** `bun test src/core` + `tsc` — PASS. fmt + lint.
- [ ] **Step 5:** Commit `feat(core): give core a public entry and boundary types`.

---

## Task 11: The Kernel integration test (the WP-1 gate)

Drive `createKernel` with the full fake set through the §11 happy path, asserting
the emitted event sequence and `stateRevision` monotonicity. This is the gate the
whole package is judged against.

**Files:**
- Test: `src/core/kernel/model/kernel.integration.test.ts` — construct
  `createKernel(deps)` with every `KernelDeps` field a `core/ports/fakes` value
  (git ports excluded, as they are not fields). Subscribe, collect events, then
  dispatch a scripted command sequence: `project.open → chat.create → turn.start
  (fake backend edits staging, first gate returns a retry, second passes,
  finalize) → export.start → export publish`. Assert:
  - each command's `CommandResultV1` is `accepted` with the right disposition;
  - the event stream carries the expected kinds in order (snapshot on subscribe,
    then per-command transitions, `turn.gateRejected` once, `turn.committed`,
    `export.*`);
  - `stateRevision` is strictly monotonic across accepted mutations;
  - the export publish port received exactly one plan.

- [ ] **Step 1:** Assemble the full fake `KernelDeps`; program the fake backend
      to edit staging and the fake gate to return one retry then pass.
- [ ] **Step 2:** Write the integration test end to end. Run
      `bun test src/core/kernel` — expect it to exercise the whole chain.
- [ ] **Step 3:** Fix whatever assembly bugs it surfaces (this is where Task 8/9
      integration errors show up). Green.
- [ ] **Step 4:** `bun test src/core` (whole module) + `bun x tsc --noEmit` +
      fmt + lint — all green. Confirm no non-English comment under `src/core`.
- [ ] **Step 5:** Commit `test(core): drive the assembled kernel end to end`.

**Acceptance:** `bun test src/core` green; `bun x tsc --noEmit` exit 0; no file
under `src/core` contains a non-English comment; the integration test drives the
full happy path with the fake set.

---

## Architecture docs

The `docs/architecture/` documents describing the Kernel as unassembled must move
to "assembled" once this package lands — the composition-root and interface-
registry notes especially. Do the sweep at the end of the package with the
architecture-update skill; do not describe WP-2's adapter ring (not landed).

## Self-review notes (planner)

- Cycle risk (protocol↔capabilities) is resolved by Task 1 moving the target DTO
  to protocol. Every later task depends on Task 1.
- `KernelStateSnapshot` (capabilities) and the mailbox `unknown` seams are the
  join point: the real functions are narrower than the seams, so binding them
  needs no cast (Task 8 step 3 flags this explicitly — if a cast seems required,
  the wiring is wrong).
- M7 (the `{}` layout stub) and B6's write path both touch export, but M7 is
  WP-5, not here — this package only adds the publish PORT and its call site, not
  the real layout tree.
- The `Kernel` shape (`dispatch`/`events`/`currentPreview`/`close`) differs from
  the UI's `KernelPort` (`dispatch`/`subscribe`/`preview`); the adapter is WP-4,
  not here.
