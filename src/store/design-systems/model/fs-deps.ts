import fs from "node:fs";

import * as errore from "errore";

import { durableFileWrite } from "infrastructure/durability";

import type { DesignSystemFsDeps, PackageAdmission } from "../types";
import { DesignSystemSourceIoError } from "./errors";

/** `ENOENT` is the ordinary "not there" case, not a fault — an empty library is normal. */
function isMissing(cause: unknown): boolean {
  return (
    typeof cause === "object" && cause !== null && (cause as { code?: unknown }).code === "ENOENT"
  );
}

/**
 * The real bindings. `withFileTypes` gives the entry kinds without a second syscall, and
 * `Dirent.isSymbolicLink()` is `lstat`-based — a link is REPORTED here and REFUSED by the
 * package walk, never followed. §13: an installed system is a copy and never a link, which is
 * the same rule `store/safe-fs/model/no-follow.ts` enforces for a project tree; P10 routes a
 * fetched package through that walk in quarantine, and this is the P3-level guard until then.
 */
export const nodeDesignSystemFsDeps: DesignSystemFsDeps = {
  listDir(absDir) {
    const entries = errore.try({
      try: () =>
        fs.readdirSync(absDir, { withFileTypes: true }).map((entry) => ({
          name: entry.name,
          isFile: entry.isFile(),
          isDirectory: entry.isDirectory(),
          isSymbolicLink: entry.isSymbolicLink(),
        })),
      catch: (cause) =>
        new DesignSystemSourceIoError({
          operation: "list",
          path: absDir,
          detail: "directory unreadable",
          cause,
        }),
    });
    if (entries instanceof Error && isMissing(entries.cause)) return null;
    return entries;
  },

  statFile(absPath) {
    const info = errore.try({
      try: () => fs.lstatSync(absPath),
      catch: (cause) =>
        new DesignSystemSourceIoError({
          operation: "stat",
          path: absPath,
          detail: "file unreadable",
          cause,
        }),
    });
    if (info instanceof Error) return isMissing(info.cause) ? null : info;
    // Present, but not a regular file (a directory or — on a platform without O_NOFOLLOW —
    // a symlink `lstat` still resolved this far into): distinct from ENOENT, and the caller
    // must not read it as "absent" (M8: a present-but-wrong-type sources.json is a failure,
    // not silently the default).
    if (!info.isFile()) {
      return new DesignSystemSourceIoError({
        operation: "stat",
        path: absPath,
        detail: "not a regular file",
      });
    }
    return { size: info.size };
  },

  readFile(absPath) {
    const bytes = errore.try({
      try: () => new Uint8Array(fs.readFileSync(absPath)),
      catch: (cause) =>
        new DesignSystemSourceIoError({
          operation: "read",
          path: absPath,
          detail: "file unreadable",
          cause,
        }),
    });
    if (bytes instanceof Error && isMissing(bytes.cause)) return null;
    return bytes;
  },

  mkdirAll(absDir) {
    return errore.try({
      try: () => {
        fs.mkdirSync(absDir, { recursive: true });
        return undefined;
      },
      catch: (cause) =>
        new DesignSystemSourceIoError({
          operation: "mkdir",
          path: absDir,
          detail: "directory unavailable",
          cause,
        }),
    });
  },

  durableWrite(absPath, bytes) {
    return durableFileWrite(absPath, bytes);
  },

  removeDir(absDir) {
    return errore.try({
      try: () => {
        fs.rmSync(absDir, { recursive: true, force: true });
        return undefined;
      },
      catch: (cause) =>
        new DesignSystemSourceIoError({
          operation: "remove",
          path: absDir,
          detail: "directory could not be removed",
          cause,
        }),
    });
  },

  renameDir(from, to) {
    return errore.try({
      try: () => {
        fs.renameSync(from, to);
        return undefined;
      },
      catch: (cause) =>
        new DesignSystemSourceIoError({
          operation: "rename",
          path: from,
          detail: "directory could not be renamed",
          cause,
        }),
    });
  },
};

/**
 * The no-op budget. FOR TESTS ONLY — production callers hand in a real budget over
 * `store/safe-fs`'s `createLimitBudget` (design §8.3, P10). It exists so this module's own tests
 * do not have to construct a limit table they are not testing.
 */
export const allowAllPackageAdmission: PackageAdmission = {
  admitFile: () => null,
  observeBytes: () => null,
};
