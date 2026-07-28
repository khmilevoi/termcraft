import { describe, expect, test } from "bun:test";

import type { ManagedNamespace, ManagedRootKind } from "../types";
import {
  JSONL_MAX_PHYSICAL_LINE_BYTES,
  JSONL_MAX_SERIALIZED_OBJECT_BYTES,
  KiB,
  MiB,
  NAMESPACE_LIMITS,
  ROOT_LIMITS,
  StorageLimitExceededError,
  UnknownNamespaceError,
  classifyNamespace,
  createLimitBudget,
} from "./limits";
import { PathRuleError, validateRelativePath } from "./path-rules";

const CHAT_ID = "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d10";

function expectNamespace(
  rootKind: ManagedRootKind,
  relPath: string,
  expected: ManagedNamespace,
): void {
  const result = classifyNamespace(rootKind, relPath);
  if (result instanceof Error)
    throw new Error(`expected ${relPath} to classify as ${expected}: ${result.message}`);
  expect(result).toBe(expected);
}

function expectUnknown(rootKind: ManagedRootKind, relPath: string): void {
  expect(classifyNamespace(rootKind, relPath)).toBeInstanceOf(UnknownNamespaceError);
}

describe("classifyNamespace — turn-durability §5.3/§5.4 namespace grammar", () => {
  test("classifies the project root's design tree and pin logs", () => {
    expectNamespace("project", "design/pages.json", "design-source");
    expectNamespace("project", "design/pages/dashboard.tsx", "design-source");
    expectNamespace("project", "design/lib/nested/deep/theme.ts", "design-source");
    expectNamespace("project", "pins/home.jsonl", "comments-jsonl");
    expectNamespace("project", "project.toml", "project-config");
  });

  test("the retired page layout is no longer a managed namespace", () => {
    expectUnknown("project", "pages/home/page.tsx");
    expectUnknown("project", "pages/home/comments.jsonl");
    expectUnknown("project", "pins/Home.jsonl"); // invalid slug
    expectUnknown("project", "pins/home.txt");
    expectUnknown("project", "pins/nested/home.jsonl");
  });

  test("classifies the workspace root's design tree the same way", () => {
    expectNamespace("workspace", "design/pages.json", "design-source");
    expectNamespace("workspace", "design/widgets/gauge.tsx", "design-source");
    expectNamespace("workspace", "RUNTIME.md", "agent-runtime-doc");
    // The other half of the pair `agent/prompt/model/runtime-docs.ts` stages: a doc written
    // under a name this grammar rejects would be unreadable through `SafeProjectFs`.
    expectNamespace("workspace", "REATOM.md", "agent-runtime-doc");
    expectNamespace("workspace", "runtime.generated.d.ts", "agent-runtime-doc");
    // A NESTED `.d.ts` (`classifyWorkspace`'s "last component" branch), distinct from the
    // single-segment case above.
    expectNamespace("workspace", "types/runtime.d.ts", "agent-runtime-doc");
    expectUnknown("workspace", "pages/home.tsx");
    expectUnknown("workspace", "pages.json");
  });

  // A retired namespace name is not merely unreachable — `ManagedNamespace` no longer
  // spells `canonical-page`/`agent-page-source`/`agent-manifest` at all (compile-time
  // enforced: nothing in this module can produce those strings any more). This pins the
  // runtime half — every path those namespaces used to own now falls through to
  // `UnknownNamespaceError` — is exercised above (`pages/home/page.tsx` was `canonical-page`,
  // `pages/home.tsx` and `pages.json` under a workspace were `agent-page-source`/
  // `agent-manifest`) rather than repeated here.

  // `classifyNamespace` documents its own precondition as "a validated managed relative
  // path" — it only `.split("/")`s a raw string, so it does not itself reject a `..`
  // component, and callers do not agree on when they validate relative to when they
  // classify: `store/safe-fs/model/candidate.ts`'s `enumerateDirectory` calls
  // `validateRelativePath` before `classifyNamespace`, but `SafeProjectFs.readFile`
  // classifies FIRST and resolves (which is where validation actually lives) only after
  // (`no-follow.ts:305` then `:308`). So `design/../secrets` really is classified as
  // `design-source` by the now-broad `design/**` branch, which accepts any components after
  // its prefix and has no `..` awareness of its own. What holds unconditionally for every
  // caller is narrower and lives one layer down: no filesystem access happens until
  // `resolveManagedPath` has approved the path, and `validateRelativePath` is its very FIRST
  // statement (`no-follow.ts:233`), before any `lstat`. This pins both halves honestly —
  // the widened classification is real, and it is inert — rather than asserting the
  // comfortable fiction that classification itself refuses the escape.
  test("a `design/`-rooted escape attempt classifies as design-source (the widened branch has no `..` awareness), but is refused before any filesystem access", () => {
    expectNamespace("project", "design/../secrets", "design-source");

    const validated = validateRelativePath("design/../secrets");
    expect(validated).toBeInstanceOf(PathRuleError);
    expect((validated as PathRuleError).code).toBe("DOT_COMPONENT");
  });

  test("a markdown file outside the staged doc set is still rejected", () => {
    expectUnknown("workspace", "NOTES.md");
    expectUnknown("workspace", "readme.md");
  });

  test("a candidate shares the workspace grammar", () => {
    expectNamespace("candidate", "design/pages/home.tsx", "design-source");
    expectNamespace("candidate", "design/pages.json", "design-source");
  });

  test("classifies the `.termcraft` project's remaining namespaces unchanged", () => {
    expectNamespace("project", "workspace.local.toml", "project-config");
    expectNamespace("project", ".gitignore", "project-config");
    expectNamespace("project", `chats/${CHAT_ID}.jsonl`, "chat-jsonl");
    expectNamespace("project", "cache/page-meta/home/1/abc.json", "project-config");
    expectNamespace("project", `transactions.local/${CHAT_ID}/plan.json`, "transaction-payload");
    expectNamespace("project", `export/generations/${CHAT_ID}/pages/home.json`, "export-artifact");
  });

  test("the workspace grammar does not leak into the project root and vice versa", () => {
    expectUnknown("project", "pages/home.tsx"); // the retired agent shape, not the design tree
    expectUnknown("workspace", "project.toml");
    expectUnknown("workspace", `chats/${CHAT_ID}.jsonl`);
  });

  test("export candidates and migration backups accept their own whole trees", () => {
    expectNamespace("export-candidate", "pages/home/snapshot.json", "export-artifact");
    expectNamespace("backup", "pages/home/page.tsx", "migration-backup");
  });
});

describe("§5.3 limit table constants", () => {
  test("carries the spec's per-file limits verbatim", () => {
    expect(NAMESPACE_LIMITS["design-source"].perFileBytes).toBe(2 * MiB);
    expect(NAMESPACE_LIMITS["agent-runtime-doc"].perFileBytes).toBe(4 * MiB);
    expect(NAMESPACE_LIMITS["project-config"].perFileBytes).toBe(1 * MiB);
    expect(NAMESPACE_LIMITS["chat-jsonl"].perFileBytes).toBe(64 * MiB);
    expect(NAMESPACE_LIMITS["comments-jsonl"].perFileBytes).toBe(32 * MiB);
    expect(NAMESPACE_LIMITS["export-artifact"].perFileBytes).toBe(16 * MiB);
    expect(NAMESPACE_LIMITS["transaction-payload"].perFileBytes).toBe(64 * MiB);
    expect(NAMESPACE_LIMITS["migration-backup"].perFileBytes).toBe(64 * MiB);
  });

  test("carries the spec's count and aggregate limits verbatim", () => {
    expect(NAMESPACE_LIMITS["design-source"].maxFiles).toBe(512);
    expect(NAMESPACE_LIMITS["design-source"].aggregateBytes).toBe(64 * MiB);
    expect(NAMESPACE_LIMITS["design-source"].maxDepth).toBe(8);
    expect(NAMESPACE_LIMITS["agent-runtime-doc"].maxFiles).toBe(32);
    expect(NAMESPACE_LIMITS["agent-runtime-doc"].aggregateBytes).toBe(16 * MiB);
    expect(NAMESPACE_LIMITS["project-config"].aggregateBytes).toBe(16 * MiB);
    expect(NAMESPACE_LIMITS["export-artifact"].maxFiles).toBe(20_000);
    expect(NAMESPACE_LIMITS["export-artifact"].aggregateBytes).toBe(1024 * MiB);
    expect(NAMESPACE_LIMITS["transaction-payload"].aggregateBytes).toBe(2048 * MiB);
    expect(NAMESPACE_LIMITS["migration-backup"].aggregateBytes).toBe(2048 * MiB);
  });

  test("no other namespace carries a `maxDepth` — `design-source` is the one exception", () => {
    for (const [namespace, limit] of Object.entries(NAMESPACE_LIMITS)) {
      if (namespace === "design-source") continue;
      expect(limit.maxDepth).toBeUndefined();
    }
  });

  test("the whole turn workspace/candidate is 512 files, 64 MiB, depth 8", () => {
    expect(ROOT_LIMITS.workspace).toEqual({ maxFiles: 512, totalBytes: 64 * MiB, maxDepth: 8 });
    expect(ROOT_LIMITS.candidate).toEqual({ maxFiles: 512, totalBytes: 64 * MiB, maxDepth: 8 });
  });

  test("carries the §5.3 JSONL physical-line bounds", () => {
    expect(JSONL_MAX_PHYSICAL_LINE_BYTES).toBe(1_048_576);
    expect(JSONL_MAX_SERIALIZED_OBJECT_BYTES).toBe(1_048_575);
  });
});

describe("createLimitBudget — checked before allocation (§5.3)", () => {
  test("admits a design-source file at exactly the per-file limit and rejects one byte over", () => {
    const at = createLimitBudget("workspace");
    expect(
      at.admitFile({
        relPath: "design/pages/home.tsx",
        namespace: "design-source",
        declaredSize: 2 * MiB,
        depth: 3,
      }),
    ).toBeNull();

    const over = createLimitBudget("workspace");
    const rejected = over.admitFile({
      relPath: "design/pages/home.tsx",
      namespace: "design-source",
      declaredSize: 2 * MiB + 1,
      depth: 3,
    });
    expect(rejected).toBeInstanceOf(StorageLimitExceededError);
    expect((rejected as StorageLimitExceededError).measured).toBe(2 * MiB + 1);
    expect((rejected as StorageLimitExceededError).allowed).toBe(2 * MiB);
  });

  test("admits 512 design-source files and rejects the 513th", () => {
    const budget = createLimitBudget("workspace");
    for (let i = 0; i < 512; i += 1) {
      expect(
        budget.admitFile({
          relPath: `design/pages/p${i}.tsx`,
          namespace: "design-source",
          declaredSize: 1,
          depth: 3,
        }),
      ).toBeNull();
    }
    expect(
      budget.admitFile({
        relPath: "design/pages/p512.tsx",
        namespace: "design-source",
        declaredSize: 1,
        depth: 3,
      }),
    ).toBeInstanceOf(StorageLimitExceededError);
  });

  test("admits a workspace at exactly 64 MiB total and rejects one byte over", () => {
    const at = createLimitBudget("workspace");
    for (let i = 0; i < 32; i += 1) {
      expect(
        at.admitFile({
          relPath: `design/pages/p${i}.tsx`,
          namespace: "design-source",
          declaredSize: 2 * MiB,
          depth: 3,
        }),
      ).toBeNull();
    }

    const over = createLimitBudget("workspace");
    for (let i = 0; i < 32; i += 1) {
      over.admitFile({
        relPath: `design/pages/p${i}.tsx`,
        namespace: "design-source",
        declaredSize: 2 * MiB,
        depth: 3,
      });
    }
    expect(
      over.admitFile({
        relPath: "design/pages.json",
        namespace: "design-source",
        declaredSize: 1,
        depth: 2,
      }),
    ).toBeInstanceOf(StorageLimitExceededError);
  });

  test("admits 512 workspace files and rejects the 513th", () => {
    // A unit-level probe of the ROOT count rule alone: `design-source`'s own count cap
    // (512) now equals the workspace root's, so this deliberately uses a namespace with NO
    // count cap (`chat-jsonl`) to isolate the root-level check from any namespace-level one.
    // `classifyNamespace` — not the budget — is what keeps a `chat-jsonl` leaf out of a
    // workspace in production.
    const budget = createLimitBudget("workspace");
    for (let i = 0; i < 512; i += 1) {
      expect(
        budget.admitFile({ relPath: `f${i}`, namespace: "chat-jsonl", declaredSize: 1, depth: 1 }),
      ).toBeNull();
    }
    expect(
      budget.admitFile({ relPath: "f512", namespace: "chat-jsonl", declaredSize: 1, depth: 1 }),
    ).toBeInstanceOf(StorageLimitExceededError);
  });

  test("admits depth 8 and rejects depth 9 in a turn workspace (ROOT depth ceiling)", () => {
    const budget = createLimitBudget("workspace");
    expect(
      budget.admitFile({ relPath: "a", namespace: "agent-runtime-doc", declaredSize: 1, depth: 8 }),
    ).toBeNull();
    expect(
      budget.admitFile({ relPath: "b", namespace: "agent-runtime-doc", declaredSize: 1, depth: 9 }),
    ).toBeInstanceOf(StorageLimitExceededError);
  });

  test("design/ carries the workspace tree budget: depth 8, 512 files, 64 MiB", () => {
    const budget = createLimitBudget("project");
    expect(
      budget.admitFile({
        relPath: "design/a/b/c/d/e/f/g/h/i.tsx",
        namespace: "design-source",
        declaredSize: 1,
        depth: 10,
      }),
    ).toBeInstanceOf(StorageLimitExceededError);
  });

  test("design/ admits exactly depth 8 under the `.termcraft` project root (the NAMESPACE ceiling, not the root's own 16-component one)", () => {
    // The project root's own `maxDepth` falls back to the §5.1 component ceiling (16, see
    // `ROOT_LIMITS.project`), which would happily admit depth 8 or 9 on its own — this test
    // only proves anything because it is `design-source`'s namespace-level `maxDepth: 8` that
    // is doing the rejecting one component later.
    const admits8 = createLimitBudget("project");
    expect(
      admits8.admitFile({
        relPath: "design/a/b/c/d/e/f/g.tsx",
        namespace: "design-source",
        declaredSize: 1,
        depth: 8,
      }),
    ).toBeNull();

    const rejects9 = createLimitBudget("project");
    expect(
      rejects9.admitFile({
        relPath: "design/a/b/c/d/e/f/g/h.tsx",
        namespace: "design-source",
        declaredSize: 1,
        depth: 9,
      }),
    ).toBeInstanceOf(StorageLimitExceededError);
  });
});

describe("createLimitBudget — checked again while streaming (§5.3)", () => {
  test("catches a file that grows past its per-file limit mid-stream", () => {
    const budget = createLimitBudget("workspace");
    // The directory entry claimed 1 KiB; the stream keeps delivering bytes.
    expect(
      budget.admitFile({
        relPath: "design/pages/home.tsx",
        namespace: "design-source",
        declaredSize: KiB,
        depth: 3,
      }),
    ).toBeNull();
    expect(
      budget.observeBytes({
        relPath: "design/pages/home.tsx",
        namespace: "design-source",
        bytesSoFar: 2 * MiB,
      }),
    ).toBeNull();
    const rejected = budget.observeBytes({
      relPath: "design/pages/home.tsx",
      namespace: "design-source",
      bytesSoFar: 2 * MiB + 1,
    });
    expect(rejected).toBeInstanceOf(StorageLimitExceededError);
  });

  test("catches a file that pushes the root aggregate over mid-stream", () => {
    const budget = createLimitBudget("workspace");
    for (let i = 0; i < 31; i += 1) {
      budget.admitFile({
        relPath: `design/pages/p${i}.tsx`,
        namespace: "design-source",
        declaredSize: 2 * MiB,
        depth: 3,
      });
    }
    // 62 MiB committed; this entry claims 1 byte but streams 2 MiB + 1.
    expect(
      budget.admitFile({
        relPath: "design/pages/last.tsx",
        namespace: "design-source",
        declaredSize: 1,
        depth: 3,
      }),
    ).toBeNull();
    expect(
      budget.observeBytes({
        relPath: "design/pages/last.tsx",
        namespace: "design-source",
        bytesSoFar: 2 * MiB,
      }),
    ).toBeNull();
    expect(
      budget.observeBytes({
        relPath: "design/pages/last.tsx",
        namespace: "design-source",
        bytesSoFar: 2 * MiB + 1,
      }),
    ).toBeInstanceOf(StorageLimitExceededError);
  });

  test("re-costs the file being streamed, not merely the last one admitted", () => {
    // `snapshotToCandidate` admits the WHOLE tree during enumeration and only then copies
    // it file by file, so `observeBytes` is reached for every file long after that file
    // stopped being the most recent `admitFile`. A file that streams exactly the size it
    // declared must therefore change nothing about the tree's cost — otherwise its bytes
    // are counted twice (once as declared, once as streamed) and a legal workspace at the
    // §5.3 boundary is falsely rejected mid-copy.
    const budget = createLimitBudget("workspace");
    for (let i = 0; i < 32; i += 1) {
      expect(
        budget.admitFile({
          relPath: `design/pages/p${i}.tsx`,
          namespace: "design-source",
          declaredSize: 2 * MiB,
          depth: 3,
        }),
      ).toBeNull();
    }

    // The tree sits at exactly its 64 MiB aggregate. Copying the FIRST-admitted file at
    // its honest declared size is not growth and must be admitted.
    expect(
      budget.observeBytes({
        relPath: "design/pages/p0.tsx",
        namespace: "design-source",
        bytesSoFar: 2 * MiB,
      }),
    ).toBeNull();

    // Growth on that same earlier file is still caught.
    expect(
      budget.observeBytes({
        relPath: "design/pages/p0.tsx",
        namespace: "design-source",
        bytesSoFar: 2 * MiB + 1,
      }),
    ).toBeInstanceOf(StorageLimitExceededError);
  });
});
