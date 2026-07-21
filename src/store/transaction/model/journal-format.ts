import * as errore from "errore";
import { z } from "zod";

import { FsAccessError, isNotFound } from "store/safe-fs";
import type { SafeFsError } from "store/safe-fs";

import { type TransactionFsDeps, installJsonIfAbsent } from "./engine";
import {
  JournalCorruptError,
  JournalTooNewError,
  TRANSACTIONS_LOCAL_DIR,
  TRANSACTION_JOURNAL_FORMAT_VERSION,
} from "./plan";

// turn-durability §3.1: "`format.json` has its own journal format version and is readable
// before project schema migration. A journal format newer than the binary produces
// `journal_too_new` and blocks the Workspace. An invalid or unsafe journal path produces
// `journal_corrupt`; it is never ignored or deleted automatically." (blocker finding #1)
//
// This is a SEPARATE gate from `./plan.ts`'s per-plan `journalVersion` field (`decodePlan`):
// that one classifies a SINGLE transaction's own `plan.json`, reachable only once
// `listTransactionIds` has already enumerated a transaction directory. This one classifies
// the WHOLE journal namespace before any transaction directory is even listed — so a binary
// encountering a future, structurally-incompatible `transactions.local/` layout (one that
// would not yield a readable `plan.json` at all, e.g. a renamed marker set) blocks the
// Workspace here instead of `classifyTransaction` falling through to `discard` and deleting
// the unrecognized directory (the exact failure mode the finding traced).

export const JOURNAL_FORMAT_PATH = `${TRANSACTIONS_LOCAL_DIR}/format.json`;

const journalFormatSchema = z.object({ journalVersion: z.number().int().nonnegative() });

/**
 * Read `transactions.local/format.json`. A MISSING file is `null` — treated as the implicit
 * version 1 (the only version this binary or any earlier one in this codebase has ever
 * written), never an error: §3.1 names an unreadable/unsafe/too-new file as the failure
 * cases, not the file's own absence. Malformed content is {@link JournalCorruptError}; per
 * §3.1 it "is never ignored or deleted automatically" — this function only ever reports it,
 * it never removes or repairs the file.
 */
export function readJournalFormat(
  deps: Pick<TransactionFsDeps, "safeFs">,
):
  | SafeFsError
  | JournalCorruptError
  | JournalTooNewError
  | { readonly journalVersion: number }
  | null {
  const bytes = deps.safeFs.readFile(JOURNAL_FORMAT_PATH);
  if (bytes instanceof Error) {
    if (bytes instanceof FsAccessError && isNotFound(bytes)) return null;
    return bytes;
  }

  // Boxed inside the `try` on purpose: a bare `unknown | Error` union collapses to `unknown`
  // and destroys the `instanceof Error` narrowing below (errore boundary rule).
  const parsed = errore.try({
    try: (): { readonly value: unknown } => ({
      value: JSON.parse(new TextDecoder().decode(bytes)) as unknown,
    }),
    catch: (cause) =>
      new JournalCorruptError({
        code: "FORMAT_JSON_PARSE",
        reason: `${JOURNAL_FORMAT_PATH} is not valid JSON`,
        cause,
      }),
  });
  if (parsed instanceof Error) return parsed;

  const result = journalFormatSchema.safeParse(parsed.value);
  if (!result.success)
    return new JournalCorruptError({
      code: "FORMAT_JSON_SHAPE",
      reason: `${JOURNAL_FORMAT_PATH} has an invalid shape`,
    });

  if (result.data.journalVersion > TRANSACTION_JOURNAL_FORMAT_VERSION) {
    return new JournalTooNewError({
      file: JOURNAL_FORMAT_PATH,
      found: result.data.journalVersion,
      supported: TRANSACTION_JOURNAL_FORMAT_VERSION,
    });
  }
  return result.data;
}

/**
 * Durably create `format.json` at the current shipped version, ONLY if it does not already
 * exist — create-new, like every other journal record (§3.1: "Existing records are never
 * edited in place."). Called once by project creation; a project that already has one (every
 * project this binary has ever opened) is left untouched.
 */
export function ensureJournalFormat(deps: TransactionFsDeps) {
  return installJsonIfAbsent(deps, JOURNAL_FORMAT_PATH, {
    journalVersion: TRANSACTION_JOURNAL_FORMAT_VERSION,
  });
}
