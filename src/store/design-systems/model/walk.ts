import path from "node:path";

import type { DesignSystemFsDeps, PackageAdmission, PackageFile } from "../types";
import { normalizePackageRelPath } from "./content-hash";
import { DesignSystemPackageInvalidError, DesignSystemPackageTooLargeError } from "./errors";

/**
 * Read a design-system package directory into a file set, under a caller-supplied budget.
 *
 * THE ADMISSION BOUNDARY (design §8.3, §13). Every file is admitted by its DECLARED size before
 * it is read, and observed by its ACTUAL length after — the same two phases `store/safe-fs`'s
 * `LimitBudget` has, so P10 drops the real `design-source` budget in without restructuring this
 * walk. A refusal is wrapped, never rethrown, and the budget's own error survives as `cause`.
 *
 * NO-FOLLOW (§13). A symlink, a device, a socket — anything that is neither a regular file nor a
 * directory — is refused. An installed design system is a COPY and never a link.
 */
export function readPackageDirectory(
  fs: DesignSystemFsDeps,
  admission: PackageAdmission,
  packageRoot: string,
) {
  const files: PackageFile[] = [];

  function walk(absDir: string, relPrefix: string, depth: number): Error | null {
    const entries = fs.listDir(absDir);
    if (entries instanceof Error) return entries;
    if (entries === null) {
      return new DesignSystemPackageInvalidError({
        path: absDir,
        reason: "directory disappeared while the package was being read",
      });
    }

    // Sorted so the resulting file set — and its content hash — never depends on the order the
    // filesystem happens to enumerate a directory in.
    const sorted = [...entries].sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );

    for (const entry of sorted) {
      const relPath = normalizePackageRelPath(
        relPrefix === "" ? entry.name : `${relPrefix}/${entry.name}`,
      );
      const absPath = path.join(absDir, entry.name);

      if (entry.isSymbolicLink || (!entry.isFile && !entry.isDirectory)) {
        return new DesignSystemPackageInvalidError({
          path: relPath,
          reason: "package entries must be regular files or directories, never links",
        });
      }

      if (entry.isDirectory) {
        const nested = walk(absPath, relPath, depth + 1);
        if (nested instanceof Error) return nested;
        continue;
      }

      const stat = fs.statFile(absPath);
      if (stat instanceof Error) return stat;
      if (stat === null) {
        return new DesignSystemPackageInvalidError({
          path: relPath,
          reason: "file disappeared while the package was being read",
        });
      }

      const admitted = admission.admitFile({ relPath, declaredSize: stat.size, depth });
      if (admitted instanceof Error) {
        return new DesignSystemPackageTooLargeError({
          path: relPath,
          detail: admitted.message,
          cause: admitted,
        });
      }

      const bytes = fs.readFile(absPath);
      if (bytes instanceof Error) return bytes;
      if (bytes === null) {
        return new DesignSystemPackageInvalidError({
          path: relPath,
          reason: "file disappeared while the package was being read",
        });
      }

      const observed = admission.observeBytes({ relPath, bytesRead: bytes.byteLength });
      if (observed instanceof Error) {
        return new DesignSystemPackageTooLargeError({
          path: relPath,
          detail: observed.message,
          cause: observed,
        });
      }

      files.push({ relPath, bytes });
    }
    return null;
  }

  const failure = walk(packageRoot, "", 1);
  if (failure instanceof Error) return failure;
  return files as readonly PackageFile[];
}
