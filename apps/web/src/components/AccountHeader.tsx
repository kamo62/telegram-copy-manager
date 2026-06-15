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

function accentColor(accent: Accent): string {
  switch (accent) {
    case "blue":
      return "hsl(218 85% 42%)";
    case "violet":
      return "hsl(265 70% 50%)";
    case "emerald":
      return "var(--up-dim)";
    case "amber":
      return "var(--warn-dim)";
    case "rose":
      return "var(--down-dim)";
    default:
      return "var(--ink-faint)";
  }
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
    {
      key: "today",
      label: "Today",
      amount: kpis.today.amount,
      delta: kpis.today.deltaPercent,
      icon: Sun,
      accent: "amber",
    },
    {
      key: "thisWeek",
      label: "This Week",
      amount: kpis.thisWeek.amount,
      delta: kpis.thisWeek.deltaPercent,
      icon: CalendarRange,
      accent: "blue",
    },
    {
      key: "thisMonth",
      label: "This Month",
      amount: kpis.thisMonth.amount,
      delta: kpis.thisMonth.deltaPercent,
      icon: CalendarDays,
      accent: "violet",
    },
  ];

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
              {connectedPlatform.eaActive ? "EA connected" : "EA offline"}
            </div>
          </div>
        </div>
      </div>

      <div className="account-kpis anim-stagger">
        {loading && kpis.balance === null
          ? Array.from({ length: 6 }, (_, index) => (
              <div className="kpi" key={`kpi-skeleton-${index}`}>
                <SkeletonStat />
              </div>
            ))
          : null}
        {!(loading && kpis.balance === null) &&
          kpiList.map((kpi) => {
            const delta = formatDelta(kpi.delta, locale);
            const Icon = kpi.icon;
            const sparkData = series?.[kpi.key];
            // The ledger value carries the signal; only the primary P/L trend earns color.
            const sparkColor = kpi.primary
              ? kpi.delta !== null && kpi.delta < 0
                ? "var(--down-dim)"
                : kpi.delta !== null && kpi.delta > 0
                  ? "var(--up-dim)"
                  : accentColor(kpi.accent)
              : "var(--ink-faint)";
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
                  <Sparkline ariaLabel={`${kpi.label} trend`} color={sparkColor} data={sparkData} />
                ) : (
                  // Reserve the sparkline strip even when no series is
                  // available (or the series is flat) so layout doesn't
                  // shift once real data lands.
                  <div aria-hidden="true" className="kpi-spark-placeholder" />
                )}
              </div>
            );
          })}
      </div>
    </section>
  );
}
