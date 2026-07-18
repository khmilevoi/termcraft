# Spike 04 — Phase 2D supervisor de-risking (D1–D4)

Mandatory empirical de-risking required by the 2D master index
(`docs/superpowers/plans/2026-07-18-mvp-phase-2d-supervisor.md`,
"Pre-implementation empirical de-risking") before writing Plan 2D-1. Probes run
against the **real** 2C `runHostStdio` child (via `host-wrapper.ts`, a throwaway
`main`-lite wiring `Bun.stdin`/`stdout`) on this tree.

Environment: Bun 1.3.14, Windows 11, `process.execPath = C:\Users\Khmil\.bun\bin\bun.exe`.
Reproduce: `bun docs/spikes/04-supervisor-derisk/probe-d1.ts` (and `-d1b`, `-d2`,
`-d3`; `bun test docs/spikes/04-supervisor-derisk/probe-d4.test.ts`).

> These findings are normative inputs for 2D-1. Where a finding contradicts an
> assumption in the master index, the finding wins (2C lesson: plan-ahead bakes in
> wrong assumptions).

---

## D1 — `Bun.spawn` framed-stdio round-trip

**Result: works end-to-end.** A framed `client.hello` written to child stdin came
back as a framed `host.hello` decoded through one `FrameDecoder`. Negotiated limits
echoed correctly (`PROTOCOL_HARD_LIMITS`), identity echoed (`sessionId`/`nonce`).

- **Pipes are byte transports** (Spike E reconfirmed on this tree). The reply
  arrived in a **single** stdout event here; fragmentation is still possible for
  larger frames and the `FrameDecoder` already buffers it — feed every chunk, never
  assume one event == one frame.
- **Cold-start latency ≈ 831 ms** for spawn→`host.hello` under `bun run` with
  on-the-fly TS transpile of `src/`. Well within the **3 s spawn→hello deadline**;
  the compiled binary will be faster. The 3 s budget must survive a cold dev spawn —
  it does, with margin.
- **A failed `Bun.spawn` (bad cmd) throws SYNCHRONOUSLY, and the throw IS
  `instanceof Error`**: `{ name: "Error", code: "ENOENT",
  message: "ENOENT: no such file or directory, uv_spawn '<cmd>'" }`. So the spawn
  boundary *can* be wrapped with `errore.try`/`.catch` and yield an Error.
  **Still wrap it in a raw `try/catch` IIFE that maps ANY throw to a typed
  `SupervisorError`** — the master index's carried 2C trap warns other Bun boundaries
  throw non-Error values, and depending on the Error shape is brittle. Capture the
  `.code` (e.g. `ENOENT`) for diagnostics + restart classification (a missing binary
  is deterministic ⇒ open the circuit; a transient spawn failure consumes budget).
- **`proc.stdin.write(bytes)` returns a Promise, NOT a byte count** — even for a
  601-byte control frame. Writes to the child-stdin `FileSink` are possibly-async.
  The supervisor's writer must `flush()` after each write and treat the return as
  possibly-`Promise` (backpressure); do **not** assume a synchronous number.
- **EOF self-exit:** closing the parent's stdin (`proc.stdin.end()`) makes the 2C
  child self-exit **cleanly (exit 0) in ≈ 10 ms** — its stdin `for await` ends,
  `runHostStdio` returns, the process exits. Stdin-close is a viable last-resort soft
  stop, but the spec's normal stop is the `shutdown` control (D1b).

## D1b — graceful shutdown round-trip (the real stop path)

`shutdown` control request (with `requestId`) → child replies **`shutdown-ack`**
(`responseTo` correlated, body `{ ok: true }`) → **exit 0 in ≈ 11 ms**. This is the
§9 shutdown→ack→reap path the 2D-1 graceful-stop timeout (1 s ack, else force)
drives. `exitCode = 0`, `signalCode = null` on this path.

## D2 — kill + reap timing and confirmation

- **`proc.kill()` → `await proc.exited` ≈ 11 ms.**
- **Termination-path classification is via `exitCode` vs `signalCode`:**
  - forced kill ⇒ `exited` resolves **143**, `exitCode: null`, `signalCode: "SIGTERM"`.
  - graceful/self-exit ⇒ `exitCode: 0` (or 1), `signalCode: null`.
  The supervisor reads which of the two is non-null to tell a forced kill from a
  clean exit (diagnostics + the §10 crash-vs-clean classification).
- **A second `kill()` after exit is safe (no throw); `await proc.exited` is
  idempotent** (resolves the same code again). The reap path may kill defensively and
  await `exited` more than once.
- **Writing to a dead child's stdin does NOT throw and does NOT reject** — the write
  Promise resolves to `true`. **Liveness cannot be detected via `stdin.write`;
  `proc.exited` is the single source of liveness truth.** Every send path must be
  robust to a silently-dead pipe and rely on `exited`/heartbeat-watchdog for death.

## D3 — stderr drain, no-terminal-handle, env allowlist

- **`Bun.spawn({ env })` REPLACES the parent environment** — a parent-only marker var
  did not reach the child. **But on Windows, Bun/OS injects a baseline of ~11 system
  vars regardless** of what you pass: `HOMEDRIVE, HOMEPATH, LOGONSERVER, PATH,
  SYSTEMDRIVE, SYSTEMROOT, TEMP, USERDOMAIN, USERNAME, USERPROFILE, WINDIR`. None are
  secrets; **no inherited user/agent/API-key values leak**. Implications for §13:
  - the allowlist is realized by passing an explicit `env` (e.g. `LANG=C.UTF-8`,
    `LC_ALL=C.UTF-8`, `TZ=UTC`); parent secrets are excluded automatically.
  - the effective child env is **allowlist ∪ Windows-system-baseline** — the
    supervisor must NOT assume the env equals exactly the allowlist, and cannot zero
    out `PATH`/`SYSTEMROOT`/`WINDIR` on Windows. The spec's "PATH not required" note
    is moot here (injected anyway). Do not depend on their absence in tests.
- **No terminal handle:** child sees `isTTY = false` on stdin/stdout/stderr — confirms
  §13 "child gets only pipes, no terminal handle." (2C's `setRawMode` shim exists but
  no real TTY is attached.)
- **A ~2 MiB stderr burst does NOT block stdout parsing** even when the parent never
  reads stderr (the stdout marker still arrived in 73 ms). Node/Bun buffer stderr in
  the child's memory rather than blocking the event loop. So stdout parsing is safe if
  the parent is briefly slow on stderr — **but the supervisor must still drain stderr
  concurrently** to (a) capture the bounded 64 KiB tail (§8), (b) bound child memory
  under pathological/unbounded bursts, and (c) enforce the §8 `STDERR_FLOOD` limit
  (>1 MiB/rolling second). Draining is a correctness requirement, not just cleanup.

## D4 — fake-clock timeouts under `bun:test`

**Design proven** (`probe-d4.test.ts`, 4 pass). The §9 deadlines
(3 s/10 s/2 s/5 s/1 s) test off **one injected seam**:

```ts
interface Clock {
  now(): number                                   // monotonic ms
  setTimer(delayMs: number, cb: () => void): { cancel(): void }
}
```

- Test double `FakeClock.advance(ms)` fires due callbacks **exactly once**, at their
  exact virtual deadline, in due order — **including timers scheduled during an
  advance** (the 250/500/1000 ms backoff chain fired at virtual 250/750/1750).
  Cancellation before the deadline prevents the fire. No real waits ⇒ fast,
  deterministic, non-flaky.
- Production impl:
  `now = () => Math.trunc(Bun.nanoseconds() / 1e6)` (monotonic) and
  `setTimer = (ms, cb) => { const t = setTimeout(cb, ms); return { cancel: () => clearTimeout(t) } }`.
- **Every §9 timeout — and the §10 backoff — is one `Clock` port**, owned by
  supervisor code with explicit `cancel()` on every exit path (never a Reatom connect
  hook, per the roadmap hardening rule).

---

## Net effect on Plan 2D-1

1. Inject a `SpawnCommand` (`{ cmd: string[] }`) + a `Bun.spawn` seam; wrap the spawn
   call in a raw `try/catch` IIFE → typed `SupervisorError` carrying the OS `.code`.
2. The stdin writer awaits/flushes each framed write (possibly-async) and never
   infers liveness from it.
3. `proc.exited` is the one liveness/termination oracle; classify by
   `exitCode`/`signalCode`; kill + await are idempotent and safe to repeat.
4. Drain `proc.stderr` concurrently into a bounded 64 KiB tail from spawn; it will not
   deadlock stdout, but it must run for the tail/flood/memory guarantees.
5. Realize the §13 env allowlist by passing an explicit `env`; accept the Windows
   system-var baseline; assert only "no parent marker leaks", not exact key sets.
6. One injected `Clock` seam drives all §9/§10 timers, with explicit teardown.
