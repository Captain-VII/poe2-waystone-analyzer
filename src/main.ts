import { MOCK_RESULTS, TIER_ORDER } from "./mock";
import { mountOverlay, type AnalyzeFailure } from "./components/RelicPanel";
import {
  placeTopRight,
  computeEffectiveMode,
  watchDisplayChanges,
  prepareWindowDrag,
  startWindowDrag,
  restoreCustomPosition,
  watchWindowMoves,
  resolveMonitor,
  type ResolvedMonitor,
} from "./placement";
import {
  loadReduceEffects,
  loadCustomPosition,
  clearCustomPosition,
  loadSessionStats,
  saveSessionStats,
  clearSessionStats,
  summarizeSessionStats,
  loadSessionHistory,
  archiveSession,
  exportSessionHistoryCsv,
  loadAnalysisLog,
  recordAnalysisLog,
  setAnalysisLogSkipFeedback,
  clearAnalysisLog,
  loadStartMinimized,
  loadPinned,
  savePinned,
} from "./settings";
import { registerHotkeys, getHotkeyBase, setHotkeyBase } from "./hotkeys";
import { getAutostartEnabled, setAutostartEnabled } from "./autostart";
import { reportInteractiveRegions } from "./interactive-rect";
import { runDiagnostics, applyDebugOpaqueOverride, sendReport, showWhenPainted, logAnalyzeAttempt } from "./diagnostics";
import { readClipboardText } from "./clipboard";
import { analyzeWaystoneText } from "./analyzer/adapter";
import {
  loadMetaConfig,
  readRawMetaFile,
  saveMetaFile,
  resetMetaFile,
  validateMetaFileOnDisk,
  watchMetaFile,
} from "./analyzer/meta-config";
import { buildEditorModel, buildMetaFile, type MechanicEdit, type MetaEditorModel } from "./analyzer/meta-schema";
import { notifyLegendaryWaystone, notifyUpdateAvailable } from "./notify";
import { playJuicyChime } from "./sound";
import { checkForUpdate, installUpdate } from "./updater";
import { decodeWaystoneShare, encodeWaystoneShare } from "./analyzer/share";
import { loadUpdateChannelBeta } from "./overlaySettings";
import { shouldShowChangelog, markChangelogSeen } from "./changelog";
import type { AnalysisResult, TierClass } from "./types";

let tier: TierClass = "god";
let analyzing = false;
/** OVERLAY_DEBUG=1, resolved once from Rust at init (the flag is a process
 *  env var the webview can't read itself). Gates the debug corner. */
let debugOverlay = false;
let lastNotifiedName: string | null = null; // avoid re-notifying on repeat/no-op analyzes
// Raw item text of the last successful analysis — source for the header's
// Share button (share.ts encodes this exact text, not a separate summary).
let lastWaystoneText: string | null = null;
// §13: the last successful analysis that was BOTH high-score and "Very
// Dangerous" — if a DIFFERENT waystone gets analyzed within 45s, that's a
// proxy for "skipped this one", and the overlay asks why. `at` doubles as
// the analysisLog entry's key (setAnalysisLogSkipFeedback matches on it).
let lastDangerousHit: { name: string; at: string } | null = null;
const SKIP_MISMATCH_WINDOW_MS = 45_000;

// Session stats (Settings panel): one score per waystone name, persisted —
// see settings.ts's SessionStats for the dedupe/session semantics.
const sessionStats = loadSessionStats();
// Past sessions, archived on each Reset — see settings.ts's archiveSession.
let sessionHistory = loadSessionHistory();
// Current session's own recent analyses (Settings → Session) — an
// append-only log, unlike sessionStats' dedup-by-name map; cleared on
// Reset alongside the live stats it sits next to, never archived.
let analysisLog = loadAnalysisLog();

/** Returns whether this analysis beats every prior one in the current
 *  session — the automatic, gesture-free "is this better than what I've
 *  seen" signal that replaced the removed Compare mode (KNOWN_ISSUES #8,
 *  "pas pertinent": manually pinning a waystone then analyzing a second
 *  one to compare was too much ceremony for a question this quick, and a
 *  side-by-side of two full analyses was more detail than the question
 *  needed — the score alone already answers it). Read against the PRE-
 *  update best (this function's own `summarizeSessionStats` call happens
 *  before `sessionStats.scores` is mutated below), and only true once
 *  there's an actual prior best to beat — the very first analysis of a
 *  session is trivially "best" but that's not a meaningful signal. */
function recordSessionStat(result: AnalysisResult, at: string): boolean {
  const before = summarizeSessionStats(sessionStats);
  const isNewSessionBest = before.best !== null && result.heat.score > before.best.score;

  sessionStats.scores[result.waystone.name] = result.heat.score;
  saveSessionStats(sessionStats);
  overlay.setSessionStats(summarizeSessionStats(sessionStats));
  analysisLog = recordAnalysisLog(analysisLog, {
    at,
    name: result.waystone.name,
    score: result.heat.score,
    tierLabel: result.heat.tierLabel,
  });
  overlay.setAnalysisLog(analysisLog);
  return isNewSessionBest;
}

/** Settings' session-stats "Reset" button — archives the current session
 *  into history, then starts a fresh one. */
function resetSessionStats(): void {
  sessionHistory = archiveSession(sessionStats);
  sessionStats.scores = {};
  clearSessionStats();
  analysisLog = [];
  clearAnalysisLog();
  overlay.setSessionStats(summarizeSessionStats(sessionStats));
  overlay.setSessionHistory(sessionHistory);
  overlay.setAnalysisLog(analysisLog);
}

/** Settings' "Export CSV" button — copies the full archived history to the
 *  clipboard (Tauri only; plain-browser dev has no clipboard-manager
 *  plugin). Returns success so the button can show brief feedback. */
async function exportSessionHistory(): Promise<boolean> {
  if (sessionHistory.length === 0 || !("__TAURI_INTERNALS__" in window)) return false;
  try {
    const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
    await writeText(exportSessionHistoryCsv(sessionHistory));
    return true;
  } catch {
    return false;
  }
}

/** Settings' App tab "Export Logs" button — reveals the folder holding the
 *  Rust-side diagnostic log file in the OS file explorer, so a tester can
 *  hand it to support (e.g. for the black-screen bug). Tauri-only, same
 *  guard as exportSessionHistory above. */
async function exportLogs(): Promise<boolean> {
  if (!("__TAURI_INTERNALS__" in window)) return false;
  try {
    const { appLogDir } = await import("@tauri-apps/api/path");
    const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
    await revealItemInDir(await appLogDir());
    return true;
  } catch {
    return false;
  }
}

/** Header's copy-summary button — writes RelicPanel's one-line summary
 *  (score/tier/verdict/best mechanic) to the clipboard, same Tauri-only
 *  pattern as exportSessionHistory above. */
async function copySummary(text: string): Promise<boolean> {
  if (!("__TAURI_INTERNALS__" in window)) return false;
  try {
    const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
    await writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Header's share button — encodes the last analyzed waystone's raw item
 *  text (share.ts) and writes the code to the clipboard, ready to paste
 *  into Discord. Same Tauri-only pattern as copySummary above; fails if
 *  nothing has been analyzed yet this session. */
async function shareWaystone(): Promise<boolean> {
  if (!lastWaystoneText || !("__TAURI_INTERNALS__" in window)) return false;
  try {
    const code = await encodeWaystoneShare(lastWaystoneText);
    const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
    await writeText(code);
    return true;
  } catch {
    return false;
  }
}

/** Session tab's "Import from clipboard" button — decodes a share.ts code
 *  back into item text and runs it through the normal analysis pipeline,
 *  same as a real Ins press, except it doesn't touch session stats or
 *  trigger the Juicy notification/chime (it isn't the player's own find). */
async function importSharedWaystone(): Promise<boolean> {
  if (!("__TAURI_INTERNALS__" in window)) return false;
  try {
    const { readText } = await import("@tauri-apps/plugin-clipboard-manager");
    const clip = await readText();
    if (!clip) return false;
    const decoded = await decodeWaystoneShare(clip);
    if (!decoded) return false;
    const result = analyzeWaystoneText(decoded);
    if (!result) return false;
    overlay.setResult(result);
    return true;
  } catch {
    return false;
  }
}

/** Header's pin toggle — persists the value and pushes it to Rust's
 *  PinState (lib.rs's set_pinned) so the click-away-to-dismiss poll loop
 *  can skip hiding the window. Also called once at startup with the
 *  persisted value, since Rust's own default is false on every launch. */
async function setPinned(pinned: boolean): Promise<void> {
  savePinned(pinned);
  if (!("__TAURI_INTERNALS__" in window)) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("set_pinned", { pinned }).catch(() => {});
}

// Méta editor (Settings panel): each action re-reads the raw file, rebuilds
// the diff-only content (meta-schema.ts's buildMetaFile), writes, hot-reloads
// the active tables, and returns a fresh model — a concurrent hand-edit of
// the file is never clobbered beyond the field being changed.
async function metaModelFromDisk(): Promise<MetaEditorModel> {
  const { raw, corrupt } = await readRawMetaFile();
  return buildEditorModel(raw, corrupt);
}

const metaEditor = {
  load: metaModelFromDisk,
  async saveMechanic(name: string, edit: MechanicEdit): Promise<MetaEditorModel> {
    const { raw } = await readRawMetaFile();
    await saveMetaFile(buildMetaFile(raw, new Map([[name.toLowerCase(), edit]]), new Map()));
    return metaModelFromDisk();
  },
  async setTabletEnabled(name: string, enabled: boolean): Promise<MetaEditorModel> {
    const { raw } = await readRawMetaFile();
    await saveMetaFile(buildMetaFile(raw, new Map(), new Map([[name.toLowerCase(), enabled]])));
    return metaModelFromDisk();
  },
  async reset(): Promise<MetaEditorModel> {
    await resetMetaFile();
    return metaModelFromDisk();
  },
  validate: validateMetaFileOnDisk,
};

// mountOverlay's own setup (restoring the persisted settings tab) fires
// onInteractiveChange synchronously, before the `overlay` const below is
// assigned — reportRegions() referencing `overlay` at that point throws a
// TDZ ReferenceError (surfaces as an unhandledrejection, since reportRegions
// is async). Harmless to skip: applyEffectiveMode() reports the initial
// regions again once overlay is ready anyway.
let overlayReady = false;
const overlay = mountOverlay(document.getElementById("app")!, MOCK_RESULTS[tier], {
  isReduced: () =>
    loadReduceEffects() || matchMedia("(prefers-reduced-motion: reduce)").matches,
  onAnalyze: analyze,
  onHide: hideOverlay,
  onInteractiveChange: () => {
    if (overlayReady) void reportRegions();
  },
  // Rust validates, swaps the three registrations (with rollback on
  // conflict), and persists — see lib.rs's set_hotkey_base. Only offered
  // inside the real overlay; plain-browser dev keeps a display-only row.
  onSetHotkey: "__TAURI_INTERNALS__" in window ? setHotkeyBase : undefined,
  onSetAutostart: "__TAURI_INTERNALS__" in window ? setAutostartEnabled : undefined,
  onCheckUpdate: "__TAURI_INTERNALS__" in window ? () => checkForUpdate(loadUpdateChannelBeta()) : undefined,
  onInstallUpdate: "__TAURI_INTERNALS__" in window ? installUpdate : undefined,
  onDragStart: "__TAURI_INTERNALS__" in window ? startWindowDrag : undefined,
  onResetPosition: resetPosition,
  onResetStats: resetSessionStats,
  onExportHistory: exportSessionHistory,
  onExportLogs: exportLogs,
  onCopySummary: copySummary,
  onShareWaystone: "__TAURI_INTERNALS__" in window ? shareWaystone : undefined,
  onImportShare: "__TAURI_INTERNALS__" in window ? importSharedWaystone : undefined,
  onSetPinned: (pinned) => void setPinned(pinned),
  metaEditor: "__TAURI_INTERNALS__" in window ? metaEditor : undefined,
  // Dev-only: clicking the tier badge cycles the mock fixtures, for UI
  // testing without a real clipboard waystone. Disabled in production
  // builds (import.meta.env.DEV is false) — it would otherwise silently
  // overwrite a real analyzed result with mock data.
  onCycleTier: import.meta.env.DEV
    ? () => {
        tier = TIER_ORDER[(TIER_ORDER.indexOf(tier) + 1) % TIER_ORDER.length];
        overlay.setResult(MOCK_RESULTS[tier]);
      }
    : undefined,
});
overlayReady = true;

async function reportRegions(): Promise<void> {
  await reportInteractiveRegions(overlay.interactiveEls());
}

/** §2: re-evaluates the Full→Mini fallback against current monitor space
 *  and renders it — Full is always what's asked for, so a forced Mini
 *  fallback is automatically undone the next time space allows it. */
async function applyEffectiveMode(resolved?: ResolvedMonitor): Promise<void> {
  const effective = await computeEffectiveMode(resolved);
  overlay.setMode(effective);
  await reportRegions();
}

/** §5 M5: Ins reads the real clipboard and, if it holds a valid Waystone
 *  (per parseWaystone's "Item Class: Waystones" gate), replaces the
 *  displayed result with the real AnalysisResult — the UI never computes
 *  tierClass/verdict itself (§11), the adapter already has. On failure
 *  (copy/read failed, empty clipboard, or non-Waystone text) the display
 *  keeps whatever's currently shown and a status chip names the failure —
 *  the success pulse never plays, so a failed press is unambiguous. */
async function analyze(simulateCopy = true): Promise<void> {
  // key-repeat guard (§8): blocks a second analyze() from overlapping the
  // first's clipboard round-trip (copy → 120ms settle → read → restore,
  // see clipboard.ts) — an overlap could restore the FIRST call's saved
  // clipboard over the SECOND call's freshly-copied text. 250ms leaves
  // roughly 2x that round-trip as margin while still keeping up with a
  // human repeatedly tapping the analyze hotkey (2026-07-13, down from
  // 450ms — user request to spam-tap Ctrl+E).
  if (analyzing) return;
  analyzing = true;
  // Re-reveal on a real Ins press (never on the startup-only analyze(false)
  // call, which happens before the window's first-ever show and doesn't
  // need it) — this is how Escape/click-away's hide gets undone.
  if (simulateCopy) void revealOverlay();
  const clip = await readClipboardText(simulateCopy);
  let applied: { score: number; tierClass: string; name: string } | null = null;
  let failure: AnalyzeFailure | null = null;
  let isNewSessionBest = false;
  if (!clip) {
    failure = "clipboard";
  } else {
    // Spans parse + render, which is what the debug readout reports — the
    // two together are the "did my formula change make this slow" number,
    // and splitting them would mean timing setResult separately for a
    // figure nobody reads independently.
    const startedAt = performance.now();
    const result = analyzeWaystoneText(clip);
    if (!result) {
      failure = "not-waystone";
    } else {
      overlay.setResult(result);
      lastWaystoneText = clip;
      if (debugOverlay) {
        overlay.setDebugInfo({
          modCount: result.waystone.modCount,
          score: result.heat.score,
          ms: performance.now() - startedAt,
        });
      }
      applied = { score: result.heat.score, tierClass: result.heat.tierClass, name: result.waystone.name };
      if (result.heat.tierClass === "god" && result.waystone.name !== lastNotifiedName) {
        lastNotifiedName = result.waystone.name;
        void notifyLegendaryWaystone(result.waystone.name, result.heat.score);
        playJuicyChime();
      }
      const at = new Date().toISOString();
      // §13: fires BEFORE lastDangerousHit is overwritten below — a chain
      // of 3+ analyses only ever asks about the immediately preceding one.
      if (
        lastDangerousHit &&
        lastDangerousHit.name !== result.waystone.name &&
        Date.now() - Date.parse(lastDangerousHit.at) <= SKIP_MISMATCH_WINDOW_MS
      ) {
        const hit = lastDangerousHit;
        overlay.promptSkipFeedback(hit.name, (skippedForDanger) => {
          analysisLog = setAnalysisLogSkipFeedback(analysisLog, hit.at, skippedForDanger);
          overlay.setAnalysisLog(analysisLog);
        });
      }
      lastDangerousHit =
        result.dangerLevel === "high" && (result.heat.tierClass === "god" || result.heat.tierClass === "splus")
          ? { name: result.waystone.name, at }
          : null;
      isNewSessionBest = recordSessionStat(result, at);
    }
  }
  // Support/debugging checkpoint: confirms whether Ins actually applied a
  // real clipboard analysis vs. left the display unchanged (invalid/no
  // Waystone on clipboard) — see docs/release-checklist.md §3.
  await logAnalyzeAttempt({ hadClipboardText: !!clip, applied, failure, clipLength: clip?.length ?? null });
  if (failure) {
    // Only on a real press — the startup-only analyze(false) keeps its
    // silent mock-data fallback (plain-browser dev has no clipboard).
    if (simulateCopy) overlay.showAnalyzeError(failure);
  } else {
    overlay.analyze();
    if (isNewSessionBest) overlay.flashSessionBest();
  }
  setTimeout(() => (analyzing = false), 250);
}

/** Settings panel's "Hide" button — sends the overlay to the system tray.
 *  Quitting for good is tray-icon-only (right-click → Quitter, see
 *  src-tauri/src/lib.rs). No-op in plain-browser dev (no Tauri window to
 *  hide). */
function hideOverlay(): void {
  if (!("__TAURI_INTERNALS__" in window)) return;
  import("@tauri-apps/api/core").then(({ invoke }) => invoke("hide_window"));
}

/** Undoes hideOverlay() — called on every real Ins press, idempotent if the
 *  overlay was already visible. No-op in plain-browser dev. */
async function revealOverlay(): Promise<void> {
  if (!("__TAURI_INTERNALS__" in window)) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("reveal_window").catch(() => {});
}

/** Settings' "Réinitialiser" position button — drops the saved custom
 *  position and snaps back to the default top-right anchor. No-op in
 *  plain-browser dev (both calls already guard on Tauri presence).
 *  Re-reports interactive regions after, same as applyEffectiveMode()'s morph —
 *  without it, `placeTopRight()`'s own onMoved fires with `repositioning`
 *  set (placement.ts's watchWindowMoves ignores it, by design, so it
 *  never persists a programmatic move as a "user drag") and nothing else
 *  updates the click-through rects, so every control stays stuck at the
 *  pre-reset screen position (found 2026-07-12, real in-game report). */
async function resetPosition(): Promise<void> {
  clearCustomPosition();
  await placeTopRight();
  await reportRegions();
}

let handlingDisplayChange = false;

/** §2/M1: display/DPI/resolution/monitor-space changed — re-anchor top-right,
 *  re-evaluate the Full→Mini fallback against the new space (this is also
 *  exactly how Full gets restored once space returns: computeEffectiveMode
 *  always asks for Full first, never sticks with a prior forced Mini), and
 *  re-report the (possibly moved/resized) interactive regions. */
async function handleDisplayChange(): Promise<void> {
  if (handlingDisplayChange) return; // coalesce bursts of change events
  handlingDisplayChange = true;
  try {
    // A real display/DPI/monitor change invalidates any dragged position —
    // remapping a stale absolute position onto new geometry risks landing
    // off-screen, so always fall back to the self-healing top-right anchor
    // rather than trying to preserve it (drag-to-reposition, see
    // placement.ts's restoreCustomPosition doc comment).
    clearCustomPosition();
    const resolved = await resolveMonitor();
    await placeTopRight(resolved);
    await applyEffectiveMode(resolved); // also re-reports regions
    setTimeout(reportRegions, 260); // once more after any mode-morph settles
  } finally {
    handlingDisplayChange = false;
  }
}

async function init(): Promise<void> {
  await loadMetaConfig(); // §3: meta.json weights/tablets/thresholds before any analysis
  // Hand-edits to meta.json outside the app used to need a restart; now the
  // merged tables reload in place. The displayed result deliberately isn't
  // re-scored — the next analysis picks the change up, exactly as it does
  // after an in-app edit.
  void watchMetaFile(() => {
    overlay.refreshMetaEditor();
    // Same compact one-line channel RelicPanel uses for autostart failures —
    // an external reload is otherwise completely silent, which makes "did my
    // hand-edit actually take?" unanswerable without a restart.
    void import("@tauri-apps/api/core").then(({ invoke }) =>
      invoke("log_frontend_report", { report: "[meta] meta.json changed on disk — tables reloaded" }),
    );
  });
  await sendReport("pre-placement");

  const { debugOpaque } = await runDiagnostics();
  if (debugOpaque) {
    applyDebugOpaqueOverride();
    await placeTopRight(); // same window size/position as the shipped overlay
    await sendReport("debug-opaque-applied");
    await showWhenPainted(); // window starts hidden; reveal once compositor has a real frame
    return; // isolate step 1 — paint only, nothing else (no click-through, no hotkeys)
  }

  if ("__TAURI_INTERNALS__" in window) {
    const { invoke } = await import("@tauri-apps/api/core");
    debugOverlay = await invoke<boolean>("is_debug_overlay").catch(() => false);
  }

  // Drag-to-reposition: restore a previously-dragged spot instead of the
  // default top-right anchor when one was saved and still fits a connected
  // monitor (restoreCustomPosition's own check) — while still hidden, no
  // visible jump on reveal either way.
  const customPos = loadCustomPosition();
  const restored = customPos ? await restoreCustomPosition(customPos) : false;
  const resolved = await resolveMonitor();
  if (!restored) await placeTopRight(resolved);
  await applyEffectiveMode(resolved); // §2 fallback — may render Mini if Full doesn't fit
  await sendReport("post-placement");
  // Settings' "Start minimized" toggle: only skip the reveal when Rust
  // confirms this launch actually came from the Windows autostart entry
  // (lib.rs's was_autostart_launch) — a manual double-click of the exe
  // always shows the window regardless of the toggle. Everything else
  // (hotkeys, click-through regions, tray icon) still initializes normally
  // below; the window just stays in its initial .visible(false) state
  // until a real Ins press (revealOverlay) or the tray icon brings it up.
  let stayMinimized = false;
  if ("__TAURI_INTERNALS__" in window && loadStartMinimized()) {
    const { invoke } = await import("@tauri-apps/api/core");
    stayMinimized = await invoke<boolean>("was_autostart_launch").catch(() => false);
  }
  if (!stayMinimized) await showWhenPainted();
  await setPinned(loadPinned()); // Rust's PinState defaults false every launch — sync the persisted value
  // Shift+base ("toggle") is still emitted by Rust (lib.rs registers all
  // three layers unconditionally) but is inert now that Compact mode is
  // gone — there's nothing left to toggle to. No-op rather than touching
  // the Rust-side registration for a rarely-pressed dead key.
  await registerHotkeys(analyze, () => {}, hideOverlay);
  // The overlay mounts (synchronously, above) before the persisted base
  // can be fetched — labels default to Ins, corrected here if remapped.
  overlay.setHotkeyLabel(await getHotkeyBase());
  const autostartOn = await getAutostartEnabled();
  overlay.setAutostartChecked(autostartOn);
  // Re-assert so the registry Run key always points at the CURRENT exe —
  // an update that changes the install path/binary name (e.g. the
  // waystone-overlay → Waystone-Analyzer rename) would otherwise keep
  // launching the orphaned old install at every login.
  if (autostartOn) setAutostartEnabled(true).catch(() => {});
  overlay.setSessionStats(summarizeSessionStats(sessionStats)); // persisted stats from previous launches
  overlay.setSessionHistory(sessionHistory); // persisted history from previous launches
  overlay.setAnalysisLog(analysisLog); // persisted current-session log from previous launches
  await prepareWindowDrag(); // caches the window ref so the header's mousedown can start a drag synchronously
  await watchDisplayChanges(() => void handleDisplayChange());
  // Persists a user drag once it settles, then re-reports interactive
  // regions at the header's new position — without this, a second drag
  // from anywhere but the original spawn position was ignored (ROADMAP.md,
  // root-caused 2026-07-12: the Rust side's click-through check compared
  // the cursor to stale pre-drag rects).
  await watchWindowMoves(reportRegions);
  await sendReport("display-watch-attached");
  // Startup paint only — must NOT simulate Ctrl+C: whatever window has OS
  // focus at this moment (often a dev terminal, not the game) would receive
  // the keystroke instead of the overlay, which for a console means SIGINT.
  analyze(false);
  // Fire-and-forget: version display + silent update check. Never blocks
  // startup, never installs anything — a found update only arms the
  // Settings row and fires one toast; installing stays a user click.
  void (async () => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    const { getVersion } = await import("@tauri-apps/api/app");
    const version = await getVersion();
    overlay.setAppVersion(version);
    // First launch of a new version (i.e. right after an update, or a fresh
    // install): show the patch notes once. Marked seen immediately — if the
    // user closes without reading, re-showing every launch would be nagging;
    // the Settings row keeps them reachable.
    if (shouldShowChangelog(version)) {
      overlay.showChangelog();
      markChangelogSeen(version);
    }
    const info = await checkForUpdate(loadUpdateChannelBeta());
    if (info) {
      overlay.setUpdateAvailable(info.version);
      await notifyUpdateAvailable(info.version);
    }
  })();
}

init();
