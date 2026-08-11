import crypto from "node:crypto";

import * as errore from "errore";

import type { PackageFile, Sha256Hex } from "../types";

/**
 * The literal ASCII domain-separation prefix of the package encoding, followed by exactly one
 * NUL byte. Same construction as `store/trust`'s subject encoding, and for the same reason: a
 * digest with no domain separator can collide with a digest of a different KIND of thing.
 */
export const DESIGN_SYSTEM_PACKAGE_V1_PREFIX = "termcraft-design-system-package-v1";

/** Two files of one package normalize to the same path — the caller's file set is not a set. */
export class DuplicatePackageFileError extends errore.createTaggedError({
  name: "DuplicatePackageFileError",
  message: "design-system package lists $path more than once",
}) {}

/**
 * The canonical package-relative path: `/` separators, no leading `./`, no surrounding or
 * repeated separators, NFC. Two spellings of one file must not hash differently, and must not
 * both survive into the file set — `a/b.ts` and `a//b.ts` collapse to the same path, matching
 * `path.join`'s own collapse of an empty segment on disk (otherwise a package publishes
 * "successfully" with one file silently overwriting the other while the hash still describes
 * both as distinct).
 */
export function normalizePackageRelPath(raw: string): string {
  const forwardSlashed = raw.replace(/\\/g, "/").normalize("NFC");
  return forwardSlashed
    .replace(/^\.\//, "")
    .replace(/\/+/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

/**
 * The byte-exact digest input for a design-system package (design §8.2's "sha256 content hash
 * over the file set"; §8.2 fixes the property, this function fixes the encoding):
 *
 * ```
 * prefix || 0x00 || u32be(fileCount)
 * for each file, ascending by NFC-UTF8 relPath bytes:
 *   u32be(relPath byte length) || relPath bytes || sha256(file bytes)
 * ```
 *
 * Each file contributes its own 32-byte digest rather than its bytes, which keeps the digest
 * input small and removes any need for a 64-bit length field. Sorting by path makes the result
 * independent of directory-walk order, so two sources serving the same bytes agree.
 */
export function encodeDesignSystemPackageV1(files: readonly PackageFile[]) {
  const normalized = files.map((file) => ({
    relPath: normalizePackageRelPath(file.relPath),
    bytes: file.bytes,
  }));

  const seen = new Set<string>();
  for (const file of normalized) {
    if (seen.has(file.relPath)) return new DuplicatePackageFileError({ path: file.relPath });
    seen.add(file.relPath);
  }

  const sorted = [...normalized].sort((left, right) =>
    Buffer.compare(Buffer.from(left.relPath, "utf8"), Buffer.from(right.relPath, "utf8")),
  );

  const header = Buffer.alloc(4);
  header.writeUInt32BE(sorted.length);
  const parts: Buffer[] = [
    Buffer.from(DESIGN_SYSTEM_PACKAGE_V1_PREFIX, "utf8"),
    Buffer.from([0x00]),
    header,
  ];

  for (const file of sorted) {
    const pathBytes = Buffer.from(file.relPath, "utf8");
    const pathLength = Buffer.alloc(4);
    pathLength.writeUInt32BE(pathBytes.byteLength);
    parts.push(pathLength, pathBytes, crypto.createHash("sha256").update(file.bytes).digest());
  }

  return new Uint8Array(Buffer.concat(parts));
}

/** The package's content hash: lowercase-hex SHA-256 of {@link encodeDesignSystemPackageV1}. */
export function designSystemContentHash(files: readonly PackageFile[]) {
  const encoded = encodeDesignSystemPackageV1(files);
  if (encoded instanceof Error) return encoded;
  return crypto.createHash("sha256").update(encoded).digest("hex") satisfies Sha256Hex;
}
