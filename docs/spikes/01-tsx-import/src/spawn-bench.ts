// Fix 2: measure spawn -> first render END TO END, from the parent.
// This is the real cost of one preview under respawn-per-source (§4.2), which this spike
// found to be the ONLY way to re-read a changed page.
//
// Run with plain `bun` (not compiled): bun src/spawn-bench.ts <exe> <page.tsx> [runs]
const exe = process.argv[2]
const page = process.argv[3]
const runs = Number(process.argv[4] ?? 10)

if (!exe || !page) {
  console.error("usage: bun src/spawn-bench.ts <probe-cold.exe> <abs-page.tsx> [runs]")
  process.exit(2)
}

const wall: number[] = []
const inProcess: number[] = []
let lastOut = ""

for (let i = 0; i < runs; i++) {
  const t0 = performance.now()
  const p = Bun.spawnSync([exe, page])
  const t1 = performance.now()
  wall.push(t1 - t0)
  lastOut = p.stdout.toString().trim()
  try {
    inProcess.push(JSON.parse(lastOut).firstImportAndRenderMs)
  } catch {
    inProcess.push(NaN)
  }
}

const stat = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  return {
    all: xs.map((x) => Number(x.toFixed(1))),
    firstRunMs: Number(xs[0]!.toFixed(1)),
    medianMs: Number(s[Math.floor(s.length / 2)]!.toFixed(1)),
    minMs: Number(s[0]!.toFixed(1)),
    maxMs: Number(s[s.length - 1]!.toFixed(1)),
  }
}

console.log(
  JSON.stringify(
    {
      runs,
      exe,
      page,
      spawnToRenderWallClockMs: stat(wall),
      inProcessFirstImportAndRenderMs: stat(inProcess),
      lastChildOutput: lastOut,
    },
    null,
    2,
  ),
)
