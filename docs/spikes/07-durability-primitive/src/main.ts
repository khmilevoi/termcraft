// Spike G — the Windows durability primitive.
//
// SCOPE: This is NOT a crash-durability test. `kill -9` / power-loss testing
// proves nothing here because the OS page cache outlives the process. This
// probe only answers three questions, empirically, on the running Windows
// machine:
//   1. Does a directory-flush API exist on Windows from Bun, and what is it?
//   2. What does the full six-step install sequence (design §4.2) cost?
//   3. Can an unsupported volume be detected before mutation?
//
// Every finding below is the literal output of running this file on Windows
// 11 with the installed Bun/Node runtime — nothing here is aspirational.

import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { dlopen, FFIType, suffix, ptr, CString } from "bun:ffi"

// ---------------------------------------------------------------------------
// utilities
// ---------------------------------------------------------------------------

function log(record: unknown) {
  console.log(JSON.stringify(record))
}

function sha256(buf: Uint8Array): string {
  return crypto.createHash("sha256").update(buf).digest("hex")
}

function toWideString(str: string): Buffer {
  // CreateFileW / GetDriveTypeW take UTF-16LE, NUL-terminated. bun:ffi's
  // FFIType.cstring encodes JS strings as UTF-8/Latin1 narrow strings, which
  // is wrong for the *W Win32 APIs. We build the wide buffer by hand and
  // pass FFIType.ptr instead of FFIType.cstring.
  return Buffer.from(str + "\0", "utf16le")
}

// FINDING: `import.meta.dir` resolves to the virtual bundle root ("\") inside
// a `bun build --compile` binary, not the real on-disk directory, and
// mkdirSync against it fails with EPERM. `process.cwd()` is the reliable
// choice for a compiled binary's real filesystem location.
const scratchRoot = path.join(process.cwd(), ".scratch")
fs.mkdirSync(scratchRoot, { recursive: true })

// ---------------------------------------------------------------------------
// Step 0: environment record
// ---------------------------------------------------------------------------

log({
  section: "environment",
  platform: process.platform,
  arch: process.arch,
  bunVersion: Bun.version,
  bunRevision: (Bun as unknown as { revision?: string }).revision ?? null,
  nodeCompat: process.version,
})

// ---------------------------------------------------------------------------
// Step 2: file-level steps of the six-step sequence, on their own
// ---------------------------------------------------------------------------

function step2Probe() {
  const dir = path.join(scratchRoot, "step2")
  fs.mkdirSync(dir, { recursive: true })
  const target = path.join(dir, "target.bin")
  const payload = crypto.randomBytes(4096)

  // fresh install (no existing target)
  const first = installFileOnly(dir, "target.bin", payload)
  log({ section: "step2", phase: "first-install", ...first })

  // second install over an EXISTING target — the case the brief calls out:
  // POSIX rename replaces; Win32 MoveFile without MOVEFILE_REPLACE_EXISTING
  // does not.
  const payload2 = crypto.randomBytes(4096)
  const second = installFileOnly(dir, "target.bin", payload2)
  log({ section: "step2", phase: "second-install-over-existing", ...second })

  // final verification: does the realized file match payload2's hash?
  const finalBytes = fs.readFileSync(target)
  log({
    section: "step2",
    phase: "final-verify",
    sizeMatches: finalBytes.length === payload2.length,
    hashMatches: sha256(finalBytes) === sha256(payload2),
  })
}

interface StepRecord {
  ok: boolean
  code?: string
  message?: string
}

function installFileOnly(
  dir: string,
  targetName: string,
  payload: Uint8Array,
): { steps: Record<string, StepRecord> } {
  const steps: Record<string, StepRecord> = {}
  const tmpName = `.tmp-${targetName}-${process.pid}-${crypto.randomBytes(4).toString("hex")}`
  const tmpPath = path.join(dir, tmpName)
  const targetPath = path.join(dir, targetName)

  // Step 1: create a reserved temporary regular file with create-new semantics.
  let fd: number
  try {
    fd = fs.openSync(tmpPath, "wx")
    steps.createNew = { ok: true }
  } catch (e) {
    steps.createNew = { ok: false, code: (e as NodeJS.ErrnoException).code, message: (e as Error).message }
    return { steps }
  }

  // Step 2: write all bytes, flush file contents and metadata, close it.
  try {
    fs.writeSync(fd, payload)
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    steps.writeFlushClose = { ok: true }
  } catch (e) {
    steps.writeFlushClose = { ok: false, code: (e as NodeJS.ErrnoException).code, message: (e as Error).message }
    return { steps }
  }

  // Step 3: reopen "without following links", verify regular-file identity,
  // size, and SHA-256.
  //
  // FINDING: node:fs on Windows does not define O_NOFOLLOW (confirmed:
  // fs.constants.O_NOFOLLOW is `undefined`). Win32 CreateFile follows
  // reparse points on open unless FILE_FLAG_OPEN_REPARSE_POINT is passed,
  // and Node's fs.openSync never passes that flag. The practical Windows
  // substitute used here is lstatSync (which does NOT traverse the final
  // symlink/reparse point) checked BEFORE opening, combined with an
  // isFile() check on the open fd's fstat. This is weaker than a true
  // O_NOFOLLOW open: there is a narrow TOCTOU window between the lstat and
  // the open where the leaf could be swapped for a reparse point. That gap
  // is recorded here, not hidden.
  try {
    const lst = fs.lstatSync(tmpPath)
    const reopenFd = fs.openSync(tmpPath, "r")
    const st = fs.fstatSync(reopenFd)
    const bytes = fs.readFileSync(reopenFd)
    fs.closeSync(reopenFd)
    steps.reopenVerify = {
      ok: lst.isSymbolicLink() === false && st.isFile() && bytes.length === payload.length && sha256(bytes) === sha256(payload),
    }
  } catch (e) {
    steps.reopenVerify = { ok: false, code: (e as NodeJS.ErrnoException).code, message: (e as Error).message }
    return { steps }
  }

  // Step 4: replace or install the target with the platform's
  // same-directory primitive (renameSync).
  try {
    fs.renameSync(tmpPath, targetPath)
    steps.rename = { ok: true }
  } catch (e) {
    steps.rename = { ok: false, code: (e as NodeJS.ErrnoException).code, message: (e as Error).message }
    return { steps }
  }

  return { steps }
}

// ---------------------------------------------------------------------------
// Step 3: three attempts to flush the directory
// ---------------------------------------------------------------------------

// --- (a) POSIX-shaped path: open the directory, fsync its fd ---
function tryPosixDirFsync(dir: string): { approach: string; ok: boolean; code?: string; message?: string } {
  try {
    const fd = fs.openSync(dir, "r")
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    return { approach: "open+fsync", ok: true }
  } catch (e) {
    return {
      approach: "open+fsync",
      ok: false,
      code: (e as NodeJS.ErrnoException).code,
      message: (e as Error).message,
    }
  }
}

// --- kernel32 FFI bindings, shared by (b) and Step 4 ---
const GENERIC_READ = 0x80000000
const FILE_SHARE_READ = 0x1
const FILE_SHARE_WRITE = 0x2
const OPEN_EXISTING = 3
const FILE_FLAG_BACKUP_SEMANTICS = 0x02000000
const INVALID_HANDLE_VALUE = -1n // as a 64-bit signed sentinel; compared via BigInt below

let k32: ReturnType<typeof dlopen> | null = null
let k32Error: string | null = null
try {
  k32 = dlopen(`kernel32.${suffix}`, {
    CreateFileW: {
      args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr],
      returns: FFIType.ptr,
    },
    FlushFileBuffers: { args: [FFIType.ptr], returns: FFIType.i32 },
    CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
    GetLastError: { args: [], returns: FFIType.u32 },
    GetDriveTypeW: { args: [FFIType.ptr], returns: FFIType.u32 },
  })
} catch (e) {
  k32Error = (e as Error).message
}

function isInvalidHandle(h: unknown): boolean {
  // bun:ffi returns pointers as `number | bigint | null` depending on
  // magnitude. INVALID_HANDLE_VALUE is (void*)-1, i.e. all-ones.
  if (h === null) return true
  if (typeof h === "bigint") return h === 0xffffffffffffffffn
  if (typeof h === "number") return h === -1
  return false
}

const GENERIC_WRITE = 0x40000000

function openDirHandle(dirPath: string, desiredAccess: number = GENERIC_READ): { handle: unknown; ok: boolean; lastError?: number } {
  if (!k32) return { handle: null, ok: false }
  const wide = toWideString(dirPath)
  const handle = k32.symbols.CreateFileW(
    ptr(wide),
    desiredAccess,
    FILE_SHARE_READ | FILE_SHARE_WRITE,
    null,
    OPEN_EXISTING,
    FILE_FLAG_BACKUP_SEMANTICS,
    null,
  )
  if (isInvalidHandle(handle)) {
    const lastError = k32.symbols.GetLastError()
    return { handle, ok: false, lastError }
  }
  return { handle, ok: true }
}

// --- (b) Win32 mechanism: CreateFileW(FILE_FLAG_BACKUP_SEMANTICS) + FlushFileBuffers on the directory handle ---
function tryWin32DirFlush(dir: string): {
  approach: string
  ok: boolean
  lastError?: number
  message?: string
  ffiLoadError?: string
} {
  if (!k32) {
    return { approach: "CreateFileW+FlushFileBuffers", ok: false, ffiLoadError: k32Error ?? "unknown dlopen failure" }
  }
  // FINDING: opening the directory handle with GENERIC_READ (or
  // GENERIC_READ|GENERIC_WRITE, or 0) lets CreateFileW succeed but
  // FlushFileBuffers then fails with GetLastError()==5 (ERROR_ACCESS_DENIED).
  // Only GENERIC_WRITE alone makes FlushFileBuffers succeed. Verified
  // reproducible across repeated runs (see src/try-genwrite.ts). This is not
  // documented clearly in the CreateFile/FlushFileBuffers MSDN pages; it was
  // found empirically by trying all four DesiredAccess combinations.
  const opened = openDirHandle(dir, GENERIC_WRITE)
  if (!opened.ok) {
    return {
      approach: "CreateFileW+FlushFileBuffers",
      ok: false,
      lastError: opened.lastError,
      message: `CreateFileW failed, GetLastError=${opened.lastError}`,
    }
  }
  const flushResult = k32.symbols.FlushFileBuffers(opened.handle as never)
  const flushLastError = flushResult === 0 ? k32.symbols.GetLastError() : undefined
  k32.symbols.CloseHandle(opened.handle as never)
  return {
    approach: "CreateFileW+FlushFileBuffers",
    ok: flushResult !== 0,
    lastError: flushLastError,
  }
}

// --- (c) FILE_FLAG_WRITE_THROUGH on the file itself (fallback, weaker guarantee) ---
const CREATE_ALWAYS = 2
const FILE_FLAG_WRITE_THROUGH = 0x80000000

function tryFileWriteThrough(filePath: string, payload: Uint8Array): {
  approach: string
  ok: boolean
  lastError?: number
  message?: string
} {
  if (!k32) return { approach: "FILE_FLAG_WRITE_THROUGH", ok: false, message: "kernel32 not loaded" }
  const wide = toWideString(filePath)
  const handle = k32.symbols.CreateFileW(
    ptr(wide),
    GENERIC_WRITE,
    0,
    null,
    CREATE_ALWAYS,
    FILE_FLAG_WRITE_THROUGH,
    null,
  )
  if (isInvalidHandle(handle)) {
    return { approach: "FILE_FLAG_WRITE_THROUGH", ok: false, lastError: k32.symbols.GetLastError() }
  }
  // We don't have WriteFile bound; the point of this probe is only to prove
  // the handle-open path exists and to record that it is a FILE guarantee,
  // not a DIRECTORY (i.e. rename-durability) guarantee.
  k32.symbols.CloseHandle(handle as never)
  return { approach: "FILE_FLAG_WRITE_THROUGH", ok: true, message: "handle opened; this is a file-level guarantee, NOT a directory/rename flush" }
}

function step3Probe() {
  const dir = path.join(scratchRoot, "step3")
  fs.mkdirSync(dir, { recursive: true })
  const filePath = path.join(dir, "wt-test.bin")

  const a = tryPosixDirFsync(dir)
  log({ section: "step3", ...a })

  const b = tryWin32DirFlush(dir)
  log({ section: "step3", ...b })

  const c = tryFileWriteThrough(filePath, crypto.randomBytes(4096))
  log({ section: "step3", ...c })
}

// ---------------------------------------------------------------------------
// Step 4: unsupported-volume detectability
// ---------------------------------------------------------------------------

const DRIVE_TYPE_NAMES: Record<number, string> = {
  0: "DRIVE_UNKNOWN",
  1: "DRIVE_NO_ROOT_DIR",
  2: "DRIVE_REMOVABLE",
  3: "DRIVE_FIXED",
  4: "DRIVE_REMOTE",
  5: "DRIVE_CDROM",
  6: "DRIVE_RAMDISK",
}

function step4Probe() {
  // Local fixed volume, for contrast.
  const localRoot = path.parse(scratchRoot).root // e.g. "C:\\"
  if (k32) {
    const wide = toWideString(localRoot)
    const t = k32.symbols.GetDriveTypeW(ptr(wide))
    log({ section: "step4", target: "local-fixed-volume", root: localRoot, driveType: t, driveTypeName: DRIVE_TYPE_NAMES[t] ?? "?" })
  }

  // UNC path — the loopback admin share \\localhost\c$ is reachable on this
  // machine (verified with `Test-Path` before running this probe) and gives
  // an honest DRIVE_REMOTE target without requiring an actual second host.
  // If it were not reachable, this section would report that plainly
  // instead of inventing a result.
  const uncDir = `\\\\localhost\\c$\\Users\\${process.env.USERNAME}\\AppData\\Local\\Temp\\termcraft-spike07-unc`
  fs.mkdirSync(uncDir, { recursive: true })

  if (k32) {
    const uncRoot = `\\\\localhost\\c$\\`
    const wide = toWideString(uncRoot)
    const t = k32.symbols.GetDriveTypeW(ptr(wide))
    log({ section: "step4", target: "unc-share", root: uncRoot, driveType: t, driveTypeName: DRIVE_TYPE_NAMES[t] ?? "?" })
  }

  // Does CreateFileW+FILE_FLAG_BACKUP_SEMANTICS succeed against the UNC directory?
  // Uses GENERIC_WRITE, the access mode Step 3(b) found necessary for
  // FlushFileBuffers to succeed at all (see finding above tryWin32DirFlush).
  const uncHandleResult = openDirHandle(uncDir, GENERIC_WRITE)
  log({ section: "step4", target: "unc-share", check: "CreateFileW(BACKUP_SEMANTICS, GENERIC_WRITE) on UNC dir", ok: uncHandleResult.ok, lastError: uncHandleResult.lastError })
  if (uncHandleResult.ok && k32) {
    const flushResult = k32.symbols.FlushFileBuffers(uncHandleResult.handle as never)
    const flushLastError = flushResult === 0 ? k32.symbols.GetLastError() : undefined
    k32.symbols.CloseHandle(uncHandleResult.handle as never)
    log({ section: "step4", target: "unc-share", check: "FlushFileBuffers on UNC dir handle", ok: flushResult !== 0, lastError: flushLastError })
  }

  // Does the ordinary file-level sequence (steps 1-4 of §4.2) succeed on the UNC path?
  const fileResult = installFileOnly(uncDir, "unc-target.bin", crypto.randomBytes(4096))
  log({ section: "step4", target: "unc-share", check: "file-level install sequence on UNC dir", steps: fileResult.steps })

  // cleanup
  try {
    fs.rmSync(uncDir, { recursive: true, force: true })
  } catch {
    // best-effort cleanup; not part of the finding
  }
}

// ---------------------------------------------------------------------------
// Step 5: measure the full six-step sequence
// ---------------------------------------------------------------------------

function fullSixStepInstall(dir: string, targetName: string, payload: Uint8Array, dirFlush: () => boolean): boolean {
  const tmpName = `.tmp-${targetName}-${process.pid}-${crypto.randomBytes(4).toString("hex")}`
  const tmpPath = path.join(dir, tmpName)
  const targetPath = path.join(dir, targetName)

  // 1
  const fd = fs.openSync(tmpPath, "wx")
  // 2
  fs.writeSync(fd, payload)
  fs.fsyncSync(fd)
  fs.closeSync(fd)
  // 3
  fs.lstatSync(tmpPath)
  const reopenFd = fs.openSync(tmpPath, "r")
  const bytes = fs.readFileSync(reopenFd)
  fs.closeSync(reopenFd)
  const preHash = sha256(bytes)
  if (preHash !== sha256(payload)) throw new Error("pre-rename hash mismatch")
  // 4
  fs.renameSync(tmpPath, targetPath)
  // 5
  const flushed = dirFlush()
  if (!flushed) throw new Error("directory flush failed")
  // 6
  const finalBytes = fs.readFileSync(targetPath)
  if (sha256(finalBytes) !== sha256(payload)) throw new Error("post-rename hash mismatch")
  return true
}

function step5Probe() {
  const dir = path.join(scratchRoot, "step5")
  fs.mkdirSync(dir, { recursive: true })

  const dirFlush = () => {
    const r = tryWin32DirFlush(dir)
    return r.ok
  }

  const iterations = 20
  const timingsMs: number[] = []
  for (let i = 0; i < iterations; i++) {
    const payload = crypto.randomBytes(4096)
    const t0 = performance.now()
    fullSixStepInstall(dir, `payload-${i}.bin`, payload, dirFlush)
    const t1 = performance.now()
    timingsMs.push(t1 - t0)
  }
  const sorted = [...timingsMs].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  const worst = sorted[sorted.length - 1]
  const best = sorted[0]
  const mean = timingsMs.reduce((a, b) => a + b, 0) / timingsMs.length

  log({
    section: "step5",
    iterations,
    allMs: timingsMs.map((n) => Math.round(n * 1000) / 1000),
    medianMs: median,
    worstMs: worst,
    bestMs: best,
    meanMs: mean,
    tenOperationTransactionEstimateMs: median * 20, // per §4.3: up to ~20 flushed files per 10-op transaction
  })
}

// ---------------------------------------------------------------------------
// run all
// ---------------------------------------------------------------------------

step2Probe()
step3Probe()
step4Probe()
step5Probe()

log({ section: "done" })
