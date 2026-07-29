export function Panel({
  actions,
  activeTab,
  children,
  className = "",
  hideTitle = false,
  onTabChange,
  tabs,
  testId,
  title,
}: {
  /**
   * Panel-level controls, right-aligned in the header. Use this rather than a
   * toolbar row: every direct panel child takes var(--space-5) from
   * `.panel > *:not(header)`, so a row wrapping one button costs ~75px of
   * height and reads as a gap.
   */
  actions?: React.ReactNode;
  activeTab?: string;
  children: React.ReactNode;
  className?: string;
  /**
   * Set when the page title already says this, so the panel would be the third
   * place the same word appears after the page heading and the workspace tab.
   * The title still labels the section for assistive tech.
   */
  hideTitle?: boolean;
  onTabChange?: (tab: string) => void;
  tabs?: string[];
  testId?: string;
  title: string;
}) {
  const tabPanelId = tabs
    ? `panel-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-content`
    : undefined;
  const hasTabs = Boolean(tabs && activeTab && onTabChange);
  const showHeader = !hideTitle || hasTabs || Boolean(actions);
  return (
    <section
      aria-label={hideTitle ? title : undefined}
      className={`panel ${className}`}
      data-testid={testId}
    >
      {showHeader ? (
        <header>
          {hideTitle ? null : <h2>{title}</h2>}
          {tabs && activeTab && onTabChange ? (
            <div className="segmented-control panel-tabs" role="tablist">
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
          {actions ? <div className="panel-header-actions">{actions}</div> : null}
        </header>
      ) : null}
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
