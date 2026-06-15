import { type ReactNode, useEffect, useMemo, useState } from "react";
import { GrowthChart, type GrowthSeries } from "../components/GrowthChart";
import { Money } from "../components/Money";
import { Stat } from "../components/Stat";
import { useLocale } from "../contexts/LocaleContext";
import { apiGet } from "../lib/api";
import { formatLot, formatMoney, formatNumber, formatPercent } from "../lib/format";

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
    ticket?: string;
    volume?: number;
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
    appPositions?: Array<{
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
    appOrders?: Array<{
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
    symbols?: Array<{ symbol: string; bid?: number; ask?: number }>;
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
      <div className="performance-mode-tabs" role="tablist" aria-label="Performance view">
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
      </div>
      {view === "overview" ? (
        <>
          <AttributionPanel
            account={account}
            attribution={attribution}
            currency={currency ?? (account as { currency?: string } | undefined)?.currency}
            error={attributionError}
            loading={attributionLoading}
            performance={data}
            range={range}
            setRange={setRange}
          />
          <GrowthChart
            data={data}
            loading={loading}
            currency={currency ?? (account as { currency?: string } | undefined)?.currency}
          />
          <ExternalActivityPanel accounts={accounts} />
        </>
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
  account,
  attribution,
  currency,
  error,
  loading,
  performance,
  range,
  setRange,
}: {
  account?: NonNullable<Parameters<typeof PerformancePage>[0]["accounts"]>[number];
  attribution: AccountAttributionData | null;
  currency?: string;
  error: string;
  loading: boolean;
  performance: GrowthSeries;
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
  const openPositions = [...(account?.appPositions ?? []), ...(account?.externalPositions ?? [])];
  const pendingOrders = [...(account?.appOrders ?? []), ...(account?.externalOrders ?? [])];
  const openLots = openPositions.reduce((sum, position) => sum + position.volume, 0);
  const floatingPnl =
    performance.floatingPnl ??
    openPositions.reduce((sum, position) => sum + (position.profit ?? 0), 0);
  const drawdowns = performance.drawdown[1] ?? [];
  const maxDrawdown = drawdowns.length > 0 ? Math.max(...drawdowns) : 0;
  const netCashflow = performance.netDeposits ?? 0;
  const cashflowLabel =
    netCashflow > 0 ? "Deposits" : netCashflow < 0 ? "Withdrawals" : "Deposits / withdrawals";
  const symbolsActive = new Set(openPositions.map((position) => position.symbol)).size;

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
                      <span
                        className={`attribution-bar ${attributionBucketClass(row.bucket)}`}
                        style={{
                          width: `${Math.max(4, (Math.abs(row.pnl) / maxAbsPnl) * 100)}%`,
                        }}
                      />
                    </div>
                    <Money value={row.pnl} currency={activeCurrency} locale={locale} signTone />
                  </div>
                ))}
              </div>
            </section>
            <RiskExposureCard
              cashflowLabel={cashflowLabel}
              currency={activeCurrency}
              floatingPnl={floatingPnl}
              maxDrawdown={maxDrawdown}
              netCashflow={netCashflow}
              openLots={openLots}
              openTrades={openPositions.length}
              pendingOrders={pendingOrders.length}
              symbolsActive={symbolsActive}
            />
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
          <section className="recent-closed-card" aria-label="Recent closed trades">
            <header className="recent-closed-card-head">
              <h4>RECENT CLOSED TRADES</h4>
              <button type="button">Export</button>
            </header>
            <div className="data-table-wrap attribution-table-wrap recent-closed-table-wrap">
              <table
                className="data-table attribution-trades-table recent-closed-table"
                aria-label="Recent closed trades"
              >
                <thead>
                  <tr>
                    <th scope="col">Close time</th>
                    <th scope="col">Ticket</th>
                    <th scope="col">Symbol</th>
                    <th scope="col">Type</th>
                    <th className="num" scope="col">
                      Volume
                    </th>
                    <th scope="col">Source</th>
                    <th scope="col">Close reason</th>
                    <th className="num" scope="col">
                      Realised P/L
                    </th>
                    <th aria-label="Open trade" scope="col" />
                  </tr>
                </thead>
                <tbody>
                  {topTrades.length > 0 ? (
                    topTrades.map((trade) => (
                      <tr key={trade.tradeId}>
                        <td className="data-table-subtle">
                          {formatAttributionTime(trade.closeAt, locale)}
                        </td>
                        <td>{trade.ticket ?? shortTradeId(trade.tradeId)}</td>
                        <td>{trade.symbol || "unmapped"}</td>
                        <td>
                          <span
                            className={`recent-closed-side ${trade.direction === "SELL" ? "sell" : "buy"}`}
                          >
                            {trade.direction || "—"}
                          </span>
                        </td>
                        <td className="num-cell">{formatLot(trade.volume)}</td>
                        <td>
                          <span
                            className={`attribution-source-chip ${attributionBucketClass(trade.bucket)}`}
                          >
                            {trade.sourceLabel}
                          </span>
                        </td>
                        <td>{trade.closeReason}</td>
                        <td className="num-cell">
                          <Money
                            value={trade.pnl}
                            currency={activeCurrency}
                            locale={locale}
                            signTone
                          />
                        </td>
                        <td className="recent-closed-chevron">›</td>
                      </tr>
                    ))
                  ) : (
                    <tr className="data-table-empty">
                      <td colSpan={9}>No closed trades for this range.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : null}
    </section>
  );
}

function RiskExposureCard({
  cashflowLabel,
  currency,
  floatingPnl,
  maxDrawdown,
  netCashflow,
  openLots,
  openTrades,
  pendingOrders,
  symbolsActive,
}: {
  cashflowLabel: string;
  currency?: string;
  floatingPnl: number;
  maxDrawdown: number;
  netCashflow: number;
  openLots: number;
  openTrades: number;
  pendingOrders: number;
  symbolsActive: number;
}) {
  const { locale } = useLocale();
  return (
    <section className="risk-exposure-card" aria-label="Risk and exposure">
      <header>
        <h4>RISK &amp; EXPOSURE</h4>
        <button type="button">View all</button>
      </header>
      <div className="risk-exposure-grid">
        <RiskExposureCell label="Open trades" value={openTrades} />
        <RiskExposureCell label="Open lots" value={formatLot(openLots)} />
        <RiskExposureCell
          label="Floating P/L"
          tone={floatingPnl > 0 ? "up" : floatingPnl < 0 ? "down" : undefined}
          value={formatMoney(floatingPnl, currency ?? "USD", locale)}
        />
        <RiskExposureCell
          label="Max drawdown"
          value={formatPercent(maxDrawdown, { locale })}
          danger
        />
        <RiskExposureCell
          label={cashflowLabel}
          tone={netCashflow > 0 ? "up" : netCashflow < 0 ? "down" : undefined}
          value={formatMoney(netCashflow, currency ?? "USD", locale)}
        />
        <RiskExposureCell label="Symbols active" value={symbolsActive} />
        <RiskExposureCell label="Pending orders" value={pendingOrders} />
      </div>
    </section>
  );
}

function RiskExposureCell({
  danger = false,
  label,
  tone,
  value,
}: {
  danger?: boolean;
  label: string;
  tone?: "up" | "down";
  value: ReactNode;
}) {
  const valueClass = danger
    ? "money-down"
    : tone === "up"
      ? "money-up"
      : tone === "down"
        ? "money-down"
        : "";
  return (
    <div className="risk-exposure-cell">
      <span>{label}</span>
      <strong className={`${valueClass} risk-exposure-value`}>{value}</strong>
    </div>
  );
}

function shortTradeId(value: string) {
  const parts = value.split("-").filter(Boolean);
  return parts[parts.length - 1] ?? value;
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
          <select
            aria-label="Statistics scope"
            value={scope}
            onChange={(event) => setScope(event.target.value as StatsScope)}
          >
            <option value="account">Account</option>
            <option value="provider">Provider</option>
          </select>
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

function ExternalActivityPanel({
  accounts,
}: {
  accounts: NonNullable<Parameters<typeof PerformancePage>[0]["accounts"]>;
}) {
  const { locale } = useLocale();
  const rows = accounts.flatMap((account) =>
    (account.externalPositions ?? []).map((position) => ({
      ...position,
      accountNumber: account.accountNumber,
      currency: (account as { currency?: string }).currency,
    })),
  );
  const pending = accounts.reduce((sum, account) => sum + (account.externalOrders?.length ?? 0), 0);
  if (rows.length === 0 && pending === 0) return null;
  const floatingPnl = rows.reduce((sum, position) => sum + (position.profit ?? 0), 0);
  const headerCurrency = rows[0]?.currency;
  return (
    <section className="external-performance-panel" aria-label="External broker activity">
      <header className="external-positions-head">
        <span className="external-positions-label">External activity</span>
        <span className="external-positions-meta">
          {rows.length} position{rows.length === 1 ? "" : "s"} · {pending} pending · floating P/L{" "}
          <Money value={floatingPnl} currency={headerCurrency} locale={locale} signTone />
        </span>
      </header>
      {rows.length > 0 ? (
        <ul className="external-positions-list external-positions-list-compact">
          {rows.map((position) => (
            <li
              className="external-position-row"
              key={`${position.accountNumber}-${position.ticket}`}
            >
              <span className={`external-position-side ${position.type === 0 ? "buy" : "sell"}`}>
                {position.type === 0 ? "BUY" : "SELL"}
              </span>
              <strong className="external-position-symbol">{position.symbol}</strong>
              <span className="external-position-vol">{formatLot(position.volume)}</span>
              <span className="external-position-price">
                @ {formatNumber(position.openPrice, { locale, maximumFractionDigits: 5 })}
              </span>
              {position.profit !== undefined ? (
                <Money
                  value={position.profit}
                  currency={position.currency}
                  locale={locale}
                  signTone
                  className="external-position-profit"
                />
              ) : null}
              <small className="external-position-source">
                {position.accountNumber} · #{position.ticket}
                {position.magic !== undefined ? ` · magic ${position.magic}` : ""}
                {position.comment ? ` · ${position.comment}` : ""}
              </small>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
