/** Keeps game data current without a release: fetches data/game-data.json
 *  from the repo's main branch and adopts it when it validates and carries
 *  a higher `revision` than what's loaded. The last good copy is cached in
 *  localStorage so an offline start still uses it. Any failure (offline,
 *  timeout, invalid file, older revision) leaves the current data alone. */

import { getGameData, parseGameData, setGameData } from "./game-data";

export const GAME_DATA_URL =
  "https://raw.githubusercontent.com/Captain-VII/poe2-waystone-analyzer/main/data/game-data.json";
const CACHE_KEY = "gameData.cache";

export type GameDataOutcome =
  | { status: "applied"; revision: number }
  | { status: "current"; revision: number }
  | { status: "rejected"; error: string }
  | { status: "unavailable"; error: string };

/** Adopts `raw` if it parses and is newer than the current data. */
function adopt(raw: unknown): GameDataOutcome {
  const parsed = parseGameData(raw);
  if (!parsed.ok) return { status: "rejected", error: parsed.error };
  if (parsed.data.revision <= getGameData().revision) return { status: "current", revision: getGameData().revision };
  setGameData(parsed.data);
  return { status: "applied", revision: parsed.data.revision };
}

/** Applies the cached copy from a previous session, if newer. Synchronous so
 *  it can run before the first analysis. */
export function applyCachedGameData(): GameDataOutcome {
  let text: string | null;
  try {
    text = localStorage.getItem(CACHE_KEY);
  } catch {
    return { status: "unavailable", error: "storage unavailable" };
  }
  if (!text) return { status: "unavailable", error: "no cached copy" };
  try {
    return adopt(JSON.parse(text));
  } catch {
    return { status: "rejected", error: "cached copy is not JSON" };
  }
}

/** Fetches the published copy and adopts it if newer, caching what it adopts. */
export async function refreshGameData(fetchImpl: typeof fetch = fetch, timeoutMs = 8000): Promise<GameDataOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let text: string;
  try {
    const res = await fetchImpl(GAME_DATA_URL, { cache: "no-cache", signal: controller.signal });
    if (!res.ok) return { status: "unavailable", error: `HTTP ${res.status}` };
    text = await res.text();
  } catch (e) {
    return { status: "unavailable", error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { status: "rejected", error: "not JSON" };
  }
  const outcome = adopt(raw);
  if (outcome.status === "applied") {
    try {
      localStorage.setItem(CACHE_KEY, text);
    } catch {
      // Caching is a convenience; the data is already applied.
    }
  }
  return outcome;
}
