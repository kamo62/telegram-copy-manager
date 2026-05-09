import { RefreshCw, TerminalSquare } from "lucide-react";

export function StatusBar({
  database,
  lastPollError,
  onCommandPalette,
  onRefresh,
  queuePending,
  refreshing,
  telegramAdapter,
}: {
  database: string;
  lastPollError: boolean;
  onCommandPalette: () => void;
  onRefresh: () => void;
  queuePending: number;
  refreshing: boolean;
  telegramAdapter: string;
}) {
  const now = new Date().toISOString().slice(11, 19);

  return (
    <header className="status-bar">
      <span className="brand">TG-TC · Operations</span>
      <div className="chips">
        <span className="chip">
          <span className={`chip-dot ${database === "connected" ? "ok" : "warn"}`} />
          DB {database}
        </span>
        <span className="chip">
          <span
            className={`chip-dot ${telegramAdapter === "live" ? "ok" : telegramAdapter === "mock" ? "warn" : "error"}`}
          />
          TG {telegramAdapter}
        </span>
        <span className="chip">Queue {queuePending}</span>
        <span className="chip">{now} UTC</span>
        {lastPollError ? (
          <span className="chip">
            <span className="chip-dot error" />
            Poll failed
          </span>
        ) : null}
      </div>
      <div>
        <span className="live-dot" aria-hidden="true" title="Live updates active" />
        <button
          aria-label="Open command palette"
          className="refresh-btn"
          onClick={() => void onCommandPalette()}
          title="Open command palette ( / )"
          type="button"
        >
          <TerminalSquare size={12} />
        </button>
        <button
          aria-label="Refresh dashboard"
          className="refresh-btn"
          disabled={refreshing}
          onClick={() => void onRefresh()}
          title={refreshing ? "Refreshing dashboard" : "Refresh dashboard"}
          type="button"
        >
          <RefreshCw size={12} />
        </button>
      </div>
    </header>
  );
}
