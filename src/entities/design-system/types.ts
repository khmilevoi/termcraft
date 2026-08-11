/**
 * The design system's own folder name inside the design tree (design-systems §3.1). TREE-relative
 * paths are relative to `design/`, so a design-system file is `system/…`, never `design/system/…`
 * — the one path vocabulary the whole Gate whole-tree pass speaks.
 */
export const DESIGN_SYSTEM_DIRNAME = "system";

/** The manifest's TREE-relative path (design-systems §3.2). */
export const DESIGN_SYSTEM_MANIFEST_RELPATH = `${DESIGN_SYSTEM_DIRNAME}/design-system.json`;

/** The only shipped manifest schema version (design-systems §3.2). */
export const DESIGN_SYSTEM_SCHEMA_VERSION = 1;

/**
 * The core token roles EVERY theme must declare (design-systems §4.1). The names are required;
 * the values are the project's. The component catalog binds to these — `Panel` with no
 * `borderColor` means `border`, status semantics mean `success`/`warning`/`danger` — so without a
 * required core every component prop becomes mandatory at every call site.
 *
 * DECLARED HERE RATHER THAN IMPORTED from `runtime/types.ts`'s `ThemeTokens`, which is the real
 * source: `entities/` may not import `runtime`. The divergence is not left to prose —
 * `manifest.test.ts` carries a type-level exact-equality assertion against `keyof ThemeTokens`, so
 * a drift is a compile error, not a silent one.
 */
export const CORE_TOKEN_ROLES = [
  "background",
  "surface",
  "foreground",
  "foregroundMuted",
  "foregroundFaint",
  "border",
  "line",
  "accent",
  "accentHi",
  "accentDim",
  "selection",
  "selectionFg",
  "success",
  "warning",
  "danger",
  "dangerDim",
  "statusBg",
] as const;

export type CoreTokenRole = (typeof CORE_TOKEN_ROLES)[number];

/** One theme's label and token values (design-systems §3.2, §4.1). */
export interface DesignSystemThemeV1 {
  /** The theme's human-readable display name (design-systems §3.2). */
  readonly label: string;
  /** Token name -> lowercase `#rrggbb` value; every {@link CoreTokenRole} plus any project tokens (design-systems §4.1). */
  readonly tokens: Readonly<Record<string, string>>;
}

/** One declared component catalog entry (design-systems §3.2, §5). */
export interface DesignSystemComponentV1 {
  /** The component's display/catalog name (design-systems §3.2). */
  readonly name: string;
  /** POSIX path RELATIVE TO `system/` — e.g. `components/Button.tsx` (design-systems §3.2). */
  readonly module: string;
  /** The named export inside `module` (design-systems §3.2). */
  readonly export: string;
}

/** The decoded `system/design-system.json` manifest (design-systems §3.2). */
export interface DesignSystemManifestV1 {
  /** The manifest schema version; only {@link DESIGN_SYSTEM_SCHEMA_VERSION} is accepted (design-systems §3.2). */
  readonly schemaVersion: typeof DESIGN_SYSTEM_SCHEMA_VERSION;
  /** A kebab-slug identifier for the design system (design-systems §3.2). */
  readonly id: string;
  /** The design system's human-readable display name (design-systems §3.2). */
  readonly name: string;
  /** The design system's own version string (design-systems §3.2). */
  readonly version: string;
  /** The kit API version this manifest targets; the supported set is checked in `gate` (design-systems §3.2, D2). */
  readonly kitApiVersion: number;
  /** The theme id (a key of {@link themes}) used when a page names none (design-systems §3.2). */
  readonly defaultTheme: string;
  /** Theme id -> theme; every theme's token names must match every other's (design-systems §3.2, §4.2). */
  readonly themes: Readonly<Record<string, DesignSystemThemeV1>>;
  /** The declared component catalog (design-systems §3.2, §5). */
  readonly components: readonly DesignSystemComponentV1[];
}
