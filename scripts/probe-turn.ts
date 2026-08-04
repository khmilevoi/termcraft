// TEMPORARY DIAGNOSTIC HARNESS (2026-07-26) — delete once the question below is answered.
//
// Answers exactly one question: do the agent's `thinking` content blocks reach us, and do they
// carry text? `Options.thinking` in the installed SDK (0.3.212) documents `{type:'adaptive'}` as
// "the default for models that support it" and we set nothing, so blocks SHOULD arrive — but the
// Messages API separately defaults thinking DISPLAY to "omitted" on Sonnet 5, which would deliver
// blocks whose text is empty. Only a live run separates those two, and the app is an interactive
// TUI that cannot be driven from this environment (no tmux).
//
// So this drives the SAME command surface the TUI drives — `createShell("interactive", env)` then
// `project.open` + `turn.start` at the `KernelPort` — exactly as `entrypoint/model/run-export.ts`
// already does for the headless export mode. It is not a unit test and not an internal-function
// import: it is the app's real Kernel graph, real agent, real turn.
//
//   bun run scripts/probe-turn.ts <project-root> [prompt]
//
// Reads the answer out of `termcraft-debug.jsonl`'s `agent.block` channel (see the TEMPORARY
// trace in `agent/claude/run/model/normalize.ts`), which records block TYPE and text LENGTH only
// — never the text itself.

import path from "node:path";

import type { EventEnvelopeV1 } from "ui/kernel";
import { createDispatcher } from "ui/kernel";

import { createShell } from "../src/entrypoint/model/create-shell";

const TURN_TIMEOUT_MS = 180_000;
const OPEN_TIMEOUT_MS = 60_000;

const [rootArg, ...promptWords] = process.argv.slice(2);
if (rootArg === undefined) {
  console.error("usage: bun run scripts/probe-turn.ts <project-root> [prompt]");
  process.exit(2);
}
const root = path.resolve(process.cwd(), rootArg);
const prompt =
  promptWords.length > 0 ? promptWords.join(" ") : "Say hello and stop. Change nothing.";

console.log(`[probe] root=${root}`);
console.log(`[probe] prompt=${JSON.stringify(prompt)}`);

const composed = await createShell("interactive", {
  root,
  workspaceIdentity: root,
  projectExists: false,
});
if (composed instanceof Error) {
  console.error(`[probe] shell composition failed: ${composed.message}`);
  process.exit(1);
}
if ("kind" in composed) {
  console.error(
    `[probe] project at ${composed.root} is on format 1 — this harness has no migration surface`,
  );
  process.exit(1);
}
const shell = composed;
console.log("[probe] shell composed");

// Minimal event tracker: `run-export.ts` keeps its own private one, so this mirrors it rather
// than reaching into that module.
let revision = "0";
const waiters: { match: (e: EventEnvelopeV1) => boolean; resolve: (e: EventEnvelopeV1) => void }[] =
  [];

// `KernelPort.subscribe` hands the handler the WIDE `EventEnvelopeV1` (every kind in one
// envelope type), not the per-kind `AnyEventEnvelope` union — this probe only reads `kind`,
// `payload` and `stateRevision`, so the wide type is the honest one here.
const unsubscribed = shell.port.subscribe((envelope: EventEnvelopeV1) => {
  revision = envelope.stateRevision;
  console.log(`[event] ${envelope.kind}`);
  for (let i = waiters.length - 1; i >= 0; i--) {
    const waiter = waiters[i];
    if (waiter !== undefined && waiter.match(envelope)) {
      waiters.splice(i, 1);
      waiter.resolve(envelope);
    }
  }
});

if (unsubscribed instanceof Error) {
  console.error(`[probe] subscribe failed: ${unsubscribed.message}`);
  process.exit(1);
}
const unsubscribe = unsubscribed;

function waitFor(
  match: (e: EventEnvelopeV1) => boolean,
  timeoutMs: number,
  label: string,
): Promise<EventEnvelopeV1> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
    waiters.push({
      match,
      resolve: (event) => {
        clearTimeout(timer);
        resolve(event);
      },
    });
  });
}

const dispatcher = createDispatcher({ port: shell.port, revision: () => revision });

async function main(): Promise<void> {
  const opened = await dispatcher.dispatch("project.open", { root });
  if (opened instanceof Error) throw opened;
  if (opened.status === "rejected") throw new Error(`project.open rejected: ${opened.code}`);
  console.log("[probe] project.open accepted");

  await waitFor(
    (e) =>
      e.kind === "kernel.stateChanged" &&
      (e.payload as { modelId?: string }).modelId === "kernel.project.state" &&
      String((e.payload as { nextTag?: string }).nextTag) === "ready",
    OPEN_TIMEOUT_MS,
    "project ready",
  );
  console.log("[probe] project ready");

  const started = await dispatcher.dispatch("turn.start", { text: prompt });
  if (started instanceof Error) throw started;
  if (started.status === "rejected") throw new Error(`turn.start rejected: ${started.code}`);
  console.log(`[probe] turn.start accepted (${started.disposition})`);

  const terminal = await waitFor(
    (e) => e.kind === "turn.completed" || e.kind === "turn.failed",
    TURN_TIMEOUT_MS,
    "turn terminal event",
  );
  console.log(`[probe] turn finished: ${terminal.kind}`);
}

try {
  await main();
} catch (error) {
  console.error(`[probe] FAILED: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  unsubscribe();
  await shell.close().catch((e: unknown) => console.error("[probe] close failed", e));
  console.log("[probe] done");
  process.exit(0);
}
