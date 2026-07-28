import * as errore from "errore";

/** The one legal BARE specifier anywhere in the tree (design §6 rule 1; runtime-api §3.1). */
export const RUNTIME_ROOT_SPECIFIER = "@termcraft/runtime";

/**
 * The complete extension probe list for an extensionless relative specifier, in order
 * (design §6). Two entries, tried left to right, and nothing else — no `.js`, no `.jsx`,
 * no `.json`, and no directory index.
 */
export const RESOLUTION_EXTENSIONS = [".tsx", ".ts"] as const;

export type SpecifierRejectionCodeV1 =
  | "ESCAPES_TREE"
  | "QUERY_OR_FRAGMENT"
  | "BARE_SPECIFIER"
  | "UNRESOLVED"
  | "BACKSLASH";

/**
 * A module specifier the design's §6 import surface refuses. Fatal at BOTH enforcement
 * points: the Gate's authoritative allowlist and the host's pre-mount rescan. Carried as a
 * value so each caller renders it in its own vocabulary (a `GateError`, a `ProtocolError`).
 */
export class SpecifierRejectedError extends errore.createTaggedError({
  name: "SpecifierRejectedError",
  message: 'specifier "$specifier" in $from is rejected [$code]: $reason',
}) {}

export type ResolvedSpecifierV1 =
  | { readonly kind: "runtime" }
  | { readonly kind: "file"; readonly relPath: string };

/**
 * Normalize a POSIX-style relative path, collapsing `.` and `..` WITHOUT touching disk.
 * Returns `null` when the path climbs above its root — the caller turns that into
 * `ESCAPES_TREE`. `node:path` is deliberately not used: `path.posix.normalize` keeps leading
 * `../` segments rather than reporting the escape, and `path.normalize` is platform-flavoured.
 */
function normalizeRelative(segments: readonly string[]): string[] | null {
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment !== "..") {
      out.push(segment);
      continue;
    }
    if (out.length === 0) return null;
    out.pop();
  }
  return out;
}

function reject(
  input: { from: string; specifier: string },
  code: SpecifierRejectionCodeV1,
  reason: string,
): SpecifierRejectedError {
  return new SpecifierRejectedError({ from: input.from, specifier: input.specifier, code, reason });
}

/**
 * Resolve one authored module specifier against the tree (design §6).
 *
 * Exactly two edges are legal: a STATIC import of the bare `@termcraft/runtime`, and a
 * RELATIVE specifier resolving to a real file inside `design/`. Everything else is refused,
 * including a runtime SUBPATH (`@termcraft/runtime/ui`), a `node:` builtin, and a
 * root-relative path.
 *
 * `from` is the importer's TREE-relative path; `has` answers whether a tree-relative path
 * names a real file in the inventory. This function performs no I/O and knows nothing about
 * symlinks — the reparse/junction check (design §6) belongs to whoever turns a tree-relative
 * path into an absolute one, i.e. `store/safe-fs`'s `no-follow.ts` (Task 8 and Task 15).
 *
 * PRECONDITION on `from`: it must already be a tree-relative, forward-slash path — the same
 * shape `findUnresolvedEntries` and a prior successful resolution both produce. This function
 * does not validate it (that would widen the contract beyond §6, which only ever speaks about
 * the SPECIFIER); a malformed `from` is a caller bug, not a specifier the design forbids.
 * `entities/design-tree`'s own `entryPathSchema` already rejects a backslash or a leading `/`
 * before a `from` could ever originate from a manifest entry.
 */
export function resolveDesignSpecifier(input: {
  readonly from: string;
  readonly specifier: string;
  readonly has: (relPath: string) => boolean;
}): SpecifierRejectedError | ResolvedSpecifierV1 {
  const { from, specifier } = input;

  if (specifier === RUNTIME_ROOT_SPECIFIER) return { kind: "runtime" };

  if (specifier.includes("\\"))
    return reject({ from, specifier }, "BACKSLASH", "a specifier must use forward slashes");

  // `.` and `..` are themselves valid relative specifiers in ESM — classifying them as a BARE
  // specifier below would be a false claim. Both are handled honestly further down: `.` is
  // caught by the directory-form check (it names the importer's own directory), and `..` is
  // caught by normalization landing exactly at the tree root.
  const isRelative =
    specifier === "." ||
    specifier === ".." ||
    specifier.startsWith("./") ||
    specifier.startsWith("../");
  if (!isRelative) {
    return reject(
      { from, specifier },
      "BARE_SPECIFIER",
      `only "${RUNTIME_ROOT_SPECIFIER}" and relative specifiers are allowed`,
    );
  }

  if (specifier.includes("?") || specifier.includes("#")) {
    return reject(
      { from, specifier },
      "QUERY_OR_FRAGMENT",
      "a specifier carries no query string or fragment",
    );
  }

  // A specifier whose LAST segment is empty (a trailing slash, e.g. `./calendar.tsx/`) or a
  // bare `.` (e.g. `./`, `./.`) names a directory, never a file. Reject it before normalization
  // would otherwise silently drop that trailing segment and probe the importer's own directory
  // as if it were a file basename — the permissive default §6 forbids on this perimeter. A
  // trailing `..` is deliberately NOT included here: it is not a directory-form typo, it is a
  // real traversal step, and normalization below already gives it an honest outcome (it either
  // lands inside the tree on a real segment, lands exactly on the tree root, or escapes).
  const specifierSegments = specifier.split("/");
  const lastSpecifierSegment = specifierSegments[specifierSegments.length - 1] ?? "";
  if (lastSpecifierSegment === "" || lastSpecifierSegment === ".") {
    return reject(
      { from, specifier },
      "UNRESOLVED",
      `"${specifier}" names a directory, not a file; there is no directory-index resolution`,
    );
  }

  // The importer's directory, then the specifier's own segments, normalized as one path.
  const fromSegments = from.split("/");
  fromSegments.pop();
  const normalized = normalizeRelative([...fromSegments, ...specifier.split("/")]);
  if (normalized === null)
    return reject({ from, specifier }, "ESCAPES_TREE", "resolves outside design/");
  if (normalized.length === 0)
    return reject(
      { from, specifier },
      "ESCAPES_TREE",
      "resolves to the design/ root itself, not a file inside it",
    );

  const base = normalized.join("/");
  if (input.has(base)) return { kind: "file", relPath: base };

  // Extensionless: probe exactly `.tsx`, then `.ts`, and stop. Only when the specifier has no
  // extension of its own — an explicit `./theme.js` must NOT silently become `./theme.js.ts`.
  const last = normalized[normalized.length - 1] ?? "";
  if (!last.includes(".")) {
    for (const extension of RESOLUTION_EXTENSIONS) {
      const candidate = `${base}${extension}`;
      if (input.has(candidate)) return { kind: "file", relPath: candidate };
    }
  }

  return reject(
    { from, specifier },
    "UNRESOLVED",
    `no file at "${base}" (probed ${RESOLUTION_EXTENSIONS.join(", ")}; there is no directory-index resolution)`,
  );
}
