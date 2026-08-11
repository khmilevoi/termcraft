// `entities/design-system-ref` — a design system's ADDRESSABLE IDENTITY (design §8.1), kept
// separate from its CONTENT (`entities/design-system`, the manifest entity P2 owns). A
// reference is `source:system@version`: `local:midnight@1.2.0`,
// `github:acme/design-systems#midnight@1.3.0`. Without an address there is no update check and
// no answer to "where did this come from".
export type { DesignSystemId, DesignSystemRef, DesignSystemVersion, SourceId } from "./types";
export {
  InvalidDesignSystemRefError,
  designSystemRefSchema,
  formatDesignSystemRef,
  parseDesignSystemId,
  parseDesignSystemRef,
  parseDesignSystemVersion,
  parseSourceId,
} from "./model/ref";
