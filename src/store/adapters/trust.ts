import type { AssertConforms, GitIdentityV1, TrustGate, TrustSubjectV1 } from "core/ports";
import type { FailureDtoV1 } from "core/protocol";

import { toFailureDto } from "./failure";
import type { StoreAdapterDeps } from "./types";

// `createTrustAdapter` — the `TrustGate` port over `OpenProject.trust` (`TrustStore`, plan
// Task 3). `GitIdentityV1`/`TrustSubjectV1` are structural redraws of the store's
// `GitIdentity`/`TrustSubject` that are field-for-field identical, so every method here is a
// direct pass-through with only the error channel mapped. `isGranted` never fails open —
// it returns the store's own `boolean` unchanged, never wrapped in a `FailureDtoV1` branch.

export function createTrustAdapter(deps: StoreAdapterDeps): TrustGate {
  const { open } = deps;

  async function buildSubject(
    root: string,
    projectId: string,
    git: GitIdentityV1 | null,
  ): Promise<FailureDtoV1 | TrustSubjectV1> {
    const result = await open.trust.buildSubject(root, projectId, git);
    if (result instanceof Error) return toFailureDto(result);
    return result;
  }

  async function isGranted(subject: TrustSubjectV1): Promise<boolean> {
    return open.trust.isGranted(subject);
  }

  async function grant(subject: TrustSubjectV1): Promise<FailureDtoV1 | undefined> {
    const result = await open.trust.grant(subject);
    if (result instanceof Error) return toFailureDto(result);
    return undefined;
  }

  return { buildSubject, isGranted, grant };
}

type _Conforms = AssertConforms<TrustGate, ReturnType<typeof createTrustAdapter>>;
