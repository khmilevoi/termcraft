import { describe, expect, spyOn, test } from "bun:test";
import path from "node:path";

import type { CommandResultV1, PageDescriptorV1 } from "core/protocol";
import type { EventOf } from "ui/kernel";
import { createFakeKernel, event } from "ui/testing";

import type { AppShell } from "../types";
import {
  ExportDriverError,
  ExportRefusedError,
  RUNNING_TURN_REFUSAL_MESSAGE,
  TRUST_REFUSAL_MESSAGE,
  ZERO_PAGES_REFUSAL_MESSAGE,
  runExport,
  runHeadlessExportOverShell,
} from "./run-export";

const ROOT = "C:/projects/site";
const TIMEOUT_MS = 1_000;

function readyDescriptor(pageSlug: string): PageDescriptorV1 {
  return {
    status: "ready",
    pageSlug,
    sourceHash: "0".repeat(64),
    title: "Home",
    minSize: { w: 80, h: 24 },
    theme: "dark-default",
    kitApiVersion: 1,
  };
}

function pageDescriptorsEnvelope(
  descriptors: readonly PageDescriptorV1[],
): EventOf<"page.descriptorsChanged"> {
  return event("page.descriptorsChanged", {
    reason: "project-open",
    descriptors,
    changes: [],
    activePageSlug: descriptors[0]?.pageSlug ?? null,
  });
}

function projectOpenSettledEnvelope(
  action: "kernel.project.finishOpen" | "kernel.project.blockOpen",
): EventOf<"kernel.stateChanged"> {
  return event("kernel.stateChanged", {
    modelId: "kernel.project.state",
    action,
    previousTag: "opening",
    nextTag: action === "kernel.project.finishOpen" ? "ready" : "blocked",
    metadata:
      action === "kernel.project.finishOpen"
        ? { projectId: "0192f000-0000-7000-8000-000000000001", trust: "trusted" }
        : {},
  });
}

function exportCompletedEnvelope(generationId: string): EventOf<"export.completed"> {
  return event("export.completed", {
    operationId: "0192f000-0000-7000-8000-000000000002",
    phase: "publishing",
    destination: ".termcraft/export",
    generationId,
    failure: null,
  });
}

const REJECTED_COMMAND_ID = "0192f000-0000-7000-8000-000000000099";

const REJECTED_UNTRUSTED: CommandResultV1 = {
  protocolVersion: 1,
  commandId: REJECTED_COMMAND_ID,
  status: "rejected",
  currentRevision: "0",
  code: "PROJECT_UNTRUSTED",
  reasons: [{ code: "PROJECT_UNTRUSTED" }],
};

const REJECTED_TURN_RUNNING: CommandResultV1 = {
  protocolVersion: 1,
  commandId: REJECTED_COMMAND_ID,
  status: "rejected",
  currentRevision: "0",
  code: "TURN_RUNNING",
  reasons: [{ code: "TURN_RUNNING", turnId: "0192f000-0000-7000-8000-000000000010" }],
};

describe("runExport", () => {
  test("dispatches project.open then export.start and resolves the resolved package directory on the terminal export.completed event", async () => {
    const fake = createFakeKernel();
    const runPromise = runExport({ port: fake, root: ROOT, timeoutMs: TIMEOUT_MS });

    fake.emit(pageDescriptorsEnvelope([readyDescriptor("home")]));
    fake.emit(projectOpenSettledEnvelope("kernel.project.finishOpen"));
    fake.emit(exportCompletedEnvelope("0192f000-0000-7000-8000-00000000abcd"));

    const result = await runPromise;
    expect(result).not.toBeInstanceOf(Error);
    if (result instanceof Error) throw result;
    expect(result.destination).toBe(
      path.join(
        ROOT,
        ".termcraft",
        "export",
        "generations",
        "0192f000-0000-7000-8000-00000000abcd",
      ),
    );

    const dispatchedKinds = fake.dispatched.map((raw) => (raw as { kind: string }).kind);
    expect(dispatchedKinds).toEqual(["project.open", "export.start"]);
  });

  test("resolves an ExportRefusedError carrying the §3.1 trust message when export.start is rejected PROJECT_UNTRUSTED", async () => {
    const fake = createFakeKernel();
    const runPromise = runExport({ port: fake, root: ROOT, timeoutMs: TIMEOUT_MS });

    fake.setDispatchResult(REJECTED_UNTRUSTED);
    fake.emit(pageDescriptorsEnvelope([readyDescriptor("home")]));
    fake.emit(projectOpenSettledEnvelope("kernel.project.finishOpen"));

    const result = await runPromise;
    expect(result).toBeInstanceOf(ExportRefusedError);
    if (!(result instanceof Error)) throw new Error("expected a refusal");
    expect(result.message).toContain("designs in this project are code and will run");
    expect(result.message).toBe(TRUST_REFUSAL_MESSAGE);

    const dispatchedKinds = fake.dispatched.map((raw) => (raw as { kind: string }).kind);
    expect(dispatchedKinds).toEqual(["project.open", "export.start"]);
  });

  test("resolves an ExportRefusedError carrying the running-turn message when export.start is rejected TURN_RUNNING", async () => {
    const fake = createFakeKernel();
    const runPromise = runExport({ port: fake, root: ROOT, timeoutMs: TIMEOUT_MS });

    fake.setDispatchResult(REJECTED_TURN_RUNNING);
    fake.emit(pageDescriptorsEnvelope([readyDescriptor("home")]));
    fake.emit(projectOpenSettledEnvelope("kernel.project.finishOpen"));

    const result = await runPromise;
    expect(result).toBeInstanceOf(ExportRefusedError);
    if (!(result instanceof Error)) throw new Error("expected a refusal");
    expect(result.message).toBe(RUNNING_TURN_REFUSAL_MESSAGE);
  });

  test("refuses with the zero-pages message once export.start is accepted but no terminal event will ever arrive", async () => {
    const fake = createFakeKernel();
    const runPromise = runExport({ port: fake, root: ROOT, timeoutMs: TIMEOUT_MS });

    fake.emit(pageDescriptorsEnvelope([]));
    fake.emit(projectOpenSettledEnvelope("kernel.project.finishOpen"));

    const result = await runPromise;
    expect(result).toBeInstanceOf(ExportRefusedError);
    if (!(result instanceof Error)) throw new Error("expected a refusal");
    expect(result.message).toBe(ZERO_PAGES_REFUSAL_MESSAGE);

    // `export.start` IS dispatched (the guard accepts it — it never checks page count); this
    // driver notices the empty page list itself instead of waiting for a terminal event that
    // the real Kernel's `NO_PAGES` handler path would never emit.
    const dispatchedKinds = fake.dispatched.map((raw) => (raw as { kind: string }).kind);
    expect(dispatchedKinds).toEqual(["project.open", "export.start"]);
  });

  test("an untrusted, zero-page project reports the trust refusal, never the zero-pages one (guard priority)", async () => {
    const fake = createFakeKernel();
    const runPromise = runExport({ port: fake, root: ROOT, timeoutMs: TIMEOUT_MS });

    fake.setDispatchResult(REJECTED_UNTRUSTED);
    fake.emit(pageDescriptorsEnvelope([]));
    fake.emit(projectOpenSettledEnvelope("kernel.project.finishOpen"));

    const result = await runPromise;
    expect(result).toBeInstanceOf(ExportRefusedError);
    if (!(result instanceof Error)) throw new Error("expected a refusal");
    expect(result.message).toBe(TRUST_REFUSAL_MESSAGE);
  });

  test("resolves an ExportDriverError when project.open itself blocks", async () => {
    const fake = createFakeKernel();
    const runPromise = runExport({ port: fake, root: ROOT, timeoutMs: TIMEOUT_MS });

    fake.emit(projectOpenSettledEnvelope("kernel.project.blockOpen"));

    const result = await runPromise;
    expect(result).toBeInstanceOf(ExportDriverError);

    const dispatchedKinds = fake.dispatched.map((raw) => (raw as { kind: string }).kind);
    expect(dispatchedKinds).toEqual(["project.open"]);
  });

  test("resolves an ExportDriverError when the project-open wait times out", async () => {
    const fake = createFakeKernel();
    const result = await runExport({ port: fake, root: ROOT, timeoutMs: 50 });
    expect(result).toBeInstanceOf(ExportDriverError);
  });
});

function fakeShell(
  port: ReturnType<typeof createFakeKernel>,
  close: () => Promise<void>,
): AppShell {
  return {
    mode: "interactive",
    port,
    env: { root: ROOT, workspaceIdentity: ROOT, projectExists: false },
    close,
  };
}

describe("runHeadlessExportOverShell", () => {
  test("a shell that fails to close after a successful export still resolves the destination, not a rejection", async () => {
    const fake = createFakeKernel();
    const teardownFailure = new Error("shell teardown failed");
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    const runPromise = runHeadlessExportOverShell({
      shell: fakeShell(fake, () => Promise.reject(teardownFailure)),
      root: ROOT,
      timeoutMs: TIMEOUT_MS,
    });

    fake.emit(pageDescriptorsEnvelope([readyDescriptor("home")]));
    fake.emit(projectOpenSettledEnvelope("kernel.project.finishOpen"));
    fake.emit(exportCompletedEnvelope("0192f000-0000-7000-8000-00000000abcd"));

    const result = await runPromise;
    expect(result).not.toBeInstanceOf(Error);
    if (result instanceof Error) throw result;
    expect(result.destination).toBe(
      path.join(
        ROOT,
        ".termcraft",
        "export",
        "generations",
        "0192f000-0000-7000-8000-00000000abcd",
      ),
    );
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  test("a shell that fails to close after a refused export still resolves the refusal, not a rejection", async () => {
    const fake = createFakeKernel();
    const teardownFailure = new Error("shell teardown failed");
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    const runPromise = runHeadlessExportOverShell({
      shell: fakeShell(fake, () => Promise.reject(teardownFailure)),
      root: ROOT,
      timeoutMs: TIMEOUT_MS,
    });

    fake.setDispatchResult(REJECTED_UNTRUSTED);
    fake.emit(pageDescriptorsEnvelope([readyDescriptor("home")]));
    fake.emit(projectOpenSettledEnvelope("kernel.project.finishOpen"));

    const result = await runPromise;
    expect(result).toBeInstanceOf(ExportRefusedError);
    if (!(result instanceof Error)) throw new Error("expected a refusal");
    expect(result.message).toBe(TRUST_REFUSAL_MESSAGE);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  test("a shell that closes cleanly logs nothing", async () => {
    const fake = createFakeKernel();
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    const runPromise = runHeadlessExportOverShell({
      shell: fakeShell(fake, () => Promise.resolve()),
      root: ROOT,
      timeoutMs: TIMEOUT_MS,
    });

    fake.emit(pageDescriptorsEnvelope([readyDescriptor("home")]));
    fake.emit(projectOpenSettledEnvelope("kernel.project.finishOpen"));
    fake.emit(exportCompletedEnvelope("0192f000-0000-7000-8000-00000000abcd"));

    const result = await runPromise;
    expect(result).not.toBeInstanceOf(Error);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
