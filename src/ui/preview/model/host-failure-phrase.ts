/**
 * The design's own closed code → phrase table (`design/termcraft-engine.js`'s `hostFailPhrase`),
 * transcribed verbatim including its fallback.
 *
 * The design fixed this table deliberately: the frame shows the raw code (the stable thing a
 * user can quote) followed by exactly one derived phrase, and implementation supplies no prose
 * beyond what is written here. A code with no entry gets the design's own generic phrase, never
 * an invented sentence.
 */
const HOST_FAILURE_PHRASES: Readonly<Record<string, string>> = {
  SPAWN_FAILED: "the host process could not be started",
  HANDSHAKE_TIMEOUT: "the host started but never answered",
  MOUNT_TIMEOUT: "the host started but never reported a mount",
  CHILD_EXITED: "the host exited before it could render",
  TRANSPORT_ERROR: "the connection to the host broke",
  HEARTBEAT_TIMEOUT: "the host stopped answering",
  RUNTIME_INTEGRITY_MISMATCH: "the host runtime does not match this build",
  KIT_API_MISMATCH: "the host speaks a different kit API",
  SOURCE_HASH_MISMATCH: "the host loaded a different source",
  PROTOCOL_NEGOTIATION_FAILED: "host and termcraft could not agree a protocol",
};

/** The design's fallback phrase for any code its table does not name. */
const UNKNOWN_HOST_FAILURE_PHRASE = "the host could not be used";

export function hostFailurePhrase(code: string | undefined): string {
  if (code === undefined) return UNKNOWN_HOST_FAILURE_PHRASE;
  return HOST_FAILURE_PHRASES[code] ?? UNKNOWN_HOST_FAILURE_PHRASE;
}
