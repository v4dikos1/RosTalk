import { createStore, type StoreApi } from "zustand/vanilla";
import { validRotation } from "./placement";
import {
  GameApiError,
  isIndeterminate,
  type Background,
  type GameApi,
  type GameState,
  type GameTarget,
  type Layout,
  type Placement,
  type PublicTree,
  type SpinReceipt,
} from "./api";

export type Operation = "enroll" | "claim" | "water" | "spin" | "layout";
export type PeerStatus = "loading" | "ready" | "empty" | "notFound" | "error";

export interface GameFailure {
  op: Operation | "load" | "peer";
  status: number;
  code: string;
}

/** Unsaved layout; `baseVersion` is the server version it was started from. */
export interface LayoutDraft {
  baseVersion: number;
  background: Background;
  placements: Placement[];
}

export interface GameStoreState {
  loading: boolean;
  state: GameState | null;
  busy: Operation | null;
  error: GameFailure | null;
  lastClaim: string | null;
  receipt: SpinReceipt | null;
  /** Spin ID whose outcome is unknown; the next open reuses it. */
  retryId: string | null;
  draft: LayoutDraft | null;
  conflict: boolean;
  peer: { status: PeerStatus; tree: PublicTree | null };
  load(): Promise<void>;
  claim(): Promise<string | null>;
  water(): Promise<boolean>;
  spin(): Promise<SpinReceipt | null>;
  saveLayout(): Promise<boolean>;
  setDraft(draft: LayoutDraft | null): void;
  reloadLayout(): void;
  reapplyDraft(): void;
  clearError(): void;
  loadPeer(): Promise<void>;
  /** Starts (or, after `dispose`, restarts) the scope; StrictMode runs effects twice. */
  activate(): void;
  dispose(): void;
}

export type GameStore = StoreApi<GameStoreState>;

/** Codes after which the displayed state is probably stale and is re-read. */
const REREAD = new Set(["already_claimed", "already_watered", "day_changed", "not_enrolled", "event_closed", "no_water", "insufficient_flakes", "rate_limited"]);

/**
 * Spin IDs of unfinished opens. They outlive one window so that closing the
 * game mid-request and reopening it retries the same ID instead of charging
 * twice. Keyed by server and identity; cleared on any definite answer.
 */
const pendingSpins = new Map<string, string>();

export function newRequestId(): string {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function scopeKey(serverId: string, selfId: number): string {
  return `${serverId}:${selfId}`;
}

function failure(op: GameFailure["op"], error: unknown): GameFailure {
  return error instanceof GameApiError
    ? { op, status: error.status, code: error.code }
    : { op, status: 0, code: "network" };
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/**
 * Per-window game store. One instance owns the last authoritative state, the
 * busy operation, the spin retry ID and the unsaved layout. Mutations are
 * serialized (a second call while one runs is ignored); a read is applied only
 * if no newer response was applied since it started.
 */
export function createGameStore(api: GameApi, scope: string, target: GameTarget): GameStore {
  let abort = new AbortController();
  let live = true;
  let epoch = 0;
  let ticket = 0;
  let applied = 0;
  let enrollTried = false;

  return createStore<GameStoreState>()((set, get) => {
    const alive = (e: number) => live && e === epoch;
    const apply = (e: number, patch: Partial<GameStoreState>) => {
      if (alive(e)) set(patch);
    };

    async function read(): Promise<GameState | null> {
      const e = epoch;
      if (!live || get().busy) return null;
      const id = ++ticket;
      try {
        const state = await api.me(abort.signal);
        if (!alive(e) || id < applied || get().busy) return null;
        applied = id;
        set({ state });
        return state;
      } catch (error) {
        if (!isAbort(error) && alive(e) && id >= applied) set({ error: failure("load", error) });
        return null;
      }
    }

    async function mutate<T>(op: Operation, run: (signal: AbortSignal) => Promise<T>, done: (value: T) => Partial<GameStoreState>, onError?: (error: GameFailure) => void): Promise<boolean> {
      const e = epoch;
      if (!live || get().busy) return false;
      const id = ++ticket;
      set({ busy: op, error: null });
      try {
        const value = await run(abort.signal);
        if (!alive(e)) return false;
        applied = Math.max(applied, id);
        set({ ...done(value), busy: null, error: null });
        return true;
      } catch (error) {
        if (isAbort(error) || !alive(e)) return false;
        const info = failure(op, error);
        set({ busy: null, error: info });
        onError?.(info);
        if (REREAD.has(info.code)) void read();
        return false;
      }
    }

    return {
      loading: false,
      state: null,
      busy: null,
      error: null,
      lastClaim: null,
      receipt: null,
      retryId: pendingSpins.get(scope) ?? null,
      draft: null,
      conflict: false,
      peer: { status: "loading", tree: null },

      async load() {
        const e = epoch;
        if (!live || get().busy) return;
        set({ loading: true });
        const state = await read();
        apply(e, { loading: false });
        if (state) {
          if (get().error?.op === "load") apply(e, { error: null });
          if (target.kind === "self" && !enrollTried && state.phase === "active" && !state.enrolled) {
            enrollTried = true;
            await mutate("enroll", (signal) => api.enroll(signal), (next) => ({ state: next }));
          }
        }
      },

      claim: async () => {
        const state = get().state;
        if (!state || state.phase !== "active") return null;
        const out = { item: null as string | null };
        await mutate("claim", (signal) => api.claim(state.day, signal), (result) => {
          out.item = result.itemId;
          return { state: result.state, lastClaim: result.itemId };
        });
        return out.item;
      },

      water: async () => {
        const state = get().state;
        if (!state || state.phase !== "active") return false;
        return mutate("water", (signal) => api.water(state.day, signal), (next) => ({ state: next }));
      },

      spin: async () => {
        const state = get().state;
        const retry = get().retryId ?? pendingSpins.get(scope) ?? null;
        if (!live || !state || get().busy) return null;
        if (!retry && state.phase !== "active") return null;
        const requestId = retry ?? newRequestId();
        pendingSpins.set(scope, requestId);
        set({ retryId: requestId, receipt: null });
        const out = { receipt: null as SpinReceipt | null };
        await mutate("spin", (signal) => api.spin(requestId, signal), (result) => {
          out.receipt = result.receipt;
          pendingSpins.delete(scope);
          return { state: result.state, receipt: result.receipt, retryId: null };
        }, (info) => {
          if (!isIndeterminate(info)) {
            pendingSpins.delete(scope);
            set({ retryId: null });
          }
        });
        return out.receipt;
      },

      saveLayout: async () => {
        const { state, draft } = get();
        if (!state || !draft || get().busy) return false;
        if (draft.placements.some((placement) => !validRotation(placement.rotation))) {
          set({ error: { op: "layout", status: 400, code: "invalid_layout" } });
          return false;
        }
        const layout: Layout = {
          version: draft.baseVersion,
          background: draft.background,
          placements: draft.placements.map(({ itemId, x, y, scale, rotation }) => ({ itemId, x, y, scale, rotation })),
        };
        return mutate("layout", (signal) => api.saveLayout(layout, signal), (next) => ({ state: next, draft: null, conflict: false }), (info) => {
          if (info.code === "layout_conflict") {
            set({ conflict: true });
            void read();
          }
        });
      },

      setDraft(draft) {
        set({ draft });
      },
      reloadLayout() {
        set({ draft: null, conflict: false, error: null });
        void get().load();
      },
      reapplyDraft() {
        const { state, draft } = get();
        if (state && draft) set({ draft: { ...draft, baseVersion: state.layout.version }, conflict: false, error: null });
      },
      clearError() {
        set({ error: null });
      },

      async loadPeer() {
        if (target.kind !== "peer" || !live) return;
        const e = epoch;
        const id = ++ticket;
        set({ peer: { status: "loading", tree: null }, error: null });
        try {
          const tree = await api.tree(target.userId, abort.signal);
          if (!alive(e) || id < ticket) return;
          set({ peer: tree ? { status: "ready", tree } : { status: "empty", tree: null } });
        } catch (error) {
          if (isAbort(error) || !alive(e) || id < ticket) return;
          const info = failure("peer", error);
          set({ peer: { status: info.code === "not_found" ? "notFound" : "error", tree: null }, error: info });
        }
      },

      activate() {
        if (live) return;
        live = true;
        epoch += 1;
        abort = new AbortController();
        set({ loading: false, busy: null });
      },
      dispose() {
        live = false;
        epoch += 1;
        abort.abort();
      },
    };
  });
}
