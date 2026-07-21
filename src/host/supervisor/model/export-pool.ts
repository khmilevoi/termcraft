import { ProtocolError } from "../../protocol";
import type { ExportPool, ExportTask, ExportTaskOutcome, OneShotResult } from "../types";
import { SupervisorError } from "./errors";

/**
 * Injected seam for the bounded export worker pool (§11.4). `runTask` drives ONE
 * one-shot export incarnation to its typed result — the pool never spawns a
 * process itself, so no process starts outside the pool. `cpuCount` sizes the
 * default worker count; `workers` is the optional machine-local override.
 */
export interface ExportPoolDeps {
  readonly runTask: (task: ExportTask) => Promise<ProtocolError | SupervisorError | OneShotResult>;
  readonly cpuCount: number;
  readonly workers?: number;
}

/**
 * §11.4 worker count: no override → `min(4, max(1, floor(cpu/2)))`. An explicit
 * override is clamped into [1, 8] — the spec says "zero and unbounded are invalid",
 * so clamping 0/negative up to 1 and >8 down to 8 is the defensive resolution.
 */
export function resolveExportWorkerCount(cpuCount: number, override?: number): number {
  if (override === undefined) return Math.min(4, Math.max(1, Math.floor(cpuCount / 2)));
  return Math.min(8, Math.max(1, Math.floor(override)));
}

/** Publish order is manifest then (w, h) — NEVER completion order (§11.4). */
function byManifestThenSize(a: ExportTaskOutcome, b: ExportTaskOutcome): number {
  return (
    a.manifestIndex - b.manifestIndex ||
    a.spec.size.w - b.spec.size.w ||
    a.spec.size.h - b.spec.size.h
  );
}

/**
 * The bounded export worker pool (§11.4). At most `resolveExportWorkerCount(...)`
 * tasks run concurrently: a fixed set of `min(workerCount, tasks.length)` worker
 * loops pull the next task by a shared cursor, so no more processes than workers
 * ever exist. Results are returned SORTED by `(manifestIndex, w, h)` — never
 * completion order — so pool scheduling cannot change the exported package bytes.
 * All-or-nothing: on the first task failure the pool stops pulling new tasks and
 * returns THAT failure; in-flight tasks settle on their own. Each one-shot session
 * owns its child's deadline/kill, so the pool never force-kills in-flight itself.
 */
export function createExportPool(deps: ExportPoolDeps): ExportPool {
  return {
    async run(tasks) {
      if (tasks.length === 0) return [];

      const workerCount = resolveExportWorkerCount(deps.cpuCount, deps.workers);
      const outcomes: ExportTaskOutcome[] = [];
      let nextIndex = 0;
      let failure: ProtocolError | SupervisorError | null = null;

      // One worker loop: pull the next task by the shared cursor until the queue
      // drains or a sibling recorded the first failure (all-or-nothing cancel).
      // The read+increment is synchronous (no await between them), so the cursor
      // hands each task to exactly one worker.
      async function worker(): Promise<void> {
        while (true) {
          if (failure !== null) return;
          const index = nextIndex;
          if (index >= tasks.length) return;
          nextIndex = index + 1;
          const task = tasks[index];
          if (task === undefined) return;
          const result = await deps.runTask(task);
          if (result instanceof Error) {
            if (failure === null) failure = result;
            else
              console.warn("export pool: dropping a secondary in-flight failure:", result.message);
            return;
          }
          outcomes.push({ manifestIndex: task.manifestIndex, spec: task.spec, result });
        }
      }

      const loopCount = Math.min(workerCount, tasks.length);
      await Promise.all(Array.from({ length: loopCount }, () => worker()));

      if (failure !== null) return failure;
      return outcomes.sort(byManifestThenSize);
    },
  };
}
