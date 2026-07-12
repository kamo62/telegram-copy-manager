import { Activity } from "lucide-react";
import { useEffect, useState } from "react";
import { apiGet } from "../lib/api";
import { EmptyState } from "./EmptyState";

export interface AuditLogEntry {
  id: string;
  eventType: string;
  level: string;
  message: string;
  actor: string;
  createdAt: string;
}

const defaultLoad = () =>
  apiGet<{ logs?: AuditLogEntry[] }>("/api/audit-logs?limit=50").then((data) => data.logs ?? []);

/**
 * Chronological feed of operator + system actions (Task 2). Self-loads from
 * /api/audit-logs; accepts an injectable `load` for testing.
 */
export function ActivityFeed({ load = defaultLoad }: { load?: () => Promise<AuditLogEntry[]> }) {
  const [logs, setLogs] = useState<AuditLogEntry[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let active = true;
    load()
      .then((rows) => {
        if (active) {
          setLogs(Array.isArray(rows) ? rows : []);
          setLoaded(true);
        }
      })
      .catch(() => {
        if (active) setLoaded(true);
      });
    return () => {
      active = false;
    };
  }, [load]);

  if (loaded && logs.length === 0) {
    return (
      <EmptyState
        body="Operator actions and system events (approvals, settings changes, reconciliations) appear here."
        glyph={<Activity aria-hidden="true" size={28} />}
        title="No activity yet"
      />
    );
  }

  return (
    <ul className="activity-feed">
      {logs.map((log) => (
        <li className={`activity-row activity-${log.level}`} key={log.id}>
          <span className={`activity-actor activity-actor-${log.actor}`}>{log.actor}</span>
          <span className="activity-event">{log.eventType}</span>
          <span className="activity-message">{log.message}</span>
          <time className="activity-time" dateTime={log.createdAt}>
            {new Date(log.createdAt).toLocaleString()}
          </time>
        </li>
      ))}
    </ul>
  );
}
