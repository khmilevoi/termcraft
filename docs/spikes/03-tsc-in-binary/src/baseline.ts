// Step 3 baseline: type-check the fixtures under `bun run` with the DEFAULT host
// (real filesystem, tsc.exe resolved from node_modules, real tsconfig on disk).
// No embedding, no virtual FS. This establishes that the checker works at all
// before --compile adds a second variable.
//
// NOTE: the plan's Step 3 code (`ts.createProgram`) does not exist in typescript@7.0.2.
// See src/plan-verbatim.ts for the recorded failure. This is the TS7 equivalent.
import { API } from "typescript/unstable/sync"
import fs from "node:fs"
import path from "node:path"

const file = path.resolve(process.argv[2]!)
const dir = path.dirname(file)

// The TS7 API is project-based: it needs a tsconfig on disk, not a loose file list.
const tsconfigPath = path.join(dir, "tsconfig.probe.json")
const runtimeDts = path.resolve(import.meta.dirname, "runtime.d.ts")

fs.writeFileSync(
  tsconfigPath,
  JSON.stringify({
    compilerOptions: {
      strict: true,
      jsx: "react-jsx",
      noEmit: true,
      target: "esnext",
      module: "esnext",
      moduleResolution: "bundler",
      types: [],
      skipLibCheck: true,
    },
    files: [file, runtimeDts],
  }),
)

const api = new API({ cwd: dir })
const snapshot = api.updateSnapshot({ openProjects: [tsconfigPath] })
const project = snapshot.getProject(tsconfigPath) ?? snapshot.getProjects()[0]

if (!project) {
  console.log(JSON.stringify({ error: "no project", projects: snapshot.getProjects().length }, null, 2))
  api.close()
  process.exit(1)
}

const diags = [
  ...project.program.getConfigFileParsingDiagnostics(),
  ...project.program.getProgramDiagnostics(),
  ...project.program.getSyntacticDiagnostics(),
  ...project.program.getSemanticDiagnostics(),
]

console.log(
  JSON.stringify(
    diags.map((d) => ({ code: d.code, message: d.text })),
    null,
    2,
  ),
)
api.close()
