# Resolved issues

Moved from KNOWN_ISSUES.md for 1.0, numbers unchanged.

## 2. Tablet pool is mostly not verified against real PoE2 tablet items — and the real system doesn't match this app's model

**As of the 2026-07-04 update below, `src/analyzer/tablets.ts` ships
exactly the six real PoE2 tablet types, all tagged `"verified"`** —
Standard/Overseer Precursor Tablet, Breach/Ritual/Delirium/Expedition
Tablet — with mods written as plain PoE2-style text (e.g. `"20% increased
Pack Size"`), parsed through the same tolerant regex `mod-parser.ts` uses
for waystone text. The rest of this entry is left as a history of how that
conclusion was reached (the earlier 17-tablet, three-confidence-level pool
is gone, not kept alongside).

**Bigger finding from the research pass that added the "verified" pair:**
PoE2's real tablet system (Precursor Tablets slotted into Atlas Towers)
mostly doesn't work like this app models it. Real mechanic-specific tablets
(Breach/Expedition/Delirium/Ritual/Abyss) boost mechanic-specific *currency*
— Breach Splinters, Expedition Artifacts, Ritual Tribute, Delirium
Simulacrum Splinters — not the six generic map stats (Item Rarity, Monster
Rarity, Pack Size, Monster Effectiveness, Waystone Drop Chance, Quantity)
this app's `mod-parser.ts`/`scoring.ts` track. Only the non-mechanic-specific
"Standard Precursor Tablet" and the boss-drop "Overseer Precursor Tablet"
actually map onto those six stats — hence only those two got the
`"verified"` tag; the mechanic-named tablets remain plausible-but-unverified
placeholders because their *real* effect is currently out of this app's
model entirely, not just unconfirmed wording. Also worth noting separately:
several mechanics in `mechanics.ts` (Legion/Heist/Sanctum/Harvest/Metamorph/
Incursion/Bestiary/Essence) don't appear to be part of PoE2's endgame tablet
system at all per this research — that's a `mechanics.ts` question, not a
tablets one, and wasn't investigated further (out of scope for this pass).

None of this is hardcoded to extend, though: tablets are matched to
mechanics by stat-fit (`scoreMechanicFit` in `mechanics.ts`), the same
weighting used to score a waystone against a mechanic — so any tablet
(real, placeholder, or user-added) is automatically eligible for whichever
mechanics its boosts fit, with no per-mechanic name list to touch. Add or
correct one via the user's `meta.json` `"tablets"` array (see README's
"Tuning the scoring" section for the exact format and an example), or edit
`DEFAULT_TABLETS` in `tablets.ts` directly — no rebuild needed for the
meta.json route, no other code changes needed either way. `mechanics.ts`'s
`recommendedTablets` field still exists but is now just an optional
fit-score bonus for curated picks, not a hard requirement for a tablet to
be recommended.

**Update (2026-07-04, same day) — partially closed:** added
`src/analyzer/rewards.ts`'s `Reward`/`computeRewardScore`, a second,
independent scoring channel for exactly the mechanic-currency value the
six-stat model can't express, without touching `StatKey`/`mod-parser.ts`/
`scoring.ts` at all (the bigger option below wasn't needed after all — see
`docs/history/implementation-plan.md`'s "Reward-based tablet scoring" entry for
the design). A tablet's optional `rewards` array is summed into a
`rewardScore` at load time and added on top of its stat-fit score in
`adapter.ts`'s `rankTablets`, clamped back to 0-100. Delirium/Expedition/
Ritual Tablet now declare example rewards; every other tablet is
unaffected (`rewardScore` defaults to 0 with no `rewards`). `meta.json`'s
`"tablets"` entries can set `rewards` too — see README's "Tuning the
scoring" section. Mechanic-specific tablets' currency value is now
representable; it's just not derived from real per-mechanic drop-rate data
(the `MECHANIC_VALUES` table and the three tablets' example weights are
still hand-picked, not sourced from the game).

**Update (2026-07-04, later same day) — mostly closed:** the "confirmed
those mechanics are actually part of PoE2's endgame tablet system" question
above is now answered. Cross-checked three independent sources
(poe2wiki.net, maxroll.gg, odealo.com): real PoE2 has exactly **six**
Precursor-Tower tablet types — Standard, Overseer, Breach, Ritual,
Delirium, Expedition. There is no Legion, Heist, Sanctum, Harvest,
Metamorph, Essence, Incursion, or Bestiary tablet in the game.
`src/analyzer/tablets.ts`'s `DEFAULT_TABLETS` now ships exactly those six,
all tagged `"verified"`, replacing the old 7 "original" + 8 "placeholder"
guesses entirely (removed, not kept alongside).

**Correction (2026-07-04, same day):** this entry originally also said
Abyss had no tablet at all — wrong. The three sources above happened to
predate Abyss's addition (one abyss-focused guide found separately cites
patch 0.4.0; maxroll's atlas guide, current as of patch 0.5.0, doesn't
mention it either, so this may be a moving target patch-to-patch). Checked
directly against **poe2db.tw** (data-mined from game files, not a
wiki write-up) instead: a real `Abyss Tablet` base type exists, drop level
65, "Adds Abysses to a Map," 10 uses remaining. Re-added to
`DEFAULT_TABLETS`, tagged `"verified"` — but poe2db itself doesn't expose
exact affix text ("Modifier weight information cannot be obtained from
game files"), so unlike the six Precursor-Tower types, Abyss Tablet's
`mods` here is a plausible representative roll, not confirmed wording.
It's also mechanically different from the six above: a personal-Map-Device
consumable with a limited use count, not something slotted into a
Precursor Tower to affect every map in its radius — this app doesn't model
that "uses remaining" mechanic for any tablet, Abyss included.

`mechanics.ts`'s `recommendedTablets` pins were updated to point at real
names (mostly "Standard Precursor Tablet" for mechanics with no dedicated
tablet, "Abyss Tablet" for Abyss). `rewards.ts`'s `MECHANIC_VALUES` now
lists the five mechanics with real mechanic-specific currency in-game
(delirium/expedition/breach/abyss/ritual), ordered by general community
consensus on chase-value — **that ordering itself is still not sourced
from real economic/drop-rate data**, same first-pass caveat as issue #3
below.

**Considered and rejected:** fetching poe2db.tw live at runtime (e.g. on
every analyze()) to auto-refresh tablet data. Rejected for two concrete
reasons: (1) a `fetch()` from the Tauri webview to `poe2db.tw` almost
certainly fails CORS (poe2db has no reason to allow the overlay's
`tauri://localhost` origin), and (2) this app's whole analyze path is
synchronous-and-local by design, with a documented acceptance criterion of
"Ins → pulse/flare < 100ms" (M6) — a network call on every analysis
would blow that budget and add a failure mode (offline, rate-limited,
slow) to a chat that currently has none. If this is revisited, it'd need
to be a Rust-side (`reqwest`, no CORS) background refresh on startup, never
inline with `analyze()` — not attempted here.

**Still open:** the shared generic-stat prefix pool (Quantity/Rarity/Pack
Size/Magic Monsters/Rare Monsters/Gold/Experience) that the six
Precursor-Tower types can roll from is only partially represented — each
tablet's `mods` here is one representative example prefix, not the full
roll table, and "Magic Monsters"/"Gold"/"Experience" aren't tracked stats
in this app's six-stat model at all (out of scope: would need new
`StatKey`s in `mod-parser.ts`/`scoring.ts`, a larger change than this
pass). The eight mechanics confirmed to have no real tablet (Legion/Heist/
Sanctum/Harvest/Metamorph/Essence/Incursion/Bestiary) still exist as
scoreable mechanics in `mechanics.ts` — that's real (they're still real
PoE2 league mechanics, just not ones with their own tablet), not a bug.

Also worth noting: `src/analyzer/tablets.ts`'s `DEFAULT_TABLETS` grew to
**nine** entries some time after this section was last fully updated here —
Abyss (2026-07-04), Irradiated and Temple (2026-07-06) were added but this
KNOWN_ISSUES entry's prose above still only discusses the original six
Precursor-Tower types. Their status is unchanged from what's already
written above/in `tablets.ts`'s own header comment: Abyss confirmed real
via poe2db.tw but with a plausible-not-confirmed roll; Irradiated/Temple
the same.

**Update (2026-07-11) — the shared prefix/suffix pools got their first real
cross-check, several representative values corrected:** user picked this
issue's "still open" item to work on. `poe2wiki.net`'s dedicated
"List of modifiers for tablets" page exists but blocks non-browser fetches
(403); its content was retrieved via odealo.com's summary of it instead,
cross-checked against maxroll.gg's rolling guide. Findings:
- The full shared prefix pool (7 mods) and full suffix pools for Standard/
  Overseer/Breach/Ritual/Delirium/Expedition are now known, with numeric
  ranges, from two independent sources.
- Several representative values in `tablets.ts` were outside the newly-
  confirmed real ranges (most notably Delirium's Pack Size at 20% vs. a
  real ~3-10% depending on which of two Pack-Size-shaped mods is used) —
  corrected; see each tablet's own comment in `tablets.ts` for the exact
  sourcing and number chosen.
- **One genuine, unresolved source conflict**: the shared Quantity-of-Items
  prefix's range is (3-7)% per poe2wiki/odealo vs. (10-20)% per maxroll —
  no overlap. Not chased down further (would repeat the exact "hunt every
  new source for a tie-break" pattern issue #3 already flags as a fatigue
  risk) — disclosed in Expedition Tablet's comment, a defensible boundary
  value picked instead.
- A parser-accuracy check (`parseMods`, via a scratchpad probe script)
  caught that the wiki's literal wording for Standard Tablet's suffix
  ("increased Quantity of Waystones found") would double-count as BOTH
  `waystoneDropChance` and `quantity` (Item Quantity) purely because it
  contains the word "quantity" — the app's existing "chance to drop/find a
  Waystone" phrasing was kept instead (same real range, parses as only the
  intended stat). Worth remembering if sourcing more real tablet/waystone
  text going forward: verify new wording against the actual parser before
  trusting it, not just by eye.
- Magic Monsters/Gold/Experience remain untracked and out of scope, same
  as before this pass — not attempted, per the user's explicit choice to
  keep this pass to correcting existing data rather than extending the
  stat model (which would touch the recently-stabilized Juice Score
  formula, issue #3).
- Abyss/Irradiated/Temple mods remain unconfirmed — both new sources
  explicitly say they don't cover these three, consistent with the
  poe2db.tw finding already on record.

**Update (2026-07-12) — mostly closed, real data-mined source found:**
user pointed at `github.com/repoe-fork/repoe`, which turned out to host a
genuinely data-mined (not wiki-summary) PoE2 export at
`repoe-fork.github.io/poe2/mods.json` — a `"domain": "tablet"` filter
yields all 125 real tablet mods straight from the game's files. Two
concrete corrections came out of it:
- **"Standard Precursor Tablet" was never real** — the data-mined source
  only has an implicit "Adds [mechanic] to a Map" mod for exactly eight
  real base types (Breach/Ritual/Delirium/Expedition/Irradiated/Overseer/
  Abyss/Temple), no generic ninth. Removed from `tablets.ts` and every
  `mechanics.ts` `recommendedTablets` reference (replaced with Overseer
  Precursor Tablet, the one remaining general-purpose type) rather than
  kept as a plausible-looking fiction.
- **The "every real tablet is Magic rarity, 1 prefix + 1 suffix" premise
  from the 2026-07-11 update above was also wrong** — two real in-game
  item texts (pasted by the user) proved a Normal-rarity tablet has zero
  mods while a well-rolled Rare tablet carries 4 (2 prefixes + 2
  suffixes). Every tablet's `mods` entry now represents a well-rolled
  Rare tablet instead of a single representative line — see
  `tablets.ts`'s header comment and each entry's own comment for the
  exact real ranges and the reasoning behind which stats were picked when
  a slot had more than one tracked-stat option.
- Overseer Precursor Tablet's two boss-scoped suffix values were also
  corrected against the same source: Item Rarity of Map Boss drops is
  really (35-60)%, not the old 20%; Waystone Quantity from Map Bosses is
  really (18-30)%, not the old 8% — both had been guessed too low by the
  wiki-summary sourcing used previously.
- Confidence bumped from "medium"/"low" to "high" across the board
  (source `"poe2db"`) — no longer a plausible guess, a real data-mined
  range with a documented, reasoned pick within it.
- **Still not done**: Magic Monsters/Gold/Experience remain untracked and
  out of scope (same reasoning as before — would touch the stabilized
  Juice Score formula, issue #3). The mechanic-specific currency
  suffixes (Splinters, Artifacts, Tribute, etc.) are real and now fully
  visible in the data-mined source too, but deliberately stay out of
  `mods` — that's `rewards.ts`'s job, unchanged by this pass.

**Update (2026-10-08) — re-checked against current game data, closed for
1.0:** `repoe-fork.github.io/poe2/base_items.json` (item class
`TowerAugmentation`) still lists exactly the eight base types this app
ships, all `released`. One correction: the game now calls the boss tablet
**"Overseer Tablet"**, not "Overseer Precursor Tablet". Renamed everywhere;
`canonicalTabletName` (`tablets.ts`) migrates the old name in meta.json and
pinned tablets on load. `tablets.test.ts` now fails if a default tablet or
a mechanic's `recommendedTablets` names anything outside the verified list.

## 4. ~~Mechanic-presence detection is a simple keyword match~~ (resolved 2026-07-08)

"Mecanique naturelle presente sur la map" (§2/§8/§9) is detected by a regex
per mechanic (e.g. `\britual\b` for Ritual) adding a flat +15 to that
mechanic's match score.

**Update (2026-07-08):** the false-positive surface is closed — detection
now runs against `parser.ts`'s `ParsedWaystone.contentText` (every block
except the header/name block), never the item name or flavor text. A
waystone *named* "Ritual Reliquary" no longer hands Ritual an unearned +15.
Regexes were also widened for real plural phrasings ("Abysses",
"Essences").

**Update (2026-07-08, same day) — consolidated:** this same keyword logic
used to be duplicated in 3 places that could silently drift (and had: the
plural widening above only landed in `mechanics.ts`'s `detect`, not
`scoring.ts`'s two pattern tables, which fed the *actual Juice Score*'s
mechanic-density term). All three now read from one shared
`src/analyzer/mechanic-patterns.ts` (`MECHANIC_PATTERNS` plus the exact
`SYNERGY_MECHANIC_IDS`/`EXTRA_CONTENT_BONUS` subsets each consumer used),
typed so a dropped/typo'd id is a compile error, not a silent gap.

This also closed the score-side sibling of the bug above:
`evaluateMap`/`countActiveMechanics` (scoring.ts) used to read the full raw
item text, so a waystone *named* "Ritual Reliquary" inflated the real
score's mechanic-density term (§8's +10 weight, plus the ×1.1-1.6 stacking
multiplier) even with zero ritual mods — not just the mechanic-match
display bonus fixed above. Both now read `contentText`. One side effect
intentionally kept: `contentText` includes every non-header block, not
just the single isolated mod block, so an instilled enchant line living in
its own block (e.g. "Players in Area are X% Delirious" outside the mod
block) now correctly counts toward both the detect bonus and the real
score — the mod-block-only version from the first 2026-07-08 update could
have missed it.

`verify-adapter.mjs` (69 checks total) pins: the name-doesn't-count fix on
both the mechanic-match bonus AND `heat.score` itself; the instilled-
separate-block case actually being picked up; and that Abyss/Essence
plurals now move `heat.score`, not just the tablet recommendation. Still
keyword-based at heart — a mechanic phrased in a way that shares no
keyword with its regex would be missed, and a unique waystone's flavor
text (which also lives outside the header block) remains a narrow residual
false-positive surface — but the three-way drift and the header/name
surface are both closed.

## 7. ~~Reduce-effects and Compact-compression settings have no UI yet~~ (resolved 2026-07-08)

Both settings are now toggles in the in-app Settings panel (gear button):
"Reduce Effects" (disables pulse/flare/spark animations, keeps all color
information) and "Compact Compressed" (a ~359px Compact layout for HUDs
where the default 392px card overlaps something else on screen). They
apply immediately and persist in `localStorage` as before.

**Update (2026-07-08):** custom hotkey remapping is now implemented. The
Settings row's `Ins` chip is a button: click it, press the new key (Escape
cancels), and both shortcuts move to that base key (key = analyze,
Shift+key = toggle). The base is validated Rust-side (modifiers, Escape,
Enter/Space/Tab/Backspace, and every *printable* key — letters, digits,
punctuation, numpad — are rejected, because a global grab swallows the key
OS-wide and would break typing everywhere, game chat included; a key
already grabbed by another app rolls back to the previous binding with an
error message). What's left: F-keys, Insert/Delete/Home/End/PageUp/
PageDown, arrows, and lock keys. The base persists in `hotkey.txt` in the
app config dir — Rust-side, not `localStorage`, because registration
happens at startup before the webview exists. One quirk: the *currently
bound* key can't be captured in the remap flow, because the OS-level global
grab means the webview never receives its keydown — re-selecting the same
key would be a no-op anyway.

**Update (2026-07-13):** a third, fixed accelerator — **Ctrl+E** — was
added alongside the remappable base, always analyzing regardless of what
the base is remapped to (user request: they wanted Ctrl+E specifically and
no physical numpad to fall back on). It bypasses the printable-key
rejection above by construction: it's registered with the Control modifier
*required*, so the OS only delivers it on the Ctrl+E combo, never on a bare
"e" keystroke — typing is never affected. This freed the Ctrl+base slot,
previously "compare" (KNOWN_ISSUES #8, now removed).

## 8. ~~Compare mode is basic~~ (resolved 2026-07-08)

**Ctrl+Ins** toggles Compare mode (§12): it overlays the last 2-3 distinct
analyzed waystones side by side (`main.ts`'s `compareList`), highlighting
the best Juice Score with a star + gold border. It's a no-op until at
least 2 waystones are in the list (nothing to compare yet).

**Update (2026-07-08):** the original gaps are closed. Each card now has a
**×** (remove it from the comparison) and a **📌** (pin it: pinned entries
survive the rolling window when new analyses come in — max 2 pins, so the
third slot always shows your latest analysis). Re-analyzing a waystone
already in the list updates its entry in place (pin and position kept)
instead of duplicating it — this also fixes the list silently filling with
duplicates of one map, which the old code allowed despite its "distinct"
comment. The list persists across restarts (`localStorage`, validated on
load — a corrupted payload falls back to an empty list). Removing the last
card closes Compare mode and restores the underlying view.

**Update (2026-07-13):** Compare mode has been removed entirely (user
request — "pas pertinent"). The freed **Ctrl+base** modifier slot isn't
reused for anything; instead a fixed, non-remappable **Ctrl+E** accelerator
was added as a second trigger for analyze, always registered alongside
whatever the base key derives (see lib.rs's `EXTRA_HOTKEYS`). All
compareList/showCompare/closeCompare code, the `.body-compare` UI, and its
CSS have been deleted (`main.ts`, `settings.ts`, `RelicPanel.ts`,
`panel.css`).

## 9. ~~Parser assumed a clipboard format real PoE2 text doesn't use~~ (resolved 2026-07-09)

Every fixture this app was ever tested against — `scripts/verify-adapter.mjs`'s
hand-written `SAMPLE`, `docs/` writeups, the original `poe2-waystone-analyzer-v2`
port — assumed a simpler item-text shape than what the game actually pastes.
A real clipboard copy (user-provided, live T15 waystone, 2026-07-09) exposed
two structural mismatches nothing had caught before:

1. **No "Waystone Tier:" line exists.** Real text has an aggregate summary
   block instead (`Item Rarity: +27% (augmented)`, `Pack Size: +16%
   (augmented)`, etc., plus an unrelated `Revives Available:` line) — the
   tier number only ever appears in the header's own base-type line,
   `Waystone (Tier 15)`. `parser.ts`'s `extractTier()` scanned only for the
   line that doesn't exist, silently returning **0** — every real waystone
   displayed **"T0"** in the overlay, permanently. Fixed: tier is now
   parsed from the header line first (the line-scan for the old assumed
   format stays as a harmless fallback).
2. **Every rolled modifier is prefixed with a label line** —
   `{ Prefix Modifier "Frostbitten" (Tier: 1) }` — that carries no stat,
   just the mod's internal name/tier. Left in, it inflated `modCount`
   (counted as real mod lines) and would render as a meaningless row like
   `{ Prefix Modifier "Frostbitten" (Tier: 1) }` in the Full-mode modifier
   list. Fixed: `extractModifiers()` now filters out
   `{ Prefix/Suffix/Implicit/Enchant Modifier ... }` label lines.

The 5 core stats themselves (Item Rarity/Monster Rarity/Pack Size/Monster
Effectiveness/Waystone Drop Chance) already parsed correctly on real text —
`mod-parser.ts`'s tolerant fallback regex scans the *full* raw text, so it
picked up the aggregate summary block's clean `"Stat: +NN% (augmented)"`
lines even though the "primary" (clean modifier-block-only) parse pass
never saw them. Only tier and modCount/display were actually broken.

Also resolved in the same pass, once real data was available: the
Pack-Size/Item-Rarity `NORMALIZE_CAP` mismatch from issue #3 — see that
entry's 2026-07-09 update.

**Not investigated further:** whether this is a genuinely NEW clipboard
format (a patch changed it since this app was first built) or whether it
was simply never tested against real text before now — doesn't change the
fix either way. `scripts/verify-adapter.mjs` now pins the exact real text
provided (tier, modCount, clean modifier list, correct stat values) so a
future format change would be caught the same way this one should have
been.
