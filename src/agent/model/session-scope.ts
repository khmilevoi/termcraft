import type { SessionScopeInput } from "../types"

/**
 * Fallback account discriminator for backends that cannot supply a stable
 * account (storage-identity §6.2: "returns a fresh scope for each PROCESS").
 * Minted once, at module load, not inside `deriveSessionScope` — the kernel
 * calls `sessionScope` twice per turn (once to look up the checkpoint, once
 * to advance it after the terminal record lands); a per-call random value
 * would make those two calls disagree and write every checkpoint under a key
 * nothing ever reads again. A module-level constant makes every call within
 * this process agree, while a fresh process still gets its own value.
 */
const UNRESUMABLE_ACCOUNT = `unresumable:${Bun.randomUUIDv7()}`

/**
 * The opaque `sessionScopeId` for the store checkpoint key (storage-identity
 * §6.2). Changes iff backend, account, model, or workspace identity changes.
 * Effort is deliberately excluded. A null account falls back to
 * `UNRESUMABLE_ACCOUNT`, which is stable for the life of this process and
 * differs across process restarts — cross-process resume is safely disabled
 * for that backend without desyncing same-process lookups (§6.2).
 *
 * Pure function — no atoms, no lifetime to own (Reatom N/A here per CLAUDE.md
 * mandate: this file has nothing async or stateful for Reatom to model).
 */
export function deriveSessionScope(backendId: string, input: SessionScopeInput): string {
  const account = input.account ?? UNRESUMABLE_ACCOUNT
  const material = [backendId, account, input.model, input.workspaceIdentity].join(" ")
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(material)
  return hasher.digest("hex")
}
