import * as errore from "errore";
import { z } from "zod";

import type { DesignSystemRef } from "entities/design-system-ref";
import { formatDesignSystemRef, parseDesignSystemRef } from "entities/design-system-ref";
import { rfc3339UtcSchema } from "infrastructure/clock";

import type { Sha256Hex } from "../types";

/**
 * The project's record of WHERE its design system came from (design §8.5), in project state
 * OUTSIDE `design/`.
 *
 * NOT INSIDE THE MANIFEST, by the spec's own argument: "a package published back out would then
 * carry a claim about its own origin that stops being true on the first republish."
 *
 * NOT INSIDE `project.toml`: that file is the PORTABLE manifest, a `z.strictObject` gated by
 * `PROJECT_MANIFEST_FORMAT_VERSION`, so a new field costs a format bump and a migration step.
 * NOT INSIDE `workspace.local.toml`: that file is machine-local and excluded from every commit
 * scope, and provenance has to travel with the project. NOT UNDER `cache/`: gitignored, and
 * discardable by name. So: its own small, versioned, portable file at the top of `.termcraft/`.
 *
 * ABSENCE IS MEANINGFUL AND IS NOT AN ERROR. A project whose design system came from the compiled
 * seed — every project P4 scaffolds or migrates — has no source to record, and says so by having
 * no file. Only an install writes one.
 *
 * The `contentHash` beside the reference is what makes the address checkable rather than trusted
 * (§8.2, §8.5): a source can republish a version, and re-fetching the same address later is
 * compared against the bytes the project actually installed, not just the version string.
 */
export const DESIGN_SYSTEM_PROVENANCE_FILENAME = "design-system-source.json";

export const DESIGN_SYSTEM_PROVENANCE_SCHEMA_VERSION = 1;

export interface DesignSystemProvenanceV1 {
  readonly schemaVersion: typeof DESIGN_SYSTEM_PROVENANCE_SCHEMA_VERSION;
  readonly ref: DesignSystemRef;
  readonly contentHash: Sha256Hex;
  /** RFC 3339 UTC. */
  readonly installedAt: string;
}

export class DesignSystemProvenanceInvalidError extends errore.createTaggedError({
  name: "DesignSystemProvenanceInvalidError",
  message: "$path is not a valid design-system provenance record [$code]: $reason",
}) {}

const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);

/** The reference is stored as its CANONICAL TEXT, so the file reads as the address it names. */
const provenanceSchema = z.strictObject({
  schemaVersion: z.literal(DESIGN_SYSTEM_PROVENANCE_SCHEMA_VERSION),
  ref: z.string().min(1),
  contentHash: sha256HexSchema,
  installedAt: rfc3339UtcSchema,
});

export function encodeDesignSystemProvenance(record: DesignSystemProvenanceV1): Uint8Array {
  return new TextEncoder().encode(
    `${JSON.stringify(
      {
        schemaVersion: record.schemaVersion,
        ref: formatDesignSystemRef(record.ref),
        contentHash: record.contentHash,
        installedAt: record.installedAt,
      },
      null,
      2,
    )}\n`,
  );
}

export function decodeDesignSystemProvenance(
  bytes: Uint8Array,
): DesignSystemProvenanceInvalidError | DesignSystemProvenanceV1 {
  const text = errore.try({
    try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    catch: (cause) =>
      new DesignSystemProvenanceInvalidError({
        path: DESIGN_SYSTEM_PROVENANCE_FILENAME,
        code: "NOT_UTF8",
        reason: "the file is not valid UTF-8",
        cause,
      }),
  });
  if (text instanceof Error) return text;

  const parsed = errore.try({
    try: () => JSON.parse(text) as Record<string, unknown>,
    catch: (cause) =>
      new DesignSystemProvenanceInvalidError({
        path: DESIGN_SYSTEM_PROVENANCE_FILENAME,
        code: "NOT_JSON",
        reason: "the file is not JSON",
        cause,
      }),
  });
  if (parsed instanceof Error) return parsed;

  const shape = provenanceSchema.safeParse(parsed);
  if (!shape.success) {
    return new DesignSystemProvenanceInvalidError({
      path: DESIGN_SYSTEM_PROVENANCE_FILENAME,
      code: "SHAPE",
      reason: shape.error.issues.map((issue) => issue.message).join("; "),
    });
  }

  const ref = parseDesignSystemRef(shape.data.ref);
  if (ref instanceof Error) {
    return new DesignSystemProvenanceInvalidError({
      path: DESIGN_SYSTEM_PROVENANCE_FILENAME,
      code: "REF",
      reason: ref.message,
      cause: ref,
    });
  }

  return {
    schemaVersion: shape.data.schemaVersion,
    ref,
    contentHash: shape.data.contentHash,
    installedAt: shape.data.installedAt,
  };
}
