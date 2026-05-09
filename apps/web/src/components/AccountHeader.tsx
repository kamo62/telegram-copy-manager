import { CheckCircle2, Server } from "lucide-react";

export interface AccountHeaderData {
  connectedPlatform: {
    platform: string;
    broker: string;
    accountType: "DEMO" | "LIVE" | "—";
    expertAdvisorVersion: string;
    eaActive: boolean;
  };
  kpis: {
    initialBalance: number | null;
    totalProfit: { amount: number | null; deltaPercent: number | null };
    thisMonth: { amount: number | null; deltaPercent: number | null };
    thisWeek: { amount: number | null; deltaPercent: number | null };
    today: { amount: number | null; deltaPercent: number | null };
  };
  currency: string;
}

const fmtMoney = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function formatAmount(amount: number | null): string {
  if (amount === null) return "—";
  return `${amount < 0 ? "-" : ""}${fmtMoney.format(Math.abs(amount))}`;
}

function formatDelta(deltaPercent: number | null): { text: string; tone: "up" | "down" | "muted" } {
  if (deltaPercent === null) return { text: "—", tone: "muted" };
  const sign = deltaPercent >= 0 ? "▲" : "▼";
  const tone: "up" | "down" | "muted" =
    deltaPercent > 0 ? "up" : deltaPercent < 0 ? "down" : "muted";
  return { text: `${sign} ${Math.abs(deltaPercent).toFixed(2)}%`, tone };
}

export function AccountHeader({ data }: { data: AccountHeaderData }) {
  const { connectedPlatform, kpis, currency } = data;

  const kpiList: Array<{
    label: string;
    amount: number | null;
    delta: number | null;
    primary?: boolean;
  }> = [
    { label: "Initial Balance", amount: kpis.initialBalance, delta: null, primary: false },
    {
      label: "Total Profit",
      amount: kpis.totalProfit.amount,
      delta: kpis.totalProfit.deltaPercent,
      primary: true,
    },
    {
      label: "This Month",
      amount: kpis.thisMonth.amount,
      delta: kpis.thisMonth.deltaPercent,
    },
    {
      label: "This Week",
      amount: kpis.thisWeek.amount,
      delta: kpis.thisWeek.deltaPercent,
    },
    { label: "Today", amount: kpis.today.amount, delta: kpis.today.deltaPercent },
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

      <div className="account-kpis">
        {kpiList.map((kpi) => {
          const delta = formatDelta(kpi.delta);
          return (
            <div className={`kpi ${kpi.primary ? "kpi-primary" : ""}`} key={kpi.label}>
              <span className="kpi-label">{kpi.label}</span>
              <strong className="kpi-amount">
                <span className="kpi-currency">{currency}</span>
                {formatAmount(kpi.amount)}
              </strong>
              <span className={`kpi-delta kpi-delta-${delta.tone}`}>{delta.text}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
