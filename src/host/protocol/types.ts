import type { HostMode } from "../types"
import type { JsonValue } from "./model/strict-json"

/**
 * The public runtime declaration exchanged before host mount (runtime-api §7.1,
 * host-supervision §5.1). Both arrays are sorted, duplicate-free canonical JSON
 * arrays. Private Reatom/React/OpenTUI identities never appear.
 */
export interface RuntimeDeclarationBundleV1 {
  readonly module: "@termcraft/runtime"
  readonly currentKitApiVersion: number
  readonly supportedKitApiVersions: number[]
  readonly publicCapabilityIds: string[]
}

/** Negotiable protocol limits carried in each hello (host-supervision §5.1). */
export interface PublicLimits {
  readonly controlPayloadBytes: number
  readonly framePayloadBytes: number
  readonly maxFrameWidth: number
  readonly maxFrameHeight: number
  readonly maxFrameCells: number
}

/**
 * Pre-handshake client hello (host-supervision §5.1). Control-class, sent once by
 * the supervisor. Not a `ControlEnvelope`; outer framing version and this
 * `framingVersion` are both `1`.
 */
export interface ClientHelloV1 {
  readonly framingVersion: 1
  readonly kind: "client.hello"
  readonly sessionId: string
  readonly nonce: string
  readonly offeredFramingVersions: [1]
  readonly offeredProtocolVersions: [1]
  readonly mode: HostMode
  readonly pageSlug: string
  readonly sourceHash: string
  readonly sourceKitApiVersion: number
  readonly runtimeDeclaration: RuntimeDeclarationBundleV1
  readonly limits: PublicLimits
}

/** Pre-handshake host hello (host-supervision §5.1). Control-class. */
export interface HostHelloV1 {
  readonly framingVersion: 1
  readonly kind: "host.hello"
  readonly sessionId: string
  readonly nonce: string
  readonly selectedFramingVersion: 1
  readonly selectedProtocolVersion: 1
  readonly runtimeDeclaration: RuntimeDeclarationBundleV1
  readonly limits: PublicLimits
}

/**
 * Post-handshake control envelope (host-supervision §5.2). `messageId` is a
 * monotonic unsigned-64-bit decimal string per `(sender, nonce)` from "1"; a
 * request carries a fresh `requestId`; exactly one terminal response carries
 * `responseTo`. The per-`kind` shape of `body` is validated by 2C/2D.
 */
export interface ControlEnvelope {
  readonly protocolVersion: 1
  readonly kind: string
  readonly sessionId: string
  readonly nonce: string
  readonly messageId: string
  readonly requestId?: string
  readonly responseTo?: string
  readonly body: { readonly [key: string]: JsonValue }
}

/** A run of consecutive cells sharing one style (host-supervision §5.3). */
export type Color =
  | "default"
  | { readonly indexed: number }
  | { readonly rgb: `#${string}` }

export interface StyledRun {
  readonly text: string
  readonly fg: Color
  readonly bg: Color
  /** Bitmask: 1 bold, 2 dim, 4 italic, 8 underline, 16 inverse, 32 strikethrough. */
  readonly attrs: number
}

/** Identity of a sealed frame (host-supervision §5.3). */
export interface FrameIdentity {
  readonly sessionId: string
  readonly nonce: string
  readonly sourceHash: string
  readonly frameSeq: string
}

/** A complete protocol-v1 preview frame (host-supervision §5.3), frame/bulk class. */
export interface FrameEnvelope extends FrameIdentity {
  readonly protocolVersion: 1
  readonly kind: "frame"
  readonly width: number
  readonly height: number
  readonly rows: StyledRun[][]
}
