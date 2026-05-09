import { CheckCircle2, RefreshCw } from "lucide-react";

export interface TelegramDialogSummary {
  id: string;
  title: string;
  type: "channel" | "group" | "user";
  unreadCount: number;
}

export function DialogPicker({
  dialogs,
  onRefresh,
  onSelect,
}: {
  dialogs: TelegramDialogSummary[];
  onRefresh: () => Promise<void>;
  onSelect: (dialog: TelegramDialogSummary) => Promise<void>;
}) {
  return (
    <section className="dialog-picker">
      <div className="dialog-picker-head">
        <strong>Available Dialogs</strong>
        <button
          aria-label="Refresh Telegram dialogs"
          onClick={() => void onRefresh()}
          title="Refresh Telegram dialogs"
          type="button"
        >
          <RefreshCw size={12} />
        </button>
      </div>
      {dialogs.length === 0 ? (
        <div className="empty-state">No dialogs loaded</div>
      ) : (
        <div className="dialog-list">
          {dialogs.map((dialog) => (
            <div className="dialog-row" key={dialog.id}>
              <div>
                <strong>{dialog.title}</strong>
                <span>
                  {dialog.type} · {dialog.unreadCount} unread
                </span>
              </div>
              <button
                aria-label={`Select ${dialog.title}`}
                onClick={() => void onSelect(dialog)}
                title={`Select ${dialog.title}`}
                type="button"
              >
                <CheckCircle2 size={14} aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
