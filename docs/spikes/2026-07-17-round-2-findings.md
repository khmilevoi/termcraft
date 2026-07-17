# Architecture spike findings — round 2 — 2026-07-17

Consolidates the six probes that re-gate specific subsystems the specs assert with
confidence but no evidence, per
`docs/superpowers/plans/2026-07-17-architecture-spikes-round-2.md`. Each spike's full
evidence, with verbatim command output, lives beside its probe code in
`docs/spikes/0N-*/FINDINGS.md`. This document is the synthesis.

**Source anchors:** `docs/spikes/04-reatom-opentui/FINDINGS.md`,
`docs/spikes/05-host-respawn/FINDINGS.md`, `docs/spikes/06-win-fs-identity/FINDINGS.md`,
`docs/spikes/07-durability-primitive/FINDINGS.md`,
`docs/spikes/08-agent-confinement/FINDINGS.md`, `docs/spikes/09-process-tree/FINDINGS.md`,
`package.json`, `bun.lock`.

---

## The call: six subsystems, six separate clearances — no whole-project verdict

Unlike round 1, this round gates six independent subsystems, not the MVP as a whole. Five
spikes ran to a definite answer; one (Codex's half of Spike H) is blocked on an external
account-quota reset, not on anything this repo controls.

| Spike | Question | Verdict |
| --- | --- | --- |
| D | Reatom v1001 through OpenTUI's React reconciler | `YES-WITH-FALLBACK` |
| E | Compiled-binary self-respawn and framed stdio | `YES` |
| F | Windows file identity and link detection | identity `YES`, links `PARTIAL` |
| G | The Windows durability primitive (§4.2 step 5) | `YES` |
| H | Agent backend confinement on Windows | Codex `BLOCKED`, Claude `YES` |
| I | Owned process tree and confirmed exit | `YES` (graceful path); crash-recovery confirmation open |

No spike returned an outright `NO`. Every named mechanism works from Bun on Windows without
a native addon. Three spikes surfaced real, load-bearing nuances that the specs did not
anticipate: a test-harness gotcha that would have made every future `reatomComponent` test
fail silently (Spike D), an access-flag requirement undocumented by Microsoft that makes the
directory-flush primitive fail if copied from the plan's own pseudocode verbatim (Spike G),
and a crash-recovery confirmation gap for process-tree exit that no amount of implementation
effort closes without a further design decision (Spike I).

---

## Spike D — Reatom v1001 through OpenTUI's React reconciler

**Question.** Does `reatomComponent` from `@reatom/react@1001.0.0` drive re-renders through
OpenTUI's own React reconciler — not `react-dom` — inside a `bun build --compile` binary on
Windows; and do `wrap`, `withAsync`, and `withConnectHook` behave as the vendored v1001
handbook describes?

**Verdict: `YES-WITH-FALLBACK`.**

**The adapter works.** Mounted through the real production API
(`@opentui/react`'s `createRoot` on a `createCliRenderer` instance, bypassing any test
harness), a plain `atom.set()` reached the rendered frame immediately, with no special
handling, identically in `bun run` and a compiled `--compile` binary on Windows.
`react-dom` is never imported anywhere in the dependency chain — confirmed across every run
— and its `peerDependencies` entry on `@reatom/react` is a types-only artifact, the same
shape as a round 1 finding. `wrap`, `withAsync`, and `withConnectHook` all behaved as
documented once given a correctly-flushed render pass.

**The `-WITH-FALLBACK` is a test-infrastructure trap, not an adapter defect.** Round 1's
proven headless harness (`createTestRenderer`, wired through `@opentui/react/test-utils`'s
`testRender`) runs the whole mounted tree inside React's "act environment." In that mode,
Reatom-originated writes — always async, scheduled off a microtask, never inside a React
event handler — sit un-flushed forever unless the test explicitly wraps them in `act()` from
`'react'`. Neither the harness's own `flush()` nor `@opentui/react`'s exported `flushSync`
substitutes. The first run, scripted exactly as the brief specified with no `act()`, gave a
literal `NO` (`frame1` unchanged after `counter.set(1)`) — root-caused via temporary,
uncommitted `node_modules` instrumentation to a reconciler that legitimately never re-invoked
the component's render function outside `act()`, then confirmed as a harness artifact, not an
adapter defect, by the production-path probe above.

**A second, unrelated finding:** a Reatom+OpenTUI process does not exit on its own after
`renderer.destroy()` — an explicit `process.exit()` is required. Immaterial for a long-lived
interactive kernel process; material for any one-shot render or test-runner child process.

**Consequences for implementation:**

1. Anyone writing automated tests against a `reatomComponent`-based OpenTUI screen — which
   `kernel-command-contract-design.md` §6 requires for the Kernel's model layer — must import
   and use `act()` from `'react'` themselves. Nothing in either spec said so before this
   spike; it now does (§6, amended).
2. Trace names are observable at runtime, but not through the typed `__reatom` meta object
   (which does not carry a `name` field) — through the atom's own `.name`/`.toString()`
   instead, both confirmed to survive `bun build --compile` unmangled.
3. `context.start` exists exactly as `kernel-command-contract-design.md` §6 assumes and is
   callable.
4. The root `package.json` was missing `@reatom/react` entirely — landed as part of this
   synthesis (see "Root package.json" below).

---

## Spike E — self-respawn and framed stdio

**Question.** Can a `bun build --compile` binary spawn *itself* with argv
`[_host, --stdio]` on Windows, and exchange length-prefixed binary frames over that child's
stdio without corruption?

**Verdict: `YES`.** `process.execPath` inside the compiled binary named the real on-disk
`.exe` path on the first try — no fallback (`argv[0]`, `Bun.main`,
`GetModuleFileNameW`) was needed. This is the mirror image of round 1's finding that
`uv_spawn` cannot execute an embedded `B:/~BUN/root/…` path for a *different* mechanism;
here the embedded-namespace failure mode simply did not reproduce.

**Framing survives Windows stdio, including at the one place corruption could occur.** JSON
string escaping means a raw `0x0A`/`0x0D` byte can never appear in a frame body — the probe
was extended to deliberately force those bytes into the 4-byte binary length *header*
instead (the only place they can occur on the wire), at both a 256 KiB and a 1-byte payload
size, sent back-to-back. Both round-tripped byte-for-byte. Frames did arrive split across
multiple stdio `"data"` events (5 events for 3 logical frames under load) — the buffering
frame reader is load-bearing, not defensive.

**Negotiation timing:** 135–178 ms across three cold compiled runs (up to 1003 ms under the
CPU contention of six parallel spikes sharing the machine) — comfortable headroom against the
spec's 3-second deadline, but this probe carries none of the real host's weight (OpenTUI's
native core, Reatom, the rest of the dependency graph); production negotiation time is
unmeasured and will be higher.

**Consequences for implementation:** `process.execPath` is correct only inside the compiled
product; under `bun run` it resolves to the Bun CLI itself and makes Bun try to run `_host`
as a script name. Any dev-mode code path needs to branch on this rather than assume
`process.execPath` behaves the same way in both contexts.

---

## Spike F — Windows file identity and link detection

**Question.** Can Bun's `fs` API on Windows read a stable volume-serial + file-id pair for a
directory, and reliably distinguish a symlink, an NTFS junction, a reparse point, and a
hardlink from an ordinary file, without a native addon?

**Verdict-identity: `YES`. Verdict-links: `PARTIAL`.**

**Identity is solid.** `fs.statSync(dir, { bigint: true })`'s `dev` matches the OS volume
serial byte-for-byte at exactly 8 hex digits, as `production-storage-identity-design.md` §8
specifies. `ino` was stable across re-stat, a file created inside the directory, a genuinely
separate process, and — directly testing §11's claim — `git init`, two commits, a branch
checkout, and an editor-style atomic rewrite. None of them moved the directory's identity.
One clarification needed: §8's worked example encodes a 16-byte (ReFS-width) file id, but
plain `stat()` on NTFS (the only filesystem tested) never produces more than ~7-8 bytes —
the encoding is correct as a variable-length hex field, but the example implied a fixed width
that plain `stat()` cannot produce.

**The links story is better than the brief's working hypothesis, but incomplete.**
`lstatSync(junction).isSymbolicLink()` returned `true` — junctions ARE caught, because
libuv's Windows `stat`/`lstat` maps both `IO_REPARSE_TAG_MOUNT_POINT` and
`IO_REPARSE_TAG_SYMLINK` to `S_IFLNK`. But this is an implementation detail of libuv's tag
mapping, not a documented guarantee for every reparse-point kind (cloud-file placeholders,
WSL interop links, and others were not available to test). Real NTFS symlink creation
(`mklink /D`) could not be tested at all — it failed with a privilege error in the spike's
non-elevated, non-Developer-Mode shell, and escalating was correctly refused by the agent
sandbox as a system-wide registry change outside a spike's scope. That case is marked
untested, not fabricated. Hardlinks are only weakly detectable (`nlink > 1`, with no API
naming the other linked path).

**The escape check was verified directly.** A naive `join(root, rel)` does **not** catch a
junction planted inside the root and pointing outside it — the joined path string still
looks contained. `realpathSync` on the resolved path, compared against `realpathSync` of the
root itself, correctly catches it.

**Consequences for implementation:** `SafeProjectFs`'s no-follow parent check needs the
tag-agnostic `GetFileAttributesW` + `FILE_ATTRIBUTE_REPARSE_POINT` fallback via `bun:ffi`
named explicitly, not `isSymbolicLink()` alone, to cover reparse-point kinds this spike
could not test.

---

## Spike G — the durability primitive

**Question.** Can `turn-durability-staging-design.md` §4.2's six-step install sequence be
executed on Windows with Bun's APIs — specifically step 5, "flush the parent directory (or
the Windows write-through equivalent)" — and at what per-file latency?

**Verdict: `YES`.** **Dir-flush mechanism:** `CreateFileW(FILE_FLAG_BACKUP_SEMANTICS,
GENERIC_WRITE)` + `FlushFileBuffers`, via `bun:ffi` against `kernel32.dll`. **Latency:**
median 18.9 ms, worst 63.4 ms per full six-step install of a 4 KiB file (20 iterations).

**An undocumented access-flag requirement, found empirically, not from Microsoft's own
docs.** The brief's own pseudocode used `GENERIC_READ`, matching the intuition that a flush
is a read-adjacent operation. Tried exactly as given, `CreateFileW` succeeds but the
following `FlushFileBuffers` call fails with `ERROR_ACCESS_DENIED`. A four-way probe
isolated the cause: only `GENERIC_WRITE` **alone** makes `FlushFileBuffers` succeed on a
directory handle; combining it with `GENERIC_READ` reintroduces the failure. Any
implementation copying the plan's original pseudocode verbatim would have shipped a primitive
that always fails.

**Not a cheap primitive.** 19 ms median is directory-flush-dominated, not file-write cost
(the 4 KiB write and file-level `fsync` are sub-millisecond). §4.3's apply loop pays this
~20 times per transaction (`plan.json`, `intent.json`, every payload, every applied marker,
`committed.json`), implying **~380 ms** of pure flush latency for a ten-operation
transaction — a real, user-visible cost, the same order of magnitude as a network round trip.

**Unsupported volumes are detectable before mutation is trusted durable**, tested against a
real SMB share (the Windows loopback admin share, confirmed via `GetDriveTypeW` reporting
`DRIVE_REMOTE`). The dangerous case the brief worried about — everything succeeding
silently — did **not** occur: the ordinary create/write/rename sequence succeeds unremarkably
on the share, but `FlushFileBuffers` on the directory handle fails distinctly
(`ERROR_INVALID_FUNCTION`, a different code from the local-volume `GENERIC_READ` mistake
above). A probe that only exercised steps 1-4 would wrongly conclude the volume is supported;
the flush step is where detection actually happens.

**Residual gap, recorded not closed:** Windows has no `O_NOFOLLOW` in Bun/Node's
`fs.constants`; step 3/6's "reopen without following links" is approximated with
`lstatSync` immediately before an ordinary open, leaving a narrow TOCTOU window a true atomic
open would not have.

---

## Spike H — agent backend confinement on Windows

**Question.** Does Codex's `workspace-write` sandbox actually silently downgrade to
read-only on Windows, detectably before a real turn runs? Does the Claude Agent SDK's
per-call permission callback give an in-process veto on every tool use, as claimed?

**Verdict-codex: `BLOCKED`. Verdict-claude: `YES`.**

**Claude: confirmed accurate, under real attack, not just the happy path.** A deny-everything
`canUseTool` callback fired before every one of 6 tool-use attempts across 5 cases — an
in-staging write, an absolute path outside staging, a `../`-relative escape, a `Bash` call,
and a `WebFetch` call — and every denial held. The SDK's own independent
`permission_denials` audit trail in the final result message corroborated the callback's own
log in every case, and a post-hoc filesystem check found nothing written anywhere. Identical
results in `bun run` and a `bun build --compile` binary.

**Codex: blocked on an account-level usage-quota exhaustion, not a probe defect.** The
write-probe mechanism (isolated scratch dir per sandbox mode, one write-only task, filesystem
inspection rather than trusting the transcript) ran to completion for all three sandbox modes
without crashing and reached the OpenAI API — every turn failed with the *same* "usage limit"
error, reproduced independently through the raw globally-installed CLI outside the SDK,
confirming it is not an SDK or probe artifact. Stated recovery: 2026-07-23 16:36. The claim
remains genuinely unverified either way; re-running `bun run src/codex.ts` after quota resets
requires no code changes.

**A related, positive finding:** `@openai/codex-sdk` exposes no health/status method at all
— only `sandboxMode` on `ThreadOptions`. A filesystem write-probe is confirmed to be the
*only* route to `healthCheck()`'s "sandbox effective?" question for Codex, not one option
among several.

**Framing, per the design's own words:** confinement is defense-in-depth, not the load-bearing
wall — correctness comes from the gate only accepting what landed in staging and validated.
The Codex block does not sink the architecture; it means §9's Codex-specific health-check
error copy is unverified until re-run.

---

## Spike I — owned process tree and confirmed exit

**Question.** Can termcraft place a child process in an owned process tree on Windows (a Job
Object with kill-on-close) and obtain OS confirmation that no owned descendant remains, from
Bun, without a native addon?

**Verdict: `YES`,** for the case the design's §6.5 sequence actually covers (application-driven
cancellation). **Mechanism:** Job Object via `bun:ffi` against `kernel32.dll`
(`CreateJobObjectW` + `SetInformationJobObject`/`KILL_ON_JOB_CLOSE` +
`AssignProcessToJobObject`), tested against a synthetic three-level tree that ignores
`SIGTERM` and spawns `detached: true` descendants specifically to defeat naive approaches.
**Confirmation:** `QueryInformationJobObject`/`JobObjectBasicAccountingInformation.
ActiveProcesses` — a genuine OS read, not PID-liveness polling — went from 3 to 0 in 0-1 ms
after `TerminateJobObject` in every trial, well inside §6.5's 5-second budgets.

**An ordering hazard exists and is not OS-closed.** `CREATE_SUSPENDED` is unreachable from
Bun/Node, so `AssignProcessToJobObject` can only run after `spawn()` returns — racing the
child spawning its own descendant. The race was won in 4/4 trials because Bun's interpreter
startup cost (200-750 ms) dwarfs the JS-side assignment call (single-digit-to-tens of ms),
but this is empirical headroom, not a guarantee; a faster-starting child (a warm native
binary, not cold Bun/TS) could in principle spawn before assignment completes.

**An open gap for the crash-recovery case, distinct from the case above.** Kill-on-close
firing because the controller itself crashed (bare `CloseHandle`, no application code
involved) still kills the tree correctly — verified directly — but by construction nobody
holds a job handle afterward to read `ActiveProcesses` from. The only fallback available is
the same PID-liveness polling this whole design exists to avoid, because Windows reuses PIDs.
This spike could not resolve it; it needs either a named-job-object reopen strategy or a
permanently-running supervisor holding an independent handle, and that is its own spike.
`backend_unhealthy_unconfirmed_exit` is a real, not theoretical, possible outcome of the
crash-recovery path specifically (amended into §6.5).

**A fallback-mechanism finding, not a change to the primary recommendation:** `taskkill /T
/F` reached every level of the synthetic tree, including both `detached: true` descendants —
contrary to the brief's a-priori assumption that `detached` breaks the parent-child link
`taskkill` walks. Windows' `detached` does not sever the OS-recorded parent PID the way
POSIX `setsid()` does.

---

## Root `package.json`

Spike D's delta named five runtime dependencies the root manifest needed; four were already
present from round 1 (`@reatom/core`, `@opentui/core`, `@opentui/react`, `react`). Only
**`@reatom/react@1001.0.0`** was actually missing — added at the exact version Spike D's
lockfile resolved, `bun install` re-run, no peer-dependency warning printed (Bun 1.3.14 does
not surface unmet-peer warnings the way npm does; the underlying `react-dom` peer on
`@reatom/react` is confirmed spurious — see Spike D). `react-dom` was **not** added, per
Spike D's explicit finding that it is never imported anywhere in the chain.

---

## Amendments landed

| # | Spec / section | Status | What changed |
| --- | --- | --- | --- |
| 1 | `kernel-command-contract-design.md` §6 | **Stale sentence, now false** | Replaced the "at design time this repository has no package.json…" sentence with the verified provider, versions, act-environment test gotcha, and trace-name/`context.start` confirmation. |
| 2 | `2026-07-13-termcraft-design.md` §5.1 | **Underspecified** | Named `@reatom/react@1001.0.0` as `reatomComponent`'s real provider and cited the OpenTUI-reconciler verification. |
| 3 | `production-hardening-decisions-design.md` §3.8 | **Underspecified** | Same clarification for the facade's `reatomComponent` re-export. |
| 4 | `host-supervision-protocol-design.md` §6 step 1 | **Underspecified** | Named `process.execPath` as the verified self-identification value inside the compiled binary, and flagged Windows stdio frame-splitting as a normal case the reader must handle, not a defensive edge case. |
| 5 | `production-storage-identity-design.md` §8 | **Example implied a width the implementation can't produce** | Added a clarifying sentence: the file-id half is variable-length; the worked example's 16-byte value is illustrative (ReFS-width), not what plain `stat()` on NTFS produces (≤8 bytes). No format change. |
| 6 | `production-storage-identity-design.md` §3.4 (no-follow parent check) | **Gap named** | Required `GetFileAttributesW` + `FILE_ATTRIBUTE_REPARSE_POINT` as the tag-agnostic backstop, not `isSymbolicLink()` alone; documented the verified `realpathSync`-based escape check. |
| 7 | `turn-durability-staging-design.md` §4.2 step 5 | **Parenthetical resolved** | Named the exact mechanism (`CreateFileW(FILE_FLAG_BACKUP_SEMANTICS, GENERIC_WRITE)` + `FlushFileBuffers`), the undocumented `GENERIC_WRITE`-only access-flag requirement, the ~19 ms / ~380 ms cost, the UNC-share detection story, and the `O_NOFOLLOW` TOCTOU gap. |
| 8 | `turn-durability-staging-design.md` §6.5 | **Gap named** | Confirmed the graceful-cancellation confirmation path (`QueryInformationJobObject`) as solid and fast; named the crash-recovery confirmation gap as unresolved and a real possible source of `unhealthy_unconfirmed_exit`; recorded the `taskkill /T` fallback finding. |
| 9 | `2026-07-13-termcraft-design.md` §6.1 | **Mixed: one confirmed, one unverified** | Recorded the Claude Agent SDK claim as verified under real attack; recorded the Codex claim as blocked on an external quota reset, not confirmed or refuted, and named the health-check implication (write-probe is the only route). |

No spec claim was invalidated outright — every named mechanism is implementable as written,
sometimes with an access flag, fallback mechanism, or scope clarification the original text
did not carry.

---

## Clearance by subsystem

- **Reatom model layer (`§5`, `kernel-command-contract-design.md` §6, all seven factories,
  every page model): Clear with amendments.** #1 and #2 above must land before code (they
  already have). The adapter is proven sound on the production render path; the only trap is
  a test-infrastructure one (`act()`), now documented.
- **Host supervision protocol (all of `host-supervision-protocol-design.md`): Clear with
  amendments.** #4 landed. Self-respawn and framed stdio both work exactly as designed on
  Windows.
- **Storage identity and `SafeProjectFs` (`production-storage-identity-design.md` §8,
  §3.4/§7): Clear with amendments.** #5 and #6 landed. The trust-key encoding is sound; the
  no-follow check needs the named FFI backstop before it can claim full reparse-point
  coverage, and real-symlink behavior remains unconfirmed pending an elevated test
  environment — flagged, not blocking.
- **Turn durability (`turn-durability-staging-design.md`, all of it): Clear with
  amendments.** #7 landed. The primitive works and is well within the design's stated
  intent, but is materially more expensive than "instant" — Task 7 records this as a cost
  line implementers must design around, not a defect.
- **Process-tree cancellation (`turn-durability-staging-design.md` §6.5, master §6.1
  `cancel()`): Clear with amendments for the graceful path; blocked for the crash-recovery
  path.** #8 landed. `cancel(run)` as currently typed (resolves after confirmed process-tree
  exit) is fully implementable for the case it is actually called for. The crash-recovery
  confirmation gap is a real open design question that needs its own spike before
  `unhealthy_unconfirmed_exit`'s crash-path behavior can be considered specified, not just
  named.
- **Agent backend confinement (master §6.1, §9): Clear for Claude; blocked for Codex, but
  non-gating.** #9 landed. Confinement is explicitly defense-in-depth in the design's own
  words — the Codex block does not stop implementation of the backend abstraction, `AgentTask`
  contract, or the gate. It does mean the Codex-specific health-check error copy in §9 needs
  re-verification after 2026-07-23 before it can be trusted as accurate.

---

## What remains unknown

1. **Real NTFS symlinks on Windows**, as distinct from junctions, were never created or
   tested — blocked by the spike's non-elevated, non-Developer-Mode environment. Expected,
   not confirmed, to behave like junctions for both detection and escape-checking.
2. **Codex's Windows sandbox-downgrade claim** is neither confirmed nor refuted. Re-running
   `docs/spikes/08-agent-confinement/src/codex.ts` after the account's quota resets
   (2026-07-23 16:36) requires no code changes and should happen before §9's Codex error
   copy is trusted.
3. **Process-tree crash-recovery confirmation.** No read-based mechanism was found for
   confirming zero owned descendants after the controller itself crashes (as opposed to a
   graceful `cancel()`). This needs a dedicated follow-up spike (a named-job-object reopen
   strategy, or a permanently-running supervisor holding an independent handle) before
   `unhealthy_unconfirmed_exit`'s crash-path behavior is fully specified.
4. **ReFS.** Every filesystem-identity and durability result in this round was measured on
   NTFS only (confirmed via `Get-Volume`). The 128-bit `FILE_ID_INFO` path and any ReFS-specific
   durability behavior are unmeasured.
5. **An exhaustive "unverifiable write-through" filesystem matrix.** Spike G tested exactly
   one non-local filesystem (an SMB share via the Windows loopback admin share). §1's
   detection story is confirmed for that one case, not proven universal.
6. **Reparse-point kinds beyond junctions and symlinks** — cloud-file placeholders (OneDrive),
   WSL interop links, dedup, and app-execution aliases were not available to test. The named
   `GetFileAttributesW` fallback is expected, not proven, to catch all of them.
7. **Real negotiation time under the actual host's weight.** Spike E's 135-178 ms floor
   carries none of OpenTUI's native core, Reatom, or the rest of the dependency graph that
   the real host process will carry.
8. **A process that spawns faster than Bun's interpreter startup**, which would close the
   empirical headroom Spike I found in the Job-Object assignment race. Not reproduced in this
   round because every spawned process in the test was itself a cold Bun/TS module.
9. **Cross-platform anything.** Every probe in this round was built and run on Windows 11
   only, per the plan's constraint. macOS and Linux remain entirely unknown for all six
   subsystems.
