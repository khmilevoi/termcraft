import * as errore from "errore";
import { z } from "zod";

import { CORE_TOKEN_ROLES, DESIGN_SYSTEM_SCHEMA_VERSION } from "../types";
import type { DesignSystemManifestV1 } from "../types";

/**
 * `design/system/design-system.json` could not be read as a manifest (design-systems spec):
 * invalid JSON, a bad shape, an unknown field, an invalid slug, a missing core token role, a
 * token-name mismatch across themes, an undeclared `defaultTheme`, or a duplicate component name.
 * Returned as a value; the Gate turns it into a fatal `GateError` (later tasks).
 */
export class DesignSystemManifestInvalidError extends errore.createTaggedError({
  name: "DesignSystemManifestInvalidError",
  message: "design/system/design-system.json is invalid [$code]: $reason",
}) {}

/** A kebab slug — a design-system id and every theme id (decision D4). */
const slugSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, { error: "must be a lowercase kebab slug" });

/** A token NAME must be writable as `t.<name>` — §4.3's taught access path (decision D4). */
const tokenNameSchema = z
  .string()
  .regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/, { error: "must be a valid identifier" });

/** A token VALUE: lowercase `#rrggbb` (§4.1). Uppercase is rejected, never normalized — the
 *  manifest's bytes feed `treeRevision`, so a decoder that rewrote them would invalidate caches
 *  for nothing and make two byte-different manifests look identical. */
const colorSchema = z
  .string()
  .regex(/^#[0-9a-f]{6}$/, { error: "must be a lowercase #rrggbb colour" });

/** A component `module`: a POSIX path relative to `system/`, with the same stored-address rules
 *  `entities/design-tree`'s `entryPathSchema` applies — no backslash, not absolute, no `.`/`..`
 *  segment, no empty segment. `..` is refused here rather than normalized: a component module is a
 *  stored address, and §5.1 forbids leaving `system/` anyway. */
const componentModuleSchema = z
  .string()
  .min(1)
  .refine((v) => !v.includes("\\"), { error: "`module` must use forward slashes" })
  .refine((v) => !v.startsWith("/"), { error: "`module` must be relative to system/" })
  .refine((v) => !/^[A-Za-z]:/.test(v), { error: "`module` must not be a drive path" })
  .refine((v) => !v.includes("//"), { error: "`module` must not contain an empty segment" })
  .refine((v) => v.split("/").every((s) => s !== "" && s !== "." && s !== ".."), {
    error: "`module` must not contain `.` or `..` segments",
  });

const themeSchema = z.strictObject({
  label: z.string().min(1),
  tokens: z.record(tokenNameSchema, colorSchema),
});

const componentSchema = z.strictObject({
  name: z.string().min(1),
  module: componentModuleSchema,
  export: z.string().min(1),
});

// Field order below is significant, not cosmetic: Zod reports `safeParse` issues in shape
// declaration order, and `fromZod` below only looks at `issues[0]`. `themes` is declared BEFORE
// `defaultTheme` so a manifest whose theme id and `defaultTheme` are both invalid (e.g. both
// "Dark") is reported under `themes` — the field the test suite pins the code to — rather than
// under `defaultTheme`, which the record-key issue would otherwise lose to.
const designSystemManifestSchema = z.strictObject({
  schemaVersion: z.literal(DESIGN_SYSTEM_SCHEMA_VERSION),
  id: slugSchema,
  name: z.string().min(1),
  version: z.string().min(1),
  kitApiVersion: z.number().int().positive(),
  themes: z
    .record(slugSchema, themeSchema)
    .refine((t) => Object.keys(t).length > 0, { error: "at least one theme is required" }),
  defaultTheme: slugSchema,
  components: z.array(componentSchema),
});

function invalid(code: string, reason: string): DesignSystemManifestInvalidError {
  return new DesignSystemManifestInvalidError({ code, reason });
}

/**
 * The first Zod issue mapped onto the tagged error. Every NUMERIC path segment (a JSON array
 * index) is dropped before joining, so the code names the FIELD (`components.export`) and never
 * the index a particular issue happened to land on — the identical rule, and the identical
 * reason, as `entities/design-tree/model/manifest.ts`'s own `fromZod`.
 *
 * A `z.record` issue's path also carries the offending KEY (`themes.dark.tokens.accent`), which is
 * a string, not an index — so it survives the numeric filter and would make the code depend on the
 * project's own theme and token names. Record keys are dropped too, by taking only the path
 * segments that name a SCHEMA field: `themes`/`tokens`/`label` are schema fields, `dark` and
 * `accent` are data. The filter below keeps the segments that are keys of a known field set.
 */
const SCHEMA_FIELD_SEGMENTS: ReadonlySet<string> = new Set([
  "schemaVersion",
  "id",
  "name",
  "version",
  "kitApiVersion",
  "defaultTheme",
  "themes",
  "label",
  "tokens",
  "components",
  "module",
  "export",
]);

function fromZod(error: z.ZodError): DesignSystemManifestInvalidError {
  const issue = error.issues[0];
  const field = (issue?.path ?? [])
    .filter((segment): segment is string => typeof segment === "string")
    .filter((segment) => SCHEMA_FIELD_SEGMENTS.has(segment))
    .join(".");
  const code = field.length > 0 ? field : "SHAPE";
  return invalid(code, issue?.message ?? "invalid input");
}

/**
 * Parse and validate `system/design-system.json` (design-systems spec §3.2, §4). Structural
 * validation is Zod's; the cross-field rules — every theme declares every core role, token-name
 * parity across themes, `defaultTheme` naming a declared theme, and no duplicate component name —
 * are checked here because they span array/map entries, in the shape
 * `entities/design-tree/model/manifest.ts`'s `decodePagesManifest` uses: parse, `safeParse`, then
 * cross-field rules, each returning early.
 */
export function decodeDesignSystemManifest(
  text: string,
): DesignSystemManifestInvalidError | DesignSystemManifestV1 {
  const parsed = errore.try({
    try: () => JSON.parse(text) as unknown,
    catch: (cause) => cause,
  });
  if (parsed instanceof Error) return invalid("JSON_PARSE", `not valid JSON: ${parsed.message}`);

  const result = designSystemManifestSchema.safeParse(parsed);
  if (!result.success) return fromZod(result.error);
  const manifest = result.data;

  // §4.1 — every theme declares every core role.
  for (const [themeId, theme] of Object.entries(manifest.themes)) {
    for (const role of CORE_TOKEN_ROLES) {
      if (theme.tokens[role] === undefined)
        return invalid(
          "MISSING_CORE_ROLE",
          `theme "${themeId}" omits the core token role "${role}"`,
        );
    }
  }

  // §4.2 — token-name parity across every theme of one system. Compared against the FIRST theme
  // in declaration order, in BOTH directions, so a name present in one and absent from the other
  // is caught whichever theme happens to carry it.
  const themeEntries = Object.entries(manifest.themes);
  const [referenceId, reference] = themeEntries[0]!; // the schema refuses an empty themes map
  const referenceNames = Object.keys(reference.tokens);
  for (const [themeId, theme] of themeEntries.slice(1)) {
    for (const name of referenceNames) {
      if (theme.tokens[name] === undefined)
        return invalid(
          "TOKEN_PARITY",
          `token "${name}" is declared in theme "${referenceId}" but not in theme "${themeId}"`,
        );
    }
    for (const name of Object.keys(theme.tokens)) {
      if (reference.tokens[name] === undefined)
        return invalid(
          "TOKEN_PARITY",
          `token "${name}" is declared in theme "${themeId}" but not in theme "${referenceId}"`,
        );
    }
  }

  // §7 — `defaultTheme` must name a declared theme.
  if (manifest.themes[manifest.defaultTheme] === undefined)
    return invalid(
      "DEFAULT_THEME_UNDECLARED",
      `defaultTheme "${manifest.defaultTheme}" is not one of the declared themes (${Object.keys(manifest.themes).sort().join(", ")})`,
    );

  // A duplicate component name would make `components[]` ambiguous for the agent prompt and the
  // picker alike; checked here because it spans array elements.
  const seenComponents = new Set<string>();
  for (const component of manifest.components) {
    if (seenComponents.has(component.name))
      return invalid(
        "DUPLICATE_COMPONENT",
        `"${component.name}" is declared more than once in \`components\``,
      );
    seenComponents.add(component.name);
  }

  return manifest;
}
