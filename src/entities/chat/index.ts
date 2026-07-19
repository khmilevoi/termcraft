// The chat vocabulary (storage-identity §11.2): the chat JSONL header and the record
// union (user / agent / system:error / system:cancelled / system:restore), plus pure
// decoders that validate one already-parsed JSON value into a typed record. No I/O —
// the streaming reader, 1-MiB line bound, and file-order rules live in `store/jsonl`.
export type {
  ChatAgentRecord,
  ChatHeader,
  ChatRecord,
  ChatSelection,
  ChatSystemCancelledRecord,
  ChatSystemErrorRecord,
  ChatSystemRestoreRecord,
  ChatUserRecord,
  ChatWarningSnapshot,
} from "./types"
export { ChatDecodeError, decodeChatHeader, decodeChatRecord } from "./model/decode"
