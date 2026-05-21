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
  onDelete,
  onToggle,
  onExport,
  loading = false,
  accounts = [],
  providerLinks = [],
  onToggleAccountLink,
}: {
  providers: ProviderRowData[];
  onConfigure: (provider: ProviderRowData) => void;
  onDelete: (provider: ProviderRowData) => void;
  onToggle: (provider: ProviderRowData) => void;
  onExport?: () => void;
  loading?: boolean;
  accounts?: ProviderAccountLinkOption[];
  providerLinks?: Array<{ accountId: string; providerId: string; enabled: boolean }>;
  onToggleAccountLink?: (accountId: string, providerId: string, enabled: boolean) => void;
}) {
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
      {accounts.length > 0 ? (
        <p className="panel-intro">
          Use the <strong>Copied by</strong> chips to choose which MT5 accounts copy each provider.
          Provider must be Enabled before any account can copy it.
        </p>
      ) : null}
      <ProvidersTable
        accounts={accounts}
        loading={loading}
        onConfigure={onConfigure}
        onDelete={onDelete}
        onToggle={onToggle}
        onToggleAccountLink={onToggleAccountLink}
        providerLinks={providerLinks}
        providers={providers}
      />
    </Panel>
  );
}
