# Waystone Overlay

[![Version](https://img.shields.io/badge/version-0.4.0-b8860b)](CHANGELOG.md)
[![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-0078d4)](#requirements)
[![Built with Tauri](https://img.shields.io/badge/built%20with-Tauri-24c8db)](https://tauri.app)

A small always-on-top overlay for **Path of Exile 2** that reads a Waystone
you're hovering and tells you, at a glance, whether it's worth running and
which tablet and Atlas Master to pair it with — without alt-tabbing out of
the game.

## Contents

- [What it does](#what-it-does)
- [Requirements](#requirements)
- [Install](#install)
- [Usage](#usage)
  - [Reading the overlay](#reading-the-overlay)
  - [How the Juice Score works](#how-the-juice-score-works)
  - [Settings](#settings)
  - [Tuning via meta.json](#tuning-via-metajson)
- [Known issues](#known-issues)
- [For developers](#for-developers)

## What it does

Hover a Waystone in-game and press **Ins**. The overlay copies the item for
you, scores it, and shows a three-column readout:

| Column | What's in it |
|---|---|
| **Recommended Tablets** | Every tablet ranked by fit %, each with a Run / Why not / Don't run verdict, plus the **Atlas Master** to run for the winning mechanic |
| **Heat Breakdown** | The **Juice Score** (0-100) with its tier badge, the five stats behind it as fill bars, and Total Heat |
| **Insights** | Every danger mod found, most dangerous first, plus a **Bonus** row of icons for the waystone's strengths |

A **Juicy** find (top tier) also fires a native OS notification and a short
chime, in case you're mid-fight and miss it.

The overlay is click-through everywhere except its own buttons, so it never
blocks a click into the game underneath.

## Requirements

- Windows 10/11
- [Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/) —
  usually already installed on modern Windows; if the overlay won't launch,
  install this first.

## Install

Grab the installer from the [latest release](https://github.com/Captain-VII/poe2-waystone-analyzer-v3/releases),
or build one yourself with `npm run tauri:build` (lands in
`src-tauri/target/release/bundle/nsis/`). It installs per-user — no admin
rights needed — and adds a Start Menu shortcut.

The app updates itself: it checks on launch and offers to install a new
version when one ships. **Settings → Check for updates** does it on demand.

To uninstall, use **Settings → Apps** and remove "waystone-overlay" like any
other app.

## Usage

| Key | Action | Scope |
|---|---|---|
| **Ins** | Analyze the Waystone you're hovering (auto-copies it first) | Global |
| **Ctrl+E** | Also analyzes — fixed, works no matter what the base key is remapped to | Global |
| **Escape** | Minimize the overlay to the tray | Only when the overlay has focus |

The two analyze keys are **global shortcuts** — they work while the game has
focus. Escape deliberately isn't: grabbing it globally swallowed the key
OS-wide, including inside the game. Whatever was on your clipboard before
analyzing is restored afterward.

The base key (Ins) is remappable: open Settings (gear button), click the
**Hotkey** binding, then press the new key. Escape cancels the capture. The
choice persists across restarts (`hotkey.txt` in the app config dir, next to
`meta.json`). Ctrl+E is separate and always stays on analyze.

The overlay defaults to the top-right corner, but you can **drag it** by its
title bar to wherever fits your HUD — the new position is remembered. A
display or resolution change re-anchors it top-right so it can never end up
off-screen; **Settings → Position → Reset** does the same on demand.

The **pin** button keeps the overlay open when you click elsewhere, and the
**copy** button puts a text summary of the current analysis on your
clipboard.

### Reading the overlay

- **Juice Score** — a 0-100 number answering "how good is the best thing I
  can do with this map?". See [below](#how-the-juice-score-works) for
  exactly how it's built.
- **Tier badge** — `WEAK` → `AVERAGE` → `GOOD` → `EXCELLENT` → `JUICY ✦`,
  on the 20 / 40 / 60 / 80 score boundaries. A letter rating (S/A/B/C/D)
  sits next to Total Heat on the same bands.
- **Verdict** — **Skip** (score under 20), **Keep** (score 50+ on a Tier 3+
  Waystone — worth holding for a good tablet rather than running now), or
  **Run** for everything else worth playing.
- **Heat Breakdown bars** — each of the five stats against its own
  realistic ceiling, so a +60% Waystone Drop Chance (ceiling 155%) reads
  smaller than a +60% Pack Size (ceiling 65%). Drop Chance simply rolls
  much higher than the rest.
- **Insights** — every detected danger mod, sorted most dangerous first and
  grouped into high (red) / Medium (gold) / Low (grey). The **danger level**
  next to the heading (`Safe` / `Manageable` / `Dangerous` /
  `Very Dangerous`) is derived from those mods **only, never from the
  score** — a map can be Juicy and Very Dangerous at the same time. That's
  information, not a bug.
- **Bonus row** — icons for the waystone's strengths (a dominant stat, a
  strong mechanic match, reward-carrying tablets). Hover any icon for the
  full text.

An in-app **Guide** (the `?` button) explains all of this from the player's
side, and is kept in sync with the real logic.

### How the Juice Score works

The score is your **best-fitting real league mechanic's fit** — not a
separate map-wide number.

Each mechanic cares about exactly one stat, its **priority stat**:

| Mechanic | Priority stat |
|---|---|
| Delirium | Pack Size |
| Expedition | Item Quantity |
| Breach | Monster Effectiveness |
| Ritual, Abyss | Monster Rarity |
| Temple | Item Rarity |

That roll is tiered on its own — under 15% Weak, 15-25% OK, 25-50% Top,
50%+ Legendary — and **the tier is the base score**: 10, 25, 55 or 80.
On top of it come the waystone's modifier count (up to +8 at 8 mods), a +10
bonus if the tablet is one of that mechanic's curated picks, and the
tablet's own reward value (Splinters, Artifacts, and such). The last two
only apply once the waystone is at least "OK" for the mechanic — a weak
roll can't be rescued by a rich tablet.

Two consequences worth knowing:

- **One great roll carries the score** instead of being averaged down by
  four mediocre lines. That's deliberate — it replaced an earlier
  weighted-sum model that buried genuinely strong waystones.
- **Overseer and Irradiated never count.** They aren't real league-encounter
  mechanics; their fit still shows in the "Other" box below the main list,
  but only Breach / Ritual / Delirium / Expedition / Abyss / Temple can
  drive the Juice Score or the Atlas Master pick.

**Item Quantity** is parsed but deliberately excluded from the score itself
— it skewed results when weighted in. It still drives Expedition's fit,
where it genuinely predicts profit.

**Danger mods never lower the score.** The Juice Score measures loot
potential only; whether a Reflect map is worth the risk is your call, so
danger is reported alongside instead of baked in.

### Settings

The gear button opens four tabs:

- **Overlay** — Insights toggle, Reduce Effects, **Overlay Opacity** and
  **Overlay Scale**, hotkey remap, and **Position → Reset** (re-anchor
  top-right).
- **Session** — waystones analyzed, average score and best find for the
  current session, plus **History**: every past session archived, with
  **Export CSV** to the clipboard for Excel/Sheets.
- **Meta** — the in-app editor described below, plus **Validate meta.json**
  (reports the exact parse error, with line and column).
- **App** — **Launch with Windows** (registry Run key, no elevation),
  **Start minimized**, version, **Beta channel** opt-in, **Check for
  updates**, patch notes, and **Hide Overlay**.

### Tuning via meta.json

> `meta.json` controls mechanics, tablets, rewards, and enable/disable
> flags. It does **not** contain the score formula itself — the tier
> boundaries and bonuses live in `src/analyzer/`.

An editable `meta.json` lives in the app's config directory, seeded on first
run from `src-tauri/default-meta.json` (which ships empty — every default
comes from code).

**Most of it is editable in-app**: Settings' **Meta** section covers each
mechanic's priority stat and skip threshold, plus enabling/disabling
tablets — dropdowns, no typo risk, immediate effect, and a reset button.
Clicking any tablet row in Full mode opens the same editor scoped to that
one mechanic. The editor writes only values that differ from the built-in
defaults and preserves anything else you hand-wrote (custom tablets,
`recommendedTablets`, unknown keys).

Hand-editing remains the way to add custom tablets. Add an entry to the
`"tablets"` array with its mods as plain PoE2-style text — the same tolerant
parser used for waystones reads them, and the tablet is ranked against every
mechanic automatically:

```json
{
  "metas": { },
  "tablets": [
    {
      "name": "Legion Tablet",
      "mods": ["40% increased Pack Size", "20% increased Monster Rarity"],
      "tags": ["legion"]
    },
    { "name": "Ritual Tablet", "enabled": false }
  ]
}
```

An entry whose `name` matches a bundled default (case-insensitive) overrides
that default; any other name is added as a new tablet. `"enabled": false`
hides a tablet without deleting its definition — no `mods` needed for that.

A tablet can declare how reliable its data is — informational only today,
not used in scoring:

```json
{ "name": "Legion Tablet", "mods": [], "confidence": "low", "source": "manual" }
```

`confidence` is `"high"` / `"medium"` / `"low"`; `source` is `"wiki"`,
`"poe2db"` (data-mined — confirms the item exists, not necessarily exact
wording), `"community"` (single unconfirmed source), or `"manual"`.

**Rewards** (optional) let a tablet's ranking reflect value the generic
stats can't express — real mechanic currency, mainly, since PoE2's actual
Breach/Expedition/Delirium/Ritual/Abyss tablets mostly grant
Splinters/Artifacts/Tribute rather than boosting stats:

```json
{
  "name": "Delirium Tablet",
  "mods": ["20% increased Pack Size"],
  "rewards": [
    { "type": "mechanic", "id": "delirium", "value": 9 },
    { "type": "currency", "id": "simulacrum_splinter", "weight": 3 }
  ]
}
```

Three shapes: `"mechanic"` (looked up in `src/analyzer/rewards.ts`'s
`MECHANIC_VALUES` first, so tablets citing the same mechanic stay
consistent, falling back to this entry's `value`), `"currency"` (`weight`
scaled by one shared multiplier), and `"generic"` (`score` directly). A
tablet without `"rewards"` is ranked purely on stats.

## Known issues

See [KNOWN_ISSUES.md](KNOWN_ISSUES.md) — most importantly, the overlay can
occasionally render as a black or invisible rectangle. This is a known,
unresolved WebView2/graphics-driver compositor issue, not something a
restart of the game fixes. Read that file before reporting it as a new bug.

## For developers

### Tech stack

Tauri 2 (Rust backend, native window/tray/notifications/global hotkeys)
wrapping a Vite + TypeScript frontend — no UI framework, plain DOM. Vitest
for tests, ESLint for linting.

### Docs

- [`docs/overlay-ui-spec.md`](docs/overlay-ui-spec.md) — the locked
  visual/behavioral spec (dimensions, colors, animations, data contract).
- [`docs/implementation-plan.md`](docs/implementation-plan.md) —
  milestone-by-milestone build log, including the full compositor-bug
  investigation.
- [`docs/release-checklist.md`](docs/release-checklist.md) — what to verify
  before shipping.
- [`CHANGELOG.md`](CHANGELOG.md) — player-facing release notes (embedded in
  the app's "What's new" panel). [`ROADMAP.md`](ROADMAP.md) is its
  forward-looking counterpart.

### Build requirements

- [Node.js](https://nodejs.org/) 20+ and npm
- [Rust](https://www.rust-lang.org/tools/install) (stable) + Cargo
- [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)
  (usually preinstalled) + the "Desktop development with C++" workload from
  Visual Studio Build Tools

### Setup

```bash
git clone https://github.com/Captain-VII/poe2-waystone-analyzer-v3.git
cd poe2-waystone-analyzer-v3
npm install
```

### Dev

```bash
npm run tauri:dev
```

Runs the full app — Tauri window, Rust backend, hot reload. `npm run dev`
starts the frontend alone in a browser at `localhost:5173`, useful for CSS
work (it renders mock fixtures, since there's no clipboard bridge).

Set `OVERLAY_DEBUG=1` to show a small corner readout of each analysis —
parsed mod count, score, and parse+render time — for iterating on the
scoring formulas without restarting or reading logs. Several other
`OVERLAY_*` flags bisect window-creation behaviour while chasing the
black-screen bug; they're listed in `src-tauri/src/lib.rs`'s `env_flag`
call sites.

### Build and test

```bash
npm run build           # type-check + frontend production build (dist/)
npm run tauri:build     # release installer (src-tauri/target/release/bundle/)
npm test                # unit tests (Vitest)
npm run verify-adapter  # contract-tests the scoring/parsing pipeline
npm run lint            # ESLint
```

### Releasing

Push a version tag and CI builds, signs, and publishes the installer, then
refreshes the updater feed the app polls. The version lives in three files
that must agree: `package.json`, `src-tauri/Cargo.toml`, and
`src-tauri/tauri.conf.json`.
