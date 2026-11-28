import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { coreApi } from "@/core";
import { fixtureSettings, fixtureState } from "@/mock/fixtures";
import { useChatStore } from "@/store/chatStore";
import { useCoreStore } from "@/store/coreStore";
import { useSettingsStore } from "@/store/settingsStore";
import { useAppStore } from "@/store/appStore";
import { PluginHost } from "./PluginHost";
import { support } from "./support";
import { newYearManifest } from "./manifest";

it("does no network work while disabled", () => {
  const fetch = vi.spyOn(window, "fetch");
  useCoreStore.setState({ state: fixtureState });
  useChatStore.getState().setProxy({ baseUrl: "http://localhost:1", token: "test" });
  useSettingsStore.setState({ settings: { ...fixtureSettings, plugins: { newYear: "disabled" } }, persistedNewYear: "disabled" });
  render(<PluginHost />);
  expect(fetch).not.toHaveBeenCalled();
  expect(newYearManifest).toEqual({ id: "new-year", version: "1.0.0", apiVersion: 1, delivery: "builtin" });
});

it("coalesces a connected unseen probe through strict mode", async () => {
  localStorage.clear();
  const proxy = { baseUrl: "http://localhost:3", token: "test" };
  useChatStore.getState().setProxy(proxy);
  useSettingsStore.setState({ settings: { ...fixtureSettings, plugins: { newYear: "absent" } }, persistedNewYear: "absent" });
  vi.spyOn(coreApi, "chatProxy").mockResolvedValue(proxy);
  const fetch = vi.spyOn(window, "fetch").mockImplementation(async () => new Response(JSON.stringify({ apiVersion: 1, season: "2026-12", phase: "active" })));
  render(<PluginHost />, { reactStrictMode: true });
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull());
});

it("coalesces support requests and rejects oversized responses", async () => {
  const fetch = vi.spyOn(window, "fetch").mockResolvedValue(new Response(JSON.stringify({ apiVersion: 1, season: "2026-12", phase: "active" })));
  const proxy = { baseUrl: "http://localhost:1", token: "test" };
  const [a, b] = await Promise.all([support(proxy, "scope-a"), support(proxy, "scope-a")]);
  expect(a?.apiVersion).toBe(1);
  expect(b).toEqual(a);
  expect(fetch).toHaveBeenCalledTimes(1);
  fetch.mockResolvedValueOnce(new Response("x".repeat(257)));
  expect(await support(proxy, "scope-b")).toBeNull();
});

it("shows the promo once per server and probes only support while absent", async () => {
  const proxy = { baseUrl: "http://localhost:41", token: "test" };
  const state = structuredClone(fixtureState);
  state.server!.id = "promo-server-a";
  useCoreStore.setState({ state });
  useChatStore.getState().setProxy(proxy);
  useSettingsStore.setState({ settings: { ...fixtureSettings, plugins: { newYear: "absent" } }, persistedNewYear: "absent" });
  vi.spyOn(coreApi, "chatProxy").mockResolvedValue(proxy);
  const fetch = vi.spyOn(window, "fetch").mockImplementation(async () => new Response(JSON.stringify({ apiVersion: 1, season: "2026-12", phase: "active" })));
  const view = render(<PluginHost />);
  await screen.findByRole("dialog");
  await userEvent.click(screen.getByRole("button", { name: /Later|Позже/ }));
  view.unmount();
  const again = render(<PluginHost />);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(1);
  const other = structuredClone(state);
  other.server!.id = "promo-server-b";
  act(() => useCoreStore.setState({ state: other }));
  await screen.findByRole("dialog");
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([`${proxy.baseUrl}/events/new-year/support`, `${proxy.baseUrl}/events/new-year/support`]);
  again.unmount();
});

it("suppresses the promo for a 404 and leaves the chat UI usable", async () => {
  const proxy = { baseUrl: "http://localhost:42", token: "test" };
  const state = structuredClone(fixtureState);
  state.server!.id = "unsupported-server";
  useCoreStore.setState({ state });
  useChatStore.getState().setProxy(proxy);
  useSettingsStore.setState({ settings: { ...fixtureSettings, plugins: { newYear: "absent" } }, persistedNewYear: "absent" });
  useAppStore.setState({ newYearTarget: null });
  vi.spyOn(coreApi, "chatProxy").mockResolvedValue(proxy);
  const fetch = vi.spyOn(window, "fetch").mockResolvedValue(new Response("not found", { status: 404 }));
  const chat = vi.fn();
  render(<><button onClick={chat}>Chat</button><PluginHost /></>);
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  await userEvent.click(screen.getByRole("button", { name: "Chat" }));
  expect(chat).toHaveBeenCalledOnce();
  expect(screen.queryByRole("dialog")).toBeNull();
});
