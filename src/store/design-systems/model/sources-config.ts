import path from "node:path";

import * as errore from "errore";
import { z } from "zod";

import type { SourceId } from "entities/design-system-ref";
import { parseSourceId } from "entities/design-system-ref";

import type { AbsPath, DesignSystemFsDeps } from "../types";
import { SourcesConfigInvalidError } from "./errors";
import { LOCAL_SOURCE_ID, LOCAL_SOURCE_LABEL, sourcesConfigPath } from "./layout";

/**
 * `{userStateRoot}/design-systems/sources.json` — the configured sources (design §8.2). Plain
 * JSON, so it follows storage-identity §12's "other JSON uses `schemaVersion`" rule rather than
 * the JSONL-header `formatVersion` name.
 */
export const SOURCES_CONFIG_SCHEMA_VERSION = 1;

/**
 * A handful of short strings per source. JUDGMENT CALL (§8.2 fixes no bound): 64 KiB is refused
 * unread, mirroring the bounded advisory read of `store/trust`'s grant records, so a hostile or
 * runaway file in the library directory cannot be buffered.
 */
export const MAX_SOURCES_CONFIG_BYTES = 64 * 1024;

export interface ConfiguredSourceV1 {
  readonly id: SourceId;
  /**
   * The adapter family the composition root maps to a factory. Deliberately an OPEN string: a
   * closed `"local" | "github"` union would invent a member for an adapter that does not exist.
   * An unknown kind is listed and simply not instantiable.
   */
  readonly kind: string;
  readonly label: string;
}

export interface SourcesConfigV1 {
  readonly schemaVersion: typeof SOURCES_CONFIG_SCHEMA_VERSION;
  readonly sources: readonly ConfiguredSourceV1[];
}

/**
 * The one built-in source. It is re-inserted by `decodeSourcesConfig` whether or not the file
 * lists it: a user who deletes the entry must not lose their own systems, and §8.6's stage 1 has
 * nothing else to fall back to.
 */
export const BUILT_IN_LOCAL_SOURCE: ConfiguredSourceV1 = {
  id: LOCAL_SOURCE_ID,
  kind: "local",
  label: LOCAL_SOURCE_LABEL,
};

export const DEFAULT_SOURCES_CONFIG: SourcesConfigV1 = {
  schemaVersion: SOURCES_CONFIG_SCHEMA_VERSION,
  sources: [BUILT_IN_LOCAL_SOURCE],
};

const sourceIdSchema = z.string().transform((raw, ctx) => {
  const id = parseSourceId(raw);
  if (id instanceof Error) {
    ctx.addIssue({ code: "custom", message: id.message });
    return z.NEVER;
  }
  return id;
});

const configuredSourceSchema = z.strictObject({
  id: sourceIdSchema,
  kind: z.string().min(1).max(64),
  label: z.string().min(1).max(200),
});

const sourcesConfigSchema = z.strictObject({
  schemaVersion: z.literal(SOURCES_CONFIG_SCHEMA_VERSION),
  sources: z.array(configuredSourceSchema).max(64),
});

/** The built-in local source first, then every configured non-local source in file order. */
function withBuiltInLocal(sources: readonly ConfiguredSourceV1[]): readonly ConfiguredSourceV1[] {
  return [BUILT_IN_LOCAL_SOURCE, ...sources.filter((source) => source.id !== LOCAL_SOURCE_ID)];
}

// The parameter is `configPath`, never `path` — `path` is the `node:path` import in this file.
export function decodeSourcesConfig(bytes: Uint8Array, configPath: AbsPath) {
  const parsed = errore.try({
    try: () => JSON.parse(new TextDecoder().decode(bytes)) as unknown,
    catch: (cause) =>
      new SourcesConfigInvalidError({ path: configPath, reason: "not valid JSON", cause }),
  });
  if (parsed instanceof Error) return parsed;

  const decoded = sourcesConfigSchema.safeParse(parsed);
  if (!decoded.success) {
    return new SourcesConfigInvalidError({
      path: configPath,
      reason: `not a schema-${SOURCES_CONFIG_SCHEMA_VERSION} sources configuration`,
      cause: decoded.error,
    });
  }

  const ids = new Set<string>();
  for (const source of decoded.data.sources) {
    if (ids.has(source.id)) {
      return new SourcesConfigInvalidError({
        path: configPath,
        reason: `duplicate source id ${source.id}`,
      });
    }
    ids.add(source.id);
  }

  return {
    schemaVersion: SOURCES_CONFIG_SCHEMA_VERSION,
    sources: withBuiltInLocal(decoded.data.sources),
  } satisfies SourcesConfigV1;
}

export function encodeSourcesConfig(config: SourcesConfigV1): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(config, null, 2)}\n`);
}

/** An ABSENT file is the default configuration; an unreadable or corrupt one is a failure. */
export function readSourcesConfig(fs: DesignSystemFsDeps, userStateRoot: AbsPath) {
  const configPath = sourcesConfigPath(userStateRoot);

  const stat = fs.statFile(configPath);
  if (stat instanceof Error) return stat;
  if (stat === null) return DEFAULT_SOURCES_CONFIG;
  if (stat.size > MAX_SOURCES_CONFIG_BYTES) {
    return new SourcesConfigInvalidError({
      path: configPath,
      reason: `exceeds ${MAX_SOURCES_CONFIG_BYTES} bytes and was refused unread`,
    });
  }

  const bytes = fs.readFile(configPath);
  if (bytes instanceof Error) return bytes;
  if (bytes === null) return DEFAULT_SOURCES_CONFIG;

  return decodeSourcesConfig(bytes, configPath);
}

export function writeSourcesConfig(
  fs: DesignSystemFsDeps,
  userStateRoot: AbsPath,
  config: SourcesConfigV1,
) {
  const configPath = sourcesConfigPath(userStateRoot);

  const created = fs.mkdirAll(path.dirname(configPath));
  if (created instanceof Error) return created;

  const wrote = fs.durableWrite(configPath, encodeSourcesConfig(config));
  if (wrote instanceof Error) return wrote;
  return undefined;
}
