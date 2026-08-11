// `store/design-systems` — the per-user design-system library and the sources that fill it
// (project-design-systems design §8). The library lives under `{userStateRoot}/design-systems/`,
// OUTSIDE every project, beside the trust ledger and the turn sandboxes; the one stage-1 source
// is a local directory, implemented THROUGH the port so a GitHub adapter can join it without
// changing the port (§8.6).
export type { AbsPath, Sha256Hex } from "./types";

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
