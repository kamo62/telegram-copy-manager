import { useMemo, useState } from "react";
import { Area } from "@/components/dither-kit/area";
import { AreaChart } from "@/components/dither-kit/area-chart";
import { Grid } from "@/components/dither-kit/grid";
import { Tooltip } from "@/components/dither-kit/tooltip";
import { XAxis } from "@/components/dither-kit/x-axis";
import { YAxis } from "@/components/dither-kit/y-axis";
import { useColorAccents } from "../contexts/ColorAccentsContext";
import { chartDitherColor } from "../lib/chartPalette";
import { downsampleIndices } from "../lib/downsample";
import { Money } from "./Money";
import { SkeletonChart } from "./Skeleton";

export type GrowthSeries = {
  growth: [number[], number[]];
  drawdown: [number[], number[]];
  totalProfit: number;
  realizedPnl?: number;
  floatingPnl?: number;
  netDeposits?: number;
  numberOfTrades: number;
};

export function GrowthChart({
  data,
  loading = false,
  currency,
}: {
  data: GrowthSeries;
  loading?: boolean;
  currency?: string;
}) {
  const [view, setView] = useState<"growth" | "drawdown">("growth");
  const { colorAccents } = useColorAccents();
  const { isGrowth, isTimeSeries, rows } = useMemo(() => {
    const [xs, ys] = view === "growth" ? data.growth : data.drawdown;
    const indices = downsampleIndices(ys, 240);
    return {
      isGrowth: view === "growth",
      isTimeSeries: data.growth[0].some((value) => value > 1_000_000),
      rows: indices.map((index) => ({ x: xs[index] ?? index, value: ys[index] ?? 0 })),
    };
  }, [data.drawdown, data.growth, view]);
  const sampleLabel = isTimeSeries
    ? `${data.numberOfTrades} sample${data.numberOfTrades === 1 ? "" : "s"}`
    : `${data.numberOfTrades} trade${data.numberOfTrades === 1 ? "" : "s"}`;

  return (
    <section className="chart-card" aria-label="Account growth chart">
      <header className="chart-card-head">
        <div>
          <h3 className="chart-card-title">Account growth</h3>
          <span className="chart-card-meta">
            {sampleLabel} · trading P/L{" "}
            <Money value={data.totalProfit} currency={currency} signTone />
            {data.netDeposits !== undefined ? (
              <>
                {" "}
                · net cashflow <Money value={data.netDeposits} currency={currency} />
              </>
            ) : null}
            {data.floatingPnl !== undefined ? (
              <>
                {" "}
                · floating <Money value={data.floatingPnl} currency={currency} signTone />
              </>
            ) : null}
          </span>
        </div>
        <div className="chart-toggle" role="tablist" aria-label="Chart view">
          <button
            aria-selected={view === "growth"}
            className={view === "growth" ? "active" : ""}
            onClick={() => setView("growth")}
            role="tab"
            type="button"
          >
            Growth
          </button>
          <button
            aria-selected={view === "drawdown"}
            className={view === "drawdown" ? "active" : ""}
            onClick={() => setView("drawdown")}
            role="tab"
            type="button"
          >
            Drawdown
          </button>
        </div>
      </header>
      {loading ? (
        <SkeletonChart />
      ) : (
        <div className="chart-canvas-wrap" data-color-accents={colorAccents ? "on" : "off"}>
          <AreaChart
            animate={false}
            bloom="low"
            className="h-80"
            config={{
              value: {
                label: isGrowth ? "Account growth" : "Drawdown",
                color: chartDitherColor(colorAccents, isGrowth ? "growth" : "drawdown"),
              },
            }}
            data={rows}
            margins={{ bottom: 30, left: 52 }}
          >
            <Grid />
            <XAxis
              dataKey="x"
              tickFormatter={(value) =>
                isTimeSeries
                  ? new Date(Number(value) * 1_000).toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                    })
                  : String(value)
              }
            />
            <YAxis
              tickFormatter={(value) =>
                isGrowth ? `$${value.toLocaleString()}` : `${value.toFixed(1)}%`
              }
            />
            <Area dataKey="value" variant="gradient" />
            <Tooltip
              labelKey="x"
              valueFormatter={(value) =>
                isGrowth ? `$${value.toLocaleString()}` : `${value.toFixed(1)}%`
              }
            />
          </AreaChart>
        </div>
      )}
      <footer className="chart-card-foot">{isTimeSeries ? "Time" : "Number of trades"}</footer>
    </section>
  );
}

export function buildPlaceholderGrowth(executedCount: number): GrowthSeries {
  const numberOfTrades = Math.max(50, Math.min(executedCount * 12 || 297, 600));
  const xs = Array.from({ length: numberOfTrades }, (_v, i) => i);
  let balance = 9500;
  const growthValues: number[] = [];
  const drawdownValues: number[] = [];
  let peak = balance;
  for (let i = 0; i < numberOfTrades; i += 1) {
    const noise = Math.sin(i * 0.31) * 35 + Math.sin(i * 0.07) * 22;
    const drift = 12 + Math.sin(i * 0.018) * 6;
    balance += drift + noise;
    if (balance < 9000) balance = 9000;
    if (balance > peak) peak = balance;
    growthValues.push(Math.round(balance));
    drawdownValues.push(Math.round(((peak - balance) / peak) * 100 * 10) / 10);
  }
  return {
    growth: [xs, growthValues],
    drawdown: [xs, drawdownValues],
    totalProfit: Math.round(balance - 9500),
    numberOfTrades,
  };
}
