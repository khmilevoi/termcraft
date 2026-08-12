import * as errore from "errore";

import { readCanonicalTreeIndex } from "core/project";
import type { FailureDtoV1 } from "core/protocol";
import { isInsideDesignSystem } from "entities/design-system";
import type { DesignSystemRef } from "entities/design-system-ref";

import type {
  DesignSystemBreakageItemV1,
  DesignSystemInstallPortsV1,
  DesignSystemPreparedInstallV1,
  DesignSystemPreviewV1,
} from "../types";
import { composeDesignSystemCandidate, summarizeGatePass } from "./candidate";

/**
 * THE INSTALL PIPELINE (project-design-systems design §8.3, §8.5; decisions D4-D6, D11):
 * trust -> fetch -> quarantine -> immutable candidate -> whole-tree Gate -> breakage preview ->
 * one recoverable commit. Trust itself is the CALLER'S concern — `core/design-systems/model/
 * sources.ts`'s own header makes the identical allowance for `listGrantedSources` — this module
 * starts from an already-granted `ref` (a later task's Kernel handler calls `isGranted` first,
 * exactly as `listGrantedSources` does, before ever reaching `prepareDesignSystemInstall`).
 *
 * `core` MAY NOT IMPORT `store`, so quarantine and the commit are reached through
 * `core/ports/design-system-install.ts`'s two ports (`DesignSystemQuarantinePort`,
 * `DesignSystemInstallPort`) — never through `store/design-systems` or `store`'s
 * `TransactionEngine` directly.
 *
 * TOCTOU (decision D5). `admitPackageThroughQuarantine` (behind `ports.quarantine.admit`) reads
 * the immutable candidate's bytes back exactly ONCE. Every byte `composeDesignSystemCandidate`
 * folds into the Gate's text map, and every byte `commitDesignSystemInstall` writes, comes from
 * THAT one read (`admitted.files`) — this module never re-reads the quarantine directory, the
 * candidate, or the fetched package a second time. `fetched.files` themselves are used exactly
 * once, to hand to `ports.quarantine.admit` — never read again, and never spliced into the
 * candidate directly, so the bytes the Gate checks are always the CANDIDATE's, not the fetch's.
 *
 * QUARANTINE'S LIFETIME SPANS TWO CALLS. `prepareDesignSystemInstall` deliberately does NOT
 * discard quarantine on success — the caller inspects `preview` first (a breakage preview the
 * designer confirms, §12) and only then calls `commitDesignSystemInstall` (which commits and
 * discards) or `discardPreparedInstall` (which abandons and discards). Every OTHER exit —
 * quarantine's own admission failure, a canonical-tree read failure, a candidate-composition
 * refusal, a commit failure — discards quarantine before returning, so no exit path leaks a
 * quarantine directory. The one exception is `admit` itself failing: `DesignSystemQuarantinePort
 * .admit`'s own contract is that IT discards its own directory on failure (mirroring
 * `admitPackageThroughQuarantine`'s `discard()` closure over every one of its own error returns),
 * so a second `discard()` here would be a redundant, harmless-but-pointless call over a directory
 * that was never created or was already removed.
 */

/** A `DesignSystemBreakageItemV1` blocks (decision D6) when its `file` is inside `system/`, or absent — an unattributed whole-tree fatal. */
function isBlockingDiagnostic(item: DesignSystemBreakageItemV1): boolean {
  return item.file === null || isInsideDesignSystem(item.file);
}

/** The `DESIGN_SYSTEM_REJECTED` refusal for a `blocked` preview — names the first blocking diagnostic (code + file) rather than the whole list, matching the Kernel's one-line `safeMessage` convention. */
function blockedInstallFailure(preview: DesignSystemPreviewV1): FailureDtoV1 {
  const blocking = preview.errors.find(isBlockingDiagnostic) ?? null;
  const safeMessage =
    blocking === null
      ? "the design system itself is invalid"
      : `the design system itself is invalid: ${blocking.code} (${blocking.file ?? "no file"})`;
  return { code: "DESIGN_SYSTEM_REJECTED", retryable: false, safeMessage, details: {} };
}

/**
 * Runs the pipeline through the Gate and stops — quarantine is left in place for the caller to
 * commit or abandon. `ref` must already be trust-granted (see the header); this function does
 * not check.
 */
export async function prepareDesignSystemInstall(
  ports: DesignSystemInstallPortsV1,
  ref: DesignSystemRef,
): Promise<FailureDtoV1 | DesignSystemPreparedInstallV1> {
  const fetched = await ports.source.fetch(ref);
  if ("code" in fetched) return fetched;

  const installId = ports.newInstallId();
  const admitted = await ports.quarantine.admit({ installId, files: fetched.files });
  // `admit` discards its own directory on failure (see header) — do NOT discard again here.
  if ("code" in admitted) return admitted;

  const index = await readCanonicalTreeIndex({
    designReader: ports.designReader,
    gateRunner: ports.gateRunner,
  });
  if ("code" in index) {
    ports.quarantine.discard(installId);
    return index;
  }

  // TWO WHOLE-TREE TYPE CHECKS PER PREPARATION, stated rather than hidden.
  // `readCanonicalTreeIndex` runs `runTree` itself (that is what makes its `pages`/`files`
  // trustworthy), and the call below runs a second pass over the candidate because §8.3 requires
  // the Gate's answer to be about the CANDIDATE, not about the current tree. Both freeze the
  // thread (decision D7). Accepted: correctness of the preview is what the whole pipeline exists
  // for.

  const candidate = composeDesignSystemCandidate({
    currentFiles: index.files,
    currentTreePaths: index.inventory.files.map((file) => file.relPath),
    packageFiles: admitted.files,
  });
  if (candidate instanceof Error) {
    ports.quarantine.discard(installId);
    return {
      code: "DESIGN_SYSTEM_REJECTED",
      retryable: false,
      safeMessage: candidate.message,
      details: {},
    };
  }

  const pass = await ports.gateRunner.runTree({
    files: candidate.files,
    treePaths: candidate.treePaths,
    pages: index.pages,
  });

  return {
    installId,
    ref,
    contentHash: admitted.contentHash,
    summary: fetched.summary,
    preview: summarizeGatePass(pass),
    candidate,
  };
}

/**
 * `discardPreparedInstall`: abandons a preparation the caller decided not to commit — a designer
 * who closed the breakage-preview dialog without confirming. Best-effort, never fails (mirrors
 * `DesignSystemQuarantinePort.discard`'s own contract).
 */
export function discardPreparedInstall(ports: DesignSystemInstallPortsV1, installId: string): void {
  ports.quarantine.discard(installId);
}

/**
 * Commits a preparation (decision D6): refuses a `blocked` preview outright (the package itself
 * is broken — nothing is written), but a `breaks-pages` preview COMMITS on this call, exactly as
 * `clean` does — §12: "surfaced before commit; not prevented". Quarantine is discarded on every
 * exit path via `AsyncDisposableStack`, so a new early return added later cannot forget it.
 */
export async function commitDesignSystemInstall(
  ports: DesignSystemInstallPortsV1,
  prepared: DesignSystemPreparedInstallV1,
): Promise<FailureDtoV1 | { readonly ref: DesignSystemRef }> {
  await using cleanup = new errore.AsyncDisposableStack();
  cleanup.defer(() => {
    discardPreparedInstall(ports, prepared.installId);
  });

  if (prepared.preview.verdict === "blocked") return blockedInstallFailure(prepared.preview);

  const provenanceBytes = ports.install.encodeProvenance({
    ref: prepared.ref,
    contentHash: prepared.contentHash,
    installedAt: ports.clock.now().toISOString(),
  });

  const failure = await ports.install.install({
    nextFiles: prepared.candidate.nextFiles,
    removedTreeRelPaths: prepared.candidate.removedTreeRelPaths,
    provenanceBytes,
  });
  if (failure !== undefined) return failure;

  return { ref: prepared.ref };
}
