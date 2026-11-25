import { currentVoiceChannelId, joinVoiceChannel } from "@/lib/channels";
import { useStreamStore } from "@/store/streamStore";

/**
 * Opens a stream from a channel tree or the streams tab.
 *
 * The media token is bound to the caller's channel (the server checks the
 * presence), so watching a stream in another channel first joins it. A failed
 * join is already reported by `joinVoiceChannel`.
 */
export async function watchStreamInChannel(
  channelId: number,
  userId: number,
): Promise<void> {
  if (currentVoiceChannelId() !== channelId) {
    const joined = await joinVoiceChannel(channelId);
    if (!joined) {
      return;
    }
  }
  // The control event that updates the mirror may arrive a tick later; point
  // the engine at the channel before adding the stream, otherwise the later
  // `setChannel` effect would discard the subscription.
  useStreamStore.getState().setChannel(channelId);
  await useStreamStore.getState().watch(userId);
}
