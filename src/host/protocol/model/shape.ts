import { z } from "zod";

import { ProtocolError } from "./errors";
import type { JsonValue } from "./strict-json";

const malformed = (reason: string) => new ProtocolError({ code: "MALFORMED_PROTOCOL", reason });

/**
 * Maps the first Zod issue to a `MALFORMED_PROTOCOL` `ProtocolError`. Every
 * protocol-layer schema violation is this one code — unlike the entities/ decoders,
 * the wire protocol has no per-field diagnostic taxonomy, just `reason` text.
 */
export function malformedFromZodError(error: z.ZodError): ProtocolError {
  return malformed(error.issues[0]?.message ?? "invalid input");
}

/** A plain JSON object (not null, not an array) — the Zod form of the old `asObject` narrow. */
export const jsonObjectSchema = z.custom<{ [key: string]: JsonValue }>(
  (value) => typeof value === "object" && value !== null && !Array.isArray(value),
  { error: "must be a JSON object" },
);

export const positiveSafeIntegerSchema = z.custom<number>(
  (value) => typeof value === "number" && Number.isSafeInteger(value) && value > 0,
  { error: "must be a positive safe integer" },
);

/** A non-empty string within `maxLength` (the Zod form of the old `asString`). */
export function boundedStringSchema(maxLength: number) {
  return z.string().min(1).max(maxLength);
}

const MAX_UINT64_DECIMAL = "18446744073709551615";

/** A decimal string for an unsigned integer ≥ 1, bounded to 64 bits. */
export const decimalUint64Schema = z.custom<string>(
  (value) => {
    if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return false;
    if (value.length > MAX_UINT64_DECIMAL.length) return false;
    if (value.length === MAX_UINT64_DECIMAL.length && value > MAX_UINT64_DECIMAL) return false;
    return true;
  },
  { error: "must be a decimal string for an unsigned integer >= 1, bounded to 64 bits" },
);

/** Exactly `length` lowercase hexadecimal characters. */
export function lowercaseHexSchema(length: number) {
  const pattern = new RegExp(`^[0-9a-f]{${length}}$`);
  return z.custom<string>((value) => typeof value === "string" && pattern.test(value), {
    error: `must be exactly ${length} lowercase hexadecimal characters`,
  });
}

/** Non-empty printable-ASCII string within `maxLength` (§7.1 capability ids). */
export function boundedAsciiSchema(maxLength: number) {
  return z.custom<string>(
    (value) =>
      typeof value === "string" &&
      value.length > 0 &&
      value.length <= maxLength &&
      /^[\x21-\x7e]+$/.test(value),
    { error: `must be a non-empty printable-ASCII string <= ${maxLength} characters` },
  );
}

function isSortedUniqueNumbers(values: readonly number[]): boolean {
  return values.every((value, index) => index === 0 || value > (values[index - 1] ?? value));
}

function isSortedUniqueStrings(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || value > (values[index - 1] ?? value));
}

/** A number array that must be sorted ascending with no duplicates. */
export function sortedUniqueNumberArraySchema<T extends z.ZodType<number>>(itemSchema: T) {
  return z
    .array(itemSchema)
    .refine(isSortedUniqueNumbers, { error: "must be sorted and duplicate-free" });
}

/** A string array that must be sorted ascending with no duplicates. */
export function sortedUniqueStringArraySchema<T extends z.ZodType<string>>(itemSchema: T) {
  return z
    .array(itemSchema)
    .refine(isSortedUniqueStrings, { error: "must be sorted and duplicate-free" });
}
