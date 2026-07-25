import type { AgentPromptContextV1, AgentPromptSource } from "../agent-prompt";
import type { AssertConforms } from "../index";
import type { StagingRuntimeDocV1 } from "../staging";

/**
 * In-memory {@link AgentPromptSource} fake, matching every other `core/ports/fakes/` entry's
 * shape (INSPECTABLE `calls` log, PROGRAMMABLE via constructor options). No `failNext`: the
 * real port has no failure channel to model (`systemPrompt`/`runtimeDocs` are both
 * synchronous, `string`/`readonly StagingRuntimeDocV1[]`-returning, never `FailureDtoV1`).
 */

export type AgentPromptSourceCall =
  | { readonly method: "systemPrompt"; readonly context: AgentPromptContextV1 }
  | { readonly method: "runtimeDocs" };

export interface FakeAgentPromptSource extends AgentPromptSource {
  readonly calls: readonly AgentPromptSourceCall[];
}

export function createFakeAgentPromptSource(options?: {
  readonly systemPromptText?: (context: AgentPromptContextV1) => string;
  readonly runtimeDocs?: readonly StagingRuntimeDocV1[];
}): FakeAgentPromptSource {
  const calls: AgentPromptSourceCall[] = [];
  const renderSystemPrompt =
    options?.systemPromptText ?? ((context) => `fake-system-prompt:${JSON.stringify(context)}`);
  const docs = options?.runtimeDocs ?? [];

  function systemPrompt(context: AgentPromptContextV1): string {
    calls.push({ method: "systemPrompt", context });
    return renderSystemPrompt(context);
  }

  function runtimeDocs(): readonly StagingRuntimeDocV1[] {
    calls.push({ method: "runtimeDocs" });
    return docs;
  }

  return { systemPrompt, runtimeDocs, calls };
}

type _Conforms = AssertConforms<AgentPromptSource, FakeAgentPromptSource>;
