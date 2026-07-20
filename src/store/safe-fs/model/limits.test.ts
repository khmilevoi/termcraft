import { describe, expect, test } from "bun:test"

import type { ManagedNamespace, ManagedRootKind } from "../types"
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
} from "./limits"

const CHAT_ID = "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d10"

function expectNamespace(rootKind: ManagedRootKind, relPath: string, expected: ManagedNamespace): void {
  const result = classifyNamespace(rootKind, relPath)
  if (result instanceof Error) throw new Error(`expected ${relPath} to classify as ${expected}: ${result.message}`)
  expect(result).toBe(expected)
}

function expectUnknown(rootKind: ManagedRootKind, relPath: string): void {
  expect(classifyNamespace(rootKind, relPath)).toBeInstanceOf(UnknownNamespaceError)
}

describe("classifyNamespace — turn-durability §5.3/§5.4 namespace grammar", () => {
  test("classifies the agent workspace's exact allowed inventory", () => {
    expectNamespace("workspace", "pages/home.tsx", "agent-page-source")
    expectNamespace("workspace", "pages.json", "agent-manifest")
    expectNamespace("workspace", "RUNTIME.md", "agent-runtime-doc")
    expectNamespace("workspace", "types/runtime.d.ts", "agent-runtime-doc")
  })

  test("a candidate shares the workspace grammar", () => {
    expectNamespace("candidate", "pages/home.tsx", "agent-page-source")
    expectNamespace("candidate", "pages.json", "agent-manifest")
  })

  test("rejects added files, nested page directories, and non-slug page names (§5.4)", () => {
    expectUnknown("workspace", "evil.sh")
    expectUnknown("workspace", "pages/home/extra.tsx")
    expectUnknown("workspace", "pages/Home.tsx") // slug mask is lower-case only
    expectUnknown("workspace", "pages/home.txt")
    expectUnknown("workspace", "pages/con.tsx") // reserved device name is not a slug
    expectUnknown("workspace", "pages/nested.d.ts") // .d.ts may not hide under pages/
  })

  test("classifies the `.termcraft` project namespaces", () => {
    expectNamespace("project", "project.toml", "project-config")
    expectNamespace("project", "workspace.local.toml", "project-config")
    expectNamespace("project", ".gitignore", "project-config")
    expectNamespace("project", `chats/${CHAT_ID}.jsonl`, "chat-jsonl")
    expectNamespace("project", "pages/home/page.tsx", "canonical-page")
    expectNamespace("project", "pages/home/comments.jsonl", "comments-jsonl")
    expectNamespace("project", "cache/page-meta/home/1/abc.json", "project-config")
    expectNamespace("project", `transactions.local/${CHAT_ID}/plan.json`, "transaction-payload")
    expectNamespace("project", `export/generations/${CHAT_ID}/pages/home.json`, "export-artifact")
  })

  test("the workspace grammar does not leak into the project root and vice versa", () => {
    expectUnknown("project", "pages/home.tsx") // agent shape, not the canonical shape
    expectUnknown("workspace", "project.toml")
    expectUnknown("workspace", `chats/${CHAT_ID}.jsonl`)
  })

  test("export candidates and migration backups accept their own whole trees", () => {
    expectNamespace("export-candidate", "pages/home/snapshot.json", "export-artifact")
    expectNamespace("backup", "pages/home/page.tsx", "migration-backup")
  })
})

describe("§5.3 limit table constants", () => {
  test("carries the spec's per-file limits verbatim", () => {
    expect(NAMESPACE_LIMITS["agent-page-source"].perFileBytes).toBe(2 * MiB)
    expect(NAMESPACE_LIMITS["agent-manifest"].perFileBytes).toBe(256 * KiB)
    expect(NAMESPACE_LIMITS["agent-runtime-doc"].perFileBytes).toBe(4 * MiB)
    expect(NAMESPACE_LIMITS["project-config"].perFileBytes).toBe(1 * MiB)
    expect(NAMESPACE_LIMITS["chat-jsonl"].perFileBytes).toBe(64 * MiB)
    expect(NAMESPACE_LIMITS["comments-jsonl"].perFileBytes).toBe(32 * MiB)
    expect(NAMESPACE_LIMITS["canonical-page"].perFileBytes).toBe(2 * MiB)
    expect(NAMESPACE_LIMITS["export-artifact"].perFileBytes).toBe(16 * MiB)
    expect(NAMESPACE_LIMITS["transaction-payload"].perFileBytes).toBe(64 * MiB)
    expect(NAMESPACE_LIMITS["migration-backup"].perFileBytes).toBe(64 * MiB)
  })

  test("carries the spec's count and aggregate limits verbatim", () => {
    expect(NAMESPACE_LIMITS["agent-page-source"].maxFiles).toBe(256)
    expect(NAMESPACE_LIMITS["agent-manifest"].maxFiles).toBe(1)
    expect(NAMESPACE_LIMITS["agent-runtime-doc"].maxFiles).toBe(32)
    expect(NAMESPACE_LIMITS["agent-runtime-doc"].aggregateBytes).toBe(16 * MiB)
    expect(NAMESPACE_LIMITS["project-config"].aggregateBytes).toBe(16 * MiB)
    expect(NAMESPACE_LIMITS["canonical-page"].maxFiles).toBe(256)
    expect(NAMESPACE_LIMITS["export-artifact"].maxFiles).toBe(20_000)
    expect(NAMESPACE_LIMITS["export-artifact"].aggregateBytes).toBe(1024 * MiB)
    expect(NAMESPACE_LIMITS["transaction-payload"].aggregateBytes).toBe(2048 * MiB)
    expect(NAMESPACE_LIMITS["migration-backup"].aggregateBytes).toBe(2048 * MiB)
  })

  test("the whole turn workspace/candidate is 512 files, 64 MiB, depth 8", () => {
    expect(ROOT_LIMITS.workspace).toEqual({ maxFiles: 512, totalBytes: 64 * MiB, maxDepth: 8 })
    expect(ROOT_LIMITS.candidate).toEqual({ maxFiles: 512, totalBytes: 64 * MiB, maxDepth: 8 })
  })

  test("carries the §5.3 JSONL physical-line bounds", () => {
    expect(JSONL_MAX_PHYSICAL_LINE_BYTES).toBe(1_048_576)
    expect(JSONL_MAX_SERIALIZED_OBJECT_BYTES).toBe(1_048_575)
  })
})

describe("createLimitBudget — checked before allocation (§5.3)", () => {
  test("admits a page file at exactly the per-file limit and rejects one byte over", () => {
    const at = createLimitBudget("workspace")
    expect(
      at.admitFile({ relPath: "pages/home.tsx", namespace: "agent-page-source", declaredSize: 2 * MiB, depth: 2 }),
    ).toBeNull()

    const over = createLimitBudget("workspace")
    const rejected = over.admitFile({
      relPath: "pages/home.tsx",
      namespace: "agent-page-source",
      declaredSize: 2 * MiB + 1,
      depth: 2,
    })
    expect(rejected).toBeInstanceOf(StorageLimitExceededError)
    expect((rejected as StorageLimitExceededError).measured).toBe(2 * MiB + 1)
    expect((rejected as StorageLimitExceededError).allowed).toBe(2 * MiB)
  })

  test("admits exactly one `pages.json` and rejects a second", () => {
    const budget = createLimitBudget("workspace")
    expect(budget.admitFile({ relPath: "pages.json", namespace: "agent-manifest", declaredSize: 10, depth: 1 })).toBeNull()
    expect(budget.admitFile({ relPath: "b.json", namespace: "agent-manifest", declaredSize: 10, depth: 1 })).toBeInstanceOf(
      StorageLimitExceededError,
    )
  })

  test("admits 256 page files and rejects the 257th", () => {
    const budget = createLimitBudget("workspace")
    for (let i = 0; i < 256; i += 1) {
      expect(
        budget.admitFile({ relPath: `pages/p${i}.tsx`, namespace: "agent-page-source", declaredSize: 1, depth: 2 }),
      ).toBeNull()
    }
    expect(
      budget.admitFile({ relPath: "pages/p256.tsx", namespace: "agent-page-source", declaredSize: 1, depth: 2 }),
    ).toBeInstanceOf(StorageLimitExceededError)
  })

  test("admits a workspace at exactly 64 MiB total and rejects one byte over", () => {
    const at = createLimitBudget("workspace")
    for (let i = 0; i < 32; i += 1) {
      expect(
        at.admitFile({ relPath: `pages/p${i}.tsx`, namespace: "agent-page-source", declaredSize: 2 * MiB, depth: 2 }),
      ).toBeNull()
    }

    const over = createLimitBudget("workspace")
    for (let i = 0; i < 32; i += 1) {
      over.admitFile({ relPath: `pages/p${i}.tsx`, namespace: "agent-page-source", declaredSize: 2 * MiB, depth: 2 })
    }
    expect(over.admitFile({ relPath: "pages.json", namespace: "agent-manifest", declaredSize: 1, depth: 1 })).toBeInstanceOf(
      StorageLimitExceededError,
    )
  })

  test("admits 512 workspace files and rejects the 513th", () => {
    // A unit-level probe of the ROOT count rule alone: every workspace namespace also
    // carries a tighter count cap (256 + 32 + 1 = 289), so the root's 512 is defence in
    // depth that only a count-uncapped namespace can reach. `classifyNamespace` — not the
    // budget — is what keeps a `chat-jsonl` leaf out of a workspace in production.
    const budget = createLimitBudget("workspace")
    for (let i = 0; i < 512; i += 1) {
      expect(budget.admitFile({ relPath: `f${i}`, namespace: "chat-jsonl", declaredSize: 1, depth: 1 })).toBeNull()
    }
    expect(budget.admitFile({ relPath: "f512", namespace: "chat-jsonl", declaredSize: 1, depth: 1 })).toBeInstanceOf(
      StorageLimitExceededError,
    )
  })

  test("admits depth 8 and rejects depth 9 in a turn workspace", () => {
    const budget = createLimitBudget("workspace")
    expect(budget.admitFile({ relPath: "a", namespace: "agent-runtime-doc", declaredSize: 1, depth: 8 })).toBeNull()
    expect(budget.admitFile({ relPath: "b", namespace: "agent-runtime-doc", declaredSize: 1, depth: 9 })).toBeInstanceOf(
      StorageLimitExceededError,
    )
  })
})

describe("createLimitBudget — checked again while streaming (§5.3)", () => {
  test("catches a file that grows past its per-file limit mid-stream", () => {
    const budget = createLimitBudget("workspace")
    // The directory entry claimed 1 KiB; the stream keeps delivering bytes.
    expect(
      budget.admitFile({ relPath: "pages/home.tsx", namespace: "agent-page-source", declaredSize: KiB, depth: 2 }),
    ).toBeNull()
    expect(
      budget.observeBytes({ relPath: "pages/home.tsx", namespace: "agent-page-source", bytesSoFar: 2 * MiB }),
    ).toBeNull()
    const rejected = budget.observeBytes({
      relPath: "pages/home.tsx",
      namespace: "agent-page-source",
      bytesSoFar: 2 * MiB + 1,
    })
    expect(rejected).toBeInstanceOf(StorageLimitExceededError)
  })

  test("catches a file that pushes the root aggregate over mid-stream", () => {
    const budget = createLimitBudget("workspace")
    for (let i = 0; i < 31; i += 1) {
      budget.admitFile({ relPath: `pages/p${i}.tsx`, namespace: "agent-page-source", declaredSize: 2 * MiB, depth: 2 })
    }
    // 62 MiB committed; this entry claims 1 byte but streams 2 MiB + 1.
    expect(budget.admitFile({ relPath: "pages/last.tsx", namespace: "agent-page-source", declaredSize: 1, depth: 2 })).toBeNull()
    expect(
      budget.observeBytes({ relPath: "pages/last.tsx", namespace: "agent-page-source", bytesSoFar: 2 * MiB }),
    ).toBeNull()
    expect(
      budget.observeBytes({ relPath: "pages/last.tsx", namespace: "agent-page-source", bytesSoFar: 2 * MiB + 1 }),
    ).toBeInstanceOf(StorageLimitExceededError)
  })

  test("re-costs the file being streamed, not merely the last one admitted", () => {
    // `snapshotToCandidate` admits the WHOLE tree during enumeration and only then copies
    // it file by file, so `observeBytes` is reached for every file long after that file
    // stopped being the most recent `admitFile`. A file that streams exactly the size it
    // declared must therefore change nothing about the tree's cost — otherwise its bytes
    // are counted twice (once as declared, once as streamed) and a legal workspace at the
    // §5.3 boundary is falsely rejected mid-copy.
    const budget = createLimitBudget("workspace")
    for (let i = 0; i < 32; i += 1) {
      expect(
        budget.admitFile({ relPath: `pages/p${i}.tsx`, namespace: "agent-page-source", declaredSize: 2 * MiB, depth: 2 }),
      ).toBeNull()
    }

    // The tree sits at exactly its 64 MiB aggregate. Copying the FIRST-admitted file at
    // its honest declared size is not growth and must be admitted.
    expect(budget.observeBytes({ relPath: "pages/p0.tsx", namespace: "agent-page-source", bytesSoFar: 2 * MiB })).toBeNull()

    // Growth on that same earlier file is still caught.
    expect(
      budget.observeBytes({ relPath: "pages/p0.tsx", namespace: "agent-page-source", bytesSoFar: 2 * MiB + 1 }),
    ).toBeInstanceOf(StorageLimitExceededError)
  })
})
