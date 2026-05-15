import { Copy } from "lucide-react";
import { useLocale } from "../contexts/LocaleContext";
import { formatLot, formatNumber } from "../lib/format";
import { SkeletonRow } from "./Skeleton";
import { Tag } from "./Tag";

function copyTicket(value: string) {
  if (!value || typeof navigator === "undefined" || !navigator.clipboard) return;
  void navigator.clipboard.writeText(value);
}

export interface HistoryRowData {
  id: string;
  symbol: string;
  direction: string;
  status: string;
  executionMode: string;
  legs: Array<{ leg: number; targetPrice: number; allocationPercent: number; status: string }>;
}

export interface BrokerOrderRowData {
  id: string;
  legId: string;
  action: string;
  orderTicket: string;
  positionTicket: string;
  dealTicket: string;
  filledVolume?: number;
  filledPrice?: number;
  retcode: number;
  brokerComment: string;
  createdAt: string;
}

export function HistoryTable({
  trades,
  brokerOrdersByTrade = {},
  onToggleBrokerOrders,
  loading = false,
}: {
  trades: HistoryRowData[];
  brokerOrdersByTrade?: Record<string, BrokerOrderRowData[]>;
  onToggleBrokerOrders?: (tradeId: string) => void;
  loading?: boolean;
}) {
  const { locale } = useLocale();
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
          {loading && trades.length === 0
            ? Array.from({ length: 6 }, (_, index) => (
                <SkeletonRow columns={7} key={`history-skeleton-${index}`} />
              ))
            : null}
          {!loading && trades.length === 0 ? (
            <tr className="data-table-empty">
              <td colSpan={7}>No trades yet. Approved signals will appear here.</td>
            </tr>
          ) : null}
          {trades.flatMap((trade) => {
            const hits = trade.legs.filter((leg) => leg.status === "HIT").length;
            const openLegs = trade.legs.filter(
              (leg) => leg.status === "OPEN" || leg.status === "PLANNED",
            ).length;
            const closed = trade.legs.filter((leg) => leg.status === "CLOSED").length;
            const brokerOrders = brokerOrdersByTrade[trade.id];
            return [
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
                  <fieldset className="tp-strip" aria-label="Take profit leg progress">
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
                          <span className="tp-chip-price">
                            {formatNumber(leg.targetPrice, {
                              locale,
                              minimumFractionDigits: 2,
                              maximumFractionDigits: 5,
                            })}
                          </span>
                          <span className="tp-chip-alloc">{leg.allocationPercent}%</span>
                        </span>
                      );
                    })}
                  </fieldset>
                  {onToggleBrokerOrders ? (
                    <button
                      className="btn btn-ghost btn-small"
                      onClick={() => onToggleBrokerOrders(trade.id)}
                      type="button"
                    >
                      {brokerOrders ? "Hide broker trail" : "Broker trail"}
                    </button>
                  ) : null}
                </td>
              </tr>,
              brokerOrders ? (
                <tr className="broker-trail-row" key={`${trade.id}-broker-trail`}>
                  <td colSpan={7}>
                    {brokerOrders.length === 0 ? (
                      <span className="data-table-subtle">No broker order reports yet.</span>
                    ) : (
                      <div className="broker-trail-list">
                        {brokerOrders.map((order) => (
                          <div className="broker-trail-item" key={order.id}>
                            <strong>{order.action}</strong>
                            <span>{order.legId}</span>
                            {(["orderTicket", "positionTicket", "dealTicket"] as const).map(
                              (field) => {
                                const value = order[field];
                                const label =
                                  field === "orderTicket"
                                    ? "order"
                                    : field === "positionTicket"
                                      ? "position"
                                      : "deal";
                                return (
                                  <button
                                    aria-label={`Copy ${label} ticket ${value || "(empty)"}`}
                                    className="ticket-chip"
                                    disabled={!value}
                                    key={field}
                                    onClick={() => copyTicket(String(value))}
                                    title={value ? `Copy ${label} ticket` : ""}
                                    type="button"
                                  >
                                    <code>
                                      {label} {value || "—"}
                                    </code>
                                    {value ? <Copy aria-hidden="true" size={11} /> : null}
                                  </button>
                                );
                              },
                            )}
                            <span>
                              {formatLot(order.filledVolume ?? null)} @{" "}
                              {formatNumber(order.filledPrice ?? null, {
                                locale,
                                minimumFractionDigits: 2,
                                maximumFractionDigits: 5,
                              })}
                            </span>
                            <small>{order.brokerComment || `retcode ${order.retcode}`}</small>
                          </div>
                        ))}
                      </div>
                    )}
                  </td>
                </tr>
              ) : null,
            ];
          })}
        </tbody>
      </table>
    </div>
  );
}
