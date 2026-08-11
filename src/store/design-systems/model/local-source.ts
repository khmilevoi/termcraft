import type { DesignSystemSource, LocalDesignSystemSourceDeps } from "../types";
import { fetchLocalPackage } from "./fetch";
import { LOCAL_SOURCE_ID, LOCAL_SOURCE_LABEL } from "./layout";
import { listLocalSystems } from "./list";
import { publishLocalPackage } from "./publish";

/**
 * The one stage-1 source (design §8.6): a local directory, implemented THROUGH the port, with
 * `list`/`fetch`/`publish`, `source:system@version` references, and a content hash. "A local
 * directory needs none of that, which is exactly why it is easy to write it in a way GitHub
 * cannot later join."
 *
 * `canPublish` is `true` and DECLARED, not assumed (§8.1): a local directory publishes by
 * copying, where a GitHub source would commit or open a pull request — a different operation
 * with its own permissions and confirmation.
 */
export function createLocalDesignSystemSource(
  deps: LocalDesignSystemSourceDeps,
): DesignSystemSource {
  return {
    id: LOCAL_SOURCE_ID,
    label: LOCAL_SOURCE_LABEL,
    canPublish: true,
    list: () => listLocalSystems(deps),
    fetch: (ref) => fetchLocalPackage(deps, ref),
    publish: (pkg) => publishLocalPackage(deps, pkg),
  };
}
