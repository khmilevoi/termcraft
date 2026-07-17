// Spike F probe: Windows file identity (dev/ino) and link detection.
// Throwaway diagnostic script. Not product code. Prints JSON section
// markers to stdout; FINDINGS.md is built from this output verbatim.

import {
  statSync,
  lstatSync,
  realpathSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  existsSync,
  rmSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { execSync } from "node:child_process"

function log(section: string, data: unknown) {
  console.log(`### ${section}`)
  console.log(JSON.stringify(data, null, 2))
}

function runCapture(cmd: string): { ok: true; stdout: string } | { ok: false; error: string } {
  try {
    const stdout = execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
    return { ok: true, stdout: stdout.toString() }
  } catch (e) {
    const err = e as { message?: string; stdout?: Buffer | string; stderr?: Buffer | string }
    const stderr = err.stderr ? err.stderr.toString() : ""
    const stdout = err.stdout ? err.stdout.toString() : ""
    return { ok: false, error: [err.message, stdout, stderr].filter(Boolean).join(" | ") }
  }
}

function identityOf(path: string) {
  const s = statSync(path, { bigint: true })
  return {
    dev: s.dev.toString(),
    ino: s.ino.toString(),
    devHex: s.dev.toString(16),
    inoHex: s.ino.toString(16),
    nlink: s.nlink.toString(),
  }
}

// ---------------------------------------------------------------------------
// Step 2: what does stat actually report on Windows
// ---------------------------------------------------------------------------
function step2_identity() {
  const dir = mkdtempSync(join(tmpdir(), "tc-id-"))
  const s = statSync(dir, { bigint: true })
  const dump = {
    dir,
    dev: s.dev.toString(),
    ino: s.ino.toString(),
    devHex: s.dev.toString(16),
    inoHex: s.ino.toString(16),
    nlink: s.nlink.toString(),
  }
  log("STEP2_IDENTITY", dump)

  // non-bigint variant, to see whether it truncates/differs
  const sNum = statSync(dir)
  log("STEP2_IDENTITY_NONBIGINT", {
    dir,
    dev: sNum.dev,
    ino: sNum.ino,
    devHex: sNum.dev.toString(16),
    // ino as a JS number loses precision above 2^53; report both forms
    inoAsNumber: sNum.ino,
    inoAsNumberHex: Number.isSafeInteger(sNum.ino) ? sNum.ino.toString(16) : "UNSAFE_INTEGER",
  })

  // volume serial comparison
  const vol = runCapture("cmd /c vol C:")
  log("STEP2_VOL_C", vol)

  // stability across: re-stat same dir, create a file inside, re-stat again
  const before = identityOf(dir)
  writeFileSync(join(dir, "probe-file.txt"), "hello")
  const afterFileCreate = identityOf(dir)
  const reopened = identityOf(dir) // simulate "reopening" by re-statting fresh
  log("STEP2_STABILITY_SAME_PROCESS", { before, afterFileCreate, reopened })

  return dir
}

// ---------------------------------------------------------------------------
// Step 3: does ino move under git operations / editor-style atomic write
// ---------------------------------------------------------------------------
function step3_gitStability(workDir: string) {
  const base = mkdtempSync(join(tmpdir(), "tc-git-"))
  const repo = join(base, "repo")
  mkdirSync(repo)

  const gitInit = runCapture(`cmd /c "cd /d ${repo} && git init"`)
  const inoAfterInit = identityOf(repo)

  const commit1 = runCapture(
    `cmd /c "cd /d ${repo} && git -c user.email=spike@example.com -c user.name=spike commit --allow-empty -m one"`,
  )
  const inoAfterCommit1 = identityOf(repo)

  const checkout = runCapture(`cmd /c "cd /d ${repo} && git checkout -b other"`)
  const inoAfterCheckout = identityOf(repo)

  const commit2 = runCapture(
    `cmd /c "cd /d ${repo} && git -c user.email=spike@example.com -c user.name=spike commit --allow-empty -m two"`,
  )
  const inoAfterCommit2 = identityOf(repo)

  // editor-style atomic write: write temp file, rename over a target file
  const target = join(repo, "file.txt")
  writeFileSync(target, "v1")
  const inoAfterInitialWrite = identityOf(repo)

  const tmpFile = join(repo, "file.txt.tmp")
  writeFileSync(tmpFile, "v2")
  renameSync(tmpFile, target)
  const inoAfterAtomicRename = identityOf(repo)

  log("STEP3_GIT_STABILITY", {
    repo,
    gitInit,
    inoAfterInit,
    commit1,
    inoAfterCommit1,
    checkout,
    inoAfterCheckout,
    commit2,
    inoAfterCommit2,
    inoAfterInitialWrite,
    inoAfterAtomicRename,
    allInoValues: [
      inoAfterInit.ino,
      inoAfterCommit1.ino,
      inoAfterCheckout.ino,
      inoAfterCommit2.ino,
      inoAfterInitialWrite.ino,
      inoAfterAtomicRename.ino,
    ],
    allDevValues: [
      inoAfterInit.dev,
      inoAfterCommit1.dev,
      inoAfterCheckout.dev,
      inoAfterCommit2.dev,
      inoAfterInitialWrite.dev,
      inoAfterAtomicRename.dev,
    ],
  })

  return base
}

// ---------------------------------------------------------------------------
// Step 4: build all four link types, record what fs says about each
// ---------------------------------------------------------------------------
function inspect(path: string) {
  if (!existsSync(path)) return { path, exists: false }
  try {
    const l = lstatSync(path, { bigint: true })
    const rp = (() => {
      try {
        return realpathSync(path)
      } catch (e) {
        return `ERROR: ${(e as Error).message}`
      }
    })()
    return {
      path,
      exists: true,
      isSymbolicLink: l.isSymbolicLink(),
      isDirectory: l.isDirectory(),
      isFile: l.isFile(),
      nlink: l.nlink.toString(),
      ino: l.ino.toString(),
      dev: l.dev.toString(),
      realpath: rp,
    }
  } catch (e) {
    return { path, exists: true, error: (e as Error).message }
  }
}

function step4_links() {
  const base = mkdtempSync(join(tmpdir(), "tc-links-"))
  const target = join(base, "target")
  const junction = join(base, "junction")
  const symlinkdir = join(base, "symlinkdir")
  const fileTxt = join(base, "file.txt")
  const hardlink = join(base, "hardlink.txt")

  mkdirSync(target)
  writeFileSync(join(target, "inside.txt"), "inside target dir")

  const mkJunction = runCapture(`cmd /c mklink /J "${junction}" "${target}"`)
  const mkSymlinkDir = runCapture(`cmd /c mklink /D "${symlinkdir}" "${target}"`)
  writeFileSync(fileTxt, "hi")
  const mkHardlink = runCapture(`cmd /c mklink /H "${hardlink}" "${fileTxt}"`)

  const results = {
    base,
    mkJunction,
    mkSymlinkDir,
    mkHardlink,
    target: inspect(target),
    junction: inspect(junction),
    symlinkdir: inspect(symlinkdir),
    fileTxt: inspect(fileTxt),
    hardlink: inspect(hardlink),
  }

  log("STEP4_LINKS", results)
  return base
}

// ---------------------------------------------------------------------------
// Step 5: try to escape a project root via a junction
// ---------------------------------------------------------------------------
function step5_escape() {
  const base = mkdtempSync(join(tmpdir(), "tc-escape-"))
  const root = join(base, "project-root")
  const outside = join(base, "outside-secret")
  mkdirSync(root)
  mkdirSync(outside)
  writeFileSync(join(outside, "secret.txt"), "top secret, should not be reachable")

  const escapeJunction = join(root, "escape-junction")
  const mk = runCapture(`cmd /c mklink /J "${escapeJunction}" "${outside}"`)

  // naive resolution: join(root, rel) then read
  const rel = "escape-junction/secret.txt"
  const naiveJoined = join(root, rel)

  const naiveRealpath = (() => {
    try {
      return realpathSync(naiveJoined)
    } catch (e) {
      return `ERROR: ${(e as Error).message}`
    }
  })()

  // The check that should work: after resolving realpath, verify the
  // resolved path is still prefixed by the realpath of root (not the raw
  // root string, since root itself could theoretically be a link too).
  const rootReal = realpathSync(root)
  const resolvedIsInsideRoot =
    typeof naiveRealpath === "string" &&
    !naiveRealpath.startsWith("ERROR") &&
    (naiveRealpath === rootReal || naiveRealpath.startsWith(rootReal + "\\"))

  // Also check: does lstat on the junction itself reveal it before we ever
  // resolve realpath (i.e. can we catch it by walking path segments and
  // lstat-ing each one, without needing realpath at all)?
  const junctionLstat = inspect(escapeJunction)

  const result = {
    base,
    root,
    outside,
    mk,
    rel,
    naiveJoined,
    naiveRealpath,
    rootReal,
    resolvedIsInsideRoot,
    junctionLstat,
  }

  log("STEP5_ESCAPE", result)
  return base
}

function main() {
  const dir2 = step2_identity()
  step3_gitStability(dir2)
  step4_links()
  step5_escape()
  console.log("### DONE")
}

main()
