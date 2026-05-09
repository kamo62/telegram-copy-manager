import type { LucideIcon } from "lucide-react";
import {
  Activity,
  Bot,
  KeyRound,
  ListChecks,
  RadioTower,
  Server,
  Settings2,
  SlidersHorizontal,
  TerminalSquare,
  Workflow,
} from "lucide-react";

export const navItems: Array<[string, string, LucideIcon]> = [
  ["dashboard", "Dashboard", Activity],
  ["telegram", "Telegram Setup", KeyRound],
  ["providers", "Providers", RadioTower],
  ["parser", "Parser Lab", ListChecks],
  ["trades", "Trade Lifecycle", Workflow],
  ["mt5", "MT5 Accounts", Server],
  ["mapping", "Symbol Mapping", SlidersHorizontal],
  ["logs", "Execution Logs", TerminalSquare],
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
