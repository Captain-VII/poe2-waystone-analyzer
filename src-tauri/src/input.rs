//! Synthetic Ctrl+C for Ins/Ctrl+E, and click-away detection for the click-through overlay.

/// Simulates Ctrl+C so the frontend can read a fresh clipboard value without
/// requiring the user to copy manually before pressing Ins (cahier des
/// charges §4). Only sends the keystroke — clipboard read stays in JS via
/// tauri-plugin-clipboard-manager, same as before.
#[tauri::command]
pub(crate) fn simulate_copy() -> Result<(), String> {
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
pub(crate) fn left_click_since_last_poll() -> bool {
    const VK_LBUTTON: i32 = 0x01;
    unsafe { (GetAsyncKeyState(VK_LBUTTON) as u16) & 0x0001 != 0 }
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn left_click_since_last_poll() -> bool {
    false // dev-only platforms here never run the real click-through path anyway
}
