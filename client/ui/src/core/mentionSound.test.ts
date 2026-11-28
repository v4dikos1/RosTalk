import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { playMentionSound, resetMentionSoundForTests } from "./mentionSound";

class FakeAudio {
  static instances: FakeAudio[] = [];

  currentTime = 0;
  volume = 1;
  readonly play = vi.fn().mockResolvedValue(undefined);
  readonly src: string;

  constructor(src: string) {
    this.src = src;
    FakeAudio.instances.push(this);
  }
}

describe("mention sound", () => {
  beforeEach(() => {
    FakeAudio.instances = [];
    resetMentionSoundForTests();
    vi.stubGlobal("Audio", FakeAudio);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetMentionSoundForTests();
  });

  it("plays the embedded asset through one Audio and resets its position", () => {
    expect(playMentionSound(10_000)).toBe(true);
    expect(FakeAudio.instances).toHaveLength(1);
    expect(FakeAudio.instances[0]?.src).toMatch(/mention\.wav$/);
    expect(FakeAudio.instances[0]?.play).toHaveBeenCalledTimes(1);

    FakeAudio.instances[0]!.currentTime = 0.3;
    expect(playMentionSound(12_000)).toBe(true);
    expect(FakeAudio.instances).toHaveLength(1);
    expect(FakeAudio.instances[0]?.currentTime).toBe(0);
    expect(FakeAudio.instances[0]?.play).toHaveBeenCalledTimes(2);
  });

  it("rate-limits a burst to about one chime per second", () => {
    expect(playMentionSound(10_000)).toBe(true);
    expect(playMentionSound(10_500)).toBe(false);
    expect(playMentionSound(10_999)).toBe(false);
    expect(playMentionSound(11_000)).toBe(true);
    expect(FakeAudio.instances[0]?.play).toHaveBeenCalledTimes(2);
  });

  it("applies the saved volume percentage to the element and clamps it", () => {
    expect(playMentionSound(10_000, 40)).toBe(true);
    expect(FakeAudio.instances[0]?.volume).toBeCloseTo(0.4, 5);

    expect(playMentionSound(12_000, 250)).toBe(true);
    expect(FakeAudio.instances[0]?.volume).toBe(1);

    expect(playMentionSound(14_000, -10)).toBe(true);
    expect(FakeAudio.instances[0]?.volume).toBe(0);
  });

  it("swallows a refused autoplay", () => {
    class RejectingAudio extends FakeAudio {
      constructor(src: string) {
        super(src);
        this.play.mockRejectedValue(new DOMException("blocked", "NotAllowedError"));
      }
    }
    vi.stubGlobal("Audio", RejectingAudio);

    expect(() => playMentionSound(20_000)).not.toThrow();
    expect(
      () => playMentionSound(21_000),
    ).not.toThrow();
  });

  it("does nothing when the environment has no Audio", () => {
    vi.stubGlobal("Audio", undefined);
    expect(playMentionSound(30_000)).toBe(false);
  });
});
