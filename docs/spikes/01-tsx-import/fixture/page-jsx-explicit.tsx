// The spec (§:47, §:162) forbids a page importing react/jsx-runtime explicitly, and
// §:679-680 requires that this FAIL. This fixture does exactly that, to find out.
import { jsx } from "react/jsx-runtime"
import { Panel, kitApiVersion } from "@termcraft/runtime"

export const meta = { title: "explicit jsx-runtime import", kitApiVersion }

export default function Page() {
  return jsx(Panel, { id: "root", title: "hello from explicit jsx-runtime" })
}
