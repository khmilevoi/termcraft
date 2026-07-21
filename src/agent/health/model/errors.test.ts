import { expect, test } from "bun:test"
import { AgentHealthProbeError } from "./errors"

test("AgentHealthProbeError distinguishes the probe boundary", () => {
  const err = new AgentHealthProbeError({ reason: "no init message" })
  expect(err._tag).toBe("AgentHealthProbeError")
})
