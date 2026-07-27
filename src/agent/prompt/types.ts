/** The static runtime-doc source files this module ships, resolved once per process — `runtime-docs.ts`'s own local shape, not a `core/ports` type. */
export interface RuntimeDocSourcesV1 {
  readonly runtimeDeclarationPath: string;
  readonly authoringGuidePath: string;
  /** The Reatom v1001 state-authoring guide — see `runtime-docs.ts` for why it is separate from `authoringGuidePath`. */
  readonly reatomGuidePath: string;
}
