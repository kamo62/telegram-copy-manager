import { Tag } from "./Tag";

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
  return (
    <div className="log-row" key={log.id}>
      <Tag tone={log.status === "EXECUTED" ? "good" : "warn"}>{log.status}</Tag>
      <code>{log.retcode}</code>
      <span>{log.brokerComment}</span>
      <small>{log.queueItemId}</small>
      {log.timestamp ? (
        <time dateTime={log.timestamp}>{new Date(log.timestamp).toLocaleTimeString()}</time>
      ) : null}
    </div>
  );
}
