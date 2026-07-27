import * as errore from "errore";

/**
 * Stable diagnostic codes for supervisor lifecycle/queue/timeout failures
 * (host-supervision §12). Protocol-schema failures (framing, JSON, identity,
 * negotiation, kit-API, source-hash) stay `ProtocolError`; this family covers
 * only what the supervisor — not the codec — decides. Codes for 2D-2/3/4 are
 * declared now so the vocabulary is closed and later slices add no new type.
 */
export type SupervisorErrorCode =
  // 2D-1 — process + handshake lifecycle
  | "SPAWN_FAILED"
  | "HANDSHAKE_TIMEOUT"
  | "MOUNT_TIMEOUT"
  | "SHUTDOWN_TIMEOUT"
  | "REAP_TIMEOUT"
  | "CHILD_EXITED"
  | "TRANSPORT_ERROR"
  | "DESIGN_RENDER_FAILED"
  // 2D-2 — requests + heartbeat
  | "QUERY_TIMEOUT"
  | "HEARTBEAT_TIMEOUT"
  | "SUPERSEDED"
  // 2D-3 — queues, flood, capacity, circuit
  | "HOST_BACKPRESSURED"
  | "TOO_MANY_REQUESTS"
  | "CONTROL_BACKPRESSURE"
  | "PROTOCOL_FLOOD"
  | "STDERR_FLOOD"
  | "HOST_CAPACITY"
  | "CIRCUIT_OPEN";

/**
 * A supervisor lifecycle failure. Fatal for the incarnation that produced it.
 * Distinct from `ProtocolError` (schema) and `FramingError` (byte frame).
 */
export class SupervisorError extends errore.createTaggedError({
  name: "SupervisorError",
  message: "Supervisor failure [$code]: $reason",
}) {}

/** What a `SupervisorError.reason` says when the throw carried nothing structured. */
const UNRECOGNIZED = "an unrecognized system error";

/**
 * §13's diagnostic bound, applied at the one place a raw OS error would otherwise cross it.
 *
 * A `SupervisorError.reason` is a §13 diagnostic: it reaches the supervisor's event sink, and
 * from there the Kernel and the user's screen. §13 promises no absolute paths, no environment
 * values and no source contents. But libuv builds its `message` by concatenating the errno, a
 * description, the syscall AND the offending path — `EACCES: permission denied, mkdtemp
 * 'C:\\Users\\<user>\\AppData\\Local\\Temp\\termcraft-host-XXXXXX'` — so forwarding that message
 * puts an absolute path into a sink that promises none. The structured fields carry the same
 * diagnosis without it: `EACCES (mkdtemp)` tells anyone who can act on it exactly as much.
 *
 * When the throw is not a libuv error there are no structured fields to use. Rather than scrub
 * free-form text — a guess about where a path ends, wrong the first time a message is worded
 * differently — this refuses to relay it at all. Nothing is lost: every caller passes the
 * original on as the `SupervisorError`'s `cause`, which the debug log records in full and the
 * §13 sink never reads.
 */
export function osFailureReason(cause: unknown): string {
  const code = (cause as { code?: unknown } | null | undefined)?.code;
  if (typeof code !== "string" || code.length === 0) return UNRECOGNIZED;
  const syscall = (cause as { syscall?: unknown }).syscall;
  return typeof syscall === "string" && syscall.length > 0 ? `${code} (${syscall})` : code;
}
