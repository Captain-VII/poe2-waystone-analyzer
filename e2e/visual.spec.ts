import { test, expect } from "@playwright/test";

/** Drives the same dev-only mock-tier cycling built for manual UI checks
 *  (mock.ts's MOCK_RESULTS, main.ts's onCycleTier, only wired when
 *  import.meta.env.DEV is true — i.e. under `npm run dev`, which is what
 *  playwright.config.ts's webServer starts). No production code exists
 *  solely for this test. Clicks [data-minibadge], not [data-badge]:
 *  `.mode-full [data-badge] { display: none }` (panel.css) hides the
 *  latter in Full mode, the only mode this app ever actually renders. */
test.describe("overlay visual regression", () => {
  test("fixture tier cycle", async ({ page }) => {
    await page.goto("/");
    // "god" is the initial mount (main.ts: `let tier: TierClass = "god"`,
    // MOCK_RESULTS[tier] passed straight into mountOverlay) — no click
    // needed to see the first fixture.
    const tiers = ["god", "trash", "low", "good", "splus"];
    for (const tier of tiers) {
      await expect(page).toHaveScreenshot(`fixture-${tier}.png`);
      await page.click("[data-minibadge]");
    }
  });

  test("settings panel tabs", async ({ page }) => {
    await page.goto("/");
    await page.click("[data-settings]");
    // No "meta" tab here: RelicPanel only renders it when `metaEditor` is
    // passed, and main.ts only does that under a real Tauri runtime
    // (meta.json editing needs the Tauri filesystem) — plain-browser dev,
    // which is all this Playwright suite ever drives, never has it.
    for (const tab of ["overlay", "session", "app"]) {
      await page.click(`[data-set-tab="${tab}"]`);
      await expect(page).toHaveScreenshot(`settings-${tab}.png`);
    }
  });
});
