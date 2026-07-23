import { CheckCircle2, CircleSlash } from "lucide-react";
import { Tag } from "./Tag";

export function AccountRow({
  account,
}: {
  account: {
    id: string;
    accountNumber: string;
    nickname?: string | null;
    server: string;
    marginMode: string;
    heartbeatStatus: string;
    eaVersion?: string;
    openPositionCount?: number;
    pendingOrderCount?: number;
  };
}) {
  const online = account.heartbeatStatus === "online";
  return (
    <header className="account-row" key={account.id}>
      <div className="account-row-icon" aria-hidden="true">
        {online ? <CheckCircle2 size={14} /> : <CircleSlash size={14} />}
      </div>
      <div className="account-row-body">
        <strong>{account.nickname || account.accountNumber || account.id}</strong>
        <span className="account-row-meta">
          {account.nickname ? <span>{account.accountNumber || account.id}</span> : null}
          {account.nickname ? (
            <span className="dot-sep" aria-hidden="true">
              ·
            </span>
          ) : null}
          <span>{account.server}</span>
          <span className="dot-sep" aria-hidden="true">
            ·
          </span>
          <span>{account.marginMode}</span>
          <span className="dot-sep" aria-hidden="true">
            ·
          </span>
          <span>EA {account.eaVersion ?? "legacy/unknown"}</span>
        </span>
        <span className="account-row-stats">
          <span>
            <strong>{account.openPositionCount ?? 0}</strong> positions
          </span>
          <span>
            <strong>{account.pendingOrderCount ?? 0}</strong> pending
          </span>
        </span>
      </div>
      <Tag tone={online ? "good" : "warn"}>{account.heartbeatStatus}</Tag>
    </header>
  );
}
