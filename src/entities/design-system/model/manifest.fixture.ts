/**
 * The design-systems spec §3.2 manifest, as plain data. TEST SUPPORT: shared by this module's own
 * tests, by `gate`'s (`design-system.test.ts`, `gate-runner.test.ts`, `type-check.test.ts`), and
 * by `store/design-systems`'s (`summary.test.ts`, `list.test.ts`, `fetch.test.ts`,
 * `publish.test.ts`) — since `readDesignSystemSummary` now decodes through this same schema, its
 * tests need a manifest the decoder actually accepts, not a hand-rolled shortcut — so the
 * seventeen core hex values are written exactly once in this repository. Deliberately NOT
 * exported from `index.ts` — nothing in production reads it.
 *
 * Returns a FRESH object every call: every caller mutates one field to build a rejection case, and
 * a shared constant would leak that mutation into the next test.
 */
export function validManifestObject(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: "midnight",
    name: "Midnight",
    version: "1.2.0",
    kitApiVersion: 1,
    defaultTheme: "dark",
    themes: {
      dark: {
        label: "Midnight Dark",
        tokens: {
          background: "#0b0f14",
          surface: "#131a24",
          foreground: "#c8d3e0",
          foregroundMuted: "#7d8ea3",
          foregroundFaint: "#4a5a6e",
          border: "#243244",
          line: "#1a2430",
          accent: "#4cc9f0",
          accentHi: "#8ae3ff",
          accentDim: "#2b7f9b",
          selection: "#16324a",
          selectionFg: "#8ae3ff",
          success: "#06d6a0",
          warning: "#ffd166",
          danger: "#ef476f",
          dangerDim: "#4a1c2a",
          statusBg: "#131a24",
          brandBlue: "#4cc9f0",
          chartSeries1: "#7b2cbf",
        },
      },
    },
    components: [
      { name: "Button", module: "components/Button.tsx", export: "Button" },
      { name: "PageShell", module: "components/PageShell.tsx", export: "PageShell" },
    ],
  };
}
