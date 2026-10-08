/** Game data: every number, pattern and table that tracks the game itself
 *  (stat ceilings, danger mod wording, mechanics, tablets) rather than the
 *  scoring model's design. Lives in `data/game-data.json`, bundled into the
 *  app as the built-in copy, and also fetched from the repo's main branch at
 *  startup (`remote-game-data.ts`) so a PoE2 patch that rewords a mod or
 *  changes a roll range is a JSON edit on GitHub, not a release.
 *
 *  Layers, lowest first: built-in -> newer remote/cached copy (higher
 *  `revision` only) -> the player's own meta.json (meta-config.ts).
 *
 *  `parseGameData` is all-or-nothing: one bad field rejects the whole file
 *  and the app keeps what it has. A half-applied remote file would be worse
 *  than a stale one. This module imports nothing from the analyzer so every
 *  data consumer can read it without an import cycle. */

import builtinJson from "../../data/game-data.json";

const GAME_DATA_SCHEMA = 1;

export type StatSignal = "itemRarity" | "monsterRarity" | "packSize" | "monsterEffectiveness" | "waystoneDropChance";
export type StatKey = StatSignal | "quantity";
export type DangerSeverity = "reflect" | "strong" | "moderate" | "minor";
type Confidence = "high" | "medium" | "low";
type Source = "wiki" | "poe2db" | "community" | "manual";

export type GameReward =
  | { type: "currency"; id: string; weight: number }
  | { type: "mechanic"; id: string; value: number }
  | { type: "generic"; score: number };

export interface GameMechanic {
  name: string;
  priorityStat: StatKey;
  secondaryStats: StatKey[];
  recommendedTablets?: string[];
  skipIfBelow: number;
  /** Key into `mechanicPatterns`; absent for "General". */
  detect?: string;
  confidence?: Confidence;
  source?: Source;
}

export interface GameTablet {
  name: string;
  mods: string[];
  tags?: string[];
  enabled?: boolean;
  rewards?: GameReward[];
  confidence?: Confidence;
  source?: Source;
}

export interface GameData {
  schema: number;
  /** Bumped on every edit; a copy only replaces the current one when higher. */
  revision: number;
  scoring: {
    statReferences: Record<StatSignal, number>;
    dominantLegendaryOverride: Partial<Record<StatSignal, number>>;
    secondaryBonusCap: number;
    skipThreshold: number;
  };
  dangerPatterns: { id: string; label: string; severity: DangerSeverity; pattern: RegExp }[];
  positivePatterns: { reason: string; pattern: RegExp; bonus: number }[];
  mechanicPatterns: Record<string, RegExp>;
  extraContentBonus: Record<string, number>;
  mechanicValues: Record<string, number>;
  mechanics: GameMechanic[];
  tablets: GameTablet[];
}

const STAT_SIGNALS: readonly StatSignal[] = [
  "itemRarity",
  "monsterRarity",
  "packSize",
  "monsterEffectiveness",
  "waystoneDropChance",
];
const STAT_KEYS: readonly StatKey[] = [...STAT_SIGNALS, "quantity"];
const SEVERITIES: readonly DangerSeverity[] = ["reflect", "strong", "moderate", "minor"];
const CONFIDENCES: readonly Confidence[] = ["high", "medium", "low"];
const SOURCES: readonly Source[] = ["wiki", "poe2db", "community", "manual"];

class Invalid extends Error {}

function fail(path: string, why: string): never {
  throw new Invalid(`${path}: ${why}`);
}

function obj(v: unknown, path: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) fail(path, "expected an object");
  return v as Record<string, unknown>;
}

function arr(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v)) fail(path, "expected an array");
  return v;
}

function str(v: unknown, path: string): string {
  if (typeof v !== "string" || v.trim() === "") fail(path, "expected a non-empty string");
  return v;
}

function num(v: unknown, path: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) fail(path, `expected a number in ${min}..${max}`);
  return v;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], path: string): T {
  if (!allowed.includes(v as T)) fail(path, `expected one of ${allowed.join("/")}`);
  return v as T;
}

function optional<T>(v: unknown, read: (v: unknown) => T): T | undefined {
  return v === undefined ? undefined : read(v);
}

/** Patterns are stored as bare sources and always compiled case-insensitive,
 *  matching how every hand-written pattern in this app was written. */
function regex(v: unknown, path: string): RegExp {
  const source = str(v, path);
  try {
    return new RegExp(source, "i");
  } catch {
    fail(path, "invalid regular expression");
  }
}

function strings(v: unknown, path: string): string[] {
  return arr(v, path).map((s, i) => str(s, `${path}[${i}]`));
}

function unique(names: string[], path: string): void {
  const seen = new Set<string>();
  for (const n of names) {
    const k = n.toLowerCase();
    if (seen.has(k)) fail(path, `duplicate "${n}"`);
    seen.add(k);
  }
}

function numberRecord(v: unknown, path: string, min: number, max: number): Record<string, number> {
  const o = obj(v, path);
  return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, num(x, `${path}.${k}`, min, max)]));
}

function readReward(v: unknown, path: string): GameReward {
  const o = obj(v, path);
  if (o.type === "generic") return { type: "generic", score: num(o.score, `${path}.score`, 0, 100) };
  const id = str(o.id, `${path}.id`);
  if (o.type === "mechanic") return { type: "mechanic", id, value: num(o.value, `${path}.value`, 0, 100) };
  if (o.type === "currency") return { type: "currency", id, weight: num(o.weight, `${path}.weight`, 0, 100) };
  fail(`${path}.type`, "expected currency/mechanic/generic");
}

function readMechanic(v: unknown, path: string, patterns: Record<string, RegExp>): GameMechanic {
  const o = obj(v, path);
  const detect = optional(o.detect, (x) => str(x, `${path}.detect`));
  if (detect !== undefined && !(detect in patterns)) fail(`${path}.detect`, `no mechanicPatterns entry "${detect}"`);
  return {
    name: str(o.name, `${path}.name`),
    priorityStat: oneOf(o.priorityStat, STAT_KEYS, `${path}.priorityStat`),
    secondaryStats: arr(o.secondaryStats, `${path}.secondaryStats`).map((s, i) =>
      oneOf(s, STAT_KEYS, `${path}.secondaryStats[${i}]`),
    ),
    recommendedTablets: optional(o.recommendedTablets, (x) => strings(x, `${path}.recommendedTablets`)),
    skipIfBelow: num(o.skipIfBelow, `${path}.skipIfBelow`, 0, 100),
    detect,
    confidence: optional(o.confidence, (x) => oneOf(x, CONFIDENCES, `${path}.confidence`)),
    source: optional(o.source, (x) => oneOf(x, SOURCES, `${path}.source`)),
  };
}

function readTablet(v: unknown, path: string): GameTablet {
  const o = obj(v, path);
  const mods = strings(o.mods, `${path}.mods`);
  if (mods.length === 0) fail(`${path}.mods`, "expected at least one mod");
  return {
    name: str(o.name, `${path}.name`),
    mods,
    tags: optional(o.tags, (x) => strings(x, `${path}.tags`)),
    enabled: optional(o.enabled, (x) => {
      if (typeof x !== "boolean") fail(`${path}.enabled`, "expected a boolean");
      return x;
    }),
    rewards: optional(o.rewards, (x) => arr(x, `${path}.rewards`).map((r, i) => readReward(r, `${path}.rewards[${i}]`))),
    confidence: optional(o.confidence, (x) => oneOf(x, CONFIDENCES, `${path}.confidence`)),
    source: optional(o.source, (x) => oneOf(x, SOURCES, `${path}.source`)),
  };
}

function read(raw: unknown): GameData {
  const root = obj(raw, "root");
  if (root.schema !== GAME_DATA_SCHEMA) fail("schema", `expected ${GAME_DATA_SCHEMA}`);
  const revision = num(root.revision, "revision", 1, Number.MAX_SAFE_INTEGER);
  if (!Number.isInteger(revision)) fail("revision", "expected an integer");

  const sc = obj(root.scoring, "scoring");
  const refs = obj(sc.statReferences, "scoring.statReferences");
  const statReferences = Object.fromEntries(
    STAT_SIGNALS.map((k) => [k, num(refs[k], `scoring.statReferences.${k}`, 1, 10000)]),
  ) as Record<StatSignal, number>;
  const overrides = obj(sc.dominantLegendaryOverride, "scoring.dominantLegendaryOverride");
  const dominantLegendaryOverride: Partial<Record<StatSignal, number>> = {};
  for (const [k, x] of Object.entries(overrides)) {
    const key = oneOf(k, STAT_SIGNALS, `scoring.dominantLegendaryOverride.${k}`);
    dominantLegendaryOverride[key] = num(x, `scoring.dominantLegendaryOverride.${k}`, 1, 100);
  }

  const dangerPatterns = arr(root.dangerPatterns, "dangerPatterns").map((d, i) => {
    const p = `dangerPatterns[${i}]`;
    const o = obj(d, p);
    return {
      id: str(o.id, `${p}.id`),
      label: str(o.label, `${p}.label`),
      severity: oneOf(o.severity, SEVERITIES, `${p}.severity`),
      pattern: regex(o.pattern, `${p}.pattern`),
    };
  });
  unique(
    dangerPatterns.map((d) => d.id),
    "dangerPatterns",
  );

  const positivePatterns = arr(root.positivePatterns, "positivePatterns").map((d, i) => {
    const p = `positivePatterns[${i}]`;
    const o = obj(d, p);
    return { reason: str(o.reason, `${p}.reason`), pattern: regex(o.pattern, `${p}.pattern`), bonus: num(o.bonus, `${p}.bonus`, 0, 100) };
  });

  const mp = obj(root.mechanicPatterns, "mechanicPatterns");
  const mechanicPatterns = Object.fromEntries(Object.entries(mp).map(([k, x]) => [k, regex(x, `mechanicPatterns.${k}`)]));

  const extraContentBonus = numberRecord(root.extraContentBonus, "extraContentBonus", 0, 100);
  for (const k of Object.keys(extraContentBonus)) {
    if (!(k in mechanicPatterns)) fail(`extraContentBonus.${k}`, "no matching mechanicPatterns entry");
  }

  const mechanics = arr(root.mechanics, "mechanics").map((m, i) => readMechanic(m, `mechanics[${i}]`, mechanicPatterns));
  unique(
    mechanics.map((m) => m.name),
    "mechanics",
  );
  const tablets = arr(root.tablets, "tablets").map((t, i) => readTablet(t, `tablets[${i}]`));
  unique(
    tablets.map((t) => t.name),
    "tablets",
  );

  return {
    schema: GAME_DATA_SCHEMA,
    revision,
    scoring: {
      statReferences,
      dominantLegendaryOverride,
      secondaryBonusCap: num(sc.secondaryBonusCap, "scoring.secondaryBonusCap", 0, 20),
      skipThreshold: num(sc.skipThreshold, "scoring.skipThreshold", 0, 100),
    },
    dangerPatterns,
    positivePatterns,
    mechanicPatterns,
    extraContentBonus,
    mechanicValues: numberRecord(root.mechanicValues, "mechanicValues", 0, 100),
    mechanics,
    tablets,
  };
}

/** Validates and compiles a game-data file. Never throws. */
export function parseGameData(raw: unknown): { ok: true; data: GameData } | { ok: false; error: string } {
  try {
    return { ok: true, data: read(raw) };
  } catch (e) {
    if (e instanceof Invalid) return { ok: false, error: e.message };
    return { ok: false, error: String(e) };
  }
}

function loadBuiltin(): GameData {
  const parsed = parseGameData(builtinJson);
  // The bundled file is checked by tests and CI; failing here means a broken
  // build, which must be loud rather than silently scoring with nothing.
  if (!parsed.ok) throw new Error(`Built-in data/game-data.json is invalid: ${parsed.error}`);
  return parsed.data;
}

export const BUILTIN_GAME_DATA: GameData = loadBuiltin();

let current: GameData = BUILTIN_GAME_DATA;
const listeners: ((d: GameData) => void)[] = [];

export function getGameData(): GameData {
  return current;
}

/** Registers a module's refresh hook; called once now and on every change. */
export function onGameData(listener: (d: GameData) => void): void {
  listeners.push(listener);
  listener(current);
}

/** Makes `data` current and refreshes every registered table. */
export function setGameData(data: GameData): void {
  current = data;
  for (const l of listeners) l(data);
}
