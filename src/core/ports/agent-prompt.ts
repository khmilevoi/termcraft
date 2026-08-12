import type { DesignSystemManifestV1 } from "entities/design-system";
import type { PageSlug } from "entities/page";

import type { StagingRuntimeDocV1 } from "./staging";

/**
 * Everything `core` honestly holds about a turn's context that the agent-prompt library
 * (`agent/prompt/`) needs to compose a system prompt (phase-8 design §WP-3). Nothing here is
 * invented to fill a gap: `activePageSlug`/`pageOrder` are the SAME facts `turn.start`
 * (`core/kernel/model/handlers/turn.ts`) already reads to build the manifest slice;
 * `kitApiVersion` is the SAME constant `ExportRenderPort.runtimeDeclaration
 * .currentKitApiVersion` (`core/ports/export-render.ts`) already carries; `openPins` is
 * folded from the SAME `PinReader.fold` result `candidatePins` is built from, never a second
 * port call.
 *
 * Master spec §6.2's own list of what the prompt carries is wider than this — it also names
 * source-extracted per-page metadata, outstanding Gate/host diagnostics, and the current
 * selection. Those three are NOT here: outstanding diagnostics reach the agent through a
 * different, already-wired channel (`core/turns/model/run-turn.ts`'s retry-time append to the
 * USER message, not this context); per-page metadata and the current selection have no
 * `core/ports` channel into the prompt at all today — a documented gap, not an oversight (see
 * `docs/superpowers/plans/2026-07-25-agent-prompt-library.md`'s "Known gaps" section).
 */
export interface AgentPromptContextV1 {
  readonly activePageSlug: PageSlug | null;
  readonly pageOrder: readonly PageSlug[];
  readonly kitApiVersion: number;
  readonly openPins: readonly { readonly pageSlug: PageSlug; readonly text: string }[];
  /**
   * The project's own design system, decoded (design-systems §5: "the agent gets the list in its
   * prompt, beside the runtime documentation: these exist in this project, use them"). `null`
   * means the project has none — every project before the mechanical migration (§9) — and the
   * prompt then carries no design-system section at all rather than a fabricated default.
   */
  readonly designSystem: DesignSystemManifestV1 | null;
}

/**
 * Declared by `core` (the consumer), implemented by `agent/prompt/` (phase-8 design §WP-3) —
 * mirrors the `AgentBackend`/`GateRunner` precedent: the port lives where the data is
 * CONSUMED, never where it is produced. `systemPrompt` is a pure function of `context` plus
 * this module's own static prose (role, §5.8 design-code rules, page-file layout,
 * answer-style guidance). `runtimeDocs` takes no argument: the two files it names (the
 * generated `@termcraft/runtime` declaration, the hand-authored authoring guide) are
 * process-wide constants, not per-turn facts. Under npm distribution these are ordinary files
 * inside the installed package, so the returned `StagingRuntimeDocV1.sourcePath`s are real
 * paths, never staged eagerly at startup.
 */
export interface AgentPromptSource {
  systemPrompt(context: AgentPromptContextV1): string;
  runtimeDocs(): readonly StagingRuntimeDocV1[];
}
