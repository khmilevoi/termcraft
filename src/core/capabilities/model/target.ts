import * as errore from "errore";

import {
  type CapabilityTargetByKindV1,
  type CommandKindV1,
  type CommandPayloadByKindV1,
  commandPayloadSchemas,
} from "core/protocol";

/**
 * `CapabilityTargetByKindV1` — the exact, deliberately-narrow value each command's guard
 * and capability projection are allowed to see (kernel-command-contract §10.1).
 *
 * This file exists for one sentence, §10.1's: "No target contains
 * message/initial/title/pin/commit text, an acknowledgement, terminal/input/tweak/geometry
 * raw input, dimensions, coordinates, rectangle fractions, or a page-order permutation."
 *
 * The reason is §10.2's parity invariant. The capability projector publishes a capability
 * per `(id, target)` key, and those keys reach the UI. If a target carried the user's
 * message text or a pin's coordinates, every keystroke would mint a new capability key —
 * and the UI's mirror would carry content the Kernel never intended to publish. Narrowing
 * is therefore a privacy boundary and a cardinality bound at once, not tidiness.
 *
 * The extractor also fixes the ORDER §10.1 states: "The extractor first validates
 * `CommandPayloadByKindV1`, then normalizes the listed fields." Validation is not the
 * caller's job to have done already — an unvalidated payload reaching a guard is exactly
 * how a malformed value would slip past capability parity.
 */

/** A payload that does not satisfy its own kind's closed schema (§10.1's ordering rule). */
export class CapabilityTargetExtractionError extends errore.createTaggedError({
  name: "CapabilityTargetExtractionError",
  message: "cannot extract a capability target for $kind: $reason",
}) {}

/** `CapabilityId` is exactly `CommandKindV1` (§2.12). */
export type CapabilityId = CommandKindV1;

/**
 * Compile-time proof of that identity. §2.12 states it as a fact about the protocol, so a
 * drift between the two must fail `tsc`, not a runtime assertion someone can skip.
 */
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _capabilityIdIsCommandKind: MutuallyAssignable<CapabilityId, CommandKindV1> = true;
void _capabilityIdIsCommandKind;

/**
 * The §10.1 target DTO itself — `CapabilityTargetByKindV1` (the 43-row map), its
 * `capabilityTargetByKindV1Schema` Zod twin, and the companion `RecoveryTargetV1`/
 * `GeometryQueryKindV1` types — lives in `core/protocol` (`protocol/model/
 * capability-target.ts`): it is a protocol wire type (it appears inside
 * `kernel.snapshot`), and `protocol/model/event-payload.ts` needs the runtime Zod value,
 * which `capabilities -> protocol` (this file's own existing import direction) can supply
 * without creating a `protocol -> capabilities -> protocol` cycle. Only the extractors
 * below — which populate that shape from a validated command payload — stay here.
 */

/** One kind's extractor: validate the payload, then normalize only the listed fields. */
export type CapabilityTargetExtractor<K extends CommandKindV1> = (
  payload: unknown,
) => CapabilityTargetExtractionError | CapabilityTargetByKindV1[K];

type ExtractorMap = { [K in CommandKindV1]: CapabilityTargetExtractor<K> };

/**
 * Validates `payload` against its kind's closed schema, then hands the parsed value to
 * `normalize`. Every extractor below goes through here, so §10.1's "validates first" rule
 * cannot be forgotten on one row.
 */
function extractor<K extends CommandKindV1>(
  kind: K,
  normalize: (payload: CommandPayloadByKindV1[K]) => CapabilityTargetByKindV1[K],
): CapabilityTargetExtractor<K> {
  return (payload: unknown) => {
    const parsed = commandPayloadSchemas[kind].safeParse(payload);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const path = issue !== undefined && issue.path.length > 0 ? issue.path.join(".") : "<root>";
      return new CapabilityTargetExtractionError({
        kind,
        reason: `${path}: ${issue?.message ?? "invalid payload"}`,
      });
    }
    return normalize(parsed.data as CommandPayloadByKindV1[K]);
  };
}

/** An extractor for one of §10.1's nine literal-`null` rows. */
function nullTarget<K extends CommandKindV1>(kind: K): CapabilityTargetExtractor<K> {
  return extractor(kind, () => null as CapabilityTargetByKindV1[K]);
}

/**
 * The total map from kind to extractor. `satisfies` makes a missing or extra key a `tsc`
 * error, which is what keeps this table and `CommandKindV1` from drifting apart.
 */
export const capabilityTargetExtractors = {
  // §10.1 row 1 — literal null. Paths, creation defaults, user text, permutations, and the
  // selected migration file-kind scope stay payload-only.
  "project.create": nullTarget("project.create"),
  "project.open": nullTarget("project.open"),
  "project.close": nullTarget("project.close"),
  "turn.start": nullTarget("turn.start"),
  "chat.create": nullTarget("chat.create"),
  "page.reorder": nullTarget("page.reorder"),
  "selection.clear": nullTarget("selection.clear"),
  "export.start": nullTarget("export.start"),
  "migration.plan": nullTarget("migration.plan"),

  "project.retryOpen": extractor("project.retryOpen", (p) => ({ recovery: p.recovery })),
  // §10.1: "Copy the validated opaque workspace identity; OMIT THE TRUST DECISION."
  "project.setTrust": extractor("project.setTrust", (p) => ({
    workspaceIdentity: p.workspaceIdentity,
  })),
  "turn.cancel": extractor("turn.cancel", (p) => ({ turnId: p.turnId })),
  "chat.switch": extractor("chat.switch", (p) => ({ chatId: p.chatId })),
  "model.select": extractor("model.select", (p) => ({
    backend: p.backend,
    model: p.model,
    effort: p.effort,
  })),
  // §10.1: "Copy the normalized page slug; TITLE TEXT IS EXCLUDED."
  "page.renameTitle": extractor("page.renameTitle", (p) => ({ pageSlug: p.pageSlug })),
  "page.removePlan": extractor("page.removePlan", (p) => ({ pageSlug: p.pageSlug })),
  // §10.1: "Copy only payload.pageRemovePlanId; plan facts come from the Kernel plan ledger."
  "page.removeConfirm": extractor("page.removeConfirm", (p) => ({
    pageRemovePlanId: p.pageRemovePlanId,
  })),
  "page.removeDiscardPlan": extractor("page.removeDiscardPlan", (p) => ({
    pageRemovePlanId: p.pageRemovePlanId,
  })),
  "history.open": extractor("history.open", (p) => ({ pageSlug: p.pageSlug })),
  "preview.selectPage": extractor("preview.selectPage", (p) => ({ pageSlug: p.pageSlug })),
  "preview.selectHistorical": extractor("preview.selectHistorical", (p) => ({
    pageSlug: p.pageSlug,
    sourceCommit: p.sourceCommit,
  })),
  "preview.selectCurrent": extractor("preview.selectCurrent", (p) => ({ pageSlug: p.pageSlug })),
  // §10.1: "Copy only the session id; DIMENSIONS and forwarded input are excluded."
  "preview.resize": extractor("preview.resize", (p) => ({ previewSessionId: p.previewSessionId })),
  "preview.forwardInput": extractor("preview.forwardInput", (p) => ({
    previewSessionId: p.previewSessionId,
  })),
  "preview.retry": extractor("preview.retry", (p) => ({ previewSessionId: p.previewSessionId })),
  "preview.close": extractor("preview.close", (p) => ({ previewSessionId: p.previewSessionId })),
  // §10.1: "Copy session and canonical theme ids; TERMINAL CAPABILITIES ARE EXCLUDED."
  "preview.setThemeCapabilities": extractor("preview.setThemeCapabilities", (p) => ({
    previewSessionId: p.previewSessionId,
    themeId: p.themeId,
  })),
  "preview.setMode": extractor("preview.setMode", (p) => ({
    previewSessionId: p.previewSessionId,
    mode: p.mode,
  })),
  // §10.1: "Copy session and canonical tweak ids; THE TYPED VALUE IS EXCLUDED."
  "preview.setTweak": extractor("preview.setTweak", (p) => ({
    previewSessionId: p.previewSessionId,
    tweakId: p.tweakId,
  })),
  /*
   * The naming trap: §8.2's PAYLOAD field is `frameToken`, while §10.1's TARGET field is
   * `frameTokenId`. They are genuinely different surfaces — the payload carries the opaque
   * token the Kernel will resolve against its ledger, the target carries only an identifier
   * for capability keying — so the rename is deliberate, not a typo to "fix".
   * §10.1: "its frame identity, coordinates, and other query body fields remain
   * payload/ledger-only" — hence only the query's discriminator survives.
   */
  "preview.queryGeometry": extractor("preview.queryGeometry", (p) => ({
    frameTokenId: p.frameToken,
    queryKind: p.query.kind,
  })),
  "selection.set": extractor("selection.set", (p) => ({
    pageSlug: p.pageSlug,
    elementId: p.elementId,
  })),
  /*
   * Same rename as above: payload `geometryToken` -> target `geometryTokenId`. §10.1:
   * "Copy only the opaque geometry token id; the private frame/page/element/fraction
   * binding and pin text are excluded."
   */
  "pin.create": extractor("pin.create", (p) => ({ geometryTokenId: p.geometryToken })),
  "pin.setStatus": extractor("pin.setStatus", (p) => ({ pinId: p.pinId, status: p.status })),
  "restore.plan": extractor("restore.plan", (p) => ({
    pageSlug: p.pageSlug,
    sourceCommit: p.sourceCommit,
  })),
  // §10.1: "Copy only the plan id; ACKNOWLEDGEMENT IS EXCLUDED."
  "restore.confirm": extractor("restore.confirm", (p) => ({ restorePlanId: p.restorePlanId })),
  "restore.discardPlan": extractor("restore.discardPlan", (p) => ({
    restorePlanId: p.restorePlanId,
  })),
  "restore.retryRecord": extractor("restore.retryRecord", (p) => ({
    restoreActionId: p.restoreActionId,
  })),
  "commit.plan": extractor("commit.plan", (p) => ({ scope: p.scope })),
  // §10.1: "Copy only the plan id; MESSAGE AND ACKNOWLEDGEMENT ARE EXCLUDED."
  "commit.confirm": extractor("commit.confirm", (p) => ({ commitPlanId: p.commitPlanId })),
  "commit.discardPlan": extractor("commit.discardPlan", (p) => ({
    commitPlanId: p.commitPlanId,
  })),
  "migration.confirm": extractor("migration.confirm", (p) => ({
    migrationPlanId: p.migrationPlanId,
  })),
  "migration.discardPlan": extractor("migration.discardPlan", (p) => ({
    migrationPlanId: p.migrationPlanId,
  })),
  "migration.retryRecovery": extractor("migration.retryRecovery", (p) => ({
    migrationActionId: p.migrationActionId,
  })),
} as const satisfies ExtractorMap;

/** Extracts one kind's capability target, validating the payload first (§10.1). */
export function extractCapabilityTarget<K extends CommandKindV1>(
  kind: K,
  payload: unknown,
): CapabilityTargetExtractionError | CapabilityTargetByKindV1[K] {
  const extract = capabilityTargetExtractors[kind] as CapabilityTargetExtractor<K>;
  return extract(payload);
}
