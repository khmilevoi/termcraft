// Host-supervision protocol §5 — fixed outer frame layout, version 1:
// [0..3] u32 big-endian payload length N (header excluded)
// [4]    framing version = 1
// [5]    message class: 1 control, 2 frame/bulk data
// [6..7] flags, must be zero
// [8..]  N bytes UTF-8 JSON payload
export const FRAME_HEADER_BYTES = 8
export const FRAMING_VERSION = 1
export const CONTROL_PAYLOAD_LIMIT_BYTES = 262_144
export const DATA_PAYLOAD_LIMIT_BYTES = 16_777_216
export const GLOBAL_PAYLOAD_CEILING_BYTES = 16_777_216
