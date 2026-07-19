/**
 * Canonical lowercase UUIDv7. Bun's implementation embeds a millisecond
 * timestamp plus a monotonic sub-millisecond counter, so in-process ids
 * sort in generation order — storage relies on that for record ordering.
 */
export function uuidv7(): string {
  return Bun.randomUUIDv7()
}

/**
 * The canonical UUIDv7 text form under RFC 9562: 8-4-4-4-12 lowercase hex with the
 * version nibble fixed to `7` and the variant nibble in `{8,9,a,b}`. Every non-page
 * termcraft identity is validated with this on read (storage-identity §3.1); it is a
 * uniform format check, not a brand — ids are minted, not parsed.
 */
const CANONICAL_UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** True iff `value` is a canonical lowercase UUIDv7 (RFC 9562). */
export function isCanonicalUuidv7(value: string): boolean {
  return CANONICAL_UUIDV7.test(value)
}
