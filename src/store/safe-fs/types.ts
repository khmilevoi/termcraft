import type { WorkspaceChangedDuringSnapshotError } from "./model/candidate";
import type {
  IdentityChangedError,
  LeafRejectedError,
  UnsafeHardlinkError,
} from "./model/leaf-identity";
import type { StorageLimitExceededError, UnknownNamespaceError } from "./model/limits";
import type { FsAccessError, PathEscapeError, ReparsePointRejectedError } from "./model/no-follow";
import type { NameCollisionError, PathRuleError } from "./model/path-rules";

/**
 * Which opened root a `SafeProjectFs` is anchored at (turn-durability §5): the project's
 * `.termcraft` directory, a turn workspace, a transaction candidate, an export candidate,
 * or a migration backup. The root kind selects both the namespace grammar (§5.4) and the
 * aggregate limit row (§5.3) — a name legal in a turn workspace is not legal under
 * `.termcraft`, and vice versa.
 *
 * `"project-migration"` is `"project"` for the duration of ONE migration and nothing else: its
 * grammar is `classifyProject`'s plus the retired format-1 `pages/<slug>/` shape, so the
 * mechanical track (design-tree §12.2) can read the old files and delete them inside the same
 * transaction that writes their replacements. It is deliberately a separate kind rather than a
 * widening of `classifyProject`: the retired names must never become legal for the live project
 * root again, and a root kind is the narrowest scope this module can give them.
 */
export type ManagedRootKind =
  | "project"
  | "project-migration"
  | "workspace"
  | "candidate"
  | "export-candidate"
  | "backup";

/**
 * A managed namespace — one row of the turn-durability §5.3 limit table. Every managed
 * leaf classifies into exactly one; a leaf that classifies into none is "outside each
 * managed namespace's grammar" (§5.1) and is rejected.
 *
 * `design-source` covers the whole authored design tree at BOTH the `.termcraft` project
 * root and a turn workspace/candidate root (multi-file design tree design §3.1/§10): the
 * workspace tree is a 1:1 copy of the canonical one, so one namespace — and one grammar —
 * serves both roots. It replaces the retired `canonical-page`, `agent-page-source`, and
 * `agent-manifest` namespaces, which named the single-file-per-page layout this plan
 * retires.
 */
export type ManagedNamespace =
  | "design-source"
  | "agent-runtime-doc"
  | "project-config"
  | "chat-jsonl"
  | "comments-jsonl"
  | "export-artifact"
  | "transaction-payload"
  | "migration-backup";

/**
 * The subset of `lstat` the §5.2 identity and type rules read. Read with
 * `{ bigint: true }` — a Windows file id is 64-bit and is not safely representable as a
 * JS number (Spike F, `docs/spikes/06-win-fs-identity/FINDINGS.md`).
 */
export interface SafeFsStat {
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly isSymbolicLink: boolean;
  /** FIFO, socket, character device, or block device — any non-regular, non-directory file. */
  readonly isSpecial: boolean;
  readonly nlink: number;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: number;
  readonly mtimeNs: bigint;
}

/**
 * The impure boundary the no-follow walk needs. Injected so the hostile tests can drive
 * platform-special files (FIFO, socket, device) that cannot be created on Windows, while
 * the real bindings (`nodeSafeFsDeps`) run against the actual filesystem.
 */
export interface NoFollowDeps {
  readonly lstat: (absPath: string) => SafeFsStat | FsAccessError;
  readonly realpath: (absPath: string) => string | FsAccessError;
  /**
   * The tag-agnostic reparse-point backstop (`infrastructure/fs-guard`, Spike F). On a
   * non-Windows host it returns `FsGuardUnavailableError`; the walk then relies on
   * `lstat().isSymbolicLink` plus the realpath escape check, which is complete on POSIX.
   */
  readonly isReparsePoint: (absPath: string) => boolean | Error;
}

/** `NoFollowDeps` plus the reads a `SafeProjectFs` performs on behalf of its callers. */
export interface SafeProjectFsDeps extends NoFollowDeps {
  readonly readFile: (absPath: string) => Uint8Array | FsAccessError;
  readonly readdir: (absPath: string) => readonly string[] | FsAccessError;
  /** Read exactly `[start, end)` bytes without materializing the whole file — the primitive `ChatStore.open`'s bounded-tail reads need (projections §16.1/§16.3). */
  readonly readRange: (absPath: string, start: number, end: number) => Uint8Array | FsAccessError;
}

/**
 * An opened managed root. `realPath` is resolved once at open time and `identity` is the
 * root's filesystem identity recorded at the same moment; every later resolution is
 * anchored at `realPath` and re-checks `identity`, so a root swapped underneath the
 * process is caught rather than followed.
 *
 * DIVERGENCE (documented, not silent): turn-durability §5.1 says each component is
 * "opened relative to the already opened parent". Node/Bun expose no `openat`/`dirfd`
 * and Windows has no `O_NOFOLLOW` (Spike G), so the faithful mapping is a recorded root
 * identity plus a per-component `lstat`+reparse check before each descent. The residual
 * TOCTOU window is the one Spike G records as accepted, not closed.
 */
export interface ManagedRoot {
  readonly kind: ManagedRootKind;
  readonly realPath: string;
  readonly identity: string;
}

/**
 * The mandatory managed-filesystem capability (turn-durability §5). Callers pass only
 * relative paths; no caller performs direct `Bun.file`, Node filesystem, or string-joined
 * managed-path access. Every method returns an errore union — a rejection is a value.
 */
export interface SafeProjectFs {
  readonly root: ManagedRoot;
  /** Validate a managed relative path and resolve it against the opened root. */
  resolve(relPath: string): SafeFsError | string;
  /** Read a managed leaf, enforcing the §5.2 type rules and the §5.3 per-file limit. */
  readFile(relPath: string): SafeFsError | Uint8Array;
  /** Stat a managed leaf's current size without reading its content — the bounded-scan callers (`ChatStore.open`) need the file's current length before deciding how many new bytes to read (projections §16.1). */
  stat(relPath: string): SafeFsError | { readonly size: number };
  /** Read exactly `[start, end)` bytes of a managed leaf, enforcing the same §5.2 type rules and §5.3 per-file limit as {@link readFile} but without ever materializing bytes outside the requested range. */
  readRange(relPath: string, start: number, end: number): SafeFsError | Uint8Array;
  /** List a managed directory; rejects NFC/case-fold colliding names (§5.1). */
  list(relDir: string): SafeFsError | readonly string[];
}

/**
 * Any rejection `store/safe-fs` can return — a `_tag`-discriminated union. Filesystem
 * safety passing never implies Gate validity, and Gate validity never bypasses this
 * union (turn-durability §5.4).
 */
export type SafeFsError =
  | PathRuleError
  | NameCollisionError
  | UnknownNamespaceError
  | StorageLimitExceededError
  | LeafRejectedError
  | UnsafeHardlinkError
  | IdentityChangedError
  | ReparsePointRejectedError
  | PathEscapeError
  | WorkspaceChangedDuringSnapshotError
  | FsAccessError;
