import type { DesignSystemManifestV1 } from "entities/design-system";
import { decodeDesignSystemManifest } from "entities/design-system";

import type { AbsPath, DesignSystemSummary, TokenSwatch } from "../types";
import { DesignSystemPackageInvalidError } from "./errors";

/**
 * A read of `design-system.json` through `entities/design-system`'s decoder — the same manifest
 * authority the Gate itself uses — projected onto exactly the seven facts a picker's swatch row
 * needs (design §8.1).
 *
 * RECONCILIATION SEAM RESOLVED (project-design-systems §10.1, sync point 1). This file used to
 * carry its own private, deliberately-narrow Zod schema: P3 shipped in parallel with P2
 * (`manifest-and-gate`, which owns `entities/design-system`'s real manifest schema and decoder)
 * and could not import what had not landed yet. Now that P2 is merged, `readDesignSystemSummary`
 * calls `decodeDesignSystemManifest` directly; `toDesignSystemSummary` is the pure, no-I/O
 * projection from an ALREADY-DECODED manifest onto the seven picker facts — exactly the function
 * the seam predicted keeping. One parser, one authority, as intended.
 *
 * BEHAVIOURAL CONSEQUENCE OF SHARING THE DECODER — read before touching this file's tests: the
 * entity decoder enforces materially more than the old private schema did. Every theme must
 * declare every core token role (§4.1), token names must match across every theme (§4.2), every
 * token value must be a lowercase `#rrggbb` colour (§4.1, which also subsumes the old private
 * schema's separate array-index-token-name guard — `tokenNameSchema` requires an identifier-shaped
 * name, so a purely-numeric key like `"0"` never parses), `id`/theme ids/`defaultTheme` must be
 * kebab slugs (decision D4), and every component needs a resolvable `module`/`export` pair, not
 * just a `name`. A candidate manifest that fails any of those now fails to LIST at all, where it
 * used to summarize successfully and defer the judgment to the Gate.
 *
 * THIS IS ACCEPTED, NOT WORKED AROUND. §8.1's picker lists candidates that have never been
 * through the Gate; a candidate that fails basic schema shape now simply has nothing to show,
 * rather than showing a row the Gate would immediately reject anyway. The alternative — a second,
 * looser parser here — is exactly the drifting-authority risk P2 exists to remove. The one
 * exception is `kitApiVersion` SUPPORT: `decodeDesignSystemManifest` only checks it is a positive
 * integer, not that it names a version this binary targets — that bound lives in
 * `gate/model/design-system.ts`'s `SUPPORTED_KIT_API_VERSIONS`, a Gate-only check — so an
 * unsupported-but-well-formed `kitApiVersion` still summarizes here, same as before.
 *
 * It still parses and never executes or compiles anything — `decodeDesignSystemManifest` is pure
 * Zod — the property §3.2 makes the manifest data-shaped for, and what §11's "`list` never opens a
 * `.tsx`" rests on.
 */

/**
 * The pure projection from an already-decoded manifest onto what a picker's swatch row needs
 * (design §8.1). No I/O, no parsing, no validation of its own — `entities/design-system`'s
 * decoder is the one authority for whether `manifest` is well-formed; this function only reshapes
 * what it already verified.
 */
export function toDesignSystemSummary(manifest: DesignSystemManifestV1): DesignSystemSummary {
  // Non-null: `decodeDesignSystemManifest`'s own DEFAULT_THEME_UNDECLARED check guarantees
  // `defaultTheme` names a theme this manifest actually declares.
  const theme = manifest.themes[manifest.defaultTheme]!;
  const defaultThemeTokens: readonly TokenSwatch[] = Object.entries(theme.tokens).map(
    ([name, value]) => ({ name, value }),
  );

  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    kitApiVersion: manifest.kitApiVersion,
    defaultTheme: manifest.defaultTheme,
    defaultThemeTokens,
    componentNames: manifest.components.map((component) => component.name),
  };
}

export function readDesignSystemSummary(bytes: Uint8Array, manifestPath: AbsPath) {
  // `TextDecoder.decode` without `{ fatal: true }` never throws — invalid byte sequences become
  // U+FFFD — so no `errore` boundary is needed here; `decodeDesignSystemManifest` owns the one
  // real failure mode (invalid JSON) below.
  const text = new TextDecoder().decode(bytes);

  const manifest = decodeDesignSystemManifest(text);
  if (manifest instanceof Error) {
    return new DesignSystemPackageInvalidError({
      path: manifestPath,
      reason: `manifest is invalid [${manifest.code}]: ${manifest.reason}`,
      cause: manifest,
    });
  }

  return toDesignSystemSummary(manifest);
}
