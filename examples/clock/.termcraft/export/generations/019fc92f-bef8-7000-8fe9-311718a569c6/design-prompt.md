# Design Prompt

This package is the exported design for the current project. Every listed snapshot
file is an acceptance fixture: your implementation at that exact size must render
output matching it — diff your output against it.

## Pages

### dashboard

- theme: dark-default
- kitApiVersion: 1
- source: pages/dashboard/page.tsx
- layout: layout/dashboard.json (per-size resolved layout trees; ids/boxes populated, text awaits the runtime catalog — D-Q6)
- rendered sizes:
  - 60x26 -> snapshots/dashboard/60x26.txt
  - 120x40 -> snapshots/dashboard/120x40.txt
  - 160x40 -> snapshots/dashboard/160x40.txt

### calendar

- theme: dark-default
- kitApiVersion: 1
- source: pages/calendar/page.tsx
- layout: layout/calendar.json (per-size resolved layout trees; ids/boxes populated, text awaits the runtime catalog — D-Q6)
- rendered sizes:
  - 60x26 -> snapshots/calendar/60x26.txt
  - 120x40 -> snapshots/calendar/120x40.txt
  - 160x40 -> snapshots/calendar/160x40.txt

### world-clock

- theme: dark-default
- kitApiVersion: 1
- source: pages/world-clock/page.tsx
- layout: layout/world-clock.json (per-size resolved layout trees; ids/boxes populated, text awaits the runtime catalog — D-Q6)
- rendered sizes:
  - 74x28 -> snapshots/world-clock/74x28.txt
  - 120x40 -> snapshots/world-clock/120x40.txt
  - 160x40 -> snapshots/world-clock/160x40.txt

## Runtime

- module: @termcraft/runtime
- currentKitApiVersion: 1
- supportedKitApiVersions: 1
