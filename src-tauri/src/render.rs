//! Overlay window show/hide, and the black-frame defenses: recompose nudges and the real
//! OS-capture render check with automatic recovery (KNOWN_ISSUES #1).

use super::*;

/// Defensive recompose nudge against the intermittent WebView2/
/// DirectComposition black-frame race (window reports visible/correctly
/// positioned but paints nothing) — observed on the click-through hover
/// transition, on tray un-hide, and on the Escape/click-away/Ins show-hide
/// cycle added below. A 1px resize-and-back forces WM_SIZE, which forces
/// WebView2 to recompose a fresh frame instead of potentially surfacing a
/// stale/black one.
pub(crate) fn recompose_nudge(window: &tauri::WebviewWindow) {
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
pub(crate) fn restore_known_size(window: &tauri::WebviewWindow) {
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
pub(crate) fn show_window(window: tauri::WebviewWindow) -> Result<(), String> {
    tracing::debug!(target: "overlay", "show_window invoked by frontend (post-paint signal)");
    window.show().map_err(|e| e.to_string())?;
    startup_nudge_burst(&window);
    // ~250ms after the burst's last nudge (300+500+700ms), plus settle time.
    schedule_render_check(&window, 1750, "startup");
    Ok(())
}

/// Bisectable via OVERLAY_STARTUP_NUDGE_BURST (default on) — see
/// `show_window`'s doc comment for why this exists and why it's delayed
/// rather than immediate. Three nudges at increasing offsets (not just one)
/// since the compositor race's exact timing is unknown; logged the same way
/// as every other nudge in this file so the trial-log methodology
/// (docs/implementation-plan.md M1) can track whether this one helps.
pub(crate) fn startup_nudge_burst(window: &tauri::WebviewWindow) {
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
pub(crate) fn bgra_buffer_is_blank(buf: &[u8], width: usize, height: usize) -> Option<bool> {
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
pub(crate) fn capture_window_is_blank(hwnd: windows_sys::Win32::Foundation::HWND) -> Option<bool> {
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
pub(crate) fn capture_window_is_blank(_hwnd: ()) -> Option<bool> {
    None
}

/// Callable on demand from the frontend (or a future in-app diagnostics
/// button) — same capture `startup_nudge_burst` now also runs automatically
/// after every startup show. Returns `Ok(Some(true))`/`Ok(Some(false))` for
/// a real verdict, `Ok(None)` when the capture itself failed (never
/// conflated with "verified fine" — see `capture_window_is_blank`'s comment).
#[tauri::command]
pub(crate) fn check_render_health(window: tauri::WebviewWindow) -> Result<Option<bool>, String> {
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

/// How many hide/show recoveries `run_render_check` attempts on a
/// confirmed black frame before giving up and leaving it to the player.
pub(crate) const MAX_RENDER_RECOVERIES: u32 = 2;

#[derive(Debug, PartialEq)]
pub(crate) enum RenderOutcome {
    /// Window was hidden by the time we looked: nothing to verify.
    Skipped,
    /// The capture itself failed: no verdict, never treated as blank.
    NoVerdict,
    /// Rendered fine, after this many recoveries (0 = fine from the start).
    Fine(u32),
    /// Still black after `MAX_RENDER_RECOVERIES` hide/show cycles.
    GaveUp,
}

/// Decision loop for the black-frame check (KNOWN_ISSUES #1), kept free of
/// GDI/window calls so it's unit-testable. A blank verdict must be
/// confirmed by a second capture before anything reacts (a frame caught
/// mid-fade or mid-resize is not the bug), and every capture first checks
/// visibility: capturing a hidden window reads whatever is behind it (often
/// a dark game scene), and "recovering" it would re-show an overlay the
/// player just dismissed. Recovery is a hide/show cycle, the same action the
/// reveal path already does; it only ever runs on a window already confirmed
/// black, so it can't make a good frame worse.
pub(crate) fn run_render_check(
    mut capture: impl FnMut() -> Option<bool>,
    is_visible: impl Fn() -> bool,
    mut recover: impl FnMut(),
    sleep_ms: impl Fn(u64),
    recovery_enabled: bool,
) -> RenderOutcome {
    const CONFIRM_MS: u64 = 250;
    let mut attempts = 0;
    loop {
        for confirming in [false, true] {
            if confirming {
                sleep_ms(CONFIRM_MS);
            }
            if !is_visible() {
                return RenderOutcome::Skipped;
            }
            match capture() {
                None => return RenderOutcome::NoVerdict,
                Some(false) => return RenderOutcome::Fine(attempts),
                Some(true) => {}
            }
        }
        if !recovery_enabled || attempts >= MAX_RENDER_RECOVERIES {
            return RenderOutcome::GaveUp;
        }
        attempts += 1;
        recover();
    }
}

/// Runs `run_render_check` against the real window `delay_ms` after a show
/// (startup or Ins reveal). Bisectable via OVERLAY_RENDER_CHECK (the check
/// itself) and OVERLAY_RENDER_RECOVERY (the hide/show reaction), both on by
/// default.
#[cfg(target_os = "windows")]
pub(crate) fn schedule_render_check(
    window: &tauri::WebviewWindow,
    delay_ms: u64,
    context: &'static str,
) {
    if !env_flag("OVERLAY_RENDER_CHECK", true) {
        return;
    }
    let handle = window.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(delay_ms));
        let outcome = run_render_check(
            || capture_window_is_blank(handle.hwnd().ok()?.0),
            || handle.is_visible().unwrap_or(false),
            || {
                tracing::warn!(target: "overlay", context, "render-check: confirmed BLANK/BLACK, hide/show recovery");
                let _ = handle.hide();
                thread::sleep(Duration::from_millis(120));
                let _ = handle.show();
                restore_known_size(&handle);
                thread::sleep(Duration::from_millis(600));
            },
            |ms| thread::sleep(Duration::from_millis(ms)),
            env_flag("OVERLAY_RENDER_RECOVERY", true),
        );
        match outcome {
            RenderOutcome::Fine(0) => {
                tracing::info!(target: "overlay", context, "render-check: window renders fine (real OS capture)")
            }
            RenderOutcome::Fine(n) => {
                tracing::warn!(target: "overlay", context, recoveries = n, "render-check: RECOVERED from black frame")
            }
            RenderOutcome::GaveUp => {
                tracing::error!(target: "overlay", context, "render-check: still BLANK/BLACK after recovery attempts")
            }
            RenderOutcome::NoVerdict => {
                tracing::warn!(target: "overlay", context, "render-check: capture failed, no verdict")
            }
            RenderOutcome::Skipped => {
                tracing::debug!(target: "overlay", context, "render-check: window hidden, skipped")
            }
        }
    });
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn schedule_render_check(
    _window: &tauri::WebviewWindow,
    _delay_ms: u64,
    _context: &'static str,
) {
}

/// Re-reveals the overlay after Escape/click-away/tray-hide — unlike
/// `show_window` (startup-only), this nudges the surface since the black-
/// frame race has also been observed right after un-hiding.
#[tauri::command]
pub(crate) fn reveal_window(window: tauri::WebviewWindow) -> Result<(), String> {
    tracing::debug!(target: "overlay", "reveal_window invoked by frontend");
    window.show().map_err(|e| e.to_string())?;
    restore_known_size(&window);
    // The black frame has also been seen right after un-hiding; 900ms lets
    // the panel's own reveal transition finish before judging the frame.
    schedule_render_check(&window, 900, "reveal");
    Ok(())
}

/// Settings panel's "Hide" button — sends the overlay to the tray instead of
/// exiting the process. The only way to actually quit is the tray icon's
/// right-click menu (see `run()`), so a stray click here can't kill the
/// overlay mid-session.
#[tauri::command]
pub(crate) fn hide_window(window: tauri::WebviewWindow) -> Result<(), String> {
    tracing::debug!(target: "overlay", "hide_window invoked by frontend");
    window.hide().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid_bgra(width: usize, height: usize, b: u8, g: u8, r: u8) -> Vec<u8> {
        let mut buf = vec![0u8; width * height * 4];
        for px in buf.as_chunks_mut::<4>().0 {
            *px = [b, g, r, 255];
        }
        buf
    }

    /// Drives `run_render_check` with a scripted sequence of capture
    /// verdicts; returns the outcome and how many recoveries ran.
    fn render_check_with(
        verdicts: &[Option<bool>],
        visible: bool,
        enabled: bool,
    ) -> (RenderOutcome, u32) {
        let mut seq = verdicts.iter().copied();
        let mut recoveries = 0;
        let outcome = run_render_check(
            || seq.next().expect("capture called more often than scripted"),
            || visible,
            || recoveries += 1,
            |_| {},
            enabled,
        );
        (outcome, recoveries)
    }

    #[test]
    fn render_check_fine_frame_needs_no_recovery() {
        assert_eq!(
            render_check_with(&[Some(false)], true, true),
            (RenderOutcome::Fine(0), 0)
        );
    }

    #[test]
    fn render_check_transient_black_is_not_acted_on() {
        assert_eq!(
            render_check_with(&[Some(true), Some(false)], true, true),
            (RenderOutcome::Fine(0), 0)
        );
    }

    #[test]
    fn render_check_confirmed_black_recovers() {
        let verdicts = [Some(true), Some(true), Some(false)];
        assert_eq!(
            render_check_with(&verdicts, true, true),
            (RenderOutcome::Fine(1), 1)
        );
    }

    #[test]
    fn render_check_gives_up_after_max_recoveries() {
        let verdicts = [Some(true); 2 * (MAX_RENDER_RECOVERIES as usize + 1)];
        assert_eq!(
            render_check_with(&verdicts, true, true),
            (RenderOutcome::GaveUp, MAX_RENDER_RECOVERIES)
        );
    }

    #[test]
    fn render_check_never_touches_a_hidden_window() {
        assert_eq!(
            render_check_with(&[], false, true),
            (RenderOutcome::Skipped, 0)
        );
    }

    #[test]
    fn render_check_capture_failure_is_not_blank() {
        assert_eq!(
            render_check_with(&[Some(true), None], true, true),
            (RenderOutcome::NoVerdict, 0)
        );
    }

    #[test]
    fn render_check_recovery_can_be_disabled() {
        assert_eq!(
            render_check_with(&[Some(true), Some(true)], true, false),
            (RenderOutcome::GaveUp, 0)
        );
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
}
