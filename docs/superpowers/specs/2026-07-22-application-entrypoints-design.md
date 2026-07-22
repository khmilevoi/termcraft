# Application Entrypoints Design

## Goal

Make Termcraft directly runnable in two modes: the real application and a safe local demo that does not require an authenticated agent or persistent user data.

## Commands

- `bun start` launches the real Termcraft application once.
- `bun run dev` launches the real application under Bun watch mode.
- `bun run demo` launches the same UI with in-memory/fake dependencies.
- `bun run build` compiles the real application into a standalone `termcraft` executable using Bun.

The project continues to require Bun 1.3.14 or newer. No new runtime dependencies are introduced unless an existing module contract cannot be implemented from the packages already declared in `package.json`.

## Architecture

`src/main.tsx` is the production composition root described by `docs/architecture/code-structure.md`. It may import every top-level module. It constructs the concrete store, host, gate, agent, kernel, and UI dependencies, then mounts the existing `App` component with the OpenTUI React renderer.

`src/demo.tsx` is a separate executable entrypoint. It composes the existing fake or in-memory ports used by UI tests and mounts the same `App` component. It must not invoke Claude, create or mutate a real Termcraft project, or depend on credentials.

Shared startup mechanics may be extracted into a small module only when both entrypoints genuinely need identical renderer lifecycle or terminal cleanup behavior. Domain behavior remains in the existing modules; entrypoints only wire dependencies and own process lifecycle.

## Startup and Shutdown

Production startup validates its environment and constructs dependencies before mounting the UI. Expected initialization failures remain error values in accordance with the repository's `errore` convention. At the executable boundary, an error is printed to stderr and produces a non-zero exit code.

Normal exit and terminal signals release renderer, agent, host, and storage resources in reverse acquisition order. Cleanup uses the existing disposable conventions where available and must be safe when startup completes only partially.

The demo has the same renderer and signal behavior but uses disposable in-memory dependencies.

## Configuration

The production entrypoint uses the existing Claude Agent SDK authentication mechanisms; it does not introduce a custom API-key file or store secrets in the repository. Missing authentication is surfaced as an actionable startup/runtime error rather than silently switching to demo mode.

Paths and defaults come from existing store and kernel factories. The composition root must not duplicate domain defaults already owned by those modules.

## Testing

Tests exercise startup through injected process/renderer boundaries so they do not take over the developer's terminal. Coverage includes:

- successful production dependency composition;
- successful demo composition without real agent or persistent storage access;
- initialization errors becoming a diagnostic and non-zero exit result;
- cleanup after normal shutdown and partial initialization;
- package scripts resolving to valid entrypoints;
- the compiled production entrypoint building successfully.

All existing TypeScript, lint, formatting, and Bun test checks must remain green.

## Documentation

Add a root README with prerequisites, install, production, demo, development, build, and authentication instructions. Update architecture documents so `main.tsx` and the runnable composition roots are marked as landed and their source anchors point to the implemented files.

## Out of Scope

- Adding another agent provider.
- Changing UI appearance or behavior.
- Changing storage formats, protocol contracts, or domain rules.
- Packaging installers or publishing binaries.
- Automatically creating credentials or silently falling back from production to demo.
