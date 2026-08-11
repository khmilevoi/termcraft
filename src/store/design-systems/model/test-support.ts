import fs from "node:fs";
import path from "node:path";

import type { DesignSystemFsDeps, PackageFile } from "../types";

/**
 * A {@link DesignSystemFsDeps} that delegates to `inner` and records every path it was asked to
 * read, list, or stat. This is what makes design §11's "`list` never opens a `.tsx`" an
 * OBSERVED property: the directories are real, and so is the record of what was opened.
 */
export interface RecordingFsDeps extends DesignSystemFsDeps {
  readonly reads: readonly string[];
  readonly lists: readonly string[];
  readonly stats: readonly string[];
  clearRecording(): void;
}

export function createRecordingFsDeps(inner: DesignSystemFsDeps): RecordingFsDeps {
  const reads: string[] = [];
  const lists: string[] = [];
  const stats: string[] = [];

  return {
    listDir(absDir) {
      lists.push(absDir);
      return inner.listDir(absDir);
    },
    statFile(absPath) {
      stats.push(absPath);
      return inner.statFile(absPath);
    },
    readFile(absPath) {
      reads.push(absPath);
      return inner.readFile(absPath);
    },
    mkdirAll: inner.mkdirAll,
    durableWrite: inner.durableWrite,
    removeDir: inner.removeDir,
    renameDir: inner.renameDir,
    reads,
    lists,
    stats,
    clearRecording() {
      reads.length = 0;
      lists.length = 0;
      stats.length = 0;
    },
  };
}

/** Materializes a package's files under `root`, creating parent directories as needed. */
export function writeFixturePackage(root: string, files: readonly PackageFile[]): void {
  for (const file of files) {
    const target = path.join(root, ...file.relPath.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.bytes);
  }
}
