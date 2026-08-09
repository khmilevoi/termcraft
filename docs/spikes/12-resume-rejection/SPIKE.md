# Spike 12 — how a rejected resume is discriminable from any other backend error

**Verdict: YES — every diagnosis confirmed, and Q2 has a STRUCTURAL discriminator, not just prose.**

Run 2026-08-09, `@anthropic-ai/claude-agent-sdk@0.3.212`, on win32-x64. Four observations, three
live turns, total cost **$0.117** (A and D cost $0 — they never reached the API).
**Task 8's premise holds. RC6 is confirmed. Task 9 does NOT have to match on an English sentence.**

Gates Task 9 of `docs/superpowers/plans/2026-08-09-design-agent-feedback-loop.md` (spec WP-8,
part 2).

## The question

1. **What does the SDK actually produce when asked to resume a session id it cannot find?** Is it a
   thrown error, a `result` message with a subtype, or a stream that closes silently? The one
   observation on record is the measured turn failure text:
   `BACKEND_FAILED: No conversation found with session ID: 28b861a5`.

2. **Is there any discriminator other than that English sentence?** An error class, a `code`, a
   `subtype`, an exit status — anything stable. This is the whole spike: `core` must not match on
   prose. A message match would break the moment the vendor rewords the sentence, and would
   misfire on a design page that happens to contain the same words in a string literal.

3. **Does the rejection depend on the cwd, as diagnosed?** The root cause on record (RC6) is that
   the SDK indexes sessions by cwd while every turn gets a create-new
   `turns/<turnId>/workspace` (`src/store/sandbox/model/staging-store.ts:91-98`), so a previous
   turn's session id is unresolvable from the new cwd. If that is right, the SAME session id
   resumes successfully from its ORIGINAL cwd and fails from a different one. That is a
   two-observation experiment and it either confirms the diagnosis or replaces it.

4. **Does an intra-turn resume actually work?** Task 8 rests on it: within one turn the workspace
   is identical across attempts, so the session the rejected attempt created is still addressable.
   Task 8 is written as if this is obvious from the cwd diagnosis — confirm it directly, because
   Task 8 ships before Task 9 and a failure here invalidates both.

## Why this is a spike and not a task step

The plan's own text says the classification "belongs in the Claude adapter, the one layer that
knows the SDK's error shape" — and then does not know what that shape is. Task 9 cannot be
implemented honestly without this: the alternative is to ship a narrow match on an English
sentence and hope, which is the failure mode `docs/mvp-remaining-work.md:844` has already been
waiting on ("needs an `AgentRunOutcome` widening") rather than guessing at.

Q3 and Q4 additionally decide whether Task 8 is even sound. Task 8 is scheduled BEFORE Task 9, so
this spike must run before either.

## Method

```bash
bun install
bun run docs/spikes/12-resume-rejection/src/probe.ts
```

Four observations, in order:

| # | observation | expected |
| --- | --- | --- |
| A | resume a fabricated session id from a fresh temp cwd | rejection — capture its full shape |
| B | run a real one-turn session in cwd X, note its session id | succeeds, yields an id |
| C | resume B's id from cwd X (the SAME cwd) | succeeds → intra-turn resume is sound (Q4) |
| D | resume B's id from a DIFFERENT temp cwd | rejects → the cwd diagnosis is confirmed (Q3) |

**Cost.** A costs nothing (it should fail before any model call). B, C and D are three minimal
turns at `effort: "low"` with a one-token-ish reply. Requires a logged-in Claude CLI.

The probe dumps every field of whatever it gets — thrown value, its class name, its own enumerable
properties, its `cause` chain, and every `result`-message field — because Q2's answer is "whichever
of these turns out to be stable", and a summarised capture would throw away the answer.

## What would falsify the task's design

- **Q2 finds no discriminator but the message** → Task 9's classifier ships as a documented narrow
  message match, with the measured string quoted verbatim in the comment, pinned by a test, AND a
  guard that only classifies on a run whose own `SessionPlan` was a resume (so a false positive
  cannot send the driver into a pointless fallback). That guard stops being belt-and-braces and
  becomes load-bearing. Record it as a ledger row with the SDK version it was true for.
- **Q3 refutes the cwd diagnosis** (D succeeds) → RC6 is wrong, the real cause of the measured
  failure is unknown, and Task 9 part 1 (flipping `sessionWorkspaceBinding` to `"fixed"`) is no
  longer justified by evidence. Stop and re-diagnose; do not flip a capability on a diagnosis this
  probe just contradicted.
- **Q4 fails** (C rejects) → **Task 8 is dead**, not just Task 9. A retry could not resume even
  within one turn, and the memoryless retry is not fixable by this route. Report immediately; Task 8
  is scheduled first and would otherwise be built on a false premise.

## Findings

| # | question | answer |
| --- | --- | --- |
| 1 | shape of a rejected resume | **Both**: a `result` message with `subtype: "error_during_execution"`, then the iteration THROWS a plain `Error`. See below. |
| 2 | discriminator other than the message | **YES — and a strong one.** `num_turns: 0`, `total_cost_usd: 0`, `duration_api_ms: 0`, `modelUsage: {}`, plus a dedicated `errors: string[]` field. |
| 3 | same id, original cwd vs. different cwd | **C succeeded, D rejected.** RC6 CONFIRMED: the SDK indexes sessions by cwd. |
| 4 | intra-turn (same cwd) resume works | **YES**, with positive proof it really resumed — see the cache figures below. |
| — | SDK version | `0.3.212` |

### Q1/Q2 — the rejected resume's actual shape

Observation A (fabricated id) and D (real id, wrong cwd) produced identical shapes:

```
.type       = "result"
.subtype    = "error_during_execution"
.is_error   = true
.num_turns  = 0
.duration_api_ms = 0
.total_cost_usd  = 0
.modelUsage = {}
.errors     = ["No conversation found with session ID: b40c398a-…"]
```

then the async iteration threw:

```
class = Error          (a PLAIN Error — no custom class, no `.code`, no `.cause`)
message = Claude Code returned an error result: No conversation found with session ID: b40c398a-…
```

**The throw itself carries nothing usable.** But the `result` message is yielded BEFORE the throw, so
a driver that records the last `result` message has the structured fields. That is what makes Q2's
answer good news:

> **A rejected resume is `is_error === true` AND `num_turns === 0` AND the run asked for a resume.**

Those preconditions are structural and a design page cannot fabricate them — `num_turns: 0` means the
API was never called. Narrowing the `errors[0]` text match with them makes a false positive
essentially impossible, which is far better than the message match the plan was resigned to. Note
`subtype: "error_during_execution"` alone is NOT enough — it is the generic execution-error subtype
and will cover unrelated failures.

### Q4 — the intra-turn resume genuinely resumed, and the cache proves it

Observation B created session `b40c398a-…` with `cache_creation_input_tokens: 17739`. Observation C,
resuming it from the same cwd, reported `cache_read_input_tokens: 17739` and
`cache_creation_input_tokens: 841`. It read back exactly the context B wrote. That is positive
evidence of resumption, not merely the absence of an error — which matters, because a silently-fresh
session would also have "succeeded".

Cost is the second confirmation: B $0.1065, C $0.0104 — a tenth, because the context was cached
rather than re-sent. **This is the measured value of Task 8**: a resumed retry does not re-pay for the
context the rejected attempt already established, on top of not re-reading every doc and page.

### Consequences for Tasks 8 and 9

1. **Task 8 proceeds.** Its premise is confirmed by C, with the cache figures as evidence.
2. **Task 9's classifier uses the structured fields, not the prose.** Require, in order:
   this run's own `SessionPlan.kind === "resume"`; the last `result` message's `is_error === true`;
   `num_turns === 0`; and only then the `errors[]` text. Record the observed string and the SDK
   version in the comment, and pin the whole conjunction with a test.
3. **The stream driver must retain the last `result` message.** Read
   `agent/claude/run/model/drive-stream.ts` and `normalize.ts` before implementing: if the driver
   only surfaces the throw, the structured fields never reach the classifier and Task 9 would be
   forced back onto the message match for no reason. Capturing that message is part of Task 9.
4. **Task 9 part 1 (flipping `sessionWorkspaceBinding` to `"fixed"`) is justified by evidence**, not
   only by the one production failure: D reproduces it deliberately.
