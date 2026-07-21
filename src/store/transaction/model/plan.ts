import * as errore from "errore";
import { z } from "zod";

import { rfc3339UtcSchema } from "infrastructure/clock";
import { canonicalUuidv7Schema } from "infrastructure/uuid";
import { sha256Hex } from "store/jsonl";
import {
  NAMESPACE_LIMITS,
  StorageLimitExceededError,
  classifyNamespace,
  validateRelativePath,
} from "store/safe-fs";

import type { Sha256Hex, TransactionOperation, TransactionPlan } from "../types";

/** The only shipped transaction journal format version (turn-durability §3.1, §3.3). */
export const TRANSACTION_JOURNAL_FORMAT_VERSION = 1;

/**
 * The journal namespace root (turn-durability §3.1). Declared here rather than in `engine.ts`
 * because the plan schema below must refuse it as an operation target, and `engine.ts` already
 * imports this module — putting it the other way round would close an import cycle.
 */
export const TRANSACTIONS_LOCAL_DIR = "transactions.local";

/**
 * A transaction may never name the transaction journal itself as a mutation target.
 *
 * The §5.1 grammar check alone admits `transactions.local/...` — it is a perfectly legal
 * managed relative path, and `classifyNamespace` even gives it its own `transaction-payload`
 * namespace. But turn-durability §4.6's guarantee that recovery "classifies before touching a
 * target" holds only while targets and journals are DISJOINT: recovery classifies each journal
 * directory by reading `plan.json`/`intent.json`/`committed.json`, so an operation allowed to
 * write inside `transactions.local/` could forge a `committed.json` for a sibling transaction
 * the scan has not classified yet, making it skip a real roll-forward. Since `decodePlan`
 * parses plans read back OFF DISK during recovery, this is a hostile-input boundary, not just
 * an internal-caller assertion.
 */
function targetsJournal(relPath: string): boolean {
  return relPath === TRANSACTIONS_LOCAL_DIR || relPath.startsWith(`${TRANSACTIONS_LOCAL_DIR}/`);
}

/**
 * A journal record is unreadable: not JSON, a shape/reference violation, an illegal path, a
 * missing payload, or a payload whose bytes disagree with its declared hash (turn-durability
 * §4.6: "Stop with journal_corrupt; write nothing"). `code` names which check fired, so the
 * hostile test matrix can assert *which* rejection happened, not merely that one did.
 */
export class JournalCorruptError extends errore.createTaggedError({
  name: "JournalCorruptError",
  message: "transaction journal corrupt [$code]: $reason",
}) {}

/**
 * A journal record declares a `journalVersion` newer than this binary supports
 * (turn-durability §3.1: "A journal format newer than the binary produces
 * `journal_too_new` and blocks the Workspace"). Kept distinct from {@link JournalCorruptError}
 * because the file is not malformed — it is simply from the future.
 */
export class JournalTooNewError extends errore.createTaggedError({
  name: "JournalTooNewError",
  message: "$file has journalVersion $found, newer than the supported version $supported",
}) {}

// ---- canonical JSON (turn-durability §3.3) -------------------------------------

/** Recursively sort object keys; arrays keep their order — only key order is canonicalized. */
function canonicalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeValue);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted = Object.keys(record).sort();
    const out: Record<string, unknown> = {};
    for (const key of sorted) out[key] = canonicalizeValue(record[key]);
    return out;
  }
  return value;
}

/**
 * Canonical UTF-8 JSON with sorted object keys (turn-durability §3.3): the exact byte form
 * every journal marker is written as, and the exact bytes {@link computePlanHash} digests.
 * Applied to every journal record (not only `plan.json`), so every marker is deterministic —
 * a superset of the letter of §3.3, applied consistently rather than only where it is named.
 */
export function encodeCanonicalJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(canonicalizeValue(value)));
}

/** The plan's SHA-256 digest over its canonical JSON bytes — stored in every later marker (§3.3). */
export function computePlanHash(plan: TransactionPlan): Sha256Hex {
  return sha256Hex(encodeCanonicalJson(plan));
}

// ---- schemas ---------------------------------------------------------------------

// Exported so `engine.ts` (same submodule) can reuse them for the journal's other markers
// (intent/applied/committed/conflict) instead of re-declaring the same shapes twice.
export const sha256HexSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, { error: "must be a lowercase-hex SHA-256 digest" });

export const fileImageSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("absent") }),
  z.strictObject({
    state: z.literal("file"),
    sha256: sha256HexSchema,
    size: z.number().int().nonnegative(),
  }),
]);

/**
 * Mirrors `store/jsonl`'s `PreparedAppend` shape locally, following this codebase's own
 * convention of re-declaring a shared shape's validation inside each consuming module
 * (e.g. `store/trust`'s `gitIdentitySchema`) rather than importing a cross-module schema.
 */
const preparedAppendSchema = z.object({
  beforeLength: z.number().int().nonnegative(),
  beforePrefixSha256: sha256HexSchema,
  appendedPayloadId: canonicalUuidv7Schema,
  appendedSha256: sha256HexSchema,
  appendedLength: z.number().int().positive(),
  recordIds: z.array(canonicalUuidv7Schema).min(1),
  domainIdentity: z.string().min(1).optional(),
});

const TRANSACTION_KINDS = [
  "turn",
  "restore",
  "export-publish",
  "migration",
  "project-mutation",
] as const;

const transactionOperationSchema = z
  .object({
    index: z.number().int().nonnegative(),
    target: z
      .string()
      .refine((value) => !(validateRelativePath(value) instanceof Error), {
        error: "target is not a legal managed relative path",
      })
      .refine((value) => !targetsJournal(value), {
        error: "target may not name the transaction journal",
      }),
    mode: z.enum(["replace", "delete", "append-jsonl"]),
    oldImage: fileImageSchema,
    newImage: fileImageSchema,
    payloadId: canonicalUuidv7Schema.optional(),
    append: preparedAppendSchema.optional(),
    releaseAfterApplied: z.boolean().optional(),
  })
  .superRefine((op, ctx) => {
    if (op.mode === "replace") {
      if (op.payloadId === undefined)
        ctx.addIssue({ code: "custom", message: "a replace operation requires payloadId" });
      if (op.append !== undefined)
        ctx.addIssue({ code: "custom", message: "a replace operation may not carry append" });
      if (op.newImage.state !== "file")
        ctx.addIssue({ code: "custom", message: "a replace operation's newImage must be a file" });
      return;
    }
    if (op.mode === "delete") {
      if (op.payloadId !== undefined)
        ctx.addIssue({ code: "custom", message: "a delete operation may not carry payloadId" });
      if (op.append !== undefined)
        ctx.addIssue({ code: "custom", message: "a delete operation may not carry append" });
      if (op.newImage.state !== "absent")
        ctx.addIssue({ code: "custom", message: "a delete operation's newImage must be absent" });
      return;
    }
    // append-jsonl
    if (op.payloadId !== undefined)
      ctx.addIssue({
        code: "custom",
        message: "an append-jsonl operation may not carry payloadId",
      });
    if (op.append === undefined) {
      ctx.addIssue({ code: "custom", message: "an append-jsonl operation requires append" });
      return;
    }
    if (op.newImage.state !== "file")
      ctx.addIssue({
        code: "custom",
        message: "an append-jsonl operation's newImage must be a file",
      });
    // oldImage and append.beforeLength/beforePrefixSha256 name the SAME pre-append fact twice
    // (turn-durability §3.3/§4.4); a plan where they disagree is corrupt, not merely unusual.
    const consistent =
      op.append.beforeLength === 0
        ? op.oldImage.state === "absent"
        : op.oldImage.state === "file" &&
          op.oldImage.size === op.append.beforeLength &&
          op.oldImage.sha256 === op.append.beforePrefixSha256;
    if (!consistent)
      ctx.addIssue({
        code: "custom",
        message: "oldImage disagrees with append.beforeLength/beforePrefixSha256",
      });
  });

const transactionPlanSchema = z
  .object({
    journalVersion: z.literal(TRANSACTION_JOURNAL_FORMAT_VERSION),
    transactionId: canonicalUuidv7Schema,
    kind: z.enum(TRANSACTION_KINDS),
    domain: z.record(z.string(), z.unknown()),
    operations: z.array(transactionOperationSchema),
    createdAt: rfc3339UtcSchema,
  })
  .superRefine((plan, ctx) => {
    const seen = new Set<number>();
    for (const op of plan.operations) {
      if (seen.has(op.index))
        ctx.addIssue({ code: "custom", message: `duplicate operation index ${op.index}` });
      seen.add(op.index);
    }
  });

/** Maps the first Zod issue onto a {@link JournalCorruptError}, mirroring every other decoder in this codebase. */
function toJournalCorruptError(error: z.ZodError): JournalCorruptError {
  const issue = error.issues[0];
  const code = issue !== undefined && issue.path.length > 0 ? issue.path.join(".") : "SHAPE";
  return new JournalCorruptError({ code, reason: issue?.message ?? "invalid input" });
}

/**
 * `journalVersion` read WITHOUT the field schema, mirroring `store/toml`'s `format_version`
 * gate — a newer journal is classified as too-new rather than as a shape violation.
 */
function readJournalVersion(value: unknown): number | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const found = (value as Record<string, unknown>).journalVersion;
  if (typeof found !== "number" || !Number.isInteger(found)) return null;
  return found;
}

/**
 * Parse and validate `plan.json` (turn-durability §3.3, §4.6). The order is deliberate: JSON
 * parse, then the `journalVersion` gate (a newer plan is {@link JournalTooNewError}, never a
 * shape complaint), then the strict operation/plan schema.
 */
export function decodePlan(
  bytes: Uint8Array,
  file = "plan.json",
): JournalCorruptError | JournalTooNewError | TransactionPlan {
  // Boxed inside the `try` on purpose: a bare `unknown | Error` union collapses to `unknown`
  // and destroys the `instanceof Error` narrowing below (errore boundary rule).
  const parsed = errore.try({
    try: (): { value: unknown } => ({
      value: JSON.parse(new TextDecoder().decode(bytes)) as unknown,
    }),
    catch: (cause) =>
      new JournalCorruptError({ code: "JSON_PARSE", reason: `${file} is not valid JSON`, cause }),
  });
  if (parsed instanceof Error) return parsed;
  const value = parsed.value;

  const version = readJournalVersion(value);
  if (version === null)
    return new JournalCorruptError({
      code: "journalVersion",
      reason: "missing or non-integer journalVersion",
    });
  if (version > TRANSACTION_JOURNAL_FORMAT_VERSION) {
    return new JournalTooNewError({
      file,
      found: version,
      supported: TRANSACTION_JOURNAL_FORMAT_VERSION,
    });
  }

  const result = transactionPlanSchema.safeParse(value);
  if (!result.success) return toJournalCorruptError(result.error);
  return result.data;
}

/**
 * turn-durability §5.3: "An action that would exceed a limit fails before intent." The
 * transaction engine only ever mutates the project's own `.termcraft` tree — every wrapper
 * (turn/restore/export/migration/project-mutation) targets a project-root-relative path — so
 * classification is always against the `"project"` root kind. A target the plan schema's own
 * `validateRelativePath` refine already let through but that classifies as
 * {@link UnknownNamespaceError} here is left to whatever later check owns that rejection;
 * this gate only ever tightens an already-legal target, never a new rejection surface.
 */
function checkOperationSizeLimit(op: TransactionOperation): StorageLimitExceededError | null {
  if (op.newImage.state !== "file") return null;
  const namespace = classifyNamespace("project", op.target);
  if (namespace instanceof Error) return null;
  const allowed = NAMESPACE_LIMITS[namespace].perFileBytes;
  if (op.newImage.size <= allowed) return null;
  return new StorageLimitExceededError({
    limit: `${namespace} per-file`,
    path: op.target,
    measured: op.newImage.size,
    allowed,
  });
}

/**
 * Verify every operation's payload reference resolves and matches its declared hash/length,
 * and that no operation's resulting file would exceed its namespace's §5.3 per-file limit —
 * BOTH BEFORE any target is touched (turn-durability §4.3 step 3 / §4.6: "missing payload, or
 * payload hash mismatch" → `journal_corrupt`; §5.3: a would-exceed action "fails before
 * intent"). Pure — the payload bytes are supplied by the caller, who already wrote them
 * durably in a prior step.
 */
export function validatePlanPayloads(
  plan: TransactionPlan,
  payloads: ReadonlyMap<string, Uint8Array>,
): JournalCorruptError | StorageLimitExceededError | null {
  for (const op of plan.operations) {
    const oversized = checkOperationSizeLimit(op);
    if (oversized instanceof Error) return oversized;

    if (op.mode === "replace") {
      if (op.payloadId === undefined || op.newImage.state !== "file") continue; // schema already excludes this
      const bytes = payloads.get(op.payloadId);
      if (bytes === undefined) {
        return new JournalCorruptError({
          code: "PAYLOAD_MISSING",
          reason: `operation ${op.index} names payload ${op.payloadId}, which was not prepared`,
        });
      }
      if (bytes.byteLength !== op.newImage.size || sha256Hex(bytes) !== op.newImage.sha256) {
        return new JournalCorruptError({
          code: "PAYLOAD_HASH_MISMATCH",
          reason: `operation ${op.index}'s payload does not match its declared newImage`,
        });
      }
    }
    if (op.mode === "append-jsonl" && op.append !== undefined) {
      const bytes = payloads.get(op.append.appendedPayloadId);
      if (bytes === undefined) {
        return new JournalCorruptError({
          code: "PAYLOAD_MISSING",
          reason: `operation ${op.index} names append payload ${op.append.appendedPayloadId}, which was not prepared`,
        });
      }
      if (
        bytes.byteLength !== op.append.appendedLength ||
        sha256Hex(bytes) !== op.append.appendedSha256
      ) {
        return new JournalCorruptError({
          code: "PAYLOAD_HASH_MISMATCH",
          reason: `operation ${op.index}'s append payload does not match its declared hash/length`,
        });
      }
    }
  }
  return null;
}
