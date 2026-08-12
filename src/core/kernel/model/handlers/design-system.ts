import {
  type DesignSystemBreakageItemV1,
  type DesignSystemInstallPortsV1,
  type DesignSystemPreparedInstallV1,
  type DesignSystemPreviewV1,
  type DesignSystemUpdateV1,
  type SourceListingV1,
  commitDesignSystemInstall,
  detectDesignSystemUpdate,
  listGrantedSources,
  prepareDesignSystemInstall,
} from "core/design-systems";
import type { PublishableEventV1 } from "core/mailbox";
import type {
  DesignSystemSummaryV1,
  DesignTreeReader,
  LocalPackageV1,
  PackageFileV1,
} from "core/ports";
import type {
  CommandPayloadByKindV1,
  DesignSystemBreakageDtoV1,
  DesignSystemPreviewDtoV1,
  DesignSystemSummaryDtoV1,
  DesignSystemUpdateDtoV1,
  FailureDtoV1,
  SourceListingDtoV1,
  UUIDv7,
} from "core/protocol";
import {
  DESIGN_SYSTEM_DIRNAME,
  DESIGN_SYSTEM_MANIFEST_RELPATH,
  decodeDesignSystemManifest,
  isInsideDesignSystem,
} from "entities/design-system";
import {
  type DesignSystemRef,
  formatDesignSystemRef,
  parseDesignSystemId,
  parseDesignSystemRef,
  parseDesignSystemVersion,
} from "entities/design-system-ref";
import { log } from "infrastructure/debug-log";
import { uuidv7 } from "infrastructure/uuid";

import type { CommandOutcomeV1, FamilyHandlerMap, HandlerContext } from "./types";
import { startedOutcome } from "./types";

/**
 * `design-system.ts` — the `designSystem` command family (project-design-systems §8.1-§8.5
 * Wave 3 / P10, task 9): `list`, `preview`, `install`, `publish`. Every handler follows
 * `preview-export.ts`'s `handleExportStart` shape verbatim — synchronous, calls
 * `context.launchOperation(label, run)` exactly once, returns `startedOutcome([], operationId)`
 * — and `run` never rejects: every outcome, success or failure, becomes a terminal event.
 *
 * DECISION D7 IS LOAD-BEARING FOR `designSystem.preview`. `runTree`'s type stage drives
 * `typescript/unstable/sync` on the calling thread — `src/entrypoint/model/design-checker.ts`'s
 * own header: "ZERO ticks of a 10 ms interval across every run, i.e. a genuine freeze, not a
 * slowdown." This plan does not fix that freeze; it refuses to make it look like a hang.
 * `designSystemPreview` publishes `designSystem.previewStarted` via
 * `context.publishOperationEvent` BEFORE `await prepareDesignSystemInstall(...)` — which is
 * where the freezing `runTree` call happens — so the picker has already painted "checking…"
 * when the thread stops. `design-system.test.ts`'s own "D7" test asserts this ordering by
 * recording BOTH the publish call and the fake Gate's own `runTree` call into one shared,
 * time-ordered probe array — an event published after the await would be indistinguishable
 * from a crash, and only a real ordering assertion (not a mocked timer) proves it is not.
 *
 * THE PREPARATION LEDGER (`context.designSystemLedger`, `./types.ts`'s
 * `DesignSystemInstallLedger`) is what makes `designSystem.install` a COMMIT of something
 * already previewed, never a second, silent re-preparation: `take(installId)` returns `null`
 * for an unknown id, and `designSystemInstall` below turns that into a real
 * `designSystem.installFailed`, never a fallback fetch.
 *
 * TRUST (decision D9) IS THIS HANDLER'S CONCERN, NOT `core/design-systems`' — mirroring that
 * module's own header note for `listGrantedSources`/`prepareDesignSystemInstall`: both take an
 * already-decided input (a grant-gated `isGranted` callback, an already-granted `ref`). This
 * file supplies `context.deps.designSystemIsGranted` as that callback for `designSystem.list`;
 * nothing here ELSE re-checks trust for `preview`/`install`, because — with exactly one
 * `designSystemSource: DesignSystemSource` on `KernelDeps` (§8.1's `local`, D9: granted without
 * a prompt but still recorded) — the only source a `designSystem.preview` ref can ever name IS
 * the one `list` already gated.
 */

// ---------------------------------------------------------------------------
// Failure construction. None of these has a dedicated `OperationalFailureCode` — the closed
// registry (`core/protocol/model/failure.ts`) has no "bad input"/"not found" code, and every
// other adapter-level "no such X" fault in this codebase (`core/ports/fakes`' own `refusal()`
// helpers) already uses the same generic bucket for the identical reason.
// ---------------------------------------------------------------------------

function genericFailure(safeMessage: string, details: FailureDtoV1["details"] = {}): FailureDtoV1 {
  return { code: "PERSISTENCE_FAILED", retryable: false, safeMessage, details };
}

/** A malformed `designSystem.preview` ref never reaches the source (§10.2-style client-input rejection). */
function refFailure(err: Error): FailureDtoV1 {
  return genericFailure(`invalid design system reference: ${err.message}`);
}

/**
 * `designSystem.install` named an `installId` `context.designSystemLedger.take` does not hold —
 * unknown, expired (already taken), or never previewed. `ref`'s own payload slot has no real
 * `DesignSystemRef` to carry here (see `DesignSystemInstallFailedPayloadV1`'s own doc comment),
 * so the caller passes the raw `installId` text through as `ref`.
 */
function unknownInstallIdFailure(installId: string): FailureDtoV1 {
  return genericFailure(`no prepared design-system installation for id "${installId}"`, {
    installId,
  });
}

function cannotPublishFailure(): FailureDtoV1 {
  return genericFailure("this source cannot publish");
}

function noOwnDesignSystemFailure(): FailureDtoV1 {
  return genericFailure("this project has no design system installed under system/");
}

function manifestInvalidFailure(err: Error): FailureDtoV1 {
  return genericFailure(`the project's own design-system manifest is invalid: ${err.message}`);
}

// ---------------------------------------------------------------------------
// DTO construction — core/design-systems' internal V1 shapes -> core/protocol's wire DTOs.
// ---------------------------------------------------------------------------

function summaryDtoOf(summary: DesignSystemSummaryV1): DesignSystemSummaryDtoV1 {
  return {
    id: summary.id,
    name: summary.name,
    version: summary.version,
    kitApiVersion: summary.kitApiVersion,
    defaultTheme: summary.defaultTheme,
    defaultThemeTokens: summary.defaultThemeTokens.map((token) => ({
      name: token.name,
      value: token.value,
    })),
    componentNames: [...summary.componentNames],
  };
}

function sourceListingDtoOf(listing: SourceListingV1): SourceListingDtoV1 {
  return {
    sourceId: listing.sourceId,
    label: listing.label,
    canPublish: listing.canPublish,
    state: listing.state,
    systems: listing.systems.map(summaryDtoOf),
    reason: listing.reason,
  };
}

/**
 * Formats `update.available`'s address (`update.installedRef.sourceId` + the available
 * summary's own id/version) into the SAME canonical `source:system@version` text
 * `formatDesignSystemRef` produces everywhere else, never assembled by hand. A summary's
 * `id`/`version` are plain strings (§8.1: read without validating a source's OWN identity
 * conventions further than its schema already did) — re-parsed here through
 * `parseDesignSystemId`/`parseDesignSystemVersion` rather than trusted verbatim; a source that
 * answers an unparsable id/version drops the update offer (logged, errore rule 21) rather than
 * publishing a malformed reference string.
 */
function updateDtoOf(update: DesignSystemUpdateV1 | null): DesignSystemUpdateDtoV1 | null {
  if (update === null) return null;

  const systemId = parseDesignSystemId(update.available.id);
  if (systemId instanceof Error) {
    log.warn(
      `core/kernel/handlers/design-system: update offer names an unparsable systemId "${update.available.id}" — dropped: ${systemId.message}`,
    );
    return null;
  }
  const version = parseDesignSystemVersion(update.available.version);
  if (version instanceof Error) {
    log.warn(
      `core/kernel/handlers/design-system: update offer names an unparsable version "${update.available.version}" — dropped: ${version.message}`,
    );
    return null;
  }

  const availableRef: DesignSystemRef = {
    sourceId: update.installedRef.sourceId,
    systemId,
    version,
  };
  return {
    installedRef: formatDesignSystemRef(update.installedRef),
    availableRef: formatDesignSystemRef(availableRef),
    reason: update.reason,
  };
}

function breakageDtoOf(item: DesignSystemBreakageItemV1): DesignSystemBreakageDtoV1 {
  return {
    code: item.code,
    message: item.message,
    file: item.file,
    blockedPages: item.blockedPages,
  };
}

function previewDtoOf(preview: DesignSystemPreviewV1): DesignSystemPreviewDtoV1 {
  return {
    verdict: preview.verdict,
    errors: preview.errors.map(breakageDtoOf),
    warnings: preview.warnings.map(breakageDtoOf),
  };
}

// ---------------------------------------------------------------------------
// Event construction
// ---------------------------------------------------------------------------

function listedEvent(
  operationId: UUIDv7,
  sources: readonly SourceListingV1[],
  update: DesignSystemUpdateV1 | null,
): PublishableEventV1<"designSystem.listed"> {
  return {
    kind: "designSystem.listed",
    payload: { operationId, sources: sources.map(sourceListingDtoOf), update: updateDtoOf(update) },
    correlation: { operationId },
  };
}

function listFailedEvent(
  operationId: UUIDv7,
  failure: FailureDtoV1,
): PublishableEventV1<"designSystem.listFailed"> {
  return {
    kind: "designSystem.listFailed",
    payload: { operationId, failure },
    correlation: { operationId },
  };
}

function previewedEvent(
  operationId: UUIDv7,
  prepared: DesignSystemPreparedInstallV1,
): PublishableEventV1<"designSystem.previewed"> {
  return {
    kind: "designSystem.previewed",
    payload: {
      operationId,
      installId: prepared.installId,
      ref: formatDesignSystemRef(prepared.ref),
      summary: summaryDtoOf(prepared.summary),
      preview: previewDtoOf(prepared.preview),
    },
    correlation: { operationId },
  };
}

function previewFailedEvent(
  operationId: UUIDv7,
  ref: string,
  failure: FailureDtoV1,
): PublishableEventV1<"designSystem.previewFailed"> {
  return {
    kind: "designSystem.previewFailed",
    payload: { operationId, ref, failure },
    correlation: { operationId },
  };
}

function installedEvent(
  operationId: UUIDv7,
  ref: string,
): PublishableEventV1<"designSystem.installed"> {
  return {
    kind: "designSystem.installed",
    payload: { operationId, ref },
    correlation: { operationId },
  };
}

function installFailedEvent(
  operationId: UUIDv7,
  ref: string,
  failure: FailureDtoV1,
): PublishableEventV1<"designSystem.installFailed"> {
  return {
    kind: "designSystem.installFailed",
    payload: { operationId, ref, failure },
    correlation: { operationId },
  };
}

function publishedEvent(
  operationId: UUIDv7,
  ref: string,
  publishedAt: string,
): PublishableEventV1<"designSystem.published"> {
  return {
    kind: "designSystem.published",
    payload: { operationId, ref, publishedAt },
    correlation: { operationId },
  };
}

function publishFailedEvent(
  operationId: UUIDv7,
  sourceId: string,
  failure: FailureDtoV1,
): PublishableEventV1<"designSystem.publishFailed"> {
  return {
    kind: "designSystem.publishFailed",
    payload: { operationId, sourceId, failure },
    correlation: { operationId },
  };
}

// ---------------------------------------------------------------------------
// The pipeline ports bundle
// ---------------------------------------------------------------------------

/** Bundles `KernelDeps`' fields into the one `DesignSystemInstallPortsV1` `core/design-systems/model/install.ts`'s pipeline consumes. */
function installPortsOf(context: HandlerContext): DesignSystemInstallPortsV1 {
  return {
    source: context.deps.designSystemSource,
    designReader: context.deps.designReader,
    gateRunner: context.deps.gateRunner,
    quarantine: context.deps.designSystemQuarantine,
    install: context.deps.designSystemInstall,
    clock: context.deps.clock,
    // A UUIDv7 (decision D4) — `store/design-systems`' quarantine relies on create-new
    // collision safety over the value's uniqueness, never its shape.
    newInstallId: () => uuidv7(),
  };
}

// ---------------------------------------------------------------------------
// designSystem.list
// ---------------------------------------------------------------------------

function designSystemList(
  _payload: CommandPayloadByKindV1["designSystem.list"],
  context: HandlerContext,
): CommandOutcomeV1 {
  const operationId = uuidv7();
  context.launchOperation("kernel.designSystem.list", async () => {
    const listings = await listGrantedSources({
      sources: [context.deps.designSystemSource],
      isGranted: context.deps.designSystemIsGranted,
    });

    const provenance = await context.deps.designSystemInstall.readProvenance();
    if (provenance !== null && "code" in provenance)
      return [listFailedEvent(operationId, provenance)];

    const update = detectDesignSystemUpdate({
      installedRef: provenance === null ? null : provenance.ref,
      listings,
    });
    return [listedEvent(operationId, listings, update)];
  });
  return startedOutcome([], operationId);
}

// ---------------------------------------------------------------------------
// designSystem.preview
// ---------------------------------------------------------------------------

function designSystemPreview(
  payload: CommandPayloadByKindV1["designSystem.preview"],
  context: HandlerContext,
): CommandOutcomeV1 {
  const operationId = uuidv7();
  context.launchOperation("kernel.designSystem.preview", async () => {
    // PUBLISHED BEFORE ANY AWAIT THAT CAN FREEZE THE THREAD (decision D7) — see this file's
    // own header. `runTree`'s type stage runs `typescript/unstable/sync` on this thread; a
    // "checking…" state published after it would reach the shell only once the freeze ended,
    // which is exactly when it stops being useful.
    context.publishOperationEvent({
      kind: "designSystem.previewStarted",
      payload: { operationId, ref: payload.ref },
      correlation: { operationId },
    });

    const ref = parseDesignSystemRef(payload.ref);
    if (ref instanceof Error)
      return [previewFailedEvent(operationId, payload.ref, refFailure(ref))];

    const prepared = await prepareDesignSystemInstall(installPortsOf(context), ref);
    if ("code" in prepared) return [previewFailedEvent(operationId, payload.ref, prepared)];

    // Evicts + discards any earlier preparation — "a second preparation evicts and DISCARDS
    // the first, no quarantine is leaked" (task-9 brief).
    context.designSystemLedger.replace(prepared);
    return [previewedEvent(operationId, prepared)];
  });
  return startedOutcome([], operationId);
}

// ---------------------------------------------------------------------------
// designSystem.install
// ---------------------------------------------------------------------------

function designSystemInstall(
  payload: CommandPayloadByKindV1["designSystem.install"],
  context: HandlerContext,
): CommandOutcomeV1 {
  const operationId = uuidv7();
  context.launchOperation("kernel.designSystem.install", async () => {
    const prepared = context.designSystemLedger.take(payload.installId);
    if (prepared === null) {
      return [
        installFailedEvent(
          operationId,
          payload.installId,
          unknownInstallIdFailure(payload.installId),
        ),
      ];
    }

    const committed = await commitDesignSystemInstall(installPortsOf(context), prepared);
    if ("code" in committed) {
      return [installFailedEvent(operationId, formatDesignSystemRef(prepared.ref), committed)];
    }

    return [installedEvent(operationId, formatDesignSystemRef(committed.ref))];
  });
  return startedOutcome([], operationId);
}

// ---------------------------------------------------------------------------
// designSystem.publish
// ---------------------------------------------------------------------------

/**
 * Reads the project's own `system/**` off the canonical design tree and shapes it into a
 * `LocalPackageV1` — package-relative paths (`system/` stripped), the manifest's own
 * `id`/`version` as the package's identity. Refuses before ever calling `source.publish` when
 * the tree has no `system/` at all (§10.2-style precondition, not a source-side fault).
 */
async function readOwnDesignSystemPackage(
  designReader: DesignTreeReader,
): Promise<FailureDtoV1 | LocalPackageV1> {
  const tree = await designReader.listTree();
  if ("code" in tree) return tree;

  const systemEntries = tree.filter((entry) => isInsideDesignSystem(entry.relPath));
  if (systemEntries.length === 0) return noOwnDesignSystemFailure();

  const files: { readonly treeRelPath: string; readonly bytes: Uint8Array }[] = [];
  for (const entry of systemEntries) {
    const file = await designReader.readTreeFile(entry.relPath);
    if ("code" in file) return file;
    files.push({ treeRelPath: entry.relPath, bytes: file.bytes });
  }

  const manifestFile = files.find((file) => file.treeRelPath === DESIGN_SYSTEM_MANIFEST_RELPATH);
  if (manifestFile === undefined) return noOwnDesignSystemFailure();

  const manifest = decodeDesignSystemManifest(new TextDecoder().decode(manifestFile.bytes));
  if (manifest instanceof Error) return manifestInvalidFailure(manifest);

  const systemId = parseDesignSystemId(manifest.id);
  if (systemId instanceof Error) return manifestInvalidFailure(systemId);
  const version = parseDesignSystemVersion(manifest.version);
  if (version instanceof Error) return manifestInvalidFailure(version);

  const packageFiles: PackageFileV1[] = files.map((file) => ({
    // package-relative: strip the tree-relative `system/` prefix `isInsideDesignSystem` proved.
    relPath: file.treeRelPath.slice(DESIGN_SYSTEM_DIRNAME.length + 1),
    bytes: file.bytes,
  }));

  return { systemId, version, files: packageFiles };
}

function designSystemPublish(
  payload: CommandPayloadByKindV1["designSystem.publish"],
  context: HandlerContext,
): CommandOutcomeV1 {
  const operationId = uuidv7();
  context.launchOperation("kernel.designSystem.publish", async () => {
    const source = context.deps.designSystemSource;
    // Refused BEFORE reading the tree or calling `publish` (task-9 brief: "Refuse before
    // calling publish when source.canPublish is false or the tree has no system/").
    if (!source.canPublish) {
      return [publishFailedEvent(operationId, payload.sourceId, cannotPublishFailure())];
    }

    const pkg = await readOwnDesignSystemPackage(context.deps.designReader);
    if ("code" in pkg) return [publishFailedEvent(operationId, payload.sourceId, pkg)];

    const receipt = await source.publish(pkg);
    if ("code" in receipt) return [publishFailedEvent(operationId, payload.sourceId, receipt)];

    return [publishedEvent(operationId, formatDesignSystemRef(receipt.ref), receipt.publishedAt)];
  });
  return startedOutcome([], operationId);
}

// ---------------------------------------------------------------------------
// The exported family map
// ---------------------------------------------------------------------------

export const designSystemHandlers: FamilyHandlerMap<"designSystem"> = {
  "designSystem.list": designSystemList,
  "designSystem.preview": designSystemPreview,
  "designSystem.install": designSystemInstall,
  "designSystem.publish": designSystemPublish,
};
