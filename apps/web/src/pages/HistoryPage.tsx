import type { ClosedTradeRow, ExternalBrokerPosition } from "../App";
import { ClosedPositionsTable } from "../components/ClosedPositionsTable";
import { useConfirm } from "../components/ConfirmDialog";
import { OpenPositionsTable } from "../components/OpenPositionsTable";
import { Panel } from "../components/Panel";
import type { TradeResolutionAction } from "../lib/api";

export type HistoryTab = "Open" | "Closed";

interface HistoryAccount {
  id: string;
  accountNumber: string;
  appPositions?: ExternalBrokerPosition[];
  appOrders?: ExternalBrokerPosition[];
  externalPositions?: ExternalBrokerPosition[];
  externalOrders?: ExternalBrokerPosition[];
  symbols?: Array<{ symbol: string; bid?: number; ask?: number }>;
  closedTrades?: ClosedTradeRow[];
}

interface OutOfSyncTrade {
  id: string;
  symbol: string;
  direction: string;
  status: string;
  outOfSyncReason?: string;
  matchedBrokerTickets?: string[];
}

export function HistoryPage({
  activeTab,
  onTabChange,
  accounts,
  focusedAccountId,
  currency,
  onExportJournal,
  trades = [],
  onResolveTrade,
}: {
  activeTab: HistoryTab;
  onTabChange: (tab: HistoryTab) => void;
  accounts: HistoryAccount[];
  focusedAccountId: string | null;
  currency?: string;
  onExportJournal?: () => void;
  trades?: OutOfSyncTrade[];
  onResolveTrade?: (tradeId: string, action: TradeResolutionAction) => Promise<void> | void;
}) {
  const outOfSyncTrades = trades.filter((trade) => trade.status === "OUT_OF_SYNC");
  return (
    <Panel
      actions={
        activeTab === "Closed" && onExportJournal ? (
          <button className="btn btn-ghost btn-small" onClick={onExportJournal} type="button">
            Export journal (JSON)
          </button>
        ) : null
      }
      activeTab={activeTab}
      className="wide-panel"
      onTabChange={(tab) => onTabChange(tab as HistoryTab)}
      tabs={["Open", "Closed"]}
      title="Trade history"
    >
      {activeTab === "Open" ? (
        <>
          {outOfSyncTrades.length > 0 && onResolveTrade ? (
            <OutOfSyncTradesTable onResolve={onResolveTrade} trades={outOfSyncTrades} />
          ) : null}
          <OpenPositionsTable
            accounts={accounts}
            focusedAccountId={focusedAccountId}
            currency={currency}
          />
        </>
      ) : (
        <ClosedPositionsTable
          accounts={accounts}
          focusedAccountId={focusedAccountId}
          currency={currency}
        />
      )}
    </Panel>
  );
}

const resolutionLabels: Record<TradeResolutionAction, string> = {
  close_from_history: "Close from broker history",
  readopt: "Re-adopt broker position",
  archive: "Archive trade",
};

function OutOfSyncTradesTable({
  trades,
  onResolve,
}: {
  trades: OutOfSyncTrade[];
  onResolve: (tradeId: string, action: TradeResolutionAction) => Promise<void> | void;
}) {
  const { confirm, dialog } = useConfirm();

  async function resolve(trade: OutOfSyncTrade, action: TradeResolutionAction) {
    const confirmed = await confirm({
      title: `${resolutionLabels[action]}?`,
      description: `${trade.direction} ${trade.symbol}: ${trade.outOfSyncReason ?? "broker and app state differ"}.`,
      confirmLabel: resolutionLabels[action],
      destructive: action === "archive",
    });
    if (confirmed) await onResolve(trade.id, action);
  }

  return (
    <section className="out-of-sync-resolution" aria-label="Out-of-sync trade resolution">
      <header>
        <strong>Out-of-sync trades</strong>
        <span>Resolve broker/app drift before further lifecycle commands are sent.</span>
      </header>
      <div className="data-table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">Trade</th>
              <th scope="col">Side</th>
              <th scope="col">Reason</th>
              <th scope="col">Candidate ticket</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {trades.map((trade) => {
              const candidateTicket = trade.matchedBrokerTickets?.[0];
              return (
                <tr key={trade.id}>
                  <td>
                    <strong>{trade.symbol}</strong>
                  </td>
                  <td>{trade.direction}</td>
                  <td>{trade.outOfSyncReason ?? "Broker and app state differ"}</td>
                  <td>
                    <code>{candidateTicket ?? "—"}</code>
                  </td>
                  <td>
                    <details className="resolve-menu">
                      <summary className="btn btn-ghost btn-small">Resolve</summary>
                      <div className="resolve-menu-popover">
                        <button
                          onClick={() => void resolve(trade, "close_from_history")}
                          type="button"
                        >
                          Close from history
                        </button>
                        <button
                          disabled={!candidateTicket}
                          onClick={() => void resolve(trade, "readopt")}
                          title={candidateTicket ? undefined : "No candidate broker ticket found"}
                          type="button"
                        >
                          Re-adopt position
                        </button>
                        <button onClick={() => void resolve(trade, "archive")} type="button">
                          Archive
                        </button>
                      </div>
                    </details>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {dialog}
    </section>
  );
}
