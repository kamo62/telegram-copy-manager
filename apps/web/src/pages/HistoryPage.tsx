import type { ClosedTradeRow, ExternalBrokerPosition } from "../App";
import { ClosedPositionsTable } from "../components/ClosedPositionsTable";
import { OpenPositionsTable } from "../components/OpenPositionsTable";
import { Panel } from "../components/Panel";

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

export function HistoryPage({
  activeTab,
  onTabChange,
  accounts,
  focusedAccountId,
  currency,
}: {
  activeTab: HistoryTab;
  onTabChange: (tab: HistoryTab) => void;
  accounts: HistoryAccount[];
  focusedAccountId: string | null;
  currency?: string;
}) {
  return (
    <Panel
      activeTab={activeTab}
      className="wide-panel"
      onTabChange={(tab) => onTabChange(tab as HistoryTab)}
      tabs={["Open", "Closed"]}
      title="Trade history"
    >
      {activeTab === "Open" ? (
        <OpenPositionsTable
          accounts={accounts}
          focusedAccountId={focusedAccountId}
          currency={currency}
        />
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
