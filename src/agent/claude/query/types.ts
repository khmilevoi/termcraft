import type { DesignCheckerPort } from "agent/checks";
import type { ProcessTree } from "infrastructure/process";

export interface QueryOptionDeps {
  readonly abortController: AbortController;
  readonly processTree: ProcessTree;
  /**
   * The design self-check behind the in-process `check_design` tool (spec WP-10). REQUIRED, with
   * no default: an omitted checker would produce a turn whose only advertised feedback channel
   * silently does nothing, which is the one failure mode this whole capability exists to avoid.
   * The composition root injects a `gate`-backed implementation
   * (`entrypoint/model/design-checker.ts`) because it is the only ring that can see both: no part
   * of `agent` imports `gate`, and the shared tier the port is declared in (`agent/checks`)
   * imports no `core` either, so `core/ports/gate-runner.ts` is equally out of reach from there.
   * Read that precisely — `agent` as a whole DOES import `core/ports`, in `agent/adapters/` and
   * `agent/prompt/`, which is the sanctioned adapter edge; what it never imports is `gate`, or
   * anything under `core` other than `core/ports`.
   */
  readonly designChecker: DesignCheckerPort;
  /** Optional override for the CLI path in a compiled binary (Spike H compiled-parity). */
  readonly pathToClaudeCodeExecutable?: string;
  /** Reparse backstop injected on Windows (Spike F). */
  readonly hasReparsePoint?: (p: string) => boolean;
}
