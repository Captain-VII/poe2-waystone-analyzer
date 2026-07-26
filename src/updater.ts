/** Auto-update against one of two rolling GitHub releases (stable/beta),
 *  chosen per-call by the Rust `check_update_channel` command rather than
 *  the plugin's static tauri.conf.json endpoint — see lib.rs's doc comment
 *  on STABLE/BETA_UPDATER_ENDPOINT for why. Check is silent (startup + on
 *  demand from Settings); install only ever runs on an explicit user click
 *  — never automatically under a running game. No-op in plain-browser dev. */

export interface UpdateInfo {
  version: string;
  notes?: string;
}

/** Never throws. null = no update available / not Tauri / check failed
 *  (offline, endpoint missing…) — callers can't tell those apart and
 *  shouldn't: the overlay must behave identically in all three cases. */
export async function checkForUpdate(beta: boolean): Promise<UpdateInfo | null> {
  if (!("__TAURI_INTERNALS__" in window)) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const info = await invoke<{ version: string; notes?: string } | null>("check_update_channel", { beta });
    return info ?? null;
  } catch {
    return null;
  }
}

/** Rejects on failure so the Settings row can show an error and reset.
 *  onProgress receives 0-100, or null when the total size is unknown. */
export async function installUpdate(
  onProgress?: (pct: number | null) => void,
): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  const { listen } = await import("@tauri-apps/api/event");
  const unlisten = onProgress
    ? await listen<number | null>("overlay://update-progress", (ev) => onProgress(ev.payload))
    : null;
  try {
    await invoke("install_pending_update");
  } finally {
    unlisten?.();
  }
  // On Windows the passive NSIS updater exits and relaunches the app by
  // itself; relaunch() is the documented tail and a harmless fallback if
  // that ever changes.
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}
