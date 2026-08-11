import { DESIGN_SYSTEM_DIRNAME } from "../types";
import type { DesignSystemComponentV1, DesignSystemManifestV1 } from "../types";

/**
 * The TREE-relative path of a declared component (design-systems §5). `module` is relative to
 * `system/`, so this is the one place the two are joined — a caller that concatenated it itself
 * would be a second reading of where a design system lives.
 */
export function designSystemComponentRelPath(component: DesignSystemComponentV1): string {
  return `${DESIGN_SYSTEM_DIRNAME}/${component.module}`;
}

/**
 * The declared components whose module names no file in the tree (design-systems §5: "the Gate
 * requires every entry to resolve to a real file inside `system/`"). Separated from the decoder
 * because it needs the inventory the decoder never sees — the same split
 * `entities/design-tree`'s `findUnresolvedEntries` counterpart makes.
 *
 * Resolution is EXACT: there is no extension probing here, unlike an import specifier. A manifest
 * entry is a stored address, and probing would let one manifest mean two different files.
 */
export function findUnresolvedComponents(input: {
  readonly manifest: DesignSystemManifestV1;
  readonly has: (relPath: string) => boolean;
}): readonly DesignSystemComponentV1[] {
  return input.manifest.components.filter(
    (component) => !input.has(designSystemComponentRelPath(component)),
  );
}

/**
 * True for a TREE-relative path inside the design system's folder (design-systems §5.1). The
 * trailing slash is load-bearing: `systemic/x.ts` is not inside `system/`, and the directory name
 * alone is not a file inside it.
 */
export function isInsideDesignSystem(relPath: string): boolean {
  return relPath.startsWith(`${DESIGN_SYSTEM_DIRNAME}/`);
}
