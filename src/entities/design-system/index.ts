// The design-system vocabulary (design-systems spec §3.2, §4, §5): the manifest shape, its core
// token roles, the decoder, and component-path resolution against the design tree. No I/O — the
// Gate reads `system/design-system.json` and calls `decodeDesignSystemManifest` (later tasks).
export type {
  CoreTokenRole,
  DesignSystemComponentV1,
  DesignSystemManifestV1,
  DesignSystemThemeV1,
} from "./types";
export {
  CORE_TOKEN_ROLES,
  DESIGN_SYSTEM_DIRNAME,
  DESIGN_SYSTEM_MANIFEST_RELPATH,
  DESIGN_SYSTEM_SCHEMA_VERSION,
} from "./types";
export { DesignSystemManifestInvalidError, decodeDesignSystemManifest } from "./model/manifest";
export {
  designSystemComponentRelPath,
  findUnresolvedComponents,
  isInsideDesignSystem,
} from "./model/components";
export { DESIGN_SYSTEM_TOKENS_RELPATH } from "./types";
export {
  SEED_DESIGN_SYSTEM_ID,
  SEED_DESIGN_SYSTEM_NAME,
  SEED_DESIGN_SYSTEM_VERSION,
  SEED_THEME_ID,
  SEED_THEME_LABEL,
  SEED_TOKENS,
  createSeedManifest,
} from "./model/seed";
export { renderDesignSystemManifest, renderTokensScaffold } from "./model/scaffold";
