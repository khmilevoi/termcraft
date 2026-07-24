import type { FailureDtoV1, Sha256Hex } from "core/protocol";

import type { AssertConforms } from "../index";
import type {
  CandidatePageSetV1,
  CreateTurnWorkspaceInputV1,
  StagedFileV1,
  StagingService,
  TurnWorkspaceV1,
} from "../staging";

/**
 * In-memory {@link StagingService} fake (6D task brief). `createTurnWorkspace` synthesizes
 * a deterministic root path and file list from `input.turnId`/`pages`/`runtimeDocs`/
 * `manifestSlice` — no real disk write happens, so `snapshotToCandidate` and
 * `retireWorkspace` only need to track which workspace ids are live, not copy real bytes.
 */

/** A deterministic, valid-looking 64-hex-char {@link Sha256Hex} derived from a seed — no crypto, no randomness. */
function fakeSha256Hex(seed: string): Sha256Hex {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (Math.imul(h, 31) + seed.charCodeAt(i)) | 0;
  const base = (h >>> 0).toString(16).padStart(8, "0");
  return base.repeat(8).slice(0, 64);
}

export type StagingFailableMethod =
  | "createTurnWorkspace"
  | "snapshotToCandidate"
  | "retireWorkspace"
  | "readCandidateFile";

export type StagingCall =
  | { readonly method: "createTurnWorkspace"; readonly input: CreateTurnWorkspaceInputV1 }
  | { readonly method: "snapshotToCandidate"; readonly turnId: string }
  | { readonly method: "retireWorkspace"; readonly turnId: string; readonly effective: boolean }
  | { readonly method: "readCandidateFile"; readonly root: string; readonly relPath: string };

export interface FakeStagingService extends StagingService {
  readonly calls: readonly StagingCall[];
  failNext(method: StagingFailableMethod, failure: FailureDtoV1): void;
}

export function createFakeStagingService(): FakeStagingService {
  const live = new Set<string>();
  const calls: StagingCall[] = [];

  const queues: Record<StagingFailableMethod, FailureDtoV1[]> = {
    createTurnWorkspace: [],
    snapshotToCandidate: [],
    retireWorkspace: [],
    readCandidateFile: [],
  };

  // Per-workspace synthetic content, keyed by `turnId` — built once, at `createTurnWorkspace`
  // time, from the ONE real byte payload this fake ever actually receives (`manifestSlice`)
  // plus deterministic (never random) synthetic bytes for every other staged file, since
  // `StagingPageSourceV1`/`StagingRuntimeDocV1` carry only a `sourcePath` STRING, never real
  // bytes, for this fake to copy. Copied into `contentByCandidateRoot` (keyed by the frozen
  // candidate's own root) once `snapshotToCandidate` runs, so `readCandidateFile` can look a
  // relPath up by the SAME root a caller actually holds after freezing — never by `turnId`,
  // which `readCandidateFile`'s own port signature never takes.
  const contentByTurnId = new Map<string, ReadonlyMap<string, Uint8Array>>();
  const contentByCandidateRoot = new Map<string, ReadonlyMap<string, Uint8Array>>();

  function failNext(method: StagingFailableMethod, failure: FailureDtoV1): void {
    queues[method].push(failure);
  }

  async function createTurnWorkspace(
    input: CreateTurnWorkspaceInputV1,
  ): Promise<FailureDtoV1 | TurnWorkspaceV1> {
    calls.push({ method: "createTurnWorkspace", input });
    const queued = queues.createTurnWorkspace.shift();
    if (queued !== undefined) return queued;

    const pageFiles: StagedFileV1[] = input.pages.map((page) => ({
      relPath: `pages/${page.pageSlug}/index.tsx`,
      sha256: fakeSha256Hex(page.sourcePath),
      size: 0,
    }));
    const runtimeFiles: StagedFileV1[] = input.runtimeDocs.map((doc) => ({
      relPath: doc.relPath,
      sha256: fakeSha256Hex(doc.sourcePath),
      size: 0,
    }));
    const manifestFile: StagedFileV1 = {
      relPath: "pages.json",
      sha256: fakeSha256Hex(`manifest:${input.turnId}`),
      size: input.manifestSlice.byteLength,
    };
    const files = [manifestFile, ...pageFiles, ...runtimeFiles];

    // The one real byte payload this fake ever receives (`manifestSlice`) is stored
    // verbatim; every other staged file gets deterministic synthetic content derived from
    // its own `sourcePath` — see this function's own header comment on `contentByTurnId`.
    const content = new Map<string, Uint8Array>();
    content.set(manifestFile.relPath, input.manifestSlice);
    for (const page of input.pages) {
      content.set(
        `pages/${page.pageSlug}/index.tsx`,
        new TextEncoder().encode(`fake-page-source:${page.sourcePath}`),
      );
    }
    for (const doc of input.runtimeDocs) {
      content.set(doc.relPath, new TextEncoder().encode(`fake-runtime-doc:${doc.sourcePath}`));
    }
    contentByTurnId.set(input.turnId, content);

    live.add(input.turnId);
    return {
      turnId: input.turnId,
      root: `/fake-turn-workspace/${input.turnId}`,
      files,
      totalBytes: files.reduce((sum, file) => sum + file.size, 0),
      readSet: input.readSet,
    };
  }

  async function snapshotToCandidate(
    workspace: TurnWorkspaceV1,
  ): Promise<FailureDtoV1 | CandidatePageSetV1> {
    calls.push({ method: "snapshotToCandidate", turnId: workspace.turnId });
    const queued = queues.snapshotToCandidate.shift();
    if (queued !== undefined) return queued;
    const root = `/fake-candidate/${workspace.turnId}`;
    // Copied from `contentByTurnId` (never re-keyed by `turnId` again after this point) —
    // `readCandidateFile` only ever receives the CANDIDATE's own root, matching the real
    // port's contract (a candidate is the one thing `runTurn` still holds a reference to
    // once the workspace itself has been retired).
    contentByCandidateRoot.set(root, contentByTurnId.get(workspace.turnId) ?? new Map());
    return { root, files: workspace.files, totalBytes: workspace.totalBytes };
  }

  function candidateFileNotFound(root: string, relPath: string): FailureDtoV1 {
    return {
      code: "PERSISTENCE_FAILED",
      retryable: false,
      safeMessage: `no candidate file "${relPath}" under "${root}"`,
      details: { root, relPath },
    };
  }

  async function readCandidateFile(
    root: string,
    relPath: string,
  ): Promise<FailureDtoV1 | Uint8Array> {
    calls.push({ method: "readCandidateFile", root, relPath });
    const queued = queues.readCandidateFile.shift();
    if (queued !== undefined) return queued;
    const bytes = contentByCandidateRoot.get(root)?.get(relPath);
    if (bytes === undefined) return candidateFileNotFound(root, relPath);
    return bytes;
  }

  async function retireWorkspace(workspace: TurnWorkspaceV1): Promise<FailureDtoV1 | undefined> {
    const effective = live.has(workspace.turnId);
    calls.push({ method: "retireWorkspace", turnId: workspace.turnId, effective });
    const queued = queues.retireWorkspace.shift();
    if (queued !== undefined) return queued;
    live.delete(workspace.turnId);
    return undefined;
  }

  return {
    createTurnWorkspace,
    snapshotToCandidate,
    retireWorkspace,
    readCandidateFile,
    calls,
    failNext,
  };
}

type _Conforms = AssertConforms<StagingService, FakeStagingService>;
