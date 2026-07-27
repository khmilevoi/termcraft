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
}

/** The turn-durability §5.3 limit table, transcribed row for row. */
export const NAMESPACE_LIMITS: Record<ManagedNamespace, NamespaceLimit> = {
  "agent-page-source": { perFileBytes: 2 * MiB, maxFiles: 256, aggregateBytes: null },
  "agent-manifest": { perFileBytes: 256 * KiB, maxFiles: 1, aggregateBytes: null },
  "agent-runtime-doc": { perFileBytes: 4 * MiB, maxFiles: 32, aggregateBytes: 16 * MiB },
  "project-config": { perFileBytes: 1 * MiB, maxFiles: null, aggregateBytes: 16 * MiB },
  "chat-jsonl": { perFileBytes: 64 * MiB, maxFiles: null, aggregateBytes: null },
  "comments-jsonl": { perFileBytes: 32 * MiB, maxFiles: null, aggregateBytes: null },
  "canonical-page": { perFileBytes: 2 * MiB, maxFiles: 256, aggregateBytes: null },
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
  workspace: { maxFiles: 512, totalBytes: 64 * MiB, maxDepth: 8 },
  candidate: { maxFiles: 512, totalBytes: 64 * MiB, maxDepth: 8 },
  "export-candidate": { maxFiles: 20_000, totalBytes: 1024 * MiB, maxDepth: MAX_PATH_COMPONENTS },
  backup: { maxFiles: null, totalBytes: 2048 * MiB, maxDepth: MAX_PATH_COMPONENTS },
};

/** True iff `name` is `<slug>.<ext>` for a valid page slug (`entities/page` mask). */
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
 * The agent workspace / candidate inventory (§5.4). The mutable namespace is exactly
 * `pages/<slug>.tsx` and `pages.json`; {@link AGENT_DOC_FILES} and runtime type declarations
 * are read-only inputs. Everything else — added files, nested page directories — is rejected.
 *
 * SPEC GAP (§5.4 names "runtime type declarations" without pinning their location): this
 * accepts any `*.d.ts` anywhere in the tree EXCEPT under `pages/`, which stays reserved
 * for `<slug>.tsx` so the "no nested page directories" rule cannot be side-stepped.
 */
function classifyWorkspace(components: readonly string[]): ManagedNamespace | null {
  const [first, second] = components;
  if (first === undefined) return null;

  if (components.length === 1) {
    if (first === "pages.json") return "agent-manifest";
    if (AGENT_DOC_FILES.has(first)) return "agent-runtime-doc";
    if (first.endsWith(".d.ts")) return "agent-runtime-doc";
    return null;
  }
  if (first === "pages") {
    if (components.length !== 2 || second === undefined) return null;
    return isSlugFile(second, ".tsx") ? "agent-page-source" : null;
  }
  const last = components[components.length - 1];
  if (last !== undefined && last.endsWith(".d.ts")) return "agent-runtime-doc";
  return null;
}

/**
 * The `.termcraft` inventory (storage-identity §4). The portable block plus the local
 * block; `transactions.local/` is the journal (its own §5.3 row) and `export/generations/`
 * holds export artifacts. Cache, diagnostics, and log entries fall under §5.3's "local
 * TOML/JSON state" row alongside the portable config files.
 */
function classifyProject(components: readonly string[]): ManagedNamespace | null {
  const [first, second, third] = components;
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
  if (first === "pages") {
    // Canonical page storage is `pages/<slug>/page.tsx` + `pages/<slug>/comments.jsonl` —
    // deliberately NOT the agent's flat `pages/<slug>.tsx` shape.
    if (components.length !== 3 || second === undefined || third === undefined) return null;
    if (parsePageSlug(second) instanceof Error) return null;
    if (third === "page.tsx") return "canonical-page";
    if (third === "comments.jsonl") return "comments-jsonl";
    return null;
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
