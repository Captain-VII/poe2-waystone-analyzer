# Game data sources

## Updating game data without a release

`data/game-data.json` holds everything that tracks the game: stat ceilings,
the SKIP threshold, danger and bonus mod patterns, mechanics, tablets. The app
bundles it, and at every start also fetches the copy on `main` from
`raw.githubusercontent.com`. To change data for every player:

1. Edit `data/game-data.json` (patterns are regex sources, always matched
   case-insensitive).
2. **Bump `revision`** by 1. Apps only adopt a copy with a higher revision
   than the one they have; an edit without a bump is ignored.
3. Update the matching note below.
4. Run `npm test` (validates the file), open a PR, merge to `main`.

Players get it on their next app start. An invalid or older file is ignored
and logged (`tag: "game-data"` in Export Logs); the app keeps its current
data. Their own meta.json still applies on top. A new mechanic or a new stat
needs code (icons, Atlas Masters, mod parsing) and therefore a release.


## Provenance

Provenance notes for `data/game-data.json`, moved out of the code when the
tables became data (2026-10-08). JSON has no comments, so the why behind
each value lives here. Update the matching note when you change a value,
and bump `revision` in the JSON.

## Scoring

**statReferences** (per-stat ceilings): Each stat's realistic ceiling — used ONLY to compare stats of very different natural ranges on a level footing before picking "the biggest one". Sourced 2026-07-11 from the user's own observation of the item market's min/max roll range per stat (not a web guide — explicitly "pas une vérité absolue" per the user, but the closest thing to real population data this project has had): Item Rarity 10-100%, Pack Size 6-63%, Monster Rarity 18-103%, Monster Effectiveness 13-70%, Waystone Drop Chance 10-155%. Ceilings below are those observed maxima, rounded up slightly for headroom (same "generous ceiling over a tight fit" policy used everywhere else in this file) — replaces the flat-100-for- everything guess from the 2026-07-11 Pack Size fix above, which was itself already known to be provisional. A stat below the market's own observed minimum doesn't need special-casing here: it simply doesn't appear as a mod line, so parseMods already reads it as 0.

**secondaryBonusCap**: Max bonus a single non-dominant stat can add, scaled by how close it is to its own ceiling (100% of ceiling = full +5). With at most 4 other stats, the composite score can't exceed legendary's 80 + 4*5 = 100 — no overflow cap needed, unlike the old multiplicative-synergy model.

**dominantLegendaryOverride**: Sourced 2026-07-11 from 6 real T15 waystones the user pasted: Waystone Drop Chance was the dominant stat in all 6, and cleared the shared 50% legendary boundary (~77.5% raw, out of its 155 ceiling) in 3 of them — a materially higher hit rate than any other stat individually reaching legendary in the same sample. Its real range (10-155%) is wider and skews toward high common rolls more than the other four. Its legendary bar alone is raised to 70% of ceiling (~108.5% raw); weak/ok/top stay on the shared 15/25/50 boundaries (tierForPercent), and the other four stats are untouched. Only the DOMINANT stat's tier is affected — a secondary stat's bonus eligibility (below) always uses the shared boundaries, since that's a different question ("is this stat at least decent") from "does the dominant stat deserve the top label".

**skipThreshold**: below this score the verdict is SKIP (cahier des charges §9).

## Danger patterns

Detected for display only, they never change the score. `severity` feeds the
danger level: `reflect` is its own tier, `strong` hurts survivability,
`moderate` slows the loop, `minor` is cosmetic. `id` is a stable key, `label`
is UI text; danger logic only ever reads `id`/`severity`.

- **reflect-damage**: Real PoE2 wording is "Monsters reflect 18% of Elemental Damage" — allow any short run of characters (the "18% of Elemental" part) between the verb and "damage", not just a single bare word.
- **no-regeneration**: Real PoE2 wording is "Players cannot Regenerate Life, Mana or Energy Shield" — "no ... regenerat" alone never matched it.
- **reduced-recovery**: Real PoE2 wording is "Players have X% less Recovery Rate of Life and Energy Shield" — "reduced ... recovery" alone never matched it.
- **high-crit-monsters**: Verb-scoped (have/gain/deal): the map suffix "Monsters take X% reduced Extra Damage from Critical Hits" is a *defensive* monster mod (annoying, not dangerous) and must not read as monsters critting you.
- **elemental-penetration**: Scoped to monster wording like its siblings: a bare /penetrat/ also matches player-side gear/passive lines ("Damage Penetrates ...") and resistance text, which are not map dangers.
- **extra-elemental-damage**: "Monsters deal 30% of Damage as Extra Fire" / "Monsters gain 20% of their Physical Damage as extra Chaos Damage".
- **lowered-max-resistances**: "-12% maximum Player Resistances" — the stat only ever appears on a waystone as this malus, so matching the stat name alone is safe.
- **additional-projectiles**: "Monsters fire 2 additional Projectiles"
- **player-curses**: "Players are Cursed with Elemental Weakness/Enfeeble/Temporal Chains"

## Mechanics

`priorityStat` drives the fit score; `detect` names a `mechanicPatterns` entry.

- **Delirium**: Community consensus 0.5 (switchbladegaming/timesaver/u4gm, 2026-07-06): pack size drives splinter throughput in the fog; rarity (140%+ target) and quantity (20-25%) scale what each fog kill is worth.
- **Expedition**: Community consensus 0.5 (maxroll/aoeah/timesaver, 2026-07-06): logbook artifact quantity is the money stat, then runic/rare monster spawns; pack size only helps chain detonations.
- **Abyss**: Reverted 2026-07-10 (same day, later): the 2026-07-10 packSize-priority change above (Fubgun's Jado/Hilda strats) was contradicted by two independent sources found on a real waystone bug report (Abyss Tablet scoring 35/100 despite +62% Monster Rarity): Mobalytics "Abyss Juicing Tablet Tier List" (Perra) — "Pack Size is considered bait... Rare Monster Modifier along with the Rarity of Items modifiers are most important" — and Switchblade Gaming's waystone-rolling priority for Abyss, "rare monster count → item quantity → monster effectiveness" (pack size/monster rarity explicitly assigned to other mechanics there). 2 sources against Fubgun's 1, and both converge with the Abyss Tablet's own real roll (tablets.ts: "15% increased Rarity of Monsters", written for the monsterRarity-priority model). "Rare monster count" isn't a tracked StatKey (KNOWN_ISSUES #2) — monsterRarity is the nearest tracked proxy, same convention used elsewhere. Two independent community sources converging, cross-checked against the Abyss Tablet's own real roll (tablets.ts) — a notch above the plain single-guide "community" entries below.
- **Ritual**: Community consensus 0.5 (mobalytics/exile.codex/aoeah, 2026-07-06): tribute scales with magic/rare monster count and pack density — item rarity does NOT affect ritual rewards, so it's dropped here.
- **Breach**: Fubgun 0.5 atlas strats (mobalytics, user-pasted tab text, 2026-07-10): waystone line reads "you're looking for high item rarity and high monster effectiveness", and among tablet mods "if you can only get one, choose monster effectiveness". Neither Monster Rarity nor Pack Size is mentioned — converges with the independent aoeah mirror ("pack size is irrelevant / monster rarity mostly wasted — rare monster count in a Breach is static", set by tablets, not map stats). Replaces the older switchbladegaming/aoeah/boostmatch consensus (monsterRarity priority). Single secondary on purpose — no padding with an explicitly-wasted stat. Two independent community sources converge (Fubgun's own tab text + an independent aoeah mirror) — same bar as Abyss above.
- **General**: Generic catch-all, not tied to any one strat guide's mechanic- specific numbers — hand-picked to be broadly reasonable.

## Tablets

Only the real base types in the game's data (RePoE `base_items.json`, class
`TowerAugmentation`) may be listed; `tablets.test.ts` enforces it. Each `mods`
list models a well-rolled Rare tablet (2 prefixes + 2 suffixes) using lines
`mod-parser.ts` can read.

- **Overseer Tablet**: Removed 2026-07-12: "Standard Precursor Tablet" was never a real PoE2 base item — the authoritative data-mined mod list (repoe-fork.github.io/poe2/mods.json, domain "tablet") only has implicit "Adds [mechanic] to a Map" mods for exactly eight real base types (Breach/Ritual/Delirium/Expedition/Irradiated/Overseer/Abyss Temple, i.e. Incursion) — no generic "Standard" one. Likely invented in an earlier pass; removed rather than kept as a plausible-looking fiction. Every real tablet (any of the eight) can roll from the same shared generic-stat pool this entry used, so nothing is lost — see each entry below. Drops from Map Bosses; boosts their own drops specifically. Re-sourced 2026-07-12 from repoe-fork.github.io/poe2/mods.json's real tablet mod pool (domain "tablet") — Overseer has two boss-scoped suffixes mapping onto tracked stats: Item Rarity of Map Boss drops (35-60%, was wrongly 20% from an older wiki-summary source) and Waystone Quantity from Map Bosses (18-30%, was wrongly 8%). Prefixes switched to Monster Effectiveness + Monster Rarity (both distinct from the two boss suffixes — the shared Item Rarity prefix would just be shadowed by the much bigger boss-scoped suffix on the same stat, since duplicate stat lines take the max, not a sum) at their shared-pool midpoints.
- **Breach Tablet**: Re-sourced 2026-07-12 from poe2db.tw's Modifiers Calc widget (pasted by the user) — Breach Tablet's real prefix pool includes Monster Effectiveness (10-15%), Item Rarity (8-12%), Pack Size (5-7%), and Monster Rarity (15-20%), but a real tablet only has 2 prefixes at once; picked Monster Rarity + Item Rarity (more rare/magic monsters = more Breach Splinters, same "rares carry the value" theme as Ritual below) at each range's midpoint. Suffix pool's two tracked-stat options: "Quantity of Waystones found in Map" (30-40%, = this app's waystoneDropChance, reworded to the existing "chance to drop a Waystone" phrasing so mod-parser.ts's regex catches it) and a Breach-scoped Pack Size roll (5-15%) — both used, midpoints. The rest of the real pool (Experience/Gold/chest-Essence-Shrine-Strongbox chance/rare-monster *count*/Breach-monster-specific effectiveness) is outside this app's six tracked stats, left out. Real mechanic- specific value (Splinters etc.) stays in `rewards` below, unchanged.
- **Ritual Tablet**: Re-sourced 2026-07-12 from repoe-fork.github.io/poe2/mods.json (data- mined, domain "tablet") — Ritual has no stat-mapped mechanic-specific suffix (its suffix pool is entirely Tribute/Favour/Omen-focused, see `rewards`), so its suffix falls back to the shared "Quantity of Waystones found in Map" line. Prefixes: Monster Rarity + Pack Size — both monster-count/rarity themed, matching the existing "tribute scales with magic/rare monster count, item rarity does NOT affect ritual rewards" research finding better than the old single-line version did. matches rewards.ts's MECHANIC_VALUES.ritual, the actual value used (see its own doc comment)
- **Delirium Tablet**: Re-sourced 2026-07-12 from repoe-fork.github.io/poe2/mods.json — real Delirium-scoped suffix "Delirium Monsters in Map have (15-30)% increased Pack Size" replaces the old made-up-sounding 8% guess. Prefixes (Item Rarity, Monster Effectiveness) deliberately avoid Pack Size again — duplicating a stat key across lines is wasted space, since `mod-parser.ts` keeps the max per stat, not a sum. matches rewards.ts's MECHANIC_VALUES.delirium, the actual value used (see its own doc comment)
- **Expedition Tablet**: Re-sourced 2026-07-12 from repoe-fork.github.io/poe2/mods.json — the old "10% increased Quantity of Items found" line didn't correspond to any real rollable tablet mod at all (no generic Item Quantity prefix exists in the real shared pool, only Rarity/Pack Size/Monster stats — likely an invented placeholder from an earlier pass). Expedition has no stat-mapped mechanic-specific suffix either (its pool is Artifact/Logbook/Remnant-focused, see `rewards`), so it falls back to the shared Waystone suffix like Ritual. Prefixes: Monster Effectiveness + Pack Size (more/tougher monsters near the dig site). matches rewards.ts's MECHANIC_VALUES.expedition, the actual value used (see its own doc comment)
- **Abyss Tablet**: Re-sourced 2026-07-12 from repoe-fork.github.io/poe2/mods.json — Abyss has no stat-mapped mechanic-specific suffix (its real suffixes are Abyssal-Depths/Modifier/Currency-focused, see `rewards`), falls back to the shared Waystone suffix. Prefixes keep Monster Rarity (loot comes from rares, pack size explicitly not recommended — the existing 0.5 research finding) and add Monster Effectiveness (stronger abyssal monsters, same "rares carry the value" theme).
- **Irradiated Tablet**: Re-sourced 2026-07-12 from repoe-fork.github.io/poe2/mods.json — Irradiated is confirmed to have NO mechanic-specific suffix pool at all (no "tower_augment_irradiated"-tagged mods exist anywhere in the 125-entry real tablet mod list — genuinely just a risk/reward map toggle), so it rolls purely from the shared generic pool: Item Rarity + Monster Rarity as prefixes, the shared Waystone line as suffix.
- **Temple Tablet**: Re-sourced 2026-07-12 from repoe-fork.github.io/poe2/mods.json — real base type is "Adds Vaal Beacons to a Map" (the mod data's internal id is "incursion", matching PoE1's Temple of Atzoatl lineage). No stat-mapped mechanic-specific suffix (its pool is Vaal-Beacon Monster-focused, see `rewards`) — falls back to the shared Waystone suffix. Prefixes: Item Rarity (better chest loot at Vaal Beacons) + Pack Size (matches its own "extra pack of Monsters around Vaal Beacons" suffix theme).
