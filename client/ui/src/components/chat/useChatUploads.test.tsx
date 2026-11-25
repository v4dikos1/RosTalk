import { act, renderHook, waitFor } from "@testing-library/react";

import type { ChatProxyView } from "@/core/api";
import { ChatHttpError, uploadAttachment } from "@/lib/chat";

import { useChatUploads } from "./useChatUploads";

vi.mock("@/lib/chat", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/chat")>();
  return {
    ...actual,
    // The upload itself is not what these tests exercise; a pending promise
    // keeps the queue entry (and its preview) in place.
    uploadAttachment: vi.fn(() => new Promise<number>(() => {})),
  };
});

const uploadMock = vi.mocked(uploadAttachment);

const proxy: ChatProxyView = { baseUrl: "http://127.0.0.1:1", token: "proxy" };

function imageFile(name = "shot.png"): File {
  return new File(["png"], name, { type: "image/png" });
}

describe("useChatUploads object URLs", () => {
  let nextId: number;
  let createObjectURL: ReturnType<typeof vi.fn>;
  let revokeObjectURL: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    nextId = 1;
    uploadMock.mockClear();
    createObjectURL = vi.fn(() => `blob:preview-${nextId++}`);
    revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", {
      createObjectURL,
      revokeObjectURL,
    } as unknown as typeof URL);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("frees the preview when the conversation changes", () => {
    const { result, rerender } = renderHook(
      ({ channelId }: { channelId: number }) =>
        useChatUploads({ kind: "channel", channelId }, true, proxy),
      { initialProps: { channelId: 1 } },
    );

    act(() => {
      result.current.addFiles([imageFile()]);
    });
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(result.current.pending[0]?.previewUrl).toBe("blob:preview-1");
    expect(revokeObjectURL).not.toHaveBeenCalled();

    rerender({ channelId: 2 });

    expect(revokeObjectURL).toHaveBeenCalledWith("blob:preview-1");
    expect(result.current.pending).toHaveLength(0);
  });

  it("frees the preview on unmount", () => {
    const { result, unmount } = renderHook(() =>
      useChatUploads({ kind: "dm", peerId: 5 }, true, proxy),
    );

    act(() => {
      result.current.addFiles([imageFile("first.png"), imageFile("second.png")]);
    });
    expect(createObjectURL).toHaveBeenCalledTimes(2);
    expect(revokeObjectURL).not.toHaveBeenCalled();

    unmount();

    expect(revokeObjectURL).toHaveBeenCalledWith("blob:preview-1");
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:preview-2");
    expect(revokeObjectURL).toHaveBeenCalledTimes(2);
  });

  it("checks the server limit instead of a hard-coded 8 MiB", () => {
    // A 10 MiB video used to be rejected by the UI's own constant even though
    // the server is now configured for more (stage P3).
    const { result } = renderHook(() =>
      useChatUploads({ kind: "channel", channelId: 1 }, true, proxy, 25 << 20),
    );
    const file = new File([new Uint8Array(10 << 20)], "clip.mp4", {
      type: "video/mp4",
    });
    act(() => {
      result.current.addFiles([file]);
    });
    expect(result.current.pending[0]?.error).toBeNull();
    expect(uploadMock).toHaveBeenCalledTimes(1);

    const small = renderHook(() =>
      useChatUploads({ kind: "channel", channelId: 2 }, true, proxy, 1024),
    );
    act(() => {
      small.result.current.addFiles([
        new File([new Uint8Array(2048)], "big.png", { type: "image/png" }),
      ]);
    });
    expect(small.result.current.pending[0]?.error).toBe("tooLarge");
    expect(uploadMock).toHaveBeenCalledTimes(1);
  });

  it("cancelling an upload aborts the request", () => {
    let signal: AbortSignal | undefined;
    uploadMock.mockImplementationOnce((_proxy, _target, _file, options) => {
      signal = options?.signal;
      return new Promise<number>(() => {});
    });
    const { result } = renderHook(() =>
      useChatUploads({ kind: "channel", channelId: 1 }, true, proxy),
    );
    act(() => {
      result.current.addFiles([imageFile()]);
    });
    const localId = result.current.pending[0]?.localId;
    expect(localId).toBeDefined();
    expect(signal?.aborted).toBe(false);

    act(() => {
      result.current.remove(localId as number);
    });
    expect(signal?.aborted).toBe(true);
    expect(result.current.pending).toHaveLength(0);
  });

  it("maps upload error codes to readable messages", async () => {
    const cases: Array<[string, string]> = [
      ["file_too_large", "tooLarge"],
      ["unsupported_type", "unsupported"],
      ["quota_exceeded", "quota"],
      ["timeout", "timeout"],
      ["network", "network"],
    ];
    uploadMock.mockImplementation((_proxy, _target, file) => {
      const code =
        cases.find(([errorCode]) => file.name.includes(errorCode))?.[0] ??
        "failed";
      return Promise.reject(new ChatHttpError(0, code, code));
    });
    const { result } = renderHook(() =>
      useChatUploads({ kind: "channel", channelId: 1 }, true, proxy),
    );
    act(() => {
      result.current.addFiles(
        cases.map(
          ([code]) =>
            new File(["x"], `${code}.bin`, {
              type: "application/octet-stream",
            }),
        ),
      );
    });
    await waitFor(() => {
      expect(result.current.pending.every((item) => item.error !== null)).toBe(
        true,
      );
    });
    for (const [code, expected] of cases) {
      const item = result.current.pending.find((entry) =>
        entry.name.includes(code),
      );
      expect(item?.error).toBe(expected);
    }
  });

  it("does not create a preview for a non-image file", () => {
    const { result, unmount } = renderHook(() =>
      useChatUploads({ kind: "channel", channelId: 7 }, true, proxy),
    );

    act(() => {
      result.current.addFiles([
        new File(["txt"], "notes.txt", { type: "text/plain" }),
      ]);
    });

    expect(createObjectURL).not.toHaveBeenCalled();
    unmount();
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });
});
