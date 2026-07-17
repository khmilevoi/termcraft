import { definePage } from "@termcraft/runtime"
export { helper } from "./neighbour.ts"

export const meta = definePage({
  kitApiVersion: 1,
  title: "Forbidden relative",
  minSize: { w: 10, h: 2 },
  theme: "dark-default",
})

export default function Bad() {
  return <text>bad</text>
}
