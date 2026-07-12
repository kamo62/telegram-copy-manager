import type { LucideIcon } from "lucide-react";
import {
  Activity,
  Bot,
  ChevronRight,
  KeyRound,
  Link2,
  Plus,
  Server,
  Settings2,
} from "lucide-react";

export const navItems: Array<[string, string, LucideIcon]> = [
  ["dashboard", "Live", Activity],
  ["telegram", "Telegram Setup", KeyRound],
  ["mt5", "Linked Accounts", Server],
  ["settings", "Settings", Settings2],
];

export interface SidebarAccount {
  id: string;
  label: string;
  status: string;
  online: boolean;
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
  heldCount = 0,
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
  heldCount?: number;
}) {
  return (
    <aside className="sidebar" aria-label="Primary">
      <div className="brand-lockup">
        <div className="brand-mark">
          <Bot size={16} aria-hidden="true" />
        </div>
        <div>
          <strong>Telegram TC</strong>
          <span>MT5 copy desk</span>
        </div>
      </div>
      <nav>
        {navItems.map(([id, label, Icon]) => {
          const isLive = id === "dashboard";
          const isActive = activeView === id;
          return (
            <div className="sidebar-group" key={id}>
              <button
                className={
                  isActive && (!isLive || (!selectedAccountId && !selectedSlotId)) ? "active" : ""
                }
                onClick={() => {
                  onNavigate(id);
                  if (isLive) {
                    onSelectAccount?.(null);
                    onSelectSlot?.(null);
                  }
                }}
                type="button"
              >
                <Icon size={15} aria-hidden="true" />
                {label}
                {isLive && accounts.length > 0 ? (
                  <span className="sidebar-count" title={`${accounts.length} accounts`}>
                    {accounts.length}
                  </span>
                ) : null}
                {isLive && heldCount > 0 ? (
                  <span
                    className="sidebar-count sidebar-count-held"
                    title={`${heldCount} held signals`}
                  >
                    {heldCount}
                  </span>
                ) : null}
              </button>
              {isLive && (accounts.length > 0 || pendingSlots.length > 0 || onAddAccount) ? (
                <ul className="sidebar-children" aria-label="MT5 accounts">
                  {accounts.map((account) => {
                    const accountActive = isActive && selectedAccountId === account.id;
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
                          <ChevronRight aria-hidden="true" size={11} />
                        </button>
                      </li>
                    );
                  })}
                  {pendingSlots.map((slot) => {
                    const slotActive = isActive && selectedSlotId === slot.id;
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
                          <Link2
                            aria-hidden="true"
                            className="sidebar-child-dot pending"
                            size={13}
                          />
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
              ) : null}
            </div>
          );
        })}
      </nav>
    </aside>
  );
}
