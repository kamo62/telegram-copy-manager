import { AlertTriangle, ChevronDown, ChevronUp } from "lucide-react";
import { useState } from "react";

export interface OutOfSyncTrade {
  id: string;
  symbol: string;
  direction: string;
  outOfSyncReason?: string;
  livePositionExists?: boolean;
  matchedBrokerTickets?: string[];
  brokerComment?: string;
  lastSnapshotAt?: string;
}

/**
 * Surfaces logical trades whose tracking state has drifted from the broker —
 * e.g. a live position exists but its EA tracking comment is truncated, or
 * the snapshot shows no matching ticket. Previously visible inline in the
 * legacy History view; lives here now because the new Closed view only shows
 * fully-wound-down trades. An operator should see drift on Live, not have to
 * hunt for it.
 */
export function OutOfSyncBanner({ trades }: { trades: OutOfSyncTrade[] }) {
  const [open, setOpen] = useState(false);
  if (trades.length === 0) return null;
  return (
    <section aria-label="Out-of-sync trades" className="out-of-sync-banner" role="status">
      <button
        aria-expanded={open}
        className="out-of-sync-banner-head"
        onClick={() => setOpen((prev) => !prev)}
        type="button"
      >
        <span className="out-of-sync-banner-icon" aria-hidden="true">
          <AlertTriangle size={14} />
        </span>
        <span className="out-of-sync-banner-summary">
          <strong>
            {trades.length} trade{trades.length === 1 ? "" : "s"} out of sync
          </strong>
          <span className="out-of-sync-banner-hint">
            EA tracking has drifted from the broker. Review before approving more signals.
          </span>
        </span>
        <span className="out-of-sync-banner-toggle" aria-hidden="true">
          {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </span>
      </button>
      {open ? (
        <ul className="out-of-sync-banner-list">
          {trades.map((trade) => (
            <li className="out-of-sync-banner-item" key={trade.id}>
              <div className="out-of-sync-banner-item-head">
                <strong>{trade.symbol}</strong>
                <span className="out-of-sync-banner-item-side">{trade.direction}</span>
                {trade.matchedBrokerTickets?.map((ticket) => (
                  <code key={ticket}>ticket {ticket}</code>
                )) ?? null}
                {trade.livePositionExists !== undefined ? (
                  <span className="out-of-sync-banner-item-state">
                    {trade.livePositionExists ? "live position present" : "no live position"}
                  </span>
                ) : null}
              </div>
              {trade.outOfSyncReason ? (
                <p className="out-of-sync-banner-item-reason">{trade.outOfSyncReason}</p>
              ) : null}
              {trade.brokerComment ? (
                <code className="out-of-sync-banner-item-comment">{trade.brokerComment}</code>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
