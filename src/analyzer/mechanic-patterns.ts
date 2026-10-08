/** Single source of truth for "is mechanic X present on this map" keyword
 *  regexes — two consumers used to keep their own copies that could
 *  silently drift apart (KNOWN_ISSUES #4's refactor, 2026-07-08):
 *  - `mechanics.ts`'s `MechanicDef.detect` (the mechanic-match bonus)
 *  - `scoring.ts`'s `POSITIVE_MOD_PATTERNS` ("extra content: X" display
 *    bonuses)
 *  Both now read from `MECHANIC_PATTERNS` below, so a wording fix (e.g. a
 *  plural) only needs to happen once. Every consumer runs these against
 *  `ParsedWaystone.contentText` (parser.ts) — every block except the
 *  header, so the item's own NAME can never false-positive a match.
 *
 *  2026-07-10: Heist/Sanctum/Harvest/Metamorph/Incursion/Bestiary were
 *  removed — no real PoE2 tablet (mechanics.ts's `MechanicDef` entries for
 *  them were cut the same day) and no other consumer either. Blight/
 *  Legion/Essence survived that pass (they fed the Juice Score's mechanic-
 *  density term) but that term itself was cut in the 2026-07-1x composite-
 *  score rework (dominant-stat-plus-bonus model, scoring.ts) — with no
 *  tablet and no other consumer left, they're pure dead weight now too. */

import { onGameData } from "./game-data";

// Filled from game data (data/game-data.json, mechanicPatterns): mutated in
// place so every importer keeps the same object.
export const MECHANIC_PATTERNS: Record<string, RegExp> = {};

/** Display-only "extra content: X" bonus points (scoring.ts's
 *  POSITIVE_MOD_PATTERNS) — exact current membership + weights. Order
 *  matters: it drives bonusDetails/insights display order. */
export const EXTRA_CONTENT_BONUS: Record<string, number> = {};

function replaceRecord<T>(target: Record<string, T>, source: Record<string, T>): void {
  for (const k of Object.keys(target)) delete target[k];
  Object.assign(target, source);
}

onGameData((d) => {
  replaceRecord(MECHANIC_PATTERNS, d.mechanicPatterns);
  replaceRecord(EXTRA_CONTENT_BONUS, d.extraContentBonus);
});
