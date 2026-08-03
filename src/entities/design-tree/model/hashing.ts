/**
 * Lowercase-hex SHA-256 over exact bytes (design-tree §7: this is the digest
 * `DesignFileEntryV1.sha256` carries, and what `computeClosureHash`/`computeTreeRevision`
 * fold). This repo deliberately keeps this digest independently implemented per ring rather
 * than forcing one shared function across layer boundaries — `store/jsonl/model/line-codec.ts`'s
 * `sha256Hex` (`node:crypto`) and `host/session/model/source-mount.ts`'s own `computeSourceHash`
 * (`Bun.CryptoHasher`) already do this, and `gate/model/smoke.test.ts`'s "parity pin" test is
 * this codebase's established way of keeping such duplicates honest instead of unifying them.
 * `line-codec.test.ts`'s own "sha256Hex parity" test pins this copy against that one the same
 * way.
 *
 * This copy exists because `core/ports` may not import `store` or `host` (`core/ports/index.ts`'s
 * own header: "Nothing under `core/ports/` imports `store`, `agent`, `gate`, or `host`, even
 * type-only"). `core/ports/fakes/design-store.ts` needs to hash a SEEDED file's bytes the exact
 * way the real `store` adapter hashes them, so it needs a copy it CAN import — `entities/` is a
 * ring both `core/ports` and `store` already depend on.
 */
export function computeSourceHash(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}
