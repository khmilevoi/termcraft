// `store/migration` — storage-identity §12's migration-safety machinery: the (currently
// empty) live migration chain plus its shared format-counter gate, and the §12 /
// turn-durability §11 verified-backup protocol every durable file kind's first rewrite
// must complete before target rewrites are even planned.
//
// The version-1 -> version-2 migration (design-tree design §12) ships here: `model/legacy-scan.ts`
// is the system's ONLY reader of the retired `pages/<slug>/` layout, `model/v1-to-v2.ts` turns
// that reading into one transaction's operations, and `MIGRATION_CHAIN` names the step.
export type {
  AbsPath,
  BackupFileInput,
  BackupManifest,
  BackupManifestFileEntry,
  BackupStore,
  BackupStoreDeps,
  CreateBackupInput,
  FormatCounterField,
  MigrationError,
  MigrationRegistry,
  MigrationStep,
  Sha256Hex,
  VerifiedBackup,
} from "./types";

export {
  DataFormatTooNewError,
  MIGRATION_CHAIN,
  NoMigrationPathError,
  checkFormatCounter,
  createMigrationRegistry,
  findMigrationSteps,
  migrationRegistry,
  readFormatCounter,
} from "./model/registry";

export {
  BACKUPS_DIR_NAME,
  BACKUP_MANIFEST_FILENAME,
  BACKUP_MANIFEST_SCHEMA_VERSION,
  BACKUP_VERIFIED_FILENAME,
  MigrationBackupFailedError,
  MigrationIoError,
  MigrationStaleError,
  backupActionDir,
  backupManifestPath,
  backupVerifiedMarkerPath,
  backupsRootDir,
  createBackupStore,
  nodeBackupStoreDeps,
  projectBackupsDir,
} from "./model/backup-store";

export type { LegacyPageV1, LegacyProjectV1 } from "./types";
export {
  LEGACY_PROJECT_FORMAT_VERSION,
  LegacyScanError,
  legacyPinsPath,
  legacySourcePath,
  scanLegacyProject,
} from "./model/legacy-scan";
export type { LegacyScanCodeV1 } from "./model/legacy-scan";

export type { MigrationMoveV1, MigrationPlanV1 } from "./types";
export { PROJECT_TOML_MIGRATION_KIND } from "./model/registry";
export { migratedPinsPath, migratedSourcePath, planV1ToV2 } from "./model/v1-to-v2";

export type { V1ToV2OperationsV1 } from "./model/v1-to-v2";
export { buildV1ToV2Operations } from "./model/v1-to-v2";

// The version-2 -> version-3 migration (design-systems §9): `model/format-two-scan.ts` is the
// system's ONLY reader of the retired format-2 manifest schema, `model/v2-to-v3.ts` turns that
// reading into one transaction's operations that seed `design/system/`, and `MIGRATION_CHAIN`
// (`model/registry.ts`) names the step.
export type { FormatTwoProjectV1 } from "./types";
export {
  FORMAT_TWO_PROJECT_VERSION,
  FormatTwoScanError,
  scanFormatTwoProject,
} from "./model/format-two-scan";
export type { FormatTwoScanCodeV1 } from "./model/format-two-scan";

export type { V2ToV3OperationsV1 } from "./model/v2-to-v3";
export { buildV2ToV3Operations, planV2ToV3 } from "./model/v2-to-v3";
