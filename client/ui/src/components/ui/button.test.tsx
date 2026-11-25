import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Button } from "./button";

describe("Button", () => {
  it("renders a disabled primary as a neutral control, not a faded accent", () => {
    render(<Button disabled>Join</Button>);

    const button = screen.getByRole("button", { name: "Join" });
    expect(button).toBeDisabled();
    expect(button.className).toContain("disabled:bg-active");
    expect(button.className).toContain("disabled:border-border");
    expect(button.className).toContain("disabled:text-faint");
    expect(button.className).toContain("disabled:cursor-not-allowed");
    expect(button.className).not.toContain("disabled:opacity-45");
  });

  it("keeps a disabled ghost quiet", () => {
    render(
      <Button variant="ghost" disabled>
        Cancel
      </Button>,
    );
    expect(screen.getByRole("button", { name: "Cancel" }).className).toContain(
      "disabled:opacity-45",
    );
  });
});
