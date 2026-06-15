import { Download } from "lucide-react";
import { Panel } from "../components/Panel";
import {
  type ProviderAccountLinkOption,
  type ProviderRowData,
  ProvidersTable,
} from "../components/ProvidersTable";

export function ProvidersPage({
  providers,
  onConfigure,
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
    <Panel className="wide-panel" title="Providers">
      <div className="provider-panel-toolbar">
        <button
          aria-label="Export provider performance"
          className="btn btn-ghost btn-small provider-export-btn"
          onClick={onExport}
          type="button"
        >
          <Download size={14} aria-hidden="true" />
          Export
        </button>
      </div>
      {isAccountMode ? (
        <p className="panel-intro">
          Stats, copy status, and configuration for {accountLabel ?? "this account"}. Use Copy to
          start or stop copying a provider, and Configure to set lot size, risk, and take-profit.
          Enable or remove providers from Telegram Setup.
        </p>
      ) : (
        <p className="panel-intro">
          Aggregated performance across all copying accounts. Select an account in the sidebar to
          see its own stats and to start copying or configuring a provider.
        </p>
      )}
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
    </Panel>
  );
}
