import { Download } from "lucide-react";
import { Panel } from "../components/Panel";
import { ProviderHealthCard } from "../components/ProviderHealthCard";
import {
  type ProviderAccountLinkOption,
  type ProviderRowData,
  ProvidersTable,
} from "../components/ProvidersTable";
import { Tag } from "../components/Tag";

export function ProvidersPage({
  providers,
  onConfigure,
  onToggleProvider,
  onRemoveProvider,
  onExport,
  loading = false,
  accounts = [],
  providerLinks = [],
  onToggleAccountLink,
  currency,
  accountId = null,
  accountLabel,
}: {
  providers: ProviderRowData[];
  onConfigure: (provider: ProviderRowData) => void;
  onToggleProvider?: (provider: ProviderRowData) => void;
  onRemoveProvider?: (provider: ProviderRowData) => void;
  onExport?: () => void;
  loading?: boolean;
  accounts?: ProviderAccountLinkOption[];
  providerLinks?: Array<{ accountId: string; providerId: string; enabled: boolean }>;
  onToggleAccountLink?: (accountId: string, providerId: string, enabled: boolean) => void;
  currency?: string;
  accountId?: string | null;
  accountLabel?: string;
}) {
  const isAccountMode = Boolean(accountId);
  return (
    <Panel
      actions={
        <button
          aria-label="Export provider performance"
          className="btn btn-ghost btn-small provider-export-btn"
          onClick={onExport}
          type="button"
        >
          <Download size={14} aria-hidden="true" />
          Export
        </button>
      }
      className="wide-panel"
      title="Providers"
    >
      {isAccountMode ? (
        <p className="panel-intro">
          Stats, copy status, and configuration shown for{" "}
          <strong>{accountLabel ?? "this account"}</strong>. Use <strong>Copy</strong> to start or
          stop copying a provider here, and <strong>Configure</strong> to set this account's lot
          size, risk, and take-profit. Enable or remove a provider from this hub.
        </p>
      ) : (
        <p className="panel-intro">
          Aggregated performance, health, and global provider monitoring. Select an account in the
          sidebar for its copy settings.
        </p>
      )}
      {!isAccountMode ? (
        <section className="provider-monitoring" aria-label="Provider monitoring">
          <header className="provider-monitoring-head">
            <div>
              <span>Global lifecycle</span>
              <h3>Provider monitoring</h3>
            </div>
            <span>{providers.length} configured</span>
          </header>
          <ul className="provider-monitoring-list">
            {providers.map((provider) => (
              <li className="provider-monitoring-row" key={provider.id}>
                <div>
                  <strong>{provider.title}</strong>
                  <Tag tone={provider.enabled ? "good" : "muted"}>
                    {provider.enabled ? "Auto-copy enabled" : "Provider paused"}
                  </Tag>
                </div>
                <div className="provider-monitoring-actions">
                  <button
                    aria-label={`Configure ${provider.title}`}
                    className="btn btn-ghost btn-small"
                    onClick={() => onConfigure(provider)}
                    type="button"
                  >
                    Configure
                  </button>
                  <button
                    aria-label={`${provider.enabled ? "Pause" : "Enable"} auto-copy for ${provider.title}`}
                    className="btn btn-ghost btn-small"
                    onClick={() => onToggleProvider?.(provider)}
                    type="button"
                  >
                    {provider.enabled ? "Pause" : "Enable"}
                  </button>
                  <button
                    aria-label={`Remove provider ${provider.title}`}
                    className="btn btn-ghost btn-small btn-destructive-subtle"
                    onClick={() => onRemoveProvider?.(provider)}
                    type="button"
                  >
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <ProvidersTable
        accountId={accountId}
        accounts={accounts}
        currency={currency}
        loading={loading}
        onConfigure={onConfigure}
        onToggleAccountLink={onToggleAccountLink}
        providerLinks={providerLinks}
        providers={providers}
      />
      {providers.length > 0 ? (
        <div className="provider-health-strip">
          {providers.map((provider) => (
            <ProviderHealthCard key={provider.id} providerId={provider.id} title={provider.title} />
          ))}
        </div>
      ) : null}
    </Panel>
  );
}
