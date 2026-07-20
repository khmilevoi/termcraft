import { expect, test } from "bun:test"
import { buildExtendedLimitInfo, createFakeProcessTree, KILL_ON_JOB_CLOSE } from "./job-object"

test("KILL_ON_JOB_CLOSE matches JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE (0x2000)", () => {
  expect(KILL_ON_JOB_CLOSE).toBe(0x2000)
})

test("the extended-limit struct is 144 bytes with kill-on-close at offset 16", () => {
  const buf = buildExtendedLimitInfo()
  expect(buf.byteLength).toBe(144)
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  expect(view.getUint32(16, true)).toBe(KILL_ON_JOB_CLOSE)
})

test("the extended-limit struct sets no other byte besides the LimitFlags field", () => {
  const buf = buildExtendedLimitInfo()
  // LimitFlags (offset 16) little-endian 0x2000 -> only byte 17 (0x20) is non-zero.
  const nonZeroOffsets = Array.from(buf)
    .map((byte, offset) => ({ byte, offset }))
    .filter(({ byte }) => byte !== 0)
  expect(nonZeroOffsets).toEqual([{ byte: 0x20, offset: 17 }])
})

test("a fake tree replays a scripted active-process count then zero", () => {
  const tree = createFakeProcessTree({ counts: [3, 3, 0] })
  expect(tree.adopt(1234)).toBeNull()
  expect(tree.activeProcesses()).toBe(3)
  expect(tree.activeProcesses()).toBe(3)
  expect(tree.terminate()).toBeNull()
  expect(tree.activeProcesses()).toBe(0)
})

test("a fake tree can be scripted to never confirm exit", () => {
  const tree = createFakeProcessTree({ counts: [2], neverZero: true })
  tree.terminate()
  expect(tree.activeProcesses()).toBe(2)
})

test("a fake tree with an empty script reports 0 active processes", () => {
  const tree = createFakeProcessTree({ counts: [] })
  expect(tree.activeProcesses()).toBe(0)
  expect(tree.terminate()).toBeNull()
  expect(tree.activeProcesses()).toBe(0)
})

test("a fake tree's adopt always succeeds regardless of pid", () => {
  const tree = createFakeProcessTree({ counts: [1] })
  expect(tree.adopt(-1)).toBeNull()
  expect(tree.adopt(999999)).toBeNull()
})

test("a fake tree's close is a no-op that never throws", () => {
  const tree = createFakeProcessTree({ counts: [1] })
  expect(() => tree.close()).not.toThrow()
})
