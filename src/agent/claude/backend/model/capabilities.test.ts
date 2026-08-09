import { expect, test } from "bun:test";

import { claudeCapabilities } from "./capabilities";

test("capabilities advertise canUseTool confinement and fixed sessions", () => {
  const caps = claudeCapabilities();
  expect(caps.confinement).toBe("canUseTool");
  // Spike 12 (design-agent-feedback-loop repair, Task 9) measured that a resumed session does
  // NOT rebind across a turn-workspace change — the SDK indexes sessions by cwd, so a resume
  // from a different cwd is rejected. "fixed" is the honest capability; a fresh session is
  // required whenever the workspace changes, never a silent rebind.
  expect(caps.sessionWorkspaceBinding).toBe("fixed");
  expect(caps.models.length).toBeGreaterThan(0);
  expect(caps.models[0]!.efforts).toContain("high");
});

test("declares sonnet-5 at high effort as the default selection", () => {
  const caps = claudeCapabilities();

  expect(caps.defaultSelection).toEqual({ model: "claude-sonnet-5", effort: "high" });
  expect(caps.models.some((m) => m.model === caps.defaultSelection.model)).toBe(true);
  const model = caps.models.find((m) => m.model === caps.defaultSelection.model);
  expect(model?.efforts).toContain(caps.defaultSelection.effort);
});
