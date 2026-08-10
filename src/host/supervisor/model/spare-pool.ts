import { log } from "infrastructure/debug-log";

import type { SpawnCommand, SpawnFn, SpawnedChild } from "../types";

/**
 * A pool of pre-spawned, un-handshaked `_host --stdio` children (design §9.3): "one booted,
 * handshaked, un-mounted spare process is kept ready and replenished after each adoption."
 *
 * THE DIVERGENCE, DECIDED HERE RATHER THAN DISCOVERED. The spare shipped here is booted and
 * NOT handshaked. `client.hello` is a `z.strictObject` requiring `mode`, `pageSlug`,
 * `sourceHash` and `sourceKitApiVersion` (`host/protocol/model/hello.ts:50-60`), all of which
 * are facts about a mount the spare does not have yet — making them optional would be a
 * host-supervision §5.1 wire change for one message round trip. MEASURED (design-tree phase 3
 * Task 6, Step 1; Bun 1.3.14, five runs each, spawn-to-first-stdout-byte): with `client.hello`
 * sent immediately, 584.4-685.7ms, median 596.5ms (boot + handshake); with `client.hello`
 * deferred 3000ms (letting the child finish booting first), the round trip past that wait was
 * 31.1-41.7ms, median 36.8ms (handshake alone, post-boot). The implied boot cost — what a spare
 * removes — is therefore ~560ms, roughly 94% of the cold-start total, well past the "roughly a
 * third" bar for building this at all. Holding the hello until adoption also makes the 10s
 * handshake budget generous instead of tight, because it no longer has to cover the boot.
 *
 * STDERR IS NOT DRAINED WHILE A SPARE IS IDLE. `session.ts` creates the stderr drain at
 * `start()`, and an `AsyncIterable` cannot be consumed twice, so the pool must not read it. A
 * booted host writes nothing to stderr before its hello; if one ever did, the worst case is
 * that spare's stderr pipe filling and the child blocking, which the adoption then observes as
 * a handshake timeout — the ordinary budgeted failure path, not a new one.
 *
 * THE CAP is the caller's problem, stated as an invariant because it is easy to get off by one.
 * `deps.canGrow()` is the supervisor's own admission rule (`keyed live + spares < maxGlobalHosts`,
 * design §13's ≤10) — this module never reasons about the global cap itself, only about its own
 * `capacity`.
 */
export interface SparePool {
  /** A pre-spawned child, or `null` when the pool is empty. Never spawns on the caller's behalf. */
  take(): SpawnedChild | null;
  /** Spawn up to `capacity` spares if `canGrow()` allows it. Idempotent; never throws. */
  replenish(): void;
  size(): number;
  /** Kill and forget every idle spare. */
  drain(): void;
}

export interface SparePoolDeps {
  readonly spawn: SpawnFn;
  readonly command: SpawnCommand;
  readonly capacity: number;
  /** The supervisor's own admission rule; the pool never reasons about the global cap itself. */
  readonly canGrow: () => boolean;
}

export function createSparePool(deps: SparePoolDeps): SparePool {
  let idle: SpawnedChild[] = [];

  function drop(child: SpawnedChild): void {
    idle = idle.filter((candidate) => candidate !== child);
  }

  function replenish(): void {
    while (idle.length < deps.capacity && deps.canGrow()) {
      const spawned = deps.spawn(deps.command);
      if (spawned instanceof Error) {
        // A spare that could not be pre-spawned is not a failure the caller can act on — it
        // is not holding a session, and a cold spawn on adoption is the ordinary fallback
        // (errore rule 21: leave a trace, never fail silently).
        log.warn("spare-pool: replenish spawn failed:", spawned.message);
        return;
      }
      idle.push(spawned);
      void spawned.exited.then(() => drop(spawned));
    }
  }

  function take(): SpawnedChild | null {
    while (idle.length > 0) {
      const child = idle.shift();
      if (child === undefined) return null;
      // Already exited while idle (`exited` settled before `take` observed it): skip, never
      // hand out a dead child.
      if (child.exitCode !== null || child.signalCode !== null) continue;
      return child;
    }
    return null;
  }

  function size(): number {
    return idle.length;
  }

  function drain(): void {
    for (const child of idle) child.kill();
    idle = [];
  }

  return { take, replenish, size, drain };
}
