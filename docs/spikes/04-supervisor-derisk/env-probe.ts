// D3 child: reports TTY flags + the env it actually received, and optionally
// bursts stderr before the stdout marker so the parent can test that a large
// stderr burst does not block stdout parsing. Throwaway spike evidence.
const mode = process.argv[2] ?? "info"

if (mode === "stderr-burst") {
  const kb = "x".repeat(1024)
  for (let i = 0; i < 2048; i += 1) process.stderr.write(kb) // ~2 MiB
}

const info = {
  mode,
  stdoutIsTTY: process.stdout.isTTY ?? false,
  stdinIsTTY: process.stdin.isTTY ?? false,
  stderrIsTTY: process.stderr.isTTY ?? false,
  envKeyCount: Object.keys(process.env).length,
  envKeys: Object.keys(process.env).sort(),
  hasParentMarker: "TERMCRAFT_PARENT_MARKER" in process.env,
  lang: process.env.LANG ?? null,
  lcAll: process.env.LC_ALL ?? null,
  tz: process.env.TZ ?? null,
  hasPath: "PATH" in process.env || "Path" in process.env,
}
process.stdout.write("ENVPROBE:" + JSON.stringify(info) + "\n")
