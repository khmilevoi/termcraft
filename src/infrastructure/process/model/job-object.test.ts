import { ptr, toArrayBuffer } from "bun:ffi";
import type { Pointer } from "bun:ffi";
import { expect, test } from "bun:test";

import { ProcessTreeError } from "../types";
import type { JobObjectSyscalls } from "./job-object";
import {
  KILL_ON_JOB_CLOSE,
  buildExtendedLimitInfo,
  buildTreeFromSyscalls,
  createFakeProcessTree,
} from "./job-object";

/**
 * A scripted kernel32 table for the FFI *failure* branches. `0` is Win32's
 * "the call failed" return for every BOOL-returning symbol here, and the real
 * kernel never produces it on demand for a healthy handle — which is exactly
 * why finding [9]'s `result === 0` guard survived every mutant until this
 * seam existed. Defaults are all-success so each test overrides only the one
 * call it is pinning.
 */
function scriptSyscalls(overrides: Partial<JobObjectSyscalls>): JobObjectSyscalls {
  const stub: JobObjectSyscalls = {
    CreateJobObjectW: () => fakeHandle(),
    AssignProcessToJobObject: () => 1,
    SetInformationJobObject: () => 1,
    QueryInformationJobObject: () => 1,
    OpenProcess: () => fakeHandle(),
    TerminateJobObject: () => 1,
    CloseHandle: () => 1,
    GetLastError: () => 5, // ERROR_ACCESS_DENIED
  };
  return { ...stub, ...overrides };
}

/** A real, non-null `Pointer` value the stubs never dereference. */
function fakeHandle(): Pointer {
  return ptr(new Uint8Array(8));
}

test("[9] activeProcesses() reports a ProcessTreeError when QueryInformationJobObject fails, never a bare 0", () => {
  // The mutant this kills: drop the `if (result === 0)` guard and return the
  // DataView read unconditionally. The buffer is allocated zeroes, so a
  // FAILED query would read as `0` — 'no live processes' — and agent-run's
  // pollUntilZero would treat a tree it cannot read as a CONFIRMED exit while
  // the agent's processes are still alive.
  const tree = buildTreeFromSyscalls(
    scriptSyscalls({ QueryInformationJobObject: () => 0 }),
    fakeHandle(),
  );
  const result = tree.activeProcesses();
  expect(result).toBeInstanceOf(ProcessTreeError);
  expect((result as ProcessTreeError).message).toContain("QueryInformationJobObject");
  expect(result).not.toBe(0);
});

test("[9] activeProcesses() returns the ActiveProcesses DWORD when QueryInformationJobObject succeeds", () => {
  // The other direction: the guard must not swallow a genuine success. Writes
  // 7 at ACTIVE_PROCESSES_OFFSET (40) of the caller's accounting buffer, so a
  // mutant that always errors — or that reads the wrong offset — fails here.
  const syscalls = scriptSyscalls({
    QueryInformationJobObject: (_job, _cls, buf, len) => {
      // `buf` is the raw `ptr(acctBuf)` the implementation passed; write back
      // through it exactly as the kernel would.
      const view = new DataView(toArrayBuffer(buf as Pointer, 0, len as number));
      view.setUint32(40, 7, true);
      return 1;
    },
  });
  expect(buildTreeFromSyscalls(syscalls, fakeHandle()).activeProcesses()).toBe(7);
});

test("[9] terminate() reports a ProcessTreeError when TerminateJobObject fails", () => {
  const tree = buildTreeFromSyscalls(scriptSyscalls({ TerminateJobObject: () => 0 }), fakeHandle());
  const result = tree.terminate();
  expect(result).toBeInstanceOf(ProcessTreeError);
  expect((result as ProcessTreeError).message).toContain("TerminateJobObject");
});

test("[9] adopt() reports a ProcessTreeError when AssignProcessToJobObject fails", () => {
  const tree = buildTreeFromSyscalls(
    scriptSyscalls({ AssignProcessToJobObject: () => 0 }),
    fakeHandle(),
  );
  const result = tree.adopt(4321);
  expect(result).toBeInstanceOf(ProcessTreeError);
  expect((result as ProcessTreeError).message).toContain("AssignProcessToJobObject");
});

test("[9] adopt() releases the process handle even when the assignment fails", () => {
  // The handle opened for the assignment must not leak on the failure path.
  const closed: Pointer[] = [];
  const opened = fakeHandle();
  const tree = buildTreeFromSyscalls(
    scriptSyscalls({
      OpenProcess: () => opened,
      AssignProcessToJobObject: () => 0,
      CloseHandle: (handle) => {
        closed.push(handle as Pointer);
        return 1;
      },
    }),
    fakeHandle(),
  );
  expect(tree.adopt(4321)).toBeInstanceOf(ProcessTreeError);
  expect(closed).toEqual([opened]);
});

test("[28] close() releases exactly one handle and never a second time", () => {
  const jobHandle = fakeHandle();
  const closed: Pointer[] = [];
  const tree = buildTreeFromSyscalls(
    scriptSyscalls({
      CloseHandle: (handle) => {
        closed.push(handle as Pointer);
        return 1;
      },
    }),
    jobHandle,
  );
  tree.close();
  tree.close();
  tree.close();
  expect(closed).toEqual([jobHandle]);
});

test("KILL_ON_JOB_CLOSE matches JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE (0x2000)", () => {
  expect(KILL_ON_JOB_CLOSE).toBe(0x2000);
});

test("the extended-limit struct is 144 bytes with kill-on-close at offset 16", () => {
  const buf = buildExtendedLimitInfo();
  expect(buf.byteLength).toBe(144);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  expect(view.getUint32(16, true)).toBe(KILL_ON_JOB_CLOSE);
});

test("the extended-limit struct sets no other byte besides the LimitFlags field", () => {
  const buf = buildExtendedLimitInfo();
  // LimitFlags (offset 16) little-endian 0x2000 -> only byte 17 (0x20) is non-zero.
  const nonZeroOffsets = Array.from(buf)
    .map((byte, offset) => ({ byte, offset }))
    .filter(({ byte }) => byte !== 0);
  expect(nonZeroOffsets).toEqual([{ byte: 0x20, offset: 17 }]);
});

test("a fake tree replays a scripted active-process count then zero", () => {
  const tree = createFakeProcessTree({ counts: [3, 3, 0] });
  expect(tree.adopt(1234)).toBeNull();
  expect(tree.activeProcesses()).toBe(3);
  expect(tree.activeProcesses()).toBe(3);
  expect(tree.terminate()).toBeNull();
  expect(tree.activeProcesses()).toBe(0);
});

test("a fake tree can be scripted to never confirm exit", () => {
  const tree = createFakeProcessTree({ counts: [2], neverZero: true });
  tree.terminate();
  expect(tree.activeProcesses()).toBe(2);
});

test("a fake tree with an empty script reports 0 active processes", () => {
  const tree = createFakeProcessTree({ counts: [] });
  expect(tree.activeProcesses()).toBe(0);
  expect(tree.terminate()).toBeNull();
  expect(tree.activeProcesses()).toBe(0);
});

test("a fake tree's adopt always succeeds regardless of pid", () => {
  const tree = createFakeProcessTree({ counts: [1] });
  expect(tree.adopt(-1)).toBeNull();
  expect(tree.adopt(999999)).toBeNull();
});

test("a fake tree's close is a no-op that never throws", () => {
  const tree = createFakeProcessTree({ counts: [1] });
  expect(() => tree.close()).not.toThrow();
});

test("a fake tree defaults to ownership NOT confirmed (scripts 'never adopted')", () => {
  const tree = createFakeProcessTree({ counts: [0] });
  expect(tree.ownershipConfirmed()).toBe(false);
});

test("a fake tree scripts 'adopted fine' up front via script.ownershipConfirmed", () => {
  const tree = createFakeProcessTree({ counts: [0], ownershipConfirmed: true });
  expect(tree.ownershipConfirmed()).toBe(true);
});

test("noteAdoptionOutcome(true) flips a fake tree to ownership confirmed", () => {
  const tree = createFakeProcessTree({ counts: [0] });
  expect(tree.ownershipConfirmed()).toBe(false);
  tree.noteAdoptionOutcome(true);
  expect(tree.ownershipConfirmed()).toBe(true);
});

test("noteAdoptionOutcome(false) never un-confirms a fake tree that already confirmed", () => {
  const tree = createFakeProcessTree({ counts: [0] });
  tree.noteAdoptionOutcome(true);
  tree.noteAdoptionOutcome(false);
  expect(tree.ownershipConfirmed()).toBe(true);
});
