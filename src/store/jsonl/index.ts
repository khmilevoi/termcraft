// The JSONL layer of the Project store (storage-identity §11): the physical line codec, the
// streaming valid-prefix reader with the three §11.3 repair classifications, and the
// prepared-append builder that feeds the transaction engine (turn-durability §4.4).
//
// Two invariants shape everything here. A record exists only when its LF is durable — a
// syntactically valid final object without one is an uncommitted suffix, never a record. And
// truncation is never automatic: only an exactly matching prepared plan can classify a tail
// as an interrupted append, so every other damaged tail costs an explicit repair instead of
// silently discarding bytes.
export type {
  AppendBuilderDeps,
  AppendInterruption,
  AppendInterruptionState,
  CanonicalRangeReader,
  ChatIndexCanonicalSource,
  ChatIndexDeps,
  ChatIndexEntry,
  ChatIndexPage,
  ChatIndexPageDirectoryEntry,
  ChatIndexPageStore,
  ChatIndexState,
  CorruptSuffixReport,
  JsonlDocument,
  JsonlRecordIdentity,
  LoadOptions,
  LoadResult,
  PageCursor,
  PreparedAppend,
  PreparedAppendPayload,
  Sha256Hex,
  TailClassification,
} from "./types"

export type { JsonlLineError, JsonlLineValue } from "./model/line-codec"
export {
  JSONL_MAX_PHYSICAL_LINE_BYTES,
  JSONL_MAX_SERIALIZED_OBJECT_BYTES,
  JsonlLineFormatError,
  JsonlLineTooLongError,
  JSONL_LF,
  decodeChatHeaderLine,
  decodeChatRecordLine,
  decodeCommentsHeaderLine,
  decodeJsonlLine,
  decodePinEventLine,
  encodeChatHeaderLine,
  encodeChatRecordLine,
  encodeCommentsHeaderLine,
  encodeJsonlLine,
  encodePinEventLine,
  sha256Hex,
} from "./model/line-codec"

export type { JsonlCodec, ReadJsonlInput } from "./model/reader"
export { JsonlMidFileCorruptionError, readChatJsonl, readJsonlDocument, readPinsJsonl } from "./model/reader"

export type { AppendBase, BuildPreparedAppendInput } from "./model/append-builder"
export { PreparedAppendError, buildChatAppend, buildPinAppend, buildPreparedAppend, computeAfterImage, defaultAppendBuilderDeps } from "./model/append-builder"

export type { BuildChatIndexInput, ChatIndexError, UpdateChatIndexInput } from "./model/chat-index"
export {
  CHAT_INDEX_DEFAULT_LOAD_LIMIT,
  CHAT_INDEX_MAX_LOAD_BYTES,
  CHAT_INDEX_MAX_LOAD_LIMIT,
  CHAT_INDEX_MAX_RESIDENT_PAGES,
  CHAT_INDEX_PAGE_SIZE,
  CHAT_INDEX_WINDOW_BYTES,
  ChatIndexCursorStaleError,
  ChatIndexIoError,
  buildChatIndex,
  loadChatIndexBefore,
  loadChatIndexTail,
  updateChatIndex,
} from "./model/chat-index"

export type { ChatIndexCacheFsDeps, ChatIndexStateStore } from "./model/chat-index-store"
export { ChatIndexStoreIoError, createNodeChatIndexPageStore, createNodeChatIndexStateStore, nodeChatIndexCacheFsDeps } from "./model/chat-index-store"

export type { SessionPrefixHash, SessionResumeDecision, SessionResumeMismatchReason, SessionSeed } from "./model/checkpoint"
export {
  SESSION_SEED_MAX_RECORDS,
  SESSION_SEED_MAX_TEXT_BYTES,
  SessionPrefixError,
  advanceSessionCheckpoint,
  computeSessionPrefixHash,
  evaluateSessionResume,
  selectSeedRecords,
} from "./model/checkpoint"
