import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { coreApi } from "@/core";
import type { ClientSettings } from "@/core/api";
import { i18n } from "@/i18n";
import { fixtureSettings, fixtureState } from "@/mock/fixtures";
import { useAppStore } from "@/store/appStore";
import { useCoreStore } from "@/store/coreStore";
import { useSettingsStore } from "@/store/settingsStore";

import { ChannelPasswordDialog } from "./ChannelPasswordDialog";

describe("ChannelPasswordDialog", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("ru");
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
    useAppStore.setState({ channelPasswordId: 3 });
    vi.spyOn(coreApi, "updateSettings").mockImplementation(
      async (settings: ClientSettings) => settings,
    );
  });

  it("sends the password and closes after the server accepts it", async () => {
    const join = vi.spyOn(coreApi, "joinChannel").mockResolvedValue();
    render(<ChannelPasswordDialog />);

    expect(screen.getByTestId("channel-password")).toHaveTextContent("Общий");
    await userEvent.type(screen.getByTestId("channel-password-input"), "secret");
    await userEvent.click(screen.getByTestId("channel-password-submit"));

    await waitFor(() => expect(join).toHaveBeenCalledWith(3, "secret"));
    expect(useAppStore.getState().channelPasswordId).toBeNull();
  });

  it("shows a wrong password as human text", async () => {
    vi.spyOn(coreApi, "joinChannel").mockRejectedValue({
      code: "serverError",
      message: "invalid channel password",
      retryable: true,
      actionUrl: null,
      serverCode: "channelPasswordInvalid",
    });
    render(<ChannelPasswordDialog />);
    await userEvent.type(screen.getByTestId("channel-password-input"), "nope");
    await userEvent.click(screen.getByTestId("channel-password-submit"));

    expect(
      await screen.findByText("Неверный пароль канала"),
    ).toBeInTheDocument();
    expect(screen.queryByText("invalid channel password")).not.toBeInTheDocument();
    expect(useAppStore.getState().channelPasswordId).toBe(3);
  });
});
