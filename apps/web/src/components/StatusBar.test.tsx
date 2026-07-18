import "../test-setup";
import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { StatusBar } from "./StatusBar";

const props = {
  appVersion: "1.21.1",
  database: "connected",
  lastSyncAt: null,
  onCommandPalette: () => {},
  onRefresh: () => {},
  queuePending: 0,
  refreshing: false,
  telegramAdapter: "mock",
};

describe("StatusBar", () => {
  test("labels the command palette as the narrow-screen menu", () => {
    const view = render(<StatusBar {...props} lastPollError={false} />);
    expect(view.getByRole("button", { name: "Open command palette" }).textContent).toContain(
      "Menu",
    );
  });

  test("keeps poll failures visible and announced", async () => {
    const view = render(<StatusBar {...props} lastPollError />);
    expect(view.getByRole("img", { name: "Last poll failed" }).className).toContain("error");
    expect(view.getAllByRole("status")).toHaveLength(2);

    const css = await Bun.file(new URL("../styles/base.css", import.meta.url)).text();
    expect(css).toContain(".status-chip:not(:first-child):not(.status-chip-error)");
  });
});
