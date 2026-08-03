// `core/chats` — chat lifecycle (kernel-command-contract §8.2): `chat.create`,
// `chat.switch`, the Kernel's own newest-first chat directory, the shared `chat.changed`
// payload builder, and `model.select`'s registry-validated selection. No I/O of its own —
// every mutation goes through `core/ports`'s `ChatMutations`/`ProjectStore`/`AgentRegistry`.

export type { ChatDirectory } from "./model/chat-directory";
export { createChatDirectory, sortChatsNewestFirst } from "./model/chat-directory";

export type { BuildChatChangedPayloadInputV1 } from "./model/chat-changed";
export { buildChatChangedPayload } from "./model/chat-changed";

export { deriveChatDisplayName, truncateChatDisplayName } from "./model/display-name";

export {
  buildChatRecordsOlderPayload,
  buildChatRecordsPayload,
  chatRecordToDtoV1,
  chatRecordsOlderFailurePayload,
  resolveChatDisplayName,
} from "./model/records";

export type { CreateChatDeps } from "./model/create";
export { createChat } from "./model/create";

export type { SwitchChatDeps } from "./model/switch";
export { switchChat } from "./model/switch";

export type { SelectModelDeps, SelectModelResultV1 } from "./model/model-select";
export { selectModel, validateModelSelection } from "./model/model-select";

export type { ChatSummaryV1, ModelSelectionRejectionV1, ModelSelectionV1 } from "./types";
