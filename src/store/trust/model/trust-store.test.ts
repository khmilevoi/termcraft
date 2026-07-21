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
