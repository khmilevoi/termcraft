/**
 * The `migrate-80` dialog's whole input (design §12.1; design-systems §9). A VIEW MODEL, not a
 * `MigrationPlanV1`: the `ui` ring does not import `store`, and the dialog needs a handful of
 * primitives, not a plan.
 */
export interface MigratePromptViewV1 {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly pageCount: number;
  readonly pinLogCount: number;
  /** Whether this migration writes `design/system/` — the version-2 origin's bullet differs from
   *  the version-1 origin's, and both draw from this instead of an inferred version check. */
  readonly seedsDesignSystem: boolean;
  /** `{userStateRoot}/backups/<projectId>` — shown verbatim, truncated from the left if long. */
  readonly backupsDir: string;
}
