export function Panel({
  activeTab,
  children,
  className = "",
  onTabChange,
  tabs,
  testId,
  title,
}: {
  activeTab?: string;
  children: React.ReactNode;
  className?: string;
  onTabChange?: (tab: string) => void;
  tabs?: string[];
  testId?: string;
  title: string;
}) {
  return (
    <section className={`panel ${className}`} data-testid={testId}>
      <header>
        <h2>{title}</h2>
        {tabs && activeTab && onTabChange ? (
          <div className="panel-tabs" role="tablist">
            {tabs.map((tab) => (
              <button
                aria-selected={activeTab === tab}
                className={`panel-tab ${activeTab === tab ? "active" : ""}`}
                key={tab}
                onClick={() => onTabChange(tab)}
                role="tab"
                type="button"
              >
                {tab}
              </button>
            ))}
          </div>
        ) : null}
      </header>
      {children}
    </section>
  );
}
