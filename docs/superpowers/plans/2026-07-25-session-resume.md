# Same-Process Session Resume (WP-7) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the second and later `turn.start` dispatches of a live chat, inside one running
termcraft process, resume the backend's SDK session instead of always starting fresh — closing
phase-8 Task 20 / design §WP-7 within the limit that section states.

**Architecture:** Read the durable `workspaceIdentity` `turn.start` needs straight from
`manifest.projectId` (`ProjectStore.readManifest()` — an ALREADY-EXISTING port method, the same one
`core`'s own `runProjectReadySequence` already calls on every `project.open`/`project.create`). No
new persisted field, no `workspace.local.toml` schema change, no `core/ports` surface addition — see
"Amendment: why this plan does not persist `workspaceIdentity`" below for why the design's original
persist-into-`workspace.local.toml` route was dropped. Derive an opaque `sessionScopeId` through
`AgentBackend.sessionScope` at `turn.start`, and switch `core/kernel/model/handlers/turn.ts`'s
`baseTask.session` from an unconditional `sessionCheckpoint.selectSeed` call to the ALREADY-BUILT
`core/turns` function `evaluateSessionPlan` (admission-time resume/fresh decision) plus a NEW call to
`advanceSessionCheckpoint` after a committed turn (checkpoint write-back, which nothing in the tree
calls today). Both `evaluateSessionPlan` and `advanceSessionCheckpoint` are fully implemented and
unit-tested already (`src/core/turns/model/session-plan.ts`) — this plan's job is wiring them into
the live turn path, not building session-resume logic from scratch.

**Tech Stack:** TypeScript on Bun ≥1.3.14, `@reatom/core` ^1001.1.0, `errore` ^0.14.1. Tests:
`bun test`. Typecheck: `bun x tsc --noEmit`. (No TOML/Zod work: this plan touches no `store/toml`
schema — see the amendment below.)

## Global Constraints

Inherited verbatim from `docs/superpowers/plans/2026-07-25-mvp-phase-8.md`'s "Global Constraints"
section, itself inherited from `docs/superpowers/plans/2026-07-17-termcraft-mvp-roadmap.md`. Every
task below implicitly includes this section.

- **Bun** `>=1.3.14`. Tests run with `bun test`; typecheck with `bun x tsc --noEmit`.
- **errore is mandatory**: namespace import (`import * as errore from "errore"`), errors as values
  (`Error | T` unions), `createTaggedError` for domain errors, `.catch()`/`errore.try` only at
  boundaries, flat control flow, no `let`+try, `| null` for optional values, one-line
  `instanceof Error` early returns.
- **Reatom v1001 rules**: named atoms/computeds/actions everywhere; `wrap(...)` at every async
  boundary; `withAsync`/`withAsyncData` instead of manual flags; no identity setter actions.
- **Module DAG** (`docs/architecture/code-structure.md`): `core` imports only `entities/` and its
  own `ports/`; adapters implement core ports; the consumer declares the port. The forbidden-shapes
  table in code-structure.md §11 is review-blocking.
- **Module folder shape** (`CLAUDE.md`): `ui/`, `model/`, `types.ts`, `index.ts`; code always inside
  subfolders, never loose at module root; atomic single-purpose functions.
- **Imports**: cross-module imports use the `tsconfig.json` path aliases, never a relative path
  climbing out of the module. Never alias under `@termcraft/*`.
- **Honest values only**: a value with no source is an explicit documented placeholder or an honest
  empty, never a fabrication.
- **Language**: all code, comments, commit messages and documents in English.
- **Commits**: frequent, per task, `feat:`/`fix:`/`docs:`/`test:`/`refactor:`/`chore:` prefixes,
  each ending with the `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>` trailer.

---

## The limit this plan must respect

`deriveSessionScope` (`src/agent/session/model/session-scope.ts:26-32`) substitutes a per-process
`UNRESUMABLE_ACCOUNT` (minted once at module load, `session-scope.ts:13`) whenever `account` is
`null`. The Claude probe returns exactly `account: null` unconditionally, on every branch of
`classifyMessage` (`src/agent/claude/backend/model/probe.ts:97-115`, `account: null` at lines 106,
109, 112), because the installed `@anthropic-ai/claude-agent-sdk`'s `SDKSystemMessage` carries no
field that could honestly fill it — `probe.ts`'s own comment at lines 99-105 states this explicitly
("the installed SDK's `SDKSystemMessage` has no field that is one, so `null` ... is the honest
value, not a guess").

**Both citations were re-read against the current tree for this plan and are accurate — no line
drift, no behavior change since the design was written.**

Consequence: for the Claude backend, `UNRESUMABLE_ACCOUNT` is a *different* random value every time
the termcraft process starts, so `sessionScope`'s output differs across restarts no matter what
`workspaceIdentity`/`model` are. **Cross-restart resume is therefore structurally unreachable for
Claude, and this plan does not attempt it.** What this plan delivers is resume within one process:
the second and later `turn.start` dispatches of a live chat, in the same running termcraft.

---

## Amendment: why this plan does not persist `workspaceIdentity`

This plan was first drafted following design §WP-7's literal instruction: persist a durable
`workspaceIdentity` into `workspace.local.toml` (via the generic `setWorkspaceLocal` patch), thread
it through `core/ports/project-store.ts`'s `WorkspaceStateV1`, and write it from the
`project.create`/`project.setTrust` handlers. That route rested on §WP-7's own claim:
"`workspaceIdentity` exists only as a payload fact on `project.create` and `project.setTrust`
... while the ordinary relaunch path is `project.open`, where `core` never sees it."

**That claim is false, and re-reading the tree proves it directly:**

- `runProjectReadySequence` (`src/core/kernel/model/handlers/project.ts:501-610`) — the shared
  post-admission sequence for BOTH `project.create` and `project.open`, not just `create` — does
  `const manifest = await wrap(deps.projectStore.readManifest())` at its own top (`:507`).
- `:531` uses `manifest.projectId` to resolve trust (`resolveTrust(context, manifest.projectId,
  trustSource)`); `:595` uses it again as `kernel.project.finishOpen`'s own event metadata
  (`projectId: manifest.projectId`). Both run on `project.open` exactly as much as on
  `project.create` — `runProjectReadySequence` is one function, shared by both callers.
- `src/entrypoint/model/create-shell.ts`'s `resolveEnvWithProjectIdentity` (lines 354-367) sets
  `UiEnv.workspaceIdentity = manifest.projectId` on **every** shell construction — fresh create and
  ordinary reopen alike — and its own doc comment already states why a durable `projectId` is the
  right "workspace identity": "a rename/move would otherwise silently change it," and cites
  `deriveSessionScope` folding it into the SDK resume key as the reason that matters.

So `core` already has honest, current access to `manifest.projectId` on every launch, through a port
method (`ProjectStore.readManifest()`) that already exists and is already called on this exact path.
Persisting a second copy into `workspace.local.toml` would only create a value able to drift from
the manifest that already holds it authoritatively — a fabricated risk the "honest values only"
global constraint is precisely meant to avoid.

**Consequences for this plan, all reflected in the tasks below:**

1. **The original Tasks 1-3 (TOML schema field, `WorkspaceStateV1` port field, persistence at
   `project.create`/`project.setTrust`) are dropped, not deferred.** They are unneeded: there is
   nothing to add to `store/toml/types.ts`, `core/ports/project-store.ts`, or
   `core/kernel/model/handlers/project.ts`. What remains is one task: read
   `manifest.projectId` at `turn.start` and use it. That is this plan's new Task 1.
2. **The open question the original plan recorded — "old projects never get a `workspaceIdentity`
   backfill, because only `project.create`/`setTrust` write it" — disappears entirely.** There is
   nothing to backfill: `ProjectManifestV1.projectId` (`core/ports/project-store.ts:39`) is a
   required field of every project's manifest, present since the project was created. It is never
   `null`, never absent, never something only NEW projects have.
3. **No new hazard is introduced.** `deriveSessionScope` folds `account` into the scope hash
   alongside `workspaceIdentity` (`session-scope.ts:28`); for Claude, `account` is always the
   per-process `UNRESUMABLE_ACCOUNT` (see "The limit this plan must respect" above), so two
   machines holding a copy of the same project can never collide on a scope key regardless of where
   `workspaceIdentity` is read from. Even for a future backend with a real, portable account
   discriminator, the session checkpoint itself (`SessionCheckpointV1`) still lives in
   `workspace.local.toml` — machine-local, hard-excluded from Git (storage-identity §6.1) — so a
   scope-key match with no local checkpoint on that machine still yields an honest "fresh," never a
   stale cross-machine resume. The machine-local-vs-portable argument the design originally made is
   real, but it argues for keeping the *checkpoint* machine-local (already true, unaffected by this
   amendment), not for a second, machine-local COPY of an identity the portable manifest already
   carries.

`docs/superpowers/specs/2026-07-25-mvp-phase-8-design.md` §WP-7 carries the matching amendment,
recorded the same way that document already amends master spec §4.1: the original reasoning stays
in place, and a dated amendment block follows it rather than silently rewriting it.

---

## Investigation findings (read before executing any task)

Every later task cites back to these. Findings 1, 3, and 4 are unchanged from this plan's first
draft (re-verified against the current tree while writing this amendment — turn.ts's own line
numbers had drifted again since then, see finding 1). Finding 2 is rewritten to match the amendment
above. The original finding 5 (`setWorkspaceLocal` patch mechanics) is removed: nothing in this plan
touches `workspace.local.toml` anymore, so there is nothing left for it to describe.

**1. The current header gap paragraph, real location.** `turn.ts`'s line numbers keep moving —
this plan is being amended while three other agents land unrelated changes in the same phase, and
the numbers below are freshly re-verified, not copied from the plan's first draft. The paragraph
describing `baseTask.session`'s divergence is currently at
**`src/core/kernel/model/handlers/turn.ts:182-193`**, inside the function-level doc comment above
`runTurnStart`. It says `baseTask.session` is ALWAYS `{kind: "fresh", seed}`, explains the same
`workspaceIdentity`-has-no-durable-source reason this plan closes, and cites "turn-durability §6.3
item 4" for where `workspaceIdentity` is defined. **That citation is wrong** — grep-confirmed:
`docs/superpowers/specs/2026-07-16-turn-durability-staging-design.md` has no §6.3 item list (its
§6.3 is "Backend cwd, confinement, and session continuation," prose, no numbered list); the
four-item numbered list ("1. backend implementation or account namespace; ... 4. backend workspace
identity") is in `docs/superpowers/specs/2026-07-16-production-storage-identity-design.md` §6.2.
Task 1 rewrites the paragraph and corrects the citation in the same edit. The runtime code today
(`src/core/kernel/model/handlers/turn.ts:693-699`) unconditionally calls
`context.deps.sessionCheckpoint.selectSeed(activeChatId)` and builds `{kind: "fresh", seed}` — it
never calls `AgentBackend.sessionScope` or `SessionCheckpointService.evaluateResume` at all.

**2. Where `workspaceIdentity` comes from, and how `turn.ts` obtains it.** See the amendment above
for the full correction. In short: `manifest.projectId` (`core/ports/project-store.ts:39`,
`ProjectManifestV1.projectId: string` — required, never null) is the value. `turn.ts` obtains it via
a **second, different call** to `context.deps.projectStore.readManifest()` — NOT by reusing its
existing `readManifestSnapshot()` call at line 619. Verified directly: `readManifestSnapshot()`
returns `FailureDtoV1 | ReadSetFileSnapshotV1`, and `ReadSetFileSnapshotV1`
(`core/ports/staging.ts:32-35`) is `{sha256: Sha256Hex, size: number}` — the raw hash+size of
`project.toml`'s bytes for the CAS read-set baseline, with no `projectId` field at all.
`readManifest()` (`core/ports/project-store.ts:120`) is the OTHER method on the same port — it
returns the parsed `ProjectManifestV1` DTO, which does carry `projectId`. Both methods already exist
on `ProjectStore`; no port addition is needed, only one more call from `turn.ts`, mirroring the
pattern `handlers/project.ts:507` already uses. `HandlerContext` (`handlers/types.ts:384-`) carries
no cached manifest or `projectId` a handler can read synchronously instead — `kernel.ts` does track
a `growableProjectId` (`kernel.ts:167`, fed by `kernel.project.finishOpen` event metadata) but it is
a private closure variable used only to build the outgoing `kernel.snapshot`/
`kernel.capabilitiesChanged` wire payloads (`kernel.ts:278`), never exposed on `HandlerContext` —
confirmed by reading that interface in full; it has no `projectId` member. So a fresh
`readManifest()` call inside `runTurnStart` is the only honest source, not a shortcut through
already-fetched state.

A `readManifest()` failure is a LOGGED, idempotent refusal — `console.warn(...); return [];` — in
the exact shape as the `readManifestSnapshot`/pin-fold refusals already in this function
(`turn.ts:620-624`, `:666-670`), never a fabricated identity. Unlike the abandoned
`workspaceIdentity === null` branch the plan's first draft needed (because a NOT-YET-PERSISTED field
was a genuine, expected, non-error state), there is no such soft-null case anymore: `readManifest()`
either succeeds — and `manifest.projectId` is always present, never null — or it fails, and the turn
refuses outright, matching how every other required read in this function already behaves.

**3. `AgentBackend.sessionScope`'s real signature, and `SessionCheckpointService` already exists —
in full.** `sessionScope(input: SessionScopeInput): string` is declared at
`src/core/ports/agent-backend.ts:170` (mirrored, pre-lift, in `src/agent/types.ts:142`).
`SessionScopeInput` (`agent-backend.ts:150-154`) is `{ account: string | null; model: string;
workspaceIdentity: string }`.

**The "checkpoint exists for that scope" lookup already exists — no port addition is required.**
`SessionCheckpointService` (`src/core/ports/session-checkpoint.ts:33-52`) has
`evaluateResume({chatId, sessionScopeId})`, `selectSeed(chatId)`, and
`advanceCheckpoint({chatId, sessionScopeId, sessionId})`. More than that:
`src/core/turns/model/session-plan.ts` already implements and exports (via `src/core/turns/
index.ts:84-86`) three fully-tested functions built directly on this port —
`evaluateSessionPlan(deps, {chatId, sessionScopeId})` (calls `evaluateResume`, and only calls
`selectSeed` when the verdict is "fresh"), `fallbackToFreshSession` (mid-turn SDK-rejection fallback
— see "Known softness"), and `advanceSessionCheckpoint`. **All three are grep-confirmed called from
nowhere except their own test file (`session-plan.test.ts`) — genuinely unwired into production.**
This is the single most consequential finding for this plan: the resume-decision logic does not need
to be built, only wired.

**4. Ordering: does turn 1 even write a resumable checkpoint today?** No.
`advanceSessionCheckpoint`/`advanceCheckpoint` (the `core/turns` function, and the underlying
`SessionCheckpointService.advanceCheckpoint`/`store` transaction method) are called from exactly
zero production call sites — grep confirms every hit is inside a test file
(`session-plan.test.ts`, `session-checkpoint.test.ts`, `fakes/session-checkpoint.test.ts`). **Turn 1
completing today durably commits pages/manifest/chat/pins, but never advances a session checkpoint
— so even if turn 2 asked "is there a checkpoint for this scope," the honest answer would always be
no.** Task 2 below is what makes turn 1 actually write one; without it, "two turns resume" is
unreachable no matter how correctly turn 2 reads. The `sessionId` needed for the write is available:
`TurnAttemptOutcomeV1`'s `"completed"` variant carries `sessionId: string`
(`src/core/turns/model/attempt.ts:64`), and `turn.ts`'s own `buildFinalizeInput` closure
(currently `turn.ts:752-799`) already receives that exact `attempt` object as an argument — it is
the same mechanism `finalizeSummary` (a `let` captured across the closure boundary,
currently `turn.ts:750`) already uses, so capturing `sessionId` the same way is a proven, in-file
pattern, not a new one.

---

## Task 1: Read `workspaceIdentity` from the manifest at `turn.start`, compute `sessionScopeId`, and resolve the real session plan

**Files:**
- Modify: `src/core/kernel/model/handlers/turn.ts`
- Test: `src/core/kernel/model/handlers/turn.test.ts`

**Interfaces:**
- Consumes: `ProjectStore.readManifest()` (existing port method — `core/ports/project-store.ts:120`
  — already called elsewhere, e.g. `handlers/project.ts:507`; not previously called from `turn.ts`),
  `AgentBackend.sessionScope` (existing port method), `evaluateSessionPlan` from `core/turns`
  (existing, unwired — finding 3).
- Produces: `AgentTask.session` genuinely resolved via the checkpoint, not unconditionally fresh; a
  `const sessionScopeId: string`, always populated past this task's manifest-read refusal, that
  Task 2 reads to advance the checkpoint after a committed turn.

- [ ] **Step 1: Write the failing tests**

Add to `src/core/kernel/model/handlers/turn.test.ts`. Build on the existing pattern at lines
560-627 (the pins-capture test) for fixture shape.

Test A — a checkpoint exists for the manifest-derived scope, so the turn resumes:

```ts
test("the manifest's projectId resolves session through sessionScope + evaluateSessionPlan, not the unconditional fresh path (WP-7)", async () => {
  const HOME = "home" as PageSlug;
  const chatStore = createFakeChatStore();
  const chatHeader = await chatStore.create();
  if ("code" in chatHeader) throw new Error("unexpected chat-create failure");

  const turnTransactions = withHonestChatAppendBase(createFakeTurnTransactionService(), chatStore);
  const pinStore = createFakePinStore();
  const staging = createFakeStagingService();
  const sessionCheckpoint = createFakeSessionCheckpointService();
  const agentBackend = createFakeAgentBackend({ capabilities: FAKE_BACKEND_CAPABILITIES });

  const scopeId = agentBackend.sessionScope({
    account: null,
    model: FAKE_BACKEND_CAPABILITIES.defaultSelection.model,
    workspaceIdentity: "ws-1",
  });
  await sessionCheckpoint.advanceCheckpoint({
    chatId: chatHeader.chatId,
    sessionScopeId: scopeId,
    sessionId: "prior-session",
  });

  const { handlerContext, getLaunchedOperations, getPublishedEvents } = buildTestContext({
    chatReader: chatStore,
    chatMutations: chatStore,
    turnTransactions,
    pinReader: pinStore,
    pinMutations: pinStore,
    staging,
    sessionCheckpoint,
    projectStore: createFakeProjectStore({
      root: "/test-root",
      manifest: { projectId: "ws-1" },
      workspaceState: {
        backend: "claude",
        model: FAKE_BACKEND_CAPABILITIES.defaultSelection.model,
        effort: "medium",
        activeChatId: chatHeader.chatId,
        activePageSlug: HOME,
      },
    }),
    agentRegistry: createFakeAgentRegistry([agentBackend]),
    gateRunner: createFakeGateRunner(),
  });

  turnHandlers["turn.start"]({ text: "continue" }, handlerContext);
  const [operation] = getLaunchedOperations();
  if (operation === undefined) throw new Error("expected exactly one launched operation");
  const runPromise = operation.run();

  async function waitForPublishedCount(kind: string, count: number): Promise<void> {
    for (let i = 0; i < 200; i++) {
      if (getPublishedEvents().filter((e) => e.kind === kind).length >= count) return;
      await wrap(Bun.sleep(0));
    }
    throw new Error(`waitForPublishedCount: never observed ${count} "${kind}" event(s)`);
  }
  await waitForPublishedCount("turn.attemptStarted", 1);

  const startCall = agentBackend.calls.find((c) => c.method === "startTurn");
  if (startCall?.method !== "startTurn") throw new Error("expected a startTurn call");
  expect(startCall.task.session).toEqual({
    kind: "resume",
    sessionId: "prior-session",
    promptDelta: null,
  });

  agentBackend.completeRun(startCall.fence, {
    kind: "completed",
    finalText: "done",
    usage: null,
    sessionId: "prior-session",
  });
  await runPromise;
});
```

Test B — the manifest read fails, so the turn refuses honestly instead of fabricating an identity
(replaces the first draft's "null `workspaceIdentity`" test — there is no reachable null-identity
state anymore, only a manifest-read success or failure; see finding 2):

```ts
test("a manifest-read failure refuses turn.start — logged, never a fabricated workspaceIdentity (WP-7)", async () => {
  const HOME = "home" as PageSlug;
  const chatStore = createFakeChatStore();
  const chatHeader = await chatStore.create();
  if ("code" in chatHeader) throw new Error("unexpected chat-create failure");
  const turnTransactions = withHonestChatAppendBase(createFakeTurnTransactionService(), chatStore);

  const agentBackend = createFakeAgentBackend({ capabilities: FAKE_BACKEND_CAPABILITIES });
  const projectStore = createFakeProjectStore({
    root: "/test-root",
    workspaceState: {
      backend: "claude",
      model: FAKE_BACKEND_CAPABILITIES.defaultSelection.model,
      effort: "medium",
      activeChatId: chatHeader.chatId,
      activePageSlug: HOME,
    },
  });
  projectStore.failNext("readManifest", {
    code: "PERSISTENCE_FAILED",
    retryable: false,
    safeMessage: "simulated manifest read failure",
    details: {},
  });

  const { handlerContext, getLaunchedOperations } = buildTestContext({
    chatReader: chatStore,
    chatMutations: chatStore,
    turnTransactions,
    pinReader: createFakePinStore(),
    pinMutations: createFakePinStore(),
    projectStore,
    agentRegistry: createFakeAgentRegistry([agentBackend]),
    gateRunner: createFakeGateRunner(),
  });

  turnHandlers["turn.start"]({ text: "hi" }, handlerContext);
  const [operation] = getLaunchedOperations();
  if (operation === undefined) throw new Error("expected exactly one launched operation");
  const events = await operation.run();

  expect(events).toEqual([]);
  expect(agentBackend.calls.some((c) => c.method === "startTurn")).toBe(false);
});
```

Both tests need `startCall.task` — see Step 2 below, which widens `FakeAgentBackend`'s call record
first (this test file cannot compile against the wider assertion until that fake is widened; do
that edit as part of this same step, since it is test-support code, not production code, and Test A
depends on it).

- [ ] **Step 2: Widen `FakeAgentBackend`'s call record to carry the task**

Edit `src/core/ports/fakes/agent-backend.ts`. Change the `"startTurn"` member of `AgentBackendCall`
(currently line 92):

```ts
export type AgentBackendCall =
  | { readonly method: "startTurn"; readonly fence: TurnFence; readonly task: AgentTask }
  | { readonly method: "cancel"; readonly fence: TurnFence }
  | { readonly method: "healthCheck" }
  | { readonly method: "capabilities" }
  | { readonly method: "sessionScope"; readonly input: SessionScopeInput };
```

Change `startTurn`'s push call (currently lines 145-146):

```ts
function startTurn(task: AgentTask): AgentRun {
  calls.push({ method: "startTurn", fence: task.fence, task });
  ...
```

- [ ] **Step 3: Run the new tests and watch them fail for the right reason**

Run: `bun test src/core/kernel/model/handlers/turn.test.ts src/core/ports/fakes/agent-backend.test.ts`
Expected: the fake's own test file still passes (an additive field on an existing call variant).
Test A fails because `startCall.task.session.kind` is `"fresh"` (the unconditional path), not
`"resume"`. Test B fails because today's `turn.ts` never calls `readManifest()` at all, so
`projectStore.failNext("readManifest", ...)` is never consumed and the turn proceeds normally
(`agentBackend.calls.some((c) => c.method === "startTurn")` is `true`, not the expected `false`).

- [ ] **Step 4: Rewrite the header paragraph and the implementation**

In `src/core/kernel/model/handlers/turn.ts`, replace the paragraph at (currently) lines 182-193
(starting "`baseTask.session: SessionPlan`: ALWAYS `{kind: "fresh", seed}`...") with:

```
 *   `baseTask.session: SessionPlan`: resolved via `evaluateSessionPlan` (`core/turns`) — phase-8
 *   WP-7, closing this file's own former "documented divergence" here. `workspaceIdentity` comes
 *   from `context.deps.projectStore.readManifest().projectId` — a SECOND call this handler now
 *   makes alongside its existing `readManifestSnapshot()` call just above (that one returns only
 *   `{sha256, size}`, `core/ports/staging.ts`'s `ReadSetFileSnapshotV1`, never the parsed DTO
 *   `projectId` lives on). A read failure is a LOGGED, idempotent refusal, in the exact shape as
 *   the `readManifestSnapshot`/pin-fold refusals elsewhere in this function — never a fabricated
 *   identity. `manifest.projectId` is the SAME value `core`'s own `runProjectReadySequence`
 *   (`handlers/project.ts:507,531,595`) already reads on every `project.open`/`project.create`,
 *   and the SAME value `entrypoint/model/create-shell.ts`'s `resolveEnvWithProjectIdentity`
 *   already threads into `UiEnv.workspaceIdentity` on every shell construction — so no new
 *   persisted field is needed (phase-8 WP-7's own design amendment: the original plan to persist
 *   a copy into `workspace.local.toml` was dropped once this direct read was confirmed to work on
 *   the SAME path `project.open` already takes; see the sub-plan's own "Amendment" section).
 *   `sessionScopeId` comes from `resolvedAgent.agentBackend.sessionScope({account: null, model,
 *   workspaceIdentity})` — `account` is a documented `null` literal, not a fresh `healthCheck()`
 *   call, because Claude's own probe (`agent/claude/backend/model/probe.ts`) returns
 *   `account: null` on EVERY branch today, so a fresh probe would report the identical `null` at
 *   the cost of one more round trip; wiring master §9's "checked ... before each send" health
 *   check into `turn.start` for real is a separate, larger gap this task does not close (see this
 *   plan's "Known softness"). **CROSS-RESTART RESUME REMAINS UNREACHABLE**: `deriveSessionScope`
 *   (`agent/session/model/session-scope.ts`) substitutes a fresh per-PROCESS
 *   `UNRESUMABLE_ACCOUNT` whenever `account` is `null`, which it always is for Claude — so
 *   `sessionScopeId` differs across every process restart regardless of `workspaceIdentity`, and
 *   `evaluateResume` honestly reports "fresh" every first turn of a new process. What resumes is
 *   the SECOND and later turn of the SAME process (storage-identity §6.2's own escape hatch: "a
 *   backend that cannot supply a stable account ... returns a fresh scope for each process, which
 *   safely disables cross-process resume for that backend").
```

Then, in the function body (`runTurnStart`), add a second manifest read right after the existing
`readManifestSnapshot` block (currently lines 619-625):

```ts
  const manifestSnapshot = await wrap(context.deps.projectStore.readManifestSnapshot());
  if ("code" in manifestSnapshot) {
    console.warn(
      `core/kernel/handlers/turn: turn.start refused — could not read project.toml's snapshot: ${manifestSnapshot.safeMessage}`,
    );
    return [];
  }

  const manifest = await wrap(context.deps.projectStore.readManifest());
  if ("code" in manifest) {
    console.warn(
      `core/kernel/handlers/turn: turn.start refused — could not read project.toml's manifest for its workspaceIdentity: ${manifest.safeMessage}`,
    );
    return [];
  }
```

Replace the unconditional `seedResult`/`sessionPlan` block (currently lines 693-699:
`const seedResult = await wrap(context.deps.sessionCheckpoint.selectSeed(activeChatId)); ...`) with:

```ts
  const sessionScopeId = resolvedAgent.agentBackend.sessionScope({
    account: null,
    model: resolvedAgent.model,
    workspaceIdentity: manifest.projectId,
  });
  const sessionPlan: SessionPlan = await (async () => {
    const plan = await wrap(
      evaluateSessionPlan(
        { sessionCheckpoint: context.deps.sessionCheckpoint },
        { chatId: activeChatId, sessionScopeId },
      ),
    );
    if ("code" in plan) {
      console.warn(
        `core/kernel/handlers/turn: turn.start's evaluateSessionPlan failed for chat "${activeChatId}" scope "${sessionScopeId}" — ${plan.safeMessage}; starting with an empty seed`,
      );
      return { kind: "fresh", seed: [] };
    }
    return plan;
  })();
```

Add `evaluateSessionPlan` to the existing `core/turns` value-import list at the top of the file
(alongside `createTurnDeadlines, foldGateDiagnosticsIntoPrompt, runTurn`); `SessionPlan` is already
imported as a type from `core/ports`.

`sessionScopeId` is declared a plain `const` — **not** `let`, unlike this plan's first draft. It no
longer needs to be nullable: past the `readManifest()` refusal above, `manifest.projectId` is always
a real string (never null, finding 2), so `sessionScopeId` is unconditionally built on every
reachable path through the rest of `runTurnStart`. Task 2's finalize closure captures it directly as
an ordinary closed-over `const`, the same way `admittedChatId` (line 606) is already captured — not
`finalizeSummary`'s `let` pattern two lines below it, which exists only because THAT value is
genuinely absent until a finalize actually runs.

- [ ] **Step 5: Run the tests**

Run: `bun test src/core/kernel/model/handlers/turn.test.ts`
Expected: PASS — both new tests, and the full pre-existing suite in the file. Every pre-existing
test that reaches this point in `runTurnStart` will now additionally exercise
`readManifest()`/`sessionScope()`/`evaluateSessionPlan()` on its default fakes (previously only
`selectSeed()` ran) — this is expected and does not change any test's OBSERVABLE session-plan output
(`createFakeProjectStore`'s default manifest always has a `projectId`; `evaluateSessionPlan` on a
`sessionCheckpoint` fake with no pre-seeded checkpoint honestly resolves to the same
`{kind: "fresh", seed: [...]}"` shape `selectSeed` alone used to produce directly). Grep-confirmed
before writing this step: no test in this file asserts an exact `agentBackend.calls` array (only
`.find`/`.some`/`.filter`), so the new `sessionScope` call these tests will now also record does not
break an exact-shape assertion anywhere in the file.

- [ ] **Step 6: Full kernel suite, typecheck**

Run: `bun test src/core/kernel && bun x tsc --noEmit`
Expected: 0 failures, exit 0.

- [ ] **Step 7: Commit**

```bash
rtk git add src/core/kernel src/core/ports
rtk git commit -m "feat(core): resolve turn.start's session plan from the manifest's workspaceIdentity"
```

---

## Task 2: Advance the session checkpoint after a committed turn

**Files:**
- Modify: `src/core/kernel/model/handlers/turn.ts`
- Test: `src/core/kernel/model/handlers/turn.test.ts`

**Interfaces:**
- Consumes: `advanceSessionCheckpoint` from `core/turns` (existing, unwired — finding 3/4),
  `TurnAttemptOutcomeV1`'s `sessionId` (existing field, finding 4), `sessionScopeId` from Task 1 (a
  plain `const`, always populated once this branch is reached).
- Produces: a durably-advanced checkpoint after every committed turn — the write half finding 4
  identified as missing. Without this task, Task 1's read half can never observe a checkpoint that
  exists, because nothing ever writes one.

- [ ] **Step 1: Write the failing test**

Add to `src/core/kernel/model/handlers/turn.test.ts`, reusing Task 1's Test A fixture shape almost
verbatim, but WITHOUT pre-seeding a checkpoint (so the first turn starts fresh, then completes, then
the test asserts the checkpoint now exists):

```ts
test("a committed turn advances the session checkpoint under the manifest-derived scope (WP-7)", async () => {
  const HOME = "home" as PageSlug;
  const chatStore = createFakeChatStore();
  const chatHeader = await chatStore.create();
  if ("code" in chatHeader) throw new Error("unexpected chat-create failure");
  const turnTransactions = withHonestChatAppendBase(createFakeTurnTransactionService(), chatStore);
  const sessionCheckpoint = createFakeSessionCheckpointService();
  const agentBackend = createFakeAgentBackend({ capabilities: FAKE_BACKEND_CAPABILITIES });

  const { handlerContext, getLaunchedOperations, getPublishedEvents } = buildTestContext({
    chatReader: chatStore,
    chatMutations: chatStore,
    turnTransactions,
    pinReader: createFakePinStore(),
    pinMutations: createFakePinStore(),
    staging: createFakeStagingService(),
    sessionCheckpoint,
    projectStore: createFakeProjectStore({
      root: "/test-root",
      manifest: { projectId: "ws-1" },
      workspaceState: {
        backend: "claude",
        model: FAKE_BACKEND_CAPABILITIES.defaultSelection.model,
        effort: "medium",
        activeChatId: chatHeader.chatId,
        activePageSlug: HOME,
      },
    }),
    agentRegistry: createFakeAgentRegistry([agentBackend]),
    gateRunner: createFakeGateRunner(),
  });

  turnHandlers["turn.start"]({ text: "first turn" }, handlerContext);
  const [operation] = getLaunchedOperations();
  if (operation === undefined) throw new Error("expected exactly one launched operation");
  const runPromise = operation.run();

  async function waitForPublishedCount(kind: string, count: number): Promise<void> {
    for (let i = 0; i < 200; i++) {
      if (getPublishedEvents().filter((e) => e.kind === kind).length >= count) return;
      await wrap(Bun.sleep(0));
    }
    throw new Error(`waitForPublishedCount: never observed ${count} "${kind}" event(s)`);
  }
  await waitForPublishedCount("turn.attemptStarted", 1);

  const startCall = agentBackend.calls.find((c) => c.method === "startTurn");
  if (startCall?.method !== "startTurn") throw new Error("expected a startTurn call");
  expect(startCall.task.session.kind).toBe("fresh"); // no prior checkpoint — honest first turn

  agentBackend.completeRun(startCall.fence, {
    kind: "completed",
    finalText: "done",
    usage: null,
    sessionId: "sess-first",
  });
  const events = await runPromise;
  expect(events[0]?.kind).toBe("turn.completed");

  const scopeId = agentBackend.sessionScope({
    account: null,
    model: FAKE_BACKEND_CAPABILITIES.defaultSelection.model,
    workspaceIdentity: "ws-1",
  });
  const verdict = await sessionCheckpoint.evaluateResume({
    chatId: chatHeader.chatId,
    sessionScopeId: scopeId,
  });
  expect(verdict).toMatchObject({ kind: "resume", sessionId: "sess-first" });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test src/core/kernel/model/handlers/turn.test.ts`
Expected: FAIL — `evaluateResume` reports `{kind: "fresh"}` after the turn completes, because
nothing wrote a checkpoint (finding 4).

- [ ] **Step 3: Capture `sessionId` in `buildFinalizeInput`, and advance on a committed result**

In `turn.ts`, add a captured variable alongside `finalizeSummary` (currently line 750):

```ts
  let finalizeSummary: FinalizeSummaryV1 | null = null;
  let capturedSessionId: string | null = null;
```

Inside the `buildFinalizeInput` closure (currently lines 752-799), at its very start (it already
destructures `{turnId, attempt, candidate, validation}` from its arguments):

```ts
  const buildFinalizeInput: RunTurnInputV1["buildFinalizeInput"] = ({
    turnId,
    attempt,
    candidate,
    validation,
  }): RunTurnFinalizeMaterialV1 => {
    capturedSessionId = attempt.sessionId;
    const changedPages: ChangedPageOpV1[] = [];
    ...
```

Inside the `if (result.kind === "finalized" && result.result.kind === "committed")` branch
(currently starting at line 899), BEFORE it builds the `turn.completed` event, add:

```ts
  if (result.kind === "finalized" && result.result.kind === "committed") {
    if (capturedSessionId !== null) {
      const advanced = await wrap(
        advanceSessionCheckpoint(
          { sessionCheckpoint: context.deps.sessionCheckpoint },
          { chatId: admittedChatId, sessionScopeId, sessionId: capturedSessionId },
        ),
      );
      if (advanced !== undefined) {
        // storage-identity §6.2: "Session checkpoint failure never changes chat history." The
        // turn already committed durably above — this is a non-fatal, logged best-effort step.
        console.warn(
          `core/kernel/handlers/turn: turn.start could not advance the session checkpoint for chat "${admittedChatId}" scope "${sessionScopeId}": ${advanced.safeMessage}`,
        );
      }
    }
    const summary: FinalizeSummaryV1 = finalizeSummary ?? { changedPages: [], gateWarnings: [] };
    return [
      {
        kind: "turn.completed",
        ...
```

Only ONE guard remains here (`capturedSessionId !== null`) — Task 1's first draft additionally
guarded on `sessionScopeId !== null`, which is now unnecessary: `sessionScopeId` is Task 1's plain
`const`, always populated by the time this branch runs (reaching a `"committed"` result requires
having gotten past Task 1's manifest-read refusal earlier in the same function). The remaining
`capturedSessionId !== null` guard is defensive, matching this project's "never assume success
blindly" convention: `buildFinalizeInput` is only guaranteed to have run at all if a finalize
attempt actually reached it.

Import `advanceSessionCheckpoint` from `core/turns` at the top of the file.

- [ ] **Step 4: Run the test**

Run: `bun test src/core/kernel/model/handlers/turn.test.ts`
Expected: PASS.

- [ ] **Step 5: Full kernel suite, typecheck**

Run: `bun test src/core/kernel && bun x tsc --noEmit`
Expected: 0 failures, exit 0.

- [ ] **Step 6: Commit**

```bash
rtk git add src/core/kernel
rtk git commit -m "feat(core): advance the session checkpoint after a committed turn"
```

---

## Task 3: Acceptance — two turns in one process resume; a scope change stays honestly fresh

**Files:**
- Test: `src/core/kernel/model/handlers/turn.test.ts`

**Interfaces:**
- Consumes: Tasks 1 and 2, composed together in one test that dispatches `turn.start` TWICE against
  the same `handlerContext`/fakes.
- Produces: this plan's primary acceptance oracle (Task 20 Step 2, first bullet).

- [ ] **Step 1: Write the two-turn acceptance test**

Add to `src/core/kernel/model/handlers/turn.test.ts`. This is the composed proof: turn 1 starts
fresh (no prior checkpoint) and completes; turn 2, dispatched against the SAME `handlerContext`
(same in-memory `sessionCheckpoint`/`projectStore`/`agentBackend` — i.e. the same "process"),
carries a resume plan built from turn 1's own `sessionId`.

```ts
test("acceptance (WP-7): the second turn.start in one process resumes the first turn's session", async () => {
  const HOME = "home" as PageSlug;
  const chatStore = createFakeChatStore();
  const chatHeader = await chatStore.create();
  if ("code" in chatHeader) throw new Error("unexpected chat-create failure");
  const turnTransactions = withHonestChatAppendBase(createFakeTurnTransactionService(), chatStore);
  const sessionCheckpoint = createFakeSessionCheckpointService();
  const agentBackend = createFakeAgentBackend({ capabilities: FAKE_BACKEND_CAPABILITIES });
  const projectStore = createFakeProjectStore({
    root: "/test-root",
    manifest: { projectId: "ws-1" },
    workspaceState: {
      backend: "claude",
      model: FAKE_BACKEND_CAPABILITIES.defaultSelection.model,
      effort: "medium",
      activeChatId: chatHeader.chatId,
      activePageSlug: HOME,
    },
  });

  const { handlerContext, getLaunchedOperations, getPublishedEvents } = buildTestContext({
    chatReader: chatStore,
    chatMutations: chatStore,
    turnTransactions,
    pinReader: createFakePinStore(),
    pinMutations: createFakePinStore(),
    staging: createFakeStagingService(),
    sessionCheckpoint,
    projectStore,
    agentRegistry: createFakeAgentRegistry([agentBackend]),
    gateRunner: createFakeGateRunner(),
  });

  async function runOneTurn(text: string, sessionId: string) {
    turnHandlers["turn.start"]({ text }, handlerContext);
    const launches = getLaunchedOperations();
    const operation = launches[launches.length - 1];
    if (operation === undefined) throw new Error("expected a launched operation");
    const runPromise = operation.run();

    for (let i = 0; i < 200; i++) {
      const call = agentBackend.calls.filter((c) => c.method === "startTurn").pop();
      if (call?.method === "startTurn") break;
      await wrap(Bun.sleep(0));
    }
    const startCall = agentBackend.calls.filter((c) => c.method === "startTurn").pop();
    if (startCall?.method !== "startTurn") throw new Error("expected a startTurn call");
    agentBackend.completeRun(startCall.fence, {
      kind: "completed",
      finalText: `done: ${text}`,
      usage: null,
      sessionId,
    });
    await runPromise;
    return startCall;
  }

  const firstStart = await runOneTurn("first message", "sess-1");
  expect(firstStart.task.session.kind).toBe("fresh");

  const secondStart = await runOneTurn("second message", "sess-2");
  expect(secondStart.task.session).toEqual({
    kind: "resume",
    sessionId: "sess-1",
    promptDelta: null,
  });
});

test("acceptance (WP-7): a scope change (simulating any of the 4 storage-identity §6.2 triggers, including a process restart) starts honestly fresh, never a stale resume", async () => {
  const HOME = "home" as PageSlug;
  const chatStore = createFakeChatStore();
  const chatHeader = await chatStore.create();
  if ("code" in chatHeader) throw new Error("unexpected chat-create failure");
  const turnTransactions = withHonestChatAppendBase(createFakeTurnTransactionService(), chatStore);
  const sessionCheckpoint = createFakeSessionCheckpointService();
  // A checkpoint under a DIFFERENT scope stands in for any of storage-identity §6.2's four
  // triggers (backend, account, model, or workspace identity changing) — including a process
  // restart's own `UNRESUMABLE_ACCOUNT` — without needing a real subprocess (that is Task 4's
  // job, at the mechanism's own layer).
  await sessionCheckpoint.advanceCheckpoint({
    chatId: chatHeader.chatId,
    sessionScopeId: "some-other-scope-entirely",
    sessionId: "stale-session",
  });

  const agentBackend = createFakeAgentBackend({ capabilities: FAKE_BACKEND_CAPABILITIES });
  const { handlerContext, getLaunchedOperations } = buildTestContext({
    chatReader: chatStore,
    chatMutations: chatStore,
    turnTransactions,
    pinReader: createFakePinStore(),
    pinMutations: createFakePinStore(),
    staging: createFakeStagingService(),
    sessionCheckpoint,
    projectStore: createFakeProjectStore({
      root: "/test-root",
      manifest: { projectId: "ws-1" },
      workspaceState: {
        backend: "claude",
        model: FAKE_BACKEND_CAPABILITIES.defaultSelection.model,
        effort: "medium",
        activeChatId: chatHeader.chatId,
        activePageSlug: HOME,
      },
    }),
    agentRegistry: createFakeAgentRegistry([agentBackend]),
    gateRunner: createFakeGateRunner(),
  });

  turnHandlers["turn.start"]({ text: "hi" }, handlerContext);
  const [operation] = getLaunchedOperations();
  if (operation === undefined) throw new Error("expected a launched operation");
  const runPromise = operation.run();
  for (let i = 0; i < 200; i++) {
    if (agentBackend.calls.some((c) => c.method === "startTurn")) break;
    await wrap(Bun.sleep(0));
  }
  const startCall = agentBackend.calls.find((c) => c.method === "startTurn");
  if (startCall?.method !== "startTurn") throw new Error("expected a startTurn call");
  expect(startCall.task.session.kind).toBe("fresh");

  agentBackend.completeRun(startCall.fence, {
    kind: "completed",
    finalText: "done",
    usage: null,
    sessionId: "s-new",
  });
  await runPromise;
});
```

- [ ] **Step 2: Run it and watch it pass**

Run: `bun test src/core/kernel/model/handlers/turn.test.ts`
Expected: PASS — both acceptance tests, if Tasks 1/2 are correctly wired. If either fails, do not
patch the test; re-examine Task 1/2's implementation, since this test's whole purpose is to prove
their COMPOSITION, not to be adjusted to match a wrong result.

- [ ] **Step 3: Full suite, typecheck, lint**

Run: `bun test && bun x tsc --noEmit`
Expected: 0 failures, exit 0.

- [ ] **Step 4: Commit**

```bash
rtk git add src/core/kernel
rtk git commit -m "test(core): acceptance — same-process turn.start resumes; scope changes stay fresh"
```

---

## Task 4: A genuine cross-process test that relaunch is honestly fresh

**Files:**
- Create: `src/agent/session/model/session-scope-process-fixture.ts`
- Modify: `src/agent/session/model/session-scope.test.ts`

**Interfaces:**
- Consumes: `deriveSessionScope` (existing, unchanged by this plan).
- Produces: the acceptance oracle for Task 20 Step 2's second bullet ("a relaunch: the next turn is
  honestly FRESH, and a test asserts that"), at the actual mechanism responsible for it —
  `UNRESUMABLE_ACCOUNT`'s per-process randomization — rather than at the kernel level, where Task
  3's "scope change" test only proves the Kernel reacts correctly to a DIFFERENT scope, not that a
  real process restart PRODUCES one. Unaffected by this plan's amendment: this task never sources
  `workspaceIdentity` from anywhere but a fixed literal, so nothing about the manifest-vs-TOML
  decision changes anything here.

- [ ] **Step 1: Write the failing test**

Add to `src/agent/session/model/session-scope.test.ts`:

```ts
test("a genuine process restart yields a different scope for otherwise-identical inputs (real subprocess, not simulated)", async () => {
  const fixture = new URL("./session-scope-process-fixture.ts", import.meta.url).pathname;
  const run = () =>
    new Response(Bun.spawn({ cmd: [process.execPath, fixture], stdout: "pipe" }).stdout).text();

  const [first, second] = await Promise.all([run(), run()]);
  // Sequential would also prove it; parallel additionally proves two processes launched
  // "at the same moment" (the adversarial case for any millisecond-based scheme) still diverge.
  expect(first.trim()).not.toBe(second.trim());
  expect(first.trim()).toMatch(/^[0-9a-f]{64}$/);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test src/agent/session/model/session-scope.test.ts`
Expected: FAIL — `session-scope-process-fixture.ts` does not exist yet (module resolution error).

- [ ] **Step 3: Write the fixture**

Create `src/agent/session/model/session-scope-process-fixture.ts`:

```ts
import { deriveSessionScope } from "./session-scope";

/**
 * Run as a standalone Bun process by `session-scope.test.ts`'s cross-process test — never
 * imported by production code. Prints one scope hash for fixed, non-account inputs so the
 * test can compare two independent process runs and prove `UNRESUMABLE_ACCOUNT`
 * (`session-scope.ts`'s own module-level constant) genuinely differs across real process
 * boundaries, not merely across two calls inside one test file.
 */
process.stdout.write(
  deriveSessionScope("claude", {
    account: null,
    model: "claude-sonnet-5",
    workspaceIdentity: "fixture-ws",
  }),
);
```

- [ ] **Step 4: Run the test**

Run: `bun test src/agent/session/model/session-scope.test.ts`
Expected: PASS, including every pre-existing test in the file (this task adds one test and one
fixture file; it changes no existing behavior).

- [ ] **Step 5: Full suite, typecheck**

Run: `bun test && bun x tsc --noEmit`
Expected: 0 failures, exit 0.

- [ ] **Step 6: Commit**

```bash
rtk git add src/agent/session
rtk git commit -m "test(agent): prove UNRESUMABLE_ACCOUNT genuinely differs across real process restarts"
```

---

## Task 5: Update the architecture docs this change makes false

**Files:**
- Modify: `docs/architecture/flows/generation-turn.md` (lines 67-69, 90, 107)

**Interfaces:**
- Consumes: nothing.
- Produces: an accurate flow document, per CLAUDE.md's "Architecture docs maintenance" rule.

- [ ] **Step 1: Rewrite the "honest still-open gaps" paragraph**

`generation-turn.md` lines 67-69 currently read: "the Kernel always starts a FRESH agent session (no
durable port sources a `workspaceIdentity` to resume against — `turn.ts`'s documented divergence)".
This is now false for the same-process case. Replace with:

```
the Kernel resumes a prior SDK session for the second and later turns of one live process (a
durable `workspaceIdentity`, read from the project manifest's `projectId` on every `turn.start` —
`ProjectStore.readManifest()`, the same manifest `core` already reads on every project open — now
feeds `AgentBackend.sessionScope`); cross-restart resume remains structurally unreachable for
Claude, because the backend's own account discriminator is always `null` and the fallback scope is
per-process-random by design (storage-identity §6.2's own escape hatch) — phase-8 WP-7;
```

Keep the rest of that paragraph's other four gaps (placeholder system prompt, generic
`turn.failed`, unwired type-check stage, un-garbage-collected turn workspace) unchanged — this task
touches only the session-resume clause.

- [ ] **Step 2: Rewrite step 2's mid-paragraph clause**

Line 90 contains: "The Kernel now makes that decision (`turn.start`) — and today always chooses
fresh (see step 11)." Replace with: "The Kernel now makes that decision (`turn.start`) and resumes
within one process once the current project's manifest supplies a `workspaceIdentity` (see step
11)."

- [ ] **Step 3: Rewrite step 11 in full**

Replace step 11's final two sentences (currently: "The Kernel now makes the decision — but always
chooses FRESH: `turn.start` seeds a bounded recent-chat excerpt via `sessionCheckpoint.selectSeed`
and never resumes, because building a `sessionScopeId` needs a durable `workspaceIdentity` that no
`core/ports` surface sources yet (`turn.ts`'s documented divergence). Resume against a prior SDK
session is therefore unreachable today, even though both halves of the checkpoint gate are built.")
with:

```
The Kernel now makes the decision for real: `turn.start` derives `sessionScopeId` via
`AgentBackend.sessionScope` once it has read a durable `workspaceIdentity` from the current
project's manifest (`ProjectStore.readManifest().projectId`, phase-8 WP-7 — the same manifest
`core` already reads on every project open, not a new persisted field), evaluates it through
`evaluateSessionPlan` (`core/turns`), and advances the checkpoint after every committed turn.
Resume therefore works for the second and later turns of one live process. It remains unreachable
across a process restart: Claude's own account discriminator is always `null`
(`agent/claude/backend/model/probe.ts`), so the scope's account component falls back to a value
random per process (`agent/session/model/session-scope.ts`'s `UNRESUMABLE_ACCOUNT`) — the exact,
deliberate escape hatch storage-identity §6.2 describes for a backend that cannot supply one.
```

- [ ] **Step 4: Run the architecture-update skill's own check**

Since this touches a `docs/architecture/` document tied to real source that just changed, follow
the architecture-update skill's verification: confirm every Source anchor this document cites for
the session-resume claim (`turn.ts`, `session-scope.ts`, `session-plan.ts`, and now `project.ts`
for the manifest-read parallel) still resolves to a real file at the stated path.

- [ ] **Step 5: Commit**

```bash
rtk git add docs/architecture
rtk git commit -m "docs(architecture): record same-process session resume in the generation-turn flow"
```

---

## Self-review notes

**Spec coverage.** Task 20 Step 1's required items, reinterpreted after the amendment above (the
persist-into-`workspace.local.toml` premise the brief's phrasing assumed does not hold — see
"Amendment: why this plan does not persist `workspaceIdentity`"): a source `turn.start` can read
`workspaceIdentity` from → Task 1, via `ProjectStore.readManifest().projectId`, the SAME field
`core`'s own `runProjectReadySequence` already reads on every `project.open`/`project.create`
(`handlers/project.ts:507,531,595`) — no `workspace.local.toml` schema change, no
`WorkspaceStateV1` field, no write from `project.create`/`project.setTrust` (the plan's original
Tasks 1-3 are dropped as unneeded, not merely deferred or reordered). Building `sessionScopeId`
through `AgentBackend.sessionScope` in `turn.ts` → Task 1. Planning `{kind: "resume"}` when a
checkpoint exists, `selectSeed` remaining the fresh fallback → Task 1 (via `evaluateSessionPlan`,
which already embeds exactly this fallback — finding 3, unchanged by the amendment). Task 20 Step
2's two acceptance bullets → Task 3 (same-process resume) and Task 4 (relaunch is honestly fresh,
tested at the mechanism responsible for it). The docs-must-say-so-plainly requirement → Task 5, and
this document's own "The limit this plan must respect" section, stated first.

**Known softness, stated rather than hidden.**

1. **`fallbackToFreshSession` stays unwired.** `core/turns/model/session-plan.ts`'s third function
   handles a resume the checkpoint judged legitimate being rejected MID-TURN by the backend's own
   SDK (storage-identity §6.2: "...or an SDK resume rejection is a mismatch"). Detecting that
   rejection requires the Claude adapter to distinguish "the SDK refused this resume" from an
   ordinary run failure in its own `AgentRunOutcome`/`TurnAttemptOutcomeV1` reporting — no such
   signal exists in the tree today (verified: `AgentRunOutcome`'s `"backend-error"` variant carries
   only a message string, no structured reason). Wiring it would mean widening that outcome type
   and `core/turns/model/attempt.ts`'s handling of it — real work, out of this plan's scope (the
   Task 20 brief's required scope names `selectSeed` as "the fresh fallback," which is the
   admission-time path this plan does wire, not the mid-turn one). A resume rejected by the SDK
   today surfaces as an ordinary backend error, terminalizing the turn — safe, but not the graceful
   fresh-retry storage-identity §6.2 envisions.
2. **`account` is a documented `null` literal at `turn.start`, not a fresh `healthCheck()` call.**
   Master spec §9 says the health check runs "at startup and before each send" — which would be the
   textually literal way to source `account` fresh for every turn — but no code path wires
   `healthCheck()` into `turn.start` today (grep-confirmed: only Home's WP-5 probe and the fake's
   own test call it). Since Claude's probe returns `account: null` on every branch unconditionally
   (probe.ts:97-115), a fresh call would report the identical value at the cost of a round trip;
   this plan uses the literal instead and flags full "healthCheck before every send" wiring as a
   separate, undocumented gap this task does not create or claim to close.

(The plan's first draft also recorded a third softness item — "old projects never get a
`workspaceIdentity` backfill, because only `project.create`/`setTrust` write it." That item is
REMOVED, not merely renumbered: it described a consequence of the abandoned TOML-persistence design
and does not exist under this amendment — see "Amendment" consequence 2 above. There is nothing to
backfill when the value is read fresh from a manifest field every project has always had.)

**Type/interface consistency checked:** `ProjectManifestV1.projectId`
(`core/ports/project-store.ts:39`, pre-existing, unchanged by this plan) → `manifest.projectId` read
inside `runTurnStart` (Task 1) → `SessionScopeInput.workspaceIdentity`
(`core/ports/agent-backend.ts:150-154`, pre-existing, unchanged). This plan feeds an already-existing
field with an already-existing value; it introduces no new field anywhere in `core/ports` or
`store/toml`, so — unlike the abandoned new-`workspaceIdentity`-field design this amendment replaces
— there is no rename/adapter chain to keep in sync at all.
