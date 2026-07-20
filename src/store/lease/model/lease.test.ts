import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type { LeaseLockApi, LeaseLockHandle, LeaseProcessIdentity } from "../types"
import {
  createLeaseStore,
  LeaseHeldError,
  LeaseIoError,
  leaseLockPath,
  leaseNonce,
  systemLeaseIdentity,
  windowsLeaseLockApi,
} from "./lease"

const onWindows = process.platform === "win32"

const roots: string[] = []

/** A fresh project root with an existing `.termcraft/` — the layout §9 requires before acquisition. */
function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "termcraft-lease-"))
  fs.mkdirSync(path.join(root, ".termcraft"))
  roots.push(root)
  return root
}

const testIdentity: LeaseProcessIdentity = {
  pid: 4242,
  hostname: "test-host",
  startedAt: "2026-07-20T10:00:00.000Z",
}

/** An in-memory stand-in for the OS lock: one boolean of shared state, no filesystem. */
function fakeLockApi(state: { held: boolean; releases: number }): LeaseLockApi {
  return {
    acquire(): LeaseLockHandle | null {
      if (state.held) return null
      state.held = true
      return {
        release() {
          state.held = false
          state.releases += 1
        },
      }
    },
  }
}

function fakeStore(state: { held: boolean; releases: number }, nonce = "AAAAAAAAAAAAAAAAAAAAAA") {
  return createLeaseStore({ lock: fakeLockApi(state), identity: () => testIdentity, mintNonce: () => nonce })
}

afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true })
})

describe("leaseNonce", () => {
  test("is a 128-bit base64url random, not a UUIDv7", () => {
    const nonce = leaseNonce()
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(Buffer.from(nonce, "base64url").byteLength).toBe(16)
    expect(nonce).not.toMatch(/^[0-9a-f]{8}-/)
  })

  test("does not repeat across mints", () => {
    const minted = new Set(Array.from({ length: 256 }, () => leaseNonce()))
    expect(minted.size).toBe(256)
  })
})

describe("createLeaseStore (injected lock)", () => {
  test("acquires, mints a nonce, and writes advisory diagnostics while holding the lock", async () => {
    const root = makeRoot()
    const lease = await fakeStore({ held: false, releases: 0 }, "nonce-under-test-01").acquire(root)
    expect(lease).not.toBeInstanceOf(Error)
    if (lease instanceof Error) return

    expect(lease.nonce).toBe("nonce-under-test-01")
    expect(lease.lockPath).toBe(leaseLockPath(root))
    expect(JSON.parse(fs.readFileSync(lease.lockPath, "utf8"))).toEqual({
      pid: 4242,
      startedAt: "2026-07-20T10:00:00.000Z",
      hostname: "test-host",
      nonce: "nonce-under-test-01",
    })
  })

  test("crashed-owner path re-acquires the existing file and rewrites diagnostics, never deleting it", async () => {
    const root = makeRoot()
    const lockPath = leaseLockPath(root)
    // A crashed owner leaves its diagnostics behind; the OS released the lock.
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 111, startedAt: "2020-01-01T00:00:00Z", hostname: "gone", nonce: "x" }))
    const before = fs.statSync(lockPath).birthtimeMs

    const lease = await fakeStore({ held: false, releases: 0 }, "fresh-owner-nonce-1").acquire(root)
    expect(lease).not.toBeInstanceOf(Error)
    if (lease instanceof Error) return

    expect(fs.existsSync(lockPath)).toBe(true)
    expect(fs.statSync(lockPath).birthtimeMs).toBe(before)
    expect(JSON.parse(fs.readFileSync(lockPath, "utf8")).nonce).toBe("fresh-owner-nonce-1")
  })

  test("a held lock yields LeaseHeldError carrying the advisory metadata", async () => {
    const root = makeRoot()
    fs.writeFileSync(
      leaseLockPath(root),
      JSON.stringify({ pid: 777, startedAt: "2026-07-20T09:00:00Z", hostname: "owner-host", nonce: "OwnerNonce0000000000AA" }),
    )
    const held = await fakeStore({ held: true, releases: 0 }).acquire(root)
    expect(held).toBeInstanceOf(LeaseHeldError)
    if (!(held instanceof LeaseHeldError)) return
    expect(held.advisory).toEqual({
      pid: 777,
      startedAt: "2026-07-20T09:00:00Z",
      hostname: "owner-host",
      nonce: "OwnerNonce0000000000AA",
    })
    expect(held.message).toContain("advisory")
  })

  test("a held lock with an absent or garbage lock file yields an all-null advisory", async () => {
    const missing = makeRoot()
    const heldMissing = await fakeStore({ held: true, releases: 0 }).acquire(missing)
    expect(heldMissing).toBeInstanceOf(LeaseHeldError)
    if (heldMissing instanceof LeaseHeldError) {
      expect(heldMissing.advisory).toEqual({ pid: null, startedAt: null, hostname: null, nonce: null })
    }

    const garbage = makeRoot()
    fs.writeFileSync(leaseLockPath(garbage), "not json at all")
    const heldGarbage = await fakeStore({ held: true, releases: 0 }).acquire(garbage)
    expect(heldGarbage).toBeInstanceOf(LeaseHeldError)
    if (heldGarbage instanceof LeaseHeldError) {
      expect(heldGarbage.advisory).toEqual({ pid: null, startedAt: null, hostname: null, nonce: null })
    }
  })

  test("release() releases the OS lock exactly once and leaves the lock file in place", async () => {
    const root = makeRoot()
    const state = { held: false, releases: 0 }
    const lease = await fakeStore(state).acquire(root)
    if (lease instanceof Error) throw lease

    await lease.release()
    expect(state.held).toBe(false)
    expect(state.releases).toBe(1)
    await lease.release()
    expect(state.releases).toBe(1)
    expect(fs.existsSync(leaseLockPath(root))).toBe(true)
  })

  test("a missing `.termcraft/` directory is a typed IO error, never a throw", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "termcraft-lease-bare-"))
    roots.push(root)
    const result = await fakeStore({ held: false, releases: 0 }).acquire(root)
    expect(result).toBeInstanceOf(LeaseIoError)
  })

  test("an advisory write failure does not fail acquisition — the OS lock is the sole authority", async () => {
    const root = makeRoot()
    // A directory where the lock file belongs makes every write fail.
    fs.mkdirSync(leaseLockPath(root))
    const lease = await fakeStore({ held: false, releases: 0 }).acquire(root)
    expect(lease).not.toBeInstanceOf(Error)
  })
})

describe("readAdvisory", () => {
  test("returns null when the lock file is missing", async () => {
    expect(await fakeStore({ held: false, releases: 0 }).readAdvisory(makeRoot())).toBeNull()
  })

  test("nulls each individually invalid field instead of rejecting the whole record", async () => {
    const root = makeRoot()
    fs.writeFileSync(
      leaseLockPath(root),
      JSON.stringify({ pid: -3, startedAt: "yesterday", hostname: "keeps-this", nonce: "too-short", extra: "ignored" }),
    )
    expect(await fakeStore({ held: false, releases: 0 }).readAdvisory(root)).toEqual({
      pid: null,
      startedAt: null,
      hostname: "keeps-this",
      nonce: null,
    })
  })

  test("refuses an oversized lock file rather than buffering it", async () => {
    const root = makeRoot()
    fs.writeFileSync(leaseLockPath(root), "x".repeat(64 * 1024))
    expect(await fakeStore({ held: false, releases: 0 }).readAdvisory(root)).toBeNull()
  })
})

describe("PID is never ownership proof", () => {
  test("a forged live PID in the file never authorizes a takeover of a held lock", async () => {
    const root = makeRoot()
    // The forger claims this very process owns the lock — a live, matching, "reused" PID.
    fs.writeFileSync(leaseLockPath(root), JSON.stringify({ pid: process.pid, hostname: os.hostname(), nonce: null }))
    const result = await fakeStore({ held: true, releases: 0 }).acquire(root)
    expect(result).toBeInstanceOf(LeaseHeldError)
  })

  test("an absent/dead PID in the file neither blocks nor is trusted when the lock is free", async () => {
    const root = makeRoot()
    fs.writeFileSync(leaseLockPath(root), JSON.stringify({ pid: 999999, startedAt: null, hostname: "dead", nonce: null }))
    const lease = await fakeStore({ held: false, releases: 0 }, "taken-over-by-lock01").acquire(root)
    expect(lease).not.toBeInstanceOf(Error)
    if (lease instanceof Error) return
    // Acquisition came from the OS lock, and the stale file was rewritten, not deleted.
    expect(JSON.parse(fs.readFileSync(leaseLockPath(root), "utf8")).nonce).toBe("taken-over-by-lock01")
  })
})

describe.skipIf(!onWindows)("windowsLeaseLockApi (real OS lock)", () => {
  test("a second handle in the same process cannot take the lock", () => {
    const root = makeRoot()
    const lockPath = leaseLockPath(root)
    const first = windowsLeaseLockApi.acquire(lockPath)
    expect(first).not.toBeInstanceOf(Error)
    if (first === null || first instanceof Error) return

    expect(windowsLeaseLockApi.acquire(lockPath)).toBeNull()
    first.release()
    const third = windowsLeaseLockApi.acquire(lockPath)
    expect(third).not.toBeNull()
    if (third !== null && !(third instanceof Error)) third.release()
  })

  test("a readAdvisory of a held lock still reads the file (the lock does not block readers)", async () => {
    const root = makeRoot()
    const store = createLeaseStore({
      lock: windowsLeaseLockApi,
      identity: systemLeaseIdentity({ now: () => new Date() }),
      mintNonce: leaseNonce,
    })
    const lease = await store.acquire(root)
    if (lease instanceof Error) throw lease
    const advisory = await store.readAdvisory(root)
    expect(advisory?.nonce).toBe(lease.nonce)
    expect(advisory?.pid).toBe(process.pid)
    await lease.release()
  })
})

// ---- two real contending processes -------------------------------------------

const children: import("bun").Subprocess[] = []

afterAll(async () => {
  for (const child of children) {
    child.kill()
    await child.exited
  }
})

const LEASE_MODULE_URL = Bun.pathToFileURL(path.join(import.meta.dir, "lease.ts")).href
const REPO_ROOT = path.resolve(import.meta.dir, "../../../..")

/**
 * A child that tries to take the lease and, on success, holds it until killed.
 * It prints exactly one line: `ACQUIRED:<nonce>` or `HELD:<tag>`.
 */
function holderScript(root: string): string {
  return [
    `const mod = await import(${JSON.stringify(LEASE_MODULE_URL)})`,
    `const store = mod.createLeaseStore({`,
    `  lock: mod.windowsLeaseLockApi,`,
    `  identity: mod.systemLeaseIdentity({ now: () => new Date() }),`,
    `  mintNonce: mod.leaseNonce,`,
    `})`,
    `const result = await store.acquire(${JSON.stringify(root)})`,
    `if (result instanceof Error) { process.stdout.write("HELD:" + result._tag + "\\n"); process.exit(3) }`,
    `process.stdout.write("ACQUIRED:" + result.nonce + "\\n")`,
    `setInterval(() => {}, 3_600_000)`,
  ].join("\n")
}

function spawnHolder(root: string): import("bun").Subprocess {
  const child = Bun.spawn({
    cmd: [process.execPath, "-e", holderScript(root)],
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  })
  children.push(child)
  return child
}

/** First stdout line, or a rejection — so a wedged child fails the test instead of hanging it. */
async function firstLine(child: import("bun").Subprocess): Promise<string> {
  const reader = (child.stdout as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()
  let buffered = ""
  const deadline = Date.now() + 20_000
  while (!buffered.includes("\n") && Date.now() < deadline) {
    const chunk = await reader.read()
    if (chunk.done) break
    buffered += decoder.decode(chunk.value, { stream: true })
  }
  reader.releaseLock()
  return buffered.split("\n")[0] ?? ""
}

describe.skipIf(!onWindows)("two real processes contending for one project", () => {
  test("exactly one process holds the lease", async () => {
    const root = makeRoot()
    const first = spawnHolder(root)
    expect(await firstLine(first)).toStartWith("ACQUIRED:")

    const second = spawnHolder(root)
    expect(await firstLine(second)).toBe("HELD:LeaseHeldError")
    expect(await second.exited).toBe(3)

    // The in-test process is a third contender and is refused just the same.
    const store = createLeaseStore({
      lock: windowsLeaseLockApi,
      identity: systemLeaseIdentity({ now: () => new Date() }),
      mintNonce: leaseNonce,
    })
    expect(await store.acquire(root)).toBeInstanceOf(LeaseHeldError)

    first.kill()
    await first.exited
  }, 40_000)

  test("abrupt termination releases the OS lock though the lock file remains", async () => {
    const root = makeRoot()
    const holder = spawnHolder(root)
    const acquired = await firstLine(holder)
    expect(acquired).toStartWith("ACQUIRED:")
    const heldNonce = acquired.slice("ACQUIRED:".length)

    const store = createLeaseStore({
      lock: windowsLeaseLockApi,
      identity: systemLeaseIdentity({ now: () => new Date() }),
      mintNonce: leaseNonce,
    })
    expect(await store.acquire(root)).toBeInstanceOf(LeaseHeldError)

    // No graceful shutdown: the kernel closes the handle, which releases the lock.
    holder.kill()
    await holder.exited

    expect(fs.existsSync(leaseLockPath(root))).toBe(true)
    const advisoryOfDeadOwner = await store.readAdvisory(root)
    expect(advisoryOfDeadOwner?.nonce).toBe(heldNonce)

    const lease = await store.acquire(root)
    expect(lease).not.toBeInstanceOf(Error)
    if (lease instanceof Error) return
    expect(lease.nonce).not.toBe(heldNonce)
    await lease.release()
  }, 40_000)

  test("a forged PID written under a live holder never authorizes a takeover", async () => {
    const root = makeRoot()
    const holder = spawnHolder(root)
    expect(await firstLine(holder)).toStartWith("ACQUIRED:")

    // Forge every advisory field an attacker could reach: our own live PID, our own
    // hostname, a plausible start time. None of it is consulted.
    fs.writeFileSync(
      leaseLockPath(root),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), hostname: os.hostname(), nonce: null }),
    )

    const store = createLeaseStore({
      lock: windowsLeaseLockApi,
      identity: systemLeaseIdentity({ now: () => new Date() }),
      mintNonce: leaseNonce,
    })
    const refused = await store.acquire(root)
    expect(refused).toBeInstanceOf(LeaseHeldError)
    if (refused instanceof LeaseHeldError) expect(refused.advisory.pid).toBe(process.pid)

    holder.kill()
    await holder.exited
  }, 40_000)
})
