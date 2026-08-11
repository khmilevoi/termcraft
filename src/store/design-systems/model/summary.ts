import * as errore from "errore";
import { z } from "zod";

import type { AbsPath, DesignSystemSummary, TokenSwatch } from "../types";
import { DesignSystemPackageInvalidError } from "./errors";

/**
 * A MINIMAL, NON-EXECUTING read of `design-system.json` — exactly the seven facts a picker's
 * swatch row needs (design §8.1), and nothing more.
 *
 * RECONCILIATION SEAM (project-design-systems §10.1, wave 1). P2 (`manifest-and-gate`) owns the
 * real manifest entity in `entities/design-system`: the full Zod schema, the decoder, and every
 * §7 fatal. P3 ships in parallel with P2 and cannot import what has not landed, so this file
 * carries its own deliberately-narrow schema. AT SYNC POINT 1 the follow-up is: keep
 * `toDesignSystemSummary`, delete `summarySchema`, and call `entities/design-system`'s decoder
 * instead — one parser, one authority. Whoever resolves sync point 1 (or P10) owns that change.
 *
 * THIS IS NOT A VALIDITY VERDICT. It deliberately does NOT check core-role presence, cross-theme
 * token parity, lowercase `#rrggbb` values, component resolvability, or whether `kitApiVersion`
 * is supported. Those are §7's Gate fatals and duplicating them here would create a second,
 * drifting authority. A summary says only "readable enough to show".
 *
 * It parses JSON and never executes or compiles anything — the property §3.2 makes the manifest
 * data-shaped for, and what §11's "`list` never opens a `.tsx`" rests on.
 */

const themeSchema = z.object({
  tokens: z.record(z.string().min(1), z.string()),
});

const summarySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  kitApiVersion: z.number().int(),
  defaultTheme: z.string().min(1),
  themes: z.record(z.string().min(1), themeSchema),
  components: z.array(z.object({ name: z.string().min(1) })).optional(),
});

/**
 * A canonical non-negative integer key is an ARRAY INDEX to JavaScript, and array-index keys
 * are enumerated before every string key regardless of insertion order — which would silently
 * scramble the swatch row. Refused narrowly and honestly rather than drawn in the wrong order.
 */
const ARRAY_INDEX_KEY = /^(0|[1-9]\d*)$/;

export function readDesignSystemSummary(bytes: Uint8Array, manifestPath: AbsPath) {
  const parsed = errore.try({
    try: () => JSON.parse(new TextDecoder().decode(bytes)) as unknown,
    catch: (cause) =>
      new DesignSystemPackageInvalidError({
        path: manifestPath,
        reason: "manifest is not valid JSON",
        cause,
      }),
  });
  if (parsed instanceof Error) return parsed;

  const decoded = summarySchema.safeParse(parsed);
  if (!decoded.success) {
    return new DesignSystemPackageInvalidError({
      path: manifestPath,
      reason: "manifest is missing a field the picker needs",
      cause: decoded.error,
    });
  }

  const theme = decoded.data.themes[decoded.data.defaultTheme];
  if (theme === undefined) {
    return new DesignSystemPackageInvalidError({
      path: manifestPath,
      reason: `defaultTheme "${decoded.data.defaultTheme}" names no declared theme`,
    });
  }

  const names = Object.keys(theme.tokens);
  const indexLike = names.find((name) => ARRAY_INDEX_KEY.test(name));
  if (indexLike !== undefined) {
    return new DesignSystemPackageInvalidError({
      path: manifestPath,
      reason: `token name "${indexLike}" is an array index and would reorder the swatch row`,
    });
  }

  const defaultThemeTokens: readonly TokenSwatch[] = names.map((name) => ({
    name,
    value: theme.tokens[name] as string,
  }));

  return {
    id: decoded.data.id,
    name: decoded.data.name,
    version: decoded.data.version,
    kitApiVersion: decoded.data.kitApiVersion,
    defaultTheme: decoded.data.defaultTheme,
    defaultThemeTokens,
    componentNames: (decoded.data.components ?? []).map((component) => component.name),
  } satisfies DesignSystemSummary;
}
