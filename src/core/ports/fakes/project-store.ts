import type { FailureDtoV1 } from "core/protocol";

import type { AssertConforms } from "../index";
import type {
  ProjectLeaseIdentityV1,
  ProjectManifestV1,
  ProjectStore,
  WorkspaceStateReadV1,
  WorkspaceStateV1,
} from "../project-store";
import type { ReadSetFileSnapshotV1 } from "../staging";

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

/**
 * A deterministic, valid-looking 64-hex-char digest derived from a seed — no real crypto,
 * no randomness. Mirrors `fakes/staging.ts`'s own identical `fakeSha256Hex` helper
 * verbatim: two independent, narrow fakes each get their own tiny copy rather than a new
 * shared fakes-utility module this task's scope does not authorize.
 */
function fakeSha256Hex(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (Math.imul(h, 31) + seed.charCodeAt(i)) | 0;
  const base = (h >>> 0).toString(16).padStart(8, "0");
  return base.repeat(8).slice(0, 64);
}

export type ProjectStoreFailableMethod =
  | "readManifest"
  | "readManifestSnapshot"
  | "readWorkspaceState"
  | "writeWorkspaceState";

export type ProjectStoreCall =
  | { readonly method: "readManifest" }
  | { readonly method: "readManifestSnapshot" }
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
    // A fixed, valid-looking UUIDv7 (no real crypto/randomness, matching `fakeSha256Hex`'s
    // own convention above) — not the earlier `"fake-project-1"`, which was a genuine
    // fake-fidelity gap (`ProjectManifestV1.projectId` is typed a loose `string` at THIS
    // port, but the real store always mints it via `uuidv7()`, and the wire protocol's own
    // `kernelSnapshotPayloadV1Schema`/`kernelStateChangedPayloadV1Schema` require a real
    // UUIDv7 wherever `projectId` crosses that boundary — `handlers/project.ts`'s
    // `kernel.project.finishOpen` metadata, closed in the §10 smoke closeout, is exactly
    // such a crossing).
    projectId: "0192f000-0000-7000-8000-000000000001",
    name: "Fake Project",
    createdAt: "2024-01-01T00:00:00.000Z",
    targetStack: "generic",
    ...options.manifest,
  };
  let state: WorkspaceStateV1 = { ...DEFAULT_WORKSPACE_STATE, ...options.workspaceState };
  let missing = options.workspaceState === undefined;
  let corrupt = false;

  const calls: ProjectStoreCall[] = [];
  const queues: Record<ProjectStoreFailableMethod, FailureDtoV1[]> = {
    readManifest: [],
    readManifestSnapshot: [],
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

  async function readManifestSnapshot(): Promise<FailureDtoV1 | ReadSetFileSnapshotV1> {
    calls.push({ method: "readManifestSnapshot" });
    const queued = queues.readManifestSnapshot.shift();
    if (queued !== undefined) return queued;
    // An honest, deterministic hash+size derived from the CONSTRUCTED manifest — never a
    // fixed placeholder — so it changes whenever a test builds a differently-shaped
    // manifest, and stays stable across repeated reads of the same one.
    const serialized = JSON.stringify(manifest);
    return {
      size: new TextEncoder().encode(serialized).byteLength,
      sha256: fakeSha256Hex(serialized),
    };
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
    readManifestSnapshot,
    readWorkspaceState,
    writeWorkspaceState,
    close,
    calls,
    failNext,
  };
}

type _Conforms = AssertConforms<ProjectStore, FakeProjectStore>;
