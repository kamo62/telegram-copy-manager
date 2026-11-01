import { Archive, Bot, ChevronDown, ChevronRight, Hand } from "lucide-react";
import { Fragment, useState } from "react";
import type { ClosedTradeRow } from "../App";
import { useLocale } from "../contexts/LocaleContext";
import { formatLot, formatNumber } from "../lib/format";
import { EmptyState } from "./EmptyState";
import { Money } from "./Money";

interface ClosedPositionsAccount {
  id: string;
  accountNumber: string;
  currency?: string;
  closedTrades?: ClosedTradeRow[];
  externalCloses?: ClosedTradeRow[];
}

interface ClosedPositionsTableProps {
  accounts: ClosedPositionsAccount[];
  /** When set, only this account's closed trades are shown. When null, all accounts aggregate. */
  focusedAccountId: string | null;
  currency?: string;
}

type FlatRow = ClosedTradeRow & { accountNumber: string; currency: string };

function legSourceLabel(source: string, legIndex?: number): string {
  if (source === "tp-hit") return legIndex !== undefined ? `TP${legIndex} hit` : "TP hit";
  if (source === "sl-hit") return "SL hit";
  if (source === "stop-out") return "Stop-out";
  if (source === "expert") return "Closed by EA";
  if (source === "manual-terminal") return "Closed manually";
  if (source === "manual-mobile") return "Closed (mobile)";
  if (source === "manual-web") return "Closed (web)";
  if (source === "manual") return "Manual close";
  if (source === "history") return "Broker history";
  return source;
}

function legSourceTone(source: string, pnl: number): "up" | "down" | "muted" {
  if (source === "stop-out") return "down";
  if (pnl > 0) return "up";
  if (pnl < 0) return "down";
  return "muted";
}

function resultTone(result: string): "up" | "down" | "muted" | "warn" {
  if (result === "WIN") return "up";
  if (result === "LOSS") return "down";
  if (result === "BE") return "muted";
  return "muted";
}

function netResultLabel(result: string): string {
  if (result === "WIN") return "Win";
  if (result === "LOSS") return "Loss";
  return "BE";
}

function formatClosedAt(iso: string, locale: string): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(locale, {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatClosedAtTimeOnly(iso: string, locale: string): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/**
 * The "Closed" sub-tab of History. Each row summarises a signal trade that
 * has fully wound down (parent), with an expandable child block showing the
 * per-leg close events (TP1 hit, TP2 hit, SL hit, etc) plus the original
 * `trade_***` identifier and entry context.
 */
export function ClosedPositionsTable({
  accounts,
  focusedAccountId,
  currency,
}: ClosedPositionsTableProps) {
  const { locale } = useLocale();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const aggregate = focusedAccountId === null;
  const scoped = aggregate ? accounts : accounts.filter((a) => a.id === focusedAccountId);

  const rows: FlatRow[] = scoped.flatMap((account) =>
    [...(account.closedTrades ?? []), ...(account.externalCloses ?? [])].map((trade) => ({
      ...trade,
      accountNumber: account.accountNumber,
      currency: account.currency ?? currency ?? "USD",
    })),
  );
  rows.sort((a, b) => (a.closedAt < b.closedAt ? 1 : -1));

  if (rows.length === 0) {
    return (
      <EmptyState
        body="When approved signals run to completion — TP hit, SL fired, or closed manually — the verdict and per-leg breakdown will land here."
        glyph={<Archive aria-hidden="true" size={28} />}
        title="No closed trades yet"
      />
    );
  }

  const currencies = new Set(rows.map((row) => row.currency));
  const canTotal = currencies.size <= 1;
  const totalRealized = canTotal ? rows.reduce((sum, row) => sum + row.realizedPnl, 0) : null;
  const totalCurrency = [...currencies][0] ?? currency;
  const wins = rows.filter((r) => r.realizedPnl > 0).length;
  const losses = rows.filter((r) => r.realizedPnl < 0).length;

  function toggle(tradeId: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(tradeId)) next.delete(tradeId);
      else next.add(tradeId);
      return next;
    });
  }

  const columnCount = aggregate ? 11 : 10;

  return (
    <div className="closed-positions">
      <header className="closed-positions-head">
        <div className="closed-positions-head-counts">
          <span className="closed-positions-head-total">
            {rows.length} closed trade{rows.length === 1 ? "" : "s"}
          </span>
          <span className="closed-positions-head-split">
            <span className="closed-positions-result-tag up">{wins} winning</span>
            <span className="closed-positions-result-tag down">{losses} losing</span>
          </span>
        </div>
        <div className="closed-positions-head-pnl">
          <span className="closed-positions-head-pnl-label">
            {canTotal ? "Realized P/L" : "Mixed currencies"}
          </span>
          {canTotal ? (
            <Money
              value={totalRealized}
              currency={totalCurrency}
              locale={locale}
              signTone
              className="closed-positions-head-pnl-value"
            />
          ) : (
            <strong className="closed-positions-head-pnl-value">Per account below</strong>
          )}
        </div>
      </header>

      <div className="data-table-wrap">
        <table className="data-table closed-positions-table">
          <thead>
            <tr>
              <th aria-label="Expand" scope="col" style={{ width: 32 }} />
              <th scope="col">Origin</th>
              <th scope="col">Ticket</th>
              {aggregate ? <th scope="col">Account</th> : null}
              <th scope="col">Symbol</th>
              <th scope="col">Side</th>
              <th className="num" scope="col">
                Open
              </th>
              <th className="num" scope="col">
                Close
              </th>
              <th scope="col">TP legs</th>
              <th className="num" scope="col">
                PnL
              </th>
              <th scope="col">Result</th>
              <th scope="col">Closed at</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const isOpen = expanded.has(row.tradeId);
              const closeReason = row.closeReason ?? row.result;
              const netResult =
                row.netResult ??
                (row.realizedPnl > 0 ? "WIN" : row.realizedPnl < 0 ? "LOSS" : "BE");
              return (
                <Fragment key={row.tradeId}>
                  <tr className={`closed-positions-row closed-positions-row-${row.origin}`}>
                    <td className="closed-positions-expand-cell">
                      <button
                        aria-expanded={isOpen}
                        aria-label={isOpen ? "Collapse trade detail" : "Expand trade detail"}
                        className="closed-positions-expand"
                        onClick={() => toggle(row.tradeId)}
                        type="button"
                      >
                        {isOpen ? (
                          <ChevronDown aria-hidden="true" size={14} />
                        ) : (
                          <ChevronRight aria-hidden="true" size={14} />
                        )}
                      </button>
                    </td>
                    <td>
                      <span className={`closed-positions-origin-tag ${row.origin}`}>
                        {row.origin === "ea" ? (
                          <>
                            <Bot aria-hidden="true" size={11} /> EA
                          </>
                        ) : (
                          <>
                            <Hand aria-hidden="true" size={11} /> Manual
                          </>
                        )}
                      </span>
                    </td>
                    <td>
                      <code className="closed-positions-ticket">#{row.ticket || "—"}</code>
                    </td>
                    {aggregate ? (
                      <td>
                        <span className="closed-positions-account">{row.accountNumber}</span>
                      </td>
                    ) : null}
                    <td>
                      <strong className="closed-positions-symbol">{row.symbol}</strong>
                    </td>
                    <td>
                      <span
                        className={`closed-positions-side ${row.direction === "BUY" ? "buy" : "sell"}`}
                      >
                        {row.direction}
                      </span>
                    </td>
                    <td className="num-cell">
                      {formatNumber(row.openPrice, { locale, maximumFractionDigits: 5 })}
                    </td>
                    <td className="num-cell">
                      {formatNumber(row.closePrice, { locale, maximumFractionDigits: 5 })}
                    </td>
                    <td>
                      <TpPills
                        legs={row.tpLegs}
                        hitCount={row.tpHitCount}
                        total={row.tpTotal}
                        slFired={closeReason === "SL hit" || closeReason === "Mixed"}
                      />
                    </td>
                    <td className="num-cell closed-positions-pnl">
                      <Money
                        value={row.realizedPnl}
                        currency={row.currency}
                        locale={locale}
                        signTone
                      />
                    </td>
                    <td>
                      <span
                        className={`closed-positions-result ${resultTone(netResult)}`}
                        title={`Close reason: ${closeReason}`}
                      >
                        {netResultLabel(netResult)}
                      </span>
                    </td>
                    <td className="closed-positions-time">
                      {formatClosedAt(row.closedAt, locale)}
                    </td>
                  </tr>
                  {isOpen ? (
                    <tr className="closed-positions-detail-row">
                      <td colSpan={columnCount + 1}>
                        <ClosedTradeDetail row={row} locale={locale} currency={row.currency} />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TpPills({
  legs,
  hitCount,
  total,
  slFired,
}: {
  legs: ClosedTradeRow["tpLegs"];
  hitCount: number;
  total: number;
  slFired: boolean;
}) {
  if (total === 0) {
    return <span className="closed-positions-tp-empty">—</span>;
  }
  return (
    <span
      aria-label={`${hitCount} of ${total} TPs hit`}
      className="closed-positions-tp-pills"
      role="img"
    >
      {legs.map((leg) => (
        <span
          aria-hidden="true"
          className={`closed-positions-tp-dot ${leg.hit ? "hit" : "miss"}`}
          key={leg.leg}
          title={
            leg.targetPrice !== undefined ? `TP${leg.leg} @ ${leg.targetPrice}` : `TP${leg.leg}`
          }
        />
      ))}
      <span className="closed-positions-tp-count">
        {hitCount}/{total}
        {slFired ? " SL" : null}
      </span>
    </span>
  );
}

function ClosedTradeDetail({
  row,
  locale,
  currency,
}: {
  row: FlatRow;
  locale: string;
  currency?: string;
}) {
  return (
    <div className="closed-positions-detail">
      <header className="closed-positions-detail-head">
        <strong className="closed-positions-detail-trade">trade_{row.shortId}</strong>
        <span className="closed-positions-detail-meta">
          {row.symbol} {row.direction} {formatLot(row.volume, locale)} · entry @{" "}
          {formatNumber(row.openPrice, { locale, maximumFractionDigits: 5 })}
        </span>
        <span className="closed-positions-detail-meta">
          Close reason: {row.closeReason ?? row.result}
        </span>
        <span className="closed-positions-detail-pnl">
          net <Money value={row.realizedPnl} currency={currency} locale={locale} signTone />
        </span>
      </header>
      <ul className="closed-positions-detail-legs">
        {row.legs.map((leg) => {
          const tone = legSourceTone(leg.source, leg.pnl);
          const label = legSourceLabel(leg.source, leg.legIndex);
          return (
            <li className="closed-positions-detail-leg" key={leg.id}>
              <span className="closed-positions-detail-leg-source">
                {leg.action === "PARTIAL_CLOSE" ? "Partial" : "Full"} close
              </span>
              {leg.targetPrice !== undefined ? (
                <span className="closed-positions-detail-leg-target">
                  → {formatNumber(leg.targetPrice, { locale, maximumFractionDigits: 5 })}
                </span>
              ) : null}
              <span className="closed-positions-detail-leg-vol">
                {formatLot(leg.volume, locale)} @{" "}
                {formatNumber(leg.price, { locale, maximumFractionDigits: 5 })}
              </span>
              <span className={`closed-positions-detail-leg-pnl ${tone}`}>
                <Money value={leg.pnl} currency={currency} locale={locale} signTone />
              </span>
              <span className={`closed-positions-detail-leg-tag ${tone}`}>{label}</span>
              <span className="closed-positions-detail-leg-time">
                {formatClosedAtTimeOnly(leg.closedAt, locale)}
              </span>
              {leg.positionTicket ? (
                <code className="closed-positions-detail-leg-ticket">#{leg.positionTicket}</code>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
