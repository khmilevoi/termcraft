export { ProtocolError } from "./model/errors";
export type { ProtocolViolationCode } from "./model/errors";
export { decodeJsonPayload, decodeUtf8, parseStrictJson } from "./model/strict-json";
export type { JsonValue } from "./model/strict-json";
export type {
  ClientHelloV1,
  Color,
  ControlEnvelope,
  FrameEnvelope,
  FrameIdentity,
  HostHelloV1,
  PublicLimits,
  RuntimeDeclarationBundleV1,
  StyledRun,
} from "./types";
export {
  PROTOCOL_HARD_LIMITS,
  validatePublicLimits,
  validateRuntimeDeclarationBundle,
} from "./model/bundle";
export {
  EMBEDDED_RUNTIME_DECLARATION,
  SUPPORTED_KIT_API_VERSIONS,
} from "./model/embedded-declaration";
export {
  decodeClientHello,
  decodeHostHello,
  encodeClientHello,
  encodeHostHello,
} from "./model/hello";
export { decodeControlEnvelope, encodeControlEnvelope } from "./model/control-envelope";
export {
  FRAME_ATTR_MASK,
  FRAME_MAX_AXIS,
  FRAME_MAX_CELLS,
  decodeFrameEnvelope,
  encodeFrameEnvelope,
} from "./model/frame";
