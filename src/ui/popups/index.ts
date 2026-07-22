/**
 * `ui/popups` — the modal/anchored popups: chat list (`/chats`), the new-pin input, the
 * export-feedback box, and the workspace-trust prompt. Each renders only its own box; the
 * App dims the backdrop behind the modal ones.
 */
export type { ChatListPopupProps, ChatListRow } from "./ui/ChatListPopup";
export { ChatListPopup } from "./ui/ChatListPopup";
export type { PinInputPopupProps } from "./ui/PinInputPopup";
export { PinInputPopup } from "./ui/PinInputPopup";
export type { ExportPopupProps } from "./ui/ExportPopup";
export { ExportPopup } from "./ui/ExportPopup";
export type { TrustPromptProps } from "./ui/TrustPrompt";
export { TrustPrompt } from "./ui/TrustPrompt";
