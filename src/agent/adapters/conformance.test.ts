import { expect, test } from "bun:test";

import { createProductionClaudeBackend } from "agent/claude";
import type { AssertConforms, AgentBackend as CoreAgentBackend } from "core/ports";

/**
 * The `AgentBackend` conformance line the port header (`core/ports/agent-backend.ts`)
 * says belongs in `agent/`, not `core/`: `core` imports no other module
 * (`docs/architecture/code-structure.md` §7), so the compile-time proof that
 * `createProductionClaudeBackend()` satisfies the core-declared `AgentBackend` port
 * can only run from this side of the boundary. This closes WP-2 Task 7's
 * "every port has one production implementation" requirement for `AgentBackend` —
 * the production backend (`agent/claude`) predates WP-2; WP-2 only adds this proof.
 *
 * `AssertConforms` (`core/ports/index.ts`) is a zero-runtime type: a future edit
 * that lets `agent/types.ts`'s `AgentBackend` and its verbatim-lifted copy in
 * `core/ports/agent-backend.ts` drift apart fails `bun x tsc --noEmit` at this
 * line, not silently at composition time.
 */
type _Check = AssertConforms<CoreAgentBackend, ReturnType<typeof createProductionClaudeBackend>>;

test("createProductionClaudeBackend structurally satisfies the core AgentBackend port (compile-time only)", () => {
  // Never invoked for its return value — the assertion under test is that this
  // assignment type-checks at all, exercising the same assignability `_Check`
  // above proves. A signature drift fails `tsc`, not this runtime assertion.
  const backend: CoreAgentBackend = createProductionClaudeBackend();
  expect(typeof backend.startTurn).toBe("function");
  expect(typeof backend.cancel).toBe("function");
  expect(typeof backend.healthCheck).toBe("function");
  expect(typeof backend.capabilities).toBe("function");
  expect(typeof backend.sessionScope).toBe("function");
});
