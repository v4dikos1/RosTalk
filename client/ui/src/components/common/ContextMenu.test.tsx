import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { coreApi } from "@/core";
import { contextMenuActions } from "@/lib/contextMenu";
import { i18n } from "@/i18n";

import { ContextMenu } from "./ContextMenu";

function renderMenu() {
  render(
    <div>
      <input data-testid="field" defaultValue="hello world" />
      <p data-testid="text">Plain text</p>
      <ContextMenu />
    </div>,
  );
  return screen.getByTestId("field") as HTMLInputElement;
}

describe("contextMenuActions", () => {
  it("offers nothing without a field or a selection", () => {
    expect(contextMenuActions({ editable: false, hasSelection: false })).toEqual(
      [],
    );
  });

  it("offers copy for read-only selected text", () => {
    expect(contextMenuActions({ editable: false, hasSelection: true })).toEqual([
      "copy",
    ]);
  });

  it("offers paste in an empty field and the full set over a selection", () => {
    expect(contextMenuActions({ editable: true, hasSelection: false })).toEqual([
      "paste",
      "selectAll",
    ]);
    expect(contextMenuActions({ editable: true, hasSelection: true })).toEqual([
      "cut",
      "copy",
      "paste",
      "selectAll",
    ]);
  });
});

describe("ContextMenu", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("ru");
  });

  it("suppresses the browser menu and shows paste in a field", () => {
    const field = renderMenu();
    // `fireEvent` returns false when `preventDefault` was called.
    const notCanceled = fireEvent.contextMenu(field, { clientX: 20, clientY: 30 });

    expect(notCanceled).toBe(false);
    expect(screen.getByTestId("context-menu")).toBeInTheDocument();
    expect(screen.getByTestId("context-menu-paste")).toBeInTheDocument();
    expect(screen.getByTestId("context-menu-selectAll")).toBeInTheDocument();
    expect(
      screen.queryByTestId("context-menu-copy"),
    ).not.toBeInTheDocument();
  });

  it("shows nothing when there is no field and no selection", () => {
    renderMenu();
    const notCanceled = fireEvent.contextMenu(screen.getByTestId("text"));

    // The browser menu is suppressed everywhere, but the replacement stays
    // hidden when it has nothing useful to offer.
    expect(notCanceled).toBe(false);
    expect(screen.queryByTestId("context-menu")).not.toBeInTheDocument();
  });

  it("pastes the OS clipboard text over the selection", async () => {
    const clipboard = vi
      .spyOn(coreApi, "readClipboardText")
      .mockResolvedValue("there");
    const field = renderMenu();
    field.setSelectionRange(6, 11);
    fireEvent.contextMenu(field);

    fireEvent.click(screen.getByTestId("context-menu-paste"));

    await waitFor(() => expect(clipboard).toHaveBeenCalled());
    await waitFor(() => expect(field.value).toBe("hello there"));
    expect(screen.queryByTestId("context-menu")).not.toBeInTheDocument();
    clipboard.mockRestore();
  });

  it("closes the menu on Escape", () => {
    const field = renderMenu();
    fireEvent.contextMenu(field);
    expect(screen.getByTestId("context-menu")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("context-menu")).not.toBeInTheDocument();
  });
});
