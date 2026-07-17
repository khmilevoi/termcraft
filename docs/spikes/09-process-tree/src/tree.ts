import { spawn } from "node:child_process"
import { appendFileSync } from "node:fs"

// argv: <pidFile> <depth>
const pidFile = process.argv[2]
const depth = Number(process.argv[3] ?? 0)

appendFileSync(pidFile, `${depth}:${process.pid}\n`)

// Refuse to die politely. Step 4 must prove the mechanism, not our manners.
process.on("SIGTERM", () => {})
process.on("SIGINT", () => {})

if (depth < 2) {
  spawn(process.execPath, [import.meta.path ?? __filename, pidFile, String(depth + 1)], {
    detached: true, // breaks the parent link — taskkill /T walks that link
    stdio: "ignore",
  }).unref()
}

// Stay alive well past the probe's own lifetime.
setInterval(() => {}, 1 << 30)
