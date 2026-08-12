import * as errore from "errore";

import type { GateErrorV1, GateWarningV1, PackageFileV1, RunTreeResultV1 } from "core/ports";
import {
  DESIGN_SYSTEM_DIRNAME,
  DESIGN_SYSTEM_MANIFEST_RELPATH,
  isInsideDesignSystem,
} from "entities/design-system";

import type {
  DesignSystemBreakageItemV1,
  DesignSystemCandidateTreeV1,
  DesignSystemPreviewV1,
  DesignSystemPreviewVerdictV1,
} from "../types";

/**
 * THE CANDIDATE TREE IS COMPOSED IN MEMORY (decision D5). `GateRunner.runTree` takes
 * `ReadonlyMap<treeRelPath, text>`, and the canonical tree is already in memory as
 * `readCanonicalTreeIndex().files`, so materializing the whole tree into quarantine just to run
 * the Gate would be pure waste. What IS materialized is the untrusted package — that is what
 * quarantine, the limit budget and the no-follow walk exist for
 * (`store/design-systems`' `admitPackageThroughQuarantine`).
 *
 * ONE BYTE SOURCE, TWO CONSUMERS. `packageFiles` are the bytes read once out of the immutable
 * candidate; this function turns them into the Gate's TEXT map and the transaction's BYTE list in
 * the same pass, so what was checked is exactly what is written. Re-reading between the check and
 * the commit would be a TOCTOU window on foreign input, for no benefit.
 *
 * `system/` IS REPLACED WHOLESALE (§4.4: "an install replaces the folder wholesale"), never
 * merged. A merge would leave a file from the outgoing system inside the incoming one, and the
 * unit that moves between projects is the folder (§3.1).
 */

/**
 * PACKAGE-relative, derived from the TREE-relative `DESIGN_SYSTEM_MANIFEST_RELPATH`
 * (`"system/design-system.json"`) by stripping the `system/` prefix (`DESIGN_SYSTEM_DIRNAME` +
 * `"/"`), so the manifest filename can never drift from the entity's own constant — no fourth
 * copy of the literal alongside `entities/design-system`'s and `store/design-systems`'
 * `MANIFEST_FILENAME` (which `core` may not import: `core` never imports `store`).
 */
const MANIFEST_PACKAGE_RELPATH = DESIGN_SYSTEM_MANIFEST_RELPATH.slice(
  DESIGN_SYSTEM_DIRNAME.length + 1,
);

/** The preview's diagnostic lists are bounded plain text (Global Constraints), never streamed. */
export const MAX_PREVIEW_ITEMS = 40;

export class DesignSystemCandidateError extends errore.createTaggedError({
  name: "DesignSystemCandidateError",
  message: "design-system candidate refuses $relPath: $reason",
}) {}

/**
 * Normalizes and validates one package-relative path (brief step 1): `/`-separated only — a `\`
 * anywhere is a refusal, since a package that named a Windows-style path could stage differently
 * on different hosts — and no empty path, no `.`/`..` segment, no empty segment.
 */
function normalizePackagePath(relPath: string): DesignSystemCandidateError | string {
  if (relPath.includes("\\"))
    return new DesignSystemCandidateError({
      relPath,
      reason: "package paths must be `/`-separated",
    });
  const segments = relPath.split("/");
  const escapes =
    relPath === "" ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..");
  if (escapes)
    return new DesignSystemCandidateError({
      relPath,
      reason: "package paths must not be empty and must not contain `.`, `..`, or an empty segment",
    });
  return relPath;
}

/** UTF-8 strict decode (brief step 4) — a non-UTF-8 package file is refused, never mojibaked into the Gate. */
function decodePackageText(
  bytes: Uint8Array,
  relPath: string,
): DesignSystemCandidateError | string {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  return errore.try({
    try: () => decoder.decode(bytes),
    catch: (cause) => new DesignSystemCandidateError({ relPath, reason: "not valid UTF-8", cause }),
  });
}

/**
 * Splices an incoming package over the canonical tree's `system/**` (brief steps 1-8), in memory,
 * over ONE read of the candidate's bytes — see the header. Every package path is normalized and
 * validated before anything is decoded, so a refusal never depends on decode order.
 */
export function composeDesignSystemCandidate(input: {
  readonly currentFiles: ReadonlyMap<string, string>;
  readonly currentTreePaths: readonly string[];
  readonly packageFiles: readonly PackageFileV1[];
}): DesignSystemCandidateError | DesignSystemCandidateTreeV1 {
  const seenPackagePaths = new Set<string>();
  const normalizedPackageFiles: { readonly relPath: string; readonly bytes: Uint8Array }[] = [];
  for (const file of input.packageFiles) {
    const relPath = normalizePackagePath(file.relPath);
    if (relPath instanceof Error) return relPath;
    if (seenPackagePaths.has(relPath))
      return new DesignSystemCandidateError({ relPath, reason: "duplicate package path" });
    seenPackagePaths.add(relPath);
    normalizedPackageFiles.push({ relPath, bytes: file.bytes });
  }

  if (!seenPackagePaths.has(MANIFEST_PACKAGE_RELPATH))
    return new DesignSystemCandidateError({
      relPath: MANIFEST_PACKAGE_RELPATH,
      reason: "the package has no manifest",
    });

  const nextFiles: { readonly treeRelPath: string; readonly bytes: Uint8Array }[] = [];
  const incomingByTreeRelPath = new Map<string, string>();
  for (const file of normalizedPackageFiles) {
    const text = decodePackageText(file.bytes, file.relPath);
    if (text instanceof Error) return text;
    const treeRelPath = `${DESIGN_SYSTEM_DIRNAME}/${file.relPath}`;
    nextFiles.push({ treeRelPath, bytes: file.bytes });
    incomingByTreeRelPath.set(treeRelPath, text);
  }

  const files = new Map<string, string>();
  for (const [relPath, text] of input.currentFiles) {
    if (isInsideDesignSystem(relPath)) continue;
    files.set(relPath, text);
  }
  for (const [treeRelPath, text] of incomingByTreeRelPath) files.set(treeRelPath, text);

  const removedTreeRelPaths = input.currentTreePaths
    .filter((relPath) => isInsideDesignSystem(relPath) && !incomingByTreeRelPath.has(relPath))
    .sort();

  const treePaths = [...files.keys()].sort();

  return { files, treePaths, removedTreeRelPaths, nextFiles };
}

/** The preview message column, bounded so one runaway diagnostic cannot dominate the dialog. */
const MAX_MESSAGE_LENGTH = 400;

function truncateMessage(message: string): string {
  return message.length > MAX_MESSAGE_LENGTH ? message.slice(0, MAX_MESSAGE_LENGTH) : message;
}

/**
 * `GateWarningV1` carries no `code` (unlike `GateErrorV1`) — its `kind` is the closest existing
 * vocabulary for the item's category, so warnings use `kind` where errors use `code`.
 */
function toBreakageItem(diagnostic: {
  readonly code: string;
  readonly message: string;
  readonly file?: string;
  readonly blockedPages?: readonly string[];
}): DesignSystemBreakageItemV1 {
  return {
    code: diagnostic.code,
    message: truncateMessage(diagnostic.message),
    file: diagnostic.file ?? null,
    blockedPages: [...(diagnostic.blockedPages ?? [])],
  };
}

function errorToBreakageItem(error: GateErrorV1): DesignSystemBreakageItemV1 {
  return toBreakageItem({
    code: error.code,
    message: error.message,
    file: error.file,
    blockedPages: error.blockedPages,
  });
}

function warningToBreakageItem(warning: GateWarningV1): DesignSystemBreakageItemV1 {
  return toBreakageItem({
    code: warning.kind,
    message: warning.message,
    file: warning.file,
    blockedPages: warning.blockedPages,
  });
}

/**
 * Classifies a `GateRunner.runTree` pass into the picker's breakage preview (decision D6). The
 * verdict is derived over the FULL error list, BEFORE truncation — a truncated tail must never
 * soften `blocked` into `breaks-pages`.
 */
export function summarizeGatePass(pass: RunTreeResultV1): DesignSystemPreviewV1 {
  const blocking = pass.errors.some(
    (error) => error.file === undefined || isInsideDesignSystem(error.file),
  );
  const verdict: DesignSystemPreviewVerdictV1 = blocking
    ? "blocked"
    : pass.errors.length > 0
      ? "breaks-pages"
      : "clean";

  return {
    verdict,
    errors: pass.errors.slice(0, MAX_PREVIEW_ITEMS).map(errorToBreakageItem),
    warnings: pass.warnings.slice(0, MAX_PREVIEW_ITEMS).map(warningToBreakageItem),
  };
}
