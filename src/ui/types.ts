/**
 * `ui`'s module-root shared types — a thin re-export of the boundary types phase 8's
 * composition root and other modules consume. Feature-local types live in each feature's
 * own `types.ts`; this file names only what crosses the `ui` module boundary.
 */
export type { KernelPort, PreviewSessionHandle, UiPreviewFrame } from "./kernel";
export type { ScreenKind } from "./mirror";
