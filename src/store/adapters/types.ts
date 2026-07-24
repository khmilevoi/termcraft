import type { Clock } from "infrastructure/clock";

import type { OpenProject } from "../types";

// Every store adapter wraps the SAME open project handle plus the two minting seams a
// permit-managed `TransactionEngine` method's `*Input` shape requires
// (`transactionId`/`actionId` via `uuidv7`, `createdAt` via `clock.now().toISOString()`) —
// see `store/types.ts:236-313`. `OpenProject` is imported via a relative path to the
// module's own root `types.ts` (mirroring `store/model/factory.ts`'s identical import),
// never through the `store` barrel — `store/index.ts` itself re-exports these adapters, and
// importing back through it would be a cycle.

/** Every store adapter's constructor input (plan Task 1, "the `{ open, uuidv7, clock }` deps bundle"). */
export interface StoreAdapterDeps {
  readonly open: OpenProject;
  readonly uuidv7: () => string;
  readonly clock: Clock;
}

/** `clock.now().toISOString()` — every named `TransactionEngine` input's `createdAt`. */
export function nowIso(clock: Clock): string {
  return clock.now().toISOString();
}
