import { describe, expect, test } from "bun:test";

import { context, wrap } from "@reatom/core";

import type {
  DesignSystemSource,
  DesignSystemSummaryV1,
  DesignTreeReader,
  GateErrorV1,
  GateRunner,
} from "core/ports";
import {
  createFakeDesignStore,
  createFakeDesignSystemInstall,
  createFakeDesignSystemSource,
  createFakeGateRunner,
} from "core/ports/fakes";
import type { DesignTreeFileSeedV1 } from "core/ports/fakes";
import type { FailureDtoV1 } from "core/protocol";
import { parseDesignSystemRef } from "entities/design-system-ref";
import {
  PAGES_MANIFEST_RELPATH,
  PAGES_MANIFEST_SCHEMA_VERSION,
  decodePagesManifest,
  encodePagesManifest,
} from "entities/design-tree";

import type { DesignSystemInstallPortsV1, DesignSystemPreparedInstallV1 } from "../types";
import {
  commitDesignSystemInstall,
  discardPreparedInstall,
  prepareDesignSystemInstall,
} from "./install";

/**
 * The install pipeline (project-design-systems design §8.3, §8.5; decisions D4-D6, D11): trust
 * -> fetch -> quarantine -> immutable candidate -> whole-tree Gate -> breakage preview -> one
 * recoverable commit. `createFakePorts` composes `core/ports/fakes`' own individual doubles
 * (extended, never replaced) into one `DesignSystemInstallPortsV1`, with a `trace` array that
 * proves ORDERING across ports — the property no per-port fake test can see on its own.
 */

const encode = (text: string) => new TextEncoder().encode(text);

function refOf(raw: string) {
  const parsed = parseDesignSystemRef(raw);
  if (parsed instanceof Error) throw parsed;
  return parsed;
}

/**
 * Narrows `FailureDtoV1 | DesignSystemPreparedInstallV1` via the ring's own `"code" in x` guard
 * (`core/project/model/tree-index.ts`'s idiom) rather than an `as` cast — `prepareDesignSystemInstall`
 * never returns an `Error` instance, so `instanceof Error` narrowing does not apply here.
 */
function expectPrepared(
  result: FailureDtoV1 | DesignSystemPreparedInstallV1,
): DesignSystemPreparedInstallV1 {
  if ("code" in result) throw new Error(`expected a preparation, got ${result.safeMessage}`);
  return result;
}

const MIDNIGHT_REF = refOf("local:midnight@1.2.0");

const MIDNIGHT_SUMMARY: DesignSystemSummaryV1 = {
  id: "midnight",
  name: "Midnight",
  version: "1.2.0",
  kitApiVersion: 1,
  defaultTheme: "dark",
  defaultThemeTokens: [],
  componentNames: [],
};

const MIDNIGHT_MANIFEST = '{"schemaVersion":1,"id":"midnight","version":"1.2.0"}';
const REWRITTEN_MANIFEST = '{"schemaVersion":1,"id":"midnight","version":"1.2.0","rewritten":true}';

function midnightPackageFiles() {
  return [
    { relPath: "design-system.json", bytes: encode(MIDNIGHT_MANIFEST) },
    { relPath: "components/Button.tsx", bytes: encode("export const Button = () => null;\n") },
  ];
}

const PAGES_JSON = encodePagesManifest({
  schemaVersion: PAGES_MANIFEST_SCHEMA_VERSION,
  pages: [],
  requestedActivePage: null,
});

/** A `pages.json`-only tree, optionally carrying the OUTGOING system's own tree-relative files — the current-tree half of `readCanonicalTreeIndex`'s read. */
function buildDesignReader(currentSystemFiles: readonly string[] | undefined): DesignTreeReader {
  const manifest = decodePagesManifest(PAGES_JSON);
  if (manifest instanceof Error) throw manifest;
  const files = new Map<string, DesignTreeFileSeedV1>([
    [PAGES_MANIFEST_RELPATH, { bytes: encode(PAGES_JSON) }],
  ]);
  for (const relPath of currentSystemFiles ?? [])
    files.set(relPath, { bytes: encode(`// ${relPath}\n`) });
  return createFakeDesignStore({ manifest, files });
}

interface FakePortsOptions {
  readonly trace?: string[];
  readonly quarantineFailure?: FailureDtoV1;
  readonly installFailure?: FailureDtoV1;
  readonly fetchFailure?: FailureDtoV1;
  readonly gateErrors?: readonly GateErrorV1[];
  readonly quarantineRewritesTo?: string;
  readonly currentSystemFiles?: readonly string[];
  /** Overrides `midnightPackageFiles()` — lets a test drive a package `composeDesignSystemCandidate` itself refuses (e.g. no manifest). */
  readonly packageFiles?: readonly { relPath: string; bytes: Uint8Array }[];
}

/**
 * Composes `core/ports/fakes`' own doubles into one `DesignSystemInstallPortsV1`, plus the
 * pipeline-level test surface (`trace`, `recordedInstalls`, `recordedProvenance`, `discarded`)
 * every test below reads. `trace` collapses consecutive same-stage pushes — `runTree` fires
 * TWICE per preparation (once inside `readCanonicalTreeIndex` for the CURRENT tree, once for the
 * CANDIDATE — install.ts's own header names this), and the two calls are adjacent with nothing
 * else traced between them, so the collapsed trace reads as one "Gate" milestone, matching what
 * "fetch -> quarantine -> Gate" actually asserts: STAGE ordering, not a call count.
 */
function createFakePorts(options: FakePortsOptions) {
  const trace = options.trace ?? [];
  function pushTrace(label: string): void {
    if (trace[trace.length - 1] !== label) trace.push(label);
  }

  const sourceFake = createFakeDesignSystemSource({
    id: "local",
    label: "Local library",
    canPublish: true,
  });
  sourceFake.seed(MIDNIGHT_SUMMARY, options.packageFiles ?? midnightPackageFiles());
  if (options.fetchFailure !== undefined) sourceFake.failNext("fetch", options.fetchFailure);
  const source: DesignSystemSource = {
    ...sourceFake,
    fetch: async (ref) => {
      pushTrace("fetch");
      return sourceFake.fetch(ref);
    },
  };

  const installFake = createFakeDesignSystemInstall();
  if (options.quarantineFailure !== undefined)
    installFake.failNext("admit", options.quarantineFailure);
  if (options.installFailure !== undefined) installFake.failNext("install", options.installFailure);

  const rewriteManifestTo = options.quarantineRewritesTo;
  const quarantine = {
    admit: async (input: {
      installId: string;
      files: readonly { relPath: string; bytes: Uint8Array }[];
    }) => {
      pushTrace("quarantine");
      const result = await installFake.admit(input);
      if ("code" in result) return result;
      if (rewriteManifestTo === undefined) return result;
      const rewritten = result.files.map((file) =>
        file.relPath === "design-system.json"
          ? { relPath: file.relPath, bytes: encode(rewriteManifestTo) }
          : file,
      );
      return { contentHash: result.contentHash, files: rewritten };
    },
    discard: (installId: string) => installFake.discard(installId),
  };

  const designReader = buildDesignReader(options.currentSystemFiles);

  // The SHARED fake, layered with `trace` exactly like `source` above — `queueRunTreeResult` is
  // an explicit FIFO queue (`core/ports/fakes/gate-runner.ts`), built precisely for scripting
  // successive calls with different results, so no hand-rolled `GateRunner` is needed. Queued in
  // call order: readCanonicalTreeIndex's own pass over the CURRENT tree first (always clean here
  // — these tests are about the INCOMING package, not the current tree), then the candidate pass,
  // which carries `options.gateErrors` (decision D6).
  const gateRunnerFake = createFakeGateRunner();
  gateRunnerFake.queueRunTreeResult({ errors: [], warnings: [], closures: [] });
  gateRunnerFake.queueRunTreeResult({
    errors: options.gateErrors ?? [],
    warnings: [],
    closures: [],
  });
  const gateRunner: GateRunner = {
    ...gateRunnerFake,
    runTree: async (input) => {
      pushTrace("runTree");
      return gateRunnerFake.runTree(input);
    },
  };

  let installCounter = 0;

  const ports: DesignSystemInstallPortsV1 = {
    source,
    designReader,
    gateRunner,
    quarantine,
    install: installFake,
    clock: { now: () => new Date("2026-08-12T00:00:00.000Z") },
    newInstallId: () => `install-${++installCounter}`,
  };

  return {
    ...ports,
    trace,
    recordedInstalls: installFake.recordedInstalls,
    recordedProvenance: installFake.recordedProvenance,
    discarded: installFake.discarded,
  };
}

describe("prepareDesignSystemInstall", () => {
  test("the pipeline runs in order: fetch → quarantine → Gate — and never writes before the Gate", async () => {
    await context.start(async () => {
      const trace: string[] = [];
      const ports = createFakePorts({ trace });
      const prepared = await wrap(prepareDesignSystemInstall(ports, MIDNIGHT_REF));
      expect(prepared).not.toHaveProperty("code");
      expect(trace).toEqual(["fetch", "quarantine", "runTree"]);
      expect(ports.recordedInstalls).toEqual([]);
    });
  });

  test("§8.3: fetch's bytes never reach the tree — the CANDIDATE's bytes do", async () => {
    await context.start(async () => {
      const ports = createFakePorts({ quarantineRewritesTo: REWRITTEN_MANIFEST });
      const prepared = expectPrepared(await wrap(prepareDesignSystemInstall(ports, MIDNIGHT_REF)));
      expect(prepared.candidate.files.get("system/design-system.json")).toBe(REWRITTEN_MANIFEST);
    });
  });

  test("§11: a package refused by the limits fails BEFORE the Gate is asked", async () => {
    await context.start(async () => {
      const trace: string[] = [];
      const ports = createFakePorts({
        trace,
        quarantineFailure: {
          code: "RESOURCE_LIMIT_EXCEEDED",
          retryable: false,
          safeMessage: "too large",
          details: {},
        },
      });
      const result = await wrap(prepareDesignSystemInstall(ports, MIDNIGHT_REF));
      expect(result).toHaveProperty("code", "RESOURCE_LIMIT_EXCEEDED");
      expect(trace).toEqual(["fetch", "quarantine"]);
    });
  });

  test("D6: a fatal inside system/ prepares with verdict `blocked`", async () => {
    await context.start(async () => {
      const ports = createFakePorts({
        gateErrors: [
          {
            kind: "manifest",
            code: "MISSING_CORE_ROLE",
            message: "x",
            file: "system/design-system.json",
          },
        ],
      });
      const prepared = expectPrepared(await wrap(prepareDesignSystemInstall(ports, MIDNIGHT_REF)));
      expect(prepared.preview.verdict).toBe("blocked");
    });
  });

  test("a package that fails CANDIDATE COMPOSITION (no manifest) is refused as DESIGN_SYSTEM_REJECTED, carrying the composition error's message, and quarantine is discarded", async () => {
    await context.start(async () => {
      const ports = createFakePorts({
        // No `design-system.json` at all — `composeDesignSystemCandidate` itself refuses this
        // (`DesignSystemCandidateError`: "the package has no manifest"), distinct from a Gate
        // fatal (D6): the package never reaches the Gate at all.
        packageFiles: [
          {
            relPath: "components/Button.tsx",
            bytes: encode("export const Button = () => null;\n"),
          },
        ],
      });
      const result = await wrap(prepareDesignSystemInstall(ports, MIDNIGHT_REF));
      expect(result).toHaveProperty("code", "DESIGN_SYSTEM_REJECTED");
      expect(result).toMatchObject({
        safeMessage: expect.stringContaining("the package has no manifest"),
      });
      // Exactly one `newInstallId()` call happened (the only preparation in this test), so its
      // one quarantine directory is the one discarded.
      expect(ports.discarded).toEqual(["install-1"]);
    });
  });
});

describe("commitDesignSystemInstall", () => {
  test("D6: committing a `blocked` preparation is refused with DESIGN_SYSTEM_REJECTED", async () => {
    await context.start(async () => {
      const ports = createFakePorts({
        gateErrors: [
          {
            kind: "manifest",
            code: "MISSING_CORE_ROLE",
            message: "x",
            file: "system/design-system.json",
          },
        ],
      });
      const prepared = expectPrepared(await wrap(prepareDesignSystemInstall(ports, MIDNIGHT_REF)));
      expect(await wrap(commitDesignSystemInstall(ports, prepared))).toHaveProperty(
        "code",
        "DESIGN_SYSTEM_REJECTED",
      );
      expect(ports.recordedInstalls).toEqual([]);
    });
  });

  test("D6: committing a `breaks-pages` preparation SUCCEEDS — surfaced, not prevented", async () => {
    await context.start(async () => {
      const ports = createFakePorts({
        gateErrors: [{ kind: "type", code: "TYPE_ERROR", message: "x", file: "pages/a.tsx" }],
      });
      const prepared = expectPrepared(await wrap(prepareDesignSystemInstall(ports, MIDNIGHT_REF)));
      expect(prepared.preview.verdict).toBe("breaks-pages");
      expect(await wrap(commitDesignSystemInstall(ports, prepared))).not.toHaveProperty("code");
      expect(ports.recordedInstalls).toHaveLength(1);
    });
  });

  test("§8.5: the commit writes the provenance record with the ref AND the content hash", async () => {
    await context.start(async () => {
      const ports = createFakePorts({});
      const prepared = expectPrepared(await wrap(prepareDesignSystemInstall(ports, MIDNIGHT_REF)));
      await wrap(commitDesignSystemInstall(ports, prepared));
      expect(ports.recordedProvenance[0]).toMatchObject({
        ref: MIDNIGHT_REF,
        contentHash: prepared.contentHash,
      });
    });
  });

  test("the commit removes every file the outgoing system had and the incoming one lacks", async () => {
    await context.start(async () => {
      const ports = createFakePorts({
        currentSystemFiles: ["system/design-system.json", "system/components/Legacy.tsx"],
      });
      const prepared = expectPrepared(await wrap(prepareDesignSystemInstall(ports, MIDNIGHT_REF)));
      await wrap(commitDesignSystemInstall(ports, prepared));
      expect(ports.recordedInstalls[0]?.removedTreeRelPaths).toEqual([
        "system/components/Legacy.tsx",
      ]);
    });
  });

  test("quarantine is discarded after a commit AND after an abandonment", async () => {
    await context.start(async () => {
      const ports = createFakePorts({});
      const first = expectPrepared(await wrap(prepareDesignSystemInstall(ports, MIDNIGHT_REF)));
      await wrap(commitDesignSystemInstall(ports, first));
      expect(ports.discarded).toEqual([first.installId]);

      const second = expectPrepared(await wrap(prepareDesignSystemInstall(ports, MIDNIGHT_REF)));
      discardPreparedInstall(ports, second.installId);
      expect(ports.discarded).toEqual([first.installId, second.installId]);
    });
  });

  test("quarantine is discarded when the commit itself fails", async () => {
    await context.start(async () => {
      const ports = createFakePorts({
        installFailure: {
          code: "PERSISTENCE_FAILED",
          retryable: true,
          safeMessage: "disk full",
          details: {},
        },
      });
      const prepared = expectPrepared(await wrap(prepareDesignSystemInstall(ports, MIDNIGHT_REF)));
      expect(await wrap(commitDesignSystemInstall(ports, prepared))).toHaveProperty(
        "code",
        "PERSISTENCE_FAILED",
      );
      expect(ports.discarded).toEqual([prepared.installId]);
    });
  });

  test("a fetch failure surfaces as-is and leaves no quarantine behind", async () => {
    await context.start(async () => {
      const ports = createFakePorts({
        fetchFailure: {
          code: "PERSISTENCE_FAILED",
          retryable: false,
          safeMessage: "package declares aurora@2.0.0",
          details: {},
        },
      });
      const result = await wrap(prepareDesignSystemInstall(ports, MIDNIGHT_REF));
      expect(result).toMatchObject({ safeMessage: "package declares aurora@2.0.0" });
      expect(ports.discarded).toEqual([]);
    });
  });
});
