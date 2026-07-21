import { uuidv7 } from "infrastructure/uuid";

import type { HostSessionIdentity, HostSessionSpec } from "../../types";

const NONCE_BYTES = 16;

/** 128 random bits as 32 lowercase hex characters — one process incarnation (§3.1). */
export function mintNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/**
 * Mint the identity for a new incarnation. `sessionId` is generated once per
 * logical session (UUIDv7) and passed back on restart so it stays stable; the
 * `nonce` is always fresh. Never accepts a nonce from the caller (§3.1).
 */
export function mintIdentity(spec: HostSessionSpec, sessionId?: string): HostSessionIdentity {
  return {
    mode: spec.mode,
    pageSlug: spec.pageSlug,
    sourceHash: spec.sourceHash,
    kitApiVersion: spec.kitApiVersion,
    sessionId: sessionId ?? uuidv7(),
    nonce: mintNonce(),
  };
}
