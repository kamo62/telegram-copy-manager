import { useMemo, useState } from "react";
import { Area } from "@/components/dither-kit/area";
import { AreaChart } from "@/components/dither-kit/area-chart";
import { Grid } from "@/components/dither-kit/grid";
import { Tooltip } from "@/components/dither-kit/tooltip";
import { XAxis } from "@/components/dither-kit/x-axis";
import { YAxis } from "@/components/dither-kit/y-axis";
import { useColorAccents } from "../contexts/ColorAccentsContext";
import { useLocale } from "../contexts/LocaleContext";
import { chartDitherColor } from "../lib/chartPalette";
import { downsampleIndices } from "../lib/downsample";
import { formatMoney } from "../lib/format";
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

export function formatGrowthChartValue(
  value: number,
  isGrowth: boolean,
  currency: string | undefined,
  locale: string,
): string {
  return isGrowth ? formatMoney(value, currency ?? "", locale) : `${value.toFixed(1)}%`;
}

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
  const { locale } = useLocale();
  const hasEquityHistory = data.growth[1].length > 1;
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
        <div className="segmented-control chart-toggle" role="tablist" aria-label="Chart view">
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
      ) : !hasEquityHistory ? (
        <div className="chart-canvas-wrap">
          {data.growth[1].length === 1 ? "Not enough equity history yet" : "No equity history yet"}
        </div>
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
            yDomain={(() => {
              const values = rows.map((row) => row.value);
              const minimum = Math.min(...values);
              const maximum = Math.max(...values);
              const spread = maximum - minimum;
              if (spread > Math.max(1, Math.abs(maximum) * 0.05)) return undefined;
              const padding = Math.max(1, Math.abs(maximum) * 0.02, spread);
              return [minimum - padding, maximum + padding] as [number, number];
            })()}
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
              tickFormatter={(value) => formatGrowthChartValue(value, isGrowth, currency, locale)}
            />
            <Area dataKey="value" variant="gradient" />
            <Tooltip
              labelKey="x"
              valueFormatter={(value) => formatGrowthChartValue(value, isGrowth, currency, locale)}
            />
          </AreaChart>
        </div>
      )}
      {hasEquityHistory ? (
        <footer className="chart-card-foot">{isTimeSeries ? "Time" : "Number of trades"}</footer>
      ) : null}
    </section>
  );
}
