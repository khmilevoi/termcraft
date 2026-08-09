# What still stands between this build and a working MVP

Compiled 2026-07-25 from a live end-to-end session on branch `phase-8`: a real project
(`examples/clock`) created from scratch, a real metered Claude CLI turn run against it, the
resulting page landing on disk, and the failures observed along the way.

**How to read the confidence tags.** They are not decoration — several claims in this session's
own history turned out wrong, and the tag is what separates a measurement from a story.

- **[verified]** — observed in a live run or reproduced by a test that fails without the fix.
- **[read]** — established by reading the code, not by running it.
- **[hypothesis]** — a plausible mechanism, explicitly not confirmed. Do not act on these
  without measuring first.

---

## 1. Blockers — the walkthrough cannot pass without these

### 1.1 Gap A — the preview panel can never render

**[verified]** The Workspace shows `preparing preview` forever, even after a fully successful
turn whose page passed the Gate and landed on disk.

`kernel.preview.enable` exists only as a state-machine action name
(`core/machines/model/preview-machine.ts`) and an event-payload string
(`core/protocol/model/event-payload.ts`). It is **not a command kind** — re-checked 2026-07-25,
`grep '"preview.enable"' src/core/protocol/` is still empty, so nothing can dispatch it. The
Preview machine therefore never leaves `disabled`, and every `preview.*` command — including the
`preview.selectPage`/`preview.selectCurrent` that would establish a session against a new page —
is rejected `OPERATION_BUSY` by the capability guard before its handler runs. Independently, no
code under `src/ui` dispatches those two commands (re-checked, zero hits outside tests).

**Consequences:** the central step of master §11 cannot succeed; right-click-to-pin is dead for
the same root cause (`preview.queryGeometry` is refused by the same guard); and the app's core
promise — describe a TUI, see it — is not deliverable.

**CORRECTED 2026-07-25 — this is not a redesign, and the paragraph that used to stand here was
wrong.** It said Gap A "needs a `preview.enable` command kind, a dispatcher, and a UI caller, and
someone has to decide *when* the shell enables preview. Treat it as a design decision." All four
claims fail on inspection.

**The contract already decides when.** kernel-command-contract §7.6's table, line 361:
`disabled` → `kernel.preview.enable` → `idle`, *"Requires trusted project and completed project
recovery."* Those are the exact two conditions `runProjectReadySequence` establishes. Enabling
preview is a Kernel-computed fact, not a user intent — so there is no command kind to add, no
dispatcher, and no decision left to make. The Kernel applies the transition itself once trust
resolves to `trusted`, and again when a later `project.setTrust` grants it. An untrusted project
correctly stays `disabled`, since preview executes design code.

**The session read-back exists.** `blockedBySessionReadback`
(`core/kernel/model/handlers/preview-export.ts:430`) justifies refusing `resize`,
`setThemeCapabilities`, `setMode`, `queryGeometry` and `retry` on the grounds that
"`HandlerContext` provides no way to read either back". That comment is stale:
`HandlerContext.currentPreviewSession: () => PreviewSession | null` is declared at
`core/kernel/model/handlers/types.ts:422` and wired to the real `activePreview` closure in
`kernel.ts`.

**The whole command surface is already implemented, composed, tested, and never called.**
`PreviewSessionCommands` (`core/preview/model/session-commands.ts:102-141`) exposes `selectPage`,
`selectCurrent`, `selectHistorical`, `resize`, `setMode`, `setThemeCapabilities`, `retry`,
`close`, `queryGeometry`, `publishFrame` and `acknowledgeDisplay` — every blocked kind and more.
`kernel.ts` composes it once over the real preview machine, the frame broker, both token ledgers
and the backpressure policy; it carries a 743-line test file; and no wired handler calls it. Its
own doc comment says exactly that ("NOT yet called by any currently-wired handler").
`preview-export.ts` drives `context.machines.preview` directly instead and lands on the stale
backstop above.

**So the real shape is three wirings:** apply `kernel.preview.enable` inside
`runProjectReadySequence` (and on a later trust grant) — **done, Task 8**; re-point
`preview-export.ts` at the already-composed `context.previewSessionCommands` instead of the
machine plus backstop — **mostly done, Task 10, see below**; and have the UI dispatch
`preview.selectPage` when the active page slug becomes known or changes — **not yet, Task 21**.

**CLOSED (mostly) 2026-07-26, Task 10.** `resize`, `setMode`, `setThemeCapabilities`,
`queryGeometry`, `retry` and `close` all now route through `context.previewSessionCommands` for
real; `blockedBySessionReadback` is deleted. `resolvePageSettings`'s `sourcePath` also moved from
the agent workspace's flat `pages/<slug>.tsx` to the same canonical
`<root>/.termcraft/pages/<slug>/page.tsx` convention Task 1 fixed on the turn path (the "Concern
raised before starting" this document used to link here) — without it, a session the router
DID establish would still have failed to mount in the host child. Two things did NOT close:

- `selectPage`/`selectCurrent`'s own ESTABLISHING call still does not route through
  `context.previewSessionCommands.selectPage`/`.selectCurrent` — it still calls
  `HostSupervisorPort.preview` directly. Reason: that router method never hands the established
  `PreviewSession` back to its caller, and `context.setActivePreviewSession` (which
  `KernelPort.currentPreview()` — the shell's real frame source, `entrypoint/model/
  create-shell.ts:412` — reads) needs the actual session object, not just an accepted/rejected/
  failed disposition. Routing the establishing call through the composed router as originally
  sketched would have left `activePreview` permanently `null` — no frame would ever reach the
  shell, defeating this whole task. Cost of the compromise: the establishing call alone does not
  reserve a backpressure slot the way `resize`/`setMode`/... now do. Closing it for real needs a
  session-returning variant of `selectPage`/`selectCurrent` on `PreviewSessionCommands`, or
  `kernel.ts` itself bridging the two — see `preview-export.ts`'s own header, "ONE NARROWER GAP
  TASK 10 FOUND".
- `retry` routes through the router for real but is REJECTED every time in this build. The
  router's own `retry()` reissues the last `HostSessionSpecV1` it remembers (`lastSpec`), and
  `lastSpec` is set ONLY by the router's own `selectPage`/`selectCurrent` — which, per the point
  above, `selectCurrentSource` does not call. So `lastSpec` is always `null`, and every retry
  lands on `session-commands.ts`'s own defensive "no remembered spec" branch. Not a regression
  (retry was a permanent no-op before Task 10 too), but the machine now genuinely transitions
  `circuit-open -> starting` before landing there and is left stranded — `preview-export.ts`'s
  `handleRetry` reports that one real transition rather than silently dropping it, but does not
  invent a fix for the underlying cause. Same closing move as the point above would fix this too.

**One remaining honest unknown, from before Task 10, still open.** `session-commands.ts`'s own
header records a NAMED GAP: `FrameIdentityV1.nonce` has no source in this slice's narrowed ports,
so the module mints a stand-in. That is a fidelity gap in frame identity, not a rendering
blocker, but it should not be discovered a third time.

### 1.2 Gap C — Enter on Home does not start the first turn

**[verified]** Type a description on Home, press Enter, and you land in a Workspace with an empty
chat, an empty composer, and nothing running. Nothing signals that the text was dropped.

The UI *does* send the text — `intent.ts`'s `home-submit` puts it in `project.create`'s payload —
but `handleProjectCreate` (`core/kernel/model/handlers/project.ts`) reads only
`payload.creationDefaults.trust` and never that field (re-checked 2026-07-25). Home's `prompt`
atom and the Workspace's `composer` atom are separate UI state with no carry-over
(`ui/app/model/deps.ts`).

**Required:** create → open Workspace → append the typed text as the first user message → start
the first turn, with no re-typing. The turn-admission spine already works; nothing below the
Kernel needs to change. Written up as **Gap C** in `docs/architecture/flows/launch.md`.

**Operator's words, verbatim:** *«это вообще не очевидно… при нажатии enter сразу должен
начинаться чат и запускаться генерация»*.

**Closed 2026-07-26 — fix-bundle Task 11 (Gap C, spec §3.1).** `runProjectReadySequence`
(`core/kernel/model/handlers/project.ts`) now reads `project.create`'s (and `project.open`'s)
`text` and chains `beginTurn` with it once the project reaches `ready` trusted — the same text
Home's Enter sent, with no re-typing and no second send from the Workspace composer. Proven
end to end (not just at the Kernel unit) by `entrypoint/model/smoke.test.ts`'s own §10
scripted-terminal smoke: one Enter on Home now reaches a real `turn.attemptStarted` carrying
that exact text, a real Gate pass, and a real page commit. Fix round 1 of that task's review
additionally closed the UI-visible half of the gap this write-up did not originally name: the
brief admission window (a store read, workspace staging, a durable user-record transaction —
hundreds of milliseconds or more) used to leave the mirror reporting `idle` and the composer
live, so a second Enter fired a silently-rejected `turn.start` and discarded whatever was typed
in that window; `ui/mirror/model/mirror.ts` now folds `kernel.turn.beginAdmission` into
`TurnMirror`'s `running` phase immediately, and `ui/app/model/intent.ts`'s `composer-submit`
only clears the composer once the Kernel actually accepts.

### 1.3 Gap D — an existing project still opens on Home

**[verified]** Relaunching termcraft in a directory that already holds a `.termcraft/` — chats,
history, canonical pages and all — lands on the empty Home prompt, not the Workspace. The
acceptance runbook's own step 9 states the opposite as the expected result ("termcraft reopens
straight into the Workspace (not Home) with the same chat history"), so this fails §11's
relaunch requirement as written.

**[read]** Nothing on the interactive path ever dispatches `project.open`. Outside tests, the
whole of `src` has exactly one caller — `entrypoint/model/run-export.ts`, the headless export
driver. The UI dispatches only `project.create`, from Home's Enter (`ui/app/model/intent.ts`).
`deriveScreen` (`ui/mirror/model/screen.ts`) returns `home` for `projectId === null`, and the
mirror learns `projectId` only from `kernel.project.finishOpen`'s metadata — an event only a
`project.*` open command produces. No dispatch → no `finishOpen` → `projectId` stays `null` →
Home forever, no matter what is on disk.

Everything below that missing dispatch is already built and unreachable: `projectOpen`
(`core/kernel/model/handlers/project.ts`) runs the same `runProjectReadySequence` as create —
transaction recovery, the orphan-turn scan, trust resolution honoring the prior durable grant,
per-page Gate descriptors — ending in `restoreActiveChatTail`, which publishes exactly the
`chat.changed` + `chat.records` pair that would paint the existing history. The relaunch
behavior `docs/architecture/flows/launch.md` describes in steps 3–4 is real code with no live
caller.

**Shape of the fix, and its one non-obvious trap.** The composition root already knows the
answer and throws it away: `openOrCreateProject` (`entrypoint/model/create-shell.ts`) tries
`store.openProject(root)` first and only falls back to `store.createProject(...)`, but returns
the same `OpenProject` either way. The UI cannot re-derive the distinction afterwards, because
by the time it mounts, `.termcraft/` exists on disk in *both* cases — the shell just created it.
So the open-vs-create discriminator has to be captured inside `openOrCreateProject` and carried
out on the shell (alongside `env`/`agentRegistry`): existing project → dispatch `project.open`
at startup and never paint Home; fresh directory → Home exactly as today.

Trust is not a complication here. An existing project opened on the machine that created it
resolves `trusted` and goes straight to the Workspace; a moved or copied workspace resolves
`untrusted-read-only` and lands on the read-only screen — which is the correct destination, and
still not Home.

**Interaction with Gap C.** Once both land, Home is reached only from a genuinely fresh
directory, and its Enter becomes the only entry into the first turn. One consequence worth
stating: a directory abandoned at Home today is *already* a created project on disk (with the
auto-minted first chat), so its next launch will open an empty Workspace rather than Home. That
is intended — the composer is the same input, one screen later.

**Operator's words, verbatim:** *«если в проекте уже есть чаты, то нужно сразу открывать
воркспейс а не home страницу»*.

**Amended 2026-07-25 — the predicate is pages, not chats.** The operator has since decided that
`chats/` becomes a hard-local, git-ignored class. That makes "has chats" the wrong test outright:
a freshly cloned project carries pages and **zero** chats, so keying the routing on chats would
send exactly the case that most needs the Workspace straight to Home.

Revised rule: open the Workspace when the project holds anything to view or edit — **at least one
page, or at least one chat** — and show Home only for a directory that is not a project yet, or is
one with nothing in it at all. Both signals are already available at open with no extra I/O:
`project.toml` carries the `pages` list the open sequence already reads, and chat presence comes
free with Gap E's listing. An empty just-created project falling back to Home is the right
outcome, not a compromise — it is functionally identical to a fresh directory, and Home is the
screen that knows how to start one.

**The gitignore change itself needs a spec amendment, not just a line.**
`PROJECT_GITIGNORE_RULES` (`store/toml/model/gitignore.ts:36-48`) currently has no `/chats/` row,
and that file is explicitly a courtesy mirror of storage-identity §13's hard-exclusion list — its
own header says correctness rests on `StoragePathPolicy`. The spec today classifies chats the
other way: *"portable chats, pages, pins, and exports while excluding every hard-local class"*
(`2026-07-16-production-storage-identity-design.md:878`, and again at `:889`). So chats move from
portable to hard-local, and the spec's own list has to move with them, or the two disagree on
what a commit scope contains. Flagging the conflict, not contesting the decision — chat logs
churn on every turn and can carry arbitrary user text, which is a sound reason to keep them out
of commits.

One thing this does **not** break, checked: `active_chat_id` lives in `workspace.local.toml`
(`store/toml/model/workspace-toml.ts:135`), which is already hard-local via `/workspace.local.toml`
and `*.local*`. A clone therefore carries no pointer to a chat file it does not have — no dangling
`activeChatId`, and no new path into Gap E's silent-empty-list failure.

**Closed 2026-07-26 — fix-bundle Task 12 (Gap D, spec §2.4).** `openOrCreateProject`
(`entrypoint/model/create-shell.ts`) now returns the discriminator it used to throw away, as
`existing: boolean` alongside the `OpenProject` handle; `probeProjectContent` folds that with one
manifest read and one `ChatStore.list()` (Gap E's own listing) into a three-way
`"has-content" | "no-content" | "unknown"` outcome, and `resolveShellLaunch` turns it into
`ShellLaunchV1 { existing, hasContent }` on the returned shell's `launch` field — evaluated BEFORE
the Kernel is constructed, since `deriveScreen` keys on `projectId`, which only a dispatched
`project.*` open command sets. `run-app.ts`'s `runApp` dispatches `project.open` itself, once,
after the shutdown path is wired up, whenever `shell.launch.hasContent` is true — the fix for the
"nothing on the interactive path ever dispatches `project.open`" root cause this write-up
diagnosed above. Home's own Enter (`ui/app/model/intent.ts`'s `home-submit`) now picks
`project.open` over `project.create` too, via `UiEnv.projectExists` (set from the same `existing`
fact in `resolveEnvWithProjectIdentity`) — the exists-but-empty branch this write-up already
called out as rare but real. Proven at the Kernel level (`core/kernel/model/handlers/
project.test.ts`'s "Gap D" describe block: the clone case reaches `ready` and publishes its pages
from `project.open` alone, with zero chats; an existing project with pages opens with no
`project.create` call anywhere; Home's Enter still creates-and-starts-a-turn in one keystroke for
a genuinely fresh directory) and at the composition-root/UI level (`create-shell.test.ts`,
`run-app.test.ts`, `intent.test.ts`).

**Fix round 1 (review).** Two Important findings on the first pass, both fixed:

1. The predicate substituted a definite `false` ("no content") for "the read failed" — a genuine
   instance of the Global Constraints' "never fabricate a fact" rule, which governs over the task
   brief's own `return false` snippet (the same override that landed in three earlier tasks of
   this bundle). `probeProjectContent` now returns `"has-content" | "no-content" | "unknown"`;
   `resolveShellLaunch` folds `"unknown"` into `hasContent: true` for an existing project, so the
   Kernel's own open sequence — not a silent Home — gets the chance to surface the real failure.
   The traced consequence (an existing project with chats and no pages, plus one transient
   `chats.list()` failure, landing on Home with an invisible `console.warn`) is now unreachable;
   the project's work was never actually at risk (`UiEnv.projectExists` stayed `true` regardless,
   so Enter still sent `project.open`), but the unrequested extra round trip is gone.
2. Home stays mounted for up to ~30s after the startup `project.open` is admitted (the Gate
   type-check the open sequence runs), and its prompt was still live the whole time; typing and
   hitting Enter fired a second, silently-rejected `project.open`
   (`CAPABILITY_UNAVAILABLE` — `beginOpen` is legal only `from: "closed"`) with no visible
   reaction and no clearing discipline of its own. `home-submit` now clears the prompt only once
   its OWN dispatch resolves accepted, never on a rejection — the identical treatment Task 11
   already gave `composer-submit` for the identical class of bug.

Also moved the startup dispatch to run AFTER `startShutdownPath` (a Ctrl-C during the open
sequence previously had no signal handler registered yet to catch it), and added the disk-backed
and unit-level coverage the predicate's chats branch and the two new failure branches had none of
before.

### 1.4 Gap E — the chat list shows one chat while three exist on disk

**[verified]** Operator, on a real project: *«выбор чатов в целом поломан. я не смог открыть чат
из списка. более того я вижу в файлах что чатов 3 но в диалоге только один»*. Both halves
reproduce from the code.

**[read] No port lists a project's chats.** `ChatReader` (`core/ports/chat-store.ts:60-91`)
exposes `open(chatId)` and `readAppendBase(chatId)` — both presume the caller already knows the
id. `store`'s own `ChatStore` (`store/types.ts:170-172`) has exactly one method, `open(chatId)`.
So `/chats` is not a view over the project; it is a view over whatever THIS process happened to
learn:

- `kernel.snapshot` resets the mirror's summaries to an empty `Map` (`ui/mirror/model/mirror.ts:157`);
- the only refill on relaunch is `restoreActiveChatTail`'s single event —
  `{ added: [], updated: [one summary] }` (`core/kernel/model/handlers/project.ts:487-492`);
- everything else accrues only from `chat.create`/`chat.switch` during the same run.

Three chats on disk, one row after a restart. Exactly as reported.

**The Kernel-side directory that would fix half of this is dead code.**
`core/chats/model/chat-directory.ts`'s `createChatDirectory()` is referenced only by its own
tests and the package `index.ts`; the live handlers build `chat.changed` inline and never touch
it. There is no accumulator in the Kernel at all — the UI mirror's `summaries` map is the only
chat registry in the running system.

**The unlisted chats are unreachable, by any means.** `chat.switch` is dispatched from exactly
one place, `ui/app/model/intent.ts:130-143`, and only for a summary already in the mirror
(`if (selected === undefined) return`). There is no hotkey — `chat-switch` exists only under the
`chat-list` overlay (`keymap.ts:142-148`) — no slash command taking an id, and no CLI argument:
`bootstrap.ts:54-60` reads only the project root from argv. A chat that is not in the list cannot
be opened at all.

**"I could not open a chat from the list" is a genuine silent no-op.** With one row, that row is
the already-active chat. Enter dispatches `chat.switch` for it and no guard rejects it — `chat.*`
has no family case in `capabilities/model/guards.ts`, so it falls to `default: return null` — and
`setActiveChat` is a pure local-state patch with no existence check, so the command is ACCEPTED.
The mirror then skips its scrollback reset because `activeChatId` did not change
(`mirror.ts:359`) and rewrites `records` with the same tail. Net effect: the popup closes, nothing
else happens. Worse in the empty-list case — `intent.ts:136`'s early return sits BEFORE
`local.overlay.set(null)` at `:141`, so Enter on an empty list does not even close the popup.

**And the list can be empty outright.** `restoreActiveChatTail` has four bail-out branches
publishing NEITHER event — `activeChatId === null`, plus `chatReader.open`, `handle.loadTail` and
`resolveChatDisplayName` failures (`project.ts:451`, `:453-459`, `:461-467`, `:469-479`) — each
only `console.warn`-ing, which in an interactive run goes nowhere (§3.1). The project still
finishes opening successfully, with zero chat summaries and an empty scrollback. The third branch
is the likeliest: `resolveChatDisplayName` walks `loadBefore` back to the very start of the chat
(`core/chats/model/records.ts:139-150`), so one bad page anywhere in a long history kills both the
summary and the records.

**Shape of the fix.** A chat-listing surface in `store`, exposed through `ChatReader`, called by
`runProjectReadySequence` to populate `added`. The material already exists and is already used:
`store/model/factory.ts:883-918`'s `scanOrphanTurns` already does `safeFs.list("chats")` and
decodes every header — it simply discards everything but its orphan-turn outcome.
`SafeProjectFs.list` is a public primitive (`store/safe-fs/types.ts:113`). This is wiring an
existing capability, not inventing a port.

**Two smaller fixes in the same popup.**

- **Remove the `· /new` footer hint** — operator's decision. It IS part of the design:
  `design/termcraft-engine.js:858-861`'s `wsChats` footer draws four hints — `↑↓ select`,
  `⏎ switch`, `/new fresh chat`, `esc close` — so this is a deliberate amendment, not a
  correction. It has an independent justification: `/new` cannot be typed from the open popup at
  all, because `resolveKey`'s `chat-list` branch (`keymap.ts:142-148`) returns `none` for every
  printable character. The hint advertises a command that surface cannot run. (The code also adds
  `· ` separators the design does not draw — cosmetic, worth aligning while there.)
- **The `WHEN` column renders a raw ISO timestamp.** `App.tsx:81` passes `when: summary.createdAt`
  straight through, so the column reads `2026-07-24T18:03:11.412Z` where the design shows relative
  time — `now`, `8m ago`, `yesterday` (`termcraft-engine.js:844-849`).

**Also worth knowing (updated 2026-07-26 — Gap D closed):** the relaunch integration test covering
this (`core/kernel/model/chat-relaunch.integration.test.ts`) drives `project.open` directly at the
Kernel. At the time this was written that command was one the interactive UI never dispatched at
all (Gap D); since Task 12 closed Gap D, `run-app.ts`'s startup dispatch now IS a real,
production `project.open` caller for a relaunch against a project holding content — the test's own
coverage gap (it still bypasses the composition root itself) is narrower than it was, though it
still does not exercise `run-app.ts`'s own dispatch wiring end to end.

### 1.5 Gap F — one rejected admission bricks the turn machine for the life of the process

**[verified]** The most severe item in this document, and the root behind the four
`activeTurnId is null` warnings the operator reported. From `termcraft-debug.jsonl`:

```
20:23:13.043  ui.dispatch.result  turn.start  accepted, resultingRevision "7", disposition "started"
20:23:13.164  kernel.turnStart    runTurn resolved   kind: "admission-rejected"
20:23:13.165  kernel.operation    run() resolved     eventCount: 0
20:32:23.775  ui.dispatch.result  turn.start  rejected, STALE_REVISION, requiredRevision "7"
20:38:41.413  console.warn        turn.phase is "admitting" (non-idle) but activeTurnId is null
```

Fifteen minutes and twenty-eight seconds separate the rejected admission from those warnings.
The turn machine did not pass through `admitting` — it stayed there. Throughout that window the
operator kept typing, and every `ui.onKey` entry records `turnRunning: false`. The application
never said anything was wrong.

**Root cause: `beginAdmission` has no failure edge.** `runAdmission`
(`core/turns/model/admission.ts:131`) applies `beginAdmission` — `idle → admitting` — BEFORE any
of the work that can fail: pin resolution, the durable user-record transaction, the append-base
read, the staging workspace build. Each of those can return `blocked`, and each returns without
an inverse transition. The table has none to offer: `admitting` has exactly two outgoing edges —
`finishAdmission` to `workspace-ready` (`core/machines/model/turn-machine.ts:93`) and
`requestCancel` to `terminalizing` (`:137`). No abort, no rollback, no path back to `idle`. The
handler does not compensate either: `turn.start`'s `admission-rejected` branch
(`core/kernel/model/handlers/turn.ts:1059-1064`) logs and returns an empty event list, leaving
the machine exactly where `runAdmission` abandoned it.

**The one escape is unreachable by construction.** `requestCancel` needs a turnId the Kernel does
not have. The id is minted INSIDE `runAdmission`, one line after the transition
(`admission.ts:134`), and reaches `activeTurnIdAtom` only when the first `turn.attemptStarted` is
observed (`handlers/turn.ts:996-998`) — an event a rejected admission never publishes. So
`activeTurnId` stays `null` and every route to cancellation closes:

- the cancel probe returns `null` and warns (`kernel.ts:198-205`), so the revision guard refuses
  `turn.cancel` with `TURN_NOT_ACTIVE` before the capability guard is even consulted
  (`core/mailbox/model/revision-guard.ts:154-157`);
- the `turn.cancel` capability is never published — `currentCapabilityRequests` gates it on
  `activeTurnId !== null` (`kernel.ts:340-343`);
- the UI never offers Esc: the mirror enters `running` only on `turn.started`
  (`ui/mirror/model/mirror.ts:230-232`), published after `setActiveTurnId`, so the status bar
  shows no `esc cancel`, the composer shows no `generating…`, and `applyEsc` resolves to
  `deselect`/`none`.

The state is permanent: `turn.start` refused, `turn.cancel` refused, and
`chat.create`/`export.start`/`page.reorder`/`model.select` turn-locked. Only restarting the
process clears it.

**Two compounding failures made it silent.**

1. **The revision desynchronised on the same dispatch.** `applyTransition` advances the revision
   before publishing (`core/mailbox/model/dispatch.ts:172-173`), but `turn.start` returns
   `startedOutcome([])` — zero events. The Kernel moved to revision 7; the UI mirror, which only
   advances on published events, stayed at 6. Nine minutes later the operator's next `turn.start`
   was rejected `STALE_REVISION, requiredRevision "7"` — a second, independent way the app was
   already unusable, visible in the log above.
2. **The one warning naming the cause never reached the terminal.** `handlers/turn.ts:1061` logs
   `turn.start's admission was rejected (<kind>)`. It is absent from the session log because
   OpenTUI's renderer replaces `global.console` for the duration of the render and restores it on
   teardown (in `@opentui/core`'s bundled renderer chunk — a build-hashed filename, so cite the
   behavior, not the path). The four warnings that DID land are the ones emitted after the
   renderer came down. This confirms §3.1's hypothesis and gives it a mechanism.

**We still do not know why the admission was rejected.** The trace records
`result.kind === "admission-rejected"` but never `result.outcome.kind`, so the actual blocking
reason — which port refused, and why — was not captured. Widening that one trace line is a
precondition for diagnosing the next occurrence.

**Answered 2026-07-26 — Gap G (§1.6); the deciding fact was in the returned value the whole time.**

**Why the suite is green.** Four tests assert this exact hang as the expected outcome:
`core/turns/model/admission.test.ts:221,234,261,275` each check `phase() === "admitting"` after a
`blocked` result. The one test exercising `turn.cancel` from `admitting`
(`core/kernel/model/handlers/turn.test.ts:1779-1781`) reaches that state by calling
`setActiveTurnId(TURN_ID)` by hand first — a state production can never construct — so it passes
while the real path cannot cancel at all. Nothing asserts the invariant the type's own comment
states (`core/capabilities/types.ts:93`: the active turn's id, or `null` exactly when
`phase === "idle"`); the only test touching it (`core/capabilities/model/turn-lock.test.ts:156-171`)
hand-builds the broken snapshot and asserts the degraded fallback.

**Shape of the fix**, in order of importance:

1. **Give the failure a transition.** `admitting` needs an edge back to a settled phase for a
   rejected admission — the table has to model the outcome that actually happens most often on a
   fresh project. The four admission tests pinning today's behavior get rewritten with it.
2. **Mint the turnId at the transition, not inside the work.** Have `turn.start` mint it and call
   `setActiveTurnId` in the same synchronous step as `beginAdmission`, passing it into
   `AdmissionInputV1`. The precedent is already here: `beginProjectOpen`
   (`handlers/project.ts:619-630`) mints its `operationId` right beside its own `tryApply`.
   `admission.ts` hardcodes `import { uuidv7 }` (`:16`) and has exactly one production caller
   (`core/turns/model/run-turn.ts:259`), so the change is contained. This closes the invariant
   break at the source instead of teaching each reader to tolerate it.
3. **Never return zero events from an accepted command.** A `turn.start` that advances the
   revision and publishes nothing desynchronises every subscriber by construction. The
   admission-rejected path needs a terminal event — the same user-facing failure surface §2.1 and
   §2.3 already ask for.

### 1.6 Gap G — a project with any page can never run another turn

**[verified]** Reproduced on demand 2026-07-26 with `scripts/probe-turn.ts` (a temporary headless
driver over the same `KernelPort` the TUI uses). Against `examples/clock` — three chats, one page
— `turn.start` is accepted and admission then fails:

```
phase: "workspace"
PERSISTENCE_FAILED: filesystem open failed for
  …/examples/clock/pages/time-dashboard.tsx (ENOENT)
```

Against a freshly created empty directory the identical driver runs a full turn — `turn.started`,
attempts, gate retries, the lot. The discriminator is page count, not project state.

**Root cause: one path helper used against two different namespaces.**
`core/kernel/model/handlers/turn.ts:782` builds each page's canonical source path as
`${context.deps.projectStore.root}/${pageFileRelPath(pageSlug)}`, and `pageFileRelPath`
(`:408-410`) returns `pages/<slug>.tsx` — the **agent workspace's** flat convention. Canonical
storage is `<root>/.termcraft/pages/<slug>/page.tsx`. The helper is correct where the same file
uses it against `candidate.root` (`:917`, `:926`, `:927` — paths inside the staged workspace) and
wrong at `:782`, where it is joined onto the project root.

`store/safe-fs/model/limits.ts:134-135` warns about exactly this confusion in prose: *"Canonical
page storage is `pages/<slug>/page.tsx` + `pages/<slug>/comments.jsonl` — deliberately NOT the
agent's flat `pages/<slug>.tsx` shape."*

**Why it reads as "the app worked once and then stopped."** `stageAllFiles`
(`store/sandbox/model/staging-store.ts:267`) only copies pages when `pages.length > 0`. A brand-new
project has none, so the first turn admits cleanly and produces a page. Every turn after that has
one, hits the bad path, and dies in admission — which then strands the turn machine permanently
via Gap F, with no user-visible signal. This single defect plus Gap F accounts for the whole
observed session: one good turn, then an app that silently refuses everything.

**Severity.** This is the most impactful item in the document. It makes §11's walkthrough
unreachable past its own first turn, and it is a two-line fix: resolve the canonical source path
through the same convention `limits.ts` documents, rather than through the workspace helper.

**Related, same shape, opposite polarity.** `setActiveTurnId(null)` runs at
`handlers/turn.ts:1081`, after `runTurn` has already settled the machine to `idle` and done its
post-settle disk work (`core/turns/model/finalize.ts:171-175`,
`core/turns/model/terminalize.ts:194-197`). So a second window exists — `phase === "idle"` with a
non-null `activeTurnId` — which emits no warnings (both readers exit early on `idle`) but lets a
new `turn.start` through, whose id the OLD handler then clears. Item 2 above should close both
ends together.

### 1.7 Gap H — `PreviewSession.query` is an unimplemented stub; hover, selection and pin creation are all dead

**[verified]** Every `preview.queryGeometry` operation in a live run resolves with `eventCount: 0`
and one content-free `console.warn` line reading `preview.queryGeometry was failed`, decided in
under 1 ms in every case — no host round trip happens at all
(`termcraft-debug/run-2026-07-28T10-12-05-238Z-41460.jsonl:32-34, 63-65, 95-97, 127-129, 145-147,
162-164` — six occurrences, six failures, zero successes). Every `preview.selectPage` in the same
run is `accepted`; page switching itself works and is unaffected. This is an orthogonal,
pre-existing defect, not a consequence of the current page-switching work.

**Root cause: a hard-coded stub, not a protocol mismatch or a race.**
`src/host/adapters/host-supervisor.ts:150-152`:

```ts
async query(_frameToken, _query): Promise<FailureDtoV1 | PreviewGeometryQueryResultV1> {
  return QUERY_NOT_WIRED;
},
```

`QUERY_NOT_WIRED` (`:89-95`) is a module constant carrying a fixed `HOST_PROTOCOL_FAILED`
`FailureDtoV1`, returned unconditionally regardless of the arguments. It becomes
`{kind: "failed", failure: result}` in the router (`src/core/preview/model/session-commands.ts:368`)
and is discarded — logged with the outcome kind only, never its content — at
`src/core/kernel/model/handlers/preview-export.ts:1153-1157`. Landed in `a453a49` (2026-07-24,
"feat(host): add the host-supervisor adapter") and the file has never been touched since
(`rtk git log -S "QUERY_NOT_WIRED" -- src/host/adapters/host-supervisor.ts` and
`rtk git log -- src/host/adapters/host-supervisor.ts` each return exactly that one commit).

**What the user loses.** `preview.queryGeometry` is the sole backing for all three mouse
interactions over the preview frame (`src/ui/workspace/ui/Workspace.tsx:483-498, 700-708`):

- **Hover highlight** — `requestGeometry(…, "hover", …)` (`src/ui/preview/model/interaction.ts:91`)
  — never renders.
- **Click-to-select** — never dispatches `selection.set` (`interaction.ts:168-173`), so the
  composer's selection chip can never appear from a preview click.
- **Pin creation is entirely unreachable.** `GeometryTokenV1` is minted only by a resolving
  `hit`/`pin-anchor` query (`session-commands.ts:370-379`), and `pin.create` consumes exactly that
  token (`src/core/pins/model/create.ts`, `geometry-token-ledger.ts:8-13`) — so pins cannot be
  created at all, not in any state.

It also **latches**: on failure the Kernel publishes nothing, so `pendingGeometry` is never cleared
(`interaction.ts:113-118`), and only a newly acknowledged frame clears it (`:83-87`). On a static
page (no animation redrawing frames) this makes the preview go permanently inert after the first
mouse move.

**Severity.** This is a real functional loss on a shipped, documented, architecture-diagrammed flow
(`docs/architecture/flows/pins-and-selection.md`) — hover, click-to-select, and one of the app's
headline interactions ("right-click to pin a comment on an element") are all dead, not merely
degraded. It has no distinguishing symptom beyond "hovering and clicking do nothing," which reads
as a missing feature rather than a broken one — the dispatch itself is reported `accepted` and the
Kernel's own trace names no reason.

**The stub's own stated blocker no longer exists.** Its file header
(`src/host/adapters/host-supervisor.ts:37-43`) says `query` "needs a Kernel-side `FrameTokenV1` →
`FrameIdentity` ledger" the adapter has no access to. That ledger exists now:
`FrameTokenLedger.verifyCurrent` already returns the resolved identity
(`src/core/preview/model/frame-token-ledger.ts:90-98`), and the Kernel handler already holds it in
hand (`preview-export.ts:1142`) — then discards it and passes the opaque token instead
(`:1151`, `session-commands.ts:365`). Everything below the adapter is finished and tested:
`SupervisedPreviewSession.query` (`src/host/supervisor/model/preview-session.ts:77-79`),
`HostSession.query`'s wire request/correlation/fencing (`src/host/supervisor/model/session.ts:670-686`,
covered by `session.test.ts:311, 340, 379, 510+`), the child's query handling
(`src/host/session/model/host-state-machine.ts:434-439, 529-564`), and the geometry primitives
(`src/host/render/model/geometry.ts:51`). One adapter method is the only thing not connected.

**Shape of the fix, as diagnosed (not applied here).** Change `query`'s first parameter from
`FrameTokenV1` to the already-resolved `FrameIdentityV1` at the port
(`src/core/ports/preview-session.ts:112-115`), pass `verification.identity` instead of `frameToken`
at `session-commands.ts:365`, and implement `query` for real in
`src/host/adapters/host-supervisor.ts` — the host ring owns it, since the frame-scoped half of the
identity (`sourceHash`, `frameSeq`) is Kernel-real but the incarnation-scoped half (`sessionId`,
`nonce`) is host-owned. That needs one additive, read-only accessor for the live incarnation's
nonce on `SupervisedPreviewSession` (currently unavailable — `PreviewIdentity =
Omit<HostSessionIdentity, "nonce">`, `src/host/types.ts:67`), because the Kernel-minted
`previewSessionId`/placeholder nonce would otherwise always draw a `STALE_FRAME` refusal from the
child's own identity fence (`host-state-machine.ts:544-560`).

**Blocking prerequisite — record this prominently, because the work cannot simply be picked up.**
`PreviewGeometryQueryResultV1.resolvedAnchor` needs `fx`/`fy`
(`src/core/ports/preview-session.ts:85-90`), and `GeometryTokenV1` binds them
(`geometry-token-ledger.ts:45-46`), but **no source anywhere in this repository states what they
are fractions *of*** — the element's own rect, or the frame. Until someone defines it, pins stay
uncreatable even after the wiring above lands, because a geometry token is minted only for a
non-null `resolvedAnchor`. Do not invent this value; the design owns it and has not stated it
(`design/07-selection-hover.dc.html`, `design/08-pin-comments.dc.html`). A second, already-documented
shape mismatch will also need resolving before hover/selection are actually usable: the host's
`checkHit` result carries only `{hit: {id}}` while `parseHitGeometry` also wants `pageSlug`,
`elementId`, `label` and a `rect` (`interaction.ts:181-202`, `interaction.test.ts:75-79, 177-189`).

**Untracked until now.** This document's prior passes discussed `preview.queryGeometry` only as a
capability-guard problem (§1.1, Gap A, closed by Task 10); it contained no reference to the adapter
stub, `QUERY_NOT_WIRED`, or "not wired." The stub is documented in the adapter's own file header
but was otherwise invisible outside the code.

---

## 2. Defects that make a working build look broken

### 2.1 A rejected command produces no user-visible feedback

**[read]** `applyIntent`'s `dispatchAndReport` (`ui/app/model/intent.ts`) reacts only to a
thrown/returned `Error`. A command the Kernel *rejects* comes back as an ordinary
`CommandResultV1` and is discarded — by design ("the result surfaces through the event stream,
never through the dispatch return"), which means a capability-guard refusal is invisible
everywhere: no chat line, no status bar, nothing.

This session added a diagnostic trace of every dispatch outcome, which makes the refusal visible
*in the log file*. The user-facing half is still missing.

### 2.2 No feedback at the moment of submit

**[verified]** Pressing Enter in the composer produced no immediate echo of the user's own
message and no spinner. During the two failed turns this was indistinguishable from "the key did
nothing", and it is what sent this session down a multi-hour false trail.

Worth re-checking now that turns actually run: the durable user record is written by admission,
so the echo may simply have been waiting on a turn that never started. If it still lags, an
optimistic local echo is the fix.

### 2.3 Export on a zero-page project publishes no terminal event

**[read]** Carried over from the previous handoff, unverified this session. `export.start` is
ACCEPTED, and the handler's own `NO_PAGES` refusal path publishes no terminal event at all, so
`Ctrl+E` appears to do nothing. It is the first thing a new user is likely to press.

### 2.4 The Home prompt has no slash menu, though the spec requires one

**[read]** Master §3.10 is explicit: *"Typing `/` as the first character of an empty primary
input (the Workspace composer **or the Home prompt**) opens the slash menu"*. Home has none.
`resolveKey`'s `screen === "home"` branch (`ui/app/model/keymap.ts`) emits only
`home-input`/`home-backspace`/`home-submit`, so `/` is just another printable character landing
in the prompt as text. `slash-open` is produced solely under `composerActive`, which requires
`screen === "workspace"`, and `SlashMenu` is rendered only from `Workspace.tsx`'s
`ws-slash-anchor` — Home has no anchor at all.

**Visible consequence:** the acceptance runbook's step 8 tells the operator to quit by typing
`/exit`, explicitly because `q` types a literal "q" on the idle Home prompt. But on Home
`/exit` is *also* just literal text, and Enter then creates a project whose first message is
"/exit". There is no in-app quit from the idle Home screen at all; only Ctrl+C gets out (SIGINT,
which `runApp` does handle gracefully). Step 8 of the runbook is wrong on this point and needs
the same correction.

**Half of it is already built.** `ActionContext` (`ui/actions/types.ts`) already carries
`screen: ScreenKind`, and `Workspace.tsx` already passes `screen: "workspace"` — but neither
`slashRowState` nor `filterSlashRows` ever reads the field. It is a declared, threaded, unused
seam waiting for exactly this. §3.10 also fixes the filtering rule it should drive: *"a command
meaningless on the current screen is hidden (on Home only `/model` applies, and when nothing
applies the menu simply does not open)"*. The design agrees: `home()` draws a `· / model` hint
right after the combo selectors (`design/termcraft-engine.js:142`) — a Home affordance the current
combo row (`Home.tsx:119-142`) does not render either.

**One MVP wrinkle to decide.** §3.10 says only `/model` applies on Home, but `/model` is v1.0
and its registry entry is `execution: { kind: "inert" }`. The dated `/exit` addition
(`ui/actions/model/registry.ts:121-128`) already declares itself reachable "from both the
Workspace composer and the Home prompt", so in MVP the Home menu's only *working* row is
`/exit` — which is precisely the row that would make step 8's instruction true. Decide whether
Home's menu opens for that pair, or stays shut until `/model` is live.

### 2.5 The composer is frozen for the whole turn, against the spec

**[read]** Master §3.2, verbatim: *"Typing the next message while a turn runs is **allowed**,
but sending is disabled (the status bar hints why) — there is no message queue."* §3.10
continues: *"While a turn runs, ordinary message sending remains disabled but `/` on an
otherwise empty composer still opens local command mode: the v1 `/commit-*` commands remain
available according to Git scope state while other turn-locked commands stay dimmed."*

The implementation does the blunt version instead. `keymap.ts`'s `composerActive` excludes
`turnRunning`, so for the entire duration of a turn the composer accepts no character, no
backspace, and no `/` — the slash menu cannot even be opened. `Workspace.tsx` renders the
Composer `disabled` over the same condition. The keymap's own comment explains the reasoning:
keystrokes would "silently accumulate behind the disabled placeholder" and Enter would fire a
second `turn.start` the Kernel rejects, discarding what was typed — because `applyIntent`'s
`composer-submit` clears the composer unconditionally. That hazard is real, but the fix for it
is to make `composer-submit` a no-op while a turn runs, not to freeze the input.

**Required:** typing, editing and `/` stay live for the whole turn; only the send itself is
refused, with the status bar saying why. Commands lock individually, not wholesale.

**The per-command matrix already exists — in the Kernel.**
`core/capabilities/model/turn-lock.ts` implements kernel-command-contract §10.4's
`TURN_LOCKED_KINDS`: `chat.create`, `chat.switch`, `export.start`, `model.select`, the `page.*`
mutations and `restore.plan`/`confirm`/`retryRecord`, each published as `TURN_RUNNING` carrying
the active `turnId`. `turn.cancel`, the whole `commit.*` family and `restore.discardPlan` are
deliberately excluded, and the file's header states outright that "local slash-command mode" is
available because it is "no Kernel command at all". The operator's rule — block the model
change and the send, nothing else — *is* that matrix: `model.select` sits in it, and the send is
`turn.start`'s own `TURN_ALREADY_ACTIVE`.

The UI overrides that authority with a blanket rule of its own: `slashRowState`'s
`turnLocked = context.turnRunning && !isCommit` dims every non-`/commit-*` row, including
`/exit`, which carries no Kernel capability and which the Kernel never locks. Once the composer
stays open mid-turn, that blanket dim would leave `/exit` unusable exactly when a stuck turn
makes someone want it. The rows should read the mirrored capability state — which already
carries `TURN_RUNNING` per kind, with its hint text — and drop the local `turnRunning` shortcut.

**Design coverage — one narrow gap to flag.** `design/termcraft-engine.js:208` draws the
generating composer as a faint `❯` with the `generating… esc to cancel` placeholder and **no**
cursor block; the blinking cursor appears only in the non-generating branch (`:209`), and that
same "faint prompt, no cursor" vocabulary is what the explicitly `composerDisabled` history
screen uses (`:449-452`, `:529-530`). So the mock only ever depicts the *empty* composer
mid-turn — it never shows typed text during generation, and therefore does not say how the caret
and the typed line should look while a turn runs. The behavior is settled by the spec; that one
visual state needs a design decision rather than an invented value.

### 2.6 The text cursor renders after the placeholder instead of over its first cell

**[read]** Every input renders the blinking `█` as a sibling `<text>` AFTER the value/placeholder,
so an empty input paints `❯ Describe the TUI you want to design…█` — the cursor sits at the end of
the hint text rather than at the insertion point. The design overlaps it onto the first cell
instead, drawing text and cursor at the same column:

- Home — `design/termcraft-engine.js:136-137`: `text(b, ix+4, …, 'Describe the TUI…')` then
  `put(b, ix+4, …, '█')`.
- Composer — `:451-452` (`chatSeq`) and `:208-209` (`drawChat`): `ctext(…, chatX+3, …)` then
  `put(…, chatX+3, …, '█')`.

`Home.tsx:101-106` documents this as a knowing divergence ("Flexbox can't overlap two siblings in
the same cell, so the closest faithful mapping appends the cursor right after the text");
`Composer.tsx` carries the identical divergence with no comment at all. The operator has ruled the
divergence wrong: the cursor belongs at the insertion point — over the placeholder's first cell
while the input is empty, after the last character once it is not.

**Scope is two components, not three.** `PinInputPopup.tsx` also appends its cursor, but that
matches ITS design source: `wsPinInput` (`termcraft-engine.js:498`) draws the cursor one column
past the end of a 26-character value, and the mock never shows an empty state. It needs the same
rule only if it ever gains a placeholder.

**The "flexbox can't overlap" premise does not hold.** `position="absolute"` is available and
already used here — `Workspace.tsx:129,432` (the slash anchor), `PreviewOverlays.tsx:65,75,89,101`,
`App.tsx:221,246`. The simpler route needs no absolute positioning at all: while the placeholder
shows, render its first character AS the cursor cell and the remainder as a second `<text>` —
precisely what the design's `put`-over-`text` produces.

**Worth doing once, not twice.** All three components declare their own private `CURSOR_GLYPH` /
`BLINK_CURSOR` constants (`Home.tsx:10,19`, `Composer.tsx:17-18`, `PinInputPopup.tsx:11-12`) —
`ui/theme` exports no shared pair. Three independent copies of the same two values is exactly how
this ended up wrong in two of them and right in the third.

### 2.7 Home shows no model for up to 20 seconds, and claims "agent ready" before checking

**[verified]** Operator: for a long stretch after launch there is no model information on Home.

**[read] One synchronous fact is stuck behind an asynchronous one.** `createAgentHealthProbe`
(`entrypoint/model/agent-health.ts:126-150`) resolves ONE promise folding together:

- `backend.healthCheck()` (`:128`) — a real cold spawn of the CLI running an actual
  `query({ prompt: "ping" })` (`agent/claude/backend/model/probe.ts:145`), bounded by
  `DEFAULT_PROBE_DEADLINE_MS = 20_000` (`agent/health/model/deadline.ts:15`), never overridden in
  production;
- `backend.capabilities().defaultSelection` (`:136`) — **synchronous**, declared non-Promise on
  both port definitions (`core/ports/agent-backend.ts:168`, `agent/types.ts:140`), and for Claude a
  plain object literal with no I/O at all (`agent/claude/backend/model/capabilities.ts:6-24`,
  `{ model: "claude-sonnet-5", effort: "high" }`).

Because `model`/`effort` ride on the promise, they arrive only when the CLI probe finishes. Home
paints `agent ‹claude›  model ‹›  effort ‹›` (`Home.tsx:119-142`, via `homeCombo`'s `?? ""` in
`App.tsx:40-42`) and a status bar reading `no project yet   · ` with a dangling separator
(`Home.tsx:161`) for the whole window. `DEFAULT_HOME_HEALTH` (`deps.ts:182-187`) omits both
deliberately — and correctly, since duplicating the backend's declared default inside `ui` would
let it drift from the catalog. The fix is not to duplicate it but to deliver the synchronous fact
synchronously: `entrypoint` is the composition root, already imports `agent`, and can seed the
selection into `UiDeps` at construction, leaving the probe responsible only for health.

**Required:** agent · model · effort paint on the first frame; while the check is in flight,
submit is refused instead.

**The gating half does not exist, and the placeholder is a false claim.** `HomeAgentHealth` has no
"checking" state — `present` is a plain boolean (`ui/home/types.ts:9`) — and the pre-probe
placeholder asserts `present: true, detail: "agent ready"` before anything has been probed. So
during the probe Home is indistinguishable from a verified-ready agent and `Enter` is fully live:
`resolveKey`'s Home branch diverts only on an explicit `present === false` (`keymap.ts:190`), and
`home-submit` checks nothing but a non-empty string (`intent.ts:44-56`). Nothing in the Kernel
compensates — `handlers/turn.ts:203` records that `account` is a documented `null` literal rather
than a fresh `healthCheck()`, and no `core/` code calls `healthCheck()` at all. A real third state
is what makes the placeholder honest and gives submit something to gate on.

**The timeout makes it worse, not merely slower.** On deadline expiry `runHealthProbe` returns
`inconclusive` = `{ status: "not-logged-in" }` (`agent/health/model/probe.ts:13-15,48-51`), which
maps to `present: false` — so a slow-but-working CLI does not just delay the combo, it flips Home
to the full agent-missing error screen after 20 s.

**Operator's decision — drop the health line from Home.** The green
`● {agent} {version} · {detail}` line (`ui/home/ui/Home.tsx:143-145`; design
`termcraft-engine.js:143`) is removed. A deliberate design amendment, and it costs nothing
factual: the combo row already names the agent, a genuinely missing CLI still replaces the whole
screen with `homeErr()`, and this was the one line asserting "ready" — precisely the assertion
that is false while the probe runs. It also retires §4's "Home's agent identity never shows a
version" entry, since `version` is read only here (`Home.tsx:46`, rendered at `:144`).

**Related, and worse: the Workspace composer's model chip is empty permanently.** Not "until a
probe resolves" — always. `buildAgentIdentity()` (`core/kernel/model/kernel.ts:884-892`) returns
`null` unconditionally and never consults `deps.agentRegistry`; a test pins that as the contract
(`kernel.test.ts:351`). So `Workspace.tsx:266-267`'s `agentLabel`/`modelChip` are `""` in every
run, and the design's `codex · gpt5.5 · high` chip on the composer seam is blank. Flagged in the
code as TRIAGE #38; it belongs here because it is the same missing fact, available from a
different — and equally synchronous — place.

---

## 3. Observability — why the two bugs above hid for hours

### 3.1 `console.*` does not reach anything in the interactive TUI

**[verified]** that internal `console.warn` calls never appeared in the trace during an
interactive run, while the very same tee captured them on the headless `export` path.

**[verified]** — upgraded from hypothesis while investigating Gap F. The OpenTUI renderer
replaces `global.console` for the duration of the render and restores it on teardown (in
`@opentui/core`'s bundled renderer chunk; the filename is build-hashed, so rely on the behavior,
not the path). Our tee installs first and is swapped straight out. The proof is in
`termcraft-debug.jsonl`: the whole session contains four `console.*` entries, all emitted after
the renderer came down, while `handlers/turn.ts:1061`'s admission-rejection warning — which fired
mid-session — is absent entirely.

Practical effect: the codebase reports through `console.warn`/`console.error` from 75 files, and
in a live interactive run **every one of those lines goes nowhere**. Both blockers found this
session were silent for exactly this reason. A real logging port, written to a file and
independent of whoever owns `console`, is worth more than any individual fix in this document.

### 3.2 Diagnostic instrumentation currently in the tree

Added during the investigation, needs a decision before commit — see §6.

---

## 4. Smaller gaps, none blocking

- **`FrameIdentityV1.nonce` has no real source.** **[read]** `core/preview/model/
  session-commands.ts`'s own header: no port in this slice's narrowed surface carries a real
  host-incarnation nonce, so the module mints its own stand-in (`mintHostNonce`) each time a
  session is (re-)established. A fidelity gap in frame identity, not a rendering blocker —
  recorded here (§1.1's own "Two honest unknowns" also names it) so it is not discovered a third
  time. Closes when a later slice threads a real host-incarnation nonce through the port
  boundary.
- **A deliberate session teardown is reported as a crash code, `CHILD_EXITED`.** **[verified]**
  When `setActivePreviewSession` retires the preview session a page switch displaces
  (`src/core/kernel/model/kernel.ts:636-640`, from `1f39f14 fix(preview): retire the displaced
  session and follow its successor`) while that session's child is still mid-handshake, the closed
  child's stdout closes and the handshake resolves `SupervisorError({code: "CHILD_EXITED", reason:
  "stdout closed before the expected message"})` (`src/host/supervisor/model/session.ts:160-167`)
  — the same code a genuine crash produces. `CHILD_EXITED` is a "budgeted", not deterministic,
  failure (`src/host/supervisor/model/restart-policy.ts:19-23, 89-92`), so it counts toward the
  three-restarts-per-60s budget and, on exhaustion, opens the circuit carrying
  `failureCode: "CHILD_EXITED"` verbatim (`src/host/supervisor/model/supervisor.ts:166`) through to
  `kernel.ts:901` and the UI's closed code→phrase table, which reads it as *"the host exited
  before it could render"* (`src/ui/preview/model/host-failure-phrase.ts:14`). Observed once in a
  live run (`termcraft-debug/run-2026-07-28T10-12-05-238Z-41460.jsonl:60`,
  `waitedMs: 1007, budgetMs: 10000` — a page-switch-back 160 ms after the displaced session's child
  reached `main.start`) and it recovered on the next session (`outcome: "hello"`). The teardown
  itself is intended and correct; only its label is wrong — a deliberate close should not be able
  to consume restart budget or draw the same user-facing failure panel as an actual crash. Needs a
  distinct disposition (e.g. "retired during handshake") or suppression of the failure path when
  the close is Kernel-initiated. Independent of Gap H (§1.7) above; page switching itself works
  correctly. Not gating MVP; recorded so it is not lost.
- **Selection never reaches the Kernel.** **[read]** `selection.set`/`selection.clear` only emit
  `selection.changed`; they never write `context.setSelection`, so `context.selection()` stays
  `null` and every sent chat record carries an unpopulated `selection`. The admission read path
  is wired ahead of the handler write path (`docs/architecture/flows/pins-and-selection.md`).
- ~~**`fallbackToFreshSession` is unwired.** **[read]** Defined and tested, no production caller;
  needs an `AgentRunOutcome` widening.~~
  **CLOSED 2026-08-09, design-agent-feedback-loop repair Task 9.** The widening this row asked
  for landed: `AgentRunOutcome`'s (and the lifted `core/ports` copy's, and
  `TurnAttemptOutcomeV1`'s) `backend-error`/`failed` variant gained a closed
  `BackendErrorCause = "resume-rejected" | null` field. `agent/claude/run/model/
  classify-backend-error.ts` classifies a rejected resume in the ONE layer that knows the SDK's
  error shape, on spike 12's four structural conditions (`SessionPlan.kind === "resume"`,
  `is_error === true`, `num_turns === 0`, then the measured `errors[]` text) — never on the
  vendor's English sentence alone. `core/turns/model/run-turn.ts` now calls
  `fallbackToFreshSession` on a classified rejection, once per turn, before terminalizing.
- **`account` is a documented `null` literal** rather than a fresh `healthCheck()` per master §9.
- **The system prompt cannot carry per-page source metadata or the current selection** that
  master §6.2 lists — `AgentPromptContextV1` has no channel for either.
- ~~**Home's agent identity never shows a version** — `AgentInfo` carries no version field, so
  the health line reads `● claude · agent ready`. Honest rendering, not a missing probe.~~
  **CLOSED 2026-07-26, Task 15 (finding §2.7).** The health line is gone: Home now routes on five
  honest outcomes (`checking`/`ready`/`advisory`/`blocked`/`missing`), and `version` is read
  nowhere in the codebase — never fabricated, never displayed.
- **`D-Q6`** — exported `layout/<slug>.json` omits the `text` field on text nodes.
- **Restore and migration are unwired** — `buildRestoreTransaction`/`buildMigrationTransaction`
  are built and unit-tested with no live caller.
- **`@reatom/core` opens a `BroadcastChannel` at module scope** on any import, so no importing
  process can exit on its own; the interactive root force-exits to compensate. Worth reporting
  upstream. A local `bun patch` or lazy shim is a repo-wide dependency decision.
- **RTM-S02, `ui/app/model/deps.ts` `pinDraft`** — reset by hand from three call sites instead of
  `withComputed` over `interaction.pendingPin`; the sibling `slashSelection` already does it the
  right way. Raised by the Reatom state auditor, dismissed twice as out-of-scope for this
  session's edits. Should be its own task.
- **A flaky test.** **[verified]** One intermittent failure around
  `src/ui/preview/model/interaction.ts:238` inside a Reatom `run`; passes on re-run. Three further
  failures in a full-suite run (`runtime-dts`, `Button`, `Gauge`) reproduced only under CPU
  contention and pass in isolation — subprocess-spawning tests, not regressions.

---

## 5. Not yet observed — the Gate's own verdict

**[verified]** A turn was gate-rejected once ("invalid design") and we still do not know *why*:
the trace recorded only the event kind. Payload logging for rejection/failure events was added
afterwards but has not been exercised by a run yet. The next gate rejection will say what it
objected to.

---

## 6. Awaiting the operator's decision

1. **Spinner cadence — answered and done** (80 ms, canonical braille cycle phase-shifted so the
   design's `⠹` is frame 0). Listed here only so the record is complete.
2. **The diagnostic instrumentation.** Recommendation: keep `infrastructure/debug-log` and the
   `console.*` tee (see §3.1 — this is the thing that made the invisible visible), drop the
   step-by-step markers in `runTurnStart`, and return tracing to opt-in — it is currently ON by
   default, marked TEMPORARY in `sink.ts`.
3. **`.reatom-audit-ignore`.** Whether to add `examples` so the audit gate stops asking about
   agent-generated example pages. `oxlint` and `oxfmt` already ignore that directory.
4. **The `<reatom-audit>` block** just appended to `CLAUDE.md` by `/reatom-audit init` — keep or
   revert.

---

## 7. Closed during this session, for context

- **Project creation never set `active_chat_id`.** The first chat was minted but nothing pointed
  at it, so `turn.start` refused every turn at `activeChatId === null`, returned an empty event
  list, and produced no message, no spinner and no error. **No turn could ever run in a new
  project.** Fixed in the one project-creation transaction; two tests that had pinned the buggy
  state were rewritten to assert the pointer against the chat file actually on disk.
- **Every gate-rejected turn died on its own retry.** The candidate directory is keyed by
  `turnId` alone and created with non-recursive `mkdirNew`, so the second attempt inside one turn
  hit `EEXIST` → `PERSISTENCE_FAILED`. The documented 3-retry budget was unreachable. Fixed by
  retiring the previous candidate through the existing containment-checked path; proven by a test
  that reproduces the exact production error when the fix is removed.
- **The spinner never animated** — `spinner="⠹"` was a hardcoded literal with no frame set
  anywhere in `src`. Replaced by a shared `ui/spinner` module: one ticker for all spinners, whose
  lifetime is owned by its connect hook, so it starts and stops with the turn.
