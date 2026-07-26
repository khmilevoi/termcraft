# MVP acceptance walkthrough (§11)

Manual, step-by-step run of master spec §11's success-criteria walkthrough, for two
distribution modes: the repository checkout in dev mode, and the globally installed
npm package. This runbook is written to be handed to an operator who has never run
termcraft before. It is deliberately not a smooth-path script: five behaviors below
are known, already-recorded limitations the operator WILL hit, and each is called out
at the step where it bites, so it reads as an expected result rather than a new bug.

Every "known limitation" callout in this document was verified against the code on
2026-07-25 (phase-8, branch `phase-8`), not copied from an earlier writeup. Where the
verification changed the original framing, the wider finding is recorded, not just the
narrower one that was asked for.

## 0. Prerequisites (both modes)

- **Bun ≥ 1.3.14** on `PATH` (`bun --version`). termcraft is Bun-native — there is no
  Node fallback.
- **Claude Code CLI installed and logged in**, on `PATH`, under whatever account you
  want termcraft's turns to run against. termcraft holds no API keys of its own; it
  drives the CLI you already authenticated. If the CLI is missing or not logged in,
  Home never shows the prompt screen at all (see step 2's failure branch) — nothing
  past that point in this runbook is reachable until the CLI is fixed.
- A terminal that supports mouse reporting, if you intend to exercise the right-click
  step (step 6). Windows Terminal and most modern terminal emulators do.
- **Real money will be spent.** Every successful turn is a real Claude Code CLI call
  under your account. This is why the design document explicitly does not treat this
  walkthrough as an automated exit criterion.

## 1. Install / launch: dev mode

Dev mode runs the repository checkout directly, against a scratch project directory
that is NOT the repository itself.

**Do not just run `bun start` from inside the repository.** `package.json`'s `start`
script is `bun run src/main.tsx`; Bun resolves a *named* package script's working
directory to the package root regardless of where you invoke `bun run start` from
(verified by hand: `bun run --cwd <pkg> <script>` from a subdirectory still reports
`process.cwd()` as `<pkg>`, not the caller's directory). Running the named `start`
script therefore always targets the repository checkout itself as the project root —
which is exactly the dev convenience the repository's own `.gitignore` already
special-cases (`/.termcraft/`, "a termcraft project created by running the app against
the repository root itself"). That is a fine way to poke at the app, but it is not
this walkthrough's starting condition, which is an **empty directory**.

To target a real scratch directory, invoke the entry file directly — a direct
`bun run <file>.tsx` invocation (as opposed to a named script) preserves the caller's
own working directory (verified by hand: a probe script run this way reports the
caller's `cwd`, not the script's own directory) — and `src/entrypoint/model/
bootstrap.ts`'s `resolveEnv` resolves the project root from the first non-flag argv
entry, defaulting to `.` (the process's cwd) when none is given:

```
mkdir <scratch-dir>
cd <scratch-dir>
bun run "<ABSOLUTE PATH TO THE termcraft CHECKOUT>/src/main.tsx"
```

Replace `<ABSOLUTE PATH TO THE termcraft CHECKOUT>` with this repository's absolute
path (e.g. `C:\Users\you\RustProjects\termcraft`). Windows path backslashes are fine
inside the quoted argument.

**Expected:** the terminal takes over (raw mode, alternate screen) and the Home screen
described in step 2 appears.

**On failure:** capture the exact command line you ran, the full stderr output, and
whether a `.termcraft/` directory was created in the scratch dir before the failure. A
module-resolution error here (`Cannot find package`, `Cannot find module`, `Failed to
resolve`) most likely means `bun install` has not been run in the repository — see the
node_modules hazard in step 8, which can produce exactly this symptom even for the
checkout itself.

## 2. Home opens

**Expected:** a centered prompt box with the `❯ termcraft` logo, the tagline "design
terminal UIs by describing them", a blinking cursor in the prompt box, and a health
line reading `● claude · agent ready` below the `agent ‹claude› model ‹claude-sonnet-5›
effort ‹high›` combo row. A status bar at the bottom reads `HOME` on the left and
`⏎ create` / `/exit quit` hints on the right.

**Known limitation — Home's agent identity never carries a version number.**
`AgentInfo` (`src/core/ports/agent-backend.ts`) carries no version field, so the
health line reads `● claude · agent ready`, never `● claude 0.34 · agent ready` the
way the design's Codex sample data shows. This is the honest rendering, not a missing
probe result — `ui/home`'s `HomeAgentHealth` (phase-8 Task 13, finding §2.7) carries
no `version` field at all, so `src/entrypoint/model/agent-health.ts`'s
`homeHealthFromAgentInfo` has nothing to set on any of its five branches. Do not
treat a bare `● claude · agent ready` line as a bug.

**The `agent ‹claude› model ‹claude-sonnet-5› effort ‹high›` combo paints on the
first frame**, before the health probe resolves (finding §2.7, phase-8 Task 13):
it is a synchronous fact — `entrypoint/model/agent-health.ts`'s
`resolveDefaultAgentSelection` reads the agent registry's declared default at
composition and seeds it directly into `UiDeps.local.agentSelection`, never riding
the health probe's own promise. Do not expect the combo to be briefly empty and
then fill in.

**Failure branch — agent CLI missing or not logged in.** Home instead shows a red
`agent` panel: `✗ claude CLI not found` (or `✗ claude CLI found but not logged in`),
`termcraft needs the claude agent on your PATH.`, an install hint, and `then reopen,
or press r to re-check`. The status bar reads `r re-check` / `q quit`. Fix the CLI and
either press `r` or relaunch. Capture the exact headline text shown (it distinguishes
"not found" from "found but not logged in" from "exited without confirming shutdown" —
all three route through this one screen, since the design only ever mocked the first
case) plus any stderr termcraft printed on launch.

## 3. Type the description, press Enter

Type into the focused prompt box:

```
a system monitor dashboard
```

Press **Enter**.

**Expected:** the screen switches to the Workspace — a chat panel on the left (~37%
width) and a preview region with a tab strip on the right, both empty, plus a status
bar. This is `project.create` completing: it creates `.termcraft/` (portable
`project.toml`, machine-local `workspace.local.toml`, a `.gitignore`, and the first
chat header) and opens the Workspace.

**Known DEFECT (Gap C) — the Home prompt's text does NOT auto-start a turn.** Expect an
**empty** chat panel, an **empty** composer, and **no** spinner or status block. Nothing
is running and nothing tells you the text was dropped; the app looks broken here. It is
not — it simply never started a turn. Continue to step 4 and type the text again.

`Enter` on Home dispatches `project.create` with your typed text carried in the command
payload, but `handleProjectCreate` (`src/core/kernel/model/handlers/project.ts`) never
reads that field — verified by reading the handler: it uses only
`payload.creationDefaults.trust`. Home's local `prompt` atom and the Workspace's local
`composer` atom are two separate pieces of UI state with no carry-over
(`src/ui/app/model/deps.ts`).

This was originally written up as designed behavior. It is now recorded as a defect to
fix — **Gap C** in `docs/architecture/flows/launch.md` — because it is the first
interaction a new user has and it reads as a broken app: raised from a real run on
2026-07-25. Required behavior is one keystroke: create, open the Workspace, append the
typed text as the first user message, start the first turn.

**On failure:** capture the on-screen error (Home surfaces creation failures inline)
and whatever appeared in the chat panel, if the Workspace did open.

## 4. Send the message from the Workspace composer

Click into (or `Tab` to) the composer and type the same text again:

```
a system monitor dashboard
```

Press **Enter** to submit. This dispatches `turn.start` with your message.

**Expected:** the chat panel shows your message, then an ephemeral status block
(spinner / tool steps / reasoning ticker) while the turn runs. This is a real,
metered call to the Claude Code CLI under your logged-in account — it can take from a
few seconds to over a minute depending on what Claude decides to do.

**On failure / to capture regardless of outcome:** the exact chat-panel text once the
turn finishes (`✗ <outcome>` on failure, or the assistant's final message on success),
and — if you have log access — the turn's own `.termcraft/turns/<turnId>/` staging
directory contents; a rejected page tells you which Gate stage failed.

## 5. Claude writes page code; the Gate validates it

**Expected on success:** the chat shows Claude's response, and `.termcraft/pages/
home/page.tsx` (or whatever slug Claude chose, most likely `home`) now exists on disk
with real `@termcraft/runtime` design code. Before that file is written, the Gate ran
for real against it — import allowlist, page contract, all five warning lints, a live
TypeScript check against the generated `@termcraft/runtime` declaration
(`src/runtime/generated/runtime-dts.ts`, phase-8 Task 7), and a one-shot smoke render
through a real disposable design-host subprocess. A page that fails any of these
retries automatically (up to 3 retries) with the Gate's diagnostics folded back into
the prompt; only a page that still fails after the retry budget produces a visible
chat error and no canonical-source change.

**Known limitation — the Workspace's live preview panel stays empty, even on a fully
successful turn.** This is the most consequential limitation in this runbook, and it
is broader than "pins don't work": no currently-wired `core/kernel` command handler
ever dispatches `kernel.preview.enable` (`disabled → idle`), so the Kernel's Preview
state machine can never leave `disabled` through `kernel.dispatch()` alone — every
`preview.*` command (including `preview.selectPage`/`preview.selectCurrent`, the ones
that would establish a live session against your new page) is rejected `OPERATION_BUSY`
by the capability guard before its handler ever runs. Independently, and consistent
with that gap, no code under `src/ui` dispatches `preview.selectPage`/`selectCurrent`
today either (verified by search; also recorded verbatim in `src/entrypoint/model/
smoke.test.ts`'s own extension notes: "still no UI caller exists"). The practical
result: `mirror.preview()` / the preview panel stay in their no-session state for the
whole walkthrough. This is NOT the same as the page failing — the Gate's own one-shot
smoke render (a separate, already-real code path; see `docs/architecture/flows/
generation-turn.md`) still proves the page renders correctly, and the file lands on
disk. You simply will not SEE it rendered live in the Workspace UI. Do not spend time
troubleshooting a blank preview panel; it is `docs/architecture/flows/
interactive-prototype.md`'s documented "Gap A", not specific to your page or your
turn.

**On failure (Gate rejects after exhausting retries):** capture the chat's final
error text, and if you have filesystem access, `.termcraft/turns/<turnId>/workspace/`
(the frozen candidate before it was retired) plus which Gate stage's diagnostic
appears in the chat.

## 6. Right-click a gauge, type "make this gauge red", send

**Expected per the design:** right-click an element in the preview to drop a pin,
type `make this gauge red` into the mini-input overlay, and send it as part of the
next message.

**Known limitation — this step cannot work today, for the same root cause as step 5.**
Right-click-to-pin needs a resolved `hit`/`pin-anchor` geometry query against a LIVE
preview session (`preview.queryGeometry`), and no live session is ever established
(step 5's Gap A). Concretely: `preview.queryGeometry` itself is also rejected
`OPERATION_BUSY` from a freshly built Kernel regardless of the frame-token
acknowledgement wiring (which IS real — phase-8 Task 16 — but has no frame to
acknowledge in the first place). **What to do instead:** treat this step as expected
to fail, and do not spend time on it. If you want to exercise pin text reaching a
turn's context at all, you can still observe `AgentPromptContextV1`'s `openPins`
wiring (phase-8 WP-3/WP-6) via the unit tests
(`src/core/kernel/model/handlers/turn.test.ts`) rather than the live UI — there is no
interactive substitute for this step in the current build. Simply continue to step 7.

**If you attempt it anyway and something DOES visibly happen** (a pin overlay
appears), that contradicts this runbook's verified finding — capture a screenshot,
the exact click coordinates, and whatever appeared in the chat, since that would mean
the gap above has closed since this runbook was written.

## 7. `Ctrl+E` — export

Press **Ctrl+E** (a global hotkey; it works even while the composer has focus/text in
it) — or type `/export` in the composer and select it from the slash menu.

**Expected on success:** the status bar or chat area shows export progress
(`export.started` → `export.progress` × 2 → `export.completed`), and
`.termcraft/export/generations/<generationId>/` is created, containing:

- `design-prompt.md` — product overview, per-page structure, theme tokens, and
  acceptance-fixture framing for an implementing coding agent.
- `pages/<slug>/page.tsx` — exact copies of the canonical design sources.
- `snapshots/<slug>/<WxH>.txt` — ASCII frames at the fixed size ladder (each page's
  own minimum size, plus 120×40 and 160×40 where they clear that minimum).
- `layout/<slug>.json` — the resolved layout tree per size (no `text` field on text
  nodes yet — a known, separately-tracked divergence, `D-Q6`).
- `runtime-api.json` — the public module identity and each page's `kitApiVersion`.

`.termcraft/export/current.json` points at this generation.

**Known limitation — exporting a project with zero pages fails silently from the
Kernel's own perspective, though the CLI form (step 9) reports it.** If your turn in
step 5 never actually landed a page (e.g. you skipped straight to export), the Gate's
own guard at admission does not check page count — `export.start` is ACCEPTED
(`disposition: "started"`) — and the handler's own `NO_PAGES` refusal path
(`core/kernel/model/handlers/preview-export.ts`'s `runExportStart`) publishes NO
terminal event at all, because nothing ran that could report one. In the interactive
UI this means Ctrl+E appears to do nothing observable once accepted (no
`export.completed`, no `export.failed`) — this is a documented gap, not a hang; wait
a few seconds, then check whether `.termcraft/pages/` actually has a page before
retrying. This does not apply if step 5 succeeded.

**On failure:** capture the chat/status-bar text, and whether `.termcraft/export/
current.json` changed at all (a failed export leaves the previous generation active).

## 8. Exit termcraft

Type `/exit` in the Workspace composer, or on the idle Home prompt — both are
"primary inputs" for the slash menu (§3.10, phase-8 Task 17, finding §2.4): typing
`/` opens the same non-modal menu on either one, filtered on Home to the two rows
meaningful there (`/model`, shown but unavailable — it is v1.0 — and `/exit`, the
one usable row); finish typing "exit" and press Enter to submit it. (On the Home
agent-missing panel or the too-small-terminal screen specifically, press `q`
instead — those two screens have no text input at all, so `q` is safe there; on
the idle Home prompt and in the Workspace composer `q` still types a literal "q",
by design, so it must not double as a quit key there — use `/exit`.)

**This instruction is new as of phase-8 Task 17.** Before it, Home had no
in-app quit affordance at all outside the agent-missing/too-small-terminal
screens: the slash menu never opened from the Home prompt, so `/exit` was
literal text there and Enter would create a project whose first message was
the string `"/exit"`. **Ctrl+C is not an escape route either** — a previous
task's claim to the contrary was already investigated and retracted
(`ui/app/model/root.tsx:70` passes `exitOnCtrlC: false` to
`createCliRenderer`, no `ctrl+c` hotkey is registered, and raw mode disables
`ISIG`, so a Ctrl+C keypress never reaches `run-app.ts`'s SIGINT handler at
all — it resolves to an ordinary, ignored keystroke). Before this task there
was no way out of idle Home at all.

**Expected:** if a turn is running, it is cancelled first and confirmed process-tree
exit is awaited before the shell releases its resources and the process exits
cleanly (no orphaned Claude CLI process, no stuck project lease).

## 9. Relaunch in the same directory (dev mode)

Re-run the same command from step 1, from the same scratch directory.

**Expected:** termcraft reopens straight into the Workspace (not Home) with the same
chat history and the same canonical pages on disk — recovery replays any unfinished
transaction before the Workspace opens.

**Known limitation — session resume is per-process, not cross-restart.** The SECOND
and later turns of the SAME live process resume the prior Claude SDK session
(phase-8 WP-7: `turn.start` reads a durable `workspaceIdentity` from the project
manifest and feeds `AgentBackend.sessionScope`). A relaunch — this step — always
starts an honestly fresh session on its first turn: Claude's own account
discriminator is always `null`, so the session-scope's account component falls back
to a value random per process (`agent/session/model/session-scope.ts`'s
`UNRESUMABLE_ACCOUNT`), by design (storage-identity §6.2's documented escape hatch
for a backend with no stable account identity). This is designed behavior, not a
defect — do not report "session doesn't resume across relaunch" as a bug.

---

## Install / launch: the globally installed package

This is the mode phase-8's exit criterion 2 actually requires — it exercises the
shipped `npm pack` tarball via the `files` allowlist in `package.json`, not the
checkout.

**`bun link` is NOT a valid substitute for this section, and must not be used as a
shortcut.** `bun link` (and `bun link termcraft` in a consumer directory) registers a
symlink to the WHOLE repository checkout, so every file in the working tree —
including everything `package.json`'s `files` allowlist deliberately excludes — stays
reachable from the "installed" copy. Two real, distribution-breaking bugs this phase
found were invisible to a `bun link` probe and surfaced only under a real `npm pack`
install: `tsconfig.json` was missing from `files` (Bun reads its `compilerOptions
.paths` at runtime, so `main.tsx`'s first aliased import died under the real tarball),
and `create-shell.ts` eagerly imported `scripts/embed-assets` — a file `npm pack`
never ships because `scripts/` is outside `files` — which `bun link` could not catch
because the symlinked checkout still has a real `scripts/` directory sitting right
there. Both are fixed now, but they are exactly the class of bug this section exists
to keep catching.

### Install

From the repository root:

```
npm pack
```

This produces `termcraft-0.1.0.tgz` (or whatever `package.json`'s current `version`
is) in the repository root, built from the real `files` allowlist — the same artifact
`npm publish` would upload.

From a SCRATCH directory — **not** the repository root; see the hazard below —
install it globally with an **absolute** path:

```
bun add -g "<ABSOLUTE PATH TO THE REPO>\termcraft-0.1.0.tgz"
```

The path must be absolute. A relative path (e.g. `bun add -g
./termcraft-0.1.0.tgz`) fails with `error: ENOENT extracting tarball from
./termcraft-0.1.0.tgz`, because a global install resolves a relative specifier
against Bun's global install location, not your current directory — verified by hand.

**Verify the install:**

```
bun which termcraft
```

should print a path. If it prints nothing, the install did not put `termcraft` on
`PATH`; do not proceed to the steps below.

### Hazard — running the install/uninstall from the repository root

**Observed during this phase, not fully diagnosed — treat as a hazard, not a
confirmed cause-and-effect.** Running `bun add -g` / `bun remove -g` with the
repository root as the current working directory coincided, in this phase, with the
repository's own local `node_modules` being emptied out, which then made the whole
`bun test` suite fail wholesale (module-resolution errors across the board) until
`bun install` was re-run in the repository to restore it. The exact mechanism was not
proven. Two consequences for this runbook:

1. **Run the global install and uninstall commands (`bun add -g` / `bun remove -g`)
   from a scratch directory, never from the repository root**, even though `npm pack`
   itself must run from the repository root.
2. **If `bun test` in the repository suddenly fails wholesale** (not a handful of
   related tests, but broad, unrelated module-resolution failures) after running a
   global install/uninstall, re-run `bun install` in the repository root before
   assuming something is actually broken.

### Run the three argv paths from an empty directory

From a fresh, genuinely empty scratch directory (not the one you installed from):

```
mkdir <empty-scratch-dir>
cd <empty-scratch-dir>
termcraft
```

**Expected:** the same Home screen as dev-mode step 2. Walk steps 2 through 9 above
identically — every behavior and every known limitation documented there applies the
same way to the installed package; nothing about the distribution mechanism changes
Kernel or UI behavior.

Additionally, two argv paths worth checking directly (both used by the automated
oracle described below, and safe to run by hand):

```
termcraft _host --stdio
```

**Expected:** the process starts and blocks waiting for the parent supervisor's hello
frame (it never announces itself unprompted) — this is the design-host child process,
not something a human drives directly. `Ctrl+C` to stop it. A `Cannot find package`/
`Cannot find module`/`Failed to resolve` on stderr here means the installed package's
module resolution is broken; anything else (including silence while it blocks) means
resolution succeeded.

```
termcraft export
```

**Expected in a fresh empty directory:** a trust or zero-pages refusal message on
stderr and a non-zero exit — this is the CORRECT behavior for an untrusted/empty
project (unlike the interactive Ctrl+E path in step 7, the headless CLI driver
explicitly checks the accepted page count itself and reports a refusal rather than
hanging — see `src/entrypoint/model/run-export.ts`'s own "ZERO-PAGES POST-ACCEPT
CHECK" comment). A `Cannot find package`/`Cannot find module`/`Failed to resolve`
string, by contrast, is a real module-resolution failure.

### Automated confirmation (optional but recommended)

With `termcraft` still on `PATH` from the install above, from the repository:

```
bun test src/entrypoint/model/installed-package.test.ts
```

**Expected:** `2 pass, 0 fail, 0 skip`. This is the same oracle phase-8's exit
criterion 2 requires; running it here re-confirms the install before you rely on it
for the rest of this walkthrough. If it reports `2 skip` instead, `termcraft` was not
actually found on `PATH` when the test file loaded (module-level `Bun.which`
check) — re-verify the install above.

### Uninstall (cleanup)

From a scratch directory (not the repository root — see the hazard above):

```
bun remove -g termcraft
```

---

## What to capture on any failure, in either mode

1. **The failing step number** from this document.
2. **The exact on-screen text** — chat panel, status bar, or error panel, verbatim.
   Screenshots are fine if you cannot copy text out of the terminal.
3. **The relevant log**, if you have filesystem access to the project directory:
   - `.termcraft/turns/<turnId>/` — the staged workspace and candidate for a
     generation-turn failure (step 4/5).
   - `.termcraft/export/` — `current.json` and the `generations/` tree for an export
     failure (step 7).
   - stderr from the terminal itself, for a launch or module-resolution failure
     (step 1, or anywhere in the installed-package section).
4. Whether the failure matches one of this document's six documented "Known
   limitation" callouts (steps 2, 3, 5, 6, 7, 9) — if it does, it is expected, not a
   new bug, and does not need separate investigation.
