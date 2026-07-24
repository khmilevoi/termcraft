import type { AssertConforms, ProjectWriteCoordinator, ProjectWritePermit } from "core/ports";
import type { WriteMutex } from "store/transaction";

// `createProjectWriteAdapter` — the `ProjectWriteCoordinator` port over `store/transaction`'s
// real `WriteMutex` (plan Task 2). Deliberately narrower deps than `StoreAdapterDeps`: this
// adapter needs only the mutex, never `uuidv7`/`clock`. The caller MUST pass the SAME
// `WriteMutex` instance `OpenProject.writeMutex` exposes (the SAME one `TransactionEngine`'s
// own methods acquire/release against internally, per `store/types.ts`'s divergence note 1 —
// blocker B2) — never a second, independently-created mutex, which would silently break
// single-writer exclusion (Design Q1's option 2).
//
// The real store `ProjectWritePermit` (`store/transaction`'s `{ permitId: string }`) is
// structurally identical to core's own `ProjectWritePermit` declared on this port
// (`core/ports/project-write.ts`), so `acquire()`'s return value satisfies the port with no
// wrapper object.

export function createProjectWriteAdapter(deps: {
  readonly mutex: WriteMutex;
}): ProjectWriteCoordinator {
  const { mutex } = deps;

  async function acquire(): Promise<ProjectWritePermit> {
    return mutex.acquire();
  }

  function release(permit: ProjectWritePermit): void {
    mutex.release(permit);
  }

  function isActive(permit: ProjectWritePermit): boolean {
    return mutex.isActive(permit);
  }

  return { acquire, release, isActive };
}

type _Conforms = AssertConforms<
  ProjectWriteCoordinator,
  ReturnType<typeof createProjectWriteAdapter>
>;
