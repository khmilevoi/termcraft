import { definePage } from "@termcraft/runtime"
import { useState } from "react"

export const meta = definePage({
  kitApiVersion: 1,
  title: "Forbidden react",
  minSize: { w: 10, h: 2 },
  theme: "dark-default",
})

export default function Bad() {
  useState(0)
  return <text>bad</text>
}
