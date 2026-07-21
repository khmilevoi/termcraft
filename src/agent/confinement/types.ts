export type PermissionResultLike =
  | { readonly behavior: "allow" }
  | { readonly behavior: "deny"; readonly message: string };

/**
 * The vendor tool vocabulary a confinement policy is parameterized over
 * (master §6.1 confinement; Spike H). Each backend (Claude Code today, a
 * future Codex backend later) supplies its OWN tables — the tool names and
 * path-field names a backend's tool-use protocol uses are backend-specific,
 * while the deny-by-default RULE below them is not.
 */
export interface ConfinementTables {
  /** File tools whose primary path argument must stay inside staging. */
  readonly fileTools: ReadonlySet<string>;
  /** Tools denied outright regardless of arguments. */
  readonly deniedTools: ReadonlySet<string>;
  /** File tools whose path argument is optional, defaulting to the process cwd. */
  readonly optionalPathTools: ReadonlySet<string>;
  /** Field names, in order, that carry a tool's primary path argument. */
  readonly pathFields: readonly string[];
}
