import * as errore from "errore"
import { z } from "zod"

import { pageSlugSchema } from "entities/page"
import { rfc3339UtcSchema } from "infrastructure/clock"
import { canonicalUuidv7Schema } from "infrastructure/uuid"
import { TARGET_STACKS } from "../types"
import type { ProjectManifest } from "../types"

/** The portable manifest's name inside `.termcraft/` (storage-identity §4, §5.1). */
export const PROJECT_MANIFEST_FILENAME = "project.toml"

/** The only shipped portable schema version (storage-identity §5.1, §12). */
export const PROJECT_MANIFEST_FORMAT_VERSION = 1

/**
 * `project.toml` is unreadable: not TOML, missing/non-integer `format_version`, a failed
 * field rule, or a non-portable field. Readers never repair identity by rewriting the file
 * (storage-identity §5.2) — this is returned as a value and the caller decides.
 */
export class ManifestCorruptError extends errore.createTaggedError({
  name: "ManifestCorruptError",
  message: "$file is not a valid termcraft project manifest [$code]: $reason",
}) {}

/**
 * `project.toml` declares a `format_version` newer than this binary supports. A
 * newer-than-supported data format is a HARD error naming the file, and data-format
 * downgrades are unsupported (storage-identity §12).
 */
export class ManifestTooNewError extends errore.createTaggedError({
  name: "ManifestTooNewError",
  message: "$file has format_version $found, newer than the supported version $supported",
}) {}

/** The named TOML basic-string escapes (TOML v1.0.0, "String"). */
const TOML_ESCAPES = new Map<string, string>([
  ["\\", "\\\\"],
  ['"', '\\"'],
  ["\b", "\\b"],
  ["\t", "\\t"],
  ["\n", "\\n"],
  ["\f", "\\f"],
  ["\r", "\\r"],
])

/** Highest code point a TOML basic string may carry literally before `\u` escaping (C0 range). */
const HIGHEST_CONTROL_CODE = 0x1f
const DELETE_CODE = 0x7f

/** One character as it appears inside a TOML basic string. */
function escapeTomlChar(char: string): string {
  const named = TOML_ESCAPES.get(char)
  if (named !== undefined) return named
  const code = char.charCodeAt(0)
  if (code > HIGHEST_CONTROL_CODE && code !== DELETE_CODE) return char
  return `\\u${code.toString(16).padStart(4, "0")}`
}

/**
 * Encode `value` as a TOML basic string. Bun ships `Bun.TOML.parse` but no TOML writer
 * (verified on Bun 1.3.14: `Object.keys(Bun.TOML)` is `["parse"]`), so this module
 * hand-serializes its small closed field set rather than taking a new dependency.
 */
export function encodeTomlString(value: string): string {
  return `"${[...value].map(escapeTomlChar).join("")}"`
}

/**
 * One deterministic `key = value` line. The closed value domain of both termcraft TOML
 * files is: integer, boolean, basic string, and array of basic strings.
 */
export function tomlLine(key: string, value: string | number | boolean | readonly string[]): string {
  if (typeof value === "string") return `${key} = ${encodeTomlString(value)}`
  if (typeof value === "number" || typeof value === "boolean") return `${key} = ${value}`
  return `${key} = [${value.map(encodeTomlString).join(", ")}]`
}

/**
 * The TOML-parse boundary, shared by both manifest decoders. `Bun.TOML.parse` throws a Bun
 * `BuildMessage`, which is NOT an `Error` instance, so `errore.try` would rethrow it rather
 * than hand it to the `catch` mapper; this normalizes the foreign throwable into a value.
 * The result is wrapped in `{ value }` because a bare `unknown | Error` union collapses to
 * `unknown` and destroys narrowing.
 */
export function parseToml(text: string): Error | { readonly value: unknown } {
  try {
    return { value: Bun.TOML.parse(text) as unknown }
  } catch (thrown) {
    return thrown instanceof Error ? thrown : new Error(String(thrown))
  }
}

/** Maps the first Zod issue onto a `ManifestCorruptError`, mirroring the `entities/` decoders. */
function toCorruptError(file: string, error: z.ZodError): ManifestCorruptError {
  const issue = error.issues[0]
  const code = issue !== undefined && issue.path.length > 0 ? issue.path.join(".") : "SHAPE"
  return new ManifestCorruptError({ file, code, reason: issue?.message ?? "invalid input" })
}

/**
 * `format_version` read WITHOUT the field schema, so a newer file is classified as
 * too-new rather than as a shape violation (storage-identity §12: the version check is the
 * outermost gate). Returns `null` when the value is missing or not an integer.
 */
export function readFormatVersion(value: unknown): number | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null
  const found = (value as Record<string, unknown>)["format_version"]
  if (typeof found !== "number" || !Number.isInteger(found)) return null
  return found
}

/**
 * Exactly the five semantic fields of storage-identity §5.1 plus `format_version`.
 * `strictObject` is the mechanism that "rejects any non-portable field": active page,
 * active chat, backend, model, effort, preview/UI settings, session ids, Git status, page
 * title, `minSize`, theme, source hash, and extracted page metadata all belong to
 * `workspace.local.toml` or a rebuildable projection, so their presence here is corruption.
 */
const projectManifestSchema = z.strictObject({
  format_version: z.literal(PROJECT_MANIFEST_FORMAT_VERSION),
  project_id: canonicalUuidv7Schema,
  // §5.1 requires the field ("portable display name") but bounds neither its length nor
  // its charset, so no invented limit is applied here.
  name: z.string(),
  created_at: rfc3339UtcSchema,
  target_stack: z.enum(TARGET_STACKS),
  pages: z.array(pageSlugSchema).refine((pages) => new Set(pages).size === pages.length, { error: "`pages` must be duplicate-free" }),
})

/**
 * Serialize a `ProjectManifest` as the portable `.termcraft/project.toml`
 * (storage-identity §5.1). Field order is fixed so the file is byte-deterministic and
 * produces a minimal Git diff; page order is preserved verbatim because it IS the listing
 * and tab order.
 */
export function encodeProjectManifest(manifest: ProjectManifest): string {
  return [
    tomlLine("format_version", manifest.formatVersion),
    tomlLine("project_id", manifest.projectId),
    tomlLine("name", manifest.name),
    tomlLine("created_at", manifest.createdAt),
    tomlLine("target_stack", manifest.targetStack),
    tomlLine("pages", manifest.pages),
    "",
  ].join("\n")
}

/**
 * Parse and validate `.termcraft/project.toml` (storage-identity §5.1). The order is
 * deliberate: TOML parse, then the `format_version` gate (a newer file is
 * {@link ManifestTooNewError}, never a shape complaint), then the strict field schema.
 * `file` names the artifact in every error, as §12 requires.
 */
export function decodeProjectManifest(
  text: string,
  file: string = PROJECT_MANIFEST_FILENAME,
): ProjectManifest | ManifestCorruptError | ManifestTooNewError {
  const parsed = parseToml(text)
  if (parsed instanceof Error) {
    return new ManifestCorruptError({ file, code: "TOML_PARSE", reason: "file is not valid TOML", cause: parsed })
  }

  const version = readFormatVersion(parsed.value)
  if (version === null) {
    return new ManifestCorruptError({ file, code: "format_version", reason: "missing or non-integer `format_version`" })
  }
  if (version > PROJECT_MANIFEST_FORMAT_VERSION) {
    return new ManifestTooNewError({ file, found: version, supported: PROJECT_MANIFEST_FORMAT_VERSION })
  }

  const result = projectManifestSchema.safeParse(parsed.value)
  if (!result.success) return toCorruptError(file, result.error)

  return {
    formatVersion: PROJECT_MANIFEST_FORMAT_VERSION,
    projectId: result.data.project_id,
    name: result.data.name,
    createdAt: result.data.created_at,
    targetStack: result.data.target_stack,
    pages: result.data.pages,
  }
}
