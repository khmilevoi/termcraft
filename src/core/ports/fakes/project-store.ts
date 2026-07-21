import type { FailureDtoV1 } from "core/protocol";

import type { AssertConforms } from "../index";
import type {
  ProjectLeaseIdentityV1,
  ProjectManifestV1,
  ProjectStore,
  WorkspaceStateReadV1,
  WorkspaceStateV1,
} from "../project-store";

/**
 * In-memory {@link ProjectStore} fake (6D task brief). Backed by a mutable manifest and a
 * mutable workspace-state read (both settable at construction, both readable/writable
 * through the port's own methods) — a store-shaped port gets its "success" path from
 * inspectable state, not from a scripted return-value queue, so a test can both drive the
 * fake through `writeWorkspaceState` and assert on it directly via `state`.
 */

const DEFAULT_WORKSPACE_STATE: WorkspaceStateV1 = {
  activePageSlug: null,
  activeChatId: null,
  backend: null,
  model: null,
  effort: null,
  previewSizeMode: "auto",
  previewSizePreset: null,
  previewCustomWidth: null,
  previewCustomHeight: null,
  themeOverride: null,
  colorCapability: null,
  renderMode: "static",
  fullscreenPreview: false,
  sessionCheckpoints: [],
  resourceLimits: {},
};

export type ProjectStoreFailableMethod =
  | "readManifest"
  | "readWorkspaceState"
  | "writeWorkspaceState";

export type ProjectStoreCall =
  | { readonly method: "readManifest" }
  | { readonly method: "readWorkspaceState" }
  | { readonly method: "writeWorkspaceState"; readonly patch: Partial<WorkspaceStateV1> }
  | { readonly method: "close" };

export interface FakeProjectStore extends ProjectStore {
  readonly calls: readonly ProjectStoreCall[];
  /** Queues exactly one {@link FailureDtoV1} for the next call to `method` (FIFO; consumed one at a time). */
  failNext(method: ProjectStoreFailableMethod, failure: FailureDtoV1): void;
}

export function createFakeProjectStore(options: {
  readonly root: string;
  readonly manifest?: Partial<ProjectManifestV1>;
  readonly workspaceState?: Partial<WorkspaceStateV1>;
}): FakeProjectStore {
  const lease: ProjectLeaseIdentityV1 = { root: options.root };
  const manifest: ProjectManifestV1 = {
    projectId: "fake-project-1",
    name: "Fake Project",
    createdAt: "2024-01-01T00:00:00.000Z",
    targetStack: "generic",
    pages: [],
    ...options.manifest,
  };
  let state: WorkspaceStateV1 = { ...DEFAULT_WORKSPACE_STATE, ...options.workspaceState };
  let missing = options.workspaceState === undefined;
  let corrupt = false;

  const calls: ProjectStoreCall[] = [];
  const queues: Record<ProjectStoreFailableMethod, FailureDtoV1[]> = {
    readManifest: [],
    readWorkspaceState: [],
    writeWorkspaceState: [],
  };

  function failNext(method: ProjectStoreFailableMethod, failure: FailureDtoV1): void {
    queues[method].push(failure);
  }

  async function readManifest(): Promise<FailureDtoV1 | ProjectManifestV1> {
    calls.push({ method: "readManifest" });
    const queued = queues.readManifest.shift();
    if (queued !== undefined) return queued;
    return manifest;
  }

  async function readWorkspaceState(): Promise<FailureDtoV1 | WorkspaceStateReadV1> {
    calls.push({ method: "readWorkspaceState" });
    const queued = queues.readWorkspaceState.shift();
    if (queued !== undefined) return queued;
    return { state, missing, corrupt };
  }

  async function writeWorkspaceState(
    patch: Partial<WorkspaceStateV1>,
  ): Promise<FailureDtoV1 | undefined> {
    calls.push({ method: "writeWorkspaceState", patch });
    const queued = queues.writeWorkspaceState.shift();
    if (queued !== undefined) return queued;
    state = { ...state, ...patch };
    missing = false;
    corrupt = false;
    return undefined;
  }

  async function close(): Promise<void> {
    calls.push({ method: "close" });
  }

  return {
    root: options.root,
    lease,
    readManifest,
    readWorkspaceState,
    writeWorkspaceState,
    close,
    calls,
    failNext,
  };
}

type _Conforms = AssertConforms<ProjectStore, FakeProjectStore>;
