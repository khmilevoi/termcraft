import type {
  AssertConforms,
  ProjectLeaseIdentityV1,
  ProjectManifestV1,
  ProjectStore,
  ReadSetFileSnapshotV1,
  WorkspaceStateReadV1,
  WorkspaceStateV1,
} from "core/ports";
import type { FailureDtoV1 } from "core/protocol";
import { sha256Hex } from "store/jsonl";
import { PROJECT_MANIFEST_FILENAME } from "store/toml";
import type { ProjectManifest, WorkspaceLocalState } from "store/toml";

import { toFailureDto } from "./failure";
import type { StoreAdapterDeps } from "./types";
import { nowIso } from "./types";

// `createProjectStoreAdapter` — the `ProjectStore` port over `OpenProject`'s
// `root`/`lease`/`manifest`/`workspaceState` facade (plan Task 1). Type-only imports from
// `core/ports` (decision C2) prove conformance; nothing under `core/` is imported as a value.

function toManifestV1(manifest: ProjectManifest): ProjectManifestV1 {
  return {
    projectId: manifest.projectId,
    name: manifest.name,
    createdAt: manifest.createdAt,
    targetStack: manifest.targetStack,
  };
}

function toWorkspaceStateV1(state: WorkspaceLocalState): WorkspaceStateV1 {
  return {
    activePageSlug: state.activePageSlug,
    activeChatId: state.activeChatId,
    backend: state.backend,
    model: state.model,
    effort: state.effort,
    previewSizeMode: state.previewSizeMode,
    previewSizePreset: state.previewSizePreset,
    previewCustomWidth: state.previewCustomWidth,
    previewCustomHeight: state.previewCustomHeight,
    themeOverride: state.themeOverride,
    colorCapability: state.colorCapability,
    renderMode: state.renderMode,
    fullscreenPreview: state.fullscreenPreview,
    sessionCheckpoints: state.sessionCheckpoints,
    resourceLimits: state.resourceLimits,
  };
}

export function createProjectStoreAdapter(deps: StoreAdapterDeps): ProjectStore {
  const { open } = deps;

  // `ProjectLeaseIdentityV1` is "a held `ProjectLease` minus its OS-handle internals" — the
  // real store `ProjectLease` (`store/lease/types.ts`) carries `nonce`/`lockPath`/`release()`,
  // none of which is a project root path, so `open.root` (already the exact fact this port
  // wants) is the honest source, not `open.lease` itself.
  const lease: ProjectLeaseIdentityV1 = { root: open.root };

  async function readManifest(): Promise<FailureDtoV1 | ProjectManifestV1> {
    const result = await open.manifest.read();
    if (result instanceof Error) return toFailureDto(result);
    return toManifestV1(result);
  }

  async function readManifestSnapshot(): Promise<FailureDtoV1 | ReadSetFileSnapshotV1> {
    const bytes = open.safeFs.readFile(PROJECT_MANIFEST_FILENAME);
    if (bytes instanceof Error) return toFailureDto(bytes);
    return { sha256: sha256Hex(bytes), size: bytes.byteLength };
  }

  async function readWorkspaceState(): Promise<FailureDtoV1 | WorkspaceStateReadV1> {
    const result = await open.workspaceState.read();
    if (result instanceof Error) return toFailureDto(result);
    return {
      state: toWorkspaceStateV1(result.state),
      missing: result.missing,
      corrupt: result.corrupt !== null,
    };
  }

  async function writeWorkspaceState(
    patch: Partial<WorkspaceStateV1>,
  ): Promise<FailureDtoV1 | undefined> {
    const result = await open.transactions.setWorkspaceLocal({
      transactionId: deps.uuidv7(),
      actionId: deps.uuidv7(),
      patch,
      createdAt: nowIso(deps.clock),
    });
    if (result instanceof Error) return toFailureDto(result);
    return undefined;
  }

  async function close(): Promise<void> {
    await open.close();
  }

  return {
    root: open.root,
    lease,
    readManifest,
    readManifestSnapshot,
    readWorkspaceState,
    writeWorkspaceState,
    close,
  };
}

type _Conforms = AssertConforms<ProjectStore, ReturnType<typeof createProjectStoreAdapter>>;
