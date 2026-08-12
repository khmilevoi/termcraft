import { z } from "zod";

import { pageSlugSchema } from "entities/page";

import { type CommandKindV1 } from "./command-kind";
import { type CommandPayloadByKindV1, commandPayloadSchemas } from "./command-payload";
import { uuidv7Schema } from "./ids";
import { frameTokenV1Schema, geometryTokenV1Schema } from "./shared-dto";

/**
 * The capability-target DTO (kernel-command-contract §10.1): the exact, deliberately-
 * narrow value each command family's guard and the capability projector are allowed to
 * see, keyed by `CommandKindV1`.
 *
 * This lives in `core/protocol`, not `core/capabilities`, even though `core/capabilities`
 * is the only current caller of the type: `core/capabilities` already imports
 * `core/protocol` (for `CommandKindV1`/`CommandPayloadByKindV1`), and `kernel.snapshot`'s
 * event payload (`./event-payload.ts`, `CapabilityEntryV1.target`, closed in WP-1 task 2)
 * needs this same DTO's real Zod schema, not just its type. Having `event-payload.ts` import from
 * `core/capabilities` for it would create a `protocol -> capabilities -> protocol` cycle;
 * moving the DTO here keeps the import direction one-way: `capabilities -> protocol`.
 * `core/capabilities/model/target.ts` keeps the 43 extractor functions that populate this
 * shape from a validated command payload — only the DTO itself (type + schema) moved.
 */

/** The closed recovery discriminator §10.1 copies verbatim for `project.retryOpen`. */
export type RecoveryTargetV1 = CommandPayloadByKindV1["project.retryOpen"]["recovery"];

/** The closed geometry query discriminator, reduced to its kind (§10.1). */
export type GeometryQueryKindV1 = "hit" | "rect" | "describe" | "layout" | "pin-anchor";

const geometryQueryKindV1Schema = z.enum(["hit", "rect", "describe", "layout", "pin-anchor"]);

/**
 * The §10.1 table, transcribed row by row. `null` is a REQUIRED VALUE here, not an omitted
 * target — §10.1: "`null` is a required value, not an omitted target."
 */
export interface CapabilityTargetByKindV1 {
  "project.create": null;
  "project.open": null;
  "project.retryOpen": { readonly recovery: RecoveryTargetV1 };
  "project.close": null;
  "project.setTrust": { readonly workspaceIdentity: string };
  "turn.start": null;
  "turn.cancel": { readonly turnId: string };
  "chat.create": null;
  "chat.switch": { readonly chatId: string };
  "chat.load-older": { readonly chatId: string };
  "model.select": { readonly backend: string; readonly model: string; readonly effort: string };
  "page.renameTitle": { readonly pageSlug: string };
  "page.removePlan": { readonly pageSlug: string };
  "page.removeConfirm": { readonly pageRemovePlanId: string };
  "page.removeDiscardPlan": { readonly pageRemovePlanId: string };
  "page.reorder": null;
  "history.open": { readonly pageSlug: string };
  "preview.selectPage": { readonly pageSlug: string };
  "preview.selectHistorical": { readonly pageSlug: string; readonly sourceCommit: string };
  "preview.selectCurrent": { readonly pageSlug: string };
  "preview.resize": { readonly previewSessionId: string };
  "preview.setThemeCapabilities": { readonly previewSessionId: string; readonly themeId: string };
  "preview.setMode": { readonly previewSessionId: string; readonly mode: "static" | "interactive" };
  "preview.forwardInput": { readonly previewSessionId: string };
  "preview.setTweak": { readonly previewSessionId: string; readonly tweakId: string };
  "preview.queryGeometry": {
    readonly frameTokenId: string;
    readonly queryKind: GeometryQueryKindV1;
  };
  "preview.retry": { readonly previewSessionId: string };
  "preview.close": { readonly previewSessionId: string };
  "selection.set": { readonly pageSlug: string; readonly elementId: string };
  "selection.clear": null;
  "pin.create": { readonly geometryTokenId: string };
  "pin.setStatus": { readonly pinId: string; readonly status: "open" | "resolved" };
  "restore.plan": { readonly pageSlug: string; readonly sourceCommit: string };
  "restore.confirm": { readonly restorePlanId: string };
  "restore.discardPlan": { readonly restorePlanId: string };
  "restore.retryRecord": { readonly restoreActionId: string };
  "commit.plan": { readonly scope: "current-page" | "infrastructure" | "whole-project" };
  "commit.confirm": { readonly commitPlanId: string };
  "commit.discardPlan": { readonly commitPlanId: string };
  "export.start": null;
  "migration.plan": null;
  "migration.confirm": { readonly migrationPlanId: string };
  "migration.discardPlan": { readonly migrationPlanId: string };
  "migration.retryRecovery": { readonly migrationActionId: string };
  // project-design-systems §8.1/§10.1 Wave 3 / P10 (scope escape, task-9 discovery: this
  // 43-row table is exhaustively `satisfies`-checked against `CommandKindV1`, so the four new
  // `designSystem.*` commands cannot compile without a row here even though the plan's file
  // list never names this file). All four stay literal `null`: nothing about the picker's
  // commands needs a per-argument capability key in this plan — `designSystem.list` takes no
  // input, and `preview`/`install`/`publish`'s own `ref`/`installId`/`sourceId` are exactly
  // the kind of runtime identity `project.retryOpen`'s neighbours already keep out of a target
  // unless a real per-identity capability need is named (none is, here).
  "designSystem.list": null;
  "designSystem.preview": null;
  "designSystem.install": null;
  "designSystem.publish": null;
}

/**
 * The Zod twin of {@link CapabilityTargetByKindV1}, one schema per kind — the same
 * per-kind-map shape `commandPayloadSchemas` (`./command-payload.ts`) already uses, so a
 * caller validates a target the same way it validates a payload:
 * `capabilityTargetByKindV1Schema[kind].safeParse(target)`.
 *
 * Every row is built from the real building blocks the corresponding payload schema uses
 * (`uuidv7Schema`, `pageSlugSchema`, the same closed enums) rather than a hand-rolled
 * re-derivation, and `project.retryOpen`'s row reuses
 * `commandPayloadSchemas["project.retryOpen"].shape.recovery` directly — the exact schema
 * instance {@link RecoveryTargetV1} is inferred from — so the two can never drift apart.
 * `satisfies` checks each row's inferred output against
 * {@link CapabilityTargetByKindV1}'s matching member (`z.ZodType`'s `Output` parameter is
 * covariant), which is what catches a wrong field name or shape at `tsc` time without a
 * cast.
 */
export const capabilityTargetByKindV1Schema = {
  "project.create": z.null(),
  "project.open": z.null(),
  "project.retryOpen": z.strictObject({
    recovery: commandPayloadSchemas["project.retryOpen"].shape.recovery,
  }),
  "project.close": z.null(),
  "project.setTrust": z.strictObject({
    workspaceIdentity: z.string().min(1),
  }),
  "turn.start": z.null(),
  "turn.cancel": z.strictObject({
    turnId: uuidv7Schema,
  }),
  "chat.create": z.null(),
  "chat.switch": z.strictObject({
    chatId: uuidv7Schema,
  }),
  "chat.load-older": z.strictObject({
    chatId: uuidv7Schema,
  }),
  "model.select": z.strictObject({
    backend: z.string().min(1),
    model: z.string().min(1),
    effort: z.string().min(1),
  }),
  "page.renameTitle": z.strictObject({
    pageSlug: pageSlugSchema,
  }),
  "page.removePlan": z.strictObject({
    pageSlug: pageSlugSchema,
  }),
  "page.removeConfirm": z.strictObject({
    pageRemovePlanId: uuidv7Schema,
  }),
  "page.removeDiscardPlan": z.strictObject({
    pageRemovePlanId: uuidv7Schema,
  }),
  "page.reorder": z.null(),
  "history.open": z.strictObject({
    pageSlug: pageSlugSchema,
  }),
  "preview.selectPage": z.strictObject({
    pageSlug: pageSlugSchema,
  }),
  "preview.selectHistorical": z.strictObject({
    pageSlug: pageSlugSchema,
    sourceCommit: z.string().min(1),
  }),
  "preview.selectCurrent": z.strictObject({
    pageSlug: pageSlugSchema,
  }),
  "preview.resize": z.strictObject({
    previewSessionId: uuidv7Schema,
  }),
  "preview.setThemeCapabilities": z.strictObject({
    previewSessionId: uuidv7Schema,
    themeId: z.string().min(1),
  }),
  "preview.setMode": z.strictObject({
    previewSessionId: uuidv7Schema,
    mode: z.enum(["static", "interactive"]),
  }),
  "preview.forwardInput": z.strictObject({
    previewSessionId: uuidv7Schema,
  }),
  "preview.setTweak": z.strictObject({
    previewSessionId: uuidv7Schema,
    tweakId: z.string().min(1),
  }),
  "preview.queryGeometry": z.strictObject({
    frameTokenId: frameTokenV1Schema,
    queryKind: geometryQueryKindV1Schema,
  }),
  "preview.retry": z.strictObject({
    previewSessionId: uuidv7Schema,
  }),
  "preview.close": z.strictObject({
    previewSessionId: uuidv7Schema,
  }),
  "selection.set": z.strictObject({
    pageSlug: pageSlugSchema,
    elementId: z.string().min(1),
  }),
  "selection.clear": z.null(),
  "pin.create": z.strictObject({
    geometryTokenId: geometryTokenV1Schema,
  }),
  "pin.setStatus": z.strictObject({
    pinId: uuidv7Schema,
    status: z.enum(["open", "resolved"]),
  }),
  "restore.plan": z.strictObject({
    pageSlug: pageSlugSchema,
    sourceCommit: z.string().min(1),
  }),
  "restore.confirm": z.strictObject({
    restorePlanId: uuidv7Schema,
  }),
  "restore.discardPlan": z.strictObject({
    restorePlanId: uuidv7Schema,
  }),
  "restore.retryRecord": z.strictObject({
    restoreActionId: uuidv7Schema,
  }),
  "commit.plan": z.strictObject({
    scope: z.enum(["current-page", "infrastructure", "whole-project"]),
  }),
  "commit.confirm": z.strictObject({
    commitPlanId: uuidv7Schema,
  }),
  "commit.discardPlan": z.strictObject({
    commitPlanId: uuidv7Schema,
  }),
  "export.start": z.null(),
  "migration.plan": z.null(),
  "migration.confirm": z.strictObject({
    migrationPlanId: uuidv7Schema,
  }),
  "migration.discardPlan": z.strictObject({
    migrationPlanId: uuidv7Schema,
  }),
  "migration.retryRecovery": z.strictObject({
    migrationActionId: uuidv7Schema,
  }),
  "designSystem.list": z.null(),
  "designSystem.preview": z.null(),
  "designSystem.install": z.null(),
  "designSystem.publish": z.null(),
} satisfies Readonly<{ [K in CommandKindV1]: z.ZodType<CapabilityTargetByKindV1[K]> }>;
