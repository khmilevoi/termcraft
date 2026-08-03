import * as errore from "errore";

/**
 * A page reached a dynamic-code capability the design's §5.8 forbids. Thrown from the denied
 * entry point itself, so the stack names the page's own frame — and surfaces one of TWO ways,
 * depending on WHEN the page reaches it (both measured, task-10-report.md):
 *
 * - At RENDER time (inside the component function): caught by
 *   `host/render/model/error-capture.ts`'s boundary, reported as an ordinary render error —
 *   `host-state-machine.ts`'s `failRender` turns it into a restartable `PAGE_RENDER_FAILED`,
 *   the candidate's own fault, not a protocol violation.
 * - At MODULE-SCOPE (top-level code, before any component ever renders — the route task 10's
 *   own Step 6 test exercises): never reaches a React boundary at all. `source-mount.ts`'s
 *   `loadPage` catches the `import()` rejection and reports `MALFORMED_PROTOCOL`, which the
 *   supervisor (`supervisor/model/session.ts`) treats as a HOST protocol violation and opens
 *   the restart circuit for. Pre-existing behavior for any module-scope throw, not something
 *   this task introduced — named here so the difference is not mistaken for a regression.
 */
export class DynamicCodeDeniedError extends errore.createTaggedError({
  name: "DynamicCodeDeniedError",
  message: "dynamic code evaluation is denied in the design host ($entryPoint)",
}) {}

/**
 * Deny every dynamic-code entry point in THIS process: `eval`, all FOUR "function kind"
 * intrinsics ECMAScript defines — `Function`, `AsyncFunction`, `GeneratorFunction`, and
 * `AsyncGeneratorFunction` — and `Worker`.
 *
 * WHY HERE AND NOT AT THE GATE. `gate/model/import-scan.ts`'s token scan closes every spelling
 * that writes `eval` or `Function` as source text, and cannot close one that reaches the same
 * capability through an alias, a computed key, a parenthesis nest, or a
 * `[].constructor.constructor` chain — that is not a lexical question, and the last of those
 * writes neither identifier anywhere in the source. Five such spellings were measured accepted,
 * executed and silent (red-debt.md). Denial at the point of execution makes every ONE OF THOSE
 * FIVE SPELLINGS inert, regardless of how the spelling reaches `Function`/`eval` — because it
 * closes the shared object those spellings all resolve to, not each spelling individually.
 *
 * WHY FOUR CONSTRUCTORS, NOT ONE. `Function` is one of four distinct "function kind" intrinsics;
 * `AsyncFunction`, `GeneratorFunction`, and `AsyncGeneratorFunction` are SEPARATE objects,
 * each reachable only through an instance of that kind —
 * `(async () => {}).constructor`, `(function* () {}).constructor`,
 * `(async function* () {}).constructor` — never through a global identifier, so replacing
 * `Function.prototype.constructor` alone does not touch them. MEASURED, not assumed: with only
 * the `Function`/`eval` half installed, all three still EXECUTE a payload string (task-10-report.md
 * records the stacks and the marker proof) — e.g. `await (async () => {}).constructor("<payload>")()`
 * ran the payload and returned its value. Each is closed the SAME way `Function` is: replace the
 * `constructor` own-property on that kind's shared prototype object with a callable-but-throwing
 * function, and give the replacement the ORIGINAL prototype object as its own `.prototype`, so
 * `x instanceof <Kind>` still resolves correctly for any ordinary code that happens to check it.
 *
 * WHY `Worker` TOO (fix round 1). `new Worker("data:text/javascript," + encodeURIComponent(code))`
 * loads and runs a string of code in a FRESH realm that this function never touched — measured
 * through the real `loadPage`, with the rest of this denial already installed, the payload still
 * answered back with `typeof Function === "function"` inside the worker. No import, no
 * `require`, straight from a page's module scope — closer to `eval` than the `require` gap
 * below, and unlike that gap, `Worker` IS an ordinary `globalThis` property, so the same
 * callable-but-throwing replacement closes it. MEASURED, not assumed, that closing it does not
 * break anything real: a 12-scenario census (both real `examples/clock` pages plus full
 * post-mount traffic — resize, hit-test, describe, layout query; a multi-file closure; all six
 * `loadPage` failure branches; all four host modes with a full hello+mount+resize round trip)
 * with an OBSERVING `Worker` wrapper found ZERO constructions anywhere in this process's own
 * code (task-10-report.md, FIX ROUND 1). Denied unconditionally, no warm-up needed.
 *
 * WHY IT IS SAFE HERE, AND WHERE IT IS ACTUALLY CALLED. This runs only in the `_host --stdio`
 * child, whose whole job is mounting and rendering pages. `entry.ts` calls this as the FIRST
 * statement of the `loadPage` dependency it hands to `createHostSession` — i.e. right before
 * the real `loadPage` ever `import()`s a page's source, the first point untrusted page code
 * executes at all. Whether anything BEFORE that point needs the capability was MEASURED, not
 * assumed, and the first measurement (mounting+rendering both `examples/clock` pages, and the
 * whole `src/host/` suite, through an OBSERVING wrapper over `eval`/`Function.prototype.
 * constructor`) reported zero hits — WHICH WAS WRONG, in a specific, documented way (see
 * task-10-report.md): `Function.prototype.constructor` is not the only spelling `new Function`
 * can take. Zod v4's `$ZodObjectJIT` compiles each object schema's validator with a BARE
 * `const F = Function; new F(...)`, which reads the global binding directly and never touches
 * `.prototype.constructor` — invisible to that observer, but just as real a use of `Function`.
 * Real spawned-process tests caught what the observer missed: `clientHelloSchema` (the
 * handshake) and `controlEnvelopeSchema` (the outer shape of every inbound mount/resize/query
 * envelope, including the mount request itself) both compile a fast-path validator on THEIR
 * OWN first parse — naturally satisfied by real traffic before `loadPage` is ever called, since
 * hello and the mount envelope are both decoded before that point. `pageMetaSchema`
 * (`source-mount.ts`, the page's own meta) hits the identical path but is NOT naturally
 * warmed — `validateMeta` runs AFTER `import()`, not before — so `entry.ts` calls
 * `warmPageMetaValidator()` immediately before this function, every time, to force that
 * compile while `Function` still works. THE MAINTENANCE RULE THIS LEAVES BEHIND: any zod
 * object schema whose FIRST parse can happen AT THIS CALL SITE OR LATER needs the same
 * warm-up before this call — NOT a schema that only ever parses earlier, during boot or the
 * handshake, which compiles fine on its own and needs nothing added. Measured either way: a
 * `z.object` schema throws `DynamicCodeDeniedError` on its first parse if that parse happens
 * at or after this point, regardless of when the SCHEMA ITSELF was constructed — a future
 * `resizeBodySchema` in `handleResize`, `decodeLayoutNode` moved into this child, or a schema
 * reached only on an error branch would all need the same treatment `pageMetaSchema` got.
 *
 * WHAT IT IS NOT. Not a sandbox. It removes the eval/Function-family capability AND `Worker`
 * from this realm; a page can still reach anything the realm's own modules — and the realm's
 * own AMBIENT globals — expose. The perimeter's job is unchanged — this closes the class of
 * §5.8 violation the token scan provably cannot see, WITHIN the eval/Function/Worker domain
 * specifically.
 *
 * A MEASURED, NOT CLOSED, RESIDUAL GAP. `require` is available in a page's module scope with NO
 * import statement (Bun injects it per module, the way Node's CJS wrapper does), and it is NOT a
 * `globalThis` property (`Object.getOwnPropertyDescriptor(globalThis, "require")` is
 * `undefined`) — so unlike `eval`/`Function`/`Worker`, there is no realm-level object this
 * function can replace to close it. An ALIASED call — `const r = require;
 * r("node:vm").runInNewContext(...)` — was measured to EXECUTE, and is invisible to
 * `Bun.Transpiler.scanImports` (both the gate's and this module's `scanClosureImports`), which
 * pattern-matches only the literal `require(...)` call form. That is a DIFFERENT, WIDER
 * capability than this function closes — arbitrary Node built-in access (`node:fs`,
 * `node:child_process`, `node:vm`, ...), not only code evaluation — and it needs its own owner;
 * see red-debt.md. Because of this gap, "denial closes every spelling, including ones nobody
 * has enumerated" is true for the eval/Function/Worker capability this function actually
 * touches, and NOT true of dynamic-code capability in general.
 */
export function denyDynamicCodeCapability(): void {
  const deny = (entryPoint: string) =>
    function denied(): never {
      throw new DynamicCodeDeniedError({ entryPoint });
    };

  // `Function.prototype.constructor` IS the `Function` global, so replacing it closes the
  // global binding, `new F(...)` through any alias, and the `[].constructor.constructor` chain
  // at once — they are three names for one object. Kept CALLABLE-but-throwing rather than
  // deleted: `x.constructor` is read by ordinary code (including React's own internals) and
  // must stay a function value.
  const deniedFunction = deny("Function");
  Object.defineProperty(deniedFunction, "prototype", { value: Function.prototype });
  Object.defineProperty(Function.prototype, "constructor", {
    configurable: true,
    writable: true,
    value: deniedFunction,
  });
  Object.defineProperty(globalThis, "Function", {
    configurable: true,
    writable: true,
    value: deniedFunction,
  });

  // Indirect `eval` through ANY receiver spelling — `globalThis[k]`, `globalThis["ev"+"al"]`,
  // a destructured `{ eval: v }` — resolves through this one property.
  Object.defineProperty(globalThis, "eval", {
    configurable: true,
    writable: true,
    value: deny("eval"),
  });

  // The three intrinsics `Function.prototype.constructor` does NOT reach (see the doc block
  // above). `instance` is discarded; it only exists to read `Object.getPrototypeOf(...)`, the
  // realm-shared prototype object every value of that kind resolves `.constructor` through.
  const denyFunctionKind = (instance: object, entryPoint: string): void => {
    const sharedPrototype = Object.getPrototypeOf(instance) as { constructor: unknown };
    const deniedCtor = deny(entryPoint);
    Object.defineProperty(deniedCtor, "prototype", { value: sharedPrototype });
    Object.defineProperty(sharedPrototype, "constructor", {
      configurable: true,
      writable: true,
      value: deniedCtor,
    });
  };
  denyFunctionKind(async () => {}, "AsyncFunction");
  denyFunctionKind(function* () {}, "GeneratorFunction");
  denyFunctionKind(async function* () {}, "AsyncGeneratorFunction");

  // `Worker` spins up a FRESH realm this function never touches — a `data:` URL constructor
  // argument turns a string into running code with none of the above involved (see the doc
  // block above for the census that measured this safe to deny unconditionally). Same
  // discipline as `Function`: callable-but-throwing, `.prototype` preserved so
  // `x instanceof Worker` still resolves for any ordinary code that happens to check it.
  const deniedWorker = deny("Worker");
  Object.defineProperty(deniedWorker, "prototype", { value: Worker.prototype });
  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    writable: true,
    value: deniedWorker,
  });
}
