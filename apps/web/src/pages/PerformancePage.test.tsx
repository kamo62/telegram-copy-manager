import "../test-setup";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import {
  formatGrowthChartTime,
  formatGrowthChartValue,
  GrowthChart,
  type GrowthSeries,
} from "../components/GrowthChart";
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

function statsPayload(totalPnl: number, range: string) {
  return {
    scope: "account",
    range,
    currency: "USD",
    generatedAt: "2026-05-21T10:00:00.000Z",
    profitReturn: { totalPnl, roiPercent: 2, bestDay: totalPnl, worstDay: -1 },
    winLoss: {
      wins: 2,
      losses: 1,
      breakEven: 0,
      winRate: 0.66,
      averageWin: totalPnl,
      averageLoss: -1,
    },
    riskDrawdown: {
      maxDrawdown: 1,
      maxDrawdownPct: 1,
      currentDrawdown: 0,
      currentDrawdownPct: 0,
      averageActiveDrawdown: 1,
      averageActiveDrawdownPct: 1,
      recoveryFactor: 2,
    },
    quality: {
      profitFactor: 2,
      grossProfit: totalPnl,
      grossLoss: -1,
      averageTrade: totalPnl,
      expectancy: totalPnl,
    },
    streaks: { current: "2 wins", maxWins: 2, maxLosses: 1 },
    timing: { averageTradeMinutes: 5, bestWeekday: "Monday", worstWeekday: "Friday" },
    riskThresholds: { warnPct: 10, dangerPct: 20 },
  };
}

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
              { bucket: "provider", label: "Provider-linked", tradeCount: 1, pnl: 20 },
              { bucket: "manual_external", label: "Manual / external", tradeCount: 1, pnl: -55 },
              { bucket: "unknown_ea", label: "Unknown / EA", tradeCount: 0, pnl: 0 },
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
    expect(view.container.querySelectorAll(".attribution-bar")).toHaveLength(2);
    expect(view.container.querySelector(".attribution-bar.gain")).not.toBeNull();
    expect(view.container.querySelector(".attribution-bar.loss")).not.toBeNull();
    expect(view.getAllByText("Manual mobile").length).toBeGreaterThanOrEqual(1);
    expect(view.getByText("Provider: KAL VIP")).toBeTruthy();
    const table = view.getByRole("table", { name: "Largest attribution trades" });
    expect(within(table).getAllByText("XAUUSD").length).toBeGreaterThanOrEqual(1);
  });

  test("does not let an older statistics request replace the current range", async () => {
    const resolvers: Array<(response: Response) => void> = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/stats?")) {
        return new Promise<Response>((resolve) => resolvers.push(resolve));
      }
      return Response.json({
        accountId: "mt5-63442826",
        range: "30d",
        currency: "USD",
        generatedAt: "2026-05-21T10:00:00.000Z",
        totals: { totalPnl: 0, providerPnl: 0, manualExternalPnl: 0, unknownEaPnl: 0 },
        attributionRows: [],
        sourceBreakdown: [],
        topTrades: [],
      });
    }) as typeof fetch;

    const view = render(
      <PerformancePage
        accounts={[{ id: "mt5-63442826", accountNumber: "63442826" }]}
        currency="USD"
        data={growthData}
      />,
    );
    fireEvent.click(view.getByRole("tab", { name: "Statistics" }));
    await waitFor(() => expect(resolvers).toHaveLength(1));

    fireEvent.change(view.getByLabelText("Statistics date range"), {
      target: { value: "all" },
    });
    await waitFor(() => expect(resolvers).toHaveLength(2));
    resolvers[1]?.(Response.json(statsPayload(200, "all")));
    await waitFor(() => expect(view.getAllByText("$200.00").length).toBeGreaterThan(0));

    resolvers[0]?.(Response.json(statsPayload(100, "30d")));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(view.getAllByText("$200.00").length).toBeGreaterThan(0);
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

  test("formats chart timestamps as dates instead of raw epoch values", () => {
    const formatted = formatGrowthChartTime(1_779_292_800, "en-US", true);

    expect(formatted).not.toContain("1779292800");
    expect(formatted).toContain("2026");
  });

  test("shows an empty state instead of fabricated growth without equity history", () => {
    const view = render(
      <GrowthChart
        data={{ ...growthData, growth: [[], []], drawdown: [[], []], numberOfTrades: 0 }}
      />,
    );

    expect(view.getByText("No equity history yet")).toBeTruthy();
  });

  test("does not draw a misleading curve for a single equity snapshot", () => {
    const view = render(
      <GrowthChart
        data={{
          ...growthData,
          growth: [[1_779_292_800], [100]],
          drawdown: [[1_779_292_800], [0]],
          numberOfTrades: 0,
        }}
      />,
    );

    expect(view.getByText("Not enough equity history yet")).toBeTruthy();
  });
});
