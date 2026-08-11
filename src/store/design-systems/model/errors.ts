import * as errore from "errore";

import { DuplicatePackageFileError } from "./content-hash";

/**
 * The tagged failures a design-system source can return — design §8.1's `SourceError`, as a
 * real `_tag`-discriminated union. `store/adapters/design-system-source.ts` maps every member
 * onto `core/protocol`'s closed `FailureDtoV1` registry at the port boundary; nothing here ever
 * throws.
 */

/** A read, write, enumeration, or rename against the library or a package directory failed. */
export class DesignSystemSourceIoError extends errore.createTaggedError({
  name: "DesignSystemSourceIoError",
  message: "design-system library $operation failed for $path: $detail",
}) {}

/** A package is present but unusable: no manifest, an undecodable one, or one that contradicts its address. */
export class DesignSystemPackageInvalidError extends errore.createTaggedError({
  name: "DesignSystemPackageInvalidError",
  message: "design-system package at $path is unusable: $reason",
}) {}

/** The reference names another source, an unknown system, or a version this source does not carry. */
export class DesignSystemRefRejectedError extends errore.createTaggedError({
  name: "DesignSystemRefRejectedError",
  message: "design-system reference $ref rejected: $reason",
}) {}

/** `publish` was called on a source that cannot publish, or the target refused the write. */
export class DesignSystemPublishRefusedError extends errore.createTaggedError({
  name: "DesignSystemPublishRefusedError",
  message: "design-system publish refused: $reason",
}) {}

/**
 * The injected {@link PackageAdmission} refused a file. Its `cause` carries the budget's own
 * error — a `StorageLimitExceededError` once P10 wires the safe-fs `design-source` budget in —
 * so the measured/allowed figures survive to the failure DTO's safe message.
 */
export class DesignSystemPackageTooLargeError extends errore.createTaggedError({
  name: "DesignSystemPackageTooLargeError",
  message: "design-system package refused at $path: $detail",
}) {}

/** `sources.json` is present but is not a schema-1 sources configuration. */
export class SourcesConfigInvalidError extends errore.createTaggedError({
  name: "SourcesConfigInvalidError",
  message: "sources configuration at $path is invalid: $reason",
}) {}

/** Every failure this module can return. */
export type SourceError =
  | DesignSystemSourceIoError
  | DesignSystemPackageInvalidError
  | DesignSystemRefRejectedError
  | DesignSystemPublishRefusedError
  | DesignSystemPackageTooLargeError
  | SourcesConfigInvalidError
  | DuplicatePackageFileError;
