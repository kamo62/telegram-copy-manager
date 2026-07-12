import { ShieldAlert, X } from "lucide-react";
import { useEffect, useState } from "react";

export interface OperationalAlert {
  kind: string;
  severity: "warn" | "error";
  message: string;
  accountId?: string;
  detail?: Record<string, unknown>;
}

/** Stable identity for an alert across dashboard refreshes (the message text
 * can change as counts move, so dismissal keys off kind + account, not text). */
function alertKey(alert: OperationalAlert): string {
  return `${alert.kind}:${alert.accountId ?? ""}`;
}

/**
 * Surfaces operational conditions that silently block trading so they can't go
 * unnoticed: a latched Equity Guardian rejecting every signal, or a Telegram
 * session that has stopped receiving updates. Both previously failed silently
 * (HTTP stayed healthy while signals were dropped), so they get a prominent
 * banner here until the condition clears.
 *
 * Each alert is dismissible. Dismissal is session-scoped (component state, not
 * persisted) on purpose: closing tidies the view now, but a page reload re-shows
 * any still-active condition so a safety-critical alert (guardian latched,
 * Telegram stalled) can never be permanently hidden.
 * ponytail: dismissal lives in state, so it resets on reload — that is the
 * intended ceiling; persisting it would risk hiding live trade-blocking alerts.
 */
export function AlertsBanner({
  alerts,
  onViewHeld,
}: {
  alerts: OperationalAlert[];
  onViewHeld?: () => void;
}) {
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());

  // Drop dismissals whose condition has cleared so the alert shows again if it
  // re-triggers later in the same session.
  useEffect(() => {
    setDismissed((current) => {
      if (current.size === 0) return current;
      const live = new Set(alerts.map(alertKey));
      const next = new Set<string>();
      for (const key of current) {
        if (live.has(key)) next.add(key);
      }
      return next.size === current.size ? current : next;
    });
  }, [alerts]);

  const visible = alerts.filter((alert) => !dismissed.has(alertKey(alert)));
  if (visible.length === 0) return null;

  return (
    <section aria-label="Operational alerts" className="alerts-banner" role="alert">
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
              onClick={() => setDismissed((current) => new Set(current).add(key))}
              type="button"
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </section>
  );
}
