import type { ProcessTree } from "infrastructure/process"

export interface QueryOptionDeps {
  readonly abortController: AbortController
  readonly processTree: ProcessTree
  /** Optional override for the CLI path in a compiled binary (Spike H compiled-parity). */
  readonly pathToClaudeCodeExecutable?: string
  /** Reparse backstop injected on Windows (Spike F). */
  readonly hasReparsePoint?: (p: string) => boolean
}
