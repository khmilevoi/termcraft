import { definePage } from "@termcraft/runtime"
// A relative specifier is LEGAL inside the tree since the design tree landed (design §6), so
// this fixture no longer asserts "relative is forbidden" — it asserts the rule that replaced
// it: a relative specifier that ESCAPES the tree is fatal, even when the file it names exists
// on disk. Renamed from `forbidden-relative.tsx` in task 15 rather than deleted, so the
// coverage moves with the rule instead of disappearing with it.
export { helper } from "../../../outside"

export const meta = definePage({
  kitApiVersion: 1,
  title: "Escaping relative",
  minSize: { w: 10, h: 2 },
  theme: "dark-default",
})

export default function Bad() {
  return <text>bad</text>
}
