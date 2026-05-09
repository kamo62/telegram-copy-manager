import { Tag } from "./Tag";

export function AccountRow({
  account,
}: {
  account: {
    id: string;
    accountNumber: string;
    server: string;
    marginMode: string;
    heartbeatStatus: string;
    openPositionCount?: number;
    pendingOrderCount?: number;
  };
}) {
  return (
    <div className="row-item" key={account.id}>
      <div>
        <strong>{account.accountNumber}</strong>
        <span>
          {account.server} · {account.marginMode}
        </span>
        <span>
          {account.openPositionCount ?? 0} positions · {account.pendingOrderCount ?? 0} orders
        </span>
      </div>
      <Tag tone={account.heartbeatStatus === "online" ? "good" : "warn"}>
        {account.heartbeatStatus}
      </Tag>
    </div>
  );
}
