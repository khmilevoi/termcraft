import { expect, test } from "bun:test";

import { createDesignSourceAdmission } from "./admission";

test("admits an ordinary package file", () => {
  const admission = createDesignSourceAdmission();
  expect(
    admission.admitFile({ relPath: "design-system.json", declaredSize: 1024, depth: 1 }),
  ).toBeNull();
  expect(admission.observeBytes({ relPath: "design-system.json", bytesRead: 1024 })).toBeNull();
});

test("refuses a file over the design-source per-file budget (2 MiB)", () => {
  const admission = createDesignSourceAdmission();
  const refusal = admission.admitFile({
    relPath: "components/Huge.tsx",
    declaredSize: 3 * 1024 * 1024,
    depth: 2,
  });
  expect(refusal).toBeInstanceOf(Error);
});

test("refuses a package past the 512-file cap", () => {
  const admission = createDesignSourceAdmission();
  const results = Array.from({ length: 600 }, (_unused, index) =>
    admission.admitFile({ relPath: `components/C${index}.tsx`, declaredSize: 8, depth: 2 }),
  );
  expect(results.slice(0, 512).every((result) => result === null)).toBe(true);
  expect(results[512]).toBeInstanceOf(Error);
});

test("refuses a file deeper than the design-source depth cap (8)", () => {
  const admission = createDesignSourceAdmission();
  expect(
    admission.admitFile({ relPath: "a/b/c/d/e/f/g/h/i.tsx", declaredSize: 8, depth: 9 }),
  ).toBeInstanceOf(Error);
});

test("observeBytes catches a file that grew past its declared size", () => {
  const admission = createDesignSourceAdmission();
  expect(admission.admitFile({ relPath: "big.tsx", declaredSize: 16, depth: 1 })).toBeNull();
  expect(admission.observeBytes({ relPath: "big.tsx", bytesRead: 3 * 1024 * 1024 })).toBeInstanceOf(
    Error,
  );
});

test("each call returns a FRESH budget — two fetches never share an aggregate", () => {
  const first = createDesignSourceAdmission();
  const second = createDesignSourceAdmission();
  for (let index = 0; index < 400; index += 1) {
    first.admitFile({ relPath: `c${index}.tsx`, declaredSize: 8, depth: 1 });
  }
  expect(second.admitFile({ relPath: "c0.tsx", declaredSize: 8, depth: 1 })).toBeNull();
});
