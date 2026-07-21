import { ProtocolError } from "../../protocol";
import type {
  ClientHelloV1,
  HostHelloV1,
  PublicLimits,
  RuntimeDeclarationBundleV1,
} from "../../protocol";
import type { HostSessionIdentity, HostSessionSpec } from "../../types";

export interface HandshakeInputs {
  readonly spec: HostSessionSpec;
  readonly identity: HostSessionIdentity;
  /** The Gate/supervisor's own runtime declaration — must match the host's exactly (§6.4). */
  readonly runtimeDeclaration: RuntimeDeclarationBundleV1;
  readonly offeredLimits: PublicLimits;
}

export interface HandshakeResult {
  readonly negotiatedLimits: PublicLimits;
  readonly hostHello: HostHelloV1;
}

/** Build the single pre-handshake `client.hello` (§5.1) from spec + minted identity. */
export function buildClientHello(inputs: HandshakeInputs): ClientHelloV1 {
  return {
    framingVersion: 1,
    kind: "client.hello",
    sessionId: inputs.identity.sessionId,
    nonce: inputs.identity.nonce,
    offeredFramingVersions: [1],
    offeredProtocolVersions: [1],
    mode: inputs.spec.mode,
    pageSlug: inputs.spec.pageSlug,
    sourceHash: inputs.spec.sourceHash,
    sourceKitApiVersion: inputs.spec.kitApiVersion,
    runtimeDeclaration: inputs.runtimeDeclaration,
    limits: inputs.offeredLimits,
  };
}

const LIMIT_FIELDS = [
  "controlPayloadBytes",
  "framePayloadBytes",
  "maxFrameWidth",
  "maxFrameHeight",
  "maxFrameCells",
] as const;

/**
 * Verify the host hello per §6.4 and negotiate limits (§6). The 2A decoder has
 * already validated the shape, literals, and hard-limit bounds; this adds the
 * session-relative checks the codec cannot know: identity echo, version
 * membership, declaration agreement, kit-API membership, and offered-limit bound.
 */
export function verifyHostHello(
  hostHello: HostHelloV1,
  inputs: HandshakeInputs,
): ProtocolError | HandshakeResult {
  if (
    hostHello.sessionId !== inputs.identity.sessionId ||
    hostHello.nonce !== inputs.identity.nonce
  ) {
    return new ProtocolError({
      code: "MALFORMED_PROTOCOL",
      reason: "host.hello identity does not echo the offered session",
    });
  }
  if (hostHello.selectedFramingVersion !== 1 || hostHello.selectedProtocolVersion !== 1) {
    return new ProtocolError({
      code: "PROTOCOL_NEGOTIATION_FAILED",
      reason: "host selected a framing/protocol version outside the offered set",
    });
  }
  for (const field of LIMIT_FIELDS) {
    if (hostHello.limits[field] > inputs.offeredLimits[field]) {
      return new ProtocolError({
        code: "MALFORMED_PROTOCOL",
        reason: `host limit ${field} exceeds the offered limit`,
      });
    }
  }
  if (!declarationsEqual(hostHello.runtimeDeclaration, inputs.runtimeDeclaration)) {
    return new ProtocolError({
      code: "RUNTIME_INTEGRITY_MISMATCH",
      reason: "host runtime declaration bundle differs from the Gate bundle",
    });
  }
  if (!hostHello.runtimeDeclaration.supportedKitApiVersions.includes(inputs.spec.kitApiVersion)) {
    return new ProtocolError({
      code: "KIT_API_MISMATCH",
      reason: `source kit API version ${inputs.spec.kitApiVersion} is not in the host supported set`,
    });
  }
  const negotiatedLimits: PublicLimits = {
    controlPayloadBytes: Math.min(
      hostHello.limits.controlPayloadBytes,
      inputs.offeredLimits.controlPayloadBytes,
    ),
    framePayloadBytes: Math.min(
      hostHello.limits.framePayloadBytes,
      inputs.offeredLimits.framePayloadBytes,
    ),
    maxFrameWidth: Math.min(hostHello.limits.maxFrameWidth, inputs.offeredLimits.maxFrameWidth),
    maxFrameHeight: Math.min(hostHello.limits.maxFrameHeight, inputs.offeredLimits.maxFrameHeight),
    maxFrameCells: Math.min(hostHello.limits.maxFrameCells, inputs.offeredLimits.maxFrameCells),
  };
  return { negotiatedLimits, hostHello };
}

/** Exact structural equality of two runtime declaration bundles (§6.4 "exact agreement"). */
function declarationsEqual(a: RuntimeDeclarationBundleV1, b: RuntimeDeclarationBundleV1): boolean {
  return (
    a.module === b.module &&
    a.currentKitApiVersion === b.currentKitApiVersion &&
    arraysEqual(a.supportedKitApiVersions, b.supportedKitApiVersions) &&
    arraysEqual(a.publicCapabilityIds, b.publicCapabilityIds)
  );
}
function arraysEqual<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
