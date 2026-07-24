import type { FailureDtoV1 } from "core/protocol";

import {
  EXPORT_POINTER_TARGET,
  type ExportPointerFileV1,
  type ExportPointerV1,
  type ExportPublicationV1,
  type ExportPublishPlanV1,
  type ExportPublishPort,
} from "../export-publish";
import type { AssertConforms } from "../index";
import { type FakeCallSequence, createSequence } from "./project-write";

/**
 * In-memory {@link ExportPublishPort} fake (B6 task brief; WP-5 Phase C task C1 adds the
 * read side). No real transaction/journal is implemented — a test that needs
 * `EXPORT_PUBLICATION_FAILED` SCRIPTS that exact failure via `failNext(...)` rather than the
 * fake deriving it from journal state, matching this ring's "programmable failure" design.
 * `publish()` never reads the wall clock: the returned `recordedAt` echoes `plan.createdAt`
 * verbatim, since that is the injected clock's own read at plan-build time, not a fact this
 * fake is entitled to recompute.
 *
 * `readPointer()` is DERIVED from the plan's own operations rather than separately
 * scripted (unlike `publish()`'s failure path): every successful `publish()` call becomes
 * the new "current" pointer, built straight from that plan's `replace` operations minus the
 * pointer's own target — an honest reflection of "what the last publish actually wrote",
 * not a second parallel model of on-disk state. `failNextRead(...)` still exists, as its own
 * queue independent of `failNext(...)`, for tests that need to script an unparseable/corrupt
 * pointer without constructing a plan whose payload happens to be malformed.
 *
 * `seq`/`sequence` mirror `project-write.ts`'s own `FakeProjectWriteCoordinator` exactly —
 * an optional shared {@link FakeCallSequence} lets a test interleave this fake's own call
 * log with `FakeProjectWriteCoordinator`'s, proving cross-port ordering (e.g. "publish()
 * happened before release()", not just "both happened") that two independent call logs
 * cannot establish on their own.
 */

export type ExportPublishCall =
  | { readonly seq: number; readonly method: "publish"; readonly plan: ExportPublishPlanV1 }
  | { readonly seq: number; readonly method: "readPointer" };

export interface FakeExportPublish extends ExportPublishPort {
  readonly calls: readonly ExportPublishCall[];
  /** Queues exactly one {@link FailureDtoV1} for the next `publish()` call (FIFO). */
  failNext(failure: FailureDtoV1): void;
  /**
   * Queues exactly one {@link FailureDtoV1} for the next `readPointer()` call (FIFO) — a
   * SEPARATE queue from {@link failNext}: a corrupt on-disk pointer never implies the next
   * publish attempt is doomed, and vice versa, so the two methods fail independently.
   */
  failNextRead(failure: FailureDtoV1): void;
}

/**
 * D-Q2's manifest, straight from the plan: every `replace` op except the pointer's own
 * target IS a generation file; a `delete` op belongs to the OLD generation being cleaned up
 * (D-Q5), never the new one, so it is excluded too.
 */
function derivePointer(plan: ExportPublishPlanV1): ExportPointerV1 {
  const files: Record<string, ExportPointerFileV1> = {};
  for (const op of plan.operations) {
    if (op.target === EXPORT_POINTER_TARGET) continue;
    if (op.mode !== "replace") continue;
    if (op.newImage.state !== "file") continue;
    files[op.target] = { sha256: op.newImage.sha256, size: op.newImage.size };
  }
  return { schemaVersion: 1, generationId: plan.generationId, files };
}

export function createFakeExportPublish(options?: {
  readonly sequence?: FakeCallSequence;
}): FakeExportPublish {
  const sequence = options?.sequence ?? createSequence();
  const calls: ExportPublishCall[] = [];
  const publishQueue: FailureDtoV1[] = [];
  const readQueue: FailureDtoV1[] = [];
  let counter = 0;
  let currentPointer: ExportPointerV1 | null = null;

  function failNext(failure: FailureDtoV1): void {
    publishQueue.push(failure);
  }

  function failNextRead(failure: FailureDtoV1): void {
    readQueue.push(failure);
  }

  async function publish(plan: ExportPublishPlanV1): Promise<FailureDtoV1 | ExportPublicationV1> {
    calls.push({ seq: sequence.next(), method: "publish", plan });
    const queued = publishQueue.shift();
    if (queued !== undefined) return queued;

    currentPointer = derivePointer(plan);

    counter += 1;
    return {
      transactionId: `fake-export-publish-${counter}`,
      generationId: plan.generationId,
      pageCount: plan.pageCount,
      recordedAt: plan.createdAt,
    };
  }

  async function readPointer(): Promise<FailureDtoV1 | ExportPointerV1 | null> {
    calls.push({ seq: sequence.next(), method: "readPointer" });
    const queued = readQueue.shift();
    if (queued !== undefined) return queued;
    return currentPointer;
  }

  return { publish, readPointer, calls, failNext, failNextRead };
}

type _Conforms = AssertConforms<ExportPublishPort, FakeExportPublish>;
