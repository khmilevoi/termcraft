// `store/design-systems` — the per-user design-system library and the sources that fill it
// (project-design-systems design §8). The library lives under `{userStateRoot}/design-systems/`,
// OUTSIDE every project, beside the trust ledger and the turn sandboxes; the one stage-1 source
// is a local directory, implemented THROUGH the port so a GitHub adapter can join it without
// changing the port (§8.6).
export type { AbsPath, PackageFile, Sha256Hex } from "./types";

export {
  CACHE_DIRNAME,
  CACHE_ENTRY_RECORD_FILENAME,
  CACHE_PACKAGE_DIRNAME,
  DESIGN_SYSTEMS_DIRNAME,
  LOCAL_LIBRARY_DIRNAME,
  LOCAL_SOURCE_ID,
  LOCAL_SOURCE_LABEL,
  MANIFEST_FILENAME,
  SOURCES_CONFIG_FILENAME,
  cacheEntryDir,
  cacheEntryRecordPath,
  cachePackageDir,
  cacheRootDir,
  decodeSourceIdSegment,
  designSystemsRoot,
  encodeSourceIdSegment,
  localLibraryDir,
  localSystemDir,
  sourcesConfigPath,
} from "./model/layout";
export {
  DESIGN_SYSTEM_PACKAGE_V1_PREFIX,
  DuplicatePackageFileError,
  designSystemContentHash,
  encodeDesignSystemPackageV1,
  normalizePackageRelPath,
} from "./model/content-hash";
export type { DesignSystemFsDeps, DirEntry, PackageAdmission } from "./types";
export {
  DesignSystemPackageInvalidError,
  DesignSystemPackageTooLargeError,
  DesignSystemPublishRefusedError,
  DesignSystemRefRejectedError,
  DesignSystemSourceIoError,
  SourcesConfigInvalidError,
} from "./model/errors";
export type { SourceError } from "./model/errors";
export { allowAllPackageAdmission, nodeDesignSystemFsDeps } from "./model/fs-deps";
export type { ConfiguredSourceV1, SourcesConfigV1 } from "./model/sources-config";
export {
  BUILT_IN_LOCAL_SOURCE,
  DEFAULT_SOURCES_CONFIG,
  MAX_SOURCES_CONFIG_BYTES,
  SOURCES_CONFIG_SCHEMA_VERSION,
  decodeSourcesConfig,
  encodeSourcesConfig,
  readSourcesConfig,
  writeSourcesConfig,
} from "./model/sources-config";
export type { CacheEntryRecordV1 } from "./model/cache-entry";
export {
  CACHE_ENTRY_SCHEMA_VERSION,
  decodeCacheEntryRecord,
  encodeCacheEntryRecord,
  readCacheEntryRecord,
  writeCacheEntryRecord,
} from "./model/cache-entry";
export type { DesignSystemSummary, TokenSwatch } from "./types";
export { readDesignSystemSummary } from "./model/summary";
export type { LocalDesignSystemSourceDeps } from "./types";
export { listLocalSystems } from "./model/list";
export type { FetchedPackage } from "./types";
export { fetchLocalPackage } from "./model/fetch";
export { readPackageDirectory } from "./model/walk";
export type { LocalPackage, PublishReceipt } from "./types";
export { publishLocalPackage } from "./model/publish";
export type { DesignSystemSource } from "./types";
export { createLocalDesignSystemSource } from "./model/local-source";
