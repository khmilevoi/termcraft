import * as errore from "errore";
import { z } from "zod";

import type { DesignSystemId, DesignSystemRef, DesignSystemVersion, SourceId } from "../types";

export class InvalidDesignSystemRefError extends errore.createTaggedError({
  name: "InvalidDesignSystemRefError",
  message: "Invalid design-system reference $value: $reason",
}) {}

/** A source family, optionally followed by `:` and a locator (design §8.1's `github:acme/design-systems`). */
const SOURCE_ID_MASK = /^[a-z][a-z0-9-]{0,31}(:[a-z0-9][a-zA-Z0-9._\-/]{0,127})?$/;

/**
 * The same shape `entities/page`'s `PAGE_SLUG_MASK` uses, and for the same reason: this string
 * is a directory name on disk (`design-systems/local/<id>/`). Deliberately duplicated rather
 * than imported — a design-system id is a different identity with a different brand, and
 * borrowing `parsePageSlug` would hand back a `PageSlug`.
 */
const DESIGN_SYSTEM_ID_MASK = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** `MAJOR.MINOR.PATCH`, no prerelease and no build metadata — design §8.1 shows nothing else. */
const VERSION_MASK = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;

/** Mirrors `entities/page/model/slug.ts` — both of these strings become directory names. */
const WINDOWS_RESERVED_NAMES: ReadonlySet<string> = new Set([
  "con",
  "nul",
  "aux",
  "prn",
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

export function parseSourceId(raw: string) {
  if (!SOURCE_ID_MASK.test(raw)) {
    return new InvalidDesignSystemRefError({
      value: raw,
      reason: "source id does not match ^[a-z][a-z0-9-]{0,31}(:[a-z0-9][a-zA-Z0-9._\\-/]{0,127})?$",
    });
  }
  // The family segment becomes a path component under `design-systems/cache/` once encoded.
  const family = raw.split(":", 1)[0] as string;
  if (WINDOWS_RESERVED_NAMES.has(family)) {
    return new InvalidDesignSystemRefError({
      value: raw,
      reason: "source id family is a reserved Windows device name",
    });
  }
  return raw as SourceId;
}

export function parseDesignSystemId(raw: string) {
  if (!DESIGN_SYSTEM_ID_MASK.test(raw)) {
    return new InvalidDesignSystemRefError({
      value: raw,
      reason: "system id does not match ^[a-z0-9][a-z0-9-]{0,31}$",
    });
  }
  if (WINDOWS_RESERVED_NAMES.has(raw)) {
    return new InvalidDesignSystemRefError({
      value: raw,
      reason: "system id is a reserved Windows device name",
    });
  }
  return raw as DesignSystemId;
}

export function parseDesignSystemVersion(raw: string) {
  if (!VERSION_MASK.test(raw)) {
    return new InvalidDesignSystemRefError({
      value: raw,
      reason: "version is not MAJOR.MINOR.PATCH with no leading zeros",
    });
  }
  return raw as DesignSystemVersion;
}

/**
 * `source:system@version` (design §8.1). The source id runs to the `#` when there is one and to
 * the FIRST `:` otherwise — that single rule covers both `local:midnight@1.2.0` and
 * `github:acme/design-systems#midnight@1.3.0` without a per-family special case. The remainder
 * splits at its LAST `@`, so a hostile `a@b@1.0.0` fails on the system-id mask rather than
 * silently parsing as something else.
 */
export function parseDesignSystemRef(raw: string) {
  const hashAt = raw.indexOf("#");
  const splitAt = hashAt >= 0 ? hashAt : raw.indexOf(":");
  if (splitAt <= 0) {
    return new InvalidDesignSystemRefError({
      value: raw,
      reason: "expected <source>:<system>@<version> or <source>#<system>@<version>",
    });
  }

  const sourceId = parseSourceId(raw.slice(0, splitAt));
  if (sourceId instanceof Error) return sourceId;

  const rest = raw.slice(splitAt + 1);
  const atAt = rest.lastIndexOf("@");
  if (atAt <= 0) {
    return new InvalidDesignSystemRefError({
      value: raw,
      reason: "expected <system>@<version> after the source id",
    });
  }

  const systemId = parseDesignSystemId(rest.slice(0, atAt));
  if (systemId instanceof Error) return systemId;

  const version = parseDesignSystemVersion(rest.slice(atAt + 1));
  if (version instanceof Error) return version;

  return { sourceId, systemId, version } satisfies DesignSystemRef;
}

/**
 * The canonical textual form. `#` when the source id carries a locator (its own `:` would
 * otherwise be ambiguous with the separator), `:` when it does not — so a reference parsed from
 * the non-canonical `local#midnight@1.2.0` formats back as `local:midnight@1.2.0`.
 */
export function formatDesignSystemRef(ref: DesignSystemRef): string {
  const separator = ref.sourceId.includes(":") ? "#" : ":";
  return `${ref.sourceId}${separator}${ref.systemId}@${ref.version}`;
}

/** Decodes reference TEXT (as stored in `sources.json`, a cache entry, or a provenance record). */
export const designSystemRefSchema = z.string().transform((raw, ctx) => {
  const ref = parseDesignSystemRef(raw);
  if (ref instanceof Error) {
    ctx.addIssue({ code: "custom", message: ref.message });
    return z.NEVER;
  }
  return ref;
});
