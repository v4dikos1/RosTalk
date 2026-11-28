import type { GameState, Placement, PublicTree } from "./api";

export const PROXY = { baseUrl: "http://127.0.0.1:9", token: "tok" };

export function makeState(patch: Partial<GameState> = {}): GameState {
  return {
    season: "2026-12", phase: "active", zone: "UTC", day: "2026-12-03", nextDayAt: "2026-12-04T00:00:00Z",
    enrolled: true, water: 0, flakes: 0, claims: [], wateredDays: [], growthDays: 0, inventory: [],
    layout: { version: 0, background: "dusk", placements: [] }, unlockedBackgrounds: ["dusk"], history: [],
    ...patch,
  };
}

export interface Call { method: string; path: string; body: unknown; token: string | null }
interface Rule { match: RegExp; status: number; code: string; once: boolean }

/**
 * In-memory stand-in for the event routes of the contract. It checks the
 * proxy header, keeps one authoritative state and records every request.
 */
export class FakeServer {
  state: GameState;
  trees = new Map<number, PublicTree | null>();
  calls: Call[] = [];
  rules: Rule[] = [];
  gates: { match: RegExp; promise: Promise<void> }[] = [];
  offline = false;
  rolls: string[] = [];
  receipts = new Map<string, unknown>();

  constructor(state: GameState = makeState()) {
    this.state = state;
  }

  fail(match: RegExp, status: number, code: string, once = true) {
    this.rules.push({ match, status, code, once });
  }
  hold(match: RegExp): () => void {
    let release!: () => void;
    this.gates.push({ match, promise: new Promise<void>((resolve) => { release = resolve; }) });
    return release;
  }
  count(method: string, path: RegExp | string): number {
    return this.calls.filter((call) => call.method === method && (typeof path === "string" ? call.path === path : path.test(call.path))).length;
  }

  private json(status: number, body: unknown) {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }
  private error(status: number, code: string) {
    return this.json(status, { error: { code, message: code } });
  }

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const path = url.pathname.replace(/^\/events\/new-year/, "");
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    this.calls.push({ method, path, body, token: headers.get("X-RosTalk-Proxy-Token") });
    if (this.offline) throw new TypeError("Failed to fetch");
    const gate = this.gates.find((g) => g.match.test(`${method} ${path}`));
    if (gate) {
      await new Promise<void>((resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        void gate.promise.then(resolve);
      });
    }
    const rule = this.rules.find((r) => r.match.test(`${method} ${path}`));
    if (rule) {
      if (rule.once) this.rules.splice(this.rules.indexOf(rule), 1);
      return this.error(rule.status, rule.code);
    }
    if (headers.get("X-RosTalk-Proxy-Token") !== PROXY.token) return this.error(401, "unauthenticated");
    return this.route(method, path, body);
  };

  private route(method: string, path: string, body: unknown): Response {
    const s = this.state;
    const input = (body ?? {}) as Record<string, unknown>;
    if (method === "GET" && path === "/me") return s.phase === "closed" ? this.error(409, "event_closed") : this.json(200, s);
    if (method === "PUT" && path === "/me/enrollment") {
      s.enrolled = true;
      return this.json(200, s);
    }
    if (!s.enrolled && method !== "GET") return this.error(409, "not_enrolled");
    if (method === "POST" && path === "/me/claim") {
      if (s.phase !== "active") return this.error(409, "event_closed");
      if (input.day !== s.day) return this.error(409, "day_changed");
      if (s.claims.some((claim) => claim.day === s.day)) return this.error(409, "already_claimed");
      const itemId = this.rolls.shift() ?? "ball-red";
      s.claims.push({ day: s.day, itemId });
      s.water += 1;
      this.own(itemId);
      return this.json(200, { itemId, state: s });
    }
    if (method === "POST" && path === "/me/water") {
      if (s.phase !== "active") return this.error(409, "event_closed");
      if (input.day !== s.day) return this.error(409, "day_changed");
      if (s.wateredDays.includes(s.day)) return this.error(409, "already_watered");
      if (s.water < 1) return this.error(409, "no_water");
      s.water -= 1;
      s.wateredDays.push(s.day);
      s.growthDays += 1;
      return this.json(200, s);
    }
    if (method === "POST" && path === "/me/spins") {
      const requestId = String(input.requestId);
      const known = this.receipts.get(requestId);
      if (known) return this.json(200, { receipt: known, state: s });
      if (s.phase !== "active") return this.error(409, "event_closed");
      if (s.flakes < 6) return this.error(409, "insufficient_flakes");
      const itemId = this.rolls.shift() ?? "ball-gold";
      const duplicate = s.inventory.some((entry) => entry.itemId === itemId);
      const refund = duplicate ? 2 : 0;
      s.flakes -= 6 - refund;
      if (!duplicate) this.own(itemId);
      s.history.unshift({ kind: "spin", delta: -6, at: "2026-12-03T10:00:00Z" });
      if (duplicate) s.history.unshift({ kind: "duplicate", delta: 2, at: "2026-12-03T10:00:00Z" });
      const receipt = { requestId, itemId, duplicate, refund, cost: 6 };
      this.receipts.set(requestId, receipt);
      return this.json(200, { receipt, state: s });
    }
    if (method === "PUT" && path === "/me/layout") {
      const layout = input as { version: number; background: "dusk" | "aurora"; placements: Placement[] };
      if (layout.version !== s.layout.version) return this.error(409, "layout_conflict");
      if (layout.placements.length > 20) return this.error(400, "invalid_layout");
      if (layout.background === "aurora" && !s.unlockedBackgrounds.includes("aurora")) return this.error(409, "background_locked");
      for (const entry of s.inventory) {
        if (layout.placements.filter((p) => p.itemId === entry.itemId).length > entry.qty) return this.error(409, "not_owned");
      }
      if (layout.placements.some((p) => !s.inventory.some((e) => e.itemId === p.itemId))) return this.error(409, "not_owned");
      const same = JSON.stringify(layout.placements) === JSON.stringify(s.layout.placements) && layout.background === s.layout.background;
      s.layout = { version: same ? s.layout.version : s.layout.version + 1, background: layout.background, placements: layout.placements };
      return this.json(200, s);
    }
    const tree = /^\/trees\/(\d+)$/.exec(path);
    if (method === "GET" && tree) {
      const id = Number(tree[1]);
      return this.trees.has(id) ? this.json(200, { tree: this.trees.get(id) }) : this.error(404, "not_found");
    }
    return this.error(404, "not_found");
  }

  private own(itemId: string) {
    const entry = this.state.inventory.find((e) => e.itemId === itemId);
    if (entry) entry.qty += 1;
    else this.state.inventory.push({ itemId, qty: 1 });
  }
}
