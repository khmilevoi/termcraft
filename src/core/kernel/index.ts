// `core/kernel`'s public entry (CLAUDE.md "Code style": every module gets a root
// `index.ts`) — kernel-assembly WP-1 Task 10. `createKernel` (Task 8) is the whole
// module's one composition function; `Kernel`/`KernelDeps` (`./types.ts`) are its return
// shape and dependency surface. Nothing else here is public: the seven machines, the event
// bus, the dedupe ledger, the handler registry, and every per-family handler module
// (`./model/handlers/*`) are `createKernel`'s own internal wiring, never imported directly
// by a caller outside this module (`ui` sees only `core/types.ts`'s boundary re-exports).

export { createKernel } from "./model/kernel";
export type { Kernel, KernelDeps } from "./types";
