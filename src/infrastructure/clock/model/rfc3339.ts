import { z } from "zod";

/**
 * A UTC RFC 3339 timestamp as termcraft writes it (storage-identity §11.1): a
 * date-time with a `T` separator, optional fractional seconds, and a UTC designator
 * (`Z` or `+00:00`). Non-UTC offsets are rejected — every stored `ts` is UTC.
 */
const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|\+00:00)$/;

/** True iff `value` is a syntactically valid UTC RFC 3339 timestamp with a real calendar date. */
export function isRfc3339Utc(value: string): boolean {
  if (!RFC3339_UTC.test(value)) return false;
  return !Number.isNaN(Date.parse(value));
}

/** A Zod schema for {@link isRfc3339Utc} — the shared `ts` check every decoder reuses. */
export const rfc3339UtcSchema = z
  .string()
  .refine(isRfc3339Utc, { error: "must be a UTC RFC 3339 timestamp" });
