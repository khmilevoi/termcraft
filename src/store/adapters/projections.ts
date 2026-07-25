import type {
  AssertConforms,
  DiagnosticsCache,
  DiagnosticsEntryV1,
  DiagnosticsKeyV1,
  ExportRenderKeyV1,
  PageMetaCache,
  PageMetaEntryV1,
  PageMetaKeyV1,
  RenderCache,
  RenderEntryV1,
} from "core/ports";
import type { DiagnosticDtoV1, FailureDtoV1 } from "core/protocol";
import { uuidv7 } from "infrastructure/uuid";
import type { DiagnosticItem, DiagnosticsEntry } from "store/projections";

import { toFailureDto } from "./failure";
import type { StoreAdapterDeps } from "./types";

// `createProjectionsAdapter` — the three rebuildable-projection caches
// (`PageMetaCache`/`DiagnosticsCache`/`RenderCache`) over `OpenProject.projections`'s flat
// `pageMetaGet`/`pageMetaPut`/`diagnosticsGet`/`diagnosticsPut`/`renderGet`/`renderPut`
// facade (plan Task 3). `pageMeta`/`render` are pure pass-throughs: `PageMetaKeyV1`/
// `PageMetaEntryV1`/`ExportRenderKeyV1`/`RenderEntryV1` are structurally identical to their
// store counterparts (both reuse `entities/page`'s `PageMeta` verbatim).
//
// FLAGGED, NOT GUESSED — `diagnostics` needs a genuinely provisional mapping: the port's
// `DiagnosticDtoV1` (`core/protocol`) requires `diagnosticId: UUIDv7` and
// `scope: "project"|"turn"|"preview"|"git"|"migration"`, neither of which the landed store
// `DiagnosticItem`/`DiagnosticsEntry` (`store/projections/types.ts`) carries — and
// `DiagnosticItem.range` has no home on `DiagnosticDtoV1` at all (silently dropped, not
// this adapter's choice — the port DTO simply has no field for it). No already-landed
// `core/` caller constructs a `DiagnosticDtoV1` yet to reveal the intended convention. This
// adapter:
//   - mints `diagnosticId` with the real `infrastructure/uuid` `uuidv7()` (review finding:
//     a truncated SHA-256 hex is "a string" but NOT a canonical UUIDv7 — it fails the
//     format `diagnosticDtoV1Schema`/`uuidv7Schema` actually enforce, e.g. no hyphens, no
//     version/variant nibbles). The store's `DiagnosticItem`/`DiagnosticsEntry` carries no
//     id field to persist a minted id against, so there is nothing to keep it stable across
//     reads — identity is per-materialization (a fresh id every `get()`), not per stored
//     record. A prior revision derived a DETERMINISTIC id from a content hash so repeated
//     reads matched; that determinism is deliberately dropped here because faking the
//     UUIDv7 FORMAT from a hash was itself the contract violation being fixed. If a future
//     caller needs read-stable diagnostic identity, that requires a real id field landing on
//     `store/projections`'s `DiagnosticItem`, not a synthesized one at this boundary;
//   - sets `scope` to a single documented placeholder constant (`DIAGNOSTICS_SCOPE_PLACEHOLDER`
//     below), mirroring `core/kernel/model/handlers/turn.ts`'s own `PLACEHOLDER_GIT_STATUS`
//     precedent for "a real value would need a port that does not exist yet" — never silently
//     invented as if it were a settled decision. (That file's sibling
//     `TURN_START_SYSTEM_PROMPT_PLACEHOLDER`, cited here until phase 8, is gone: WP-3 gave it the
//     port it was waiting for, which is exactly the resolution this comment anticipates.)
// FLAG FOR THE MAINTAINER: confirm the intended `scope` value (or add a real per-diagnostic
// scope field to `store/projections`'s `DiagnosticsEntry`) before this cache carries
// non-gate/host-page diagnostics; `range` is unrecoverable through this port's DTO as declared.
const DIAGNOSTICS_SCOPE_PLACEHOLDER: DiagnosticDtoV1["scope"] = "project";

function toPageMetaCache(deps: StoreAdapterDeps): PageMetaCache {
  const { open } = deps;
  return {
    async get(key: PageMetaKeyV1): Promise<FailureDtoV1 | PageMetaEntryV1 | null> {
      const result = await open.projections.pageMetaGet(key);
      if (result instanceof Error) return toFailureDto(result);
      return result;
    },
    async put(entry: PageMetaEntryV1): Promise<FailureDtoV1 | undefined> {
      const result = await open.projections.pageMetaPut(entry);
      if (result instanceof Error) return toFailureDto(result);
      return undefined;
    },
  };
}

function toRenderCache(deps: StoreAdapterDeps): RenderCache {
  const { open } = deps;
  return {
    async get(key: ExportRenderKeyV1): Promise<FailureDtoV1 | RenderEntryV1 | null> {
      const result = await open.projections.renderGet(key);
      if (result instanceof Error) return toFailureDto(result);
      return result;
    },
    async put(entry: RenderEntryV1): Promise<FailureDtoV1 | undefined> {
      const result = await open.projections.renderPut(entry);
      if (result instanceof Error) return toFailureDto(result);
      return undefined;
    },
  };
}

function toDiagnosticDtoV1(key: DiagnosticsKeyV1, item: DiagnosticItem): DiagnosticDtoV1 {
  return {
    // Real UUIDv7, minted fresh per materialization — see the file header FLAG for why this
    // is not (and cannot honestly be) stable across repeated reads of the same content.
    diagnosticId: uuidv7(),
    scope: DIAGNOSTICS_SCOPE_PLACEHOLDER,
    severity: item.severity,
    code: item.code,
    safeMessage: item.message,
    pageSlug: key.pageSlug,
    sourceHash: key.sourceHash,
  };
}

function toDiagnosticsEntryV1(entry: DiagnosticsEntry): DiagnosticsEntryV1 {
  return {
    key: entry.key,
    schemaVersion: entry.schemaVersion,
    provenance: entry.provenance,
    observedAt: entry.observedAt,
    diagnostics: entry.diagnostics.map((item) => toDiagnosticDtoV1(entry.key, item)),
  };
}

/** Inverse of {@link toDiagnosticDtoV1} — drops `diagnosticId`/`scope` (not stored by `store/projections`) and `range` (the port DTO has no field for it, see this file's header). */
function toDiagnosticItem(dto: DiagnosticDtoV1): DiagnosticItem {
  return { code: dto.code, severity: dto.severity, message: dto.safeMessage };
}

function toStoreEntry(entry: DiagnosticsEntryV1): DiagnosticsEntry {
  return {
    key: entry.key,
    schemaVersion: entry.schemaVersion,
    provenance: entry.provenance,
    observedAt: entry.observedAt,
    diagnostics: entry.diagnostics.map(toDiagnosticItem),
  };
}

function toDiagnosticsCache(deps: StoreAdapterDeps): DiagnosticsCache {
  const { open } = deps;
  return {
    async get(key: DiagnosticsKeyV1): Promise<FailureDtoV1 | DiagnosticsEntryV1 | null> {
      const result = await open.projections.diagnosticsGet(key);
      if (result instanceof Error) return toFailureDto(result);
      if (result === null) return null;
      return toDiagnosticsEntryV1(result);
    },
    async put(entry: DiagnosticsEntryV1): Promise<FailureDtoV1 | undefined> {
      const result = await open.projections.diagnosticsPut(toStoreEntry(entry));
      if (result instanceof Error) return toFailureDto(result);
      return undefined;
    },
  };
}

export interface ProjectionsAdapter {
  readonly pageMeta: PageMetaCache;
  readonly diagnostics: DiagnosticsCache;
  readonly render: RenderCache;
}

export function createProjectionsAdapter(deps: StoreAdapterDeps): ProjectionsAdapter {
  return {
    pageMeta: toPageMetaCache(deps),
    diagnostics: toDiagnosticsCache(deps),
    render: toRenderCache(deps),
  };
}

type _Conforms = AssertConforms<ProjectionsAdapter, ReturnType<typeof createProjectionsAdapter>>;
