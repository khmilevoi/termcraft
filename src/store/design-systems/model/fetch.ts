import type { DesignSystemRef } from "entities/design-system-ref";
import { formatDesignSystemRef } from "entities/design-system-ref";

import type { FetchedPackage, LocalDesignSystemSourceDeps } from "../types";
import { designSystemContentHash } from "./content-hash";
import { DesignSystemPackageInvalidError, DesignSystemRefRejectedError } from "./errors";
import { LOCAL_SOURCE_ID, MANIFEST_FILENAME, localSystemDir } from "./layout";
import { readDesignSystemSummary } from "./summary";
import { readPackageDirectory } from "./walk";

/**
 * `DesignSystemSource.fetch(ref)` for the local library (design §8.1, §8.6).
 *
 * It RETURNS BYTES AND WRITES NOTHING. Installing never copies into a design tree directly:
 * P10 stages this into quarantine, applies the safe-filesystem limits, snapshots an immutable
 * candidate, runs the full Gate, previews the breakage, and only then commits a recoverable
 * transaction (§8.3). No local cache entry is written either — a local directory needs no cache
 * (§8.2's cache exists for materialized REMOTE packages).
 *
 * The reference must agree with the package. A `local:midnight@1.2.0` whose manifest claims
 * `2.0.0`, or claims to be `aurora`, is rejected rather than silently returned: an address that
 * does not name what it resolves to defeats the update check and the provenance record (§8.5).
 */
export async function fetchLocalPackage(
  deps: LocalDesignSystemSourceDeps,
  ref: DesignSystemRef,
): Promise<Error | FetchedPackage> {
  if (ref.sourceId !== LOCAL_SOURCE_ID) {
    return new DesignSystemRefRejectedError({
      ref: formatDesignSystemRef(ref),
      reason: `this source answers ${LOCAL_SOURCE_ID}, not ${ref.sourceId}`,
    });
  }

  const packageRoot = localSystemDir(deps.userStateRoot, ref.systemId);
  const present = deps.fs.listDir(packageRoot);
  if (present instanceof Error) return present;
  if (present === null) {
    return new DesignSystemRefRejectedError({
      ref: formatDesignSystemRef(ref),
      reason: "no such design system in the local library",
    });
  }

  const files = readPackageDirectory(deps.fs, deps.admission, packageRoot);
  if (files instanceof Error) return files;

  const manifest = files.find((file) => file.relPath === MANIFEST_FILENAME);
  if (manifest === undefined) {
    return new DesignSystemPackageInvalidError({
      path: packageRoot,
      reason: `package has no ${MANIFEST_FILENAME}`,
    });
  }

  const summary = readDesignSystemSummary(manifest.bytes, MANIFEST_FILENAME);
  if (summary instanceof Error) return summary;

  if (summary.id !== ref.systemId || summary.version !== ref.version) {
    return new DesignSystemRefRejectedError({
      ref: formatDesignSystemRef(ref),
      reason: `package declares ${summary.id}@${summary.version}`,
    });
  }

  const contentHash = designSystemContentHash(files);
  if (contentHash instanceof Error) return contentHash;

  return { ref, contentHash, files, summary };
}
