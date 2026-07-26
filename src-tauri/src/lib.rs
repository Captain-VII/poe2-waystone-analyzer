use std::{env, fs, sync::Mutex, thread, time::Duration};

use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    webview::Color,
    Emitter, Manager, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

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

/// Structured logging (ROADMAP.md "Confort & diagnostic"): a daily-rotating
/// file in the OS log dir, plus stdout under `tauri dev` only (release
/// builds detach the console via `windows_subsystem = "windows"`, so a
/// stdout layer there would just pay formatting/lock overhead for a sink
/// nothing can read). Default level is `debug`, not `info` — the routine
/// invocation/nudge/timing lines logged at `debug!` are exactly the
/// evidence the black-screen investigation (KNOWN_ISSUES.md #1) needs, and
/// nothing here documents or exposes a `RUST_LOG` override to end users, so
/// `info` as a default would silently make this feature's whole diagnostic
/// purpose invisible. `RUST_LOG` still overrides for a quieter local run.
/// Uses `tracing_appender::non_blocking` specifically so file I/O never
/// happens on the calling thread (the "must cost nothing on the hot path"
/// rule from the roadmap item).
fn init_logging(app: &tauri::AppHandle) -> tracing_appender::non_blocking::WorkerGuard {
    use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

    let log_dir = app
        .path()
        .app_log_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."));
    let _ = fs::create_dir_all(&log_dir);
    let file_appender = tracing_appender::rolling::daily(&log_dir, "waystone-overlay.log");
    let (non_blocking, guard) = tracing_appender::non_blocking(file_appender);

    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("debug"));
    let stdout_layer = cfg!(debug_assertions).then(|| fmt::layer().with_writer(std::io::stdout));
    let _ = tracing_subscriber::registry()
        .with(filter)
        .with(stdout_layer)
        .with(fmt::layer().with_writer(non_blocking).with_ansi(false))
        .try_init();

    guard
}

/// Logs a panicking background thread via `tracing::error!` before falling
/// through to Rust's default hook (still prints to stderr when a console is
/// attached, e.g. `tauri dev`) — without this, a panic on any of this
/// file's background threads (click-through poll, hotkey retry, nudge
/// bursts) is completely invisible in a release build (`windows_subsystem
/// = "windows"` has no console for the default hook's stderr) — silently
/// killing that thread with zero trace even in the log file `init_logging`
/// exists to populate. Must be called after `init_logging` so the panic
/// message has somewhere to go.
fn install_panic_hook() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        tracing::error!("panic: {info}");
        default_hook(info);
    }));
}

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
    *state.0.lock().unwrap() = rects;
}

/// Header's pin toggle — when true, the click-through poll loop's
/// click-away-to-dismiss (see its own comment further down) is skipped, so
/// the overlay stays up while the player clicks around in the game. Default
/// false (existing behavior unchanged); the frontend pushes its persisted
/// value here once at startup and again on every toggle.
struct PinState(Mutex<bool>);

#[tauri::command]
fn set_pinned(state: tauri::State<'_, PinState>, pinned: bool) {
    *state.0.lock().unwrap() = pinned;
}

/// Defensive recompose nudge against the intermittent WebView2/
/// DirectComposition black-frame race (window reports visible/correctly
/// positioned but paints nothing) — observed on the click-through hover
/// transition, on tray un-hide, and on the Escape/click-away/Ins show-hide
/// cycle added below. A 1px resize-and-back forces WM_SIZE, which forces
/// WebView2 to recompose a fresh frame instead of potentially surfacing a
/// stale/black one.
fn recompose_nudge(window: &tauri::WebviewWindow) {
    if !env_flag("OVERLAY_HOVER_NUDGE", true) {
        return;
    }
    if let Ok(size) = window.inner_size() {
        let _ = window.set_size(tauri::Size::Physical(tauri::PhysicalSize::new(
            size.width + 1,
            size.height,
        )));
        let _ = window.set_size(tauri::Size::Physical(tauri::PhysicalSize::new(
            size.width,
            size.height,
        )));
    }
}

/// Re-asserts `WINDOW_LOGICAL_SIZE` (converted to physical px for the
/// window's current DPI) and nudges via a 1px resize-and-back — used after
/// a hide()/show() cycle (tray un-hide, Escape/click-away/Ins reveal),
/// where a *relative* nudge off `inner_size()` was observed to occasionally
/// read back a corrupted size (window collapsed to 16×16) rather than the
/// real 620×416. Forcing the known-good absolute size fixes that even if
/// the read-back was already wrong, and the resize itself still forces the
/// WM_SIZE that recomposes a fresh WebView2 frame (the original black-frame
/// motivation for nudging at all).
fn restore_known_size(window: &tauri::WebviewWindow) {
    let scale = window.scale_factor().unwrap_or(1.0);
    let w = (WINDOW_LOGICAL_SIZE.0 * scale).round() as u32;
    let h = (WINDOW_LOGICAL_SIZE.1 * scale).round() as u32;
    let _ = window.set_size(tauri::Size::Physical(tauri::PhysicalSize::new(w + 1, h)));
    let _ = window.set_size(tauri::Size::Physical(tauri::PhysicalSize::new(w, h)));
}

// An IMMEDIATE nudge here once regressed to an invisible-from-the-start
// window in testing (see the click-through thread's `first_check` guard
// below for the same lesson) — racing a resize against the window-show
// itself made things worse, not better. But the black-frame race has also
// been observed with NO nudge at all firing anywhere (trial #16,
// docs/implementation-plan.md's M1 log: "invisible from the start again...
// nudge did not fire") — startup is the one path with no hover/reveal
// transition to trigger the existing reactive nudges. `startup_nudge_burst`
// below is the new angle: DELAYED nudges (not immediate), giving the
// compositor time to settle first, at a few increasing offsets so a slow
// first composite still gets caught.
#[tauri::command]
fn show_window(window: tauri::WebviewWindow) -> Result<(), String> {
    tracing::debug!(target: "overlay", "show_window invoked by frontend (post-paint signal)");
    window.show().map_err(|e| e.to_string())?;
    startup_nudge_burst(&window);
    schedule_startup_render_check(&window);
    Ok(())
}

/// Bisectable via OVERLAY_STARTUP_NUDGE_BURST (default on) — see
/// `show_window`'s doc comment for why this exists and why it's delayed
/// rather than immediate. Three nudges at increasing offsets (not just one)
/// since the compositor race's exact timing is unknown; logged the same way
/// as every other nudge in this file so the trial-log methodology
/// (docs/implementation-plan.md M1) can track whether this one helps.
fn startup_nudge_burst(window: &tauri::WebviewWindow) {
    if !env_flag("OVERLAY_STARTUP_NUDGE_BURST", true) {
        return;
    }
    let handle = window.clone();
    thread::spawn(move || {
        for (i, delay_ms) in [300u64, 500, 700].iter().enumerate() {
            thread::sleep(Duration::from_millis(*delay_ms));
            tracing::debug!(target: "overlay", nudge = i + 1, "startup nudge firing");
            recompose_nudge(&handle);
        }
    });
}

/// Real OS-level screen capture of the window's own screen rect, checking
/// whether it came back suspiciously solid-black — the one thing every
/// diagnostic pass on the render-paint bug (docs/implementation-plan.md M1)
/// couldn't do: every trial's own DOM/CSSOM report (`diagnostics.ts`) read
/// identical whether the window was actually visible or black, because the
/// page's own layout engine has no way to observe what the *compositor*
/// ends up presenting — a CDP/browser-level screenshot has the exact same
/// blind spot (KNOWN_ISSUES #1's 2026-07-11 trial note). The only view that
/// can see this bug is a real desktop-level capture, the same one a human
/// eye or an actual screenshot tool would see.
///
/// `GetDC(None)` grabs the whole-screen device context (not the window's
/// own DC) so this reads exactly what DWM actually composited onto the
/// monitor at the window's rect — deliberately not `PrintWindow`, which
/// targets a single window's own surface and would need the
/// `PW_RENDERFULLCONTENT` flag to have any chance of seeing
/// DirectComposition content, an extra layer of uncertainty this avoids by
/// reading the desktop directly.
///
/// Downsamples to a coarse grid (every 8th pixel on each axis) rather than
/// every pixel — this runs on a background thread a second or so after
/// every show, so it must stay cheap, and "is this window overwhelmingly
/// one dark color" doesn't need full resolution to detect. Returns `Some(true)`
/// when at least 97% of the sampled pixels are near-black — high enough
/// that the panel's own gold/ivory text and borders (a small minority of
/// any frame) can't trip it, but low enough to catch the actual symptom
/// (solid black rectangle) rather than requiring literal 100% purity.
/// Returns `None` on any capture failure (never treated as "is blank" —
/// this is a diagnostic, not a control path, so a failure to observe must
/// never be confused with a bad observation).
/// Pure decision extracted out of the unsafe GDI capture below so it's
/// actually unit-testable (a synthetic buffer in, a verdict out) — the rest
/// of `capture_window_is_blank` is unsafe FFI plumbing with no meaningful
/// branches of its own to test. `buf` is a top-down 32bpp BGRA buffer
/// (GDI's own byte order), `width`/`height` in pixels. Downsamples to every
/// 8th pixel on each axis rather than reading every one — this runs on a
/// background thread a second or so after every window show, so "is this
/// window overwhelmingly one dark color" doesn't need full resolution.
/// `None` when there's nothing to sample (zero-size buffer). `Some(true)`
/// once at least 97% of sampled pixels are near-black — high enough that
/// the panel's own gold/ivory text and borders (a small minority of any
/// real frame) can't trip it, but low enough to catch the actual symptom
/// (solid black rectangle) rather than requiring literal 100% purity.
fn bgra_buffer_is_blank(buf: &[u8], width: usize, height: usize) -> Option<bool> {
    const STEP: usize = 8;
    const NEAR_BLACK: u8 = 12;
    let mut sampled = 0u32;
    let mut dark = 0u32;
    let mut y = 0;
    while y < height {
        let mut x = 0;
        while x < width {
            let i = (y * width + x) * 4;
            if i + 2 >= buf.len() {
                break;
            }
            // BGRA byte order for a 32bpp GDI DIB.
            let (b, g, r) = (buf[i], buf[i + 1], buf[i + 2]);
            sampled += 1;
            if b <= NEAR_BLACK && g <= NEAR_BLACK && r <= NEAR_BLACK {
                dark += 1;
            }
            x += STEP;
        }
        y += STEP;
    }
    if sampled == 0 {
        return None;
    }
    Some((dark as f64 / sampled as f64) >= 0.97)
}

#[cfg(target_os = "windows")]
fn capture_window_is_blank(hwnd: windows_sys::Win32::Foundation::HWND) -> Option<bool> {
    use windows_sys::Win32::Foundation::RECT;
    use windows_sys::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC,
        GetDIBits, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
        SRCCOPY,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::GetWindowRect;

    unsafe {
        let mut rect: RECT = std::mem::zeroed();
        if GetWindowRect(hwnd, &mut rect) == 0 {
            return None;
        }
        let width = rect.right - rect.left;
        let height = rect.bottom - rect.top;
        if width <= 0 || height <= 0 {
            return None;
        }

        let screen_dc = GetDC(std::ptr::null_mut());
        if screen_dc.is_null() {
            return None;
        }
        let mem_dc = CreateCompatibleDC(screen_dc);
        if mem_dc.is_null() {
            ReleaseDC(std::ptr::null_mut(), screen_dc);
            return None;
        }
        let bitmap = CreateCompatibleBitmap(screen_dc, width, height);
        if bitmap.is_null() {
            DeleteDC(mem_dc);
            ReleaseDC(std::ptr::null_mut(), screen_dc);
            return None;
        }
        let old_obj = SelectObject(mem_dc, bitmap as _);

        let blit_ok = BitBlt(
            mem_dc, 0, 0, width, height, screen_dc, rect.left, rect.top, SRCCOPY,
        );

        let mut result = None;
        if blit_ok != 0 {
            // Top-down 32bpp DIB (negative height) — GetDIBits then gives rows
            // in on-screen order, no manual flip needed for the sampling below.
            let mut info: BITMAPINFO = std::mem::zeroed();
            info.bmiHeader = BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                biHeight: -height,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB,
                biSizeImage: 0,
                biXPelsPerMeter: 0,
                biYPelsPerMeter: 0,
                biClrUsed: 0,
                biClrImportant: 0,
            };
            let mut buf = vec![0u8; (width as usize) * (height as usize) * 4];
            let lines = GetDIBits(
                mem_dc,
                bitmap,
                0,
                height as u32,
                buf.as_mut_ptr() as *mut _,
                &mut info,
                DIB_RGB_COLORS,
            );
            if lines > 0 {
                result = bgra_buffer_is_blank(&buf, width as usize, height as usize);
            }
        }

        SelectObject(mem_dc, old_obj);
        DeleteObject(bitmap as _);
        DeleteDC(mem_dc);
        ReleaseDC(std::ptr::null_mut(), screen_dc);
        result
    }
}

#[cfg(not(target_os = "windows"))]
fn capture_window_is_blank(_hwnd: ()) -> Option<bool> {
    None
}

/// Callable on demand from the frontend (or a future in-app diagnostics
/// button) — same capture `startup_nudge_burst` now also runs automatically
/// after every startup show. Returns `Ok(Some(true))`/`Ok(Some(false))` for
/// a real verdict, `Ok(None)` when the capture itself failed (never
/// conflated with "verified fine" — see `capture_window_is_blank`'s comment).
#[tauri::command]
fn check_render_health(window: tauri::WebviewWindow) -> Result<Option<bool>, String> {
    #[cfg(target_os = "windows")]
    {
        let hwnd = window.hwnd().map_err(|e| e.to_string())?;
        let raw: windows_sys::Win32::Foundation::HWND = hwnd.0;
        Ok(capture_window_is_blank(raw))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = window;
        Ok(None)
    }
}

/// Scheduled once, ~250ms after `startup_nudge_burst`'s last nudge
/// (1500ms, plus its own settle time) — the first time this bug gets an actual
/// pass/fail verdict instead of "the nudges fired" (proven insufficient
/// evidence: the 2026-07-11 8-trial run showed identical Rust-side nudge
/// logs on both visible and invisible runs). Diagnostic only for now,
/// deliberately not wired to any new corrective action: the project's own
/// trial log already burned one lesson on an untested escalation making
/// things worse (trial #12, an immediate nudge racing the show itself) —
/// this exists to gather real evidence for the next manual multi-launch
/// session before deciding what, if anything, should react to it.
#[cfg(target_os = "windows")]
fn schedule_startup_render_check(window: &tauri::WebviewWindow) {
    if !env_flag("OVERLAY_RENDER_CHECK", true) {
        return;
    }
    let handle = window.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(1750));
        let Ok(hwnd) = handle.hwnd() else {
            tracing::warn!(target: "overlay", "render-check: could not read hwnd, skipping");
            return;
        };
        let raw: windows_sys::Win32::Foundation::HWND = hwnd.0;
        match capture_window_is_blank(raw) {
            Some(true) => {
                tracing::warn!(target: "overlay", "render-check: window appears BLANK/BLACK (real OS capture)")
            }
            Some(false) => {
                tracing::info!(target: "overlay", "render-check: window renders fine (real OS capture)")
            }
            None => tracing::warn!(target: "overlay", "render-check: capture failed, no verdict"),
        }
    });
}

#[cfg(not(target_os = "windows"))]
fn schedule_startup_render_check(_window: &tauri::WebviewWindow) {}

/// Re-reveals the overlay after Escape/click-away/tray-hide — unlike
/// `show_window` (startup-only), this nudges the surface since the black-
/// frame race has also been observed right after un-hiding.
#[tauri::command]
fn reveal_window(window: tauri::WebviewWindow) -> Result<(), String> {
    tracing::debug!(target: "overlay", "reveal_window invoked by frontend");
    window.show().map_err(|e| e.to_string())?;
    restore_known_size(&window);
    Ok(())
}

/// Simulates Ctrl+C so the frontend can read a fresh clipboard value without
/// requiring the user to copy manually before pressing Ins (cahier des
/// charges §4). Only sends the keystroke — clipboard read stays in JS via
/// tauri-plugin-clipboard-manager, same as before.
#[tauri::command]
fn simulate_copy() -> Result<(), String> {
    use enigo::{Direction::Click, Enigo, Key, Keyboard, Settings};
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| {
        tracing::error!(target: "overlay", error = %e, "simulate_copy: Enigo::new failed");
        e.to_string()
    })?;
    // Key::Unicode('c') sends a KEYEVENTF_UNICODE WM_CHAR, not a VK_C
    // keydown — most apps' Ctrl+C accelerator (Notepad, the game) listens
    // for the virtual-key event, so a held-Ctrl + Unicode 'c' never
    // registers as the shortcut. Key::C is the actual VK_C keycode, but
    // enigo only defines that variant on Windows — macOS/Linux only have
    // Key::Unicode, which is fine there since Cmd/Ctrl-modified Unicode
    // keys do register as accelerators on those platforms.
    #[cfg(target_os = "windows")]
    let c_key = Key::C;
    #[cfg(not(target_os = "windows"))]
    let c_key = Key::Unicode('c');
    // macOS' copy accelerator is Cmd+C, not Ctrl+C.
    #[cfg(target_os = "macos")]
    let modifier = Key::Meta;
    #[cfg(not(target_os = "macos"))]
    let modifier = Key::Control;
    // Ctrl+E (EXTRA_HOTKEYS) fires this command while the user is still
    // physically holding Ctrl down. If we then send our own synthetic
    // Ctrl-release, Windows' global keyboard-state table (the same one
    // RegisterHotKey/GetAsyncKeyState read) marks Ctrl as up — even though
    // the physical key never moved — because SendInput-injected events and
    // real ones update the same state. The user's very next E press then
    // reads as a bare "E", not "Ctrl+E", so the hotkey silently stops
    // firing until they actually release and re-press the real Ctrl key
    // (found 2026-07-13: "works the first time, not the second"). Fix:
    // skip synthesizing the Ctrl press/release entirely when Ctrl is
    // already really down — just click C, which still sends a real
    // Ctrl+C since the physical modifier is genuinely held.
    #[cfg(target_os = "windows")]
    let ctrl_already_down = unsafe {
        use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_CONTROL};
        (GetAsyncKeyState(VK_CONTROL as i32) as u16 & 0x8000) != 0
    };
    #[cfg(not(target_os = "windows"))]
    let ctrl_already_down = false;
    let result = (|| -> Result<(), enigo::InputError> {
        if !ctrl_already_down {
            enigo.key(modifier, enigo::Direction::Press)?;
        }
        enigo.key(c_key, Click)?;
        if !ctrl_already_down {
            enigo.key(modifier, enigo::Direction::Release)?;
        }
        Ok(())
    })();
    match &result {
        Ok(()) => tracing::debug!(target: "overlay", "simulate_copy: Ctrl+C sent"),
        Err(e) => tracing::error!(target: "overlay", error = %e, "simulate_copy: key send failed"),
    }
    result.map_err(|e| e.to_string())
}

/// Settings panel's "Hide" button — sends the overlay to the tray instead of
/// exiting the process. The only way to actually quit is the tray icon's
/// right-click menu (see `run()`), so a stray click here can't kill the
/// overlay mid-session.
#[tauri::command]
fn hide_window(window: tauri::WebviewWindow) -> Result<(), String> {
    tracing::debug!(target: "overlay", "hide_window invoked by frontend");
    window.hide().map_err(|e| e.to_string())
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

/// Two rolling GitHub releases serve as updater feeds. `updater-beta` is
/// refreshed on every tag (stable or `-beta` suffixed); `updater` (stable)
/// only on a plain, non-suffixed tag — see release.yml's "Refresh rolling
/// updater feed(s)" step. Picking the endpoint per-call (rather than baking
/// one into tauri.conf.json's static `plugins.updater.endpoints`) is what
/// lets the Settings channel toggle take effect on the very next check, no
/// restart needed.
const STABLE_UPDATER_ENDPOINT: &str =
    "https://github.com/Captain-VII/poe2-waystone-analyzer-v3/releases/download/updater/latest.json";
const BETA_UPDATER_ENDPOINT: &str =
    "https://github.com/Captain-VII/poe2-waystone-analyzer-v3/releases/download/updater-beta/latest.json";

#[derive(serde::Serialize)]
struct UpdateInfo {
    version: String,
    notes: Option<String>,
}

/// Holds the `Update` handle from the last successful check so
/// `install_pending_update` can act on it without re-checking — mirrors the
/// JS-side `pending` variable this replaced, just backend-owned now that the
/// channel choice lives here.
struct PendingUpdate(Mutex<Option<tauri_plugin_updater::Update>>);

#[tauri::command]
async fn check_update_channel(
    app: tauri::AppHandle,
    state: tauri::State<'_, PendingUpdate>,
    beta: bool,
) -> Result<Option<UpdateInfo>, String> {
    use tauri_plugin_updater::UpdaterExt;
    let endpoint = if beta {
        BETA_UPDATER_ENDPOINT
    } else {
        STABLE_UPDATER_ENDPOINT
    }
    .parse()
    .map_err(|e: url::ParseError| e.to_string())?;
    let updater = app
        .updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())?;
    let update = updater.check().await.map_err(|e| e.to_string())?;
    let info = update.as_ref().map(|u| UpdateInfo {
        version: u.version.clone(),
        notes: u.body.clone(),
    });
    *state.0.lock().unwrap() = update;
    Ok(info)
}

/// Downloads and installs whatever `check_update_channel` last found,
/// emitting `overlay://update-progress` (0-100, or null while the total
/// size is still unknown) for the Settings row to render. Never
/// auto-triggered — only ever reachable from an explicit Settings click,
/// same contract as before this moved from the JS plugin call.
#[tauri::command]
async fn install_pending_update(
    app: tauri::AppHandle,
    state: tauri::State<'_, PendingUpdate>,
) -> Result<(), String> {
    let update = state
        .0
        .lock()
        .unwrap()
        .take()
        .ok_or_else(|| "no pending update — call check_update_channel first".to_string())?;
    let mut got: usize = 0;
    let progress_handle = app.clone();
    update
        .download_and_install(
            move |chunk_len, total_len| {
                got += chunk_len;
                let pct = total_len
                    .filter(|t| *t > 0)
                    .map(|t| ((got as f64 / t as f64) * 100.0).round() as u32);
                let _ = progress_handle.emit("overlay://update-progress", pct);
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
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

// VK_LBUTTON state, polled (not hooked) — same tradeoff as the existing
// cursor-position click-through loop: cheap, no system-wide keyboard/mouse
// hook to fight anti-cheat over, at the cost of ~50ms latency. Click-through
// already means clicks in the game pass straight to it; this just also
// notices that a real click happened out there so the overlay can get out
// of the way (§ cahier des charges: hide on click-away or Escape, reappear
// on Ins).
#[cfg(target_os = "windows")]
#[link(name = "user32")]
extern "system" {
    fn GetAsyncKeyState(vkey: i32) -> i16;
}

/// Bit 0 of GetAsyncKeyState is "was pressed since the *previous* call to
/// this function" — not just "is down right now". A real click's down+up
/// can both land inside one 50ms poll gap, so checking the instantaneous
/// high bit alone missed clicks in testing; the low bit is exactly the
/// edge-detection this polling loop needs, no `was-it-down-last-tick`
/// bookkeeping required on our side.
#[cfg(target_os = "windows")]
fn left_click_since_last_poll() -> bool {
    const VK_LBUTTON: i32 = 0x01;
    unsafe { (GetAsyncKeyState(VK_LBUTTON) as u16) & 0x0001 != 0 }
}

#[cfg(not(target_os = "windows"))]
fn left_click_since_last_poll() -> bool {
    false // dev-only platforms here never run the real click-through path anyway
}

/// Modifier layer per action, applied to one user-remappable base key
/// (KNOWN_ISSUES #7): base = analyze, Shift+base = toggle. The accelerators
/// are registered and handled entirely Rust-side: the JS-side `register()`
/// API of tauri-plugin-global-shortcut proved unreliable on Windows —
/// registration would succeed but the event channel to the webview
/// sometimes never delivered a single keypress until the app was restarted
/// (diagnosed 2026-07-06 from session logs: healthy launches showed
/// hundreds of `state=Pressed` deliveries, broken launches showed zero,
/// with identical successful registrations). Rust-side registration + a
/// standard `app.emit()` rides the same event system every invoke/report in
/// this app already uses, which has never misfired.
/// Escape is deliberately absent — it's a local keydown listener in
/// hotkeys.ts (a global Escape grab swallowed the key OS-wide).
const HOTKEY_ACTIONS: &[(&str, &str)] = &[("", "analyze"), ("Shift+", "toggle")];

/// Fixed, non-remappable extra accelerator, always registered alongside
/// whatever the user's base key derives (2026-07-13, user request) —
/// Ctrl+E specifically, so it never varies with `set_hotkey_base`. Safe as
/// a printable-key accelerator (unlike a `HOTKEY_ACTIONS`/base combination,
/// which `is_printable_key` blocks) because it's registered with the
/// Control modifier *required*: the OS never delivers it for a bare "e"
/// keystroke, so normal typing (including the game's own chat) is
/// untouched.
const EXTRA_HOTKEYS: &[(&str, &str)] = &[("Control+KeyE", "analyze")];

/// `HOTKEY_ACTIONS` derived from `base`, plus the fixed `EXTRA_HOTKEYS` —
/// the full set of accelerators that should be registered/matched at any
/// given time.
fn all_accels(base: &str) -> Vec<(String, &'static str)> {
    let mut accels = hotkey_accels(base);
    accels.extend(
        EXTRA_HOTKEYS
            .iter()
            .map(|(a, action)| (a.to_string(), *action)),
    );
    accels
}

const DEFAULT_HOTKEY_BASE: &str = "Insert";

/// Keys a global grab must never own: Escape (already a local listener, and
/// grabbing it OS-wide broke the key everywhere — see hotkeys.ts) and
/// editing keys. Printable keys (letters/digits/punctuation/numpad) are
/// rejected separately by `is_printable_key` — a global grab swallows the
/// key OS-wide, which would break typing everywhere, the game's chat
/// included (and Control+C is what `simulate_copy` *sends*: grabbing C
/// would make the overlay swallow its own copy keystroke).
const HOTKEY_BLOCKLIST: &[&str] = &[
    "Escape",
    "Enter",
    "NumpadEnter",
    "Space",
    "Tab",
    "Backspace",
];

/// W3C `KeyboardEvent.code` values that produce text — all rejected as
/// hotkey bases (see HOTKEY_BLOCKLIST's rationale). Anything left is
/// F-keys, navigation (Insert/Delete/Home/End/PageUp/PageDown), arrows,
/// and lock/system keys.
fn is_printable_key(base: &str) -> bool {
    if base.len() == 4 && base.starts_with("Key") {
        return true; // KeyA..KeyZ
    }
    if base.len() == 6 && base.starts_with("Digit") {
        return true; // Digit0..Digit9
    }
    if base.starts_with("Numpad") && base != "NumpadEnter" {
        return true; // Numpad0..9 and the printable operators
    }
    matches!(
        base,
        "Comma"
            | "Period"
            | "Slash"
            | "Semicolon"
            | "Quote"
            | "BracketLeft"
            | "BracketRight"
            | "Backslash"
            | "Backquote"
            | "Minus"
            | "Equal"
            | "IntlBackslash"
            | "IntlRo"
            | "IntlYen"
    )
}

/// Current base key — user-remappable via `set_hotkey_base`, persisted in
/// the app config dir (see `hotkey_file`) since registration happens at
/// startup, before the webview (and its localStorage) exists.
struct HotkeyBase(Mutex<String>);

/// The three (accelerator, action) pairs derived from a base key.
fn hotkey_accels(base: &str) -> Vec<(String, &'static str)> {
    HOTKEY_ACTIONS
        .iter()
        .map(|(prefix, action)| (format!("{prefix}{base}"), *action))
        .collect()
}

/// Rejects modifiers/blocklisted keys and anything the shortcut plugin can't
/// parse (the frontend sends raw `KeyboardEvent.code` values — "KeyA",
/// "F9", "Insert", "Numpad5" — which are exactly the W3C `Code` names the
/// plugin's parser accepts).
fn validate_hotkey_base(base: &str) -> Result<(), String> {
    if base.is_empty() || base.contains('+') || base.contains(char::is_whitespace) {
        return Err("invalid key".into());
    }
    if HOTKEY_BLOCKLIST
        .iter()
        .any(|b| b.eq_ignore_ascii_case(base))
    {
        return Err("reserved key (Escape, Enter, chat)".into());
    }
    if is_printable_key(base) {
        return Err("typing key — it would get swallowed everywhere, chat included".into());
    }
    for (accel, _) in hotkey_accels(base) {
        if accel.parse::<Shortcut>().is_err() {
            return Err("unsupported key".into());
        }
    }
    Ok(())
}

fn hotkey_file(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("hotkey.txt"))
}

fn persist_hotkey_base(app: &tauri::AppHandle, base: &str) {
    let Some(path) = hotkey_file(app) else { return };
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    if let Err(e) = fs::write(&path, base) {
        tracing::error!(target: "hotkey", error = %e, "persist failed");
    }
}

fn load_hotkey_base(app: &tauri::AppHandle) -> String {
    let stored = hotkey_file(app)
        .and_then(|p| fs::read_to_string(p).ok())
        .map(|s| s.trim().to_string());
    match stored {
        Some(base) if !base.is_empty() => {
            if validate_hotkey_base(&base).is_ok() {
                base
            } else {
                tracing::warn!(target: "hotkey", stored = ?base, fallback = DEFAULT_HOTKEY_BASE, "stored base invalid, using fallback");
                DEFAULT_HOTKEY_BASE.into()
            }
        }
        _ => DEFAULT_HOTKEY_BASE.into(),
    }
}

#[tauri::command]
fn get_hotkey_base(state: tauri::State<'_, HotkeyBase>) -> String {
    state.0.lock().unwrap().clone()
}

/// Remaps the base key: unregisters the old pair, registers the new one,
/// and rolls back to the old pair if any new registration fails (typically
/// a conflict with another app's global shortcut) so the overlay never ends
/// up with no working hotkeys. Persists on success. Errors are
/// user-displayable (shown in the Settings panel). `EXTRA_HOTKEYS` is
/// untouched — it's independent of the remappable base.
#[tauri::command]
fn set_hotkey_base(
    app: tauri::AppHandle,
    state: tauri::State<'_, HotkeyBase>,
    base: String,
) -> Result<String, String> {
    let base = base.trim().to_string();
    validate_hotkey_base(&base)?;
    let old = state.0.lock().unwrap().clone();
    if old == base {
        return Ok(base);
    }
    let gs = app.global_shortcut();
    for (accel, _) in hotkey_accels(&old) {
        let _ = gs.unregister(accel.as_str());
    }
    let mut registered: Vec<String> = Vec::new();
    for (accel, _) in hotkey_accels(&base) {
        match gs.register(accel.as_str()) {
            Ok(()) => registered.push(accel),
            Err(e) => {
                tracing::warn!(target: "hotkey", %base, %accel, error = %e, rollback_to = %old, "remap failed, rolling back");
                for done in &registered {
                    let _ = gs.unregister(done.as_str());
                }
                for (accel, _) in hotkey_accels(&old) {
                    let _ = gs.register(accel.as_str());
                }
                return Err("key already taken by another application".into());
            }
        }
    }
    *state.0.lock().unwrap() = base.clone();
    persist_hotkey_base(&app, &base);
    tracing::info!(target: "hotkey", from = %old, to = %base, "base remapped");
    Ok(base)
}

/// Registers `base`'s accelerators plus the fixed `EXTRA_HOTKEYS`, retrying
/// failures on a backoff (2s→32s) in a background thread — the common
/// conflict is transient (a previous overlay instance still shutting down
/// during a relaunch).
fn register_hotkeys(app: &tauri::AppHandle, base: &str) {
    const RETRY_DELAYS: [u64; 5] = [2, 4, 8, 16, 32];
    let mut pending: Vec<String> = Vec::new();
    for (accel, _) in all_accels(base) {
        match app.global_shortcut().register(accel.as_str()) {
            Ok(()) => tracing::info!(target: "hotkey", %accel, "registered"),
            Err(e) => {
                tracing::warn!(target: "hotkey", %accel, error = %e, "registration failed, will retry");
                pending.push(accel);
            }
        }
    }
    if pending.is_empty() {
        return;
    }
    let handle = app.clone();
    thread::spawn(move || {
        for delay in RETRY_DELAYS {
            thread::sleep(Duration::from_secs(delay));
            // A remap (set_hotkey_base) may have landed while waiting —
            // don't resurrect accelerators for a base the user replaced.
            // EXTRA_HOTKEYS is always live regardless of base.
            let current = handle.state::<HotkeyBase>().0.lock().unwrap().clone();
            let live: Vec<String> = all_accels(&current).into_iter().map(|(a, _)| a).collect();
            pending.retain(|a| live.contains(a));
            pending.retain(
                |accel| match handle.global_shortcut().register(accel.as_str()) {
                    Ok(()) => {
                        tracing::info!(target: "hotkey", %accel, "registered after retry");
                        false
                    }
                    Err(_) => true,
                },
            );
            if pending.is_empty() {
                return;
            }
        }
        for accel in &pending {
            tracing::error!(target: "hotkey", %accel, "permanently unavailable — bound by another app");
        }
    });
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
                    let base = app.state::<HotkeyBase>().0.lock().unwrap().clone();
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
            app.manage(LogGuard::new(Some(init_logging(app.handle()))));
            install_panic_hook();
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
                            .unwrap()
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
                        let pinned = *handle.state::<PinState>().0.lock().unwrap();
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
                        if let Some(guard) = app.state::<LogGuard>().lock().unwrap().take() {
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

/// Unit tests for the pure hotkey-validation logic — `is_printable_key`/
/// `hotkey_accels`/`validate_hotkey_base` are plain string logic with no
/// window/OS dependency (unlike most of this file, which needs a real
/// window/display and has historically only been verified by hand — see
/// KNOWN_ISSUES.md's Rust-side test-coverage gap). Deliberately NOT testing
/// `env_flag`/`has_cli_flag` here: both read real process-global state
/// (`env::var`/`env::args()`), which is unsafe to mutate across Rust's
/// parallel-by-default test threads without extra test-only dependencies —
/// not worth it for two three-line functions.
#[cfg(test)]
mod tests {
    use super::*;

    fn solid_bgra(width: usize, height: usize, b: u8, g: u8, r: u8) -> Vec<u8> {
        let mut buf = vec![0u8; width * height * 4];
        for px in buf.chunks_exact_mut(4) {
            px[0] = b;
            px[1] = g;
            px[2] = r;
            px[3] = 255;
        }
        buf
    }

    #[test]
    fn a_solid_black_buffer_is_reported_blank() {
        let buf = solid_bgra(64, 64, 0, 0, 0);
        assert_eq!(bgra_buffer_is_blank(&buf, 64, 64), Some(true));
    }

    #[test]
    fn a_solid_bright_buffer_is_not_blank() {
        // The panel's own gold-on-dark palette is nowhere near uniform black —
        // a solid mid-tone stands in for "the frame clearly isn't blank".
        let buf = solid_bgra(64, 64, 74, 184, 240);
        assert_eq!(bgra_buffer_is_blank(&buf, 64, 64), Some(false));
    }

    #[test]
    fn a_mostly_black_frame_with_real_ui_content_is_not_blank() {
        // Simulates a real rendered panel: overwhelmingly near-black
        // background with a *minority* of bright pixels (text/borders) —
        // must NOT trip the blank detector, or every real frame would
        // false-positive as broken.
        let mut buf = solid_bgra(64, 64, 5, 5, 5);
        // Paint roughly 10% of the sampled grid points bright.
        for y in (0..64).step_by(8) {
            for x in (0..64).step_by(8) {
                if (x / 8 + y / 8) % 3 == 0 {
                    let i = (y * 64 + x) * 4;
                    buf[i] = 240;
                    buf[i + 1] = 200;
                    buf[i + 2] = 74;
                }
            }
        }
        assert_eq!(bgra_buffer_is_blank(&buf, 64, 64), Some(false));
    }

    #[test]
    fn an_empty_buffer_reports_no_verdict_rather_than_a_wrong_one() {
        assert_eq!(bgra_buffer_is_blank(&[], 0, 0), None);
    }

    #[test]
    fn printable_keys_are_rejected_letters_digits_numpad() {
        assert!(is_printable_key("KeyA"));
        assert!(is_printable_key("KeyZ"));
        assert!(is_printable_key("Digit0"));
        assert!(is_printable_key("Digit9"));
        assert!(is_printable_key("Numpad5"));
        assert!(is_printable_key("Comma"));
        assert!(is_printable_key("Semicolon"));
    }

    #[test]
    fn numpad_enter_is_the_one_numpad_exception() {
        // NumpadEnter is an editing key (blocklisted separately), not a
        // printable one — see is_printable_key's doc comment.
        assert!(!is_printable_key("NumpadEnter"));
    }

    #[test]
    fn navigation_and_function_keys_are_not_printable() {
        assert!(!is_printable_key("Insert"));
        assert!(!is_printable_key("F9"));
        assert!(!is_printable_key("Delete"));
        assert!(!is_printable_key("Home"));
        assert!(!is_printable_key("ArrowUp"));
        assert!(!is_printable_key("Escape"));
    }

    #[test]
    fn hotkey_accels_derives_the_two_action_layers() {
        let accels = hotkey_accels("Insert");
        assert_eq!(
            accels,
            vec![
                ("Insert".to_string(), "analyze"),
                ("Shift+Insert".to_string(), "toggle"),
            ]
        );
    }

    #[test]
    fn all_accels_appends_the_fixed_extra_hotkeys() {
        let accels = all_accels("Insert");
        assert_eq!(
            accels,
            vec![
                ("Insert".to_string(), "analyze"),
                ("Shift+Insert".to_string(), "toggle"),
                ("Control+KeyE".to_string(), "analyze"),
            ]
        );
        // Independent of base — a remap doesn't change or drop it.
        assert!(all_accels("F9").contains(&("Control+KeyE".to_string(), "analyze")));
    }

    #[test]
    fn validate_hotkey_base_accepts_the_default_and_a_function_key() {
        assert!(validate_hotkey_base(DEFAULT_HOTKEY_BASE).is_ok());
        assert!(validate_hotkey_base("F9").is_ok());
    }

    #[test]
    fn validate_hotkey_base_rejects_empty_and_combos() {
        assert!(validate_hotkey_base("").is_err());
        assert!(validate_hotkey_base("Shift+Insert").is_err());
        assert!(validate_hotkey_base("Control C").is_err()); // whitespace
    }

    #[test]
    fn validate_hotkey_base_rejects_blocklisted_keys() {
        assert!(validate_hotkey_base("Escape").is_err());
        assert!(validate_hotkey_base("Enter").is_err());
        assert!(validate_hotkey_base("NumpadEnter").is_err());
        assert!(validate_hotkey_base("Space").is_err());
        assert!(validate_hotkey_base("Tab").is_err());
        assert!(validate_hotkey_base("Backspace").is_err());
    }

    #[test]
    fn validate_hotkey_base_rejects_printable_keys() {
        // The actual reported bug this guards against (KNOWN_ISSUES/git log:
        // "Reject printable keys as hotkey bases") — a global grab on a
        // letter/digit would swallow it OS-wide, breaking typing everywhere
        // including the game's own chat.
        assert!(validate_hotkey_base("KeyA").is_err());
        assert!(validate_hotkey_base("Digit5").is_err());
        assert!(validate_hotkey_base("Comma").is_err());
    }

    #[test]
    fn validate_hotkey_base_is_case_insensitive_on_the_blocklist() {
        assert!(validate_hotkey_base("escape").is_err());
        assert!(validate_hotkey_base("ESCAPE").is_err());
    }
}
