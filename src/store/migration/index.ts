// `store/migration` — storage-identity §12's migration-safety machinery: the (currently
// empty) live migration chain plus its shared format-counter gate, and the §12 /
// turn-durability §11 verified-backup protocol every durable file kind's first rewrite
// must complete before target rewrites are even planned.
//
// No shipped migration exists yet — `MIGRATION_CHAIN` is empty and `registry.test.ts`
// asserts it stays that way. `BackupStore` and `MigrationStaleError` are exercised end to
// end (backup → verify → transform → `store/transaction`'s `MigrationTransaction`) by a
// synthetic, test-only migration in `backup-store.test.ts` — MVP wires no production
// caller, matching `store/transaction`'s own "infrastructure only" note on
// `buildMigrationTransaction`.
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
} from "./types"

export { DataFormatTooNewError, MIGRATION_CHAIN, NoMigrationPathError, checkFormatCounter, createMigrationRegistry, findMigrationSteps, migrationRegistry, readFormatCounter } from "./model/registry"

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
} from "./model/backup-store"
