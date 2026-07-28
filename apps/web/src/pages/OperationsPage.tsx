import { ArrowRight, ShieldAlert } from "lucide-react";
import type { DashboardSnapshot, ExternalBrokerPosition } from "../App";
import { EmptyState } from "../components/EmptyState";
import { numericSignTone } from "../components/Money";
import { useLocale } from "../contexts/LocaleContext";
import { formatMoney, formatNumber } from "../lib/format";

function orderSide(type: number) {
  if (type === 2) return "buy limit";
  if (type === 3) return "sell limit";
  if (type === 4) return "buy stop";
  if (type === 5) return "sell stop";
  if (type === 6) return "buy stop limit";
  if (type === 7) return "sell stop limit";
  return type === 0 ? "buy" : "sell";
}

export function signalRequiresReview(signal: DashboardSnapshot["parserResults"][number]) {
  return (
    signal.status === "HELD" ||
    ((!signal.status || signal.status === "PARSED") && signal.reviewRequired)
  );
}

export function OperationsPage({
  snapshot,
  focusedAccountId,
  onSelectAccount,
  onReviewSignals,
  onOpenPositions,
  onOpenProviders,
  signalReviewCount,
  alertCount,
}: {
  snapshot: DashboardSnapshot;
  focusedAccountId: string | null;
  onSelectAccount: (accountId: string) => void;
  onReviewSignals: () => void;
  onOpenPositions: () => void;
  onOpenProviders: () => void;
  signalReviewCount: number;
  alertCount: number;
}) {
  const { locale } = useLocale();
  const accounts = focusedAccountId
    ? snapshot.mt5Accounts.filter((account) => account.id === focusedAccountId)
    : snapshot.mt5Accounts;
  const attentionCount = signalReviewCount + alertCount;
  const workingOrders = accounts.flatMap((account) =>
    [
      ...((account.appOrders ?? []).map((order) => ({ order, account, owned: true })) as Array<{
        order: ExternalBrokerPosition;
        account: (typeof accounts)[number];
        owned: boolean;
      }>),
      ...((account.externalOrders ?? []).map((order) => ({
        order,
        account,
        owned: false,
      })) as Array<{
        order: ExternalBrokerPosition;
        account: (typeof accounts)[number];
        owned: boolean;
      }>),
    ].slice(0, 8),
  );

  return (
    <div className="operations-page">
      {attentionCount > 0 ? (
        <section
          aria-label="Attention summary"
          className="operations-blocker operations-attention-summary"
          role="status"
        >
          <ShieldAlert aria-hidden="true" className="operations-blocker-icon" size={18} />
          <div>
            <span>Attention required</span>
            <strong>
              {attentionCount} {attentionCount === 1 ? "item needs" : "items need"} attention
            </strong>
            <small>
              {signalReviewCount} {signalReviewCount === 1 ? "signal" : "signals"} · {alertCount}{" "}
              {alertCount === 1 ? "alert" : "alerts"}
            </small>
          </div>
          {signalReviewCount > 0 ? (
            <button className="btn btn-primary btn-small" onClick={onReviewSignals} type="button">
              Open review queue
            </button>
          ) : null}
        </section>
      ) : null}

      <section className="operations-account-grid" aria-label="Account operating state">
        {accounts.map((account) => {
          const performance = snapshot.accountPerformanceByAccount?.[account.id];
          const currency = account.currency ?? performance?.currency ?? "USD";
          const online = account.heartbeatStatus === "online";
          const guardian = snapshot.equityGuardians?.find((item) => item.accountId === account.id);
          return (
            <article
              className={`operations-account ${online ? "online" : "offline"}`}
              key={account.id}
            >
              <header>
                <button onClick={() => onSelectAccount(account.id)} type="button">
                  {account.nickname || account.accountNumber || account.id}
                  <ArrowRight aria-hidden="true" size={14} />
                </button>
                <span className={`operations-state ${online ? "online" : "offline"}`}>
                  <span aria-hidden="true" />
                  {online ? "Live" : account.heartbeatStatus || "Offline"}
                </span>
                <span className="operations-broker">
                  {account.server.split("-")[0] || account.server} · {currency}
                </span>
              </header>
              <dl className="operations-account-metrics">
                <div>
                  <dt>Balance</dt>
                  <dd>{formatMoney(account.balance ?? null, currency, locale)}</dd>
                </div>
                <div>
                  <dt>Equity</dt>
                  <dd>{formatMoney(account.equity ?? null, currency, locale)}</dd>
                </div>
                <div>
                  <dt>Open</dt>
                  <dd>{formatNumber(account.openPositionCount ?? 0, { locale })}</dd>
                </div>
                <div>
                  <dt>Today</dt>
                  <dd className={numericSignTone(performance?.today ?? null) ?? undefined}>
                    {formatMoney(performance?.today ?? null, currency, locale)}
                  </dd>
                </div>
              </dl>
              {!online ? (
                <div className="operations-account-issue">
                  <strong>Account telemetry is stale</strong>
                  <span>
                    Figures are the last known broker values; new entries should remain held.
                  </span>
                </div>
              ) : guardian?.paused ? (
                <div className="operations-account-issue danger">
                  <strong>Equity Guardian paused new entries</strong>
                  <span>Lifecycle commands for existing trades continue.</span>
                </div>
              ) : null}
            </article>
          );
        })}
      </section>

      <div className="operations-primary-grid">
        <section className="operations-orders">
          <header className="operations-section-head">
            <div>
              <span>Broker state</span>
              <h3>Working orders</h3>
            </div>
            <strong>{workingOrders.length}</strong>
          </header>
          {workingOrders.length === 0 ? (
            <EmptyState
              body="Pending broker orders will remain visible here until filled or cancelled."
              glyph={<ShieldAlert aria-hidden="true" size={25} />}
              title="No working orders"
            />
          ) : (
            <div className="operations-orders-table-wrap">
              <table className="operations-orders-table">
                <thead>
                  <tr>
                    <th>Instrument</th>
                    <th>Entry</th>
                    <th>SL</th>
                    <th>TP</th>
                  </tr>
                </thead>
                <tbody>
                  {workingOrders.map(({ order, account, owned }) => (
                    <tr key={`${account.id}-${order.ticket}`}>
                      <td>
                        <strong>{order.symbol}</strong>
                        <span>
                          {orderSide(order.type)} · {account.accountNumber} ·{" "}
                          {owned ? "EA" : "external"}
                        </span>
                      </td>
                      <td>{order.openPrice || "—"}</td>
                      <td className={order.sl ? "" : "missing"}>{order.sl || "Missing"}</td>
                      <td>{order.tp || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <footer>
            <button className="btn btn-ghost btn-small" onClick={onOpenPositions} type="button">
              Open positions & orders
            </button>
          </footer>
        </section>
      </div>

      <section className="operations-provider-strip">
        <header className="operations-section-head">
          <div>
            <span>Copy network</span>
            <h3>Providers</h3>
          </div>
          <button className="btn btn-ghost btn-small" onClick={onOpenProviders} type="button">
            Manage providers
          </button>
        </header>
        <div>
          {snapshot.providers.slice(0, 6).map((provider) => {
            const accountCount = (snapshot.accountProviderLinks ?? []).filter(
              (link) => link.providerId === provider.id && link.enabled,
            ).length;
            const performance = snapshot.providerPerformance?.find(
              (item) => item.id === provider.id,
            );
            return (
              <article key={provider.id}>
                <span className={provider.enabled ? "online" : "offline"} aria-hidden="true" />
                <strong>{provider.title}</strong>
                <small>
                  {accountCount} account{accountCount === 1 ? "" : "s"}
                </small>
                <b>{performance ? `${(performance.winRate * 100).toFixed(0)}%` : "—"}</b>
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}
