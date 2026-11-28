import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import GameRoot from "./GameRoot";
import { FakeServer, makeState, PROXY } from "./server.fixture";

let server: FakeServer;
const onClose = vi.fn();

function mount(extra: Partial<Parameters<typeof GameRoot>[0]> = {}, strict = false) {
  const ui = <GameRoot proxy={PROXY} serverId="srv" selfId={7} target={{ kind: "self" }} onClose={onClose} {...extra} />;
  return render(strict ? <StrictMode>{ui}</StrictMode> : ui);
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  server = new FakeServer(makeState());
  vi.stubGlobal("fetch", server.fetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  onClose.mockClear();
});

describe("GameRoot calendar", () => {
  it("sends the proxy header and shows the 31 day calendar with keyboard access", async () => {
    mount();
    expect(await screen.findByTestId("ny-day-detail")).toBeInTheDocument();
    expect(server.calls[0]).toMatchObject({ method: "GET", path: "/me", token: "tok" });
    const grid = screen.getByRole("group", { name: "Calendar" });
    expect(within(grid).getAllByRole("button")).toHaveLength(31);
    const user = userEvent.setup();
    const day = screen.getByRole("button", { name: /^December 5,/ });
    day.focus();
    await user.keyboard("{Enter}");
    expect(day).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("ny-day-detail")).toHaveTextContent("not yet open");
    expect(screen.getByRole("button", { name: /^December 3,/ })).toHaveAttribute("aria-current", "date");
  });

  it("enrolls once on the first active open, also under StrictMode", async () => {
    server = new FakeServer(makeState({ enrolled: false }));
    vi.stubGlobal("fetch", server.fetch);
    mount({}, true);
    await waitFor(() => expect(server.state.enrolled).toBe(true));
    await screen.findByTestId("ny-day-detail");
    expect(server.count("PUT", "/me/enrollment")).toBe(1);
  });

  it("sends one claim POST for a double click and shows the reward", async () => {
    server.rolls = ["bell-gold"];
    const release = server.hold(/POST \/me\/claim/);
    mount();
    const claim = await screen.findByRole("button", { name: "Claim reward" });
    claim.click();
    claim.click();
    release();
    await screen.findByText("You received: Golden bell");
    expect(server.count("POST", "/me/claim")).toBe(1);
    expect(server.calls.find((call) => call.path === "/me/claim")?.body).toEqual({ day: "2026-12-03" });
    expect(screen.queryByRole("button", { name: "Claim reward" })).toBeNull();
    expect(screen.getByTestId("ny-water")).toHaveTextContent("1");
  });

  it("re-reads after an already_claimed conflict and keeps the water unchanged", async () => {
    mount();
    const claim = await screen.findByRole("button", { name: "Claim reward" });
    server.state.claims.push({ day: "2026-12-03", itemId: "ball-red" });
    await userEvent.click(claim);
    expect(await screen.findByTestId("ny-error")).toHaveTextContent("already claimed");
    await waitFor(() => expect(screen.queryByRole("button", { name: "Claim reward" })).toBeNull());
    expect(screen.getByTestId("ny-water")).toHaveTextContent("0");
  });

  it("rejected watering leaves the water, and day_changed refreshes the day", async () => {
    server.state.water = 2;
    mount();
    const user = userEvent.setup();
    await screen.findByTestId("ny-day-detail");
    server.state.day = "2026-12-04";
    await user.click(screen.getByRole("button", { name: "Water the tree" }));
    expect(await screen.findByTestId("ny-error")).toHaveTextContent("new day");
    await waitFor(() => expect(screen.getByRole("button", { name: /^December 4,/ })).toHaveAttribute("aria-current", "date"));
    expect(screen.getByTestId("ny-water")).toHaveTextContent("2");
    await user.click(screen.getByRole("button", { name: "Water the tree" }));
    await waitFor(() => expect(screen.getByTestId("ny-water")).toHaveTextContent("1"));
    expect(screen.getByTestId("ny-growth")).toHaveTextContent("1 / 31");
    expect(screen.getByRole("button", { name: "Water the tree" })).toBeDisabled();
    expect(screen.getByText("The tree is already watered today.")).toBeInTheDocument();
  });

  it("disables water without a supply and never sends it", async () => {
    mount();
    await screen.findByTestId("ny-day-detail");
    expect(screen.getByRole("button", { name: "Water the tree" })).toBeDisabled();
    expect(server.count("POST", "/me/water")).toBe(0);
  });

  it("is read only in the gallery and a preview before December", async () => {
    server.state = makeState({ phase: "gallery", day: "2027-01-02", claims: [{ day: "2026-12-01", itemId: "ball-red" }] });
    const view = mount();
    await screen.findByTestId("ny-day-detail");
    expect(screen.queryByRole("button", { name: "Claim reward" })).toBeNull();
    expect(screen.getByRole("button", { name: "Water the tree" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^December 2,.*missed/ })).toBeInTheDocument();
    expect(server.count("PUT", "/me/enrollment")).toBe(0);
    view.unmount();
    server = new FakeServer(makeState({ phase: "upcoming", day: "", enrolled: false }));
    vi.stubGlobal("fetch", server.fetch);
    mount();
    expect(await screen.findByText(/The calendar opens on December 1/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Claim reward" })).toBeNull();
    expect(server.count("PUT", "/me/enrollment")).toBe(0);
  });

  it("shows an empty calendar with a welcome illustration and no history", async () => {
    mount();
    await screen.findByTestId("ny-day-detail");
    expect(screen.getByText("Welcome to the tree")).toBeInTheDocument();
    expect(screen.getByText("No changes yet.")).toBeInTheDocument();
  });

  it("lists the history with signed amounts in the server zone", async () => {
    server.state = makeState({ zone: "Europe/Moscow", history: [{ kind: "voice", delta: 2, at: "2026-12-03T12:05:00Z" }, { kind: "spin", delta: -6, at: "2026-12-03T10:00:00Z" }] });
    mount();
    const list = await screen.findByTestId("ny-history");
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(list).toHaveTextContent("+2");
    expect(list).toHaveTextContent("-6");
    expect(list).toHaveTextContent("3:05");
  });
});

describe("GameRoot failures and lifecycle", () => {
  it("shows a retryable offline error and recovers", async () => {
    server.offline = true;
    mount();
    const fatal = await screen.findByTestId("ny-fatal");
    expect(fatal).toHaveTextContent("unreachable");
    server.offline = false;
    await userEvent.click(within(fatal).getByRole("button", { name: "Retry" }));
    await screen.findByTestId("ny-day-detail");
    expect(screen.queryByTestId("ny-fatal")).toBeNull();
  });

  it("maps an expired session and a closed event", async () => {
    server.fail(/GET \/me/, 401, "unauthenticated");
    const view = mount();
    expect(await screen.findByTestId("ny-fatal")).toHaveTextContent("session expired");
    view.unmount();
    server.state = makeState({ phase: "closed" });
    mount();
    expect(await screen.findByTestId("ny-fatal")).toHaveTextContent("The event is over.");
  });

  it("localizes errors in Russian", async () => {
    await i18n.changeLanguage("ru");
    server.fail(/GET \/me/, 500, "internal");
    mount();
    expect(await screen.findByTestId("ny-fatal")).toHaveTextContent("Ошибка сервера");
  });

  it("ignores a response that arrives after the server changed and aborts the old request", async () => {
    const release = server.hold(/GET \/me/);
    const view = mount();
    await waitFor(() => expect(server.calls).toHaveLength(1));
    const second = new FakeServer(makeState({ water: 5 }));
    vi.stubGlobal("fetch", second.fetch);
    view.rerender(<GameRoot proxy={PROXY} serverId="other" selfId={7} target={{ kind: "self" }} onClose={onClose} />);
    await screen.findByTestId("ny-day-detail");
    expect(screen.getByTestId("ny-water")).toHaveTextContent("5");
    await act(async () => { release(); });
    expect(screen.getByTestId("ny-water")).toHaveTextContent("5");
  });

  it("does not apply a response after unmount", async () => {
    const release = server.hold(/GET \/me/);
    const view = mount();
    await waitFor(() => expect(server.calls).toHaveLength(1));
    view.unmount();
    await act(async () => { release(); });
    expect(server.count("PUT", "/me/enrollment")).toBe(0);
    expect(screen.queryByTestId("new-year-game")).toBeNull();
  });

  it("closes through the dialog close button", async () => {
    mount();
    await screen.findByTestId("ny-day-detail");
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("re-reads on window focus and by the Refresh button", async () => {
    mount();
    await screen.findByTestId("ny-day-detail");
    server.state.flakes = 9;
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(screen.getByTestId("ny-flakes")).toHaveTextContent("9"));
    server.state.flakes = 11;
    act(() => { window.dispatchEvent(new Event("focus")); });
    await waitFor(() => expect(screen.getByTestId("ny-flakes")).toHaveTextContent("11"));
  });
});
