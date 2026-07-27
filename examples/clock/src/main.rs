//! Native ratatui port of the generated design at
//! `.termcraft/pages/dashboard/page.tsx` (target_stack `js-opentui`, theme
//! `dark-default`). Colors are the exact `dark-default` hex values from
//! `src/runtime/model/tokens.ts` (itself lifted 1:1 from `design/termcraft-engine.js`'s
//! `pal`), and the analog clock face uses the same pure grid-drawing algorithm as
//! `buildAnalogClockFace` in the source page. The `Separator` band (a solid
//! `line`-colored row, no glyph) mirrors `src/runtime/ui/separator.tsx`'s current
//! behavior rather than the engine's `hline()` rule glyph — that gap between the
//! design mockups and the MVP runtime is already documented in that file.

use std::io::{self, Stdout};
use std::panic;
use std::time::Duration;

use chrono::{DateTime, Datelike, Local, Timelike};
use color_eyre::Result;
use crossterm::event::{self, Event, KeyCode, KeyEventKind, KeyModifiers};
use crossterm::execute;
use crossterm::terminal::{
    EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode,
};
use ratatui::Frame;
use ratatui::Terminal;
use ratatui::backend::CrosstermBackend;
use ratatui::layout::{Alignment, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Text as RtText};
use ratatui::widgets::{Block, BorderType, Paragraph};

// ---- `dark-default` theme tokens (src/runtime/model/tokens.ts) ----

const BACKGROUND: Color = Color::Rgb(0x14, 0x11, 0x0d);
const FOREGROUND: Color = Color::Rgb(0xd7, 0xd0, 0xc2);
const FOREGROUND_MUTED: Color = Color::Rgb(0x8f, 0x87, 0x7a);
const BORDER: Color = Color::Rgb(0x40, 0x3a, 0x2f);
const LINE: Color = Color::Rgb(0x2c, 0x28, 0x20);
const ACCENT: Color = Color::Rgb(0xe6, 0xa2, 0x3c);
const ACCENT_HI: Color = Color::Rgb(0xf6, 0xc1, 0x63);

const WEEKDAYS_RU: [&str; 7] = [
    "Воскресенье",
    "Понедельник",
    "Вторник",
    "Среда",
    "Четверг",
    "Пятница",
    "Суббота",
];

const MONTHS_RU: [&str; 12] = [
    "января",
    "февраля",
    "марта",
    "апреля",
    "мая",
    "июня",
    "июля",
    "августа",
    "сентября",
    "октября",
    "ноября",
    "декабря",
];

// ---- analog clock face (buildAnalogClockFace, page.tsx) ----

const CLOCK_RADIUS: f64 = 7.0;
/// Terminal cells are roughly twice as tall as wide; scale x so the face reads as round.
const CLOCK_X_SCALE: f64 = 2.0;
const CLOCK_CX: f64 = CLOCK_RADIUS * CLOCK_X_SCALE;
const CLOCK_CY: f64 = CLOCK_RADIUS;
const CLOCK_WIDTH: usize = (CLOCK_CX * 2.0 + 1.0) as usize;
const CLOCK_HEIGHT: usize = (CLOCK_CY * 2.0 + 1.0) as usize;
const CLOCK_TICK_ANGLES: [f64; 4] = [
    -std::f64::consts::FRAC_PI_2,
    0.0,
    std::f64::consts::FRAC_PI_2,
    std::f64::consts::PI,
];

fn draw_hand(grid: &mut [Vec<char>], angle: f64, length: f64, glyph: char) {
    let steps = (CLOCK_WIDTH.max(CLOCK_HEIGHT) * 2) as i64;
    for i in 1..=steps {
        let t = i as f64 / steps as f64;
        let col = (CLOCK_CX + angle.cos() * length * CLOCK_X_SCALE * t).round();
        let row = (CLOCK_CY + angle.sin() * length * t).round();
        if row >= 0.0 && (row as usize) < CLOCK_HEIGHT && col >= 0.0 && (col as usize) < CLOCK_WIDTH
        {
            grid[row as usize][col as usize] = glyph;
        }
    }
}

/// Renders the analog face as one grid of `CLOCK_WIDTH` × `CLOCK_HEIGHT` chars.
/// Pure function of `now`: no timers, no randomness involved beyond the clock read.
fn build_analog_clock_face(now: DateTime<Local>) -> Vec<String> {
    let mut grid = vec![vec![' '; CLOCK_WIDTH]; CLOCK_HEIGHT];

    // face outline (an ellipse in character space so it reads as a circle)
    for (row, line) in grid.iter_mut().enumerate() {
        for (col, cell) in line.iter_mut().enumerate() {
            let dx = (col as f64 - CLOCK_CX) / CLOCK_X_SCALE;
            let dy = row as f64 - CLOCK_CY;
            let dist = (dx * dx + dy * dy).sqrt();
            if (CLOCK_RADIUS - 0.6..=CLOCK_RADIUS).contains(&dist) {
                *cell = '·';
            }
        }
    }

    // hour ticks at 12 / 3 / 6 / 9
    for angle in CLOCK_TICK_ANGLES {
        let col = (CLOCK_CX + angle.cos() * CLOCK_RADIUS * CLOCK_X_SCALE).round();
        let row = (CLOCK_CY + angle.sin() * CLOCK_RADIUS).round();
        if row >= 0.0 && (row as usize) < CLOCK_HEIGHT && col >= 0.0 && (col as usize) < CLOCK_WIDTH
        {
            grid[row as usize][col as usize] = '•';
        }
    }

    let hours12 = (now.hour() % 12) as f64;
    let minutes = now.minute() as f64;
    let seconds = now.second() as f64;

    let hour_angle = ((hours12 + minutes / 60.0) / 12.0) * 2.0 * std::f64::consts::PI
        - std::f64::consts::FRAC_PI_2;
    let minute_angle = ((minutes + seconds / 60.0) / 60.0) * 2.0 * std::f64::consts::PI
        - std::f64::consts::FRAC_PI_2;
    let second_angle = (seconds / 60.0) * 2.0 * std::f64::consts::PI - std::f64::consts::FRAC_PI_2;

    draw_hand(&mut grid, hour_angle, CLOCK_RADIUS * 0.5, '█');
    draw_hand(&mut grid, minute_angle, CLOCK_RADIUS * 0.8, '█');
    draw_hand(&mut grid, second_angle, CLOCK_RADIUS * 0.95, '•');

    grid[CLOCK_CY as usize][CLOCK_CX as usize] = '●';

    grid.into_iter()
        .map(|row| row.into_iter().collect())
        .collect()
}

fn full_time(now: DateTime<Local>) -> String {
    now.format("%H:%M:%S").to_string()
}

fn full_date(now: DateTime<Local>) -> String {
    format!(
        "{} {} {}",
        now.day(),
        MONTHS_RU[now.month0() as usize],
        now.year()
    )
}

fn weekday(now: DateTime<Local>) -> &'static str {
    WEEKDAYS_RU[now.weekday().num_days_from_sunday() as usize]
}

// ---- layout ----

const NESTED_PANEL_WIDTH: u16 = CLOCK_WIDTH as u16 + 2 /* padding */ + 2 /* border */;
const NESTED_PANEL_HEIGHT: u16 = CLOCK_HEIGHT as u16 + 2 /* padding */ + 2 /* border */;
/// digital-time + gap + date-line + gap + separator + gap + nested panel (Column gap=1).
const CONTENT_HEIGHT: u16 = 1 + 1 + 1 + 1 + 1 + 1 + NESTED_PANEL_HEIGHT;
const CONTENT_WIDTH: u16 = NESTED_PANEL_WIDTH;

fn centered_x(area: Rect, width: u16) -> u16 {
    area.x + area.width.saturating_sub(width) / 2
}

fn draw(frame: &mut Frame, now: DateTime<Local>) {
    let area = frame.area();
    frame.render_widget(
        Block::default().style(Style::default().bg(BACKGROUND)),
        area,
    );

    let outer = Block::bordered()
        .border_type(BorderType::Rounded)
        .border_style(Style::default().fg(BORDER).bg(BACKGROUND))
        .title(Line::styled(
            " Часы ",
            Style::default()
                .fg(FOREGROUND)
                .bg(BACKGROUND)
                .add_modifier(Modifier::BOLD),
        ))
        .style(Style::default().bg(BACKGROUND));
    let inner = outer.inner(area);
    frame.render_widget(outer, area);

    // Column padding=1
    let padded = Rect {
        x: inner.x + 1,
        y: inner.y + 1,
        width: inner.width.saturating_sub(2),
        height: inner.height.saturating_sub(2),
    };

    if padded.width < CONTENT_WIDTH || padded.height < CONTENT_HEIGHT {
        let msg = format!("нужно хотя бы {CONTENT_WIDTH}×{}", CONTENT_HEIGHT + 4);
        let p = Paragraph::new(msg)
            .style(Style::default().fg(FOREGROUND_MUTED).bg(BACKGROUND))
            .alignment(Alignment::Center);
        frame.render_widget(p, padded);
        return;
    }

    let mut y = padded.y;
    let row = |y: u16| Rect {
        x: padded.x,
        y,
        width: padded.width,
        height: 1,
    };

    frame.render_widget(
        Paragraph::new(full_time(now))
            .style(
                Style::default()
                    .fg(ACCENT_HI)
                    .bg(BACKGROUND)
                    .add_modifier(Modifier::BOLD),
            )
            .alignment(Alignment::Center),
        row(y),
    );
    y += 2; // gap=1

    let date_line = format!("{}, {}", weekday(now), full_date(now));
    frame.render_widget(
        Paragraph::new(date_line)
            .style(
                Style::default()
                    .fg(FOREGROUND_MUTED)
                    .bg(BACKGROUND)
                    .add_modifier(Modifier::DIM),
            )
            .alignment(Alignment::Center),
        row(y),
    );
    y += 2; // gap=1

    frame.render_widget(Block::default().style(Style::default().bg(LINE)), row(y));
    y += 2; // gap=1

    let panel_rect = Rect {
        x: centered_x(padded, NESTED_PANEL_WIDTH),
        y,
        width: NESTED_PANEL_WIDTH,
        height: NESTED_PANEL_HEIGHT,
    };
    let analog_panel = Block::bordered()
        .border_type(BorderType::Rounded)
        .border_style(Style::default().fg(BORDER).bg(BACKGROUND))
        .title(Line::styled(
            " Аналоговые часы ",
            Style::default()
                .fg(FOREGROUND)
                .bg(BACKGROUND)
                .add_modifier(Modifier::BOLD),
        ))
        .style(Style::default().bg(BACKGROUND));
    let analog_inner = analog_panel.inner(panel_rect);
    frame.render_widget(analog_panel, panel_rect);

    let analog_padded = Rect {
        x: analog_inner.x + 1,
        y: analog_inner.y + 1,
        width: analog_inner.width.saturating_sub(2),
        height: analog_inner.height.saturating_sub(2),
    };
    let face_lines: Vec<Line> = build_analog_clock_face(now)
        .into_iter()
        .map(|line| Line::styled(line, Style::default().fg(ACCENT).bg(BACKGROUND)))
        .collect();
    frame.render_widget(
        Paragraph::new(RtText::from(face_lines)).alignment(Alignment::Center),
        analog_padded,
    );
}

fn run(terminal: &mut Terminal<CrosstermBackend<Stdout>>) -> Result<()> {
    loop {
        let now = Local::now();
        terminal.draw(|frame| draw(frame, now))?;

        if event::poll(Duration::from_millis(250))?
            && let Event::Key(key) = event::read()?
            && key.kind == KeyEventKind::Press
        {
            let quit = matches!(key.code, KeyCode::Char('q') | KeyCode::Esc)
                || (key.code == KeyCode::Char('c')
                    && key.modifiers.contains(KeyModifiers::CONTROL));
            if quit {
                return Ok(());
            }
        }
    }
}

fn main() -> Result<()> {
    color_eyre::install()?;

    let original_hook = panic::take_hook();
    panic::set_hook(Box::new(move |info| {
        let _ = disable_raw_mode();
        let _ = execute!(io::stdout(), LeaveAlternateScreen);
        original_hook(info);
    }));

    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen)?;
    let mut terminal = Terminal::new(CrosstermBackend::new(stdout))?;

    let result = run(&mut terminal);

    disable_raw_mode()?;
    execute!(terminal.backend_mut(), LeaveAlternateScreen)?;
    terminal.show_cursor()?;

    result
}
