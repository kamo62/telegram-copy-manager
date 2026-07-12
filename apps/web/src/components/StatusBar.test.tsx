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
  test("keeps poll failures visible and announced", async () => {
    const view = render(<StatusBar {...props} lastPollError />);
    expect(view.getByRole("img", { name: "Last poll failed" }).className).toContain("error");
    expect(view.getAllByRole("status")).toHaveLength(2);

    const css = await Bun.file(new URL("../styles/base.css", import.meta.url)).text();
    expect(css).toContain(".status-chip:not(:first-child):not(.status-chip-error)");
  });
});
