import * as errore from "errore";

import { type Sha256Hex } from "./ids";

/**
 * Canonical serialization and hashing for command envelopes.
 *
 * kernel-command-contract §8.5 makes this load-bearing for exactly-once handling: "For a
 * first-seen id, the ledger stores a canonical hash of the complete envelope... A later
 * byte-equivalent/canonically equivalent envelope returns the exact stored result...
 * Reusing the id with any different envelope field returns `COMMAND_ID_REUSE_MISMATCH`."
 *
 * So the hash must satisfy two properties at once. Two envelopes that MEAN the same thing
 * must hash the same, or a legitimate retry of an unknown-result command would be
 * misreported as id reuse. Two envelopes that differ in any field must hash differently,
 * or one intent could silently return another's stored result.
 *
 * `JSON.stringify` alone provides neither: it preserves insertion order (so `{a,b}` and
 * `{b,a}` differ) and it silently drops `undefined`, coerces `Date`, and empties `Map`/`Set`
 * (so genuinely different inputs collide). This module orders keys and refuses every value
 * §8.1 forbids in a DTO rather than encoding it into a lie.
 */

/** A value that cannot be canonicalized: forbidden in a DTO, non-finite, or cyclic. */
export class CanonicalHashError extends errore.createTaggedError({
  name: "CanonicalHashError",
  message: "cannot canonicalize $path: $reason",
}) {}

function describePath(path: readonly string[]): string {
  return path.length === 0 ? "<root>" : path.join(".");
}

function encode(
  value: unknown,
  path: readonly string[],
  seen: ReadonlySet<object>,
): CanonicalHashError | string {
  if (value === null) return "null";

  const type = typeof value;

  if (type === "string") return JSON.stringify(value);

  if (type === "boolean") return value === true ? "true" : "false";

  if (type === "number") {
    const numeric = value as number;
    if (!Number.isFinite(numeric)) {
      return new CanonicalHashError({
        path: describePath(path),
        reason: `non-finite number ${String(numeric)}`,
      });
    }
    // JSON.stringify's number formatting is the shortest round-trippable form and is
    // fully specified, so it is already canonical for finite doubles.
    return JSON.stringify(numeric);
  }

  if (type === "undefined") {
    return new CanonicalHashError({ path: describePath(path), reason: "undefined" });
  }

  if (type === "bigint") {
    // §4: "bigint never crosses a DTO boundary" — counters travel as UInt64String.
    return new CanonicalHashError({ path: describePath(path), reason: "bigint" });
  }

  if (type === "function" || type === "symbol") {
    return new CanonicalHashError({ path: describePath(path), reason: type });
  }

  if (type !== "object") {
    return new CanonicalHashError({ path: describePath(path), reason: `unsupported ${type}` });
  }

  const object = value as object;

  if (seen.has(object)) {
    return new CanonicalHashError({ path: describePath(path), reason: "cycle" });
  }

  if (object instanceof Date) {
    return new CanonicalHashError({ path: describePath(path), reason: "Date" });
  }
  if (object instanceof Map) {
    return new CanonicalHashError({ path: describePath(path), reason: "Map" });
  }
  if (object instanceof Set) {
    return new CanonicalHashError({ path: describePath(path), reason: "Set" });
  }
  if (object instanceof Error) {
    return new CanonicalHashError({ path: describePath(path), reason: "Error" });
  }

  const nested = new Set(seen);
  nested.add(object);

  if (Array.isArray(object)) {
    const parts: string[] = [];
    for (const [index, item] of object.entries()) {
      // Array order is meaning, not incidental: page.reorder's payload IS a permutation,
      // so sorting elements here would erase the very intent being hashed.
      const encoded = encode(item, [...path, String(index)], nested);
      if (encoded instanceof Error) return encoded;
      parts.push(encoded);
    }
    return `[${parts.join(",")}]`;
  }

  const prototype = Object.getPrototypeOf(object);
  if (prototype !== Object.prototype && prototype !== null) {
    return new CanonicalHashError({ path: describePath(path), reason: "class instance" });
  }

  const record = object as Record<string, unknown>;
  // Sort by code unit so the order is locale-independent and reproducible across machines.
  const keys = Object.keys(record).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const encoded = encode(record[key], [...path, key], nested);
    if (encoded instanceof Error) return encoded;
    parts.push(`${JSON.stringify(key)}:${encoded}`);
  }
  return `{${parts.join(",")}}`;
}

/**
 * Serializes a DTO value to its one canonical JSON spelling, or returns the reason it
 * cannot be serialized. Object keys are sorted; array order is preserved.
 */
export function canonicalJson(value: unknown): CanonicalHashError | string {
  return encode(value, [], new Set());
}

/** SHA-256 of the canonical serialization, as 64 lowercase hex characters. */
export function canonicalHash(value: unknown): CanonicalHashError | Sha256Hex {
  const json = canonicalJson(value);
  if (json instanceof Error) return json;
  return new Bun.CryptoHasher("sha256").update(json, "utf8").digest("hex");
}
