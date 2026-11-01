import { Activity, Bot, Hand } from "lucide-react";
import { useState } from "react";
import type { ExternalBrokerPosition } from "../App";
import { useLocale } from "../contexts/LocaleContext";
import {
  externalTradeKey,
  readDismissedExternalTrades,
  writeDismissedExternalTrades,
} from "../lib/dismissedExternalTrades";
import { formatLot, formatNumber } from "../lib/format";
import { EmptyState } from "./EmptyState";
import { Money } from "./Money";

interface OpenPositionsAccount {
  id: string;
  accountNumber: string;
  currency?: string;
  appPositions?: ExternalBrokerPosition[];
  appOrders?: ExternalBrokerPosition[];
  externalPositions?: ExternalBrokerPosition[];
  externalOrders?: ExternalBrokerPosition[];
  symbols?: Array<{ symbol: string; bid?: number; ask?: number }>;
}

interface OpenPositionsTableProps {
  accounts: OpenPositionsAccount[];
  /** When set, only this account's positions are shown. When null, all accounts aggregate. */
  focusedAccountId: string | null;
  currency?: string;
}

type Origin = "ea" | "external";
type Side = "buy" | "sell";

interface PositionRow extends ExternalBrokerPosition {
  origin: Origin;
  accountId: string;
  accountNumber: string;
  currency: string;
  currentPrice: number | undefined;
}

function positionSide(positionType: number): Side {
  return positionType === 0 ? "buy" : "sell";
}

function pendingOrderSide(orderType: number): Side {
  // MT5 order enums use 0/1 for market orders, then alternate buy/sell for
  // pending variants: BUY_LIMIT=2, SELL_LIMIT=3, BUY_STOP=4, SELL_STOP=5.
  return orderType % 2 === 0 ? "buy" : "sell";
}

function sideLabel(side: Side): string {
  return side.toUpperCase();
}

function currentPriceFor(
  position: ExternalBrokerPosition,
  symbols: OpenPositionsAccount["symbols"],
): number | undefined {
  const match = symbols?.find((s) => s.symbol === position.symbol);
  if (!match) return undefined;
  // For a long position (type 0 = BUY), the closing price the operator would
  // get RIGHT NOW is the bid. For a short (type 1 = SELL), it's the ask.
  return position.type === 0 ? match.bid : match.ask;
}

function externalLabel(magic: number): string {
  if (magic === 0) return "Manual";
  return "External";
}

/**
 * Unified table of every position currently open on the focused account —
 * app-driven (EA-taken) and external (manual / mobile / other-EA) in one place.
 * Origin is conveyed by a left-edge stripe (cobalt = EA, amber = external).
 * Pending orders render in a slim secondary block.
 */
export function OpenPositionsTable({
  accounts,
  focusedAccountId,
  currency,
}: OpenPositionsTableProps) {
  const { locale } = useLocale();
  const [dismissed, setDismissed] = useState(readDismissedExternalTrades);
  const aggregate = focusedAccountId === null;
  const scoped = aggregate ? accounts : accounts.filter((a) => a.id === focusedAccountId);

  const positions: PositionRow[] = scoped.flatMap((account) => {
    const symbols = account.symbols;
    const ea = (account.appPositions ?? []).map<PositionRow>((p) => ({
      ...p,
      origin: "ea",
      accountId: account.id,
      accountNumber: account.accountNumber,
      currency: account.currency ?? currency ?? "USD",
      currentPrice: currentPriceFor(p, symbols),
    }));
    const ext = (account.externalPositions ?? [])
      .filter((p) => !dismissed.has(externalTradeKey(account.id, p.ticket)))
      .map<PositionRow>((p) => ({
        ...p,
        origin: "external",
        accountId: account.id,
        accountNumber: account.accountNumber,
        currency: account.currency ?? currency ?? "USD",
        currentPrice: currentPriceFor(p, symbols),
      }));
    return [...ea, ...ext];
  });

  const pendingOrders: PositionRow[] = scoped.flatMap((account) => {
    const symbols = account.symbols;
    const ea = (account.appOrders ?? []).map<PositionRow>((o) => ({
      ...o,
      origin: "ea",
      accountId: account.id,
      accountNumber: account.accountNumber,
      currency: account.currency ?? currency ?? "USD",
      currentPrice: currentPriceFor(o, symbols),
    }));
    const ext = (account.externalOrders ?? [])
      .filter((o) => !dismissed.has(externalTradeKey(account.id, o.ticket)))
      .map<PositionRow>((o) => ({
        ...o,
        origin: "external",
        accountId: account.id,
        accountNumber: account.accountNumber,
        currency: account.currency ?? currency ?? "USD",
        currentPrice: currentPriceFor(o, symbols),
      }));
    return [...ea, ...ext];
  });

  positions.sort((a, b) => a.symbol.localeCompare(b.symbol) || a.ticket.localeCompare(b.ticket));
  pendingOrders.sort(
    (a, b) => a.symbol.localeCompare(b.symbol) || a.ticket.localeCompare(b.ticket),
  );

  const dismiss = (row: PositionRow) => {
    const key = externalTradeKey(row.accountId, row.ticket);
    setDismissed((current) => {
      const next = new Set(current).add(key);
      writeDismissedExternalTrades(next);
      return next;
    });
  };
  const dismissedCount = [...dismissed].filter((key) =>
    scoped.some((account) => key.startsWith(`${account.id}:`)),
  ).length;

  if (positions.length === 0 && pendingOrders.length === 0) {
    return (
      <div className="open-positions">
        <EmptyState
          body="Approved signals will appear here while they're running. Manual MT5 trades on this account will show up alongside them, marked external."
          glyph={<Activity aria-hidden="true" size={28} />}
          title="No positions open right now"
        />
        {dismissedCount > 0 ? (
          <button
            className="btn btn-ghost btn-small dismissed-external-show"
            onClick={() => {
              setDismissed((current) => {
                const next = new Set(current);
                for (const key of next) {
                  if (scoped.some((account) => key.startsWith(`${account.id}:`))) next.delete(key);
                }
                writeDismissedExternalTrades(next);
                return next;
              });
            }}
            type="button"
          >
            Show {dismissedCount} dismissed trade{dismissedCount === 1 ? "" : "s"}
          </button>
        ) : null}
      </div>
    );
  }

  const currencies = new Set(positions.map((position) => position.currency));
  const canTotal = currencies.size <= 1;
  const totalFloating = canTotal
    ? positions.reduce((sum, position) => sum + (position.profit ?? 0), 0)
    : null;
  const totalCurrency = [...currencies][0] ?? currency;
  const eaCount = positions.filter((p) => p.origin === "ea").length;
  const externalCount = positions.filter((p) => p.origin === "external").length;

  return (
    <div className="open-positions">
      <header className="open-positions-head">
        <div className="open-positions-head-counts">
          <span className="open-positions-head-total">
            {positions.length} position{positions.length === 1 ? "" : "s"} open
          </span>
          <span className="open-positions-head-split">
            <span className="open-positions-origin-tag ea">
              <Bot aria-hidden="true" size={11} /> EA {eaCount}
            </span>
            <span className="open-positions-origin-tag external">
              <Hand aria-hidden="true" size={11} /> External {externalCount}
            </span>
            {pendingOrders.length > 0 ? (
              <span className="open-positions-pending-meta">· {pendingOrders.length} pending</span>
            ) : null}
          </span>
        </div>
        <div className="open-positions-head-pnl">
          <span className="open-positions-head-pnl-label">
            {canTotal ? "Floating P/L" : "Mixed currencies"}
          </span>
          {canTotal ? (
            <Money
              value={totalFloating}
              currency={totalCurrency}
              locale={locale}
              signTone
              className="open-positions-head-pnl-value"
            />
          ) : (
            <strong className="open-positions-head-pnl-value">Per account below</strong>
          )}
        </div>
      </header>

      {positions.length > 0 ? (
        <div className="data-table-wrap">
          <table className="data-table open-positions-table">
            <thead>
              <tr>
                <th scope="col">Origin</th>
                {aggregate ? <th scope="col">Account</th> : null}
                <th scope="col">Side</th>
                <th scope="col">Symbol</th>
                <th className="num" scope="col">
                  Volume
                </th>
                <th className="num" scope="col">
                  Open
                </th>
                <th className="num" scope="col">
                  Current
                </th>
                <th className="num" scope="col">
                  SL
                </th>
                <th className="num" scope="col">
                  TP
                </th>
                <th className="num" scope="col">
                  Floating P/L
                </th>
                <th scope="col">Ticket</th>
              </tr>
            </thead>
            <tbody>
              {positions.map((p) => (
                <PositionRowComponent
                  key={`${p.accountNumber}-${p.ticket}`}
                  onDismiss={p.origin === "external" ? dismiss : undefined}
                  position={p}
                  aggregate={aggregate}
                  locale={locale}
                  currency={p.currency}
                />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState
          body="Approved signals will appear here while they're running."
          glyph={<Activity aria-hidden="true" size={28} />}
          title="No positions open right now"
        />
      )}

      {pendingOrders.length > 0 ? (
        <section className="open-positions-pending">
          <h4 className="open-positions-pending-title">Pending orders ({pendingOrders.length})</h4>
          <div className="data-table-wrap">
            <table className="data-table open-positions-table">
              <thead>
                <tr>
                  <th scope="col">Origin</th>
                  {aggregate ? <th scope="col">Account</th> : null}
                  <th scope="col">Side</th>
                  <th scope="col">Symbol</th>
                  <th className="num" scope="col">
                    Volume
                  </th>
                  <th className="num" scope="col">
                    Trigger
                  </th>
                  <th className="num" scope="col">
                    SL
                  </th>
                  <th className="num" scope="col">
                    TP
                  </th>
                  <th scope="col">Ticket</th>
                </tr>
              </thead>
              <tbody>
                {pendingOrders.map((o) => (
                  <PendingOrderRow
                    key={`${o.accountNumber}-${o.ticket}`}
                    onDismiss={o.origin === "external" ? dismiss : undefined}
                    order={o}
                    aggregate={aggregate}
                    locale={locale}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
      {dismissedCount > 0 ? (
        <button
          className="btn btn-ghost btn-small dismissed-external-show"
          onClick={() => {
            setDismissed((current) => {
              const next = new Set(current);
              for (const key of next) {
                if (scoped.some((account) => key.startsWith(`${account.id}:`))) next.delete(key);
              }
              writeDismissedExternalTrades(next);
              return next;
            });
          }}
          type="button"
        >
          Show {dismissedCount} dismissed trade{dismissedCount === 1 ? "" : "s"}
        </button>
      ) : null}
    </div>
  );
}

function PositionRowComponent({
  position,
  aggregate,
  locale,
  currency,
  onDismiss,
}: {
  position: PositionRow;
  aggregate: boolean;
  locale: string;
  currency?: string;
  onDismiss?: (position: PositionRow) => void;
}) {
  const pnl = position.profit;
  const side = positionSide(position.type);
  return (
    <tr className={`open-positions-row open-positions-row-${position.origin}`}>
      <td>
        <span className={`open-positions-origin-tag ${position.origin}`}>
          {position.origin === "ea" ? (
            <>
              <Bot aria-hidden="true" size={11} /> EA
            </>
          ) : (
            <>
              <Hand aria-hidden="true" size={11} /> {externalLabel(position.magic)}
            </>
          )}
        </span>
      </td>
      {aggregate ? (
        <td>
          <span className="open-positions-account">{position.accountNumber}</span>
        </td>
      ) : null}
      <td>
        <span className={`open-positions-side ${side}`}>{sideLabel(side)}</span>
      </td>
      <td>
        <strong className="open-positions-symbol">{position.symbol}</strong>
      </td>
      <td className="num-cell">{formatLot(position.volume, locale)}</td>
      <td className="num-cell">
        {formatNumber(position.openPrice, { locale, maximumFractionDigits: 5 })}
      </td>
      <td className="num-cell">
        {position.currentPrice !== undefined
          ? formatNumber(position.currentPrice, { locale, maximumFractionDigits: 5 })
          : "—"}
      </td>
      <td className={position.sl > 0 ? "num-cell" : "num-cell muted"}>
        {position.sl > 0 ? formatNumber(position.sl, { locale, maximumFractionDigits: 5 }) : "—"}
      </td>
      <td className={position.tp > 0 ? "num-cell" : "num-cell muted"}>
        {position.tp > 0 ? formatNumber(position.tp, { locale, maximumFractionDigits: 5 }) : "—"}
      </td>
      <td className="num-cell open-positions-pnl">
        {pnl !== undefined ? (
          <Money value={pnl} currency={currency} locale={locale} signTone />
        ) : (
          "—"
        )}
      </td>
      <td>
        <code className="open-positions-ticket">#{position.ticket}</code>
        {onDismiss ? (
          <button
            aria-label={`Dismiss external trade ${position.ticket} from app view`}
            className="btn btn-ghost btn-small external-dismiss-button"
            onClick={() => onDismiss(position)}
            type="button"
          >
            Dismiss from app view
          </button>
        ) : null}
      </td>
    </tr>
  );
}

function PendingOrderRow({
  order,
  aggregate,
  locale,
  onDismiss,
}: {
  order: PositionRow;
  aggregate: boolean;
  locale: string;
  onDismiss?: (order: PositionRow) => void;
}) {
  const side = pendingOrderSide(order.type);
  return (
    <tr className={`open-positions-row open-positions-row-${order.origin}`}>
      <td>
        <span className={`open-positions-origin-tag ${order.origin}`}>
          {order.origin === "ea" ? (
            <>
              <Bot aria-hidden="true" size={11} /> EA
            </>
          ) : (
            <>
              <Hand aria-hidden="true" size={11} /> {externalLabel(order.magic)}
            </>
          )}
        </span>
      </td>
      {aggregate ? (
        <td>
          <span className="open-positions-account">{order.accountNumber}</span>
        </td>
      ) : null}
      <td>
        <span className={`open-positions-side ${side}`}>{sideLabel(side)}</span>
      </td>
      <td>
        <strong className="open-positions-symbol">{order.symbol}</strong>
      </td>
      <td className="num-cell">{formatLot(order.volume, locale)}</td>
      <td className="num-cell">
        {formatNumber(order.openPrice, { locale, maximumFractionDigits: 5 })}
      </td>
      <td className={order.sl > 0 ? "num-cell" : "num-cell muted"}>
        {order.sl > 0 ? formatNumber(order.sl, { locale, maximumFractionDigits: 5 }) : "—"}
      </td>
      <td className={order.tp > 0 ? "num-cell" : "num-cell muted"}>
        {order.tp > 0 ? formatNumber(order.tp, { locale, maximumFractionDigits: 5 }) : "—"}
      </td>
      <td>
        <code className="open-positions-ticket">#{order.ticket}</code>
        {onDismiss ? (
          <button
            aria-label={`Dismiss external trade ${order.ticket} from app view`}
            className="btn btn-ghost btn-small external-dismiss-button"
            onClick={() => onDismiss(order)}
            type="button"
          >
            Dismiss from app view
          </button>
        ) : null}
      </td>
    </tr>
  );
}
