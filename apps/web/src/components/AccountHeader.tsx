import {
  CalendarDays,
  CalendarRange,
  CheckCircle2,
  type LucideIcon,
  PiggyBank,
  Server,
  Sun,
  TrendingUp,
  Wallet,
} from "lucide-react";
import { useState } from "react";
import { useLocale } from "../contexts/LocaleContext";
import { formatPercent } from "../lib/format";
import { Money } from "./Money";
import { SkeletonStat } from "./Skeleton";
import { Sparkline } from "./Sparkline";

export interface AccountHeaderData {
  connectedPlatform: {
    platform: string;
    broker: string;
    accountType: "DEMO" | "LIVE" | "—";
    expertAdvisorVersion: string;
    eaActive: boolean;
  };
  kpis: {
    balance: number | null;
    equity: number | null;
    totalProfit: { amount: number | null; deltaPercent: number | null };
    today: { amount: number | null; deltaPercent: number | null };
    thisWeek: { amount: number | null; deltaPercent: number | null };
    thisMonth: { amount: number | null; deltaPercent: number | null };
  };
  /** Optional per-KPI history series for the sparkline strip. Each array is
   * a thin slice of recent equity / P-L values; falsy or short series skip
   * rendering so cards never show a degenerate single-point line. */
  series?: {
    balance?: number[];
    equity?: number[];
    totalProfit?: number[];
    today?: number[];
    thisWeek?: number[];
    thisMonth?: number[];
  };
  currency: string;
}

type Accent = "blue" | "violet" | "emerald" | "amber" | "rose" | "muted";

function accentColor(): string {
  return "var(--ink)";
}

function formatDelta(
  deltaPercent: number | null,
  locale: string,
): { text: string; tone: "up" | "down" | "muted" } {
  if (deltaPercent === null) return { text: "—", tone: "muted" };
  const sign = deltaPercent >= 0 ? "▲" : "▼";
  const tone: "up" | "down" | "muted" =
    deltaPercent > 0 ? "up" : deltaPercent < 0 ? "down" : "muted";
  return {
    text: `${sign} ${formatPercent(Math.abs(deltaPercent), { locale, signDisplay: "never" })}`,
    tone,
  };
}

export function AccountHeader({
  data,
  loading = false,
}: {
  data: AccountHeaderData;
  loading?: boolean;
}) {
  const { connectedPlatform, kpis, series, currency } = data;
  const { locale } = useLocale();
  // Today / This Week / This Month are the same metric over three windows, so
  // they collapse into one card with a toggle instead of three separate cards.
  const [pnlWindow, setPnlWindow] = useState<"today" | "thisWeek" | "thisMonth">("today");

  // Each card carries its own icon + accent so the badge palette stays
  // distinct even when several values move in the same direction.
  const kpiList: Array<{
    key: keyof NonNullable<AccountHeaderData["series"]>;
    label: string;
    amount: number | null;
    delta: number | null;
    icon: LucideIcon;
    accent: Accent;
    primary?: boolean;
  }> = [
    {
      key: "balance",
      label: "Balance",
      amount: kpis.balance,
      delta: null,
      icon: Wallet,
      accent: "blue",
    },
    {
      key: "equity",
      label: "Equity",
      amount: kpis.equity,
      delta: null,
      icon: PiggyBank,
      accent: "violet",
    },
    {
      key: "totalProfit",
      label: "Trading P/L",
      amount: kpis.totalProfit.amount,
      delta: kpis.totalProfit.deltaPercent,
      icon: TrendingUp,
      accent: "emerald",
      primary: true,
    },
  ];

  const windowOptions: Array<{
    key: "today" | "thisWeek" | "thisMonth";
    short: string;
    icon: LucideIcon;
    accent: Accent;
  }> = [
    { key: "today", short: "Today", icon: Sun, accent: "amber" },
    { key: "thisWeek", short: "Week", icon: CalendarRange, accent: "blue" },
    { key: "thisMonth", short: "Month", icon: CalendarDays, accent: "violet" },
  ];
  const activeWindow =
    windowOptions.find((option) => option.key === pnlWindow) ?? windowOptions[0]!;
  const windowKpi = kpis[pnlWindow];
  const WindowIcon = activeWindow.icon;
  const windowDelta = formatDelta(windowKpi.deltaPercent, locale);
  const windowSpark = series?.[pnlWindow];
  const windowSparkColor =
    windowKpi.deltaPercent !== null && windowKpi.deltaPercent < 0
      ? "var(--down-dim)"
      : windowKpi.deltaPercent !== null && windowKpi.deltaPercent > 0
        ? "var(--up-dim)"
        : accentColor();

  return (
    <section className="account-header" aria-label="Account performance">
      <div className="account-header-section">
        <h2 className="account-header-title">Live</h2>
        <div className="account-platform-card">
          <div className="account-platform-card-icon" aria-hidden="true">
            <Server size={16} />
          </div>
          <div>
            <dl className="account-platform-card-grid">
              <dt>Platform</dt>
              <dd>{connectedPlatform.platform}</dd>
              <dt>Broker</dt>
              <dd>{connectedPlatform.broker}</dd>
              <dt>Type</dt>
              <dd>{connectedPlatform.accountType}</dd>
              <dt>Expert Advisor</dt>
              <dd>{connectedPlatform.expertAdvisorVersion}</dd>
            </dl>
            <div
              className={`ea-badge ${connectedPlatform.eaActive ? "ea-on" : "ea-off"}`}
              role="status"
            >
              <CheckCircle2 size={12} aria-hidden="true" />
              {connectedPlatform.eaActive ? "EA WORKING" : "EA OFFLINE"}
            </div>
          </div>
        </div>
      </div>

      <div className="account-kpis anim-stagger">
        {loading && kpis.balance === null
          ? Array.from({ length: 4 }, (_, index) => (
              <div className="kpi" key={`kpi-skeleton-${index}`}>
                <SkeletonStat />
              </div>
            ))
          : null}
        {!(loading && kpis.balance === null) ? (
          <>
            {kpiList.map((kpi) => {
              const delta = formatDelta(kpi.delta, locale);
              const Icon = kpi.icon;
              const sparkData = series?.[kpi.key];
              // Sparkline tone tracks P/L sign for the windowed cards;
              // Balance/Equity stay on their fixed accent.
              const sparkColor =
                kpi.delta !== null && kpi.delta < 0
                  ? "var(--down-dim)"
                  : kpi.delta !== null && kpi.delta > 0
                    ? "var(--up-dim)"
                    : accentColor();
              return (
                <div className={`kpi ${kpi.primary ? "kpi-primary" : ""}`} key={kpi.label}>
                  <div className="kpi-head">
                    <span className="kpi-label">
                      <span>{kpi.label}</span>
                      {currency ? <span className="kpi-label-currency">· {currency}</span> : null}
                    </span>
                    <span className={`kpi-badge kpi-badge-${kpi.accent}`} aria-hidden="true">
                      <Icon size={13} />
                    </span>
                  </div>
                  <Money
                    value={kpi.amount}
                    currency={currency}
                    locale={locale}
                    signTone={kpi.delta !== null}
                    className="kpi-amount"
                  />
                  <span className={`kpi-delta kpi-delta-${delta.tone}`}>{delta.text}</span>
                  {sparkData &&
                  sparkData.length >= 2 &&
                  Math.min(...sparkData) !== Math.max(...sparkData) ? (
                    <Sparkline
                      ariaLabel={`${kpi.label} trend`}
                      color={sparkColor}
                      data={sparkData}
                    />
                  ) : (
                    // Reserve the sparkline strip even when no series is
                    // available (or the series is flat) so layout doesn't
                    // shift once real data lands.
                    <div aria-hidden="true" className="kpi-spark-placeholder" />
                  )}
                </div>
              );
            })}
            <div className="kpi kpi-window">
              <div className="kpi-head">
                <span className="kpi-label">
                  <span>P/L</span>
                  {currency ? <span className="kpi-label-currency">· {currency}</span> : null}
                </span>
                <span className={`kpi-badge kpi-badge-${activeWindow.accent}`} aria-hidden="true">
                  <WindowIcon size={13} />
                </span>
              </div>
              <div className="kpi-window-toggle" role="tablist" aria-label="P/L window">
                {windowOptions.map((option) => (
                  <button
                    aria-selected={pnlWindow === option.key}
                    className={pnlWindow === option.key ? "active" : ""}
                    key={option.key}
                    onClick={() => setPnlWindow(option.key)}
                    role="tab"
                    type="button"
                  >
                    {option.short}
                  </button>
                ))}
              </div>
              <Money
                value={windowKpi.amount}
                currency={currency}
                locale={locale}
                signTone={windowKpi.deltaPercent !== null}
                className="kpi-amount"
              />
              <span className={`kpi-delta kpi-delta-${windowDelta.tone}`}>{windowDelta.text}</span>
              {windowSpark &&
              windowSpark.length >= 2 &&
              Math.min(...windowSpark) !== Math.max(...windowSpark) ? (
                <Sparkline
                  ariaLabel={`${activeWindow.short} P/L trend`}
                  color={windowSparkColor}
                  data={windowSpark}
                />
              ) : (
                <div aria-hidden="true" className="kpi-spark-placeholder" />
              )}
            </div>
          </>
        ) : null}
      </div>
    </section>
  );
}
