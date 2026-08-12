import { describe, expect, test } from "bun:test";

import type { GateErrorV1, GateWarningV1, RunTreeResultV1 } from "core/ports";
import { parsePageSlug } from "entities/page";

import type { DesignSystemCandidateTreeV1 } from "../types";
import {
  DesignSystemCandidateError,
  MAX_PREVIEW_ITEMS,
  composeDesignSystemCandidate,
  summarizeGatePass,
} from "./candidate";

/**
 * `composeDesignSystemCandidate` (decision D5) and `summarizeGatePass` (decision D6): the pure
 * candidate-tree splice and the pure Gate-answer classification. No I/O — every input here is an
 * in-memory map/array, matching the module's own no-filesystem contract.
 */

const encode = (text: string) => new Uint8Array(Buffer.from(text, "utf8"));
const decode = (bytes: Uint8Array) => Buffer.from(bytes).toString("utf8");

function slug(value: string) {
  const parsed = parsePageSlug(value);
  if (parsed instanceof Error) throw parsed;
  return parsed;
}

const PAGE_DASHBOARD = slug("dashboard");

const OLD_MANIFEST = '{"schemaVersion":1,"id":"legacy","version":"0.9.0"}';
const NEW_MANIFEST = '{"schemaVersion":1,"id":"midnight","version":"1.2.0"}';
const BUTTON = "export const Button = () => null;\n";

const SAMPLE_INPUT = {
  currentFiles: new Map([
    ["pages.json", "{}"],
    ["pages/dashboard.tsx", "export default null;"],
    ["system/design-system.json", OLD_MANIFEST],
    ["system/components/Legacy.tsx", "export const Legacy = () => null;"],
  ]),
  currentTreePaths: [
    "pages.json",
    "pages/dashboard.tsx",
    "system/design-system.json",
    "system/components/Legacy.tsx",
  ],
  packageFiles: [
    { relPath: "design-system.json", bytes: encode(NEW_MANIFEST) },
    { relPath: "components/Button.tsx", bytes: encode(BUTTON) },
  ],
};

describe("composeDesignSystemCandidate", () => {
  test("replaces system/** wholesale and leaves every other file untouched", () => {
    const candidate = composeDesignSystemCandidate(SAMPLE_INPUT);
    expect(candidate).not.toBeInstanceOf(Error);
    const value = candidate as DesignSystemCandidateTreeV1;
    expect([...value.files.keys()].sort()).toEqual([
      "pages.json",
      "pages/dashboard.tsx",
      "system/components/Button.tsx",
      "system/design-system.json",
    ]);
    expect(value.files.get("system/design-system.json")).toBe(NEW_MANIFEST);
    expect(value.removedTreeRelPaths).toEqual(["system/components/Legacy.tsx"]);
  });

  test("treePaths is sorted and matches the composed file set exactly", () => {
    const candidate = composeDesignSystemCandidate(SAMPLE_INPUT);
    expect(candidate).not.toBeInstanceOf(Error);
    const value = candidate as DesignSystemCandidateTreeV1;
    expect(value.treePaths).toEqual([...value.files.keys()].sort());
  });

  test("nextFiles carries the same bytes the file map carries as text", () => {
    const candidate = composeDesignSystemCandidate(SAMPLE_INPUT);
    expect(candidate).not.toBeInstanceOf(Error);
    const value = candidate as DesignSystemCandidateTreeV1;
    for (const file of value.nextFiles) {
      const text = value.files.get(file.treeRelPath);
      if (text === undefined) throw new Error(`missing text for ${file.treeRelPath}`);
      expect(decode(file.bytes)).toBe(text);
    }
  });

  test("a package with no manifest is refused", () => {
    expect(
      composeDesignSystemCandidate({
        currentFiles: new Map(),
        currentTreePaths: [],
        packageFiles: [{ relPath: "components/Button.tsx", bytes: encode(BUTTON) }],
      }),
    ).toBeInstanceOf(DesignSystemCandidateError);
  });

  test("a package path escaping the package root is refused", () => {
    expect(
      composeDesignSystemCandidate({
        currentFiles: new Map(),
        currentTreePaths: [],
        packageFiles: [
          { relPath: "design-system.json", bytes: encode(NEW_MANIFEST) },
          { relPath: "../pages/dashboard.tsx", bytes: encode("owned") },
        ],
      }),
    ).toBeInstanceOf(DesignSystemCandidateError);
  });

  test("a non-UTF-8 package file is refused rather than mojibaked into the Gate", () => {
    expect(
      composeDesignSystemCandidate({
        currentFiles: new Map(),
        currentTreePaths: [],
        packageFiles: [
          { relPath: "design-system.json", bytes: encode(NEW_MANIFEST) },
          { relPath: "components/Bad.tsx", bytes: new Uint8Array([0xff, 0xfe, 0xfd]) },
        ],
      }),
    ).toBeInstanceOf(DesignSystemCandidateError);
  });
});

describe("summarizeGatePass", () => {
  test("D6: a clean pass is `clean`", () => {
    expect(summarizeGatePass({ errors: [], warnings: [], closures: [] }).verdict).toBe("clean");
  });

  test("D6: a fatal naming a PAGE is breakage the designer can confirm", () => {
    const errors: GateErrorV1[] = [
      {
        kind: "type",
        code: "TYPE_ERROR",
        message: "t.brandBlue does not exist",
        file: "pages/dashboard.tsx",
        blockedPages: [PAGE_DASHBOARD],
      },
    ];
    const pass: RunTreeResultV1 = { errors, warnings: [], closures: [] };
    const preview = summarizeGatePass(pass);
    expect(preview.verdict).toBe("breaks-pages");
    expect(preview.errors[0]).toEqual({
      code: "TYPE_ERROR",
      message: "t.brandBlue does not exist",
      file: "pages/dashboard.tsx",
      blockedPages: ["dashboard"],
    });
  });

  test("D6: a fatal INSIDE system/ blocks — the package itself is broken", () => {
    const errors: GateErrorV1[] = [
      {
        kind: "manifest",
        code: "MISSING_CORE_ROLE",
        message: "theme dark omits dangerDim",
        file: "system/design-system.json",
      },
    ];
    expect(summarizeGatePass({ errors, warnings: [], closures: [] }).verdict).toBe("blocked");
  });

  test("D6: an UNATTRIBUTED fatal blocks — an unplaceable failure is never assumed to be a page's", () => {
    const errors: GateErrorV1[] = [
      { kind: "type", code: "TYPE_CHECK_UNAVAILABLE", message: "the compiler is down" },
    ];
    expect(summarizeGatePass({ errors, warnings: [], closures: [] }).verdict).toBe("blocked");
  });

  test("warnings never change the verdict", () => {
    const warnings: GateWarningV1[] = [
      { kind: "dead-module", message: "unused", file: "system/x.tsx" },
    ];
    expect(summarizeGatePass({ errors: [], warnings, closures: [] }).verdict).toBe("clean");
  });

  test("the preview is bounded — a flood of diagnostics is truncated, not streamed", () => {
    const errors: GateErrorV1[] = Array.from({ length: 200 }, (_unused, index) => ({
      kind: "type",
      code: "TYPE_ERROR",
      message: `e${index}`,
      file: "pages/a.tsx",
    }));
    expect(summarizeGatePass({ errors, warnings: [], closures: [] }).errors).toHaveLength(
      MAX_PREVIEW_ITEMS,
    );
  });

  test("truncation can never soften the verdict", () => {
    // 60 page fatals then ONE inside `system/`: the blocking one falls outside the truncation
    // window, and the verdict must still be `blocked`.
    const errors: GateErrorV1[] = [
      ...Array.from({ length: 60 }, (_unused, index) => ({
        kind: "type" as const,
        code: "TYPE_ERROR",
        message: `e${index}`,
        file: "pages/a.tsx",
      })),
      {
        kind: "manifest",
        code: "MISSING_CORE_ROLE",
        message: "x",
        file: "system/design-system.json",
      },
    ];
    expect(summarizeGatePass({ errors, warnings: [], closures: [] }).verdict).toBe("blocked");
  });
});
