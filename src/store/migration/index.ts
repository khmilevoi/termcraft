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
