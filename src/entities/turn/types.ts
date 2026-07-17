/** Tool-step categories the UI renders as `✓ read main.tsx` (master spec §6.1). */
export type AgentToolOp = "read" | "edit" | "run" | "search" | "other"

/** Backend-reported token usage; feeds the composer's context indicator (§3.9). */
export interface TokenUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  /** 0–100 share of the backend's context window; null when unreported. */
  readonly contextPercent: number | null
}

/**
 * The normalized agent stream — the turn's only live output (master spec
 * §6.1). Backends map vendor events into this; kernel and UI never see
 * vendor shapes. Vendor events with no mapping are dropped silently.
 */
export type AgentEvent =
  | { readonly kind: "reasoning"; readonly text: string }
  | {
      readonly kind: "tool"
      readonly op: AgentToolOp
      readonly target: string
    }
  | { readonly kind: "final"; readonly text: string }
  | { readonly kind: "usage"; readonly tokens: TokenUsage }
  | { readonly kind: "error"; readonly message: string }

/**
 * Fences one agent run (master spec §6.2). Events carrying a stale fence
 * are ignored; retries get a fresh `{attempt, leaseNonce}` in the same
 * turn workspace.
 */
export interface TurnFence {
  readonly turnId: string
  readonly attempt: number
  readonly leaseNonce: string
}
