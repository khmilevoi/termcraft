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

/**
 * The outcome of a {@link WriteMutexChain}. `error` is the permit channel only — a domain
 * failure travels as a value inside `result`, because the chain guards write ownership, not
 * business rules.
 */
export type WriteMutexChainResult<TResult> =
  | { readonly error: null; readonly result: TResult }
  | { readonly error: WritePermitInvalidError; readonly result: null }

/**
 * A sequential chain of permit-protected write steps. Each callback receives the preceding
 * callback's result, and the permit is re-checked immediately BEFORE every callback runs —
 * so adding a step to a protocol cannot forget its ownership check the way a hand-written
 * ladder of `assertActivePermit` calls can.
 *
 * The check is deliberately before-only: a step that started under a valid permit runs to
 * completion even if the permit is released mid-step. After `intent.json` is durable the
 * transaction is past the point of no rollback (turn-durability §4.3), so aborting a
 * half-applied step would be worse than finishing it; the next step catches the staleness.
 */
export interface WriteMutexChain<TPrevious> extends PromiseLike<WriteMutexChainResult<TPrevious>> {
  do<TResult>(callback: (previous: TPrevious) => TResult | PromiseLike<TResult>): WriteMutexChain<TResult>
}

export interface WriteMutex {
  /** FIFO fair: resolves in the exact order callers invoke `acquire` (turn-durability §4.5). */
  acquire(): Promise<ProjectWritePermit>
  /** Idempotent: releasing an already-stale permit is a no-op and never drops a later holder's lock. */
  release(permit: ProjectWritePermit): void
  isActive(permit: ProjectWritePermit): boolean
  /** Starts a sequential chain of permit-protected write steps. */
  chain(permit: ProjectWritePermit): WriteMutexChain<void>
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

function makePermitInvalidError(permit: ProjectWritePermit): WritePermitInvalidError {
  return new WritePermitInvalidError({ permitId: permit.permitId })
}

function makeInvalidChainResult<TResult>(permit: ProjectWritePermit): WriteMutexChainResult<TResult> {
  return { error: makePermitInvalidError(permit), result: null }
}

function makeWriteMutexChain<TPrevious>(
  permit: ProjectWritePermit,
  isActive: (permit: ProjectWritePermit) => boolean,
  statePromise: Promise<WriteMutexChainResult<TPrevious>>,
): WriteMutexChain<TPrevious> {
  return {
    do<TResult>(callback: (previous: TPrevious) => TResult | PromiseLike<TResult>): WriteMutexChain<TResult> {
      const nextStatePromise = statePromise.then(async (previousState): Promise<WriteMutexChainResult<TResult>> => {
        // An earlier step already found the permit stale: preserve that error and run none
        // of the remaining callbacks.
        if (previousState.error !== null) return { error: previousState.error, result: null }

        // Re-check immediately before executing this individual step.
        if (!isActive(permit)) return makeInvalidChainResult<TResult>(permit)

        return { error: null, result: await callback(previousState.result) }
      })

      return makeWriteMutexChain(permit, isActive, nextStatePromise)
    },

    then(onFulfilled, onRejected) {
      return statePromise.then(onFulfilled, onRejected)
    },
  }
}

/**
 * The in-process FIFO project-write mutex (turn-durability §4.5). Exactly one permit is
 * active at a time; `acquire` calls queue and are granted in exact call order. Every
 * mutating step must check {@link WriteMutex.isActive} before writing — `release` flips the
 * active permit immediately, so a stale async continuation that still holds the old
 * `ProjectWritePermit` object fails that check even though its object reference is
 * unchanged. Prefer {@link WriteMutex.chain} over a hand-written ladder of checks.
 *
 * This mutex protects only operations running inside the same JavaScript process; the
 * cross-process guarantee is the OS-held `ProjectLease` (`store/lease`).
 */
export function createWriteMutex(deps: WriteMutexDeps = defaultWriteMutexDeps()): WriteMutex {
  let activePermitId: string | null = null
  const waiters: Array<() => void> = []

  function grant(resolve: (permit: ProjectWritePermit) => void): void {
    const permitId = deps.mintPermitId()
    activePermitId = permitId
    resolve({ permitId })
  }

  function isActive(permit: ProjectWritePermit): boolean {
    return activePermitId !== null && activePermitId === permit.permitId
  }

  return {
    acquire() {
      return new Promise<ProjectWritePermit>((resolve) => {
        const attempt = (): void => grant(resolve)
        if (activePermitId === null && waiters.length === 0) {
          attempt()
          return
        }
        waiters.push(attempt)
      })
    },

    release(permit) {
      // A stale or repeatedly released permit must not release the mutex for a newer holder.
      if (!isActive(permit)) return
      activePermitId = null
      const nextWaiter = waiters.shift()
      if (nextWaiter !== undefined) nextWaiter()
    },

    isActive,

    chain(permit) {
      const initialState: WriteMutexChainResult<void> = isActive(permit)
        ? { error: null, result: undefined }
        : makeInvalidChainResult<void>(permit)
      return makeWriteMutexChain(permit, isActive, Promise.resolve(initialState))
    },
  }
}

/** A standalone permit check, for a single guarded step where a chain would add no structure. */
export function assertActivePermit(mutex: WriteMutex, permit: ProjectWritePermit): WritePermitInvalidError | null {
  return mutex.isActive(permit) ? null : makePermitInvalidError(permit)
}
