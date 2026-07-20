import crypto from "node:crypto"

import type { Sha256Hex } from "../types"

/** The two inputs that determine one project's machine-local sandbox parent. */
export interface ProjectKeyInput {
  readonly canonicalProjectRoot: string
  readonly projectId: string
}

/**
 * Lowercase-hex SHA-256 over `UTF-8(canonicalProjectRoot) || 0x00 || UTF-8(projectId)`
 * (storage-identity §4, turn-durability §6.2) — the name of the machine-local sandbox
 * parent under `{userStateRoot}/sandboxes/`. No salt and no OS-temporary root fallback:
 * the key is a pure function of exactly these two fields, so the same project on the same
 * machine always resolves to the same sandbox parent, and two projects that happen to
 * share a basename under different roots never collide (the `0x00` separator is what
 * keeps a `root`/`projectId` boundary from being forgeable by string concatenation).
 *
 * JUDGMENT CALL (spec gap): neither storage-identity §4 nor turn-durability §6.2 states a
 * canonicalization rule (NFC, trailing separator, drive-letter case, …) for
 * `canonicalProjectRoot` the way storage-identity §8 pins one for `TrustSubjectV1`
 * (`store/trust`'s `canonicalizeTrustPath`). This function hashes the caller-supplied
 * string exactly as given rather than re-deriving its own canonical form — the caller
 * (the composition root, which already resolves the project root once at startup) is
 * responsible for passing an already-canonical, `realpath`-resolved root so that two
 * spellings of the same path never split the sandbox parent.
 */
export function computeProjectKey(input: ProjectKeyInput): Sha256Hex {
  const root = Buffer.from(input.canonicalProjectRoot, "utf8")
  const separator = Buffer.from([0x00])
  const projectId = Buffer.from(input.projectId, "utf8")
  return crypto.createHash("sha256").update(Buffer.concat([root, separator, projectId])).digest("hex")
}
