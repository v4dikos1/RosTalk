import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";

import { TooltipProvider } from "@/components/ui/tooltip";
import type { UserView } from "@/core/api";
import { fixtureState } from "@/mock/fixtures";

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

/** Anya, a nickname with a space, and a Cyrillic one, all online fixtures. */
const people: UserView[] = [
  { ...fixtureState.users[1]!, id: 2, nickname: "Anya" },
  { ...fixtureState.users[2]!, id: 3, nickname: "Anna Maria" },
  { ...fixtureState.users[3]!, id: 4, nickname: "Анна Мария" },
];

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

  it("offers people after @ and picks one with the keyboard without sending", async () => {
    const user = userEvent.setup();
    const state = uploads();
    renderComposer(
      <MessageComposer
        target={target}
        placeholder="Message"
        canSend
        canAttach
        mentionCandidates={people}
        uploads={state}
      />,
    );

    const input = screen.getByTestId("chat-input") as HTMLTextAreaElement;
    await user.click(input);
    await user.keyboard("@an");

    expect(screen.getByRole("listbox")).toBeInTheDocument();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByTestId("mention-option-3")).toHaveAttribute(
      "aria-selected",
      "true",
    );

    // Enter chooses a person; the draft is not sent and the mention is
    // inserted with a space after it.
    await user.keyboard("{Enter}");
    expect(input.value).toBe("@Anna Maria ");
    // The caret stays after the inserted tag so typing continues there.
    await waitFor(() =>
      expect(input.selectionStart).toBe(input.value.length),
    );
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(state.clear).not.toHaveBeenCalled();

    await user.keyboard("{Enter}");
    expect(input.value).toBe("");
    expect(state.clear).toHaveBeenCalled();
  });

  it("inserts a mention at the caret in the middle of the draft", async () => {
    const user = userEvent.setup();
    const state = uploads();
    renderComposer(
      <MessageComposer
        target={target}
        placeholder="Message"
        canSend
        canAttach
        mentionCandidates={people}
        uploads={state}
      />,
    );

    const input = screen.getByTestId("chat-input") as HTMLTextAreaElement;
    await user.click(input);
    await user.keyboard("hi  there");
    input.setSelectionRange(3, 3);
    await user.keyboard("@any");
    await user.click(screen.getByTestId("mention-option-2"));

    expect(input.value).toBe("hi @Anya  there");
    await waitFor(() => expect(input.selectionStart).toBe(9));
  });

  it("keeps Shift+Enter as a line break while the list is open", async () => {
    const user = userEvent.setup();
    const state = uploads();
    renderComposer(
      <MessageComposer
        target={target}
        placeholder="Message"
        canSend
        canAttach
        mentionCandidates={people}
        uploads={state}
      />,
    );

    const input = screen.getByTestId("chat-input") as HTMLTextAreaElement;
    await user.click(input);
    await user.keyboard("@an");
    expect(screen.getByRole("listbox")).toBeInTheDocument();

    await user.keyboard("{Shift>}{Enter}{/Shift}");
    expect(input.value).toBe("@an\n");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("closes the list on Escape and sends the text as usual", async () => {
    const user = userEvent.setup();
    const state = uploads();
    renderComposer(
      <MessageComposer
        target={target}
        placeholder="Message"
        canSend
        canAttach
        mentionCandidates={people}
        uploads={state}
      />,
    );

    const input = screen.getByTestId("chat-input") as HTMLTextAreaElement;
    await user.click(input);
    await user.keyboard("@an");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

    await user.keyboard("{Enter}");
    expect(state.clear).toHaveBeenCalled();
  });

  it("closes the list when the caret leaves the fragment and sends the draft", async () => {
    const user = userEvent.setup();
    const state = uploads();
    renderComposer(
      <MessageComposer
        target={target}
        placeholder="Message"
        canSend
        canAttach
        mentionCandidates={people}
        uploads={state}
      />,
    );

    const input = screen.getByTestId("chat-input") as HTMLTextAreaElement;
    await user.click(input);
    await user.keyboard("test @Ан");
    expect(screen.getByRole("listbox")).toBeInTheDocument();

    // Home moves the caret to 0. The desktop WebView fires a selection change
    // for that; jsdom does not, so the test dispatches the same event.
    input.setSelectionRange(0, 0);
    fireEvent.select(input);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

    await user.keyboard("{Enter}");
    expect(state.clear).toHaveBeenCalled();
    expect(input.value).toBe("");
  });

  it("sends the plain draft on Enter after the caret moves without a select event", async () => {
    const user = userEvent.setup();
    const state = uploads();
    renderComposer(
      <MessageComposer
        target={target}
        placeholder="Message"
        canSend
        canAttach
        mentionCandidates={people}
        uploads={state}
      />,
    );

    const input = screen.getByTestId("chat-input") as HTMLTextAreaElement;
    await user.click(input);
    await user.keyboard("test @Ан");
    await user.keyboard("{Home}");

    // Even if no selection event arrived, Enter must not replace the old
    // fragment: the caret is outside it, so the draft is sent as typed.
    await user.keyboard("{Enter}");
    expect(state.clear).toHaveBeenCalled();
    expect(input.value).toBe("");
  });

  it("closes a list at the first character when Home moves before the @", async () => {
    const user = userEvent.setup();
    const state = uploads();
    renderComposer(
      <MessageComposer
        target={target}
        placeholder="Message"
        canSend
        canAttach
        mentionCandidates={people}
        uploads={state}
      />,
    );

    const input = screen.getByTestId("chat-input") as HTMLTextAreaElement;
    await user.click(input);
    await user.keyboard("@Ан");
    expect(screen.getByRole("listbox")).toBeInTheDocument();

    // The draft starts with "@", so position 0 is before the tag.
    input.setSelectionRange(0, 0);
    fireEvent.select(input);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

    await user.keyboard("{Enter}");
    expect(state.clear).toHaveBeenCalled();
    expect(input.value).toBe("");
  });

  it("sends a draft that starts with @ after Home without a select event", async () => {
    const user = userEvent.setup();
    const state = uploads();
    renderComposer(
      <MessageComposer
        target={target}
        placeholder="Message"
        canSend
        canAttach
        mentionCandidates={people}
        uploads={state}
      />,
    );

    const input = screen.getByTestId("chat-input") as HTMLTextAreaElement;
    await user.click(input);
    await user.keyboard("@Ан");
    await user.keyboard("{Home}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

    await user.keyboard("{Enter}");
    expect(state.clear).toHaveBeenCalled();
    expect(input.value).toBe("");
  });

  it("Enter with the caret inside the fragment replaces the whole fragment", async () => {
    const user = userEvent.setup();
    const state = uploads();
    renderComposer(
      <MessageComposer
        target={target}
        placeholder="Message"
        canSend
        canAttach
        mentionCandidates={people}
        uploads={state}
      />,
    );

    const input = screen.getByTestId("chat-input") as HTMLTextAreaElement;
    await user.click(input);
    await user.keyboard("test @Ан");
    // The caret sits between "А" and "н"; the tail of the typed fragment must
    // not survive the insert.
    await user.keyboard("{ArrowLeft}{Enter}");

    expect(input.value).toBe("test @Анна Мария ");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(state.clear).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(input.selectionStart).toBe(input.value.length),
    );

    await user.keyboard("{Enter}");
    expect(input.value).toBe("");
    expect(state.clear).toHaveBeenCalled();
  });

  it("closes the list when a click moves the caret out of the fragment", async () => {
    const user = userEvent.setup();
    const state = uploads();
    renderComposer(
      <MessageComposer
        target={target}
        placeholder="Message"
        canSend
        canAttach
        mentionCandidates={people}
        uploads={state}
      />,
    );

    const input = screen.getByTestId("chat-input") as HTMLTextAreaElement;
    await user.click(input);
    await user.keyboard("test @Ан");
    expect(screen.getByRole("listbox")).toBeInTheDocument();

    // A mouse click before the "@" moves the caret there; the click handler
    // re-reads the caret even when no selection event arrives.
    input.setSelectionRange(0, 0);
    fireEvent.click(input);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

    await user.keyboard("{Enter}");
    expect(state.clear).toHaveBeenCalled();
    expect(input.value).toBe("");
  });

  it("a mouse pick with the caret inside the fragment replaces the whole fragment", async () => {
    const user = userEvent.setup();
    const state = uploads();
    renderComposer(
      <MessageComposer
        target={target}
        placeholder="Message"
        canSend
        canAttach
        mentionCandidates={people}
        uploads={state}
      />,
    );

    const input = screen.getByTestId("chat-input") as HTMLTextAreaElement;
    await user.click(input);
    await user.keyboard("test @Ан");
    await user.keyboard("{ArrowLeft}");
    await user.click(screen.getByTestId("mention-option-4"));

    expect(input.value).toBe("test @Анна Мария ");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(state.clear).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(input.selectionStart).toBe(input.value.length),
    );
  });

  it("inserts a two-word nickname from Enter without keeping the typed tail", async () => {
    const user = userEvent.setup();
    const state = uploads();
    renderComposer(
      <MessageComposer
        target={target}
        placeholder="Message"
        canSend
        canAttach
        mentionCandidates={people}
        uploads={state}
      />,
    );

    const input = screen.getByTestId("chat-input") as HTMLTextAreaElement;
    await user.click(input);
    await user.keyboard("test @Анна М");
    expect(screen.getByRole("listbox")).toBeInTheDocument();

    // The nickname contains a space: Enter replaces the whole fragment with
    // one tag and one trailing space instead of sending the draft.
    await user.keyboard("{Enter}");
    expect(input.value).toBe("test @Анна Мария ");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(state.clear).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(input.selectionStart).toBe(input.value.length),
    );

    await user.keyboard("{Enter}");
    expect(input.value).toBe("");
    expect(state.clear).toHaveBeenCalled();
  });

  it("inserts a two-word nickname from a mouse pick without keeping the typed tail", async () => {
    const user = userEvent.setup();
    const state = uploads();
    renderComposer(
      <MessageComposer
        target={target}
        placeholder="Message"
        canSend
        canAttach
        mentionCandidates={people}
        uploads={state}
      />,
    );

    const input = screen.getByTestId("chat-input") as HTMLTextAreaElement;
    await user.click(input);
    await user.keyboard("test @Анна М");
    await user.click(screen.getByTestId("mention-option-4"));

    expect(input.value).toBe("test @Анна Мария ");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(state.clear).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(input.selectionStart).toBe(input.value.length),
    );
  });

  it("replaces the whole two-word nickname when the caret sits after the first word", async () => {
    const user = userEvent.setup();
    const state = uploads();
    renderComposer(
      <MessageComposer
        target={target}
        placeholder="Message"
        canSend
        canAttach
        mentionCandidates={people}
        uploads={state}
      />,
    );

    const input = screen.getByTestId("chat-input") as HTMLTextAreaElement;
    await user.click(input);
    await user.keyboard("test @Анна Мария");
    // The caret moves between the two words; the tail of the nickname must
    // not survive the insert as a duplicate.
    await user.keyboard(
      "{ArrowLeft}{ArrowLeft}{ArrowLeft}{ArrowLeft}{ArrowLeft}{ArrowLeft}",
    );
    expect(screen.getByRole("listbox")).toBeInTheDocument();

    await user.keyboard("{Enter}");
    expect(input.value).toBe("test @Анна Мария ");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(state.clear).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(input.selectionStart).toBe(input.value.length),
    );
  });

  it("keeps the text after the fragment when Enter picks a mention", async () => {
    const user = userEvent.setup();
    const state = uploads();
    renderComposer(
      <MessageComposer
        target={target}
        placeholder="Message"
        canSend
        canAttach
        mentionCandidates={people}
        uploads={state}
      />,
    );

    const input = screen.getByTestId("chat-input") as HTMLTextAreaElement;
    await user.click(input);
    await user.keyboard("test @Ан tail");
    // Put the caret inside "@Ан"; only the fragment is replaced.
    input.setSelectionRange(7, 7);
    fireEvent.select(input);
    expect(screen.getByRole("listbox")).toBeInTheDocument();

    await user.keyboard("{Enter}");
    expect(input.value).toBe("test @Анна Мария  tail");
    expect(state.clear).not.toHaveBeenCalled();
    await waitFor(() => expect(input.selectionStart).toBe(17));
  });

  it("keeps the text after a half-typed second word when Enter picks a mention", async () => {
    const user = userEvent.setup();
    const state = uploads();
    renderComposer(
      <MessageComposer
        target={target}
        placeholder="Message"
        canSend
        canAttach
        mentionCandidates={people}
        uploads={state}
      />,
    );

    const input = screen.getByTestId("chat-input") as HTMLTextAreaElement;
    await user.click(input);
    await user.keyboard("test @Анна М tail");
    input.setSelectionRange(12, 12);
    fireEvent.select(input);
    expect(screen.getByRole("listbox")).toBeInTheDocument();

    await user.keyboard("{Enter}");
    expect(input.value).toBe("test @Анна Мария  tail");
    expect(state.clear).not.toHaveBeenCalled();
    await waitFor(() => expect(input.selectionStart).toBe(17));
  });

  it("inserts a mention that reaches exactly the draft limit", async () => {
    const user = userEvent.setup();
    const state = uploads();
    const anya = [{ ...fixtureState.users[1]!, id: 9, nickname: "Anya" }];
    renderComposer(
      <MessageComposer
        target={target}
        placeholder="Message"
        canSend
        canAttach
        mentionCandidates={anya}
        uploads={state}
      />,
    );

    const input = screen.getByTestId("chat-input") as HTMLTextAreaElement;
    await user.click(input);
    await user.paste("a".repeat(3993));
    await user.keyboard(" @");
    expect(input.value).toHaveLength(3995);
    expect(screen.getByRole("listbox")).toBeInTheDocument();

    await user.keyboard("{Enter}");
    expect(input.value).toHaveLength(4000);
    expect(input.value.endsWith("@Anya ")).toBe(true);
  });

  it("keeps the draft and the limit when the mention would not fit", async () => {
    const user = userEvent.setup();
    const state = uploads();
    const anya = [{ ...fixtureState.users[1]!, id: 9, nickname: "Anya" }];
    renderComposer(
      <MessageComposer
        target={target}
        placeholder="Message"
        canSend
        canAttach
        mentionCandidates={anya}
        uploads={state}
      />,
    );

    const input = screen.getByTestId("chat-input") as HTMLTextAreaElement;
    await user.click(input);
    await user.paste("a".repeat(3994));
    await user.keyboard(" @");
    const original = input.value;
    expect(original).toHaveLength(3996);

    // The insert would need 4001 characters: nothing changes, no tag is made.
    await user.keyboard("{Enter}");
    expect(input.value).toBe(original);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(state.clear).not.toHaveBeenCalled();

    // The intact draft still sends as ordinary text afterwards.
    await user.keyboard("{Enter}");
    expect(state.clear).toHaveBeenCalled();
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
