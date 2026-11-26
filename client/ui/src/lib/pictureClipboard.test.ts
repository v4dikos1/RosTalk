import { vi } from "vitest";

import type { ChatProxyView } from "@/core/api";
import {
  copyPictureToClipboard,
  CopyDecodeError,
  CopyLimitError,
  MAX_COPY_IMAGE_BYTES,
} from "./chat";

const proxy: ChatProxyView = {
  baseUrl: "http://127.0.0.1:9",
  token: "proxy-token",
};

class FakeClipboardItem {
  readonly items: Record<string, Promise<Blob> | Blob>;

  constructor(items: Record<string, Promise<Blob> | Blob>) {
    this.items = items;
  }
}

function bodyResponse(
  chunks: Uint8Array[],
  headers: Record<string, string> = {},
): Response {
  let index = 0;
  const cancel = vi.fn().mockResolvedValue(undefined);
  const reader = {
    read: async () =>
      index < chunks.length
        ? { done: false, value: chunks[index++] }
        : { done: true, value: undefined },
    cancel,
    releaseLock: vi.fn(),
  };
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    body: { getReader: () => reader },
    cancel,
  } as unknown as Response;
}

function installClipboard() {
  const write = vi.fn(async (items: FakeClipboardItem[]) => {
    await items[0]?.items["image/png"];
  });
  Object.defineProperty(navigator, "clipboard", {
    value: { write },
    configurable: true,
  });
  vi.stubGlobal("ClipboardItem", FakeClipboardItem);
  return write;
}

function installCanvas() {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => {
    callback(new Blob(["png"], { type: "image/png" }));
  });
}

describe("picture clipboard", () => {
  beforeEach(() => {
    installCanvas();
    installClipboard();
    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue({
      width: 4,
      height: 3,
      close: vi.fn(),
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("calls clipboard.write before the attachment response arrives", async () => {
    let resolveFetch: (response: Response) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn().mockReturnValue(
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
      ),
    );
    const write = installClipboard();

    const copy = copyPictureToClipboard(proxy, 11, new AbortController().signal);
    expect(write).toHaveBeenCalledTimes(1);
    const item = (write.mock.calls[0] as unknown[])[0] as FakeClipboardItem[];
    expect(item[0]?.items["image/png"]).toBeInstanceOf(Promise);

    resolveFetch(bodyResponse([new Uint8Array([1, 2, 3])]));
    await copy;
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("refuses a declared body above the limit before reading it", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: {
          get: (name: string) =>
            name.toLowerCase() === "content-length"
              ? String(MAX_COPY_IMAGE_BYTES + 1)
              : null,
        },
        body: { cancel },
      }),
    );

    await expect(
      copyPictureToClipboard(proxy, 11, new AbortController().signal),
    ).rejects.toBeInstanceOf(CopyLimitError);
    expect(cancel).toHaveBeenCalled();
  });

  it("cancels a chunked body as soon as it crosses the limit", async () => {
    const chunk = new Uint8Array(Math.floor(MAX_COPY_IMAGE_BYTES / 2) + 1);
    const response = bodyResponse([chunk, chunk, chunk]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    await expect(
      copyPictureToClipboard(proxy, 11, new AbortController().signal),
    ).rejects.toBeInstanceOf(CopyLimitError);
    const readerCancel = (response.body as unknown as {
      getReader: () => { cancel: ReturnType<typeof vi.fn> };
    }).getReader().cancel;
    expect(readerCancel).toHaveBeenCalled();
  });

  it("checks the decoded bitmap size and releases it", async () => {
    const close = vi.fn();
    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue({
      width: 6000,
      height: 6000,
      close,
    }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(bodyResponse([new Uint8Array([1])])));

    await expect(
      copyPictureToClipboard(proxy, 11, new AbortController().signal),
    ).rejects.toBeInstanceOf(CopyLimitError);
    expect(close).toHaveBeenCalled();
  });

  it("reports a broken picture instead of writing anything", async () => {
    vi.stubGlobal("createImageBitmap", vi.fn().mockRejectedValue(new Error("bad")));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(bodyResponse([new Uint8Array([1])])));

    await expect(
      copyPictureToClipboard(proxy, 11, new AbortController().signal),
    ).rejects.toBeInstanceOf(CopyDecodeError);
  });
});
