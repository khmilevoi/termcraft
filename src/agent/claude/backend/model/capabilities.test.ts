import { expect, test } from "bun:test";

import { claudeCapabilities } from "./capabilities";

test("capabilities advertise canUseTool confinement and rebindable sessions", () => {
  const caps = claudeCapabilities();
  expect(caps.confinement).toBe("canUseTool");
  expect(caps.sessionWorkspaceBinding).toBe("rebindable");
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
