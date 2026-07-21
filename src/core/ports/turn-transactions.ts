import type { FailureDtoV1, Sha256Hex } from "core/protocol"
import type { ChatAgentRecord, ChatSystemCancelledRecord, ChatSystemErrorRecord, ChatUserRecord } from "entities/chat"
import type { PageSlug } from "entities/page"
import type { PinStatusEvent } from "entities/pin"

/**
 * `TurnTransactionService`: the three durable turn-transaction phases turn-durability §6-§7
 * name — admission (§6.1 invariant 9, §7.2 step 3), finalization (§7.4-§7.5), and
 * terminalization (§7.6-§7.7) — narrowed from `store/transaction`'s real
 * `admitTurn`/`finalizeTurn`/`terminalizeTurn` wrappers per decision C1: every shape below
 * is a core-owned redraw over `entities/` + local DTOs, never an import of
 * `store/transaction`'s `TurnAdmissionInput`/`TurnFinalizeInput`/`TurnTerminalizeInput`/
 * `TurnReadSet`/`FileImage` types themselves.
 *
 * MUTEX/PERMIT ARE ABSENT FROM EVERY METHOD HERE (matching `store/index.ts`'s own
 * documented divergence note 1: "a caller never sees `ProjectWritePermit` at all" for this
 * exact engine) — `store`'s real `TransactionEngine` already acquires and releases its own
 * `WriteMutex` permit internally around each call. A caller that separately needs a SHORT
 * permit outside a turn (Export's snapshot, per blocker B2) uses `project-write.ts`'s
 * `ProjectWriteCoordinator` instead, which is exposed precisely because it is the SAME
 * mutex instance this service uses — never a second one (B2: "Creating a second mutex
 * silently breaks single-writer exclusion and is forbidden").
 *
 * THE READ-SET PORT (decision C6): `TurnReadSetV1` below is the FINALIZATION-TIME shape —
 * `FileImage`/`AppendBase`-keyed, matching `store/transaction`'s own `TurnReadSet` (soon to
 * be the only type still named that on the store side). The STAGING-TIME shape captured at
 * admission is a structurally different record (`store/sandbox`'s `TurnReadSet`, renamed
 * `StagedTurnReadSet` in this same slice per C6 to stop two same-named types reaching
 * `store`'s public surface) — see `staging.ts`'s `StagedTurnReadSetV1`. The 1:1 translation
 * between the two is `core/turns/model/read-set.ts`, a named core deliverable OUTSIDE this
 * ports file (C6) — this file only fixes the finalize-side shape the translation must
 * produce.
 */

/** Mirrors `store/transaction`'s `FileImage` (turn-durability §3.3 invariant 2), redrawn per C1. */
export type FileImageV1 = { readonly state: "absent" } | { readonly state: "file"; readonly sha256: Sha256Hex; readonly size: number }

/** Mirrors `store/jsonl`'s `AppendBase` (an exact valid-prefix length + hash), redrawn per C1. */
export interface AppendBaseV1 {
  readonly length: number
  readonly prefixSha256: Sha256Hex
}

/**
 * The full send-time read set turn-durability §7.5 re-checks immediately before intent:
 * `project.toml`'s image, every canonical page exposed to the agent (including
 * expected-absent entries for a potential new target), the captured chat's append base, and
 * every contributing comments log's append base.
 */
export interface TurnReadSetV1 {
  readonly manifest: FileImageV1
  readonly canonicalPages: ReadonlyMap<PageSlug, FileImageV1>
  readonly chat: AppendBaseV1
  readonly pins: ReadonlyMap<PageSlug, AppendBaseV1>
}

/** A committed transaction's receipt — an opaque id for tracing/diagnostics, never a value the caller branches on. */
export interface TurnCommitV1 {
  readonly transactionId: string
}

// ---- admission (§6.1 invariant 9, §7.2 step 3) -------------------------------------------

export interface TurnAdmissionInputV1 {
  readonly turnId: string
  readonly targetChatId: string
  /** Fully built by the caller — text/selection/pins/`ts` are domain decisions this port never makes. */
  readonly userRecord: ChatUserRecord
  readonly createdAt: string
}

// ---- finalization (§7.4, §7.5) ------------------------------------------------------------

export interface ChangedPageOpV1 {
  readonly pageSlug: PageSlug
  readonly change: "replace" | "delete"
  /** Required when `change === "replace"` — the page's complete new bytes. */
  readonly newBytes?: Uint8Array
}

export interface ResolvedPinAppendV1 {
  readonly pageSlug: PageSlug
  /** Fully built by the caller: `status: "resolved"`, `turnId` set, `actionId` absent. */
  readonly event: PinStatusEvent
}

export interface TurnFinalizeInputV1 {
  readonly turnId: string
  readonly targetChatId: string
  /** Gate-validated diff; empty means no canonical page changed. */
  readonly changedPages: readonly ChangedPageOpV1[]
  /** The validated `pages.json` ordered slug array (turn-durability §7.4 item 2). */
  readonly validatedPageSlugs: readonly PageSlug[]
  /** Present only when the candidate explicitly requests a different active page (§7.4 item 3). */
  readonly requestedActivePage?: PageSlug | null
  /** Fully built by the caller: `changedPages`/`warnings`/`text` are Gate/agent outcomes this port never computes. */
  readonly agentRecord: ChatAgentRecord
  /** Every sent pin resolved by this turn — the adapter filters this down to `changedPages` internally (§7.4 item 5: "an empty diff resolves no pin"). */
  readonly resolvedPins: readonly ResolvedPinAppendV1[]
  readonly readSet: TurnReadSetV1
  readonly createdAt: string
}

// ---- terminalization (§7.6, §7.7) ---------------------------------------------------------

export type TurnTerminalRecordV1 = ChatSystemErrorRecord | ChatSystemCancelledRecord

export interface TurnTerminalizeInputV1 {
  readonly turnId: string
  readonly targetChatId: string
  /** Fully built by the caller: `system:error` (outcome `error`/`stale`/`interrupted`) or `system:cancelled`, with `turnId` set. */
  readonly record: TurnTerminalRecordV1
  readonly createdAt: string
}

export interface TurnTransactionService {
  /** Append exactly the user record to `targetChatId`, committed BEFORE any agent process starts (invariant 9, §7.2 step 3). */
  admit(input: TurnAdmissionInputV1): Promise<FailureDtoV1 | TurnCommitV1>
  /**
   * Changed canonical pages -> derived manifest -> optional active-page effect -> one agent
   * record -> filtered pin resolutions, all inside one transaction whose precondition is the
   * full send-time CAS against `readSet` (§7.4, §7.5). `FailureDtoV1.code` surfaces
   * `APPLY_SOURCE_CHANGED` (`details.part: "page" | "manifest"`) or `APPLY_STALE`
   * (`details.part: "chat" | "pins"`) on a CAS mismatch — kernel-command-contract §11.2's
   * two typed-detail codes, never a generic write failure for these two cases.
   */
  finalize(input: TurnFinalizeInputV1): Promise<FailureDtoV1 | TurnCommitV1>
  /** Appends exactly one terminal system record; never touches pages, manifest, or pins (§7.6). Idempotent per `turnId` (§7.7: "terminalizes exactly once"). */
  terminalize(input: TurnTerminalizeInputV1): Promise<FailureDtoV1 | TurnCommitV1>
}
