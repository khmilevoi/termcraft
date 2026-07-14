# termcraft MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A terminal app where the user describes a TUI in chat, the Codex CLI generates a declarative page document, termcraft renders it live with mouse selection/pin-comments/version history, and exports a prompt file + DSL for an implementing agent.

**Architecture:** Modular monolith (modules `dsl` / `render` / `agent` / `store` / `core` / `ui`) with a strict Command/Event channel boundary between `ui` and `core` (the future daemon IPC). Elm architecture in the UI; tokio select-loop merges terminal events and kernel events. Spec: `docs/superpowers/specs/2026-07-13-termcraft-design.md` (§8.2 MVP cut, §11 success criteria). Diagrams: `architecture/*.mmd`. UI reference: `design/Termcraft UI.dc.html`.

**Tech Stack:** Rust (edition 2024), ratatui 0.30, crossterm 0.29 (event-stream), tokio 1, tokio-util, serde/serde_json/serde_ignored, toml, chrono, color-eyre. Dev: tempfile.

## Global Constraints

- All shell commands are prefixed with `rtk` (project CLAUDE.md rule), e.g. `rtk cargo test`.
- Dependencies are exactly the ones in Task 1's `Cargo.toml`; adding a crate requires a spec-level reason.
- No `unwrap()` / `expect()` outside `#[cfg(test)]` code.
- Every persisted file carries its format version (spec §7.2): JSON → top-level `schemaVersion`, JSONL → first header line, TOML → `format_version` key. Current version of every kind is `1`.
- All store writes go through `store::atomic_write` (tmp + rename).
- The panic hook must restore the terminal: disable mouse capture, then `ratatui::restore()`.
- Theme values come verbatim from `design/Termcraft UI.dc.html` palette (bg `#14110d`, text `#d7d0c2`, muted `#8f877a`, faint `#5b544a`, border `#403a2f`, primary `#e6a23c`, accent `#f6c163`, selection `#392c11`, ok `#8fb96b`, error `#dd7b60`, surface `#231d12`).
- Key events must be filtered to `KeyEventKind::Press` (Windows emits Release events too).
- Commit after each task. End every commit message with:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- Codex CLI contract (verified against openai/codex docs): `codex exec --json` prints JSONL events to stdout; `codex exec resume <SESSION_ID> --json <prompt>` continues a session; `-m/--model` picks the model; `--sandbox read-only` and `--skip-git-repo-check` apply; events include `thread.started` (field `thread_id`), `item.completed` (with `item.type` of `agent_message`/`reasoning`/`command_execution`), `turn.completed`.

---

### Task 1: Project scaffold and terminal lifecycle

**Files:**
- Create: `Cargo.toml`
- Create: `.gitignore`
- Create: `src/main.rs`

**Interfaces:**
- Produces: binary crate `termcraft`; `main()` installs color-eyre + panic hook, opens/restores the terminal. Later tasks add modules via `mod` declarations in `main.rs`.

- [ ] **Step 1: Write `Cargo.toml` and `.gitignore`**

```toml
[package]
name = "termcraft"
version = "0.1.0"
edition = "2024"

[dependencies]
ratatui = "0.30"
crossterm = { version = "0.29", features = ["event-stream"] }
color-eyre = "0.6"
tokio = { version = "1", features = ["full"] }
tokio-util = "0.7"
futures = "0.3"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
serde_ignored = "0.1"
toml = "0.8"
chrono = { version = "0.4", features = ["serde"] }

[dev-dependencies]
tempfile = "3"

[profile.release]
lto = true
codegen-units = 1
strip = true
```

`.gitignore`:

```
/target
```

- [ ] **Step 2: Write `src/main.rs` with terminal lifecycle**

```rust
use color_eyre::eyre::Result;

fn main() -> Result<()> {
    color_eyre::install()?;
    install_panic_hook();
    let terminal = ratatui::init();
    let res = run(terminal);
    ratatui::restore();
    res
}

fn install_panic_hook() {
    let hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let _ = crossterm::execute!(std::io::stdout(), crossterm::event::DisableMouseCapture);
        ratatui::restore();
        hook(info);
    }));
}

fn run(mut terminal: ratatui::DefaultTerminal) -> Result<()> {
    use crossterm::event::{self, Event, KeyCode, KeyEventKind};
    loop {
        terminal.draw(|f| {
            f.render_widget(
                ratatui::widgets::Paragraph::new("termcraft — press q to quit"),
                f.area(),
            );
        })?;
        if let Event::Key(k) = event::read()? {
            if k.kind == KeyEventKind::Press && k.code == KeyCode::Char('q') {
                break;
            }
        }
    }
    Ok(())
}
```

- [ ] **Step 3: Build**

Run: `rtk cargo build`
Expected: compiles with no errors (warnings OK).

- [ ] **Step 4: Commit**

```bash
rtk git add Cargo.toml .gitignore src/main.rs && rtk git commit -m "feat: scaffold termcraft binary with terminal lifecycle

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: DSL types and parsing

**Files:**
- Create: `src/dsl/mod.rs`
- Modify: `src/main.rs` (add `mod dsl;`)

**Interfaces:**
- Produces (used by render/core/store tasks):
  - `dsl::PAGE_SCHEMA_VERSION: u32` (= 1)
  - `dsl::PageDoc { schema_version: u32, page: String, title: String, min_size: Size, theme: String, root: Element }` (serde camelCase)
  - `dsl::Size { w: u16, h: u16 }`
  - `dsl::Element { id: String, kind: ElementKind (json field "type"), label: Option<String>, text: Option<String>, items: Vec<String>, headers: Vec<String>, rows: Vec<Vec<String>>, value: Option<f64>, data: Vec<f64>, canvas: Vec<Vec<CanvasRun>>, active: Option<usize>, layout: LayoutSpec, style: StyleDef, children: Vec<Element> }`
  - `dsl::ElementKind` = `Row|Column|Panel|Tabs|Text|Button|Input|List|Table|Gauge|Sparkline|Separator|Spacer|Canvas` (lowercase in JSON)
  - `dsl::LayoutSpec { size: Option<SizeSpec>, padding: u16 }`; `dsl::SizeSpec::parse(&self) -> Result<ParsedSize, String>`; `dsl::ParsedSize` = `Cells(u16)|Percent(u16)|Fill|Min(u16)`
  - `dsl::StyleDef { fg: Option<String>, bg: Option<String>, bold: bool, dim: bool, underline: bool, border: Option<BorderKind> }`; `dsl::BorderKind` = `None|Plain|Rounded|Double|Thick`
  - `dsl::CanvasRun { text: String, fg: Option<String>, bg: Option<String> }`
  - `dsl::parse_page(json: &str) -> Result<(PageDoc, Vec<String>), String>` — warnings list unknown fields.

- [ ] **Step 1: Write the failing tests** (bottom of `src/dsl/mod.rs`)

```rust
#[cfg(test)]
mod tests {
    use super::*;

    const MINIMAL: &str = r#"{
      "schemaVersion": 1,
      "page": "main",
      "title": "Dashboard",
      "root": {
        "id": "root", "type": "column",
        "children": [
          { "id": "cpu", "type": "gauge", "label": "CPU", "value": 63,
            "layout": { "size": 1 } },
          { "id": "hint", "type": "text", "text": "hello",
            "style": { "fg": "text-muted" }, "layout": { "size": "fill" } }
        ]
      }
    }"#;

    #[test]
    fn parses_minimal_page() {
        let (doc, warnings) = parse_page(MINIMAL).unwrap();
        assert!(warnings.is_empty());
        assert_eq!(doc.schema_version, PAGE_SCHEMA_VERSION);
        assert_eq!(doc.page, "main");
        assert_eq!(doc.min_size, Size { w: 80, h: 24 }); // default
        assert_eq!(doc.theme, "dark-default"); // default
        assert_eq!(doc.root.children.len(), 2);
        assert_eq!(doc.root.children[0].kind, ElementKind::Gauge);
        assert_eq!(doc.root.children[0].value, Some(63.0));
    }

    #[test]
    fn roundtrip() {
        let (doc, _) = parse_page(MINIMAL).unwrap();
        let json = serde_json::to_string(&doc).unwrap();
        let (doc2, _) = parse_page(&json).unwrap();
        assert_eq!(doc, doc2);
    }

    #[test]
    fn unknown_fields_warn() {
        let json = MINIMAL.replace(r#""title": "Dashboard","#, r#""title": "Dashboard", "wat": 1,"#);
        let (_, warnings) = parse_page(&json).unwrap();
        assert_eq!(warnings, vec!["unknown field: wat".to_string()]);
    }

    #[test]
    fn size_specs_parse() {
        assert_eq!(SizeSpec::Cells(12).parse().unwrap(), ParsedSize::Cells(12));
        assert_eq!(SizeSpec::Expr("30%".into()).parse().unwrap(), ParsedSize::Percent(30));
        assert_eq!(SizeSpec::Expr("fill".into()).parse().unwrap(), ParsedSize::Fill);
        assert_eq!(SizeSpec::Expr("min:10".into()).parse().unwrap(), ParsedSize::Min(10));
        assert_eq!(SizeSpec::Expr("7".into()).parse().unwrap(), ParsedSize::Cells(7));
        assert!(SizeSpec::Expr("banana".into()).parse().is_err());
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `rtk cargo test dsl`
Expected: FAIL — module/items not defined (compile error).

- [ ] **Step 3: Write the implementation** (top of `src/dsl/mod.rs`; add `mod dsl;` to `src/main.rs`)

```rust
use serde::{Deserialize, Serialize};

pub const PAGE_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageDoc {
    pub schema_version: u32,
    pub page: String,
    pub title: String,
    #[serde(default = "Size::default_min")]
    pub min_size: Size,
    #[serde(default = "default_theme")]
    pub theme: String,
    pub root: Element,
}

fn default_theme() -> String {
    "dark-default".into()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Size {
    pub w: u16,
    pub h: u16,
}

impl Size {
    pub fn default_min() -> Self {
        Size { w: 80, h: 24 }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ElementKind {
    Row, Column, Panel, Tabs, Text, Button, Input, List, Table,
    Gauge, Sparkline, Separator, Spacer, Canvas,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum SizeSpec {
    Cells(u16),
    Expr(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParsedSize {
    Cells(u16),
    Percent(u16),
    Fill,
    Min(u16),
}

impl SizeSpec {
    pub fn parse(&self) -> Result<ParsedSize, String> {
        let bad = |s: &str| format!("invalid size spec '{s}' (use N, \"N%\", \"fill\", \"min:N\")");
        match self {
            SizeSpec::Cells(n) => Ok(ParsedSize::Cells(*n)),
            SizeSpec::Expr(s) => {
                let s = s.trim();
                if s == "fill" {
                    return Ok(ParsedSize::Fill);
                }
                if let Some(p) = s.strip_suffix('%') {
                    return p.parse().map(ParsedSize::Percent).map_err(|_| bad(s));
                }
                if let Some(m) = s.strip_prefix("min:") {
                    return m.parse().map(ParsedSize::Min).map_err(|_| bad(s));
                }
                if let Ok(n) = s.parse::<u16>() {
                    return Ok(ParsedSize::Cells(n));
                }
                Err(bad(s))
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LayoutSpec {
    #[serde(default)]
    pub size: Option<SizeSpec>,
    #[serde(default)]
    pub padding: u16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BorderKind {
    None, Plain, Rounded, Double, Thick,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StyleDef {
    #[serde(default)]
    pub fg: Option<String>,
    #[serde(default)]
    pub bg: Option<String>,
    #[serde(default)]
    pub bold: bool,
    #[serde(default)]
    pub dim: bool,
    #[serde(default)]
    pub underline: bool,
    #[serde(default)]
    pub border: Option<BorderKind>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasRun {
    pub text: String,
    #[serde(default)]
    pub fg: Option<String>,
    #[serde(default)]
    pub bg: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Element {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: ElementKind,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub items: Vec<String>,
    #[serde(default)]
    pub headers: Vec<String>,
    #[serde(default)]
    pub rows: Vec<Vec<String>>,
    #[serde(default)]
    pub value: Option<f64>,
    #[serde(default)]
    pub data: Vec<f64>,
    #[serde(default)]
    pub canvas: Vec<Vec<CanvasRun>>,
    #[serde(default)]
    pub active: Option<usize>,
    #[serde(default)]
    pub layout: LayoutSpec,
    #[serde(default)]
    pub style: StyleDef,
    #[serde(default)]
    pub children: Vec<Element>,
}

/// Parse a page document, collecting unknown-field warnings (spec §5.2).
pub fn parse_page(json: &str) -> Result<(PageDoc, Vec<String>), String> {
    let mut warnings = Vec::new();
    let de = &mut serde_json::Deserializer::from_str(json);
    let doc: PageDoc = serde_ignored::deserialize(de, |path| {
        warnings.push(format!("unknown field: {path}"));
    })
    .map_err(|e| e.to_string())?;
    Ok((doc, warnings))
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `rtk cargo test dsl`
Expected: 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add src/dsl/mod.rs src/main.rs && rtk git commit -m "feat(dsl): page document types, serde parsing, size specs

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: DSL validation

**Files:**
- Create: `src/dsl/validate.rs`
- Modify: `src/dsl/mod.rs` (add `pub mod validate;` and re-export)

**Interfaces:**
- Consumes: Task 2 types.
- Produces (used by core::ops):
  - `dsl::validate::Validation { warnings: Vec<String>, errors: Vec<String> }`
  - `dsl::validate::validate(doc: &PageDoc) -> Validation`
  - `dsl::validate::parse_and_validate(json: &str) -> Result<(PageDoc, Vec<String>), String>` — Err = joined errors (retryable by the agent).

- [ ] **Step 1: Write the failing tests** (bottom of `src/dsl/validate.rs`)

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsl::parse_page;

    fn doc(json: &str) -> crate::dsl::PageDoc {
        parse_page(json).unwrap().0
    }

    #[test]
    fn accepts_valid_doc() {
        let d = doc(r#"{"schemaVersion":1,"page":"p","title":"T",
            "root":{"id":"root","type":"column","children":[
              {"id":"g","type":"gauge","value":50},
              {"id":"s","type":"sparkline","data":[1,2,3]}]}}"#);
        let v = validate(&d);
        assert!(v.errors.is_empty(), "{:?}", v.errors);
    }

    #[test]
    fn rejects_duplicate_ids() {
        let d = doc(r#"{"schemaVersion":1,"page":"p","title":"T",
            "root":{"id":"a","type":"column","children":[
              {"id":"a","type":"text","text":"x"}]}}"#);
        let v = validate(&d);
        assert!(v.errors.iter().any(|e| e.contains("duplicate id 'a'")));
    }

    #[test]
    fn rejects_newer_schema() {
        let d = doc(r#"{"schemaVersion":99,"page":"p","title":"T",
            "root":{"id":"root","type":"spacer"}}"#);
        let v = validate(&d);
        assert!(v.errors.iter().any(|e| e.contains("newer than supported")));
    }

    #[test]
    fn rejects_bad_gauge_and_tabs() {
        let d = doc(r#"{"schemaVersion":1,"page":"p","title":"T",
            "root":{"id":"root","type":"column","children":[
              {"id":"g","type":"gauge"},
              {"id":"t","type":"tabs","active":3,"children":[
                {"id":"c1","type":"spacer"}]}]}}"#);
        let v = validate(&d);
        assert!(v.errors.iter().any(|e| e.contains("gauge 'g'")));
        assert!(v.errors.iter().any(|e| e.contains("active 3 out of range")));
    }

    #[test]
    fn parse_and_validate_joins_errors() {
        let err = parse_and_validate(
            r#"{"schemaVersion":1,"page":"p","title":"T",
               "root":{"id":"","type":"canvas"}}"#,
        )
        .unwrap_err();
        assert!(err.contains("empty id"));
        assert!(err.contains("canvas"));
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `rtk cargo test validate`
Expected: FAIL — items not defined.

- [ ] **Step 3: Write the implementation** (top of `src/dsl/validate.rs`)

```rust
use std::collections::HashSet;

use super::{Element, ElementKind, PageDoc, PAGE_SCHEMA_VERSION};

#[derive(Debug, Default)]
pub struct Validation {
    pub warnings: Vec<String>,
    pub errors: Vec<String>,
}

pub fn validate(doc: &PageDoc) -> Validation {
    let mut v = Validation::default();
    if doc.schema_version > PAGE_SCHEMA_VERSION {
        v.errors.push(format!(
            "page '{}': schemaVersion {} is newer than supported {} — update termcraft",
            doc.page, doc.schema_version, PAGE_SCHEMA_VERSION
        ));
        return v;
    }
    let mut seen = HashSet::new();
    walk(&doc.root, &mut seen, &mut v);
    v
}

fn walk(el: &Element, seen: &mut HashSet<String>, v: &mut Validation) {
    if el.id.is_empty() {
        v.errors.push(format!("{:?} element with empty id", el.kind));
    } else if !seen.insert(el.id.clone()) {
        v.errors.push(format!("duplicate id '{}'", el.id));
    }
    if let Some(spec) = &el.layout.size {
        if let Err(e) = spec.parse() {
            v.errors.push(format!("element '{}': {e}", el.id));
        }
    }
    match el.kind {
        ElementKind::Gauge => match el.value {
            Some(x) if (0.0..=100.0).contains(&x) => {}
            _ => v.errors.push(format!("gauge '{}' needs value in 0..=100", el.id)),
        },
        ElementKind::Sparkline => {
            if el.data.is_empty() {
                v.errors.push(format!("sparkline '{}' needs non-empty data", el.id));
            }
        }
        ElementKind::Tabs => {
            if el.children.is_empty() {
                v.errors.push(format!("tabs '{}' needs children", el.id));
            } else if let Some(a) = el.active {
                if a >= el.children.len() {
                    v.errors.push(format!("tabs '{}': active {a} out of range", el.id));
                }
            }
        }
        ElementKind::Canvas => {
            if el.canvas.is_empty() {
                v.errors.push(format!("canvas '{}' needs canvas rows", el.id));
            }
        }
        ElementKind::Table => {
            if el.rows.is_empty() {
                v.warnings.push(format!("table '{}' has no rows", el.id));
            }
        }
        ElementKind::Text | ElementKind::Button => {
            if el.text.is_none() && el.label.is_none() {
                v.warnings.push(format!("{:?} '{}' has no text", el.kind, el.id));
            }
        }
        _ => {}
    }
    for c in &el.children {
        walk(c, seen, v);
    }
}

/// Parse + validate; Err joins all errors into one agent-retryable string.
pub fn parse_and_validate(json: &str) -> Result<(PageDoc, Vec<String>), String> {
    let (doc, mut warnings) = super::parse_page(json)?;
    let val = validate(&doc);
    warnings.extend(val.warnings);
    if val.errors.is_empty() {
        Ok((doc, warnings))
    } else {
        Err(val.errors.join("; "))
    }
}
```

In `src/dsl/mod.rs` add at the top:

```rust
pub mod validate;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `rtk cargo test validate`
Expected: 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add src/dsl && rtk git commit -m "feat(dsl): semantic validation with agent-retryable errors

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Theme, palette roles, color degradation

**Files:**
- Create: `src/render/theme.rs`
- Create: `src/render/mod.rs` (module shell: `pub mod theme;`)
- Modify: `src/main.rs` (add `mod render;`)

**Interfaces:**
- Produces (used by render/ui/export):
  - `render::theme::Theme` with `pub fn dark_default() -> Theme`
  - `Theme::role(&self, name: &str) -> Option<Color>` — roles: `background`, `surface`, `text`, `text-muted`, `text-faint`, `border`, `primary`, `accent`, `selection`, `ok`, `error`
  - `Theme::resolve(&self, spec: &str) -> Option<Color>` — role name or `#rrggbb`
  - `Theme::color(&self, spec: &Option<String>, fallback_role: &str) -> Color`
  - `render::theme::ColorDepth { TrueColor, Ansi256, Ansi16 }`, `render::theme::degrade(c: Color, d: ColorDepth) -> Color`

- [ ] **Step 1: Write the failing tests** (bottom of `src/render/theme.rs`)

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::style::Color;

    #[test]
    fn resolves_roles_and_hex() {
        let t = dark_default();
        assert_eq!(t.role("primary"), Some(Color::Rgb(0xe6, 0xa2, 0x3c)));
        assert_eq!(t.resolve("#f6c163"), Some(Color::Rgb(0xf6, 0xc1, 0x63)));
        assert_eq!(t.resolve("error"), Some(Color::Rgb(0xdd, 0x7b, 0x60)));
        assert_eq!(t.resolve("nope"), None);
        assert_eq!(t.color(&Some("primary".into()), "text"), Color::Rgb(0xe6, 0xa2, 0x3c));
        assert_eq!(t.color(&None, "text"), Color::Rgb(0xd7, 0xd0, 0xc2));
    }

    #[test]
    fn degrades_colors() {
        let amber = Color::Rgb(0xe6, 0xa2, 0x3c);
        assert_eq!(degrade(amber, ColorDepth::TrueColor), amber);
        // 256 cube: 16 + 36*(230*5/255) + 6*(162*5/255) + (60*5/255) = 16+36*4+6*3+1 = 179
        assert_eq!(degrade(amber, ColorDepth::Ansi256), Color::Indexed(179));
        assert_eq!(degrade(amber, ColorDepth::Ansi16), Color::Yellow);
        assert_eq!(degrade(Color::Indexed(5), ColorDepth::Ansi256), Color::Indexed(5));
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `rtk cargo test theme`
Expected: FAIL — items not defined.

- [ ] **Step 3: Write the implementation** (top of `src/render/theme.rs`; `src/render/mod.rs` = `pub mod theme;` for now; `mod render;` in main.rs)

```rust
use ratatui::style::Color;

pub struct Theme {
    pub name: &'static str,
    roles: &'static [(&'static str, Color)],
}

pub fn dark_default() -> Theme {
    Theme {
        name: "dark-default",
        roles: &[
            ("background", Color::Rgb(0x14, 0x11, 0x0d)),
            ("surface", Color::Rgb(0x23, 0x1d, 0x12)),
            ("text", Color::Rgb(0xd7, 0xd0, 0xc2)),
            ("text-muted", Color::Rgb(0x8f, 0x87, 0x7a)),
            ("text-faint", Color::Rgb(0x5b, 0x54, 0x4a)),
            ("border", Color::Rgb(0x40, 0x3a, 0x2f)),
            ("primary", Color::Rgb(0xe6, 0xa2, 0x3c)),
            ("accent", Color::Rgb(0xf6, 0xc1, 0x63)),
            ("selection", Color::Rgb(0x39, 0x2c, 0x11)),
            ("ok", Color::Rgb(0x8f, 0xb9, 0x6b)),
            ("error", Color::Rgb(0xdd, 0x7b, 0x60)),
        ],
    }
}

impl Theme {
    pub fn role(&self, name: &str) -> Option<Color> {
        self.roles.iter().find(|(n, _)| *n == name).map(|(_, c)| *c)
    }

    pub fn resolve(&self, spec: &str) -> Option<Color> {
        if let Some(hex) = spec.strip_prefix('#') {
            if hex.len() == 6 {
                if let (Ok(r), Ok(g), Ok(b)) = (
                    u8::from_str_radix(&hex[0..2], 16),
                    u8::from_str_radix(&hex[2..4], 16),
                    u8::from_str_radix(&hex[4..6], 16),
                ) {
                    return Some(Color::Rgb(r, g, b));
                }
            }
            return None;
        }
        self.role(spec)
    }

    /// Resolve an optional style spec with a role fallback (always succeeds).
    pub fn color(&self, spec: &Option<String>, fallback_role: &str) -> Color {
        spec.as_deref()
            .and_then(|s| self.resolve(s))
            .or_else(|| self.role(fallback_role))
            .unwrap_or(Color::Reset)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ColorDepth {
    TrueColor,
    Ansi256,
    Ansi16,
}

const ANSI16: [(Color, (u8, u8, u8)); 16] = [
    (Color::Black, (0, 0, 0)),
    (Color::Red, (205, 49, 49)),
    (Color::Green, (13, 188, 121)),
    (Color::Yellow, (229, 229, 16)),
    (Color::Blue, (36, 114, 200)),
    (Color::Magenta, (188, 63, 188)),
    (Color::Cyan, (17, 168, 205)),
    (Color::Gray, (229, 229, 229)),
    (Color::DarkGray, (102, 102, 102)),
    (Color::LightRed, (241, 76, 76)),
    (Color::LightGreen, (35, 209, 139)),
    (Color::LightYellow, (245, 245, 67)),
    (Color::LightBlue, (59, 142, 234)),
    (Color::LightMagenta, (214, 112, 214)),
    (Color::LightCyan, (41, 184, 219)),
    (Color::White, (255, 255, 255)),
];

pub fn degrade(c: Color, depth: ColorDepth) -> Color {
    let Color::Rgb(r, g, b) = c else { return c };
    match depth {
        ColorDepth::TrueColor => c,
        ColorDepth::Ansi256 => {
            let idx = 16
                + 36 * (r as u16 * 5 / 255)
                + 6 * (g as u16 * 5 / 255)
                + (b as u16 * 5 / 255);
            Color::Indexed(idx as u8)
        }
        ColorDepth::Ansi16 => {
            let dist = |(cr, cg, cb): (u8, u8, u8)| {
                let dr = cr as i32 - r as i32;
                let dg = cg as i32 - g as i32;
                let db = cb as i32 - b as i32;
                dr * dr + dg * dg + db * db
            };
            ANSI16
                .iter()
                .min_by_key(|(_, rgb)| dist(*rgb))
                .map(|(c, _)| *c)
                .unwrap_or(Color::Reset)
        }
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `rtk cargo test theme`
Expected: 2 tests PASS. (If the Ansi16 expectation picks a different named color, adjust the test to the actual nearest value printed by the failure — the table is the contract, not the sample.)

- [ ] **Step 5: Commit**

```bash
rtk git add src/render src/main.rs && rtk git commit -m "feat(render): dark-default theme, palette roles, color degradation

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Renderer — DSL to buffer, hit-testing, snapshot

**Files:**
- Modify: `src/render/mod.rs`

**Interfaces:**
- Consumes: `dsl::*` (Task 2), `render::theme::*` (Task 4).
- Produces (used by ui/export):
  - `render::RenderResult { hits: Vec<(String, Rect)> }` — parents pushed before children
  - `render::render_page(doc: &PageDoc, area: Rect, buf: &mut Buffer, theme: &Theme) -> RenderResult`
  - `render::hit_test(hits: &[(String, Rect)], x: u16, y: u16) -> Option<&str>` — deepest element
  - `render::highlight_corners(buf: &mut Buffer, r: Rect, color: Color)` (hover)
  - `render::highlight_fill(buf: &mut Buffer, r: Rect, bg: Color)` (selection)
  - `render::snapshot(buf: &Buffer) -> String` — plain text, trailing spaces trimmed, `\n` per row

- [ ] **Step 1: Write the failing tests** (bottom of `src/render/mod.rs`)

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsl::parse_page;
    use ratatui::buffer::Buffer;
    use ratatui::layout::Rect;

    const PAGE: &str = r#"{
      "schemaVersion": 1, "page": "main", "title": "Mon",
      "minSize": {"w": 30, "h": 10},
      "root": { "id": "root", "type": "column", "children": [
        { "id": "res", "type": "panel", "label": "resources",
          "layout": {"size": 5}, "children": [
            { "id": "cpu", "type": "gauge", "label": "CPU", "value": 50 } ] },
        { "id": "note", "type": "text", "text": "hello world",
          "layout": {"size": "fill"} } ] }
    }"#;

    fn render_fixture() -> (Buffer, RenderResult) {
        let (doc, _) = parse_page(PAGE).unwrap();
        let area = Rect::new(0, 0, 30, 10);
        let mut buf = Buffer::empty(area);
        let res = render_page(&doc, area, &mut buf, &theme::dark_default());
        (buf, res)
    }

    #[test]
    fn renders_panel_title_and_text() {
        let (buf, _) = render_fixture();
        let snap = snapshot(&buf);
        assert!(snap.contains("resources"), "snapshot:\n{snap}");
        assert!(snap.contains("hello world"), "snapshot:\n{snap}");
        assert!(snap.contains("╭"), "rounded border expected:\n{snap}");
    }

    #[test]
    fn hit_map_is_parent_then_child_and_hit_test_finds_deepest() {
        let (_, res) = render_fixture();
        let ids: Vec<&str> = res.hits.iter().map(|(id, _)| id.as_str()).collect();
        assert_eq!(ids, vec!["root", "res", "cpu", "note"]);
        // inside the gauge (panel inner starts at 1,1)
        assert_eq!(hit_test(&res.hits, 2, 1), Some("cpu"));
        // panel border cell belongs to the panel, not the gauge
        assert_eq!(hit_test(&res.hits, 0, 0), Some("res"));
        // below the panel → text element
        assert_eq!(hit_test(&res.hits, 2, 7), Some("note"));
        assert_eq!(hit_test(&res.hits, 99, 99), None);
    }

    #[test]
    fn snapshot_trims_trailing_spaces() {
        let (buf, _) = render_fixture();
        for line in snapshot(&buf).lines() {
            assert_eq!(line, line.trim_end());
        }
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `rtk cargo test render`
Expected: FAIL — items not defined.

- [ ] **Step 3: Write the implementation** (top of `src/render/mod.rs`, keeping `pub mod theme;`)

```rust
pub mod theme;

use ratatui::buffer::Buffer;
use ratatui::layout::{Constraint, Layout, Margin, Position, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::Line;
use ratatui::widgets::{
    Block, BorderType, Gauge, List, Paragraph, Row as TRow, Sparkline, Table, Tabs, Widget, Wrap,
};

use crate::dsl::{BorderKind, Element, ElementKind, PageDoc, ParsedSize};
use theme::Theme;

pub struct RenderResult {
    pub hits: Vec<(String, Rect)>,
}

pub fn render_page(doc: &PageDoc, area: Rect, buf: &mut Buffer, theme: &Theme) -> RenderResult {
    let mut hits = Vec::new();
    let base = Style::default()
        .bg(theme.color(&None, "background"))
        .fg(theme.color(&None, "text"));
    buf.set_style(area, base);
    render_el(&doc.root, area, buf, theme, &mut hits);
    RenderResult { hits }
}

fn constraint(el: &Element) -> Constraint {
    match el.layout.size.as_ref().map(|s| s.parse()) {
        Some(Ok(ParsedSize::Cells(n))) => Constraint::Length(n),
        Some(Ok(ParsedSize::Percent(p))) => Constraint::Percentage(p),
        Some(Ok(ParsedSize::Min(n))) => Constraint::Min(n),
        _ => Constraint::Fill(1),
    }
}

fn style_of(el: &Element, theme: &Theme) -> Style {
    let mut s = Style::default().fg(theme.color(&el.style.fg, "text"));
    if let Some(bg) = el.style.bg.as_deref().and_then(|b| theme.resolve(b)) {
        s = s.bg(bg);
    }
    if el.style.bold {
        s = s.add_modifier(Modifier::BOLD);
    }
    if el.style.dim {
        s = s.add_modifier(Modifier::DIM);
    }
    if el.style.underline {
        s = s.add_modifier(Modifier::UNDERLINED);
    }
    s
}

fn border_type(b: Option<BorderKind>) -> BorderType {
    match b {
        Some(BorderKind::Plain) => BorderType::Plain,
        Some(BorderKind::Double) => BorderType::Double,
        Some(BorderKind::Thick) => BorderType::Thick,
        _ => BorderType::Rounded,
    }
}

fn split_children(el: &Element, area: Rect, horizontal: bool) -> Vec<Rect> {
    let cons: Vec<Constraint> = el.children.iter().map(constraint).collect();
    let layout = if horizontal {
        Layout::horizontal(cons)
    } else {
        Layout::vertical(cons)
    };
    layout.split(area).to_vec()
}

fn render_el(el: &Element, mut area: Rect, buf: &mut Buffer, theme: &Theme, hits: &mut Vec<(String, Rect)>) {
    if area.width == 0 || area.height == 0 {
        return;
    }
    hits.push((el.id.clone(), area));
    if el.layout.padding > 0 {
        area = area.inner(Margin::new(el.layout.padding, el.layout.padding));
    }
    let sty = style_of(el, theme);
    match el.kind {
        ElementKind::Row | ElementKind::Column => {
            let chunks = split_children(el, area, el.kind == ElementKind::Row);
            for (c, a) in el.children.iter().zip(chunks.iter()) {
                render_el(c, *a, buf, theme, hits);
            }
        }
        ElementKind::Panel => {
            let mut block = Block::bordered()
                .border_type(border_type(el.style.border))
                .border_style(Style::default().fg(theme.color(&el.style.fg, "border")));
            if let Some(l) = &el.label {
                block = block.title(Line::from(format!(" {l} ")).style(
                    Style::default().fg(theme.color(&None, "text-muted")),
                ));
            }
            let inner = block.inner(area);
            block.render(area, buf);
            if !el.children.is_empty() {
                let chunks = split_children(el, inner, false);
                for (c, a) in el.children.iter().zip(chunks.iter()) {
                    render_el(c, *a, buf, theme, hits);
                }
            }
        }
        ElementKind::Tabs => {
            if el.children.is_empty() {
                return;
            }
            let titles: Vec<String> = el
                .children
                .iter()
                .map(|c| c.label.clone().or_else(|| c.text.clone()).unwrap_or_else(|| c.id.clone()))
                .collect();
            let active = el.active.unwrap_or(0).min(el.children.len() - 1);
            let [bar, body] =
                Layout::vertical([Constraint::Length(1), Constraint::Fill(1)]).areas(area);
            Tabs::new(titles)
                .select(active)
                .style(Style::default().fg(theme.color(&None, "text-muted")))
                .highlight_style(
                    Style::default()
                        .fg(theme.color(&None, "primary"))
                        .add_modifier(Modifier::BOLD),
                )
                .render(bar, buf);
            render_el(&el.children[active], body, buf, theme, hits);
        }
        ElementKind::Text => {
            let text = el.text.clone().or_else(|| el.label.clone()).unwrap_or_default();
            Paragraph::new(text).style(sty).wrap(Wrap { trim: false }).render(area, buf);
        }
        ElementKind::Button => {
            let label = el.label.clone().or_else(|| el.text.clone()).unwrap_or_default();
            let text = format!("[ {label} ]");
            let x = area.x + area.width.saturating_sub(text.len() as u16) / 2;
            let color = el
                .style
                .fg
                .as_deref()
                .and_then(|s| theme.resolve(s))
                .unwrap_or_else(|| theme.color(&None, "primary"));
            buf.set_string(x, area.y, text, Style::default().fg(color).add_modifier(Modifier::BOLD));
        }
        ElementKind::Input => {
            let block = Block::bordered()
                .border_type(BorderType::Rounded)
                .border_style(Style::default().fg(theme.color(&el.style.fg, "border")))
                .title(el.label.clone().map(|l| format!(" {l} ")).unwrap_or_default());
            let inner = block.inner(area);
            block.render(area, buf);
            if let Some(t) = &el.text {
                buf.set_string(inner.x, inner.y, t, Style::default().fg(theme.color(&None, "text")));
            }
        }
        ElementKind::List => {
            let items: Vec<Line> = el.items.iter().map(|i| Line::from(i.clone())).collect();
            List::new(items).style(sty).render(area, buf);
        }
        ElementKind::Table => {
            let ncols = el.headers.len().max(el.rows.first().map(|r| r.len()).unwrap_or(1)).max(1);
            let widths = vec![Constraint::Fill(1); ncols];
            let rows: Vec<TRow> = el.rows.iter().map(|r| TRow::new(r.clone())).collect();
            let mut table = Table::new(rows, widths).style(sty);
            if !el.headers.is_empty() {
                table = table.header(
                    TRow::new(el.headers.clone()).style(
                        Style::default()
                            .fg(theme.color(&None, "text-faint"))
                            .add_modifier(Modifier::BOLD),
                    ),
                );
            }
            table.render(area, buf);
        }
        ElementKind::Gauge => {
            let ratio = (el.value.unwrap_or(0.0) / 100.0).clamp(0.0, 1.0);
            let mut g = Gauge::default().ratio(ratio).gauge_style(
                Style::default()
                    .fg(theme.color(&el.style.fg, "primary"))
                    .bg(theme.color(&None, "surface")),
            );
            if let Some(l) = &el.label {
                g = g.label(format!("{l} {:.0}%", ratio * 100.0));
            }
            g.render(area, buf);
        }
        ElementKind::Sparkline => {
            let data: Vec<u64> = el.data.iter().map(|v| (v.max(&0.0) * 100.0) as u64).collect();
            Sparkline::default()
                .data(&data)
                .style(Style::default().fg(theme.color(&el.style.fg, "ok")))
                .render(area, buf);
        }
        ElementKind::Separator => {
            let line = "─".repeat(area.width as usize);
            buf.set_string(area.x, area.y, line, Style::default().fg(theme.color(&None, "border")));
        }
        ElementKind::Spacer => {}
        ElementKind::Canvas => {
            for (dy, runs) in el.canvas.iter().enumerate() {
                if dy as u16 >= area.height {
                    break;
                }
                let mut x = area.x;
                for run in runs {
                    let s = Style::default()
                        .fg(theme.color(&run.fg, "text"))
                        .bg(run
                            .bg
                            .as_deref()
                            .and_then(|b| theme.resolve(b))
                            .unwrap_or_else(|| theme.color(&None, "background")));
                    buf.set_string(x, area.y + dy as u16, &run.text, s);
                    x += run.text.chars().count() as u16;
                }
            }
        }
    }
}

pub fn hit_test<'a>(hits: &'a [(String, Rect)], x: u16, y: u16) -> Option<&'a str> {
    hits.iter()
        .rev()
        .find(|(_, r)| r.contains(Position::new(x, y)))
        .map(|(id, _)| id.as_str())
}

pub fn highlight_corners(buf: &mut Buffer, r: Rect, color: Color) {
    if r.width == 0 || r.height == 0 {
        return;
    }
    let s = Style::default().fg(color).add_modifier(Modifier::BOLD);
    buf.set_string(r.left(), r.top(), "┌", s);
    buf.set_string(r.right().saturating_sub(1), r.top(), "┐", s);
    buf.set_string(r.left(), r.bottom().saturating_sub(1), "└", s);
    buf.set_string(r.right().saturating_sub(1), r.bottom().saturating_sub(1), "┘", s);
}

pub fn highlight_fill(buf: &mut Buffer, r: Rect, bg: Color) {
    buf.set_style(r, Style::default().bg(bg));
}

pub fn snapshot(buf: &Buffer) -> String {
    let a = buf.area;
    let mut out = String::new();
    for y in a.top()..a.bottom() {
        let mut line = String::new();
        for x in a.left()..a.right() {
            let sym = buf
                .cell(Position::new(x, y))
                .map(|c| c.symbol().to_string())
                .unwrap_or_else(|| " ".into());
            line.push_str(&sym);
        }
        out.push_str(line.trim_end());
        out.push('\n');
    }
    out
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `rtk cargo test render`
Expected: theme + render tests PASS. If a hit-test coordinate assertion fails, print the snapshot (test messages include it), adjust coordinates to the actual layout — the invariants (deepest element wins, parent-before-child order) are the contract.

- [ ] **Step 5: Commit**

```bash
rtk git add src/render && rtk git commit -m "feat(render): DSL renderer with hit-testing and text snapshots

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Store — workspace, config, atomic writes, lock, migration registry

**Files:**
- Create: `src/store/mod.rs`
- Create: `src/store/config.rs`
- Create: `src/store/migrate.rs`
- Modify: `src/main.rs` (add `mod store;`)

**Interfaces:**
- Produces (used by everything below):
  - `store::Workspace { root: PathBuf }` — `root` points at `.termcraft/`
  - `Workspace::discover(dir: &Path) -> Option<Workspace>`
  - `Workspace::init(dir: &Path, cfg: &Config) -> color_eyre::Result<Workspace>` — creates `.termcraft/{projects,exports}` + `config.toml`
  - `Workspace::lock(&self) -> color_eyre::Result<LockGuard>` — `LockGuard` removes the lock file on drop
  - `Workspace::read_config(&self) -> color_eyre::Result<Config>` / `Workspace::write_config(&self, &Config)`
  - `store::atomic_write(path: &Path, bytes: &[u8]) -> std::io::Result<()>`
  - `store::config::Config { format_version: u32, agent: String, model: String, effort: String, target_stack: String, preview_w: u16, preview_h: u16 }` with `Config::default_codex()`
  - `store::migrate::{FileKind, current_version(FileKind) -> u32, ensure_readable(FileKind, found: u32) -> Result<(), String>}`

- [ ] **Step 1: Write the failing tests** (bottom of `src/store/mod.rs`)

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::config::Config;
    use crate::store::migrate::{ensure_readable, FileKind};

    #[test]
    fn init_discover_and_config_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        assert!(Workspace::discover(dir.path()).is_none());
        let ws = Workspace::init(dir.path(), &Config::default_codex()).unwrap();
        assert!(ws.root.join("projects").is_dir());
        assert!(ws.root.join("exports").is_dir());
        let found = Workspace::discover(dir.path()).unwrap();
        let cfg = found.read_config().unwrap();
        assert_eq!(cfg.agent, "codex");
        assert_eq!(cfg.format_version, 1);
    }

    #[test]
    fn atomic_write_replaces_existing() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("f.json");
        atomic_write(&p, b"one").unwrap();
        atomic_write(&p, b"two").unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "two");
        assert!(!p.with_extension("tmp").exists());
    }

    #[test]
    fn lock_is_exclusive_and_released_on_drop() {
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::init(dir.path(), &Config::default_codex()).unwrap();
        let guard = ws.lock().unwrap();
        assert!(ws.lock().is_err());
        drop(guard);
        assert!(ws.lock().is_ok());
    }

    #[test]
    fn migrate_registry_rejects_newer() {
        assert!(ensure_readable(FileKind::Config, 1).is_ok());
        let err = ensure_readable(FileKind::Config, 2).unwrap_err();
        assert!(err.contains("newer"), "{err}");
    }

    #[test]
    fn config_too_new_fails_to_load() {
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::init(dir.path(), &Config::default_codex()).unwrap();
        let mut cfg = Config::default_codex();
        cfg.format_version = 99;
        ws.write_config(&cfg).unwrap();
        assert!(ws.read_config().is_err());
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `rtk cargo test store`
Expected: FAIL — items not defined.

- [ ] **Step 3: Write the implementation**

`src/store/migrate.rs`:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileKind {
    Config,
    Project,
    Chat,
    Comments,
    Page,
}

pub fn current_version(_kind: FileKind) -> u32 {
    1
}

pub type Migration = fn(serde_json::Value) -> Result<serde_json::Value, String>;

/// Ordered N -> N+1 steps per file kind. Empty at format v1; grows with the formats.
pub fn migrations(_kind: FileKind) -> &'static [Migration] {
    &[]
}

/// Gate every loader: newer-than-binary is a hard error, older needs a migration path.
pub fn ensure_readable(kind: FileKind, found: u32) -> Result<(), String> {
    let cur = current_version(kind);
    if found > cur {
        return Err(format!(
            "{kind:?} file format v{found} is newer than supported v{cur} — update termcraft"
        ));
    }
    let steps_needed = (cur - found) as usize;
    if steps_needed > migrations(kind).len() {
        return Err(format!("no migration path for {kind:?} v{found} -> v{cur}"));
    }
    Ok(())
}
```

`src/store/config.rs`:

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Config {
    pub format_version: u32,
    pub agent: String,
    pub model: String,
    pub effort: String,
    pub target_stack: String,
    pub preview_w: u16,
    pub preview_h: u16,
}

impl Config {
    pub fn default_codex() -> Self {
        Config {
            format_version: 1,
            agent: "codex".into(),
            model: String::new(),  // empty = backend default
            effort: String::new(), // empty = backend default
            target_stack: "rust-ratatui".into(),
            preview_w: 80,
            preview_h: 24,
        }
    }
}
```

`src/store/mod.rs`:

```rust
pub mod config;
pub mod migrate;

use std::fs;
use std::path::{Path, PathBuf};

use color_eyre::eyre::{bail, Context, Result};

use config::Config;
use migrate::{ensure_readable, FileKind};

pub struct Workspace {
    pub root: PathBuf,
}

pub const DIR_NAME: &str = ".termcraft";

impl Workspace {
    pub fn discover(dir: &Path) -> Option<Workspace> {
        let root = dir.join(DIR_NAME);
        root.is_dir().then_some(Workspace { root })
    }

    pub fn init(dir: &Path, cfg: &Config) -> Result<Workspace> {
        let root = dir.join(DIR_NAME);
        fs::create_dir_all(root.join("projects"))?;
        fs::create_dir_all(root.join("exports"))?;
        let ws = Workspace { root };
        ws.write_config(cfg)?;
        Ok(ws)
    }

    pub fn write_config(&self, cfg: &Config) -> Result<()> {
        let text = toml::to_string_pretty(cfg)?;
        atomic_write(&self.root.join("config.toml"), text.as_bytes())?;
        Ok(())
    }

    pub fn read_config(&self) -> Result<Config> {
        let path = self.root.join("config.toml");
        let text = fs::read_to_string(&path).wrap_err_with(|| format!("reading {path:?}"))?;
        let cfg: Config = toml::from_str(&text)?;
        ensure_readable(FileKind::Config, cfg.format_version).map_err(|e| color_eyre::eyre::eyre!(e))?;
        Ok(cfg)
    }

    pub fn lock(&self) -> Result<LockGuard> {
        let path = self.root.join("lock");
        match fs::OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(_) => Ok(LockGuard { path }),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                bail!("another termcraft instance holds {path:?} (delete it if that instance crashed)")
            }
            Err(e) => Err(e.into()),
        }
    }
}

pub struct LockGuard {
    path: PathBuf,
}

impl Drop for LockGuard {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

/// tmp + rename. On Windows rename-over-existing fails, so remove first —
/// safe because the lock file guarantees a single instance.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes)?;
    if path.exists() {
        fs::remove_file(path)?;
    }
    fs::rename(&tmp, path)
}
```

Add `mod store;` to `src/main.rs`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `rtk cargo test store`
Expected: 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add src/store src/main.rs && rtk git commit -m "feat(store): workspace init/discover, config, atomic writes, lock, migration registry

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

<!-- CONTINUED -->
