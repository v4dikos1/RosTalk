import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { StreamEngineSnapshot } from "@/features/streams/engine";
import { i18n } from "@/i18n";
import { fixtureState } from "@/mock/fixtures";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useCoreStore } from "@/store/coreStore";
import { streamEngine, useStreamStore } from "@/store/streamStore";

import { StreamsPanel } from "./StreamsPanel";

const { watchStreamInChannel } = vi.hoisted(() => ({
  watchStreamInChannel: vi.fn(async () => {}),
}));
vi.mock("@/lib/streams", () => ({ watchStreamInChannel }));

const channel = fixtureState.channels.find((entry) => entry.id === 4);
if (!channel) {
  throw new Error("fixture channel 4 is missing");
}

function baseSnapshot(): Partial<StreamEngineSnapshot> {
  return {
    room: "connected",
    watching: [6],
    streams: [
      {
        userId: 6,
        identity: "6:stream",
        hasVideo: true,
        hasAudio: true,
        subscribed: true,
        videoReady: true,
        audioReady: true,
        quality: "high",
        stats: null,
      },
    ],
    error: null,
  };
}

function renderPanel() {
  return render(
    <TooltipProvider delayDuration={0}>
      <StreamsPanel channel={channel!} />
    </TooltipProvider>,
  );
}

describe("StreamsPanel states", () => {
  beforeEach(async () => {
    cleanup();
    watchStreamInChannel.mockClear();
    await i18n.changeLanguage("ru");
    useCoreStore.setState({
      state: structuredClone(fixtureState),
      hydrated: true,
      pending: [],
      actionError: null,
    });
    useStreamStore.setState(baseSnapshot());
  });

  it("shows a retry action when the stream connection failed", async () => {
    useStreamStore.setState({
      room: "failed",
      streams: [],
      error: { code: "disconnected", message: "closed" },
    });
    renderPanel();

    expect(screen.getByTestId("stream-state-6")).toHaveTextContent(
      "Не удалось подключиться",
    );

    await userEvent.click(screen.getByTestId("retry-6"));
    expect(watchStreamInChannel).toHaveBeenCalledWith(4, 6);
  });

  it("shows connecting, waiting for the picture and reconnecting", () => {
    useStreamStore.setState({ streams: [] });
    renderPanel();
    expect(screen.getByTestId("stream-state-6")).toHaveTextContent(
      "Подключаемся…",
    );
    cleanup();

    useStreamStore.setState({
      streams: [
        {
          userId: 6,
          identity: "6:stream",
          hasVideo: true,
          hasAudio: true,
          subscribed: true,
          videoReady: false,
          audioReady: false,
          quality: "high",
          stats: null,
        },
      ],
    });
    renderPanel();
    expect(screen.getByTestId("stream-state-6")).toHaveTextContent(
      "Ждём картинку от Kirill",
    );
    cleanup();

    useStreamStore.setState({ room: "reconnecting", streams: [] });
    renderPanel();
    expect(screen.getByTestId("stream-state-6")).toHaveTextContent(
      "Переподключаемся…",
    );
  });

  it("keeps a watched tile when the stream ends", async () => {
    const unwatch = vi.fn();
    const state = structuredClone(fixtureState);
    state.users = state.users.map((user) =>
      user.id === 6 ? { ...user, streaming: false } : user,
    );
    useCoreStore.setState({
      state,
      hydrated: true,
      pending: [],
      actionError: null,
    });
    useStreamStore.setState({ streams: [], watching: [6], unwatch });
    renderPanel();

    expect(screen.getByTestId("stream-state-6")).toHaveTextContent(
      "Стрим закончился",
    );
    await userEvent.click(screen.getByTestId("close-6"));
    expect(unwatch).toHaveBeenCalledWith(6);
  });

  it("never shows the capture-source text for a remote stream", () => {
    useStreamStore.setState({ streams: [], watching: [6] });
    renderPanel();
    expect(screen.queryByText(/Источник экрана недоступен/)).toBeNull();
  });

  it("shows the audience of a stream and lists it on hover", async () => {
    renderPanel();

    const badge = screen.getByTestId("stream-viewers-6");
    expect(badge).toHaveAttribute("data-count", "2");
    expect(badge).toHaveTextContent("Смотрят: 2");

    await userEvent.hover(badge);
    expect(
      await screen.findByText("Кто смотрит: Dima, Lena"),
    ).toBeInTheDocument();
  });

  it("keeps the audience badge off the tile when nobody watches", () => {
    const state = structuredClone(fixtureState);
    state.users = state.users.map((user) => ({
      ...user,
      watchingUserIds: [],
    }));
    useCoreStore.setState({
      state,
      hydrated: true,
      pending: [],
      actionError: null,
    });
    renderPanel();
    expect(screen.queryByTestId("stream-viewers-6")).toBeNull();
  });

  it("publishes the audience again when a watched stream restarts", () => {
    const refresh = vi.spyOn(streamEngine, "refreshWatching");
    const state = structuredClone(fixtureState);
    state.users = state.users.map((user) =>
      user.id === 6 ? { ...user, streaming: false } : user,
    );
    useCoreStore.setState({
      state,
      hydrated: true,
      pending: [],
      actionError: null,
    });
    renderPanel();
    refresh.mockClear();

    // The streamer goes live again: the server cleared the list when the
    // previous share ended, so the open tile has to report itself again.
    act(() => {
      useCoreStore.setState({ state: structuredClone(fixtureState) });
    });
    expect(refresh).toHaveBeenCalled();
    refresh.mockRestore();
  });

  it("requests the top layer by default and lets the viewer pick another", async () => {
    const setQuality = vi.spyOn(streamEngine, "setQuality");
    renderPanel();

    const select = screen.getByRole("combobox", {
      name: "Качество картинки",
    });
    expect(select).toHaveValue("high");
    expect(setQuality).toHaveBeenCalledWith(6, "high");

    await userEvent.selectOptions(select, "low");
    expect(setQuality).toHaveBeenLastCalledWith(6, "low");

    await userEvent.selectOptions(select, "auto");
    expect(setQuality).toHaveBeenCalledWith(6, "auto");
    setQuality.mockRestore();
  });
});

describe("StreamsPanel fullscreen", () => {
  const fullscreenElement = { current: null as Element | null };

  beforeAll(() => {
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      get: () => fullscreenElement.current,
    });
    Object.defineProperty(HTMLElement.prototype, "requestFullscreen", {
      configurable: true,
      value: async function (this: HTMLElement) {
        fullscreenElement.current = this;
        document.dispatchEvent(new Event("fullscreenchange"));
      },
    });
    Object.defineProperty(document, "exitFullscreen", {
      configurable: true,
      value: async () => {
        fullscreenElement.current = null;
        document.dispatchEvent(new Event("fullscreenchange"));
      },
    });
  });

  afterAll(() => {
    fullscreenElement.current = null;
    delete (HTMLElement.prototype as Partial<HTMLElement>).requestFullscreen;
    delete (document as Partial<Document>).exitFullscreen;
  });

  beforeEach(async () => {
    cleanup();
    await i18n.changeLanguage("ru");
    useCoreStore.setState({
      state: structuredClone(fixtureState),
      hydrated: true,
      pending: [],
      actionError: null,
    });
    useStreamStore.setState(baseSnapshot());
  });

  it("toggles the button and the icon between enter and exit", async () => {
    renderPanel();
    const enter = screen.getByRole("button", { name: "Во весь экран" });
    fireEvent.click(enter);

    await waitFor(() => {
      expect(
        screen.getByRole("button", {
          name: "Выйти из полноэкранного режима",
        }),
      ).toBeInTheDocument();
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Выйти из полноэкранного режима" }),
    );
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Во весь экран" }),
      ).toBeInTheDocument();
    });
  });
});
