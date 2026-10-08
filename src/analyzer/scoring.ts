/** Juice Score engine for PoE2 waystones.
 *
 *  The actual score (`rewardScore`/`effectiveScore`/`score`) is a
 *  DOMINANT-STAT model (2026-07-1x redesign, user's own gameplay judgment —
 *  "basé sur sa plus grosse stat, et des petits bonus si y'a d'autres stats
 *  intéressantes"): find the waystone's single strongest stat (normalized
 *  against its own realistic ceiling — see `STAT_REFERENCES`, sourced
 *  2026-07-11 from the user's own observed market min/max per stat), tier
 *  the RESULT with the same 15/25/50 THRESHOLD NUMBERS as mechanic/tablet
 *  fit (`mechanics.ts`'s `tierForPercent`), and add a small bonus for every
 *  OTHER stat that also clears "ok". See `computeCompositeScore` below.
 *
 *  Sharing those threshold numbers does NOT make this the same measurement
 *  as a mechanic's own fit, though — they're deliberately answering two
 *  different questions on two different scales. A mechanic's fit
 *  (`mechanics.ts`'s `priorityStatTier`) tiers a stat's RAW %, i.e. "is this
 *  roll strong in absolute terms". This dominant-stat model tiers the
 *  NORMALIZED %, i.e. "how close is this roll to that stat's own realistic
 *  ceiling" — necessary here since picking a fair "dominant" stat across
 *  differently-capped stats (Pack Size caps ~65%, Monster Effectiveness
 *  ~70%, see `STAT_REFERENCES`) only works on a comparable scale. Since
 *  normalizing raises the effective value for any stat whose ceiling is
 *  below 100, the SAME raw roll can legitimately land in a higher tier here
 *  than it does for its own mechanic's fit (e.g. +40% Monster Effectiveness
 *  is "top" for Breach's raw-% fit but "legendary" for the headline score's
 *  normalized reading) — that's expected, not a bug to chase, if you're
 *  ever comparing the two side by side. This replaces the 2026-07-06 weighted-sum
 *  model (6 signals incl. a mechanic-density term, each capped and summed,
 *  then scaled by multiplicative mechanic/Pack-Size synergy) — that model
 *  was found to average away genuinely strong individual stats (a real
 *  waystone with +80% Drop Chance and +55% Item Rarity but nothing else
 *  landed in the "MOYEN" band) and had accreted layers (synergy multipliers,
 *  a soft overflow cap) that were hard to reason about together.
 *
 *  `breakdown`/`bonusDetails` (from the legacy `Weights`-per-field model and
 *  `POSITIVE_MOD_PATTERNS`) are kept ONLY as a display breakdown for the UI
 *  (heat.breakdown chips, key factors, "Bonus: ..." insights in adapter.ts)
 *  — they no longer feed the actual score. Any resemblance between their
 *  numbers and `score` is coincidental.
 *
 *  Item Quantity (`ModStats.quantity`) is not one of the scored signals: it
 *  skewed results when weighted in (2026-07-06) and isn't part of the
 *  cahier des charges' 5 signals. It's still parsed (mod-parser.ts) and
 *  still used by the Mechanic Match Score, but only as Expedition's own
 *  `priorityStat` (mechanics.ts) — every mechanic's `secondaryStats` (which
 *  used to include quantity for a few more) stopped factoring into scoring
 *  entirely on 2026-07-10, per `priorityStatTier`'s own doc comment; Heist/
 *  Harvest, the other two mechanics that once read it, were removed the
 *  same day. Only the Juice Score ignores quantity outright.
 *
 *  Danger/annoyance mods (reflect, no leech/regen, reduced recovery, fast
 *  monsters, elemental penetration, ...) are detected here too, but surface
 *  for display ONLY (`warning`/`warnings`/`dangerLevel`/`dangerLabel` — the
 *  Insights column). They never affect the score: the score measures loot
 *  value on paper, and danger is the player's call (2026-07-08 decision,
 *  reverting the short-lived 2026-07-06 ×0.7-0.95 danger multiplier on
 *  `effectiveScore`). */

import { PATTERNS as NUMERIC_PATTERNS, type ModStats } from "./mod-parser";
import { MECHANIC_PATTERNS, EXTRA_CONTENT_BONUS } from "./mechanic-patterns";
import { getGameData, onGameData, type GameData } from "./game-data";
import { TIER_SCORE, tierForPercent, type StatTier } from "./mechanics";

export interface Weights {
  itemRarity: number;
  monsterRarity: number;
  packSize: number;
  monsterEffectiveness: number;
  waystoneDropChance: number;
}

// Per-stat ceiling applied before weighting, for the LEGACY display-only
// breakdown only (see file-level comment) — keeps it stable and normalized
// even if a garbled outlier value gets parsed. Not used by the actual score.
const CAPS: Record<keyof Weights, number> = {
  itemRarity: 200,
  monsterRarity: 100,
  packSize: 150,
  monsterEffectiveness: 100,
  waystoneDropChance: 100,
};

// Weight = (max points this field can contribute at its cap) / cap, for the
// legacy display breakdown (`EvaluationResult.breakdown`, UI-only — see
// file-level comment). NOT used by `rewardScore`/`effectiveScore`/`score`.
//
// Display-only, so these weights and CAPS stay in code. Everything that
// tracks the game (stat ceilings, SKIP threshold, danger/positive patterns)
// lives in data/game-data.json and can change without a rebuild.
// Key order here drives the Heat Breakdown UI's row order (breakdownFields
// iterates Object.keys(weights)) — matches the real in-game stat order
// (2026-07-12, user report), not the Weights/ModStats type declaration
// order above.
export const DEFAULT_WEIGHTS: Weights = {
  itemRarity: 22 / CAPS.itemRarity,
  packSize: 22 / CAPS.packSize,
  monsterRarity: 20 / CAPS.monsterRarity,
  monsterEffectiveness: 16 / CAPS.monsterEffectiveness,
  waystoneDropChance: 10 / CAPS.waystoneDropChance,
};

/** Below this score: SKIP (§9). Read at call time, it follows game data. */
export function skipThreshold(): number {
  return getGameData().scoring.skipThreshold;
}

// Danger/annoyance mods — detected for display only (`warning`/`warnings`/
// `dangerLevel`); they never affect the score.
// `id` is a stable internal key (never shown to the user, never changes with
// wording/localization); `label` is the current UI-facing text, looked up
// from `id` only when building `warnings` for display. This split is
// deliberate: `dangerLevel` is computed from `severity` (via `DangerHit[]`,
// see below) and must never depend on `label` — renaming/relocalizing a
// label can't silently change danger logic.
//
// `severity` feeds `computeDangerLevel` below; "reflect" is its own tier
// (heavily weighted, see computeDangerLevel); "strong" mods actively hurt
// survivability/leech (crit/penetration/speed/no-leech/no-regen); "moderate"
// slow the loop without threatening it; "minor" is cosmetic annoyance.
export type { DangerSeverity } from "./game-data";
import type { DangerSeverity } from "./game-data";
let DANGER_PATTERNS: GameData["dangerPatterns"] = [];

// Duplicate ids are rejected by parseGameData (game-data.ts).
let DANGER_LABEL_BY_ID: Record<string, string> = {};

// Exported so adapter.ts can sort DangerHit[] by the same domain order when
// building its UI-facing view (DangerHitView), without either duplicating
// this comparator or scoring.ts knowing about UI severity tiers.
export const DANGER_SEVERITY_ORDER: Record<DangerSeverity, number> = { reflect: 0, strong: 1, moderate: 2, minor: 3 };

// Positive mods: signals that increase profit/hour beyond what the raw
// stat numbers already capture. Display-only (see file-level comment) —
// feeds `bonusDetails`/the UI's "Bonus: ..." insights and heat.breakdown's
// bonus row, NOT the actual score. The 4 "extra content: X" entries are
// derived from the shared EXTRA_CONTENT_BONUS/MECHANIC_PATTERNS
// (mechanic-patterns.ts) — order preserved (ritual, breach, delirium,
// expedition after the 2 monster entries) since it drives display order.
let POSITIVE_MOD_PATTERNS: Record<string, [RegExp, number]> = {};

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

// The 5 cahier-des-charges signals, keyed the same as `Weights`/`ModStats`.
type StatSignal = keyof Weights;
const STAT_SIGNALS: StatSignal[] = [
  "itemRarity",
  "monsterRarity",
  "packSize",
  "monsterEffectiveness",
  "waystoneDropChance",
];

// Each stat's realistic ceiling, used only to compare stats of different
// natural ranges before picking the biggest one (data/SOURCES.md).
export const STAT_REFERENCES = {} as Record<StatSignal, number>;

// Max bonus a single non-dominant stat can add, scaled by how close it is to
// its own ceiling (data/SOURCES.md).
let SECONDARY_BONUS_CAP = 0;

// Per-stat legendary bar for the DOMINANT stat only (data/SOURCES.md).
let DOMINANT_LEGENDARY_OVERRIDE: Partial<Record<StatSignal, number>> = {};

function dominantTierFor(key: StatSignal, normalizedPercent: number): StatTier {
  const legendaryAt = DOMINANT_LEGENDARY_OVERRIDE[key] ?? 50;
  if (normalizedPercent < 15) return "weak";
  if (normalizedPercent < 25) return "ok";
  if (normalizedPercent < legendaryAt) return "top";
  return "legendary";
}

// Rebuilds every table above from the current game data (built-in, then any
// newer remote copy). MECHANIC_PATTERNS/EXTRA_CONTENT_BONUS are refreshed
// first since mechanic-patterns.ts registered its hook before this module.
onGameData((d) => {
  DANGER_PATTERNS = d.dangerPatterns;
  DANGER_LABEL_BY_ID = Object.fromEntries(d.dangerPatterns.map((x) => [x.id, x.label]));
  POSITIVE_MOD_PATTERNS = {
    ...Object.fromEntries(d.positivePatterns.map((p) => [p.reason, [p.pattern, p.bonus] as [RegExp, number]])),
    ...Object.fromEntries(
      Object.entries(EXTRA_CONTENT_BONUS).map(([id, bonus]) => [
        `extra content: ${id}`,
        [MECHANIC_PATTERNS[id], bonus] as [RegExp, number],
      ]),
    ),
  };
  Object.assign(STAT_REFERENCES, d.scoring.statReferences);
  SECONDARY_BONUS_CAP = d.scoring.secondaryBonusCap;
  DOMINANT_LEGENDARY_OVERRIDE = d.scoring.dominantLegendaryOverride;
});

interface DominantStat {
  key: StatSignal;
  normalizedPercent: number;
  tier: StatTier;
}

/** The waystone's single strongest stat, tiered, plus a small bonus for
 *  every other stat that also clears "ok" — see the file-level comment for
 *  why. `normalizedPercent` is "how close to this stat's own ceiling", not
 *  the raw %, so it's only meaningful for comparing stats against each
 *  other, never shown to the player directly.
 *
 *  Exported (2026-07-12) so adapter.ts's `rankTablets`/`computeMechanicScores`
 *  can reuse it as the General/Overseer tablet's fit — no mechanic reads
 *  Waystone Drop Chance as its priority stat (the other four each have at
 *  least one), so without this a Drop-Chance-dominant waystone (the most
 *  common real case per the 2026-07-11 6-waystone sample) would never fit
 *  ANY tablet well, even though the map itself is genuinely juicy. */
export function computeCompositeScore(stats: ModStats): { score: number; dominant: DominantStat; bonus: number } {
  const candidates = STAT_SIGNALS.map((key) => ({
    key,
    normalizedPercent: ((stats[key] ?? 0) / STAT_REFERENCES[key]) * 100,
  }));
  const dominant = candidates.reduce((best, c) => (c.normalizedPercent > best.normalizedPercent ? c : best));
  const dominantTier = dominantTierFor(dominant.key, dominant.normalizedPercent);

  const bonus = candidates
    .filter((c) => c.key !== dominant.key && tierForPercent(c.normalizedPercent) !== "weak")
    .reduce((sum, c) => sum + clamp01(c.normalizedPercent / 100) * SECONDARY_BONUS_CAP, 0);

  const score = Math.max(0, Math.min(100, TIER_SCORE[dominantTier] + bonus));
  return { score, dominant: { key: dominant.key, normalizedPercent: dominant.normalizedPercent, tier: dominantTier }, bonus };
}

export interface FieldContribution {
  rawValue: number;
  cappedValue: number;
  weight: number;
  contribution: number;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// LEGACY per-field breakdown — display only (see file-level comment). Does
// NOT feed `rewardScore`/`effectiveScore`/`score`.
function breakdownFields(
  stats: ModStats,
  weights: Weights,
  caps: Record<keyof Weights, number>,
): Record<keyof Weights, FieldContribution> {
  const out = {} as Record<keyof Weights, FieldContribution>;
  for (const field of Object.keys(weights) as (keyof Weights)[]) {
    const rawValue = stats[field] ?? 0;
    const cappedValue = Math.min(rawValue, caps[field]);
    const weight = weights[field];
    out[field] = { rawValue, cappedValue, weight, contribution: round2(cappedValue * weight) };
  }
  return out;
}

export interface BonusDetail {
  reason: string;
  bonus: number;
}

/** Internal, string-decoupled unit of danger detection: `id` is a stable key
 *  (never user-facing), `severity` is what all danger logic (currently just
 *  `computeDangerLevel`) reasons over. Never derive danger logic from
 *  `warnings`/labels — always from `DangerHit[]`. */
export interface DangerHit {
  id: string;
  severity: DangerSeverity;
}

/** All matched danger/annoyance mods on this map, in pattern-table order. */
export function detectDangerHits(text: string): DangerHit[] {
  if (!text) return [];
  return DANGER_PATTERNS.filter((d) => d.pattern.test(text)).map((d) => ({ id: d.id, severity: d.severity }));
}

/** `DangerHit[]` → UI-facing label strings, sorted most-severe-first
 *  (reflect > strong > moderate > minor). This is the ONLY place a hit's
 *  `id` is translated to display text — nothing upstream of this should
 *  need the label. */
export function dangerHitsToWarnings(hits: DangerHit[]): string[] {
  return [...hits]
    .sort((a, b) => DANGER_SEVERITY_ORDER[a.severity] - DANGER_SEVERITY_ORDER[b.severity])
    .map((h) => DANGER_LABEL_BY_ID[h.id] ?? h.id);
}

export type DangerLevel = "none" | "low" | "medium" | "high";

/** Derives an at-a-glance danger signal from `DangerHit[]` — `severity`
 *  only, never a label/warning string, so renaming or relocalizing a
 *  warning can never change this. Also never derived from raw text,
 *  keeping it fully independent of danger *detection*. Deliberately
 *  simple, evaluated most-severe-first:
 *  - "high": any "reflect" hit, or 3+ hits with at least one "strong" one
 *    (crit/penetration/fast-monsters/no-leech/no-regen).
 *  - "medium": any single "strong" hit, or 2+ "moderate" ones.
 *  - "low": anything left over (a single moderate/minor hit).
 *  - "none": no hits at all. */
export function computeDangerLevel(hits: DangerHit[]): DangerLevel {
  if (hits.length === 0) return "none";

  const hasReflect = hits.some((h) => h.severity === "reflect");
  const strongCount = hits.filter((h) => h.severity === "strong").length;
  const moderateCount = hits.filter((h) => h.severity === "moderate").length;

  if (hasReflect) return "high";
  if (hits.length >= 3 && strongCount >= 1) return "high";
  if (strongCount >= 1) return "medium";
  if (moderateCount >= 2) return "medium";
  return "low";
}

/** Classifies a single raw modifier line for display (§5 modifiers[].kind). */
export function classifyModifierKind(text: string): "positive" | "neutral" | "danger" {
  for (const { pattern } of DANGER_PATTERNS) {
    if (pattern.test(text)) return "danger";
  }
  for (const [pattern] of Object.values(POSITIVE_MOD_PATTERNS)) {
    if (pattern.test(text)) return "positive";
  }
  for (const pattern of Object.values(NUMERIC_PATTERNS)) {
    if (pattern.test(text)) return "positive";
  }
  return "neutral";
}

export function detectPositiveMods(text: string): BonusDetail[] {
  if (!text) return [];
  const details: BonusDetail[] = [];
  for (const [reason, [pattern, bonus]] of Object.entries(POSITIVE_MOD_PATTERNS)) {
    if (pattern.test(text)) details.push({ reason, bonus });
  }
  return details;
}

export interface EvaluationResult {
  /** Final score, thresholded on for `decision` — equal to `effectiveScore`.
   *  Kept as its own field (rather than dropped in favor of just
   *  `effectiveScore`) for backward compatibility with existing callers. */
  score: number;
  decision: "run" | "skip";
  /** LEGACY per-field breakdown (display only — heat.breakdown/keyFactors in
   *  adapter.ts). Computed from the old flat `Weights`/`CAPS` model, fully
   *  decoupled from `score`/`rewardScore`/`effectiveScore` below — it will
   *  NOT sum to them. */
  breakdown: Record<keyof Weights, FieldContribution>;
  /** LEGACY positive-mod bonuses (display only — adapter.ts's "Bonus: ..."
   *  insights and heat.breakdown's bonus row). Not applied to the score. */
  bonusDetails: BonusDetail[];
  /** Danger/annoyance mods detected on this map (structured, string-free) —
   *  feeds `warning`/`warnings`/`dangerLevel` display only; never affects
   *  any score field. */
  dangerHits: DangerHit[];
  /** The real score: the dominant stat's tier score plus the secondary-stat
   *  bonus (`computeCompositeScore`) — "how good is this map on paper",
   *  ignoring danger. Naturally bounded to [0, 100] by construction (no
   *  overshoot, unlike the old multiplicative-synergy model), so this is
   *  already equal to `effectiveScore`/`score`. */
  rewardScore: number;
  /** Same value as `rewardScore`/`score`. Kept as its own field for
   *  backward compatibility from when it also carried a danger multiplier
   *  (removed 2026-07-08 — danger is display-only) and a soft overflow cap
   *  (removed 2026-07-1x — the new model can't overshoot 100). */
  effectiveScore: number;
  /** The dominant stat's tier score (10/25/55/80, `mechanics.ts`'s
   *  `TIER_SCORE`) alone, before the secondary-stat bonus — for display
   *  layers that want to show "main stat vs. bonus" as separate numbers
   *  (see displayAdapter.ts) instead of re-deriving them from scratch. */
  baseScore: number;
  /** The secondary-stat bonus alone (`rewardScore` - `baseScore`) — every
   *  other stat that also cleared "ok", each contributing up to
   *  `SECONDARY_BONUS_CAP` scaled by how close it is to its own ceiling.
   *  Always >= 0. */
  synergyBonus: number;
}

/** Composite Juice Score (2026-07-1x dominant-stat redesign — see the
 *  file-level comment for the "why"): `computeCompositeScore` finds the
 *  waystone's single strongest stat (normalized against its own realistic
 *  ceiling), tiers it (same 15/25/50 boundaries as mechanic/tablet fit),
 *  and adds a small bonus for every other stat that's also at least "ok".
 *  Bounded to [0, 100] by construction — `rewardScore`/`effectiveScore`/
 *  `score` are all the same number now (kept as separate fields for
 *  backward compatibility, see their own doc comments). Danger mods never
 *  reduce the score — they surface as display-only warnings (see the
 *  file-level comment). `breakdown`/`bonusDetails` are still computed from
 *  the old flat model, but purely for UI display now — see the file-level
 *  comment.
 *
 *  `contentText` (parser.ts's `ParsedWaystone.contentText` — every block
 *  except the header) is what positive-mod/danger keyword matching runs
 *  against, so the item's own NAME can never false-positive a match
 *  (KNOWN_ISSUES #4's follow-up, 2026-07-08). */
export function evaluateMap(
  stats: ModStats,
  contentText = "",
  weights: Weights = DEFAULT_WEIGHTS,
  threshold: number = skipThreshold(),
): EvaluationResult {
  const breakdown = breakdownFields(stats, weights, CAPS);
  const bonusDetails = detectPositiveMods(contentText);
  const dangerHits = detectDangerHits(contentText);

  const { score: composite, dominant, bonus } = computeCompositeScore(stats);
  const rewardScore = round2(composite);
  const effectiveScore = rewardScore;
  const score = effectiveScore;
  const decision = score >= threshold ? "run" : "skip";
  const baseScore = round2(TIER_SCORE[dominant.tier]);
  const synergyBonus = round2(bonus);

  return {
    score,
    decision,
    breakdown,
    bonusDetails,
    dangerHits,
    rewardScore,
    effectiveScore,
    baseScore,
    synergyBonus,
  };
}
