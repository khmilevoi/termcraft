/** The four supervised host modes (host-supervision §3.1). */
export type HostMode = "preview" | "historical" | "smoke" | "export"

/** Effective interaction mode of a mounted host (host-supervision §3.1). */
export type InteractionMode = "static" | "interactive"

/** A terminal-cell size (columns × rows) shared across the host module. */
export interface Size {
  readonly w: number
  readonly h: number
}

/**
 * Terminal color/geometry capabilities announced at mount (host-supervision §3.1)
 * and echoed into the runtime's viewport/color capability model. MVP carries the
 * color depth only (4/8/24-bit); later phases widen this (mouse, unicode width).
 */
export interface TerminalCapabilities {
  readonly colorDepth: number
}
