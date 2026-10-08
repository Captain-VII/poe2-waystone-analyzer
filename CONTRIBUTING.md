# Contributing

## Stack

Tauri 2 (Rust: window, tray, notifications, global hotkeys, updater) around a
Vite + TypeScript frontend with no UI framework. Vitest, Playwright (visual
regression), ESLint, rustfmt and clippy.

| Path | What |
|---|---|
| `src/analyzer/` | Parsing, scoring, mechanics, tablets, game-data loading |
| `src/components/RelicPanel.ts` | The whole overlay UI |
| `data/game-data.json` | Game data, updatable without a release ([data/SOURCES.md](data/SOURCES.md)) |
| `src-tauri/src/` | `lib.rs` (`run()`, shared state), `render.rs` (show/hide, black-frame recovery), `hotkeys.rs`, `input.rs`, `updater.rs`, `logging.rs` |
| `docs/overlay-ui-spec.md` | The visual/behavioral spec |
| `docs/history/` | Build log and resolved-issue history |

## Setup

Requirements: Node.js 22, Rust via rustup (the version is pinned in
`rust-toolchain.toml` and installed automatically), Visual Studio Build
Tools with "Desktop development with C++", WebView2.

```bash
git clone https://github.com/Captain-VII/poe2-waystone-analyzer.git
cd poe2-waystone-analyzer
npm ci
npm run tauri:dev
```

`npm run dev` serves the frontend alone at `localhost:5173` with mock data,
handy for CSS. `OVERLAY_DEBUG=1` adds a corner readout per analysis;
other `OVERLAY_*` flags (see `env_flag` call sites) bisect window behavior.

## Checks

CI runs all of these on every PR and push to `main`, plus weekly:

```bash
npm run lint
npm test                 # unit tests
npm run verify-adapter   # scoring/parsing contract tests on real waystones
npm run build            # type-check + production build
npm run test:visual      # Playwright screenshots (needed when touching RelicPanel.ts or styles)
cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
```

`npm run test:visual:update` refreshes the reference screenshots after an
intended visual change.

## Game data

Stat ranges, danger and bonus mod wording, mechanics and tablets live in
`data/game-data.json`. Edit it, **bump `revision`**, update
`data/SOURCES.md`, merge to `main`: every installed app picks it up on next
launch. `npm test` validates the file. See [data/SOURCES.md](data/SOURCES.md).

## Releasing

See [RELEASE.md](RELEASE.md). In short: `npm run bump -- <version>`, write
the CHANGELOG notes, push to `main`, wait for CI, push a `v<version>` tag.

## Rules

- Everything a player sees (UI, notifications, CHANGELOG) is in English.
- Never log clipboard or typed text, only lengths and flags: logs are
  exportable in one click.
- One concern per PR.
