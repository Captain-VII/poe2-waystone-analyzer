//! Global hotkeys: one remappable base key, its action layers, validation and persistence.

use super::*;

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
pub(crate) const HOTKEY_ACTIONS: &[(&str, &str)] = &[("", "analyze"), ("Shift+", "toggle")];

/// Fixed, non-remappable extra accelerator, always registered alongside
/// whatever the user's base key derives (2026-07-13, user request) —
/// Ctrl+E specifically, so it never varies with `set_hotkey_base`. Safe as
/// a printable-key accelerator (unlike a `HOTKEY_ACTIONS`/base combination,
/// which `is_printable_key` blocks) because it's registered with the
/// Control modifier *required*: the OS never delivers it for a bare "e"
/// keystroke, so normal typing (including the game's own chat) is
/// untouched.
pub(crate) const EXTRA_HOTKEYS: &[(&str, &str)] = &[("Control+KeyE", "analyze")];

/// `HOTKEY_ACTIONS` derived from `base`, plus the fixed `EXTRA_HOTKEYS` —
/// the full set of accelerators that should be registered/matched at any
/// given time.
pub(crate) fn all_accels(base: &str) -> Vec<(String, &'static str)> {
    let mut accels = hotkey_accels(base);
    accels.extend(
        EXTRA_HOTKEYS
            .iter()
            .map(|(a, action)| (a.to_string(), *action)),
    );
    accels
}

pub(crate) const DEFAULT_HOTKEY_BASE: &str = "Insert";

/// Keys a global grab must never own: Escape (already a local listener, and
/// grabbing it OS-wide broke the key everywhere — see hotkeys.ts) and
/// editing keys. Printable keys (letters/digits/punctuation/numpad) are
/// rejected separately by `is_printable_key` — a global grab swallows the
/// key OS-wide, which would break typing everywhere, the game's chat
/// included (and Control+C is what `simulate_copy` *sends*: grabbing C
/// would make the overlay swallow its own copy keystroke).
pub(crate) const HOTKEY_BLOCKLIST: &[&str] = &[
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
pub(crate) fn is_printable_key(base: &str) -> bool {
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
pub(crate) struct HotkeyBase(pub(crate) Mutex<String>);

/// The three (accelerator, action) pairs derived from a base key.
pub(crate) fn hotkey_accels(base: &str) -> Vec<(String, &'static str)> {
    HOTKEY_ACTIONS
        .iter()
        .map(|(prefix, action)| (format!("{prefix}{base}"), *action))
        .collect()
}

/// Rejects modifiers/blocklisted keys and anything the shortcut plugin can't
/// parse (the frontend sends raw `KeyboardEvent.code` values — "KeyA",
/// "F9", "Insert", "Numpad5" — which are exactly the W3C `Code` names the
/// plugin's parser accepts).
pub(crate) fn validate_hotkey_base(base: &str) -> Result<(), String> {
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

pub(crate) fn hotkey_file(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("hotkey.txt"))
}

pub(crate) fn persist_hotkey_base(app: &tauri::AppHandle, base: &str) {
    let Some(path) = hotkey_file(app) else { return };
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    if let Err(e) = fs::write(&path, base) {
        tracing::error!(target: "hotkey", error = %e, "persist failed");
    }
}

pub(crate) fn load_hotkey_base(app: &tauri::AppHandle) -> String {
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
pub(crate) fn get_hotkey_base(state: tauri::State<'_, HotkeyBase>) -> String {
    state
        .0
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .clone()
}

/// Remaps the base key: unregisters the old pair, registers the new one,
/// and rolls back to the old pair if any new registration fails (typically
/// a conflict with another app's global shortcut) so the overlay never ends
/// up with no working hotkeys. Persists on success. Errors are
/// user-displayable (shown in the Settings panel). `EXTRA_HOTKEYS` is
/// untouched — it's independent of the remappable base.
#[tauri::command]
pub(crate) fn set_hotkey_base(
    app: tauri::AppHandle,
    state: tauri::State<'_, HotkeyBase>,
    base: String,
) -> Result<String, String> {
    let base = base.trim().to_string();
    validate_hotkey_base(&base)?;
    let old = state
        .0
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .clone();
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
    *state.0.lock().unwrap_or_else(PoisonError::into_inner) = base.clone();
    persist_hotkey_base(&app, &base);
    tracing::info!(target: "hotkey", from = %old, to = %base, "base remapped");
    Ok(base)
}

/// Registers `base`'s accelerators plus the fixed `EXTRA_HOTKEYS`, retrying
/// failures on a backoff (2s→32s) in a background thread — the common
/// conflict is transient (a previous overlay instance still shutting down
/// during a relaunch).
pub(crate) fn register_hotkeys(app: &tauri::AppHandle, base: &str) {
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
            let current = handle
                .state::<HotkeyBase>()
                .0
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .clone();
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
