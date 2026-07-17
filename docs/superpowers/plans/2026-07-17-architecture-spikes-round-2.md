# Architecture Spikes — Round 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Answer the six load-bearing technical questions that the specs assert with confidence but no evidence, each one carrying a whole spec section as its blast radius, so that implementation of the Kernel, the host supervisor, the storage layer, and the agent backends does not begin on an unverified premise.

**Architecture:** Six independent throwaway probes, each in a self-contained directory under `docs/spikes/` with its own `package.json`, each compiled with `bun build --compile` and run on Windows. **Each spike gets its own dedicated subagent** — the probes share no state and touch no common file. A seventh task, run only after the six report, synthesizes findings into per-section spec amendments.

**Tech Stack:** Bun 1.3.14, `@opentui/core` + `@opentui/react` 0.4.5, `@reatom/core` 1001.1.0, `@reatom/react` 1001.0.0 (**not currently installed — see Known facts #1**), `react` 19.2.7, `typescript` 7.0.2, `@openai/codex-sdk` 0.144.5, `@anthropic-ai/claude-agent-sdk` 0.3.212.

## Relationship to Round 1

Round 1 (`docs/spikes/2026-07-17-findings.md`) answered three questions — dynamic TSX import, headless styled capture, TypeScript check in the binary — and produced eight spec amendments, all of which have landed. **Nothing in this plan re-opens those.** Do not re-litigate the single-binary claim, the Gate's diagnostic union, respawn-per-source, the JSX facade, or the styled cell frame; they are settled and amended.

Round 1 explicitly left open (its "What remains unknown" §3): *"`@opentui/react`, and both agent SDKs, are pinned from a lockfile but exercised by no probe. Nothing is known about their behavior inside a compiled binary."* Spikes D and H close exactly that gap.

**This plan re-gates specific subsystems, not the MVP.** Round 1's verdict ungated implementation planning in general. Each spike below gates only the subsystem named in its blast radius: nothing here blocks work that touches none of them.

## Global Constraints

- **Platform: Windows.** Every probe must be built *and run* on Windows 11. A green result on another OS does not answer any question in this plan — five of the six questions are specifically about Windows behavior.
- **Throwaway code.** Probes are evidence, not foundations. They live under `docs/spikes/`, are committed so the result is reproducible and auditable, and are never imported by product code.
- **Empirical, not aspirational.** A spike inverts TDD: you do not know the expected output, and the output *is* the finding. Never write a probe that asserts the answer you want. Record what actually happened, including the exact error text.
- **A "no" is a successful spike.** A subagent that reports "this does not work, here is the error, here are the fallbacks I tried" has succeeded. Do not work around a failure to make the probe pass — the workaround *is* the finding and must be reported as such.
- **Do not touch the root `package.json` or `tsconfig.json`.** They are real now (Round 1, Task 4) and are product configuration. Each probe owns its own `package.json` in its own directory. A probe that discovers the root manifest is wrong or incomplete **reports that as a finding**; Task 7 decides.
- **Versions are facts, not guesses.** Every version recorded must come from an installed lockfile, not from memory.
- **No product code.** Do not create `src/`, do not implement any module from `docs/architecture/code-structure.md`. This plan ends at findings and amendments.
- **The installed package is the authority.** Where this plan shows an API signature, it is a starting point, not a promise. If the installed `.d.ts` disagrees with this plan, the `.d.ts` wins — record the discrepancy and proceed with the real API.

---

## Known facts established while writing this plan

These were verified against the installed packages and the npm registry on 2026-07-17. Each subagent must treat the fact for its own spike as its starting point rather than rediscovering it.

1. **`reatomComponent` has no installed provider, and the root `package.json` cannot satisfy §5 as written.** Verified: `@reatom/core@1001.1.0` declares exactly one export (`"."`, no subpaths), has no `react` peer dependency, and **does not declare `reatomComponent`** — the identifier occurs in its `.d.ts` only inside a JSDoc example at line 6681. The real provider is **`@reatom/react@1001.0.0`** (`declare let reatomComponent: <Props extends Rec = {}>(Component: (props: Props) => React.ReactNode, options?: …)`), which is **absent from the root `package.json` and from `node_modules/`**. Meanwhile `2026-07-13-termcraft-design.md` §5 and `2026-07-16-production-hardening-decisions-design.md` §5 both promise that `@termcraft/runtime` exposes `reatomComponent`. Round 1's Task 4 wrote a "verified" `package.json` that omits the package §5 requires. This is Spike D's starting point, and it is already a confirmed amendment.

2. **`@reatom/react@1001.0.0` peer-requires `react-dom >=18.2.0`, but does not import it.** Verified by unpacking the published tarball: `dist/index.js` imports **only** `@reatom/core` and `react`; `react-dom` appears nowhere in `dist/`. This is the same shape as Round 1's `bun-ffi-structs → typescript@^5` finding — a types-only/spurious peer that produces a `bun install` warning and nothing else. **Do not let the peer warning end Spike D.** The open question is not the peer dep; it is whether the adapter's subscription machinery drives **OpenTUI's** React reconciler, which is not `react-dom`.

3. **`wrap`, `withAsync`, `withAsyncData`, and `withConnectHook` all exist in `@reatom/core@1001.1.0`.** Confirmed in `node_modules/@reatom/core/dist/index.d.ts`; `withConnectHook`'s real signature is `<Target extends AtomLike>(cb: (target: Target) => MaybeUnsubscribe) => Ext<Target>`. The specs' *names* are therefore right. Their *behavior inside a compiled binary against a non-DOM reconciler* is what is unverified.

4. **`2026-07-16-kernel-command-contract-design.md` §6 contains a now-stale statement of fact.** It reads: *"At design time this repository has no `package.json`, installed `@reatom/core`, or `node_modules`, so the installed types cannot yet be verified. Implementation must pin v1001 and check the package's own `.d.ts` before code is accepted."* All three now exist. The spec itself names this verification as a precondition for accepting code — Spike D is that precondition being met, and the sentence must be replaced with the result.

5. **Neither Bun nor Node exposes a Windows Job Object API.** There is no `child_process` option for it. Spike I therefore starts from `bun:ffi` against `kernel32` (`CreateJobObjectW`, `AssignProcessToJobObject`, `SetInformationJobObject`) or from a `taskkill /T /F` fallback — not from a Node API that does not exist. Do not spend the spike's budget looking for one.

6. **`fs.open()` on a directory fails on Windows in Node's fs semantics**, which is the exact call POSIX `fsync(dirfd)` needs. This is why `turn-durability-staging-design.md` §4.2 hedges with "or the Windows write-through equivalent". Spike G's job is to find out what that equivalent concretely is, and whether Bun can reach it.

---

## File structure

Each spike directory is self-contained and mirrors Round 1's layout (`docs/spikes/0N-<name>/`): a `package.json`, a `tsconfig.json`, `src/` for probe entries, `fixture/` where a probe needs external files, and a `FINDINGS.md` that is the task's only real deliverable. No probe imports another probe.

| Dir | Spike | Blast radius if the answer is "no" |
|---|---|---|
| `docs/spikes/04-reatom-opentui/` | D — Reatom v1001 through OpenTUI's reconciler | §5 master; §6 kernel-command-contract (all seven factories); every page model |
| `docs/spikes/05-host-respawn/` | E — self-respawn + framed stdio | all of `host-supervision-protocol-design.md` |
| `docs/spikes/06-win-fs-identity/` | F — Windows file identity + link detection | `production-storage-identity-design.md` §8 (TrustSubject) and §3.4/§7 (`SafeProjectFs`) |
| `docs/spikes/07-durability-primitive/` | G — the §4.2 durability sequence | all of `turn-durability-staging-design.md` |
| `docs/spikes/08-agent-confinement/` | H — Codex sandbox + Claude permission callback | master §6.1, §9 |
| `docs/spikes/09-process-tree/` | I — owned process tree and confirmed exit | `turn-durability-staging-design.md` §6.5; master §6.1 `cancel()` |
| `docs/spikes/2026-07-17-round-2-findings.md` | Task 7 synthesis | — |

---

## Task 1: Spike D — Reatom v1001 through OpenTUI's React reconciler

> **Dedicated subagent.** This task is one subagent's entire assignment. It shares nothing with Tasks 2–6 and runs in parallel with them.

**The question:** Does `reatomComponent` from `@reatom/react@1001.0.0` drive re-renders through **OpenTUI's** React reconciler — not `react-dom` — inside a `bun build --compile` binary on Windows; and do `wrap`, `withAsync`, and `withConnectHook` behave there as the vendored v1001 handbook describes?

**Why it is first:** highest blast radius in the set. `2026-07-13-termcraft-design.md` §5 makes Reatom the state model for *everything* — page models, kernel state, turn orchestration, and screen/action-table state — and `2026-07-16-kernel-command-contract-design.md` §6 fixes seven `reatom*` factories on it. If the adapter does not drive OpenTUI's reconciler, §5 and §6 are both void and the entire model layer needs a different binding.

**Start from Known facts #1, #2, and #3.** `reatomComponent` is not in `@reatom/core`; it is in `@reatom/react@1001.0.0`, which is not installed. The `react-dom` peer warning is expected and is not the finding.

**Files:**
- Create: `docs/spikes/04-reatom-opentui/package.json`
- Create: `docs/spikes/04-reatom-opentui/tsconfig.json`
- Create: `docs/spikes/04-reatom-opentui/src/main.tsx`
- Create: `docs/spikes/04-reatom-opentui/FINDINGS.md`

**Interfaces:**
- Consumes: nothing.
- Produces: `docs/spikes/04-reatom-opentui/FINDINGS.md` with a `Verdict:` line reading exactly `YES`, `YES-WITH-FALLBACK`, or `NO`, plus a `Provider:` line naming the exact package + version that exports `reatomComponent`, and a `Root package.json delta:` block listing every dependency the root manifest must gain. Task 7 reads this file.

- [ ] **Step 1: Scaffold and install**

```bash
mkdir -p docs/spikes/04-reatom-opentui/src
cd docs/spikes/04-reatom-opentui
bun init -y
bun add @reatom/core@1001.1.0 @reatom/react@1001.0.0 @opentui/core@0.4.5 @opentui/react@0.4.5 react@19.2.7
```

Record verbatim: the resolved versions from `bun.lock`, **and every peer-dependency warning `bun install` prints**. Known facts #2 predicts a `react-dom` warning. Confirm it appeared, note it, and move on — do **not** install `react-dom` to silence it unless a later step proves a real runtime need.

`docs/spikes/04-reatom-opentui/tsconfig.json`:

```json
{
  "compilerOptions": {
    "lib": ["ESNext", "ESNext.Disposable"],
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": true
  }
}
```

- [ ] **Step 2: Confirm the provider and record the delta**

Before any rendering, settle the fact that motivates the spike:

```bash
grep -c "declare let reatomComponent" node_modules/@reatom/react/dist/index.d.ts
grep -c "declare let reatomComponent" node_modules/@reatom/core/dist/index.d.ts
```

Record both counts verbatim (expected: `1` and `0`, per Known facts #1 — but record what you actually get). Write the `Provider:` line and an initial `Root package.json delta:` into `FINDINGS.md` now.

- [ ] **Step 3: Find OpenTUI's real React entry point**

This plan does not know `@opentui/react@0.4.5`'s render API and will not guess. Read it from the installed package:

```bash
ls node_modules/@opentui/react/dist/
grep -rhoE "declare (function|const|let) [A-Za-z_]+" node_modules/@opentui/react/dist/*.d.ts | sort -u
```

Record the exported surface verbatim in `FINDINGS.md`. You need whatever renders a React tree into an OpenTUI renderer, and you need it to cooperate with `createTestRenderer` from `@opentui/core/testing` — Round 1's Spike B established that `createTestRenderer({ width, height })` gives a headless renderer with `renderOnce()` and `captureCharFrame()` and that it survives `--compile`. Prefer that harness; it is proven.

- [ ] **Step 4: Write the probe — a Reatom atom must move a rendered cell**

The decisive test is not "does it compile" or "does it mount". It is: **an atom write, with no React state anywhere, changes what the terminal shows.** Anything less does not prove the adapter is wired to this reconciler.

`docs/spikes/04-reatom-opentui/src/main.tsx`:

```tsx
import { atom, action, computed, wrap, withAsync, withConnectHook } from "@reatom/core"
import { reatomComponent } from "@reatom/react"
import { createTestRenderer } from "@opentui/core/testing"

const results: Record<string, unknown> = {}

// 1. Plain reactive read: an atom write must reach the frame.
const counter = atom(0, "probe.counter")
const doubled = computed(() => counter() * 2, "probe.doubled")

// 2. withConnectHook: must fire on connect, and its cleanup on disconnect.
let connectFired = 0
let cleanupFired = 0
const watched = atom(0, "probe.watched").extend(
  withConnectHook(() => {
    connectFired++
    return () => {
      cleanupFired++
    }
  }),
)

// 3. withAsync across a real await, re-entering Reatom through wrap.
const loaded = atom("idle", "probe.loaded")
const load = action(async () => {
  await wrap(Promise.resolve())
  loaded.set("done")
  return "done"
}, "probe.load").extend(withAsync())

const Probe = reatomComponent(() => {
  // Read lazily, per the handbook's React rules.
  const n = counter()
  const d = doubled()
  const w = watched()
  const l = loaded()
  return <text>{`n=${n} d=${d} w=${w} l=${l}`}</text>
}, "probe.Probe")
```

`<text>` is a guess at OpenTUI's intrinsic element. **Replace it with the real one** found in Step 3's type dump — the installed package is the authority.

Then mount it into the headless renderer using the API Step 3 found, and drive the sequence:

```tsx
const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 40, height: 6 })

// ...mount <Probe /> into renderer using @opentui/react's real entry...

await renderOnce()
results.frame0 = captureCharFrame()

counter.set(1)
await renderOnce()
results.frame1 = captureCharFrame()          // THE verdict: did n=0 become n=1?

watched()                                     // force a connection
results.connectFired = connectFired

results.loadReturn = await load()
await renderOnce()
results.frame2 = captureCharFrame()          // did the async action reach the frame?

renderer.destroy()
results.cleanupFired = cleanupFired          // did withConnectHook's cleanup run?

console.log(JSON.stringify(results, null, 2))
```

- [ ] **Step 5: Run under `bun run` first**

```bash
bun run src/main.tsx
```

Baseline before adding the `--compile` variable — two variables at once produce an unattributable failure. Record the full JSON verbatim. Answer explicitly in `FINDINGS.md`:

- Did `frame1` differ from `frame0`? **If not, the verdict is `NO`** regardless of what else worked: the adapter is not driving this reconciler.
- Did `frame2` show `l=done`?
- Did `connectFired` reach 1, and `cleanupFired` reach 1 after `destroy()`?
- Did any error mention `react-dom`? (Known facts #2 predicts no. If it does, that prediction was wrong and it is a major finding.)

- [ ] **Step 6: Compile it**

```bash
bun build --compile src/main.tsx --outfile probe.exe
./probe.exe
```

Record verbatim. Round 1 proved OpenTUI's native core survives `--compile`; what is unproven here is Reatom + `@reatom/react` + OpenTUI's reconciler *together* inside the binary. If the compiled run differs from the `bun run` baseline in any field, that difference **is** the finding — report it rather than reconciling it.

- [ ] **Step 7: Probe the two things the specs bet on that the frames do not show**

- **Trace names.** `kernel-command-contract-design.md` §6 requires "every atom, computed, and action has a stable hierarchical trace name". Confirm the named atoms above are actually observable by name at runtime, and record *how* (which API). If names are erased in a compiled binary, §6's tracing requirement is unimplementable as written — a real finding.
- **`context.start`.** §6 requires "isolated tests use `context.start`". Confirm it exists in the installed `.d.ts` and record its signature. The Kernel's whole test story rests on it.

- [ ] **Step 8: Finalize FINDINGS.md and commit**

Must contain, in this order: the question; `Verdict:`; `Provider:`; `Root package.json delta:`; the Step 2 counts; the Step 3 export dump; verbatim JSON from both `bun run` and `--compile`; the Step 7 answers; and a plain-language paragraph a reader can act on. If the verdict is `NO`, state exactly which spec sections die with it.

```bash
git add docs/spikes/04-reatom-opentui
git commit -m "spike: Reatom v1001 through OpenTUI's React reconciler"
```

---

## Task 2: Spike E — self-respawn and framed stdio

> **Dedicated subagent.** This task is one subagent's entire assignment. It shares nothing with Tasks 1, 3–6 and runs in parallel with them.

**The question:** Can a `bun build --compile` binary spawn **itself** with the argument array `[_host, --stdio]` on Windows, and exchange length-prefixed binary frames over that child's stdio without corruption?

**Why it matters:** `host-supervision-protocol-design.md` §6.1 states: *"The supervisor spawns the current termcraft executable with the argument array `[_host, --stdio]`, with no shell interpolation."* Every preview, smoke test, and export in the product goes through this. The whole document — framing, the 3-second negotiation deadline, session state machine, restart policy — is built on a mechanism no probe has ever executed.

**The hard parts, named so the subagent does not have to find them the slow way:**

1. **Does the binary know its own path?** `process.execPath` and `process.argv[0]` inside a compiled Bun binary may point at the binary, at a Bun runtime, or at an embedded-namespace path. Round 1 established that `uv_spawn` **cannot execute** a `B:/~BUN/root/…` embedded path. If self-identification lands in that namespace, spawn fails the same way.
2. **Windows stdio is not binary-safe by default.** A `0x0A` byte inside a length-prefixed frame can be translated to `0x0D 0x0A` on a Windows pipe in text mode, silently corrupting every frame with a newline byte in it — which, for JSON payloads with a 4-byte big-endian length header, is most of them. This is the single most likely way this spike fails, and it will look like a framing bug, not a stdio bug.

**Files:**
- Create: `docs/spikes/05-host-respawn/package.json`
- Create: `docs/spikes/05-host-respawn/tsconfig.json`
- Create: `docs/spikes/05-host-respawn/src/main.ts`
- Create: `docs/spikes/05-host-respawn/FINDINGS.md`

**Interfaces:**
- Consumes: nothing.
- Produces: `docs/spikes/05-host-respawn/FINDINGS.md` with a `Verdict:` line reading exactly `YES`, `YES-WITH-FALLBACK`, or `NO`, a `Self-path:` line giving the literal value that identified the executable, and a `Negotiation:` line giving milliseconds from spawn to parsed hello. Task 7 reads this file.

- [ ] **Step 1: Scaffold**

```bash
mkdir -p docs/spikes/05-host-respawn/src
cd docs/spikes/05-host-respawn
bun init -y
```

Use the same `tsconfig.json` as Task 1 Step 1.

- [ ] **Step 2: Write one binary that is both supervisor and host**

The product ships one executable that behaves as a host when given `_host --stdio`. The probe must have the same shape, or it proves nothing.

`docs/spikes/05-host-respawn/src/main.ts`:

```ts
import { spawn } from "node:child_process"

// A frame is a 4-byte big-endian length followed by that many bytes of JSON.
function encodeFrame(obj: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(obj), "utf8")
  const header = Buffer.alloc(4)
  header.writeUInt32BE(body.length, 0)
  return Buffer.concat([header, body])
}

function makeFrameReader(onFrame: (obj: unknown) => void) {
  let buf = Buffer.alloc(0)
  return (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk])
    for (;;) {
      if (buf.length < 4) return
      const len = buf.readUInt32BE(0)
      if (buf.length < 4 + len) return
      const body = buf.subarray(4, 4 + len)
      buf = buf.subarray(4 + len)
      onFrame(JSON.parse(body.toString("utf8")))
    }
  }
}

// ---- host role ----
if (process.argv[2] === "_host" && process.argv[3] === "--stdio") {
  process.stdin.on(
    "data",
    makeFrameReader((msg) => {
      process.stdout.write(
        encodeFrame({
          type: "HostHelloV1",
          framingVersion: 1,
          echoed: msg,
          // A payload with bytes that Windows text-mode translation would mangle.
          canary: "a\nb\r\nc dÿ",
        }),
      )
    }),
  )
  process.stdin.resume()
} else {
  // ---- supervisor role ----
  const selfPath = process.execPath
  const t0 = performance.now()
  const child = spawn(selfPath, ["_host", "--stdio"], {
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
  })
  let stderr = ""
  child.stderr.on("data", (c) => (stderr += c.toString()))
  child.stdout.on(
    "data",
    makeFrameReader((msg) => {
      console.log(
        JSON.stringify(
          {
            ok: true,
            selfPath,
            argv0: process.argv[0],
            negotiationMs: performance.now() - t0,
            reply: msg,
            canaryIntact: (msg as any).canary === "a\nb\r\nc dÿ",
            stderr,
          },
          null,
          2,
        ),
      )
      child.kill()
      process.exit(0)
    }),
  )
  child.on("error", (e) => {
    console.log(JSON.stringify({ ok: false, selfPath, name: e.name, message: e.message }, null, 2))
    process.exit(1)
  })
  child.stdin.write(encodeFrame({ type: "ClientHelloV1", framingVersion: 1 }))
  setTimeout(() => {
    console.log(JSON.stringify({ ok: false, selfPath, reason: "3s negotiation deadline", stderr }))
    child.kill()
    process.exit(1)
  }, 3000)
}
```

The `canary` string is the point of the probe, not decoration: `\n`, `\r\n`, a NUL, and a high byte. `canaryIntact: false` with `ok: true` is a **worse** result than an outright failure, and it is the one the product would ship by accident.

- [ ] **Step 3: Run under `bun run` first**

```bash
bun run src/main.ts
```

Record verbatim. This baseline uses `process.execPath` = the Bun binary, so a pass here proves framing but **not** self-respawn. Note that distinction explicitly in `FINDINGS.md` so a later reader does not mistake the baseline for the answer.

- [ ] **Step 4: Compile and find out whether the binary can spawn itself**

```bash
bun build --compile src/main.ts --outfile probe.exe
./probe.exe
```

**This is the verdict step.** Record `selfPath` verbatim. Three outcomes, all findings:
- It names `probe.exe` and the child answers → `YES`.
- It names an embedded `B:/~BUN/root/…` path and `uv_spawn` refuses → matches Round 1's finding exactly; try `process.argv[0]`, `Bun.main`, and the Win32 `GetModuleFileNameW` via `bun:ffi`, in that order, and record which works.
- It names a Bun runtime outside the binary → the product would spawn the wrong program on a user's machine. Major finding.

- [ ] **Step 5: Check the framing under load, not just at hello**

A single small frame can pass while a real one fails. Send a frame with a **256 KiB** payload (the spec's control-class cap in §5) and one with a 1-byte payload, back to back, and confirm both round-trip with `canaryIntact`. Record whether frames ever arrive split or coalesced — the reader above handles both, and `FINDINGS.md` must say whether that was needed on Windows or merely defensive.

- [ ] **Step 6: Measure against the spec's own deadline**

§5 sets a **three monotonic second** pre-negotiation deadline from successful child spawn to a parsed `HostHelloV1`. Record `negotiationMs` across three cold runs of `probe.exe`. Round 1 measured a 44–52 ms spawn floor *without* OpenTUI's native core aboard; this probe has no OpenTUI either, so state plainly in `FINDINGS.md` that the real host will be slower and that this number is a floor, not a budget.

- [ ] **Step 7: Finalize FINDINGS.md and commit**

Include: the question; `Verdict:`; `Self-path:`; `Negotiation:`; verbatim output under `bun run` and `--compile`; the canary result at both payload sizes; and, if a fallback was needed to identify the executable, its working code in full.

```bash
git add docs/spikes/05-host-respawn
git commit -m "spike: compiled-binary self-respawn and framed stdio"
```

---

## Task 3: Spike F — Windows file identity and link detection

> **Dedicated subagent.** This task is one subagent's entire assignment. It shares nothing with Tasks 1–2, 4–6 and runs in parallel with them.

**The question:** Can Bun's fs API on Windows (a) read a **stable** volume-serial + file-id pair for a directory, and (b) reliably distinguish a symlink, an NTFS junction, an arbitrary reparse point, and a hardlink from an ordinary file — without a native addon?

**Why it matters:** two separate load-bearing claims rest on it.

- `production-storage-identity-design.md` §8 keys **every trust grant** on a `TrustSubject` whose second field is *"the filesystem identity of that directory: device and inode on Unix, or volume serial and file ID on Windows"*, encoded as `windows:<volume-serial-8hex-lower>:<file-id-bytes-lower-hex>`. If Windows `dev`/`ino` are zero, synthetic, or unstable, every trust key is garbage and §8's encoding is unimplementable.
- §3.4/§7 make `SafeProjectFs` *"reject symlinks, junctions, or reparse points in a durable writable path"* and §11 lists *"Symlink, junction, reparse-point … attempts cannot escape the writable project root"* as an acceptance criterion. Junctions are **not** symlinks at the Win32 level, and `lstat().isSymbolicLink()` is not obviously true for them. If it returns `false`, the security barrier has a hole in it and the acceptance criterion is untestable.

**Files:**
- Create: `docs/spikes/06-win-fs-identity/package.json`
- Create: `docs/spikes/06-win-fs-identity/tsconfig.json`
- Create: `docs/spikes/06-win-fs-identity/src/main.ts`
- Create: `docs/spikes/06-win-fs-identity/FINDINGS.md`

**Interfaces:**
- Consumes: nothing.
- Produces: `docs/spikes/06-win-fs-identity/FINDINGS.md` with a `Verdict-identity:` line (`YES` / `YES-WITH-FALLBACK` / `NO`), a `Verdict-links:` line (`YES` / `PARTIAL` / `NO`), and a `Detection matrix:` table with one row per link type. Task 7 reads this file.

- [ ] **Step 1: Scaffold**

```bash
mkdir -p docs/spikes/06-win-fs-identity/src
cd docs/spikes/06-win-fs-identity
bun init -y
```

Use the same `tsconfig.json` as Task 1 Step 1.

- [ ] **Step 2: Find out what `stat` actually reports on Windows**

```ts
import { statSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const dir = mkdtempSync(join(tmpdir(), "tc-id-"))
const s = statSync(dir, { bigint: true })
console.log(
  JSON.stringify(
    {
      dir,
      dev: s.dev.toString(),
      ino: s.ino.toString(),
      devHex: s.dev.toString(16),
      inoHex: s.ino.toString(16),
      nlink: s.nlink.toString(),
    },
    null,
    2,
  ),
)
```

Use `{ bigint: true }` deliberately: a Windows file ID is **64-bit** (128-bit on ReFS) and a JS `number` cannot hold it — a non-bigint `stat` may silently truncate the very value §8 encodes. Record both forms.

Answer precisely in `FINDINGS.md`:
- Are `dev` and `ino` non-zero and plausible, or zero/undefined?
- Does `dev` match the volume serial reported by `cmd /c vol C:`? §8 says `volume-serial-8hex-lower` — **8 hex digits, i.e. 32 bits**. If Bun's `dev` is wider or narrower, §8's encoding is wrong as written and must be amended.
- Is `ino` stable across: reading the directory, creating a file inside it, and reopening the process?

- [ ] **Step 3: Test the claim §8 makes about what must *not* change identity**

`production-storage-identity-design.md` §11 asserts *"changing `HEAD` alone does not prompt"* — i.e. Git operations must not move the trust key. Build a real repository and check:

```bash
git init repo && cd repo && git commit --allow-empty -m one && git checkout -b other
```

Record `ino` for the repo directory before and after `git checkout`, `git commit`, and an editor-style write (write a temp file, rename over the target — the same install sequence §4.2 uses). **Any of these changing the directory's `ino` breaks the trust model**, because a routine save would silently revoke trust.

- [ ] **Step 4: Build all four link types and find out what fs says about each**

Creating them needs privilege on Windows; use the real tools and record which ones required an elevated shell:

```bash
mkdir target
cmd /c mklink /J junction target
cmd /c mklink /D symlinkdir target
cmd /c "echo hi > file.txt && mklink /H hardlink.txt file.txt"
```

Then, for **each** of `target`, `junction`, `symlinkdir`, `hardlink.txt`, and `file.txt`, record every one of:

```ts
const l = lstatSync(p, { bigint: true })
;({
  path: p,
  isSymbolicLink: l.isSymbolicLink(),
  isDirectory: l.isDirectory(),
  isFile: l.isFile(),
  nlink: l.nlink.toString(),
  ino: l.ino.toString(),
  realpath: realpathSync(p),
})
```

Fill the `Detection matrix:` table from the results. **The crux: does `lstatSync(junction).isSymbolicLink()` return `true`?** If it returns `false`, then a `SafeProjectFs` built on `isSymbolicLink()` alone lets a junction through, and §3.4's rejection list needs a mechanism it does not currently name. Report the fallback you find (`realpathSync` divergence from the expected path is the obvious candidate; `bun:ffi` → `GetFileAttributesW` and `FILE_ATTRIBUTE_REPARSE_POINT` is the precise one). Record whether a hardlink is detectable at all — `nlink > 1` is the only signal, and it does not say *what* it is linked to.

- [ ] **Step 5: Try to escape**

The acceptance criterion is not "we can see links", it is "links cannot escape the root". Put a junction **inside** a project-root-shaped directory pointing outside it, resolve a normalized relative path through it, and record whether a naive `join(root, rel)` + `realpath` check catches it. Record the exact check that works.

- [ ] **Step 6: Compile and re-run**

```bash
bun build --compile src/main.ts --outfile probe.exe
./probe.exe
```

fs behavior is not expected to change under `--compile`, but "not expected" is what a spike exists to replace. Record verbatim; note any divergence from the `bun run` baseline.

- [ ] **Step 7: Finalize FINDINGS.md and commit**

Include: the question; both verdicts; the `Detection matrix:`; the Step 2 identity dump; the Step 3 stability results (call out any operation that moved `ino`); the escape test; and an explicit statement of whether §8's `windows:<volume-serial-8hex-lower>:<file-id-bytes-lower-hex>` encoding is implementable exactly as specified.

```bash
git add docs/spikes/06-win-fs-identity
git commit -m "spike: Windows file identity and link detection"
```

---

## Task 4: Spike G — the durability primitive

> **Dedicated subagent.** This task is one subagent's entire assignment. It shares nothing with Tasks 1–3, 5–6 and runs in parallel with them.

**The question:** Can `turn-durability-staging-design.md` §4.2's six-step install sequence be executed on Windows with Bun's APIs — specifically **step 5, "Flush the parent directory (or the Windows write-through equivalent)"** — and at what per-file latency?

**Why it matters:** §4.2's sequence is the physical primitive under *every* journal record and *every* target file in the product. §1 promises that if the adapter cannot establish these primitives, mutating actions fail with `unsupported_durability` and *"termcraft does not silently weaken the guarantee"*. That promise requires the adapter to actually be able to tell.

**Scope this honestly, and do not let it drift.** A true crash-durability test needs power loss or a filesystem fault injector; `kill -9` proves **nothing** about durability, because the OS page cache outlives the process. Do not write a probe that kills a process and reports "durable" — that is a false green and worse than no spike. The three answerable questions are:

1. Does an API to flush a directory exist on Windows from Bun, and what is it concretely?
2. What does the full six-step sequence cost per file?
3. Can an unsupported volume be **detected** (the `unsupported_durability` path), rather than discovered after data loss?

**Start from Known facts #6:** `fs.open()` on a directory is expected to fail on Windows, which is exactly the handle `fsync(dirfd)` needs.

**Files:**
- Create: `docs/spikes/07-durability-primitive/package.json`
- Create: `docs/spikes/07-durability-primitive/tsconfig.json`
- Create: `docs/spikes/07-durability-primitive/src/main.ts`
- Create: `docs/spikes/07-durability-primitive/FINDINGS.md`

**Interfaces:**
- Consumes: nothing.
- Produces: `docs/spikes/07-durability-primitive/FINDINGS.md` with a `Verdict:` line (`YES` / `YES-WITH-FALLBACK` / `NO`), a `Dir-flush mechanism:` line naming the exact API that worked or `NONE`, and a `Latency:` line giving milliseconds for one full six-step install. Task 7 reads this file.

- [ ] **Step 1: Scaffold**

```bash
mkdir -p docs/spikes/07-durability-primitive/src
cd docs/spikes/07-durability-primitive
bun init -y
```

Use the same `tsconfig.json` as Task 1 Step 1.

- [ ] **Step 2: Establish that the file-level steps work, before the hard one**

Steps 1–4 and 6 of §4.2 are ordinary fs calls. Implement them exactly as specified and confirm each: create-new temp (`flag: "wx"`), write, `fsyncSync(fd)`, close, reopen **without following links**, verify regular-file identity + size + SHA-256, `renameSync` onto the target, reopen and verify the realized image. Record any step that does not behave as §4.2 assumes — particularly whether `renameSync` over an **existing** target succeeds on Windows (POSIX rename replaces; Win32 `MoveFile` without `MOVEFILE_REPLACE_EXISTING` does not) and whether it is atomic.

- [ ] **Step 3: Try to flush the directory, in this order, recording every attempt**

Try all of them even after one works — Task 7 needs the cost comparison, and the cheapest is not always the first.

**(a) The POSIX-shaped path.** Expected to fail per Known facts #6; record the exact errno and message:

```ts
import { openSync, fsyncSync, closeSync } from "node:fs"
try {
  const fd = openSync(dir, "r")
  fsyncSync(fd)
  closeSync(fd)
  console.log(JSON.stringify({ approach: "open+fsync", ok: true }))
} catch (e) {
  console.log(JSON.stringify({ approach: "open+fsync", ok: false, code: (e as any).code, message: (e as Error).message }))
}
```

**(b) The Win32 mechanism, via `bun:ffi`.** This is the real "write-through equivalent" §4.2 gestures at: `CreateFileW` with `FILE_FLAG_BACKUP_SEMANTICS` is the documented way to obtain a **directory** handle, and `FlushFileBuffers` on it is the directory flush. Establish whether Bun can reach both:

```ts
import { dlopen, FFIType, suffix } from "bun:ffi"

const k32 = dlopen(`kernel32.${suffix}`, {
  CreateFileW: {
    args: [FFIType.cstring, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr],
    returns: FFIType.ptr,
  },
  FlushFileBuffers: { args: [FFIType.ptr], returns: FFIType.i32 },
  CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
  GetLastError: { args: [], returns: FFIType.u32 },
})
```

`CreateFileW` takes **UTF-16LE**, not a C string — encode the path accordingly and record what you had to do. The constants: `GENERIC_READ = 0x80000000`, `FILE_SHARE_READ|WRITE = 0x3`, `OPEN_EXISTING = 3`, `FILE_FLAG_BACKUP_SEMANTICS = 0x02000000`. Record `GetLastError()` verbatim on any failure. **If this works, it is the answer to the spec's parenthetical**, and `FINDINGS.md` must say so in those words.

**(c) `FILE_FLAG_WRITE_THROUGH` on the file itself.** A different guarantee from a directory flush — it does not make the *rename* durable. If (b) fails and this is the fallback, state plainly and prominently that the durability guarantee is **weaker than §4.2 specifies**, and name what is lost. Do not let a weaker primitive be recorded as a `YES`.

- [ ] **Step 4: Find out whether an unsupported volume is detectable**

§1 says network shares and *"filesystems with unverifiable write-through behavior"* are outside the supported envelope, and §11 requires "Local filesystems pass the primitive probe; mocked remote or weak-lock filesystems fail before mutation". Run the probe against a mapped network drive or a UNC path if one is reachable; if none is, say so rather than inventing a result. Record what distinguishes it: does `GetDriveTypeW` suffice, does `CreateFileW` fail, or does everything succeed and silently give no guarantee — the last being the dangerous case that makes §1's promise unkeepable.

- [ ] **Step 5: Measure**

Time one complete six-step install of a 4 KiB file, 20 iterations, and report median and worst. Then compose it against the spec: §4.3's apply loop runs this sequence for `plan.json`, `intent.json`, **every payload**, **every operation's applied marker**, and `committed.json`. A ten-operation transaction pays it upward of 20 times. State the implied per-transaction cost explicitly — a `YES` at 0.5 ms is a different answer from a `YES` at 40 ms, and Task 7 must be told which one it got.

- [ ] **Step 6: Compile and re-run**

```bash
bun build --compile src/main.ts --outfile probe.exe
./probe.exe
```

`bun:ffi` inside a compiled binary is the specific risk here — Round 1 proved FFI works for OpenTUI's embedded DLL, but `kernel32` is a system library loaded by name, which is a different path. Record verbatim.

- [ ] **Step 7: Finalize FINDINGS.md and commit**

Include: the question; `Verdict:`; `Dir-flush mechanism:`; `Latency:`; every approach from Step 3 with verbatim output; the Step 4 detectability answer; and an explicit sentence stating whether §4.2 step 5 is implementable as written, weaker than written, or not at all. **Restate the scope limit in `FINDINGS.md`** so no later reader mistakes this for a crash test.

```bash
git add docs/spikes/07-durability-primitive
git commit -m "spike: the Windows durability primitive"
```

---

## Task 5: Spike H — agent backend confinement on Windows

> **Dedicated subagent.** This task is one subagent's entire assignment. It shares nothing with Tasks 1–4, 6 and runs in parallel with them.
>
> **⚠ Prerequisite this task cannot satisfy for itself:** both agent CLIs must be installed **and authenticated** on the machine. If either is not, do not fake it and do not skip to a verdict — record `Verdict: BLOCKED` naming exactly what is missing, complete whatever half is available, and stop. A guessed answer here is worse than no answer.

**The question:** Two, both from `2026-07-13-termcraft-design.md` §6.1:

1. Does Codex's `workspace-write` sandbox actually silently downgrade to read-only on Windows, and does a scratch-dir write-probe detect the degradation **before** a real turn runs?
2. Does the Claude Agent SDK's per-call permission callback actually give an in-process veto on **every** tool use, as §6.1's claim *"platform-independent"* asserts?

**Why it matters:** §6.1's exact words are *"On Windows the sandbox is experimental and silently downgrades `workspace-write` to read-only when disabled — the health check probes an actual write in a scratch dir and reports the degradation honestly instead of letting turns silently produce nothing"*, and §9 promises a specific error for it. Both are stated as established behavior of third-party tools, sourced to nothing. This spike also closes Round 1's open risk #3 — *"both agent SDKs … are exercised by no probe"*.

**Confinement is defense-in-depth, not the wall** (§6.1: *"correctness comes from the gate only accepting what landed in staging and validated"*). A `NO` here does not sink the architecture; it changes what the health check can honestly claim, and §9's error text. Report accordingly — do not overstate the consequence.

**Files:**
- Create: `docs/spikes/08-agent-confinement/package.json`
- Create: `docs/spikes/08-agent-confinement/tsconfig.json`
- Create: `docs/spikes/08-agent-confinement/src/codex.ts`
- Create: `docs/spikes/08-agent-confinement/src/claude.ts`
- Create: `docs/spikes/08-agent-confinement/FINDINGS.md`

**Interfaces:**
- Consumes: nothing.
- Produces: `docs/spikes/08-agent-confinement/FINDINGS.md` with `Verdict-codex:` and `Verdict-claude:` lines (`YES` / `PARTIAL` / `NO` / `BLOCKED`), and a `Health-check probe:` block giving the working detection code for the Codex degradation. Task 7 reads this file.

- [ ] **Step 1: Scaffold, install, and check the prerequisite honestly**

```bash
mkdir -p docs/spikes/08-agent-confinement/src
cd docs/spikes/08-agent-confinement
bun init -y
bun add @openai/codex-sdk@0.144.5 @anthropic-ai/claude-agent-sdk@0.3.212
```

Record resolved versions from `bun.lock`. Then record, verbatim, whether each CLI is installed and authenticated, and how you determined it. Write this into `FINDINGS.md` **before** probing — it decides whether the rest of the task is evidence or theater.

- [ ] **Step 2: Read both SDKs' real confinement surface from the installed types**

This plan does not know either API and will not guess:

```bash
grep -rhoE "declare (function|const|let|class|interface|type) [A-Za-z_]+" node_modules/@openai/codex-sdk/dist/*.d.ts | sort -u
grep -rhoE "sandbox|workspace-write|permission|canUseTool" node_modules/@anthropic-ai/claude-agent-sdk/**/*.d.ts | sort -u
```

Record both surfaces verbatim. §6.1's `AgentBackend` interface requires `healthCheck(): Promise<AgentInfo>` to report *"sandbox effective?"* — find out whether either SDK exposes anything that answers that question directly, or whether a write-probe is genuinely the only route.

- [ ] **Step 3: Probe the Codex sandbox with a write, not with a question**

Point Codex at a scratch directory with `workspace-write`, give it a task whose **only** effect is writing one file, and observe the filesystem — not the transcript. An agent that reports success while writing nothing is precisely the failure §6.1 describes, and only the filesystem can tell you.

Record: did the file appear? Did Codex report success anyway? Did anything in its output disclose the downgrade? Then repeat with the sandbox explicitly disabled and with it explicitly enabled, and record all three. **The finding is the delta**, and the `Health-check probe:` block is whatever code reliably tells the three apart.

- [ ] **Step 4: Try to make the Claude permission callback fail**

Register the SDK's permission callback, deny **everything**, and give the agent a task that requires writing. Confirm the callback fires and the write does not happen. Then attack the word "every" in §6.1's claim:

- a file tool with an **absolute path outside** staging;
- a relative path escaping via `..`;
- a Bash tool call, which §6.1 says is denied outright;
- a web tool call, likewise.

Record, per attempt: did the callback fire, what arguments did it receive, and did the denial hold? **Any tool use that reaches the filesystem without the callback firing is the finding** — §6.1's "on every tool use" is either true or it is not.

- [ ] **Step 5: Compile and re-run**

```bash
bun build --compile src/codex.ts --outfile codex-probe.exe
bun build --compile src/claude.ts --outfile claude-probe.exe
./codex-probe.exe && ./claude-probe.exe
```

Round 1 knows nothing about either SDK inside a compiled binary; both bundle or spawn CLIs and may reach for files beside themselves. A failure here is a packaging finding independent of the confinement answers — report it separately so the two do not get conflated.

- [ ] **Step 6: Finalize FINDINGS.md and commit**

Include: the question; both verdicts; the prerequisite record from Step 1; both API surfaces; every attempt from Steps 3 and 4 with verbatim output; the `Health-check probe:` block; and an explicit statement of whether §6.1's two sentences are accurate as written. If Codex does **not** silently downgrade, say so — §6.1 and §9 both describe an error case that would then not exist.

```bash
git add docs/spikes/08-agent-confinement
git commit -m "spike: agent backend confinement on Windows"
```

---

## Task 6: Spike I — owned process tree and confirmed exit

> **Dedicated subagent.** This task is one subagent's entire assignment. It shares nothing with Tasks 1–5 and runs in parallel with them.

**The question:** Can termcraft place a child process in an owned process tree on Windows — *"a Job Object with kill-on-close"* — and obtain **OS confirmation that no owned descendant remains**, from Bun, without a native addon?

**Why it matters:** `turn-durability-staging-design.md` §6.5 requires *"Every backend must place each attempt in an owned process tree: a process group on POSIX and a Job Object with kill-on-close on Windows"*, and its step 4 requires waiting *"up to 5 seconds for OS confirmation that no owned descendant remains"*. §7.6 makes this load-bearing for data safety, not just tidiness: *"Cancellation does not resolve pins and does not clear/quarantine the workspace until process exit is confirmed."* A turn workspace reused while an orphan still writes to it is silent corruption. `master §6.1` likewise types `cancel(run): Promise<void>` as resolving *"only after process-tree exit"*.

**Start from Known facts #5:** neither Bun nor Node exposes a Job Object API, so this begins at `bun:ffi` or at `taskkill`. **The hard part is the word "confirmation"** — killing a tree is easy, proving nothing survived is not.

**Test the mechanism synthetically.** A deterministic three-level process tree you control is better evidence than a real agent CLI, because you know exactly what should die. This task deliberately needs **no** authentication — unlike Task 5 — so it must not be blocked by it.

**Files:**
- Create: `docs/spikes/09-process-tree/package.json`
- Create: `docs/spikes/09-process-tree/tsconfig.json`
- Create: `docs/spikes/09-process-tree/src/main.ts`
- Create: `docs/spikes/09-process-tree/src/tree.ts` (the synthetic victim tree)
- Create: `docs/spikes/09-process-tree/FINDINGS.md`

**Interfaces:**
- Consumes: nothing.
- Produces: `docs/spikes/09-process-tree/FINDINGS.md` with a `Verdict:` line (`YES` / `YES-WITH-FALLBACK` / `NO`), a `Mechanism:` line naming what worked, and a `Confirmation:` line stating exactly how "no owned descendant remains" was established. Task 7 reads this file.

- [ ] **Step 1: Scaffold**

```bash
mkdir -p docs/spikes/09-process-tree/src
cd docs/spikes/09-process-tree
bun init -y
```

Use the same `tsconfig.json` as Task 1 Step 1.

- [ ] **Step 2: Build a victim that behaves badly on purpose**

A well-behaved tree proves nothing — agent CLIs are not well-behaved. This victim detaches its grandchild and ignores `SIGTERM`, which is the shape §6.5 has to survive.

`docs/spikes/09-process-tree/src/tree.ts`:

```ts
import { spawn } from "node:child_process"
import { appendFileSync } from "node:fs"

// argv: <pidFile> <depth>
const pidFile = process.argv[2]
const depth = Number(process.argv[3] ?? 0)

appendFileSync(pidFile, `${depth}:${process.pid}\n`)

// Refuse to die politely. Step 4 must prove the mechanism, not our manners.
process.on("SIGTERM", () => {})
process.on("SIGINT", () => {})

if (depth < 2) {
  spawn(process.execPath, [import.meta.path ?? __filename, pidFile, String(depth + 1)], {
    detached: true, // breaks the parent link — taskkill /T walks that link
    stdio: "ignore",
  }).unref()
}

// Stay alive well past the probe's own lifetime.
setInterval(() => {}, 1 << 30)
```

Run it as `bun run src/tree.ts <pidFile> 0` under the baseline, and as the spawned child under each mechanism. `process.execPath` here is the *victim's* concern, not the probe's — if Step 6's compiled run cannot re-launch this file, spawn `bun` explicitly and record that you had to.

Read the PIDs back with:

```ts
const pids = readFileSync(pidFile, "utf8")
  .trim()
  .split("\n")
  .map((l) => ({ depth: Number(l.split(":")[0]), pid: Number(l.split(":")[1]) }))
```

Check liveness per PID with `process.kill(pid, 0)` — it throws `ESRCH` when the process is gone. **Record that this check is unsound on Windows because PIDs are reused**; proving that unsoundness matters is exactly what Step 5 is for.

- [ ] **Step 3: Establish the baseline — kill the parent and count survivors**

Spawn the tree, kill **only** the top child, wait, then check each recorded PID for liveness. Record how many survived. This is the number §6.5 exists to make zero; if it is already zero without a Job Object, that is a surprising and important finding.

- [ ] **Step 4: Try each mechanism, recording every one**

**(a) Job Object via `bun:ffi`.** The spec's named mechanism:

```ts
import { dlopen, FFIType, suffix } from "bun:ffi"

const k32 = dlopen(`kernel32.${suffix}`, {
  CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
  AssignProcessToJobObject: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  SetInformationJobObject: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
  TerminateJobObject: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
  GetLastError: { args: [], returns: FFIType.u32 },
})
```

Kill-on-close is `JOBOBJECT_EXTENDED_LIMIT_INFORMATION` with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000`, passed to `SetInformationJobObject` with class `JobObjectExtendedLimitInformation = 9`. The struct is 144 bytes on x64 and its layout must be exact — record the layout you used and how you verified it, because a wrong offset fails silently by setting the wrong limit. Note the ordering hazard: a process must be assigned to the job **before** it spawns descendants, or the descendants are never in it. Report whether `child_process.spawn` gives a usable handle early enough, or whether the child must be spawned suspended (which Node/Bun cannot do) — **if it cannot, the spec's mechanism is unreachable from Bun and that is the headline finding**.

**(b) `taskkill /T /F /PID <pid>`.** The pragmatic fallback: kills a tree by walking parent-child links. Record whether it reaches the detached grandchild — `detached: true` breaks the parent link, which is exactly why (a) exists. Record its exit code and output verbatim.

**(c) Breakaway.** §6.5 claims confirmation that *no owned descendant remains*. A process created with `CREATE_BREAKAWAY_FROM_JOB` leaves the job. Record whether a job configured with `JOB_OBJECT_LIMIT_BREAKAWAY_OK` unset actually prevents it, and what happens when a child tries.

- [ ] **Step 5: Answer the question that is actually hard — confirmation**

For whichever mechanism worked, establish **how you know** the tree is gone, and record the API that told you:
- Does the job report its process count (`QueryInformationJobObject` / `JobObjectBasicAccountingInformation`) so "no owned descendant remains" is a **read**, not an inference?
- Or is the only available signal polling each PID — which is unsound, because Windows reuses PIDs?
- Time the full §6.5 sequence and compare it to the spec's three 5-second waits.

`Confirmation:` must name a mechanism. If the honest answer is "we can kill but cannot confirm", say exactly that: §6.5's step 4 and §7.6's workspace-reuse rule both depend on confirmation, and `unhealthy_unconfirmed_exit` would become the normal case rather than the exception.

- [ ] **Step 6: Compile and re-run**

```bash
bun build --compile src/main.ts --outfile probe.exe
./probe.exe
```

Same FFI-in-a-binary risk as Spike G; the two tasks must not coordinate — divergent results between them are themselves informative.

- [ ] **Step 7: Finalize FINDINGS.md and commit**

Include: the question; `Verdict:`; `Mechanism:`; `Confirmation:`; the Step 3 baseline survivor count; every mechanism from Step 4 with verbatim output; the timing; and an explicit statement of whether §6.5 is implementable as written from Bun.

```bash
git add docs/spikes/09-process-tree
git commit -m "spike: owned process tree and confirmed exit on Windows"
```

---

## Task 7: Synthesis — amendments, not a go/no-go

> **Not a subagent task.** Run this only after the six subagents have reported. It is a judgment call over their evidence and belongs in the main session with the user.

**Why this differs from Round 1's Task 4:** Round 1 gated the whole project on three answers and produced a single go/no-go. This round gates **six independent subsystems**. There is no single verdict to give — there are six, and each one either clears its subsystem for implementation or amends its spec first.

**Files:**
- Create: `docs/spikes/2026-07-17-round-2-findings.md` (rename to the actual completion date if the spikes slip past today)
- Modify: `package.json` — if and only if Spike D's `Root package.json delta:` is non-empty
- Modify: the spec files named by the findings
- Modify: `docs/architecture/` — if and only if a finding contradicts a document there

**Interfaces:**
- Consumes: the `Verdict:` lines from all six `FINDINGS.md` files, plus Spike D's `Provider:` and `Root package.json delta:`, Spike E's `Self-path:`, Spike F's `Detection matrix:`, Spike G's `Dir-flush mechanism:` and `Latency:`, Spike H's `Health-check probe:`, and Spike I's `Confirmation:`.
- Produces: a per-subsystem clearance table and the landed amendments.

- [ ] **Step 1: Collect the verdicts**

```bash
grep -rn "^Verdict" docs/spikes/0[4-9]-*/FINDINGS.md
```

- [ ] **Step 2: Write the consolidated findings**

`docs/spikes/2026-07-17-round-2-findings.md`, in Round 1's shape: a verdict table at the top, one section per spike (question, verdict, evidence, consequences for implementation), then a table mapping each finding to the spec claims it invalidates **by section number**, then a "what remains unknown" section. Be specific: *"§4.2 step 5 is implementable only via `bun:ffi` → `CreateFileW(FILE_FLAG_BACKUP_SEMANTICS)` + `FlushFileBuffers`; the spec's parenthetical must name it"* is actionable; *"durability is mostly fine"* is not.

Round 1's findings document is the quality bar — match its specificity and its willingness to state what died.

- [ ] **Step 3: Fix the root `package.json` if Spike D says it is wrong**

Known facts #1 already establishes that `@reatom/react` is missing and that §5 cannot be satisfied without it. Add exactly what Spike D's delta names, at the versions its lockfile resolved — **not** from memory, and **not** more than the delta names. Then re-run `bun install` and record any peer warning, following Round 1's precedent of documenting benign warnings so nobody re-investigates them.

- [ ] **Step 4: Land the amendments, section by section**

At minimum, and regardless of any verdict, two are already known and must land:

- **`kernel-command-contract-design.md` §6** — replace *"At design time this repository has no `package.json`, installed `@reatom/core`, or `node_modules`, so the installed types cannot yet be verified"* with the verified result (Known facts #3 and #4). The sentence is now false.
- **`2026-07-13-termcraft-design.md` §5 / `production-hardening-decisions-design.md` §5** — record that `reatomComponent` comes from `@reatom/react`, not `@reatom/core`, and that the facade must re-export it from there (Known facts #1).

Then land whatever each finding requires. Amend the **spec**, not just the findings file: a finding nobody acted on is a finding that will be rediscovered.

- [ ] **Step 5: Clear each subsystem, out loud, one at a time**

For each of the six, state one of:
- **Clear** — the claim held; implementation of that subsystem may start.
- **Clear with amendments** — name every section that changed, by number; implementation may start once they land.
- **Blocked** — a premise failed. Name it, and name what that subsystem becomes without it.

Do **not** average them into one verdict. A `NO` in Spike I does not block the Reatom model layer, and a `NO` in Spike D does not block the storage layer.

- [ ] **Step 6: Commit**

```bash
git add docs/spikes package.json docs/superpowers/specs docs/architecture
git commit -m "docs: record round-2 spike findings and land the resulting amendments"
```

---

## Dispatch

Tasks 1–6 are fully independent — separate directories, separate `package.json` files, no shared state, no ordering. **Dispatch six subagents in parallel, one per spike.** Each subagent's brief is its task section verbatim, plus the Global Constraints and the Known facts entries its section names.

Task 5 (Spike H) is the only one with a prerequisite the plan cannot satisfy: both agent CLIs installed and authenticated. Confirm that before dispatching it, or expect `Verdict: BLOCKED`.

Task 7 runs after the six report, in the main session, with the user.

## Priority, if all six cannot run

Ordered by blast radius — how much spec dies if the answer is "no":

1. **Spike D** (Reatom) — §5 and all of `kernel-command-contract` §6. Already has one confirmed defect before it starts.
2. **Spike E** (self-respawn) — all of `host-supervision-protocol-design.md`. Every preview, smoke test, and export.
3. **Spike G** (durability) — all of `turn-durability-staging-design.md`. Every write the product makes.
4. **Spike F** (file identity) — the trust model and the `SafeProjectFs` security barrier.
5. **Spike I** (process tree) — cancellation correctness and turn-workspace reuse safety.
6. **Spike H** (agent confinement) — defense-in-depth, explicitly *not* the load-bearing wall (§6.1). Lowest blast radius of the six, and the only one needing credentials.
