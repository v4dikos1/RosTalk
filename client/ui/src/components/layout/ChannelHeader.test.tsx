import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import type { ChannelView } from "@/core/api";
import { i18n } from "@/i18n";
import { fixtureChannel } from "@/mock/fixtures";

import { ChannelHeader } from "./ChannelHeader";

const longName =
  "Очень длинное название голосового канала для проверки переноса";
const longTopic =
  "Тема канала тоже длинная: здесь собираемся по вечерам, обсуждаем катки и смотрим записи";

function channel(overrides: Partial<ChannelView> = {}): ChannelView {
  return fixtureChannel(4, 101, 1, longName, longTopic, "voice", overrides);
}

function renderHeader(overrides: Partial<ChannelView> = {}) {
  const onWatch = vi.fn();
  const onToggle = vi.fn();
  render(
    <TooltipProvider delayDuration={0}>
      <ChannelHeader
        channel={channel(overrides)}
        memberCount={6}
        connected
        onJoin={() => {}}
        streamingCount={2}
        onWatchStreams={onWatch}
        onStartStream={() => {}}
        onStopStream={() => {}}
        membersOpen
        onToggleMembers={onToggle}
      />
    </TooltipProvider>,
  );
  return { onWatch, onToggle };
}

describe("ChannelHeader", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("ru");
  });

  it("keeps a long name and topic readable without dropping the badges", () => {
    renderHeader();

    const name = screen.getByRole("heading", { name: longName });
    expect(name).toHaveAttribute("title", longName);
    expect(screen.getByText(longTopic)).toHaveAttribute("title", longTopic);
    expect(screen.getByTestId("channel-you-are-here")).toHaveTextContent(
      "Вы здесь",
    );
    expect(screen.getByTestId("channel-live")).toHaveTextContent("В эфире");
    expect(screen.getByTestId("channel-live")).toHaveTextContent("2");
    expect(screen.getByText("Участников: 6")).toBeInTheDocument();
  });

  it("wraps its groups instead of overlapping them", () => {
    renderHeader();

    const header = screen.getByTestId("channel-live").closest("header");
    expect(header).not.toBeNull();
    expect(header?.className).toContain("flex-wrap");
    const identity = header?.querySelector(":scope > div");
    expect(identity?.className).toContain("min-w-[220px]");
  });

  it("keeps the stream shortcut and the member-pane toggle keyboard reachable", async () => {
    const { onWatch, onToggle } = renderHeader();

    await userEvent.click(screen.getByTestId("channel-live"));
    expect(onWatch).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByTestId("toggle-members"));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("no longer duplicates invite or leaving from the header", () => {
    renderHeader();
    expect(screen.queryByTestId("invite-open")).toBeNull();
    expect(screen.queryByTestId("invite-popover")).toBeNull();
    expect(screen.queryByText("Покинуть канал")).toBeNull();
    expect(screen.getByTestId("toggle-stream")).toBeInTheDocument();
  });
});
