import { describe, expect, it } from "vitest";
import { DEFAULT_TABLETS, canonicalTabletName, getActiveTablets } from "./tablets";
import { MECHANICS } from "./mechanics";
import { parseMetaFile } from "./meta-schema";

// The eight real tablet base types in the game's own data
// (repoe-fork.github.io/poe2/base_items.json, item_class TowerAugmentation),
// re-checked 2026-10-08. Shipping anything else would be a made-up item.
const VERIFIED_TABLETS = [
  "Abyss Tablet",
  "Breach Tablet",
  "Delirium Tablet",
  "Expedition Tablet",
  "Irradiated Tablet",
  "Overseer Tablet",
  "Ritual Tablet",
  "Temple Tablet",
];

describe("tablets", () => {
  it("ships exactly the verified base types", () => {
    expect(DEFAULT_TABLETS.map((t) => t.name).sort()).toEqual(VERIFIED_TABLETS);
  });

  it("every mechanic only recommends verified tablets", () => {
    for (const mech of MECHANICS) {
      for (const name of mech.recommendedTablets ?? []) expect(VERIFIED_TABLETS).toContain(name);
    }
  });

  it("every default tablet boosts at least one tracked stat", () => {
    for (const t of getActiveTablets()) expect(Object.keys(t.boosts).length, t.name).toBeGreaterThan(0);
  });

  it("maps the renamed Overseer tablet, case-insensitively", () => {
    expect(canonicalTabletName("Overseer Precursor Tablet")).toBe("Overseer Tablet");
    expect(canonicalTabletName("overseer precursor tablet")).toBe("Overseer Tablet");
    expect(canonicalTabletName("Breach Tablet")).toBe("Breach Tablet");
  });

  it("migrates the old name in meta.json tablets and recommended_tablets", () => {
    const file = parseMetaFile(
      JSON.stringify({
        metas: { Delirium: { recommended_tablets: ["Delirium Tablet", "Overseer Precursor Tablet"] } },
        tablets: [{ name: "Overseer Precursor Tablet", enabled: false }],
      }),
    );
    expect(file?.metas?.Delirium.recommended_tablets).toEqual(["Delirium Tablet", "Overseer Tablet"]);
    expect((file?.tablets?.[0] as { name: string }).name).toBe("Overseer Tablet");
  });
});
