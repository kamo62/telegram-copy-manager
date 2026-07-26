import { Clock3, RotateCcw, Trash2 } from "lucide-react";
import { useState } from "react";
import { useLocale } from "../contexts/LocaleContext";
import { useSortableTable } from "../hooks/useSortableTable";
import type { HeldQueueItem, HeldRequeueMode } from "../lib/api";
import { formatNumber, formatPercent } from "../lib/format";
import { useConfirm } from "./ConfirmDialog";
import { EmptyState } from "./EmptyState";
import { Tag } from "./Tag";

function reasonLabel(reason: string): string {
  return reason.replaceAll("_", " ");
}

function ageLabel(createdAt: string): string {
  const ageMs = Date.now() - Date.parse(createdAt);
  if (!Number.isFinite(ageMs) || ageMs < 0) return "just now";
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function confirmationDescription(item: HeldQueueItem, action: string) {
  const warning =
    item.droppedLifecycleCount > 0
      ? ` Warning: ${item.droppedLifecycleCount} lifecycle command${item.droppedLifecycleCount === 1 ? "" : "s"} arrived while held (${item.droppedLifecycle.join(", ")}). They will not be replayed automatically.`
      : "";
  return `${action} ${item.commandType} for ${item.symbol}?${warning}`;
}

export function HeldSignalsTable({
  items,
  accountLabel,
  providerLabel,
  onRequeue,
  onDismiss,
}: {
  items: HeldQueueItem[];
  accountLabel: (accountId: string) => string;
  providerLabel: (providerId: string) => string;
  onRequeue: (
    item: HeldQueueItem,
    mode: HeldRequeueMode,
    logicalTradeId?: string,
  ) => Promise<void> | void;
  onDismiss: (item: HeldQueueItem) => Promise<void> | void;
}) {
  const { locale } = useLocale();
  const { confirm, dialog } = useConfirm();
  const [selectedTradeIds, setSelectedTradeIds] = useState<Record<string, string>>({});
  const { sortedRows, toggle, sortAria } = useSortableTable(items, "createdAt", "asc");

  async function requeue(item: HeldQueueItem, mode: HeldRequeueMode) {
    const requiresTradeSelection = item.commandType !== "OPEN_TRADE";
    const logicalTradeId = selectedTradeIds[item.id];
    if (requiresTradeSelection && !logicalTradeId) return;
    const market = mode === "market";
    const confirmed = await confirm({
      title: market ? "Requeue at market?" : "Requeue as original order?",
      description: confirmationDescription(
        item,
        market ? "Requeue at market" : "Requeue using the original order details",
      ),
      confirmLabel: market ? "Requeue at market" : "Requeue original",
      destructive: false,
    });
    if (confirmed) await onRequeue(item, mode, logicalTradeId);
  }

  async function dismiss(item: HeldQueueItem) {
    const confirmed = await confirm({
      title: "Dismiss held signal?",
      description: confirmationDescription(item, "Dismiss"),
      confirmLabel: "Dismiss signal",
    });
    if (confirmed) await onDismiss(item);
  }

  if (items.length === 0) {
    return (
      <EmptyState
        body="Signals blocked by the guardian, late delivery, missing accounts, or uncertain delivery will appear here for operator review."
        glyph={<Clock3 aria-hidden="true" size={28} />}
        title="No held signals"
      />
    );
  }

  return (
    <>
      <div className="data-table-wrap held-table-wrap">
        <table className="data-table held-table">
          <thead>
            <tr>
              <th aria-sort={sortAria("createdAt")} scope="col">
                <button className="table-sort" onClick={() => toggle("createdAt")} type="button">
                  Age
                </button>
              </th>
              <th scope="col">Provider</th>
              <th scope="col">Account</th>
              <th scope="col">Command</th>
              <th scope="col">Symbol</th>
              <th scope="col">Reason</th>
              <th className="num" scope="col">
                Price drift
              </th>
              <th className="num" scope="col">
                Dropped
              </th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((item) => (
              <tr key={item.id}>
                <td>
                  <time dateTime={item.createdAt}>{ageLabel(item.createdAt)}</time>
                </td>
                <td>{providerLabel(item.providerId)}</td>
                <td>{accountLabel(item.accountId)}</td>
                <td>
                  <code>{item.commandType}</code>
                </td>
                <td>
                  <strong>{item.symbol}</strong>
                </td>
                <td>
                  <Tag tone="warn">{reasonLabel(item.heldReason)}</Tag>
                </td>
                <td className="num-cell held-price-cell">
                  <span>
                    {item.originalEntry == null
                      ? "—"
                      : formatNumber(item.originalEntry, { locale, maximumFractionDigits: 5 })}
                    {" → "}
                    {item.currentPrice == null
                      ? "—"
                      : formatNumber(item.currentPrice, { locale, maximumFractionDigits: 5 })}
                  </span>
                  {item.driftPct == null ? null : (
                    <small
                      className={item.driftPct < 0 ? "money money-danger" : "money money-warn"}
                    >
                      {formatPercent(item.driftPct, { locale, signDisplay: "always" })}
                    </small>
                  )}
                </td>
                <td className="num-cell">
                  {item.droppedLifecycleCount > 0 ? (
                    <span className="held-dropped-badge" title={item.droppedLifecycle.join(", ")}>
                      {item.droppedLifecycleCount}
                    </span>
                  ) : (
                    "—"
                  )}
                </td>
                <td>
                  <div className="held-row-actions">
                    {item.commandType !== "OPEN_TRADE" ? (
                      <select
                        aria-label={`Select active trade for ${item.symbol}`}
                        onChange={(event) =>
                          setSelectedTradeIds((current) => ({
                            ...current,
                            [item.id]: event.target.value,
                          }))
                        }
                        value={selectedTradeIds[item.id] ?? ""}
                      >
                        <option value="">Select active trade</option>
                        {(item.candidateLogicalTradeIds ?? []).map((tradeId) => (
                          <option key={tradeId} value={tradeId}>
                            {tradeId}
                          </option>
                        ))}
                      </select>
                    ) : null}
                    <button
                      className="btn btn-primary btn-small"
                      disabled={item.commandType !== "OPEN_TRADE" && !selectedTradeIds[item.id]}
                      onClick={() => void requeue(item, "market")}
                      type="button"
                    >
                      <RotateCcw aria-hidden="true" size={12} />
                      Market
                    </button>
                    <button
                      className="btn btn-ghost btn-small"
                      disabled={item.commandType !== "OPEN_TRADE" && !selectedTradeIds[item.id]}
                      onClick={() => void requeue(item, "original")}
                      type="button"
                    >
                      Original
                    </button>
                    <button
                      aria-label={`Dismiss ${item.symbol}`}
                      className="icon-btn"
                      onClick={() => void dismiss(item)}
                      title="Dismiss held signal"
                      type="button"
                    >
                      <Trash2 aria-hidden="true" size={13} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {dialog}
    </>
  );
}
