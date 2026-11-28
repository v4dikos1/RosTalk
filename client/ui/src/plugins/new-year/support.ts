import type { ChatProxyView } from "@/core/api";

export type Support = { apiVersion: number; season: string; phase: "upcoming" | "active" | "gallery" | "closed" };
const memory = new Map<string, string>();
export function read(key: string): string | null { try { return localStorage.getItem(key) ?? memory.get(key) ?? null; } catch { return memory.get(key) ?? null; } }
export function write(key: string, value: string) { memory.set(key, value); try { localStorage.setItem(key, value); } catch { /* memory fallback */ } }
export function clearPreferences() {
  for (const key of memory.keys()) if (key.startsWith("rostalk.newYear.")) memory.delete(key);
  try { for (let i = localStorage.length - 1; i >= 0; i--) { const key = localStorage.key(i); if (key?.startsWith("rostalk.newYear.")) localStorage.removeItem(key); } } catch { /* memory fallback */ }
}
const pending = new Map<string, Promise<Support | null>>();
export function support(proxy: ChatProxyView, scope: string): Promise<Support | null> {
  const key = "rostalk.newYear.probe";
  const existing = pending.get(scope);
  if (existing) return existing;
  const cached = read(key);
  if (cached) { try { const record = JSON.parse(cached) as { scope: string; result: Support | null }; if (record.scope === scope) return Promise.resolve(record.result); } catch { /* retry */ } }
  write(key, JSON.stringify({ scope, result: null }));
  const request = fetch(`${proxy.baseUrl}/events/new-year/support`, { headers: { "X-RosTalk-Proxy-Token": proxy.token }, cache: "no-store" }).then(async (response) => {
    if (!response.ok || Number(response.headers.get("content-length")) > 256) return null;
    const reader = response.body?.getReader();
    if (!reader) return null;
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 256) { void reader.cancel(); return null; } chunks.push(part.value); }
    const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const text = new TextDecoder().decode(bytes);
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object") return null;
    const v = value as Record<string, unknown>;
    if (typeof v.apiVersion !== "number" || typeof v.season !== "string" || !["upcoming", "active", "gallery", "closed"].includes(String(v.phase))) return null;
    return v as Support;
  }).catch(() => null).then((result) => { const current = read(key); if (current && JSON.parse(current).scope === scope) write(key, JSON.stringify({ scope, result })); return result; }).finally(() => pending.delete(scope));
  pending.set(scope, request);
  return request;
}
