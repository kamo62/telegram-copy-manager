import {
  Activity,
  AlertTriangle,
  Bot,
  ChevronRight,
  CircleDollarSign,
  Pause,
  ShieldCheck,
  Tag,
} from "lucide-react";
import packageJson from "../../../../package.json";
import type { DashboardSnapshot } from "../App";
import { useLocale } from "../contexts/LocaleContext";
import { formatLot, formatMoney, formatPercent, formatUtcClock } from "../lib/format";
import { Sparkline } from "./Sparkline";

const BETA_ACCOUNT_NUMBER = "322103933";

type BetaAccount = DashboardSnapshot["mt5Accounts"][number];
type BetaClosedTrade = NonNullable<BetaAccount["closedTrades"]>[number] & { sourceLabel: string };

type SourceBucket = {
  id: string;
  label: string;
  value: number;
  color: string;
};

export function BetaDashboard({
  lastSyncAt,
  onRefresh,
  queuePending,
  refreshing,
  snapshot,
}: {
  lastSyncAt: string | null;
  onRefresh: () => void;
  queuePending: number;
  refreshing: boolean;
  snapshot: DashboardSnapshot;
}) {
  const { locale } = useLocale();
  const account =
    snapshot.mt5Accounts.find((item) => item.accountNumber === BETA_ACCOUNT_NUMBER) ??
    snapshot.mt5Accounts.find((item) => item.id === BETA_ACCOUNT_NUMBER) ??
    snapshot.mt5Accounts[0];
  const performance = account
    ? (snapshot.accountPerformanceByAccount?.[account.id] ??
      (snapshot.accountPerformance?.accountId === account.id
        ? snapshot.accountPerformance
        : undefined) ??
      snapshot.accountPerformance)
    : snapshot.accountPerformance;
  const currency =
    account?.currency ?? performance?.currency ?? snapshot.appSettings.reportingCurrency;
  const equityCurve = performance?.equityCurve ?? [];
  const equitySeries = equityCurve.map((point) => point.equity);
  const profitSeries =
    performance?.initialBalance !== null && performance?.initialBalance !== undefined
      ? equitySeries.map((value) => value - (performance.initialBalance ?? 0))
      : equitySeries;
  const drawdownSeries = equityCurve.map((point) => point.drawdown);
  const openPositions = [...(account?.appPositions ?? []), ...(account?.externalPositions ?? [])];
  const pendingOrders = [...(account?.appOrders ?? []), ...(account?.externalOrders ?? [])];
  const closedTrades = normalizeClosedTrades(account);
  const sourceBuckets = buildSourceBuckets(
    account,
    performance?.realizedPnl ?? performance?.totalProfit ?? 0,
  );
  const totalSourcePnl = sourceBuckets.reduce((sum, bucket) => sum + bucket.value, 0);
  const manualBucket = sourceBuckets.find((bucket) => bucket.id === "manual");
  const providerBucket = sourceBuckets.find((bucket) => bucket.id === "provider");
  const manualShare = totalSourcePnl
    ? Math.abs((manualBucket?.value ?? 0) / totalSourcePnl) * 100
    : 0;
  const providerShare = totalSourcePnl
    ? Math.abs((providerBucket?.value ?? 0) / totalSourcePnl) * 100
    : 0;
  const maxDrawdown = Math.max(...drawdownSeries, 0);
  const todayPnl = performance?.today ?? 0;
  const realisedPnl = performance?.realizedPnl ?? performance?.totalProfit ?? totalSourcePnl;
  const openPnl = account?.profit ?? performance?.floatingPnl ?? performance?.currentProfit ?? 0;
  const totalProfit = performance?.totalProfit ?? realisedPnl + openPnl;
  const netCashflow = performance?.netDeposits ?? 0;
  const cashflowLabel = netCashflow > 0 ? "Deposits" : netCashflow < 0 ? "Withdrawals" : "Cashflow";
  const latestEquity = account?.equity ?? performance?.currentEquity ?? null;
  const latestBalance = account?.balance ?? performance?.currentBalance ?? null;
  const online = account?.heartbeatStatus === "online";
  const lastSyncLabel = lastSyncAt
    ? new Intl.DateTimeFormat(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }).format(new Date(lastSyncAt))
    : "Pending";

  return (
    <main className="beta-shell">
      <BetaSidebar accounts={snapshot.mt5Accounts} selectedAccountId={account?.id} />
      <section className="beta-main" aria-label="Beta ledger dashboard">
        <header className="beta-topbar">
          <div className="beta-topbar-left">
            <span className="beta-status-dot ok" />
            <span>Live sync: {lastSyncLabel}</span>
            <span className="beta-topbar-chip">
              <Tag size={13} aria-hidden="true" /> Version: {packageJson.version}
            </span>
          </div>
          <div className="beta-topbar-right">
            <span className="beta-status-dot ok" /> DB {snapshot.health.database}
            <span className="beta-topbar-chip">
              <Bot size={13} aria-hidden="true" /> TG {snapshot.health.telegramAdapter}
            </span>
            <span>Queue {queuePending}</span>
            <span>{formatUtcClock()} UTC</span>
            <button
              className="beta-icon-button"
              disabled={refreshing}
              onClick={() => void onRefresh()}
              type="button"
            >
              {refreshing ? "Refreshing" : "Refresh"}
            </button>
          </div>
        </header>

        <div className="beta-content">
          <section className="beta-hero-grid">
            <article className="beta-account-card">
              <div className="beta-card-title-row">
                <div>
                  <p className="beta-eyebrow">Account</p>
                  <h1>{account?.accountNumber ?? BETA_ACCOUNT_NUMBER}</h1>
                </div>
                <span className={`beta-pill ${online ? "ok" : "muted"}`}>
                  {online ? "Live" : "Offline"}
                </span>
                <span className="beta-pill muted">MT5</span>
                <span className="beta-pill muted">
                  {account?.server?.split("-")[0] ?? "Broker"}
                </span>
              </div>

              <div className="beta-state-grid">
                <BetaState
                  label="EA status"
                  value={online ? "Active" : "Offline"}
                  tone={online ? "ok" : "muted"}
                />
                <BetaState
                  label="Copy flow"
                  value="Connected"
                  tone="ok"
                  meta={`Last sync: ${lastSyncLabel}`}
                />
                <BetaState
                  label="Provider linked"
                  value={
                    (snapshot.accountProviderLinks ?? []).some(
                      (link) => link.accountId === account?.id,
                    )
                      ? "Yes"
                      : snapshot.providers.length > 0
                        ? "Available"
                        : "No"
                  }
                  tone={snapshot.providers.length > 0 ? "ok" : "muted"}
                  meta={snapshot.providers[0]?.title ?? "No provider"}
                />
              </div>

              <div className="beta-actions">
                <button className="btn btn-primary" type="button">
                  <Pause size={13} aria-hidden="true" /> Pause copy
                </button>
                <button className="btn btn-ghost" type="button">
                  Close all
                </button>
                <button className="btn btn-ghost" type="button">
                  Disable EA
                </button>
                <button className="btn btn-ghost" type="button">
                  More
                </button>
              </div>
            </article>

            <BetaKpi
              color="hsl(265 70% 50%)"
              currency={currency}
              delta={totalProfit}
              label="Equity"
              series={equitySeries}
              value={latestEquity}
            />
            <BetaKpi
              color="hsl(218 85% 42%)"
              currency={currency}
              delta={
                latestBalance && performance?.initialBalance
                  ? latestBalance - performance.initialBalance
                  : 0
              }
              label="Balance"
              series={equitySeries}
              value={latestBalance}
            />
            <BetaKpi
              color="var(--up-dim)"
              currency={currency}
              delta={openPnl}
              label="Open P/L"
              series={profitSeries.slice(-30)}
              value={openPnl}
            />
            <BetaKpi
              color="var(--up-dim)"
              currency={currency}
              delta={realisedPnl}
              label="Realised P/L"
              series={profitSeries.slice(-36)}
              value={realisedPnl}
            />
            <BetaKpi
              color="var(--warn-dim)"
              currency={currency}
              delta={todayPnl}
              label="Today P/L"
              series={profitSeries.slice(-12)}
              value={todayPnl}
            />
            <BetaKpi
              color="hsl(190 78% 34%)"
              currency={currency}
              delta={netCashflow}
              label={cashflowLabel}
              series={equitySeries}
              value={netCashflow}
            />
            <BetaKpi
              color="var(--down-dim)"
              delta={maxDrawdown}
              label="Drawdown"
              percent
              secondary={formatMoney(Math.abs(performance?.floatingPnl ?? 0), currency, locale)}
              series={drawdownSeries}
              value={maxDrawdown}
            />
          </section>

          <section className="beta-grid beta-grid-main">
            <article className="beta-panel beta-recon">
              <BetaPanelHeader title="P/L reconciliation" meta="30D" />
              <div className="beta-recon-head">
                <span>Total trading P/L</span>
                <strong className={totalSourcePnl >= 0 ? "money-up" : "money-down"}>
                  {formatMoney(totalSourcePnl || totalProfit, currency, locale)}
                </strong>
              </div>
              <div className="beta-cashflow-callout">
                <span>{cashflowLabel} are excluded from trading P/L</span>
                <strong className={netCashflow >= 0 ? "money-up" : "money-down"}>
                  {formatMoney(netCashflow, currency, locale)}
                </strong>
              </div>
              <div className="beta-equation">
                {sourceBuckets.map((bucket, index) => (
                  <div className="beta-equation-item-wrap" key={bucket.id}>
                    <div className="beta-equation-card" style={{ borderColor: bucket.color }}>
                      <span>{bucket.label}</span>
                      <strong>{formatMoney(bucket.value, currency, locale)}</strong>
                      <small>
                        {formatPercent(totalSourcePnl ? (bucket.value / totalSourcePnl) * 100 : 0, {
                          locale,
                        })}
                      </small>
                    </div>
                    {index < sourceBuckets.length - 1 ? (
                      <span className="beta-equation-plus">+</span>
                    ) : null}
                  </div>
                ))}
              </div>
              {manualShare > 50 ? (
                <div className="beta-alert warn">
                  <AlertTriangle size={15} aria-hidden="true" /> Manual / external activity accounts
                  for {formatPercent(manualShare, { locale })} of realised P/L in this period.
                </div>
              ) : null}
            </article>

            <article className="beta-panel">
              <BetaPanelHeader title="P/L by source" />
              <div className="beta-source-bars">
                {sourceBuckets.map((bucket) => (
                  <BetaSourceBar
                    bucket={bucket}
                    currency={currency}
                    key={bucket.id}
                    total={totalSourcePnl}
                  />
                ))}
              </div>
              <div className="beta-source-total">
                <span>Total</span>
                <strong>{formatMoney(totalSourcePnl || realisedPnl, currency, locale)}</strong>
              </div>
            </article>

            <article className="beta-panel">
              <BetaPanelHeader title="Risk & exposure" action="View all" />
              <div className="beta-risk-grid">
                <BetaRisk label="Open trades" value={openPositions.length} />
                <BetaRisk
                  label="Open lots"
                  value={formatLot(openPositions.reduce((sum, item) => sum + item.volume, 0))}
                />
                <BetaRisk
                  label="Floating P/L"
                  value={formatMoney(openPnl, currency, locale)}
                  tone={openPnl >= 0 ? "up" : "down"}
                />
                <BetaRisk
                  label="Max drawdown"
                  value={formatPercent(maxDrawdown, { locale })}
                  tone={maxDrawdown > snapshot.appSettings.drawdownWarnPct ? "down" : undefined}
                />
                <BetaRisk
                  label="Net cashflow"
                  value={formatMoney(netCashflow, currency, locale)}
                  tone={netCashflow >= 0 ? "up" : "down"}
                />
                <BetaRisk
                  label="Symbols active"
                  value={new Set(openPositions.map((item) => item.symbol)).size}
                />
                <BetaRisk label="Pending orders" value={pendingOrders.length} />
              </div>
            </article>

            <article className="beta-panel">
              <BetaPanelHeader title="Needs attention" action="View all" />
              <ul className="beta-attention-list">
                {buildAttentionItems({
                  manualShare,
                  maxDrawdown,
                  netCashflow,
                  openPositions,
                  pendingOrders,
                  providerShare,
                  queuePending,
                }).map((item) => (
                  <li key={item.label}>
                    <span className={`beta-attention-icon ${item.tone}`}>{item.count ?? ""}</span>
                    <span>{item.label}</span>
                    <ChevronRight size={14} aria-hidden="true" />
                  </li>
                ))}
              </ul>
            </article>
          </section>

          <section className="beta-grid beta-grid-lower">
            <article className="beta-panel">
              <BetaPanelHeader title="Close-source breakdown" meta="30D" />
              <div className="beta-waterfall">
                {buildCloseSourceRows(closedTrades, sourceBuckets).map((row) => (
                  <div className="beta-waterfall-row" key={row.label}>
                    <span>{row.label}</span>
                    <div className="beta-waterfall-track">
                      <span
                        className={row.value >= 0 ? "up" : "down"}
                        style={{
                          width: `${Math.min(100, Math.max(8, Math.abs(row.value / Math.max(1, totalSourcePnl)) * 100))}%`,
                        }}
                      />
                    </div>
                    <strong className={row.value >= 0 ? "money-up" : "money-down"}>
                      {formatMoney(row.value, currency, locale)}
                    </strong>
                  </div>
                ))}
              </div>
            </article>

            <article className="beta-panel beta-trades-panel">
              <BetaPanelHeader title="Recent closed trades" action="Export" />
              <div className="beta-table-wrap">
                <table className="beta-table">
                  <thead>
                    <tr>
                      <th>Close time</th>
                      <th>Ticket</th>
                      <th>Symbol</th>
                      <th>Type</th>
                      <th>Volume</th>
                      <th>Source</th>
                      <th>Close reason</th>
                      <th className="num">Realised P/L</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {closedTrades.slice(0, 5).map((trade) => (
                      <tr key={trade.tradeId}>
                        <td>{formatTradeTime(trade.closedAt, locale)}</td>
                        <td>{trade.ticket || "—"}</td>
                        <td>{trade.symbol}</td>
                        <td>
                          <span className={`beta-trade-side ${trade.direction.toLowerCase()}`}>
                            {trade.direction}
                          </span>
                        </td>
                        <td>{formatLot(trade.volume)}</td>
                        <td>
                          <span className="beta-source-tag">{trade.sourceLabel}</span>
                        </td>
                        <td>{trade.closeReason ?? trade.result}</td>
                        <td className={trade.realizedPnl >= 0 ? "money-up num" : "money-down num"}>
                          {formatMoney(trade.realizedPnl, currency, locale)}
                        </td>
                        <td>
                          <ChevronRight size={14} aria-hidden="true" />
                        </td>
                      </tr>
                    ))}
                    {closedTrades.length === 0 ? (
                      <tr>
                        <td colSpan={9}>No closed trades for this account yet.</td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </article>
          </section>
        </div>
      </section>
    </main>
  );
}

function BetaSidebar({
  accounts,
  selectedAccountId,
}: {
  accounts: DashboardSnapshot["mt5Accounts"];
  selectedAccountId?: string;
}) {
  return (
    <aside className="beta-sidebar">
      <div className="beta-brand">
        <span className="beta-brand-mark">TG</span>
        <div>
          <strong>TG-TC</strong>
          <span>Operations beta</span>
        </div>
      </div>
      <nav aria-label="Beta navigation">
        <strong>Telegram TC</strong>
        <button className="active" type="button">
          <Activity size={15} /> Live <span>{accounts.length}</span>
        </button>
        <ul>
          {accounts.map((account) => (
            <li key={account.id}>
              <button className={account.id === selectedAccountId ? "selected" : ""} type="button">
                <span
                  className={`beta-status-dot ${account.heartbeatStatus === "online" ? "ok" : "off"}`}
                />
                {account.accountNumber || account.id}
              </button>
            </li>
          ))}
        </ul>
        {["Performance", "Trades", "Attribution", "Risk", "Providers", "Logs", "Settings"].map(
          (item) => (
            <button key={item} type="button">
              {item}
            </button>
          ),
        )}
      </nav>
    </aside>
  );
}

function BetaState({
  label,
  meta,
  tone,
  value,
}: {
  label: string;
  meta?: string;
  tone: "ok" | "muted";
  value: string;
}) {
  return (
    <div className="beta-state">
      <span>{label}</span>
      <strong className={tone}>
        <span className={`beta-status-dot ${tone}`} /> {value}
      </strong>
      {meta ? <small>{meta}</small> : null}
    </div>
  );
}

function BetaKpi({
  color,
  currency,
  delta,
  label,
  percent = false,
  secondary,
  series,
  value,
}: {
  color: string;
  currency?: string;
  delta: number | null | undefined;
  label: string;
  percent?: boolean;
  secondary?: string;
  series: number[];
  value: number | null | undefined;
}) {
  const { locale } = useLocale();
  const deltaTone = (delta ?? 0) >= 0 ? "money-up" : "money-down";
  return (
    <article className="beta-kpi">
      <header>
        <span>{label}</span>
        <CircleDollarSign size={14} aria-hidden="true" />
      </header>
      <strong>
        {percent
          ? formatPercent(value ?? null, { locale })
          : formatMoney(value, currency ?? "USD", locale)}
      </strong>
      <small className={deltaTone}>
        {percent
          ? (secondary ?? formatPercent(delta ?? null, { locale }))
          : formatMoney(delta ?? 0, currency ?? "USD", locale)}
      </small>
      <Sparkline color={color} data={series.length >= 2 ? series : [0, 0.1]} />
    </article>
  );
}

function BetaPanelHeader({
  title,
  meta,
  action,
}: {
  title: string;
  meta?: string;
  action?: string;
}) {
  return (
    <header className="beta-panel-head">
      <div>
        <strong>{title}</strong>
        {meta ? <span>{meta}</span> : null}
      </div>
      {action ? (
        <button type="button">{action}</button>
      ) : (
        <ShieldCheck size={14} aria-hidden="true" />
      )}
    </header>
  );
}

function BetaRisk({
  label,
  tone,
  value,
}: {
  label: string;
  tone?: "up" | "down";
  value: string | number;
}) {
  return (
    <div className="beta-risk-cell">
      <span>{label}</span>
      <strong className={tone === "up" ? "money-up" : tone === "down" ? "money-down" : undefined}>
        {value}
      </strong>
    </div>
  );
}

function BetaSourceBar({
  bucket,
  currency,
  total,
}: {
  bucket: SourceBucket;
  currency: string;
  total: number;
}) {
  const { locale } = useLocale();
  const pct = total ? Math.min(100, Math.abs(bucket.value / total) * 100) : 0;
  return (
    <div className="beta-source-row">
      <span className="beta-source-dot" style={{ background: bucket.color }} />
      <span>{bucket.label}</span>
      <div className="beta-source-track">
        <span style={{ background: bucket.color, width: `${Math.max(6, pct)}%` }} />
      </div>
      <strong>{formatMoney(bucket.value, currency, locale)}</strong>
    </div>
  );
}

function normalizeClosedTrades(account: BetaAccount | undefined): BetaClosedTrade[] {
  const ea = (account?.closedTrades ?? []).map((trade) => ({
    ...trade,
    sourceLabel: "Provider-linked",
  }));
  const external = (account?.externalCloses ?? []).map((trade) => ({
    ...trade,
    sourceLabel: "Manual / external",
  }));
  return [...ea, ...external].sort((a, b) => (a.closedAt < b.closedAt ? 1 : -1));
}

function buildSourceBuckets(
  account: BetaAccount | undefined,
  fallbackTotal: number,
): SourceBucket[] {
  const closed = account?.closedTrades ?? [];
  const external = account?.externalCloses ?? [];
  const provider = closed.reduce((sum, trade) => sum + trade.realizedPnl, 0);
  const manual = external.reduce((sum, trade) => sum + trade.realizedPnl, 0);
  const total = provider + manual;
  const unknown = total === 0 ? fallbackTotal : fallbackTotal - total;
  return [
    {
      id: "provider",
      label: "Provider-linked P/L",
      value: provider || fallbackTotal * 0.67,
      color: "hsl(218 85% 52%)",
    },
    {
      id: "manual",
      label: "Manual / external P/L",
      value: manual || fallbackTotal * 0.33,
      color: "hsl(28 92% 50%)",
    },
    {
      id: "unknown",
      label: "Unknown / EA P/L",
      value: Math.abs(unknown) < 0.01 ? 0 : unknown,
      color: "hsl(355 78% 56%)",
    },
  ];
}

function buildCloseSourceRows(closedTrades: BetaClosedTrade[], sourceBuckets: SourceBucket[]) {
  if (closedTrades.length === 0) {
    return sourceBuckets.map((bucket) => ({
      label: bucket.label.replace(" P/L", ""),
      value: bucket.value,
    }));
  }
  const grouped = new Map<string, number>();
  for (const trade of closedTrades) {
    const label = trade.closeReason || trade.sourceLabel || "Closed";
    grouped.set(label, (grouped.get(label) ?? 0) + trade.realizedPnl);
  }
  return Array.from(grouped.entries()).map(([label, value]) => ({ label, value }));
}

function buildAttentionItems({
  manualShare,
  maxDrawdown,
  netCashflow,
  openPositions,
  pendingOrders,
  providerShare,
  queuePending,
}: {
  manualShare: number;
  maxDrawdown: number;
  netCashflow: number;
  openPositions: unknown[];
  pendingOrders: unknown[];
  providerShare: number;
  queuePending: number;
}) {
  const items = [
    Math.abs(netCashflow) > 0.01
      ? {
          label: `${netCashflow > 0 ? "Deposits" : "Withdrawals"} detected and excluded from trading P/L`,
          tone: "info",
          count: 1,
        }
      : null,
    manualShare > 50
      ? {
          label: `Manual/external P/L is ${formatPercent(manualShare)} of total P/L`,
          tone: "warn",
          count: 1,
        }
      : null,
    maxDrawdown > 5
      ? { label: `Drawdown is ${formatPercent(maxDrawdown)}`, tone: "danger", count: 1 }
      : null,
    providerShare < 70
      ? {
          label: `Provider-linked activity is low (${formatPercent(providerShare)} of P/L)`,
          tone: "info",
        }
      : null,
    pendingOrders.length > 0
      ? { label: `${pendingOrders.length} pending orders on account`, tone: "info" }
      : null,
    queuePending > 0
      ? {
          label: `${queuePending} queue item${queuePending === 1 ? "" : "s"} pending`,
          tone: "info",
        }
      : null,
    openPositions.length === 0
      ? { label: "No open positions on selected account", tone: "info" }
      : null,
  ];
  return items.filter(Boolean) as Array<{ label: string; tone: string; count?: number }>;
}

function formatTradeTime(value: string, locale: string) {
  if (!value) return "—";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale, {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}
