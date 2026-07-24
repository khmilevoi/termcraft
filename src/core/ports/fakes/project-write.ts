import type { AssertConforms } from "../index";
import type { ProjectWriteCoordinator, ProjectWritePermit } from "../project-write";

/**
 * In-memory {@link ProjectWriteCoordinator} fake (6D task brief). Real FIFO-fair mutex
 * semantics (turn-durability §4.5): at most one permit is active; a second `acquire()`
 * queues and resolves only once the holder `release()`s, in exact call order. This is
 * the single mutex 6F must prove "acquired before the CAS" against, so the fake earns its
 * keep by actually excluding concurrent holders rather than minting an unlimited supply.
 *
 * This port carries NO failure channel — `acquire` always resolves, `release`/`isActive`
 * are synchronous with no error variant (see `project-write.ts`'s own doc) — so there is
 * no `failNext` here. The only "failure" scenario an orchestration test needs from a
 * mutex is "never released", which is already exercised by simply not calling `release`.
 *
 * `calls` is one combined, ORDER-preserving log (not one array per method) precisely so a
 * test can assert cross-method order ("acquire before release") without reconstructing it
 * from three separate arrays. An optional external {@link FakeCallSequence} lets several
 * fakes share one counter so their logs interleave comparably across ports.
 */

/** A monotonic call counter. Tests can share one instance across several fakes in this ring. */
export interface FakeCallSequence {
  next(): number;
}

/** Exported so a test — or another fake's own default — can mint one to share across ports. */
export function createSequence(): FakeCallSequence {
  let n = 0;
  return { next: () => n++ };
}

export type ProjectWriteCoordinatorCall =
  | { readonly seq: number; readonly method: "acquire" }
  | { readonly seq: number; readonly method: "acquire-granted"; readonly permitId: string }
  | {
      readonly seq: number;
      readonly method: "release";
      readonly permitId: string;
      readonly effective: boolean;
    }
  | {
      readonly seq: number;
      readonly method: "isActive";
      readonly permitId: string;
      readonly result: boolean;
    };

export interface FakeProjectWriteCoordinator extends ProjectWriteCoordinator {
  readonly calls: readonly ProjectWriteCoordinatorCall[];
}

export function createFakeProjectWriteCoordinator(options?: {
  readonly sequence?: FakeCallSequence;
}): FakeProjectWriteCoordinator {
  const sequence = options?.sequence ?? createSequence();
  const calls: ProjectWriteCoordinatorCall[] = [];

  let counter = 0;
  let active: ProjectWritePermit | null = null;
  const waiters: Array<(permit: ProjectWritePermit) => void> = [];

  function mintPermit(): ProjectWritePermit {
    counter += 1;
    return { permitId: `fake-permit-${counter}` };
  }

  function acquire(): Promise<ProjectWritePermit> {
    calls.push({ seq: sequence.next(), method: "acquire" });
    if (active === null) {
      const permit = mintPermit();
      active = permit;
      calls.push({ seq: sequence.next(), method: "acquire-granted", permitId: permit.permitId });
      return Promise.resolve(permit);
    }
    return new Promise((resolve) => {
      waiters.push((permit) => {
        calls.push({ seq: sequence.next(), method: "acquire-granted", permitId: permit.permitId });
        resolve(permit);
      });
    });
  }

  function release(permit: ProjectWritePermit): void {
    // Idempotent (port doc): a stale permit — already released, or superseded by a later
    // holder — is a no-op and must never drop the CURRENT holder's lock.
    const effective = active !== null && active.permitId === permit.permitId;
    calls.push({ seq: sequence.next(), method: "release", permitId: permit.permitId, effective });
    if (!effective) return;
    active = null;
    const next = waiters.shift();
    if (next === undefined) return;
    active = mintPermit();
    next(active);
  }

  function isActive(permit: ProjectWritePermit): boolean {
    const result = active !== null && active.permitId === permit.permitId;
    calls.push({ seq: sequence.next(), method: "isActive", permitId: permit.permitId, result });
    return result;
  }

  return { acquire, release, isActive, calls };
}

type _Conforms = AssertConforms<ProjectWriteCoordinator, FakeProjectWriteCoordinator>;
