import { ShieldAlert, X } from "lucide-react";
import { useEffect, useState } from "react";

const DISMISSED_ALERTS_STORAGE_KEY = "ttc:dismissedOperationalAlerts";

export interface OperationalAlert {
  kind: string;
  severity: "warn" | "error";
  message: string;
  accountId?: string;
  detail?: Record<string, unknown>;
}

/** Stable identity for an alert across dashboard refreshes. */
function alertKey(alert: OperationalAlert): string {
  const detailId = alert.detail?.providerId ?? alert.detail?.sessionId ?? "";
  return `${alert.kind}:${alert.accountId ?? detailId}`;
}

function readDismissedAlerts(): Set<string> {
  try {
    const stored = JSON.parse(window.localStorage.getItem(DISMISSED_ALERTS_STORAGE_KEY) ?? "[]");
    return new Set(
      Array.isArray(stored) ? stored.filter((key): key is string => typeof key === "string") : [],
    );
  } catch {
    return new Set();
  }
}

export function visibleOperationalAlerts(alerts: OperationalAlert[]): OperationalAlert[] {
  const dismissed = readDismissedAlerts();
  return alerts.filter((alert) => !dismissed.has(alertKey(alert)));
}

function writeDismissedAlerts(dismissed: Set<string>) {
  try {
    window.localStorage.setItem(DISMISSED_ALERTS_STORAGE_KEY, JSON.stringify([...dismissed]));
  } catch {
    // The in-memory dismissal still works when browser storage is unavailable.
  }
}

/**
 * Surfaces operational conditions that silently block trading so they can't go
 * unnoticed: a latched Equity Guardian rejecting every signal, or a Telegram
 * session that has stopped receiving updates. Both previously failed silently
 * (HTTP stayed healthy while signals were dropped), so they get a prominent
 * banner here until the condition clears.
 *
 * Each alert is dismissible. Dismissals survive reloads, then clear when the
 * underlying condition clears so a later recurrence is visible again.
 */
export function AlertsBanner({
  alerts,
  onViewHeld,
}: {
  alerts: OperationalAlert[];
  onViewHeld?: () => void;
}) {
  const [dismissed, setDismissed] = useState(readDismissedAlerts);

  // Drop dismissals whose condition has cleared so a later recurrence is visible.
  useEffect(() => {
    setDismissed((current) => {
      if (current.size === 0) return current;
      const live = new Set(alerts.map(alertKey));
      const next = new Set<string>();
      for (const key of current) {
        if (live.has(key)) next.add(key);
      }
      if (next.size === current.size) return current;
      writeDismissedAlerts(next);
      return next;
    });
  }, [alerts]);

  const visible = alerts.filter((alert) => !dismissed.has(alertKey(alert)));
  if (visible.length === 0) return null;
  const errors = visible.filter((alert) => alert.severity === "error").length;
  const warnings = visible.length - errors;

  return (
    <details aria-label="Operational alerts" className="alerts-banner">
      <summary className="alerts-banner-summary">
        <span className="alerts-banner-icon" aria-hidden="true">
          <ShieldAlert size={15} />
        </span>
        <strong>
          {visible.length} operational {visible.length === 1 ? "alert" : "alerts"}
        </strong>
        <span>
          {errors} critical · {warnings} {warnings === 1 ? "warning" : "warnings"}
        </span>
      </summary>
      <div className="alerts-banner-list" role="alert">
        {visible.map((alert, index) => {
          const key = alertKey(alert);
          return (
            <div
              className={`alerts-banner-item alerts-banner-${alert.severity}`}
              key={`${alert.kind}-${alert.accountId ?? index}`}
            >
              <span className="alerts-banner-icon" aria-hidden="true">
                <ShieldAlert size={15} />
              </span>
              <span className="alerts-banner-message">{alert.message}</span>
              {onViewHeld && /guardian|held/i.test(alert.kind) ? (
                <button className="alerts-banner-link" onClick={onViewHeld} type="button">
                  View held
                </button>
              ) : null}
              <button
                aria-label="Dismiss alert"
                className="alerts-banner-close"
                onClick={() =>
                  setDismissed((current) => {
                    const next = new Set(current).add(key);
                    writeDismissedAlerts(next);
                    return next;
                  })
                }
                type="button"
              >
                <X size={14} aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>
    </details>
  );
}
