import { afterEach, describe, expect, test } from "bun:test"
import { SupervisorError } from "./errors"
import { buildChildEnv, createBunSpawn } from "./spawn"
import type { SpawnedChild } from "../types"

const children: SpawnedChild[] = []
afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill()
    await child.exited
  }
})

describe("buildChildEnv", () => {
  test("is the explicit locale/timezone allowlist and carries no parent secrets", () => {
    process.env.TERMCRAFT_TEST_MARKER = "leak-me"
    const env = buildChildEnv()
    expect(env.LANG).toBe("C.UTF-8")
    expect(env.LC_ALL).toBe("C.UTF-8")
    expect(env.TZ).toBe("UTC")
    expect("TERMCRAFT_TEST_MARKER" in env).toBe(false)
    delete process.env.TERMCRAFT_TEST_MARKER
  })
})

describe("createBunSpawn", () => {
  test("returns a typed SupervisorError when the binary does not exist", () => {
    const spawn = createBunSpawn()
    const result = spawn({ cmd: ["C:/no/such/binary_termcraft_xyz.exe", "_host", "--stdio"] })
    expect(result).toBeInstanceOf(SupervisorError)
    if (result instanceof SupervisorError) {
      expect(result.code).toBe("SPAWN_FAILED")
      expect(result.reason).toContain("ENOENT")
    }
  })

  test("spawns a real echo-lite child and exposes streams + exited", async () => {
    const spawn = createBunSpawn()
    const result = spawn({ cmd: [process.execPath, "-e", "process.stdout.write('hi'); process.exit(0)"] })
    expect(result).not.toBeInstanceOf(SupervisorError)
    if (result instanceof SupervisorError) throw result
    children.push(result)
    let out = ""
    const dec = new TextDecoder()
    for await (const chunk of result.stdout) out += dec.decode(chunk, { stream: true })
    const code = await result.exited
    expect(out).toBe("hi")
    expect(code).toBe(0)
    expect(result.exitCode).toBe(0)
    expect(result.signalCode).toBeNull()
  })
})
