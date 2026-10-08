//! Structured logging to a daily file, and the panic hook that routes panics into it.

use super::*;

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
pub(crate) fn init_logging(app: &tauri::AppHandle) -> tracing_appender::non_blocking::WorkerGuard {
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
pub(crate) fn install_panic_hook() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        tracing::error!("panic: {info}");
        default_hook(info);
    }));
}
