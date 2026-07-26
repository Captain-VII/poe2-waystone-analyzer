/** Top-right anchoring per docs/overlay-ui-spec.md §2.
 *  The window carries PANEL_BLEED logical px of transparent margin around the
 *  panel (ornament/glow overflow), so the safe-zone pad applies to the panel
 *  edge, not the window edge. */

import type { EffectiveMode } from "./settings";
import { saveCustomPosition } from "./settings";
import { reportDiagnosticError } from "./diagnostics";

const PANEL_BLEED = 12;

/** §2 footprint. Full adds 16px clearance for its up-left micro-shift. */
const FULL_FOOTPRINT = { w: 580 + 16, h: 332 + 16 };

export interface ResolvedMonitor {
  monitor: Awaited<ReturnType<typeof import("@tauri-apps/api/window").currentMonitor>>;
  source: "current" | "primary" | "available" | "none";
}

/** Resolves the monitor to anchor/size against, falling back when
 *  `currentMonitor()` comes back null — which is exactly what happens right
 *  after the display the overlay was on gets disconnected, before the OS
 *  has a chance to relocate the window: the window's stale position no
 *  longer overlaps any connected monitor. Without a fallback here,
 *  `placeTopRight()` used to silently no-op in that case, leaving the
 *  overlay stuck wherever it was — potentially off-screen for good
 *  (KNOWN_ISSUES.md #6's disconnected-screen case). Falls through
 *  current -> primary -> first available, so there's always a real monitor
 *  to re-anchor onto as long as at least one is connected. `source` is
 *  reported back so callers can log the degraded cases.
 *
 *  Exported so a caller driving both `computeEffectiveMode()` and
 *  `placeTopRight()` for the same event (a display change, or startup) can
 *  resolve once and pass the result into both, instead of each of them
 *  independently paying up to 3 Tauri IPC round-trips. */
export async function resolveMonitor(): Promise<ResolvedMonitor> {
  if (!("__TAURI_INTERNALS__" in window)) return { monitor: null, source: "none" };
  const { currentMonitor, primaryMonitor, availableMonitors } = await import("@tauri-apps/api/window");
  const current = await currentMonitor();
  if (current) return { monitor: current, source: "current" };
  const primary = await primaryMonitor();
  if (primary) return { monitor: primary, source: "primary" };
  const [first] = await availableMonitors();
  if (first) return { monitor: first, source: "available" };
  // Genuinely no monitor detected — degrade silently to the plain-browser
  // "full" default rather than throwing; there's nothing to log to in that
  // state either (invoke would just fail).
  return { monitor: null, source: "none" };
}

/** Reports a degraded monitor-resolution outcome to the exportable log file
 *  (Settings -> App -> Export Logs) — the currently-anchored display went
 *  away and we fell back to primary/first-available, exactly the
 *  disconnected-screen scenario KNOWN_ISSUES.md #6 flags as unverified on
 *  real hardware. `source: "none"` (no monitor at all) can't reach an
 *  invoke that would need one, so it's not logged here. */
async function logMonitorFallback(source: "primary" | "available"): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("log_frontend_report", {
    report: JSON.stringify({ tag: "monitor-fallback", source }),
  }).catch((e) => reportDiagnosticError(`logMonitorFallback failed: ${e}`));
}

/** §2 fallback: Full fits (with micro-shift)? → Full. Else → Mini — the
 *  emergency fallback for screens too small for Full (Compact mode, the
 *  former middle rung, was removed). Accepts an already-`resolveMonitor()`d
 *  result so a caller also calling `placeTopRight()` for the same event
 *  doesn't pay for a second resolution — see `resolveMonitor()`'s doc
 *  comment. */
export async function computeEffectiveMode(resolved?: ResolvedMonitor): Promise<EffectiveMode> {
  if (!("__TAURI_INTERNALS__" in window)) return "full"; // plain-browser dev
  const { monitor: mon, source } = resolved ?? (await resolveMonitor());
  if (!mon) return "full";
  if (source === "primary" || source === "available") void logMonitorFallback(source);

  const scale = mon.scaleFactor;
  const monW = mon.size.width / scale;
  const monH = mon.size.height / scale;
  const pad = monW < 1600 || monH < 900 ? 14 : 20;
  const availW = monW - pad * 2;
  const availH = monH - pad * 2;
  const fits = availW >= FULL_FOOTPRINT.w && availH >= FULL_FOOTPRINT.h;

  return fits ? "full" : "mini";
}

// Set around our own setPosition() calls so the resulting onMoved() firing
// (placeTopRight moving the window itself) isn't mistaken for an external
// display change and doesn't re-trigger the display watch on itself.
let repositioning = false;

/** Accepts an already-`resolveMonitor()`d result so a caller also calling
 *  `computeEffectiveMode()` for the same event doesn't pay for a second
 *  resolution — see `resolveMonitor()`'s doc comment. */
export async function placeTopRight(resolved?: ResolvedMonitor): Promise<void> {
  if (!("__TAURI_INTERNALS__" in window)) return; // plain-browser vite dev
  const { getCurrentWindow, LogicalPosition } = await import("@tauri-apps/api/window");
  const win = getCurrentWindow();
  const { monitor: mon, source } = resolved ?? (await resolveMonitor());
  if (!mon) return;
  if (source === "primary" || source === "available") void logMonitorFallback(source);

  const scale = mon.scaleFactor;
  const monX = mon.position.x / scale;
  const monY = mon.position.y / scale;
  const monW = mon.size.width / scale;
  const monH = mon.size.height / scale;
  const pad = monW < 1600 || monH < 900 ? 14 : 20;

  const size = await win.outerSize();
  const winW = size.width / scale;
  const winH = size.height / scale;

  let x = Math.round(monX + monW - winW - (pad - PANEL_BLEED));
  let y = Math.round(monY + (pad - PANEL_BLEED));

  // §2 clamp: no edge may ever leave the screen, whatever the pad math above
  // produced (e.g. a monitor smaller than the window itself).
  x = Math.min(Math.max(x, monX), monX + monW - winW);
  y = Math.min(Math.max(y, monY), monY + monH - winH);

  repositioning = true;
  try {
    await win.setPosition(new LogicalPosition(x, y));
  } finally {
    // Give the resulting onMoved() event a tick to arrive before re-arming.
    setTimeout(() => (repositioning = false), 250);
  }
}

// Resolved once (prepareWindowDrag, called from main.ts's init()) so the
// header's mousedown handler can call startDragging() synchronously — no
// `await import()` in between, which some platforms need for the OS-level
// drag gesture to actually attach to the originating mousedown.
let dragWindow: ReturnType<typeof import("@tauri-apps/api/window").getCurrentWindow> | null = null;

export async function prepareWindowDrag(): Promise<void> {
  if (!("__TAURI_INTERNALS__" in window)) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  dragWindow = getCurrentWindow();
}

/** Drag-to-reposition: called synchronously from the header's mousedown
 *  handler (RelicPanel.ts) — see the `dragWindow` comment above for why
 *  this stays a plain sync call instead of importing on demand. No-op if
 *  `prepareWindowDrag` hasn't resolved yet (startup race) or in
 *  plain-browser dev. */
export function startWindowDrag(): void {
  void dragWindow?.startDragging();
}

/** Restores a previously-dragged position instead of the default top-right
 *  anchor — called at startup when `loadCustomPosition()` has a value.
 *  Falls back to `placeTopRight()` if the saved position would land
 *  (fully or mostly) off every connected monitor, e.g. a monitor used at
 *  drag time was later disconnected. */
export async function restoreCustomPosition(pos: { x: number; y: number }): Promise<boolean> {
  if (!("__TAURI_INTERNALS__" in window)) return false;
  const { getCurrentWindow, LogicalPosition, availableMonitors } = await import("@tauri-apps/api/window");
  const monitors = await availableMonitors();

  // A saved position is usable if at least a meaningful corner of the
  // window would land on SOME connected monitor — cheap defensive check,
  // not a precise clamp (placeTopRight's own clamp already handles the
  // "monitor smaller than window" case for the fallback path).
  const fits = monitors.some((mon) => {
    const scale = mon.scaleFactor;
    const monX = mon.position.x / scale;
    const monY = mon.position.y / scale;
    const monW = mon.size.width / scale;
    const monH = mon.size.height / scale;
    return pos.x + 40 > monX && pos.x < monX + monW && pos.y + 40 > monY && pos.y < monY + monH;
  });
  if (!fits) return false;

  const win = getCurrentWindow();
  repositioning = true;
  try {
    await win.setPosition(new LogicalPosition(pos.x, pos.y));
  } finally {
    setTimeout(() => (repositioning = false), 250);
  }
  return true;
}

/** Persists any window move the USER causes (drag) — never one `placeTopRight`/
 *  `restoreCustomPosition` itself triggers (`repositioning` gate, shared with
 *  `watchDisplayChanges`). Debounced: a drag fires many onMoved events, only
 *  the settled position is worth writing. No-op in plain-browser dev.
 *  Returns a stop function, same shape as `watchDisplayChanges`.
 *
 *  `onSettled` (optional) fires on the same debounced tick, after the
 *  position is saved — used to re-run `reportInteractiveRegions()`, whose
 *  screen-absolute click-through rects go stale once the header moves
 *  (KNOWN_ISSUES-adjacent: a second drag from the new position was
 *  otherwise ignored, since the Rust side kept comparing the cursor to the
 *  pre-drag rects). Sharing this debounce instead of adding a second timer
 *  keeps the two effects landing on the same tick. */
export async function watchWindowMoves(onSettled?: () => void | Promise<void>): Promise<() => void> {
  if (!("__TAURI_INTERNALS__" in window)) return () => {};
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const win = getCurrentWindow();

  let debounce: ReturnType<typeof setTimeout> | undefined;
  const unlisten = await win.onMoved(({ payload }) => {
    if (repositioning) return; // our own move, not a user drag
    clearTimeout(debounce);
    debounce = setTimeout(async () => {
      const scale = await win.scaleFactor();
      saveCustomPosition({ x: payload.x / scale, y: payload.y / scale });
      await onSettled?.();
    }, 300);
  });

  return () => {
    clearTimeout(debounce);
    unlisten();
  };
}

interface MonitorSnapshot {
  x: number;
  y: number;
  w: number;
  h: number;
  scale: number;
}

async function snapshotMonitor(): Promise<MonitorSnapshot | null> {
  const { currentMonitor } = await import("@tauri-apps/api/window");
  const mon = await currentMonitor();
  if (!mon) return null;
  return { x: mon.position.x, y: mon.position.y, w: mon.size.width, h: mon.size.height, scale: mon.scaleFactor };
}

function sameMonitor(a: MonitorSnapshot | null, b: MonitorSnapshot | null): boolean {
  if (a === null || b === null) return a === b;
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h && a.scale === b.scale;
}

/** §2/M1: re-runs `onChange` whenever the window's display geometry, DPI
 *  scale factor, or usable monitor space actually changes — resolution
 *  change, monitor add/remove/rearrange, moving the window to a
 *  different-DPI display, etc. Combines Tauri's native `onScaleChanged`/
 *  `onMoved`/`onResized` events (fire promptly, but don't cover every OS
 *  display-reconfiguration case) with a slow poll (every 3s) comparing a
 *  monitor snapshot, as a robust fallback that catches whatever the native
 *  events miss — cheap, since it's one IPC call every few seconds.
 *  No-ops in plain-browser dev. Returns a stop function. */
export async function watchDisplayChanges(onChange: () => void): Promise<() => void> {
  if (!("__TAURI_INTERNALS__" in window)) return () => {};

  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const win = getCurrentWindow();

  let last = await snapshotMonitor();

  async function recheck(): Promise<void> {
    if (repositioning) return; // our own placeTopRight() move, not an external change
    const current = await snapshotMonitor();
    if (!sameMonitor(last, current)) {
      last = current;
      onChange();
    }
  }

  const unlistenScale = await win.onScaleChanged(() => void recheck());
  const unlistenMoved = await win.onMoved(() => void recheck());
  const unlistenResized = await win.onResized(() => void recheck());

  const interval = setInterval(() => void recheck(), 3000);

  return () => {
    unlistenScale();
    unlistenMoved();
    unlistenResized();
    clearInterval(interval);
  };
}
