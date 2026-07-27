import type { LucideIcon } from "lucide-react";
import {
  Activity,
  ChevronRight,
  Inbox,
  KeyRound,
  Link2,
  Plus,
  Settings2,
  Split,
  UsersRound,
} from "lucide-react";

const deskItems: Array<[string, string, LucideIcon]> = [
  ["dashboard", "Operations", Activity],
  ["parser", "Review queue", Inbox],
];

const setupItems: Array<[string, string, LucideIcon]> = [
  ["providers", "Providers", UsersRound],
  ["mapping", "Symbols", Split],
  ["telegram", "Telegram", KeyRound],
  ["settings", "Settings", Settings2],
];

export const navItems = [...deskItems, ...setupItems];

export interface SidebarAccount {
  id: string;
  label: string;
  status: string;
  online: boolean;
  broker: string;
  currency?: string;
  equity?: number;
}

export interface SidebarPendingSlot {
  id: string;
  name: string;
  linkCode: string;
}

export function Sidebar({
  activeView,
  onNavigate,
  accounts = [],
  pendingSlots = [],
  selectedAccountId,
  selectedSlotId,
  onSelectAccount,
  onSelectSlot,
  onAddAccount,
  reviewCount = 0,
}: {
  activeView: string;
  onNavigate: (id: string) => void;
  accounts?: SidebarAccount[];
  pendingSlots?: SidebarPendingSlot[];
  selectedAccountId?: string | null;
  selectedSlotId?: string | null;
  onSelectAccount?: (accountId: string | null) => void;
  onSelectSlot?: (slotId: string | null) => void;
  onAddAccount?: () => void;
  reviewCount?: number;
}) {
  return (
    <aside className="sidebar" aria-label="Primary">
      <div className="brand-lockup">
        <div>
          <strong>Telegram TC</strong>
          <span className="brand-kicker">MT5 copy desk</span>
        </div>
      </div>
      <span className="sidebar-nav-label">Desk</span>
      <nav>
        {deskItems.map(([id, label, Icon]) => {
          const isOperations = id === "dashboard";
          const isActive = activeView === id;
          return (
            <div className="sidebar-group" key={id}>
              <button
                className={
                  isActive && (!isOperations || (!selectedAccountId && !selectedSlotId))
                    ? "active"
                    : ""
                }
                onClick={() => {
                  onNavigate(id);
                  if (isOperations) {
                    onSelectAccount?.(null);
                    onSelectSlot?.(null);
                  }
                }}
                type="button"
              >
                <Icon size={15} aria-hidden="true" />
                {label}
                {id === "parser" && reviewCount > 0 ? (
                  <span
                    className="sidebar-count sidebar-count-held"
                    title={`${reviewCount} ${reviewCount === 1 ? "signal needs" : "signals need"} review`}
                  >
                    {reviewCount}
                  </span>
                ) : null}
              </button>
            </div>
          );
        })}
      </nav>

      <span className="sidebar-nav-label sidebar-accounts-label">Accounts</span>
      <ul className="sidebar-children sidebar-account-list" aria-label="MT5 accounts">
        {accounts.map((account) => {
          const accountActive = activeView === "dashboard" && selectedAccountId === account.id;
          return (
            <li key={account.id}>
              <button
                aria-current={accountActive ? "true" : undefined}
                className={`sidebar-child ${accountActive ? "active" : ""}`}
                onClick={() => {
                  onNavigate("dashboard");
                  onSelectAccount?.(account.id);
                  onSelectSlot?.(null);
                }}
                type="button"
              >
                <span
                  aria-hidden="true"
                  className={`sidebar-child-dot ${account.online ? "ok" : "off"}`}
                />
                <span className="sidebar-child-label">{account.label}</span>
                <span aria-hidden="true" className="sidebar-account-meta">
                  {account.broker}
                  {typeof account.equity === "number"
                    ? ` · ${compactMoney(account.equity, account.currency)}`
                    : ""}
                </span>
                <ChevronRight aria-hidden="true" size={11} />
              </button>
            </li>
          );
        })}
        {pendingSlots.map((slot) => {
          const slotActive = activeView === "dashboard" && selectedSlotId === slot.id;
          return (
            <li key={`slot-${slot.id}`}>
              <button
                aria-current={slotActive ? "true" : undefined}
                className={`sidebar-child sidebar-child-pending ${slotActive ? "active" : ""}`}
                onClick={() => {
                  onNavigate("dashboard");
                  onSelectAccount?.(null);
                  onSelectSlot?.(slot.id);
                }}
                title={`Waiting for EA · link code ${slot.linkCode}`}
                type="button"
              >
                <Link2 aria-hidden="true" className="sidebar-child-dot pending" size={13} />
                <span className="sidebar-child-label">{slot.name || "Pending slot"}</span>
                <span className="sidebar-child-meta">{slot.linkCode}</span>
              </button>
            </li>
          );
        })}
        {onAddAccount ? (
          <li>
            <button
              className="sidebar-child sidebar-child-add"
              onClick={() => {
                onNavigate("mt5");
                onAddAccount();
              }}
              type="button"
            >
              <Plus aria-hidden="true" size={11} />
              <span className="sidebar-child-label">Add account</span>
            </button>
          </li>
        ) : null}
      </ul>

      <span className="sidebar-nav-label sidebar-setup-label">Setup</span>
      <nav>
        {setupItems.map(([id, label, Icon]) => (
          <button
            className={activeView === id ? "active" : ""}
            key={id}
            onClick={() => onNavigate(id)}
            type="button"
          >
            <Icon size={15} aria-hidden="true" />
            {label}
          </button>
        ))}
      </nav>
      <div className="sidebar-foot">
        <span className="sidebar-foot-mark" aria-hidden="true" />
        <div>
          <strong>Local execution</strong>
          <span>Cloud-independent trade path</span>
        </div>
      </div>
    </aside>
  );
}

function compactMoney(value: number, currency = "USD"): string {
  return new Intl.NumberFormat(undefined, {
    currency,
    maximumFractionDigits: 2,
    notation: "compact",
    style: "currency",
  }).format(value);
}
