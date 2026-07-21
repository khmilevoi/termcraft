export type { MessageClass, WireFrame } from "./types";
export {
  CONTROL_PAYLOAD_LIMIT_BYTES,
  DATA_PAYLOAD_LIMIT_BYTES,
  FRAME_HEADER_BYTES,
  FRAMING_VERSION,
  GLOBAL_PAYLOAD_CEILING_BYTES,
} from "./model/constants";
export { FramingError } from "./model/errors";
export { encodeFrame } from "./model/encode";
export { FrameDecoder } from "./model/decoder";
