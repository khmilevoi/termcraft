import type { UnavailableReason } from "core/protocol";

/**
 * Short, design-flavoured hint labels for each unavailable-reason code — the status-bar /
 * slash-menu hint text (§10.1: "User-facing prose is presentation data; callers branch on
 * codes, never message text"). This is the presentation mapping the UI owns; the Kernel
 * only ever sends codes. Kept terse to fit the single-line hint row (design `hint` badges
 * like "turn running — export locked", "git off", "read-only").
 */
const REASON_LABELS: Readonly<Record<UnavailableReason["code"], string>> = {
  UNSUPPORTED_PROTOCOL: "unsupported",
  INVALID_ENVELOPE: "invalid",
  COMMAND_ID_REUSE_MISMATCH: "duplicate",
  COMMAND_ID_EXPIRED: "expired",
  COMMAND_DEDUPE_CAPACITY: "busy",
  STALE_REVISION: "out of date",
  PROJECT_NOT_READY: "not ready",
  PROJECT_UNTRUSTED: "read-only",
  TURN_ALREADY_ACTIVE: "turn running",
  TURN_RUNNING: "turn running",
  TURN_NOT_ACTIVE: "no turn",
  TURN_ID_MISMATCH: "no turn",
  CANCEL_TOO_LATE: "too late to cancel",
  HISTORICAL_PREVIEW_READ_ONLY: "history is read-only",
  GIT_UNAVAILABLE: "git off",
  NOT_GIT_REPOSITORY: "not a git repo",
  GIT_SCOPE_CLEAN: "nothing to commit",
  GIT_SEQUENCER_ACTIVE: "git busy",
  SOURCE_STAGED: "staged",
  PLAN_NOT_FOUND: "plan gone",
  PLAN_STALE: "plan stale",
  CONFIRMATION_REQUIRED: "confirm first",
  NO_PAGES: "no pages",
  OPERATION_BUSY: "busy",
  HOST_BACKPRESSURED: "busy",
  TOO_MANY_REQUESTS: "busy",
  FRAME_TOKEN_INVALID: "stale frame",
  FRAME_TOKEN_STALE: "stale frame",
  GEOMETRY_TOKEN_INVALID: "stale anchor",
  GEOMETRY_TOKEN_STALE: "stale anchor",
  CAPABILITY_UNAVAILABLE: "unavailable",
};

/** The short hint label for one unavailable reason. */
export function reasonLabel(reason: UnavailableReason): string {
  return REASON_LABELS[reason.code];
}
