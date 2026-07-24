// `core`'s public entry (CLAUDE.md "Code style": every module gets a root `index.ts`) —
// kernel-assembly WP-1 Task 10 (B1). This is the WHOLE cross-boundary surface: `ui` (and,
// later, the composition root's own dependency wiring) imports from here and nowhere
// deeper into `core`. Public entry: `createKernel`, the boundary types, and nothing else —
// not a submodule's own barrel, not a model function, not an internal handler contract.
//
// "The boundary types" is exactly `core/types.ts`'s own re-export list (the Command/Result/
// Event DTOs `ui` already imports from `core/protocol`/`core/ports`/`core/mailbox`, plus
// `KernelDeps`) — see that file's own header for how that list was derived. `Kernel` (the
// composed object `createKernel` returns) is deliberately NOT re-exported here: its own
// shape differs from `ui/kernel/types.ts`'s `KernelPort`, and the WP-4 composition-root
// adapter between the two is not built yet — `core/kernel/index.ts` exports `Kernel` for
// that future caller; this barrel does not need to.

export { createKernel } from "./kernel";

export type {
  ColorV1,
  CommandKindV1,
  CommandPayloadByKindV1,
  CommandResultV1,
  EventCorrelationV1,
  EventEnvelopeV1,
  EventKindV1,
  EventPayloadByKindV1,
  FailureDtoV1,
  FrameIdentityV1,
  FrameTokenV1,
  GeometryTokenV1,
  KernelDeps,
  PageDescriptorV1,
  PinDtoV1,
  PreviewFrameV1,
  PreviewGeometryQueryResultV1,
  PreviewSession,
  Sha256Hex,
  StyledRunV1,
  UInt64String,
  UnavailableReason,
  UUIDv7,
} from "./types";
export { REASON_CODES_V1, primaryReason } from "./types";
