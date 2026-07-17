// Does the `dev-only` registration actually FORBID explicit jsx-runtime imports, or does it
// merely fail to resolve the one specifier authors happen to type? An author who writes the
// DEV subpath explicitly should reveal which.
import { jsxDEV } from "react/jsx-dev-runtime"
import { Panel, kitApiVersion } from "@termcraft/runtime"

export const meta = { title: "explicit jsx-dev-runtime import", kitApiVersion }

export default function Page() {
  return jsxDEV(Panel, { id: "root", title: "hello from explicit jsx-DEV-runtime" })
}
