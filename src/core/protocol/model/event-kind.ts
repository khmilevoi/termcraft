import { z } from "zod"

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
  "selection.changed",
  "pins.changed",
  "git.statusChanged",
  "diagnostics.changed",
] as const

export type EventKindV1 = (typeof EVENT_KINDS_V1)[number]

/** The exact member count §9 fixes. */
export const EVENT_KIND_COUNT = 43

const EVENT_KIND_SET: ReadonlySet<string> = new Set(EVENT_KINDS_V1)

/** True when `raw` names a v1 event kind. */
export function isEventKindV1(raw: string): raw is EventKindV1 {
  return EVENT_KIND_SET.has(raw)
}

/** Zod schema over the closed union. */
export const eventKindV1Schema = z.enum(EVENT_KINDS_V1)
