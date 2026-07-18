import "../test-setup";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { CommandPalette } from "./CommandPalette";

afterEach(() => cleanup());

describe("CommandPalette", () => {
  test("keeps empty results navigable without producing a selected index", () => {
    const view = render(<CommandPalette commands={[]} onClose={() => undefined} open />);
    const search = view.getByLabelText("Command palette search");

    fireEvent.keyDown(window, { key: "ArrowDown" });
    fireEvent.keyDown(window, { key: "ArrowUp" });
    fireEvent.keyDown(window, { key: "Enter" });

    expect(search.getAttribute("aria-activedescendant")).toBeNull();
    expect(view.getByText('No commands match ""')).toBeTruthy();
  });

  test("connects the search field to its highlighted option", () => {
    const view = render(
      <CommandPalette
        commands={[{ id: "settings", label: "Open settings", action: () => undefined }]}
        onClose={() => undefined}
        open
      />,
    );

    expect(
      view.getByLabelText("Command palette search").getAttribute("aria-activedescendant"),
    ).toBe("command-palette-option-settings");
    expect(view.getByRole("option", { name: "Open settings" }).getAttribute("aria-selected")).toBe(
      "true",
    );
  });
});
