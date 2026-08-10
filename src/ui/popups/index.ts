/**
 * `ui/popups` — the modal/anchored popups: chat list (`/chats`), the new-pin input, the
 * export-feedback box, and the workspace-trust prompt. Each renders only its own box; the
 * App dims the backdrop behind the modal ones.
 */
export type { ChatListPopupProps, ChatListRow } from "./ui/ChatListPopup";
export { ChatListPopup } from "./ui/ChatListPopup";
export type { ChatListViewport } from "./model/chat-list";
export {
  CHAT_LIST_VIEWPORT_CAP,
  FRESH_CHAT_LABEL,
  computeChatListViewport,
  formatChatWhen,
} from "./model/chat-list";
export type { PinInputPopupProps } from "./ui/PinInputPopup";
export { PIN_INPUT_POPUP_SIZE, PinInputPopup } from "./ui/PinInputPopup";
export type { ExportFailurePopupProps, ExportPopupProps } from "./ui/ExportPopup";
export { ExportFailurePopup, ExportPopup } from "./ui/ExportPopup";
export type { TrustPromptProps } from "./ui/TrustPrompt";
export { TrustPrompt } from "./ui/TrustPrompt";
