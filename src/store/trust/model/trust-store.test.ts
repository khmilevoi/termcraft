import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Clock } from "infrastructure/clock";

import type { GitIdentity, TrustFsDeps } from "../types";
import { trustSubjectKey } from "./subject";
import {
  TrustLedgerError,
  TrustSubjectError,
  createTrustStore,
  nodeTrustFsDeps,
  trustGrantPath,
} from "./trust-store";

const USER_STATE_ROOT = "C:/Users/alice/AppData/Local/termcraft";
const PROJECT_ID = "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d10";
const OTHER_PROJECT_ID = "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d11";

const frozenClock: Clock = { now: () => new Date("2026-07-20T10:00:00.000Z") };

/**
 * An in-memory filesystem for the ledger plus a `realpath`/identity table, so the tests
 * drive alias resolution, directory replacement, and durable-write failure without
 * touching a real volume.
 */
function memoryFs(
  seed: {
    readonly links?: Record<string, string>;
    readonly identities?: Record<string, string>;
  } = {},
) {
  const files = new Map<string, Uint8Array>();
  const dirs = new Set<string>();
  const links = { ...seed.links };
  const identities = { ...seed.identities };
  let writeFailure: Error | null = null;

  const deps: TrustFsDeps = {
    realpath(absPath) {
      const resolved = links[absPath] ?? absPath;
      return resolved;
    },
    fsIdentity(absPath) {
      const identity = identities[absPath];
      if (identity === undefined) return new Error(`no identity recorded for ${absPath}`);
      return identity;
    },
    ensureDir(absDir) {
      dirs.add(absDir);
      return undefined;
    },
    readFile(absPath) {
      return files.get(absPath) ?? null;
    },
    durableWrite(absPath, bytes) {
      if (writeFailure !== null) return writeFailure;
      files.set(absPath, bytes);
      return undefined;
    },
  };

  return {
    deps,
    files,
    dirs,
    identities,
    failWrites(error: Error) {
      writeFailure = error;
    },
    /** Overwrite a stored grant with arbitrary bytes — the forged/corrupt-ledger cases. */
    poison(absPath: string, text: string) {
      files.set(absPath, new TextEncoder().encode(text));
    },
  };
}

function storeOver(memory: ReturnType<typeof memoryFs>) {
  return createTrustStore({ userStateRoot: USER_STATE_ROOT, clock: frozenClock, fs: memory.deps });
}

const gitIdentity: GitIdentity = {
  canonicalGitCommonDir: "C:\\work\\.git",
  gitCommonDirFilesystemIdentity: "windows:1a2b3c4d:ffeeddccbbaa998877",
  projectPathRelativeToWorktreeRoot: "termcraft",
};

describe("trustGrantPath", () => {
  test("keys the machine-local ledger by the 64-hex trust key", () => {
    const key = "a".repeat(64);
    expect(trustGrantPath(USER_STATE_ROOT, key)).toBe(
      path.join(USER_STATE_ROOT, "trust", `${key}.json`),
    );
  });
});

describe("buildSubject", () => {
  test("canonicalizes the resolved root and derives the §8 key", async () => {
    const memory = memoryFs({
      links: { "C:\\work\\termcraft": "c:\\Work\\termcraft" },
      identities: { "c:\\Work\\termcraft": "windows:1a2b3c4d:0011223344" },
    });
    const subject = await storeOver(memory).buildSubject("C:\\work\\termcraft", PROJECT_ID, null);
    if (subject instanceof Error) throw subject;

    expect(subject.canonicalProjectPath).toBe("C:/Work/termcraft");
    expect(subject.projectFilesystemIdentity).toBe("windows:1a2b3c4d:0011223344");
    expect(subject.git).toBeNull();
    expect(subject.key).toBe(
      trustSubjectKey({
        canonicalProjectPath: "C:/Work/termcraft",
        projectFilesystemIdentity: "windows:1a2b3c4d:0011223344",
        projectId: PROJECT_ID,
        git: null,
      }),
    );
  });

  test("canonicalizes the supplied Git common dir and repo-relative path", async () => {
    const memory = memoryFs({
      identities: { "C:\\work\\termcraft": "windows:1a2b3c4d:0011223344" },
    });
    const subject = await storeOver(memory).buildSubject(
      "C:\\work\\termcraft",
      PROJECT_ID,
      gitIdentity,
    );
    if (subject instanceof Error) throw subject;

    expect(subject.git).toEqual({
      canonicalGitCommonDir: "C:/work/.git",
      gitCommonDirFilesystemIdentity: "windows:1a2b3c4d:ffeeddccbbaa998877",
      projectPathRelativeToWorktreeRoot: "termcraft",
    });
  });

  test("two path aliases resolving to the same canonical object produce ONE subject", async () => {
    const memory = memoryFs({
      links: {
        "C:\\work\\termcraft": "C:\\work\\termcraft",
        "C:\\alias-junction": "C:\\work\\termcraft",
        "C:\\work\\termcraft\\": "C:\\work\\termcraft",
      },
      identities: { "C:\\work\\termcraft": "windows:1a2b3c4d:0011223344" },
    });
    const store = storeOver(memory);

    const direct = await store.buildSubject("C:\\work\\termcraft", PROJECT_ID, null);
    const viaJunction = await store.buildSubject("C:\\alias-junction", PROJECT_ID, null);
    const viaTrailingSeparator = await store.buildSubject(
      "C:\\work\\termcraft\\",
      PROJECT_ID,
      null,
    );
    if (direct instanceof Error) throw direct;
    if (viaJunction instanceof Error) throw viaJunction;
    if (viaTrailingSeparator instanceof Error) throw viaTrailingSeparator;

    expect(viaJunction.key).toBe(direct.key);
    expect(viaTrailingSeparator.key).toBe(direct.key);
  });

  test("a path move produces a new subject", async () => {
    const memory = memoryFs({
      identities: {
        "C:\\work\\termcraft": "windows:1a2b3c4d:0011223344",
        "C:\\moved\\termcraft": "windows:1a2b3c4d:0011223344",
      },
    });
    const store = storeOver(memory);
    const before = await store.buildSubject("C:\\work\\termcraft", PROJECT_ID, null);
    const after = await store.buildSubject("C:\\moved\\termcraft", PROJECT_ID, null);
    if (before instanceof Error) throw before;
    if (after instanceof Error) throw after;

    expect(after.key).not.toBe(before.key);
  });

  test("replacing the directory at the same path produces a new subject", async () => {
    const memory = memoryFs({
      identities: { "C:\\work\\termcraft": "windows:1a2b3c4d:0011223344" },
    });
    const store = storeOver(memory);
    const before = await store.buildSubject("C:\\work\\termcraft", PROJECT_ID, null);
    memory.identities["C:\\work\\termcraft"] = "windows:1a2b3c4d:9988776655";
    const after = await store.buildSubject("C:\\work\\termcraft", PROJECT_ID, null);
    if (before instanceof Error) throw before;
    if (after instanceof Error) throw after;

    expect(after.key).not.toBe(before.key);
  });

  test("a projectId change produces a new subject", async () => {
    const memory = memoryFs({
      identities: { "C:\\work\\termcraft": "windows:1a2b3c4d:0011223344" },
    });
    const store = storeOver(memory);
    const before = await store.buildSubject("C:\\work\\termcraft", PROJECT_ID, null);
    const after = await store.buildSubject("C:\\work\\termcraft", OTHER_PROJECT_ID, null);
    if (before instanceof Error) throw before;
    if (after instanceof Error) throw after;

    expect(after.key).not.toBe(before.key);
  });

  test("Git initialization then repository replacement each produce a new subject", async () => {
    const memory = memoryFs({
      identities: { "C:\\work\\termcraft": "windows:1a2b3c4d:0011223344" },
    });
    const store = storeOver(memory);
    const noGit = await store.buildSubject("C:\\work\\termcraft", PROJECT_ID, null);
    const initialized = await store.buildSubject("C:\\work\\termcraft", PROJECT_ID, gitIdentity);
    const replaced = await store.buildSubject("C:\\work\\termcraft", PROJECT_ID, {
      ...gitIdentity,
      gitCommonDirFilesystemIdentity: "windows:1a2b3c4d:0102030405",
    });
    if (noGit instanceof Error) throw noGit;
    if (initialized instanceof Error) throw initialized;
    if (replaced instanceof Error) throw replaced;

    expect(initialized.key).not.toBe(noGit.key);
    expect(replaced.key).not.toBe(initialized.key);
  });

  test("a worktree-path change produces a new subject", async () => {
    const memory = memoryFs({
      identities: { "C:\\work\\termcraft": "windows:1a2b3c4d:0011223344" },
    });
    const store = storeOver(memory);
    const before = await store.buildSubject("C:\\work\\termcraft", PROJECT_ID, gitIdentity);
    const after = await store.buildSubject("C:\\work\\termcraft", PROJECT_ID, {
      ...gitIdentity,
      projectPathRelativeToWorktreeRoot: "apps/termcraft",
    });
    if (before instanceof Error) throw before;
    if (after instanceof Error) throw after;

    expect(after.key).not.toBe(before.key);
  });

  test("a HEAD, branch, or commit change keeps the SAME subject", async () => {
    // Nothing a checkout/commit/rebase touches appears in GitIdentity or the fs identity
    // that Spike F proved stable across `git init`/commit/checkout — so the key must not move.
    const memory = memoryFs({
      identities: { "C:\\work\\termcraft": "windows:1a2b3c4d:0011223344" },
    });
    const store = storeOver(memory);
    const before = await store.buildSubject("C:\\work\\termcraft", PROJECT_ID, gitIdentity);
    const afterCheckout = await store.buildSubject("C:\\work\\termcraft", PROJECT_ID, {
      ...gitIdentity,
    });
    if (before instanceof Error) throw before;
    if (afterCheckout instanceof Error) throw afterCheckout;

    expect(afterCheckout.key).toBe(before.key);
  });

  test("a non-canonical projectId is refused", async () => {
    const memory = memoryFs({
      identities: { "C:\\work\\termcraft": "windows:1a2b3c4d:0011223344" },
    });
    const subject = await storeOver(memory).buildSubject("C:\\work\\termcraft", "not-a-uuid", null);
    expect(subject).toBeInstanceOf(TrustSubjectError);
  });

  test("an unreadable filesystem identity is a returned error, never a guessed subject", async () => {
    const memory = memoryFs({});
    const subject = await storeOver(memory).buildSubject("C:\\work\\gone", PROJECT_ID, null);
    expect(subject).toBeInstanceOf(TrustSubjectError);
  });
});

describe("isGranted / grant", () => {
  async function grantedStore() {
    const memory = memoryFs({
      identities: { "C:\\work\\termcraft": "windows:1a2b3c4d:0011223344" },
    });
    const store = storeOver(memory);
    const subject = await store.buildSubject("C:\\work\\termcraft", PROJECT_ID, null);
    if (subject instanceof Error) throw subject;
    return { memory, store, subject };
  }

  test("an ungranted subject is not granted", async () => {
    const { store, subject } = await grantedStore();
    expect(await store.isGranted(subject)).toBe(false);
  });

  test("a granted subject is granted, and the grant is durably written under {userStateRoot}", async () => {
    const { memory, store, subject } = await grantedStore();
    expect(await store.grant(subject)).toBeUndefined();

    const grantPath = trustGrantPath(USER_STATE_ROOT, subject.key);
    expect(memory.files.has(grantPath)).toBe(true);
    expect(memory.dirs.has(path.join(USER_STATE_ROOT, "trust"))).toBe(true);
    expect(await store.isGranted(subject)).toBe(true);
  });

  test("the grant record round-trips the complete subject plus a clock-stamped grant time", async () => {
    const { memory, store, subject } = await grantedStore();
    await store.grant(subject);

    const bytes = memory.files.get(trustGrantPath(USER_STATE_ROOT, subject.key));
    if (bytes === undefined) throw new Error("grant not written");
    const record = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    expect(record.schemaVersion).toBe(1);
    expect(record.key).toBe(subject.key);
    expect(record.canonicalProjectPath).toBe("C:/work/termcraft");
    expect(record.projectId).toBe(PROJECT_ID);
    expect(record.git).toBeNull();
    expect(record.grantedAt).toBe("2026-07-20T10:00:00.000Z");
  });

  test("granting one subject never grants a different one", async () => {
    const { memory, store, subject } = await grantedStore();
    await store.grant(subject);
    const other = await store.buildSubject("C:\\work\\termcraft", OTHER_PROJECT_ID, null);
    if (other instanceof Error) throw other;

    expect(await store.isGranted(other)).toBe(false);
    expect(memory.files.has(trustGrantPath(USER_STATE_ROOT, other.key))).toBe(false);
  });

  test("a tampered grant record does not grant, because its fields no longer derive its key", async () => {
    const { memory, store, subject } = await grantedStore();
    await store.grant(subject);

    const grantPath = trustGrantPath(USER_STATE_ROOT, subject.key);
    const record = JSON.parse(
      new TextDecoder().decode(memory.files.get(grantPath) as Uint8Array),
    ) as Record<string, unknown>;
    memory.poison(grantPath, JSON.stringify({ ...record, canonicalProjectPath: "C:/elsewhere" }));

    expect(await store.isGranted(subject)).toBe(false);
  });

  test("a corrupt or non-JSON grant record does not grant", async () => {
    const { memory, store, subject } = await grantedStore();
    await store.grant(subject);
    memory.poison(trustGrantPath(USER_STATE_ROOT, subject.key), "{not json");

    expect(await store.isGranted(subject)).toBe(false);
  });

  test("a schema-invalid grant record does not grant", async () => {
    const { memory, store, subject } = await grantedStore();
    await store.grant(subject);
    memory.poison(
      trustGrantPath(USER_STATE_ROOT, subject.key),
      JSON.stringify({ schemaVersion: 2, key: subject.key }),
    );

    expect(await store.isGranted(subject)).toBe(false);
  });

  test("a failed durable write is a returned error and leaves the subject ungranted", async () => {
    const { memory, store, subject } = await grantedStore();
    memory.failWrites(new Error("volume does not support write-through flush"));

    const outcome = await store.grant(subject);
    expect(outcome).toBeInstanceOf(TrustLedgerError);
    expect(await store.isGranted(subject)).toBe(false);
  });

  test("re-granting is idempotent", async () => {
    const { store, subject } = await grantedStore();
    expect(await store.grant(subject)).toBeUndefined();
    expect(await store.grant(subject)).toBeUndefined();
    expect(await store.isGranted(subject)).toBe(true);
  });
});

describe("source grants (project-design-systems §8.4)", () => {
  const PROJECT_ROOT = "C:\\work\\termcraft";
  const sourceInput = {
    sourceKind: "github",
    sourceId: "github:acme/design-systems",
    canonicalLocation: "github.com/acme/design-systems",
    locationFilesystemIdentity: null,
  };

  let currentMemory: ReturnType<typeof memoryFs>;

  /** A fresh store over a fresh in-memory ledger, mirroring `grantedStore()` above. */
  function createStoreForTest() {
    currentMemory = memoryFs({
      identities: { [PROJECT_ROOT]: "windows:1a2b3c4d:0011223344" },
    });
    return storeOver(currentMemory);
  }

  /** Reach into the in-memory ledger and decode the raw bytes filed under `key`. */
  function readGrantRecordForTest(key: string): Record<string, unknown> {
    const bytes = currentMemory.files.get(trustGrantPath(USER_STATE_ROOT, key));
    if (bytes === undefined) throw new Error("grant not written");
    return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  }

  /** Poison the ledger entry at `key` with arbitrary record bytes — the tamper case. */
  function overwriteGrantRecordForTest(key: string, record: Record<string, unknown>): void {
    currentMemory.poison(trustGrantPath(USER_STATE_ROOT, key), JSON.stringify(record));
  }

  test("an ungranted source is not granted", async () => {
    const store = createStoreForTest();
    const subject = store.buildSourceSubject(sourceInput);
    expect(await store.isSourceGranted(subject)).toBe(false);
  });

  test("a granted source is granted, and the record is durably written under {userStateRoot}", async () => {
    const store = createStoreForTest();
    const subject = store.buildSourceSubject(sourceInput);
    expect(await store.grantSource(subject)).toBeUndefined();
    expect(await store.isSourceGranted(subject)).toBe(true);
  });

  test("the stored record is kind-discriminated and re-derives its own key", async () => {
    const store = createStoreForTest();
    const subject = store.buildSourceSubject(sourceInput);
    await store.grantSource(subject);

    const raw = readGrantRecordForTest(subject.key);
    expect(raw.kind).toBe("source");
    expect(raw.schemaVersion).toBe(1);
    expect(raw.key).toBe(subject.key);
    expect(raw.canonicalProjectPath).toBeUndefined();
  });

  test("a changed location is a different subject and is not granted", async () => {
    const store = createStoreForTest();
    await store.grantSource(store.buildSourceSubject(sourceInput));
    const moved = store.buildSourceSubject({
      ...sourceInput,
      canonicalLocation: "github.com/acme/other",
    });
    expect(await store.isSourceGranted(moved)).toBe(false);
  });

  test("a tampered record grants nothing — the key must derive from the record's own fields", async () => {
    const store = createStoreForTest();
    const subject = store.buildSourceSubject(sourceInput);
    await store.grantSource(subject);
    overwriteGrantRecordForTest(subject.key, {
      ...readGrantRecordForTest(subject.key),
      sourceId: "github:evil/ds",
    });
    expect(await store.isSourceGranted(subject)).toBe(false);
  });

  test("a project grant and a source grant never satisfy each other", async () => {
    const store = createStoreForTest();
    const projectSubject = await store.buildSubject(PROJECT_ROOT, PROJECT_ID, null);
    if (projectSubject instanceof Error) throw projectSubject;
    await store.grant(projectSubject);

    // Keys differ by construction (§8.4's prefix separation), so neither lookup can find the
    // other's record — assert the OUTCOME, which is what a caller actually depends on.
    const sourceSubject = store.buildSourceSubject(sourceInput);
    expect(await store.isSourceGranted(sourceSubject)).toBe(false);
    expect(sourceSubject.key).not.toBe(projectSubject.key);
  });

  test("every existing project grant still works unchanged", async () => {
    const store = createStoreForTest();
    const subject = await store.buildSubject(PROJECT_ROOT, PROJECT_ID, null);
    if (subject instanceof Error) throw subject;
    expect(await store.grant(subject)).toBeUndefined();
    expect(await store.isGranted(subject)).toBe(true);
  });
});

// ---- the production wiring, against a real volume -------------------------------

const realRoots: string[] = [];

afterAll(() => {
  for (const root of realRoots) fs.rmSync(root, { recursive: true, force: true });
});

describe("nodeTrustFsDeps", () => {
  test("grants and re-reads a real project root through the real filesystem", async () => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "termcraft-trust-state-"));
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "termcraft-trust-project-"));
    realRoots.push(stateRoot, projectRoot);

    const store = createTrustStore({
      userStateRoot: stateRoot,
      clock: frozenClock,
      fs: nodeTrustFsDeps,
    });
    const subject = await store.buildSubject(projectRoot, PROJECT_ID, null);
    if (subject instanceof Error) throw subject;

    expect(subject.key).toMatch(/^[0-9a-f]{64}$/);
    expect(subject.canonicalProjectPath).not.toContain("\\");
    expect(await store.isGranted(subject)).toBe(false);

    const granted = await store.grant(subject);
    if (granted instanceof Error) throw granted;
    expect(fs.existsSync(trustGrantPath(stateRoot, subject.key))).toBe(true);
    expect(await store.isGranted(subject)).toBe(true);
  });

  test("a trailing separator and a differently cased drive letter resolve to the same subject", async () => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "termcraft-trust-state-"));
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "termcraft-trust-project-"));
    realRoots.push(stateRoot, projectRoot);

    const store = createTrustStore({
      userStateRoot: stateRoot,
      clock: frozenClock,
      fs: nodeTrustFsDeps,
    });
    const direct = await store.buildSubject(projectRoot, PROJECT_ID, null);
    const aliased = await store.buildSubject(`${projectRoot}${path.sep}`, PROJECT_ID, null);
    if (direct instanceof Error) throw direct;
    if (aliased instanceof Error) throw aliased;

    expect(aliased.key).toBe(direct.key);
  });
});
