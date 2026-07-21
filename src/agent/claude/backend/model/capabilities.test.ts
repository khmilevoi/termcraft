import { expect, test } from "bun:test";

import { claudeCapabilities } from "./capabilities";

test("capabilities advertise canUseTool confinement and rebindable sessions", () => {
  const caps = claudeCapabilities();
  expect(caps.confinement).toBe("canUseTool");
  expect(caps.sessionWorkspaceBinding).toBe("rebindable");
  expect(caps.models.length).toBeGreaterThan(0);
  expect(caps.models[0]!.efforts).toContain("high");
});
