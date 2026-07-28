// The project's two TOML files and its generated ignore file — the portable/local split of
// storage-identity §5.1 and §6.1, plus the §13 / turn-durability §3.1 exclusion mirror.
//
// The split is the point: `project.toml` carries identity, display name, creation time,
// target stack, and page order and NOTHING else, so moving machines never produces a
// workspace-navigation or backend-preference diff (§5.1, §16.1). Everything machine-local
// — active page/chat, backend/model/effort, preview and UI state, session checkpoints, and
// the typed resource-limit overrides — lives in `workspace.local.toml`, which is
// hard-excluded from every Git commit scope. Nothing decoded from the local file can reach
// the portable one: the two strict schemas share no field.
//
// Both decoders check `format_version` BEFORE the field schema, so a newer file reports a
// hard too-new error naming the file (§12) rather than a misleading shape complaint.
//
// Serialization is hand-written: Bun exposes `Bun.TOML.parse` but no TOML writer, and the
// field set here is small and closed, so a deterministic encoder beats a new dependency.
export type {
  ColorCapability,
  PreviewSizeMode,
  PreviewSizePreset,
  ProjectManifest,
  RenderMode,
  ResourceLimitOverrides,
  SessionCheckpoint,
  TargetStack,
  WorkspaceLocalState,
} from "./types";
export { COLOR_CAPABILITIES, PREVIEW_SIZE_PRESETS, TARGET_STACKS } from "./types";

export {
  ManifestCorruptError,
  ManifestMigrationRequiredError,
  ManifestTooNewError,
  PROJECT_MANIFEST_FILENAME,
  PROJECT_MANIFEST_FORMAT_VERSION,
  decodeProjectManifest,
  encodeProjectManifest,
  encodeTomlString,
  parseToml,
  readFormatVersion,
  tomlLine,
} from "./model/project-toml";

export type { WorkspaceStateLoad } from "./model/workspace-toml";
export {
  WORKSPACE_STATE_FILENAME,
  WORKSPACE_STATE_FORMAT_VERSION,
  WorkspaceStateCorruptError,
  WorkspaceStateTooNewError,
  decodeWorkspaceLocalState,
  defaultWorkspaceLocalState,
  encodeWorkspaceLocalState,
  loadWorkspaceLocalState,
} from "./model/workspace-toml";

export {
  PROJECT_GITIGNORE_FILENAME,
  PROJECT_GITIGNORE_RULES,
  renderProjectGitignore,
} from "./model/gitignore";
