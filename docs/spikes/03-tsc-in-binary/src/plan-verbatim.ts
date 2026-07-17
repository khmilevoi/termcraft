// The plan's Step 3 code, VERBATIM, kept only to record how it fails against the
// resolved typescript version (7.0.2). Not the working probe. See src/main.ts.
import ts from "typescript"

const file = process.argv[2]
const program = ts.createProgram([file], {
  strict: true,
  jsx: ts.JsxEmit.ReactJSX,
  noEmit: true,
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
})
const diags = ts.getPreEmitDiagnostics(program)
console.log(
  JSON.stringify(
    diags.map((d) => ({
      code: d.code,
      message: ts.flattenDiagnosticMessageText(d.messageText, " "),
    })),
    null,
    2,
  ),
)
