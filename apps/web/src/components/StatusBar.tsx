import { Moon, RefreshCw, Sun, TerminalSquare } from "lucide-react";
import { useTheme } from "../contexts/ThemeContext";
import { useSyncStatus } from "../lib/syncStatus";

interface StatusBarProps {
  appVersion: string;
  database: string;
  lastPollError: boolean;
  lastSyncAt: string | null;
  onCommandPalette: () => void;
  onRefresh: () => void;
  queuePending: number;
  refreshing: boolean;
  telegramAdapter: string;
  title?: string;
}

/**
 * StatusBar bound to the external sync store, so the frequent SSE reload
 * cycle re-renders this subtree only instead of the whole App.
 */
export function LiveStatusBar(props: Omit<StatusBarProps, "lastSyncAt" | "refreshing">) {
  const { lastSyncAt, refreshing } = useSyncStatus();
  return <StatusBar {...props} lastSyncAt={lastSyncAt} refreshing={refreshing} />;
}

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
  title = "Operations",
}: StatusBarProps) {
  const { theme, toggleTheme } = useTheme();
  const liveDotClass = lastPollError
    ? "live-dot error"
    : refreshing
      ? "live-dot refreshing"
      : "live-dot";
  const liveDotLabel = lastPollError
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
      {/* Not a heading: this names the app and mirrors the current page, so as
          an <h1> it displaced the real page title in the outline. */}
      <div className="brand" title={`Version ${appVersion}`}>
        <span className="visually-hidden">TG-TC · </span>
        {title}
      </div>
      <div className="status-cluster">
        <span
          aria-live={lastPollError ? "polite" : undefined}
          className="status-chip"
          role={lastPollError ? "status" : undefined}
        >
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
        <span className="status-chip status-version">v{appVersion}</span>
        {lastPollError ? (
          <span aria-live="polite" className="status-chip status-chip-error" role="status">
            <span className="chip-dot error" />
            <span className="sync-label">Poll failed</span>
          </span>
        ) : null}
      </div>
      <div className="status-actions">
        <button
          aria-label={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
          className="refresh-btn theme-toggle"
          onClick={toggleTheme}
          title={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
          type="button"
        >
          {theme === "light" ? (
            <Moon aria-hidden="true" size={14} />
          ) : (
            <Sun aria-hidden="true" size={14} />
          )}
        </button>
        <button
          aria-label="Open command palette"
          className="refresh-btn"
          onClick={() => void onCommandPalette()}
          title="Open command palette ( / )"
          type="button"
        >
          <TerminalSquare aria-hidden="true" size={14} />
          <span className="status-action-label">Menu</span>
        </button>
        <button
          aria-label="Refresh dashboard"
          className="refresh-btn"
          disabled={refreshing}
          onClick={() => void onRefresh()}
          title={refreshing ? "Refreshing dashboard" : "Refresh dashboard"}
          type="button"
        >
          <RefreshCw aria-hidden="true" size={14} />
        </button>
      </div>
    </header>
  );
}
