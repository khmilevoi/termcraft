/**
 * `ui/text-input` — the one editable text surface in the shell. The Workspace composer, the Home
 * prompt and the pin-input popup all render through {@link TextEditor}, so the caret run, the
 * placeholder, the cursor and the whole editing key table come from a single source. The buffer
 * lives in OpenTUI's native `EditBuffer`; the UI-local `Atom<string>` is its downstream mirror.
 */
export { editorMaxRows, editorRowCount, wrappedLineCount } from "./model/editor-height";
export { TEXT_EDITOR_KEY_BINDINGS } from "./model/key-bindings";
export type { EditorBridge, TextEditorHandle, TextEditorProps } from "./types";
export { TextEditor } from "./ui/TextEditor";
export type { TextInputProps } from "./types";
export { TextInput } from "./ui/TextInput";
