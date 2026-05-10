import type { LucideIcon } from "lucide-react";
import { Activity, Bot, KeyRound, Server, Settings2 } from "lucide-react";

export const navItems: Array<[string, string, LucideIcon]> = [
  ["dashboard", "Live", Activity],
  ["telegram", "Telegram Setup", KeyRound],
  ["mt5", "Linked Accounts", Server],
  ["settings", "Settings", Settings2],
];

export function Sidebar({
  activeView,
  onNavigate,
}: {
  activeView: string;
  onNavigate: (id: string) => void;
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
        {navItems.map(([id, label, Icon]) => (
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
    </aside>
  );
}
