import * as errore from "errore";
import { z } from "zod";

import type { PageSlug } from "../types";

export class InvalidPageSlugError extends errore.createTaggedError({
  name: "InvalidPageSlugError",
  message: "Invalid page slug $slug: $reason",
}) {}

// Master spec §6.2: a slug is a directory name on disk.
const PAGE_SLUG_MASK = /^[a-z0-9][a-z0-9-]{0,31}$/;

const WINDOWS_RESERVED_NAMES = new Set([
  "con",
  "nul",
  "aux",
  "prn",
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

export function parsePageSlug(raw: string) {
  if (!PAGE_SLUG_MASK.test(raw)) {
    return new InvalidPageSlugError({
      slug: raw,
      reason: "does not match the slug mask ^[a-z0-9][a-z0-9-]{0,31}$",
    });
  }
  if (WINDOWS_RESERVED_NAMES.has(raw)) {
    return new InvalidPageSlugError({
      slug: raw,
      reason: "is a reserved Windows device name",
    });
  }
  return raw as PageSlug;
}

/** A Zod schema for {@link parsePageSlug} — decoders elsewhere reuse this rather than reimplementing the mask. */
export const pageSlugSchema = z.string().transform((raw, ctx) => {
  const slug = parsePageSlug(raw);
  if (slug instanceof Error) {
    ctx.addIssue({ code: "custom", message: slug.message });
    return z.NEVER;
  }
  return slug;
});
