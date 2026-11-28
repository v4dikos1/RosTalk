import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";

import { Markup } from "./markup";

/**
 * Security test for stage 4.1: message text is data, never markup. HTML and
 * scripts must render as literal text, and only http(s) links become anchors.
 */
describe("Markup", () => {
  it("renders HTML and scripts as text, never as elements", () => {
    const { container } = render(
      <Markup text={'<img src=x onerror="alert(1)"><script>alert(2)</script>'} />,
    );

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("<img src=x");
    expect(container.textContent).toContain("<script>alert(2)</script>");
  });

  it("never turns a javascript: URL into a link", () => {
    const { container } = render(
      <Markup text="javascript:alert(1) and data:text/html,x" />,
    );

    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain("javascript:alert(1)");
  });

  it("links only http and https with safe rel attributes", () => {
    render(<Markup text="see https://example.com/a?b=1, and http://x.test" />);

    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(2);
    for (const link of links) {
      expect(link.getAttribute("href")).toMatch(/^https?:\/\//);
      expect(link.getAttribute("rel")).toBe("noreferrer noopener");
      expect(link.getAttribute("target")).toBe("_blank");
    }
    expect(links[0]?.getAttribute("href")).toBe("https://example.com/a?b=1");
  });

  it("supports bold, italic, inline code and fenced code", () => {
    const { container } = render(
      <Markup text={"**bold** *italic* `code`\n```\nmake check\n```"} />,
    );

    expect(container.querySelector("strong")?.textContent).toBe("bold");
    expect(container.querySelector("em")?.textContent).toBe("italic");
    expect(container.querySelector("code")?.textContent).toBe("code");
    expect(container.querySelector("pre code")?.textContent).toBe(
      "make check",
    );
  });
});

describe("Markup mentions", () => {
  const anya = new Map([["anya", 2]]);

  it("renders a confirmed mention as a link-style button and reports the click", () => {
    const onClick = vi.fn();
    render(
      <Markup text="привет @Anya!" mentions={anya} onMentionClick={onClick} />,
    );

    const mention = screen.getByRole("button", { name: "@Anya" });
    expect(mention).toHaveAttribute("type", "button");
    expect(mention.className).toContain("text-accent");
    expect(mention.className).toContain("underline");

    fireEvent.click(mention, { clientX: 12, clientY: 34 });
    expect(onClick).toHaveBeenCalledWith(2, 12, 34);
  });

  it("activates the mention from the keyboard", async () => {
    const onClick = vi.fn();
    render(
      <Markup text="привет @Anya" mentions={anya} onMentionClick={onClick} />,
    );
    const mention = screen.getByRole("button", { name: "@Anya" });
    mention.focus();
    await userEvent.keyboard("{Enter}");

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onClick.mock.calls[0]?.[0]).toBe(2);
  });

  it("matches case-insensitively and prefers the longest nickname", () => {
    const onClick = vi.fn();
    const mentions = new Map([
      ["anna", 1],
      ["anna maria", 2],
    ]);
    render(
      <Markup
        text="@ANNA MARIA and @anna"
        mentions={mentions}
        onMentionClick={onClick}
      />,
    );

    const buttons = screen.getAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual([
      "@ANNA MARIA",
      "@anna",
    ]);
    fireEvent.click(buttons[0]!);
    expect(onClick).toHaveBeenLastCalledWith(2, 0, 0);
    fireEvent.click(buttons[1]!);
    expect(onClick).toHaveBeenLastCalledWith(1, 0, 0);
  });

  it("keeps unknown, unbounded and email mentions plain", () => {
    render(
      <Markup
        text="mail@anya @Ann @anyaX @Nobody (@anya)"
        mentions={anya}
        onMentionClick={vi.fn()}
      />,
    );

    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.textContent).toBe("@anya");
    expect(screen.getByText(/mail@anya/)).toBeInTheDocument();
  });

  it("leaves URLs, bold and code intact next to a real mention", () => {
    const onClick = vi.fn();
    render(
      <Markup
        text={"**@Anya** `@Anya` https://x.test/@Anya and @Anya"}
        mentions={anya}
        onMentionClick={onClick}
      />,
    );

    expect(screen.getByRole("link").getAttribute("href")).toBe(
      "https://x.test/@Anya",
    );
    expect(document.querySelector("strong")?.textContent).toBe("@Anya");
    expect(document.querySelector("code")?.textContent).toBe("@Anya");
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.textContent).toBe("@Anya");
  });

  it("does not create buttons without a click handler", () => {
    render(<Markup text="привет @Anya" mentions={anya} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByText(/привет @Anya/)).toBeInTheDocument();
  });
});
