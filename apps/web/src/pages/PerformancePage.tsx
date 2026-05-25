import { type ReactNode, useEffect, useMemo, useState } from "react";
import { GrowthChart, type GrowthSeries } from "../components/GrowthChart";
import { Money } from "../components/Money";
import { Stat } from "../components/Stat";
import { useLocale } from "../contexts/LocaleContext";
import { apiGet } from "../lib/api";
import { formatLot, formatNumber, formatPercent } from "../lib/format";

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
          <GrowthChart
            data={data}
            loading={loading}
            currency={(account as { currency?: string } | undefined)?.currency}
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
