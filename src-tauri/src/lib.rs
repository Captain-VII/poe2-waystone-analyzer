use std::{
    env, fs,
    sync::{Mutex, PoisonError},
    thread,
    time::Duration,
};

use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    webview::Color,
    Emitter, Manager, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

mod hotkeys;
mod input;
mod logging;
mod migration;
mod render;
mod updater;

use hotkeys::*;
use input::*;
use logging::*;
use migration::*;
use render::*;
use updater::*;

/// Bundled starting point for the user-editable meta.json (cahier des
/// charges §10) — copied into the app config dir on first run only, never
/// overwriting a file the user has since edited. Deliberately EMPTY since
/// the in-app Méta editor exists: a seed that duplicated the hardcoded
/// defaults pinned them, silently diverging when the code's tuning evolved
/// (the 2026-07-08 stale-meta.json bug). Empty = pure defaults, and the
/// editor writes only genuine customizations (diff-only).
const DEFAULT_META_JSON: &str = include_str!("../default-meta.json");

/// Logical window size — the single source of truth, also passed to
/// `.inner_size()` at window creation. `reveal_window` re-asserts this
/// explicitly (converted to physical px) rather than nudging off of a
/// relative `inner_size()` read, which was observed to occasionally read
/// back a corrupted size (window collapsed to 16×16) right after a
/// hide()/show() cycle.
const WINDOW_LOGICAL_SIZE: (f64, f64) = (620.0, 406.0);

/// Managed as Tauri state wrapping the guard in `Option` so the tray "quit"
/// handler can `.take()` and explicitly drop it — flushing the non-blocking
/// writer — before `app.exit()`. `AppHandle::exit()` bottoms out in the
/// window backend's event loop, which on every platform terminates the
/// process directly (`-> !`, no unwind), so managed state's `Drop` never
/// runs on its own; an explicit `.take()` + `drop()` is required for the
/// last buffered lines (e.g. the "quit requested" line itself) to reach
/// disk. `Manager::unmanage()` would do this too but is deprecated/unsafe
/// upstream — `Mutex<Option<T>>` + `take()` is tauri's documented
/// replacement.
type LogGuard = Mutex<Option<tracing_appender::non_blocking::WorkerGuard>>;

fn seed_meta_json(app: &tauri::AppHandle) {
    let Ok(dir) = app.path().app_config_dir() else {
        return;
    };
    if fs::create_dir_all(&dir).is_err() {
        return;
    }
    let path = dir.join("meta.json");
    if !path.exists() {
        let _ = fs::write(&path, DEFAULT_META_JSON);
    }
}

type Rect = (f64, f64, f64, f64);

/// Physical-pixel screen rects of the currently-visible interactive controls
/// (§2: toggle / footer / mod-scroll only), reported by the frontend after
/// every mount, mode morph, and analyze. Click-through is re-enabled for the
/// whole window except when the cursor is inside one of these.
struct InteractiveRects(Mutex<Vec<Rect>>);

#[tauri::command]
fn set_interactive_rects(state: tauri::State<'_, InteractiveRects>, rects: Vec<Rect>) {
    *state.0.lock().unwrap_or_else(PoisonError::into_inner) = rects;
}

/// Header's pin toggle — when true, the click-through poll loop's
/// click-away-to-dismiss (see its own comment further down) is skipped, so
/// the overlay stays up while the player clicks around in the game. Default
/// false (existing behavior unchanged); the frontend pushes its persisted
/// value here once at startup and again on every toggle.
struct PinState(Mutex<bool>);

#[tauri::command]
fn set_pinned(state: tauri::State<'_, PinState>, pinned: bool) {
    *state.0.lock().unwrap_or_else(PoisonError::into_inner) = pinned;
}

/// Settings' "Start minimized" toggle needs to tell a Windows-autostart
/// launch apart from the user double-clicking the exe — the autostart
/// plugin is configured (see `run()`) to always append `--autostart` to the
/// command line it registers in the HKCU Run key, so a plain manual launch
/// never has this arg. The frontend only skips `show_window` on init when
/// both this is true AND the user's own toggle is on — a manual launch
/// always shows the window regardless of the toggle.
#[tauri::command]
fn was_autostart_launch() -> bool {
    std::env::args().any(|a| a == "--autostart")
}

#[tauri::command]
fn log_frontend_report(report: String) {
    tracing::info!(target: "frontend", report = %report, "frontend report received");
}

#[tauri::command]
async fn log_window_diagnostics(window: tauri::WebviewWindow) -> Result<(), String> {
    let label = window.label().to_string();
    let outer_size = window.outer_size().map_err(|e| e.to_string())?;
    let inner_size = window.inner_size().map_err(|e| e.to_string())?;
    let outer_pos = window.outer_position().map_err(|e| e.to_string())?;
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let monitor = window.current_monitor().map_err(|e| e.to_string())?;
    let visible = window.is_visible().map_err(|e| e.to_string())?;
    let focused = window.is_focused().map_err(|e| e.to_string())?;

    let current_monitor = monitor.as_ref().map_or_else(
        || "none".to_string(),
        |m| {
            format!(
                "pos=({},{}) size={}x{} scale={}",
                m.position().x,
                m.position().y,
                m.size().width,
                m.size().height,
                m.scale_factor()
            )
        },
    );
    tracing::info!(
        target: "window_diagnostics",
        label = %label,
        outer_size = format!("{}x{}", outer_size.width, outer_size.height),
        inner_size = format!("{}x{}", inner_size.width, inner_size.height),
        outer_position = format!("({}, {})", outer_pos.x, outer_pos.y),
        scale_factor = scale,
        current_monitor = %current_monitor,
        visible,
        focused,
        "window diagnostics snapshot"
    );

    // A fixed, known set of 7 vars (not a dynamic list) — spelled out as
    // named fields rather than joined into one string, so each stays
    // individually greppable in the exported log (`grep OVERLAY_SHADOW`),
    // unlike a single comma-joined blob.
    fn env_or_unset(key: &str) -> String {
        env::var(key).unwrap_or_else(|_| "(unset)".into())
    }
    tracing::info!(
        target: "window_diagnostics",
        overlay_debug_opaque = %env_or_unset("OVERLAY_DEBUG_OPAQUE"),
        overlay_transparent = %env_or_unset("OVERLAY_TRANSPARENT"),
        overlay_decorations = %env_or_unset("OVERLAY_DECORATIONS"),
        overlay_always_on_top = %env_or_unset("OVERLAY_ALWAYS_ON_TOP"),
        overlay_shadow = %env_or_unset("OVERLAY_SHADOW"),
        overlay_skip_taskbar = %env_or_unset("OVERLAY_SKIP_TASKBAR"),
        overlay_click_through = %env_or_unset("OVERLAY_CLICK_THROUGH"),
        "env matrix snapshot"
    );
    Ok(())
}

/// `OVERLAY_DEBUG=1` turns on the frontend's debug corner (parsed mods,
/// score, rebuild time — see RelicPanel's setDebugInfo). Read here rather
/// than in JS because the flag is a process env var owned by whoever
/// launched the app, which the webview has no access to.
#[tauri::command]
fn is_debug_overlay() -> bool {
    env_flag("OVERLAY_DEBUG", false)
}

fn env_flag(key: &str, default: bool) -> bool {
    match env::var(key).as_deref() {
        Ok("0") => false,
        Ok("1") => true,
        _ => default,
    }
}

fn has_cli_flag(flag: &str) -> bool {
    env::args().any(|a| a == flag)
}

pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    // Compare parsed Shortcuts, not display strings — the
                    // plugin's to_string() normalization isn't a stable
                    // format to match against.
                    let base = app.state::<HotkeyBase>().0.lock().unwrap_or_else(PoisonError::into_inner).clone();
                    let action = all_accels(&base)
                        .into_iter()
                        .find(|(accel, _)| accel.parse::<Shortcut>().is_ok_and(|s| s == *shortcut))
                        .map(|(_, action)| action);
                    match action {
                        Some(action) => {
                            tracing::debug!(target: "hotkey", %action, "shortcut pressed");
                            if let Err(e) = app.emit("overlay://hotkey", action) {
                                tracing::error!(target: "hotkey", error = %e, "emit failed");
                            }
                        }
                        None => {
                            tracing::warn!(target: "hotkey", shortcut = ?shortcut, "unmatched shortcut fired")
                        }
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        // MacosLauncher::LaunchAgent is ignored on Windows (this app's only
        // real target) but required at compile time by the plugin's API.
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
        ))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .manage(InteractiveRects(Mutex::new(Vec::new())))
        .manage(PinState(Mutex::new(false)))
        .manage(PendingUpdate(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            set_interactive_rects,
            log_window_diagnostics,
            log_frontend_report,
            show_window,
            reveal_window,
            check_render_health,
            simulate_copy,
            hide_window,
            was_autostart_launch,
            set_pinned,
            get_hotkey_base,
            set_hotkey_base,
            check_update_channel,
            install_pending_update,
            is_debug_overlay
        ])
        .setup(|app| {
            // Before anything creates the new identifier's folders (logs,
            // meta.json, the WebView2 profile): see migration.rs.
            let migrations = migrate_legacy_dirs(app.handle());
            app.manage(LogGuard::new(Some(init_logging(app.handle()))));
            install_panic_hook();
            for (dir, outcome) in &migrations {
                match outcome {
                    Migration::NothingToMove => {}
                    Migration::Moved => tracing::info!(target: "migration", dir, "moved legacy data folder"),
                    other => tracing::warn!(target: "migration", dir, outcome = ?other, "legacy data folder not moved"),
                }
            }
            seed_meta_json(app.handle());
            let hotkey_base = load_hotkey_base(app.handle());
            app.manage(HotkeyBase(Mutex::new(hotkey_base.clone())));
            register_hotkeys(app.handle(), &hotkey_base);

            // --debug-opaque-overlay (or OVERLAY_DEBUG_OPAQUE=1 under `tauri dev`):
            // same window geometry/position as the shipped overlay, but opaque,
            // non-click-through, with a big "OVERLAY DEBUG" label — proves the
            // surface paints at all, isolated from every transparency/compositing
            // variable. Every other axis stays independently toggleable via env
            // var for the render-paint investigation.
            let debug_opaque =
                has_cli_flag("--debug-opaque-overlay") || env_flag("OVERLAY_DEBUG_OPAQUE", false);
            // Independently overridable even in debug mode (bisect: is `transparent`
            // itself the hover-blackening culprit?) — defaults false in debug mode
            // (matching the original "prove paint works" intent) unless set explicitly.
            let transparent = env_flag("OVERLAY_TRANSPARENT", !debug_opaque);
            let decorations = env_flag("OVERLAY_DECORATIONS", false); // frameless in both modes — same geometry
            let always_on_top = env_flag("OVERLAY_ALWAYS_ON_TOP", true);
            let shadow = env_flag("OVERLAY_SHADOW", false);
            let skip_taskbar = env_flag("OVERLAY_SKIP_TASKBAR", true);
            // Independently overridable even in debug mode (bisect: is the runtime
            // set_ignore_cursor_events() toggling itself the hover-blackening culprit?).
            let click_through = env_flag("OVERLAY_CLICK_THROUGH", !debug_opaque);

            let title = if debug_opaque {
                "Waystone-Analyzer [DEBUG OPAQUE]"
            } else {
                "Waystone-Analyzer"
            };

            let mut builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                .title(title)
                .inner_size(WINDOW_LOGICAL_SIZE.0, WINDOW_LOGICAL_SIZE.1)
                .resizable(false)
                .decorations(decorations)
                .transparent(transparent)
                .always_on_top(always_on_top)
                .shadow(shadow)
                .skip_taskbar(skip_taskbar)
                .focused(false)
                .visible(false); // shown explicitly once the frontend confirms a real first paint

            // Fully-transparent windows leave DirectComposition's clear color
            // undefined; on a hover-triggered recomposite (DWM hit-test
            // re-evaluation) that ambiguity is a known trigger for the surface
            // going solid black instead of showing the real frame. Stating the
            // color explicitly removes that ambiguity. Opaque debug builds get
            // an explicit opaque color too, for the same reason.
            if env_flag("OVERLAY_EXPLICIT_BG", true) {
                builder = builder.background_color(if transparent {
                    Color(0, 0, 0, 0)
                } else {
                    Color(26, 26, 46, 255) // matches the debug-opaque #1a1a2e ground
                });
            }

            let win = builder.build()?;

            tracing::info!(
                target: "overlay",
                debug_opaque,
                transparent,
                decorations,
                always_on_top,
                shadow,
                skip_taskbar,
                click_through,
                "window built"
            );

            if click_through {
                win.set_ignore_cursor_events(true)?;

                let handle = win.clone();
                let app_handle = app.handle().clone();
                thread::spawn(move || {
                    let mut interactive = false;
                    let mut first_check = true;
                    loop {
                        let rects = app_handle
                            .state::<InteractiveRects>()
                            .0
                            .lock()
                            .unwrap_or_else(PoisonError::into_inner)
                            .clone();
                        let inside = match handle.cursor_position() {
                            Ok(c) if !rects.is_empty() => rects.iter().any(|&(x, y, w, h)| {
                                c.x >= x && c.y >= y && c.x < x + w && c.y < y + h
                            }),
                            // No regions reported yet (early startup): fall back to
                            // whole-window bounds so nothing is un-clickable before
                            // the frontend's first report lands.
                            Ok(c) => match (handle.outer_position(), handle.outer_size()) {
                                (Ok(p), Ok(s)) => {
                                    c.x >= p.x as f64
                                        && c.y >= p.y as f64
                                        && c.x < (p.x + s.width as i32) as f64
                                        && c.y < (p.y + s.height as i32) as f64
                                }
                                _ => interactive,
                            },
                            _ => interactive,
                        };
                        // Skip the nudge (but still sync `interactive`/cursor-events) on
                        // the thread's first observation — if the cursor already happens
                        // to be over the window at startup (e.g. left there from a prior
                        // test), this is establishing initial state, not a real hover
                        // entry, and nudging this early raced with window-show and caused
                        // an "invisible from the start" regression in testing.
                        let is_real_transition = inside != interactive && !first_check;
                        first_check = false;
                        if inside != interactive {
                            interactive = inside;
                            let _ = handle.set_ignore_cursor_events(!inside);
                            if inside && is_real_transition {
                                tracing::debug!(target: "overlay", "hover-nudge firing (cursor entered window)");
                                recompose_nudge(&handle);
                            }
                        }

                        // Click-away-to-dismiss: a fresh left-click landing outside every
                        // reported interactive rect is, by definition, a click-through
                        // click into the game — hide the overlay so it doesn't linger
                        // over gameplay until the player deliberately re-checks with Ins
                        // (see reveal_window / hotkeys.ts's Insert handler). Skipped
                        // entirely when the header's pin toggle is on (PinState).
                        let pinned = *handle.state::<PinState>().0.lock().unwrap_or_else(PoisonError::into_inner);
                        if left_click_since_last_poll() && !inside && !pinned {
                            let _ = handle.hide();
                        }

                        thread::sleep(Duration::from_millis(50));
                    }
                });
            } else {
                tracing::info!(target: "overlay", "click-through disabled — window is focusable/interactive");
            }

            // System-tray icon: the only way to fully quit. The window itself
            // has no decorations/close box and is skip_taskbar, so without
            // this a stray Settings-panel click was the sole exit — now that
            // button just hides the window (see `hide_window`), and this menu
            // is what actually ends the process.
            let show_item =
                MenuItem::with_id(app, "show", "Afficher / Masquer", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quitter", true, None::<&str>)?;
            let tray_menu = Menu::with_items(app, &[&show_item, &quit_item])?;

            let tray_win = win.clone();
            TrayIconBuilder::new()
                .icon(app.default_window_icon().cloned().unwrap())
                .menu(&tray_menu)
                .show_menu_on_left_click(true)
                .tooltip("Waystone-Analyzer")
                .on_menu_event(move |app, event| match event.id().as_ref() {
                    "quit" => {
                        tracing::info!(target: "overlay", "quit requested from tray menu");
                        // Flush the last buffered log lines before app.exit() —
                        // see LogGuard's doc comment for why Drop alone can't be
                        // relied on here.
                        if let Some(guard) = app.state::<LogGuard>().lock().unwrap_or_else(PoisonError::into_inner).take() {
                            drop(guard);
                        }
                        app.exit(0);
                    }
                    "show" => {
                        tracing::debug!(target: "overlay", "show requested from tray menu");
                        let _ = tray_win.show();
                        let _ = tray_win.set_focus();
                        restore_known_size(&tray_win);
                    }
                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running waystone overlay");
}
