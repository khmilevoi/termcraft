// A page that imports BOTH the embedded runtime (bare specifier) and a local sibling
// file by relative path. Real design pages may well do this; the plan asks whether the
// scratch-dir shim (fallback c) survives it.
import { Panel, kitApiVersion } from "@termcraft/runtime"
import { siblingBadge } from "./sibling.ts"

export const meta = { title: "Probe page with sibling", kitApiVersion }

export default function Page(): string {
  return Panel({ id: "root", title: `hello + ${siblingBadge}` })
}
