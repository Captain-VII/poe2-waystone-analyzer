import { describe, expect, it } from "vitest";
import { MECHANICS, TIER_SCORE, scoreMechanicFit, tierForPercent } from "./mechanics";

describe("tierForPercent", () => {
  it.each([
    [0, "weak"],
    [14.9, "weak"],
    [15, "ok"],
    [24.9, "ok"],
    [25, "top"],
    [49.9, "top"],
    [50, "legendary"],
    [400, "legendary"],
  ])("%d%% is %s", (value, tier) => {
    expect(tierForPercent(value)).toBe(tier);
  });
});

describe("scoreMechanicFit", () => {
  const breach = MECHANICS.find((m) => m.name === "Breach")!;

  it("scores on the priority stat's raw % only", () => {
    expect(scoreMechanicFit({ monsterEffectiveness: 40 }, breach)).toBe(TIER_SCORE.top);
    // A huge secondary stat does not lift the fit.
    expect(scoreMechanicFit({ monsterEffectiveness: 5, itemRarity: 300 }, breach)).toBe(TIER_SCORE.weak);
  });

  it("adds the extra bonus and clamps to 0..100", () => {
    expect(scoreMechanicFit({ monsterEffectiveness: 60 }, breach, 50)).toBe(100);
    expect(scoreMechanicFit({}, breach, -50)).toBe(0);
  });
});

describe("MECHANICS table", () => {
  it("has unique names and a skip threshold in 0..100", () => {
    const names = MECHANICS.map((m) => m.name);
    expect(new Set(names).size).toBe(names.length);
    for (const m of MECHANICS) {
      expect(m.skipIfBelow).toBeGreaterThanOrEqual(0);
      expect(m.skipIfBelow).toBeLessThanOrEqual(100);
    }
  });
});
