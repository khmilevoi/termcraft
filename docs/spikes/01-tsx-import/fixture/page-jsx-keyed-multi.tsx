// Closes the one unobserved slot: every keyed element in page-jsx-multi.tsx is CHILDLESS, so
// it routes to `jsx` and no `jsxs` invocation ever carried a key. Here each keyed row has TWO
// children, forcing `jsxs` WITH a key so its third slot is observed rather than extrapolated.
import { Panel, kitApiVersion } from "@termcraft/runtime"

export const meta = { title: "keyed multi-child JSX", kitApiVersion }

const rows = ["r1", "r2"]

export default function Page() {
  return (
    <Panel id="root" title="keyed-multi">
      {rows.map((r) => (
        <Panel key={r} id={`row-${r}`} title={`row ${r}`}>
          <Panel id={`${r}-a`} title="a" />
          <Panel id={`${r}-b`} title="b" />
        </Panel>
      ))}
    </Panel>
  )
}
