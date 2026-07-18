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
  const tabPanelId = tabs
    ? `panel-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-content`
    : undefined;
  return (
    <section className={`panel ${className}`} data-testid={testId}>
      <header>
        <h2>{title}</h2>
        {tabs && activeTab && onTabChange ? (
          <div className="panel-tabs" role="tablist">
            {tabs.map((tab) => (
              <button
                aria-selected={activeTab === tab}
                aria-controls={tabPanelId}
                className={`panel-tab ${activeTab === tab ? "active" : ""}`}
                id={`${tabPanelId}-${tab.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
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
      {tabs && activeTab && onTabChange ? (
        <div
          aria-labelledby={`${tabPanelId}-${activeTab.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
          id={tabPanelId}
          role="tabpanel"
        >
          {children}
        </div>
      ) : (
        children
      )}
    </section>
  );
}
