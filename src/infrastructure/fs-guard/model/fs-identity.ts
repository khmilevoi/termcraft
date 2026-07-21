import fs from "node:fs";

import * as errore from "errore";

import { FsIdentityError } from "./errors";

/**
 * The canonical filesystem-identity string of a directory or file (storage-identity
 * §8): `windows:<volume-serial-8hex-lower>:<file-id-hex-lower>` on Windows, or
 * `unix:<device-u64-decimal>:<inode-u64-decimal>` elsewhere. Spike F verified that
 * `fs.statSync(path, { bigint: true })` yields a `dev` matching the OS volume serial
 * byte-for-byte (8 lowercase hex digits) and an `ino` stable across git operations and
 * atomic file rewrites. The file-id half is variable-length — `statSync` returns at
 * most 8 bytes of file-id bits, so a shorter hex string is a valid encoding, not a
 * deviation. Domain-free: it formats an identity for any path, page-agnostic; the
 * TrustSubjectV1 assembly consumes it in `store/trust`.
 */
export function formatFsIdentity(absPath: string): string | FsIdentityError {
  const stat = errore.try({
    try: () => fs.statSync(absPath, { bigint: true }),
    catch: (cause) => new FsIdentityError({ path: absPath, cause }),
  });
  if (stat instanceof Error) return stat;

  if (process.platform === "win32") {
    const serial = stat.dev.toString(16).padStart(8, "0");
    const fileId = stat.ino.toString(16);
    return `windows:${serial}:${fileId}`;
  }
  return `unix:${stat.dev.toString(10)}:${stat.ino.toString(10)}`;
}
