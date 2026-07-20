import type { SessionScopeInput } from "../types"

/**
 * The opaque `sessionScopeId` for the store checkpoint key (storage-identity
 * §6.2). Changes iff backend, account, model, or workspace identity changes.
 * Effort is deliberately excluded. A null account produces a per-call unique
 * value, which safely disables cross-process resume for that backend (§6.2).
 *
 * Pure function — no atoms, no lifetime to own (Reatom N/A here per CLAUDE.md
 * mandate: this file has nothing async or stateful for Reatom to model).
 */
export function deriveSessionScope(backendId: string, input: SessionScopeInput): string {
  const account = input.account ?? `unresumable:${Bun.randomUUIDv7()}`
  const material = [backendId, account, input.model, input.workspaceIdentity].join(" ")
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(material)
  return hasher.digest("hex")
}
