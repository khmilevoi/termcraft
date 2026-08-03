import { afterEach, describe, expect, test } from "bun:test";

import { FrameDecoder, type WireFrame } from "infrastructure/framing";

import {
  type ClientHelloV1,
  PROTOCOL_HARD_LIMITS,
  type RuntimeDeclarationBundleV1,
  decodeHostHello,
  encodeClientHello,
} from "../../protocol";
import { parseHostArgs, runHostStdio } from "./entry";

/**
 * `runHostStdio` now calls `denyDynamicCodeCapability()` on every boot (task 10) — real and
 * correct for the production `_host --stdio` child, which is a dedicated one-shot process. But
 * `describe("runHostStdio ...")` below calls it IN-PROCESS, and `bun test` does NOT run one
 * file per process (measured, task-10-report.md: two files invoked together share one
 * `process.pid`) — so without restoring here, the first test below would leave Function/eval
 * denied for every OTHER file this invocation happens to run afterward. Restored exactly the
 * way `capability-denial.test.ts` does, for the same reason.
 */
const originalFunctionConstructor = Function.prototype.constructor;
const originalGlobalFunction = (globalThis as Record<string, unknown>).Function;
const originalGlobalEval = globalThis.eval;
const asyncFunctionPrototype = Object.getPrototypeOf(async () => {}) as { constructor: unknown };
const originalAsyncFunctionConstructor = asyncFunctionPrototype.constructor;
const generatorFunctionPrototype = Object.getPrototypeOf(function* () {}) as {
  constructor: unknown;
};
const originalGeneratorFunctionConstructor = generatorFunctionPrototype.constructor;
const asyncGeneratorFunctionPrototype = Object.getPrototypeOf(async function* () {}) as {
  constructor: unknown;
};
const originalAsyncGeneratorFunctionConstructor = asyncGeneratorFunctionPrototype.constructor;

function restoreRealm(): void {
  Object.defineProperty(Function.prototype, "constructor", {
    configurable: true,
    writable: true,
    value: originalFunctionConstructor,
  });
  Object.defineProperty(globalThis, "Function", {
    configurable: true,
    writable: true,
    value: originalGlobalFunction,
  });
  Object.defineProperty(globalThis, "eval", {
    configurable: true,
    writable: true,
    value: originalGlobalEval,
  });
  Object.defineProperty(asyncFunctionPrototype, "constructor", {
    configurable: true,
    writable: true,
    value: originalAsyncFunctionConstructor,
  });
  Object.defineProperty(generatorFunctionPrototype, "constructor", {
    configurable: true,
    writable: true,
    value: originalGeneratorFunctionConstructor,
  });
  Object.defineProperty(asyncGeneratorFunctionPrototype, "constructor", {
    configurable: true,
    writable: true,
    value: originalAsyncGeneratorFunctionConstructor,
  });
}

afterEach(restoreRealm);

describe("parseHostArgs", () => {
  test("accepts a compiled-binary _host --stdio argv", () => {
    expect(parseHostArgs(["C:/termcraft.exe", "_host", "--stdio"])).toBe(true);
  });
  test("accepts a bun run _host --stdio argv", () => {
    expect(parseHostArgs(["bun", "/src/main.ts", "_host", "--stdio"])).toBe(true);
  });
  test("rejects a normal launch", () => {
    expect(parseHostArgs(["C:/termcraft.exe"])).toBe(false);
  });
  test("rejects _host without --stdio", () => {
    expect(parseHostArgs(["C:/termcraft.exe", "_host"])).toBe(false);
  });
});

const RUNTIME_DECLARATION: RuntimeDeclarationBundleV1 = {
  module: "@termcraft/runtime",
  currentKitApiVersion: 1,
  supportedKitApiVersions: [1],
  publicCapabilityIds: ["theme:dark-default"],
};
const SESSION_ID = "01920000-0000-7000-8000-000000000000";
const NONCE = "0123456789abcdef0123456789abcdef";

const clientHelloFrame = (): Uint8Array => {
  const hello: ClientHelloV1 = {
    framingVersion: 1,
    kind: "client.hello",
    sessionId: SESSION_ID,
    nonce: NONCE,
    offeredFramingVersions: [1],
    offeredProtocolVersions: [1],
    mode: "preview",
    pageSlug: "dashboard",
    sourceHash: "a".repeat(64),
    sourceKitApiVersion: 1,
    runtimeDeclaration: RUNTIME_DECLARATION,
    limits: PROTOCOL_HARD_LIMITS,
  };
  const framed = encodeClientHello(hello);
  if (framed instanceof Error) throw framed;
  return framed;
};

describe("runHostStdio (in-memory transport)", () => {
  test("negotiates a host.hello from a client.hello fed as framed bytes", async () => {
    const output: Uint8Array[] = [];
    const exits: number[] = [];
    const { resolve: resolveExit } = Promise.withResolvers<void>();

    async function* input() {
      yield clientHelloFrame();
      // Give the host a moment to answer, then close the input to end the run.
      await new Promise((r) => setTimeout(r, 50));
    }

    await runHostStdio({
      argv: ["exe", "_host", "--stdio"],
      input: input(),
      output: (bytes) => output.push(bytes),
      now: () => 1000,
      exit: (code) => {
        exits.push(code);
        resolveExit();
      },
      deps: {
        runtimeDeclaration: RUNTIME_DECLARATION,
        limits: PROTOCOL_HARD_LIMITS,
        createRenderer: async () => {
          throw new Error("no mount in this test");
        },
      },
    });

    // `runHostStdio` denies dynamic code the instant its own `host-hello` goes out (task 10)
    // — correct for production, where decoding that SAME `host-hello` happens in a totally
    // separate supervisor process that never installed the denial. This in-memory-transport
    // test plays BOTH roles in one process, so restore BEFORE decoding below: otherwise
    // `decodeHostHello`'s zod schema would be attempting ITS OWN first-ever JIT compile
    // (task-10-report.md) against an already-denied `Function`, an artifact of the test
    // harness sharing a realm across both sides of the wire, not a real production path.
    restoreRealm();

    // Decode the host's framed output.
    const decoder = new FrameDecoder();
    const frames: WireFrame[] = [];
    for (const chunk of output) {
      const fed = decoder.feed(chunk);
      if (fed instanceof Error) throw fed;
      frames.push(...fed);
    }
    expect(frames.length).toBeGreaterThanOrEqual(1);
    const hostHello = decodeHostHello(frames[0]!.payload);
    if (hostHello instanceof Error) throw hostHello;
    expect(hostHello.kind).toBe("host.hello");
    expect(hostHello.sessionId).toBe(SESSION_ID);
  });

  test("still performs the explicit-exit guarantee (Spike D) when the input iterable simply ends", async () => {
    const exits: number[] = [];

    async function* input() {
      yield clientHelloFrame();
      // No more chunks — the iterable just ends, simulating the parent's pipe closing with
      // no `shutdown` control message and no fatal ExitRequest ever raised. Important 3
      // (WP-3 fix pass): without an explicit guarantee on THIS path, `io.exit` is never
      // called and the live headless renderer is never destroyed — the child is orphaned.
    }

    await runHostStdio({
      argv: ["exe", "_host", "--stdio"],
      input: input(),
      output: () => {},
      now: () => 1000,
      exit: (code) => {
        exits.push(code);
      },
      deps: {
        runtimeDeclaration: RUNTIME_DECLARATION,
        limits: PROTOCOL_HARD_LIMITS,
        createRenderer: async () => {
          throw new Error("no mount in this test");
        },
      },
    });

    expect(exits).toEqual([0]);
  }, 5_000);
});
