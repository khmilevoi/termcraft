/**
 * `core/preview`'s shared vocabulary (CLAUDE.md "Code style": `types.ts` holds a module's
 * shared types). Nothing here yet — every type this module exports (`FrameBroker`,
 * `FrameTokenLedger`/`FrameTokenVerification`, `GeometryTokenLedger`/`GeometryAnchorV1`,
 * `PreviewBackpressure`, `SessionCommandsDeps`/`PreviewSessionCommands`/
 * `PreviewCommandOutcomeV1`/`PreviewQueryOutcomeV1`/`GeometryQueryV1`) is reached for by
 * exactly one file — its own — plus `session-commands.ts`, which imports the four ledger/
 * broker/backpressure factories as ITS OWN dependencies rather than sharing a type with
 * them. That "defined by its one owner, imported by its one consumer" shape matches
 * `core/pins/types.ts`'s own precedent: a shape stays local until a SECOND file needs the
 * identical shape for its own sake, not merely as a dependency of another file's factory.
 */
export {}
