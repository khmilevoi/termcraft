import type {
  AssertConforms,
  DesignSystemSource as CoreDesignSystemSource,
  DesignSystemSummaryV1,
  FetchedPackageV1,
  LocalPackageV1,
  PublishReceiptV1,
} from "core/ports";
import type { FailureDtoV1 } from "core/protocol";
import type { DesignSystemRef } from "entities/design-system-ref";
import type { DesignSystemSource } from "store/design-systems";

import { toFailureDto } from "./failure";

/**
 * `createDesignSystemSourceAdapter` — the `DesignSystemSource` port over any store-side source
 * (`store/design-systems`). The store's `DesignSystemSummary`/`FetchedPackage`/`LocalPackage`/
 * `PublishReceipt` are field-for-field identical to the port's `…V1` redraws, so every method is
 * a direct pass-through with only the error channel mapped — the same relationship
 * `createTrustAdapter` has with `TrustStore`.
 *
 * It takes a SOURCE, not deps: only the failure mapping is shared between source families, so
 * one adapter wraps the local source today and a GitHub source later without changing the port
 * (design §10's one requirement on this work).
 */
export function createDesignSystemSourceAdapter(
  source: DesignSystemSource,
): CoreDesignSystemSource {
  async function list(): Promise<FailureDtoV1 | readonly DesignSystemSummaryV1[]> {
    const result = await source.list();
    if (result instanceof Error) return toFailureDto(result);
    return result;
  }

  async function fetch(ref: DesignSystemRef): Promise<FailureDtoV1 | FetchedPackageV1> {
    const result = await source.fetch(ref);
    if (result instanceof Error) return toFailureDto(result);
    return result;
  }

  async function publish(pkg: LocalPackageV1): Promise<FailureDtoV1 | PublishReceiptV1> {
    const result = await source.publish(pkg);
    if (result instanceof Error) return toFailureDto(result);
    return result;
  }

  return {
    id: source.id,
    label: source.label,
    canPublish: source.canPublish,
    list,
    fetch,
    publish,
  };
}

type _Conforms = AssertConforms<
  CoreDesignSystemSource,
  ReturnType<typeof createDesignSystemSourceAdapter>
>;
