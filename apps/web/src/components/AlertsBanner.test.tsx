import "../test-setup";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { AlertsBanner, type OperationalAlert } from "./AlertsBanner";

afterEach(() => cleanup());

const sample: OperationalAlert[] = [
  { kind: "unmapped-symbols", severity: "warn", message: "2 provider symbols could not be mapped" },
  {
    kind: "telegram-stalled",
    severity: "error",
    message: "Telegram session is not receiving updates",
  },
];

describe("AlertsBanner", () => {
  test("renders nothing when there are no alerts", () => {
    const { container } = render(<AlertsBanner alerts={[]} />);
    expect(container.querySelector(".alerts-banner")).toBeNull();
  });

  test("renders each alert with a dismiss button and hides one on click", () => {
    const { getByText, queryByText, getAllByRole } = render(<AlertsBanner alerts={sample} />);
    expect(getByText("2 provider symbols could not be mapped")).toBeDefined();
    expect(getByText("Telegram session is not receiving updates")).toBeDefined();

    const closers = getAllByRole("button", { name: "Dismiss alert" });
    expect(closers.length).toBe(2);

    fireEvent.click(closers[0] as HTMLElement);
    expect(queryByText("2 provider symbols could not be mapped")).toBeNull();
    // The other alert stays visible.
    expect(getByText("Telegram session is not receiving updates")).toBeDefined();
  });
});
