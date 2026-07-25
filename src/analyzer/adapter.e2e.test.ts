/** End-to-end pipeline tests: real clipboard-shaped waystone text straight
 *  into `analyzeWaystoneText`, asserting on the exact contract the overlay
 *  renders — not just the shape checks `scripts/verify-adapter.mjs` already
 *  covers (one sample, structural invariants), but concrete behavior claims
 *  this project has repeatedly stated in comments/docs and never actually
 *  pinned in a test:
 *  - danger mods are flagged but never move the score (README, guide.ts)
 *  - Corrupted is a pure pass-through, unrelated to scoring
 *  - the Skip/Keep/Run gate depends on BOTH score and waystone tier, not
 *    score alone (adapter.ts's `classifyVerdict`) — an easy thing to get
 *    subtly wrong when tuning either threshold in isolation
 *
 *  Fixtures use the plain-line mod format (no `{ Prefix Modifier ... }`
 *  brackets) — the same format `scripts/verify-adapter.mjs`'s SAMPLE uses,
 *  and the one this app's own README documents users pasting. Exact stat
 *  wording is taken from `mod-parser.ts`'s PATTERNS and
 *  `scoring.ts`'s DANGER_PATTERNS/mechanic-patterns.ts, not guessed — a
 *  fixture whose wording doesn't actually match the real parser regex would
 *  silently test nothing, the exact failure mode `parseMods`'s own
 *  double-count near-miss (KNOWN_ISSUES #2, 2026-07-11) already caught once
 *  in real tablet text. */

import { describe, expect, it } from "vitest";
import { analyzeWaystoneText } from "./adapter";

function waystone(opts: {
  name?: string;
  rarity?: string;
  tier?: number;
  mods: string[];
  corrupted?: boolean;
}): string {
  const { name = "Test Waystone", rarity = "Rare", tier = 15, mods, corrupted = false } = opts;
  const lines = [
    "Item Class: Waystones",
    `Rarity: ${rarity}`,
    name,
    `Waystone (Tier ${tier})`,
    "--------",
    "Waystone Tier: " + tier,
    "Item Level: 82",
    "--------",
    ...mods,
  ];
  if (corrupted) lines.push("--------", "Corrupted");
  return lines.join("\n");
}

describe("analyzeWaystoneText: non-waystone / degenerate input", () => {
  it("returns null for a non-waystone item", () => {
    const text = "Item Class: Rings\nRarity: Normal\nA Ring\n--------\nItem Level: 50";
    expect(analyzeWaystoneText(text)).toBeNull();
  });

  it("returns null for empty text without throwing", () => {
    expect(() => analyzeWaystoneText("")).not.toThrow();
    expect(analyzeWaystoneText("")).toBeNull();
  });

  it("never throws on a waystone header with no mod lines at all", () => {
    const text = waystone({ mods: [] });
    expect(() => analyzeWaystoneText(text)).not.toThrow();
    const result = analyzeWaystoneText(text);
    expect(result).not.toBeNull();
    expect(result!.waystone.modCount).toBe(0);
  });
});

describe("analyzeWaystoneText: danger mods never move the score", () => {
  // Same stats AND same modCount, only difference is which two of the four
  // lines are "real danger" vs "inert filler" — scoring.ts's
  // modCountBonus feeds every tablet's fit from `parsed.modifiers.length`
  // alone, so comparing a 2-mod fixture against a naively-appended 4-mod
  // "dangerous" one would conflate "danger changed the score" with "having
  // more modifiers changed the score" (caught live: the naive version of
  // this test failed with 88 vs 86, a modCountBonus delta, not a danger
  // regression). Padding `clean` with two harmless filler lines that don't
  // match ANY tracked stat/danger/mechanic pattern isolates the actual
  // claim under test. Real danger wording: reflect + fast monsters
  // (scoring.ts's DANGER_PATTERNS) — this is the exact "danger flagged,
  // never scored" claim the README/Guide both state but that no prior test
  // (unit or contract) actually cross-checked.
  const statMods = ["+45% increased Rarity of Items found in this Area", "+30% increased Pack Size"];
  const inertFiller = ["Players gain 5% increased Trap Throwing Speed", "Slaying Enemies grants a Charm"];
  const dangerFiller = ["Reflects Elemental Damage", "Monsters have 25% increased Attack Speed"];

  it("adding real danger mods changes warnings/dangerLevel but not heat.score", () => {
    const clean = analyzeWaystoneText(waystone({ mods: [...statMods, ...inertFiller] }))!;
    const dangerous = analyzeWaystoneText(waystone({ mods: [...statMods, ...dangerFiller] }))!;
    expect(clean.waystone.modCount).toBe(dangerous.waystone.modCount);

    expect(clean.warnings).toEqual([]);
    expect(clean.dangerLevel).toBe("none");

    expect(dangerous.warnings.length).toBeGreaterThan(0);
    expect(dangerous.dangerLevel).not.toBe("none");
    expect(dangerous.dangerHits.map((h) => h.label)).toEqual(
      expect.arrayContaining(["Reflect Damage", "Fast Monsters"]),
    );
    // both are "reflect"/"strong" severity — UI_SEVERITY collapses both to "high"
    expect(dangerous.dangerHits.every((h) => h.severity === "high")).toBe(true);

    // The actual claim under test: identical stats, score untouched by danger.
    expect(dangerous.heat.score).toBe(clean.heat.score);
    expect(dangerous.heat.tierClass).toBe(clean.heat.tierClass);
    expect(dangerous.heat.verdict).toBe(clean.heat.verdict);
  });
});

describe("analyzeWaystoneText: Corrupted is a pure pass-through", () => {
  it("toggling Corrupted changes only waystone.corrupted, nothing score-related", () => {
    const mods = ["+50% increased Rarity of Items found in this Area", "+20% increased Rarity of Monsters"];
    const normal = analyzeWaystoneText(waystone({ mods, corrupted: false }))!;
    const corrupted = analyzeWaystoneText(waystone({ mods, corrupted: true }))!;

    expect(normal.waystone.corrupted).toBe(false);
    expect(corrupted.waystone.corrupted).toBe(true);
    expect(corrupted.heat.score).toBe(normal.heat.score);
    expect(corrupted.heat.verdict).toBe(normal.heat.verdict);
    expect(corrupted.tablets).toEqual(normal.tablets);
  });
});

describe("analyzeWaystoneText: Skip/Keep/Run depends on tier AND score, not score alone", () => {
  // classifyVerdict: score < 20 -> SKIP; score >= 50 && tier >= 3 -> KEEP;
  // else RUN. A high score on a LOW-tier waystone must still read RUN, not
  // KEEP — the tier gate is easy to lose track of when only the score
  // threshold gets tuned.
  const strongMods = [
    "+90% increased Rarity of Items found in this Area",
    "+90% increased Rarity of Monsters",
    "+55% increased Pack Size",
    "+60% Monster Effectiveness",
    "+120% increased Quantity of Waystones found in this Area",
  ];

  it("a weak waystone (near-empty stats) is SKIP", () => {
    const result = analyzeWaystoneText(waystone({ mods: ["+10% increased Rarity of Items found in this Area"] }))!;
    expect(result.heat.score).toBeLessThan(20);
    expect(result.heat.verdict).toBe("SKIP");
  });

  it("a strong waystone on a low tier is RUN, not KEEP", () => {
    const result = analyzeWaystoneText(waystone({ tier: 2, mods: strongMods }))!;
    expect(result.heat.score).toBeGreaterThanOrEqual(50);
    expect(result.waystone.tier).toBeLessThan(3);
    expect(result.heat.verdict).toBe("RUN");
  });

  it("the same strong waystone on a high tier is KEEP", () => {
    const result = analyzeWaystoneText(waystone({ tier: 15, mods: strongMods }))!;
    expect(result.heat.score).toBeGreaterThanOrEqual(50);
    expect(result.waystone.tier).toBeGreaterThanOrEqual(3);
    expect(result.heat.verdict).toBe("KEEP");
  });
});

describe("analyzeWaystoneText: mechanic detection drives recommendedMechanic and the Bonus insight", () => {
  it("a Delirium-shaped waystone (Pack Size dominant + keyword) recommends Delirium", () => {
    const text = waystone({
      mods: [
        "+50% increased Pack Size",
        "+30% increased Rarity of Items found in this Area",
        "Players in Area are 60% Delirious",
      ],
    });
    const result = analyzeWaystoneText(text)!;
    expect(result.recommendedMechanic).toBe("Delirium");
    // buildInsights: "Bonus: <reason> (+<bonus>)" — extra-content bonus for
    // delirium is +8 (mechanic-patterns.ts's EXTRA_CONTENT_BONUS).
    expect(result.insights.some((line) => line.includes("delirium") && line.includes("+8"))).toBe(true);
    expect(result.tablets.some((t) => t.mechanic === "Delirium")).toBe(true);
  });

  it("a Breach-shaped waystone (Monster Effectiveness dominant + keyword) recommends Breach", () => {
    const text = waystone({
      mods: [
        "+55% Monster Effectiveness",
        "+30% increased Rarity of Items found in this Area",
        "Area contains a hidden Breach",
      ],
    });
    const result = analyzeWaystoneText(text)!;
    expect(result.recommendedMechanic).toBe("Breach");
    expect(result.insights.some((line) => line.includes("breach") && line.includes("+10"))).toBe(true);
  });

  it("a mechanic keyword with a starved priority stat does not get recommended (skipIfBelow gate)", () => {
    // Delirium's skipIfBelow is 40 — a near-empty Pack Size roll must not
    // clear it just because the keyword is present.
    const text = waystone({ mods: ["Players in Area are 5% Delirious"] });
    const result = analyzeWaystoneText(text)!;
    expect(result.recommendedMechanic).not.toBe("Delirium");
  });
});

describe("analyzeWaystoneText: contract invariants hold on realistic mixed fixtures", () => {
  const fixtures = [
    waystone({
      mods: [
        "+45% increased Rarity of Items found in this Area",
        "+38% increased Rarity of Monsters",
        "+25% increased Pack Size",
        "+30% Monster Effectiveness",
        "Area contains an Expedition Encampment",
      ],
      corrupted: true,
    }),
    waystone({
      tier: 3,
      rarity: "Magic",
      mods: ["+15% increased Rarity of Monsters", "Reflects Elemental Damage"],
    }),
    waystone({ mods: [] }),
  ];

  it.each(fixtures.map((f, i) => [i, f] as const))("fixture %i: score/rating/tablets stay within contract", (_i, text) => {
    const result = analyzeWaystoneText(text)!;
    expect(result).not.toBeNull();
    expect(result.heat.score).toBeGreaterThanOrEqual(0);
    expect(result.heat.score).toBeLessThanOrEqual(100);
    expect(["SKIP", "KEEP", "RUN"]).toContain(result.heat.verdict);
    expect(["trash", "low", "good", "splus", "god"]).toContain(result.heat.tierClass);
    expect(["none", "low", "medium", "high"]).toContain(result.dangerLevel);
    expect(result.tablets.length).toBeGreaterThan(0);
    // tablets are sorted best-fit-first
    const fits = result.tablets.map((t) => t.fit);
    expect(fits).toEqual([...fits].sort((a, b) => b - a));
    expect(result.mechanicScores.every((m) => m.score >= 0 && m.score <= 100)).toBe(true);
    expect(result.keyFactors.length).toBeLessThanOrEqual(4);
  });
});
