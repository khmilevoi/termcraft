import path from "node:path";

import * as errore from "errore";

import type { DesignSystemId, DesignSystemVersion, SourceId } from "entities/design-system-ref";
import { InvalidDesignSystemRefError, parseSourceId } from "entities/design-system-ref";

import type { AbsPath } from "../types";

/**
 * The per-user design-system library (design §8.2), under the SAME root that already holds
 * `trust/`, `sandboxes/`, and `backups/` — `resolveDefaultUserStateRoot()` in
 * `src/entrypoint/model/create-shell.ts`, i.e. `%LOCALAPPDATA%/termcraft` with the
 * `<tmpdir>/termcraft` fallback applying unchanged.
 *
 * ```
 * {userStateRoot}/design-systems/
 *   sources.json                                    configured sources
 *   local/<systemId>/                               the designer's own systems; the publish target
 *   cache/<sourceIdSegment>/<systemId>@<version>/   materialized remote packages
 *     entry.json                                    reference + content hash + fetch time
 *     package/…                                     the bytes the source served
 * ```
 *
 * The cache is keyed by VERSION, not by time: one reference always names the same bytes, so
 * reinstalling never goes to the network.
 */
export const DESIGN_SYSTEMS_DIRNAME = "design-systems";
export const SOURCES_CONFIG_FILENAME = "sources.json";
export const CACHE_ENTRY_RECORD_FILENAME = "entry.json";
export const CACHE_PACKAGE_DIRNAME = "package";
export const LOCAL_LIBRARY_DIRNAME = "local";
export const CACHE_DIRNAME = "cache";

/** The manifest filename inside a design-system package (design §3.1). */
export const MANIFEST_FILENAME = "design-system.json";

/** The one built-in source. Parsed rather than cast so the mask is the single authority. */
export const LOCAL_SOURCE_ID: SourceId = (() => {
  const id = parseSourceId(LOCAL_LIBRARY_DIRNAME);
  if (id instanceof Error) throw id;
  return id;
})();

export const LOCAL_SOURCE_LABEL = "Local library";

export function designSystemsRoot(userStateRoot: AbsPath): AbsPath {
  return path.join(userStateRoot, DESIGN_SYSTEMS_DIRNAME);
}

export function sourcesConfigPath(userStateRoot: AbsPath): AbsPath {
  return path.join(designSystemsRoot(userStateRoot), SOURCES_CONFIG_FILENAME);
}

export function localLibraryDir(userStateRoot: AbsPath): AbsPath {
  return path.join(designSystemsRoot(userStateRoot), LOCAL_LIBRARY_DIRNAME);
}

export function localSystemDir(userStateRoot: AbsPath, systemId: DesignSystemId): AbsPath {
  return path.join(localLibraryDir(userStateRoot), systemId);
}

export function cacheRootDir(userStateRoot: AbsPath): AbsPath {
  return path.join(designSystemsRoot(userStateRoot), CACHE_DIRNAME);
}

/**
 * §8.2 writes `cache/<source-id>/`, and a source id may be `github:acme/design-systems` — a `:`
 * is not a legal Windows filename character and a `/` would silently nest a directory level.
 * Percent-encoding is filename-safe on Windows and exactly reversible, so the address stays
 * recoverable from the path. `parseSourceId` already refuses a reserved device name for the
 * family, so an encoded segment can never come out as `con`.
 */
export function encodeSourceIdSegment(sourceId: SourceId): string {
  return encodeURIComponent(sourceId);
}

export function decodeSourceIdSegment(segment: string) {
  const decoded = errore.try({
    try: () => decodeURIComponent(segment),
    catch: (cause) =>
      new InvalidDesignSystemRefError({
        value: segment,
        reason: "cache segment is not valid percent-encoding",
        cause,
      }),
  });
  if (decoded instanceof Error) return decoded;
  return parseSourceId(decoded);
}

export function cacheEntryDir(
  userStateRoot: AbsPath,
  sourceId: SourceId,
  systemId: DesignSystemId,
  version: DesignSystemVersion,
): AbsPath {
  return path.join(
    cacheRootDir(userStateRoot),
    encodeSourceIdSegment(sourceId),
    `${systemId}@${version}`,
  );
}

export function cachePackageDir(
  userStateRoot: AbsPath,
  sourceId: SourceId,
  systemId: DesignSystemId,
  version: DesignSystemVersion,
): AbsPath {
  return path.join(
    cacheEntryDir(userStateRoot, sourceId, systemId, version),
    CACHE_PACKAGE_DIRNAME,
  );
}

export function cacheEntryRecordPath(
  userStateRoot: AbsPath,
  sourceId: SourceId,
  systemId: DesignSystemId,
  version: DesignSystemVersion,
): AbsPath {
  return path.join(
    cacheEntryDir(userStateRoot, sourceId, systemId, version),
    CACHE_ENTRY_RECORD_FILENAME,
  );
}
