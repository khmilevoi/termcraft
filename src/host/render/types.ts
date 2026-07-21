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

/** A hit-tested/queried element's absolute screen-space rectangle (design doc §4.2). */
export interface Rect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * `describe(id)`'s answer (design doc §4.2: "component kind + label"). `label` is not
 * yet populated — see `RenderHandle.describe`'s doc comment for the documented gap.
 */
export interface DescribedElement {
  readonly id: string
  readonly kind: string
}

/**
 * One node of `layoutTree()`'s resolved tree (design doc §4.2: "id, kind, box, text,
 * children"). `text` is not yet populated — see `RenderHandle.layoutTree`'s doc comment.
 */
export interface LayoutNode {
  readonly id: string
  readonly kind: string
  readonly box: Rect
  readonly children: readonly LayoutNode[]
}

/** A live headless renderer with a mounted React root. */
export interface RenderHandle {
  /** Mount (or replace) the React tree to render. */
  mount(node: unknown): void
  /** Paint one frame and wait for it to settle. */
  render(): Promise<void>
  /** Capture the current frame as styled rows. */
  capture(): CapturedFrame
  /** Resize the live renderer, preserving the mounted tree and its atom state. */
  resize(size: RenderSize): void
  /** Tear down the renderer and release native resources. */
  destroy(): void
  /**
   * `checkHit(x, y) → id` (design doc §4.2): the id of the topmost element at an
   * absolute terminal-cell point, or `null` when nothing mounted resolves there.
   *
   * Implemented as a deterministic point-in-rectangle walk over the mounted tree, NOT
   * via `CliRenderer.hitTest`/its native hit-grid — see `model/geometry.ts`, which
   * explains why. (An earlier draft of this comment claimed the opposite and pointed
   * at the very file that refutes it.)
   */
  hitTest(x: number, y: number): string | null
  /**
   * `rectOf(id) → Rect` (design doc §4.2): the element's absolute screen rectangle,
   * or `null` when no mounted element carries that id.
   */
  rectOf(id: string): Rect | null
  /**
   * `describe(id) → component kind + label` (design doc §4.2). KNOWN DIVERGENCE:
   * `@termcraft/runtime`'s themed component catalog does not exist yet (§5.2), so
   * `kind` is the real underlying OpenTUI renderable's constructor name, not the
   * design's semantic vocabulary, and `label` is not populated — see
   * `model/geometry.ts`'s doc comment.
   */
  describe(id: string): DescribedElement | null
  /**
   * `layoutTree() → the resolved node tree` (design doc §4.2). KNOWN DIVERGENCE:
   * `text` is omitted from every node for the same reason `describe`'s `label` is —
   * see `model/geometry.ts`'s doc comment.
   */
  layoutTree(): LayoutNode
}
