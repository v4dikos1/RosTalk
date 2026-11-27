import { fixtureState } from "@/mock/fixtures";

import { mentionCandidates } from "./chat";

const self = fixtureState.selfUserId;

describe("mentionCandidates", () => {
  it("offers every other online user in a channel", () => {
    const ids = mentionCandidates(
      fixtureState.users,
      { kind: "channel", channelId: 2 },
      self,
    ).map((user) => user.id);
    expect(ids).not.toContain(self);
    expect(ids).toEqual(
      fixtureState.users.filter((user) => user.id !== self).map((user) => user.id),
    );
  });

  it("offers only the peer in a direct message", () => {
    const peerId = fixtureState.users.find((user) => user.id !== self)!.id;
    const ids = mentionCandidates(
      fixtureState.users,
      { kind: "dm", peerId },
      self,
    ).map((user) => user.id);
    expect(ids).toEqual([peerId]);
  });
});
