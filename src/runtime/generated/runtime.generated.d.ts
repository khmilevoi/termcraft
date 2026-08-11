declare module "@termcraft/runtime" {
  import { jsxDEV } from "@opentui/react/jsx-dev-runtime";
  import { Fragment, jsx, jsxs } from "@opentui/react/jsx-runtime";
  import { action, atom, computed, withAbort, withAsync, withAsyncData, withComputed, wrap } from "@reatom/core";
  import type { Action, Atom, AtomLike, Computed, Ext } from "@reatom/core";
  import { reatomComponent } from "@reatom/react";

  // ── src/runtime/model/capabilities
  /**
   * Declares a page's tweak controls (runtime-api §6). DORMANT in the MVP: like
   * `definePage`, it only records the declaration shape; the scoped reactive
   * toggle/select/text values and the Tweaks panel that drives them land with the
   * phase-7 UI (`defineTweaks` is exported but inert until then).
   */
  function defineTweaks<T extends Record<string, unknown>>(declaration: T): T;
  /**
   * The host-scoped mode capability (§6). These named atoms are HOST INPUTS: the
   * Kernel initializes `hostMode`/`interactionMode` only from an accepted `ready`
   * response and updates `interactionMode` only from an accepted correlated
   * `set-mode` response (phase-6 wiring) — a page reads them so deterministic
   * export behavior never depends on a private global. MVP defaults are
   * `preview` + `static`; a page must not write them.
   */
  const hostModeAtom: import("@reatom/core").Atom<"export" | "preview", [newState: "export" | "preview"]>;
  const interactionModeAtom: import("@reatom/core").Atom<"interactive" | "static", [newState: "interactive" | "static"]>;
  /** True while the host renders this page for deterministic export (§6, §11.4). */
  const isExportAtom: import("@reatom/core").Computed<boolean>;
  /** A page-readable helper for the export flag (reads {@link isExportAtom}). */
  function isExport(): boolean;
  /** The theme capability (§6): the active theme id and its resolved token map. */
  interface ThemeCapability {
      readonly themeId: ThemeId;
      readonly tokens: TokenMap;
  }
  /**
   * Resolve the current theme capability (§6, spec §4.6). It reads the two HOST-INPUT atoms the
   * mount seeds (`./tokens`'s `themeIdAtom`/`themeTokensAtom`), so it returns the PROJECT's real
   * theme — the compiled `dark-default` it used to return survives only as those atoms' pre-mount
   * default. Called from a `reatomComponent`, both reads are tracked, so a preview theme override
   * re-renders the page without rewriting `meta.theme` (`runtime-api` §6).
   */
  function themeCapability(): ThemeCapability;
  /** The navigation capability (§6): `usePages().goTo(slug)`. */
  interface PagesCapability {
      readonly goTo: (slug: string) => void;
  }
  /**
   * Retrieves the navigation capability (design §5.5). A minimal context lookup
   * (§6) — DORMANT in MVP, see {@link goToPage}.
   */
  function usePages(): PagesCapability;
  /**
   * The host-scoped viewport/terminal capability (§6): "reactive size and
   * color-capability values supplied by the host." Modeled like `hostModeAtom`/
   * `interactionModeAtom` above — named HOST-INPUT atoms a page reads and must not
   * write. DORMANT in MVP: the host doesn't wire real viewport/color negotiation yet,
   * so both atoms carry fixed defaults.
   *
   * `viewportSizeAtom` defaults to 80x24 (columns x rows): the classic terminal size,
   * the first entry in the design's own preview-size preset list (design §8.1 item
   * 10: "80×24, 120×40, custom..., auto"), and the size used by every `minSize`
   * example in the runtime-api spec itself. Neither spec fixes this as the
   * *capability*'s default value, though — this MVP default is this task's own
   * choice, documented here rather than silently invented.
   */
  const viewportSizeAtom: import("@reatom/core").Atom<Size, [newState: Size]>;
  /**
   * The color-depth capability. 24 (truecolor) is this task's own MVP default: the
   * design's palette tokens are full `#rrggbb` values (§5.4) and OpenTUI targets
   * truecolor terminals, but no spec section fixes a default numeric value for this
   * capability — flagged here rather than assumed.
   */
  const colorDepthAtom: import("@reatom/core").Atom<number, [newState: number]>;

  // ── src/runtime/model/define-page
  /** The runtime API version this binary authors new pages against (§7.1). */
  const CURRENT_KIT_API_VERSION = 1;
  /**
   * Declares a page's static metadata (§5.1). The Gate reads this call's object
   * literal from the AST without executing the page, so at authoring time this
   * only supplies types; at render time it returns the same object unchanged.
   */
  function definePage(meta: PageMeta): PageMeta;

  // ── src/runtime/model/reatom
  /** A connection-scoped cleanup returned from `withConnectHook` (§3.2). */
  type ConnectionCleanup = () => void;
  /**
   * The narrowed facade return contract for a `withConnectHook` callback (§3.2): only
   * no cleanup or exactly one cleanup function, synchronously or asynchronously. It
   * deliberately does not expose Reatom's private subscription object types.
   */
  type ConnectionHookResult = void | ConnectionCleanup | Promise<void | ConnectionCleanup>;
  /**
   * `withConnectHook` narrowed to the facade's `ConnectionHookResult` (§3.2, m1).
   * Reatom's real signature (`node_modules/@reatom/core/dist/index.d.ts:1222`) types
   * the callback's return as `MaybeUnsubscribe`:
   *
   *   type MaybeUnsubscribe = void | Exclude<{}, Fn> | Unsubscribe | { unsubscribe: Unsubscribe }
   *
   * — a much wider type than the facade wants to publish: it admits almost any
   * non-null return value, not just "no cleanup or one cleanup function". This
   * thin wrapper narrows only the PUBLIC callback parameter type; every
   * `ConnectionHookResult` value is already assignable to `MaybeUnsubscribe` (`void`
   * matches `void` directly, a `ConnectionCleanup` function matches `Unsubscribe`,
   * and a `Promise` matches the permissive `Exclude<{}, Fn>` arm), so TypeScript's
   * covariant function-return check lets `cb` forward straight into the real
   * `withConnectHook` below with no cast.
   */
  function withConnectHook<Target extends AtomLike>(cb: (target: Target) => ConnectionHookResult): Ext<Target>;

  // ── src/runtime/model/tokens
  /**
   * The one theme id the COMPILED SEED carries. The seed registry is a closed, one-member
   * thing and says so in its own type.
   */
  type SeedThemeId = "dark-default";
  /**
   * The `dark-default` seed palette. These are the design system's REAL hues, taken 1:1 from
   * `design/termcraft-engine.js`'s `pal` object (a warm amber-on-near-black terminal theme) — not
   * a placeholder, and not invented here.
   *
   * WHAT IT IS NOW (spec §4.6, §9). It is no longer "the palette a page renders against": that is
   * the project's own `design/system/design-system.json`, delivered through
   * {@link themeTokensAtom}. Two jobs survive:
   *   1. the SEED the project-create scaffold and the mechanical migration copy into a new
   *      project's manifest;
   *   2. {@link themeTokensAtom}'s pre-mount default — see that atom's own note.
   */
  const DARK_DEFAULT: TokenMap;
  /** Resolve the SEED theme id to its palette. Closed to {@link SeedThemeId} — see its note. */
  function themeTokens(id: SeedThemeId): TokenMap;
  /** The seed theme's id — the scaffold's starting point, not a project's active theme. */
  const DEFAULT_THEME_ID: SeedThemeId;
  const themeIdAtom: import("@reatom/core").Atom<string, [newState: string]>;
  const themeTokensAtom: import("@reatom/core").Atom<TokenMap, [newState: TokenMap]>;
  const seedThemeCapability: import("@reatom/core").GAction<(input: {
      readonly themeId: ThemeId;
      readonly tokens: TokenMap;
  }) => void>;
  /**
   * A page's reactive read of the active theme's token map (spec §4.6).
   *
   * REACTIVE BECAUSE THE CALLER IS. A page is a `reatomComponent` (§4.3), so this call is a
   * TRACKED read of {@link themeTokensAtom} inside the component's render body: seeding a new
   * theme re-renders the page. §4.5 turns the corollary into a Gate warning — read at module
   * scope it captures one theme's values forever, which is exactly the shape a token scan can see.
   *
   * GENERIC so a project's own `design/system/tokens.ts` binds its manifest-derived `Tokens` type
   * with NO CAST AT THE CALL SITE (§4.3's scaffold: `useRuntimeTokens<Tokens>()`). The single
   * assertion that costs is here, once, and it is a last resort rather than a shortcut: the
   * runtime cannot know a project's token names, and the type that does know them is derived from
   * the project's own manifest through `resolveJsonModule` inside the Gate's one whole-tree
   * program. The Gate is what makes the assertion honest — a `Tokens` naming a token the manifest
   * does not declare is a fatal type error there, before any of this runs.
   */
  function useTokens<T = TokenMap>(): T;
  /**
   * The active theme's tokens for a CATALOG COMPONENT to resolve its own defaults against
   * (`Panel`'s `border`, `Text`'s `foreground`, `Gauge`'s `accent`, …).
   *
   * STAGE-1 REACTIVITY, STATED RATHER THAN ASSUMED (spec §4.2 — no theme switcher ships in stage
   * 1). The fourteen catalog components are plain function components, so this read is a
   * current-value read, not a tracked one: a mid-session theme change would not re-render them on
   * its own. That is correct by construction today, because {@link seedThemeCapability} runs
   * before the first render of a mount and nothing writes the atom again. THE TRIGGER TO REVISIT:
   * a shell-side theme switcher (§4.2's `runtime-api` §6 preview override). At that point the
   * catalog components — not this function — become `reatomComponent`s, which is the change that
   * makes their reads tracked.
   *
   * A PAGE's own read is already reactive and needs nothing here: a page is a `reatomComponent`
   * (§4.3), so its `useTokens()` call is a tracked read of the same atom.
   */
  function activeTokens(): TokenMap;

  // ── src/runtime/types
  /**
   * A theme id declared by the project's own design system (spec §4.6). It was a closed
   * one-member union while a single `dark-default` palette was compiled into this binary; the
   * truth now lives in the project's `design/system/design-system.json`, and the GATE — not this
   * type — validates a concrete id against that manifest. Widening it here rather than enumerating
   * project names is the whole point: a closed union in the binary would make every project's
   * theme names part of the binary's identity.
   */
  type ThemeId = string;
  /**
   * A concrete terminal colour: a lowercase `#rrggbb` string (spec §4.5).
   *
   * TEMPLATE-LITERAL RATHER THAN `string`, ON PURPOSE. A `string` alias would leave
   * `color="foregroundMuted"` compiling, and §4.5 replaces two ways of naming a colour with one:
   * the checked `t.accent` path. §9's migration depends on the old spelling being a fatal
   * `TS2322` that the Gate's warning can attach an exact rewrite to.
   *
   * DIVERGENCE, STATED RATHER THAN SILENTLY SUBSTITUTED: TypeScript cannot express "exactly six
   * lowercase hex digits", so this type checks the `#` prefix and nothing else. The full
   * `#rrggbb` form is enforced where the values ENTER the system — the design-system manifest's
   * Gate schema (§7) — not at every prop site.
   */
  type Color = `#${string}`;
  /** A terminal-cell size (columns × rows). */
  interface Size {
      readonly w: number;
      readonly h: number;
  }
  /**
   * The themed token palette a page renders against (runtime-api §5.4). Token NAMES
   * are the stable contract the design-system components bind to; the concrete hues
   * belong to the resolved `ThemeId`. Every value is a {@link Color}. The NAMES are the
   * mandatory core roles every project theme must declare (spec §4.1) — the component
   * catalog's defaults bind to them; the VALUES are the project's, delivered through
   * {@link TokenMap} at mount.
   *
   * The 17 roles map 1:1 onto the design system's real `termcraft-engine.js` palette
   * (a warm amber-on-near-black terminal theme). `warning` has no dedicated engine
   * hue — amber-highlight is the caution shade — and `statusBg`/`surface` share a hue
   * in dark but stay distinct roles so a future theme can diverge them.
   */
  interface ThemeTokens {
      /** Global terminal background (engine `bg`); also the knocked-out fg on solid amber chips. */
      readonly background: Color;
      /** Elevated fill — status bar, lifted card/input bodies (engine `statusBg`). */
      readonly surface: Color;
      /** Primary body text (engine `fg`). */
      readonly foreground: Color;
      /** Secondary/dim text — labels, metadata, sub-panel titles (engine `dim`). */
      readonly foregroundMuted: Color;
      /** Faintest text — placeholders, disabled/ghost rows, hints, column headers (engine `faint`). */
      readonly foregroundFaint: Color;
      /** Active structural frame — panel borders, pane dividers, gauge track (engine `border`). */
      readonly border: Color;
      /** Subtle/inactive chrome — interior dividers, dimmed frames, quiet-chip bg (engine `line`). */
      readonly line: Color;
      /** Primary accent — prompt/cursor, titles, active tab, ▸ marker, gauge fill (engine `amber`). */
      readonly accent: Color;
      /** Bright emphasis — popup/active titles, selected values, hover borders, warning emphasis (engine `amberHi`). */
      readonly accentHi: Color;
      /** Dimmed amber — generating-state borders, low-emphasis warning (engine `amberDim`). */
      readonly accentDim: Color;
      /** Selected-row background — the back-fill behind the current list/table/pin row (engine `sel`). */
      readonly selection: Color;
      /** Selected-row text — text/columns on the highlighted row (engine `selFg`). */
      readonly selectionFg: Color;
      /** Success/live — ● live, ✓ resolved, sparkline bars (engine `green`). */
      readonly success: Color;
      /** Warning/caution — ⚠ hints, ctx-threshold (engine `amberHi`; no dedicated warning hue). */
      readonly warning: Color;
      /** Error text/border — ✗ failures, invalid input, error modal (engine `red`). */
      readonly danger: Color;
      /** Error-band background — the strip behind a red error message (engine `redDim`). */
      readonly dangerDim: Color;
      /** Status-bar background — bottom row + segment fills (engine `statusBg`). */
      readonly statusBg: Color;
  }
  /**
   * The active theme's whole token map (spec §4.1): the mandatory core roles above, plus any
   * number of token names the project declared. The index signature is what makes a
   * project-declared name expressible at all.
   *
   * A page never indexes this type by a computed string — it reads a named field off its own
   * manifest-derived `Tokens` type (§4.3), where every key is known.
   */
  interface TokenMap extends ThemeTokens {
      readonly [token: string]: Color;
  }
  /**
   * A page's static metadata (§5.1). Authored through `definePage`; the Gate
   * reads this shape from the call's object literal without executing the page.
   * This type is deliberately independent of termcraft's internal `PageMeta`
   * (`entities/page`) so the runtime facade stays a leaf that leaks no internal
   * module identity into authored pages (runtime-api §3.3).
   */
  interface PageMeta {
      /** Positive integer runtime-API compatibility identity (§7.1). */
      readonly kitApiVersion: number;
      /** Tab label and the page's display name. */
      readonly title: string;
      /** Smallest export size and the status-bar warning threshold. */
      readonly minSize: Size;
      /**
       * The declared theme this page pins to (spec §4.6). OPTIONAL: absent means the project
       * manifest's `defaultTheme`, which is the ordinary case; present, it pins the page to one
       * declared theme. The Gate checks the name against the project's manifest.
       */
      readonly theme?: ThemeId;
  }
  /**
   * One side of a box frame (spec §6.2). `Box.border` takes `true` for all four, `false` for none,
   * or a list of exactly the sides to draw. termcraft declares this locally rather than re-exporting
   * `@opentui/core`'s `BorderSides`, so an OpenTUI upgrade changes the adapter and not one saved
   * page (§6).
   */
  type BorderSide = "top" | "right" | "bottom" | "left";
  /**
   * A complete custom frame glyph set (spec §6.2). All eleven members are required: a partial set
   * would leave a frame drawn half in one alphabet and half in another, which reads as a rendering
   * bug rather than a choice. The four built-in tables `borderStyle` selects
   * (`single`/`double`/`rounded`/`heavy`) each supply exactly these eleven.
   */
  interface BorderGlyphs {
      readonly topLeft: string;
      readonly topRight: string;
      readonly bottomLeft: string;
      readonly bottomRight: string;
      /** The horizontal run along the top and bottom edges. */
      readonly horizontal: string;
      /** The vertical run along the left and right edges. */
      readonly vertical: string;
      /** T-junctions where an interior rule meets an edge. */
      readonly topT: string;
      readonly bottomT: string;
      readonly leftT: string;
      readonly rightT: string;
      /** The four-way junction where two interior rules cross. */
      readonly cross: string;
  }
  /**
   * A layout length (spec §6.2): a cell count, a percentage of the containing box, or `auto` —
   * "whatever the content or the flex algorithm decides". termcraft declares this locally rather
   * than re-exporting OpenTUI's own union, so an OpenTUI upgrade changes the adapter and not one
   * saved page (§6).
   */
  type Dimension = number | "auto" | `${number}%`;

  // ── src/runtime/ui/button
  /** Props for the themed `Button` component. `id` is the mandatory stable id (§3.2). */
  interface ButtonProps {
      /** Stable id the host selects/pins on and the shell dispatches presses through (§3.2). */
      readonly id: string;
      /** The button label. */
      readonly children?: string | number;
      /**
       * Invoked when the button is pressed. Accepted here and wired to the box's
       * `onMouseDown` for the interactive path (the shell dispatches it in accepted
       * interactive mode — phase 7); in the static headless render it stays inert.
       */
      readonly onPress?: () => void;
      /** A disabled button renders muted and never fires `onPress`. */
      readonly disabled?: boolean;
  }
  /**
   * Themed pressable button (design-system, runtime-api §3.2). Renders a bordered
   * OpenTUI `<box>` wrapping a token-colored label `Text`; the mandatory `id` flows
   * to the box so the host can answer geometry queries and the shell can select/pin
   * it. `onPress` is wired to the box's `onMouseDown` handler (the real OpenTUI prop
   * on `RenderableOptions`) for the phase-7 interactive path — disabled buttons pass
   * no handler. Colors are semantic token names, never raw hues.
   */
  function Button(props: ButtonProps): React.ReactNode;

  // ── src/runtime/ui/column
  /** Props for the `Column` layout container. `id` is the mandatory stable id (§3.2). */
  interface ColumnProps {
      /** Stable id the host selects and answers geometry on. Mandatory on every catalog component. */
      readonly id: string;
      readonly children?: unknown;
      /** Cells of space inserted between children (Yoga gap). */
      readonly gap?: number;
      /** Uniform inner padding on all sides. */
      readonly padding?: number;
      /** Cross-axis placement of children; maps to Yoga `alignItems`. */
      readonly align?: "start" | "center" | "end" | "stretch";
      /** Main-axis distribution of children; maps to Yoga `justifyContent`. */
      readonly justify?: "start" | "center" | "end" | "between" | "around";
  }
  /**
   * A vertical flex container (design-system §3.2). Stacks its children in a
   * column and maps the ergonomic `align`/`justify` prop vocabulary onto Yoga's
   * `alignItems`/`justifyContent`. The mandatory `id` flows to the element so the
   * host can answer geometry queries and the shell can select/pin it.
   */
  function Column(props: ColumnProps): React.ReactNode;

  // ── src/runtime/ui/gauge
  /** Props for the themed `Gauge` component. `id` is the mandatory stable id (§3.2). */
  interface GaugeProps {
      readonly id: string;
      /** Fill fraction; clamped to 0..1 (NaN treated as 0). */
      readonly value: number;
      /** Optional trailing label (e.g. a percent readout). */
      readonly label?: string;
      /** Bar length in cells; defaults to 10. */
      readonly width?: number;
  }
  /**
   * A horizontal fill bar (design-system §3.2). Rounds `clamp01(value) * width` to
   * a filled-cell count, drawing `█` in `accent` for the filled span and the `╌`
   * dashed track in `border` for the remainder, with an optional trailing label
   * `Text` in the design's dim label hue. Composes a `row` box so the two spans read
   * as one contiguous bar. Colors + glyphs match the design engine's gauge.
   */
  function Gauge(props: GaugeProps): React.ReactNode;

  // ── src/runtime/ui/inline
  /**
   * THE INLINE TEXT FAMILY (spec §6.1). Six wrappers over OpenTUI's text-node intrinsics —
   * `span`, `b`, `i`, `u`, `a`, `br` — kept in ONE module because they share one contract that
   * has to be stated once and obeyed by all of them:
   *
   *  - **They are only valid inside a `Text`.** Each renders a `TextNodeRenderable`
   *    (`@opentui/core/renderables/TextNode.d.ts:17`), which is not a layout renderable and has no
   *    container of its own; a `Text` is what holds them. `TextProps.children` is widened to accept
   *    them.
   *  - **Their `id` is mandatory but NOT host-addressable.** `TextNodeRenderable` extends
   *    `BaseRenderable` — no Yoga node, no screen rect — and the host's `rectOf`/`checkHit` walk
   *    `Renderable.findDescendantById` (`@opentui/core/Renderable.d.ts:187`), which never reaches a
   *    text node. DIVERGENCE, DOCUMENTED RATHER THAN SILENTLY DROPPED (CLAUDE.md): the id is
   *    carried, stable, and part of the authored-page contract spec §6 states without exception,
   *    but the shell cannot select or pin an inline run today. `ui/inline.test.tsx` pins that fact.
   *  - **Weight, slant and underline are the dedicated wrappers, not `Span` flags.** Two spellings
   *    for one effect is what §4.5 removed from the colour model; one spelling is kept here.
   *  - **No background prop in this stage.** `Text` has none either, and splitting the text
   *    vocabulary for `Span` alone would cost more than it buys. Adding it later is additive.
   */
  /** Props for the inline `Span`. `id` is the mandatory stable id (§3.2). */
  interface SpanProps {
      /** Stable id the shell keys on. Mandatory on every catalog component — see the module note. */
      readonly id: string;
      /** Literal text, or further inline wrappers. */
      readonly children?: unknown;
      /** The run's hue; defaults to the theme's `foreground`. Read one off `useTokens()` (spec §4.5). */
      readonly color?: Color;
  }
  /**
   * An inline run of text inside a `Text` (design-system §6.1). Its only styling is a hue — for
   * weight, slant or underline, wrap it in `Bold`, `Italic` or `Underline`. Must be nested in a
   * `Text`; on its own it has no container to attach to.
   */
  function Span(props: SpanProps): React.ReactNode;

  // ── src/runtime/ui/input
  /** Props for the themed `Input` component. `id` is the mandatory stable id (§3.2). */
  interface InputProps {
      /** Stable id the host selects/pins on (§3.2). Mandatory on every catalog component. */
      readonly id: string;
      /** The current text value. */
      readonly value?: string;
      /** Placeholder shown when the value is empty. */
      readonly placeholder?: string;
      /** Whether the input holds keyboard focus (drives the intrinsic's focused styling). */
      readonly focused?: boolean;
      /** Invoked with the new value on every edit; mapped to the intrinsic's `onInput`. */
      readonly onChange?: (value: string) => void;
  }
  /**
   * Themed single-line text input (design-system, runtime-api §3.2). Renders a single
   * OpenTUI `<input>` with token-resolved text/placeholder/background colors so a theme
   * swap re-colors it without editing sources. The mandatory `id` flows to the element
   * for the host's geometry queries and the shell's select/pin. `onChange` maps to the
   * intrinsic's `onInput` (fires on each edit) — the interactive path lands in phase 7;
   * in the static headless render the handler is inert. Colors are semantic token names.
   */
  function Input(props: InputProps): React.ReactNode;

  // ── src/runtime/ui/list
  /** One selectable row in a `List` (design-system §3.2). */
  interface ListItem {
      /** Stable per-item id; composes into each row's Text id. */
      readonly id: string;
      /** The rendered row label. */
      readonly label: string;
  }
  /** Props for the themed `List` component. `id` is the mandatory stable id (§3.2). */
  interface ListProps {
      /** Stable id the shell selects/pins on and each row id is derived from. */
      readonly id: string;
      readonly items: readonly ListItem[];
      /** The currently selected item id; its row gets the design's selection recipe. */
      readonly selectedId?: string;
      /** Interactive-path selection callback; inert in a static render. */
      readonly onSelect?: (id: string) => void;
  }
  /**
   * A vertical list of themed rows (design-system §3.2). Renders a `column` box of
   * one row per item. The selected row follows the design's selection recipe: a
   * `selection` background band, a `▸` (U+25B8) gutter marker in `accent`, and the
   * label in `selectionFg` bold; unselected rows show a blank gutter and a
   * `foreground` label. Each row carries a stable `${id}-${item.id}` so the host can
   * answer geometry queries and the shell can select/pin it. `onSelect` belongs to
   * the interactive path and does nothing here. Colors + marker match the engine.
   */
  function List(props: ListProps): React.ReactNode;

  // ── src/runtime/ui/panel
  /** Props for the `Panel` bordered container. `id` is the mandatory stable id (§3.2). */
  interface PanelProps {
      /** Stable id the host selects and answers geometry on. Mandatory on every catalog component. */
      readonly id: string;
      /** Optional caption drawn into the top border. */
      readonly title?: string;
      readonly children?: unknown;
      /** Uniform inner padding inside the border. */
      readonly padding?: number;
      /** The border hue; defaults to the theme's `border`. Design variants: `t.accent` (active/popup), `t.accentHi` (hover), `t.danger` (error), `t.line` (dimmed). */
      readonly borderColor?: Color;
      /** The title hue; defaults to the theme's `foreground`. Design variants: `t.accentHi` (popup/active), `t.foregroundMuted` (welded sub-panel). */
      readonly titleColor?: Color;
  }
  /**
   * A titled, bordered column container (design-system §3.2). Draws the design's rounded
   * frame (`box()`'s own default, `design/termcraft-engine.js:47`) with an optional `title`
   * space-padded into the top border (`:52`'s `' '+title+' '`), or no caption at all when
   * `title` is absent or empty — matching the engine's own `if(o.title){…}` guard.
   * `borderColor`/`titleColor` are `Color`s read off `useTokens()`: an active/popup panel
   * uses border `t.accent` + title `t.accentHi`; an error panel uses border `t.danger`; a
   * welded sub-panel uses title `t.foregroundMuted`. The mandatory `id` flows to the element
   * for host geometry.
   */
  function Panel(props: PanelProps): React.ReactNode;

  // ── src/runtime/ui/primitive
  const ALIGN: {
      readonly start: "flex-start";
      readonly center: "center";
      readonly end: "flex-end";
      readonly stretch: "stretch";
  };
  const JUSTIFY: {
      readonly start: "flex-start";
      readonly center: "center";
      readonly end: "flex-end";
      readonly between: "space-between";
      readonly around: "space-around";
  };
  /**
   * The low-level `Box` primitive — the facade-owned rendering escape hatch
   * (runtime-api §3.2). It exposes the raw flexbox + border/background surface a
   * bespoke widget needs (a superset of the semantic `Row`/`Column`) WITHOUT letting
   * an authored page import an `@opentui/*` path or bind to its release. Colors are
   * `Color` values — a page reads them off its own `useTokens()` (spec §4.5); the mandatory
   * `id` flows through for host geometry and shell select/pin.
   */
  interface BoxProps {
      /** Stable id the host answers geometry on and the shell selects/pins. Mandatory. */
      readonly id: string;
      readonly children?: unknown;
      readonly direction?: "row" | "column";
      readonly align?: keyof typeof ALIGN;
      readonly justify?: keyof typeof JUSTIFY;
      readonly gap?: number;
      readonly padding?: number;
      /** Flex grow factor — a 0 keeps the box at content size; ≥1 lets it expand. */
      readonly grow?: number;
      /** Flex shrink factor — a 0 refuses to give way when the line is over-full. */
      readonly shrink?: number;
      /** Flex basis — the main-axis starting size before grow/shrink, or `auto` for content size. */
      readonly basis?: number | "auto";
      /** Whether an over-full row/column wraps onto further lines. */
      readonly wrap?: "nowrap" | "wrap" | "wrap-reverse";
      /** Cross-axis placement of THIS box, overriding its parent's `align` for it alone. */
      readonly alignSelf?: "auto" | "start" | "center" | "end" | "stretch" | "baseline";
      readonly width?: Dimension;
      readonly height?: Dimension;
      readonly minWidth?: Dimension;
      readonly maxWidth?: Dimension;
      readonly minHeight?: Dimension;
      readonly maxHeight?: Dimension;
      /**
       * Outer spacing on all four sides. DELIBERATE OMISSION: OpenTUI also offers per-side and
       * per-axis margins; spec §6.2 asks for the scalar form only, and exposing more is additive.
       */
      readonly margin?: Dimension;
      /**
       * `absolute` takes the box out of its parent's flex flow and places it by the offsets below.
       * DELIBERATE OMISSION: OpenTUI's third value, `static`, is Yoga's own default and §6.2 does not
       * ask for it.
       */
      readonly position?: "relative" | "absolute";
      readonly top?: Dimension;
      readonly right?: Dimension;
      readonly bottom?: Dimension;
      readonly left?: Dimension;
      /** Paint order among overlapping siblings; higher paints later. */
      readonly zIndex?: number;
      /** What happens to content larger than the box. */
      readonly overflow?: "visible" | "hidden" | "scroll";
      /**
       * The frame: `true` for all four sides, `false`/omitted for none, or exactly the sides to
       * draw (spec §6.2).
       */
      readonly border?: boolean | readonly BorderSide[];
      /**
       * Which glyph table the frame is drawn from. OMITTED ON PURPOSE BY DEFAULT: `Box` is the
       * un-opinionated escape hatch (runtime-api §3.2), so with no `borderStyle` OpenTUI's own
       * `single` applies. The DESIGN's default frame is rounded
       * (`design/termcraft-engine.js:47` — `const r = o.rounded !== false`) and is pinned where it
       * belongs, on `Panel`, the design-conformant frame.
       */
      readonly borderStyle?: "single" | "double" | "rounded" | "heavy";
      /** A complete custom glyph set, replacing whatever `borderStyle` would have selected. */
      readonly borderChars?: BorderGlyphs;
      /** The border hue (only meaningful with `border`). Read one off `useTokens()` (spec §4.5). */
      readonly borderColor?: Color;
      /** Caption drawn into the TOP border row. */
      readonly title?: string;
      /** Where the top caption sits along its row; OpenTUI's own default is `left`. */
      readonly titleAlign?: "left" | "center" | "right";
      /** The caption hue. Read one off `useTokens()` (spec §4.5). */
      readonly titleColor?: Color;
      /** Caption drawn into the BOTTOM border row. */
      readonly bottomTitle?: string;
      /** Where the bottom caption sits along its row; OpenTUI's own default is `left`. */
      readonly bottomTitleAlign?: "left" | "center" | "right";
      /** The fill hue. Read one off `useTokens()` (spec §4.5). */
      readonly background?: Color;
  }
  /** The low-level box escape hatch (§3.2). Renders one OpenTUI `<box>` from `Color`-typed props. */
  function Box(props: BoxProps): React.ReactNode;

  // ── src/runtime/ui/row
  /** Props for the `Row` layout container. `id` is the mandatory stable id (§3.2). */
  interface RowProps {
      /** Stable id the host selects and answers geometry on. Mandatory on every catalog component. */
      readonly id: string;
      readonly children?: unknown;
      /** Cells of space inserted between children (Yoga gap). */
      readonly gap?: number;
      /** Uniform inner padding on all sides. */
      readonly padding?: number;
      /** Cross-axis placement of children; maps to Yoga `alignItems`. */
      readonly align?: "start" | "center" | "end" | "stretch";
      /** Main-axis distribution of children; maps to Yoga `justifyContent`. */
      readonly justify?: "start" | "center" | "end" | "between" | "around";
  }
  /**
   * A horizontal flex container (design-system §3.2). Lays its children out in a
   * row and maps the ergonomic `align`/`justify` prop vocabulary onto Yoga's
   * `alignItems`/`justifyContent`. The mandatory `id` flows to the element so the
   * host can answer geometry queries and the shell can select/pin it.
   */
  function Row(props: RowProps): React.ReactNode;

  // ── src/runtime/ui/separator
  /** Props for the `Separator` rule. `id` is the mandatory stable id (§3.2). */
  interface SeparatorProps {
      /** Stable id the host selects and answers geometry on. Mandatory on every catalog component. */
      readonly id: string;
      /** Orientation of the rule; defaults to `horizontal`. */
      readonly direction?: "horizontal" | "vertical";
      /** The rule's hue; defaults to the theme's `line` (the design's subtle-divider hue). */
      readonly color?: Color;
  }
  /**
   * A one-cell themed rule (design-system §3.2). A `horizontal` separator is a
   * full-width, single-row band; a `vertical` one is a full-height, single-column
   * band. It defaults to the theme's `line` hue — the design's subtle interior
   * divider (`border` is reserved for actual box frames drawn by Panel) — and takes
   * an optional `color`, a `Color` a caller reads off `useTokens()`, so a caller can pick
   * `t.border` for an active-frame rule or `t.accentHi` for a focused one. The mandatory
   * `id` flows to the element.
   * (MVP simplification: the design draws glyph rules `─`/`│` with `├┤┬┴` weld tees;
   * this renders a color band — a known divergence pending the phase-7 UI pass.)
   */
  function Separator(props: SeparatorProps): React.ReactNode;

  // ── src/runtime/ui/spacer
  /** Props for the `Spacer`. `id` is the mandatory stable id (§3.2). */
  interface SpacerProps {
      /** Stable id the host selects and answers geometry on. Mandatory on every catalog component. */
      readonly id: string;
      /** Fixed cell size (width and height); omit for a flexible spacer. */
      readonly size?: number;
  }
  /**
   * Empty space between siblings (design-system §3.2). With `size` it is a fixed
   * `size`×`size` box; without it, a flexible `flexGrow: 1` box that soaks up the
   * free main-axis space and pushes its siblings apart. The mandatory `id` flows
   * to the element for host geometry.
   */
  function Spacer(props: SpacerProps): React.ReactNode;

  // ── src/runtime/ui/sparkline
  /** Props for the themed `Sparkline` component. `id` is the mandatory stable id (§3.2). */
  interface SparklineProps {
      readonly id: string;
      /** The series to plot; an empty series renders empty. */
      readonly values: readonly number[];
      /** The glyph hue; defaults to the theme's `success` (the design's sparkline green). */
      readonly color?: Color;
  }
  /**
   * A single-line block-glyph trend (design-system §3.2). Scales each value between
   * the series min and max onto `▁…█` and renders the glyph string as one themed
   * `Text` in `color` (default `success` — the design renders sparklines in the
   * live/throughput green). An empty series renders an empty anchor — it never throws.
   */
  function Sparkline(props: SparklineProps): React.ReactNode;

  // ── src/runtime/ui/table
  /** A single table column descriptor (design-system §3.2). */
  interface TableColumn {
      /** Stable per-column id; composes into each cell's Text id. */
      readonly id: string;
      /** The header-row label. */
      readonly label: string;
      /** Fixed cell width in columns; cells pad/truncate to it when set. */
      readonly width?: number;
      /** Cell alignment within `width`; numeric columns use `right` (design convention). Defaults to `left`. */
      readonly align?: "left" | "right";
  }
  /** A single table data row (design-system §3.2). */
  interface TableRow {
      /** Stable per-row id; composes into each cell's Text id. */
      readonly id: string;
      /** Cell strings positional to `columns`; missing cells render empty. */
      readonly cells: readonly string[];
  }
  /** Props for the themed `Table` component. `id` is the mandatory stable id (§3.2). */
  interface TableProps {
      readonly id: string;
      readonly columns: readonly TableColumn[];
      readonly rows: readonly TableRow[];
      /** The currently selected row id; its row gets the design's selection recipe. */
      readonly selectedId?: string;
  }
  /**
   * A columnar table of themed cells (design-system §3.2). Composes a `column` box
   * of `row` boxes: a header row of `foregroundMuted` bold column labels (the
   * design's dim header hue), then one row per data row. The selected row follows
   * the design's selection recipe — a `selection` back-fill, a `▸` marker in
   * `accent`, and cells in `selectionFg`; unselected cells are `foreground`. Cells
   * fit to their column width and align left (or right for numeric columns). Rows
   * and cells carry stable `${id}-…` ids for host geometry + shell select/pin.
   */
  function Table(props: TableProps): React.ReactNode;

  // ── src/runtime/ui/tabs
  /** One tab: a stable `id` and its display `label`. */
  interface TabItem {
      readonly id: string;
      readonly label: string;
  }
  /** Props for the themed `Tabs` component. `id` is the mandatory stable id (§3.2). */
  interface TabsProps {
      /** Stable id the host selects/pins on (§3.2). Mandatory on every catalog component. */
      readonly id: string;
      /** The tabs to render, in display order. */
      readonly tabs: readonly TabItem[];
      /** The id of the currently active tab; its label renders bold + accent. */
      readonly activeId: string;
      /**
       * Invoked with a tab id when it is selected. Accepted for the interactive path
       * (the shell dispatches it in accepted interactive mode — phase 7); the MVP
       * static render is a highlighted label row and never calls it.
       */
      readonly onSelect?: (id: string) => void;
  }
  /**
   * Themed tab strip (design-system, runtime-api §3.2). MVP renders a STATIC
   * highlighted label row — an OpenTUI `<box flexDirection="row">` of label `Text`s;
   * the active tab is prefixed with the design's `▸` (U+25B8) marker and rendered
   * bold + `accent`, the rest `foregroundMuted`. The mandatory `id` flows to the box
   * for the host's geometry queries and the shell's select/pin, and each label
   * carries its own `${id}-tab-${tab.id}` id. `onSelect` is accepted for the phase-7
   * interactive path and stays inert here. Colors + marker match the design engine.
   */
  function Tabs(props: TabsProps): React.ReactNode;

  // ── src/runtime/ui/text
  /** Props for the themed `Text` component. `id` is the mandatory stable id (§3.2). */
  interface TextProps {
      /** Stable id selection and pins key on (§3.2). Mandatory on every catalog component. */
      readonly id: string;
      /**
       * Literal text, or the inline wrappers of `ui/inline` (`Span`, `Bold`, `Italic`, `Underline`,
       * `Link`, `LineBreak`). `unknown` rather than a named node union: the React/OpenTUI node type
       * is a private identity this facade must not leak into authored source (runtime-api §3.3), and
       * `BoxProps.children` already takes the same shape for the same reason.
       */
      readonly children?: unknown;
      /** The text hue; defaults to the theme's `foreground`. Read one off `useTokens()` (spec §4.5). */
      readonly color?: Color;
      readonly bold?: boolean;
      readonly dim?: boolean;
  }
  /**
   * Themed inline text (design-system, runtime-api §3.2). Renders a single OpenTUI
   * `<text>` with a `Color` foreground read off the theme and an attribute mask; the mandatory
   * `id` flows to the element so the host can answer geometry queries (checkHit/
   * rectOf) and the shell can select/pin it. The hue is a `Color` the caller supplies
   * — a page reads one off its own `useTokens()` (spec §4.5), so the project's design
   * system owns the palette and the catalog owns only the default.
   */
  function Text(props: TextProps): React.ReactNode;

  // ── the facade's public surface (src/runtime/index.ts)
  export type { Color, PageMeta, Size, ThemeId, ThemeTokens, TokenMap };
  export { CURRENT_KIT_API_VERSION, definePage };
  export { atom, computed, action, wrap, withAsync, withAsyncData, withComputed, withAbort, withConnectHook, reatomComponent };
  export type { Atom, Action, Computed, AtomLike, Ext, ConnectionCleanup, ConnectionHookResult };
  export { DEFAULT_THEME_ID, themeTokens, useTokens };
  export { colorDepthAtom, defineTweaks, isExport, isExportAtom, hostModeAtom, interactionModeAtom, themeCapability, usePages, viewportSizeAtom };
  export type { PagesCapability, ThemeCapability };
  export { jsx, jsxs, jsxDEV, Fragment };
  export { Box };
  export type { BoxProps };
  export { Row };
  export type { RowProps };
  export { Column };
  export type { ColumnProps };
  export { Panel };
  export type { PanelProps };
  export { Separator };
  export type { SeparatorProps };
  export { Spacer };
  export type { SpacerProps };
  export { Text };
  export type { TextProps };
  export { Button };
  export type { ButtonProps };
  export { Input };
  export type { InputProps };
  export { Tabs };
  export type { TabsProps, TabItem };
  export { List };
  export type { ListProps, ListItem };
  export { Table };
  export type { TableProps, TableColumn, TableRow };
  export { Gauge };
  export type { GaugeProps };
  export { Sparkline };
  export type { SparklineProps };
  export type { BorderGlyphs, BorderSide, Dimension };
  export { Span };
  export type { SpanProps };
}

declare module "@termcraft/runtime/jsx-dev-runtime" {
  export { jsxDEV } from "@opentui/react/jsx-dev-runtime";
}

declare module "@termcraft/runtime/jsx-runtime" {
  export { Fragment, jsx, jsxs } from "@opentui/react/jsx-runtime";
}
