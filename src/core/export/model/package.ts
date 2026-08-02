import * as errore from "errore";

import type { RuntimeDeclarationBundleV1 } from "core/ports";
import type { FailureDtoV1 } from "core/protocol";
import type { PageSlug } from "entities/page";

import type { ExportClosureV1, ExportSnapshotV1 } from "../types";
import type { ExportRenderJobResultV1 } from "./render-jobs";

/**
 * Export package assembly (kernel-command-contract §7.5/§12.5; storage-identity §5.2;
 * runtime-api-compatibility §12; multi-file design tree §11): `design-prompt.md`,
 * `design/<treeRelPath>` for EVERY canonical tree file, `closures/<slug>.json`,
 * `snapshots/<slug>/<w>x<h>.txt`, `layout/<slug>.json`, and `runtime-api.json` — assembled
 * as an IN-MEMORY file list. This module never touches disk (`core` has no disk access);
 * `ExportPublishTransaction` writing these bytes durably is a later slice's job.
 *
 * `pages/<slug>/page.tsx` IS GONE (design §11, task 16). A page is its closure now, so one
 * file per page could not describe it: the shared module the page imports would be missing,
 * and the copy's path would be a slug-derived fiction the canonical tree has retired. The
 * whole tree ships ONCE under `design/`, and `closures/<slug>.json` says which of those files
 * each page actually reaches — `{ "pageSlug": ..., "entry": "design/<entry>", "files":
 * ["design/..."] }`, with every path prefixed the same way, so a reader of the package never
 * has to know the tree-relative convention exists.
 *
 * `design-prompt.md`'s own shared-module section (design §11) is PLAN 3's — the prompt names
 * each page's entry and closure file today and deliberately does not yet explain module-level
 * state across pages, rather than half-writing that explanation here.
 *
 * `layout/<slug>.json` (WP-5 Task B1, D-Q1) is a SIZE-KEYED JSON object — one key per
 * rendered ladder size (`sizeLabel()` below, the same `WxH` label the snapshot files use),
 * each value the real resolved `LayoutNode` tree for that page at that size, taken verbatim
 * from `ExportRenderResultV1.layout` (host-supervision WP-5 Phase A seals it; `render-jobs.ts`
 * carries it through unmodified). One file per page carries EVERY rendered size (design §3.7:
 * "the resolved layout tree at every export size") — never a single bare tree, which would
 * lose the per-size resize data the ladder exists to capture. `{}` is written ONLY for a page
 * with zero rendered sizes (unreachable past the size ladder in practice, but honest rather
 * than fabricated). KNOWN DIVERGENCE, carried forward from `host/render/types.ts` (D-Q6):
 * every tree's nodes carry `id`/`kind`/`box`/`children` — `text` is not yet populated (the
 * runtime element catalog that would resolve it has not landed).
 *
 * ALL RENDERS MUST HAVE SUCCEEDED (§7.5: "`beginPublication` ... All page/size renders
 * succeeded"). This function refuses wholesale on the first failed render it finds rather
 * than assembling a package with a missing size — the caller decides what happens next
 * (typically: never call `publishExport` at all). A render whose `layout` bytes fail to
 * parse as JSON (defensive only — the host adapter already validated the tree with
 * `layoutNodeSchema` before serializing it, WP-5 Task A2) is treated the identical way: a
 * wholesale refusal, never a package with a silently-dropped or fabricated tree.
 */

/** A render's `layout` bytes are not valid JSON — defensive only (see this file's header). */
class ExportLayoutMalformedError extends errore.createTaggedError({
  name: "ExportLayoutMalformedError",
  message: "page $pageSlug's layout bytes at size $size are not valid JSON",
}) {}

export interface ExportPackageFileV1 {
  readonly relPath: string;
  readonly bytes: Uint8Array;
}

export interface AssembleExportPackageInputV1 {
  readonly snapshot: ExportSnapshotV1;
  readonly renders: readonly ExportRenderJobResultV1[];
  readonly runtimeDeclaration: RuntimeDeclarationBundleV1;
  /**
   * One closure per page, resolved over the SAME bytes {@link ExportSnapshotV1.tree} holds.
   * The caller supplies them because resolving a closure means walking the import graph, which
   * is `gate`'s job and a ring `core` may not import — `runExportStart` asks the `GateRunner`
   * port once, after the permit is released, and hands the answer here.
   *
   * A page with no entry here gets NO `closures/<slug>.json` rather than a fabricated one
   * naming only its entry: a truncated closure would tell an implementer the page needs
   * nothing else, which is the same silent lie a truncated closure has cost this branch twice.
   */
  readonly closures: readonly ExportClosureV1[];
}

export type AssembleExportPackageResultV1 =
  | { readonly kind: "failed"; readonly failure: FailureDtoV1 }
  | { readonly kind: "assembled"; readonly files: readonly ExportPackageFileV1[] };

function textFile(relPath: string, text: string): ExportPackageFileV1 {
  return { relPath, bytes: new TextEncoder().encode(text) };
}

function sizeLabel(size: { readonly w: number; readonly h: number }): string {
  return `${size.w}x${size.h}`;
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
  ];

  for (const page of input.snapshot.pages) {
    lines.push(`### ${page.pageSlug}`);
    lines.push("");
    lines.push(`- theme: ${page.theme}`);
    lines.push(`- kitApiVersion: ${page.kitApiVersion}`);
    lines.push(`- entry: design/${page.entryRelPath}`);
    const closure = input.closures.find((entry) => entry.pageSlug === page.pageSlug);
    lines.push(
      closure === undefined
        ? "- closure: unavailable — this page's import graph could not be resolved"
        : `- closure: closures/${page.pageSlug}.json (${closure.files.length} file(s))`,
    );
    lines.push(
      `- layout: layout/${page.pageSlug}.json (per-size resolved layout trees; ` +
        `ids/boxes populated, text awaits the runtime catalog — D-Q6)`,
    );

    const pageRenders = input.renders.filter((render) => render.pageSlug === page.pageSlug);
    if (pageRenders.length > 0) {
      lines.push("- rendered sizes:");
      for (const render of pageRenders) {
        lines.push(
          `  - ${sizeLabel(render.size)} -> snapshots/${page.pageSlug}/${sizeLabel(render.size)}.txt`,
        );
      }
    }
    lines.push("");
  }

  lines.push("## Runtime");
  lines.push("");
  lines.push(`- module: ${input.runtimeDeclaration.module}`);
  lines.push(`- currentKitApiVersion: ${input.runtimeDeclaration.currentKitApiVersion}`);
  lines.push(
    `- supportedKitApiVersions: ${input.runtimeDeclaration.supportedKitApiVersions.join(", ")}`,
  );
  lines.push("");

  return lines.join("\n");
}

/**
 * Confirms `bytes` decode to valid JSON syntax and hands back the ORIGINAL decoded text
 * verbatim (never a `JSON.parse`+re-`JSON.stringify` round trip, which could silently
 * reformat numbers/whitespace and drift from the exact bytes the host sealed). This is a
 * boundary check on host-produced bytes (errore rule 12) — `core` has no `LayoutNode` type
 * to decode INTO (module DAG: `core` never imports `host`), so the tree's shape is opaque
 * here; only its JSON well-formedness is verified before it is spliced into the combined
 * per-page document.
 */
function validateLayoutJsonText(
  bytes: Uint8Array,
  pageSlug: PageSlug,
  size: string,
): ExportLayoutMalformedError | string {
  const text = new TextDecoder().decode(bytes);
  // The parsed VALUE is deliberately discarded (returning it would be `unknown`, which
  // collapses the `Error | T` union per errore's boundary rule) — only JSON well-formedness
  // is being probed here, so `try` returns a plain `true` rather than the parsed value.
  const validated = errore.try({
    try: () => {
      JSON.parse(text);
      return true;
    },
    catch: (cause) => new ExportLayoutMalformedError({ pageSlug, size, cause }),
  });
  if (validated instanceof Error) return validated;
  return text;
}

/** Builds one page's `layout/<slug>.json` — a size-keyed object of every rendered size's tree (D-Q1), or `{}` if this page rendered nothing (unreachable past the ladder, kept honest). */
function buildLayoutFile(
  pageSlug: PageSlug,
  pageRenders: readonly ExportRenderJobResultV1[],
): FailureDtoV1 | ExportPackageFileV1 {
  const relPath = `layout/${pageSlug}.json`;
  if (pageRenders.length === 0) return textFile(relPath, "{}");

  const entries: string[] = [];
  for (const render of pageRenders) {
    if ("code" in render.outcome) continue; // unreachable: the wholesale refusal above already returned
    const label = sizeLabel(render.size);
    const validated = validateLayoutJsonText(render.outcome.layout, pageSlug, label);
    if (validated instanceof Error) {
      return {
        code: "EXPORT_RENDER_FAILED",
        retryable: false,
        safeMessage: validated.message,
        details: {},
      };
    }
    entries.push(`${JSON.stringify(label)}:${validated}`);
  }

  return textFile(relPath, `{${entries.join(",")}}`);
}

/**
 * One page's `closures/<slug>.json`, with every tree-relative path prefixed `design/` so it
 * addresses the package's own layout rather than the canonical tree's. `files` keeps the
 * closure's own order, which `resolveClosure` already sorted.
 */
function buildClosureJson(closure: ExportClosureV1): string {
  return JSON.stringify(
    {
      pageSlug: closure.pageSlug,
      entry: `design/${closure.entry}`,
      files: closure.files.map((relPath) => `design/${relPath}`),
    },
    null,
    2,
  );
}

/** Assembles the export package's in-memory file list, or refuses wholesale on the first failed render (or the first unparseable layout tree — see the header). */
export function assembleExportPackage(
  input: AssembleExportPackageInputV1,
): AssembleExportPackageResultV1 {
  const failedRender = input.renders.find(
    (render): render is ExportRenderJobResultV1 & { readonly outcome: FailureDtoV1 } =>
      "code" in render.outcome,
  );
  if (failedRender !== undefined) return { kind: "failed", failure: failedRender.outcome };

  const files: ExportPackageFileV1[] = [];

  files.push(textFile("design-prompt.md", buildDesignPrompt(input)));
  files.push(textFile("runtime-api.json", JSON.stringify(input.runtimeDeclaration, null, 2)));

  // The whole canonical tree, once, under `design/` — never one slug-derived copy per page.
  for (const file of input.snapshot.tree) {
    files.push({ relPath: `design/${file.relPath}`, bytes: file.bytes });
  }

  for (const closure of input.closures) {
    files.push(textFile(`closures/${closure.pageSlug}.json`, buildClosureJson(closure)));
  }

  for (const page of input.snapshot.pages) {
    const pageRenders = input.renders.filter((render) => render.pageSlug === page.pageSlug);
    const layoutFile = buildLayoutFile(page.pageSlug, pageRenders);
    if ("code" in layoutFile) return { kind: "failed", failure: layoutFile };
    files.push(layoutFile);
  }

  for (const render of input.renders) {
    if ("code" in render.outcome) continue; // unreachable past the wholesale refusal above
    files.push({
      relPath: `snapshots/${render.pageSlug}/${sizeLabel(render.size)}.txt`,
      bytes: render.outcome.textFrame,
    });
  }

  return { kind: "assembled", files };
}
