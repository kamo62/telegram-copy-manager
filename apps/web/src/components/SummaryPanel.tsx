import { downsample } from "../lib/downsample";
import { DitherSparkline } from "./DitherSparkline";
import type { GrowthSeries } from "./GrowthChart";
import { Money } from "./Money";

/**
 * Default account landing. Deliberately light: the persistent account header
 * (KPIs) and exposure panel sit above this, so the Summary body only adds one
 * glanceable equity trend. The full growth chart, P/L attribution, and
 * statistics live a click away under the Performance tab to keep the landing
 * uncluttered.
 */
export function SummaryPanel({ data, currency }: { data: GrowthSeries; currency?: string }) {
  const equity = data.growth[1] ?? [];
  const sparklineEquity = downsample(equity, 96);
  const hasTrend = equity.length >= 2 && Math.min(...equity) !== Math.max(...equity);
  const rising = hasTrend ? (equity[equity.length - 1] ?? 0) >= (equity[0] ?? 0) : true;

  return (
    <section
      aria-labelledby="tab-summary"
      className="summary-panel"
      id="tabpanel-summary"
      role="tabpanel"
    >
      <header className="summary-panel-head">
        <h3 className="summary-panel-title">Recent trend</h3>
        <span className="summary-panel-meta">
          trading P/L <Money value={data.totalProfit} currency={currency} signTone />
          {data.floatingPnl !== undefined ? (
            <>
              {" · "}
              floating <Money value={data.floatingPnl} currency={currency} signTone />
            </>
          ) : null}
        </span>
      </header>
      {hasTrend ? (
        <DitherSparkline
          ariaLabel="Account equity trend"
          data={sparklineEquity}
          tone={rising ? "growth" : "drawdown"}
        />
      ) : (
        <p className="summary-panel-empty">
          Not enough history yet — the trend fills in as trades close.
        </p>
      )}
      <p className="summary-panel-hint">
        Open the <strong>Performance</strong> tab for the full growth chart, P/L attribution, and
        statistics.
      </p>
    </section>
  );
}
