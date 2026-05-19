import { GrowthChart, type GrowthSeries } from "../components/GrowthChart";
import { useLocale } from "../contexts/LocaleContext";
import { formatLot, formatNumber } from "../lib/format";

export function PerformancePage({
  accounts = [],
  data,
  loading = false,
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
}) {
  return (
    <div aria-labelledby="tab-performance" id="tabpanel-performance" role="tabpanel">
      <GrowthChart data={data} loading={loading} />
      <ExternalActivityPanel accounts={accounts} />
    </div>
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
