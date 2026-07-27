/** Tool-step categories the UI renders as `✓ read main.tsx` (master spec §6.1). */
export type AgentToolOp = "read" | "edit" | "run" | "search" | "other";

/** Backend-reported token usage; feeds the composer's context indicator (§3.9). */
export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** 0–100 share of the backend's context window; null when unreported. */
  readonly contextPercent: number | null;
}

/**
 * The normalized agent stream — the turn's only live output (master spec
 * §6.1). Backends map vendor events into this; kernel and UI never see
 * vendor shapes. Vendor events with no mapping are dropped silently.
 *
 * `tool.id` is the vendor's own `tool_use` block id, carried through so a later
 * `tool-failed` event can name WHICH step failed by id rather than by position —
 * the UI's timeline is an ordered list, and a failure arriving after several more
 * steps have already started must still land on its own step, not the newest one
 * (design `03-workspace-generating.dc.html:44`, "✓ done, ▸ running, ✗ failed").
 *
 * `tool-failed` is emitted ONLY on failure, never paired with a `tool-succeeded`
 * counterpart: a tool result is frequent (one per tool call) and a success adds
 * nothing the timeline's existing positional "done" state does not already say,
 * so mirroring every result would double the wire traffic for no new information.
 * Only the one state the positional signal structurally cannot express — a step
 * that failed, regardless of where it sits in the list — gets its own event.
 */
export type AgentEvent =
  | { readonly kind: "reasoning"; readonly text: string }
  | {
      readonly kind: "tool";
      readonly id: string;
      readonly op: AgentToolOp;
      readonly target: string;
    }
  | { readonly kind: "tool-failed"; readonly id: string }
  | { readonly kind: "final"; readonly text: string }
  | { readonly kind: "usage"; readonly tokens: TokenUsage }
  | { readonly kind: "error"; readonly message: string };

/**
 * Fences one agent run (master spec §6.2). Events carrying a stale fence
 * are ignored; retries get a fresh `{attempt, leaseNonce}` in the same
 * turn workspace.
 */
export interface TurnFence {
  readonly turnId: string;
  readonly attempt: number;
  readonly leaseNonce: string;
}
