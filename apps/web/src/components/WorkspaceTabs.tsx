export type TabId =
  | "performance"
  | "providers"
  | "history"
  | "equity-guardian"
  | "symbols"
  | "logs";

export const tabOptions: Array<{ id: TabId; label: string }> = [
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
  return (
    <div className="workspace-tabs" role="tablist" aria-label="Live workspace sections">
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
