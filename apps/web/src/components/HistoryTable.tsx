import { Tag } from "./Tag";

export interface HistoryRowData {
  id: string;
  symbol: string;
  direction: string;
  status: string;
  executionMode: string;
  legs: Array<{ leg: number; targetPrice: number; allocationPercent: number; status: string }>;
}

const numFmt = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 5,
});

export function HistoryTable({ trades }: { trades: HistoryRowData[] }) {
  return (
    <div className="data-table-wrap">
      <table className="data-table history-table">
        <thead>
          <tr>
            <th scope="col">Trade</th>
            <th scope="col">Symbol</th>
            <th scope="col">Side</th>
            <th scope="col">Mode</th>
            <th scope="col">Status</th>
            <th className="num" scope="col">
              TPs
            </th>
            <th scope="col">TP progress</th>
          </tr>
        </thead>
        <tbody>
          {trades.length === 0 ? (
            <tr className="data-table-empty">
              <td colSpan={7}>No trades yet. Approved signals will appear here.</td>
            </tr>
          ) : null}
          {trades.map((trade) => {
            const hits = trade.legs.filter((leg) => leg.status === "HIT").length;
            const openLegs = trade.legs.filter(
              (leg) => leg.status === "OPEN" || leg.status === "PLANNED",
            ).length;
            const closed = trade.legs.filter((leg) => leg.status === "CLOSED").length;
            return (
              <tr key={trade.id}>
                <th className="data-table-row-head" scope="row">
                  <strong>{trade.id.slice(0, 10)}</strong>
                  <span className="data-table-subtle">
                    {trade.legs.length} TP legs · {hits} hit · {openLegs} open · {closed} closed
                  </span>
                </th>
                <td className="num-cell">{trade.symbol}</td>
                <td>
                  <span className={`history-side ${trade.direction === "BUY" ? "up" : "down"}`}>
                    {trade.direction}
                  </span>
                </td>
                <td className="history-mode">{trade.executionMode}</td>
                <td>
                  <Tag tone={trade.status === "OPEN" ? "good" : "muted"}>{trade.status}</Tag>
                </td>
                <td className="num-cell">{trade.legs.length}</td>
                <td>
                  <div className="tp-strip" aria-label="Take profit leg progress">
                    {trade.legs.map((leg) => {
                      const tone =
                        leg.status === "HIT"
                          ? "hit"
                          : leg.status === "OPEN"
                            ? "open"
                            : leg.status === "CLOSED"
                              ? "closed"
                              : "planned";
                      return (
                        <span className={`tp-chip tp-chip-${tone}`} key={leg.leg}>
                          <span className="tp-chip-label">TP{leg.leg}</span>
                          <span className="tp-chip-price">{numFmt.format(leg.targetPrice)}</span>
                          <span className="tp-chip-alloc">{leg.allocationPercent}%</span>
                        </span>
                      );
                    })}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
