// `ui/setup` — the SETUP TIER (design-tree design §12.1): dialogs shown before a workspace exists,
// never layered over one. `migrate-80` is its first member; `wizard-80` (the first-run setup
// wizard, still unimplemented) belongs here too when it lands.
export type { MigratePromptViewV1 } from "./types";
export type { MigratePromptProps } from "./ui/MigratePrompt";
export { MigratePrompt, migrateBullets } from "./ui/MigratePrompt";
export type { MigrationChoiceV1 } from "./model/migration-root";
export { createMigrationRoot, migrationChoiceForKey } from "./model/migration-root";
