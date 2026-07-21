/**
 * `ui/testing` — `ui`-owned test doubles and event builders. Typed purely against the
 * `ui`-declared `KernelPort`; `ui` may not import `core/ports/fakes`.
 */
export {
  TEST_KERNEL_INSTANCE_ID,
  TEST_NONCE,
  TEST_SHA,
  TEST_TS,
  event,
  resetEventSeq,
  snapshot,
  snapshotPayload,
} from "./model/events";
export type { EventOptions } from "./model/events";
export { createFakeKernel } from "./model/fake-kernel";
export type { FakeKernel, FakeKernelOptions } from "./model/fake-kernel";
export { createFakePreviewSession } from "./model/fake-preview";
export type { FakePreviewOptions, FakePreviewSession } from "./model/fake-preview";
