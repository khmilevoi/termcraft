// Closes the last gap: jsxs / Fragment / key were registered but never exercised.
// Records, for every helper invocation, exactly what the transform passed — so Task 4 knows
// what the real @termcraft/runtime facade must implement.
//
// usage: probe-jsx-multi <abs-path-to-page.tsx>
//   (set NODE_ENV=production to see the production transform)
import { plugin } from "bun"
import * as runtime from "./runtime.ts"
import { pathToFileURL } from "node:url"

const pagePath = process.argv[2]
if (!pagePath) {
  console.error("usage: probe-jsx-multi <absolute-path-to-page.tsx>")
  process.exit(2)
}

type Invocation = {
  helper: string
  type: string
  propKeys: string[]
  childrenKind: string
  keyPositional: unknown
  extraArgs: unknown[]
}
const log: Invocation[] = []

// Named so `type.name` identifies it when the transform passes it as the element type.
function Fragment(props: { children?: unknown }): unknown {
  return props?.children
}

const describeChildren = (props: Record<string, unknown> | undefined): string => {
  if (!props || !("children" in props)) return "none"
  const c = props.children
  if (Array.isArray(c)) return `array(${c.length})`
  return typeof c
}

// React's automatic runtime signatures:
//   jsx(type, props, key)
//   jsxs(type, props, key)
//   jsxDEV(type, props, key, isStaticChildren, source, self)
// `key` is POSITIONAL — it is not in props. Record it rather than assume.
const mk =
  (name: string) =>
  (type: unknown, props: Record<string, unknown>, key?: unknown, ...rest: unknown[]): unknown => {
    log.push({
      helper: name,
      type:
        typeof type === "function"
          ? (type as { name?: string }).name || "(anonymous fn)"
          : String(type),
      propKeys: Object.keys(props ?? {}),
      childrenKind: describeChildren(props),
      keyPositional: key === undefined ? null : key,
      extraArgs: rest,
    })
    return typeof type === "function" ? (type as (p: unknown) => unknown)(props) : String(type)
  }

const jsxRuntime = {
  jsx: mk("jsx"),
  jsxs: mk("jsxs"),
  jsxDEV: mk("jsxDEV"),
  jsxsDEV: mk("jsxsDEV"),
  Fragment,
}

plugin({
  name: "termcraft-runtime-resolver",
  setup(build) {
    build.module("@termcraft/runtime", () => ({ exports: runtime, loader: "object" }))
  },
})

plugin({
  name: "termcraft-jsx-runtime",
  setup(build) {
    build.module("react/jsx-runtime", () => ({ exports: jsxRuntime, loader: "object" }))
    build.module("react/jsx-dev-runtime", () => ({ exports: jsxRuntime, loader: "object" }))
  },
})

try {
  const mod = await import(pathToFileURL(pagePath).href)
  const rendered = typeof mod.default === "function" ? mod.default() : null
  console.log(
    JSON.stringify(
      {
        ok: true,
        nodeEnv: process.env.NODE_ENV ?? "(unset)",
        helpersCalled: log.map((l) => l.helper),
        distinctHelpers: [...new Set(log.map((l) => l.helper))],
        invocations: log,
        rendered,
      },
      null,
      2,
    ),
  )
} catch (e) {
  console.log(
    JSON.stringify(
      {
        ok: false,
        nodeEnv: process.env.NODE_ENV ?? "(unset)",
        helpersCalled: log.map((l) => l.helper),
        invocations: log,
        name: (e as Error).name,
        message: (e as Error).message,
      },
      null,
      2,
    ),
  )
  process.exit(1)
}
