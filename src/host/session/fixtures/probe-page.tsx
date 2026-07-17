import { definePage } from "@termcraft/runtime"

export const meta = definePage({
  kitApiVersion: 1,
  title: "Probe page",
  minSize: { w: 10, h: 2 },
  theme: "dark-default",
})

export default function ProbePage() {
  return (
    <box>
      <text>hi-from-fixture</text>
    </box>
  )
}
