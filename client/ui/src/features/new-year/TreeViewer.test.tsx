import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { TreeViewer } from "./TreeViewer";

it("renders a public tree without editing controls", () => {
  render(<TreeViewer locale="en" tree={{ growthDays: 8, background: "aurora", placements: [{ itemId: "ball-red", x: 500, y: 600, scale: 100, rotation: 0 }] }} />);
  expect(screen.getByRole("img", { name: "Red bauble" })).toBeVisible();
  expect(screen.queryByRole("button")).toBeNull();
});
