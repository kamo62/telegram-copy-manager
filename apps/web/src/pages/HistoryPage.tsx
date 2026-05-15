import { type BrokerOrderRowData, HistoryTable } from "../components/HistoryTable";
import { Panel } from "../components/Panel";

export function HistoryPage({
  trades,
  brokerOrdersByTrade,
  onToggleBrokerOrders,
  loading = false,
}: {
  trades: Parameters<typeof HistoryTable>[0]["trades"];
  brokerOrdersByTrade: Record<string, BrokerOrderRowData[]>;
  onToggleBrokerOrders: (tradeId: string) => void;
  loading?: boolean;
}) {
  return (
    <Panel className="wide-panel" title="Trade Lifecycle">
      <HistoryTable
        brokerOrdersByTrade={brokerOrdersByTrade}
        loading={loading}
        onToggleBrokerOrders={onToggleBrokerOrders}
        trades={trades}
      />
    </Panel>
  );
}
