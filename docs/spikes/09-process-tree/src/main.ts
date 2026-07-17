// Spike I — owned process tree and confirmed exit on Windows.
// Orchestrates: baseline (no mechanism) -> Job Object via bun:ffi -> taskkill /T /F
// against a synthetic three-level "badly-behaved" victim tree (src/tree.ts).
//
// IMPORTANT: this file spawns the victim tree via the literal command "bun",
// not process.execPath. Reason: when this file is compiled with
// `bun build --compile`, process.execPath inside the compiled binary is the
// standalone probe.exe itself, which cannot interpret an arbitrary .ts path
// as a script. Using "bun" on PATH keeps the orchestrator's own spawn calls
// identical between interpreted and compiled runs. tree.ts's *own*
// self-respawn of its children still uses process.execPath, because tree.ts
// itself is always run interpreted (by bun, directly or via this file), so
// process.execPath there is reliably bun.exe. This split is itself a finding
// — see FINDINGS.md.
//
// SECOND compiled-binary hazard (also a finding): inside a `bun build
// --compile` binary, `import.meta.dir` resolves to a *virtual* embedded path
// (observed: `B:\~BUN\root`), not a real directory on disk — so a path built
// from it (`${import.meta.dir}/tree.ts`) does not exist and a spawned real
// bun.exe fails to open it. We detect that here and fall back to
// process.cwd(), which is the real directory the compiled probe.exe was
// launched from.

import { spawn, execFileSync, type ChildProcess } from "node:child_process"
import { existsSync, readFileSync, unlinkSync } from "node:fs"
import { dlopen, FFIType, ptr, suffix } from "bun:ffi"

const importMetaTreeScript = `${import.meta.dir}/tree.ts`
const cwdTreeScript = `${process.cwd()}/src/tree.ts`
const usingCwdFallback = !existsSync(importMetaTreeScript)
const treeScript = usingCwdFallback ? cwdTreeScript : importMetaTreeScript
const scriptDir = usingCwdFallback ? process.cwd() : import.meta.dir

type PidEntry = { depth: number; pid: number }

function readPids(file: string): PidEntry[] {
  if (!existsSync(file)) return []
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [depth, pid] = line.split(":")
      return { depth: Number(depth), pid: Number(pid) }
    })
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === "ESRCH") return false
    console.warn(`process.kill(${pid}, 0) threw unexpected error`, e)
    return false
  }
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

async function waitForPidCount(file: string, count: number, timeoutMs = 5000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const pids = readPids(file)
    if (pids.length >= count) return pids
    await sleep(50)
  }
  return readPids(file)
}

function taskkillTree(pid: number) {
  const result = (() => {
    try {
      const out = execFileSync("taskkill", ["/F", "/T", "/PID", String(pid)], {
        encoding: "utf8",
      })
      return { code: 0, out }
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string }
      return { code: err.status ?? -1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` }
    }
  })()
  return result
}

function cleanupAll(pids: PidEntry[], label: string) {
  for (const { pid } of pids) {
    if (!isAlive(pid)) continue
    console.log(`[cleanup:${label}] pid ${pid} still alive, force-killing`)
    taskkillTree(pid)
  }
}

function spawnTree(pidFile: string) {
  if (existsSync(pidFile)) unlinkSync(pidFile)
  const child = spawn("bun", [treeScript, pidFile, "0"], { stdio: "ignore" })
  return child
}

async function main() {
  console.log("Bun.version:", Bun.version)
  console.log("process.platform/arch:", process.platform, process.arch)
  console.log("process.execPath:", process.execPath)
  console.log("import.meta.dir:", import.meta.dir)
  console.log("import.meta.dir-based treeScript exists?", existsSync(importMetaTreeScript), `(${importMetaTreeScript})`)
  console.log(`usingCwdFallback=${usingCwdFallback}, treeScript=${treeScript}, exists=${existsSync(treeScript)}`)

  // ---------------------------------------------------------------
  // STEP 3: baseline — kill only the top child, no job object at all
  // ---------------------------------------------------------------
  console.log("\n=== STEP 3: BASELINE (kill top child only, no mechanism) ===")
  const baselineFile = `${scriptDir}/baseline-pids.txt`
  const baselineChild: ChildProcess = spawnTree(baselineFile)
  const baselinePids = await waitForPidCount(baselineFile, 3)
  await sleep(500)
  console.log("spawned tree (depth:pid):", JSON.stringify(baselinePids))
  console.log(`top child pid (from ChildProcess) = ${baselineChild.pid}`)
  console.log(`killing ONLY the top child via ChildProcess#kill() (default signal)`)
  const baselineKillStart = Date.now()
  const killReturn = baselineChild.kill()
  console.log(`ChildProcess#kill() returned: ${killReturn}`)
  await sleep(1500)
  const baselineElapsed = Date.now() - baselineKillStart
  const baselineSurvivors = baselinePids.filter((p) => isAlive(p.pid))
  console.log(`after ${baselineElapsed}ms, liveness by pid:`, JSON.stringify(baselinePids.map((p) => ({ ...p, alive: isAlive(p.pid) }))))
  console.log(`BASELINE SURVIVOR COUNT: ${baselineSurvivors.length} of ${baselinePids.length} recorded pids`)
  cleanupAll(baselinePids, "baseline")
  await sleep(300)
  console.log("post-cleanup liveness:", JSON.stringify(baselinePids.map((p) => ({ ...p, alive: isAlive(p.pid) }))))

  // ---------------------------------------------------------------
  // STEP 4b: taskkill /T /F against a fresh tree, no job object
  // ---------------------------------------------------------------
  console.log("\n=== STEP 4b: taskkill /T /F /PID <top> (no job object) ===")
  const taskkillFile = `${scriptDir}/taskkill-pids.txt`
  const taskkillChild = spawnTree(taskkillFile)
  const taskkillPids = await waitForPidCount(taskkillFile, 3)
  await sleep(500)
  console.log("spawned tree (depth:pid):", JSON.stringify(taskkillPids))
  console.log(`running: taskkill /F /T /PID ${taskkillChild.pid}`)
  const tkStart = Date.now()
  const tkResult = taskkillTree(taskkillChild.pid!)
  const tkElapsedCmd = Date.now() - tkStart
  console.log(`taskkill exit code: ${tkResult.code} (took ${tkElapsedCmd}ms)`)
  console.log(`taskkill output verbatim:\n${tkResult.out}`)
  await sleep(500)
  const tkElapsedTotal = Date.now() - tkStart
  const taskkillLiveness = taskkillPids.map((p) => ({ ...p, alive: isAlive(p.pid) }))
  console.log(`after ${tkElapsedTotal}ms total, liveness by pid:`, JSON.stringify(taskkillLiveness))
  const taskkillSurvivors = taskkillLiveness.filter((p) => p.alive)
  console.log(`TASKKILL SURVIVOR COUNT: ${taskkillSurvivors.length} of ${taskkillPids.length} recorded pids (depth-1/2 were spawned with detached: true)`)
  cleanupAll(taskkillPids, "taskkill")

  // ---------------------------------------------------------------
  // STEP 4a + 5: Job Object via bun:ffi, with QueryInformationJobObject
  // as the confirmation mechanism (a read, not an inference).
  // ---------------------------------------------------------------
  console.log("\n=== STEP 4a + 5: Job Object via bun:ffi, with OS-confirmed exit ===")

  const PROCESS_TERMINATE = 0x0001
  const PROCESS_SET_QUOTA = 0x0100
  const JobObjectExtendedLimitInformation = 9
  const JobObjectBasicAccountingInformation = 1
  const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000

  const k32 = dlopen(`kernel32.${suffix}`, {
    CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
    AssignProcessToJobObject: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    SetInformationJobObject: {
      args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32],
      returns: FFIType.i32,
    },
    QueryInformationJobObject: {
      args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32, FFIType.ptr],
      returns: FFIType.i32,
    },
    OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
    TerminateJobObject: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
    GetLastError: { args: [], returns: FFIType.u32 },
  })
  console.log(`dlopen(kernel32.${suffix}) succeeded, symbols loaded:`, Object.keys(k32.symbols))

  const jobHandle = k32.symbols.CreateJobObjectW(null, null)
  console.log(`CreateJobObjectW -> handle=${jobHandle} GetLastError=${k32.symbols.GetLastError()}`)

  // JOBOBJECT_EXTENDED_LIMIT_INFORMATION is 144 bytes on x64:
  //   JOBOBJECT_BASIC_LIMIT_INFORMATION (64 bytes, LimitFlags DWORD at offset 16)
  //   + IO_COUNTERS (48 bytes, 6x UINT64)
  //   + 4x SIZE_T memory limit fields (32 bytes)
  // Verified by hand against winnt.h field layout + x64 alignment rules; only
  // the LimitFlags DWORD at offset 16 is non-zero (everything else stays 0).
  const extLimitBuf = new Uint8Array(144)
  new DataView(extLimitBuf.buffer).setUint32(16, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, true)
  const setInfoResult = k32.symbols.SetInformationJobObject(
    jobHandle,
    JobObjectExtendedLimitInformation,
    ptr(extLimitBuf),
    extLimitBuf.length,
  )
  console.log(`SetInformationJobObject(kill-on-close) -> ${setInfoResult} GetLastError=${k32.symbols.GetLastError()}`)

  const jobFile = `${scriptDir}/job-pids.txt`
  if (existsSync(jobFile)) unlinkSync(jobFile)
  const jobStart = Date.now()
  const jobChild = spawn("bun", [treeScript, jobFile, "0"], { stdio: "ignore" })
  console.log(`spawn() returned after ${Date.now() - jobStart}ms, child pid=${jobChild.pid}`)

  const procHandle = k32.symbols.OpenProcess(PROCESS_TERMINATE | PROCESS_SET_QUOTA, 0, jobChild.pid!)
  console.log(`OpenProcess -> handle=${procHandle} at +${Date.now() - jobStart}ms GetLastError=${k32.symbols.GetLastError()}`)

  const assignResult = k32.symbols.AssignProcessToJobObject(jobHandle, procHandle)
  console.log(`AssignProcessToJobObject -> ${assignResult} at +${Date.now() - jobStart}ms GetLastError=${k32.symbols.GetLastError()}`)

  const jobPids = await waitForPidCount(jobFile, 3)
  console.log(`tree fully spawned at +${Date.now() - jobStart}ms:`, JSON.stringify(jobPids))
  await sleep(500)

  function queryActiveProcesses(): number {
    const acctBuf = new Uint8Array(48)
    const retLenBuf = new Uint32Array(1)
    k32.symbols.QueryInformationJobObject(
      jobHandle,
      JobObjectBasicAccountingInformation,
      ptr(acctBuf),
      acctBuf.length,
      ptr(retLenBuf),
    )
    // JOBOBJECT_BASIC_ACCOUNTING_INFORMATION: ActiveProcesses is the DWORD at
    // offset 40 (4x LARGE_INTEGER = 32 bytes, then TotalPageFaultCount DWORD
    // at 32, TotalProcesses DWORD at 36, ActiveProcesses DWORD at 40).
    return new DataView(acctBuf.buffer).getUint32(40, true)
  }

  const activeBeforeKill = queryActiveProcesses()
  console.log(`QueryInformationJobObject ActiveProcesses BEFORE kill: ${activeBeforeKill} (expect 3)`)

  const killStart = Date.now()
  const termResult = k32.symbols.TerminateJobObject(jobHandle, 1)
  console.log(`TerminateJobObject -> ${termResult} GetLastError=${k32.symbols.GetLastError()}`)

  let activeAfterKill = -1
  let confirmMs = -1
  for (let i = 0; i < 100; i++) {
    activeAfterKill = queryActiveProcesses()
    if (activeAfterKill === 0) {
      confirmMs = Date.now() - killStart
      break
    }
    await sleep(50)
  }
  console.log(`QueryInformationJobObject ActiveProcesses reached 0 after ${confirmMs}ms (last read: ${activeAfterKill})`)

  await sleep(200)
  const jobLiveness = jobPids.map((p) => ({ ...p, alive: isAlive(p.pid) }))
  console.log("cross-check via process.kill(pid,0):", JSON.stringify(jobLiveness))
  console.log(
    `JOB OBJECT SURVIVOR COUNT: ${jobLiveness.filter((p) => p.alive).length} of ${jobPids.length} recorded pids ` +
      `(depth-1/2 were spawned with detached: true by the victim itself — CREATE_BREAKAWAY_FROM_JOB is not reachable ` +
      `from Bun's child_process API, so this also answers Step 4c: no code path exists for the victim to opt out of the job)`,
  )

  k32.symbols.CloseHandle(procHandle)
  k32.symbols.CloseHandle(jobHandle)
  cleanupAll(jobPids, "job-object")

  // ---------------------------------------------------------------
  // STEP 4a-ii: the actual "kill-on-close" path — CloseHandle with no
  // TerminateJobObject call at all. This is what the spec's phrase "Job
  // Object with kill-on-close" is really testing: if the controller process
  // itself crashes without running any cleanup code, does the OS still kill
  // every owned descendant on its own, with zero application code involved
  // in the kill? TerminateJobObject above was an explicit, code-driven kill;
  // this is the crash-safety net.
  // ---------------------------------------------------------------
  console.log("\n=== STEP 4a-ii: kill-on-close via bare CloseHandle (simulated controller crash) ===")
  const jobHandle2 = k32.symbols.CreateJobObjectW(null, null)
  const setInfoResult2 = k32.symbols.SetInformationJobObject(
    jobHandle2,
    JobObjectExtendedLimitInformation,
    ptr(extLimitBuf),
    extLimitBuf.length,
  )
  console.log(`second job: CreateJobObjectW handle=${jobHandle2}, SetInformationJobObject -> ${setInfoResult2}`)

  const jobFile2 = `${scriptDir}/job2-pids.txt`
  if (existsSync(jobFile2)) unlinkSync(jobFile2)
  const job2Start = Date.now()
  const jobChild2 = spawn("bun", [treeScript, jobFile2, "0"], { stdio: "ignore" })
  const procHandle2 = k32.symbols.OpenProcess(PROCESS_TERMINATE | PROCESS_SET_QUOTA, 0, jobChild2.pid!)
  const assignResult2 = k32.symbols.AssignProcessToJobObject(jobHandle2, procHandle2)
  console.log(`assign result=${assignResult2} at +${Date.now() - job2Start}ms`)

  const jobPids2 = await waitForPidCount(jobFile2, 3)
  console.log("tree fully spawned:", JSON.stringify(jobPids2), `at +${Date.now() - job2Start}ms`)
  await sleep(500)

  const activeBefore2 = (() => {
    const b = new Uint8Array(48)
    const r = new Uint32Array(1)
    k32.symbols.QueryInformationJobObject(jobHandle2, JobObjectBasicAccountingInformation, ptr(b), b.length, ptr(r))
    return new DataView(b.buffer).getUint32(40, true)
  })()
  console.log("ActiveProcesses before CloseHandle:", activeBefore2)

  console.log("closing the ONLY job handle, no TerminateJobObject call — this is the real kill-on-close path")
  const closeStart = Date.now()
  const closeResult = k32.symbols.CloseHandle(jobHandle2)
  console.log(`CloseHandle -> ${closeResult}, GetLastError=${k32.symbols.GetLastError()}`)

  // We no longer hold a job handle, so QueryInformationJobObject is not an
  // option anymore. The only confirmation available from *this* process is
  // PID liveness polling — precisely the mechanism Step 2 flagged as unsound
  // on Windows because PIDs are reused. Poll it anyway, to record how long
  // kill-on-close actually takes in wall-clock terms.
  let closeConfirmMs = -1
  for (let i = 0; i < 100; i++) {
    const stillAlive = jobPids2.filter((p) => isAlive(p.pid))
    if (stillAlive.length === 0) {
      closeConfirmMs = Date.now() - closeStart
      break
    }
    await sleep(50)
  }
  const finalLiveness2 = jobPids2.map((p) => ({ ...p, alive: isAlive(p.pid) }))
  console.log(`kill-on-close: all pids dead (by liveness poll) after ${closeConfirmMs}ms:`, JSON.stringify(finalLiveness2))
  console.log(
    "CAVEAT: this confirmation used process.kill(pid,0) liveness polling, NOT a job-object read, because " +
      "CloseHandle invalidated our only handle to the job. A controller that crashes (the real scenario " +
      "kill-on-close protects against) leaves nobody holding a handle to query afterward — a supervisor " +
      "wanting a genuine read-based confirmation after a crash would need either an independent second " +
      "handle (which changes exactly when kill-on-close fires, since it fires on the LAST handle closing) " +
      "or a named job object it can attempt to reopen, racing object teardown. This spike surfaces that " +
      "question; it does not resolve it.",
  )
  k32.symbols.CloseHandle(procHandle2)
  cleanupAll(jobPids2, "kill-on-close")

  console.log("\n=== DONE ===")
}

main().catch((e) => {
  console.error("PROBE CRASHED:", e)
  process.exit(1)
})
