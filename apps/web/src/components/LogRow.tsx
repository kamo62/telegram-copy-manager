import { Clock, Hash } from "lucide-react";
import { Tag } from "./Tag";

const RETCODE_LABEL: Record<number, string> = {
  10004: "REQUOTE",
  10006: "REJECT",
  10007: "CANCEL",
  10008: "PLACED",
  10009: "DONE",
  10010: "DONE_PARTIAL",
  10011: "ERROR",
  10012: "TIMEOUT",
  10013: "INVALID",
  10014: "INVALID_VOLUME",
  10015: "INVALID_PRICE",
  10016: "INVALID_STOPS",
};

export function LogRow({
  log,
}: {
  log: {
    id: string;
    queueItemId: string;
    retcode: number;
    brokerComment: string;
    status: string;
    timestamp?: string;
  };
}) {
  const ok = log.status === "EXECUTED";
  const retcodeLabel = RETCODE_LABEL[log.retcode];
  return (
    <article className="log-row" key={log.id}>
      <Tag tone={ok ? "good" : "warn"}>{log.status}</Tag>
      <div className="log-row-body">
        <div className="log-row-line">
          <span className="log-retcode" title={retcodeLabel ? `MQL5 ${retcodeLabel}` : undefined}>
            <Hash aria-hidden="true" size={11} />
            {log.retcode}
            {retcodeLabel ? <span className="log-retcode-label">{retcodeLabel}</span> : null}
          </span>
          <span className="log-comment">{log.brokerComment || "—"}</span>
        </div>
        <div className="log-row-line log-row-line-meta">
          <small className="log-queue-id">queue {log.queueItemId}</small>
          {log.timestamp ? (
            <time className="log-timestamp" dateTime={log.timestamp}>
              <Clock aria-hidden="true" size={11} />
              {new Date(log.timestamp).toLocaleTimeString()}
            </time>
          ) : null}
        </div>
      </div>
    </article>
  );
}
