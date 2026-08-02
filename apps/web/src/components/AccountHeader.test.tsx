import "../test-setup";
import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { AccountHeader, type AccountHeaderData } from "./AccountHeader";

afterEach(() => cleanup());

// The rename form commits through a promise, so the state update lands a
// microtask after the click rather than inside it. Driving that boundary with
// act() flushes React's work queue to empty and lets every assertion below be
// synchronous.
//
// Do not reach for waitFor here. Its first poll runs before the microtask and
// therefore always fails, and a failing bun matcher whose received value is a
// live happy-dom element spends about 2.7s of CPU serialising the attached
// document into the failure message. That single wasted poll, not the
// component, is what made this file take ten seconds and time out under load.
async function flush(body: () => void) {
  await act(async () => {
    body();
  });
}

const data: AccountHeaderData = {
  connectedPlatform: {
    platform: "MT5",
    broker: "XMGlobal",
    accountType: "LIVE",
    expertAdvisorVersion: "Active",
    eaActive: true,
  },
  kpis: {
    balance: 1000,
    equity: 1100,
    totalProfit: { amount: 250, deltaPercent: 5 },
    today: { amount: 11, deltaPercent: 1 },
    thisWeek: { amount: 222, deltaPercent: 2 },
    thisMonth: { amount: 3333, deltaPercent: 3 },
  },
  currency: "USD",
};

describe("AccountHeader", () => {
  test("collapses to four cards with a Today/Week/Month P/L toggle", () => {
    const view = render(<AccountHeader data={data} />);

    // The three fixed cards remain.
    expect(view.getByText("Balance")).toBeTruthy();
    expect(view.getByText("Equity")).toBeTruthy();
    expect(view.getByText("Trading P/L")).toBeTruthy();
    // Today / This Week / This Month are no longer three separate cards.
    expect(view.queryByText("This Week")).toBeNull();
    expect(view.queryByText("This Month")).toBeNull();

    // One windowed card with a three-option toggle, defaulting to Today.
    const toggle = within(view.getByRole("tablist", { name: "P/L window" }));
    expect(toggle.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Today",
      "Week",
      "Month",
    ]);
    expect(view.getByText(/11\.00/)).toBeTruthy();
    expect(view.queryByText(/222\.00/)).toBeNull();

    // Switching the window updates the displayed value.
    fireEvent.click(toggle.getByRole("tab", { name: "Week" }));
    expect(view.getByText(/222\.00/)).toBeTruthy();
  });

  test("shows honest stale state and exposes account actions", async () => {
    const onRename = async () => undefined;
    const view = render(
      <AccountHeader
        data={{
          ...data,
          accountId: "mt5-demo-1",
          accountLabel: "Primary gold",
          heartbeatStatus: "stale",
          lastHeartbeatAt: "2026-07-23T08:30:00.000Z",
        }}
        onRename={onRename}
        onManageLink={() => undefined}
        onRemoveAccount={() => undefined}
      />,
    );

    expect(view.getByText("Last known")).toBeTruthy();
    expect(view.getByText("Primary gold")).toBeTruthy();
    expect(view.getByText(/Balance as at/)).toBeTruthy();
    const accountActions = view.container.querySelector('summary[aria-label="Account actions"]');
    expect(accountActions).toBeTruthy();
    fireEvent.click(accountActions!);
    fireEvent.click(view.getByRole("button", { name: "Rename" }));
    fireEvent.change(view.getByLabelText("Account name"), { target: { value: "Gold live" } });
    await flush(() => fireEvent.click(view.getByRole("button", { name: "Save name" })));
    expect(view.queryByLabelText("Account name")).toBeNull();
  });

  test("resets rename state when switching accounts and keeps an empty nickname clearable", async () => {
    const renamed: string[] = [];
    const view = render(
      <AccountHeader
        key="account-a"
        data={{ ...data, accountId: "account-a", accountLabel: "100", accountNickname: "Alpha" }}
        onRename={(nickname) => {
          renamed.push(nickname);
        }}
      />,
    );

    fireEvent.click(view.container.querySelector('summary[aria-label="Account actions"]')!);
    fireEvent.click(view.getByRole("button", { name: "Rename" }));
    expect((view.getByLabelText("Account name") as HTMLInputElement).value).toBe("Alpha");

    await flush(() =>
      view.rerender(
        <AccountHeader
          key="account-b"
          data={{ ...data, accountId: "account-b", accountLabel: "200", accountNickname: null }}
          onRename={(nickname) => {
            renamed.push(nickname);
          }}
        />,
      ),
    );

    expect(view.queryByLabelText("Account name")).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Rename" }));
    expect((view.getByLabelText("Account name") as HTMLInputElement).value).toBe("");
    fireEvent.input(view.getByLabelText("Account name"), { target: { value: "Bravo" } });
    expect((view.getByLabelText("Account name") as HTMLInputElement).value).toBe("Bravo");
    await flush(() => fireEvent.click(view.getByRole("button", { name: "Save name" })));
    expect(renamed).toEqual(["Bravo"]);
  });
});
