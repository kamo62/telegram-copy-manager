import { useEffect, useMemo, useState } from "react";
import { GrowthChart, type GrowthSeries } from "../components/GrowthChart";
import { useLocale } from "../contexts/LocaleContext";
import { apiGet } from "../lib/api";
import { formatLot, formatNumber, formatPercent } from "../lib/format";

type PerformanceView = "overview" | "statistics";
type StatsRange = "7d" | "30d" | "90d" | "all";
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
    averageActiveDrawdown: number;
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
}

export function PerformancePage({
  accounts = [],
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
          <GrowthChart data={data} loading={loading} />
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
  const cards = useMemo(
    () =>
      stats
        ? [
            {
              title: "Profit / Return",
              metrics: [
                [
                  "Total P/L",
                  formatNumber(stats.profitReturn.totalPnl, { locale, minimumFractionDigits: 0 }),
                ],
                ["ROI", formatPercent(stats.profitReturn.roiPercent, { locale })],
                ["Best day", formatNumber(stats.profitReturn.bestDay, { locale })],
                ["Worst day", formatNumber(stats.profitReturn.worstDay, { locale })],
              ],
            },
            {
              title: "Win / Loss",
              metrics: [
                ["Win rate", formatPercent(stats.winLoss.winRate * 100, { locale })],
                ["Wins", String(stats.winLoss.wins)],
                ["Losses", String(stats.winLoss.losses)],
                ["Avg win", formatNumber(stats.winLoss.averageWin, { locale })],
                ["Avg loss", formatNumber(stats.winLoss.averageLoss, { locale })],
              ],
            },
            {
              title: "Risk / Drawdown",
              metrics: [
                ["Max DD", formatNumber(stats.riskDrawdown.maxDrawdown, { locale })],
                ["Max DD %", formatPercent(stats.riskDrawdown.maxDrawdownPct, { locale })],
                ["Current DD", formatNumber(stats.riskDrawdown.currentDrawdown, { locale })],
                [
                  "Avg active DD",
                  formatNumber(stats.riskDrawdown.averageActiveDrawdown, { locale }),
                ],
                ["Recovery", formatNumber(stats.riskDrawdown.recoveryFactor, { locale })],
              ],
            },
            {
              title: "Quality",
              metrics: [
                ["Profit factor", formatNumber(stats.quality.profitFactor, { locale })],
                ["Gross profit", formatNumber(stats.quality.grossProfit, { locale })],
                ["Gross loss", formatNumber(stats.quality.grossLoss, { locale })],
                ["Expectancy", formatNumber(stats.quality.expectancy, { locale })],
              ],
            },
            {
              title: "Streaks",
              metrics: [
                ["Current", stats.streaks.current],
                ["Max wins", String(stats.streaks.maxWins)],
                ["Max losses", String(stats.streaks.maxLosses)],
              ],
            },
            {
              title: "Timing",
              metrics: [
                [
                  "Avg duration",
                  `${formatNumber(stats.timing.averageTradeMinutes, { locale })} min`,
                ],
                ["Best weekday", stats.timing.bestWeekday],
                ["Worst weekday", stats.timing.worstWeekday],
              ],
            },
          ]
        : [],
    [locale, stats],
  );
  return (
    <section className="statistics-panel" aria-label="Account statistics">
      <header className="statistics-toolbar">
        <div className="statistics-filter-group">
          <select
            aria-label="Statistics date range"
            value={range}
            onChange={(event) => setRange(event.target.value as StatsRange)}
          >
            <option value="7d">7d</option>
            <option value="30d">30d</option>
            <option value="90d">90d</option>
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
    })),
  );
  const pending = accounts.reduce((sum, account) => sum + (account.externalOrders?.length ?? 0), 0);
  if (rows.length === 0 && pending === 0) return null;
  const floatingPnl = rows.reduce((sum, position) => sum + (position.profit ?? 0), 0);
  return (
    <section className="external-performance-panel" aria-label="External broker activity">
      <header className="external-positions-head">
        <span className="external-positions-label">External activity</span>
        <span className="external-positions-meta">
          {rows.length} position{rows.length === 1 ? "" : "s"} · {pending} pending · floating P/L{" "}
          <strong className={floatingPnl >= 0 ? "up" : "down"}>
            {floatingPnl >= 0 ? "+" : ""}
            {formatNumber(floatingPnl, { locale })}
          </strong>
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
                <span
                  className={`external-position-profit ${position.profit >= 0 ? "up" : "down"}`}
                >
                  {position.profit >= 0 ? "+" : ""}
                  {formatNumber(position.profit, { locale })}
                </span>
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
