import { z } from "zod";

/**
 * The closed v1 control-event registry (kernel-command-contract §9), transcribed
 * verbatim from the `EventKindV1` union in its declared order. §2.12 fixes it as closed,
 * and §9 states that "Unknown event kinds, unknown payload keys, or a payload type not
 * mapped by `EventPayloadByKindV1` are protocol errors inside the same-version
 * in-process implementation; they are not silently interpreted as known events."
 *
 * Frames are NOT here. §7.6: "Frames do not pass through the control-event stream" —
 * the UI consumes a separate bounded latest-wins `PreviewSession` frame stream, so a
 * frame kind on this union would be a category error.
 */
export const EVENT_KINDS_V1 = [
  "kernel.snapshot",
  "kernel.stateChanged",
  "kernel.capabilitiesChanged",
  "page.removePlanReady",
  "page.descriptorsChanged",
  "turn.started",
  "turn.attemptStarted",
  "turn.progress",
  "turn.gateRejected",
  "turn.applyStarted",
  "turn.completed",
  "turn.failed",
  "turn.cancelled",
  "restore.planReady",
  "restore.started",
  "restore.recordPending",
  "restore.completed",
  "restore.failed",
  "commit.planReady",
  "commit.started",
  "commit.completed",
  "commit.failed",
  "export.started",
  "export.progress",
  "export.completed",
  "export.failed",
  "migration.planReady",
  "migration.started",
  "migration.progress",
  "migration.completed",
  "migration.failed",
  "preview.sourceChanged",
  "preview.sessionReady",
  "preview.geometryResult",
  "preview.backpressured",
  "preview.writable",
  "preview.failed",
  "preview.circuitOpened",
  "chat.changed",
  "chat.records",
  "chat.records.older",
  "selection.changed",
  "pins.changed",
  "git.statusChanged",
  "diagnostics.changed",
  // project-design-systems §9 Wave 3 / P10: the picker overlay's nine events, mirroring
  // `export.start`'s admission/progress/terminal shape (§9 KCC:811-813 precedent).
  "designSystem.listed",
  "designSystem.listFailed",
  "designSystem.previewStarted",
  "designSystem.previewed",
  "designSystem.previewFailed",
  "designSystem.installed",
  "designSystem.installFailed",
  "designSystem.published",
  "designSystem.publishFailed",
] as const;

export type EventKindV1 = (typeof EVENT_KINDS_V1)[number];

/**
 * The exact member count §9 fixes. 44 -> 45 (chat-scroll spec §6.2): `chat.records.older`
 * carries one backward page of a chat's history, or the reason it could not be read. It is a
 * separate kind from `chat.records` because the mirror treats the two differently — a tail
 * page merges at the tail, an older page prepends (spec §6.5) — and one kind carrying both
 * would need a direction discriminant on the payload to say which.
 *
 * 45 -> 54 (project-design-systems §9 Wave 3 / P10): `listed`/`listFailed` report the
 * grant-gated bounded multi-source list plus an optional update offer (decisions D9/D10);
 * `previewStarted`/`previewed`/`previewFailed` report the quarantine -> candidate -> Gate
 * pipeline — `previewStarted` publishes BEFORE the freezing `runTree` await (decision D7),
 * so the picker has already painted "checking…" when the thread stops; `installed`/
 * `installFailed` report committing a previously previewed preparation; `published`/
 * `publishFailed` report publishing the project's own system back to a source.
 */
export const EVENT_KIND_COUNT = 54;

const EVENT_KIND_SET: ReadonlySet<string> = new Set(EVENT_KINDS_V1);

/** True when `raw` names a v1 event kind. */
export function isEventKindV1(raw: string): raw is EventKindV1 {
  return EVENT_KIND_SET.has(raw);
}

/** Zod schema over the closed union. */
export const eventKindV1Schema = z.enum(EVENT_KINDS_V1);
