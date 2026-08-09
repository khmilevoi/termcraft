# Spike 11 — an in-process SDK MCP tool inside termcraft's confinement

**Verdict: YES — all four questions answered. Task 12's mechanism is sound.**

Both tiers run 2026-08-09 at `2f816d7`, `@anthropic-ai/claude-agent-sdk@0.3.212`, `zod@4.4.3`.
Tier 2 cost **$0.2098**. The in-process server IS reachable through `createSpawnAndAdopt`; the tool
name is exactly the predicted `mcp__termcraft__check_design`.

**Two findings the spike did not set out to look for**: the SDK does not validate schemas at the
handler boundary (S3), and **a tool ran without `canUseTool` being consulted at all** (S4 — this one
contradicts a standing claim in `docs/spikes/08-agent-confinement/FINDINGS.md`).

Gates Task 12 of `docs/superpowers/plans/2026-08-09-design-agent-feedback-loop.md` (spec WP-10) —
the largest task in the plan and the one whose failure mode is most expensive: a half-built tool
that the agent can see but not call, or can call but that reports nothing useful.

## The question

Four, in ascending cost. Q1 and Q2 are free; Q3 and Q4 cost a live turn.

1. **Does the SDK's `tool()` accept a `zod@4` raw shape?** `tool` is declared over
   `AnyZodRawShape` (`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:6794,3898`), typed
   against whatever zod the SDK itself peers on. This repository is on `zod@^4.4.3` and has already
   been bitten by a zod-version assumption once (`memory: Zod v4 .finite() is a no-op`). A
   majors mismatch is a **hard stop** for the task's design, not something to paper over: an
   invented schema shim is exactly the fabrication `CLAUDE.md`'s honest-values rule forbids.

2. **Does `Options.mcpServers` accept what `createSdkMcpServer` returns, in OUR `Options`
   construction?** `McpSdkServerConfigWithInstance` is a member of the `McpServerConfig` union
   (`sdk.d.ts:1030-1037`) and `Options.mcpServers?: Record<string, McpServerConfig>` (`:1669`), so
   this should typecheck. Confirm it against `buildQueryOptions`'s real object literal
   (`src/agent/claude/query/model/query-options.ts:24`) rather than against the declaration in
   isolation — that literal also sets `settingSources: []`, `permissionMode: "default"` and
   `disallowedTools`, and the interaction is the question.

3. **What tool name reaches `canUseTool`?** The convention is `mcp__<server>__<tool>`, but
   `src/agent/confinement/model/policy.ts:44-48` is deny-by-default on an exact string match, so
   the confinement table must contain the **real** name. Read it off a run. Getting this wrong
   produces a tool the agent sees advertised and is refused on every call — strictly worse than no
   tool, because the agent will retry it.

4. **Does an in-process MCP server survive our custom spawn?** This is the spike's real reason.
   termcraft does not let the SDK spawn the CLI: `createSpawnAndAdopt`
   (`src/agent/claude/query/model/spawn-adopt.ts:30-38`) intercepts `spawnClaudeCodeProcess` so the
   child can be adopted into an owned Job Object (Spike I / §6.5). It forwards `command`, `args`,
   `cwd`, `env` and `signal` — and **specifies no `stdio`**, so Node's default
   `['pipe','pipe','pipe']` applies. If the SDK's in-process MCP transport needs a file descriptor
   beyond those three, or an `stdio` shape the SDK would have set itself, the server is silently
   unreachable from the child. Nothing in the SDK's types says either way.

   `settingSources: []` is the second half of this question: it isolates the turn from the user's
   own settings, and MCP servers are ordinarily a settings-level concept. Confirm that an
   `Options.mcpServers` entry is not filtered out by that isolation.

## Why this is a spike and not a task step

Q4 cannot be answered by reading. The SDK's MCP wiring is internal, the spawn interception is
ours, and the failure is silent — the turn runs, the agent never successfully calls the tool, and
the symptom is indistinguishable from "the model chose not to use it". Discovering that at the end
of the plan's largest task, after the module, the confinement change and the prompt paragraph are
all written, is the outcome this spike exists to prevent.

## Method

Two tiers. **Run tier 1 first and stop if it fails** — tier 2 costs a paid turn.

### Tier 1 — free, no network, no turn

```bash
bun install
bun run docs/spikes/11-sdk-mcp-tool/src/probe-tier1.ts
bun x tsc --noEmit                 # Q1/Q2 are partly TYPE questions; the probe pins the runtime half
```

Answers Q1 and Q2: constructs a real `check_design`-shaped tool with a `zod@4` schema, builds a
server, feeds it through the real `buildQueryOptions` shape, and calls the tool's handler directly
so the schema's runtime behaviour is observed rather than assumed.

### Tier 2 — one live turn, costs money

```bash
bun run docs/spikes/11-sdk-mcp-tool/src/probe-tier2.ts
```

Answers Q3 and Q4. Runs ONE minimal turn in a throwaway workspace with a system prompt that asks
for exactly one `check_design` call and nothing else, with `canUseTool` instrumented to log every
name it is asked about and to ALLOW the MCP name whatever it turns out to be. Reports: the names
`canUseTool` saw, whether the handler ran, and what the model received back.

**This tier requires a logged-in Claude CLI and spends tokens.** Do not run it inside CI, and do not
run it as part of an automated plan execution without the operator's say-so.

## What would falsify the task's design

- **Q1 answers NO** → stop and report. Do not write a schema shim, do not downgrade zod, do not
  hand-roll a JSON Schema by hand to route around it. The honest options are: wait for an SDK that
  peers zod@4, or drop the MCP-tool shape for something the SDK types support natively — and that
  is a design decision, not a task's.
- **Q3 shows a name our table cannot express** (dynamic, per-run, or unstable across runs) → the
  confinement change needs a PREFIX rule rather than an exact-name set, which widens deny-by-default
  in a way that needs its own argument. Do not add a prefix match silently; that is the one part of
  this project's tool policy nothing else weakens.
- **Q4 answers NO** → the task's mechanism is dead in its current shape, and the fix is a spawn
  change, not a tool change. Two candidates, in order: forward the SDK's own `stdio` if
  `SpawnOptions` carries one, or stop intercepting the spawn for turns that register an MCP server
  — the second trades the Job Object guarantee (§6.5's confirmed process-tree exit) for the tool,
  which is **not** a trade to make quietly. Report and stop.

## Findings

| # | question | answer | evidence |
| --- | --- | --- | --- |
| 1 | `tool()` accepts a zod@4 raw shape? | **YES**, both empty `{}` and `{slug: z.string()}` | Constructed, and both handlers RAN: `ok-pathless`, `ok-scoped:home`. Type half confirmed separately — see the typecheck note below. |
| 1b | does the SDK validate against the schema? | **NO** | `handler({slug: 42})` **resolved** with `ok-scoped:42` instead of rejecting. |
| 2 | `Options.mcpServers` accepted by our literal? | **YES** | `createSdkMcpServer` returns `type=sdk`; spread over the real `buildQueryOptions` output keeps `settingSources=[]`, `permissionMode=default`, `disallowedTools=["Bash","BashOutput","KillShell","WebFetch","WebSearch"]`, `canUseTool` present, `mcpServers` keys `["termcraft"]`. |
| 3 | tool name seen by `canUseTool` | **`mcp__termcraft__check_design`** — exactly as predicted | `canUseTool` was asked about that ONE name and no other. |
| 4 | server reachable through `createSpawnAndAdopt`? | **YES — full round trip** | handler invocations: 1; the sentinel `SPIKE11-HANDLER-DID-RUN-7f3a91` reached the model's reply, and the run's `result.result` is the handler's own text. `num_turns: 3`. |
| 3b | `tool_use` names the model emitted | **`ToolSearch`, then `mcp__termcraft__check_design`** | The MCP tool was surfaced as a DEFERRED tool the model had to search for first. See S4. |

**The typecheck needed its own run, and this is worth knowing before trusting any probe here.**
`tsconfig.json:42` **excludes `docs/spikes`**, so a plain `bun x tsc --noEmit` never looks at these
files and its clean exit is not evidence. The type half of Q1/Q2 was confirmed with a temporary
config that `extends` the repo's, lists the three probe files, and overrides `typeRoots` to the
repo's `node_modules/@types` (without that override `tsc` reports
`TS2688: Cannot find type definition file for 'bun'`, because `typeRoots` resolves relative to the
config file's own directory — the same trap `scripts/gen-runtime-dts.ts:90-91` documents). With that
config: **clean**, so `InferShape` does flow zod@4's types through to `args.slug`.

### S4 — a tool ran WITHOUT `canUseTool` being consulted, and that contradicts a standing claim

The model emitted **two** `tool_use` blocks — `ToolSearch` first, then
`mcp__termcraft__check_design` — while `canUseTool` was asked about **only the second**. So
`ToolSearch` executed without passing through the in-process veto.

`docs/spikes/08-agent-confinement/FINDINGS.md` records, as its Claude verdict, the claim it set out to
test: "the SDK's per-call permission callback gives termcraft an in-process veto on **every** tool
use". **That is now measurably incomplete.** Observed here, verbatim: one tool ran, unvetoed.

Read this precisely, without overclaiming:

- `ToolSearch` is a schema-fetching meta-tool — it loads tool definitions and does no I/O of its own,
  so the confinement risk from this specific instance is low.
- This probe set **no `disallowedTools`** (unlike production, `query-options.ts:29`), so it does not
  show whether the `disallowedTools` list would have stopped it. It shows only that the CALLBACK was
  not consulted.
- Whether other CLI-internal tools behave the same way is UNKNOWN and was not probed.

**What follows for Task 12.** Nothing blocking: the confinement table needs exactly
`mcp__termcraft__check_design`, and Q4 is satisfied. But there is a live question — **if MCP tools are
surfaced as deferred tools behind `ToolSearch`, can the agent reach `check_design` when the veto and
`disallowedTools` are both in force?** In this probe `ToolSearch` was never vetoed, so it worked. If a
future SDK routes it through `canUseTool`, deny-by-default would refuse it and `check_design` would
become **unreachable** — the tool advertised and never callable, which the plan already names as
strictly worse than no tool. Task 12 must add a test that drives the whole path with the REAL
production `canUseTool` in place, not merely assert the table's contents.

Ledger this as its own row against `08-agent-confinement`'s claim, with the observation above. It is
not this plan's to fix, and it must not be filed as a limitation — the claim it contradicts is load
bearing for the whole confinement story.

### Consequence for Task 12 (from Q1b)

**`check_design`'s handler must validate its own input.** The SDK does not enforce the declared
schema at the handler boundary — a wrong-typed field arrived at the handler untouched. For the
pathless tool this is nearly moot (there is no input), which is one more argument for keeping it
pathless; but if Task 12 ever adds the `slug` variant, the handler validates with the repo's own
`zod` before use, exactly as `entities/*`'s decoders do, and the plan says so rather than trusting
the declaration.
