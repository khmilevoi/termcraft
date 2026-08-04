import * as errore from "errore";

import { parsePageSlug } from "entities/page";

import type { ManagedNamespace, ManagedRootKind } from "../types";
import { MAX_PATH_COMPONENTS } from "./path-rules";

/**
 * A managed action would exceed a turn-durability §5.3 limit. The spec names this
 * `storage_limit_exceeded` and requires the measured and allowed values to be reported —
 * existing oversized managed data opens read-only under this error and is never silently
 * truncated. An action that would exceed a limit fails BEFORE intent.
 */
export class StorageLimitExceededError extends errore.createTaggedError({
  name: "StorageLimitExceededError",
  message: "storage_limit_exceeded: $limit for $path — measured $measured, allowed $allowed",
}) {}

/**
 * A path is legal §5.1 grammar but falls outside every managed namespace of its root
 * (§5.1 "names outside each managed namespace's grammar"; §5.4 "Added files, nested page
 * directories, and any other workspace output are rejected").
 */
export class UnknownNamespaceError extends errore.createTaggedError({
  name: "UnknownNamespaceError",
  message: "$path is outside every managed namespace of a $rootKind root",
}) {}

export const KiB = 1024;
export const MiB = 1024 * 1024;

/** §5.3: the physical JSONL line bound, including the terminating LF. */
export const JSONL_MAX_PHYSICAL_LINE_BYTES = 1_048_576;
/** §5.3: the serialized object bound — one byte less, because the LF is part of the line. */
export const JSONL_MAX_SERIALIZED_OBJECT_BYTES = 1_048_575;

export interface NamespaceLimit {
  readonly perFileBytes: number;
  /** `null` where §5.3 states no count limit for the namespace. */
  readonly maxFiles: number | null;
  /** `null` where §5.3 states no aggregate limit for the namespace. */
  readonly aggregateBytes: number | null;
  /**
   * A namespace-level depth ceiling, tighter than its root's. Present for exactly one
   * namespace: the design tree reuses the WORKSPACE root's depth-8 budget (multi-file design
   * tree design §3.1) even inside the `.termcraft` project root, whose own row has no
   * whole-tree budget and falls back to the §5.1 component ceiling. Without this field the
   * canonical tree would accept a depth the workspace copy of that same tree would reject.
   */
  readonly maxDepth?: number;
}

/** The turn-durability §5.3 limit table, transcribed row for row. */
export const NAMESPACE_LIMITS: Record<ManagedNamespace, NamespaceLimit> = {
  // The authored design tree at BOTH roots (multi-file design tree design §3.1): the
  // workspace root budget — 512 files, 64 MiB total, depth 8 — with the 2 MiB per-file
  // limit the retired `canonical-page` row carried.
  "design-source": { perFileBytes: 2 * MiB, maxFiles: 512, aggregateBytes: 64 * MiB, maxDepth: 8 },
  "agent-runtime-doc": { perFileBytes: 4 * MiB, maxFiles: 32, aggregateBytes: 16 * MiB },
  "project-config": { perFileBytes: 1 * MiB, maxFiles: null, aggregateBytes: 16 * MiB },
  "chat-jsonl": { perFileBytes: 64 * MiB, maxFiles: null, aggregateBytes: null },
  "comments-jsonl": { perFileBytes: 32 * MiB, maxFiles: null, aggregateBytes: null },
  "export-artifact": { perFileBytes: 16 * MiB, maxFiles: 20_000, aggregateBytes: 1024 * MiB },
  "transaction-payload": { perFileBytes: 64 * MiB, maxFiles: null, aggregateBytes: 2048 * MiB },
  "migration-backup": { perFileBytes: 64 * MiB, maxFiles: null, aggregateBytes: 2048 * MiB },
};

export interface RootAggregateLimit {
  readonly maxFiles: number | null;
  readonly totalBytes: number | null;
  readonly maxDepth: number;
}

/**
 * The whole-root rows of §5.3. Only the turn workspace/candidate row is stated as a
 * single tree budget ("512 files, 64 MiB total, depth 8"); an export candidate reuses its
 * per-generation row and a backup its total row. The `.termcraft` project root has no
 * stated whole-tree budget — its namespaces carry their own — so its depth falls back to
 * the §5.1 component ceiling.
 */
export const ROOT_LIMITS: Record<ManagedRootKind, RootAggregateLimit> = {
  project: { maxFiles: null, totalBytes: null, maxDepth: MAX_PATH_COMPONENTS },
  // Identical to `project` by construction: this root is the same `.termcraft` directory, opened
  // for one migration. A tighter budget here would refuse a project the ordinary root accepts.
  "project-migration": { maxFiles: null, totalBytes: null, maxDepth: MAX_PATH_COMPONENTS },
  workspace: { maxFiles: 512, totalBytes: 64 * MiB, maxDepth: 8 },
  candidate: { maxFiles: 512, totalBytes: 64 * MiB, maxDepth: 8 },
  "export-candidate": { maxFiles: 20_000, totalBytes: 1024 * MiB, maxDepth: MAX_PATH_COMPONENTS },
  backup: { maxFiles: null, totalBytes: 2048 * MiB, maxDepth: MAX_PATH_COMPONENTS },
};

/** True iff `name` is `<slug>.<ext>` for a valid page slug (`entities/page` mask). Used by
 * {@link classifyProject}'s `pins/<slug>.jsonl` grammar — e.g. `pins/home.jsonl`. */
function isSlugFile(name: string, ext: string): boolean {
  if (!name.endsWith(ext)) return false;
  return !(parsePageSlug(name.slice(0, -ext.length)) instanceof Error);
}

/**
 * The read-only markdown docs staged at the workspace root (§5.4's "runtime docs"). Kept as
 * one named set because `agent/prompt/model/runtime-docs.ts` stages exactly these names —
 * the two lists must agree, and a bare literal in a condition hides that they are a pair.
 */
const AGENT_DOC_FILES: ReadonlySet<string> = new Set(["RUNTIME.md", "REATOM.md"]);

/**
 * The design tree's directory name. Paired with `entities/design-tree`'s `DESIGN_DIRNAME` —
 * this layer is domain-free and does not import it, so the two must be changed together.
 */
const DESIGN_DIRNAME = "design";

/**
 * The agent workspace / candidate inventory (turn-durability §5.4, as amended by the
 * multi-file design tree design §10). The mutable namespace is the whole `design/**` tree, a
 * 1:1 copy of the canonical one — the flat `pages/<slug>.tsx` + root `pages.json` shape is
 * retired, and `pages.json` now lives INSIDE the tree. {@link AGENT_DOC_FILES} and runtime
 * type declarations remain read-only inputs staged BESIDE the tree at the workspace root,
 * never inside it (design §10).
 *
 * A `.d.ts` is admitted at the ROOT ONLY. `agent/prompt/model/runtime-docs.ts` stages exactly
 * three single-component paths — `runtime.d.ts`, `RUNTIME.md`, `REATOM.md` — so a nested
 * `*.d.ts` is a path nothing produces, and admitting it widened a READ-ONLY namespace for no
 * caller. A declaration the agent authors lives inside `design/` and is `design-source`, which
 * the branch above already answers first.
 */
function classifyWorkspace(components: readonly string[]): ManagedNamespace | null {
  const [first] = components;
  if (first === undefined) return null;

  if (first === DESIGN_DIRNAME) return components.length >= 2 ? "design-source" : null;

  if (components.length !== 1) return null;
  if (AGENT_DOC_FILES.has(first)) return "agent-runtime-doc";
  if (first.endsWith(".d.ts")) return "agent-runtime-doc";
  return null;
}

/**
 * The `.termcraft` inventory (storage-identity §4). The portable block plus the local
 * block; `transactions.local/` is the journal (its own §5.3 row) and `export/generations/`
 * holds export artifacts. Cache, diagnostics, and log entries fall under §5.3's "local
 * TOML/JSON state" row alongside the portable config files.
 */
function classifyProject(components: readonly string[]): ManagedNamespace | null {
  const [first, second] = components;
  if (first === undefined) return null;

  if (components.length === 1) {
    if (first === "project.toml" || first === "workspace.local.toml" || first === ".gitignore")
      return "project-config";
    return null;
  }
  if (first === "chats") {
    if (components.length !== 2 || second === undefined) return null;
    return second.endsWith(".jsonl") ? "chat-jsonl" : null;
  }
  if (first === DESIGN_DIRNAME) return components.length >= 2 ? "design-source" : null;
  if (first === "pins") {
    // `pins/<slug>.jsonl` (design §3) — the append-only pin log, moved out from under the
    // retired `pages/<slug>/` directory so page identity lives in ONE place, the manifest.
    if (components.length !== 2 || second === undefined) return null;
    return isSlugFile(second, ".jsonl") ? "comments-jsonl" : null;
  }
  if (first === "transactions.local") return "transaction-payload";
  if (first === "export") {
    if (components.length === 2 && second === "current.json") return "project-config";
    return second === "generations" ? "export-artifact" : null;
  }
  if (first === "cache" || first === "diagnostics" || first === "logs") return "project-config";
  return null;
}

/**
 * The RETIRED format-1 page layout (`pages/<slug>/page.tsx`, `pages/<slug>/comments.jsonl`),
 * admitted ONLY under the `project-migration` root kind — design-tree §12.1: "no compatibility
 * reader for it exists anywhere in the system ... the old layout is understood by exactly one
 * thing: the migration step itself."
 *
 * Each legacy path maps onto the namespace it migrates INTO rather than getting a budget row of
 * its own: `pages/<slug>/page.tsx` becomes `design/pages/<slug>.tsx` and
 * `pages/<slug>/comments.jsonl` becomes `pins/<slug>.jsonl`, so the bytes are governed here by
 * exactly the limits that will govern them a transaction later. An invented third budget would
 * be a number with no source.
 */
function classifyLegacyProject(components: readonly string[]): ManagedNamespace | null {
  if (components.length !== 3) return null;
  const [first, slug, leaf] = components;
  if (first !== "pages" || slug === undefined || leaf === undefined) return null;
  if (parsePageSlug(slug) instanceof Error) return null;
  if (leaf === "page.tsx") return "design-source";
  if (leaf === "comments.jsonl") return "comments-jsonl";
  return null;
}

/**
 * Map a validated managed relative path to its §5.3 namespace, or reject it as outside
 * every namespace of this root. The root kind decides the grammar: a turn workspace and
 * `.termcraft` deliberately do not accept each other's names.
 */
export function classifyNamespace(
  rootKind: ManagedRootKind,
  relPath: string,
): ManagedNamespace | UnknownNamespaceError {
  const components = relPath.split("/");
  const namespace = (() => {
    if (rootKind === "workspace" || rootKind === "candidate") return classifyWorkspace(components);
    if (rootKind === "project") return classifyProject(components);
    // `?? classifyLegacyProject(...)`, not a replacement: a migration root reads and writes the
    // CURRENT layout too (project.toml, design/**, pins/**, transactions.local/**) in the same
    // transaction that retires the old one.
    if (rootKind === "project-migration")
      return classifyProject(components) ?? classifyLegacyProject(components);
    // An export candidate and a migration backup are whole opaque trees produced by
    // termcraft itself; §5.3 gives each a single row covering every file it holds.
    if (rootKind === "export-candidate") return "export-artifact" as const;
    return "migration-backup" as const;
  })();
  if (namespace === null) return new UnknownNamespaceError({ path: relPath, rootKind });
  return namespace;
}

export interface AdmitFileInput {
  readonly relPath: string;
  readonly namespace: ManagedNamespace;
  /** The size the directory entry claims — the pre-allocation figure. */
  readonly declaredSize: number;
  /** Component count of the path relative to the root. */
  readonly depth: number;
}

export interface ObserveBytesInput {
  readonly relPath: string;
  readonly namespace: ManagedNamespace;
  /** Bytes actually delivered by the stream so far for this file. */
  readonly bytesSoFar: number;
}

/**
 * The §5.3 budget for one managed tree. Limits are "checked before allocation and again
 * while streaming": {@link LimitBudget.admitFile} is the pre-allocation check against the
 * declared size, {@link LimitBudget.observeBytes} is the streaming check against the bytes
 * that actually arrive — which is what catches a source that lied about its size or grew
 * after it was stat-ed.
 */
export interface LimitBudget {
  admitFile(input: AdmitFileInput): StorageLimitExceededError | null;
  observeBytes(input: ObserveBytesInput): StorageLimitExceededError | null;
}

export function createLimitBudget(rootKind: ManagedRootKind): LimitBudget {
  const rootLimit = ROOT_LIMITS[rootKind];
  const namespaceCounts = new Map<ManagedNamespace, number>();
  const namespaceBytes = new Map<ManagedNamespace, number>();
  let fileCount = 0;
  let totalBytes = 0;
  // Keyed by path, not a single "most recently admitted" slot: `snapshotToCandidate`
  // admits the whole tree during enumeration and only then copies it file by file, so by
  // the time `observeBytes` runs for a file that file is almost never the last admitted.
  const declaredSizes = new Map<string, number>();

  const exceeded = (limit: string, path: string, measured: number, allowed: number) =>
    new StorageLimitExceededError({ limit, path, measured, allowed });

  /** Every ceiling that a byte count — declared or streamed — must respect. */
  function checkBytes(input: {
    relPath: string;
    namespace: ManagedNamespace;
    fileBytes: number;
    namespaceTotal: number;
    rootTotal: number;
  }): StorageLimitExceededError | null {
    const nsLimit = NAMESPACE_LIMITS[input.namespace];
    if (input.fileBytes > nsLimit.perFileBytes) {
      return exceeded(
        `${input.namespace} per-file`,
        input.relPath,
        input.fileBytes,
        nsLimit.perFileBytes,
      );
    }
    if (nsLimit.aggregateBytes !== null && input.namespaceTotal > nsLimit.aggregateBytes) {
      return exceeded(
        `${input.namespace} aggregate`,
        input.relPath,
        input.namespaceTotal,
        nsLimit.aggregateBytes,
      );
    }
    if (rootLimit.totalBytes !== null && input.rootTotal > rootLimit.totalBytes) {
      return exceeded(
        `${rootKind} tree aggregate`,
        input.relPath,
        input.rootTotal,
        rootLimit.totalBytes,
      );
    }
    return null;
  }

  return {
    admitFile(input) {
      if (input.depth > rootLimit.maxDepth) {
        return exceeded(`${rootKind} depth`, input.relPath, input.depth, rootLimit.maxDepth);
      }

      const nsLimit = NAMESPACE_LIMITS[input.namespace];
      if (nsLimit.maxDepth !== undefined && input.depth > nsLimit.maxDepth) {
        return exceeded(`${input.namespace} depth`, input.relPath, input.depth, nsLimit.maxDepth);
      }

      const nsCount = (namespaceCounts.get(input.namespace) ?? 0) + 1;
      if (nsLimit.maxFiles !== null && nsCount > nsLimit.maxFiles) {
        return exceeded(`${input.namespace} count`, input.relPath, nsCount, nsLimit.maxFiles);
      }
      if (rootLimit.maxFiles !== null && fileCount + 1 > rootLimit.maxFiles) {
        return exceeded(`${rootKind} file count`, input.relPath, fileCount + 1, rootLimit.maxFiles);
      }

      const nsBytes = (namespaceBytes.get(input.namespace) ?? 0) + input.declaredSize;
      const violation = checkBytes({
        relPath: input.relPath,
        namespace: input.namespace,
        fileBytes: input.declaredSize,
        namespaceTotal: nsBytes,
        rootTotal: totalBytes + input.declaredSize,
      });
      if (violation instanceof Error) return violation;

      namespaceCounts.set(input.namespace, nsCount);
      namespaceBytes.set(input.namespace, nsBytes);
      fileCount += 1;
      totalBytes += input.declaredSize;
      declaredSizes.set(input.relPath, input.declaredSize);
      return null;
    },

    observeBytes(input) {
      // Re-cost the tree with the streamed length replacing what THIS file was admitted
      // for; a file admitted at 1 byte that streams 2 MiB is caught here, not after the
      // copy has already been handed to a consumer. A file streaming exactly its declared
      // size yields a zero delta and so leaves the tree's cost untouched.
      const declared = declaredSizes.get(input.relPath) ?? 0;
      const delta = input.bytesSoFar - declared;
      return checkBytes({
        relPath: input.relPath,
        namespace: input.namespace,
        fileBytes: input.bytesSoFar,
        namespaceTotal: (namespaceBytes.get(input.namespace) ?? 0) + delta,
        rootTotal: totalBytes + delta,
      });
    },
  };
}
