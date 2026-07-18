// D3 — stderr drain + no-terminal-handle + env allowlist.
// (1) env replace: set a parent marker, spawn env-probe with an explicit small
//     env, confirm the child does NOT see the marker (env replaces, not merges).
// (2) no-TTY: confirm the child sees isTTY=false on all three streams.
// (3) stderr drain: spawn the child in stderr-burst mode, read ONLY stdout, and
//     confirm the stdout marker still arrives (a large stderr burst must not
//     block stdout parsing when the parent does not drain stderr).
const log = (tag: string, value: unknown) =>
  console.log(`D3:${tag}`, typeof value === "string" ? value : JSON.stringify(value))

const hardStop = setTimeout(() => {
  console.log("D3:TIMEOUT hard 20s")
  process.exit(9)
}, 20_000)
hardStop.unref()

process.env.TERMCRAFT_PARENT_MARKER = "present-in-parent"
const probePath = `${import.meta.dir}/env-probe.ts`

async function readStdoutLine(proc: { stdout: ReadableStream }, timeoutMs: number) {
  const start = Bun.nanoseconds()
  let buf = ""
  const dec = new TextDecoder()
  const loop = (async () => {
    for await (const chunk of proc.stdout as unknown as AsyncIterable<Uint8Array>) {
      buf += dec.decode(chunk, { stream: true })
      const nl = buf.indexOf("\n")
      if (nl !== -1) return { line: buf.slice(0, nl), waitedMs: Math.round((Bun.nanoseconds() - start) / 1e6) }
    }
    return { line: buf, waitedMs: Math.round((Bun.nanoseconds() - start) / 1e6), eof: true }
  })()
  return Promise.race([
    loop,
    new Promise<{ timeout: true; waitedMs: number }>((r) =>
      setTimeout(() => r({ timeout: true, waitedMs: timeoutMs }), timeoutMs),
    ),
  ])
}

// --- (1)+(2): env replace + no-TTY ---
{
  const proc = Bun.spawn({
    cmd: [process.execPath, probePath, "info"],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TZ: "UTC" },
  })
  const res = await readStdoutLine(proc, 8_000)
  const line = (res as { line?: string }).line ?? ""
  const parsed = line.startsWith("ENVPROBE:") ? JSON.parse(line.slice("ENVPROBE:".length)) : { raw: line, meta: res }
  log("env-replace+tty", parsed)
  proc.kill()
  await proc.exited
}

// --- (3): stderr burst must not block stdout ---
{
  const proc = Bun.spawn({
    cmd: [process.execPath, probePath, "stderr-burst"],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { LANG: "C.UTF-8", TZ: "UTC" },
  })
  // Deliberately do NOT read proc.stderr — testing whether an undrained ~2 MiB
  // stderr burst blocks the child before it writes the stdout marker.
  const res = await readStdoutLine(proc, 8_000)
  const line = (res as { line?: string }).line ?? ""
  const gotMarker = line.startsWith("ENVPROBE:")
  log("stderr-burst.stdout", { gotMarker, meta: res, linePrefix: line.slice(0, 40) })
  proc.kill()
  await proc.exited
}

clearTimeout(hardStop)
console.log("D3:DONE")
