import { RefreshCw, TerminalSquare } from "lucide-react";
import { useEffect, useState } from "react";

export function StatusBar({
  appVersion,
  database,
  lastPollError,
  lastSyncAt,
  onCommandPalette,
  onRefresh,
  queuePending,
  refreshing,
  telegramAdapter,
}: {
  appVersion: string;
  database: string;
  lastPollError: boolean;
  lastSyncAt: string | null;
  onCommandPalette: () => void;
  onRefresh: () => void;
  queuePending: number;
  refreshing: boolean;
  telegramAdapter: string;
}) {
  const [errorFlash, setErrorFlash] = useState(false);

  useEffect(() => {
    if (!lastPollError) return;
    setErrorFlash(true);
    const timer = window.setTimeout(() => setErrorFlash(false), 4000);
    return () => window.clearTimeout(timer);
  }, [lastPollError]);

  const liveDotClass = errorFlash
    ? "live-dot error"
    : refreshing
      ? "live-dot refreshing"
      : "live-dot";
  const liveDotLabel = errorFlash
    ? "Last poll failed"
    : refreshing
      ? "Refreshing dashboard"
      : "Live updates active";
  const telegramAdapterStatus =
    telegramAdapter === "gramjs" || telegramAdapter === "live"
      ? "ok"
      : telegramAdapter === "mock"
        ? "warn"
        : "error";
  const lastSyncLabel = lastSyncAt
    ? new Intl.DateTimeFormat(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }).format(new Date(lastSyncAt))
    : "Pending";

  return (
    <header className="status-bar">
      <h1 className="brand" title={`Version ${appVersion}`}>
        TG-TC · Operations
      </h1>
      <div className="status-cluster">
        <span className="status-chip">
          <span
            aria-label={liveDotLabel}
            className={liveDotClass}
            role="img"
            title={liveDotLabel}
          />
          <span className="sync-label">Last sync:</span>
          <span className="sync-value">{lastSyncLabel}</span>
        </span>
        <span className="status-chip">
          <span className={`chip-dot ${database === "connected" ? "ok" : "warn"}`} />
          <span className="sync-label">DB</span>
          <span className="sync-value">{database}</span>
        </span>
        <span className="status-chip">
          <span className={`chip-dot ${telegramAdapterStatus}`} />
          <span className="sync-label">TG</span>
          <span className="sync-value">{telegramAdapter}</span>
        </span>
        <span className="status-chip">
          <span className="sync-label">Queue</span>
          <span className="sync-value">{queuePending}</span>
        </span>
        {lastPollError ? (
          <span aria-live="polite" className="status-chip" role="status">
            <span className="chip-dot error" />
            <span className="sync-label">Poll failed</span>
          </span>
        ) : null}
      </div>
      <div className="status-actions">
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
