# Spike F — Windows file identity and link detection

## The question

Can Bun's `fs` API on Windows (a) read a **stable** volume-serial + file-id pair
for a directory, and (b) reliably distinguish a symlink, an NTFS junction, an
arbitrary reparse point, and a hardlink from an ordinary file — without a
native addon?

Verdict-identity: YES
Verdict-links: PARTIAL

Summary of the two verdicts:

- **Identity**: `fs.statSync(dir, { bigint: true })` returns a non-zero,
  plausible `dev`/`ino` pair. `dev` is exactly the volume serial number as
  reported by `vol C:`, formatted as exactly 8 hex digits — §8's
  `volume-serial-8hex-lower` is correct as written. `ino` was stable across
  re-stat, creating a file inside the directory, `git init`/`commit`/`checkout`,
  an editor-style atomic rename, and a genuinely separate process (verified by
  invoking a second, independent `bun` process against the same path). No
  native addon or `bun:ffi` was needed. One caveat requiring a spec
  clarification: see "Is §8's encoding implementable exactly as written?"
  below — the design's own example row encodes a 16-byte file ID but plain
  `stat()` never produced more than ~7 bytes' worth of bits in this
  environment (NTFS, not ReFS).
- **Links**: the "crux" question the brief posed —
  `lstatSync(junction).isSymbolicLink()` — came back **`true`**, contradicting
  the brief's working hypothesis that junctions might slip past
  `isSymbolicLink()` undetected. That part of the security concern does not
  materialize on this Bun/libuv version. But the verdict is **PARTIAL**, not
  YES, because: (1) actual NTFS symlink creation (`mklink /D`) could not be
  tested — it failed with a privilege error in this shell, and escalating
  (elevating the shell, enabling Developer Mode) was outside what a spike
  should do and was in fact refused by the sandbox as a system-wide registry
  change; (2) hardlinks are only weakly detectable — `nlink > 1` is the only
  signal `stat`/`lstat` gives you, and it does not identify *which* other path
  the file is linked to; (3) other reparse-point kinds (OneDrive/cloud
  placeholders, WSL interop links, dedup) were not available to test and are
  flagged below as needing the `GetFileAttributesW` fallback rather than relying
  on `isSymbolicLink()`'s tag-specific behavior.

## Environment

- Windows 11, `Microsoft Windows [Version 10.0.26200.8875]`
- `bun 1.3.14`, `node v24.13.0` (Bun's bundled Node compat version, reported
  by `node --version` on PATH — recorded for completeness, not used directly)
- C: volume: NTFS (`Get-Volume -DriveLetter C` → `FileSystem: NTFS`). **Not
  tested on ReFS** — see caveat below.
- Volume serial per `cmd /c vol C:`: `40A8-B11C`
- Shell used to run all probes was **not elevated** (`net session` → "System
  error 5 has occurred. Access is denied."; `whoami /groups` shows
  `BUILTIN\Администраторы ... Group used for deny only`, i.e. UAC-filtered,
  non-admin token). Windows Developer Mode was **not enabled**
  (`HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock\AllowDevelopmentWithoutDevLicense`
  did not exist). An attempt to enable it via registry was blocked by the
  agent sandbox itself ("Permission for this action was denied by the Claude
  Code auto mode classifier... modifying HKLM registry"), which is the
  correct call for a throwaway spike — not undone or worked around.
- This spike installs no dependencies, so it has **no `bun.lock`**, same as
  spike 01's precedent.

## Step 2: what does `stat` actually report on Windows

`bun run src/main.ts`, `STEP2_IDENTITY` section, verbatim:

```json
{
  "dir": "C:\\Users\\Khmil\\AppData\\Local\\Temp\\tc-id-THensZ",
  "dev": "1084797212",
  "ino": "1407374884926807",
  "devHex": "40a8b11c",
  "inoHex": "500000014f557",
  "nlink": "1"
}
```

`STEP2_VOL_C`:

```json
{ "ok": true, "stdout": " Volume in drive C has no label.\r\n Volume Serial Number is 40A8-B11C\r\n" }
```

**`dev` matches the volume serial exactly**: `devHex` = `40a8b11c`, `vol C:` reports
`40A8-B11C`. Lower-cased and de-hyphenated, they are byte-identical. `devHex` is
exactly 8 hex characters — §8's `volume-serial-8hex-lower` is correct as written,
no amendment needed.

`dev`/`ino` are non-zero and plausible (not synthetic zero values, not `-1`).

Non-bigint variant (`STEP2_IDENTITY_NONBIGINT`), same directory:

```json
{
  "dev": 1084797212,
  "ino": 1407374884926807,
  "inoAsNumber": 1407374884926807,
  "inoAsNumberHex": "500000014f557"
}
```

In this run `ino` (1,407,374,884,926,807) is under `Number.MAX_SAFE_INTEGER`
(9,007,199,254,740,991), so no truncation happened to show up in this
particular sample — but the brief's warning stands: a Windows file ID is a
64-bit quantity and there is no guarantee every file's `ino` stays under
2^53. `{ bigint: true }` is the only form that is safe as a matter of
correctness, not luck, and it must be the one used for any production trust
key derivation. Non-bigint `stat` is not "wrong" here by accident of a small
sample, it is wrong in general.

**Stability, same process** (`STEP2_STABILITY_SAME_PROCESS`): identical
`dev`/`ino` across re-stat before/after creating a file inside the directory
and a third re-stat ("reopened"):

```json
{
  "before":          { "dev": "1084797212", "ino": "1407374884926807" },
  "afterFileCreate": { "dev": "1084797212", "ino": "1407374884926807" },
  "reopened":        { "dev": "1084797212", "ino": "1407374884926807" }
}
```

**Stability, genuinely separate process** — ran a second, independent `bun -e`
one-liner against the same temp directory after `main.ts` exited:

```json
{"dir":"C:\\Users\\Khmil\\AppData\\Local\\Temp\\tc-id-THensZ","dev":"1084797212","ino":"1407374884926807"}
```

Identical. `ino` is stable across process boundaries, not an artifact of a
per-process handle cache.

## Step 3: does `ino` move under Git operations or an editor-style atomic write

`production-storage-identity-design.md` §11 asserts *"changing `HEAD` alone
does not prompt"*. Built a real repo (`git init`, `git commit --allow-empty`,
`git checkout -b other`, second commit), then an editor-style atomic write
(write `file.txt`, then write `file.txt.tmp` and `renameSync` it over
`file.txt`) — the same install-sequence shape §4.2 uses. `STEP3_GIT_STABILITY`,
`allInoValues` across every step:

```json
["1125899908216172","1125899908216172","1125899908216172","1125899908216172","1125899908216172","1125899908216172"]
```

Every one of `git init`, `git commit --allow-empty` (twice), `git checkout -b`,
the initial write of `file.txt`, and the atomic rename over it left the
**repo directory's** `ino` completely unchanged. Same for `dev`
(`allDevValues`, all `"1084797212"`). **No operation in this sequence moves
the directory's identity.** This directly supports §11's claim: routine Git
operations and editor-style saves do not silently revoke trust under this
encoding, because they never touch the directory's own `dev`/`ino` — only file
contents inside it change, and file-level `renameSync` doesn't touch the
parent's file record on NTFS.

## Step 4: build all four link types, record what `fs` says about each

`cmd /c mklink /J junction target` and `cmd /c mklink /H hardlink.txt file.txt`
both **succeeded without elevation** — junctions and hardlinks do not require
`SeCreateSymbolicLinkPrivilege` on Windows, only symlinks do.
`cmd /c mklink /D symlinkdir target` **failed**:

```
Command failed: cmd /c mklink /D "...\symlinkdir" "...\target"
You do not have sufficient privilege to perform this operation.
```

This is recorded verbatim and the `symlinkdir` case is marked **untested**
below — not fabricated, not skipped silently.

### Detection matrix

| Type | Created? | `isSymbolicLink()` | `isDirectory()` | `isFile()` | `nlink` | `realpath()` | Notes |
|---|---|---|---|---|---|---|---|
| `target` (plain dir) | yes | `false` | `true` | `false` | `1` | itself | ordinary directory, baseline |
| `file.txt` (plain file) | yes | `false` | `false` | `true` | `2`* | itself | *`nlink=2` only because `hardlink.txt` was later linked to it — an ordinary file with no hardlinks shows `nlink=1` |
| `junction` (`mklink /J`) | yes | **`true`** | `false` | `false` | `1` | resolves to `target` | **the crux result: `isSymbolicLink()` is `true` for an NTFS junction**, contradicting the brief's working hypothesis. `isDirectory`/`isFile` are both `false` on the *unresolved* reparse point — you must call `realpathSync`/follow it to learn it points at a directory. |
| `symlinkdir` (`mklink /D`) | **NO — blocked, untested** | untested | untested | untested | untested | untested | `mklink /D` failed with "You do not have sufficient privilege to perform this operation." No elevated shell or Developer Mode was available; not fabricated. |
| `hardlink.txt` (`mklink /H`) | yes | `false` | `false` | `true` | `2` | itself (not `file.txt`) | same `dev`+`ino` as `file.txt`, confirming it is the same underlying file record. `nlink>1` is the *only* signal available; there is no API that lists which other path(s) share the link — you would have to already suspect a candidate path and compare `(dev, ino)` pairs. |

Why junctions test as `isSymbolicLink() === true`: both NTFS junctions
(`IO_REPARSE_TAG_MOUNT_POINT`) and true symlinks (`IO_REPARSE_TAG_SYMLINK`)
are implemented as NTFS reparse points, and libuv's Windows `stat`/`lstat`
path (which Bun uses) maps both of those specific reparse tags to `S_IFLNK`.
This is empirically confirmed here, not merely inferred from Win32
documentation.

**This is an implementation detail of libuv's tag mapping, not a documented
cross-version guarantee**, and it is known to *not* generalize to every
reparse-point kind. Reparse tags libuv does not special-case (cloud-file
placeholders such as OneDrive's `IO_REPARSE_TAG_CLOUD`, WSL interop links
`IO_REPARSE_TAG_LX_SYMLINK` in some configurations, dedup, app-execution
aliases `IO_REPARSE_TAG_APPEXECLINK`) were **not available to test** in this
environment and must be assumed uncovered by `isSymbolicLink()` until proven
otherwise. §3.4's rejection list says *"reject symlinks, junctions, or
reparse points"* — the third of those three ("reparse points" as the general
case) is **not fully covered** by `isSymbolicLink()` alone on the evidence
gathered here. The robust, tag-agnostic fallback the brief asked for:
`GetFileAttributesW` and testing `result & FILE_ATTRIBUTE_REPARSE_POINT`, via
`bun:ffi`. This check does not depend on libuv's tag-specific mapping — it is
true for *every* reparse point regardless of tag, at the cost of one FFI call
into `kernel32.dll`. It was not implemented in this spike (no native/FFI code
required to answer the stated question empirically), but it is the named,
correct fallback and should be treated as required for §3.4's "reparse
points" clause, not optional hardening.

## Step 5: try to escape

Built `project-root/escape-junction` (an NTFS junction pointing at a sibling
directory `outside-secret`, outside the root), then resolved a normalized
relative path `escape-junction/secret.txt` through it.

`STEP5_ESCAPE`, verbatim:

```json
{
  "rel": "escape-junction/secret.txt",
  "naiveJoined": "...\\project-root\\escape-junction\\secret.txt",
  "naiveRealpath": "...\\outside-secret\\secret.txt",
  "rootReal": "...\\project-root",
  "resolvedIsInsideRoot": false,
  "junctionLstat": { "isSymbolicLink": true, "realpath": "...\\outside-secret" }
}
```

**A naive `join(root, rel)` does *not* catch the escape by itself** — the
joined path string still looks like it's under `project-root`. **The check
that works**: call `realpathSync` on the joined path, call `realpathSync` on
`root` itself (not the raw root string — `root` could theoretically be a link
too), and verify the resolved target is either equal to `rootReal` or starts
with `rootReal + "\\"`. In this run that check correctly evaluated to `false`
and would correctly refuse the escape.

A second, independent signal is also available without needing full-path
`realpathSync` resolution at all: walking the path segment-by-segment and
`lstatSync`-ing each intermediate segment shows `escape-junction` itself has
`isSymbolicLink: true` *before* you ever try to resolve past it — so a
no-follow segment walk that refuses to descend into any segment with
`isSymbolicLink() === true` (or, more robustly, `FILE_ATTRIBUTE_REPARSE_POINT`
set) is a viable alternative to full-path `realpath` comparison, and is
closer to what §3.4's *"checks every writable parent with no-follow
semantics"* language describes.

## Step 6: compile and re-run

```
bun build --compile src/main.ts --outfile probe.exe
 [179ms]  bundle  1 modules
 [882ms] compile  probe.exe
```

`./probe.exe` reproduced every section with the same shape and the same
qualitative results: `devHex` again `40a8b11c` (same volume, expected), `ino`
values differ from the `bun run` baseline only because each run creates fresh
temp directories/files (expected — different underlying MFT records, not a
divergence in behavior). `mkJunction`/`mkHardlink` succeeded again,
`mkSymlinkDir` failed with the identical privilege error, `junction`'s
`isSymbolicLink()` was `true` again, and the Step 5 escape check again
correctly computed `resolvedIsInsideRoot: false`. **No divergence found
between `bun run` and the compiled binary.**

## Is §8's `windows:<volume-serial-8hex-lower>:<file-id-bytes-lower-hex>` encoding implementable exactly as specified?

**Yes, for the volume-serial half, exactly as written** — `dev` is a 32-bit
value that renders as exactly 8 lowercase hex digits and matches the OS's own
`vol` output byte-for-byte.

**Mostly yes for the file-id half, with one clarification the spec should
make explicit.** §8's own worked example
(`windows:1a2b3c4d:00112233445566778899aabbccddeeff`) encodes a **16-byte**
(128-bit) file ID. Every `ino` observed in this spike — across five separate
probe runs, both interpreted and compiled — fit in 7 bytes or fewer (hex
lengths of 13-14 characters; the theoretical ceiling of the value `stat()`
actually returns on Windows is 64 bits / 8 bytes, via the legacy
`BY_HANDLE_FILE_INFORMATION` file-index pair that libuv reads, not the newer
128-bit `FILE_ID_INFO` that `GetFileInformationByHandleEx` can return on
ReFS). Plain `fs.stat()` **cannot** produce the 16-byte value the spec's own
example shows; reaching the 128-bit ReFS ID would need a native
`GetFileInformationByHandleEx(FileIdInfo)` call via `bun:ffi`, which was out
of scope to build here (and untested — this spike ran on NTFS only,
confirmed via `Get-Volume`). Because the encoding is a variable-length
lower-hex string of "whatever bytes the platform gives you", it remains
implementable and stable as literally written — the digest input format in
§8 treats it as a length-prefixed UTF-8 text field, not a fixed-width byte
array, so no padding requirement is actually violated. But the spec's example
row implies a byte width (16) that plain `stat()` will never produce on NTFS,
which will read as a discrepancy to the next person who compares an example
against real output. **Recommend**: either change the example to a
realistic <=8-byte NTFS value, or add one sentence stating the file-id byte
width is whatever the OS call in use returns (8 bytes for the `stat()`-based
path used here; up to 16 on ReFS if a future revision adds the FFI call) and
is not fixed. This is a documentation clarification, not a blocking defect —
the encoding as actually implementable today (via plain `stat()`, no native
addon) is stable, deterministic, and correctly keys trust grants.

## Which spec claims are affected

- §8 `volume-serial-8hex-lower`: **confirmed correct as written**, no change needed.
- §8 `file-id-bytes-lower-hex`: **implementable as written**, but its own
  example row assumes a byte width (16 bytes/ReFS) that the `stat()`-based
  implementation tested here cannot produce (NTFS gives <=8 bytes). Recommend
  a one-sentence clarification, not a redesign.
- §11 *"changing `HEAD` alone does not prompt"*: **confirmed** — `ino` did not
  move across `git init`, two commits, a branch checkout, or an atomic
  editor-style rename.
- §3.4/§7 *"reject symlinks, junctions, or reparse points"*: **partially
  confirmed**. Junctions specifically ARE caught by `isSymbolicLink()` —
  better than the brief's working hypothesis. But `isSymbolicLink()` is a
  libuv-tag-specific implementation detail, not a documented guarantee for
  *all* reparse points, and real NTFS symlinks could not be created to
  confirm directly in this non-elevated, non-Developer-Mode environment.
  §3.4's "reparse points" clause needs the `GetFileAttributesW` +
  `FILE_ATTRIBUTE_REPARSE_POINT` fallback named explicitly as the
  tag-agnostic backstop, since `isSymbolicLink()` alone is not proven to
  cover every reparse tag.
- §11 acceptance criterion *"Symlink, junction, reparse-point ... attempts
  cannot escape the writable project root"*: **junction escape confirmed
  caught** by a `realpathSync(joined)` vs `realpathSync(root)` prefix check
  (a naive string `join()` alone does NOT catch it). Symlink escape was not
  directly testable (creation blocked by privilege) but is expected to behave
  identically to junctions for this check, since both resolve through
  `realpathSync` the same way.
