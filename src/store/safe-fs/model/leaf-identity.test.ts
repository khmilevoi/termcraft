import { describe, expect, test } from "bun:test";

import type { SafeFsStat } from "../types";
import {
  IdentityChangedError,
  LeafRejectedError,
  UnsafeHardlinkError,
  checkIdentityUnchanged,
  checkManagedDirectory,
  checkManagedLeaf,
  detectDuplicateIdentity,
  identityKey,
} from "./leaf-identity";

function stat(overrides: Partial<SafeFsStat> = {}): SafeFsStat {
  return {
    isFile: true,
    isDirectory: false,
    isSymbolicLink: false,
    isSpecial: false,
    nlink: 1,
    dev: 1n,
    ino: 100n,
    size: 10,
    mtimeNs: 1_700_000_000_000_000_000n,
    ...overrides,
  };
}

describe("checkManagedLeaf — turn-durability §5.2", () => {
  test("accepts an ordinary regular file with exactly one link", () => {
    expect(checkManagedLeaf("a.tsx", stat())).toBeNull();
  });

  test("rejects a link count other than one as `unsafe_hardlink`", () => {
    const rejected = checkManagedLeaf("a.tsx", stat({ nlink: 2 }));
    expect(rejected).toBeInstanceOf(UnsafeHardlinkError);
    expect((rejected as UnsafeHardlinkError).reason).toContain("link count");
  });

  test("rejects a link count of zero", () => {
    expect(checkManagedLeaf("a.tsx", stat({ nlink: 0 }))).toBeInstanceOf(UnsafeHardlinkError);
  });

  test("rejects a directory presented as a leaf", () => {
    expect(checkManagedLeaf("pages", stat({ isFile: false, isDirectory: true }))).toBeInstanceOf(
      LeafRejectedError,
    );
  });

  test("rejects a symbolic link, junction, or any reparse point", () => {
    expect(checkManagedLeaf("link", stat({ isFile: false, isSymbolicLink: true }))).toBeInstanceOf(
      LeafRejectedError,
    );
  });

  test("rejects FIFOs, sockets, and devices", () => {
    expect(checkManagedLeaf("fifo", stat({ isFile: false, isSpecial: true }))).toBeInstanceOf(
      LeafRejectedError,
    );
  });

  test("a reparse point that still stats as a regular file is rejected, not accepted", () => {
    // libuv maps some reparse tags to a regular file; the symlink flag is the signal
    // that survives, so `isFile` alone must never be sufficient (Spike F).
    expect(checkManagedLeaf("sparse", stat({ isFile: true, isSymbolicLink: true }))).toBeInstanceOf(
      LeafRejectedError,
    );
  });
});

describe("checkManagedDirectory — turn-durability §5.2", () => {
  test("accepts an ordinary directory", () => {
    expect(checkManagedDirectory("pages", stat({ isFile: false, isDirectory: true }))).toBeNull();
  });

  test("rejects a directory that is a reparse point", () => {
    const rejected = checkManagedDirectory(
      "pages",
      stat({ isFile: false, isDirectory: true, isSymbolicLink: true }),
    );
    expect(rejected).toBeInstanceOf(LeafRejectedError);
  });

  test("rejects a non-directory presented as a directory", () => {
    expect(checkManagedDirectory("pages", stat())).toBeInstanceOf(LeafRejectedError);
  });
});

describe("detectDuplicateIdentity — §5.2 duplicate file identity in an enumerated tree", () => {
  test("accepts a tree of distinct files", () => {
    const entries = [
      { path: "a.tsx", stat: stat({ ino: 1n }) },
      { path: "b.tsx", stat: stat({ ino: 2n }) },
    ];
    expect(detectDuplicateIdentity(entries)).toBeNull();
  });

  test("rejects two paths sharing one (dev, ino) — a hardlink pair", () => {
    const entries = [
      { path: "a.tsx", stat: stat({ dev: 7n, ino: 42n }) },
      { path: "b.tsx", stat: stat({ dev: 7n, ino: 42n }) },
    ];
    const rejected = detectDuplicateIdentity(entries);
    expect(rejected).toBeInstanceOf(UnsafeHardlinkError);
    expect((rejected as UnsafeHardlinkError).reason).toContain("b.tsx");
  });

  test("the same inode on a different device is not a duplicate", () => {
    const entries = [
      { path: "a.tsx", stat: stat({ dev: 7n, ino: 42n }) },
      { path: "b.tsx", stat: stat({ dev: 8n, ino: 42n }) },
    ];
    expect(detectDuplicateIdentity(entries)).toBeNull();
  });

  test("an inode of zero is not usable as identity and never reports a duplicate", () => {
    const entries = [
      { path: "a.tsx", stat: stat({ ino: 0n }) },
      { path: "b.tsx", stat: stat({ ino: 0n }) },
    ];
    expect(detectDuplicateIdentity(entries)).toBeNull();
  });

  test("identityKey separates device from inode", () => {
    expect(identityKey(stat({ dev: 1n, ino: 23n }))).not.toBe(
      identityKey(stat({ dev: 12n, ino: 3n })),
    );
  });
});

describe("checkIdentityUnchanged — §5.2 identity stable between validation and use", () => {
  test("accepts an unchanged identity and metadata", () => {
    expect(checkIdentityUnchanged("a.tsx", stat(), stat())).toBeNull();
  });

  test("rejects a changed inode, device, link count, size, or mtime", () => {
    for (const drift of [{ ino: 999n }, { dev: 9n }, { nlink: 2 }, { size: 11 }, { mtimeNs: 2n }]) {
      expect(checkIdentityUnchanged("a.tsx", stat(), stat(drift))).toBeInstanceOf(
        IdentityChangedError,
      );
    }
  });
});
