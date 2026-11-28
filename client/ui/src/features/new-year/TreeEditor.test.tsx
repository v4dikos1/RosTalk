import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { TreeEditor } from "./TreeEditor";
import { makeState } from "./server.fixture";

it("places an owned copy at the center using the keyboard and preserves conflict controls", async () => {
  const onDraft = vi.fn();
  const state = makeState({ inventory: [{ itemId: "ball-red", qty: 1 }] });
  const props = { state, draft: null, busy: false, conflict: false, error: "", locale: "en" as const, onDraft, onSave: vi.fn(), onReload: vi.fn(), onReapply: vi.fn() };
  const view = render(<TreeEditor {...props} />);
  const button = screen.getByRole("button", { name: /Red bauble/ });
  await userEvent.click(button);
  button.focus();
  await userEvent.keyboard("{Enter}");
  expect(onDraft).toHaveBeenCalledWith(expect.objectContaining({ placements: [expect.objectContaining({ itemId: "ball-red", x: 500, y: 600 })] }));
  view.rerender(<TreeEditor {...props} draft={onDraft.mock.calls[0]![0]} conflict />);
  const rotation = screen.getByRole("spinbutton", { name: "Rotation" });
  fireEvent.change(rotation, { target: { value: "-46" } });
  expect(onDraft.mock.lastCall?.[0].placements[0].rotation).toBe(-45);
  fireEvent.change(rotation, { target: { value: "46" } });
  expect(onDraft.mock.lastCall?.[0].placements[0].rotation).toBe(45);
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Reapply" })).toBeEnabled();
});
