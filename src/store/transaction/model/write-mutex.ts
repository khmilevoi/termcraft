import crypto from "node:crypto"
import * as errore from "errore"

import type { ProjectWritePermit } from "../types"

/**
 * A mutating call's permit is no longer the write mutex's active permit — either `release`
 * already ran for it, or a later `acquire` has since won the mutex (turn-durability §4.5:
 * "Release invalidates it; a stale async continuation cannot write after release."). Every
 * mutating transaction-engine step returns this instead of writing when it fires.
 */
export class WritePermitInvalidError extends errore.createTaggedError({
  name: "WritePermitInvalidError",
  message: "write permit $permitId is not the mutex's active permit",
}) {}

export interface WriteMutex {
  /** FIFO fair: resolves in the exact order callers invoke `acquire` (turn-durability §4.5). */
  acquire(): Promise<ProjectWritePermit>
  /** Idempotent: releasing an already-stale permit is a no-op and never drops a later holder's lock. */
  release(permit: ProjectWritePermit): void
  isActive(permit: ProjectWritePermit): boolean
}

export interface WriteMutexDeps {
  readonly mintPermitId: () => string
}

/** 128-bit CSPRNG, base64url — mirrors `store/lease`'s `leaseNonce`: a random id, not a UUIDv7 (the roadmap's identity registry does not list `permitId`). */
export function mintWritePermitId(): string {
  const bytes = new Uint8Array(16)
  crypto.webcrypto.getRandomValues(bytes)
  return Buffer.from(bytes).toString("base64url")
}

export function defaultWriteMutexDeps(): WriteMutexDeps {
  return { mintPermitId: mintWritePermitId }
}

/**
 * The in-process FIFO project-write mutex (turn-durability §4.5). Exactly one permit is
 * active at a time; `acquire` calls queue and are granted in exact call order. Every
 * mutating `SafeProjectFs`/transaction-engine step must check {@link WriteMutex.isActive}
 * before writing — `release` flips `active` immediately, so a stale async continuation that
 * still holds the old `ProjectWritePermit` object fails that check even though its object
 * reference is unchanged.
 */
export function createWriteMutex(deps: WriteMutexDeps = defaultWriteMutexDeps()): WriteMutex {
  let active: string | null = null
  const waiters: Array<() => void> = []

  function grant(resolve: (permit: ProjectWritePermit) => void): void {
    const permitId = deps.mintPermitId()
    active = permitId
    resolve({ permitId })
  }

  return {
    acquire() {
      return new Promise((resolve) => {
        const attempt = () => grant(resolve)
        if (active === null && waiters.length === 0) {
          attempt()
          return
        }
        waiters.push(attempt)
      })
    },

    release(permit) {
      if (permit.permitId !== active) return
      active = null
      const next = waiters.shift()
      if (next !== undefined) next()
    },

    isActive(permit) {
      return active !== null && active === permit.permitId
    },
  }
}

/** The re-check every mutating engine step performs before writing (turn-durability §4.5). */
export function assertActivePermit(mutex: WriteMutex, permit: ProjectWritePermit): WritePermitInvalidError | null {
  return mutex.isActive(permit) ? null : new WritePermitInvalidError({ permitId: permit.permitId })
}
