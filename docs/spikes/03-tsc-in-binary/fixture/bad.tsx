import { Panel } from "@termcraft/runtime"

export const meta = { title: "Bad page" }
export default function Page(): string {
  return Panel({ title: 42 })
}
