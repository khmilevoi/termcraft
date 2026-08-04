/**
 * The `migrate-80` dialog's whole input (design §12.1). A VIEW MODEL, not a `MigrationPlanV1`: the
 * `ui` ring does not import `store`, and the dialog needs three numbers and a path, not a plan.
 */
export interface MigratePromptViewV1 {
  readonly pageCount: number;
  readonly pinLogCount: number;
  /** `{userStateRoot}/backups/<projectId>` — shown verbatim, truncated from the left if long. */
  readonly backupsDir: string;
}
