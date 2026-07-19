// The pin vocabulary (storage-identity §11.2): the comments JSONL header, the pin
// event union (pin:created / pin:status), the derived Pin state, and pure decoders
// plus the event fold. Status is never an in-place field — it is the fold of the log
// in file order. No I/O — the streaming reader and 1-MiB bound live in `store/jsonl`.
export type { CommentsHeader, Pin, PinCreatedEvent, PinEvent, PinStatusEvent } from "./types"
export { decodeCommentsHeader, decodePinEvent, foldPins, PinDecodeError } from "./model/decode"
