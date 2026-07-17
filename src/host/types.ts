/** The four supervised host modes (host-supervision §3.1). */
export type HostMode = "preview" | "historical" | "smoke" | "export"

/** Effective interaction mode of a mounted host (host-supervision §3.1). */
export type InteractionMode = "static" | "interactive"

/** A terminal-cell size (columns × rows) shared across the host module. */
export interface Size {
  readonly w: number
  readonly h: number
}
