// `core`'s shared boundary types (CLAUDE.md "Code style": `types.ts` holds a module's
// shared types) — kernel-assembly WP-1 Task 10 (m6). This is the module DAG's real
// `core/types.ts` row (docs/architecture/code-structure.md): the exact Command/Result/
// Event DTO re-exports `ui` imports today from `core/protocol`/`core/ports`/`core/mailbox`,
// plus `KernelDeps`. `ui` sees only these re-exports and `PreviewSession` — never a deep
// import into `core/protocol`, `core/ports`, `core/mailbox`, or any other `core` submodule.
//
// The re-exported set is verbatim what `grep -rn "from \"core" src/ui` found (kernel-
// assembly Task 10, Step 1) — every symbol below has at least one real `ui` consumer today;
// nothing is added speculatively. Growing this list means a new `ui` file importing a new
// `core` symbol, not a guess.

// --- Command/result DTOs (core/protocol) ---------------------------------------------------
export type {
  CommandKindV1,
  CommandPayloadByKindV1,
  CommandResultV1,
  UnavailableReason,
} from "./protocol";
export { REASON_CODES_V1, primaryReason } from "./protocol";

// --- Event DTOs (core/protocol) -------------------------------------------------------------
export type { EventKindV1, EventPayloadByKindV1 } from "./protocol";

// --- Shared wire DTOs (core/protocol) --------------------------------------------------------
export type {
  FailureDtoV1,
  FrameIdentityV1,
  FrameTokenV1,
  GeometryTokenV1,
  PageDescriptorV1,
  PinDtoV1,
  Sha256Hex,
  UInt64String,
  UUIDv7,
} from "./protocol";

// --- Ports the UI reads DTOs from (core/ports) -----------------------------------------------
export type {
  ColorV1,
  PreviewFrameV1,
  PreviewGeometryQueryResultV1,
  PreviewSession,
  StyledRunV1,
} from "./ports";

// --- Mailbox event envelope (core/mailbox) ----------------------------------------------------
export type { EventCorrelationV1, EventEnvelopeV1 } from "./mailbox";

// --- Kernel dependency surface (core/kernel) ---------------------------------------------------
export type { KernelDeps } from "./kernel";
