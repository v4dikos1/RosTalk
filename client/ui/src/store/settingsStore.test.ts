import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { coreApi } from "@/core";
import type { ClientSettings } from "@/core/api";
import { resetFixtureSettings } from "@/mock/fixtureApi";
import { fixtureSettings } from "@/mock/fixtures";

import { useSettingsStore } from "./settingsStore";

const { getState } = useSettingsStore;

function pendingSave() {
  let resolve!: (settings: ClientSettings) => void;
  const promise = new Promise<ClientSettings>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

beforeEach(async () => {
  resetFixtureSettings();
  vi.spyOn(coreApi, "getSettings");
  await getState().hydrate();
});

afterEach(() => vi.restoreAllMocks());

describe("New Year settings persistence", () => {
  it("round-trips installation and uninstall through the version 4 fixture", async () => {
    expect(getState().settings?.version).toBe(4);
    expect(getState().persistedNewYear).toBe("absent");

    for (const newYear of ["enabled", "disabled", "absent"] as const) {
      await getState().update({ plugins: { newYear } });
      await getState().hydrate();
      expect(getState().settings?.plugins.newYear).toBe(newYear);
      expect(getState().persistedNewYear).toBe(newYear);
    }
  });

  it("confirms enable only after persistence and applies disable immediately", async () => {
    const enable = pendingSave();
    const disable = pendingSave();
    vi.spyOn(coreApi, "updateSettings")
      .mockReturnValueOnce(enable.promise)
      .mockReturnValueOnce(disable.promise);

    const enabling = getState().update({ plugins: { newYear: "enabled" } });
    expect(getState().settings?.plugins.newYear).toBe("enabled");
    expect(getState().persistedNewYear).toBe("absent");
    expect(getState().newYearUpdatePending).toBe(true);
    enable.resolve({ ...fixtureSettings, plugins: { newYear: "enabled" } });
    await enabling;
    expect(getState().persistedNewYear).toBe("enabled");
    expect(getState().newYearUpdatePending).toBe(false);

    const disabling = getState().update({ plugins: { newYear: "disabled" } });
    expect(getState().settings?.plugins.newYear).toBe("disabled");
    expect(getState().persistedNewYear).toBe("enabled");
    disable.resolve({ ...fixtureSettings, plugins: { newYear: "disabled" } });
    await disabling;
    expect(getState().persistedNewYear).toBe("disabled");
    expect(getState().newYearUpdatePending).toBe(false);
  });

  it("rehydrates the confirmed value and keeps the save error", async () => {
    const failure = { code: "internal", message: "Could not write settings" };
    vi.spyOn(coreApi, "updateSettings").mockRejectedValueOnce(failure);

    await getState().update({ plugins: { newYear: "enabled" } });

    expect(getState().settings?.plugins.newYear).toBe("absent");
    expect(getState().persistedNewYear).toBe("absent");
    expect(getState().newYearUpdatePending).toBe(false);
    expect(getState().error).toEqual(failure);
    expect(coreApi.getSettings).toHaveBeenCalledTimes(2);
  });

  it("does not retry a failed enable with an unrelated queued write", async () => {
    const update = vi.spyOn(coreApi, "updateSettings")
      .mockRejectedValueOnce({ code: "internal", message: "Could not write settings" })
      .mockImplementationOnce(async (settings) => settings);

    const enabling = getState().update({ plugins: { newYear: "enabled" } });
    const rename = getState().update({ nickname: "Alex2" });
    await Promise.all([enabling, rename]);

    expect(update.mock.calls.map(([settings]) => settings.plugins.newYear)).toEqual([
      "enabled", "absent",
    ]);
    expect(getState().settings?.plugins.newYear).toBe("absent");
    expect(getState().settings?.nickname).toBe("Alex2");
    expect(getState().persistedNewYear).toBe("absent");
  });
});
