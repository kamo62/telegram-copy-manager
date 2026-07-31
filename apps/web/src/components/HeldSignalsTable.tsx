import { Clock3, RotateCcw, Trash2 } from "lucide-react";
import { useState } from "react";
import { useLocale } from "../contexts/LocaleContext";
import { useSortableTable } from "../hooks/useSortableTable";
import type { HeldQueueItem, HeldRequeueMode } from "../lib/api";
import { formatNumber, formatPercent } from "../lib/format";
import { useConfirm } from "./ConfirmDialog";
import { EmptyState } from "./EmptyState";
import { Tag } from "./Tag";

const STALE_AFTER_MS = 24 * 60 * 60 * 1_000;

function reasonLabel(reason: string): string {
  const label = reason.replaceAll("_", " ").toLowerCase();
  return label.charAt(0).toUpperCase() + label.slice(1);
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

function isStale(createdAt: string): boolean {
  const createdAtMs = Date.parse(createdAt);
  return Number.isFinite(createdAtMs) && Date.now() - createdAtMs >= STALE_AFTER_MS;
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
  onDismissAll,
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
  onDismissAll: (items: HeldQueueItem[]) => Promise<void> | void;
}) {
  const { locale } = useLocale();
  const { confirm, dialog } = useConfirm();
  const [dismissAllBusy, setDismissAllBusy] = useState(false);
  const [selectedTradeIds, setSelectedTradeIds] = useState<Record<string, string>>({});
  const { sortedRows, toggle, sortAria } = useSortableTable(items, "createdAt", "desc");

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
      title: item.actionable ? "Dismiss held signal?" : "Dismiss suppressed signal?",
      description: confirmationDescription(item, "Dismiss"),
      confirmLabel: item.actionable ? "Dismiss signal" : "Dismiss suppression",
    });
    if (confirmed) await onDismiss(item);
  }

  async function dismissAll() {
    const confirmed = await confirm({
      title: `Dismiss all ${items.length} signals?`,
      description:
        "This removes every held and suppressed signal from review. Nothing will be executed or requeued.",
      confirmLabel: `Dismiss ${items.length} signals`,
    });
    if (!confirmed) return;
    setDismissAllBusy(true);
    try {
      await onDismissAll(items);
    } finally {
      setDismissAllBusy(false);
    }
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
      <div className="panel-toolbar held-table-toolbar">
        <span>
          {items.length} {items.length === 1 ? "signal" : "signals"} awaiting review
        </span>
        <button
          className="btn btn-ghost btn-small"
          disabled={dismissAllBusy}
          onClick={() => void dismissAll()}
          type="button"
        >
          <Trash2 aria-hidden="true" size={13} />
          {dismissAllBusy ? "Dismissing…" : "Dismiss all"}
        </button>
      </div>
      <div className="data-table-wrap held-table-wrap">
        <table className="data-table held-table">
          <thead>
            <tr>
              <th aria-sort={sortAria("createdAt")} scope="col">
                <button className="table-sort" onClick={() => toggle("createdAt")} type="button">
                  Signal
                </button>
              </th>
              <th scope="col">Account</th>
              <th scope="col">Intent</th>
              <th scope="col">Review</th>
              <th className="num" scope="col">
                Price drift
              </th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((item) => (
              <tr className={isStale(item.createdAt) ? "held-row-stale" : undefined} key={item.id}>
                <td className="held-signal-cell">
                  <strong>{providerLabel(item.providerId)}</strong>
                  <time dateTime={item.createdAt}>{ageLabel(item.createdAt)} ago</time>
                </td>
                <td className="held-account-cell">{accountLabel(item.accountId)}</td>
                <td className="held-intent-cell">
                  <strong>{item.symbol}</strong>
                  <code>{item.commandType}</code>
                </td>
                <td className="held-review-cell">
                  <Tag tone={item.actionable ? "warn" : "muted"}>
                    {item.actionable ? "Awaiting action" : "Suppressed"}
                  </Tag>
                  <span className="held-reason">{reasonLabel(item.heldReason)}</span>
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
                  <small
                    title={
                      item.droppedLifecycleCount
                        ? item.droppedLifecycle.join(", ")
                        : "No lifecycle commands were dropped while this signal was held"
                    }
                  >
                    {typeof item.droppedLifecycleCount === "number"
                      ? `${item.droppedLifecycleCount} dropped`
                      : "Dropped unknown"}
                  </small>
                </td>
                <td>
                  <div className="held-row-actions">
                    {item.actionable ? (
                      <>
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
                        {item.commandType === "OPEN_TRADE" || selectedTradeIds[item.id] ? (
                          <>
                            <button
                              className="btn btn-primary btn-small"
                              onClick={() => void requeue(item, "market")}
                              type="button"
                            >
                              <RotateCcw aria-hidden="true" size={12} />
                              Market
                            </button>
                            <button
                              className="btn btn-ghost btn-small"
                              onClick={() => void requeue(item, "original")}
                              type="button"
                            >
                              Original
                            </button>
                          </>
                        ) : null}
                      </>
                    ) : null}
                    <button
                      aria-label={`Dismiss ${item.symbol}`}
                      className="icon-btn"
                      onClick={() => void dismiss(item)}
                      title={item.actionable ? "Dismiss held signal" : "Dismiss suppressed signal"}
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
