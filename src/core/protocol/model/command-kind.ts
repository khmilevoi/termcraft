import { z } from "zod";

/**
 * The authoritative v1 intent registry (kernel-command-contract §8.1/§8.2). This union
 * is CLOSED: §2.12 fixes `CommandKindV1` as a closed protocol-v1 union, and §8.2 permits
 * a new kind "only with a protocol-schema change, guard, capability mapping,
 * transition-table entry, and contract tests".
 *
 * The list is transcribed verbatim from §8.1 in its declared order. Its length is
 * asserted at 48 by the closure test so a member cannot be silently added or dropped.
 * (44 -> 48, project-design-systems §8.1/§10.1 Wave 3 / P10: the four `designSystem.*`
 * commands below.)
 *
 * `CapabilityId` is exactly this union (§10.1) — the identity is enforced as a
 * compile-time check in `core/capabilities`, not restated as a second list.
 */
export const COMMAND_KINDS_V1 = [
  "project.create",
  "project.open",
  "project.retryOpen",
  "project.close",
  "project.setTrust",
  "turn.start",
  "turn.cancel",
  "chat.create",
  "chat.switch",
  "chat.load-older",
  "model.select",
  "page.renameTitle",
  "page.removePlan",
  "page.removeConfirm",
  "page.removeDiscardPlan",
  "page.reorder",
  "history.open",
  "preview.selectPage",
  "preview.selectHistorical",
  "preview.selectCurrent",
  "preview.resize",
  "preview.setThemeCapabilities",
  "preview.setMode",
  "preview.forwardInput",
  "preview.setTweak",
  "preview.queryGeometry",
  "preview.retry",
  "preview.close",
  "selection.set",
  "selection.clear",
  "pin.create",
  "pin.setStatus",
  "restore.plan",
  "restore.confirm",
  "restore.discardPlan",
  "restore.retryRecord",
  "commit.plan",
  "commit.confirm",
  "commit.discardPlan",
  "export.start",
  "migration.plan",
  "migration.confirm",
  "migration.discardPlan",
  "migration.retryRecovery",
  // project-design-systems §8.1/§10.1 Wave 3 / P10: the picker overlay's four commands,
  // modelled on `export.start`'s single-command-family shape. Appended after the closed
  // §8.1 union rather than interleaved, matching how `chat.load-older` was appended for the
  // chat-scroll spec.
  "designSystem.list",
  "designSystem.preview",
  "designSystem.install",
  "designSystem.publish",
] as const;

export type CommandKindV1 = (typeof COMMAND_KINDS_V1)[number];

/**
 * The exact member count §8.1 fixes. A drifted union fails the closure test, not a
 * review. 43 -> 44 (chat-scroll spec §6.1): `chat.load-older` asks for the page of
 * records before a cursor the client was previously given. It is a command, not a plain
 * read, because it crosses the same guard/capability boundary every other chat operation
 * does, and its answer travels as an event for the same reason `chat.records` does —
 * `AcceptedCommandV1` is a closed object with no payload slot.
 *
 * 44 -> 48 (project-design-systems §8.1/§10.1 Wave 3 / P10): `designSystem.list`/`preview`/
 * `install`/`publish` drive the picker overlay — listing configured sources, previewing an
 * installable candidate through quarantine -> immutable candidate -> whole-tree Gate,
 * committing a previously previewed preparation, and publishing the project's own system
 * back to a source. Modelled on `export.start`'s `launchOperation` shape.
 */
export const COMMAND_KIND_COUNT = 48;

const COMMAND_KIND_SET: ReadonlySet<string> = new Set(COMMAND_KINDS_V1);

/** True when `raw` names a v1 command kind. */
export function isCommandKindV1(raw: string): raw is CommandKindV1 {
  return COMMAND_KIND_SET.has(raw);
}

/** Zod schema over the closed union. */
export const commandKindV1Schema = z.enum(COMMAND_KINDS_V1);

/**
 * The command family a kind belongs to. Families own one pure guard each (§10.2:
 * "Each command family owns a pure guard over exactly
 * `(currentKernelState, CapabilityTargetByKindV1[K])`"), so the split is behavioural,
 * not cosmetic — it is the unit the guard registry and the capability projector index by.
 */
export const COMMAND_FAMILIES_V1 = [
  "project",
  "turn",
  "chat",
  "model",
  "page",
  "history",
  "preview",
  "selection",
  "pin",
  "restore",
  "commit",
  "export",
  "migration",
  // project-design-systems §8.1/§10.1 Wave 3 / P10.
  "designSystem",
] as const;

export type CommandFamilyV1 = (typeof COMMAND_FAMILIES_V1)[number];

/**
 * Extracts the family from a kind. Every kind is `family.verb`, so the prefix IS the
 * family — no lookup table can drift out of sync with the union this way.
 */
export function commandFamilyOf(kind: CommandKindV1): CommandFamilyV1 {
  const dot = kind.indexOf(".");
  return kind.slice(0, dot) as CommandFamilyV1;
}
