import {
  DESIGN_SYSTEM_MANIFEST_RELPATH,
  DESIGN_SYSTEM_TOKENS_RELPATH,
  createSeedManifest,
  renderDesignSystemManifest,
  renderTokensScaffold,
} from "entities/design-system";

/** One seed file: its TREE-relative path (`system/…`) and its exact bytes. */
export interface DesignSystemSeedFileV1 {
  readonly relPath: string;
  readonly bytes: Uint8Array;
}

/**
 * The two files a project's design system starts life as (design-systems §4.4, §9). ONE emitter,
 * shared by `createProject` and by the mechanical migration, because a created project and a
 * migrated project must be the same thing — two emitters would drift into two seed palettes and
 * only a user with both would ever notice.
 *
 * TREE-relative paths: the caller prefixes `design/` through `store/transaction`'s
 * `designFilePath`, exactly as it already does for `pages.json`.
 */
export function createDesignSystemSeedFiles(input: {
  readonly kitApiVersion: number;
}): readonly DesignSystemSeedFileV1[] {
  const manifest = createSeedManifest({ kitApiVersion: input.kitApiVersion });
  const encoder = new TextEncoder();
  return [
    {
      relPath: DESIGN_SYSTEM_MANIFEST_RELPATH,
      bytes: encoder.encode(renderDesignSystemManifest(manifest)),
    },
    {
      relPath: DESIGN_SYSTEM_TOKENS_RELPATH,
      bytes: encoder.encode(renderTokensScaffold(manifest)),
    },
  ];
}
