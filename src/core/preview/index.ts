// `core/preview` — the Kernel's Preview-model orchestration (kernel-command-contract §7.6,
// §8.1-§8.2, §12.5-§12.6; host-supervision-protocol §8): the frame/geometry token chain
// ("FrameTokenV1 -> geometry query -> GeometryTokenV1 -> pin.create", §8.1, verbatim), the
// Kernel-side latest-wins frame slot, the host-queue/outstanding-request backpressure
// bounds, and the `preview.*` command router built over the landed `PreviewState` machine
// and the `PreviewSession`/`HostSupervisorPort` ports. `pin.create` itself is out of scope
// here — see `core/pins/model/create.ts`, this module's one cross-boundary consumer, which
// imports `FrameTokenLedger`/`GeometryTokenLedger` as dependencies rather than duplicating
// their shapes.

export type { FrameBroker } from "./model/frame-broker"
export { createFrameBroker } from "./model/frame-broker"

export type { FrameTokenLedger, FrameTokenVerification } from "./model/frame-token-ledger"
export { createFrameTokenLedger, FrameAckError } from "./model/frame-token-ledger"

export type {
  GeometryAnchorV1,
  GeometryTokenConsumption,
  GeometryTokenLedger,
  GeometryTokenLedgerDeps,
} from "./model/geometry-token-ledger"
export {
  createGeometryTokenLedger,
  GEOMETRY_TOKEN_LEDGER_CAPACITY,
  GEOMETRY_TOKEN_TTL_MS,
} from "./model/geometry-token-ledger"

export type { PreviewBackpressure, PreviewBackpressureTransitionV1 } from "./model/backpressure"
export {
  createPreviewBackpressure,
  HOST_CONTROL_QUEUE_CAPACITY,
  HOST_CONTROL_QUEUE_LOW_WATER_MARK,
} from "./model/backpressure"

export type {
  GeometryQueryV1,
  PreviewCommandOutcomeV1,
  PreviewQueryOutcomeV1,
  PreviewSessionCommands,
  SessionCommandsDeps,
} from "./model/session-commands"
export {
  createPreviewSessionCommands,
  MAX_OUTSTANDING_GEOMETRY_REQUESTS,
  PreviewNoLiveSessionError,
} from "./model/session-commands"
