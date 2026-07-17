import type { StyledRun } from "../protocol"

/** A terminal-cell size for a headless render. */
export interface RenderSize {
  readonly w: number
  readonly h: number
}

/**
 * A frame captured from the headless renderer — the styled rows plus dims, ready
 * to drop into a phase-2A `FrameEnvelope` (which adds the identity fields).
 */
export interface CapturedFrame {
  readonly width: number
  readonly height: number
  readonly rows: StyledRun[][]
}

/** A live headless renderer with a mounted React root. */
export interface RenderHandle {
  /** Mount (or replace) the React tree to render. */
  mount(node: unknown): void
  /** Paint one frame and wait for it to settle. */
  render(): Promise<void>
  /** Capture the current frame as styled rows. */
  capture(): CapturedFrame
  /** Tear down the renderer and release native resources. */
  destroy(): void
}
