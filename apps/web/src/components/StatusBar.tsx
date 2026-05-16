import { RefreshCw, TerminalSquare } from "lucide-react";
import { useEffect, useState } from "react";
import { formatUtcClock } from "../lib/format";

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
  const now = formatUtcClock();
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

  return (
    <header className="status-bar">
      <h1 className="brand">TG-TC · Operations</h1>
      <div className="chips">
        <span className="chip">
          <span className={`chip-dot ${database === "connected" ? "ok" : "warn"}`} />
          DB {database}
        </span>
        <span className="chip">
          <span className={`chip-dot ${telegramAdapterStatus}`} />
          TG {telegramAdapter}
        </span>
        <span className="chip">Queue {queuePending}</span>
        <span className="chip">{now} UTC</span>
        {lastPollError ? (
          <span aria-live="polite" className="chip" role="status">
            <span className="chip-dot error" />
            Poll failed
          </span>
        ) : null}
      </div>
      <div>
        <span aria-label={liveDotLabel} className={liveDotClass} role="img" title={liveDotLabel} />
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
