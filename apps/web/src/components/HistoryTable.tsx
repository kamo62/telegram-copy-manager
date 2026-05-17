import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Copy,
  Database,
  Hand,
  Octagon,
  Smartphone,
  StopCircle,
  Target,
  Globe as Web,
} from "lucide-react";
import type { ReactNode } from "react";
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
  legs: Array<{
    leg: number;
    targetPrice?: number;
    targetSource?: string;
    defaultDistance?: { value: number; unit: string };
    allocationPercent: number;
    status: string;
  }>;
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
  source?: string;
  pnlCurrency?: number;
  pnlPips?: number;
  createdAt: string;
}

/**
 * Maps the broker_orders.source field (driven by MT5 DEAL_REASON) to a
 * human-readable label + icon for the History trail. Tone is intentionally
 * NOT in here: a "SL hit" event might still close in profit if the operator
 * trailed SL into the green or hit TP1+TP2 before SL came back to break-even.
 * Likewise "Closed manually" can be a winner or a loser. Tone is computed
 * separately from the actual realized P/L on the deal — see {@link sourceTone}.
 */
function sourceMeta(source: string | undefined): { label: string; icon: ReactNode } {
  switch (source) {
    case "tp-hit":
      return { label: "TP hit", icon: <Target aria-hidden="true" size={12} /> };
    case "sl-hit":
      return { label: "SL hit", icon: <Octagon aria-hidden="true" size={12} /> };
    case "stop-out":
      return { label: "Stop-out", icon: <AlertTriangle aria-hidden="true" size={12} /> };
    case "expert":
      return { label: "Closed by EA", icon: <Bot aria-hidden="true" size={12} /> };
    case "manual-terminal":
      return { label: "Closed manually", icon: <Hand aria-hidden="true" size={12} /> };
    case "manual-mobile":
      return { label: "Closed (mobile)", icon: <Smartphone aria-hidden="true" size={12} /> };
    case "manual-web":
      return { label: "Closed (web)", icon: <Web aria-hidden="true" size={12} /> };
    case "manual":
      return { label: "Manual close (unattributed)", icon: <Hand aria-hidden="true" size={12} /> };
    case "signal":
      return { label: "Opened by signal", icon: <CheckCircle2 aria-hidden="true" size={12} /> };
    case "app-close":
      return { label: "App close", icon: <Bot aria-hidden="true" size={12} /> };
    case "app-trailing":
      return { label: "App trail", icon: <Bot aria-hidden="true" size={12} /> };
    case "app-modify":
      return { label: "App modify", icon: <Bot aria-hidden="true" size={12} /> };
    case "app-cancel":
      return { label: "App cancel", icon: <Bot aria-hidden="true" size={12} /> };
    case "app-command":
      return { label: "App command", icon: <Bot aria-hidden="true" size={12} /> };
    case "history":
      return { label: "Broker history", icon: <Database aria-hidden="true" size={12} /> };
    case "rollover":
      return { label: "Rollover", icon: <Database aria-hidden="true" size={12} /> };
    case "variation-margin":
      return { label: "Variation margin", icon: <StopCircle aria-hidden="true" size={12} /> };
    case "split":
      return { label: "Symbol split", icon: <Database aria-hidden="true" size={12} /> };
    default:
      return { label: source ?? "—", icon: <Database aria-hidden="true" size={12} /> };
  }
}

/**
 * Drive the pill color from the realised P/L of the deal, NOT from the event
 * type. A `sl-hit` after TP1+TP2 fills with SL trailed to break-even is a
 * winning trade overall — coloring it red would mislead the operator.
 *
 * Exceptions (always-red regardless of P/L): `stop-out` is a margin call —
 * even if some legs closed in profit, hitting margin is operationally bad.
 * Informational events (open, history, rollover, split) stay muted.
 */
function sourceTone(
  source: string | undefined,
  action: string,
  pnlCurrency: number | undefined | null,
): "good" | "warn" | "muted" | "down" {
  // Operationally bad regardless of leg-level P/L.
  if (source === "stop-out") return "down";
  // Informational / non-trading events.
  if (source === "rollover" || source === "variation-margin" || source === "split") return "muted";
  if (source === "signal" || source === "history") return "muted";
  if (source?.startsWith("app-") && action !== "FULL_CLOSE" && action !== "PARTIAL_CLOSE") {
    return "muted";
  }
  // Closes: realized P/L is authoritative. break-even (0) stays muted.
  const isClose = action === "FULL_CLOSE" || action === "PARTIAL_CLOSE";
  if (isClose && pnlCurrency !== undefined && pnlCurrency !== null) {
    if (pnlCurrency > 0) return "good";
    if (pnlCurrency < 0) return "down";
    return "muted";
  }
  // Closes without P/L yet (snapshot diff just noticed the ticket disappeared,
  // history sweep hasn't caught up) — flag as warn so the operator knows it
  // happened but P/L is pending reconciliation.
  if (isClose) return "warn";
  // Opens / modifies / non-close events default to muted.
  return "muted";
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
                            {leg.targetPrice !== undefined
                              ? formatNumber(leg.targetPrice, {
                                  locale,
                                  minimumFractionDigits: 2,
                                  maximumFractionDigits: 5,
                                })
                              : leg.defaultDistance
                                ? `Default ${formatNumber(leg.defaultDistance.value, { locale })} ${leg.defaultDistance.unit.toLowerCase()}`
                                : "Default"}
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
                        {brokerOrders.map((order) => {
                          const meta = sourceMeta(order.source);
                          const tone = sourceTone(order.source, order.action, order.pnlCurrency);
                          return (
                            <div className="broker-trail-item" key={order.id}>
                              <strong>{order.action}</strong>
                              <span
                                className={`broker-trail-source broker-trail-source-${tone}`}
                                title={
                                  order.pnlCurrency !== undefined && order.pnlCurrency !== null
                                    ? `${meta.label} · P/L ${order.pnlCurrency >= 0 ? "+" : ""}${order.pnlCurrency.toFixed(2)}`
                                    : meta.label
                                }
                              >
                                {meta.icon}
                                {meta.label}
                              </span>
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
                              {order.pnlCurrency !== undefined && order.pnlCurrency !== null ? (
                                <span
                                  className={`broker-trail-pnl ${order.pnlCurrency >= 0 ? "up" : "down"}`}
                                >
                                  {order.pnlCurrency >= 0 ? "+" : ""}
                                  {formatNumber(order.pnlCurrency, { locale })}
                                </span>
                              ) : null}
                              <small>{order.brokerComment || `retcode ${order.retcode}`}</small>
                            </div>
                          );
                        })}
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
