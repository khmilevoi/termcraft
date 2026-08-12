import { z } from "zod";

import { pageSlugSchema } from "entities/page";

import { type CommandKindV1 } from "./command-kind";
import { uuidv7Schema } from "./ids";
import { chatPageCursorDtoV1Schema, frameTokenV1Schema, geometryTokenV1Schema } from "./shared-dto";

/**
 * The closed v1 command-payload registry (kernel-command-contract §8.2): one Zod schema
 * per `CommandKindV1` member, matching the spec's `Payload` table column exactly.
 *
 * Every named object is `z.strictObject` — §8.2: "every named object rejects unknown
 * keys, and prose-separated fields are required fields of one readonly object unless the
 * row says `empty` (the exact empty object)". A row that spells out its shape in
 * TypeScript (`project.retryOpen`, `project.setTrust`, `page.removePlan`,
 * `page.removeConfirm`, `preview.queryGeometry`, `pin.create`, `migration.confirm`,
 * `migration.discardPlan`) is transcribed verbatim, field names included — that already
 * fixes `recovery`, `trust`, `workspaceIdentity`, `frameToken`, `query`, `geometryToken`,
 * and (for `pin.create` only) `text`, none of them chosen here. A row that only describes
 * its fields in prose ("page slug, validated new title", "backend, model, effort", …) gets
 * a field name chosen here — documented at each such schema — preferring a name the spec
 * already uses for the same concept elsewhere (`turnId`, `chatId`, `pageSlug`,
 * `previewSessionId`, `restorePlanId`, `commitPlanId`, `migrationPlanId`,
 * `pageRemovePlanId`, `restoreActionId`, `migrationActionId`, `sourceCommit`, `scope`,
 * `mode`, `themeId`, `tweakId`, `elementId`, `status`) — each cross-checked against
 * §10.1's `CapabilityTargetByKindV1` table, which reuses the same name for the kinds it
 * targets.
 *
 * That cross-check does not extend to every name above. `preview.queryGeometry`'s
 * `frameToken` and `pin.create`'s `geometryToken` are §8.2-fixed the verbatim way, but
 * §10.1 copies them under *different* names — `frameTokenId` and `geometryTokenId` — so
 * the target renames the id rather than echoing the payload field. `project.setTrust`'s
 * `trust` (also §8.2-verbatim) and the `text` field chosen here for `turn.start`'s
 * "message text" (and reused by `project.create`, then by `project.open` too — MVP blocker
 * fix bundle §2.4/§3.1, Gap C) never reach §10.1's target at all: it keeps only
 * `workspaceIdentity` ("omit the trust decision") and states "No target contains
 * message/initial/title/pin/commit text".
 *
 * DTOs carry no `Error`, `Date`, `Map`, `Set`, class instance, function, `undefined`, or
 * `bigint` (§8.1); every schema below is built only from the JSON-safe primitives and the
 * landed identity/counter schemas.
 */

/** `trust` (§8.2 `project.setTrust`), reused for `project.create`'s creation defaults. */
const trustSchema = z.enum(["trusted", "untrusted-read-only"]);

/**
 * `project.create`'s "validated creation defaults" is prose-only (§8.2). A fresh project
 * needs the same validated decision `project.setTrust` makes — §7.1 shows `ready` is
 * reachable with either trust value straight out of `opening`, so creation cannot defer
 * that decision indefinitely. Reusing `trust`/`workspaceIdentity` verbatim (both are in
 * the spec's shared-name list) is preferred over inventing an unrelated shape.
 */
const projectCreationDefaultsV1Schema = z.strictObject({
  trust: trustSchema,
  workspaceIdentity: z.string().min(1),
});

/**
 * `project.create`: "canonical root, validated creation defaults, initial text" (§8.2).
 * `root` mirrors `project.open`'s "canonical root"; `text` reuses `turn.start`'s field
 * name for the same concept (§8.2 says `project.create`'s intent is to "begin the first
 * turn"). Non-empty like every other user-facing identity string in this file.
 */
const projectCreatePayloadSchema = z.strictObject({
  root: z.string().min(1),
  creationDefaults: projectCreationDefaultsV1Schema,
  text: z.string().min(1),
});

/**
 * `project.open`: "canonical root" (§8.2), plus the SAME optional first-turn `text`
 * `project.create` already carries (MVP blocker fix bundle §2.4/§3.1).
 *
 * Why `open` needs it too: Home's Enter is the one entry into the first turn, and the composition
 * root decides per launch whether that Enter means create-or-open. Without this field, an Enter on
 * a project that already exists but is empty would have to send `project.create`, and the
 * difference is not cosmetic — `create` grants trust implicitly, `open` honours a prior grant. One
 * optional field removes a class of "which semantics ran" ambiguity instead of hiding a special
 * case inside `create`. Optional, never nullable: a plain `project.open` at relaunch carries none.
 */
const projectOpenPayloadSchema = z.strictObject({
  root: z.string().min(1),
  text: z.string().min(1).optional(),
});

/**
 * `project.retryOpen`'s closed recovery discriminated union, transcribed verbatim from
 * §8.2: `{ recovery: { kind: "restore", restoreActionId } | { kind: "export", operationId }
 * | { kind: "migration", migrationActionId } }`. Each domain's one outstanding operation id
 * is copied, never invented — §10.1 confirms the same three fields as the capability
 * target.
 */
const projectRetryOpenPayloadSchema = z.strictObject({
  recovery: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("restore"), restoreActionId: uuidv7Schema }),
    z.strictObject({ kind: z.literal("export"), operationId: uuidv7Schema }),
    z.strictObject({ kind: z.literal("migration"), migrationActionId: uuidv7Schema }),
  ]),
});

/** `project.close`: "empty" (§8.2) — the exact empty object. */
const projectClosePayloadSchema = z.strictObject({});

/** `project.setTrust`: `{ trust, workspaceIdentity }`, transcribed verbatim (§8.2). */
const projectSetTrustPayloadSchema = z.strictObject({
  trust: trustSchema,
  workspaceIdentity: z.string().min(1),
});

/** `turn.start`: "message text" (§8.2). `text` is the spec's own name for this concept. */
const turnStartPayloadSchema = z.strictObject({
  text: z.string().min(1),
});

/** `turn.cancel`: "`turnId`" (§8.2, fixed name). */
const turnCancelPayloadSchema = z.strictObject({
  turnId: uuidv7Schema,
});

/** `chat.create`: "empty" (§8.2). */
const chatCreatePayloadSchema = z.strictObject({});

/** `chat.switch`: "`chatId`" (§8.2, fixed name). */
const chatSwitchPayloadSchema = z.strictObject({
  chatId: uuidv7Schema,
});

/**
 * `chat.load-older`: the chat, plus the cursor the client last received on `chat.records` or
 * `chat.records.older` (chat-scroll spec §6.1). The client returns the cursor it was given
 * and never constructs one — which is why this is the DTO from `shared-dto.ts` and not a
 * pair of loose numbers validated here.
 */
const chatLoadOlderPayloadSchema = z.strictObject({
  chatId: uuidv7Schema,
  cursor: chatPageCursorDtoV1Schema,
});

/**
 * `model.select`: "backend, model, effort" (§8.2). §10.1 confirms all three as plain
 * validated strings (not a closed enum) — the concrete catalog is capability-driven, not
 * fixed by the protocol.
 */
const modelSelectPayloadSchema = z.strictObject({
  backend: z.string().min(1),
  model: z.string().min(1),
  effort: z.string().min(1),
});

/**
 * `page.renameTitle`: "page slug, validated new title" (§8.2). `pageSlug` matches §10.1's
 * capability target; `title` is chosen here — the spec has no other name for this concept.
 */
const pageRenameTitlePayloadSchema = z.strictObject({
  pageSlug: pageSlugSchema,
  title: z.string().min(1),
});

/** `page.removePlan`: `{ pageSlug }`, transcribed verbatim (§8.2). */
const pageRemovePlanPayloadSchema = z.strictObject({
  pageSlug: pageSlugSchema,
});

/** `page.removeConfirm`: `{ pageRemovePlanId }`, transcribed verbatim (§8.2). */
const pageRemoveConfirmPayloadSchema = z.strictObject({
  pageRemovePlanId: uuidv7Schema,
});

/** `page.removeDiscardPlan`: `{ pageRemovePlanId }` (§8.2, same shape as `removeConfirm`). */
const pageRemoveDiscardPlanPayloadSchema = z.strictObject({
  pageRemovePlanId: uuidv7Schema,
});

/**
 * `page.reorder`: "exact permutation of listed slugs" (§8.2). `pageSlugs` is chosen here —
 * the spec names no field for this concept. Uniqueness of the permutation is a Kernel
 * runtime invariant, not re-asserted at the schema layer, matching how
 * `pageRemovePlanV1Schema.orderedPageSlugs` (shared-dto.ts) validates the same way.
 */
const pageReorderPayloadSchema = z.strictObject({
  pageSlugs: z.array(pageSlugSchema).readonly(),
});

/** `history.open`: "active page slug" (§8.2). `pageSlug` matches §10.1's capability target. */
const historyOpenPayloadSchema = z.strictObject({
  pageSlug: pageSlugSchema,
});

/** `preview.selectPage`: "page slug" (§8.2). */
const previewSelectPagePayloadSchema = z.strictObject({
  pageSlug: pageSlugSchema,
});

/**
 * `preview.selectHistorical`: "page slug, full commit id" (§8.2). Both names confirmed by
 * §10.1's capability target: `{ pageSlug, sourceCommit }`. `sourceCommit` is validated the
 * same way `entities/chat`'s `system:restore` record validates the same concept
 * (`z.string().min(1)` — a full Git object id, no fixed length asserted at this layer).
 */
const previewSelectHistoricalPayloadSchema = z.strictObject({
  pageSlug: pageSlugSchema,
  sourceCommit: z.string().min(1),
});

/** `preview.selectCurrent`: "page slug" (§8.2). */
const previewSelectCurrentPayloadSchema = z.strictObject({
  pageSlug: pageSlugSchema,
});

/**
 * `preview.resize`: "`previewSessionId`, width and height" (§8.2). Spelled out as two
 * top-level fields — the row lists them as separate prose words, not a nested size object.
 */
const previewResizePayloadSchema = z.strictObject({
  previewSessionId: uuidv7Schema,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

/**
 * Terminal color/geometry capabilities announced at `preview.setThemeCapabilities` (§8.2).
 * Mirrors `host/types.ts`'s `TerminalCapabilities` (MVP carries only `colorDepth`) but is
 * redefined here rather than imported: `core` imports only `entities/` and its own
 * `ports/` (code-structure.md item 7) and must never import `host`.
 */
const terminalCapabilitiesV1Schema = z.strictObject({
  colorDepth: z.number().int().positive(),
});

/**
 * `preview.setThemeCapabilities`: "`previewSessionId`, theme id, terminal capabilities"
 * (§8.2). `themeId` matches §10.1's capability target, which also confirms terminal
 * capabilities are payload-only ("terminal capabilities are excluded" from the target).
 */
const previewSetThemeCapabilitiesPayloadSchema = z.strictObject({
  previewSessionId: uuidv7Schema,
  themeId: z.string().min(1),
  terminalCapabilities: terminalCapabilitiesV1Schema,
});

/** `preview.setMode`: "`previewSessionId`, static or interactive" (§8.2); `mode` matches §10.1. */
const previewSetModePayloadSchema = z.strictObject({
  previewSessionId: uuidv7Schema,
  mode: z.enum(["static", "interactive"]),
});

/**
 * `preview.forwardInput`'s "typed key/click/mouse input" (§8.2) has no closed shape fixed
 * anywhere in the spec corpus; the host wire's message names (`input-key`, `input-click`,
 * `input-mousemove`, host-supervision §7) are the closest grounding, so the discriminator
 * values mirror them. `x`/`y` are 0-based terminal-cell coordinates, consistent with the
 * cell-grid the host seals per frame (host-supervision §7.1).
 */
const previewInputV1Schema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("key"), key: z.string().min(1) }),
  z.strictObject({
    kind: z.literal("click"),
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
    button: z.enum(["left", "middle", "right"]),
  }),
  z.strictObject({
    kind: z.literal("mousemove"),
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
  }),
]);

/**
 * `preview.forwardInput`: "`previewSessionId`, typed key/click/mouse input" (§8.2).
 * `input` is chosen here for the field; §10.1 confirms only `previewSessionId` survives
 * into the capability target ("dimensions and forwarded input are excluded").
 */
const previewForwardInputPayloadSchema = z.strictObject({
  previewSessionId: uuidv7Schema,
  input: previewInputV1Schema,
});

/**
 * `preview.setTweak`'s "typed value" (§8.2) has no closed catalog anywhere in the spec —
 * `host/session/types.ts`'s `ReadyBody.tweaks` is `readonly never[]` because tweaks are a
 * later phase. A JSON-safe tagged scalar (string/number/boolean) is the smallest typed
 * shape that satisfies §8.1's DTO constraint without inventing tweak semantics that do not
 * exist yet.
 */
const tweakValueV1Schema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("string"), value: z.string() }),
  z.strictObject({ kind: z.literal("number"), value: z.number() }),
  z.strictObject({ kind: z.literal("boolean"), value: z.boolean() }),
]);

/**
 * `preview.setTweak`: "`previewSessionId`, tweak id and typed value" (§8.2). `tweakId`
 * matches §10.1's capability target, which excludes the typed value from the target.
 */
const previewSetTweakPayloadSchema = z.strictObject({
  previewSessionId: uuidv7Schema,
  tweakId: z.string().min(1),
  value: tweakValueV1Schema,
});

/**
 * `preview.queryGeometry`'s closed hit/rect/describe/layout/pin-anchor query union (§8.2).
 * The five discriminator values are fixed by the spec verbatim; the per-variant body
 * fields are not specified anywhere in the corpus and are chosen here: `hit`/`pin-anchor`
 * carry the 0-based terminal-cell point being tested (§8.1: a resolving query binds
 * `(pageSlug, elementId, fx, fy)`, so the *input* coordinates are raw, pre-resolution);
 * `rect`/`describe` carry the target `elementId` (reused from `selection.set`); `layout`
 * carries no body beyond its discriminator.
 */
const geometryQueryV1Schema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("hit"),
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
  }),
  z.strictObject({ kind: z.literal("rect"), elementId: z.string().min(1) }),
  z.strictObject({ kind: z.literal("describe"), elementId: z.string().min(1) }),
  z.strictObject({ kind: z.literal("layout") }),
  z.strictObject({
    kind: z.literal("pin-anchor"),
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
  }),
]);

/**
 * `preview.queryGeometry`: `{ frameToken, query }`, transcribed verbatim (§8.2). Reuses
 * `frameTokenV1Schema` (shared-dto.ts) rather than re-deriving the opaque-token shape.
 */
const previewQueryGeometryPayloadSchema = z.strictObject({
  frameToken: frameTokenV1Schema,
  query: geometryQueryV1Schema,
});

/** `preview.retry`: "`previewSessionId`" (§8.2). */
const previewRetryPayloadSchema = z.strictObject({
  previewSessionId: uuidv7Schema,
});

/** `preview.close`: "`previewSessionId`" (§8.2). */
const previewClosePayloadSchema = z.strictObject({
  previewSessionId: uuidv7Schema,
});

/**
 * `selection.set`: "page slug, element id" (§8.2); both names confirmed by §10.1's
 * capability target `{ pageSlug, elementId }`.
 */
const selectionSetPayloadSchema = z.strictObject({
  pageSlug: pageSlugSchema,
  elementId: z.string().min(1),
});

/** `selection.clear`: "empty" (§8.2). */
const selectionClearPayloadSchema = z.strictObject({});

/**
 * `pin.create`: `{ geometryToken, text }`, transcribed verbatim (§8.2) — "No page,
 * element, rectangle, or fractions are accepted separately." Reuses `geometryTokenV1Schema`
 * (shared-dto.ts). `text` allows the empty string, matching `pinDtoV1Schema`'s own
 * comment that pin text is "empty-allowed ... unlike an identity string".
 */
const pinCreatePayloadSchema = z.strictObject({
  geometryToken: geometryTokenV1Schema,
  text: z.string(),
});

/**
 * `pin.setStatus`: "stable `pinId`, `open` or `resolved`" (§8.2); `status` matches §10.1's
 * capability target and `pinDtoV1Schema`'s own status enum (shared-dto.ts).
 */
const pinSetStatusPayloadSchema = z.strictObject({
  pinId: uuidv7Schema,
  status: z.enum(["open", "resolved"]),
});

/**
 * `restore.plan`: "page slug, full commit id" (§8.2); both names confirmed by §10.1's
 * capability target `{ pageSlug, sourceCommit }`.
 */
const restorePlanPayloadSchema = z.strictObject({
  pageSlug: pageSlugSchema,
  sourceCommit: z.string().min(1),
});

/**
 * `restore.confirm`: "`restorePlanId`, overwrite acknowledgement" (§8.2). Unlike
 * `migration.confirm`'s literal-`true` acknowledgement, §11.1's `CONFIRMATION_REQUIRED`
 * ("Required overwrite/detached-HEAD warning was not acknowledged") shows this
 * acknowledgement is a real boolean the guard evaluates, not a schema-level literal —
 * a caller can legally send `false` and be rejected by the guard, not by decode.
 * `overwriteAcknowledged` is chosen here; the spec names no field for this concept.
 */
const restoreConfirmPayloadSchema = z.strictObject({
  restorePlanId: uuidv7Schema,
  overwriteAcknowledged: z.boolean(),
});

/** `restore.discardPlan`: "`restorePlanId`" (§8.2). */
const restoreDiscardPlanPayloadSchema = z.strictObject({
  restorePlanId: uuidv7Schema,
});

/** `restore.retryRecord`: "`restoreActionId`" (§8.2). */
const restoreRetryRecordPayloadSchema = z.strictObject({
  restoreActionId: uuidv7Schema,
});

/**
 * `commit.plan`: "typed commit scope" (§8.2); §10.1's capability target fixes the closed
 * enum verbatim: `{ scope: "current-page" | "infrastructure" | "whole-project" }`.
 */
const commitPlanPayloadSchema = z.strictObject({
  scope: z.enum(["current-page", "infrastructure", "whole-project"]),
});

/**
 * `commit.confirm`: "`commitPlanId`, message, required warning acknowledgement" (§8.2).
 * Like `restore.confirm`, this acknowledgement is a real boolean the guard evaluates
 * (`CONFIRMATION_REQUIRED` is a rejection code, not a schema failure). `message` and
 * `warningAcknowledged` are chosen here; the spec names no field for either.
 */
const commitConfirmPayloadSchema = z.strictObject({
  commitPlanId: uuidv7Schema,
  message: z.string().min(1),
  warningAcknowledged: z.boolean(),
});

/** `commit.discardPlan`: "`commitPlanId`" (§8.2). */
const commitDiscardPlanPayloadSchema = z.strictObject({
  commitPlanId: uuidv7Schema,
});

/** `export.start`: "empty" (§8.2). */
const exportStartPayloadSchema = z.strictObject({});

/**
 * `migration.plan`'s "typed selected file-kind scope" has no closed catalog anywhere in
 * the spec corpus (only per-rewrite-entry `fileKind` strings are mentioned, at
 * `migration.planReady`, §9) — so a scope is a non-empty set of caller-chosen category
 * strings, `fileKinds`, validated only for shape, not against a fixed enum.
 */
const fileKindScopeV1Schema = z.strictObject({
  fileKinds: z.array(z.string().min(1)).min(1).readonly(),
});

/**
 * `migration.plan`: "empty or typed selected file-kind scope" (§8.2) — the one row that
 * is not simply "one object of required fields" or bare "empty". Modeled as a union of
 * the two literal shapes the prose names, matching how every other "empty" row means the
 * exact empty object rather than a nullable field.
 */
const migrationPlanPayloadSchema = z.union([
  z.strictObject({}),
  z.strictObject({ scope: fileKindScopeV1Schema }),
]);

/**
 * `migration.confirm`: `{ migrationPlanId, acknowledged: true }`, transcribed verbatim
 * (§8.2) — `acknowledged` is a literal `true`, not a boolean, unlike `restore.confirm`'s
 * and `commit.confirm`'s acknowledgement fields.
 */
const migrationConfirmPayloadSchema = z.strictObject({
  migrationPlanId: uuidv7Schema,
  acknowledged: z.literal(true),
});

/** `migration.discardPlan`: `{ migrationPlanId }`, transcribed verbatim (§8.2). */
const migrationDiscardPlanPayloadSchema = z.strictObject({
  migrationPlanId: uuidv7Schema,
});

/** `migration.retryRecovery`: `{ migrationActionId }`, transcribed verbatim (§8.2). */
const migrationRetryRecoveryPayloadSchema = z.strictObject({
  migrationActionId: uuidv7Schema,
});

// ---------------------------------------------------------------------------
// designSystem.list / preview / install / publish (project-design-systems §8.1/§10.1
// Wave 3 / P10) — the picker overlay's four commands, modelled on `export.start`.
// ---------------------------------------------------------------------------

/** `designSystem.list`: empty, matching `export.start`/`chat.create`'s own "no input" shape. */
const designSystemListPayloadSchema = z.strictObject({});

/**
 * `designSystem.preview`: the canonical `source:system@version` reference text
 * (`entities/design-system-ref`'s `formatDesignSystemRef`/`parseDesignSystemRef` own that
 * format; this schema only checks non-empty — the real parse, and its failure, happen in the
 * Kernel handler so a malformed ref becomes a real `designSystem.previewFailed`, never a
 * decode-time protocol error indistinguishable from a client bug).
 */
const designSystemPreviewPayloadSchema = z.strictObject({
  ref: z.string().min(1),
});

/**
 * `designSystem.install`: `installId`, a previously previewed preparation's id. Decision D4
 * fixes it as a UUIDv7 minted by `prepareDesignSystemInstall`'s `newInstallId()`.
 */
const designSystemInstallPayloadSchema = z.strictObject({
  installId: uuidv7Schema,
});

/** `designSystem.publish`: the configured source's id to publish the project's own system to. */
const designSystemPublishPayloadSchema = z.strictObject({
  sourceId: z.string().min(1),
});

/**
 * The closed `CommandPayloadByKindV1` schema map (§8.2). `satisfies` (not a type
 * annotation) checks completeness/no-excess against `CommandKindV1` while keeping each
 * value's precise literal schema type, so {@link CommandPayloadByKindV1} below can derive
 * per-kind payload types through `z.infer` without a second, drift-prone declaration.
 */
export const commandPayloadSchemas = {
  "project.create": projectCreatePayloadSchema,
  "project.open": projectOpenPayloadSchema,
  "project.retryOpen": projectRetryOpenPayloadSchema,
  "project.close": projectClosePayloadSchema,
  "project.setTrust": projectSetTrustPayloadSchema,
  "turn.start": turnStartPayloadSchema,
  "turn.cancel": turnCancelPayloadSchema,
  "chat.create": chatCreatePayloadSchema,
  "chat.switch": chatSwitchPayloadSchema,
  "chat.load-older": chatLoadOlderPayloadSchema,
  "model.select": modelSelectPayloadSchema,
  "page.renameTitle": pageRenameTitlePayloadSchema,
  "page.removePlan": pageRemovePlanPayloadSchema,
  "page.removeConfirm": pageRemoveConfirmPayloadSchema,
  "page.removeDiscardPlan": pageRemoveDiscardPlanPayloadSchema,
  "page.reorder": pageReorderPayloadSchema,
  "history.open": historyOpenPayloadSchema,
  "preview.selectPage": previewSelectPagePayloadSchema,
  "preview.selectHistorical": previewSelectHistoricalPayloadSchema,
  "preview.selectCurrent": previewSelectCurrentPayloadSchema,
  "preview.resize": previewResizePayloadSchema,
  "preview.setThemeCapabilities": previewSetThemeCapabilitiesPayloadSchema,
  "preview.setMode": previewSetModePayloadSchema,
  "preview.forwardInput": previewForwardInputPayloadSchema,
  "preview.setTweak": previewSetTweakPayloadSchema,
  "preview.queryGeometry": previewQueryGeometryPayloadSchema,
  "preview.retry": previewRetryPayloadSchema,
  "preview.close": previewClosePayloadSchema,
  "selection.set": selectionSetPayloadSchema,
  "selection.clear": selectionClearPayloadSchema,
  "pin.create": pinCreatePayloadSchema,
  "pin.setStatus": pinSetStatusPayloadSchema,
  "restore.plan": restorePlanPayloadSchema,
  "restore.confirm": restoreConfirmPayloadSchema,
  "restore.discardPlan": restoreDiscardPlanPayloadSchema,
  "restore.retryRecord": restoreRetryRecordPayloadSchema,
  "commit.plan": commitPlanPayloadSchema,
  "commit.confirm": commitConfirmPayloadSchema,
  "commit.discardPlan": commitDiscardPlanPayloadSchema,
  "export.start": exportStartPayloadSchema,
  "migration.plan": migrationPlanPayloadSchema,
  "migration.confirm": migrationConfirmPayloadSchema,
  "migration.discardPlan": migrationDiscardPlanPayloadSchema,
  "migration.retryRecovery": migrationRetryRecoveryPayloadSchema,
  "designSystem.list": designSystemListPayloadSchema,
  "designSystem.preview": designSystemPreviewPayloadSchema,
  "designSystem.install": designSystemInstallPayloadSchema,
  "designSystem.publish": designSystemPublishPayloadSchema,
} satisfies Readonly<Record<CommandKindV1, z.ZodType>>;

/**
 * The type-level twin of {@link commandPayloadSchemas}, derived through `z.infer` so the
 * runtime map and the compile-time map cannot drift apart.
 */
export type CommandPayloadByKindV1 = {
  readonly [K in CommandKindV1]: z.infer<(typeof commandPayloadSchemas)[K]>;
};

/** Fetches the payload schema for one command kind — the single indexing point callers use. */
export function commandPayloadSchemaFor<K extends CommandKindV1>(
  kind: K,
): (typeof commandPayloadSchemas)[K] {
  return commandPayloadSchemas[kind];
}
