import { ChevronRight } from "lucide-react";
import { useLocale } from "../contexts/LocaleContext";
import { formatMoney, formatNumber } from "../lib/format";
import { Donut, DonutLegend, type DonutSlice } from "./Donut";

interface AccountsOverviewProps {
  accounts: Array<{
    id: string;
    accountNumber: string;
    server: string;
    marginMode: string;
    heartbeatStatus: string;
    eaVersion?: string;
    openPositionCount?: number;
    pendingOrderCount?: number;
    equity?: number;
    currency?: string;
  }>;
  onSelectAccount: (id: string) => void;
}

const SLICE_PATTERNS = [0, 1, 2, 3, 4, 5];

export function AccountsOverview({ accounts, onSelectAccount }: AccountsOverviewProps) {
  const { locale } = useLocale();
  const onlineCount = accounts.filter((a) => a.heartbeatStatus === "online").length;
  const totalPositions = accounts.reduce((acc, a) => acc + (a.openPositionCount ?? 0), 0);
  const totalPending = accounts.reduce((acc, a) => acc + (a.pendingOrderCount ?? 0), 0);

  const equitySlices: DonutSlice[] = accounts
    .filter((account) => (account.equity ?? 0) > 0)
    .map((account, index) => ({
      id: account.id,
      label: account.accountNumber || account.id,
      value: account.equity ?? 0,
      pattern: SLICE_PATTERNS[index % SLICE_PATTERNS.length] ?? 0,
    }));
  const equityCurrencies = new Set(
    accounts
      .filter((account) => (account.equity ?? 0) > 0)
      .map((account) => account.currency?.trim().toUpperCase() || "USD"),
  );
  const singleCurrency = equityCurrencies.size === 1;
  const totalEquity = singleCurrency
    ? equitySlices.reduce((sum, slice) => sum + slice.value, 0)
    : null;
  // Equity shares only make sense when every slice uses the same unit. Mixed-currency
  // accounts stay in their native units until a reporting-currency conversion is supplied.
  const showEquityDonut = equitySlices.length >= 2 && singleCurrency;
  const donutCurrency = [...equityCurrencies][0] ?? "USD";

  return (
    <section className="accounts-overview" aria-label="All accounts overview">
      <header className="accounts-overview-head">
        <div>
          <span className="accounts-overview-eyebrow">All accounts</span>
          <h3 className="accounts-overview-title">Account fleet</h3>
          {!singleCurrency ? (
            <span className="accounts-overview-currency-note">Native currencies</span>
          ) : null}
        </div>
        <div className="accounts-overview-stats">
          <div>
            <span>Connected</span>
            <strong>
              {formatNumber(onlineCount, {
                locale,
                minimumFractionDigits: 0,
                maximumFractionDigits: 0,
              })}
              <span className="accounts-overview-stats-divider"> / </span>
              {formatNumber(accounts.length, {
                locale,
                minimumFractionDigits: 0,
                maximumFractionDigits: 0,
              })}
            </strong>
          </div>
          <div>
            <span>Open positions</span>
            <strong>
              {formatNumber(totalPositions, {
                locale,
                minimumFractionDigits: 0,
                maximumFractionDigits: 0,
              })}
            </strong>
          </div>
          <div>
            <span>Pending orders</span>
            <strong>
              {formatNumber(totalPending, {
                locale,
                minimumFractionDigits: 0,
                maximumFractionDigits: 0,
              })}
            </strong>
          </div>
        </div>
      </header>

      {showEquityDonut ? (
        <figure className="accounts-overview-donut">
          <figcaption className="visually-hidden">Equity by account</figcaption>
          <Donut
            ariaLabel="Equity by account"
            centerLabel="Total"
            centerValue={formatMoney(totalEquity ?? 0, donutCurrency, locale)}
            size={120}
            slices={equitySlices}
            thickness={16}
          />
          <DonutLegend
            renderValue={(slice) => formatMoney(slice.value, donutCurrency, locale)}
            slices={equitySlices}
          />
        </figure>
      ) : null}

      <ul className="accounts-overview-list">
        {accounts.map((account) => {
          const online = account.heartbeatStatus === "online";
          return (
            <li key={account.id}>
              <button
                aria-label={`Open ${account.accountNumber || account.id}`}
                className="accounts-overview-row"
                onClick={() => onSelectAccount(account.id)}
                type="button"
              >
                <span
                  aria-hidden="true"
                  className={`accounts-overview-dot ${online ? "ok" : "off"}`}
                />
                <div className="accounts-overview-row-body">
                  <strong>{account.accountNumber || account.id}</strong>
                  <span className="accounts-overview-row-meta">
                    {account.server} · {account.marginMode} · EA{" "}
                    {account.eaVersion ?? "legacy/unknown"}
                  </span>
                </div>
                <div className="accounts-overview-row-stats">
                  <span className="accounts-overview-row-equity">
                    <strong>
                      {account.equity == null
                        ? "—"
                        : formatMoney(account.equity, account.currency ?? "USD", locale)}
                    </strong>
                    equity
                  </span>
                  <span>
                    <strong>{account.openPositionCount ?? 0}</strong> pos
                  </span>
                  <span>
                    <strong>{account.pendingOrderCount ?? 0}</strong> pending
                  </span>
                </div>
                <span className={`accounts-overview-status ${online ? "ok" : "off"}`}>
                  {account.heartbeatStatus}
                </span>
                <ChevronRight aria-hidden="true" size={14} />
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
