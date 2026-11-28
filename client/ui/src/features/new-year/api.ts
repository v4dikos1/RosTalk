import type { ChatProxyView } from "@/core/api";
import type { Placement } from "./art/Scene";
import { artLabels, type ArtLocale } from "./locales/art";

export type { Placement };

export type Phase = "upcoming" | "active" | "gallery" | "closed";
export type Background = "dusk" | "aurora";
export type Rarity = "common" | "rare" | "epic" | "legendary";

export interface Layout {
  version: number;
  background: Background;
  placements: Placement[];
}

export interface HistoryEntry {
  kind: string;
  delta: number;
  at: string;
}

export interface GameState {
  season: string;
  phase: Phase;
  zone: string;
  day: string;
  nextDayAt: string;
  enrolled: boolean;
  water: number;
  flakes: number;
  claims: { day: string; itemId: string }[];
  wateredDays: string[];
  growthDays: number;
  inventory: { itemId: string; qty: number }[];
  layout: Layout;
  unlockedBackgrounds: Background[];
  history: HistoryEntry[];
}

export interface SpinReceipt {
  requestId: string;
  itemId: string;
  duplicate: boolean;
  refund: number;
  cost: number;
}

export interface PublicTree {
  growthDays: number;
  background: Background;
  placements: Placement[];
}

export type GameTarget = { kind: "self" } | { kind: "peer"; userId: number; nickname: string };

/** Static v1 catalog: ID, rarity and the weight table are owned by the API major. */
export const CATALOG: readonly { id: string; rarity: Rarity }[] = [
  { id: "ball-red", rarity: "common" }, { id: "ball-gold", rarity: "common" },
  { id: "ball-blue", rarity: "common" }, { id: "candy-cane", rarity: "common" },
  { id: "pine-cone", rarity: "common" }, { id: "snowflake", rarity: "common" },
  { id: "ball-glass-house", rarity: "rare" }, { id: "bell-gold", rarity: "rare" },
  { id: "ribbon-bow", rarity: "rare" }, { id: "icicle-silver", rarity: "rare" },
  { id: "ball-aurora", rarity: "epic" }, { id: "snow-globe", rarity: "epic" },
  { id: "gingerbread-house", rarity: "epic" },
  { id: "star-topper", rarity: "legendary" }, { id: "deer-gold", rarity: "legendary" },
  { id: "clock-midnight", rarity: "legendary" },
];
export const CATALOG_IDS = CATALOG.map((entry) => entry.id);
export const SPIN_COST = 6;
export const MAX_PLACEMENTS = 20;
export const SEASON_DAYS = 31;
/** The client never reads more than this from a game route. */
export const MAX_RESPONSE_BYTES = 32 * 1024;

export function itemName(itemId: string, locale: ArtLocale): string {
  const index = CATALOG_IDS.indexOf(itemId);
  return index < 0 ? artLabels[locale].unknown : (artLabels[locale].items[index] ?? artLabels[locale].unknown);
}

export function rarityOf(itemId: string): Rarity | null {
  return CATALOG.find((entry) => entry.id === itemId)?.rarity ?? null;
}

export class GameApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(`new year request failed (${status} ${code})`);
    this.name = "GameApiError";
    this.status = status;
    this.code = code;
  }
}

const KNOWN_CODES = new Set([
  "unauthenticated", "permission_denied", "not_found", "event_closed", "not_enrolled",
  "already_claimed", "already_watered", "no_water", "insufficient_flakes", "day_changed",
  "invalid_request", "invalid_layout", "not_owned", "background_locked", "layout_conflict",
  "rate_limited", "file_too_large", "unsupported_media_type", "internal", "invalid_response",
]);

/** Key below the `errors.` prefix of the game namespace for a failed call. */
export function errorKey(error: { status: number; code: string }): string {
  if (error.status === 0 || error.code === "network") {
    return "network";
  }
  if (KNOWN_CODES.has(error.code)) {
    return error.code;
  }
  if (error.status === 401) return "unauthenticated";
  if (error.status === 403) return "permission_denied";
  if (error.status === 404) return "not_found";
  if (error.status === 429) return "rate_limited";
  return error.status >= 500 ? "internal" : "unknown";
}

/** The outcome of a call is unknown: a spin with this ID may have committed. */
export function isIndeterminate(error: { status: number; code: string }): boolean {
  return error.status === 0 || error.status >= 500 || error.code === "invalid_response";
}

function invalid(): never {
  throw new GameApiError(200, "invalid_response");
}
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function obj(value: unknown): Record<string, unknown> {
  return isObject(value) ? value : invalid();
}
function str(value: unknown): string {
  return typeof value === "string" ? value : invalid();
}
function int(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) ? value : invalid();
}
function bool(value: unknown): boolean {
  return typeof value === "boolean" ? value : invalid();
}
function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : invalid();
}
function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T {
  return allowed.includes(value as T) ? (value as T) : invalid();
}

const PHASES = ["upcoming", "active", "gallery", "closed"] as const;
const BACKGROUNDS = ["dusk", "aurora"] as const;

function parsePlacement(value: unknown): Placement {
  const o = obj(value);
  return { itemId: str(o.itemId), x: int(o.x), y: int(o.y), scale: int(o.scale), rotation: int(o.rotation) };
}

export function parseState(value: unknown): GameState {
  const o = obj(value);
  const layout = obj(o.layout);
  return {
    season: str(o.season),
    phase: oneOf(o.phase, PHASES),
    zone: str(o.zone),
    day: str(o.day),
    nextDayAt: str(o.nextDayAt),
    enrolled: bool(o.enrolled),
    water: int(o.water),
    flakes: int(o.flakes),
    claims: arr(o.claims).map((claim) => ({ day: str(obj(claim).day), itemId: str(obj(claim).itemId) })),
    wateredDays: arr(o.wateredDays).map(str),
    growthDays: int(o.growthDays),
    inventory: arr(o.inventory).map((entry) => ({ itemId: str(obj(entry).itemId), qty: int(obj(entry).qty) })),
    layout: {
      version: int(layout.version),
      background: oneOf(layout.background, BACKGROUNDS),
      placements: arr(layout.placements).map(parsePlacement),
    },
    unlockedBackgrounds: arr(o.unlockedBackgrounds).map((b) => oneOf(b, BACKGROUNDS)),
    history: arr(o.history).map((entry) => ({ kind: str(obj(entry).kind), delta: int(obj(entry).delta), at: str(obj(entry).at) })),
  };
}

function parseReceipt(value: unknown): SpinReceipt {
  const o = obj(value);
  return { requestId: str(o.requestId), itemId: str(o.itemId), duplicate: bool(o.duplicate), refund: int(o.refund), cost: int(o.cost) };
}

export function parseTree(value: unknown): PublicTree | null {
  const o = obj(value);
  if (o.tree === null) {
    return null;
  }
  const tree = obj(o.tree);
  return {
    growthDays: int(tree.growthDays),
    background: oneOf(tree.background, BACKGROUNDS),
    placements: arr(tree.placements).map(parsePlacement),
  };
}

async function readBounded(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (declared > MAX_RESPONSE_BYTES) {
    throw new GameApiError(response.status, "invalid_response");
  }
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) throw new GameApiError(response.status, "invalid_response");
    return text;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      void reader.cancel();
      throw new GameApiError(response.status, "invalid_response");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export interface GameApi {
  me(signal?: AbortSignal): Promise<GameState>;
  enroll(signal?: AbortSignal): Promise<GameState>;
  claim(day: string, signal?: AbortSignal): Promise<{ itemId: string; state: GameState }>;
  water(day: string, signal?: AbortSignal): Promise<GameState>;
  spin(requestId: string, signal?: AbortSignal): Promise<{ receipt: SpinReceipt; state: GameState }>;
  saveLayout(layout: Layout, signal?: AbortSignal): Promise<GameState>;
  tree(userId: number, signal?: AbortSignal): Promise<PublicTree | null>;
}

/**
 * Client of the fixed event routes. Every request goes through the loopback
 * proxy with its header; the page never sees the server session.
 */
export function createGameApi(proxy: ChatProxyView): GameApi {
  async function call<T>(method: "GET" | "POST" | "PUT", path: string, body: unknown, parse: (json: unknown) => T, signal?: AbortSignal): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${proxy.baseUrl}/events/new-year${path}`, {
        method,
        cache: "no-store",
        headers: {
          "X-RosTalk-Proxy-Token": proxy.token,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (isAbort(error)) throw error;
      throw new GameApiError(0, "network");
    }
    let text: string;
    try {
      text = await readBounded(response);
    } catch (error) {
      if (isAbort(error)) throw error;
      throw error instanceof GameApiError ? error : new GameApiError(response.ok ? 0 : response.status, response.ok ? "network" : "request_failed");
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    if (!response.ok) {
      const code = isObject(json) && isObject(json.error) && typeof json.error.code === "string" ? json.error.code : "request_failed";
      throw new GameApiError(response.status, code);
    }
    if (json === undefined) invalid();
    return parse(json);
  }
  const day = (value: string) => ({ day: value });
  return {
    me: (signal) => call("GET", "/me", undefined, parseState, signal),
    enroll: (signal) => call("PUT", "/me/enrollment", {}, parseState, signal),
    claim: (value, signal) => call("POST", "/me/claim", day(value), (json) => ({ itemId: str(obj(json).itemId), state: parseState(obj(json).state) }), signal),
    water: (value, signal) => call("POST", "/me/water", day(value), parseState, signal),
    spin: (requestId, signal) => call("POST", "/me/spins", { requestId }, (json) => ({ receipt: parseReceipt(obj(json).receipt), state: parseState(obj(json).state) }), signal),
    saveLayout: (layout, signal) => call("PUT", "/me/layout", layout, parseState, signal),
    tree: (userId, signal) => Number.isSafeInteger(userId) && userId > 0
      ? call("GET", `/trees/${userId}`, undefined, parseTree, signal)
      : Promise.reject(new GameApiError(404, "not_found")),
  };
}
