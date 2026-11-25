import { render, screen } from "@testing-library/react";
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
});
