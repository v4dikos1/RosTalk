import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";
import { fixtureState } from "@/mock/fixtures";
import { useCoreStore } from "@/store/coreStore";
import { useStreamStore } from "@/store/streamStore";

import { StreamStartDialog } from "./StreamStartDialog";

describe("StreamStartDialog", () => {
  const start = vi.fn(async () => {});

  beforeEach(async () => {
    await i18n.changeLanguage("ru");
    useCoreStore.setState({
      state: structuredClone(fixtureState),
      hydrated: true,
      pending: [],
      actionError: null,
    });
    useStreamStore.setState({
      local: {
        streaming: false,
        preset: "1080p30",
        hasAudio: false,
        audioPath: null,
        stats: null,
        native: false,
        nativeStatus: null,
      },
      error: null,
      start,
    });
    start.mockClear();
  });

  it("has no text/game mode switch any more", async () => {
    render(
      <StreamStartDialog open onOpenChange={() => {}} channelId={4} />,
    );

    expect(screen.queryByText("Режим")).toBeNull();
    expect(screen.queryByText("Текст")).toBeNull();
    expect(i18n.exists("streams.mode")).toBe(false);
    expect(i18n.exists("streams.modeText")).toBe(false);
    const en = i18n.getResourceBundle("en", "translation") as {
      streams: Record<string, unknown>;
    };
    expect(en.streams.mode).toBeUndefined();
    expect(en.streams.modeText).toBeUndefined();
  });

  it("starts without a mode field", async () => {
    render(
      <StreamStartDialog open onOpenChange={() => {}} channelId={4} />,
    );

    await userEvent.click(screen.getByTestId("stream-start"));
    expect(start).toHaveBeenCalledWith({
      preset: "1080p30",
      includeAudio: true,
      native: false,
    });
  });

  it("keeps the experimental native mode off and unsupported outside the desktop shell", async () => {
    render(
      <StreamStartDialog open onOpenChange={() => {}} channelId={4} />,
    );

    const toggle = screen.getByTestId("stream-native-toggle");
    expect(toggle).toBeDisabled();
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(screen.getByTestId("stream-native-hint")).toHaveTextContent(
      /desktop|клиент/i,
    );
  });

  it("offers the native source preset advertised for the HQ permission", async () => {
    render(
      <StreamStartDialog
        open
        onOpenChange={() => {}}
        channelId={4}
        presets={["720p30", "1080p30", "1080p60", "source"]}
      />,
    );

    const labels = screen
      .getAllByRole("option")
      .map((option) => option.textContent);
    expect(labels).toEqual([
      "720p · 30",
      "1080p · 30",
      "1080p · 60",
      "Исходное (до 1440p · 60)",
    ]);

    await userEvent.selectOptions(screen.getByTestId("stream-preset"), "source");
    await userEvent.click(screen.getByTestId("stream-start"));
    expect(start).toHaveBeenCalledWith({
      preset: "source",
      includeAudio: true,
      native: false,
    });
  });
});
