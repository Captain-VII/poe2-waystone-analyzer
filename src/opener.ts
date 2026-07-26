/** Opens a URL in the user's default browser via the Rust `opener` plugin.
 *  Plain-browser dev (no Tauri) falls back to `window.open` so the link
 *  still works while iterating in the Browser pane. */
export function openExternal(url: string): void {
  if (!("__TAURI_INTERNALS__" in window)) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  void import("@tauri-apps/plugin-opener").then(({ openUrl }) => openUrl(url)).catch(() => {});
}
