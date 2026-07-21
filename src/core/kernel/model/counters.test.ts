import { describe, expect, test } from "bun:test"
import { context } from "@reatom/core"

import { isUuidv7 } from "core/protocol"

import { createKernelCounters } from "./counters"

describe("createKernelCounters", () => {
  test("starts both counters at zero and mints a UUIDv7 instance id", () => {
    context.start(() => {
      const counters = createKernelCounters()
      expect(counters.stateRevision()).toBe("0")
      expect(counters.eventSeq()).toBe("0")
      expect(isUuidv7(counters.kernelInstanceId)).toBe(true)
    })
  })

  test("two kernels in one process get distinct instance ids", () => {
    context.start(() => {
      // §4: the id exists so "logs and tests cannot accidentally compare counters from
      // different process lifetimes".
      expect(createKernelCounters().kernelInstanceId).not.toBe(
        createKernelCounters().kernelInstanceId,
      )
    })
  })

  test("advanceRevision increments the revision by exactly one and returns it", () => {
    context.start(() => {
      const counters = createKernelCounters()
      expect(counters.advanceRevision()).toBe("1")
      expect(counters.advanceRevision()).toBe("2")
      expect(counters.stateRevision()).toBe("2")
    })
  })

  test("advanceRevision does not touch the event sequence", () => {
    // §4 keeps them separate: "They are separate counters with different meanings."
    context.start(() => {
      const counters = createKernelCounters()
      counters.advanceRevision()
      counters.advanceRevision()
      expect(counters.eventSeq()).toBe("0")
    })
  })

  test("nextEventSeq increments the event sequence and leaves the revision alone", () => {
    context.start(() => {
      const counters = createKernelCounters()
      expect(counters.nextEventSeq()).toBe("1")
      expect(counters.nextEventSeq()).toBe("2")
      expect(counters.stateRevision()).toBe("0")
    })
  })

  test("several events can carry the same revision", () => {
    // §4: "Several events may therefore carry the same `stateRevision`."
    context.start(() => {
      const counters = createKernelCounters()
      counters.advanceRevision()
      const revisionAtFirst = counters.stateRevision()
      counters.nextEventSeq()
      counters.nextEventSeq()
      expect(counters.stateRevision()).toBe(revisionAtFirst)
    })
  })

  test("counters are canonical decimal strings, never bigint", () => {
    // §4: "`bigint` never crosses a DTO boundary."
    context.start(() => {
      const counters = createKernelCounters()
      counters.advanceRevision()
      counters.nextEventSeq()
      expect(typeof counters.stateRevision()).toBe("string")
      expect(typeof counters.eventSeq()).toBe("string")
      expect(counters.stateRevision()).toMatch(/^(?:0|[1-9][0-9]*)$/)
    })
  })

  test("each kernel's counters are independent", () => {
    context.start(() => {
      const first = createKernelCounters()
      const second = createKernelCounters()
      first.advanceRevision()
      expect(first.stateRevision()).toBe("1")
      expect(second.stateRevision()).toBe("0")
    })
  })

  test("atoms carry hierarchical trace names rooted at kernel", () => {
    context.start(() => {
      const counters = createKernelCounters()
      expect(counters.stateRevisionAtom.name).toBe("kernel.stateRevision")
      expect(counters.eventSeqAtom.name).toBe("kernel.eventSeq")
    })
  })
})
