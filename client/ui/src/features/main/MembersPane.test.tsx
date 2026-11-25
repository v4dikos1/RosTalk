import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";
import { fixtureState } from "@/mock/fixtures";

import { MembersPane } from "./MembersPane";

function renderPane(channelId = 4) {
  const channel = fixtureState.channels.find((item) => item.id === channelId);
  if (!channel) {
    throw new Error(`fixture channel ${channelId} is missing`);
  }
  render(
    <MembersPane
      channel={channel}
      users={fixtureState.users}
      channels={fixtureState.channels}
      roles={fixtureState.roles}
      selfUserId={fixtureState.selfUserId}
      speakingUserIds={new Set()}
      serverId="fixture-server"
      connected
      onClose={vi.fn()}
      onUserMenu={vi.fn()}
    />,
  );
}

describe("MembersPane", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("ru");
  });

  it("counts the viewers of a streamer", () => {
    renderPane();

    const count = screen.getByTestId("member-viewers-6");
    expect(count).toHaveAttribute("data-count", "2");
    expect(count).toHaveTextContent("2");
    expect(count).toHaveAttribute("aria-label", "Зрителей: 2");
    // A member who is not streaming has no audience badge.
    expect(screen.queryByTestId("member-viewers-5")).toBeNull();
  });
});
