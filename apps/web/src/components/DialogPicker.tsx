import { CheckCircle2, RefreshCw, Search } from "lucide-react";
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
  selectedDialogIds = [],
  loading = false,
}: {
  dialogs: TelegramDialogSummary[];
  onRefresh: () => Promise<void>;
  onSelect: (dialog: TelegramDialogSummary) => Promise<void>;
  selectedDialogIds?: string[];
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
          <span className="dialog-picker-count">{dialogs.length} total · {selected.size} selected</span>
        </div>
        <button
          aria-label="Refresh Telegram dialogs"
          className="btn btn-ghost btn-small"
          onClick={() => void onRefresh()}
          type="button"
        >
          <RefreshCw aria-hidden="true" size={12} />
          Refresh
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
              aria-pressed={filter === option}
              className={`dialog-filter-chip ${filter === option ? "is-on" : ""}`}
              key={option}
              onClick={() => setFilter(option)}
              role="tab"
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
                <button
                  aria-label={`${isSelected ? "Selected" : "Select"} ${dialog.title}`}
                  className={`dialog-row dialog-row-button ${isSelected ? "is-selected" : ""}`}
                  disabled={isSelected}
                  onClick={() => void onSelect(dialog)}
                  type="button"
                >
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
                        <span className="dialog-unread-pill">
                          {dialog.unreadCount} unread
                        </span>
                      ) : (
                        <span className="dialog-row-muted-text">no new messages</span>
                      )}
                    </span>
                  </div>
                  <span className={`dialog-row-action ${isSelected ? "is-selected" : ""}`}>
                    <CheckCircle2 aria-hidden="true" size={13} />
                    {isSelected ? "Added" : "Add provider"}
                  </span>
                </button>
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
