import { Panel, kitApiVersion } from "@termcraft/runtime"

export const meta = { title: "Probe page", kitApiVersion }

export default function Page(): string {
  return Panel({ id: "root", title: "hello from an external file" })
}
