import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { LiveBadge } from "./LiveBadge";

describe("LiveBadge", () => {
  it("spells the label out in the full variant", () => {
    render(<LiveBadge />);
    const badge = screen.getByTestId("live-badge");
    expect(badge).toHaveTextContent("В эфире");
    expect(badge).not.toHaveAttribute("role");
  });

  it("shows the count after the label", () => {
    render(<LiveBadge count={3} />);
    expect(screen.getByTestId("live-badge")).toHaveTextContent(/В эфире\s*3/);
  });

  it("keeps only the icon in the tree and member pane, named for screen readers", () => {
    render(<LiveBadge variant="icon" />);
    const badge = screen.getByTestId("live-badge-icon");
    expect(badge).not.toHaveTextContent("В эфире");
    expect(badge).toHaveAttribute("role", "img");
    expect(badge).toHaveAttribute("aria-label", "Стримит");
    expect(badge).toHaveAttribute("title", "Стримит");
  });

  it("uses the same ember outline on media and in the panels", () => {
    render(
      <>
        <LiveBadge onMedia />
        <LiveBadge />
      </>,
    );
    const [onMedia, plain] = screen.getAllByTestId("live-badge");
    expect(onMedia?.className).toContain("border-[var(--media-ember-border)]");
    expect(plain?.className).toContain("border-accent");
    expect(plain?.className).not.toContain("bg-danger");
  });
});
