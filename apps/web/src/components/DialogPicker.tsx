import { CheckCircle2, RefreshCw, Search, X } from "lucide-react";
import { useMemo, useState } from "react";
import { EmptyState } from "./EmptyState";

export interface TelegramDialogSummary {
  id: string;
  title: string;
  type: "channel" | "group" | "user";
  unreadCount: number;
}

type Filter = "all" | "channel" | "group" | "user";

export function DialogPicker({
  dialogs,
  onRefresh,
  onSelect,
  onRemove,
  selectedDialogIds = [],
  connected = false,
  loading = false,
}: {
  dialogs: TelegramDialogSummary[];
  onRefresh: () => Promise<void>;
  onSelect: (dialog: TelegramDialogSummary) => Promise<void>;
  onRemove?: (dialog: TelegramDialogSummary) => Promise<void> | void;
  selectedDialogIds?: string[];
  connected?: boolean;
  loading?: boolean;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");

  const selected = new Set(selectedDialogIds);
  const counts = useMemo(() => {
    const map = { channel: 0, group: 0, user: 0 } as Record<Filter, number>;
    for (const dialog of dialogs) map[dialog.type] += 1;
    return map;
  }, [dialogs]);

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return [...dialogs]
      .filter((dialog) => filter === "all" || dialog.type === filter)
      .filter((dialog) => !needle || dialog.title.toLowerCase().includes(needle))
      .sort((left, right) => dialogRank(left) - dialogRank(right));
  }, [dialogs, filter, search]);

  return (
    <section className="dialog-picker">
      <div className="dialog-picker-head">
        <div className="dialog-picker-title">
          <strong>Available dialogs</strong>
          <span className="dialog-picker-count">
            {dialogs.length} total · {selected.size} selected
          </span>
        </div>
        <button
          aria-label={
            dialogs.length === 0 && connected ? "Load Telegram dialogs" : "Refresh Telegram dialogs"
          }
          className="btn btn-ghost btn-small"
          onClick={() => void onRefresh()}
          type="button"
        >
          <RefreshCw aria-hidden="true" size={12} />
          {dialogs.length === 0 && connected ? "Load dialogs" : "Refresh"}
        </button>
      </div>
      <div className="dialog-picker-filters">
        <label className="panel-search">
          <Search aria-hidden="true" size={13} />
          <input
            aria-label="Filter dialogs by title"
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Filter by title…"
            type="search"
            value={search}
          />
        </label>
        <div className="dialog-picker-types" role="tablist" aria-label="Filter by type">
          {(["all", "channel", "group", "user"] as Filter[]).map((option) => (
            <button
              aria-selected={filter === option}
              className={`dialog-filter-chip ${filter === option ? "is-on" : ""}`}
              key={option}
              onClick={() => setFilter(option)}
              role="tab"
              tabIndex={filter === option ? 0 : -1}
              type="button"
            >
              {option === "all" ? `All ${dialogs.length}` : `${option} ${counts[option] ?? 0}`}
            </button>
          ))}
        </div>
      </div>
      {dialogs.length === 0 ? (
        <EmptyState
          body={
            loading
              ? "Pulling your Telegram dialogs from the API…"
              : connected
                ? "Telegram is connected. Load dialogs to choose channels and groups."
                : "Once Telegram is connected, your channels and groups will appear here."
          }
          title="No dialogs loaded"
        />
      ) : visible.length === 0 ? (
        <p className="panel-hint">No dialogs match the current filter.</p>
      ) : (
        <ul className="dialog-list">
          {visible.map((dialog) => {
            const isSelected = selected.has(dialog.id);
            return (
              <li className="dialog-list-item" key={dialog.id}>
                <div className={`dialog-row ${isSelected ? "is-selected" : ""}`}>
                  <div className="dialog-row-icon" aria-hidden="true">
                    {dialog.title.trim().charAt(0).toUpperCase() || "?"}
                  </div>
                  <div className="dialog-row-text">
                    <strong>{dialog.title}</strong>
                    <span className="dialog-row-meta">
                      <span className={`dialog-type-pill dialog-type-${dialog.type}`}>
                        {dialog.type}
                      </span>
                      {dialog.unreadCount > 0 ? (
                        <span className="dialog-unread-pill">{dialog.unreadCount} unread</span>
                      ) : (
                        <span className="dialog-row-muted-text">no new messages</span>
                      )}
                    </span>
                  </div>
                  {isSelected ? (
                    <div className="dialog-row-actions">
                      <span className="dialog-row-action is-selected" title="Provider added">
                        <CheckCircle2 aria-hidden="true" size={13} />
                        Added
                      </span>
                      {onRemove ? (
                        <button
                          aria-label={`Remove ${dialog.title} as a provider`}
                          className="btn btn-ghost btn-small btn-destructive-subtle"
                          onClick={() => void onRemove(dialog)}
                          type="button"
                        >
                          <X aria-hidden="true" size={12} />
                          Remove
                        </button>
                      ) : null}
                    </div>
                  ) : (
                    <button
                      aria-label={`Add ${dialog.title} as a provider`}
                      className="dialog-row-action dialog-row-action-add"
                      onClick={() => void onSelect(dialog)}
                      type="button"
                    >
                      <CheckCircle2 aria-hidden="true" size={13} />
                      Add provider
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function dialogRank(dialog: TelegramDialogSummary) {
  if (dialog.type === "channel") return 0;
  if (dialog.type === "group") return 1;
  return 2;
}
