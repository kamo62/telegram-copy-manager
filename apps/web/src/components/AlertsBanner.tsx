import { ShieldAlert } from "lucide-react";

export interface OperationalAlert {
  kind: string;
  severity: "warn" | "error";
  message: string;
  accountId?: string;
  detail?: Record<string, unknown>;
}

/**
 * Surfaces operational conditions that silently block trading so they can't go
 * unnoticed: a latched Equity Guardian rejecting every signal, or a Telegram
 * session that has stopped receiving updates. Both previously failed silently
 * (HTTP stayed healthy while signals were dropped), so they get a persistent,
 * prominent banner here until the condition clears.
 */
export function AlertsBanner({ alerts }: { alerts: OperationalAlert[] }) {
  if (alerts.length === 0) return null;
  return (
    <section aria-label="Operational alerts" className="alerts-banner" role="alert">
      {alerts.map((alert, index) => (
        <div
          className={`alerts-banner-item alerts-banner-${alert.severity}`}
          key={`${alert.kind}-${alert.accountId ?? index}`}
        >
          <span className="alerts-banner-icon" aria-hidden="true">
            <ShieldAlert size={15} />
          </span>
          <span className="alerts-banner-message">{alert.message}</span>
        </div>
      ))}
    </section>
  );
}
