import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGameApi } from "./api";
import { FakeServer, makeState, PROXY } from "./server.fixture";
import { createGameStore } from "./store";

let server: FakeServer;
let scope = 0;
function open(target: Parameters<typeof createGameStore>[2] = { kind: "self" }) {
  return createGameStore(createGameApi(PROXY), `srv:${++scope}`, target);
}

beforeEach(() => {
  server = new FakeServer(makeState({ flakes: 12, inventory: [{ itemId: "ball-red", qty: 1 }] }));
  vi.stubGlobal("fetch", server.fetch);
});
afterEach(() => vi.unstubAllGlobals());

describe("game store", () => {
  it("drops a stale read that finishes after a newer save", async () => {
    const store = open();
    await store.getState().load();
    const release = server.hold(/GET \/me/);
    const pending = store.getState().load();
    await vi.waitFor(() => expect(server.count("GET", "/me")).toBe(2));
    const snapshot = JSON.parse(JSON.stringify(server.state));
    store.getState().setDraft({ baseVersion: 0, background: "dusk", placements: [{ itemId: "ball-red", x: 500, y: 600, scale: 100, rotation: 0 }] });
    server.gates = [];
    expect(await store.getState().saveLayout()).toBe(true);
    release();
    await pending;
    expect(snapshot.layout.version).toBe(0);
    expect(store.getState().state?.layout.version).toBe(1);
    expect(store.getState().draft).toBeNull();
  });

  it("serializes mutations: a second spin while one runs is ignored", async () => {
    const store = open();
    await store.getState().load();
    const release = server.hold(/POST \/me\/spins/);
    const first = store.getState().spin();
    const second = await store.getState().spin();
    release();
    expect(second).toBeNull();
    expect((await first)?.cost).toBe(6);
    expect(server.count("POST", "/me/spins")).toBe(1);
    expect(store.getState().state?.flakes).toBe(6);
  });

  it("retries a lost spin with the same request ID and charges once", async () => {
    const store = open();
    await store.getState().load();
    server.fail(/POST \/me\/spins/, 500, "internal");
    expect(await store.getState().spin()).toBeNull();
    const id = store.getState().retryId;
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(store.getState().receipt).toBeNull();
    const receipt = await store.getState().spin();
    expect(receipt?.requestId).toBe(id);
    expect(server.calls.filter((c) => c.path === "/me/spins").map((c) => (c.body as { requestId: string }).requestId)).toEqual([id, id]);
    expect(store.getState().state?.flakes).toBe(6);
    expect(store.getState().retryId).toBeNull();
    await store.getState().spin();
    const ids = server.calls.filter((c) => c.path === "/me/spins").map((c) => (c.body as { requestId: string }).requestId);
    expect(ids[2]).not.toBe(id);
  });

  it("clears an earlier prize while a later lost reply is retried without a second charge", async () => {
    const store = open();
    await store.getState().load();
    const first = await store.getState().spin();
    expect(first).not.toBeNull();
    const fetch = server.fetch;
    let loseReply = true;
    vi.stubGlobal("fetch", async (...args: Parameters<typeof globalThis.fetch>) => {
      const response = await fetch(...args);
      if (loseReply && String(args[0]).endsWith("/me/spins")) {
        loseReply = false;
        return new Response(JSON.stringify({ error: { code: "internal", message: "lost reply" } }), { status: 500 });
      }
      return response;
    });
    expect(await store.getState().spin()).toBeNull();
    const retryId = store.getState().retryId;
    expect(store.getState().receipt).toBeNull();
    const balanceAfterCommit = server.state.flakes;
    const retried = await store.getState().spin();
    expect(retried?.requestId).toBe(retryId);
    expect(retried?.requestId).not.toBe(first?.requestId);
    expect(server.state.flakes).toBe(balanceAfterCommit);
    expect(server.calls.filter((c) => c.path === "/me/spins").map((c) => (c.body as { requestId: string }).requestId)).toEqual([first?.requestId, retryId, retryId]);
  });

  it("rejects out-of-range rotation before a layout request and accepts both bounds", async () => {
    const store = open();
    await store.getState().load();
    for (const rotation of [-46, 46]) {
      store.getState().setDraft({ baseVersion: 0, background: "dusk", placements: [{ itemId: "ball-red", x: 500, y: 600, scale: 100, rotation }] });
      expect(await store.getState().saveLayout()).toBe(false);
      expect(store.getState().error?.code).toBe("invalid_layout");
    }
    expect(server.count("PUT", "/me/layout")).toBe(0);
    for (const rotation of [-45, 45]) {
      store.getState().setDraft({ baseVersion: store.getState().state!.layout.version, background: "dusk", placements: [{ itemId: "ball-red", x: 500, y: 600, scale: 100, rotation }] });
      expect(await store.getState().saveLayout()).toBe(true);
      expect(server.state.layout.placements[0]?.rotation).toBe(rotation);
    }
  });

  it("keeps the pending spin across a closed window and a definite refusal clears it", async () => {
    const scopeKey = `srv:keep:${++scope}`;
    const first = createGameStore(createGameApi(PROXY), scopeKey, { kind: "self" });
    await first.getState().load();
    const release = server.hold(/POST \/me\/spins/);
    void first.getState().spin();
    await vi.waitFor(() => expect(server.count("POST", "/me/spins")).toBe(1));
    const id = first.getState().retryId;
    first.getState().dispose();
    release();
    const second = createGameStore(createGameApi(PROXY), scopeKey, { kind: "self" });
    expect(second.getState().retryId).toBe(id);
    await second.getState().load();
    expect((await second.getState().spin())?.requestId).toBe(id);
    const third = createGameStore(createGameApi(PROXY), scopeKey, { kind: "self" });
    expect(third.getState().retryId).toBeNull();
  });

  it("does not leave a pending ID after insufficient flakes and re-reads", async () => {
    server.state.flakes = 3;
    const store = open();
    await store.getState().load();
    expect(await store.getState().spin()).toBeNull();
    expect(store.getState().error?.code).toBe("insufficient_flakes");
    expect(store.getState().retryId).toBeNull();
    expect(store.getState().state?.flakes).toBe(3);
  });

  it("keeps the draft on a layout conflict and can reapply it on the new version", async () => {
    const store = open();
    await store.getState().load();
    store.getState().setDraft({ baseVersion: 0, background: "dusk", placements: [{ itemId: "ball-red", x: 400, y: 500, scale: 100, rotation: 0 }] });
    server.state.layout = { version: 3, background: "dusk", placements: [] };
    expect(await store.getState().saveLayout()).toBe(false);
    expect(store.getState().conflict).toBe(true);
    expect(store.getState().draft?.placements).toHaveLength(1);
    await vi.waitFor(() => expect(store.getState().state?.layout.version).toBe(3));
    store.getState().reapplyDraft();
    expect(store.getState().draft?.baseVersion).toBe(3);
    expect(await store.getState().saveLayout()).toBe(true);
    expect(server.state.layout.version).toBe(4);
    expect(server.state.layout.placements).toHaveLength(1);
  });

  it("sends only contract fields in a layout save", async () => {
    const store = open();
    await store.getState().load();
    store.getState().setDraft({ baseVersion: 0, background: "dusk", placements: [{ itemId: "ball-red", x: 400, y: 500, scale: 100, rotation: 0 }] });
    await store.getState().saveLayout();
    const body = server.calls.find((c) => c.path === "/me/layout")?.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["background", "placements", "version"]);
    expect(Object.keys((body.placements as object[])[0] as object).sort()).toEqual(["itemId", "rotation", "scale", "x", "y"]);
  });

  it("separates a hidden peer, an empty tree and a transport error", async () => {
    server.trees.set(5, null);
    server.trees.set(6, { growthDays: 3, background: "dusk", placements: [] });
    const empty = open({ kind: "peer", userId: 5, nickname: "a" });
    await empty.getState().loadPeer();
    expect(empty.getState().peer.status).toBe("empty");
    const ready = open({ kind: "peer", userId: 6, nickname: "b" });
    await ready.getState().loadPeer();
    expect(ready.getState().peer).toMatchObject({ status: "ready", tree: { growthDays: 3 } });
    const missing = open({ kind: "peer", userId: 9, nickname: "c" });
    await missing.getState().loadPeer();
    expect(missing.getState().peer.status).toBe("notFound");
    server.offline = true;
    const broken = open({ kind: "peer", userId: 6, nickname: "b" });
    await broken.getState().loadPeer();
    expect(broken.getState().peer.status).toBe("error");
    expect(server.calls.every((c) => c.method === "GET" && !c.path.startsWith("/me"))).toBe(true);
  });

  it("rejects malformed responses and oversized bodies", async () => {
    server.fail(/GET \/me/, 200, "x");
    const original = server.fetch;
    vi.stubGlobal("fetch", async (...args: Parameters<typeof fetch>) => {
      const response = await original(...args);
      return response.status === 200 && String(args[0]).endsWith("/me") ? new Response("{\"phase\":1}", { status: 200 }) : response;
    });
    const store = open();
    await store.getState().load();
    expect(store.getState().error?.code).toBe("invalid_response");
    vi.stubGlobal("fetch", async () => new Response("x".repeat(40 * 1024), { status: 200 }));
    await store.getState().load();
    expect(store.getState().error?.code).toBe("invalid_response");
  });

  it("applies nothing after dispose", async () => {
    const store = open();
    const release = server.hold(/GET \/me/);
    const pending = store.getState().load();
    await vi.waitFor(() => expect(server.calls).toHaveLength(1));
    store.getState().dispose();
    release();
    await pending;
    expect(store.getState().state).toBeNull();
  });
});
