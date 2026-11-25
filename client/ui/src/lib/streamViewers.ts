import type { UserView } from "@/core/api";

/**
 * Users that watch the stream of `streamerId` (stage P12).
 *
 * The server keeps the list per viewer (`watchingUserIds`), so the audience of
 * a tile is derived from the presence instead of a second counter that could
 * drift. The order is stable (nickname, then id) so a stack of avatars does not
 * shuffle when an unrelated presence event arrives.
 */
export function streamViewers(
  users: readonly UserView[],
  streamerId: number,
): UserView[] {
  return users
    .filter(
      (user) =>
        user.id !== streamerId && user.watchingUserIds.includes(streamerId),
    )
    .slice()
    .sort(
      (a, b) => a.nickname.localeCompare(b.nickname) || a.id - b.id,
    );
}
