import "../test-setup";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { AlertsBanner, type OperationalAlert } from "./AlertsBanner";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

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

  test("summarises alerts until opened, then lets the operator dismiss one", () => {
    const { getByText, queryByText, getAllByRole, getByLabelText } = render(
      <AlertsBanner alerts={sample} />,
    );
    expect(getByText("2 operational alerts")).toBeDefined();
    expect(getByText("1 critical · 1 warning")).toBeDefined();
    expect((getByLabelText("Operational alerts") as HTMLDetailsElement).open).toBe(false);

    fireEvent.click(getByText("2 operational alerts"));
    expect(getByText("2 provider symbols could not be mapped")).toBeDefined();
    expect(getByText("Telegram session is not receiving updates")).toBeDefined();

    const closers = getAllByRole("button", { name: "Dismiss alert" });
    expect(closers.length).toBe(2);

    fireEvent.click(closers[0] as HTMLElement);
    expect(queryByText("2 provider symbols could not be mapped")).toBeNull();
    // The other alert stays visible.
    expect(getByText("Telegram session is not receiving updates")).toBeDefined();
  });

  test("keeps dismissed alerts hidden after remount", () => {
    const first = render(<AlertsBanner alerts={sample} />);
    fireEvent.click(first.getByText("2 operational alerts"));
    fireEvent.click(first.getAllByRole("button", { name: "Dismiss alert" })[0] as HTMLElement);
    first.unmount();

    const second = render(<AlertsBanner alerts={sample} />);
    expect(second.queryByText("2 provider symbols could not be mapped")).toBeNull();
    expect(second.getByText("1 operational alert")).toBeDefined();
    expect(second.getByText("Telegram session is not receiving updates")).toBeDefined();
  });
});
