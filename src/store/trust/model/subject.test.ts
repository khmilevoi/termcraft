import { describe, expect, test } from "bun:test";
import crypto from "node:crypto";

import type { GitIdentity, SourceTrustSubjectInput, TrustSubjectInput } from "../types";
import {
  TRUST_SUBJECT_SOURCE_V1_PREFIX,
  TRUST_SUBJECT_V1_PREFIX,
  canonicalizeRepoRelativePath,
  canonicalizeTrustPath,
  encodeSourceTrustSubjectV1,
  encodeTrustSubjectV1,
  sourceTrustSubjectKey,
  trustSubjectKey,
} from "./subject";

// ---- the two normative vectors (storage-identity §8) ---------------------------

const unixNoGit: TrustSubjectInput = {
  canonicalProjectPath: "/home/alice/project",
  projectFilesystemIdentity: "unix:2049:123456",
  projectId: "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d10",
  git: null,
};
const UNIX_NO_GIT_KEY = "d4e6fdfbde06ba486ac28297a4a55e0eaaf086fdfb70ba6302e162afb12ad6a9";

const windowsGitIdentity: GitIdentity = {
  canonicalGitCommonDir: "C:/work/.git",
  gitCommonDirFilesystemIdentity: "windows:1a2b3c4d:ffeeddccbbaa99887766554433221100",
  projectPathRelativeToWorktreeRoot: "termcraft",
};
const windowsGit: TrustSubjectInput = {
  canonicalProjectPath: "C:/work/termcraft",
  projectFilesystemIdentity: "windows:1a2b3c4d:00112233445566778899aabbccddeeff",
  projectId: "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d11",
  git: windowsGitIdentity,
};
const WINDOWS_GIT_KEY = "3912b4962af0420f5c76cd2890d90369815af23768f3b3cffd3b5127ec3824b1";

/** Composed "ö" (NFC) versus "o" + combining diaeresis (NFD) — the same character, different bytes. */
const NFC_O_UMLAUT = "ö";
const NFD_O_UMLAUT = NFC_O_UMLAUT.normalize("NFD");

/** Read the length-prefixed fields back out of an encoding, so layout is asserted, not assumed. */
function decodeFields(bytes: Uint8Array): string[] {
  const buf = Buffer.from(bytes);
  const prefix = Buffer.concat([Buffer.from(TRUST_SUBJECT_V1_PREFIX, "utf8"), Buffer.from([0x00])]);
  expect(buf.subarray(0, prefix.length)).toEqual(prefix);

  const fields: string[] = [];
  let offset = prefix.length;
  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    offset += 4;
    fields.push(buf.subarray(offset, offset + length).toString("utf8"));
    offset += length;
  }
  expect(offset).toBe(buf.length);
  return fields;
}

describe("encodeTrustSubjectV1", () => {
  test("starts with the ASCII prefix plus exactly one NUL byte", () => {
    const bytes = encodeTrustSubjectV1(unixNoGit);
    const prefix = Buffer.from(TRUST_SUBJECT_V1_PREFIX, "utf8");
    expect(Buffer.from(bytes).subarray(0, prefix.length).toString("utf8")).toBe(
      "termcraft-trust-subject-v1",
    );
    expect(bytes[prefix.length]).toBe(0x00);
    // Exactly ONE NUL: the four bytes after it must decode as the first field's length,
    // which pins the separator width — a second NUL would shift every length prefix.
    expect(Buffer.from(bytes).readUInt32BE(prefix.length + 1)).toBe("/home/alice/project".length);
  });

  test("encodes the four absent-Git fields in spec order", () => {
    expect(decodeFields(encodeTrustSubjectV1(unixNoGit))).toEqual([
      "/home/alice/project",
      "unix:2049:123456",
      "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d10",
      "absent",
    ]);
  });

  test("encodes the seven present-Git fields in spec order", () => {
    expect(decodeFields(encodeTrustSubjectV1(windowsGit))).toEqual([
      "C:/work/termcraft",
      "windows:1a2b3c4d:00112233445566778899aabbccddeeff",
      "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d11",
      "present",
      "C:/work/.git",
      "windows:1a2b3c4d:ffeeddccbbaa99887766554433221100",
      "termcraft",
    ]);
  });

  test("length prefixes are unsigned 32-bit big-endian NFC-UTF8 byte counts", () => {
    const bytes = Buffer.from(
      encodeTrustSubjectV1({
        ...unixNoGit,
        canonicalProjectPath: `/home/alice/pr${NFC_O_UMLAUT}ject`,
      }),
    );
    const at = TRUST_SUBJECT_V1_PREFIX.length + 1;
    // 19 characters, with "ö" costing 2 UTF-8 bytes → 20 bytes, big-endian.
    expect(bytes.subarray(at, at + 4)).toEqual(Buffer.from([0x00, 0x00, 0x00, 0x14]));
  });

  test("normalizes decomposed input to NFC before measuring and hashing", () => {
    const composed = { ...unixNoGit, canonicalProjectPath: `/home/alice/pr${NFC_O_UMLAUT}ject` };
    const decomposed = { ...unixNoGit, canonicalProjectPath: `/home/alice/pr${NFD_O_UMLAUT}ject` };
    expect(composed.canonicalProjectPath).not.toBe(decomposed.canonicalProjectPath);
    expect(Buffer.from(encodeTrustSubjectV1(decomposed))).toEqual(
      Buffer.from(encodeTrustSubjectV1(composed)),
    );
  });

  test("an empty repo-relative path is still a length-0 field, never omitted", () => {
    const git: GitIdentity = { ...windowsGitIdentity, projectPathRelativeToWorktreeRoot: "" };
    const fields = decodeFields(encodeTrustSubjectV1({ ...windowsGit, git }));
    expect(fields).toHaveLength(7);
    expect(fields[6]).toBe("");
  });
});

describe("trustSubjectKey — normative vectors (storage-identity §8)", () => {
  test("Unix, no Git", () => {
    expect(trustSubjectKey(unixNoGit)).toBe(UNIX_NO_GIT_KEY);
  });

  test("Windows, Git", () => {
    expect(trustSubjectKey(windowsGit)).toBe(WINDOWS_GIT_KEY);
  });

  test("is the lowercase-hex SHA-256 of the complete encoded byte string", () => {
    const digest = crypto
      .createHash("sha256")
      .update(encodeTrustSubjectV1(windowsGit))
      .digest("hex");
    expect(digest).toBe(WINDOWS_GIT_KEY);
    expect(trustSubjectKey(windowsGit)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("encodes the project UUID lowercase regardless of caller casing", () => {
    const upper = { ...unixNoGit, projectId: unixNoGit.projectId.toUpperCase() };
    expect(trustSubjectKey(upper)).toBe(UNIX_NO_GIT_KEY);
  });
});

describe("trustSubjectKey — what changes the subject (storage-identity §8)", () => {
  test("a path move produces a new subject", () => {
    expect(trustSubjectKey({ ...unixNoGit, canonicalProjectPath: "/home/alice/moved" })).not.toBe(
      UNIX_NO_GIT_KEY,
    );
  });

  test("replacing the directory at the same path produces a new subject", () => {
    expect(
      trustSubjectKey({ ...unixNoGit, projectFilesystemIdentity: "unix:2049:999999" }),
    ).not.toBe(UNIX_NO_GIT_KEY);
  });

  test("a projectId change produces a new subject", () => {
    expect(
      trustSubjectKey({ ...unixNoGit, projectId: "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d99" }),
    ).not.toBe(UNIX_NO_GIT_KEY);
  });

  test("Git initialization (absent → present) produces a new subject", () => {
    expect(trustSubjectKey({ ...unixNoGit, git: windowsGitIdentity })).not.toBe(UNIX_NO_GIT_KEY);
  });

  test("replacing the Git repository produces a new subject", () => {
    const git: GitIdentity = {
      ...windowsGitIdentity,
      gitCommonDirFilesystemIdentity: "windows:1a2b3c4d:0102030405060708",
    };
    expect(trustSubjectKey({ ...windowsGit, git })).not.toBe(WINDOWS_GIT_KEY);
  });

  test("moving the project within its worktree produces a new subject", () => {
    const git: GitIdentity = {
      ...windowsGitIdentity,
      projectPathRelativeToWorktreeRoot: "apps/termcraft",
    };
    expect(trustSubjectKey({ ...windowsGit, git })).not.toBe(WINDOWS_GIT_KEY);
  });

  test("the `absent` tag cannot be forged by a Git identity of empty strings", () => {
    const git: GitIdentity = {
      canonicalGitCommonDir: "",
      gitCommonDirFilesystemIdentity: "",
      projectPathRelativeToWorktreeRoot: "",
    };
    expect(trustSubjectKey({ ...unixNoGit, git })).not.toBe(UNIX_NO_GIT_KEY);
  });

  test("a HEAD, branch, or commit change keeps the identical subject", () => {
    // §8: GitIdentity carries no branch name, HEAD, commit id, index checksum, remote
    // URL, or Git user identity, so none of those operations can move the key.
    expect(Object.keys(windowsGitIdentity).sort()).toEqual([
      "canonicalGitCommonDir",
      "gitCommonDirFilesystemIdentity",
      "projectPathRelativeToWorktreeRoot",
    ]);
    const afterCheckoutAndCommit: TrustSubjectInput = {
      canonicalProjectPath: "C:/work/termcraft",
      projectFilesystemIdentity: "windows:1a2b3c4d:00112233445566778899aabbccddeeff",
      projectId: "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d11",
      git: {
        canonicalGitCommonDir: "C:/work/.git",
        gitCommonDirFilesystemIdentity: "windows:1a2b3c4d:ffeeddccbbaa99887766554433221100",
        projectPathRelativeToWorktreeRoot: "termcraft",
      },
    };
    expect(trustSubjectKey(afterCheckoutAndCommit)).toBe(WINDOWS_GIT_KEY);
  });
});

describe("canonicalizeTrustPath", () => {
  test("uses forward separators and an uppercase Windows drive letter", () => {
    expect(canonicalizeTrustPath("c:\\work\\termcraft")).toBe("C:/work/termcraft");
  });

  test("preserves resolved case outside the drive letter", () => {
    expect(canonicalizeTrustPath("C:\\Work\\TermCraft")).toBe("C:/Work/TermCraft");
  });

  test("drops a trailing separator", () => {
    expect(canonicalizeTrustPath("C:\\work\\termcraft\\")).toBe("C:/work/termcraft");
    expect(canonicalizeTrustPath("/home/alice/project/")).toBe("/home/alice/project");
  });

  test("keeps the separator on a root", () => {
    expect(canonicalizeTrustPath("C:\\")).toBe("C:/");
    expect(canonicalizeTrustPath("c:")).toBe("C:/");
    expect(canonicalizeTrustPath("/")).toBe("/");
  });

  test("strips the Windows extended-length prefix", () => {
    expect(canonicalizeTrustPath("\\\\?\\C:\\work\\termcraft")).toBe("C:/work/termcraft");
    expect(canonicalizeTrustPath("\\\\?\\UNC\\server\\share\\project")).toBe(
      "//server/share/project",
    );
  });

  test("preserves a UNC root's leading double separator", () => {
    expect(canonicalizeTrustPath("\\\\server\\share\\project\\")).toBe("//server/share/project");
  });

  test("normalizes to NFC", () => {
    expect(canonicalizeTrustPath(`/home/alice/pr${NFD_O_UMLAUT}ject`)).toBe(
      `/home/alice/pr${NFC_O_UMLAUT}ject`,
    );
  });
});

describe("canonicalizeRepoRelativePath", () => {
  test("uses forward separators and drops surrounding separators", () => {
    expect(canonicalizeRepoRelativePath("apps\\termcraft\\")).toBe("apps/termcraft");
    expect(canonicalizeRepoRelativePath("/apps/termcraft")).toBe("apps/termcraft");
  });

  test("a project at the worktree root is the empty relative path", () => {
    expect(canonicalizeRepoRelativePath(".")).toBe("");
    expect(canonicalizeRepoRelativePath("")).toBe("");
  });

  test("drops a leading ./", () => {
    expect(canonicalizeRepoRelativePath("./apps/termcraft")).toBe("apps/termcraft");
  });

  test("normalizes to NFC", () => {
    expect(canonicalizeRepoRelativePath(`pr${NFD_O_UMLAUT}ject`)).toBe(`pr${NFC_O_UMLAUT}ject`);
  });
});

// ---- the source subject variant (project-design-systems §8.4) ------------------

const localSource: SourceTrustSubjectInput = {
  sourceKind: "local",
  sourceId: "local",
  canonicalLocation: "C:/Users/alice/AppData/Local/termcraft/design-systems/local",
  locationFilesystemIdentity: "windows:1a2b3c4d:00112233445566778899aabbccddeeff",
};

const remoteSource: SourceTrustSubjectInput = {
  sourceKind: "github",
  sourceId: "github:acme/design-systems",
  canonicalLocation: "github.com/acme/design-systems",
  locationFilesystemIdentity: null,
};

/** Pinned in Step 4 by running this file once and copying the printed digests. */
const LOCAL_SOURCE_KEY = "e07471d8137dc2a253d26affde361a86d90eba072ea2d3158c040f6adbaead46";
const REMOTE_SOURCE_KEY = "647c8ed3714b9bb8cedc08023f885618d09b8ba042f74016f6f77e09140be1d4";

/** Reads the length-prefixed fields back out, so layout is asserted rather than assumed. */
function decodeSourceFields(bytes: Uint8Array): string[] {
  const buf = Buffer.from(bytes);
  const prefix = Buffer.concat([
    Buffer.from(TRUST_SUBJECT_SOURCE_V1_PREFIX, "utf8"),
    Buffer.from([0x00]),
  ]);
  expect(buf.subarray(0, prefix.length)).toEqual(prefix);

  const fields: string[] = [];
  let offset = prefix.length;
  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    offset += 4;
    fields.push(buf.subarray(offset, offset + length).toString("utf8"));
    offset += length;
  }
  expect(offset).toBe(buf.length);
  return fields;
}

describe("encodeSourceTrustSubjectV1 (project-design-systems §8.4)", () => {
  test("carries its OWN domain-separation prefix, distinct from the project one", () => {
    expect(TRUST_SUBJECT_SOURCE_V1_PREFIX).toBe("termcraft-trust-subject-source-v1");
    expect(TRUST_SUBJECT_SOURCE_V1_PREFIX).not.toBe(TRUST_SUBJECT_V1_PREFIX);
  });

  test("encodes the five present-identity fields in order", () => {
    expect(decodeSourceFields(encodeSourceTrustSubjectV1(localSource))).toEqual([
      "local",
      "local",
      "C:/Users/alice/AppData/Local/termcraft/design-systems/local",
      "present",
      "windows:1a2b3c4d:00112233445566778899aabbccddeeff",
    ]);
  });

  test("encodes the four absent-identity fields in order", () => {
    expect(decodeSourceFields(encodeSourceTrustSubjectV1(remoteSource))).toEqual([
      "github",
      "github:acme/design-systems",
      "github.com/acme/design-systems",
      "absent",
    ]);
  });

  test("the `absent` tag cannot be forged by an empty identity string", () => {
    expect(sourceTrustSubjectKey({ ...remoteSource, locationFilesystemIdentity: "" })).not.toBe(
      sourceTrustSubjectKey(remoteSource),
    );
  });

  test("normalizes decomposed input to NFC before measuring and hashing", () => {
    const composed = { ...localSource, canonicalLocation: `C:/pr${NFC_O_UMLAUT}ject` };
    const decomposed = { ...localSource, canonicalLocation: `C:/pr${NFD_O_UMLAUT}ject` };
    expect(Buffer.from(encodeSourceTrustSubjectV1(decomposed))).toEqual(
      Buffer.from(encodeSourceTrustSubjectV1(composed)),
    );
  });
});

describe("sourceTrustSubjectKey", () => {
  test("is the lowercase-hex SHA-256 of the complete encoded byte string", () => {
    const digest = crypto
      .createHash("sha256")
      .update(encodeSourceTrustSubjectV1(localSource))
      .digest("hex");
    expect(sourceTrustSubjectKey(localSource)).toBe(digest);
    expect(sourceTrustSubjectKey(localSource)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("is pinned — the key of a recorded grant may not drift", () => {
    expect(sourceTrustSubjectKey(localSource)).toBe(LOCAL_SOURCE_KEY);
    expect(sourceTrustSubjectKey(remoteSource)).toBe(REMOTE_SOURCE_KEY);
  });

  test("each of the four fields moves the key", () => {
    expect(sourceTrustSubjectKey({ ...localSource, sourceKind: "github" })).not.toBe(
      LOCAL_SOURCE_KEY,
    );
    expect(sourceTrustSubjectKey({ ...localSource, sourceId: "other" })).not.toBe(LOCAL_SOURCE_KEY);
    expect(sourceTrustSubjectKey({ ...localSource, canonicalLocation: "C:/elsewhere" })).not.toBe(
      LOCAL_SOURCE_KEY,
    );
    expect(
      sourceTrustSubjectKey({ ...localSource, locationFilesystemIdentity: "windows:1:2" }),
    ).not.toBe(LOCAL_SOURCE_KEY);
  });

  test("a source subject can never collide with a project subject, even field for field", () => {
    // Same texts in the same positions, different KIND — the prefix is what separates them.
    const mirroredProject: TrustSubjectInput = {
      canonicalProjectPath: "local",
      projectFilesystemIdentity: "local",
      projectId: "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d10",
      git: null,
    };
    expect(sourceTrustSubjectKey(localSource)).not.toBe(trustSubjectKey(mirroredProject));
  });
});

describe("the project encoding is untouched by the source variant", () => {
  test("both normative §8 vectors still produce their recorded keys", () => {
    expect(trustSubjectKey(unixNoGit)).toBe(UNIX_NO_GIT_KEY);
    expect(trustSubjectKey(windowsGit)).toBe(WINDOWS_GIT_KEY);
  });
});
