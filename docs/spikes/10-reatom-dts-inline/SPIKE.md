# Spike 10 — inlining `@reatom/core` into the Gate's declaration

**Verdict: YES — and the probe found a SECOND, pre-existing defect the plan did not know about.**

Run 2026-08-09 on win32-x64, `typescript@7.0.2`, `@reatom/core@1001.1.0`, at `2f816d7`.
Full output: see Findings below. The inline works, costs ~13 ms, and needs no amendment. The
incidental discovery — **every lowercase raw element is a fatal `TS7026` today** — is bigger than
the defect this spike was written to de-risk, and is NOT fixed by the inline.

Gates Task 7 of `docs/superpowers/plans/2026-08-09-design-agent-feedback-loop.md` (spec WP-4).
Nothing in that task may be implemented until this spike has a verdict, because the task's whole
premise — that inlining the real `@reatom/core` declarations makes atom reads typed — is a claim
about how the Go compiler behaves on a 300 KB ambient module it has never been handed before.

## The question

Four, in dependency order. (2) is the one the task exists for; (1) can kill the mechanism outright.

1. **Is `declare global { var __REATOM: ReatomGlobal | undefined }` legal inside a
   `declare module "@reatom/core" { … }` block, under the Gate's exact synthesized options?**
   `node_modules/@reatom/core/dist/index.d.ts:3923` contains that block. A global augmentation is
   documented as legal when "directly nested in external modules or ambient module declarations",
   which reads as YES — but the Gate's options are unusual (`types: []`, `lib: ["esnext"]`,
   `moduleResolution: "bundler"`, `cwd = os.tmpdir()`, a virtual FS answering five hooks), and
   "reads as legal" is not evidence.

2. **Do the four measured `TS7006`s disappear, and does a real type error still surface?**
   The predicted mechanism: `skipLibCheck: true` currently suppresses the `TS2307` for the
   unresolved `@reatom/core` specifier, so `atom` degrades to `any`, a type argument on an
   `any` callee is ignored, `alarmsAtom()` is `any`, and `.map((a) => …)` on `any` has no
   contextual signature — which `noImplicitAny` reports as `TS7006`. If the inline resolves the
   specifier, all four go away. **A check that passes everything is not a check**, so the negative
   direction is asserted with the same weight.

3. **What else appears?** `@reatom/core`'s declaration references globals `lib: ["esnext"]` does
   not supply — counted: `AbortController` ×16, `AbortSignal` ×11, `EventTarget` ×5, `Element` ×6,
   `document` ×7, `localStorage` ×8. The prediction is that `skipLibCheck` silences all of them and
   they degrade to the error type inside the `.d.ts`, touching nothing a page can reach. Enumerate
   what actually appears rather than trusting that.

4. **What does it cost?** The Gate copy grows from ~31 KB to ~333 KB, and the compiler parses it on
   **every whole-tree check**, which sits on the critical path of every turn's validation. Measure
   the wall-clock over a realistic tree, both ways.

## Why this is a spike and not a task step

Three of the four questions have a plausible answer that a careful reader would accept, and the
project has been burned by exactly that before. `scripts/gen-runtime-dts.ts:50-62` records the
previous instance: it asserted "THE UNRESOLVED SPECIFIERS ARE HARMLESS TO THE GATE, AND THAT WAS
VERIFIED, NOT ASSUMED", verified the half it thought to check (a valid page passes, a bad prop
still fails), and shipped a declaration that manufactured four fatal diagnostics against
correctly-typed pages for a year. The half it did not think to check is the one that cost two agent
attempts. This spike's job is to be the half nobody thought to check.

## Method

`src/probe.ts`, run from the repository root so the tsconfig path aliases resolve:

```bash
bun install                                          # this worktree's node_modules is empty
bun run docs/spikes/10-reatom-dts-inline/src/probe.ts
```

It measures the **real production seam**, not a replica: `createTreeTypeChecker` from `gate` with
`resolveCompilerPath()`'s compiler and the committed `RUNTIME_DTS`, which is exactly what
`entrypoint/model/create-shell.ts:287` wires in production. **This deviates from the standalone
spike convention** (`03-tsc-in-binary`, `08-agent-confinement` each carry their own
`package.json`) and the deviation is the point: a spike that rebuilt the Gate's synthesized options
by hand would answer a question about the replica. The options are the load-bearing part.

Four fixture trees, each run against three declarations (`baseline` = committed `RUNTIME_DTS`,
`inlined` = plus the `@reatom/core` block, `inlined-no-global` = the same with the `declare global`
block dropped):

| fixture | what it pins |
| --- | --- |
| `measured-map` | `atom<readonly Item[]>(…)().map((i) => i.name)` — the measured `alarm.tsx:98` shape |
| `measured-filter-and-binding` | `.filter((a) => …)` and `const laps = lapsAtom(); laps.map((l, i) => …)` — `alarm.tsx:102` and `stopwatch.tsx:126` |
| `real-type-error` | the same page reading `i.nope` — must STAY a `type` diagnostic |
| `spread-sort` | `[...itemsAtom()].sort((a, b) => …)` — the measured site that was NOT flagged; it must stay clean, proving the fix did not merely re-derange the classification |

## What would falsify the task's design

- **Q1 answers NO and dropping the `declare global` block does not help** → the mechanical inline
  is dead. Land the spec's own contingency WP-4a (one paragraph in `runtime-authoring-guide.md`
  stating atom reads are untyped under the Gate's check, so every callback parameter over atom
  state must be annotated) and report why. Do not hand-write stand-ins for `Atom`/`Computed` —
  `gen-runtime-dts.ts:46-48` forbids it and that rule is binding.
- **Q1 answers NO but `inlined-no-global` is clean** → ship the inline with that one block dropped,
  and document the removal as the single transformation beyond the declare-strip. Dropping a
  declaration the design tree cannot legitimately reach is honest; inventing one is not.
- **Q2's positive direction fails** → the diagnosed mechanism is wrong. Stop; do not iterate on the
  inline until the real mechanism is identified, because a fix aimed at the wrong mechanism is how
  the current defect got shipped.
- **Q2's negative direction fails** (the `real-type-error` fixture comes back clean) → the inline
  has disabled type checking rather than fixed it. This is the worst outcome and must not be
  mistaken for success: it looks identical to a pass on every other fixture.
- **Q4 shows a large regression** → the inline is still correct, but the plan gains a named
  follow-up (the compiler API is constructed per check at `src/gate/model/type-check.ts:340`) and
  the number goes in the ledger. Do not silently accept it.

## Findings

| # | question | answer | evidence |
| --- | --- | --- | --- |
| 1 | `declare global` legal inside the ambient block? | **YES** | `inlined` and `inlined-no-global` are diagnostic-IDENTICAL on all four fixtures. No amendment needed; the block stays. |
| 2a | measured `TS7006`s cleared? | **YES, all of them** | `measured-map` 1 → 0. `measured-filter-and-binding` 3 → 0 (`a`, `lapMs`, `i`). The diagnosed mechanism is confirmed exactly. |
| 2b | real type error still caught? | **YES — and it was NOT caught before** | See "The check was weaker than anyone thought" below. |
| 3 | other diagnostics introduced | **NONE by the inline.** Zero DOM-global diagnostics — C4's prediction that `skipLibCheck` silences them all is confirmed. | But the probe surfaced a pre-existing `TS7026` on every fixture, in every variant including baseline. See below. |
| 4 | check wall-clock, 5-page tree, median of 5 | **48 ms → 61 ms** (+13 ms) | min/max: baseline 44/61, inlined 50/64, inlined-no-global 59/75. Negligible. No follow-up needed. |
| 4b | gate copy size | **30,480 → 346,435 bytes** | `@reatom/core` source is 302,787. `inlined-no-global` is 346,376. |

### The check was weaker than anyone thought, and Q2b is the proof

The `real-type-error` fixture reads `i.nope` on an `Item` that has no `nope`. Both variants scored
`PASS` — **and that scoring was too weak, so read what actually happened:**

- **baseline** reported `TS7026` ×2 and `TS7006` — and **never mentioned `nope`**. The probe scored
  it PASS only because it counted any `type` diagnostic. The Gate was not catching the field error
  at all; it was complaining that the parameter was implicitly `any`.
- **inlined** reported `TS2339 Property 'nope' does not exist on type 'Item'` — the real diagnostic,
  naming the real mistake.

So the inline does not merely remove four false rejections. It converts a check that **could not
detect a misspelled field on atom state** into one that can. That is a stronger result than the
spec claimed, and Task 7's test for this direction must assert the CODE (`TS2339`), not merely
"some type diagnostic" — otherwise it passes today for the wrong reason.

### The incidental discovery: every lowercase raw element is a fatal `TS7026`

`TS7026: JSX element implicitly has type 'any' because no interface 'JSX.IntrinsicElements' exists.`

Two per element, on **every fixture, in every variant, baseline included**. The inline neither
causes nor fixes it. The cause is structural and is C5's other half: `JSX.IntrinsicElements` lives in
the JSX namespace of `@opentui/react/jsx-runtime`, which the generated declaration re-exports **by
specifier** and which does not resolve hermetically — `@types/react` is not installed and `react@19`
ships none.

**Why nobody noticed, verified three ways:**

1. `src/gate/model/type-check.test.ts:20-22`'s stand-in declaration says so out loud: "Covers
   exactly what those fixtures use — **no JSX**, so no jsx-runtime resolution is dragged in."
2. The real-declaration suite at `:183` DOES use JSX — but every fixture uses only **capitalized**
   Kit components (`<Panel>`, `<Text>`), which are declared inside the ambient module and therefore
   resolve. Lowercase intrinsics appear in no fixture in the file.
3. The real, Gate-ACCEPTED pages in `examples/clock/.termcraft/design/pages/` contain **zero**
   lowercase JSX tags — `grep -oE "<[a-z][a-zA-Z]*"` returns five hits and all five are generic type
   arguments (`atom<number>`, `atom<readonly …>`). The authoring agent happened to use Kit
   components throughout.

**Why this is a defect and not a documented gap.** The system prompt actively teaches the escape
hatch — `prose.ts`'s `DESIGN_CODE_RULES` describes lowercase tags as "a low-level/raw OpenTUI
primitive (the runtime's escape hatch, e.g. `<box>`/`<text>`)" — and `gate/model/lints.ts`'s
`lintUnpointedElements` exists specifically to WARN about a lowercase tag with no `id`, which
presumes such tags are legal and expected. A page that follows the documented escape hatch is
rejected with a diagnostic that names an interface the author has never heard of and cannot supply.
It is the same family as RC3 and arguably worse: RC3 cost an annotation, this makes a documented
feature unusable.

**It is out of scope for Task 7** — the inline neither caused it nor can fix it — and it must not be
laundered into the ledger as a known limitation. Recommended handling: a NEW ledger row naming it a
defect, plus the one fixture the Gate's own suite is missing (`type-check.test.ts` gains a
lowercase-element case that FAILS, pinning the defect until it is fixed). The fix itself is a
declaration question: either the generated declaration supplies a `JSX.IntrinsicElements` sourced
from `@opentui/react`'s own `jsx-namespace.d.ts`, or lowercase tags stop being advertised. Both are
design decisions, and neither belongs inside this plan.

### Consequences for Task 7

1. **Ship the inline, `declare global` block included.** No amendment.
2. **Assert `TS2339` by code** in the negative-direction test, not "some type diagnostic".
3. **Do not use lowercase JSX elements in Task 7's new fixtures** — use Kit components, as the
   existing suite does, or the fixtures will fail on the unrelated `TS7026` and read as a broken
   inline. (The probe's own fixtures use `<box>` and therefore show `TS7026` throughout; that was
   accidental and is what surfaced the defect.)
4. **Raise the `TS7026` defect separately**, with the three pieces of evidence above.
