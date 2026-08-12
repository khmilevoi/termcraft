import { z } from "zod";

/**
 * The closed v1 operational-failure code registry (kernel-command-contract §11.2),
 * transcribed verbatim from the table's "Code" column in table order — rows listing
 * several comma-separated codes expand to one entry each, still in left-to-right order —
 * PLUS one code from a later spec, `DESIGN_SYSTEM_REJECTED` (project-design-systems §8.3/§12,
 * appended last, see its own entry below for why this registry is no longer §11.2-only). Its
 * length is asserted at 31 by the closure test so a member cannot be silently added or dropped.
 */
export const OPERATIONAL_FAILURE_CODES_V1 = [
  "BACKEND_UNAVAILABLE",
  "BACKEND_FAILED",
  "TURN_DEADLINE_EXCEEDED",
  "GATE_RETRY_EXHAUSTED",
  "APPLY_SOURCE_CHANGED",
  "APPLY_STALE",
  "STALE_BACKEND_EVENT_DROPPED",
  "TRANSACTION_RECOVERY_CONFLICT",
  "RESTORE_SOURCE_CHANGED",
  "RESTORE_OBJECT_MISSING",
  "RESTORE_GATE_FAILED",
  "RESTORE_RECORD_PENDING",
  "COMMIT_PLAN_STALE",
  "GIT_IDENTITY_MISSING",
  "GIT_HOOK_FAILED",
  "GIT_SIGNING_FAILED",
  "GIT_INDEX_BUSY",
  "GIT_COMMAND_FAILED",
  "EXPORT_SNAPSHOT_STALE",
  "EXPORT_RENDER_FAILED",
  "EXPORT_PUBLICATION_FAILED",
  "MIGRATION_BACKUP_FAILED",
  "MIGRATION_STALE",
  "MIGRATION_TRANSFORM_FAILED",
  "MIGRATION_PUBLICATION_FAILED",
  "HOST_START_FAILED",
  "HOST_PROTOCOL_FAILED",
  "HOST_CIRCUIT_OPEN",
  "PERSISTENCE_FAILED",
  "RESOURCE_LIMIT_EXCEEDED",
  // project-design-systems §8.3/§12, decision D6: the Gate refused the CANDIDATE ITSELF — a §7
  // fatal inside `system/`, or a whole-tree fatal with no file attribution. Deliberately distinct
  // from a package the Gate accepted that BREAKS PAGES: that is not a failure at all, it is a
  // preview the designer confirms (§8.3, §12 — "surfaced before commit; not prevented"). Appended
  // here (ahead of kernel-command-contract §11.2's own table, which this code is not part of)
  // because `core/design-systems/model/install.ts`'s `commitDesignSystemInstall` needs it to
  // type-check its own `FailureDtoV1` return; see that module's own header for the pipeline this
  // closes.
  "DESIGN_SYSTEM_REJECTED",
] as const;

export type OperationalFailureCode = (typeof OPERATIONAL_FAILURE_CODES_V1)[number];

/** The exact member count §11.2 fixes, PLUS `DESIGN_SYSTEM_REJECTED` (see its own entry above). A drifted union fails the closure test, not a review. */
export const OPERATIONAL_FAILURE_CODE_COUNT = 31;

const OPERATIONAL_FAILURE_CODE_SET: ReadonlySet<string> = new Set(OPERATIONAL_FAILURE_CODES_V1);

/** True when `raw` names a v1 operational-failure code. */
export function isOperationalFailureCode(raw: string): raw is OperationalFailureCode {
  return OPERATIONAL_FAILURE_CODE_SET.has(raw);
}

/** Zod schema over the closed union. */
export const operationalFailureCodeSchema = z.enum(OPERATIONAL_FAILURE_CODES_V1);

/**
 * The bound on `FailureDtoV1.details` (this module's own encoding — §11.2 says only
 * "bounded details", it does not fix a key count or value size). 16 keys is generous for
 * a diagnostic payload (e.g. `part`, `exitCode`, `host`, `signal`) while still being a
 * closed, reviewable ceiling rather than an unbounded bag a stray loop could fill.
 */
export const FAILURE_DETAILS_MAX_KEYS = 16;
/** Exported so its boundary is a test fixture, not a number re-typed by hand in a test. */
export const FAILURE_DETAIL_KEY_MAX_LENGTH = 64;
/** Exported so its boundary is a test fixture, not a number re-typed by hand in a test. */
export const FAILURE_DETAIL_STRING_VALUE_MAX_LENGTH = 500;

/**
 * A single detail value: a JSON primitive, never an object, array, `Error`, or other
 * class instance. This is what makes `details` "bounded" rather than an arbitrary
 * `Record<string, unknown>` — §11.2: "Native `Error` objects and unbounded
 * stdout/stderr never cross the event DTO." An object literal or an `Error` instance is
 * neither `string | number | boolean | null`, so it fails this union, not a nested check.
 */
const failureDetailValueSchema = z.union([
  z.string().max(FAILURE_DETAIL_STRING_VALUE_MAX_LENGTH),
  z.number(),
  z.boolean(),
  z.null(),
]);

/**
 * `FailureDtoV1.details` (my bounded encoding of "bounded details"): a record of
 * primitive values, capped at {@link FAILURE_DETAILS_MAX_KEYS} keys so a failure can
 * carry a few typed facts (`part`, `scope`, `exitCode`, …) without becoming an
 * unbounded catch-all for arbitrary diagnostic data.
 */
export const failureDetailsV1Schema = z
  .record(z.string().min(1).max(FAILURE_DETAIL_KEY_MAX_LENGTH), failureDetailValueSchema)
  .refine((details) => Object.keys(details).length <= FAILURE_DETAILS_MAX_KEYS, {
    message: `expected at most ${FAILURE_DETAILS_MAX_KEYS} detail keys`,
  });

/**
 * A terminal operation failure (§11.2): "Terminal operation events include a typed
 * failure object with code, retryability, bounded details, and a safe display message."
 * `code`/`retryable`/`safeMessage` are spec-verbatim; `details`'s primitive-record shape
 * is this module's bounded encoding of "bounded details" (see {@link failureDetailsV1Schema}) —
 * except for the two codes §11.2 itself fixes a typed detail for, `APPLY_SOURCE_CHANGED`
 * and `APPLY_STALE` (see {@link failureDtoV1Schema}). `FailureDtoV1` stays the general
 * shape covering both those variants and the other 28 codes' unconstrained bounded
 * record; narrowing it to a full discriminated type would ripple into every
 * `event-payload.ts` DTO that carries a `FailureDtoV1` for no gain this slice needs.
 */
export interface FailureDtoV1 {
  readonly code: OperationalFailureCode;
  readonly retryable: boolean;
  readonly safeMessage: string;
  readonly details: Readonly<Record<string, string | number | boolean | null>>;
}

/**
 * §11.2 fixes a typed `part` for exactly two codes, not merely "bounded details" like the
 * other 28: "`APPLY_SOURCE_CHANGED` … details include `part: "page" | "manifest"`" and
 * "`APPLY_STALE` … details carry typed `part: "chat" | "pins"`." The two vocabularies are
 * disjoint — a page/manifest drift and a chat/pins drift are different failures — so each
 * gets its own closed enum layered on top of the general bounded-details record, refined
 * to require `part` be one of that code's two values.
 */
const applySourceChangedDetailsSchema = failureDetailsV1Schema.refine(
  (details) => details.part === "page" || details.part === "manifest",
  { message: 'APPLY_SOURCE_CHANGED details.part must be "page" or "manifest"' },
);
const applyStaleDetailsSchema = failureDetailsV1Schema.refine(
  (details) => details.part === "chat" || details.part === "pins",
  { message: 'APPLY_STALE details.part must be "chat" or "pins"' },
);

const applySourceChangedFailureSchema = z.strictObject({
  code: z.literal("APPLY_SOURCE_CHANGED"),
  retryable: z.boolean(),
  safeMessage: z.string(),
  details: applySourceChangedDetailsSchema,
});
const applyStaleFailureSchema = z.strictObject({
  code: z.literal("APPLY_STALE"),
  retryable: z.boolean(),
  safeMessage: z.string(),
  details: applyStaleDetailsSchema,
});

/** The 28 codes §11.2 does not fix a typed detail for — kept on the general bounded record. */
const GENERAL_OPERATIONAL_FAILURE_CODES_V1 = OPERATIONAL_FAILURE_CODES_V1.filter(
  (code): code is Exclude<OperationalFailureCode, "APPLY_SOURCE_CHANGED" | "APPLY_STALE"> =>
    code !== "APPLY_SOURCE_CHANGED" && code !== "APPLY_STALE",
) as [
  Exclude<OperationalFailureCode, "APPLY_SOURCE_CHANGED" | "APPLY_STALE">,
  ...Exclude<OperationalFailureCode, "APPLY_SOURCE_CHANGED" | "APPLY_STALE">[],
];

const generalOperationalFailureSchema = z.strictObject({
  code: z.enum(GENERAL_OPERATIONAL_FAILURE_CODES_V1),
  retryable: z.boolean(),
  safeMessage: z.string(),
  details: failureDetailsV1Schema,
});

export const failureDtoV1Schema = z.discriminatedUnion("code", [
  applySourceChangedFailureSchema,
  applyStaleFailureSchema,
  generalOperationalFailureSchema,
]);
