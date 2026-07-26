/**
 * `ui/text-input` — the one shared insertion-point input (finding §2.6). Home's prompt box and
 * the Workspace composer's input row both render through {@link TextInput} so the caret, the
 * value-or-placeholder text, and the cursor cell come from a single source instead of two
 * divergent copies.
 */
export type { TextInputProps } from "./types";
export { TextInput } from "./ui/TextInput";
