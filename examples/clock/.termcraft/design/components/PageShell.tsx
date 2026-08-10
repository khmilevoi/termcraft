import { Box, Column, Panel } from "@termcraft/runtime"
import type { ThemeTokens } from "@termcraft/runtime"

// Shared page chrome, factored out of the five pages that all repeated it: the
// full-bleed themed background box, the titled bordered root panel, and the single
// top-level `Column` that lays out the page's own content. A page only ever differs
// from another in its title, accent color and content — those are the only knobs
// exposed here. The ids ("app-bg" / "root" / "layout") are fixed on purpose: stable
// ids across iterations is one of the authoring conventions, and every page using
// the exact same three ids for its chrome is what makes them stable.

export interface PageShellProps {
  readonly title: string
  readonly children?: unknown
  /** Root panel border token; defaults to the panel's own default ("border"). */
  readonly borderColor?: keyof ThemeTokens
  /** Root panel title token; defaults to the panel's own default ("foreground"). */
  readonly titleColor?: keyof ThemeTokens
  /** Cross-axis alignment of the content column; defaults to "stretch". */
  readonly align?: "start" | "center" | "end" | "stretch"
  /** Gap between content column children; defaults to 1. */
  readonly gap?: number
}

export function PageShell(props: PageShellProps) {
  const { title, children, borderColor, titleColor, align = "stretch", gap = 1 } = props

  return (
    <Box id="app-bg" direction="column" grow={1} background="background">
      <Panel id="root" title={title} padding={1} borderColor={borderColor} titleColor={titleColor}>
        <Column id="layout" gap={gap} align={align}>
          {children}
        </Column>
      </Panel>
    </Box>
  )
}
