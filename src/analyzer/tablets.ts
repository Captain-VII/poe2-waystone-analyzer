/** Tablet definitions (cahier des charges §2). Data-driven: each tablet
 *  declares its stat boosts as plain PoE2-style mod text (e.g. "30%
 *  increased Monster Effectiveness"), parsed through `mod-parser.ts`'s
 *  already-tolerant regex — the same matcher proven against real waystone
 *  text — instead of a second hand-rolled parser. `meta-config.ts` overlays
 *  user tablets from meta.json on top of `DEFAULT_TABLETS` at load time,
 *  same pattern as mechanics.ts, so adding a tablet never requires a code
 *  change or rebuild.
 *
 *  Tablets are matched to mechanics by stat-fit (`scoreMechanicFit` in
 *  mechanics.ts), not by name — a new tablet is automatically eligible for
 *  every mechanic its boosts fit, with no `recommendedTablets` list to
 *  maintain per mechanic.
 *
 *  **Re-verified 2026-07-12 against a real data-mined source:**
 *  repoe-fork.github.io/poe2/mods.json (a fork of the RePoE tool-dev data
 *  export, `"domain": "tablet"` entries — genuinely mined from the game's
 *  files, not a wiki summary). This corrected two things earlier passes
 *  got wrong from wiki/poe2db.tw sourcing:
 *  1. **"Standard Precursor Tablet" was never real** — the data-mined
 *     source has an implicit "Adds [mechanic] to a Map" mod for exactly
 *     **eight** real base types — Breach, Ritual, Delirium, Expedition,
 *     Irradiated, Overseer, Abyss, Temple (Temple = Incursion/Vaal
 *     Beacons internally) — no generic ninth type. Removed outright
 *     rather than kept as a plausible-looking fiction. Legion, Heist,
 *     Sanctum, Harvest, Metamorph, Essence, and Bestiary still have no
 *     dedicated tablet at all (a `mechanics.ts` fact, not a gap here —
 *     see KNOWN_ISSUES.md #2).
 *  2. **"Every real tablet is Magic rarity, 1 prefix + 1 suffix max" was
 *     wrong** — two real in-game item texts (pasted by the user) proved a
 *     Normal-rarity tablet has *zero* mods (just the base "Adds
 *     [mechanic] to a Map, 10 uses" implicit) while a well-rolled Rare
 *     tablet can carry **4** (2 prefixes + 2 suffixes). Each `mods` entry
 *     below now represents a well-rolled Rare tablet — up to 2 prefix + 2
 *     suffix lines — not an exhaustive roll table, and not every possible
 *     combination (a real tablet still only has 2 of each at once). All
 *     four shared-pool prefixes (Item Rarity/Monster Rarity/Pack
 *     Size/Monster Effectiveness) are available to every one of the eight
 *     real tablets equally; when a slot has more tracked-stat options than
 *     it has room for, the ones picked are a reasoned, mechanic-themed
 *     choice (documented per entry) in the absence of market data on
 *     which roll players actually prioritize — a user with a differently-
 *     rolled real tablet overrides it via meta.json's "tablets" array.
 *     Duplicating a stat key across two lines on the same tablet is
 *     avoided on purpose: `mod-parser.ts` keeps the max value per stat
 *     across all lines, not a sum, so a repeated key would just waste a
 *     slot. The mechanic-specific types' real value is also partly in
 *     mechanic-specific currency (Breach Splinters, Expedition
 *     Artifacts/Logbooks, Ritual Tribute, Delirium Simulacrum Splinters)
 *     — that's what `rewards` (rewards.ts) represents, kept separate from
 *     `mods`.
 *
 *  Every real per-tablet pool includes plenty of mods outside this app's
 *  six tracked stats (Experience, Gold, monster/rare-monster *density*
 *  rather than rarity%, chest/Essence/Shrine/Strongbox chance, mechanic-
 *  scoped effects like "Effectiveness of Rare Breach Monsters") —
 *  deliberately left out, not a gap (see KNOWN_ISSUES.md #2). Replace any
 *  entry's exact mod wording once a more precise/updated source turns up;
 *  no other code needs to change either way. */

import { parseMods } from "./mod-parser";
import { computeRewardScore, type Reward } from "./rewards";
import type { StatKey } from "./mechanics";
import { onGameData } from "./game-data";

/** The shape read from `default-tablets.json` / meta.json's `"tablets"`
 *  array — plain data, no parsed boosts yet. */
export interface RawTabletDef {
  name: string;
  /** Raw mod lines, PoE2 item-text style. Parsed via `parseMods`. */
  mods: string[];
  /** Free-form grouping (e.g. league name) — informational only today,
   *  available for future filtering/UI without a schema change. */
  tags?: string[];
  /** Defaults to true. Set false (in meta.json) to hide a default tablet
   *  without deleting its definition. */
  enabled?: boolean;
  /** Value beyond the six generic stats — mechanic-specific currency, a
   *  named mechanic's own worth, or a flat score (see rewards.ts).
   *  Optional: a tablet without `rewards` is ranked purely on `mods`,
   *  exactly as before this feature existed. */
  rewards?: Reward[];
  /** How reliable this entry's `mods`/`rewards` data is, not whether the
   *  tablet itself exists in-game. Defaults to `"medium"` when omitted
   *  (`hydrate()`). Informational only today — available for future
   *  filtering/UI without another schema change, same as `tags`. */
  confidence?: "high" | "medium" | "low";
  /** Where the data came from. `"wiki"` = triangulated against
   *  community wiki/guide text (poe2wiki.net/maxroll.gg/odealo.com);
   *  `"poe2db"` = data-mined game files (confirms the item exists, not
   *  necessarily exact affix wording); `"community"` = a single
   *  community source, unconfirmed elsewhere; `"manual"` = hand-guessed,
   *  not checked against any source. */
  source?: "wiki" | "poe2db" | "community" | "manual";
}

export interface TabletDef extends RawTabletDef {
  enabled: boolean;
  /** `mods` parsed once at load time into numeric stat boosts. */
  boosts: Partial<Record<StatKey, number>>;
  /** `rewards` summed once at load time via `computeRewardScore`. 0 when
   *  `rewards` is absent — adds nothing to ranking, same as before. */
  rewardScore: number;
  /** Resolved default for `confidence` — always set, never undefined. */
  confidence: "high" | "medium" | "low";
}

// Bundled defaults. Extend this list, or (preferred, no rebuild needed) add
// entries to the user's meta.json "tablets" array — see meta-config.ts.
// Filled from game data (data/game-data.json, tablets); per-tablet sourcing
// (real roll ranges, which stats were picked and why) is in data/SOURCES.md.
export const DEFAULT_TABLETS: RawTabletDef[] = [];

function toBoosts(mods: string[]): Partial<Record<StatKey, number>> {
  const parsed = parseMods(mods.join("\n"));
  const boosts: Partial<Record<StatKey, number>> = {};
  for (const key of Object.keys(parsed) as StatKey[]) {
    if (parsed[key] > 0) boosts[key] = parsed[key];
  }
  return boosts;
}

function hydrate(raw: RawTabletDef): TabletDef {
  return {
    ...raw,
    enabled: raw.enabled ?? true,
    boosts: toBoosts(raw.mods),
    rewardScore: computeRewardScore(raw.rewards),
    confidence: raw.confidence ?? "medium",
  };
}

/** Tablet names this app used to ship that the game has since renamed
 *  (lowercased old name -> current name). Applied to meta.json and pinned
 *  tablets on load, so a player's customizations follow the rename instead
 *  of silently turning into an orphaned "custom" tablet. "Overseer
 *  Precursor Tablet" is "Overseer Tablet" in the game's own base-item data
 *  (re-checked 2026-10-08 against repoe-fork.github.io/poe2/base_items.json). */
const LEGACY_TABLET_NAMES: Record<string, string> = {
  "overseer precursor tablet": "Overseer Tablet",
};

export function canonicalTabletName(name: string): string {
  return LEGACY_TABLET_NAMES[name.toLowerCase()] ?? name;
}

let active: TabletDef[] = DEFAULT_TABLETS.map(hydrate);

onGameData((d) => {
  DEFAULT_TABLETS.splice(0, DEFAULT_TABLETS.length, ...d.tablets);
  active = DEFAULT_TABLETS.map(hydrate);
});

/** Overlays meta-config.ts's parsed meta.json tablets onto the bundled
 *  defaults — read by adapter.ts's rankTablets instead of DEFAULT_TABLETS
 *  directly, so a user edit takes effect without a rebuild. */
export function setActiveTablets(overrides: RawTabletDef[]): void {
  active = overrides.map(hydrate);
}

/** Enabled tablets only — disabled ones stay defined but excluded from
 *  ranking/recommendation. */
export function getActiveTablets(): TabletDef[] {
  return active.filter((t) => t.enabled);
}

export function findTablet(name: string): TabletDef | undefined {
  return active.find((t) => t.name === name);
}
