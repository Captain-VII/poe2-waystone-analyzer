import { describe, expect, it } from "vitest";
import { decodeWaystoneShare, encodeWaystoneShare } from "./share";

const ITEM_TEXT = `Item Class: Waystones
Rarity: Normal
Waystone of the Hunt
Waystone (Tier 5)
--------
Item Level: 68
--------
{ Prefix Modifier "Rarity" (Tier: 1) }
+45% increased Rarity of Items found in this Area
{ Suffix Modifier "of the Hunt" (Tier: 2) }
12% increased Rarity of Monsters`;

describe("share", () => {
  it("round-trips item text through encode/decode", async () => {
    const code = await encodeWaystoneShare(ITEM_TEXT);
    expect(code.startsWith("WA1:")).toBe(true);
    const decoded = await decodeWaystoneShare(code);
    expect(decoded).toBe(ITEM_TEXT);
  });

  it("rejects text without the share prefix", async () => {
    expect(await decodeWaystoneShare("not a share code")).toBeNull();
  });

  it("rejects a corrupted/truncated code", async () => {
    const code = await encodeWaystoneShare(ITEM_TEXT);
    expect(await decodeWaystoneShare(code.slice(0, -10))).toBeNull();
  });
});
