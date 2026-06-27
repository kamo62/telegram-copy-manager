import { useEffect, useRef, useState } from "react";
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
  const containerRef = useRef<HTMLDivElement | null>(null);
  const plotRef = useRef<{
    destroy: () => void;
    setSize: (s: { width: number; height: number }) => void;
  } | null>(null);
  const [view, setView] = useState<"growth" | "drawdown">("growth");
  const isTimeSeries = data.growth[0].some((value) => value > 1_000_000);
  const sampleLabel = isTimeSeries
    ? `${data.numberOfTrades} sample${data.numberOfTrades === 1 ? "" : "s"}`
    : `${data.numberOfTrades} trade${data.numberOfTrades === 1 ? "" : "s"}`;

  useEffect(() => {
    if (loading) return;
    let cancelled = false;
    let observer: ResizeObserver | null = null;

    async function initPlot() {
      const container = containerRef.current;
      if (!container) return;
      if (!canvas2dSupported()) return;
      // Dynamic import so uplot only touches the DOM at runtime, not at module-load.
      const [{ default: uPlot }] = await Promise.all([
        import("uplot"),
        import("uplot/dist/uPlot.min.css"),
      ]);
      if (cancelled) return;

      if (plotRef.current) {
        plotRef.current.destroy();
        plotRef.current = null;
      }

      const series = view === "growth" ? data.growth : data.drawdown;
      const isGrowth = view === "growth";
      const smoothPath = uPlot.paths.spline?.();
      const opts = {
        width: container.clientWidth || 600,
        height: 320,
        padding: [12, 12, 4, 4] as [number, number, number, number],
        cursor: { y: false, drag: { x: true, y: false }, points: { size: 6 } },
        axes: [
          {
            stroke: "#9ca3af",
            grid: { stroke: "rgba(225, 228, 237, 0.6)", width: 1 },
            ticks: { stroke: "transparent" },
            font: '11px "JetBrains Mono", ui-monospace, monospace',
          },
          {
            stroke: "#9ca3af",
            grid: { stroke: "rgba(225, 228, 237, 0.6)", width: 1 },
            ticks: { stroke: "transparent" },
            font: '11px "JetBrains Mono", ui-monospace, monospace',
            values: (_self: unknown, ticks: number[]) =>
              ticks.map((value) =>
                isGrowth ? `$${value.toLocaleString()}` : `${value.toFixed(1)}%`,
              ),
          },
        ],
        scales: { x: { time: isTimeSeries } },
        legend: { show: false },
        series: [
          { label: isTimeSeries ? "Time" : "Trades" },
          isGrowth
            ? {
                label: "Account growth",
                stroke: "#5046e5",
                width: 2,
                fill: "rgba(80, 70, 229, 0.12)",
                paths: smoothPath,
                points: { show: false },
              }
            : {
                label: "Drawdown",
                stroke: "#ef4444",
                width: 2,
                fill: "rgba(239, 68, 68, 0.12)",
                paths: smoothPath,
                points: { show: false },
              },
        ],
      };
      // biome-ignore lint/suspicious/noExplicitAny: uplot types don't expose construct signature cleanly here.
      plotRef.current = new (uPlot as any)(opts, series, container);

      observer = new ResizeObserver(([entry]) => {
        if (!plotRef.current || !entry) return;
        const next = Math.max(320, entry.contentRect.width);
        plotRef.current.setSize({ width: next, height: 320 });
      });
      observer.observe(container);
    }

    void initPlot();
    return () => {
      cancelled = true;
      observer?.disconnect();
      plotRef.current?.destroy();
      plotRef.current = null;
    };
  }, [data, isTimeSeries, view, loading]);

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
      {loading ? <SkeletonChart /> : <div className="chart-canvas-wrap" ref={containerRef} />}
      <footer className="chart-card-foot">{isTimeSeries ? "Time" : "Number of trades"}</footer>
    </section>
  );
}

function canvas2dSupported() {
  const canvas = document.createElement("canvas");
  return Boolean(canvas.getContext("2d"));
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
