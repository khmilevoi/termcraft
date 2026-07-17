/**
 * Canonical lowercase UUIDv7. Bun's implementation embeds a millisecond
 * timestamp plus a monotonic sub-millisecond counter, so in-process ids
 * sort in generation order — storage relies on that for record ordering.
 */
export function uuidv7(): string {
  return Bun.randomUUIDv7()
}
