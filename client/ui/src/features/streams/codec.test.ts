import { afterEach, describe, expect, it, vi } from "vitest";

import { chooseStreamCodec, hasHardwareEncoder } from "./codec";

const profile = { width: 1920, height: 1080, fps: 30, bitrate: 6_000_000 };

function stubEncodingInfo(
  answer: (contentType: string) => { supported: boolean; powerEfficient: boolean },
) {
  const encodingInfo = vi.fn(async (configuration: { video: { contentType: string } }) =>
    answer(configuration.video.contentType),
  );
  Object.defineProperty(navigator, "mediaCapabilities", {
    configurable: true,
    value: { encodingInfo },
  });
  return encodingInfo;
}

describe("stream codec choice", () => {
  afterEach(() => {
    delete (navigator as unknown as Record<string, unknown>).mediaCapabilities;
  });

  it("keeps H.264 when the browser reports no hardware AV1/VP9 encoder", async () => {
    stubEncodingInfo(() => ({ supported: true, powerEfficient: false }));
    await expect(chooseStreamCodec(profile)).resolves.toEqual({
      codec: "h264",
      svc: false,
    });
  });

  it("prefers AV1 SVC when AV1 has a hardware encoder", async () => {
    stubEncodingInfo((contentType) => ({
      supported: true,
      powerEfficient: contentType === "video/av1",
    }));
    await expect(hasHardwareEncoder("vp9", profile)).resolves.toBe(false);
    await expect(chooseStreamCodec(profile)).resolves.toEqual({
      codec: "av1",
      svc: true,
    });
  });

  it("uses VP9 SVC when only VP9 has a hardware encoder", async () => {
    stubEncodingInfo((contentType) => ({
      supported: true,
      powerEfficient: contentType === "video/vp9",
    }));
    await expect(chooseStreamCodec(profile)).resolves.toEqual({
      codec: "vp9",
      svc: true,
    });
  });

  it("falls back to H.264 when encodingInfo throws or is missing", async () => {
    Object.defineProperty(navigator, "mediaCapabilities", {
      configurable: true,
      value: {
        encodingInfo: async () => {
          throw new TypeError("unsupported");
        },
      },
    });
    await expect(chooseStreamCodec(profile)).resolves.toEqual({
      codec: "h264",
      svc: false,
    });
    delete (navigator as unknown as Record<string, unknown>).mediaCapabilities;
    await expect(chooseStreamCodec(profile)).resolves.toEqual({
      codec: "h264",
      svc: false,
    });
  });
});
