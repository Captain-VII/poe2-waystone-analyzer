import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import builtinJson from "../../data/game-data.json";
import { BUILTIN_GAME_DATA, getGameData, parseGameData, setGameData } from "./game-data";
import { GAME_DATA_URL, applyCachedGameData, refreshGameData } from "./remote-game-data";
import { STAT_REFERENCES, detectDangerHits, evaluateMap, skipThreshold } from "./scoring";
import { getActiveMechanics } from "./mechanics";
import { getActiveTablets } from "./tablets";

// Test fixtures mutate arbitrary paths of the JSON file.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

/** A deep copy of the bundled file, to mutate per test. */
const copy = (): Json => JSON.parse(JSON.stringify(builtinJson));

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  };
}

const respond = (body: string, status = 200) =>
  vi.fn(async () => new Response(body, { status })) as unknown as typeof fetch;

beforeEach(() => vi.stubGlobal("localStorage", memoryStorage()));
afterEach(() => {
  setGameData(BUILTIN_GAME_DATA);
  vi.unstubAllGlobals();
});

describe("parseGameData", () => {
  it("accepts the bundled data/game-data.json", () => {
    const r = parseGameData(builtinJson);
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
  });

  it.each<[string, (d: Json) => void]>([
    ["a newer schema", (d) => (d.schema = 2)],
    ["a missing stat ceiling", (d) => delete d.scoring.statReferences.packSize],
    ["an invalid regex", (d) => (d.dangerPatterns[0].pattern = "(")],
    ["an unknown severity", (d) => (d.dangerPatterns[0].severity = "deadly")],
    ["a duplicate danger id", (d) => d.dangerPatterns.push({ ...d.dangerPatterns[0] })],
    ["a mechanic with an unknown stat", (d) => (d.mechanics[0].priorityStat = "luck")],
    ["a mechanic detecting a missing pattern", (d) => (d.mechanics[0].detect = "nope")],
    ["a tablet without mods", (d) => (d.tablets[0].mods = [])],
    ["a fractional revision", (d) => (d.revision = 1.5)],
  ])("rejects %s", (_, mutate) => {
    const d = copy();
    mutate(d);
    expect(parseGameData(d).ok).toBe(false);
  });
});

describe("setGameData", () => {
  it("refreshes every consumer table", () => {
    const d = copy();
    d.revision += 1;
    d.scoring.skipThreshold = 50;
    d.scoring.statReferences.itemRarity = 200;
    d.dangerPatterns.push({ id: "test-danger", label: "Test", severity: "minor", pattern: "zzz test mod" });
    d.mechanics = d.mechanics.filter((m: { name: string }) => m.name !== "Temple");
    d.tablets = d.tablets.filter((t: { name: string }) => t.name !== "Temple Tablet");
    const parsed = parseGameData(d);
    if (!parsed.ok) throw new Error(parsed.error);
    setGameData(parsed.data);

    expect(skipThreshold()).toBe(50);
    expect(STAT_REFERENCES.itemRarity).toBe(200);
    expect(detectDangerHits("zzz test mod").map((h) => h.id)).toEqual(["test-danger"]);
    expect(getActiveMechanics().map((m) => m.name)).not.toContain("Temple");
    expect(getActiveTablets().map((t) => t.name)).not.toContain("Temple Tablet");
    // Item Rarity 40 was 40% of its old ceiling (top, 55 points, run); now it's
    // 20% of 200 (ok, 25 points), under the new SKIP bar of 50.
    const r = evaluateMap({
      quantity: 0,
      itemRarity: 40,
      monsterRarity: 0,
      packSize: 0,
      monsterEffectiveness: 0,
      waystoneDropChance: 0,
    });
    expect(r.score).toBe(25);
    expect(r.decision).toBe("skip");
  });
});

describe("refreshGameData", () => {
  const newer = () => {
    const d = copy();
    d.revision = BUILTIN_GAME_DATA.revision + 1;
    d.scoring.skipThreshold = 30;
    return JSON.stringify(d);
  };

  it("adopts and caches a newer valid copy", async () => {
    const fetchImpl = respond(newer());
    expect(await refreshGameData(fetchImpl)).toEqual({ status: "applied", revision: BUILTIN_GAME_DATA.revision + 1 });
    expect(fetchImpl).toHaveBeenCalledWith(GAME_DATA_URL, expect.anything());
    expect(skipThreshold()).toBe(30);
    expect(localStorage.getItem("gameData.cache")).not.toBeNull();
  });

  it("ignores a copy that isn't newer", async () => {
    const r = await refreshGameData(respond(JSON.stringify(builtinJson)));
    expect(r.status).toBe("current");
    expect(getGameData()).toBe(BUILTIN_GAME_DATA);
    expect(localStorage.getItem("gameData.cache")).toBeNull();
  });

  it("rejects an invalid copy without touching current data", async () => {
    const d = JSON.parse(newer());
    d.dangerPatterns[0].pattern = "(";
    const r = await refreshGameData(respond(JSON.stringify(d)));
    expect(r.status).toBe("rejected");
    expect(getGameData()).toBe(BUILTIN_GAME_DATA);
  });

  it("treats HTTP errors and network failures as unavailable", async () => {
    expect((await refreshGameData(respond("", 404))).status).toBe("unavailable");
    const failing = vi.fn(async () => {
      throw new TypeError("offline");
    }) as unknown as typeof fetch;
    expect((await refreshGameData(failing)).status).toBe("unavailable");
    expect(getGameData()).toBe(BUILTIN_GAME_DATA);
  });

  it("restores the cached copy on the next start", async () => {
    await refreshGameData(respond(newer()));
    setGameData(BUILTIN_GAME_DATA);
    expect(applyCachedGameData().status).toBe("applied");
    expect(skipThreshold()).toBe(30);
  });
});
