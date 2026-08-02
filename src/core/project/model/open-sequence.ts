import { wrap } from "@reatom/core";

import type {
  ChatReader,
  DesignTreeReader,
  ExportPublishPort,
  GitIdentityV1,
  PinReader,
  ProjectStore,
  RecoveryService,
  TrustGate,
  TrustSubjectV1,
} from "core/ports";
import type { CommandRejectionCode, FailureDtoV1 } from "core/protocol";

import type { IntendedRecoveryDomainV1, OpenSequenceStepV1, TrustDecisionV1 } from "../types";
import { readPageEntrySource, readPageOrder } from "./descriptors";
import { scanOrphanTurns } from "./orphan-turn-scan";
import { type RecoveryRoutingMachines, routeProjectRecovery } from "./recovery-routing";
import { buildTrustStatus, grantImplicitTrust, resolveTrustDecision } from "./trust";

/**
 * TD §12's ordered startup sequence (lines 1057-1084), end to end through Kernel `ready`
 * (or the broken-source/recovering paths) — never through Workspace/host construction,
 * which is the composition root's job (TD step 10's own second half: "construct the
 * Workspace and start the current design host").
 *
 * ORDER IS THE CONTRACT (this task's own words): every dependency below is called AT
 * MOST once, in the fixed order this function's body reads top to bottom, and a failure
 * at step N calls `kernel.project.blockOpen` and returns before step N+1 ever runs — see
 * `open-sequence.test.ts`'s per-step ordering proofs.
 *
 * STEPS WITH NO 6D PORT (documented gaps, not silent inventions): `openProjectStore`
 * (TD steps 1-2: acquire the project lease, then validate `SafeProjectFs` — no port
 * exposes "open a project" as an operation; `core/ports/project-store.ts`'s `ProjectStore`
 * represents an ALREADY-open, ALREADY-leased project), `readJournalFormat` (TD step 3),
 * `recoverPendingMigrations` (TD step 6 — completing an in-flight schema migration is
 * out of THIS slice's scope; `MIGRATION_CHAIN` is empty by design per this phase's master
 * plan), `validateSchemas` (TD step 7), and `findIntendedRecoveryDomain` (KCC §12.7's
 * "journal inspection... proves durable commit intent" — no port names WHICH domain
 * (Restore/Export/Migration) an intended journal belongs to; `RecoveryService.recover()`
 * returns only aggregate counts and `classify(transactionId)` needs a `transactionId`
 * this ring cannot enumerate). Each is an explicit injected dependency here, not a
 * fabricated port import — the composition root supplies the real implementation once
 * `store` grows the corresponding named method.
 *
 * EXPORT POINTER VALIDATION (TD step 9's "...and export pointer...", WP-5 Phase C task C3):
 * `validateProjectContents` calls `ExportPublishPort.readPointer()` last, after the active
 * chat — a `null` result (the project never published an export) never blocks; a
 * `FailureDtoV1` (an unparseable/schema-invalid pointer, or one whose referenced generation
 * directory is missing, D-Q4) blocks exactly like every other content-validation failure.
 *
 * CHAT ENUMERATION is likewise partial: TD step 9 says "chats" plural, but this open sequence
 * still validates only the ACTIVE chat. `ChatReader` gained `list()` (fix-bundle spec §2.1,
 * Gap E) — enumeration is no longer a port-shape gap — but `validateProjectContents` below has
 * not been updated to call it; closing that is separate work, not done here.
 * Same class of gap as the export pointer, recorded for the same reason.
 *
 * TRUST (KCC §7.1/§12.8) is NOT one of TD's ten storage steps — TD's own list never
 * mentions it. It runs LAST, after every storage step succeeds and before `finishOpen`,
 * per §7.1's own transition table: `setTrust` is only legal from `opening`, never from
 * `recovering` — so a run that routes to `recovering` (an intended journal was found)
 * stops there and never reaches trust at all, matching §7.7's "post-intent recovery runs
 * before trust because rollback is no longer legal."
 */

export interface OpenSequenceDeps {
  readonly mode: "create" | "open";
  readonly projectId: string;
  /** `null` when the project's worktree carries no Git repository (storage-identity §8). */
  readonly git: GitIdentityV1 | null;

  readonly openProjectStore: () => Promise<FailureDtoV1 | ProjectStore>;
  readonly readJournalFormat: () => Promise<FailureDtoV1 | undefined>;
  readonly recovery: RecoveryService;
  readonly findIntendedRecoveryDomain: () => Promise<
    FailureDtoV1 | IntendedRecoveryDomainV1 | null
  >;
  readonly recoverPendingMigrations: () => Promise<FailureDtoV1 | undefined>;
  readonly validateSchemas: () => Promise<FailureDtoV1 | undefined>;

  readonly designReader: DesignTreeReader;
  readonly pinReader: PinReader;
  readonly chatReader: ChatReader;
  /** TD §12 step 9's "...export pointer..." (WP-5 Phase C task C3) — only `readPointer()` is ever called here, never `publish()`. */
  readonly exportPublish: ExportPublishPort;

  readonly trustGate: TrustGate;
  /** The UI-level trust prompt round trip; never called when a prior grant already covers this exact subject, or on `mode: "create"`'s implicit grant. */
  readonly promptTrustDecision: (subject: TrustSubjectV1) => Promise<"grant" | "refuse">;

  /** The seven-machine ring's project/restore/export/migration quartet (§6/§7.1/§12.7) — "state-machine wiring". */
  readonly machines: RecoveryRoutingMachines;
}

export type OpenSequenceOutcomeV1 =
  | { readonly kind: "opened"; readonly store: ProjectStore; readonly trust: TrustDecisionV1 }
  | { readonly kind: "recovering"; readonly domain: IntendedRecoveryDomainV1 }
  | { readonly kind: "blocked"; readonly step: OpenSequenceStepV1; readonly failure: FailureDtoV1 }
  | { readonly kind: "illegal"; readonly code: CommandRejectionCode };

/** Calls `kernel.project.blockOpen` and builds the `blocked` outcome for `step`/`failure` — every failing step below funnels through this one place. */
function blocked(
  deps: OpenSequenceDeps,
  step: OpenSequenceStepV1,
  failure: FailureDtoV1,
): OpenSequenceOutcomeV1 {
  deps.machines.project.apply("blockOpen");
  return { kind: "blocked", step, failure };
}

/** TD step 9: manifest, canonical pages, pins, the active chat, then the export pointer. */
async function validateProjectContents(
  deps: OpenSequenceDeps,
  store: ProjectStore,
): Promise<FailureDtoV1 | undefined> {
  // TD step 9 names the manifest FIRST: "Validate the manifest, canonical pages, chats,
  // pins, export pointer, and local state required to open." A corrupt or too-new manifest
  // is precisely the condition that must stop an open — every page slug below is read
  // through it, so validating pages while never reading the manifest inverts the ordering.
  const manifest = await store.readManifest();
  if ("code" in manifest) return manifest;

  const workspaceState = await store.readWorkspaceState();
  if ("code" in workspaceState) return workspaceState;

  // `design/pages.json`, read ONCE, is the page-identity authority — TD step 9's "canonical
  // pages" are whatever entries it names, never files derived from a slug (task 14; this
  // module previously carried a local copy of the retired `PageReader` shape).
  const pages = await readPageOrder(deps.designReader);
  if ("code" in pages) return pages;

  for (const entry of pages) {
    const source = await readPageEntrySource(deps.designReader, entry.slug, pages);
    if ("code" in source) return source;

    const pins = await deps.pinReader.fold(entry.slug);
    if ("code" in pins) return pins;
  }

  if (workspaceState.state.activeChatId !== null) {
    const chat = await deps.chatReader.open(workspaceState.state.activeChatId);
    if ("code" in chat) return chat;
  }

  // TD §12 step 9's "...export pointer..." (WP-5 Phase C, D-Q3/D-Q4): `null` means the
  // project has never published an export — ABSENT IS VALID, never a block.
  const pointer = await deps.exportPublish.readPointer();
  if (pointer !== null && "code" in pointer) return pointer;

  return undefined;
}

/** Resolves KCC §7.1/§12.8's trust decision. Never touches Gate, HostSupervisor, migration transformation, or export — see this file's header. */
async function resolveTrust(
  deps: OpenSequenceDeps,
  store: ProjectStore,
): Promise<FailureDtoV1 | TrustDecisionV1> {
  if (deps.mode === "create") {
    const subject = await grantImplicitTrust({
      trustGate: deps.trustGate,
      root: store.root,
      projectId: deps.projectId,
      git: deps.git,
    });
    if ("code" in subject) return subject;
    return "trusted";
  }

  const status = await buildTrustStatus({
    trustGate: deps.trustGate,
    root: store.root,
    projectId: deps.projectId,
    git: deps.git,
  });
  if ("code" in status) return status;
  if (status.granted) return "trusted";

  const decision = await deps.promptTrustDecision(status.subject);
  return resolveTrustDecision(deps.trustGate, status.subject, decision);
}

/**
 * REATOM NOTE: every `await` below wraps the injected promise in `wrap(...)` (the
 * project's binding rule: "async boundaries: use `wrap(...)` for promises... that touch
 * Reatom"). Each dependency call is an uncontrolled async boundary — an injected
 * function, or a port method the composition root eventually backs with real I/O — and
 * this function's own continuations touch `deps.machines.*.apply(...)` (real atom
 * writes) after nearly every one of them. Without `wrap`, a continuation resumes outside
 * the `context.start(...)` frame the caller established, and `.apply()`'s `atom.set` runs
 * against no active context — silently landing on the wrong instance rather than
 * throwing, which is exactly why `open-sequence.test.ts` caught it as a stuck `"closed"`
 * phase instead of a visible error.
 */
export async function runOpenSequence(deps: OpenSequenceDeps): Promise<OpenSequenceOutcomeV1> {
  const startOutcome = deps.machines.project.apply(
    deps.mode === "create" ? "beginCreate" : "beginOpen",
  );
  if (startOutcome.kind === "illegal") return { kind: "illegal", code: startOutcome.code };

  // TD steps 1-2: the project lease, then SafeProjectFs.
  const store = await wrap(deps.openProjectStore());
  if ("code" in store) return blocked(deps, "open-project-store", store);

  // TD step 3: "Read journal format. Stop on too-new or corrupt journal state." Stopping
  // here is the point — a too-new journal means a newer build wrote state this one cannot
  // interpret, so continuing into recovery would roll forward against a format it does not
  // understand.
  const journalFormat = await wrap(deps.readJournalFormat());
  if (journalFormat !== undefined) return blocked(deps, "journal-format", journalFormat);

  // TD step 4: the generic transaction-recovery pass. Its OWN failure path — a conflict
  // or non-retryable I/O pending — is TD step 5's "pre-Workspace Recovery screen",
  // modeled here as the same typed `blocked` outcome.
  const recoverOutcome = await wrap(deps.recovery.recover());
  if (!recoverOutcome.ok) return blocked(deps, "transaction-recovery", recoverOutcome.error);

  // KCC §12.7 recovery routing. Runs BEFORE trust (§7.7: "post-intent recovery runs
  // before trust because rollback is no longer legal") and, when it finds an intended
  // journal, this run stops here — `setTrust` has no legal edge from `recovering`.
  const intendedDomain = await wrap(deps.findIntendedRecoveryDomain());
  // `IntendedRecoveryDomainV1` is a bare string union, not an object — `"code" in x`
  // would throw on it (unlike the object-shaped checks elsewhere in this file), so this
  // is a membership check against the three known domains instead.
  if (
    intendedDomain !== null &&
    intendedDomain !== "restore" &&
    intendedDomain !== "export" &&
    intendedDomain !== "migration"
  ) {
    return blocked(deps, "recovery-routing", intendedDomain);
  }

  const routing = routeProjectRecovery(deps.machines, intendedDomain);
  if (routing.kind === "illegal") return { kind: "illegal", code: routing.code };
  if (routing.kind === "routed") return { kind: "recovering", domain: routing.domain };

  // TD step 6.
  const migrationsGate = await wrap(deps.recoverPendingMigrations());
  if (migrationsGate !== undefined) return blocked(deps, "migrations-gate", migrationsGate);

  // TD step 7.
  const schemaValidation = await wrap(deps.validateSchemas());
  if (schemaValidation !== undefined) return blocked(deps, "schema-validation", schemaValidation);

  // TD step 8: the orphan/nonterminal-turn scan (TD §7.7, `orphan-turn-scan.ts`).
  const orphanDecisions = await wrap(scanOrphanTurns({ recovery: deps.recovery }));
  if ("code" in orphanDecisions) return blocked(deps, "orphan-turn-scan", orphanDecisions);

  const corrupt = orphanDecisions.find((decision) => decision.kind === "chat-corrupt");
  if (corrupt !== undefined) {
    // §7.7: "chat_corrupt; block mutating Workspace actions." No §11.2 operational code
    // names "a chat's turn records are internally inconsistent" — the closest faithful
    // mapping, documented rather than invented, is the durable-store-is-inconsistent
    // code this ring already uses for "the store itself cannot be trusted right now".
    return blocked(deps, "orphan-turn-scan", {
      code: "PERSISTENCE_FAILED",
      retryable: false,
      safeMessage: `chat_corrupt: ${corrupt.reason} for turnId ${corrupt.turnId} in chatId ${corrupt.chatId}`,
      details: { chatId: corrupt.chatId, turnId: corrupt.turnId, reason: corrupt.reason },
    });
  }

  // TD step 9 (minus the export-pointer gap — see this file's header).
  const contentValidation = await wrap(validateProjectContents(deps, store));
  if (contentValidation !== undefined)
    return blocked(deps, "content-validation", contentValidation);

  // KCC §7.1/§12.8 trust — see this file's header for why it runs here, last.
  const trust = await wrap(resolveTrust(deps, store));
  // `TrustDecisionV1` is a bare string union — same reasoning as `intendedDomain` above.
  if (trust !== "trusted" && trust !== "untrusted-read-only") return blocked(deps, "trust", trust);

  const setTrustOutcome = deps.machines.project.apply("setTrust");
  if (setTrustOutcome.kind === "illegal") return { kind: "illegal", code: setTrustOutcome.code };

  // TD step 10's Kernel-state half only — Workspace/host construction is the
  // composition root's job, not this sequence's (see this file's header).
  const finishOutcome = deps.machines.project.apply("finishOpen");
  if (finishOutcome.kind === "illegal") return { kind: "illegal", code: finishOutcome.code };

  return { kind: "opened", store, trust };
}
