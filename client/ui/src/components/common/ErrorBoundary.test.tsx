import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { coreApi } from "@/core";
import { i18n } from "@/i18n";

import { ErrorBoundary } from "./ErrorBoundary";

describe("ErrorBoundary", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("ru");
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps the rest of the app alive and logs the panel error", () => {
    const log = vi.spyOn(coreApi, "logUiError").mockResolvedValue();
    const Broken = () => {
      throw new Error("boom");
    };

    render(
      <div>
        <p>rest of the app</p>
        <ErrorBoundary name="streams">
          <Broken />
        </ErrorBoundary>
      </div>,
    );

    expect(screen.getByText("rest of the app")).toBeInTheDocument();
    expect(screen.getByText("Эта панель упала")).toBeInTheDocument();
    expect(log).toHaveBeenCalledWith(
      "streams",
      expect.stringContaining("boom"),
      expect.anything(),
    );
  });

  it("remounts the panel on reload", async () => {
    let broken = true;
    const Flaky = () => {
      if (broken) {
        throw new Error("first render fails");
      }
      return <p>panel is back</p>;
    };

    render(
      <ErrorBoundary name="chat">
        <Flaky />
      </ErrorBoundary>,
    );
    expect(screen.getByText("Эта панель упала")).toBeInTheDocument();

    broken = false;
    await userEvent.click(
      screen.getByRole("button", { name: "Перезагрузить панель" }),
    );

    expect(screen.getByText("panel is back")).toBeInTheDocument();
  });
});
