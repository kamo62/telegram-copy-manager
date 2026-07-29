import { type ReactNode, useEffect, useMemo, useState } from "react";
import { SegmentedControl } from "../components/FormControls";
import { GrowthChart, type GrowthSeries } from "../components/GrowthChart";
import { Money } from "../components/Money";
import { Stat } from "../components/Stat";
import { useLocale } from "../contexts/LocaleContext";
import { apiGet } from "../lib/api";
import { formatNumber, formatPercent } from "../lib/format";

type PerformanceView = "overview" | "statistics";
type StatsRange = "today" | "7d" | "30d" | "all";
type StatsScope = "account" | "provider";

export interface AccountStatsData {
  scope: StatsScope;
  range: StatsRange;
  currency: string;
  generatedAt: string;
  profitReturn: { totalPnl: number; roiPercent: number; bestDay: number; worstDay: number };
  winLoss: {
    wins: number;
    losses: number;
    breakEven: number;
    winRate: number;
    averageWin: number;
    averageLoss: number;
  };
  riskDrawdown: {
    maxDrawdown: number;
    maxDrawdownPct: number;
    currentDrawdown: number;
    currentDrawdownPct: number;
    averageActiveDrawdown: number;
    averageActiveDrawdownPct: number;
    recoveryFactor: number;
  };
  quality: {
    profitFactor: number;
    grossProfit: number;
    grossLoss: number;
    averageTrade: number;
    expectancy: number;
  };
  streaks: { current: string; maxWins: number; maxLosses: number };
  timing: { averageTradeMinutes: number; bestWeekday: string; worstWeekday: string };
  riskThresholds: { warnPct: number; dangerPct: number };
}

type AttributionBucket = "provider" | "manual_external" | "unknown_ea";

interface AccountAttributionData {
  accountId: string;
  range: StatsRange;
  currency: string;
  generatedAt: string;
  totals: {
    totalPnl: number;
    providerPnl: number;
    manualExternalPnl: number;
    unknownEaPnl: number;
  };
  attributionRows: Array<{
    bucket: AttributionBucket;
    label: string;
    tradeCount: number;
    pnl: number;
  }>;
  sourceBreakdown: Array<{
    source: string;
    label: string;
    tradeCount: number;
    pnl: number;
  }>;
  topTrades: Array<{
    tradeId: string;
    bucket: AttributionBucket;
    providerId?: string;
    providerTitle?: string;
    source: string;
    sourceLabel: string;
    closeReason: string;
    symbol: string;
    direction: string;
    pnl: number;
    openAt?: string;
    closeAt: string;
  }>;
}

export function PerformancePage({
  accounts = [],
  currency,
  data,
  loading = false,
  providers = [],
}: {
  accounts?: Array<{
    id: string;
    accountNumber: string;
    externalPositions?: Array<{
      ticket: string;
      symbol: string;
      type: number;
      volume: number;
      openPrice: number;
      sl?: number;
      tp?: number;
      profit?: number;
      magic?: number;
      comment?: string;
    }>;
    externalOrders?: Array<{
      ticket: string;
      symbol: string;
      type: number;
      volume: number;
      openPrice: number;
      sl?: number;
      tp?: number;
      profit?: number;
      magic?: number;
      comment?: string;
    }>;
  }>;
  currency?: string;
  data: GrowthSeries;
  loading?: boolean;
  providers?: Array<{ id: string; title: string }>;
}) {
  const [view, setView] = useState<PerformanceView>("overview");
  const [range, setRange] = useState<StatsRange>("30d");
  const [scope, setScope] = useState<StatsScope>("account");
  const [providerId, setProviderId] = useState("");
  const [stats, setStats] = useState<AccountStatsData | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [statsError, setStatsError] = useState("");
  const [attribution, setAttribution] = useState<AccountAttributionData | null>(null);
  const [attributionLoading, setAttributionLoading] = useState(false);
  const [attributionError, setAttributionError] = useState("");
  const account = accounts[0];
  const effectiveProviderId = scope === "provider" ? providerId || providers[0]?.id || "" : "";

  useEffect(() => {
    if (view !== "statistics" || !account?.id) return;
    const controller = new AbortController();
    setStatsLoading(true);
    setStatsError("");
    const params = new URLSearchParams({ range, scope });
    if (scope === "provider" && effectiveProviderId) params.set("providerId", effectiveProviderId);
    apiGet<AccountStatsData>(`/api/accounts/${account.id}/stats?${params.toString()}`, {
      signal: controller.signal,
    })
      .then((payload) => setStats(payload))
      .catch((error) => {
        if ((error as Error).name !== "AbortError") setStatsError((error as Error).message);
      })
      .finally(() => setStatsLoading(false));
    return () => controller.abort();
  }, [account?.id, effectiveProviderId, range, scope, view]);

  useEffect(() => {
    if (view !== "overview" || !account?.id) return;
    const controller = new AbortController();
    setAttributionLoading(true);
    setAttributionError("");
    apiGet<AccountAttributionData>(`/api/accounts/${account.id}/attribution?range=${range}`, {
      signal: controller.signal,
    })
      .then((payload) => setAttribution(payload))
      .catch((error) => {
        if ((error as Error).name !== "AbortError") setAttributionError((error as Error).message);
      })
      .finally(() => setAttributionLoading(false));
    return () => controller.abort();
  }, [account?.id, range, view]);

  return (
    <div aria-labelledby="tab-performance" id="tabpanel-performance" role="tabpanel">
      <SegmentedControl
        ariaLabel="Performance view"
        className="performance-mode-tabs"
        role="tablist"
      >
        <button
          aria-selected={view === "overview"}
          className={view === "overview" ? "active" : ""}
          onClick={() => setView("overview")}
          role="tab"
          type="button"
        >
          Overview
        </button>
        <button
          aria-selected={view === "statistics"}
          className={view === "statistics" ? "active" : ""}
          onClick={() => setView("statistics")}
          role="tab"
          type="button"
        >
          Statistics
        </button>
      </SegmentedControl>
      {view === "overview" ? (
        <div className="performance-overview">
          <AttributionPanel
            attribution={attribution}
            currency={currency ?? (account as { currency?: string } | undefined)?.currency}
            error={attributionError}
            loading={attributionLoading}
            range={range}
            setRange={setRange}
          >
            <GrowthChart
              data={data}
              loading={loading}
              currency={currency ?? (account as { currency?: string } | undefined)?.currency}
            />
          </AttributionPanel>
        </div>
      ) : (
        <StatisticsView
          error={statsError}
          loading={statsLoading}
          providers={providers}
          providerId={effectiveProviderId}
          range={range}
          scope={scope}
          setProviderId={setProviderId}
          setRange={setRange}
          setScope={setScope}
          stats={stats}
        />
      )}
    </div>
  );
}

function AttributionPanel({
  attribution,
  children,
  currency,
  error,
  loading,
  range,
  setRange,
}: {
  attribution: AccountAttributionData | null;
  children?: ReactNode;
  currency?: string;
  error: string;
  loading: boolean;
  range: StatsRange;
  setRange: (value: StatsRange) => void;
}) {
  const { locale } = useLocale();
  const activeCurrency = attribution?.currency ?? currency;
  const totals = attribution?.totals;
  const cards: Array<{ label: string; value: number; bucket?: AttributionBucket }> = [
    { label: "Total trading P/L", value: totals?.totalPnl ?? 0 },
    { label: "Provider-linked P/L", value: totals?.providerPnl ?? 0, bucket: "provider" },
    {
      label: "Manual / external P/L",
      value: totals?.manualExternalPnl ?? 0,
      bucket: "manual_external",
    },
    { label: "Unknown / EA P/L", value: totals?.unknownEaPnl ?? 0, bucket: "unknown_ea" },
  ];
  const rows = attribution?.attributionRows ?? [];
  const sourceRows = attribution?.sourceBreakdown ?? [];
  const topTrades = attribution?.topTrades ?? [];
  const maxAbsPnl = Math.max(1, ...rows.map((row) => Math.abs(row.pnl)));

  return (
    <section className="attribution-panel" aria-label="Performance attribution">
      <header className="attribution-panel-head">
        <div>
          <h3>P/L attribution</h3>
          <p>Manual/external means MT5 activity observed outside provider-linked copy flow.</p>
        </div>
        <select
          aria-label="Attribution date range"
          value={range}
          onChange={(event) => setRange(event.target.value as StatsRange)}
        >
          <option value="today">Today</option>
          <option value="7d">7d</option>
          <option value="30d">30d</option>
          <option value="all">All</option>
        </select>
      </header>
      {error ? <p className="attribution-error">{error}</p> : null}
      {loading && !attribution ? <p className="attribution-loading">Loading attribution…</p> : null}
      <div className="attribution-strip">
        {cards.map((card) => (
          <div
            className={`attribution-kpi ${card.bucket ? attributionBucketClass(card.bucket) : ""}`}
            key={card.label}
          >
            <span>{card.label}</span>
            <Money
              value={card.value}
              currency={activeCurrency}
              locale={locale}
              signTone
              className="attribution-kpi-value"
            />
          </div>
        ))}
      </div>
      {children}
      {attribution ? (
        <>
          <div className="attribution-breakdown-grid">
            <section className="attribution-breakdown" aria-label="P/L by attribution bucket">
              <h4>P/L by source</h4>
              <div className="attribution-bars">
                {rows.map((row) => (
                  <div className="attribution-bar-row" key={row.bucket}>
                    <div>
                      <strong>{row.label}</strong>
                      <span>
                        {row.tradeCount} trade{row.tradeCount === 1 ? "" : "s"}
                      </span>
                    </div>
                    <div className="attribution-bar-track" aria-hidden="true">
                      {row.pnl !== 0 ? (
                        <span
                          className={`attribution-bar ${row.pnl > 0 ? "gain" : "loss"}`}
                          style={{ width: `${(Math.abs(row.pnl) / maxAbsPnl) * 100}%` }}
                        />
                      ) : null}
                    </div>
                    <Money value={row.pnl} currency={activeCurrency} locale={locale} signTone />
                  </div>
                ))}
              </div>
            </section>
            <section className="attribution-breakdown" aria-label="Close-source breakdown">
              <h4>Close-source breakdown</h4>
              <div className="source-breakdown-list">
                {sourceRows.length > 0 ? (
                  sourceRows.map((row) => (
                    <div className="source-breakdown-row" key={row.source}>
                      <span>{row.label}</span>
                      <small>
                        {row.tradeCount} trade{row.tradeCount === 1 ? "" : "s"}
                      </small>
                      <Money value={row.pnl} currency={activeCurrency} locale={locale} signTone />
                    </div>
                  ))
                ) : (
                  <p className="attribution-empty">No close-source data for this range.</p>
                )}
              </div>
            </section>
          </div>
          <div className="data-table-wrap attribution-table-wrap">
            <table
              className="data-table attribution-trades-table"
              aria-label="Largest attribution trades"
            >
              <thead>
                <tr>
                  <th scope="col">Trade</th>
                  <th scope="col">Source</th>
                  <th scope="col">Close</th>
                  <th scope="col">Opened</th>
                  <th scope="col">Closed</th>
                  <th className="num" scope="col">
                    Realized P/L
                  </th>
                </tr>
              </thead>
              <tbody>
                {topTrades.length > 0 ? (
                  topTrades.map((trade) => (
                    <tr key={trade.tradeId}>
                      <th className="data-table-row-head" scope="row">
                        <strong>{trade.symbol || "unmapped"}</strong>
                        <span className="data-table-subtle">
                          {trade.direction || "—"} · {trade.tradeId}
                        </span>
                      </th>
                      <td>
                        <span
                          className={`attribution-source-chip ${attributionBucketClass(trade.bucket)}`}
                        >
                          {trade.sourceLabel}
                        </span>
                      </td>
                      <td>{trade.closeReason}</td>
                      <td className="data-table-subtle">
                        {formatAttributionTime(trade.openAt, locale)}
                      </td>
                      <td className="data-table-subtle">
                        {formatAttributionTime(trade.closeAt, locale)}
                      </td>
                      <td className="num-cell">
                        <Money
                          value={trade.pnl}
                          currency={activeCurrency}
                          locale={locale}
                          signTone
                        />
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr className="data-table-empty">
                    <td colSpan={6}>No closed trades for this range.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </section>
  );
}

function StatisticsView({
  error,
  loading,
  providerId,
  providers,
  range,
  scope,
  setProviderId,
  setRange,
  setScope,
  stats,
}: {
  error: string;
  loading: boolean;
  providerId: string;
  providers: Array<{ id: string; title: string }>;
  range: StatsRange;
  scope: StatsScope;
  setProviderId: (value: string) => void;
  setRange: (value: StatsRange) => void;
  setScope: (value: StatsScope) => void;
  stats: AccountStatsData | null;
}) {
  const { locale } = useLocale();
  const cards = useMemo<Array<{ title: string; metrics: Array<[string, ReactNode]> }>>(() => {
    if (!stats) return [];
    const currency = stats.currency;
    const warnPct = stats.riskThresholds?.warnPct ?? 10;
    const dangerPct = stats.riskThresholds?.dangerPct ?? 20;
    const winRateTone: "up" | "down" | null =
      stats.winLoss.winRate > 0.5 ? "up" : stats.winLoss.winRate < 0.5 ? "down" : null;
    return [
      {
        title: "Profit / Return",
        metrics: [
          [
            "Total P/L",
            <Money
              key="totalPnl"
              value={stats.profitReturn.totalPnl}
              currency={currency}
              locale={locale}
              signTone
            />,
          ],
          ["ROI", formatPercent(stats.profitReturn.roiPercent, { locale })],
          [
            "Best day",
            <Money
              key="bestDay"
              value={stats.profitReturn.bestDay}
              currency={currency}
              locale={locale}
              signTone
            />,
          ],
          [
            "Worst day",
            <Money
              key="worstDay"
              value={stats.profitReturn.worstDay}
              currency={currency}
              locale={locale}
              signTone
            />,
          ],
        ],
      },
      {
        title: "Win / Loss",
        metrics: [
          [
            "Win rate",
            <Stat
              key="winRate"
              value={stats.winLoss.winRate * 100}
              unit="percent"
              locale={locale}
              tone={winRateTone ?? "neutral"}
            />,
          ],
          ["Wins", String(stats.winLoss.wins)],
          ["Losses", String(stats.winLoss.losses)],
          [
            "Avg win",
            <Money
              key="avgWin"
              value={stats.winLoss.averageWin}
              currency={currency}
              locale={locale}
              signTone
            />,
          ],
          [
            "Avg loss",
            <Money
              key="avgLoss"
              value={stats.winLoss.averageLoss}
              currency={currency}
              locale={locale}
              signTone
            />,
          ],
        ],
      },
      {
        title: "Risk / Drawdown",
        metrics: [
          [
            "Max DD",
            <Stat
              key="maxDd"
              value={stats.riskDrawdown.maxDrawdown}
              unit="money"
              currency={currency}
              locale={locale}
              pair={{ value: stats.riskDrawdown.maxDrawdownPct, unit: "percent" }}
              warnAbove={warnPct}
              dangerAbove={dangerPct}
            />,
          ],
          [
            "Current DD",
            <Stat
              key="currentDd"
              value={stats.riskDrawdown.currentDrawdown}
              unit="money"
              currency={currency}
              locale={locale}
              pair={{ value: stats.riskDrawdown.currentDrawdownPct, unit: "percent" }}
              warnAbove={warnPct}
              dangerAbove={dangerPct}
            />,
          ],
          [
            "Avg active DD",
            <Stat
              key="avgDd"
              value={stats.riskDrawdown.averageActiveDrawdown}
              unit="money"
              currency={currency}
              locale={locale}
              pair={{ value: stats.riskDrawdown.averageActiveDrawdownPct, unit: "percent" }}
              warnAbove={warnPct}
              dangerAbove={dangerPct}
            />,
          ],
          [
            "Recovery",
            <Stat
              key="recovery"
              value={stats.riskDrawdown.recoveryFactor}
              unit="ratio"
              locale={locale}
              upWhenAtLeast={1}
            />,
          ],
        ],
      },
      {
        title: "Quality",
        metrics: [
          ["Profit factor", formatNumber(stats.quality.profitFactor, { locale })],
          [
            "Gross profit",
            <Money
              key="grossProfit"
              value={stats.quality.grossProfit}
              currency={currency}
              locale={locale}
              signTone
            />,
          ],
          [
            "Gross loss",
            <Money
              key="grossLoss"
              value={stats.quality.grossLoss}
              currency={currency}
              locale={locale}
              signTone
            />,
          ],
          [
            "Expectancy",
            <Money
              key="expectancy"
              value={stats.quality.expectancy}
              currency={currency}
              locale={locale}
              signTone
            />,
          ],
        ],
      },
      {
        title: "Streaks",
        metrics: [
          ["Current", stats.streaks.current],
          ["Max wins", <Stat key="maxWins" value={stats.streaks.maxWins} unit="count" tone="up" />],
          [
            "Max losses",
            <Stat key="maxLosses" value={stats.streaks.maxLosses} unit="count" tone="down" />,
          ],
        ],
      },
      {
        title: "Timing",
        metrics: [
          ["Avg duration", `${formatNumber(stats.timing.averageTradeMinutes, { locale })} min`],
          ["Best weekday", stats.timing.bestWeekday],
          ["Worst weekday", stats.timing.worstWeekday],
        ],
      },
    ];
  }, [locale, stats]);
  return (
    <section className="statistics-panel" aria-label="Account statistics">
      <header className="statistics-toolbar">
        <div className="statistics-filter-group">
          <select
            aria-label="Statistics date range"
            value={range}
            onChange={(event) => setRange(event.target.value as StatsRange)}
          >
            <option value="today">Today</option>
            <option value="7d">7d</option>
            <option value="30d">30d</option>
            <option value="all">All</option>
          </select>
          <SegmentedControl ariaLabel="Statistics scope">
            <button
              aria-pressed={scope === "account"}
              className={scope === "account" ? "active" : ""}
              onClick={() => setScope("account")}
              type="button"
            >
              Account
            </button>
            <button
              aria-pressed={scope === "provider"}
              className={scope === "provider" ? "active" : ""}
              onClick={() => setScope("provider")}
              type="button"
            >
              Provider
            </button>
          </SegmentedControl>
          {scope === "provider" ? (
            <select
              aria-label="Statistics provider"
              value={providerId}
              onChange={(event) => setProviderId(event.target.value)}
            >
              {providers.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.title}
                </option>
              ))}
            </select>
          ) : null}
        </div>
      </header>
      {error ? <p className="statistics-error">{error}</p> : null}
      {loading && !stats ? <p className="statistics-loading">Loading statistics…</p> : null}
      {stats ? (
        <div className="statistics-card-grid">
          {cards.map((card) => (
            <article className="statistics-card" key={card.title}>
              <h3>{card.title}</h3>
              <dl>
                {card.metrics.map(([label, value]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
            </article>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function attributionBucketClass(bucket: AttributionBucket) {
  return bucket.replace("_", "-");
}

function formatAttributionTime(value: string | undefined, locale: string) {
  if (!value) return "—";
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return value;
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(time));
}
