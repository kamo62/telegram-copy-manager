import { Tag } from "./Tag";

export function QueueItem({
  item,
}: {
  item: { id: string; commandType: string; symbol: string; status: string };
}) {
  return (
    <div className="queue-item" key={item.id}>
      <Tag tone={item.status === "PENDING" ? "warn" : "good"}>{item.status}</Tag>
      <strong>{item.commandType}</strong>
      <span>{item.symbol}</span>
    </div>
  );
}
