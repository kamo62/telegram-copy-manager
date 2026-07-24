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

  test("makes unmapped symbols actionable and hides a successful suppression", async () => {
    let mapped: OperationalAlert | undefined;
    let suppressed: OperationalAlert | undefined;
    const alert: OperationalAlert = {
      kind: "unmapped-symbols",
      severity: "warn",
      message: "UNKNOWNPAIR is unmapped",
      accountId: "mt5-1",
      detail: {
        token: "UNKNOWNPAIR",
        canonicalSymbol: "UNKNOWNPAIR",
        providerId: "provider-1",
        providerTitle: "HF Markets",
        accountId: "mt5-1",
        accountLabel: "HF Markets",
        blockedSignalCount: 1,
        suggestedBrokerSymbol: "UNKNOWNPAIR.raw",
      },
    };
    const view = render(
      <AlertsBanner
        alerts={[alert]}
        onMapUnmapped={(value) => {
          mapped = value;
        }}
        onSuppressUnmapped={async (value) => {
          suppressed = value;
        }}
      />,
    );
    fireEvent.click(view.getByText("1 operational alert"));
    expect(view.getByText("HF Markets · HF Markets · 1 signal blocked")).toBeDefined();
    fireEvent.click(view.getByRole("button", { name: "Map to UNKNOWNPAIR.raw" }));
    expect(mapped).toBe(alert);
    fireEvent.click(view.getByRole("button", { name: "Not an instrument" }));
    await Promise.resolve();
    expect(suppressed).toBe(alert);
    expect(view.queryByText("UNKNOWNPAIR")).toBeNull();
  });

  test("suppresses shared token alerts independently per provider", async () => {
    const alerts: OperationalAlert[] = [
      {
        kind: "unmapped-symbols",
        severity: "warn",
        message: "GOLD is unmapped",
        accountId: "mt5-1",
        detail: {
          token: "GOLD",
          canonicalSymbol: "XAUUSD",
          providerId: "provider-1",
          providerTitle: "Provider One",
          accountId: "mt5-1",
          accountLabel: "Account 1",
          blockedSignalCount: 1,
        },
      },
      {
        kind: "unmapped-symbols",
        severity: "warn",
        message: "GOLD is unmapped",
        accountId: "mt5-1",
        detail: {
          token: "GOLD",
          canonicalSymbol: "XAUUSD",
          providerId: "provider-2",
          providerTitle: "Provider Two",
          accountId: "mt5-1",
          accountLabel: "Account 1",
          blockedSignalCount: 1,
        },
      },
    ];
    const view = render(
      <AlertsBanner alerts={alerts} onSuppressUnmapped={async () => undefined} />,
    );
    fireEvent.click(view.getByText("2 operational alerts"));
    const suppressButtons = view.getAllByRole("button", { name: "Not an instrument" });
    fireEvent.click(suppressButtons[0]!);
    await Promise.resolve();
    expect(view.getByRole("alert").textContent).toContain("Provider Two");
    expect(view.getAllByRole("button", { name: "Not an instrument" })).toHaveLength(1);
  });
});
