// Spike H probe (Codex half): does Codex's `workspace-write` sandbox actually
// silently downgrade to read-only on Windows, and can a scratch-dir write-probe
// tell the three sandbox modes apart *before* a real turn runs?
//
// This is throwaway evidence-gathering code, not product code. It is never
// imported by anything under src/. See ../FINDINGS.md for the recorded result.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as errore from 'errore'
import { Codex, type SandboxMode, type ThreadItem, type Turn } from '@openai/codex-sdk'

const PROBE_FILE = 'probe.txt'
const PROBE_TEXT = 'PROBE_OK'

class CodexTurnError extends errore.createTaggedError({
  name: 'CodexTurnError',
  message: 'Codex turn failed for sandboxMode $mode',
}) {}

type ProbeResult = {
  mode: SandboxMode
  scratchDir: string
  fileAppeared: boolean
  fileContent: string | null
  finalResponse: string
  items: ThreadItem[]
  turnFailed: boolean
  errorMessage: string | null
}

/**
 * Health-check probe: the only reliable way to answer "is the sandbox
 * effective?" is to inspect the filesystem after the turn, not the
 * transcript. An agent can (and, per this probe, sometimes does) report
 * success in `finalResponse` while writing nothing.
 */
function checkScratchWrite(scratchDir: string): {
  fileAppeared: boolean
  fileContent: string | null
} {
  const target = path.join(scratchDir, PROBE_FILE)
  const fileAppeared = fs.existsSync(target)
  const fileContent = fileAppeared ? fs.readFileSync(target, 'utf-8') : null
  return { fileAppeared, fileContent }
}

async function runProbe(mode: SandboxMode): Promise<CodexTurnError | ProbeResult> {
  const scratchDir = fs.mkdtempSync(
    path.join(os.tmpdir(), `termcraft-codex-${mode}-`),
  )

  const codex = new Codex()
  const thread = codex.startThread({
    workingDirectory: scratchDir,
    sandboxMode: mode,
    skipGitRepoCheck: true,
    approvalPolicy: 'never',
    networkAccessEnabled: false,
  })

  const turn: CodexTurnError | Turn = await thread
    .run(
      `Write the exact text ${PROBE_TEXT} to a new file named ${PROBE_FILE} in the current working directory. Do that and nothing else. Report success or failure plainly.`,
    )
    .catch((e) => new CodexTurnError({ mode, cause: e }))
  if (turn instanceof Error) return turn

  const { fileAppeared, fileContent } = checkScratchWrite(scratchDir)

  const errorItem = turn.items.find((item) => item.type === 'error')

  return {
    mode,
    scratchDir,
    fileAppeared,
    fileContent,
    finalResponse: turn.finalResponse,
    items: turn.items,
    turnFailed: Boolean(errorItem),
    errorMessage: errorItem && 'message' in errorItem ? errorItem.message : null,
  }
}

async function main() {
  const modes: SandboxMode[] = ['workspace-write', 'danger-full-access', 'read-only']
  const summaries: Array<{
    mode: SandboxMode
    fileAppeared: boolean
    turnFailed: boolean
    finalResponseClaimsSuccess: boolean
    crashed: boolean
  }> = []

  for (const mode of modes) {
    console.log(`\n=== Probing sandboxMode: ${mode} ===`)
    const result = await runProbe(mode)

    if (result instanceof Error) {
      console.warn(`Turn threw for mode ${mode}:`, result.message, result.cause)
      summaries.push({
        mode,
        fileAppeared: false,
        turnFailed: true,
        finalResponseClaimsSuccess: false,
        crashed: true,
      })
      continue
    }

    console.log(`scratchDir: ${result.scratchDir}`)
    console.log(`fileAppeared: ${result.fileAppeared}`)
    console.log(`fileContent: ${JSON.stringify(result.fileContent)}`)
    console.log(`turnFailed: ${result.turnFailed}`)
    console.log(`errorMessage: ${result.errorMessage}`)
    console.log(`finalResponse: ${result.finalResponse}`)
    console.log(`items: ${JSON.stringify(result.items, null, 2)}`)

    summaries.push({
      mode: result.mode,
      fileAppeared: result.fileAppeared,
      turnFailed: result.turnFailed,
      finalResponseClaimsSuccess: /wrote|created|success|done/i.test(
        result.finalResponse,
      ),
      crashed: false,
    })
  }

  console.log('\n=== Summary ===')
  console.log(JSON.stringify(summaries, null, 2))
}

main().catch((e) => {
  console.error('FATAL:', e)
  process.exit(1)
})
