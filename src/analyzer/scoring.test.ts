import { describe, expect, it } from "vitest";
import type { ModStats } from "./mod-parser";
import {
  STAT_REFERENCES,
  classifyModifierKind,
  computeCompositeScore,
  computeDangerLevel,
  dangerHitsToWarnings,
  detectDangerHits,
  detectPositiveMods,
  evaluateMap,
  type DangerHit,
} from "./scoring";

const ZERO: ModStats = {
  quantity: 0,
  itemRarity: 0,
  monsterRarity: 0,
  packSize: 0,
  monsterEffectiveness: 0,
  waystoneDropChance: 0,
};
const stats = (s: Partial<ModStats>): ModStats => ({ ...ZERO, ...s });

describe("computeCompositeScore", () => {
  it("scores an empty waystone as weak with no bonus", () => {
    const r = computeCompositeScore(ZERO);
    expect(r.dominant.tier).toBe("weak");
    expect(r.bonus).toBe(0);
    expect(r.score).toBe(10);
  });

  it("picks the dominant stat by % of its own ceiling, not by raw %", () => {
    // Pack Size 40 = 61.5% of its 65 ceiling beats Item Rarity 50 = 50% of 100.
    const r = computeCompositeScore(stats({ packSize: 40, itemRarity: 50 }));
    expect(r.dominant.key).toBe("packSize");
    expect(r.dominant.tier).toBe("legendary");
    // Item Rarity clears "ok", so it adds 50% of the 5-point cap.
    expect(r.bonus).toBeCloseTo(2.5);
    expect(r.score).toBeCloseTo(82.5);
  });

  it("ignores Item Quantity entirely", () => {
    expect(computeCompositeScore(stats({ quantity: 200 })).score).toBe(10);
  });

  it("gives no bonus to a secondary stat below the ok tier", () => {
    // Monster Rarity 10 = 9.5% of its 105 ceiling: weak, no bonus.
    const r = computeCompositeScore(stats({ itemRarity: 60, monsterRarity: 10 }));
    expect(r.bonus).toBe(0);
  });

  it("raises Waystone Drop Chance's legendary bar to 70% of its ceiling", () => {
    // 100 raw = 64.5% of 155: legendary for any other stat, top here.
    expect(computeCompositeScore(stats({ waystoneDropChance: 100 })).dominant.tier).toBe("top");
    // 120 raw = 77.4% of 155.
    expect(computeCompositeScore(stats({ waystoneDropChance: 120 })).dominant.tier).toBe("legendary");
  });

  it("caps at 100 with every stat at its ceiling", () => {
    expect(computeCompositeScore(stats({ ...STAT_REFERENCES })).score).toBe(100);
  });

  it("never exceeds 100 even above the ceilings", () => {
    const over = stats({
      itemRarity: 500,
      monsterRarity: 500,
      packSize: 500,
      monsterEffectiveness: 500,
      waystoneDropChance: 900,
    });
    expect(computeCompositeScore(over).score).toBe(100);
  });
});

describe("evaluateMap", () => {
  it("skips a waystone below the threshold", () => {
    const r = evaluateMap(ZERO);
    expect(r.score).toBe(10);
    expect(r.decision).toBe("skip");
  });

  it("runs a waystone whose dominant stat is at least ok", () => {
    // Item Rarity 20 = 20% of its ceiling: ok tier, 25 points.
    const r = evaluateMap(stats({ itemRarity: 20 }));
    expect(r.score).toBe(25);
    expect(r.decision).toBe("run");
  });

  it("keeps score, rewardScore and effectiveScore identical", () => {
    const r = evaluateMap(stats({ packSize: 40, itemRarity: 50 }));
    expect(r.rewardScore).toBe(r.score);
    expect(r.effectiveScore).toBe(r.score);
    expect(r.baseScore + r.synergyBonus).toBeCloseTo(r.score);
  });

  it("never lets danger lower the score", () => {
    const s = stats({ itemRarity: 60 });
    const clean = evaluateMap(s, "");
    const dangerous = evaluateMap(s, "Monsters reflect 18% of Elemental Damage\nPlayers cannot Regenerate Life");
    expect(dangerous.dangerHits.length).toBeGreaterThan(0);
    expect(dangerous.score).toBe(clean.score);
  });
});

describe("danger detection (real PoE2 wording)", () => {
  const ids = (text: string) => detectDangerHits(text).map((h) => h.id);

  it.each([
    ["Monsters reflect 18% of Elemental Damage", "reflect-damage"],
    ["Players cannot Regenerate Life, Mana or Energy Shield", "no-regeneration"],
    ["Players have 40% less Recovery Rate of Life and Energy Shield", "reduced-recovery"],
    ["-12% maximum Player Resistances", "lowered-max-resistances"],
    ["Monsters fire 2 additional Projectiles", "additional-projectiles"],
    ["Players are Cursed with Temporal Chains", "player-curses"],
    ["Monsters deal 30% of Damage as Extra Fire", "extra-elemental-damage"],
    ["Monsters have 25% increased Attack Speed", "fast-monsters"],
    ["Monsters Penetrate 15% Elemental Resistances", "elemental-penetration"],
    ["Monsters have 300% increased Critical Hit Chance", "high-crit-monsters"],
  ])("detects %s", (text, id) => {
    expect(ids(text)).toContain(id);
  });

  it("does not read a defensive crit mod as monsters critting you", () => {
    expect(ids("Monsters take 30% reduced Extra Damage from Critical Hits")).not.toContain("high-crit-monsters");
  });

  it("finds nothing in plain loot mods", () => {
    expect(ids("20% increased Rarity of Items found\n15% increased Pack Size")).toEqual([]);
  });
});

describe("computeDangerLevel", () => {
  const hits = (severities: DangerHit["severity"][]): DangerHit[] =>
    severities.map((severity, i) => ({ id: `x${i}`, severity }));

  it.each<[DangerHit["severity"][], string]>([
    [[], "none"],
    [["minor"], "low"],
    [["moderate"], "low"],
    [["moderate", "moderate"], "medium"],
    [["strong"], "medium"],
    [["strong", "minor", "minor"], "high"],
    [["reflect"], "high"],
  ])("%s gives %s", (severities, level) => {
    expect(computeDangerLevel(hits(severities))).toBe(level);
  });
});

describe("dangerHitsToWarnings", () => {
  it("sorts labels most-severe first", () => {
    const found = detectDangerHits("Players are Cursed with Enfeeble\nMonsters reflect 10% of Physical Damage");
    expect(dangerHitsToWarnings(found)).toEqual(["Reflect Damage", "Cursed Players"]);
  });
});

describe("positive mods and modifier kinds", () => {
  it("detects extra rare monsters as a bonus", () => {
    const reasons = detectPositiveMods("25% increased number of Rare Monsters").map((b) => b.reason);
    expect(reasons).toContain("more rare monsters");
  });

  it.each([
    ["Monsters reflect 18% of Elemental Damage", "danger"],
    ["20% increased Rarity of Items found", "positive"],
    ["Area is inhabited by Goatmen", "neutral"],
  ])("%s is %s", (text, kind) => {
    expect(classifyModifierKind(text)).toBe(kind);
  });
});
