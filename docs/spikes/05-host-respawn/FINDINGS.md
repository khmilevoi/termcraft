# Spike E — self-respawn and framed stdio

**Question:** Can a `bun build --compile` binary spawn *itself* with the argument array
`[_host, --stdio]` on Windows, and exchange length-prefixed binary frames over that
child's stdio without corruption?

**Verdict:** YES
**Self-path:** `process.execPath` inside the compiled binary — literal value
`C:\Users\Khmil\RustProjects\termcraft\docs\spikes\05-host-respawn\probe.exe`. No
fallback was needed; `process.execPath` named the real `.exe` on the first try.
**Negotiation:** 135.37 ms / 148.18 ms / 177.78 ms across three cold runs of the
compiled `probe.exe` (spawn to parsed `HostHelloV1`). See "Negotiation timing" below
for the full set of measurements observed and why they vary more than Round 1's
floor.

Bun: `1.3.14` (`bun --version`), resolved at `C:\Users\Khmil\.bun\bin\bun.exe`. No
other dependencies were installed — this probe only imports `node:child_process`,
which ships with Bun's Node compat layer.

## Environment

- Windows 11 Pro 10.0.26200, built and run on the same machine (no cross-platform
  step).
- Six spikes ran as parallel subagents against the same working tree at the time of
  this run; see "Negotiation timing" for how that shows up in the numbers.

## Step 3 — baseline under `bun run` (proves framing, NOT self-respawn)

```
$ bun run src/main.ts
{"ok":false,"selfPath":"C:\\Users\\Khmil\\.bun\\bin\\bun.exe","reason":"3s negotiation deadline","stderr":"error: Script not found \"_host\"\n"}
```
(exit code 1)

**This is not a framing failure and not the answer to the spike question.** Under
`bun run`, `process.execPath` is `C:\Users\Khmil\.bun\bin\bun.exe` — the Bun runtime,
not the script. `spawn(selfPath, ["_host", "--stdio"])` therefore re-invokes the Bun
CLI itself with `_host` as its first argument, and Bun's own CLI parser treats an
unrecognized first argument as a script name to run: `error: Script not found
"_host"`. The child process exits immediately; framing and the `canary` payload were
never exercised, because the child never reached the frame-reading code at all. The
3-second deadline in the supervisor fires because the child produced no `HostHelloV1`.
A reader must not mistake this for evidence either way about framing — it only
shows that `process.execPath` is the wrong self-path source under the interpreted
`bun run` invocation, a different failure mode than Round 1's `B:/~BUN/root/...`
finding, but the same underlying lesson: which value counts as "self" depends on how
the process was launched.

## Step 4 — compiled binary, verdict step

```
$ bun build --compile src/main.ts --outfile probe.exe
  [12ms]  bundle  1 modules
 [587ms] compile  probe.exe

$ ./probe.exe
{
  "ok": true,
  "selfPath": "C:\\Users\\Khmil\\RustProjects\\termcraft\\docs\\spikes\\05-host-respawn\\probe.exe",
  "argv0": "bun",
  "negotiationMs": 59.263400000000004,
  "reply": {
    "type": "HostHelloV1",
    "framingVersion": 1,
    "echoed": {
      "type": "ClientHelloV1",
      "framingVersion": 1
    },
    "canary": "a\nb\r\nc dÿ"
  },
  "canaryIntact": true,
  "stderr": ""
}
```

This is outcome (1) of the three named in the brief: `process.execPath` inside the
compiled binary names `probe.exe` itself (its real on-disk path, not an embedded
`B:/~BUN/root/…` namespace path and not an external Bun runtime), `uv_spawn`
successfully executes it as `_host --stdio`, and the child answers with a parsed
`HostHelloV1` whose `canary` round-tripped byte-for-byte (`canaryIntact: true`).
No fallback (`process.argv[0]`, `Bun.main`, `GetModuleFileNameW` via `bun:ffi`) was
needed.

One incidental finding worth recording: `process.argv[0]` inside the compiled binary
is the literal string `"bun"` — not a path, not the executable name, just `"bun"`.
Had `process.execPath` failed (e.g. landed in the embedded namespace as Round 1 saw
for a different mechanism), `argv[0]` would not have been a usable fallback here;
`Bun.main` or `GetModuleFileNameW` would have been the next things to try. This
probe never needed to find out which of those actually works, because `execPath`
worked on the first attempt.

## Step 5 — framing under load (256 KiB + 1-byte payloads, back to back)

The hard part named in the brief is that JSON string content can never carry a raw
`0x0A`/`0x0D` byte on the wire — `JSON.stringify` always backslash-escapes control
characters inside strings, so the risk the brief describes ("a `0x0A` byte inside a
length-prefixed frame") cannot come from the JSON body at all. It can only come
from the 4-byte binary length header, which is not JSON and is not escaped. The
probe was extended (beyond the brief's literal `main.ts`, same file, same shape —
the hello role/exchange logic is untouched) to deliberately pad two `LoadFrame`
messages so their encoded body length forces a `0x0A` and a `0x0D` byte into the
header itself — the actual corruption-risk byte:

- 256 KiB payload (`262144` bytes of payload content, canary embedded once,
  ASCII filler for the rest): body length tuned to `262410` bytes = header bytes
  `0x00 0x04 0x01 0x0a` — the low header byte is a raw line-feed byte on the wire.
- 1-byte payload (`"Z"`): body length tuned to `269` bytes via a padding field
  = header bytes `0x00 0x00 0x01 0x0d` — the low header byte is a raw
  carriage-return byte on the wire.

Both frames were written back-to-back (`child.stdin.write(bigLoad.frame)` then
immediately `child.stdin.write(smallLoad.frame)`, no delay) and the host echoed each
payload back verbatim for byte-for-byte comparison. Result, verbatim from a run of
the compiled `probe.exe`:

```json
"loadTest": {
  "big": {
    "targetBytes": 262144,
    "headerLowByteForced": "0x0a",
    "bodyLength": 262410,
    "headerBytes": ["0x00", "0x04", "0x01", "0x0a"],
    "ok": true,
    "length": 262144,
    "expectedLength": 262144
  },
  "small": {
    "targetBytes": 1,
    "headerLowByteForced": "0x0d",
    "bodyLength": 269,
    "headerBytes": ["0x00", "0x00", "0x01", "0x0d"],
    "ok": true,
    "length": 1,
    "expectedLength": 1
  }
},
"stdoutDataEvents": 5,
"stdoutFrameCount": 3
```

`ok: true` for both — the 256 KiB payload and the 1-byte payload both round-tripped
byte-for-byte, including through header bytes that were deliberately forced to
`0x0A` and `0x0D`. No corruption was observed at either size, and no NUL/high-byte
mangling either (the initial hello canary `"a\nb\r\nc dÿ"` — containing `\n`, `\r\n`,
and a high byte `ÿ` — also came back intact in every run of every step).

Frames did arrive split. `stdoutDataEvents: 5` against `stdoutFrameCount: 3`
means the child's replies (one `HostHelloV1` plus two `LoadFrameEcho`s, one of
which is 262 KB) were delivered across five separate `"data"` events on the pipe,
not three. The buffering frame reader (`makeFrameReader`, unchanged from the
brief's code) was load-bearing, not merely defensive: a naive reader that assumed
one `data` event equals one frame would have broken on this exact probe, on Windows,
without any hostile input — just an ordinary 256 KiB frame.

## Step 6 — negotiation timing against the 3-second deadline

Three cold runs of the final `probe.exe` (which includes the Step 5 load test after
the hello handshake — `negotiationMs` is captured at the hello reply, before the
load test frames are sent, so the load test does not inflate this number):

| Run | negotiationMs |
|-----|---------------|
| 1   | 135.37 |
| 2   | 148.18 |
| 3   | 177.78 |

All three are far under the spec's 3-second deadline. For comparison, the very
first `--compile` run in Step 4 — before the Step 5 load-test code existed in
`main.ts`, i.e. hello-exchange only, closest in shape to Round 1's measurement —
came in at 59.26 ms, in the same ballpark as Round 1's 44–52 ms floor without
OpenTUI aboard.

Across all `probe.exe` invocations in this session (7 total, including ad hoc runs
made while developing the Step 5 extension), `negotiationMs` ranged from 59.26 ms
to 1003.06 ms. The high end coincides with this spike running as one of six parallel
subagents against the same working tree, several of which were compiling and
running their own Bun binaries concurrently — this is CPU contention on the host
machine, not a framing or spawn defect; every run in the range still succeeded with
`canaryIntact: true` and `loadTest.big.ok`/`loadTest.small.ok` both `true`. As
Round 1 already stated and this spike reaffirms: this number is a floor, not a
budget. The real host process carries OpenTUI's native core, a larger dependency
graph, and Reatom's setup — all absent here — so production negotiation time will
be higher than every number in this table, and the 3-second deadline has
comfortable headroom against the floor but has not been measured against the real
host.

## Summary of findings

1. `process.execPath` is the correct self-path source for a compiled Bun
   binary on Windows, and it worked without any fallback. It resolves to the
   real on-disk path of the `.exe` that is currently running, not an embedded
   `B:/~BUN/root/…` namespace path (Round 1's failure mode for a different
   mechanism did not reproduce here) and not an external Bun runtime.
2. `process.execPath` is the wrong self-path source under `bun run` — it
   resolves to the Bun CLI binary, and respawning it with `[_host, --stdio]`
   makes Bun's own CLI try to run `_host` as a script name and fail immediately.
   Any code path that must work both in dev (`bun run`) and in the compiled
   product needs to branch on this, or only ever rely on `execPath` inside the
   compiled artifact.
3. `process.argv[0]` inside a compiled binary is the literal string `"bun"`,
   not a path — confirmed but not needed as a fallback here since `execPath`
   worked; recorded so a later reader does not assume it is a usable self-path
   source without checking.
4. Length-prefixed binary frames survive Windows stdio pipes intact,
   including at a 256 KiB payload size and a 1-byte payload size sent
   back-to-back, and including with the 4-byte binary length header
   deliberately forced to contain a raw `0x0A` and a raw `0x0D` byte — the one
   place on the wire where such a byte can actually occur, since JSON string
   escaping means it can never occur inside the frame body itself. No
   corruption was observed in any run.
5. Frames do arrive split across multiple stdio `"data"` events on Windows —
   observed 5 events for 3 logical frames in the load test. A frame reader that
   buffers and only consumes complete frames (as the brief's `makeFrameReader`
   already does) is required, not optional.
6. Negotiation time comfortably clears the 3-second deadline even under
   heavy concurrent CPU load from five other spike subagents (worst observed:
   1003.06 ms), but this probe carries none of the real host's weight
   (OpenTUI's native core, Reatom, the rest of the dependency graph) — the
   product's real negotiation time is unmeasured and will be higher than every
   number recorded here.
