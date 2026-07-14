import "../test-setup";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import { formatGrowthChartValue, GrowthChart, type GrowthSeries } from "../components/GrowthChart";
import { PerformancePage } from "./PerformancePage";

afterEach(() => cleanup());

const growthData: GrowthSeries = {
  growth: [
    [1_779_292_800, 1_779_296_400, 1_779_300_000],
    [100, 85, 110],
  ],
  drawdown: [
    [1_779_292_800, 1_779_296_400, 1_779_300_000],
    [0, 15, 0],
  ],
  totalProfit: -82.5,
  numberOfTrades: 3,
};

describe("PerformancePage", () => {
  test("renders account attribution in the overview without adding another tab", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push(url);
      if (url.startsWith("/api/accounts/mt5-63442826/attribution")) {
        return new Response(
          JSON.stringify({
            accountId: "mt5-63442826",
            range: "30d",
            currency: "USD",
            generatedAt: "2026-05-21T10:00:00.000Z",
            totals: {
              totalPnl: -82.5,
              providerPnl: -20,
              manualExternalPnl: -55,
              unknownEaPnl: -7.5,
            },
            attributionRows: [
              { bucket: "provider", label: "Provider-linked", tradeCount: 1, pnl: -20 },
              { bucket: "manual_external", label: "Manual / external", tradeCount: 1, pnl: -55 },
              { bucket: "unknown_ea", label: "Unknown / EA", tradeCount: 1, pnl: -7.5 },
            ],
            sourceBreakdown: [
              { source: "manual-mobile", label: "Manual mobile", tradeCount: 1, pnl: -55 },
              { source: "manual-terminal", label: "Manual terminal", tradeCount: 1, pnl: -20 },
              { source: "expert", label: "Expert", tradeCount: 1, pnl: -7.5 },
            ],
            topTrades: [
              {
                tradeId: "external-mt5-63442826-manual-position",
                bucket: "manual_external",
                sourceLabel: "Manual mobile",
                closeReason: "Manual",
                symbol: "XAUUSD",
                direction: "BUY",
                pnl: -55,
                openAt: "2026-05-21T08:20:00.000Z",
                closeAt: "2026-05-21T08:25:00.000Z",
              },
              {
                tradeId: "trade-provider",
                bucket: "provider",
                sourceLabel: "Provider: KAL VIP",
                providerTitle: "KAL VIP",
                closeReason: "Manual",
                symbol: "XAUUSD",
                direction: "BUY",
                pnl: -20,
                openAt: "2026-05-21T08:00:00.000Z",
                closeAt: "2026-05-21T08:10:00.000Z",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ error: "not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const view = render(
      <PerformancePage
        accounts={[{ id: "mt5-63442826", accountNumber: "63442826" }]}
        currency="USD"
        data={growthData}
        providers={[{ id: "provider-kal", title: "KAL VIP" }]}
      />,
    );

    await waitFor(() =>
      expect(calls.some((url) => url === "/api/accounts/mt5-63442826/attribution?range=30d")).toBe(
        true,
      ),
    );
    await waitFor(() => expect(view.getByText("Manual / external P/L")).toBeTruthy());

    const modeTabs = within(view.getByRole("tablist", { name: "Performance view" }));
    expect(modeTabs.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Overview",
      "Statistics",
    ]);
    expect(
      view.getByText(
        "Manual/external means MT5 activity observed outside provider-linked copy flow.",
      ),
    ).toBeTruthy();
    expect(view.getByText("P/L attribution")).toBeTruthy();
    expect(view.getByText("Close-source breakdown")).toBeTruthy();
    expect(view.getAllByText("Manual mobile").length).toBeGreaterThanOrEqual(1);
    expect(view.getByText("Provider: KAL VIP")).toBeTruthy();
    const table = view.getByRole("table", { name: "Largest attribution trades" });
    expect(within(table).getAllByText("XAUUSD").length).toBeGreaterThanOrEqual(1);
  });

  test("describes sampled time-series points as samples instead of trades", () => {
    const view = render(<GrowthChart data={growthData} currency="USD" />);

    expect(view.getByText(/3 samples/)).toBeTruthy();
    expect(view.queryByText(/3 trades/)).toBeNull();
    expect(view.getByText("Time")).toBeTruthy();
  });

  test("uses the account currency for growth axis values", () => {
    expect(formatGrowthChartValue(100, true, "ZAR", "en-ZA")).toBe("R\u00a0100,00");
    expect(formatGrowthChartValue(12.34, false, "ZAR", "en-ZA")).toBe("12.3%");
  });

  test("shows an empty state instead of fabricated growth without equity history", () => {
    const view = render(
      <GrowthChart
        data={{ ...growthData, growth: [[], []], drawdown: [[], []], numberOfTrades: 0 }}
      />,
    );

    expect(view.getByText("No equity history yet")).toBeTruthy();
  });
});
