import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import type { CoreError } from "@/core/api";
import { i18n } from "@/i18n";
import { useCoreStore } from "@/store/coreStore";

import { CoreErrorNotice } from "./CoreErrorNotice";

const permissionError: CoreError = {
  code: "serverError",
  message: "server rejected the request: permission_denied",
  retryable: true,
  actionUrl: null,
  serverCode: "permissionDenied",
};

describe("CoreErrorNotice", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("ru");
  });

  it("names the channel and keeps the technical detail reachable", async () => {
    const user = userEvent.setup();
    useCoreStore.setState({
      actionError: permissionError,
      actionContext: "Общий",
    });
    render(<CoreErrorNotice />);

    expect(screen.getByTestId("core-error")).toHaveTextContent("Общий:");
    expect(screen.getByTestId("core-error")).toHaveTextContent(
      "Не хватает прав",
    );
    // PERMISSION_DENIED does not become retryable by pressing the same button.
    expect(screen.getByTestId("core-error")).not.toHaveTextContent(
      "Можно повторить",
    );

    await user.click(screen.getByTestId("core-error-details"));
    expect(screen.getByTestId("core-error-technical")).toHaveTextContent(
      permissionError.message,
    );
  });
});
