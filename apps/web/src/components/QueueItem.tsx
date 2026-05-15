import { ArrowRightCircle } from "lucide-react";
import { Tag } from "./Tag";

export function QueueItem({
  item,
}: {
  item: { id: string; commandType: string; symbol: string; status: string };
}) {
  const tone = item.status === "PENDING" ? "warn" : item.status === "EXECUTED" ? "good" : "muted";
  return (
    <article className="queue-item" key={item.id}>
      <span className="queue-item-icon" aria-hidden="true">
        <ArrowRightCircle size={14} />
      </span>
      <div className="queue-item-body">
        <strong>{item.commandType}</strong>
        <span>{item.symbol}</span>
      </div>
      <Tag tone={tone}>{item.status}</Tag>
    </article>
  );
}
