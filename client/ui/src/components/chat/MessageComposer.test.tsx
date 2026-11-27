import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";

import { TooltipProvider } from "@/components/ui/tooltip";

import { MessageComposer } from "./MessageComposer";
import type { ChatUploads } from "./useChatUploads";

function renderComposer(ui: ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

function uploads(overrides: Partial<ChatUploads> = {}): ChatUploads {
  return {
    pending: [],
    uploading: false,
    readyIds: [],
    addFiles: vi.fn(),
    remove: vi.fn(),
    clear: vi.fn(),
    ...overrides,
  };
}

const target = { kind: "channel" as const, channelId: 10 };

describe("MessageComposer", () => {
  it("sends on Enter and keeps Shift+Enter as a line break", async () => {
    const user = userEvent.setup();
    const state = uploads();
    renderComposer(
      <MessageComposer
        target={target}
        placeholder="Message"
        canSend
        canAttach
        uploads={state}
      />,
    );

    const input = screen.getByTestId("chat-input");
    await user.click(input);
    await user.keyboard("hello");
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    expect((input as HTMLTextAreaElement).value).toBe("hello\n");

    await user.keyboard("world{Enter}");
    // The fixture adapter accepts the send; the draft and attachments clear.
    expect((input as HTMLTextAreaElement).value).toBe("");
    expect(state.clear).toHaveBeenCalled();
  });

  it("does not submit an empty draft", async () => {
    const user = userEvent.setup();
    const state = uploads();
    renderComposer(
      <MessageComposer
        target={target}
        placeholder="Message"
        canSend
        canAttach
        uploads={state}
      />,
    );
    await user.click(screen.getByTestId("chat-input"));
    await user.keyboard("{Enter}");
    expect(state.clear).not.toHaveBeenCalled();
  });

  it("disables writing when the channel does not allow it", () => {
    renderComposer(
      <MessageComposer
        target={target}
        placeholder="Message"
        canSend={false}
        canAttach={false}
        uploads={uploads()}
      />,
    );
    expect(screen.getByTestId("chat-input")).toBeDisabled();
    expect(screen.getByTestId("chat-send")).toBeDisabled();
    expect(screen.getByTestId("chat-attach")).toBeDisabled();
  });

  it("shows upload progress and a readable size error", () => {
    const state = uploads({
      pending: [
        {
          localId: 1,
          id: null,
          name: "photo.png",
          size: 1200,
          image: true,
          progress: 0.5,
          previewUrl: null,
          error: null,
        },
        {
          localId: 2,
          id: null,
          name: "huge.bin",
          size: 20_000_000,
          image: false,
          progress: 0,
          previewUrl: null,
          error: "tooLarge",
        },
      ],
    });
    renderComposer(
      <MessageComposer
        target={target}
        placeholder="Message"
        canSend
        canAttach
        uploads={state}
      />,
    );
    expect(screen.getByTestId("upload-queue")).toBeInTheDocument();
    expect(screen.getByText("50%")).toBeInTheDocument();
    expect(
      screen.getByText("Файл больше разрешённого размера"),
    ).toBeInTheDocument();
  });

  it("inserts an emoji at the caret, keeps the draft and closes", async () => {
    const user = userEvent.setup();
    renderComposer(
      <MessageComposer
        target={target}
        placeholder="Message"
        canSend
        canAttach
        uploads={uploads()}
      />,
    );

    const input = screen.getByTestId("chat-input") as HTMLTextAreaElement;
    await user.click(input);
    await user.keyboard("hello");
    input.setSelectionRange(2, 2);

    await user.click(screen.getByTestId("chat-emoji"));
    expect(await screen.findByTestId("emoji-picker")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "😀" }));

    await waitFor(() =>
      expect(screen.queryByTestId("emoji-picker")).not.toBeInTheDocument(),
    );
    expect(input).toHaveValue("he😀llo");
    await waitFor(() => expect(input).toHaveFocus());
    expect(input.selectionStart).toBe(4);
  });

  it("searches emoji by Russian and English keywords", async () => {
    const user = userEvent.setup();
    renderComposer(
      <MessageComposer
        target={target}
        placeholder="Message"
        canSend
        canAttach
        uploads={uploads()}
      />,
    );

    await user.click(screen.getByTestId("chat-emoji"));
    const search = await screen.findByTestId("emoji-search");
    await user.type(search, "кот");
    expect(screen.getByTestId("emoji-🐱")).toBeInTheDocument();
    expect(screen.queryByTestId("emoji-🔥")).not.toBeInTheDocument();

    await user.clear(search);
    await user.type(search, "fire");
    expect(screen.getByTestId("emoji-🔥")).toBeInTheDocument();
  });

  it("closes the emoji picker on Escape and on an outside click", async () => {
    const user = userEvent.setup();
    renderComposer(
      <MessageComposer
        target={target}
        placeholder="Message"
        canSend
        canAttach
        uploads={uploads()}
      />,
    );

    await user.click(screen.getByTestId("chat-emoji"));
    expect(await screen.findByTestId("emoji-picker")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByTestId("emoji-picker")).not.toBeInTheDocument(),
    );
    expect(screen.getByTestId("chat-input")).toHaveValue("");

    await user.click(screen.getByTestId("chat-emoji"));
    expect(await screen.findByTestId("emoji-picker")).toBeInTheDocument();
    await user.click(document.body);
    await waitFor(() =>
      expect(screen.queryByTestId("emoji-picker")).not.toBeInTheDocument(),
    );
  });

  it("keeps the composer scrollbar off until the text overflows", async () => {
    renderComposer(
      <MessageComposer
        target={target}
        placeholder="Message"
        canSend
        canAttach
        uploads={uploads()}
      />,
    );

    const input = screen.getByTestId("chat-input") as HTMLTextAreaElement;
    expect(input).toHaveClass("overflow-y-hidden");
    expect(input).not.toHaveClass("overflow-y-auto");

    // jsdom has no layout, so the field reports no scrollHeight by itself.
    Object.defineProperty(input, "scrollHeight", {
      configurable: true,
      get: () => 400,
    });
    fireEvent.change(input, {
      target: { value: Array.from({ length: 12 }, () => "line").join("\n") },
    });

    await waitFor(() => expect(input).toHaveClass("overflow-y-auto"));
    expect(input).not.toHaveClass("overflow-y-hidden");
  });
});
