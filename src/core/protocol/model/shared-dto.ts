import { z } from "zod";

import { pageSlugSchema } from "entities/page";
import { rfc3339UtcSchema } from "infrastructure/clock";

import { type Sha256Hex, type UUIDv7, hostNonceSchema, sha256HexSchema, uuidv7Schema } from "./ids";
import { type UInt64String, uint64StringSchema } from "./uint64";

/**
 * DTO shapes shared by more than one command payload, event payload, or ledger entry
 * (kernel-command-contract §8.1 and §9).
 *
 * Every object here is a `z.strictObject`, NOT the forward-compatible `z.object` used by
 * the storage decoders in `entities/`. The two boundaries have opposite requirements: a
 * JSONL record on disk may legitimately be written by a newer build and must survive
 * being read by an older one, whereas §8.2 says "every named object rejects unknown
 * keys" and §9 says "Unknown payload keys are invalid". An in-process protocol has no
 * version skew to tolerate, so an unexpected key is a bug to surface, not data to strip.
 *
 * Nullable fields are `.nullable()` and never `.optional()`: §9 states "fields marked
 * nullable carry JSON `null`, not omission".
 */

/** A fraction in the closed unit interval [0,1] — a pin's normalized anchor coordinate. */
const fractionSchema = z.number().min(0).max(1);

/**
 * The complete incarnation-local frame identity (§4, §12.5). No frame, query, or token
 * comparison is valid without all four parts: `frameSeq` resets when the host `nonce`
 * changes, so a bare sequence number means nothing on its own.
 */
export interface FrameIdentityV1 {
  readonly previewSessionId: UUIDv7;
  readonly nonce: string;
  readonly sourceHash: Sha256Hex;
  readonly frameSeq: UInt64String;
}

export const frameIdentityV1Schema = z.strictObject({
  previewSessionId: uuidv7Schema,
  nonce: hostNonceSchema,
  sourceHash: sha256HexSchema,
  frameSeq: uint64StringSchema,
});

/**
 * An opaque frame token (§8.1). It is query-authorizing only after the UI's typed
 * display acknowledgement, and it "cannot create a pin" — the binding stays in the
 * Kernel ledger and never travels in the DTO.
 */
export type FrameTokenV1 = UUIDv7;

export const frameTokenV1Schema = uuidv7Schema;

/**
 * An opaque geometry token (§8.1). Minted only by a resolving `hit`/`pin-anchor` query;
 * its private ledger entry binds `(FrameIdentityV1, pageSlug, elementId, fx, fy)`, none
 * of which the UI can inspect, edit, or synthesize.
 */
export type GeometryTokenV1 = UUIDv7;

export const geometryTokenV1Schema = uuidv7Schema;

/**
 * The immutable page-removal plan (§8.1). Confirmation is possession of the still-current
 * plan id at the current revision — §7.1: "`page.removeConfirm` never accepts an
 * acknowledgement boolean or page identity from the UI", which is why no acknowledgement
 * field exists here to accept.
 */
export interface PageRemovePlanV1 {
  readonly pageRemovePlanId: UUIDv7;
  readonly pageSlug: string;
  readonly sourceHash: Sha256Hex;
  readonly orderedPageSlugs: readonly string[];
  readonly pageOrderHash: Sha256Hex;
  readonly activePageSlug: string | null;
  readonly fallbackPageSlug: string | null;
  readonly planRevision: UInt64String;
}

export const pageRemovePlanV1Schema = z.strictObject({
  pageRemovePlanId: uuidv7Schema,
  pageSlug: pageSlugSchema,
  sourceHash: sha256HexSchema,
  orderedPageSlugs: z.array(pageSlugSchema).readonly(),
  pageOrderHash: sha256HexSchema,
  activePageSlug: pageSlugSchema.nullable(),
  fallbackPageSlug: pageSlugSchema.nullable(),
  planRevision: uint64StringSchema,
});

/** A bounded, display-safe error carried inside a descriptor — never a native `Error`. */
const safeErrorSchema = z.strictObject({
  code: z.string().min(1),
  safeMessage: z.string(),
});

/**
 * A page descriptor (§9). Discriminated on `status`, so an `invalid` descriptor cannot
 * carry `ready`-only meta and vice versa — a mixed shape means the producer lost track of
 * whether the page actually parsed.
 */
export type PageDescriptorV1 =
  | {
      readonly status: "ready";
      readonly pageSlug: string;
      readonly sourceHash: Sha256Hex;
      readonly title: string;
      readonly minSize: { readonly w: number; readonly h: number };
      readonly theme: string;
      readonly kitApiVersion: number;
    }
  | {
      readonly status: "invalid";
      readonly pageSlug: string;
      readonly sourceHash: Sha256Hex;
      readonly error: { readonly code: string; readonly safeMessage: string };
    };

const readyPageDescriptorSchema = z.strictObject({
  status: z.literal("ready"),
  pageSlug: pageSlugSchema,
  sourceHash: sha256HexSchema,
  title: z.string(),
  minSize: z.strictObject({
    w: z.number().int().positive(),
    h: z.number().int().positive(),
  }),
  theme: z.string().min(1),
  kitApiVersion: z.number().int().positive(),
});

const invalidPageDescriptorSchema = z.strictObject({
  status: z.literal("invalid"),
  pageSlug: pageSlugSchema,
  sourceHash: sha256HexSchema,
  error: safeErrorSchema,
});

export const pageDescriptorV1Schema = z.discriminatedUnion("status", [
  readyPageDescriptorSchema,
  invalidPageDescriptorSchema,
]);

/**
 * One entry in a descriptor change set (§9). Both hash bindings are explicit: §9 requires
 * that "every change carries its exact before/after source-hash binding", so an `added`
 * page states `beforeSourceHash: null` rather than omitting it.
 */
export interface PageDescriptorChangeV1 {
  readonly pageSlug: string;
  readonly kind: "added" | "updated" | "removed" | "reordered";
  readonly beforeSourceHash: Sha256Hex | null;
  readonly afterSourceHash: Sha256Hex | null;
}

export const pageDescriptorChangeV1Schema = z.strictObject({
  pageSlug: pageSlugSchema,
  kind: z.enum(["added", "updated", "removed", "reordered"]),
  beforeSourceHash: sha256HexSchema.nullable(),
  afterSourceHash: sha256HexSchema.nullable(),
});

/**
 * A complete pin as the UI sees it (§9). `pins.changed` always carries the whole DTO
 * including the stable `pinId` (§12.6) — the UI never reconstructs a pin from a record
 * stream, and it has no project-store write path at all.
 */
export interface PinDtoV1 {
  readonly pinId: UUIDv7;
  readonly pageSlug: string;
  readonly elementId: string;
  readonly fx: number;
  readonly fy: number;
  readonly text: string;
  readonly status: "open" | "resolved";
  readonly createdRecordId: UUIDv7;
  readonly latestRecordId: UUIDv7;
  readonly updatedAt: string;
}

export const pinDtoV1Schema = z.strictObject({
  pinId: uuidv7Schema,
  pageSlug: pageSlugSchema,
  elementId: z.string().min(1),
  fx: fractionSchema,
  fy: fractionSchema,
  text: z.string(), // empty-allowed on a pin, unlike an identity string
  status: z.enum(["open", "resolved"]),
  createdRecordId: uuidv7Schema,
  latestRecordId: uuidv7Schema,
  updatedAt: rfc3339UtcSchema,
});

/**
 * A bounded diagnostic (§9). The strict shape is a privacy boundary as much as a schema:
 * §11.2 forbids native `Error` objects and unbounded stdout/stderr from crossing an event
 * DTO, and the projections design's field allowlist keeps reasoning text, prompts, chat
 * bodies, credentials, tool arguments, and stack dumps out. An unknown key here would be
 * exactly the leak those rules exist to prevent.
 */
export interface DiagnosticDtoV1 {
  readonly diagnosticId: UUIDv7;
  readonly scope: "project" | "turn" | "preview" | "git" | "migration";
  readonly severity: "info" | "warning" | "error";
  readonly code: string;
  readonly safeMessage: string;
  readonly pageSlug?: string;
  readonly sourceHash?: Sha256Hex;
}

export const diagnosticDtoV1Schema = z.strictObject({
  diagnosticId: uuidv7Schema,
  scope: z.enum(["project", "turn", "preview", "git", "migration"]),
  severity: z.enum(["info", "warning", "error"]),
  code: z.string().min(1),
  safeMessage: z.string(),
  pageSlug: pageSlugSchema.optional(),
  sourceHash: sha256HexSchema.optional(),
});
