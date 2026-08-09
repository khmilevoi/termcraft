import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as errore from "errore";

import type { DesignCheckReportV1, DesignCheckerPort } from "../types";
import { DESIGN_CHECK_CLEAN_HEADLINE } from "./render";
import { runDesignCheck } from "./run-check";

class CheckerBrokeError extends errore.createTaggedError({
  name: "CheckerBrokeError",
  message: "the checker itself failed: $reason",
}) {}

/**
 * A checker that genuinely READS THE DISK on every call, reporting whatever the workspace's
 * marker file currently says as one error. A fake that replayed a canned report could not tell
 * a live read apart from a snapshot taken once — which is exactly the property under test.
 */
function createDiskReadingChecker(): DesignCheckerPort {
  return {
    check(input): Promise<DesignCheckReportV1> {
      const marker = fs.readFileSync(
        path.join(input.workspacePath, "design", "marker.txt"),
        "utf8",
      );
      return Promise.resolve({
        errors: [{ kind: "type", code: "MARKER", message: marker, file: "marker.txt" }],
        warnings: [],
      });
    },
  };
}

test("runDesignCheck reads the LIVE workspace, not a report frozen at the first call", async () => {
  // THE WHOLE POINT OF THE TOOL: the agent edits, checks, edits again inside ONE attempt. A
  // check answered from a snapshot taken at attempt start would report code the agent already
  // fixed, and the second call would be worse than useless.
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "tc-checks-live-"));
  fs.mkdirSync(path.join(workspace, "design"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "design", "marker.txt"), "before-the-edit");

  const checker = createDiskReadingChecker();
  const first = await runDesignCheck(checker, workspace);
  expect(first).toContain("before-the-edit");

  fs.writeFileSync(path.join(workspace, "design", "marker.txt"), "after-the-edit");

  const second = await runDesignCheck(checker, workspace);
  expect(second).toContain("after-the-edit");
  expect(second).not.toContain("before-the-edit");

  fs.rmSync(workspace, { recursive: true, force: true });
});

test("runDesignCheck passes the workspace path it was built with, and nothing else", async () => {
  const seen: string[] = [];
  const checker: DesignCheckerPort = {
    check(input) {
      seen.push(input.workspacePath);
      return Promise.resolve({ errors: [], warnings: [] });
    },
  };
  await runDesignCheck(checker, "C:\\ws\\turn-1");
  await runDesignCheck(checker, "C:\\ws\\turn-1");
  // Called once PER CALL — never memoized behind the first answer.
  expect(seen).toEqual(["C:\\ws\\turn-1", "C:\\ws\\turn-1"]);
});

test("a checker that could not run renders as a failure, never as a clean pass", async () => {
  const checker: DesignCheckerPort = {
    check: () => Promise.resolve(new CheckerBrokeError({ reason: "no design/ directory" })),
  };
  const text = await runDesignCheck(checker, "C:\\ws");
  expect(text).not.toContain(DESIGN_CHECK_CLEAN_HEADLINE);
  expect(text).toContain("no design/ directory");
});
