import { CheckCircle2, Server } from "lucide-react";
import { useLocale } from "../contexts/LocaleContext";
import { formatNumber, formatPercent } from "../lib/format";
import { SkeletonStat } from "./Skeleton";

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
  currency: string;
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
  const { connectedPlatform, kpis, currency } = data;
  const { locale } = useLocale();

  const kpiList: Array<{
    label: string;
    amount: number | null;
    delta: number | null;
    primary?: boolean;
  }> = [
    { label: "Balance", amount: kpis.balance, delta: null, primary: false },
    { label: "Equity", amount: kpis.equity, delta: null, primary: false },
    {
      label: "Trading P/L",
      amount: kpis.totalProfit.amount,
      delta: kpis.totalProfit.deltaPercent,
      primary: true,
    },
    { label: "Today", amount: kpis.today.amount, delta: kpis.today.deltaPercent },
    {
      label: "This Week",
      amount: kpis.thisWeek.amount,
      delta: kpis.thisWeek.deltaPercent,
    },
    {
      label: "This Month",
      amount: kpis.thisMonth.amount,
      delta: kpis.thisMonth.deltaPercent,
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
              {connectedPlatform.eaActive ? "EA WORKING" : "EA OFFLINE"}
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
            return (
              <div className={`kpi ${kpi.primary ? "kpi-primary" : ""}`} key={kpi.label}>
                <span className="kpi-label">
                  <span>{kpi.label}</span>
                  {currency ? <span className="kpi-label-currency">· {currency}</span> : null}
                </span>
                <strong className="kpi-amount">{formatNumber(kpi.amount, { locale })}</strong>
                <span className={`kpi-delta kpi-delta-${delta.tone}`}>{delta.text}</span>
              </div>
            );
          })}
      </div>
    </section>
  );
}
