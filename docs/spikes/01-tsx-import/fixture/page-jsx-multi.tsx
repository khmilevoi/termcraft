// Exercises the JSX code paths a single-child fixture never reaches:
//   - multiple children  -> jsxs (production) / jsxDEV with isStaticChildren (dev)
//   - a fragment <>...</> -> Fragment passed as the `type` argument
//   - a keyed .map child  -> `key` flowing as a POSITIONAL argument, not via props
// Essentially every real page hits these, so "JSX works" cannot rest on single-child alone.
import { Panel, kitApiVersion } from "@termcraft/runtime"

export const meta = { title: "multi-child JSX probe", kitApiVersion }

const items = ["a", "b"]

export default function Page() {
  return (
    <Panel id="root" title="multi">
      <Panel id="one" title="first" />
      <Panel id="two" title="second" />
      <>
        <Panel id="frag-1" title="in-fragment-1" />
        <Panel id="frag-2" title="in-fragment-2" />
      </>
      {items.map((it) => (
        <Panel key={it} id={`item-${it}`} title={`item ${it}`} />
      ))}
    </Panel>
  )
}
