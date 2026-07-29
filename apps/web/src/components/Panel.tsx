import { ChevronDown } from "lucide-react";
import { useState } from "react";

export function Panel({
  actions,
  activeTab,
  children,
  className = "",
  collapsible = false,
  defaultOpen = true,
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
   * Lets the operator fold this panel away. Use on secondary or diagnostic
   * panels that would otherwise push the primary work off screen.
   */
  collapsible?: boolean;
  defaultOpen?: boolean;
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
  const [open, setOpen] = useState(defaultOpen);
  const collapsed = collapsible && !open;
  const showHeader = !hideTitle || hasTabs || Boolean(actions) || collapsible;
  return (
    <section
      aria-label={hideTitle ? title : undefined}
      className={`panel ${className}`}
      data-testid={testId}
    >
      {showHeader ? (
        <header>
          {collapsible ? (
            <button
              aria-expanded={open}
              className={`panel-collapse-toggle ${open ? "is-open" : ""}`}
              onClick={() => setOpen((value) => !value)}
              type="button"
            >
              <ChevronDown aria-hidden="true" size={15} />
              <span className="visually-hidden">
                {open ? `Collapse ${title}` : `Expand ${title}`}
              </span>
            </button>
          ) : null}
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
      {collapsed ? null : tabs && activeTab && onTabChange ? (
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
