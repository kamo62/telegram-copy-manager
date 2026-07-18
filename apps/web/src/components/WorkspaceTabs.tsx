import { useEffect, useRef } from "react";

export type TabId =
  | "summary"
  | "performance"
  | "providers"
  | "history"
  | "equity-guardian"
  | "symbols"
  | "logs";

export const tabOptions: Array<{ id: TabId; label: string }> = [
  { id: "summary", label: "Summary" },
  { id: "performance", label: "Performance" },
  { id: "providers", label: "Providers" },
  { id: "history", label: "History" },
  { id: "equity-guardian", label: "Equity Guardian" },
  { id: "symbols", label: "Symbol Settings" },
  { id: "logs", label: "Logs" },
];

export function WorkspaceTabs({
  value,
  onChange,
}: {
  value: TabId;
  onChange: (id: TabId) => void;
}) {
  const tabsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const active = tabsRef.current?.querySelector<HTMLElement>(".workspace-tab.active");
    active?.scrollIntoView?.({ block: "nearest", inline: "center" });
  }, [value]);

  return (
    <div
      className="workspace-tabs"
      ref={tabsRef}
      role="tablist"
      aria-label="Live workspace sections"
    >
      {tabOptions.map((tab) => (
        <button
          aria-controls={`tabpanel-${tab.id}`}
          aria-selected={value === tab.id}
          className={`workspace-tab ${value === tab.id ? "active" : ""}`}
          id={`tab-${tab.id}`}
          key={tab.id}
          onClick={() => onChange(tab.id)}
          role="tab"
          tabIndex={value === tab.id ? 0 : -1}
          type="button"
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
