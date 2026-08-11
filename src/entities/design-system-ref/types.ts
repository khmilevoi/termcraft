declare const sourceIdBrand: unique symbol;
declare const designSystemIdBrand: unique symbol;
declare const designSystemVersionBrand: unique symbol;

/**
 * A configured source's identity — the `DesignSystemSource.id` of design §8.1: `"local"`, or
 * a family plus a locator such as `"github:acme/design-systems"`. Obtain one only through
 * `parseSourceId`.
 */
export type SourceId = string & { readonly [sourceIdBrand]: true };

/**
 * A design system's own id (`design-system.json`'s `id`). It is also a directory name — the
 * designer's own systems live at `design-systems/local/<id>/` (design §8.2) — so it carries the
 * same lowercase, Windows-safe mask a page slug does. Obtain one only through
 * `parseDesignSystemId`.
 */
export type DesignSystemId = string & { readonly [designSystemIdBrand]: true };

/** A design system's `MAJOR.MINOR.PATCH` version. Obtain one only through `parseDesignSystemVersion`. */
export type DesignSystemVersion = string & { readonly [designSystemVersionBrand]: true };

/**
 * The parsed form of a `source:system@version` reference (design §8.1). Having an address is
 * what makes an update check and a "where did this come from" answer possible at all; the
 * textual form is produced by `formatDesignSystemRef` and never assembled by hand.
 */
export interface DesignSystemRef {
  readonly sourceId: SourceId;
  readonly systemId: DesignSystemId;
  readonly version: DesignSystemVersion;
}
