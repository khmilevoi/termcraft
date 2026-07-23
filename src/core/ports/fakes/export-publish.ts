import type { FailureDtoV1 } from "core/protocol";

import type {
  ExportPublicationV1,
  ExportPublishPlanV1,
  ExportPublishPort,
} from "../export-publish";
import type { AssertConforms } from "../index";

/**
 * In-memory {@link ExportPublishPort} fake (B6 task brief). No real transaction/journal is
 * implemented — a test that needs `EXPORT_PUBLICATION_FAILED` SCRIPTS that exact failure
 * via `failNext(...)` rather than the fake deriving it from journal state, matching this
 * ring's "programmable failure" design. `publish()` never reads the wall clock: the
 * returned `recordedAt` echoes `plan.createdAt` verbatim, since that is the injected
 * clock's own read at plan-build time, not a fact this fake is entitled to recompute.
 */

export interface ExportPublishCall {
  readonly method: "publish";
  readonly plan: ExportPublishPlanV1;
}

export interface FakeExportPublish extends ExportPublishPort {
  readonly calls: readonly ExportPublishCall[];
  failNext(failure: FailureDtoV1): void;
}

export function createFakeExportPublish(): FakeExportPublish {
  const calls: ExportPublishCall[] = [];
  const queue: FailureDtoV1[] = [];
  let counter = 0;

  function failNext(failure: FailureDtoV1): void {
    queue.push(failure);
  }

  async function publish(plan: ExportPublishPlanV1): Promise<FailureDtoV1 | ExportPublicationV1> {
    calls.push({ method: "publish", plan });
    const queued = queue.shift();
    if (queued !== undefined) return queued;

    counter += 1;
    return {
      transactionId: `fake-export-publish-${counter}`,
      generationId: plan.generationId,
      pageCount: plan.pageCount,
      recordedAt: plan.createdAt,
    };
  }

  return { publish, calls, failNext };
}

type _Conforms = AssertConforms<ExportPublishPort, FakeExportPublish>;
