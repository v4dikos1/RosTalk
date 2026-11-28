import { render, screen } from "@testing-library/react";
import { beforeAll, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { Roulette } from "./Roulette";

beforeAll(async () => { await i18n.changeLanguage("en"); });
it("shows only the server result and permits retry without another balance", () => {
  const props = { balance: 5, busy: false, retry: false, receipt: null, error: "", onOpen: vi.fn() };
  const view = render(<Roulette {...props} />);
  expect(screen.getByRole("button", { name: "Open for 6 flakes" })).toBeDisabled();
  expect(screen.queryByText(/You received/)).toBeNull();
  view.rerender(<Roulette {...props} retry error="Offline" />);
  expect(screen.getByRole("button", { name: "Retry opening" })).toBeEnabled();
  view.rerender(<Roulette {...props} receipt={{ requestId: "id", itemId: "bell-gold", duplicate: true, refund: 2, cost: 6 }} />);
  expect(screen.getByText(/You received: Golden bell/)).toHaveTextContent("Duplicate: +2 flakes returned");
});
