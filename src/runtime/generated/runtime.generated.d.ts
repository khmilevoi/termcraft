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
   *      project's manifest. P4 does NOT import it from here: the two writers of that seed live in
   *      `store` (project create, and the mechanical migration), and `store` importing `runtime`
   *      would be a new module edge — so the seed values are declared in
   *      `entities/design-system/model/seed.ts` and pinned to THIS constant by an exact
   *      `toEqual` test (`seed.test.ts`). See plan P4's decision D3.
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

  // ── src/runtime/ui/ascii-font
  /**
   * The seven glyph sets `@opentui/core@0.4.5` ships (`lib/ascii.font.d.ts:3`), declared locally
   * rather than re-exported so an OpenTUI upgrade changes this adapter and not one saved page (§6).
   * Omitting `font` leaves OpenTUI's own default, `tiny`.
   */
  type AsciiFontName = "tiny" | "block" | "shade" | "slick" | "huge" | "grid" | "pallet";
  /** Props for the `AsciiFont` display text. `id` is the mandatory stable id (§3.2). */
  interface AsciiFontProps {
      /** Stable id the host answers geometry on and the shell selects/pins. Mandatory. */
      readonly id: string;
      /**
       * The string to draw. REQUIRED, where upstream's is optional: a banner with no text renders
       * nothing, and a silently empty element in an authored page reads as a broken render.
       */
      readonly text: string;
      /** Which glyph set to draw with; omitted leaves OpenTUI's `tiny`. */
      readonly font?: AsciiFontName;
      /**
       * The glyph hue; defaults to the theme's `foreground`.
       *
       * DESIGN GAP, RECORDED RATHER THAN GUESSED (CLAUDE.md): the project's design system contains
       * no ASCII-banner screen — `design/*.dc.html` and `design/termcraft-engine.js` have none — so
       * there is no design hue to take. The default is therefore the CATALOG's own established one
       * (`Text` defaults to `foreground` too), not an invented accent.
       *
       * DELIBERATE OMISSION: upstream also accepts an ARRAY of colours for a per-row gradient. §6.1
       * asks for a display-text wrapper, not a gradient API, and nothing in the design system would
       * pick the stops. Adding it later is additive.
       */
      readonly color?: Color;
      /** The fill behind the glyph block. Read one off `useTokens()` (spec §4.5). */
      readonly background?: Color;
  }
  /**
   * Large ASCII-art display text (design-system §6.1). Renders one OpenTUI `ascii-font` element,
   * sized by the chosen glyph set rather than by width/height props — upstream `Omit`s both
   * (`@opentui/core/renderables/ASCIIFont.d.ts:7`), so wrap it in a `Box` when it needs to be
   * placed or constrained. The mandatory `id` resolves for host geometry: unlike the inline text
   * family, this is a real layout `Renderable`.
   */
  function AsciiFont(props: AsciiFontProps): React.ReactNode;

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

  // ── src/runtime/ui/diff
  /** Props for the themed `Diff` view. `id` is the mandatory stable id (§3.2). */
  interface DiffProps {
      /** Stable id the host selects and answers geometry on. Mandatory on every catalog component. */
      readonly id: string;
      /**
       * The change to render, as ONE unified diff (a `--- / +++ / @@` patch). Only the first patch
       * in the string is rendered. An empty or unparseable value renders nothing rather than failing.
       */
      readonly patch: string;
      /** `unified` stacks the two sides, `split` puts them side by side. Defaults to `unified`. */
      readonly view?: "unified" | "split";
      /**
       * Whether to draw the line-number gutters — and with them, the `+`/`-` sign column, since the
       * vendor paints the signs INSIDE the gutter (see the component's own note). Defaults to `true`:
       * turning this off leaves added and removed rows with no marker distinguishing them at all.
       */
      readonly showLineNumbers?: boolean;
      /** How over-long lines break. Defaults to `"word"` (the code renderable's own default when unset). */
      readonly wrap?: "word" | "char" | "none";
      /** The content hue; defaults to the theme's `foreground`. */
      readonly color?: Color;
      /** The gutter digits' hue; defaults to the theme's `foregroundFaint`. */
      readonly lineNumberColor?: Color;
      /** The `+` sign's hue; defaults to the theme's `success`. */
      readonly addedColor?: Color;
      /** The `-` sign's hue; defaults to the theme's `danger`. */
      readonly removedColor?: Color;
      /**
       * The band behind an added line. Defaults to the theme's `background` — i.e. NO band; see the
       * component's own note on why, and supply a project token here to paint one.
       */
      readonly addedBackground?: Color;
      /** The band behind a removed line. Defaults to the theme's `background` — i.e. NO band. */
      readonly removedBackground?: Color;
  }
  /**
   * A themed unified/split diff view (design-system §6.1, the "Documents and code" group). Takes
   * one unified `patch` string and renders it with `+`/`-` signs riding inside the (by-default-on)
   * line-number gutters, and every colour resolved from the active theme. The mandatory `id` flows
   * to the element so the host can answer geometry queries and the shell can select/pin it.
   *
   * DEGRADATION, NOT FAILURE. An empty patch, or a string that is not a patch at all, renders an
   * empty frame; nothing throws. A patch whose hunk header disagrees with its body renders the
   * renderer's own parse-error message instead of the diff — a divergence recorded here because the
   * message is drawn in the renderer's own red, which is not a theme colour and cannot be
   * overridden through any prop.
   *
   * THE GUTTER AND THE SIGN COLUMN ARE ONE OBJECT — A VENDOR DIVERGENCE. `@opentui/core` paints the
   * `+`/`-` signs INSIDE the gutter renderable itself, and `showLineNumbers` toggles that same
   * object's visibility (there is no prop that keeps the signs and drops only the digits). Because
   * this component deliberately paints no background band (see the COLOURS note below), the sign
   * column is the ONLY thing that distinguishes an added row from a removed one — with it hidden, a
   * changed line reads as declared twice with nothing marking which version is which. `showLineNumbers`
   * therefore defaults to `true`: the bare `<Diff id={..} patch={..} />` call an author is most
   * likely to write must not silently discard the diff's own meaning. This still satisfies the
   * "every prop is passed explicitly" rule below — the value is written, not left to the vendor's
   * own default; it simply now agrees with it.
   *
   * COLOURS, AND THE ONE GAP. `color`/`lineNumberColor`/`addedColor`/`removedColor` default to the
   * theme's `foreground`/`foregroundFaint`/`success`/`danger` — the design's own vocabulary, where
   * green marks the live/resolved/positive and red the failed/negative.
   *
   * The row BACKGROUNDS are the gap. The design system carries no diff view at all: it paints no
   * green band anywhere, and the only red band it paints is the failure strip (`danger` on
   * `dangerDim`), which means something else. Rather than invent a diff palette, this component
   * carries the semantics on the signs and leaves both rows on the ordinary `background` — and
   * exposes `addedBackground`/`removedBackground` so a project whose own design system declares
   * diff hues can supply them. Passing the theme background EXPLICITLY is also what keeps
   * `@opentui/core`'s hard-coded `#1a4d1a`/`#4d1a1a` bands out of an authored page.
   *
   * Selection colours are passed from the theme but are not props: selection is host-driven chrome,
   * not page styling. The syntax-highlighting client is never exposed (spec §6).
   */
  function Diff(props: DiffProps): React.ReactNode;

  // ── src/runtime/ui/frame-buffer
  /**
   * The cell surface a `FrameBuffer`'s `draw` callback paints into (spec §6.1's "raw drawing …
   * the last escape hatch"). Every colour is a `Color` value read off `useTokens()`; the
   * underlying `OptimizedBuffer` is never handed out, so a page cannot reach the renderer.
   * Coordinates are buffer-local, origin top-left; a write outside the buffer is DROPPED.
   */
  interface FrameBufferSurface {
      /** The buffer's width in cells — the `width` prop. */
      readonly width: number;
      /** The buffer's height in cells — the `height` prop. */
      readonly height: number;
      /** Fill the whole buffer with one hue. */
      clear(color: Color): void;
      /**
       * Paint one cell.
       *
       * ASYMMETRY WITH {@link drawText}, DOCUMENTED (CLAUDE.md): an omitted `background` here
       * defaults to the OPAQUE {@link TRANSPARENT} constant, which ERASES whatever a prior
       * `clear()` painted at that cell. `drawText`'s omitted `background` instead defaults to
       * `undefined`, which PRESERVES it. The difference is forced by the vendor FFI, not a choice
       * made here: `OptimizedBuffer.setCell` takes a required `rgbaPtr` for its background
       * argument, while `drawText` takes an `optionalRgbaPtr` that can mean "leave it alone" — see
       * `createSurface`'s call sites below.
       */
      setCell(x: number, y: number, glyph: string, color: Color, background?: Color): void;
      /**
       * Paint a run of text starting at `x`,`y`. An omitted `background` PRESERVES whatever is
       * already there — see {@link setCell}'s doc comment for why the two methods differ here.
       */
      drawText(text: string, x: number, y: number, color: Color, background?: Color): void;
      /** Fill a rectangle with one hue. */
      fillRect(x: number, y: number, width: number, height: number, color: Color): void;
  }
  /** Props for the low-level `FrameBuffer`. `id` is the mandatory stable id (§3.2). */
  interface FrameBufferProps {
      /** Stable id the host answers geometry on and the shell selects/pins. Mandatory. */
      readonly id: string;
      /** Buffer width in cells. REQUIRED by the underlying renderable (spec §6.1's spike). */
      readonly width: number;
      /** Buffer height in cells. REQUIRED by the underlying renderable (spec §6.1's spike). */
      readonly height: number;
      /**
       * Paints the buffer. REQUIRED: the renderable renders NOTHING until it is drawn into (spec
       * §6.1's spike), so an optional `draw` would make the blank render the default.
       */
      readonly draw: (surface: FrameBufferSurface) => void;
  }
  /**
   * A raw cell buffer for bespoke graphics — spec §6.1's "last escape hatch". Renders the OpenTUI
   * `FrameBufferRenderable`, a renderable with no intrinsic tag, registered by
   * {@link registerRenderableTags}.
   *
   * HOW `draw` REACHES THE BUFFER, and why a `ref` is used INTERNALLY. The renderable exposes its
   * buffer only as an instance field and renders nothing until something paints into it (spec
   * §6.1's spike), so an instance handle is the only path. §6 forbids PASSING `ref` through to an
   * authored page, which this does not do: the callback ref below is termcraft's own, the page sees
   * only {@link FrameBufferSurface}, and the renderable never escapes. Because the inline callback's
   * identity changes on every render, React re-invokes it on every re-render, so a theme change
   * repaints the buffer.
   *
   * DETERMINISM (spec §6.3): the whole rendered state is a pure function of `draw`, `width` and
   * `height`, with no internal offset, focus or selection — so the export frame equals the preview
   * frame for the same props, which is what `./frame-buffer.test.tsx` asserts.
   */
  function FrameBuffer(props: FrameBufferProps): React.ReactNode;

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
      /**
       * Stable id the shell keys on. Mandatory on every catalog component — see the module note: an
       * inline id is stable and part of the export vocabulary, but it is NOT addressable by the
       * host's geometry queries.
       */
      readonly id: string;
      /** Literal text, or further inline wrappers. */
      readonly children?: unknown;
      /**
       * The run's hue. Omitted, it INHERITS the enclosing `Text`'s colour (which itself defaults to
       * the theme's `foreground`) — OpenTUI merges text-node styles down the chain, so a `Span`
       * inside a red `Text` is red. Read one off `useTokens()` (spec §4.5).
       */
      readonly color?: Color;
  }
  /**
   * An inline run of text inside a `Text` (design-system §6.1). Its only styling is a hue — for
   * weight, slant or underline, wrap it in `Bold`, `Italic` or `Underline`. Must be nested in a
   * `Text`; on its own it has no container to attach to.
   */
  function Span(props: SpanProps): React.ReactNode;
  /** Props for the inline `Bold`. `id` is the mandatory stable id (§3.2). */
  interface BoldProps {
      /**
       * Stable id the shell keys on. Mandatory on every catalog component — see the module note: an
       * inline id is stable and part of the export vocabulary, but it is NOT addressable by the
       * host's geometry queries.
       */
      readonly id: string;
      /** Literal text, or further inline wrappers. */
      readonly children?: unknown;
      /**
       * The run's hue. Omitted, it INHERITS the enclosing `Text`'s colour (which itself defaults to
       * the theme's `foreground`) — OpenTUI merges text-node styles down the chain, so a `Span`
       * inside a red `Text` is red. Read one off `useTokens()` (spec §4.5).
       */
      readonly color?: Color;
  }
  /**
   * A bold inline run inside a `Text` (design-system §6.1). The weight comes from the intrinsic
   * itself — `@opentui/react`'s `b` renderable ORs `TextAttributes.BOLD` into the run — so nesting
   * `Bold` inside `Italic` combines both rather than replacing one.
   */
  function Bold(props: BoldProps): React.ReactNode;
  /** Props for the inline `Italic`. `id` is the mandatory stable id (§3.2). */
  interface ItalicProps {
      /**
       * Stable id the shell keys on. Mandatory on every catalog component — see the module note: an
       * inline id is stable and part of the export vocabulary, but it is NOT addressable by the
       * host's geometry queries.
       */
      readonly id: string;
      /** Literal text, or further inline wrappers. */
      readonly children?: unknown;
      /**
       * The run's hue. Omitted, it INHERITS the enclosing `Text`'s colour (which itself defaults to
       * the theme's `foreground`) — OpenTUI merges text-node styles down the chain, so a `Span`
       * inside a red `Text` is red. Read one off `useTokens()` (spec §4.5).
       */
      readonly color?: Color;
  }
  /**
   * An italic inline run inside a `Text` (design-system §6.1). The slant comes from the intrinsic
   * (`TextAttributes.ITALIC`); whether the terminal actually renders italics is the terminal's
   * choice, and the attribute is carried into the export snapshot either way.
   */
  function Italic(props: ItalicProps): React.ReactNode;
  /** Props for the inline `Underline`. `id` is the mandatory stable id (§3.2). */
  interface UnderlineProps {
      /**
       * Stable id the shell keys on. Mandatory on every catalog component — see the module note: an
       * inline id is stable and part of the export vocabulary, but it is NOT addressable by the
       * host's geometry queries.
       */
      readonly id: string;
      /** Literal text, or further inline wrappers. */
      readonly children?: unknown;
      /**
       * The run's hue. Omitted, it INHERITS the enclosing `Text`'s colour (which itself defaults to
       * the theme's `foreground`) — OpenTUI merges text-node styles down the chain, so a `Span`
       * inside a red `Text` is red. Read one off `useTokens()` (spec §4.5).
       */
      readonly color?: Color;
  }
  /**
   * An underlined inline run inside a `Text` (design-system §6.1). The rule comes from the
   * intrinsic (`TextAttributes.UNDERLINE`), not from a drawn glyph, so it never consumes a row.
   */
  function Underline(props: UnderlineProps): React.ReactNode;
  /** Props for the inline `Link`. `id` is the mandatory stable id (§3.2). */
  interface LinkProps {
      /**
       * Stable id the shell keys on. Mandatory on every catalog component — see the module note: an
       * inline id is stable and part of the export vocabulary, but it is NOT addressable by the
       * host's geometry queries.
       */
      readonly id: string;
      /** The link target, emitted as a terminal hyperlink. Required: a link with no target is text. */
      readonly href: string;
      /** The label; literal text, or further inline wrappers. */
      readonly children?: unknown;
      /**
       * The label's hue. Omitted, it INHERITS the enclosing `Text`'s colour (which itself defaults
       * to the theme's `foreground`) — OpenTUI merges text-node styles down the chain, so a `Link`
       * inside a red `Text` is red. Read one off `useTokens()` (spec §4.5).
       */
      readonly color?: Color;
  }
  /**
   * A terminal hyperlink inside a `Text` (design-system §6.1). The label renders as ordinary
   * inline text; `href` becomes the run's hyperlink target in terminals that support it.
   *
   * DESIGN GAP, RECORDED RATHER THAN GUESSED (CLAUDE.md): the design system defines no distinct
   * link hue, so an omitted `color` inherits the enclosing `Text`'s hue like every other inline
   * run instead of inventing one — pass `color={t.accent}` for the conventional highlighted link.
   *
   * DIVERGENCE: a hyperlink TARGET is not observable in a captured frame. `StyledRun`
   * (`src/host/protocol/types.ts:77-83`) carries text, colours and attributes and has no link
   * field, so an export snapshot preserves the label and drops the target. The tests assert the
   * label and its hue for exactly that reason.
   */
  function Link(props: LinkProps): React.ReactNode;
  /** Props for the inline `LineBreak`. `id` is the mandatory stable id (§3.2) and its only prop. */
  interface LineBreakProps {
      /**
       * Stable id the shell keys on. Mandatory, with no exception carved for this element: `id` is
       * the ENTIRE prop surface the `br` intrinsic has (`LineBreakProps = Pick<SpanProps, "id">`,
       * `@opentui/react/src/types/components.d.ts:37`), and spec §6 states the rule without
       * exception — see the module note: an inline id is stable and part of the export vocabulary,
       * but it is NOT addressable by the host's geometry queries.
       */
      readonly id: string;
  }
  /**
   * A hard line break inside a `Text` (design-system §6.1). Takes no children and no styling — the
   * intrinsic emits a newline and nothing else. Use it to split one `Text` across rows without
   * paying for a second container.
   */
  function LineBreak(props: LineBreakProps): React.ReactNode;

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

  // ── src/runtime/ui/line-number
  /** Props for the themed `LineNumber` gutter. `id` is the mandatory stable id (§3.2). */
  interface LineNumberProps {
      /** Stable id the host selects and answers geometry on. Mandatory on every catalog component. */
      readonly id: string;
      /**
       * The content whose lines are numbered — EXACTLY ONE text-like child (`Text` today; `Input`,
       * and later `Textarea`/`Code`, qualify too). A second child is silently dropped and a child
       * that is not text-like leaves the gutter unbuilt, so nothing renders at all. See the
       * component's own note.
       */
      readonly children?: unknown;
      /** The gutter digits' hue; defaults to the theme's `foregroundFaint`. */
      readonly color?: Color;
      /** The gutter's fill; defaults to the theme's `background` (the design paints no gutter fill). */
      readonly background?: Color;
      /** The number the first line carries; defaults to `1`. */
      readonly startAt?: number;
      /**
       * Minimum gutter width in cells, so a growing file does not shift the content sideways.
       * Defaults to `3`. The vendor also applies this as the outer box's own minimum width, which is
       * harmless here since the gutter is already at least that wide.
       */
      readonly minWidth?: number;
      /**
       * Cells of space between the digits and the content. Defaults to `1`. The vendor option this
       * maps to (`paddingRight`) is ALSO a base layout prop, so it double-applies: it inserts the gap
       * on the left of the content AND pads the same number of cells onto the component's own right
       * edge, costing that much content width there too. There is no prop that separates the two
       * effects; a large `gap` narrows the content column on both sides.
       */
      readonly gap?: number;
  }
  /**
   * A themed line-number gutter around one text-like child (design-system §6.1, the "Documents and
   * code" group). Renders an OpenTUI `<line-number>` whose numbering target is wired from the child
   * itself — the underlying `target` is a renderer object and is deliberately never a prop (spec
   * §6). The mandatory `id` flows to the element so the host can answer geometry queries and the
   * shell can select/pin it.
   *
   * ONE CHILD, AND IT MUST BE TEXT-LIKE. The renderable adopts the FIRST child that reports line
   * information (`Text`, `Input`, and later `Textarea`/`Code`) as its numbering target; every later
   * child is refused and never appears. A child that reports no line information — a `Row`, a
   * `Panel`, a `Box` — leaves the gutter unbuilt and the whole component draws nothing. Neither
   * case throws; both are covered by tests beside this file.
   *
   * `Diff` can NOT be a child: it carries no line information of its own (it composes its own
   * internal gutters). Use `Diff`'s `showLineNumbers` instead.
   *
   * COLOURS. `color` defaults to `foregroundFaint` — the role the design gives placeholders, ghost
   * rows and column headers, which is the weight a gutter reads at; the design draws no gutter of
   * its own, so this is the closest faithful mapping rather than a quoted value. `background`
   * defaults to the theme's `background`: the design paints no gutter fill, and passing the value
   * explicitly is what stops `@opentui/core`'s own `#888888` default from reaching the frame.
   */
  function LineNumber(props: LineNumberProps): React.ReactNode;

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
      /**
       * What happens to content larger than the box. `scroll` currently clips exactly like `hidden`
       * on `Box`: `Renderable` installs a scissor rect for any value other than `visible` but gives
       * `Box` neither a scroll offset nor any affordance to move it — a scrollable container is
       * `ScrollBox`'s job (plan P7), not this one.
       */
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

  // ── src/runtime/ui/renderable-tags
  /**
   * Register the four tagless renderables as JSX tags. Idempotent, and called as the FIRST
   * statement of each wrapper's component body rather than at module scope: React runs a component
   * function during render and creates its host instances during commit, so a call in the body is
   * provably ordered before the reconciler looks the tag up in `getComponentCatalogue()`, without
   * making `src/runtime/ui/*` import-order-sensitive.
   */
  function registerRenderableTags(): void;

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

  // ── src/runtime/ui/scroll-bar
  /**
   * Props for the themed `ScrollBar`. `id` is the mandatory stable id (§3.2); `orientation` is
   * REQUIRED by the underlying renderable's constructor, and the scroll state is required because
   * an export snapshot must render it from props rather than from the renderable's own mutable
   * offset (spec §6.3). There is deliberately NO `children`: the renderable is a leaf (spec §6.1's
   * spike).
   */
  interface ScrollBarProps {
      /** Stable id the host answers geometry on and the shell selects/pins. Mandatory. */
      readonly id: string;
      readonly orientation: "horizontal" | "vertical";
      /** The full scrollable extent, in cells. */
      readonly contentSize: number;
      /** The visible window's extent, in cells. */
      readonly viewportSize: number;
      /** The window's offset into the content, in cells; clamped to `0..contentSize - viewportSize`. */
      readonly position: number;
      /** The track hue. Read one off `useTokens()` (spec §4.5). Defaults to `line`. */
      readonly trackColor?: Color;
      /** The thumb hue. Read one off `useTokens()` (spec §4.5). Defaults to `accentDim`. */
      readonly thumbColor?: Color;
      /** Step arrows at both ends; OFF by default, matching the design's scrollbar. */
      readonly showArrows?: boolean;
      /**
       * The arrow hue when `showArrows` is set. Defaults to `foregroundFaint`.
       *
       * DESIGN GAP, FLAGGED (CLAUDE.md): `design/termcraft-engine.js`'s `scrollbar()` draws its
       * track and thumb only — arrows are OFF unconditionally (its own comment: "Arrows off") — so
       * the design supplies no arrow hue anywhere for this control. `foregroundFaint` is chosen for
       * a case the design does not cover, not read off it.
       */
      readonly arrowColor?: Color;
      readonly width?: number;
      readonly height?: number;
      /** Invoked with the new offset when the bar is dragged; inert in the static render. */
      readonly onScroll?: (position: number) => void;
  }
  /**
   * A proportional scroll indicator (spec §6.1). Renders the OpenTUI `ScrollBarRenderable` — a
   * renderable with no intrinsic tag, registered by {@link registerRenderableTags} — whose inner
   * track is a `SliderRenderable` drawing a `█`/`▀`/`▄` thumb at half-cell precision.
   *
   * COLOURS AND ARROWS COME FROM THE DESIGN (`design/termcraft-engine.js`'s `scrollbar()`): a track
   * in `line`, a thumb in `amberDim` (the `accentDim` role), arrows off.
   *
   * DIVERGENCE, DOCUMENTED RATHER THAN SUBSTITUTED (CLAUDE.md): the design draws the track as a
   * `│` glyph rule, while `SliderRenderable` paints its track as a solid background fill. The glyph
   * half cannot be reproduced through this renderable, so the closest faithful mapping is used —
   * track BACKGROUND `line`, thumb FOREGROUND `accentDim`.
   *
   * PROP ORDER IS LOAD-BEARING, and this is measured rather than assumed. `scrollSize`,
   * `viewportSize` and `scrollPosition` are not constructor options; `@opentui/react`'s
   * `setInitialProperties` applies them as plain property writes, iterating `for (const propKey in
   * props)` — i.e. in the order written below. `scrollPosition`'s setter clamps against
   * `scrollSize - viewportSize`, so a position written before its bounds would clamp to 0.
   *
   * The same constructor-captured-handler divergence recorded on `./slider.tsx` applies to
   * `onChange` here.
   */
  function ScrollBar(props: ScrollBarProps): React.ReactNode;

  // ── src/runtime/ui/scroll-box
  /** Props for the `ScrollBox` scrolling viewport. `id` is the mandatory stable id (§3.2). */
  interface ScrollBoxProps {
      /** Stable id the host answers geometry on and the shell selects/pins. Mandatory. */
      readonly id: string;
      readonly children?: unknown;
      /** Content axis, and therefore the scrolling axis. Defaults to `column`. */
      readonly direction?: "row" | "column";
      /** Gap between the content's children. */
      readonly gap?: number;
      /** Inner padding around the content. */
      readonly padding?: number;
      /** Flex grow factor of the viewport itself. */
      readonly grow?: number;
      readonly width?: number;
      /** Viewport height in rows. A viewport shorter than its content is the point. */
      readonly height?: number;
      readonly border?: boolean;
      /** The frame hue; defaults to the theme's `border`. Read one off `useTokens()` (§4.5). */
      readonly borderColor?: Color;
      /** The viewport fill; defaults to the theme's `background`. Read one off `useTokens()`. */
      readonly background?: Color;
      /** Whether the viewport holds keyboard focus. Always false under export (§6.3). */
      readonly focused?: boolean;
      /**
       * Pin the viewport to the NEWEST content — the design's chat-scroll "following" state
       * (`design/termcraft-engine.js:1474-1495`, §28). IGNORED UNDER EXPORT (§6.3): a snapshot is
       * always taken at offset 0.
       */
      readonly follow?: boolean;
  }
  /**
   * A scrolling viewport (design-system §3.2, spec §6.1). Renders one OpenTUI `<scrollbox>`: a
   * fixed-size frame over content taller (or wider) than itself, with a proportional scrollbar
   * themed to the design's §28 recipe — a track in `line` and a thumb in `accentDim`, arrows off
   * (`design/termcraft-engine.js:1478-1483`); this is a REAL DESIGN FACT, drawn there. A focused
   * frame is drawn in `accentHi`, the hue the design's own palette legend labels `focus`
   * (`design/termcraft-engine.js:1876`) — but the design ships no screen of an authored page's
   * focused scroll frame, so `focusedBorderColor = accentHi` is a MAPPING onto existing vocabulary,
   * recorded here rather than invented as a new hue.
   *
   * DIVERGENCE, STATED RATHER THAN SILENTLY SUBSTITUTED: the design's thumb is `█` with `▀`/`▄` at
   * half-cell precision, drawn by the engine itself. OpenTUI's `SliderRenderable` draws its own
   * glyphs and exposes only two colours, so this wrapper reproduces the HUES and the arrows-off
   * rule and not the half-cell thumb.
   *
   * NO SCROLL-OFFSET PROP, AND NO SCROLL CALLBACK. `ScrollBoxOptions` carries neither: `scrollTop`
   * exists only as a class setter, and the scrollbars' own `onChange` is overwritten by
   * `ScrollBoxRenderable`'s constructor after the caller's spread. Position is therefore expressed
   * declaratively, through `follow`, which is the design's own vocabulary for it.
   *
   * EXPORT DETERMINISM (§6.3): under `hostMode === "export"` the viewport is pinned to the START
   * edge — offset 0 — whatever `follow` says, and the frame is blurred with its focused hue
   * collapsed onto the unfocused one.
   */
  function ScrollBox(props: ScrollBoxProps): React.ReactNode;

  // ── src/runtime/ui/select
  /** One selectable row in a `Select` (spec §6.1). */
  interface SelectItem {
      /** Stable per-item id; what `onSelect`/`onHighlight` report. */
      readonly id: string;
      /** The rendered row label. */
      readonly label: string;
  }
  /** Props for the themed `Select` component. `id` is the mandatory stable id (§3.2). */
  interface SelectProps {
      /** Stable id the host answers geometry on and the shell selects/pins. Mandatory. */
      readonly id: string;
      /** The choices, in display order. */
      readonly items: readonly SelectItem[];
      /**
       * The highlighted item's id. A `Select` is a CURSOR, not an optional highlight: an absent or
       * unmatched id lands on the first item, unlike `List`, where no `selectedId` means no
       * selection band at all.
       */
      readonly selectedId?: string;
      /** Whether the list holds keyboard focus. Always false under export (§6.3). */
      readonly focused?: boolean;
      /** Viewport height in rows; defaults to the item count (one row per item). */
      readonly height?: number;
      /**
       * Invoked with an item id when the cursor MOVES onto it (the intrinsic's `onChange`). The
       * interactive path lands in phase 7; in the static headless render the handler is inert.
       */
      readonly onHighlight?: (id: string) => void;
      /**
       * Invoked with an item id when it is COMMITTED (the intrinsic's `onSelect`, i.e. Enter). The
       * interactive path lands in phase 7; in the static headless render the handler is inert.
       */
      readonly onSelect?: (id: string) => void;
  }
  /**
   * Themed single-choice list (design-system §3.2, spec §6.1). Renders one OpenTUI `<select>`,
   * one line per item, with the design's selection recipe: a `selection` back-fill and
   * `selectionFg` text on the cursor row (`design/termcraft-engine.js:499-503`, the agent/model
   * picker), `foreground` on the rest, over the terminal `background`. A focused list lifts its
   * body onto `surface` — the role its own definition calls the "lifted input body" fill; the
   * design ships no screen of an authored page's focused select, so that is a MAPPING onto
   * existing vocabulary, recorded here rather than invented as a new hue.
   *
   * CONTROLLED, WITH NO REF. `SelectRenderable`'s `selectedIndex` and `options` setters both clamp
   * and emit nothing (measured against `@opentui/core@0.4.5`), so re-passing them every render can
   * never loop back into `onHighlight`. `options` is written before `selectedIndex` so the clamp
   * sees the new list.
   *
   * THAT IS TRUE OF THE SETTER, NOT OF PREVIEW SYNC. `@opentui/react`'s `updateProperties` only
   * re-applies a prop whose value CHANGED, and `SelectRenderable`'s own keyboard handling mutates
   * `_selectedIndex` directly — so once the phase-7 input path lands, a user keyboard move followed
   * by a re-render carrying the SAME `selectedId` will not correct the instance; the cursor stays
   * where the user left it. This does not affect export (there is no keyboard there); the phase-7
   * input path owes this a real controlled sync.
   *
   * DIVERGENCE, STATED RATHER THAN SILENTLY SUBSTITUTED: the cursor marker is OpenTUI's own `▶ `
   * (U+25B6). The design's marker is `▸` (U+25B8) — the glyph `List` and `Tabs` render — but
   * `SelectRenderableOptions` exposes no marker character. Descriptions are off (upstream defaults
   * them ON, which would paint a blank line per item) and the scroll indicator is off (upstream
   * draws it in a hard-coded `#666666` that no theme can reach).
   *
   * EXPORT DETERMINISM (§6.3): under `hostMode === "export"` the widget is blurred and its focused
   * fill collapses onto the unfocused one, so the frame is a function of `items` + `selectedId`
   * alone.
   */
  function Select(props: SelectProps): React.ReactNode;

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

  // ── src/runtime/ui/slider
  /**
   * Props for the themed `Slider`. `id` is the mandatory stable id (§3.2); `orientation` is
   * REQUIRED by the underlying renderable's constructor (spec §6.1's spike), and `value` is
   * required because a slider's rendered state must come from props rather than from the
   * renderable's own mutable `_value` (spec §6.3).
   */
  interface SliderProps {
      /** Stable id the host answers geometry on and the shell selects/pins. Mandatory. */
      readonly id: string;
      readonly orientation: "horizontal" | "vertical";
      /** The current value, clamped by the renderable into `min`..`max`. */
      readonly value: number;
      /** Range floor; defaults to 0. */
      readonly min?: number;
      /** Range ceiling; defaults to 100. */
      readonly max?: number;
      /** The unfilled track hue. Read one off `useTokens()` (spec §4.5). Defaults to `border`. */
      readonly trackColor?: Color;
      /** The thumb hue. Read one off `useTokens()` (spec §4.5). Defaults to `accent`. */
      readonly fillColor?: Color;
      /** Track length in cells for a horizontal slider. */
      readonly width?: number;
      /** Track length in cells for a vertical slider. */
      readonly height?: number;
      /** Invoked with the new value when the slider is dragged; inert in the static render. */
      readonly onChange?: (value: number) => void;
  }
  /**
   * A draggable value track (spec §6.1). Renders the OpenTUI `SliderRenderable` — a renderable
   * with no intrinsic tag, registered by {@link registerRenderableTags} — as a solid track filled
   * with `trackColor` and a thumb drawn in `fillColor` at half-cell precision: `█`/`▌`/`▐` on the
   * horizontal path, `█`/`▀`/`▄` on the vertical path (`renderVertical` in `@opentui/core`).
   *
   * DESIGN GAP, FLAGGED RATHER THAN GUESSED (CLAUDE.md): the design system has NO standalone
   * slider. Its nearest covered element is the gauge (`design/termcraft-engine.js`'s gauge draw,
   * implemented in `./gauge.tsx`), which fills in `accent` over a track in `border`; those two
   * roles are reused here as the closest faithful mapping, not invented.
   *
   * DIVERGENCE, DOCUMENTED RATHER THAN SUBSTITUTED (CLAUDE.md): the gauge whose colour mapping is
   * reused here draws its track as a `╌` dashed glyph rule in `border` (`design/termcraft-engine.js`'s
   * gauge draw method, `./gauge.tsx`'s `EMPTY_GLYPH`), while `SliderRenderable` paints its track as
   * a solid `border` BACKGROUND band — the same glyph-rule-vs-colour-band gap `./scroll-bar.tsx`
   * documents for its own track. The glyph half cannot be reproduced through this renderable, so
   * the closest faithful mapping is used: track BACKGROUND `border`, thumb FOREGROUND `accent`.
   *
   * The thumb's SIZE follows OpenTUI's own proportional rule (its `viewPortSize` defaults to 10% of
   * the range). No prop is exposed for it: naming that number in termcraft's vocabulary would mean
   * inventing a semantic the design does not have.
   *
   * DIVERGENCE, MEASURED: `SliderRenderable` captures `onChange` in its CONSTRUCTOR
   * (`_onChange = options.onChange`) and exposes no setter for it, so a handler whose identity
   * changes after mount keeps invoking the first one. The wrapper cannot fix that without reaching
   * the instance through a `ref`, which §6 forbids exposing; it is recorded here instead. The
   * interactive path is inert in the current static render either way.
   *
   * PROP ORDER IS LOAD-BEARING, and this is measured rather than assumed — the same hazard
   * `./scroll-bar.tsx` documents and handles for its own three ordered props. `@opentui/react`'s
   * `updateProperties` applies changed props as plain property writes, iterating `for (const
   * propKey in newProps)` — i.e. in JSX attribute order. `SliderRenderable`'s `value` setter
   * clamps against the CURRENT `_min`/`_max`, while the `min`/`max` setters' own re-clamp is
   * ASYMMETRIC: `min`'s setter only pushes `_value` UP when it now falls below the new floor, and
   * `max`'s setter only pushes it DOWN when it now exceeds the new ceiling — neither ever moves
   * `_value` the other direction. Written `value` first (as this attribute list once was), an
   * in-place re-render that changes bounds and value together clamps the new `value` against the
   * STALE bounds, then the bounds settle afterwards without re-touching `_value` — the thumb lands
   * on the wrong cell, and because export re-mounts fresh, preview then renders a DIFFERENT frame
   * from export, breaking the §6.3 determinism property. Writing `min`, then `max`, then `value`
   * last means the bounds are already settled before the final `value` write clamps against them.
   */
  function Slider(props: SliderProps): React.ReactNode;

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

  // ── src/runtime/ui/text-table
  /** One styled run inside a table cell. Colours are `Color` values read off `useTokens()`. */
  interface TextTableSpan {
      readonly text: string;
      /** Text hue; defaults to the table's `textColor`. */
      readonly color?: Color;
      /** Cell-run back-fill. */
      readonly background?: Color;
      readonly bold?: boolean;
      readonly italic?: boolean;
      readonly underline?: boolean;
  }
  /**
   * A single cell: a plain string, or a run list when parts of it need their own style.
   * The underlying renderable takes styled runs and nothing else (spec §6.1's spike); the plain
   * string form is termcraft's own convenience over that, converted here.
   */
  type TextTableCell = string | readonly TextTableSpan[];
  /** Props for the themed `TextTable`. `id` is the mandatory stable id (§3.2). */
  interface TextTableProps {
      /** Stable id the host answers geometry on and the shell selects/pins. Mandatory. */
      readonly id: string;
      /** Rows of cells, positional. A short row simply renders fewer columns. */
      readonly rows: readonly (readonly TextTableCell[])[];
      /** Draw a single-line grid. OFF by default — the design's tables are borderless. */
      readonly borders?: boolean;
      /** The grid hue when `borders` is set. Defaults to `border`. */
      readonly borderColor?: Color;
      /** The default cell text hue. Defaults to `foreground`. */
      readonly textColor?: Color;
      /** The table's back-fill. */
      readonly background?: Color;
      /** Cells between columns; defaults to 1, matching the design's table gutter. */
      readonly columnGap?: number;
      /** Wrapping inside a cell; defaults to `word`. */
      readonly wrap?: "none" | "char" | "word";
      /** Padding inside every cell. */
      readonly cellPadding?: number;
      readonly width?: number;
      readonly height?: number;
  }
  /**
   * A grid of styled text cells (spec §6.1). Renders the OpenTUI `TextTableRenderable` — a
   * renderable with no intrinsic tag, registered by {@link registerRenderableTags} — which
   * measures its own column widths and wraps inside a cell, which is what it offers over the
   * hand-composed `./table.tsx`.
   *
   * BORDERS ARE OFF BY DEFAULT because the design's tables are borderless column layouts (the
   * shape `./table.tsx` implements from `design/termcraft-engine.js`). With `borders` set, the
   * style is `rounded` in the `border` token: `design/termcraft-engine.js:47` — `box()`'s own
   * default is ROUNDED (`const r = o.rounded !== false`), and no design call site opts out
   * (`rounded:false` appears zero times in the file). `square` corners are the opt-out here too,
   * matching `./panel.tsx`'s house rule for the same reason: no design screen takes it.
   *
   * THE RENDERABLE'S OWN DEFAULTS ARE A HARDCODED `#FFFFFF` for both `borderColor` and `fg`, so
   * this wrapper always passes both from the active theme: no raw white can reach a frame.
   *
   * SELECTION IS DISABLED UNCONDITIONALLY (spec §6.3). `TextTableRenderable` defaults
   * `selectable: true` and keeps its own `_lastLocalSelection`, which is exactly the kind of
   * renderer-internal state an export snapshot must not depend on; row selection is `./table.tsx`'s
   * job, driven from props.
   */
  function TextTable(props: TextTableProps): React.ReactNode;

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

  // ── src/runtime/ui/textarea
  /** Props for the themed `Textarea` component. `id` is the mandatory stable id (§3.2). */
  interface TextareaProps {
      /** Stable id the host answers geometry on and the shell selects/pins. Mandatory. */
      readonly id: string;
      /**
       * The text the editor starts from. UNDER EXPORT this is exactly what renders, on every render
       * (§6.3). In preview it behaves like an HTML `defaultValue` — see the divergence note below.
       */
      readonly value?: string;
      /** Placeholder shown while the buffer is empty. */
      readonly placeholder?: string;
      /** Whether the editor holds keyboard focus. Always false under export (§6.3). */
      readonly focused?: boolean;
      readonly width?: number;
      /** Height in rows. An editor is a viewport, so give it one (or a growing parent). */
      readonly height?: number;
      /** Flex grow factor — a 0 keeps the editor at its height; ≥1 lets it expand. */
      readonly grow?: number;
      /** Soft-wrap mode for long lines. Defaults to `word`. */
      readonly wrap?: "none" | "char" | "word";
      /**
       * Invoked with the whole buffer text on every edit (the intrinsic's `onContentChange`). The
       * interactive path lands in phase 7; in the static headless render the handler is inert. Its
       * value is read off the instance through the wrapper's own callback ref (see the component doc
       * comment below), and that ref path has never been exercised — nothing delivers keystrokes to a
       * page today, so it is covered only by a "mounts and renders with handlers attached" test.
       * Whoever builds the interactive path must exercise it before relying on it.
       */
      readonly onChange?: (value: string) => void;
      /**
       * Invoked when the editor's submit binding fires. The interactive path lands in phase 7; in the
       * static headless render the handler is inert.
       */
      readonly onSubmit?: () => void;
  }
  /**
   * Themed multi-line text editor (design-system §3.2, spec §6.1). Renders one OpenTUI
   * `<textarea>` with token-resolved text/placeholder/selection colours, so a theme swap re-colours
   * it without editing sources. A focused editor lifts its body from `background` onto `surface` —
   * the role its own definition calls the "lifted input body" fill; the design ships no screen of
   * an authored page's focused editor, so that is a MAPPING onto existing vocabulary, recorded
   * here rather than invented as a new hue.
   *
   * DIVERGENCE, STATED RATHER THAN SILENTLY SUBSTITUTED. `@opentui/core@0.4.5`'s `TextareaOptions`
   * has no `value`; it has `initialValue`, whose setter is a ONE-SHOT LATCH — it applies the first
   * time and ignores every later write. In PREVIEW this wrapper therefore behaves like an HTML
   * `defaultValue`: a `value` change after mount does not re-apply, because keying the element on
   * the text would remount the editor (losing cursor and undo) on every keystroke once the phase-7
   * input path lands. UNDER EXPORT that trade is not available — §6.3 requires the value to come
   * from props rather than internal state — so the element IS keyed on the text there, and a
   * changed `value` produces a fresh instance whose latch fires again.
   *
   * `onChange` reads the buffer through a ref this component owns and never exposes (no
   * passthrough, spec §6): upstream's `ContentChangeEvent` is an EMPTY interface, so the event
   * carries no text and `plainText` off the instance is the only source. It is a CALLBACK ref
   * rather than `useRef` because this repository installs no `@types/react` (see
   * `host/render/model/error-capture.ts`), which makes any `react` import a TS7016.
   */
  function Textarea(props: TextareaProps): React.ReactNode;

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
  export { LineNumber };
  export type { LineNumberProps };
  export { Diff };
  export type { DiffProps };
  export { Select };
  export type { SelectProps, SelectItem };
  export { Textarea };
  export type { TextareaProps };
  export { ScrollBox };
  export type { ScrollBoxProps };
  export type { BorderGlyphs, BorderSide, Dimension };
  export { Span };
  export type { SpanProps };
  export { Bold, Italic, Underline };
  export type { BoldProps, ItalicProps, UnderlineProps };
  export { Link, LineBreak };
  export type { LinkProps, LineBreakProps };
  export { AsciiFont };
  export type { AsciiFontProps, AsciiFontName };
  export { Slider };
  export type { SliderProps };
  export { ScrollBar };
  export type { ScrollBarProps };
  export { TextTable };
  export type { TextTableProps, TextTableCell, TextTableSpan };
  export { FrameBuffer };
  export type { FrameBufferProps, FrameBufferSurface };
}

declare module "@termcraft/runtime/jsx-dev-runtime" {
  export { jsxDEV } from "@opentui/react/jsx-dev-runtime";
}

declare module "@termcraft/runtime/jsx-runtime" {
  export { Fragment, jsx, jsxs } from "@opentui/react/jsx-runtime";
}
