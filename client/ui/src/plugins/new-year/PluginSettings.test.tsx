import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { coreApi } from "@/core";
import { i18n } from "@/i18n";
import { fixtureSettings, fixtureState } from "@/mock/fixtures";
import { useChatStore } from "@/store/chatStore";
import { useCoreStore } from "@/store/coreStore";
import { useSettingsStore } from "@/store/settingsStore";
import { PluginSettings } from "./PluginSettings";
import { clearPreferences, read, write } from "./support";

beforeEach(async () => { await i18n.changeLanguage("en"); clearPreferences(); });
it("clears every New Year preference without deleting unrelated storage", () => {
  for (const key of ["rostalk.newYear.probe", "rostalk.newYear.uninstalled:test", "rostalk.newYear.seen:test", "rostalk.newYear.open:test"]) write(key, "1");
  localStorage.setItem("other", "keep");
  clearPreferences();
  for (const key of ["rostalk.newYear.probe", "rostalk.newYear.uninstalled:test", "rostalk.newYear.seen:test", "rostalk.newYear.open:test"]) expect(read(key)).toBeNull();
  expect(localStorage.getItem("other")).toBe("keep");
});

it.each([
  [404, null, "Game unavailable"],
  [200, { apiVersion: 2, season: "2026-12", phase: "active" }, "Game unavailable"],
  [200, { apiVersion: 1, season: "2026-12", phase: "active" }, "Server supports the event"],
])("shows server availability and only probes support (%s)", async (status, body, expected) => {
  const state = structuredClone(fixtureState);
  state.server!.id = `settings-${status}-${body?.apiVersion ?? 0}`;
  const proxy = { baseUrl: "http://localhost:48", token: "fixture" };
  useCoreStore.setState({ state }); useChatStore.setState({ proxy });
  useSettingsStore.setState({ settings: { ...fixtureSettings, plugins: { newYear: "disabled" } }, persistedNewYear: "disabled", error: null });
  vi.spyOn(coreApi, "chatProxy").mockResolvedValue(proxy);
  const fetch = vi.spyOn(window, "fetch").mockResolvedValue(new Response(JSON.stringify(body), { status }));
  render(<PluginSettings />);
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(expected));
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(String(fetch.mock.calls[0]?.[0])).toBe(`${proxy.baseUrl}/events/new-year/support`);
});

it("shows disconnected state without probing", () => {
  useCoreStore.setState({ state: { ...fixtureState, connection: "disconnected" } });
  const fetch = vi.spyOn(window, "fetch");
  render(<PluginSettings />);
  expect(screen.getByRole("status")).toHaveTextContent("Not connected to a server");
  expect(fetch).not.toHaveBeenCalled();
});

it("does not start a probe after settings closes during proxy verification", async () => {
  const state = structuredClone(fixtureState);
  state.server!.id = "settings-cancel";
  const proxy = { baseUrl: "http://localhost:49", token: "fixture" };
  useCoreStore.setState({ state }); useChatStore.setState({ proxy });
  let finish!: (value: typeof proxy) => void;
  vi.spyOn(coreApi, "chatProxy").mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  const fetch = vi.spyOn(window, "fetch");
  const view = render(<PluginSettings />);
  view.unmount();
  finish(proxy);
  await Promise.resolve();
  await Promise.resolve();
  expect(fetch).not.toHaveBeenCalled();
});
