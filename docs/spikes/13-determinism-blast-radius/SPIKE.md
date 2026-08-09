# Spike 13 — the blast radius of widening the determinism rule

**Verdict: YES — the radius is small (2 → 6 warnings on a 5-page tree) and every prediction held.**

Run 2026-08-09 at `2f816d7` against `examples/clock/.termcraft/design` (7 code files, 5 pages).
Tasks 4 and 5 proceed. Two amendments to the plan, both about ORDER and honesty, not coverage —
see Consequences below.

Gates Tasks 4 and 5 of `docs/superpowers/plans/2026-08-09-design-agent-feedback-loop.md`
(spec WP-5a and WP-5b).

## The question

Tasks 4 and 5 together widen what the determinism lint sees along two axes at once: **more shapes**
(argument-less `new Date()` joins `Date.now()`/`performance.now()`) and **more files** (every file
in a page's closure, not only the page entry). Both are correct. Neither is free.

1. **How many NEW warnings does a real, shipped design tree produce?** If a project that opened
   clean yesterday shows a wall of warnings today, that is a product event — not a lint
   improvement — and it needs to be known before it is shipped, not discovered by a user.

2. **Does the seeded-constructor exemption hold on real code?** Task 4 flags `new Date()` and
   deliberately spares `new Date(y, m, d)`. That distinction is load-bearing or it is noise, and
   only real code says which.

3. **Do comments and strings stay out of it?** The lint tokenizes, so a `Date.now()` inside a `//`
   comment is trivia and must not match. The real tree contains several — this is a cheap
   assertion that the widening did not accidentally become a text search.

4. **How does one shared-module warning fan out through attribution?** Task 5 attributes a
   warning in a shared module to every page whose closure reaches it. One `Date.now()` in one
   `lib/` file could legitimately name five pages, which reads very differently in a fold than one
   warning naming one file.

## What the survey already found

`examples/clock/.termcraft/design/` — the project the measured failure ran against — surveyed by
`grep` at plan time. **This is not the spike's verdict; it is why the spike exists.**

| site | shape | today | after T4/T5 |
| --- | --- | --- | --- |
| `lib/elapsed.ts:24` | `Date.now()` in a SHARED MODULE | invisible | flagged, attributed to every page importing it |
| `pages/alarm.tsx:97` | `const now = new Date()` | invisible | flagged |
| `pages/calendar.tsx:112` | `const now = new Date()` | invisible | flagged |
| `pages/dashboard.tsx:137` | `const now = new Date()` | invisible | flagged |
| `pages/calendar.tsx:68,69,70` | `new Date(year, month, 1)` etc. | invisible | **spared** — seeded |
| `pages/stopwatch.tsx:56` | `Date.now()` in an entry | flagged | flagged |
| `pages/timer.tsx:76` | `Date.now()` in an entry | flagged | flagged |
| 5 comment lines naming `Date.now()`/`setInterval` | trivia | not flagged | must stay not flagged |

So Q2's answer looks like YES with real force: the seeded exemption is what stops `calendar.tsx`
from collecting three spurious warnings for the one wall-clock-free way to build a date. Without
that decision, the calendar page would look like the worst offender in the tree while doing nothing
wrong.

## The disagreement this spike must settle

`examples/clock/.termcraft/design/pages/dashboard.tsx:132-134` carries this comment, written by the
authoring agent:

> The clock reads `new Date()` once per render. There is no timer driving re-renders, […]
> deterministic, no setInterval/setTimeout/randomness involved.

**Task 4 flags exactly that line.** The page's author reasoned that a single clock read per render
is deterministic. It is not — a sealed export render at logical `t = 0` produces a different
snapshot on every run, which is the entire property the lint protects. But the disagreement is
evidence about the RULE'S EXPLANATION, not just its coverage: an author who read the existing
guidance ("no timers or randomness outside animation guarded by the export flag",
`runtime-authoring-guide.md:60-62`) concluded that reading the clock once was fine, because that
sentence is about timers and randomness and says nothing about a clock read.

That is Task 6's job, and this spike is what proves Task 6 is not optional decoration: the guide
must say "a sealed render has no wall clock" in those words, or the same author will reach the same
conclusion again and this lint will read as a false positive.

`lib/elapsed.ts:5-12`'s comment is the second instance — it argues its `Date.now()` "only runs off
the export flag's guard", which is precisely the guard the lint cannot see (RC4) and which the
rename in Task 4 exists to stop promising.

## Method

```bash
bun install
bun run docs/spikes/13-determinism-blast-radius/src/probe.ts
```

No network, no SDK, no turn. Reads the real `examples/clock/.termcraft/design/` tree off disk and
runs the REAL `lintDeterminism`/`lintSilencingAny` from `gate/model/lints.ts` over it in two
configurations — entries only (today) and every code file (after Task 5) — then diffs. It also
runs the proposed `new Date()` shapes past the CURRENT lint to confirm they are unflagged today, so
the "new" column is measured rather than assumed.

The probe reports per-file counts, the entries-only/whole-closure delta, and a fan-out estimate
built from `pages.json` plus the real relative imports.

## What this changes about the plan

- **A large blast radius does not stop Tasks 4 and 5.** Both fix real holes; the measured run
  laundered a `Date.now()` into `lib/elapsed.ts` and the check went blind. What a large radius
  changes is the ORDER: Task 6 (the guide) must land with or before them, not after, so a user
  meeting the new warnings has something to read that explains them.
- **If the count is large enough to look broken** (say, more warnings than pages), the plan gains a
  decision it does not currently have: whether a pre-existing tree's warnings are surfaced on
  open, or only on the next turn that touches a page. That is a product decision, and it belongs
  to the operator — flag it, do not pick it inside a task.
- **Update `examples/clock`'s own pages as part of Task 6, not silently.** The example is shipped
  documentation. Leaving it carrying warnings the guide tells authors to avoid makes the guide
  advisory. Fixing it in the same commit as the guide, with the stopwatch rewrite the guide's own
  worked example prescribes, is the honest close.

## Findings

| # | question | answer | evidence |
| --- | --- | --- | --- |
| 1 | entries-only → whole-closure | **2 → 3**, one new | today: `stopwatch.tsx:56`, `timer.tsx:76`. New: **`lib/elapsed.ts:24`** — the laundered call, exactly as RC4 described. |
| 1b | Task 4's `new Date()` addition | **+3** | `alarm.tsx:97`, `calendar.tsx:112`, `dashboard.tsx:137`, all `const now = new Date()`. Sanity check confirmed the current lint reports **0** `new Date` warnings, so all three are genuinely new. |
| 2 | seeded `new Date(…)` spared | **YES, and 3 sites depend on it** | `calendar.tsx:68,69,70` — `new Date(year, month, 1)`, `new Date(year, month + 1, 0)`, `new Date(year, month, 0)`. Without the exemption the calendar page would carry 6 warnings instead of 1 and look like the tree's worst offender while reading no clock. |
| 3 | comments/strings stay unflagged | **YES, 7/7 clean** | `lib/elapsed.ts:5,12`, `dashboard.tsx:132,134`, `stopwatch.tsx:42`, `timer.tsx:54,55` — every one names `Date.now`/`setInterval`/`new Date` in prose and none is flagged. The tokenizer holds; the widening did not become a text search. |
| 4 | fan-out of the shared-module warning | **2 pages** | `lib/elapsed.ts:24` → `blocks: stopwatch, timer`. Modest, and it is exactly the fact the agent cannot derive without an import graph. |
| — | total | **2 today → ~6 after Tasks 4+5**, on 5 pages | |

**The "more warnings than pages" trigger fired at 6 vs 5 — and it should be read as noise at this
scale.** The threshold in `probe.ts` is a heuristic, and +4 warnings on a five-page tree is not a
product event. **No operator decision is needed**, and the plan does not gain the
"surface on open vs. on next touch" question after all. Re-run this probe if a much larger tree ever
becomes the reference; the question is real, just not at n=5.

### Consequences for the plan

1. **Tasks 4 and 5 proceed unchanged.** Every prediction in the survey held, including the one that
   mattered most: the seeded-constructor exemption is load-bearing, with three real sites depending
   on it.
2. **Task 6 must land with Tasks 4 and 5, not after** — unchanged from the survey, and the reason is
   now measured rather than inferred. `dashboard.tsx:132-134`'s comment ("The clock reads
   `new Date()` once per render… deterministic, no setInterval/setTimeout/randomness involved") sits
   three lines above a site Task 4 flags, and `lib/elapsed.ts:5-12`'s comment argues its `Date.now()`
   "only runs off the export flag's guard" — the guard the lint cannot see. Both authors reasoned
   correctly from guidance that talks about timers and randomness and says nothing about a clock
   read. Ship the guide with the rule or the rule reads as a false positive.
3. **`examples/clock` must be fixed in the same commit as Task 6.** Six warnings on the project that
   ships as documentation makes the guide advisory. The stopwatch rewrite the guide's own worked
   example prescribes is the honest close, and `lib/elapsed.ts` is the file to start with — it is
   the laundering RC4 measured, still sitting in the tree.
