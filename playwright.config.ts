import { defineConfig, devices } from "@playwright/test";

/** Visual-regression suite (ROADMAP.md § "Tests & fiabilité") — a separate
 *  runner from vitest (which runs under `environment: "node"`, no real DOM
 *  layout at all, see vite.config.ts). Viewport matches the real overlay
 *  window's logical size (src-tauri/src/lib.rs's WINDOW_LOGICAL_SIZE) since
 *  in plain-browser dev `.overlay` anchors via top/right relative to the
 *  viewport itself (no Tauri window-move call runs outside a real Tauri
 *  window) — using the real size reproduces the actual edge/glow bugs this
 *  suite exists to catch. Chromium only: the app only ever renders inside
 *  WebView2, and Chromium is the closest available proxy — Firefox/WebKit
 *  would add CI time for zero real-world relevance. */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: "html",

  use: {
    baseURL: "http://localhost:5173",
    viewport: { width: 620, height: 406 },
    deviceScaleFactor: 1,
    trace: "retain-on-failure",
  },

  // 2% tolerance absorbs anti-aliasing jitter without hiding a real layout
  // shift (a wrapped badge or misaligned column moves hundreds of
  // contiguous pixels, far above this threshold on a 620x406 frame).
  expect: {
    toHaveScreenshot: { maxDiffPixelRatio: 0.02 },
  },

  // devices["Desktop Chrome"] carries its own 1280x720 viewport, which
  // would silently override the 620x406 set above (project-level `use`
  // wins over the top-level block) — re-asserted explicitly here.
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 620, height: 406 } },
    },
  ],

  webServer: {
    command: "npm run dev",
    url: "http://localhost:5173",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
