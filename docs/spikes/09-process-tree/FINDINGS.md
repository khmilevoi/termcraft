# Spike I — owned process tree and confirmed exit on Windows

## Question

Can termcraft place a child process in an owned process tree on Windows — a
Job Object with kill-on-close — and obtain **OS confirmation that no owned
descendant remains**, from Bun, without a native addon? `turn-durability-staging-design.md`
§6.5 requires this; §7.6 makes it load-bearing for data safety, not tidiness:
a turn workspace must not be reused/cleared until process-tree exit is
*confirmed*, not just attempted.

## Verdict: YES

**Mechanism:** Job Object created and configured via `bun:ffi` against
`kernel32.dll` — `CreateJobObjectW` + `SetInformationJobObject` with
`JobObjectExtendedLimitInformation` / `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`,
the top process assigned with `AssignProcessToJobObject`. Both the explicit
kill path (`TerminateJobObject`) and the crash-safety path (bare
`CloseHandle` with no explicit kill call) killed the entire synthetic
three-level tree, including two descendants the victim itself spawned with
`detached: true`.

**Confirmation:** `QueryInformationJobObject` with
`JobObjectBasicAccountingInformation`, reading the `ActiveProcesses` DWORD.
This is a genuine **read** of an OS-maintained count, not an inference from
polling PIDs — it went from `3` to `0` in 0–1ms after the kill in every
trial. **Caveat:** this read-based confirmation requires a live handle to
the job. In the crash-safety path (Step 4a-ii), where the controller's own
handle closing *is* what triggers the kill, there is by definition nobody
left holding a handle to read `ActiveProcesses` afterward — see "Open
question" below. `Confirmation:` for the explicit-kill path is solid;
for the crash-recovery path it is an unresolved design question, not a
solved one.

---

## Environment

- Windows 11 Pro 10.0.26200, x64
- Bun 1.3.14 (`bun.lock` in this directory pins `@types/bun` only; no other deps)
- Working directory: `docs/spikes/09-process-tree`

## Files

- `src/tree.ts` — synthetic three-level "badly-behaved" victim: ignores
  `SIGTERM`/`SIGINT`, and each level spawns the next with `detached: true`
  before staying alive via `setInterval`.
- `src/main.ts` — orchestrator: baseline, `taskkill /T /F`, Job Object via
  `bun:ffi` (explicit `TerminateJobObject` and bare `CloseHandle`), all with
  timestamped output.

## Step 3: Baseline (kill only the top child, no mechanism at all)

Spawned the tree, waited for all three PIDs to appear, killed **only** the
top-level `ChildProcess` via `.kill()`, waited 1.5s, checked liveness of all
three recorded PIDs.

**Result, consistent across 3 trials (2 interpreted + 1 compiled):**

```
spawned tree (depth:pid): [{"depth":0,"pid":3500},{"depth":1,"pid":32072},{"depth":2,"pid":31156}]
killing ONLY the top child via ChildProcess#kill() (default signal)
ChildProcess#kill() returned: true
after 1510ms, liveness by pid: [{"depth":0,"pid":3500,"alive":false},{"depth":1,"pid":32072,"alive":true},{"depth":2,"pid":31156,"alive":true}]
BASELINE SURVIVOR COUNT: 2 of 3 recorded pids
```

**Baseline survivor count: 2 of 3.** Not zero — the problem §6.5 exists to
solve is real on Windows: killing the top process leaves the orphaned
descendants running indefinitely (the `setInterval` keeps them alive past
the probe's own lifetime, as designed).

Side finding: the victim's `process.on('SIGTERM', () => {})` handler on the
**directly-killed top process** never mattered. `ChildProcess#kill()`
returned `true` and the top process died immediately every time, despite
having installed a no-op `SIGTERM` handler. Windows has no real POSIX
signal delivery; Node/Bun's `.kill()` on Windows terminates the target
process unconditionally, regardless of any handler the target process
installed. The problem §6.5 solves is entirely about **orphaned**
descendants that no longer have a live parent to call `.kill()` on — not
about signal-ignoring per se, which turned out to be moot on Windows for
any process still directly reachable.

## Step 4b: `taskkill /T /F /PID <top>` (no Job Object)

**Result, consistent across 3 trials (2 interpreted + 1 compiled):**

```
spawned tree (depth:pid): [{"depth":0,"pid":14916},{"depth":1,"pid":11920},{"depth":2,"pid":10852}]
running: taskkill /F /T /PID 14916
taskkill exit code: 0 (took 234ms)
taskkill output verbatim:
SUCCESS: The process with PID 10852 (child process of PID 11920) has been terminated.
SUCCESS: The process with PID 11920 (child process of PID 14916) has been terminated.
SUCCESS: The process with PID 14916 (child process of PID 14688) has been terminated.

after 745ms total, liveness by pid: [{"depth":0,"pid":14916,"alive":false},{"depth":1,"pid":11920,"alive":false},{"depth":2,"pid":10852,"alive":false}]
TASKKILL SURVIVOR COUNT: 0 of 3 recorded pids
```

**This contradicts the brief's a-priori assumption.** The brief expected
`detached: true` to "break the parent link — `taskkill /T` walks that
link" and fail to reach the detached grandchild. Empirically, across every
trial, `taskkill /T /F` reached **all three** levels, including both
descendants spawned with `detached: true`. The reason: on Windows, Node/Bun's
`detached` option does not set any creation flag that changes the OS-recorded
`InheritedFromUniqueProcessId` (the field `taskkill`/`ToolHelp32Snapshot`
walk to build the tree). `detached` on Windows primarily affects whether the
child keeps the parent's event loop alive (`.unref()`) and console/process-group
behavior — it is not POSIX `setsid()` and does not sever the OS-level
parent-child record. `taskkill /T` walked it successfully every time.

**Untested caveat, documented but not exercised:** `taskkill /T`'s tree walk
is known to be unreliable when an *intermediate* process in the chain has
already exited before `taskkill` runs (its `InheritedFromUniqueProcessId`
slot can be reused by an unrelated process with the same PID, corrupting the
walk for anything further down). Our test always ran `taskkill` while the
whole chain was still alive, so this specific failure mode — distinct from
the `detached` question we did test — was not directly reproduced here.

## Step 4a: Job Object via `bun:ffi`, explicit `TerminateJobObject`

Loaded `kernel32.${suffix}` with `dlopen`, all eight symbols resolved with no
error. Built `JOBOBJECT_EXTENDED_LIMIT_INFORMATION` by hand as a 144-byte
`Uint8Array`:

| Offset | Field | Size |
|---|---|---|
| 0 | `PerProcessUserTimeLimit` | 8 |
| 8 | `PerJobUserTimeLimit` | 8 |
| 16 | **`LimitFlags`** (only non-zero field: `0x2000` = `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`) | 4 |
| 20 | padding | 4 |
| 24 | `MinimumWorkingSetSize` | 8 |
| 32 | `MaximumWorkingSetSize` | 8 |
| 40 | `ActiveProcessLimit` | 4 |
| 44 | padding | 4 |
| 48 | `Affinity` | 8 |
| 56 | `PriorityClass` | 4 |
| 60 | `SchedulingClass` | 4 |
| 64 | `IoInfo` (`IO_COUNTERS`, 6x`UINT64`) | 48 |
| 112 | `ProcessMemoryLimit` | 8 |
| 120 | `JobMemoryLimit` | 8 |
| 128 | `PeakProcessMemoryUsed` | 8 |
| 136 | `PeakJobMemoryUsed` | 8 |

Total 144 bytes, matching the brief's stated size. Verified by hand-deriving
offsets from the documented `winnt.h` field order under x64 alignment rules
(each field aligned to its own size; struct padded to an 8-byte multiple),
then empirically confirmed: `SetInformationJobObject` returned `1`
(success) with `GetLastError() == 0` in every trial, and the kill-on-close
limit demonstrably worked (see below) — a wrong `LimitFlags` offset would
either have failed the call or silently set an unintended limit that would
not have produced correct kill behavior.

**Ordering-hazard result — the headline question.** Bun/Node's
`child_process.spawn` has no `CREATE_SUSPENDED` option, so the child starts
running immediately; `AssignProcessToJobObject` can only happen *after*
`spawn()` returns, via `OpenProcess(PROCESS_TERMINATE | PROCESS_SET_QUOTA, 0, pid)`
+ `AssignProcessToJobObject`. This is a genuine race against the child
spawning its own descendant. Timestamps from four independent trials
(interpreted x 3, compiled x 1):

| Trial | `spawn()` returns | `AssignProcessToJobObject` | tree fully spawned (3 pids on disk) |
|---|---|---|---|
| 1 | +39ms | +40ms | +657ms |
| 2 | +9ms | +10ms | +200ms |
| 3 | +18ms | +18ms | +749ms |
| compiled | +9ms | +9ms | +194ms |

The JS-side `OpenProcess` + `AssignProcessToJobObject` completed in
single-digit-to-tens of milliseconds every time — 5-20x faster than the
~200-750ms Bun cold-start took to reach the point where the child spawned
its own grandchild. The race was won in **every** trial (`ActiveProcesses`
read `3` before any kill, confirming all three levels, including both
`detached: true` descendants, ended up in the job). **But this margin is
empirical headroom from Bun's interpreter startup cost, not an OS
guarantee.** Nothing prevents a faster-starting child (a warm native binary,
not a cold Bun/TS module) from spawning its own descendant before the
parent's JS gets to call `AssignProcessToJobObject`. Without
`CREATE_SUSPENDED` (unreachable from Bun/Node), this ordering hazard cannot
be closed, only outrun.

**Step 4c (breakaway) — answered as a side effect of 4a, not independently
testable.** `JOB_OBJECT_LIMIT_BREAKAWAY_OK` was left unset (only
`KILL_ON_JOB_CLOSE` was requested), so breakaway should be disallowed. But
this was moot: `CREATE_BREAKAWAY_FROM_JOB` is a `CreateProcess` flag that
Bun's `child_process.spawn` does not expose at all, to any caller — not to
the probe, and not to the victim's own self-respawn (which also goes
through Bun's `spawn`). No code path exists, from Bun, for a spawned
descendant to opt out of its parent's job. `ActiveProcesses` reading `3`
before every kill (both depth-1 and depth-2, both spawned with
`detached: true`) is the direct evidence: job membership is inherited
unconditionally down the whole tree when nothing in the chain can request
breakaway.

**Confirmation result (Step 5, explicit-kill path):**

```
QueryInformationJobObject ActiveProcesses BEFORE kill: 3 (expect 3)
TerminateJobObject -> 1 GetLastError=0
QueryInformationJobObject ActiveProcesses reached 0 after 0ms (last read: 0)
cross-check via process.kill(pid,0): [...all alive:false...]
```

`ActiveProcesses` (from `JobObjectBasicAccountingInformation`) went `3 -> 0`
in **0-1ms** after `TerminateJobObject`, in every trial, both interpreted
and compiled. This is a direct OS read — the job object itself is
authoritative about its own membership count — not a PID-liveness
inference. Cross-checked against `process.kill(pid, 0)` per recorded PID,
which agreed every time, though the PID check is the *unsound* one (PIDs
are reused on Windows); the job-object read is what actually answers "no
owned descendant remains."

## Step 4a-ii: the real kill-on-close path (`CloseHandle`, no explicit kill)

The spec names "Job Object **with kill-on-close**" specifically —
`TerminateJobObject` above is an explicit, application-code-driven kill,
which is not what protects against a controller that crashes without
running any cleanup. This step tests that: assign the tree to a second job
configured identically, then simply `CloseHandle` the only handle, with no
call to `TerminateJobObject` at all.

```
second job: CreateJobObjectW handle=760, SetInformationJobObject -> 1
tree fully spawned: [...3 pids...] at +190ms
ActiveProcesses before CloseHandle: 3
closing the ONLY job handle, no TerminateJobObject call -- this is the real kill-on-close path
CloseHandle -> 1, GetLastError=0
kill-on-close: all pids dead (by liveness poll) after 0ms: [...all alive:false...]
```

**Kill-on-close works exactly as advertised**: closing the last handle to a
job configured with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, with zero
application code calling any kill API, terminated the entire owned tree —
both `detached: true` descendants included — within one 50ms poll interval,
consistent across interpreted and compiled runs.

**Open question this step surfaces but does not resolve.** Once
`CloseHandle` runs, the process no longer holds a job handle, so
`QueryInformationJobObject` is no longer available — confirmation for this
path had to fall back to `process.kill(pid, 0)` liveness polling, i.e. the
mechanism Step 2 explicitly flagged as unsound on Windows because PIDs get
reused. This matters because kill-on-close's entire value proposition is
protecting against the controller **crashing** — and a crashed controller
is, by construction, not around afterward to hold a handle for a read-based
confirmation. A supervisor that wants a genuine read after a crash would
need either: (a) an independent second handle to the same job — but that
changes *when* kill-on-close actually fires, since it fires on the last
handle closing, and a second live handle held by a supervisor would prevent
it from firing at all when the controller alone dies; or (b) a **named**
job object the supervisor can attempt to reopen after detecting the
controller's exit — racing the job kernel object's own teardown once its
handle count hits zero. This spike did not attempt to resolve which of
these (if either) is workable; it is flagged here as exactly the gap
`unhealthy_unconfirmed_exit` (§6.5) would need to cover for the
crash-recovery case, as distinct from the graceful-cancellation case, which
this spike answers cleanly via `TerminateJobObject` + `QueryInformationJobObject`.

## Step 6: compile and re-run

```
bun build --compile src/main.ts --outfile probe.exe
./probe.exe
```

Compiled successfully (`[593ms] compile probe.exe`, ~98MB). Running it
surfaced a **second, independent compiled-binary hazard**, distinct from
the FFI-in-a-binary risk Spike G was checking:

```
import.meta.dir: B:\~BUN\root
import.meta.dir-based treeScript exists? false (B:\~BUN\root/tree.ts)
usingCwdFallback=true, treeScript=C:\...\09-process-tree/src/tree.ts, exists=true
```

Inside a `bun build --compile` binary, `import.meta.dir` resolves to a
**virtual embedded path** (`B:\~BUN\root`), not a real directory on disk.
`src/tree.ts` is bundled *inside* the binary, not present as a loose file at
that virtual path, so a path built from `import.meta.dir` does not exist —
a separately spawned real `bun.exe` given that path silently fails to open
it (the child process starts, gets a real PID, then exits before writing
anything, because `stdio: "ignore"` swallowed its error). The orchestrator
was fixed to detect this (`existsSync` check) and fall back to
`process.cwd() + "/src/tree.ts"`, which works because the compiled probe is
always launched from the spike's own directory, where the real `tree.ts`
still exists on disk. **This is itself a finding**, separate from FFI: a
compiled `bun build --compile` binary cannot dynamically re-launch a sibling
source file it was bundled from — that reference has to be an externally
supplied real path, not anything derived from `import.meta.dir`.

Once that fallback was in place, every step above — baseline, `taskkill`,
Job Object assign/confirm/terminate, and bare-`CloseHandle` kill-on-close —
reproduced **identically** in the compiled binary, including the 0ms
`ActiveProcesses` confirmation timing. **No FFI-specific divergence between
interpreted and compiled was observed** in this spike (unlike whatever Spike
G found — the two were run independently per the brief's instruction not to
coordinate).

Note on `process.execPath` inside `main.ts`: the orchestrator never used
`process.execPath` to spawn the victim tree, specifically to sidestep this —
`process.execPath` inside a compiled binary is the standalone `probe.exe`
itself, which cannot interpret an arbitrary `.ts` path as a script. The
orchestrator spawns the victim via the literal command `"bun"` on `PATH`
instead, which is identical in both interpreted and compiled contexts.
`tree.ts`'s own self-respawn of its children still uses `process.execPath`
per the brief's exact code — that resolves correctly because `tree.ts`
itself is always run interpreted (by a real `bun.exe`), never compiled, so
`process.execPath` there is reliably `bun.exe`.

## Timing vs. the spec's three 5-second waits

§6.5 step 4 budgets "up to 5 seconds" for OS confirmation. Measured, for the
explicit-kill path: `AssignProcessToJobObject` completes in single-digit
milliseconds after spawn, and `QueryInformationJobObject` confirms
`ActiveProcesses == 0` in **0-1ms** after `TerminateJobObject`. The full
happy-path sequence (spawn -> assign -> tree alive -> kill -> confirmed-zero)
completed in well under one second in every trial — the spec's three
5-second budgets are a generous safety margin against slow/stuck processes,
not a binding constraint on the mechanism itself. For the kill-on-close
(crash-safety) path, wall-clock kill time was also sub-50ms (one poll
interval), but as noted above, no job-object read was available to time
against in that path — only PID-liveness polling was used, and is exactly
what the spec is trying to avoid relying on.

## Is §6.5 implementable as written, from Bun?

**Mostly yes, with one caveat and one open question:**

1. **The named mechanism works.** Job Object + kill-on-close, created and
   configured via `bun:ffi` against `kernel32`, requires no native addon.
2. **Confirmation is a genuine read**, not PID-polling, for the
   application-driven cancellation case (`cancel(run)` calling
   `TerminateJobObject` or equivalent, then `QueryInformationJobObject`).
   This is the case §6.1's `cancel(run): Promise<void>` and §7.6's
   "cancellation does not resolve pins... until process exit is confirmed"
   most directly describe, and it is fully implementable and fast.
3. **Caveat:** the assign-before-spawn ordering is not OS-guaranteed
   (`CREATE_SUSPENDED` is unreachable from Bun/Node). It held in 4/4 trials
   here because Bun's own interpreter startup cost dwarfs the JS-side
   assignment call, but an implementation should not treat "the child is in
   the job" as certain the instant `spawn()` returns — it should be
   verified (e.g. re-check `ActiveProcesses` matches the expected count)
   rather than assumed.
4. **Open question, not answered here:** for the crash-recovery case (the
   controller itself dies unexpectedly, kill-on-close fires with zero
   application code involved), this spike could not identify a read-based
   confirmation mechanism — only PID-liveness polling remained available,
   which is the unsound mechanism §6.5/§7.6 are trying to avoid depending
   on. If termcraft's real design needs confirmed cleanup after a
   controller crash (not just after a graceful `cancel()`), it needs either
   a named-job-object reopen strategy or a permanently-running supervisor
   holding an independent handle — and either approach needs its own spike,
   because in this one, `unhealthy_unconfirmed_exit` is a real possible
   outcome of the crash-recovery path, not just a theoretical edge case.
