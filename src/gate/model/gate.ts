import type { PageSlug } from "entities/page";

import type { GateError, GateResult, GateWarning, PageDescriptor } from "../types";
import { makeGateResult } from "./gate-result";
import { scanImportAllowlist } from "./import-scan";
import { lintDeterminism, lintDroppedIds, lintUnpointedElements } from "./lints";
import { checkPageContract } from "./page-contract";

/**
 * The gate's injected validation stages that need more than the page source
 * (code-structure ports). Each is optional so the pipeline runs the source-only
 * checks standalone and gains the heavier stages as they are wired: `typeCheck`
 * (phase-3 T4, the tsc/unstable-sync diagnostics), `checkManifest` (T5, gated on
 * the phase-4 pages.json schema), and `smokeRender` (T6, the host's one-shot
 * SmokeRenderer). Each may be sync or async and returns fatal `GateError`s.
 */
export interface GatePorts {
  readonly typeCheck?: (source: string, fileName: string) => GateError[] | Promise<GateError[]>;
  readonly checkManifest?: (
    descriptor: PageDescriptor,
    source: string,
  ) => GateError[] | Promise<GateError[]>;
  readonly smokeRender?: (
    descriptor: PageDescriptor,
    source: string,
  ) => GateError[] | Promise<GateError[]>;
}

/**
 * One candidate page to validate: its source, its slug, and its scratch file name.
 * `referencedIds` and `listedSlugs` feed the `dropped-id` and `unlisted-navigation`
 * warning lints (§6.3 step 3); both are optional and, absent, skip their lint so
 * the gate stays runnable standalone (e.g. in a fixture with no kernel/manifest).
 */
export interface GateInput {
  readonly source: string;
  readonly slug: PageSlug;
  readonly fileName?: string;
  /** Ids the caller's current selection or open pins reference (`dropped-id`). */
  readonly referencedIds?: readonly string[];
}

/**
 * Run the validation gate over one immutable candidate page (master §6.3). The
 * source-only stages always run — the static-import allowlist (§3.1) and the page
 * contract (§4) are fatal; the determinism lints (§6.3) are warnings. The injected
 * `typeCheck` runs next. The manifest + smoke stages run ONLY when nothing fatal
 * has surfaced yet, because a candidate with a forbidden import, a broken contract,
 * or a type error must never be imported/rendered. A candidate passes only when
 * there are zero fatal errors; warnings never reject.
 */
export async function runGate(input: GateInput, ports: GatePorts = {}): Promise<GateResult> {
  const errors: GateError[] = [];
  const warnings: GateWarning[] = [];
  const fileName = input.fileName ?? `${input.slug}.tsx`;

  for (const e of scanImportAllowlist(input.source)) {
    errors.push({
      kind: "import",
      code: e.code,
      message: e.message,
      file: fileName,
      line: e.line,
      column: e.column,
    });
  }
  const contract = checkPageContract(input.source);
  for (const e of contract.errors) {
    errors.push({
      kind: "contract",
      code: e.code,
      message: e.message,
      file: fileName,
      line: e.line,
      column: e.column,
    });
  }
  warnings.push(...lintDeterminism(input.source));
  warnings.push(...lintDroppedIds(input.source, input.referencedIds));
  warnings.push(...lintUnpointedElements(input.source));

  if (ports.typeCheck !== undefined) {
    errors.push(...(await ports.typeCheck(input.source, fileName)));
  }

  const descriptor: PageDescriptor | null =
    contract.meta === null ? null : { slug: input.slug, meta: contract.meta };

  // Only mount/render/consult the manifest when the candidate is otherwise safe:
  // a forbidden import, a broken contract, or a type error means the source cannot
  // be imported or rendered, so skip the heavier stages.
  if (errors.length === 0 && descriptor !== null) {
    if (ports.checkManifest !== undefined)
      errors.push(...(await ports.checkManifest(descriptor, input.source)));
    if (ports.smokeRender !== undefined)
      errors.push(...(await ports.smokeRender(descriptor, input.source)));
  }

  return makeGateResult(errors, warnings, descriptor);
}
