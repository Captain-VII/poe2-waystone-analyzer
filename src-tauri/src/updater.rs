//! Beta/stable update channels over the rolling GitHub release feeds.

use super::*;

/// Two rolling GitHub releases serve as updater feeds. `updater-beta` is
/// refreshed on every tag (stable or `-beta` suffixed); `updater` (stable)
/// only on a plain, non-suffixed tag — see release.yml's "Refresh rolling
/// updater feed(s)" step. Picking the endpoint per-call (rather than baking
/// one into tauri.conf.json's static `plugins.updater.endpoints`) is what
/// lets the Settings channel toggle take effect on the very next check, no
/// restart needed.
pub(crate) const STABLE_UPDATER_ENDPOINT: &str =
    "https://github.com/Captain-VII/poe2-waystone-analyzer/releases/download/updater/latest.json";
pub(crate) const BETA_UPDATER_ENDPOINT: &str =
    "https://github.com/Captain-VII/poe2-waystone-analyzer/releases/download/updater-beta/latest.json";

#[derive(serde::Serialize)]
pub(crate) struct UpdateInfo {
    version: String,
    notes: Option<String>,
}

/// Holds the `Update` handle from the last successful check so
/// `install_pending_update` can act on it without re-checking — mirrors the
/// JS-side `pending` variable this replaced, just backend-owned now that the
/// channel choice lives here.
pub(crate) struct PendingUpdate(pub(crate) Mutex<Option<tauri_plugin_updater::Update>>);

#[tauri::command]
pub(crate) async fn check_update_channel(
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
        // Default comparator only offers a *greater* version — switching
        // the Settings toggle to Stable while running a beta needs the
        // opposite direction too (offer downgrading back to the latest
        // stable release), so any version difference counts, not just an
        // increase.
        .version_comparator(|current, release| release.version != current)
        .build()
        .map_err(|e| e.to_string())?;
    let update = updater.check().await.map_err(|e| e.to_string())?;
    let info = update.as_ref().map(|u| UpdateInfo {
        version: u.version.clone(),
        notes: u.body.clone(),
    });
    *state.0.lock().unwrap_or_else(PoisonError::into_inner) = update;
    Ok(info)
}

/// Downloads and installs whatever `check_update_channel` last found,
/// emitting `overlay://update-progress` (0-100, or null while the total
/// size is still unknown) for the Settings row to render. Never
/// auto-triggered — only ever reachable from an explicit Settings click,
/// same contract as before this moved from the JS plugin call.
#[tauri::command]
pub(crate) async fn install_pending_update(
    app: tauri::AppHandle,
    state: tauri::State<'_, PendingUpdate>,
) -> Result<(), String> {
    let update = state
        .0
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
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
