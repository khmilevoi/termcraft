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
  /**
   * Tools that are ALLOWED and carry no path to resolve. Deliberately a third set rather than a
   * `fileTools` member with an optional path: `optionalPathTools` means "the path defaults to the
   * cwd", which is a statement about a path argument that exists. These tools have none, and
   * their confinement is inherent — `check_design` runs in-process against the turn workspace the
   * adapter already holds, so there is no argument through which a caller could aim it elsewhere.
   *
   * Deny-by-default is unchanged (`policy.ts`): a tool absent from every set is still refused, so
   * this set widens the allowlist by exactly its own membership and nothing more.
   */
  readonly pathlessAllowedTools: ReadonlySet<string>;
  /** Field names, in order, that carry a tool's primary path argument. */
  readonly pathFields: readonly string[];
}
