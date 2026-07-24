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

export interface UnmappedSymbolAlertDetail {
  token: string;
  canonicalSymbol: string;
  providerId: string;
  providerTitle: string;
  accountId: string;
  accountLabel: string;
  blockedSignalCount: number;
  suggestedBrokerSymbol?: string;
}

/** Stable identity for an alert across dashboard refreshes. */
function alertKey(alert: OperationalAlert): string {
  const detail = alert.detail ?? {};
  if (alert.kind === "unmapped-symbols") {
    return `${alert.kind}:${detail.providerId ?? ""}:${alert.accountId ?? detail.accountId ?? ""}:${detail.token ?? ""}`;
  }
  const detailId = detail.providerId ?? detail.sessionId ?? "";
  const token = detail.token ?? "";
  return `${alert.kind}:${alert.accountId ?? detail.accountId ?? detailId}:${token}`;
}

function unmappedDetail(alert: OperationalAlert): UnmappedSymbolAlertDetail | null {
  if (alert.kind !== "unmapped-symbols" || !alert.detail?.token) return null;
  return alert.detail as unknown as UnmappedSymbolAlertDetail;
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
  onMapUnmapped,
  onSuppressUnmapped,
}: {
  alerts: OperationalAlert[];
  onViewHeld?: () => void;
  onMapUnmapped?: (alert: OperationalAlert) => void;
  onSuppressUnmapped?: (alert: OperationalAlert) => Promise<void> | void;
}) {
  const [dismissed, setDismissed] = useState(readDismissedAlerts);
  const [suppressed, setSuppressed] = useState<Set<string>>(() => new Set());

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

  const visible = alerts.filter(
    (alert) => !dismissed.has(alertKey(alert)) && !suppressed.has(alertKey(alert)),
  );
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
          const detail = unmappedDetail(alert);
          return (
            <div
              className={`alerts-banner-item alerts-banner-${alert.severity}`}
              key={`${key}-${index}`}
            >
              <span className="alerts-banner-icon" aria-hidden="true">
                <ShieldAlert size={15} />
              </span>
              <span className="alerts-banner-message">
                {detail ? (
                  <>
                    <strong>{detail.token}</strong>
                    <span>
                      {detail.providerTitle} · {detail.accountLabel} · {detail.blockedSignalCount}{" "}
                      {detail.blockedSignalCount === 1 ? "signal blocked" : "signals blocked"}
                    </span>
                  </>
                ) : (
                  alert.message
                )}
              </span>
              {detail && onMapUnmapped ? (
                <button
                  className="alerts-banner-link"
                  onClick={() => onMapUnmapped(alert)}
                  type="button"
                >
                  {detail.suggestedBrokerSymbol
                    ? `Map to ${detail.suggestedBrokerSymbol}`
                    : "Map symbol"}
                </button>
              ) : null}
              {detail && onSuppressUnmapped ? (
                <button
                  className="alerts-banner-link alerts-banner-secondary"
                  onClick={() => {
                    setSuppressed((current) => new Set(current).add(key));
                    void Promise.resolve(onSuppressUnmapped(alert)).catch(() => {
                      setSuppressed((current) => {
                        const next = new Set(current);
                        next.delete(key);
                        return next;
                      });
                    });
                  }}
                  type="button"
                >
                  Not an instrument
                </button>
              ) : null}
              {onViewHeld && /guardian|held/i.test(alert.kind) ? (
                <button className="alerts-banner-link" onClick={onViewHeld} type="button">
                  View held
                </button>
              ) : null}
              {!detail ? (
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
              ) : null}
            </div>
          );
        })}
      </div>
    </details>
  );
}
