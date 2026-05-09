import { Tag } from "./Tag";

export function TradeCard({
  trade,
}: {
  trade: {
    id: string;
    symbol: string;
    direction: string;
    status: string;
    executionMode: string;
    legs: Array<{ leg: number; targetPrice: number; allocationPercent: number; status: string }>;
  };
}) {
  return (
    <article className="trade-card" key={trade.id}>
      <div className="trade-head">
        <div>
          <strong>
            {trade.direction} {trade.symbol}
          </strong>
          <span>{trade.executionMode}</span>
        </div>
        <Tag tone="good">{trade.status}</Tag>
      </div>
      <div className="tp-grid">
        {trade.legs.map((leg) => (
          <div className="tp-leg" key={leg.leg}>
            <span>TP{leg.leg}</span>
            <strong>{leg.targetPrice}</strong>
            <small>
              {leg.allocationPercent}% · {leg.status}
            </small>
          </div>
        ))}
      </div>
    </article>
  );
}
