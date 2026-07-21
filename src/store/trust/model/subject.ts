import crypto from "node:crypto";

import type { Sha256Hex, TrustSubjectInput } from "../types";

/**
 * The literal ASCII domain-separation prefix of the encoding (storage-identity §8). It is
 * followed by exactly one NUL byte, then the length-prefixed fields.
 */
export const TRUST_SUBJECT_V1_PREFIX = "termcraft-trust-subject-v1";

/** The two literal Git-presence tags; they are encoded as ordinary length-prefixed fields. */
const GIT_ABSENT = "absent";
const GIT_PRESENT = "present";

/**
 * One field: `u32be(NFC-UTF8 byte length) || NFC-UTF8 bytes` (storage-identity §8). No
 * delimiter and no omitted empty field is allowed — an empty string is a length-0 field,
 * which is why `absent` can never be forged by supplying empty Git strings.
 */
function encodeField(value: string): Buffer {
  const bytes = Buffer.from(value.normalize("NFC"), "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.byteLength);
  return Buffer.concat([length, bytes]);
}

/**
 * The ordered field list of `TrustSubjectV1` (storage-identity §8): canonical project
 * path, canonical filesystem-identity string, lowercase project UUID, the `absent`/
 * `present` tag, and — only when `present` — canonical Git common dir, its
 * filesystem-identity string, and the NFC repo-relative project path.
 *
 * The project UUID is lowercased here because §8 names the field "lowercase project
 * UUID"; a caller that hands in upper-case text must not land on a different trust key.
 */
function subjectFields(input: TrustSubjectInput): string[] {
  const head = [
    input.canonicalProjectPath,
    input.projectFilesystemIdentity,
    input.projectId.toLowerCase(),
  ];
  if (input.git === null) return [...head, GIT_ABSENT];
  return [
    ...head,
    GIT_PRESENT,
    input.git.canonicalGitCommonDir,
    input.git.gitCommonDirFilesystemIdentity,
    input.git.projectPathRelativeToWorktreeRoot,
  ];
}

/**
 * The byte-exact `TrustSubjectV1` digest input (storage-identity §8), verified against
 * both normative vectors in `subject.test.ts`. Pure and total: nothing outside the four
 * `TrustSubjectInput` fields can influence the resulting trust key.
 */
export function encodeTrustSubjectV1(input: TrustSubjectInput): Uint8Array {
  const prefix = Buffer.concat([Buffer.from(TRUST_SUBJECT_V1_PREFIX, "utf8"), Buffer.from([0x00])]);
  return Buffer.concat([prefix, ...subjectFields(input).map(encodeField)]);
}

/** The trust key: lowercase-hex SHA-256 of the complete encoded byte string (§8). */
export function trustSubjectKey(input: TrustSubjectInput): Sha256Hex {
  return crypto.createHash("sha256").update(encodeTrustSubjectV1(input)).digest("hex");
}

// ---- canonical path forms (storage-identity §8) --------------------------------

/** `\\?\C:\x` and `\\?\UNC\server\share` are Win32 extended-length forms of ordinary paths. */
function stripExtendedLengthPrefix(forwardSlashed: string): string {
  if (forwardSlashed.startsWith("//?/UNC/")) return `//${forwardSlashed.slice("//?/UNC/".length)}`;
  if (forwardSlashed.startsWith("//?/")) return forwardSlashed.slice("//?/".length);
  return forwardSlashed;
}

/** `^[a-z]:` → uppercase; §8 preserves filesystem-resolved case everywhere else. */
function upperDriveLetter(value: string): string {
  const drive = value.match(/^([a-zA-Z]):/);
  if (drive === null) return value;
  return `${(drive[1] as string).toUpperCase()}:${value.slice(2)}`;
}

/**
 * "No trailing separator except a root" (§8). A bare drive (`C:`) is the same location as
 * the drive root, so it normalizes to `C:/` rather than losing its root separator.
 */
function stripTrailingSeparator(value: string): string {
  if (/^[A-Z]:\/*$/.test(value)) return `${value.slice(0, 2)}/`;
  const stripped = value.replace(/\/+$/, "");
  if (stripped === "") return "/";
  return stripped;
}

/**
 * The canonical form of an already-resolved absolute path (storage-identity §8): `/`
 * separators, filesystem-resolved case preserved except an uppercase Windows drive
 * letter, no trailing separator except at a root, NFC.
 *
 * This normalizes only the textual form. Resolving aliases (junctions, symlinks, `..`)
 * is the caller's `realpath` step — `buildSubject` does it before calling here, so two
 * aliases for one filesystem object collapse to one subject.
 */
export function canonicalizeTrustPath(rawPath: string): string {
  const forwardSlashed = rawPath.replace(/\\/g, "/").normalize("NFC");
  return stripTrailingSeparator(upperDriveLetter(stripExtendedLengthPrefix(forwardSlashed)));
}

/**
 * The canonical form of the NFC repository-relative project path (storage-identity §8):
 * `/` separators, no surrounding separators, no leading `./`.
 *
 * JUDGMENT CALL (§8 gap): the spec names the field but does not say how a project sitting
 * AT the worktree root is spelled. Git would render that as `.`; this encoder maps `.`
 * and `""` alike to the empty string, which §8 still encodes as an explicit length-0
 * field. Both spellings must therefore agree on one key rather than splitting the subject.
 */
export function canonicalizeRepoRelativePath(rawPath: string): string {
  const forwardSlashed = rawPath.replace(/\\/g, "/").normalize("NFC");
  const unanchored = forwardSlashed.replace(/^\.\//, "").replace(/^\/+/, "").replace(/\/+$/, "");
  if (unanchored === ".") return "";
  return unanchored;
}
