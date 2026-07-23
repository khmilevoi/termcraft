import type { SmokeRenderer, SmokeRequest } from "../ports/smoke-renderer";
import { smokeResultToErrors } from "../ports/smoke-renderer";
import type { GateError, PageDescriptor } from "../types";

/**
 * The lowercase-hex SHA-256 the host's `computeSourceHash` computes over the same
 * staged file's bytes (`src/host/session/model/source-mount.ts:42-44`). Computed
 * locally — never by importing `host` (module DAG: the dependency points from host
 * to the gate's `SmokeRenderer` port, never the reverse) — over the exact UTF-8
 * bytes `TextEncoder` produces for `source`, which is what a UTF-8-written staged
 * file's bytes are. Parity with the host's hash is pinned by a dedicated test that
 * uses the host helper only as a test-only oracle (never called from here).
 */
function hashSource(source: string): string {
  return new Bun.CryptoHasher("sha256").update(new TextEncoder().encode(source)).digest("hex");
}

/**
 * Build the gate's `smokeRender` port (phase-3 T6, host-supervision §11.3) from an
 * injected `SmokeRenderer`. Mirrors `createTypeChecker`'s factory shape
 * (`type-check.ts:242-253`): close over the renderer + the candidate's staged
 * source path, and return the plain port function `runGate` calls. Per call:
 * compute the source hash, assemble the `SmokeRequest` from the parsed
 * descriptor's `meta` (`size` is the candidate's declared minimum — §11.3 smoke-
 * renders at the minimum, never a larger size), render once, and map the typed
 * result through `smokeResultToErrors`.
 */
export function createSmokeRender(
  renderer: SmokeRenderer,
  sourcePath: string,
): (descriptor: PageDescriptor, source: string) => Promise<GateError[]> {
  return async (descriptor, source) => {
    const request: SmokeRequest = {
      sourcePath,
      sourceHash: hashSource(source),
      size: descriptor.meta.minSize,
      kitApiVersion: descriptor.meta.kitApiVersion,
    };
    const result = await renderer.render(request);
    return smokeResultToErrors(result);
  };
}
