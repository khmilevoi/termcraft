import { z } from "zod";

import { canonicalUuidv7Schema, isCanonicalUuidv7 } from "infrastructure/uuid";

/**
 * The three opaque identity strings the Kernel DTOs carry, fixed verbatim by
 * kernel-command-contract §8.1:
 *
 * ```ts
 * type UUIDv7 = string
 * type Sha256Hex = string // exactly 64 lowercase hexadecimal characters
 * type HostNonce = string // exactly 32 lowercase hexadecimal characters
 * ```
 *
 * They are deliberately distinct schemas rather than one "hex string" helper: a nonce
 * and a source hash differ only by length, and the frame-identity tuple
 * `(previewSessionId, nonce, sourceHash, frameSeq)` is only meaningful when each
 * component is validated as its own kind.
 */
export type UUIDv7 = string;

/** Exactly 64 lowercase hexadecimal characters. */
export type Sha256Hex = string;

/** Exactly 32 lowercase hexadecimal characters. */
export type HostNonce = string;

const SHA256_HEX = /^[0-9a-f]{64}$/;
const HOST_NONCE = /^[0-9a-f]{32}$/;

/** True for a canonical lowercase UUIDv7. Delegates to the shared infrastructure guard. */
export function isUuidv7(raw: string): raw is UUIDv7 {
  return isCanonicalUuidv7(raw);
}

/** True for exactly 64 lowercase hexadecimal characters. */
export function isSha256Hex(raw: string): raw is Sha256Hex {
  return SHA256_HEX.test(raw);
}

/** True for exactly 32 lowercase hexadecimal characters. */
export function isHostNonce(raw: string): raw is HostNonce {
  return HOST_NONCE.test(raw);
}

/** Zod schema for a canonical UUIDv7, re-exported under the protocol's own name. */
export const uuidv7Schema = canonicalUuidv7Schema;

/** Zod schema for a 64-character lowercase SHA-256 hex digest. */
export const sha256HexSchema = z
  .string()
  .regex(SHA256_HEX, { error: "expected 64 lowercase hex characters" });

/** Zod schema for a 32-character lowercase host nonce. */
export const hostNonceSchema = z
  .string()
  .regex(HOST_NONCE, { error: "expected 32 lowercase hex characters" });
