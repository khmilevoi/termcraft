import { definePage } from "@termcraft/runtime"

export const meta = definePage({
  kitApiVersion: 1,
  title: "Broken syntax",
  minSize: { w: 10, h: 2 },
  theme: "dark-default",
})

// Intentionally unparseable: a truncated JSX return with no closing tag. Bun's
// Transpiler.scanImports throws a BuildMessage on this source, which loadPage
// must convert into a typed ProtocolError rather than rejecting.
export default function Broken() {
  return <text>hi
}
