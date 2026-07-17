import { Panel } from "@termcraft/runtime"

export const meta = { title: "Good page" }
export default function Page(): string {
  return Panel({ id: "root", title: "fine" })
}
