import { render, screen } from "@testing-library/react";

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
