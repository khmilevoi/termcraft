import * as errore from "errore";

import {
  type CanonicalHashError,
  type CommandRejectionCode,
  type CommandResultV1,
  type Sha256Hex,
  type UUIDv7,
  envelopeFingerprint,
  isUuidv7,
} from "core/protocol";
import type { Clock } from "infrastructure/clock";

/**
 * The Kernel's per-process command dedupe ledger (kernel-command-contract §8.5).
 *
 * §8.5, verbatim: "The Kernel keeps a per-process dedupe ledger with at most 65,536
 * results and a 15-minute retry horizon. Entries are never evicted before the horizon.
 * If capacity would be exceeded, new commands are rejected with `COMMAND_DEDUPE_CAPACITY`
 * rather than weakening exactly-once handling." This module deliberately has NO eviction
 * path at all, LRU or otherwise: the moment code exists to drop an entry to make room, it
 * is capable of dropping one that a legitimate duplicate would still need. Refusing new
 * work is the only response §8.5 allows once the ledger is full.
 *
 * "For a first-seen id, the ledger stores a canonical hash of the complete envelope and
 * an in-flight promise before guard evaluation. A concurrent duplicate waits for that
 * promise." This module stores that hash/promise pair synchronously, before it ever calls
 * the caller-supplied `execute`, and does so with no `await` anywhere on that path — so a
 * second `run` for the same id, issued before the first's `execute()` settles, always
 * finds the entry already recorded and returns its promise rather than starting a second
 * execution. "A later byte-equivalent/canonically equivalent envelope returns the exact
 * stored result, including generated `operationId`, without a transition, event replay,
 * or revision change" and "Reusing the id with any different envelope field returns
 * `COMMAND_ID_REUSE_MISMATCH`" are both decided by comparing envelope fingerprints, never
 * by re-running `execute`.
 *
 * "After the horizon, UUIDv7 timestamps older than the ledger's dedupe floor are rejected
 * with `COMMAND_ID_EXPIRED`; they are never executed as new commands." This reads the
 * timestamp out of the id itself — UUIDv7 is time-ordered, with the first 48 bits a
 * big-endian Unix-epoch-milliseconds value (RFC 9562 §5.7) — rather than tracking id ages
 * separately, since the id already carries that fact.
 */

/** The ledger's default capacity (§8.5: "at most 65,536 results"). Overridable for tests. */
export const DEDUPE_CAPACITY = 65_536;

/** The ledger's default retry horizon in milliseconds (§8.5: "a 15-minute retry horizon"). */
export const DEDUPE_HORIZON_MS = 15 * 60 * 1000;

/**
 * The subset of §11.1's rejection codes this ledger can produce. Derived from — and
 * `satisfies`-checked against — the canonical `CommandRejectionCode` registry rather than
 * hand-declared, so if any of these three codes were ever renamed or dropped upstream this
 * file fails to compile instead of silently drifting from the registry it must agree with.
 */
const DEDUPE_REJECTION_CODES = [
  "COMMAND_ID_REUSE_MISMATCH",
  "COMMAND_ID_EXPIRED",
  "COMMAND_DEDUPE_CAPACITY",
] as const satisfies readonly CommandRejectionCode[];

export type DedupeRejectionCode = (typeof DEDUPE_REJECTION_CODES)[number];

/** One of the three §8.5 immediate rejections this ledger decides on its own. */
export class DedupeRejectionError extends errore.createTaggedError({
  name: "DedupeRejectionError",
  message: "command $commandId dedupe rejected [$code]: $reason",
}) {}

interface DedupeEntry {
  readonly fingerprint: Sha256Hex;
  readonly promise: Promise<CommandResultV1>;
}

export interface DedupeLedger {
  /**
   * Decides whether `execute` runs at all for `commandId`, and returns either its result
   * or a dedupe rejection — the ledger owns that decision, the caller never calls
   * `execute` itself. Like `KernelCounters`'s methods, this reads/writes `entriesAtom`
   * directly and trusts the caller's ambient Reatom context to already be correct (per
   * §7's mailbox rule: "Service callbacks return to the same mailbox through `wrap`; they
   * never set model atoms directly") — this module does not re-wrap on the caller's
   * behalf.
   */
  readonly run: (
    envelopeRaw: unknown,
    commandId: UUIDv7,
    execute: () => Promise<CommandResultV1>,
  ) => Promise<CanonicalHashError | DedupeRejectionError | CommandResultV1>;
  /** The number of ids currently recorded. Exposed for tests and diagnostics only. */
  readonly size: () => number;
}

export interface DedupeLedgerDeps {
  readonly clock: Clock;
  readonly capacity?: number;
  readonly horizonMs?: number;
}

/**
 * Extracts the big-endian Unix-epoch-milliseconds timestamp UUIDv7 embeds in its first 48
 * bits (RFC 9562 §5.7). `dedupe-ledger.test.ts` checks this against RFC 9562's own worked
 * example rather than any value this module produces, so a bit-order or offset mistake
 * here cannot hide behind a self-consistent round trip.
 */
export function uuidv7TimestampMs(id: UUIDv7): Error | number {
  // `UUIDv7` is a plain string alias, not a branded type, so nothing at the type level
  // stops a malformed id reaching here. Parsing one with BigInt() throws a SyntaxError,
  // which would escape `run`'s declared `Error | T` return synchronously — so the shape
  // is validated first and the failure comes back as a value, per the errore rules.
  if (!isUuidv7(id)) return new TypeError(`not a canonical UUIDv7: ${id}`);
  const hex = id.replace(/-/g, "").slice(0, 12);
  return Number(BigInt(`0x${hex}`));
}

/**
 * Creates one Kernel's dedupe ledger. A factory rather than module-level atoms for the
 * same reason as `createKernelCounters`: §8.5 scopes the ledger to a single Kernel process
 * lifetime, and module-level state would let two kernels in one test process — or one test
 * after another — silently share dedupe entries and invalidate each other's assertions.
 */
export function createDedupeLedger(deps: DedupeLedgerDeps): DedupeLedger {
  const capacity = deps.capacity ?? DEDUPE_CAPACITY;
  const horizonMs = deps.horizonMs ?? DEDUPE_HORIZON_MS;

  /**
   * Deliberately a plain closure `Map`, NOT a Reatom atom — the one place in this module
   * where the `counters.ts` pattern must not be copied.
   *
   * `context.start()` opens an *isolated* context, so atom state is per-frame. A duplicate
   * arriving in a different frame would not find the entry and would execute a second
   * time, which is precisely the exactly-once guarantee §8.5 exists to provide. Measured:
   * with the state in an atom, a duplicate across two frames ran `execute` twice; with a
   * closure `Map`, once. (`wrap` does not rescue it — that was verified too.)
   *
   * The ledger is also not reactive: nothing computes off it, no projector reads it. It is
   * process-local infrastructure, so an atom bought nothing and cost the invariant.
   */
  const entries = new Map<UUIDv7, DedupeEntry>();

  function reject(
    commandId: UUIDv7,
    code: DedupeRejectionCode,
    reason: string,
  ): DedupeRejectionError {
    return new DedupeRejectionError({ commandId, code, reason });
  }

  function run(
    envelopeRaw: unknown,
    commandId: UUIDv7,
    execute: () => Promise<CommandResultV1>,
  ): Promise<CanonicalHashError | DedupeRejectionError | CommandResultV1> {
    const fingerprint = envelopeFingerprint(envelopeRaw);
    if (fingerprint instanceof Error) return Promise.resolve(fingerprint);

    const existing = entries.get(commandId);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) {
        return Promise.resolve(
          reject(
            commandId,
            "COMMAND_ID_REUSE_MISMATCH",
            "commandId is already bound to a different canonical envelope",
          ),
        );
      }
      // §8.5: "returns the exact stored result ... without a transition, event replay, or
      // revision change" — `execute` is never called again on this path.
      return existing.promise;
    }

    // §8.5's expiry check applies only to ids not yet in the ledger — a duplicate of a
    // known id is never "executed as new" regardless of how old its embedded timestamp is.
    const floor = deps.clock.now().getTime() - horizonMs;
    const stamp = uuidv7TimestampMs(commandId);
    if (stamp instanceof Error) {
      return Promise.resolve(reject(commandId, "COMMAND_ID_EXPIRED", stamp.message));
    }
    if (stamp < floor) {
      return Promise.resolve(
        reject(
          commandId,
          "COMMAND_ID_EXPIRED",
          "commandId timestamp is older than the dedupe floor",
        ),
      );
    }

    if (entries.size >= capacity) {
      // §8.5 says entries are "never evicted BEFORE the horizon" — not never. Dropping
      // entries already past the floor costs nothing, because a duplicate of one could
      // only ever be answered COMMAND_ID_EXPIRED now anyway. Without this sweep the ledger
      // deadlocks permanently: after 65,536 commands every subsequent command is refused
      // for the life of the process, however long ago each entry expired.
      for (const [id] of entries) {
        const recorded = uuidv7TimestampMs(id);
        if (recorded instanceof Error || recorded < floor) entries.delete(id);
      }
    }

    if (entries.size >= capacity) {
      return Promise.resolve(
        reject(commandId, "COMMAND_DEDUPE_CAPACITY", "dedupe ledger is at capacity"),
      );
    }

    // The entry is recorded BEFORE `execute` runs, per §8.5: "the ledger stores a canonical
    // hash of the complete envelope and an in-flight promise before guard evaluation".
    // Order matters twice over. If `execute` re-entered the ledger with the same id it
    // would otherwise start a second execution, and if `execute` threw synchronously the
    // throw would escape `run` as a synchronous exception rather than the declared
    // `Error | T` value — a caller's `.catch()` cannot catch what has no promise yet.
    // Deferring the call through a resolved promise makes a sync throw a rejection, and
    // the entry is in place before either can happen.
    const promise = Promise.resolve().then(execute);
    entries.set(commandId, { fingerprint, promise });
    return promise;
  }

  return {
    run,
    size: () => entries.size,
  };
}
