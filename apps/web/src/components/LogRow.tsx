import { Clock, Hash } from "lucide-react";
import { useState } from "react";
import { apiGet } from "../lib/api";
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
    retcodeExternal?: number;
    brokerComment: string;
    errorText?: string;
    orderTicket?: string;
    positionTicket?: string;
    dealTicket?: string;
    requestedPrice?: number;
    filledPrice?: number;
    volume?: number;
    status: string;
    timestamp?: string;
  };
}) {
  const ok = log.status === "EXECUTED";
  const retcodeLabel = RETCODE_LABEL[log.retcode];
  const [expanded, setExpanded] = useState(false);
  const [details, setDetails] = useState<typeof log | null>(null);
  const [detailError, setDetailError] = useState("");

  async function toggleDetails() {
    if (expanded) return setExpanded(false);
    if (!details) {
      try {
        const data = await apiGet<{ log?: typeof log; error?: string }>(
          `/api/execution-logs/${log.id}`,
        );
        if (!data.log) throw new Error(data.error || "Execution detail unavailable");
        setDetails(data.log);
      } catch (error) {
        setDetailError(error instanceof Error ? error.message : "Execution detail unavailable");
      }
    }
    setExpanded(true);
  }
  const detail = details ?? log;
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
          {log.errorText ? <span className="log-error">{log.errorText}</span> : null}
        </div>
        <div className="log-row-line log-row-line-meta">
          <small className="log-queue-id">queue {log.queueItemId}</small>
          {log.timestamp ? (
            <time className="log-timestamp" dateTime={log.timestamp}>
              <Clock aria-hidden="true" size={11} />
              {new Date(log.timestamp).toLocaleTimeString()}
            </time>
          ) : null}
          <button
            aria-expanded={expanded}
            className="btn btn-ghost btn-small"
            onClick={() => void toggleDetails()}
            type="button"
          >
            {expanded ? "Hide details" : "Details"}
          </button>
        </div>
        {expanded ? (
          <div className="log-details">
            {detailError ? (
              <span>{detailError}</span>
            ) : (
              <>
                <span>External retcode: {detail.retcodeExternal ?? "—"}</span>
                <span>
                  Order: {detail.orderTicket || "—"} · Position: {detail.positionTicket || "—"} ·
                  Deal: {detail.dealTicket || "—"}
                </span>
                <span>
                  Requested: {detail.requestedPrice ?? "—"} · Filled: {detail.filledPrice ?? "—"} ·
                  Volume: {detail.volume ?? "—"}
                </span>
                {detail.errorText ? <span>Broker error: {detail.errorText}</span> : null}
              </>
            )}
          </div>
        ) : null}
      </div>
    </article>
  );
}
