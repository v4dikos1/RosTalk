import { beforeEach, describe, expect, it, vi } from "vitest";

import { coreApi } from "@/core";
import type { ClientSettings, VoiceState } from "@/core/api";
import { fixtureSettings, fixtureState } from "@/mock/fixtures";
import { useAppStore } from "@/store/appStore";
import { useCoreStore } from "@/store/coreStore";
import { useSettingsStore } from "@/store/settingsStore";
import { useVoiceStore } from "@/store/voiceStore";

import { currentVoiceChannelId, joinVoiceChannel } from "./channels";

describe("joinVoiceChannel", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useCoreStore.setState({
      state: structuredClone(fixtureState),
      hydrated: true,
      pending: [],
      actionError: null,
    });
    useSettingsStore.setState({
      settings: structuredClone(fixtureSettings),
      loaded: true,
      error: null,
    });
    useAppStore.setState({ channelPasswordId: null });
    useVoiceStore.setState({
      state: null,
      levels: null,
      stats: null,
      previousStats: null,
      devices: null,
    });
    vi.spyOn(coreApi, "updateSettings").mockImplementation(
      async (settings: ClientSettings) => settings,
    );
  });

  it("does not join the channel the user is already in while its media is live", async () => {
    // The fixture self user sits in channel 3; the server would remove and
    // re-add the participant and drop the media session for ~100 ms.
    useVoiceStore.setState({
      state: { channelId: 3, media: "connected" } as unknown as VoiceState,
    });
    const join = vi.spyOn(coreApi, "joinChannel").mockResolvedValue();

    await expect(joinVoiceChannel(3)).resolves.toBe(true);

    expect(join).not.toHaveBeenCalled();
  });

  it("restores audio when the user is in the channel but its media is gone", async () => {
    // A moderator move updates the presence and removes the media participant;
    // the click on the current channel must not stay a no-op.
    useVoiceStore.setState({
      state: { channelId: 3, media: "idle" } as unknown as VoiceState,
    });
    const join = vi.spyOn(coreApi, "joinChannel").mockResolvedValue();

    await expect(joinVoiceChannel(3)).resolves.toBe(true);

    expect(join).toHaveBeenCalledWith(3, null);
  });

  it("restores audio when the engine still holds another room", async () => {
    useVoiceStore.setState({
      state: { channelId: 5, media: "connected" } as unknown as VoiceState,
    });
    const join = vi.spyOn(coreApi, "joinChannel").mockResolvedValue();

    await expect(joinVoiceChannel(3)).resolves.toBe(true);

    expect(join).toHaveBeenCalledWith(3, null);
  });

  it("joins another channel and remembers it as the default", async () => {
    const join = vi.spyOn(coreApi, "joinChannel").mockResolvedValue();
    const update = vi.spyOn(coreApi, "updateSettings");

    await expect(joinVoiceChannel(4)).resolves.toBe(true);

    expect(join).toHaveBeenCalledWith(4, null);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ defaultChannelId: 4 }),
    );
  });

  it("still asks for a password when the server rejects the join", async () => {
    const join = vi.spyOn(coreApi, "joinChannel").mockRejectedValue({
      code: "serverError",
      message: "channel password required",
      retryable: true,
      actionUrl: null,
      serverCode: "channelPasswordRequired",
    });
    const update = vi.spyOn(coreApi, "updateSettings");

    await expect(joinVoiceChannel(4)).resolves.toBe(false);

    expect(join).toHaveBeenCalledWith(4, null);
    expect(useAppStore.getState().channelPasswordId).toBe(4);
    expect(update).not.toHaveBeenCalled();
    expect(useCoreStore.getState().actionError).toBeNull();
  });

  it("falls back to the engine channel when the core mirror has no self user", async () => {
    useCoreStore.setState({ state: null, hydrated: false });
    useVoiceStore.setState({
      state: { channelId: 3, media: "connected" } as unknown as VoiceState,
    });
    const join = vi.spyOn(coreApi, "joinChannel").mockResolvedValue();

    expect(currentVoiceChannelId()).toBe(3);
    await expect(joinVoiceChannel(3)).resolves.toBe(true);
    expect(join).not.toHaveBeenCalled();
  });

  it("joins when the self user has left and the engine still holds the old room", async () => {
    const state = structuredClone(fixtureState);
    state.users = state.users.map((user) =>
      user.id === state.selfUserId ? { ...user, channelId: 0 } : user,
    );
    useCoreStore.setState({ state, hydrated: true });
    useVoiceStore.setState({
      state: { channelId: 5 } as unknown as VoiceState,
    });
    const join = vi.spyOn(coreApi, "joinChannel").mockResolvedValue();

    expect(currentVoiceChannelId()).toBeNull();
    await expect(joinVoiceChannel(5)).resolves.toBe(true);
    expect(join).toHaveBeenCalledWith(5, null);
  });

  it("joins when neither the mirror nor the engine has a channel", async () => {
    useCoreStore.setState({ state: null, hydrated: false });
    const join = vi.spyOn(coreApi, "joinChannel").mockResolvedValue();

    expect(currentVoiceChannelId()).toBeNull();
    await expect(joinVoiceChannel(3)).resolves.toBe(true);
    expect(join).toHaveBeenCalledWith(3, null);
  });
});
