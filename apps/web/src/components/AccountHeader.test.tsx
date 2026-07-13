import "../test-setup";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { AccountHeader, type AccountHeaderData } from "./AccountHeader";

afterEach(() => cleanup());

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
  series: {
    balance: [900, 1000],
    equity: [1000, 1100],
    totalProfit: [100, 250],
    today: [5, 11],
    thisWeek: [100, 222],
    thisMonth: [1000, 3333],
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
    expect(view.container.querySelectorAll(".kpi-window-spacer")).toHaveLength(3);
    expect(
      Array.from(view.container.querySelectorAll(".kpi-window-spacer")).every(
        (spacer) => spacer.getAttribute("aria-hidden") === "true",
      ),
    ).toBe(true);
    expect(view.getByLabelText("Balance trend").classList.contains("dither-sparkline")).toBe(true);
    expect(view.getByLabelText("Equity trend").classList.contains("dither-sparkline")).toBe(true);
    expect(view.getByLabelText("Trading P/L trend").classList.contains("dither-sparkline")).toBe(
      true,
    );
    expect(view.getByLabelText("Today P/L trend").classList.contains("dither-sparkline")).toBe(
      true,
    );
    expect(view.container.querySelector(".account-kpis .sparkline")).toBeNull();
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
});
