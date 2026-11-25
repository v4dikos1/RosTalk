// Screen-share codec choice (stage P14).
//
// H.264 with simulcast is the default because every Windows GPU has a hardware
// H.264 encoder and every WebView2 build can decode it. VP9 and AV1 are only
// worth it when the browser has a *hardware* encoder for them: VP9 SVC and AV1
// SVC are encoded by the browser (three spatial layers in one stream), and a
// software encoder burns the streamer's CPU for a picture the GPU would have
// produced for free.
//
// Chromium exposes that through `MediaCapabilities.encodingInfo`: the W3C
// definition of `powerEfficient` is "the encoder uses hardware". It is not a
// perfect signal (Chrome 159 reports `powerEfficient: false` even for NVENC
// H.264, see docs/PERF.md), so the probe can only ever promote H.264 to
// VP9/AV1 when the browser says so — never the other way round.

export type StreamVideoCodec = "h264" | "vp9" | "av1";

export interface StreamCodecProfile {
  width: number;
  height: number;
  fps: number;
  bitrate: number;
}

export interface StreamCodecChoice {
  codec: StreamVideoCodec;
  /** Publish three spatial layers in one stream (`L3T3_KEY`). */
  svc: boolean;
}

/** Spatial scalability for VP9/AV1 SVC publishing. */
export const SVC_SCALABILITY_MODE = "L3T3_KEY";

/**
 * Whether the browser has a hardware encoder for `codec`.
 *
 * `encodingInfo` is the only standard API that answers this. A browser without
 * it, or one that throws on the config, is treated as software-only.
 */
export async function hasHardwareEncoder(
  codec: "vp9" | "av1",
  profile: StreamCodecProfile,
): Promise<boolean> {
  const capabilities = navigator.mediaCapabilities;
  if (!capabilities || typeof capabilities.encodingInfo !== "function") {
    return false;
  }
  try {
    const info = await capabilities.encodingInfo({
      type: "webrtc",
      video: {
        contentType: `video/${codec}`,
        width: profile.width,
        height: profile.height,
        bitrate: profile.bitrate,
        framerate: profile.fps,
      },
    });
    return info.supported && info.powerEfficient;
  } catch {
    return false;
  }
}

/**
 * Picks the publishing codec: AV1 SVC and VP9 SVC only with a hardware
 * encoder, otherwise H.264 simulcast.
 */
export async function chooseStreamCodec(
  profile: StreamCodecProfile,
): Promise<StreamCodecChoice> {
  if (await hasHardwareEncoder("av1", profile)) {
    return { codec: "av1", svc: true };
  }
  if (await hasHardwareEncoder("vp9", profile)) {
    return { codec: "vp9", svc: true };
  }
  return { codec: "h264", svc: false };
}
