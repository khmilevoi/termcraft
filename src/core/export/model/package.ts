import type { RuntimeDeclarationBundleV1 } from "core/ports"
import type { FailureDtoV1 } from "core/protocol"

import type { ExportSnapshotV1 } from "../types"
import type { ExportRenderJobResultV1 } from "./render-jobs"

/**
 * Export package assembly (kernel-command-contract §7.5/§12.5; storage-identity §5.2;
 * runtime-api-compatibility §12): `design-prompt.md`, `pages/<slug>/page.tsx`,
 * `snapshots/<slug>/<w>x<h>.txt`, `layout/<slug>.json`, and `runtime-api.json` — assembled
 * as an IN-MEMORY file list. This module never touches disk (`core` has no disk access);
 * `ExportPublishTransaction` writing these bytes durably is a later slice's job.
 *
 * KNOWN DIVERGENCE (mvp-phase-6-core plan §5, verbatim): "`layout/<page>.json` in the
 * export package ships **unpopulated** — the conformant correlated capture awaits the 2A
 * bulk schema." This function therefore NEVER writes a render's own `layout` bytes into
 * that file — doing so would be a non-conformant, per-size layout masquerading as the
 * correlated per-page tree the 2A schema is meant to produce. Every `layout/<slug>.json`
 * is the literal two-byte stub `{}` instead, so a reader can tell "empty by design" apart
 * from "empty because something broke."
 *
 * ALL RENDERS MUST HAVE SUCCEEDED (§7.5: "`beginPublication` ... All page/size renders
 * succeeded"). This function refuses wholesale on the first failed render it finds rather
 * than assembling a package with a missing size — the caller decides what happens next
 * (typically: never call `publishExport` at all).
 */

export interface ExportPackageFileV1 {
  readonly relPath: string
  readonly bytes: Uint8Array
}

export interface AssembleExportPackageInputV1 {
  readonly snapshot: ExportSnapshotV1
  readonly renders: readonly ExportRenderJobResultV1[]
  readonly runtimeDeclaration: RuntimeDeclarationBundleV1
}

export type AssembleExportPackageResultV1 =
  | { readonly kind: "failed"; readonly failure: FailureDtoV1 }
  | { readonly kind: "assembled"; readonly files: readonly ExportPackageFileV1[] }

function textFile(relPath: string, text: string): ExportPackageFileV1 {
  return { relPath, bytes: new TextEncoder().encode(text) }
}

function sizeLabel(size: { readonly w: number; readonly h: number }): string {
  return `${size.w}x${size.h}`
}

function buildDesignPrompt(input: AssembleExportPackageInputV1): string {
  const lines: string[] = [
    "# Design Prompt",
    "",
    "This package is the exported design for the current project. Every listed snapshot",
    "file is an acceptance fixture: your implementation at that exact size must render",
    "output matching it — diff your output against it.",
    "",
    "## Pages",
    "",
  ]

  for (const page of input.snapshot.pages) {
    lines.push(`### ${page.pageSlug}`)
    lines.push("")
    lines.push(`- theme: ${page.theme}`)
    lines.push(`- kitApiVersion: ${page.kitApiVersion}`)
    lines.push(`- source: pages/${page.pageSlug}/page.tsx`)
    lines.push(`- layout: layout/${page.pageSlug}.json (unpopulated in this MVP export)`)

    const pageRenders = input.renders.filter((render) => render.pageSlug === page.pageSlug)
    if (pageRenders.length > 0) {
      lines.push("- rendered sizes:")
      for (const render of pageRenders) {
        lines.push(`  - ${sizeLabel(render.size)} -> snapshots/${page.pageSlug}/${sizeLabel(render.size)}.txt`)
      }
    }
    lines.push("")
  }

  lines.push("## Runtime")
  lines.push("")
  lines.push(`- module: ${input.runtimeDeclaration.module}`)
  lines.push(`- currentKitApiVersion: ${input.runtimeDeclaration.currentKitApiVersion}`)
  lines.push(`- supportedKitApiVersions: ${input.runtimeDeclaration.supportedKitApiVersions.join(", ")}`)
  lines.push("")

  return lines.join("\n")
}

/** Assembles the export package's in-memory file list, or refuses wholesale on the first failed render. */
export function assembleExportPackage(input: AssembleExportPackageInputV1): AssembleExportPackageResultV1 {
  const failedRender = input.renders.find((render): render is ExportRenderJobResultV1 & { readonly outcome: FailureDtoV1 } => "code" in render.outcome)
  if (failedRender !== undefined) return { kind: "failed", failure: failedRender.outcome }

  const files: ExportPackageFileV1[] = []

  files.push(textFile("design-prompt.md", buildDesignPrompt(input)))
  files.push(textFile("runtime-api.json", JSON.stringify(input.runtimeDeclaration, null, 2)))

  for (const page of input.snapshot.pages) {
    files.push({ relPath: `pages/${page.pageSlug}/page.tsx`, bytes: page.bytes })
    // Deliberately `{}`, never `render.outcome.layout` — see this file's header divergence note.
    files.push(textFile(`layout/${page.pageSlug}.json`, "{}"))
  }

  for (const render of input.renders) {
    if ("code" in render.outcome) continue // unreachable past the wholesale refusal above
    files.push({ relPath: `snapshots/${render.pageSlug}/${sizeLabel(render.size)}.txt`, bytes: render.outcome.textFrame })
  }

  return { kind: "assembled", files }
}
