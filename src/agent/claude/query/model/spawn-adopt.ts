import { spawn } from "node:child_process";

import type { SpawnOptions, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";

import { log, trace } from "infrastructure/debug-log";
import type { ProcessTree } from "infrastructure/process";

/**
 * Spawns the Claude CLI ourselves (instead of letting the SDK spawn it
 * internally) so the resulting `ChildProcess` — and its `.pid` — can be adopted
 * into the injected `ProcessTree` (owned Job Object, Spike I / §6.5). A real
 * Node `ChildProcess` satisfies the SDK's `SpawnedProcess` interface, so no
 * cast is needed — if that ever stops holding, the typecheck fails here rather
 * than the mismatch being absorbed.
 *
 * Both SDK entry points that spawn a CLI use this: a fenced turn
 * (`query-options.ts`) and the health probe (`probe.ts`). They must not drift —
 * a probe with a weaker adoption contract than a turn is exactly the unowned
 * orphan that §6.5's confirmed-exit guarantee exists to prevent. `logLabel`
 * only names the caller in warnings; the ownership contract is identical.
 *
 * Non-Reatom: this closure owns no Reatom lifetime — the spawned process and
 * its Job Object membership are explicit, adapter-owned state (CLAUDE.md /
 * plan Global Constraints), matching `agent/`'s non-Reatom adapter status.
 */
export function createSpawnAndAdopt(
  processTree: ProcessTree,
  logLabel: string,
): (options: SpawnOptions) => SpawnedProcess {
  return (options: SpawnOptions): SpawnedProcess => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      // `options.signal` is the SDK's forwarded graceful signal — safe to pass.
      signal: options.signal,
    });

    if (typeof child.pid !== "number") {
      log.warn(
        `${logLabel}: spawned CLI has no pid, cannot adopt it into the owned process tree`,
      );
      // Recording the failure on the tree is the only channel back to the
      // caller (errore rule 21 covers the log; the flag covers correctness):
      // an exit-confirmation poll must never read a tree nothing was ever
      // adopted into as "confirmed drained".
      processTree.noteAdoptionOutcome(false);
      return child;
    }

    const adopted = processTree.adopt(child.pid);
    if (adopted instanceof Error) {
      log.warn(
        `${logLabel}: adopt(${child.pid}) failed, the process tree may not own the CLI:`,
        adopted.message,
      );
      processTree.noteAdoptionOutcome(false);
      return child;
    }

    // The assign-before-descendant-spawn race is not OS-guaranteed (no
    // `CREATE_SUSPENDED` reachable from Bun/Node spawn) — re-read
    // `activeProcesses()` to verify membership rather than assume the `adopt`
    // call above actually landed the process in the job.
    const verified = processTree.activeProcesses();
    if (verified instanceof Error) {
      log.warn(
        `${logLabel}: activeProcesses() re-read after adopt(${child.pid}) failed:`,
        verified.message,
      );
      processTree.noteAdoptionOutcome(false);
      return child;
    }
    if (verified < 1) {
      log.warn(
        `${logLabel}: activeProcesses() re-read reported ${verified} immediately after adopt(${child.pid})`,
      );
      processTree.noteAdoptionOutcome(false);
      return child;
    }

    // DIAGNOSTIC (infrastructure/debug-log): the CLI process this call spawned and successfully
    // adopted into the owned process tree -- the vendor process backing the whole agent run.
    trace("agent.claude.spawnAdopt.adopted", {
      logLabel,
      pid: child.pid,
      command: options.command,
    });
    processTree.noteAdoptionOutcome(true);
    return child;
  };
}
