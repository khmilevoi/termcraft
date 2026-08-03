import { afterEach, describe, expect, test } from "bun:test";

import { DynamicCodeDeniedError, denyDynamicCodeCapability } from "./capability-denial";

/**
 * This file mutates the realm's shared intrinsics on purpose — that IS the thing under test.
 * MEASURED, not assumed (task-10-report.md): `bun test` does NOT run one file per process —
 * two files invoked together report the SAME `process.pid` — so a mutation left in place after
 * this file's tests finish would leak forward into every OTHER file `bun test src/host/` or
 * `bun run test` happens to run afterward in the same invocation. `afterEach` below restores
 * every intrinsic this file touches to what it captured before any test ran, so nothing here
 * survives past this file's own tests regardless of run order.
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

describe("denyDynamicCodeCapability", () => {
  test("closes every spelling the token scan measured LIVE, plus the three function-kind intrinsics it cannot reach", () => {
    denyDynamicCodeCapability();

    const spellings: readonly (() => unknown)[] = [
      // red-debt.md's five measured-LIVE spellings, all funneling through Function/eval.
      () => {
        const F = Function;
        return new F("return 1")();
      },
      () => {
        const key = "eval";
        return (globalThis as never as Record<string, (s: string) => unknown>)[key]!("1");
      },
      () => (globalThis as never as Record<string, (s: string) => unknown>)["ev" + "al"]!("1"),
      () =>
        (
          [] as never as { constructor: { constructor: (s: string) => () => unknown } }
        ).constructor.constructor("return 1")(),
      () => (Function as never as (s: string) => () => unknown)("return 1")(),
      // The three SEPARATE "function kind" intrinsics `Function.prototype.constructor` cannot
      // reach — measured LIVE against the brief's Step-4 code alone (task-10-report.md): each
      // executes a payload the instant its constructor is called, before the caller ever awaits
      // or iterates the result.
      () => ((async () => {}).constructor as never as (s: string) => () => unknown)("return 1"),
      () => (function* () {}.constructor as never as (s: string) => () => unknown)("return 1"),
      () =>
        (async function* () {}.constructor as never as (s: string) => () => unknown)("return 1"),
    ];

    for (const [index, spelling] of spellings.entries()) {
      const thrown = (() => {
        try {
          spelling();
          return null;
        } catch (error) {
          return error;
        }
      })();
      expect([index, thrown instanceof DynamicCodeDeniedError]).toEqual([index, true]);
    }
  });

  test("is idempotent — a second call does not double-wrap or restore", () => {
    denyDynamicCodeCapability();
    denyDynamicCodeCapability();
    expect(() => new Function("return 1")).toThrow(DynamicCodeDeniedError);
    expect(() => (async () => {}).constructor("return 1")).toThrow(DynamicCodeDeniedError);
  });

  test("ordinary function values still work", () => {
    denyDynamicCodeCapability();
    const double = (n: number) => n * 2;
    expect(double(2)).toBe(4);
    expect(typeof double.call).toBe("function");
    expect([1, 2].map(double)).toEqual([2, 4]);
    // `x.constructor` as a plain READ must keep working — only CALLING it is denied — for
    // every function kind, not only the ordinary one.
    expect(typeof ([] as unknown[]).constructor).toBe("function");
    expect(typeof (async () => {}).constructor).toBe("function");
    expect(typeof function* () {}.constructor).toBe("function");
    expect(typeof async function* () {}.constructor).toBe("function");
    // `instanceof` against the now-replaced constructors must still resolve for ordinary
    // values — the replacement keeps the ORIGINAL prototype object as its own `.prototype`.
    expect(double instanceof Function).toBe(true);
  });
});
