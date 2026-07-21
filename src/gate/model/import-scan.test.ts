import { describe, expect, test } from "bun:test";

import { scanImportAllowlist } from "./import-scan";

const clean = `import { definePage, Panel, Text, atom, reatomComponent } from "@termcraft/runtime"
export const meta = definePage({ kitApiVersion: 1, title: "X", minSize: { w: 80, h: 24 }, theme: "dark-default" })
export default reatomComponent(() => <Panel id="p"><Text id="t">{atom(1, "x")()}</Text></Panel>)
`;

describe("scanImportAllowlist (§3.1 authoritative module-edge allowlist)", () => {
  test("a clean page importing only the bare runtime root passes", () => {
    expect(scanImportAllowlist(clean)).toEqual([]);
  });

  test("a type-only import from the runtime root is legal", () => {
    const errors = scanImportAllowlist(
      `import type { PageMeta } from "@termcraft/runtime"\nexport const x = 1\n`,
    );
    expect(errors).toEqual([]);
  });

  test("a value import from a foreign module is rejected", () => {
    const errors = scanImportAllowlist(`import { useState } from "react"\n`);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("FORBIDDEN_IMPORT");
    expect(errors[0]?.message).toContain("react");
  });

  test("a type-only import from a foreign module is rejected (type edges are scanned)", () => {
    const errors = scanImportAllowlist(`import type { X } from "./local"\n`);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("FORBIDDEN_IMPORT");
  });

  test("a runtime subpath is rejected (only the bare root is legal)", () => {
    const errors = scanImportAllowlist(`import { jsx } from "@termcraft/runtime/jsx-runtime"\n`);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("FORBIDDEN_IMPORT");
  });

  test("a side-effect import is rejected even from the runtime root reasons aside — foreign is rejected", () => {
    expect(scanImportAllowlist(`import "./side-effect"\n`)[0]?.code).toBe("FORBIDDEN_IMPORT");
  });

  test("a dynamic import is rejected even when it names the runtime", () => {
    const errors = scanImportAllowlist(`const m = await import("@termcraft/runtime")\n`);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("DYNAMIC_IMPORT");
  });

  test("a re-export from the runtime is rejected (one page, no runtime-selected loading)", () => {
    const errors = scanImportAllowlist(`export { atom } from "@termcraft/runtime"\n`);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("REEXPORT");
  });

  test("a bare re-export of a foreign module is rejected", () => {
    expect(scanImportAllowlist(`export * from "./other"\n`)[0]?.code).toBe("REEXPORT");
  });

  test("a CJS require is rejected", () => {
    const errors = scanImportAllowlist(`const react = require("react")\n`);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("REQUIRE_CALL");
  });

  test("a local export is NOT a module edge (no false positive)", () => {
    expect(scanImportAllowlist(`export const label = "danger"\nexport default 1\n`)).toEqual([]);
  });

  test("import.meta is not a module edge", () => {
    expect(scanImportAllowlist(`const u = import.meta.url\n`)).toEqual([]);
  });

  test("a JSX string-attribute value is not mistaken for an import specifier", () => {
    const src = `import { Text } from "@termcraft/runtime"\nexport default () => <Text id="t" color="danger">hi "quoted"</Text>\n`;
    expect(scanImportAllowlist(src)).toEqual([]);
  });

  test("reports every offending edge, not just the first", () => {
    const errors = scanImportAllowlist(
      `import "react"\nimport { x } from "lodash"\nrequire("fs")\n`,
    );
    expect(errors.length).toBe(3);
  });
});
