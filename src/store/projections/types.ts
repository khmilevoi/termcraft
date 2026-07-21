import type { PageMeta } from "entities/page";

import type { DiagnosticsStoreIoError } from "./model/diagnostics-store";
import type { PageMetaCacheIoError } from "./model/page-meta-cache";
import type { RenderCacheIoError } from "./model/render-cache";

/**
 * An OS-absolute path handed in by the composition root — never a caller-built managed
 * relative path. `store/types.ts` (T19) owns the shared alias; this local declaration
 * keeps the submodule self-contained until then.
 */
export type AbsPath = string;

/** Lowercase-hex SHA-256. */
export type Sha256Hex = string;

// ---- shared filesystem seam -----------------------------------------------------
//
// All three projections write local content-addressed entries under an injected root
// directory (projections-observability §4's `cache/page-meta/`, `diagnostics/`,
// `cache/export-render/`). None of them go through `store/safe-fs`: `SafeProjectFs`'s
// path grammar and per-namespace limits (turn-durability §5.3) exist to police
// agent/hostile-controlled paths, but every path here is a SHA-256 of a key this store
// computed itself — there is no hostile input to police. `infrastructure/durability`'s
// `durableFileWrite` (the temp-write -> verify -> rename -> flush-dir sequence) is the
// ONLY write path, satisfying "temp-write -> checksum -> rename" for every entry.

/** The impure filesystem boundary every projection store needs, injected for testability. */
export interface ProjectionFsDeps {
  /** `null` means "no such file" (an ordinary miss); `Error` means a real I/O fault. */
  readonly readFile: (absPath: AbsPath) => Uint8Array | null | Error;
  /** The atomic temp-write -> verify -> rename -> flush-dir install (`infrastructure/durability`). */
  readonly durableWrite: (absPath: AbsPath, bytes: Uint8Array) => Error | undefined;
  /** Best-effort delete, used by quota eviction and corrupt-entry cleanup. Missing is success. */
  readonly remove: (absPath: AbsPath) => Error | undefined;
  /** Entry file names directly under `absDir`; `[]` when the directory does not exist yet. */
  readonly listFiles: (absDir: AbsPath) => readonly string[] | Error;
  readonly ensureDir: (absDir: AbsPath) => Error | undefined;
}

// ---- page-meta cache (storage-identity §7) ---------------------------------------

/**
 * The exact §7 cache key. `pageSlug` is a plain string here (not the branded
 * `entities/page` `PageSlug`), matching the plan's `store/types.ts` port sketch: a key
 * read back out of a stored entry is a lookup value, not a value that needs the slug
 * grammar re-validated to serve as one.
 */
export interface PageMetaKey {
  readonly pageSlug: string;
  readonly sourceHash: Sha256Hex;
  readonly extractorVersion: number;
}

/**
 * A cache entry: the key it was extracted under, plus the page-module contract's
 * static `PageMeta` (`entities/page`) — "extracted title, minimum size, theme, and
 * other values already defined by the page-module contract" (§7). §7 does not name a
 * value shape beyond that phrase; reusing the already-landed `PageMeta` resolves the
 * gap without inventing a parallel shape.
 */
export interface PageMetaEntry {
  readonly key: PageMetaKey;
  readonly meta: PageMeta;
}

// ---- diagnostics store (projections §6) ------------------------------------------

export interface DiagnosticsKey {
  readonly pageSlug: string;
  readonly sourceHash: Sha256Hex;
  readonly kitApiVersion: number;
}

export interface DiagnosticRange {
  readonly line: number;
  readonly column: number;
}

export interface DiagnosticItem {
  readonly code: string;
  readonly severity: "error" | "warning" | "info";
  readonly message: string;
  readonly range?: DiagnosticRange;
}

/**
 * §6.1 names a schema version, normalized codes/severities, bounded messages and
 * ranges, provenance, and an observation timestamp. §6.1 also describes the static
 * portion (Gate) and the runtime portion (host) as independently updatable within one
 * entry; the `ProjectionStore` port this store backs exposes only an atomic whole-entry
 * `diagnosticsPut` (no partial-merge method), so that finer-grained merge is a
 * caller-side concern (read, merge, put) — not implemented as a separate method here.
 * `provenance` therefore describes the entry's most recent whole-entry write.
 */
export interface DiagnosticsEntry {
  readonly key: DiagnosticsKey;
  readonly schemaVersion: number;
  readonly provenance: "gate" | "host";
  readonly observedAt: string; // RFC 3339
  readonly diagnostics: readonly DiagnosticItem[];
}

/** Injected so tests can control which keys survive an eviction sweep (§6.2 "pinned during the active process"). */
export type DiagnosticsPinPredicate = (key: DiagnosticsKey) => boolean;

// ---- render cache (projections §10.2) --------------------------------------------

/** The exact §10.2 logical key. `flags` is canonicalized with SORTED keys before hashing/comparison. */
export interface ExportRenderKey {
  readonly sourceHash: Sha256Hex;
  readonly kitApiVersion: number;
  readonly rendererVersion: string;
  readonly size: { readonly width: number; readonly height: number };
  readonly theme: string;
  readonly flags: Readonly<Record<string, boolean | number | string>>;
}

/**
 * One immutable render (§10.2: "styled/text frame, resolved layout tree, key envelope,
 * byte lengths, and checksums"). The three payloads are opaque bytes rather than a typed
 * frame/layout shape: `store` may import no adapter (code-structure §6/§11), and the
 * host-owned wire format lives in `host/render` — out of reach from here. The caller
 * (the phase-6 export orchestration, wired at the composition root) serializes/
 * deserializes between the host's frame representation and these buffers; this store
 * only guarantees they round-trip byte-exact under their own recorded checksums.
 */
export interface RenderEntry {
  readonly key: ExportRenderKey;
  readonly styledFrame: Uint8Array;
  readonly textFrame: Uint8Array;
  readonly layout: Uint8Array;
}

export type RenderPinPredicate = (key: ExportRenderKey) => boolean;

// ---- error unions -----------------------------------------------------------------

export type ProjectionsError = PageMetaCacheIoError | DiagnosticsStoreIoError | RenderCacheIoError;
