import { z } from "zod";

import { ProtocolError } from "../../protocol";
import type { LayoutNode } from "../types";

const rectSchema = z.strictObject({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});

/**
 * The wire form of `RenderHandle.layoutTree()`'s resolved tree (design doc §4.2), decoded
 * back on the supervisor side after the export/smoke one-shot child seals it into the
 * `ready` body's `layout` field (`host-state-machine.ts`'s `handleMount`, WP-5 Task A1).
 * Recursive via `z.lazy` — the tree depth mirrors the mounted component tree, which is
 * bounded by the page itself, never attacker-controlled input.
 */
const layoutNodeSchema: z.ZodType<LayoutNode> = z.lazy(() =>
  z.strictObject({
    id: z.string(),
    kind: z.string(),
    box: rectSchema,
    children: z.array(layoutNodeSchema),
  }),
);

/**
 * Decode a `ready.body.layout` value into a `LayoutNode`, or a typed `MALFORMED_PROTOCOL`
 * refusal on a missing/malformed tree (WP-5 Task A2) — never a fabricated stand-in
 * (CLAUDE.md, "document the divergence... never silently substitute an invented value").
 */
export function decodeLayoutNode(value: unknown): ProtocolError | LayoutNode {
  const result = layoutNodeSchema.safeParse(value);
  if (!result.success) {
    return new ProtocolError({
      code: "MALFORMED_PROTOCOL",
      reason: result.error.issues[0]?.message ?? "layout tree is malformed",
    });
  }
  return result.data;
}
