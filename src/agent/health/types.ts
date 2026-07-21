import type { AgentInfo } from "agent/types";
import type { ProcessTree } from "infrastructure/process";

/**
 * Reads a vendor probe stream until one of its messages classifies the health
 * state. Resolves `null` when the stream closed cleanly with no verdict. MAY
 * reject — {@link runHealthProbe} converts that into a value.
 */
export type HealthProbeReader = () => Promise<AgentInfo | null>;

export interface HealthProbeDeps {
  readonly abortController: AbortController;
  /**
   * The owned process tree the probe CLI is adopted into, or `null` when the
   * caller's `ProcessTreeFactory` could not produce one. Required — not
   * optional — so a caller can never silently forget to wire it; `null` is the
   * one deliberate, explicit opt-out.
   */
  readonly processTree: ProcessTree | null;
  /** Injectable delay for the probe deadline; defaults to an `unref`'d timer. */
  readonly wait?: (ms: number) => Promise<void>;
  /** Probe read budget; defaults to 20_000 ms. */
  readonly deadlineMs?: number;
}
