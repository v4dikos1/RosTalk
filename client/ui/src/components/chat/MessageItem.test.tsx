import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";

import type { AttachmentView, MessageView } from "@/core/api";
import { i18n } from "@/i18n";
import { MAX_COPY_IMAGE_BYTES, MAX_COPY_IMAGE_PIXELS } from "@/lib/chat";
import { useSettingsStore } from "@/store/settingsStore";

import { MessageItem } from "./MessageItem";

const proxy = { baseUrl: "http://127.0.0.1:9", token: "proxy-token" };

class FakeClipboardItem {
  readonly items: Record<string, Promise<Blob> | Blob>;

  constructor(items: Record<string, Promise<Blob> | Blob>) {
    this.items = items;
  }
}

function picture(id: number, overrides: Partial<AttachmentView> = {}): AttachmentView {
  return {
    id,
    fileName: `shot-${id}.png`,
    contentType: "image/png",
    sizeBytes: 64,
    width: 4,
    height: 3,
    image: true,
    ...overrides,
  };
}

function message(attachments: AttachmentView[], senderId = 2): MessageView {
  return {
    id: 1,
    channelId: 1,
    senderId,
    recipientId: 0,
    senderNickname: "Anya",
    body: "",
    createdAtUnixMs: 1_700_000_000_000,
    editedAtUnixMs: 0,
    attachments,
    mentionUserIds: [],
  };
}

function messageItem(
  attachments: AttachmentView[],
  senderId = 2,
  proxyValue: typeof proxy = proxy,
) {
  return (
    <MessageItem
      message={message(attachments, senderId)}
      selfUserId={1}
      authorColor={null}
      authorAvatarHash=""
      serverId={null}
      proxy={proxyValue}
      canManage={false}
      onEdit={vi.fn().mockResolvedValue(undefined)}
      onDelete={vi.fn().mockResolvedValue(undefined)}
    />
  );
}

function renderMessage(
  attachments: AttachmentView[],
  senderId = 2,
  proxyValue: typeof proxy = proxy,
) {
  return render(messageItem(attachments, senderId, proxyValue));
}

function bodyResponse(bytes: Uint8Array, headers: Record<string, string> = {}): Response {
  let sent = false;
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    body: {
      getReader: () => ({
        read: async () => {
          if (sent) {
            return { done: true, value: undefined };
          }
          sent = true;
          return { done: false, value: bytes };
        },
        cancel: vi.fn().mockResolvedValue(undefined),
        releaseLock: vi.fn(),
      }),
    },
  } as unknown as Response;
}

function errorResponse(status: number, code: string): Response {
  return {
    ok: false,
    status,
    json: async () => ({ error: { code } }),
  } as unknown as Response;
}

function installSuccessClipboard() {
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

function installBitmap(width = 4, height = 3, close = vi.fn()) {
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn().mockResolvedValue({ width, height, close }),
  );
  return close;
}

describe("MessageItem picture copy", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useSettingsStore.setState({ settings: null });
    void i18n.changeLanguage("ru");
    installCanvas();
    installSuccessClipboard();
    installBitmap();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("starts clipboard.write in the click handler before the proxy answers", async () => {
    let resolveFetch: (response: Response) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn().mockReturnValue(
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
      ),
    );
    const write = installSuccessClipboard();

    renderMessage([picture(11)]);
    fireEvent.click(screen.getByTestId("attachment-image-copy"));

    expect(write).toHaveBeenCalledTimes(1);
    expect(await screen.findByTestId("attachment-image-copy")).toBeDisabled();

    resolveFetch(bodyResponse(new Uint8Array([1, 2, 3])));
    expect(await screen.findByTestId("attachment-copy-status")).toHaveTextContent(
      i18n.t("chat.copyImageCopied"),
    );
    expect(screen.getByTestId("attachment-image-copy")).not.toBeDisabled();
  });

  it("copies a different picture from the same message", async () => {
    const fetchMock = vi.fn().mockResolvedValue(bodyResponse(new Uint8Array([1])));
    vi.stubGlobal("fetch", fetchMock);
    const write = installSuccessClipboard();

    renderMessage([picture(11), picture(12)]);
    fireEvent.click(screen.getAllByTestId("attachment-image-copy")[1] as HTMLElement);

    await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "http://127.0.0.1:9/chat/attachments/12",
    );
  });

  it("copies pictures of own messages too", async () => {
    const fetchMock = vi.fn().mockResolvedValue(bodyResponse(new Uint8Array([1])));
    vi.stubGlobal("fetch", fetchMock);
    const write = installSuccessClipboard();

    renderMessage([picture(11)], 1);
    fireEvent.click(screen.getByTestId("attachment-image-copy"));

    await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
  });

  it("shows the localised deleted-attachment outcome", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(errorResponse(404, "not_found")));

    renderMessage([picture(11)]);
    fireEvent.click(screen.getByTestId("attachment-image-copy"));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        i18n.t("chat.copyImageGone"),
      ),
    );
  });

  it("shows the localised lost-access outcome", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(errorResponse(403, "forbidden")));

    renderMessage([picture(11)]);
    fireEvent.click(screen.getByTestId("attachment-image-copy"));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        i18n.t("chat.copyImageNoAccess"),
      ),
    );
  });

  it("refuses a picture above the copy limit without fetching", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const write = installSuccessClipboard();

    renderMessage([picture(11, { sizeBytes: MAX_COPY_IMAGE_BYTES + 1 })]);
    fireEvent.click(screen.getByTestId("attachment-image-copy"));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      i18n.t("chat.copyImageTooLarge"),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("marks the button busy and keeps aria-busy without an infinite spinner", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(bodyResponse(new Uint8Array([1]))));
    let finish: () => void = () => {};
    const write = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    Object.defineProperty(navigator, "clipboard", {
      value: { write },
      configurable: true,
    });

    renderMessage([picture(11)]);
    fireEvent.click(screen.getByTestId("attachment-image-copy"));

    const button = await screen.findByTestId("attachment-image-copy");
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button.querySelector(".animate-spin")).toBeNull();

    finish();
    await waitFor(() => expect(write).toHaveBeenCalled());
  });

  it("maps a broken picture and a refused clipboard to distinct messages", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(bodyResponse(new Uint8Array([1]))));
    installBitmap(4, 3, vi.fn());
    vi.stubGlobal("createImageBitmap", vi.fn().mockRejectedValueOnce(new Error("bad")));
    const write = installSuccessClipboard();

    renderMessage([picture(11)]);
    fireEvent.click(screen.getByTestId("attachment-image-copy"));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        i18n.t("chat.copyImageBroken"),
      ),
    );

    vi.stubGlobal(
      "createImageBitmap",
      vi.fn().mockResolvedValue({ width: 4, height: 3, close: vi.fn() }),
    );
    write.mockRejectedValueOnce(new DOMException("denied", "NotAllowedError"));
    fireEvent.click(screen.getByTestId("attachment-image-copy"));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        i18n.t("chat.copyImageClipboardBusy"),
      ),
    );
  });

  it("clears pending state when the proxy changes and a late write succeeds", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(bodyResponse(new Uint8Array([1]))));
    let finish: () => void = () => {};
    const write = installSuccessClipboard();
    write.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );

    const { rerender } = renderMessage([picture(11)]);
    fireEvent.click(screen.getByTestId("attachment-image-copy"));
    expect(screen.getByTestId("attachment-image-copy")).toBeDisabled();

    rerender(
      messageItem([picture(11)], 2, { ...proxy, token: "new-proxy-token" }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("attachment-image-copy")).not.toBeDisabled(),
    );

    // The old write completes after the abort. It must not resurrect the old
    // state or keep the button busy.
    finish();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(screen.getByTestId("attachment-image-copy")).not.toBeDisabled();
  });

  it("lets a newer picture win over an older delayed copy", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init: RequestInit) => {
        if (String(url).endsWith("/11")) {
          return new Promise<Response>((_, reject) => {
            init.signal?.addEventListener("abort", () => {
              reject(new DOMException("aborted", "AbortError"));
            });
          });
        }
        return Promise.resolve(bodyResponse(new Uint8Array([2])));
      }),
    );
    const write = installSuccessClipboard();

    renderMessage([picture(11), picture(12)]);
    const buttons = screen.getAllByTestId("attachment-image-copy");
    fireEvent.click(buttons[0] as HTMLElement);
    fireEvent.click(buttons[1] as HTMLElement);

    await waitFor(() =>
      expect(screen.getAllByTestId("attachment-image-copy")[1]).not.toBeDisabled(),
    );
    expect(write).toHaveBeenCalledTimes(2);
    expect(screen.getAllByTestId("attachment-image-copy")[0]).not.toBeDisabled();
  });

  it("checks known dimensions before downloading and the actual bitmap after", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const write = installSuccessClipboard();

    renderMessage([
      picture(11, {
        width: Math.ceil(MAX_COPY_IMAGE_PIXELS / 1000) + 1,
        height: 1000,
      }),
    ]);
    fireEvent.click(screen.getByTestId("attachment-image-copy"));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      i18n.t("chat.copyImageTooLarge"),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("copies from the open full-screen view and stays keyboard reachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(bodyResponse(new Uint8Array([5]))));
    const write = installSuccessClipboard();

    renderMessage([picture(11)]);
    fireEvent.click(screen.getByTestId("attachment-image"));
    const full = await screen.findByTestId("attachment-image-copy-full");
    expect(full).toHaveAccessibleName(i18n.t("chat.copyImage"));

    full.focus();
    await userEvent.keyboard("{Enter}");

    await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
  });
});
