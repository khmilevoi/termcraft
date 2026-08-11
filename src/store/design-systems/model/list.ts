import path from "node:path";

import { parseDesignSystemId } from "entities/design-system-ref";
import { log } from "infrastructure/debug-log";

import type { DesignSystemSummary, LocalDesignSystemSourceDeps } from "../types";
import { MANIFEST_FILENAME, localLibraryDir } from "./layout";
import { readDesignSystemSummary } from "./summary";

/**
 * `DesignSystemSource.list()` over `{userStateRoot}/design-systems/local/` (design §8.1, §8.2).
 *
 * It opens EXACTLY ONE FILE PER CANDIDATE — that candidate's `design-system.json` — and never a
 * `.tsx`. §11 asserts this against a recording filesystem, because it is the property that makes
 * a picker over a remote source affordable (§8.1: "had `list` returned whole packages, opening
 * the picker against a configured remote would download every system in it") and the property
 * that keeps foreign code unexecuted (§8.3: "no foreign code executes at any point before
 * commit, and `list` never executes any").
 *
 * One unreadable folder skips itself rather than blanking the picker; only a fault reading the
 * library DIRECTORY is propagated. Skips are logged, never swallowed (errore rule 21).
 */
export async function listLocalSystems(deps: LocalDesignSystemSourceDeps) {
  const libraryDir = localLibraryDir(deps.userStateRoot);

  const entries = deps.fs.listDir(libraryDir);
  if (entries instanceof Error) return entries;
  // A machine that has never published anything has no library — an empty list, not a fault.
  if (entries === null) return [] as readonly DesignSystemSummary[];

  const summaries: DesignSystemSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory || entry.isSymbolicLink) {
      log.warn("design-systems: skipping non-directory or symlinked library entry:", entry.name);
      continue;
    }

    const systemId = parseDesignSystemId(entry.name);
    if (systemId instanceof Error) {
      log.warn("design-systems: skipping library entry with an illegal id:", entry.name);
      continue;
    }

    const manifestPath = path.join(libraryDir, entry.name, MANIFEST_FILENAME);
    const bytes = deps.fs.readFile(manifestPath);
    if (bytes instanceof Error) {
      log.warn("design-systems: skipping unreadable manifest:", bytes.message);
      continue;
    }
    if (bytes === null) {
      log.warn("design-systems: skipping library entry with no manifest:", entry.name);
      continue;
    }

    const summary = readDesignSystemSummary(bytes, manifestPath);
    if (summary instanceof Error) {
      log.warn("design-systems: skipping unsummarizable manifest:", summary.message);
      continue;
    }

    summaries.push(summary);
  }

  // Sorted so a picker's list is stable across runs and platforms.
  summaries.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  return summaries as readonly DesignSystemSummary[];
}
