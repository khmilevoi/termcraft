import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import type { ProcessTreeFactory } from "infrastructure/process";

/**
 * The minimal SDK surface the run loop consumes (injection seam, mirrors
 * host's SpawnedChild). Shared across query/model/query-fn.ts (production
 * wiring), run/model/drive-stream.ts (the run loop), backend/model/probe.ts
 * (the probe), and backend/model/backend.ts (deps plumbing) — the module's
 * own public vocabulary, so it lives here rather than being re-exported
 * piecemeal from wherever it happened to be defined first.
 */
export interface ClaudeQuery extends AsyncIterable<SDKMessage> {
  interrupt(): Promise<unknown>;
}

/** Injected query seam: production wraps the SDK `query`, tests script an async generator. */
export type ClaudeQueryFn = (params: { prompt: string; options: Options }) => ClaudeQuery;

/** Deps for `createClaudeBackend` (./backend/model/backend.ts). */
export interface ClaudeBackendDeps {
  readonly queryFn: ClaudeQueryFn;
  /** Constructs a fresh, independently owned process tree per `startTurn` call (§6.5). */
  readonly processTreeFactory: ProcessTreeFactory;
  /** Injectable delay for the §6.5 exit-confirmation polls; production = `(ms) => Bun.sleep(ms)`. */
  readonly wait: (ms: number) => Promise<void>;
  /** Override for the CLI path in a compiled binary (Spike H compiled-binary parity). */
  readonly pathToClaudeCodeExecutable?: string;
  /** Reparse-point backstop injected on Windows (Spike F). */
  readonly hasReparsePoint?: (p: string) => boolean;
  /** Override for the §6.5 exit-confirmation budget; `startAgentRun` supplies its own default when omitted. */
  readonly confirmTimeoutMs?: number;
}
