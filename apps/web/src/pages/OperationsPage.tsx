import { ArrowRight, Radio, ShieldAlert } from "lucide-react";
import type { DashboardSnapshot, ExternalBrokerPosition } from "../App";
import { EmptyState } from "../components/EmptyState";
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

function stageState(status: string, reviewRequired: boolean) {
  if (reviewRequired || status === "HELD") return 1;
  if (status === "IGNORED") return 1;
  if (status === "APPROVED") return 3;
  if (status === "EXECUTED") return 5;
  return 2;
}

export function OperationsPage({
  snapshot,
  focusedAccountId,
  onSelectAccount,
  onReviewSignals,
  onOpenPositions,
  onOpenProviders,
}: {
  snapshot: DashboardSnapshot;
  focusedAccountId: string | null;
  onSelectAccount: (accountId: string) => void;
  onReviewSignals: () => void;
  onOpenPositions: () => void;
  onOpenProviders: () => void;
}) {
  const { locale } = useLocale();
  const accounts = focusedAccountId
    ? snapshot.mt5Accounts.filter((account) => account.id === focusedAccountId)
    : snapshot.mt5Accounts;
  const signalRows = snapshot.parserResults.slice(0, 5);
  const blockedSignal = signalRows.find(
    (signal) => signal.reviewRequired || signal.status === "HELD",
  );
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
      {blockedSignal ? (
        <section className="operations-blocker" role="alert">
          <ShieldAlert aria-hidden="true" size={18} />
          <div>
            <span>Signal stopped before execution</span>
            <strong>
              {blockedSignal.providerTitle || "Unknown provider"} · {blockedSignal.rawText}
            </strong>
            <small>{blockedSignal.heldReason || "Operator review is required."}</small>
          </div>
          <button className="btn btn-primary btn-small" onClick={onReviewSignals} type="button">
            Review and fix
          </button>
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
                  {account.accountNumber || account.id}
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
                  <dd className={(performance?.today ?? 0) < 0 ? "down" : "up"}>
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
        <section className="operations-ledger">
          <header className="operations-section-head">
            <div>
              <span>Signal flow</span>
              <h3>Signal ledger</h3>
            </div>
            <div className="operations-stage-labels" aria-hidden="true">
              <span>Parse</span>
              <span>Route</span>
              <span>Queue</span>
              <span>Send</span>
              <span>Fill</span>
            </div>
          </header>
          {signalRows.length === 0 ? (
            <EmptyState
              body="New Telegram messages will appear here as they move toward a broker."
              glyph={<Radio aria-hidden="true" size={26} />}
              title="No recent signals"
            />
          ) : (
            <div className="operations-ledger-list">
              {signalRows.map((signal) => {
                const reached = stageState(signal.status ?? "", signal.reviewRequired);
                const blocked = signal.reviewRequired || signal.status === "HELD";
                return (
                  <article className={blocked ? "needs-review" : ""} key={signal.id}>
                    <div className="operations-ledger-copy">
                      <span>{signal.providerTitle || "Unknown provider"}</span>
                      <strong>
                        {signal.rawText || `${signal.commandType} ${signal.canonicalSymbol}`}
                      </strong>
                      <small>
                        {signal.commandType} ·{" "}
                        {signal.brokerSymbol || signal.canonicalSymbol || "unmapped"}
                        {signal.heldReason ? ` · ${signal.heldReason}` : ""}
                      </small>
                    </div>
                    <div
                      className="operations-stage-track"
                      aria-label={`Reached stage ${reached} of 5`}
                      role="img"
                    >
                      {[1, 2, 3, 4, 5].map((stage) => (
                        <span
                          className={stage < reached ? "done" : stage === reached ? "current" : ""}
                          key={stage}
                        />
                      ))}
                    </div>
                    {blocked ? (
                      <button
                        className="btn btn-ghost btn-small"
                        onClick={onReviewSignals}
                        type="button"
                      >
                        Review
                      </button>
                    ) : null}
                  </article>
                );
              })}
            </div>
          )}
          <footer>
            <button className="btn btn-ghost btn-small" onClick={onReviewSignals} type="button">
              Open signal review
            </button>
          </footer>
        </section>

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
