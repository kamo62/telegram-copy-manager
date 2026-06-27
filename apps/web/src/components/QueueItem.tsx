import { ArrowRightCircle } from "lucide-react";
import { Tag } from "./Tag";

export function QueueItem({
  item,
}: {
  item: {
    id: string;
    commandType: string;
    symbol: string;
    status: string;
    volume?: number | null;
    riskPercent?: number | null;
  };
}) {
  const tone = item.status === "PENDING" ? "warn" : item.status === "EXECUTED" ? "good" : "muted";
  const volumePreview =
    typeof item.volume === "number" && item.volume > 0
      ? `≈ ${item.volume} lots`
      : typeof item.riskPercent === "number" && item.riskPercent > 0
        ? `≈ ${item.riskPercent}% risk`
        : null;
  return (
    <article className="queue-item" key={item.id}>
      <span className="queue-item-icon" aria-hidden="true">
        <ArrowRightCircle size={14} />
      </span>
      <div className="queue-item-body">
        <strong>{item.commandType}</strong>
        <span>{item.symbol}</span>
      </div>
      {volumePreview ? <span className="queue-item-volume">{volumePreview}</span> : null}
      <Tag tone={tone}>{item.status}</Tag>
    </article>
  );
}
