/**
 * Protocol-wide types that belong to no single schema file.
 *
 * Everything else in this module keeps its TypeScript type next to the Zod schema that
 * produces it — `CommandPayloadByKindV1` is `z.infer`red from `commandPayloadSchemas`,
 * `UnavailableReason` from `unavailableReasonV1Schema`, and so on. Hoisting those
 * declarations here would split a type from the runtime validator that defines it and
 * let the two drift, which is the failure mode the closure tests exist to prevent.
 */

/** The only protocol version this build speaks (kernel-command-contract §8.1). */
export type ProtocolVersion = 1

/** The wire-neutral value `protocolVersion` must carry on every command and event. */
export const PROTOCOL_VERSION: ProtocolVersion = 1
