/** Static "Guide" panel content: why each stat matters and how the score is
 *  computed, so the player understands the Ctrl+E verdict instead of just
 *  trusting it blindly. Grounded directly in the real logic it explains
 *  (scoring.ts's dominant-stat model, mechanics.ts's priority-stat fit,
 *  adapter.ts's Skip/Keep/Run thresholds) — kept in sync with those by
 *  hand, same convention as CHANGELOG.md (bundled, not generated). */

export interface GuideSection {
  title: string;
  bullets: string[];
}

export const GUIDE_SECTIONS: GuideSection[] = [
  {
    title: "How it works",
    bullets: [
      "Hover a Waystone in-game and press your analyze hotkey (**Ins** by default, remappable in Settings) — the app copies its text and scores it instantly, no manual copy needed. **Ctrl+E** always works too, whatever you remap the base key to.",
      "You get a **Juice Score** (0-100) with a Skip/Keep/Run verdict, and — when a league mechanic tablet applies — a **Mechanic Match Score** plus a ranked list of Recommended Tablets.",
    ],
  },
  {
    title: "The Juice Score",
    bullets: [
      "It's your **best-fitting real league mechanic's fit** (Breach, Ritual, Delirium, Expedition, Abyss, or Temple) — not a separate map-only number. Each mechanic reads one stat, its **priority stat**, and tiers that roll on its own: under 15% is Weak, 15-25% OK, 25-50% Top, 50%+ Legendary. The tier IS the base score — 10, 25, 55, or 80.",
      "Three things add on top of that base: the waystone's **modifier count** (up to +8 at 8 mods), a **+10 bonus** when the tablet is one of that mechanic's curated picks, and the tablet's own **reward value** (mechanic currency like Splinters or Artifacts). The last two only count once the waystone is at least \"OK\" for the mechanic — a weak roll can't be rescued by a rich tablet.",
      "So one genuinely great roll carries the score, instead of being averaged down by four mediocre lines. It also means the score answers \"how good is the best thing I can do with this map\", not \"how good is this map overall\".",
      "**Overseer and Irradiated don't count toward it.** They're not a real league-encounter mechanic — their own tablet fit still shows (in the \"Other\" box below the main list), but only Breach/Ritual/Delirium/Expedition/Abyss/Temple can drive the Juice Score or the Atlas Master pick.",
    ],
  },
  {
    title: "The 5 stats behind it",
    bullets: [
      "**Item Rarity** — better quality of everything the map drops (more rares/uniques).",
      "**Monster Rarity** — more magic and rare monsters spawn; each one drops more on its own.",
      "**Pack Size** — more monsters per pack overall, so more kills, more drops.",
      "**Monster Effectiveness** — monsters hit harder and take more to kill; raises rewards, but is danger-adjacent (see Warnings below).",
      "**Waystone Drop Chance** — more Waystones come back from the map, sustaining your mapping. It naturally rolls much higher than the other four, so the **Heat Breakdown bars** measure each stat against its own realistic ceiling (155% for Drop Chance, 65% for Pack Size, ...) — that's why a +60% Drop Chance bar looks smaller than a +60% Pack Size one.",
    ],
  },
  {
    title: "Item Quantity — the odd one out",
    bullets: [
      "Quantity is parsed but deliberately left out of the Juice Score — it skewed results when it was weighted in. It still matters for one thing: the Mechanic Match Score of mechanics whose real profit scales with it (Expedition above all).",
    ],
  },
  {
    title: "Verdict: Skip / Keep / Run",
    bullets: [
      "**Skip** — Juice Score below 20: not worth running.",
      "**Keep** — Juice Score 50+ on a Tier 3+ Waystone: strong enough to hold onto for a good Precursor Tablet instead of running it right away.",
      "**Run** — everything else worth playing.",
    ],
  },
  {
    title: "Mechanic Match & Recommended Tablets",
    bullets: [
      "Each league mechanic cares about one specific stat the most — its **priority stat** — because that's what actually predicts good rewards FROM that mechanic, not from the map in general.",
      "**Delirium** → Pack Size. **Expedition** → Item Quantity. **Breach** → Monster Effectiveness. **Ritual** and **Abyss** → Monster Rarity. **Temple** → Item Rarity.",
      "The app reads your waystone's priority stat for the mechanic it best fits, tiers it the same way as the Juice Score, and ranks Precursor Tablets by how well they'd combo with what you're holding. Each row's verdict comes straight off that tier: Weak → Don't run, OK → Why not, Top or Legendary → Run.",
    ],
  },
  {
    title: "Warnings",
    bullets: [
      "Dangerous or annoying mods (Reflect, Cannot Leech, Fast Monsters, ...) are flagged but never lower the score — the Juice Score measures loot potential only. Staying safe with those mods is your call.",
      "The Insights column lists **every** one it found, most dangerous first, grouped into high (red), Medium (gold) and Low (grey). The **danger level** next to the \"Insights\" heading — Safe / Manageable / Dangerous / Very Dangerous — is derived from those mods alone, never from the score. A waystone can be Juicy and Very Dangerous at once; that's information, not a contradiction.",
    ],
  },
];
