import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { SourcesConfigInvalidError } from "./errors";
import { nodeDesignSystemFsDeps } from "./fs-deps";
import { sourcesConfigPath } from "./layout";
import {
  BUILT_IN_LOCAL_SOURCE,
  DEFAULT_SOURCES_CONFIG,
  decodeSourcesConfig,
  encodeSourcesConfig,
  readSourcesConfig,
  writeSourcesConfig,
} from "./sources-config";

const scratchRoots: string[] = [];
function freshScratch(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-ds-sources-"));
  scratchRoots.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of scratchRoots) fs.rmSync(dir, { recursive: true, force: true });
});

const utf8 = (text: string) => new Uint8Array(Buffer.from(text, "utf8"));

describe("decodeSourcesConfig", () => {
  test("decodes a schema-1 configuration", () => {
    const decoded = decodeSourcesConfig(
      utf8(
        JSON.stringify({
          schemaVersion: 1,
          sources: [
            { id: "local", kind: "local", label: "Local library" },
            { id: "github:acme/design-systems", kind: "github", label: "Acme" },
          ],
        }),
      ),
      "sources.json",
    );
    expect(decoded).not.toBeInstanceOf(Error);
    if (decoded instanceof Error) return;
    expect(decoded.sources.map((source) => source.id)).toEqual([
      "local",
      "github:acme/design-systems",
    ] as never);
  });

  test("re-inserts the built-in local source when the file omits it", () => {
    const decoded = decodeSourcesConfig(
      utf8(
        JSON.stringify({
          schemaVersion: 1,
          sources: [{ id: "github:acme/design-systems", kind: "github", label: "Acme" }],
        }),
      ),
      "sources.json",
    );
    if (decoded instanceof Error) throw decoded;
    expect(decoded.sources[0]).toEqual(BUILT_IN_LOCAL_SOURCE);
    expect(decoded.sources).toHaveLength(2);
  });

  test("rejects a non-1 schema version, malformed JSON, a bad source id, and a duplicate id", () => {
    expect(decodeSourcesConfig(utf8('{"schemaVersion":2,"sources":[]}'), "p")).toBeInstanceOf(
      SourcesConfigInvalidError,
    );
    expect(decodeSourcesConfig(utf8("{not json"), "p")).toBeInstanceOf(SourcesConfigInvalidError);
    expect(
      decodeSourcesConfig(
        utf8(JSON.stringify({ schemaVersion: 1, sources: [{ id: "A B", kind: "x", label: "l" }] })),
        "p",
      ),
    ).toBeInstanceOf(SourcesConfigInvalidError);
    expect(
      decodeSourcesConfig(
        utf8(
          JSON.stringify({
            schemaVersion: 1,
            sources: [
              { id: "github:a/b", kind: "github", label: "one" },
              { id: "github:a/b", kind: "github", label: "two" },
            ],
          }),
        ),
        "p",
      ),
    ).toBeInstanceOf(SourcesConfigInvalidError);
  });
});

describe("encodeSourcesConfig / decodeSourcesConfig round trip", () => {
  test("re-decodes to the identical configuration", () => {
    const config = {
      schemaVersion: 1 as const,
      sources: [
        BUILT_IN_LOCAL_SOURCE,
        { id: "github:acme/design-systems" as never, kind: "github", label: "Acme" },
      ],
    };
    const decoded = decodeSourcesConfig(encodeSourcesConfig(config), "p");
    expect(decoded).toEqual(config);
  });

  test("encodes as JSON with a trailing newline", () => {
    const text = Buffer.from(encodeSourcesConfig(DEFAULT_SOURCES_CONFIG)).toString("utf8");
    expect(text.endsWith("\n")).toBe(true);
    expect(JSON.parse(text).schemaVersion).toBe(1);
  });
});

describe("readSourcesConfig / writeSourcesConfig", () => {
  test("an absent file is the default configuration, not a failure", () => {
    const root = freshScratch();
    expect(readSourcesConfig(nodeDesignSystemFsDeps, root)).toEqual(DEFAULT_SOURCES_CONFIG);
  });

  test("writes then reads back the same configuration", () => {
    const root = freshScratch();
    const config = {
      schemaVersion: 1 as const,
      sources: [
        BUILT_IN_LOCAL_SOURCE,
        { id: "github:acme/design-systems" as never, kind: "github", label: "Acme" },
      ],
    };
    expect(writeSourcesConfig(nodeDesignSystemFsDeps, root, config)).toBeUndefined();
    expect(fs.existsSync(sourcesConfigPath(root))).toBe(true);
    expect(readSourcesConfig(nodeDesignSystemFsDeps, root)).toEqual(config);
  });

  test("a corrupt file is a failure, never silently the default", () => {
    const root = freshScratch();
    fs.mkdirSync(path.dirname(sourcesConfigPath(root)), { recursive: true });
    fs.writeFileSync(sourcesConfigPath(root), "{ not json");
    expect(readSourcesConfig(nodeDesignSystemFsDeps, root)).toBeInstanceOf(
      SourcesConfigInvalidError,
    );
  });

  test("a sources.json that is a directory is a failure, never silently the default (M8)", () => {
    // Regression: `statFile` used to fold "present but not a regular file" into `null`
    // alongside true absence (ENOENT), so a directory at the config path was silently read as
    // "no config yet" — contradicting this function's own doc comment.
    const root = freshScratch();
    fs.mkdirSync(sourcesConfigPath(root), { recursive: true });
    expect(readSourcesConfig(nodeDesignSystemFsDeps, root)).toBeInstanceOf(
      SourcesConfigInvalidError,
    );
  });
});
