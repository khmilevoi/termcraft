import path from "node:path";

import { sha256Hex } from "store/jsonl";
import {
  FsAccessError,
  createSafeProjectFs,
  isNotFound,
  nodeSafeFsDeps,
  openManagedRoot,
} from "store/safe-fs";
import type { SafeFsError, SafeProjectFs } from "store/safe-fs";

import type { FileImage, TransactionBoundary, TransactionPlan } from "../types";
import { type RecoveryOutcome, nodeRecoveryFsDeps, recoverTransactions } from "./recovery";
import { createWriteMutex } from "./write-mutex";

// The MANDATORY fault-injection harness (turn-durability §14.1): the test authority for
// every durability boundary. A real `bun` CHILD process performs one transaction attempt and
// terminates itself — via `process.exit` — at an injected physical boundary WITHOUT any
// cleanup; the parent (`bun test`) process then reopens the same `.termcraft` root fresh,
// runs `./recovery`'s startup scan, and the test asserts the managed tree landed at exactly
// the pre-intent old state or the exact committed new state — never a mixed state, and never
// a duplicate append identity.
//
// The child is spawned with `bun -e "<generated script>"`. It resolves every termcraft module
// by dynamically `import()`-ing that module's own file, by absolute `file://` URL, rather than
// by bare specifier — the SAME technique already established by `store/lease`'s
// `lease.test.ts` (`spawnHolder`/`holderScript`) for spawning a real contending process. Once
// the entry point's first `import()` lands inside the repository tree, every module's OWN
// internal imports (bare `entities/*`/`store/*`/`infrastructure/*` specifiers, and npm
// packages) resolve normally via the nearest `tsconfig.json`/`node_modules` — no
// `--tsconfig-override` or `NODE_PATH` is needed, and none is used.

const REPO_ROOT = path.resolve(import.meta.dir, "../../../..");
const TRANSACTION_MODULE_URL = Bun.pathToFileURL(path.join(import.meta.dir, "../index.ts")).href;
const SAFE_FS_MODULE_URL = Bun.pathToFileURL(
  path.join(REPO_ROOT, "src/store/safe-fs/index.ts"),
).href;

/** The exit code the child deliberately calls `process.exit` with at the injected boundary — distinct from a normal commit (0) or a rejected-plan exit, so a child that died for an unrelated reason is never mistaken for "crashed exactly where the test asked". */
export const CRASH_EXIT_CODE = 87;
/** The child's exit code when `runTransaction` returned an `Error | T` failure — a rejected plan, not a crash. */
export const CHILD_TX_ERROR_EXIT_CODE = 2;
/** The child's exit code when it could not even open the managed root. */
export const CHILD_SETUP_ERROR_EXIT_CODE = 3;

/** One plan payload, base64-encoded so it survives being embedded as a JSON literal in the generated child script. */
export interface ChildPayload {
  readonly payloadId: string;
  readonly bytesBase64: string;
}

/**
 * Where and how the child deliberately dies. `"boundary"` fires `process.exit` from the
 * engine's own `onBoundary` hook — every named artifact in `TransactionBoundary`.
 * `"partial-append"` simulates a torn disk write of an `append-jsonl` operation's own bytes:
 * a sub-step `TransactionBoundary` cannot name on its own (documented in `../types`'s
 * `TransactionBoundary` granularity note — the physical append write is one call inside
 * `infrastructure/durability`-composed `appendInPlace`, not independently boundary-injectable
 * at the artifact level this module owns). `"none"` is the control run: the transaction
 * completes normally and the child exits 0.
 */
export type ChildCrashMode =
  | { readonly kind: "boundary"; readonly boundary: TransactionBoundary }
  | { readonly kind: "partial-append"; readonly truncateAppendedBytesTo: number }
  | { readonly kind: "none" };

export interface RunPlanInChildInput {
  readonly termcraftDir: string;
  readonly plan: TransactionPlan;
  readonly payloads: readonly ChildPayload[];
  readonly crash: ChildCrashMode;
}

export interface ChildRunResult {
  readonly exitCode: number | null;
  readonly signalCode: string | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Build the child's entire program as one `bun -e` source string, with every input embedded as a JSON literal (mirrors `store/lease`'s `holderScript`). */
function childScript(input: RunPlanInChildInput): string {
  const setup = [
    `const store = await import(${JSON.stringify(TRANSACTION_MODULE_URL)})`,
    `const safeFsMod = await import(${JSON.stringify(SAFE_FS_MODULE_URL)})`,
    `const termcraftDir = ${JSON.stringify(input.termcraftDir)}`,
    `const plan = ${JSON.stringify(input.plan)}`,
    `const payloadEntries = ${JSON.stringify(input.payloads)}`,
    `const payloads = new Map(payloadEntries.map((p) => [p.payloadId, new Uint8Array(Buffer.from(p.bytesBase64, "base64"))]))`,
    `const fsDeps = safeFsMod.nodeSafeFsDeps()`,
    `const root = safeFsMod.openManagedRoot({ kind: "project", path: termcraftDir, deps: fsDeps })`,
    `if (root instanceof Error) { process.stdout.write("SETUP_ERROR:" + root.message + "\\n"); process.exit(${CHILD_SETUP_ERROR_EXIT_CODE}) }`,
    `const safeFs = safeFsMod.createSafeProjectFs(root, fsDeps)`,
    `const mutex = store.createWriteMutex()`,
    `const permit = await mutex.acquire()`,
    `const baseDeps = store.nodeTransactionFsDeps(safeFs)`,
  ];

  const deps =
    input.crash.kind === "boundary"
      ? [
          `const crashAt = ${JSON.stringify(input.crash.boundary)}`,
          `const deps = { ...baseDeps, onBoundary: (name) => { if (name === crashAt) process.exit(${CRASH_EXIT_CODE}) } }`,
        ]
      : input.crash.kind === "partial-append"
        ? [
            `const truncateTo = ${JSON.stringify(input.crash.truncateAppendedBytesTo)}`,
            `const fsNode = await import("node:fs")`,
            // A hand-rolled `appendInPlace` that durably writes only a LEADING PREFIX of the
            // prepared append bytes, then dies — simulating the disk having captured only
            // part of the physical write before power loss, never returning to the caller.
            `const deps = { ...baseDeps, appendInPlace: (appendInput) => {`,
            `  const fd = fsNode.openSync(appendInput.absPath, "r+")`,
            `  fsNode.ftruncateSync(fd, appendInput.truncateTo)`,
            `  const torn = appendInput.bytes.subarray(0, Math.min(truncateTo, appendInput.bytes.byteLength))`,
            `  fsNode.writeSync(fd, torn, 0, torn.byteLength, appendInput.offset)`,
            `  fsNode.fsyncSync(fd)`,
            `  fsNode.closeSync(fd)`,
            `  process.exit(${CRASH_EXIT_CODE})`,
            `} }`,
          ]
        : [`const deps = baseDeps`];

  const run = [
    `const result = await store.runTransaction(deps, { mutex, permit, plan, payloads })`,
    `if (result instanceof Error) { process.stdout.write("TX_ERROR:" + result._tag + ":" + result.message + "\\n"); process.exit(${CHILD_TX_ERROR_EXIT_CODE}) }`,
    `process.stdout.write("COMMITTED:" + result.transactionId + "\\n")`,
    `process.exit(0)`,
  ];

  return [...setup, ...deps, ...run].join("\n");
}

/** Spawn a real `bun` child that attempts one transaction and dies exactly where `input.crash` says. Every stream is drained and the child is always reaped — the caller never needs to poll or kill it. */
export async function runPlanInChildProcess(input: RunPlanInChildInput): Promise<ChildRunResult> {
  const child = Bun.spawn({
    cmd: [process.execPath, "-e", childScript(input)],
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, signalCode: child.signalCode, stdout, stderr };
}

// ---- post-recovery assertions -------------------------------------------------------

function imagesEqual(a: FileImage, b: FileImage): boolean {
  if (a.state === "absent" && b.state === "absent") return true;
  if (a.state === "file" && b.state === "file") return a.sha256 === b.sha256 && a.size === b.size;
  return false;
}

function observeFileImage(safeFs: SafeProjectFs, relTarget: string): SafeFsError | FileImage {
  const bytes = safeFs.readFile(relTarget);
  if (bytes instanceof Error) {
    if (bytes instanceof FsAccessError && isNotFound(bytes)) return { state: "absent" };
    return bytes;
  }
  return { state: "file", sha256: sha256Hex(bytes), size: bytes.byteLength };
}

export type PlanTargetsState = "all-old" | "all-new" | "mixed";

/**
 * The core §14.1 assertion: "the complete managed tree must equal the exact pre-intent old
 * state or the exact committed new state... never merely 'no exception'". Rather than
 * requiring the caller to know in advance whether a given boundary lands before or after
 * intent, this simply observes every operation's target and demands they are UNANIMOUSLY at
 * their old image or UNANIMOUSLY at their new image — any target at neither, or a split
 * between old and new across operations, is `"mixed"` and always a test failure.
 */
export function observePlanTargetsState(
  safeFs: SafeProjectFs,
  plan: TransactionPlan,
): SafeFsError | PlanTargetsState {
  let sawOld = false;
  let sawNew = false;
  for (const op of plan.operations) {
    const current = observeFileImage(safeFs, op.target);
    if (current instanceof Error) return current;
    if (imagesEqual(current, op.oldImage)) {
      sawOld = true;
      continue;
    }
    if (imagesEqual(current, op.newImage)) {
      sawNew = true;
      continue;
    }
    return "mixed";
  }
  if (sawOld && sawNew) return "mixed";
  return sawNew ? "all-new" : "all-old";
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let at = 0;
  for (;;) {
    const found = haystack.indexOf(needle, at);
    if (found === -1) return count;
    count += 1;
    at = found + needle.length;
  }
}

/** No `recordId` from any `append-jsonl` operation appears more than once in its target's realized bytes (§14.1: "duplicate append identities must be absent"). A target still at its pre-append state trivially satisfies this. */
export function hasNoDuplicateAppendIdentity(
  safeFs: SafeProjectFs,
  plan: TransactionPlan,
): SafeFsError | boolean {
  for (const op of plan.operations) {
    if (op.mode !== "append-jsonl" || op.append === undefined) continue;
    const bytes = safeFs.readFile(op.target);
    if (bytes instanceof Error) {
      if (bytes instanceof FsAccessError && isNotFound(bytes)) continue;
      return bytes;
    }
    const text = new TextDecoder().decode(bytes);
    for (const recordId of op.append.recordIds) {
      if (countOccurrences(text, `"${recordId}"`) > 1) return false;
    }
  }
  return true;
}

// ---- the full case: spawn, crash, reopen, recover, assert --------------------------

export interface CrashCase {
  readonly termcraftDir: string;
  readonly plan: TransactionPlan;
  readonly payloads: readonly ChildPayload[];
  readonly crash: ChildCrashMode;
}

export type CrashCaseOutcome =
  | { readonly ok: false; readonly stage: "reopen"; readonly error: SafeFsError }
  | {
      readonly ok: true;
      readonly child: ChildRunResult;
      readonly recovery: RecoveryOutcome;
      readonly targetsState: SafeFsError | PlanTargetsState;
      readonly noDuplicateIdentity: SafeFsError | boolean;
    };

/**
 * Run one complete fault-injection case: spawn the child, let it die per `input.crash`,
 * reopen `input.termcraftDir` in THIS process as a fresh `SafeProjectFs`/mutex/permit (a
 * cold start has none of the crashed process's in-memory state), run `./recovery`'s startup
 * scan, then observe the plan's own targets. The caller asserts on the returned outcome —
 * this function performs no assertions itself, so it stays reusable across every boundary a
 * test sweeps.
 */
export async function runCrashCase(input: CrashCase): Promise<CrashCaseOutcome> {
  const child = await runPlanInChildProcess({
    termcraftDir: input.termcraftDir,
    plan: input.plan,
    payloads: input.payloads,
    crash: input.crash,
  });

  const fsDeps = nodeSafeFsDeps();
  const root = openManagedRoot({ kind: "project", path: input.termcraftDir, deps: fsDeps });
  if (root instanceof Error) return { ok: false, stage: "reopen", error: root };
  const safeFs = createSafeProjectFs(root, fsDeps);

  const recoveryDeps = nodeRecoveryFsDeps(safeFs);
  const mutex = createWriteMutex();
  const permit = await mutex.acquire();
  const recovery = await recoverTransactions(recoveryDeps, mutex, permit);

  return {
    ok: true,
    child,
    recovery,
    targetsState: observePlanTargetsState(safeFs, input.plan),
    noDuplicateIdentity: hasNoDuplicateAppendIdentity(safeFs, input.plan),
  };
}
