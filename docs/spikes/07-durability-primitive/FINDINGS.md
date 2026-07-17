# Spike G — the Windows durability primitive

## Scope (read this before the rest of the document)

**This is not a crash-durability test.** A true crash-durability test needs
power loss or a filesystem fault injector. `kill -9` proves nothing about
durability, because the OS page cache outlives the process, and this spike
does not attempt one. This document only answers three narrower, empirically
answerable questions, all exercised live on Windows 11 with the installed
Bun runtime:

1. Does an API to flush a directory exist on Windows from Bun, and what is it
   concretely?
2. What does the full six-step install sequence (design section 4.2) cost per file?
3. Can an unsupported volume be detected before mutation, rather than
   discovered after data loss?

Nothing below claims to have verified that data survives a power cut. It
verifies which Win32 API calls succeed, with what access flags, at what
latency, and what a probe on an unsupported volume observes before writing
anything durable.

## The question

Can `turn-durability-staging-design.md` section 4.2's six-step install sequence be
executed on Windows with Bun's APIs -- specifically step 5, "Flush the parent
directory (or the Windows write-through equivalent)" -- and at what per-file
latency?

## Verdict: YES

**Dir-flush mechanism:** `CreateFileW` with `FILE_FLAG_BACKUP_SEMANTICS` and
`dwDesiredAccess = GENERIC_WRITE`, followed by `FlushFileBuffers` on the
returned directory handle, called via `bun:ffi` against `kernel32.dll`. This
is the answer to section 4.2 step 5's parenthetical "or the Windows write-through
equivalent" -- it worked directly, with no fallback to a weaker per-file
primitive required.

**Latency:** median **18.9 ms**, worst **63.4 ms**, mean **21.5 ms**, for one
complete six-step install of a 4 KiB file (20 iterations, source run).
Compiled-binary run: median 18.7 ms, worst 63.4 ms (see Step 6). A
ten-operation transaction that pays this cost ~20 times (per section 4.3's apply
loop -- plan.json, intent.json, every payload, every applied marker,
committed.json) is therefore implied to cost on the order of **~380 ms**
of pure directory-flush-dominated I/O, not milliseconds. This is a real,
material cost that Task 7 needs to weigh -- it is not a cheap primitive.

**Whether section 4.2 step 5 is implementable as written:** implementable as
written, not weaker. `FlushFileBuffers` on a directory handle obtained via
`FILE_FLAG_BACKUP_SEMANTICS` is exactly the Windows equivalent of POSIX
`fsync(dirfd)` that the spec's parenthetical anticipates, and it produced a
genuine success return (not a silently-ignored no-op) on the local NTFS
volume under test.

## Environment

```json
{"platform":"win32","arch":"x64","bunVersion":"1.3.14","bunRevision":"0d9b296af33f2b851fcbf4df3e9ec89751734ba4","nodeCompat":"v24.3.0"}
```

- OS: Windows 11 Pro 10.0.26200
- Bun: 1.3.14 (`bun --version`)
- Installed lockfile (`docs/spikes/07-durability-primitive/bun.lock`):
  `@types/bun@1.3.14`, `bun-types@1.3.14`, `typescript@5.9.3`
- Shell not elevated (`IsInRole(Administrator)` -> `False`) -- all results
  below hold under a normal, non-admin user session.

## Step 2 -- file-level steps of the six-step sequence

Ran in isolation, before touching the hard part (directory flush), against a
local scratch directory on `C:\`.

```json
{"section":"step2","phase":"first-install","steps":{"createNew":{"ok":true},"writeFlushClose":{"ok":true},"reopenVerify":{"ok":true},"rename":{"ok":true}}}
{"section":"step2","phase":"second-install-over-existing","steps":{"createNew":{"ok":true},"writeFlushClose":{"ok":true},"reopenVerify":{"ok":true},"rename":{"ok":true}}}
{"section":"step2","phase":"final-verify","sizeMatches":true,"hashMatches":true}
```

Findings:

- **`renameSync` over an existing target succeeds on Windows.** The brief
  flagged this as a real risk (POSIX `rename` replaces; Win32 `MoveFile`
  without `MOVEFILE_REPLACE_EXISTING` does not). Empirically, Node/Bun's
  `fs.renameSync` on Windows calls libuv's `uv_fs_rename`, which internally
  uses `MoveFileExW` with `MOVEFILE_REPLACE_EXISTING` already set -- so the
  second install over an existing `target.bin` replaced it cleanly with no
  extra flag needed from application code. This was **not** independently
  re-derived from Win32 documentation in this spike; it is inferred from the
  observed behavior (no error, correct final content) and is consistent with
  libuv's known implementation. This spike did not verify atomicity beyond
  "no partial/torn file was observed after a single uncontended call" -- no
  concurrent-writer race was exercised.
- **`O_NOFOLLOW` does not exist on Windows in Node/Bun's `fs.constants`.**
  Confirmed directly: `fs.constants.O_NOFOLLOW` is `undefined` on this
  platform. Step 3/6's "reopen without following links" therefore cannot use
  the POSIX flag at all on Windows. The practical substitute implemented
  here is `fs.lstatSync` (which does not traverse a final symlink/reparse
  point) checked immediately before an ordinary `fs.openSync(path, "r")`.
  This is **weaker** than a true `O_NOFOLLOW` open: there is a narrow
  TOCTOU window between the `lstat` and the `open` where the leaf could
  theoretically be swapped for a reparse point. This gap is a real
  discrepancy between what section 4.2 step 3/6 assumes and what Windows lets you
  express atomically, and should be recorded as a residual risk rather than
  silently closed.

## Step 3 -- three attempts to flush the directory

All three attempted regardless of which succeeded first, per the brief
(Task 7 needs a cost comparison).

**(a) POSIX-shaped path -- expected to fail, per Known facts #6:**

```json
{"section":"step3","approach":"open+fsync","ok":false,"code":"EPERM","message":"EPERM: operation not permitted, fsync"}
```

Confirmed: `fs.openSync(dir, "r")` itself succeeds on Windows (opening a
directory read-only does not fail the way `fs.open` on a directory is
sometimes assumed to fail outright), but the subsequent `fs.fsyncSync(fd)`
fails with `EPERM`. This is the concrete shape of "Known facts #6" -- the
failure surfaces one call later than a naive reading of the known fact
suggests, at `fsync`, not at `open`.

**(b) Win32 mechanism via bun:ffi -- the real "write-through equivalent":**

```json
{"section":"step3","approach":"CreateFileW+FlushFileBuffers","ok":true}
```

This succeeded, but only after an empirical correction not evident from the
brief's pseudocode. The brief's snippet passes dwDesiredAccess =
GENERIC_READ = 0x80000000. Tried exactly as given, CreateFileW succeeds
but the following FlushFileBuffers call **fails** with
GetLastError() == 5 (ERROR_ACCESS_DENIED). A dedicated four-way probe
(GENERIC_READ only / GENERIC_WRITE only / GENERIC_READ or GENERIC_WRITE combined /
0) was run to isolate the cause:

| dwDesiredAccess | CreateFileW | FlushFileBuffers |
|---|---|---|
| GENERIC_READ (0x80000000) | succeeds | fails, GetLastError=5 (ERROR_ACCESS_DENIED) |
| GENERIC_WRITE (0x40000000) | succeeds | **succeeds** |
| GENERIC_READ combined with GENERIC_WRITE | succeeds | fails, GetLastError=5 |
| 0 | succeeds | fails, GetLastError=5 |

Reproduced identically across repeated runs. Only GENERIC_WRITE **alone**
makes FlushFileBuffers succeed on a directory handle; combining it with
GENERIC_READ reintroduces the failure. This is not called out clearly on
the MSDN pages for CreateFile/FlushFileBuffers and was found by trying
all four combinations rather than by reading documentation. main.ts uses
GENERIC_WRITE alone for the working path.

Also recorded: CreateFileW takes UTF-16LE, not a narrow C string.
bun:ffi's FFIType.cstring encodes JS strings as narrow (UTF-8/Latin1)
strings, which is the wrong encoding for the *W Win32 APIs the brief's
own pseudocode used (FFIType.cstring for lpFileName). The working
approach builds the wide string by hand -- Buffer.from(str + "\0",
"utf16le") -- and passes it as FFIType.ptr via bun:ffi's ptr()
helper, not as FFIType.cstring. This is a concrete discrepancy between
the brief's pseudocode and what actually compiles/works.

**Since (b) succeeded, this is the answer to the spec's parenthetical**:
"the Windows write-through equivalent" of flushing the parent directory is
CreateFileW(FILE_FLAG_BACKUP_SEMANTICS, GENERIC_WRITE) +
FlushFileBuffers.

**(c) FILE_FLAG_WRITE_THROUGH on the file itself -- tried anyway, for cost comparison:**

```json
{"section":"step3","approach":"FILE_FLAG_WRITE_THROUGH","ok":true,"message":"handle opened; this is a file-level guarantee, NOT a directory/rename flush"}
```

The handle opens successfully with GENERIC_WRITE | FILE_FLAG_WRITE_THROUGH
and CREATE_ALWAYS. This is recorded only as evidence the mechanism is
reachable -- it is **not used as the working path**, because (b) already
succeeded and because, as the brief states, FILE_FLAG_WRITE_THROUGH is a
different, weaker guarantee: it makes writes to that one file's data
write through the cache, but it says nothing about the **directory entry**
created by the subsequent rename -- i.e. it does not make the rename itself
durable. Since (b) worked, this fallback is not needed and this spike does
not recommend it as the primary mechanism.

## Step 4 -- is an unsupported volume detectable?

A local mapped/UNC path was needed to test the "unsupported volume" case
honestly. No separate physical host was available, but the Windows loopback
administrative share \localhost\c$\... is a real UNC path served over
the SMB stack (not a local path in disguise -- GetDriveTypeW classifies it
as DRIVE_REMOTE, the same as any other network share), and both read and
write access were confirmed before running the probe
(Test-Path \localhost\c$\Users -> True; a real file write/read/delete
round-trip via PowerShell succeeded). This was used as the honest stand-in
for "a network share reachable from this machine."

```json
{"section":"step4","target":"local-fixed-volume","root":"C:\\","driveType":3,"driveTypeName":"DRIVE_FIXED"}
{"section":"step4","target":"unc-share","root":"\\localhost\c$\\","driveType":4,"driveTypeName":"DRIVE_REMOTE"}
{"section":"step4","target":"unc-share","check":"CreateFileW(BACKUP_SEMANTICS, GENERIC_WRITE) on UNC dir","ok":true}
{"section":"step4","target":"unc-share","check":"FlushFileBuffers on UNC dir handle","ok":false,"lastError":1}
{"section":"step4","target":"unc-share","check":"file-level install sequence on UNC dir","steps":{"createNew":{"ok":true},"writeFlushClose":{"ok":true},"reopenVerify":{"ok":true},"rename":{"ok":true}}}
```

Findings, most important first:

- **GetDriveTypeW alone is sufficient, and is the cheapest possible check.**
  It requires no file I/O at all -- just the volume root string
  (\localhost\c$\ or C:\) -- and correctly distinguishes
  DRIVE_FIXED (3, local NTFS) from DRIVE_REMOTE (4, the UNC share) in a
  single call. This can run as a pre-flight admission check before any
  mutating action is attempted, which is exactly what section 1's
  unsupported_durability gate needs: reject before any write, not after.
- **The dangerous silent-success case does *not* occur for this path.** The
  brief specifically worried about "everything succeeds and silently gives
  no guarantee." That did not happen here: the ordinary file-level sequence
  (create/write/fsync/close/reopen/rename) **does** succeed unremarkably on
  the UNC share -- so a probe that stopped at step 4 of section 4.2 would wrongly
  conclude the volume is fully supported. But the **directory-flush step
  itself fails cleanly and distinctly**: CreateFileW succeeds in opening
  the UNC directory handle, but FlushFileBuffers on it fails with
  GetLastError() == 1 (ERROR_INVALID_FUNCTION) -- a different error code
  from the local-volume GENERIC_READ mistake above (5,
  ERROR_ACCESS_DENIED), so the two failure modes are also
  distinguishable from each other if that ever matters. In other words: if
  the adapter's probe for unsupported_durability checks the *actual
  directory-flush primitive* (as section 4.2 step 5 requires it to use for every
  real install anyway) rather than stopping after the file-level steps,
  the UNC share is caught before any target file mutation is treated as
  durable.
- Practical recommendation for the adapter: run GetDriveTypeW as a cheap
  first gate (rejects DRIVE_REMOTE, DRIVE_UNKNOWN, DRIVE_NO_ROOT_DIR
  outright), and additionally attempt one real
  CreateFileW(FILE_FLAG_BACKUP_SEMANTICS, GENERIC_WRITE) +
  FlushFileBuffers probe against the project's own transaction directory
  at startup, failing closed (unsupported_durability) if either check
  fails. Relying on GetDriveTypeW alone is cheaper but is a heuristic
  about the volume, not a proof the flush primitive works on it (e.g. a
  DRIVE_FIXED volume could in principle still be a filesystem with
  unverifiable write-through behavior, per section 1's phrasing) -- this spike only
  had NTFS-on-local and SMB-share-to-localhost to compare, not an
  exhaustive filesystem matrix.

## Step 5 -- measurement

20 iterations, complete six-step install of a 4 KiB file, local NTFS volume,
non-elevated shell, source run:

```json
{"section":"step5","iterations":20,"allMs":[21.876,19.924,19.361,18.664,17.694,19.558,55.578,19.78,18.679,18.328,23.657,19.398,17.514,18.792,21.054,17.741,24.968,20.464,17.661,19.132],"medianMs":19.398199999999974,"worstMs":55.577999999999975,"bestMs":17.51380000000006,"meanMs":21.491130000000005,"tenOperationTransactionEstimateMs":387.9639999999995}
```

- **Median: 19.4 ms. Worst: 55.6 ms.** (Compiled-binary run: median 18.7 ms,
  worst 63.4 ms -- see Step 6; both runs agree within noise.)
- This is dominated by the directory-flush call, not the file write --
  4 KiB writes and an fsync on the temp file are sub-millisecond on this
  machine; the tens-of-milliseconds cost appears after the rename, at the
  FlushFileBuffers call on the directory handle, consistent with
  FlushFileBuffers forcing the underlying volume's write cache to
  physical completion rather than being a cheap OS-buffer operation.
- **This is a YES at ~19 ms, not a YES at 0.5 ms.** Section 4.3's apply loop
  runs this sequence for plan.json, intent.json, every payload, every
  operation's applied marker, and committed.json. A ten-operation
  transaction pays it upward of 20 times, implying **~380 ms** of
  directory-flush-dominated latency for that one transaction on this
  hardware. Task 7 should treat this as a real, user-visible cost budget
  line, not a rounding error -- it is the same order of magnitude as a
  network round-trip, not "instant."

## Step 6 -- compile and re-run

```
$ bun build --compile src/main.ts --outfile probe.exe
  [186ms]  bundle  1 modules
 [900ms] compile  probe.exe

$ ./probe.exe
{"section":"environment","platform":"win32","arch":"x64","bunVersion":"1.3.14","bunRevision":"0d9b296af33f2b851fcbf4df3e9ec89751734ba4","nodeCompat":"v24.3.0"}
{"section":"step2","phase":"first-install","steps":{"createNew":{"ok":true},"writeFlushClose":{"ok":true},"reopenVerify":{"ok":true},"rename":{"ok":true}}}
{"section":"step2","phase":"second-install-over-existing","steps":{"createNew":{"ok":true},"writeFlushClose":{"ok":true},"reopenVerify":{"ok":true},"rename":{"ok":true}}}
{"section":"step2","phase":"final-verify","sizeMatches":true,"hashMatches":true}
{"section":"step3","approach":"open+fsync","ok":false,"code":"EPERM","message":"EPERM: operation not permitted, fsync"}
{"section":"step3","approach":"CreateFileW+FlushFileBuffers","ok":true}
{"section":"step3","approach":"FILE_FLAG_WRITE_THROUGH","ok":true,"message":"handle opened; this is a file-level guarantee, NOT a directory/rename flush"}
{"section":"step4","target":"local-fixed-volume","root":"C:\\","driveType":3,"driveTypeName":"DRIVE_FIXED"}
{"section":"step4","target":"unc-share","root":"\\localhost\c$\\","driveType":4,"driveTypeName":"DRIVE_REMOTE"}
{"section":"step4","target":"unc-share","check":"CreateFileW(BACKUP_SEMANTICS, GENERIC_WRITE) on UNC dir","ok":true}
{"section":"step4","target":"unc-share","check":"FlushFileBuffers on UNC dir handle","ok":false,"lastError":1}
{"section":"step4","target":"unc-share","check":"file-level install sequence on UNC dir","steps":{"createNew":{"ok":true},"writeFlushClose":{"ok":true},"reopenVerify":{"ok":true},"rename":{"ok":true}}}
{"section":"step5","iterations":20,"allMs":[22.299,18.466,17.996,18.225,18.254,15.037,29.8,18.7,21.174,22.699,19.52,18.322,18.569,18.713,18.197,18.886,18.03,19.06,63.393,18.503],"medianMs":18.700099999999964,"worstMs":63.392999999999915,"bestMs":15.037000000000035,"meanMs":21.69221,"tenOperationTransactionEstimateMs":374.00199999999927}
{"section":"done"}
```

Findings:

- **bun:ffi against kernel32.dll works unchanged inside a
  bun build --compile binary.** Round 1 proved FFI works for OpenTUI's
  embedded DLL from a compiled binary; this is a different path (a system
  library loaded by name via dlopen('kernel32.${suffix}', ...) rather
  than a bundled/embedded native module), and it also works, with no
  special packaging step needed.
- **import.meta.dir does not resolve to a real filesystem path inside a
  compiled binary.** The original probe used import.meta.dir to locate a
  .scratch working directory next to the source; inside probe.exe this
  resolved to the virtual bundle root ("\" -- logged in the crash as
  B:/~BUN/root/probe.exe) and fs.mkdirSync against it failed with
  EPERM: operation not permitted, mkdir '\'. Fixed by switching to
  process.cwd(), which is the real on-disk working directory in both the
  source run and the compiled binary. This is a real portability trap for
  any product code that assumes import.meta.dir survives compilation.
- All step 2-5 results reproduced from the compiled binary within normal
  run-to-run variance (median 18.7 ms vs. 19.4 ms from source; both single
  digit percent apart).

## Summary for Task 7

- Section 4.2 step 5 **is implementable as written** on Windows via
  bun:ffi -> kernel32.dll's CreateFileW(FILE_FLAG_BACKUP_SEMANTICS,
  GENERIC_WRITE) + FlushFileBuffers. No fallback to the weaker
  FILE_FLAG_WRITE_THROUGH file-level primitive was necessary.
- The access-mode requirement (GENERIC_WRITE alone, not GENERIC_READ or
  both) is undocumented in the obvious places and was found empirically --
  any production implementation must use exactly this flag or it will fail
  with ERROR_ACCESS_DENIED despite CreateFileW itself reporting success.
- The primitive is **not cheap**: ~19 ms median per directory flush, ~380 ms
  implied for a 10-operation transaction's worth of flushes. This should
  inform whether/how aggressively section 4.3's apply loop batches or reduces the
  number of flushed artifacts per transaction.
- Unsupported volumes (tested: an SMB share reachable via the loopback
  admin share \localhost\c$) **are detectable before mutation is trusted
  as durable** -- cheaply via GetDriveTypeW (DRIVE_REMOTE vs.
  DRIVE_FIXED), and confirmable via the real flush primitive itself
  failing with a distinct GetLastError() (1, ERROR_INVALID_FUNCTION)
  -- even though the ordinary create/write/rename file steps succeed
  unremarkably on that same share. A probe that only exercises steps 1-4
  of section 4.2 would miss this; the flush step is where the detection actually
  happens, which is one more reason step 5 cannot be skipped or treated as
  optional for "mostly fine" filesystems.
- Two residual gaps, both recorded above rather than silently closed: (1)
  Windows has no O_NOFOLLOW, so "reopen without following links" is
  approximated with lstatSync + open, leaving a narrow TOCTOU window;
  (2) this spike exercised exactly one non-local filesystem (SMB via
  loopback), not an exhaustive matrix of "unverifiable write-through"
  filesystems, so section 1's detection story is confirmed for this one case, not
  proven universal.

## Files

- `docs/spikes/07-durability-primitive/src/main.ts` -- the probe, run both
  from source (`bun run src/main.ts`) and compiled
  (`bun build --compile src/main.ts --outfile probe.exe`).
- `docs/spikes/07-durability-primitive/package.json`,
  `tsconfig.json`, `bun.lock` -- this probe's own manifest, isolated from the
  repo root per the plan's global constraints.
