import { Settings as SettingsIcon } from "lucide-react";
import { useLocale } from "../contexts/LocaleContext";
import { useSortableTable } from "../hooks/useSortableTable";
import {
  formatLot,
  formatNumber,
  formatPercent,
  formatPips,
  formatRelativeTime,
} from "../lib/format";
import { SkeletonRow } from "./Skeleton";
import { Tag } from "./Tag";

export interface ProviderRowData {
  id: string;
  dialogId: string;
  title: string;
  enabled: boolean;
  parserMode: string;
  riskProfile: string;
  lotSize: number;
  riskMode?: "fixed" | "percent";
  riskAmount?: number;
  takeProfitLevels?: Array<{
    leg: number;
    percentage: number;
    strategy:
      | { kind: "set-sl-to-entry"; offsetPips: number }
      | { kind: "set-sl-to-tp"; tpLeg: number; offsetPips: number }
      | { kind: "no-change" };
  }>;
  runner?: {
    enabled: boolean;
    lotSize: number;
    slBehavior: "break-even" | "last-tp" | "trail";
    trailPips: number;
  };
  lastMessageAt: string;
  ingestionStatus?: string;
  pips?: number;
  winRate?: number;
  averageDrawdown?: number;
  pnl?: number;
  profit?: number;
  gain?: number;
}

export interface ProviderAccountLinkOption {
  id: string;
  label: string;
}

export function ProvidersTable({
  providers,
  onConfigure,
  onDelete,
  onToggle,
  loading = false,
  accounts = [],
  providerLinks = [],
  onToggleAccountLink,
}: {
  providers: ProviderRowData[];
  onConfigure: (provider: ProviderRowData) => void;
  onDelete: (provider: ProviderRowData) => void;
  onToggle: (provider: ProviderRowData) => void;
  loading?: boolean;
  accounts?: ProviderAccountLinkOption[];
  providerLinks?: Array<{ accountId: string; providerId: string; enabled: boolean }>;
  onToggleAccountLink?: (accountId: string, providerId: string, enabled: boolean) => void;
}) {
  const { locale } = useLocale();
  const { sortedRows, toggle, sortAria } = useSortableTable<ProviderRowData, keyof ProviderRowData>(
    providers,
    "title",
  );
  const sortable = (key: keyof ProviderRowData, label: string, numeric = false) => (
    <th
      aria-sort={sortAria(key)}
      className={`data-table-th-sortable ${numeric ? "num" : ""}`}
      onClick={() => toggle(key)}
      scope="col"
    >
      {label}
      <span className="sort-indicator" aria-hidden="true" />
    </th>
  );

  return (
    <div className="data-table-wrap">
      <table className="data-table providers-table">
        <thead>
          <tr>
            {sortable("title", "Name")}
            {sortable("lotSize", "Lots", true)}
            <th className="num" scope="col">
              TP #
            </th>
            <th className="num" scope="col">
              SL
            </th>
            <th className="num" scope="col">
              Pips
            </th>
            {sortable("winRate", "W/L %", true)}
            <th className="num" scope="col">
              Avg. drawdown
            </th>
            <th className="num" scope="col">
              P/L
            </th>
            <th className="num" scope="col">
              Profit
            </th>
            <th className="num" scope="col">
              Gain
            </th>
            <th scope="col">Status</th>
            {accounts.length > 0 ? <th scope="col">Copied by</th> : null}
            <th aria-label="Actions" scope="col" />
          </tr>
        </thead>
        <tbody>
          {loading && providers.length === 0
            ? Array.from({ length: 6 }, (_, index) => (
                <SkeletonRow
                  columns={accounts.length > 0 ? 13 : 12}
                  key={`provider-skeleton-${index}`}
                />
              ))
            : null}
          {!loading && providers.length === 0 ? (
            <tr className="data-table-empty">
              <td colSpan={accounts.length > 0 ? 13 : 12}>
                No providers configured yet. Add one from Telegram Setup.
              </td>
            </tr>
          ) : null}
          {sortedRows.map((provider) => (
            <tr key={provider.id}>
              <th className="data-table-row-head" scope="row">
                <strong>{provider.title}</strong>
                <span className="data-table-subtle">
                  {provider.parserMode} · {formatRelativeTime(provider.lastMessageAt, locale)}
                </span>
              </th>
              <td className="num-cell">{formatLot(provider.lotSize)}</td>
              <td className="num-cell muted">—</td>
              <td className="num-cell muted">—</td>
              <td className="num-cell">{formatPips(provider.pips, locale)}</td>
              <td className="num-cell">
                {provider.winRate === undefined
                  ? "—"
                  : formatPercent(provider.winRate * 100, { locale })}
              </td>
              <td className="num-cell">{formatNumber(provider.averageDrawdown, { locale })}</td>
              <td className="num-cell">{formatNumber(provider.pnl, { locale })}</td>
              <td className="num-cell">{formatNumber(provider.profit, { locale })}</td>
              <td className="num-cell">{formatNumber(provider.gain, { locale })}</td>
              <td>
                <Tag tone={provider.enabled ? "good" : "muted"}>
                  {provider.enabled ? "Auto-copy enabled" : "Provider paused"}
                </Tag>
                {provider.ingestionStatus && provider.enabled ? (
                  <Tag tone={provider.ingestionStatus === "polling" ? "good" : "warn"}>
                    {provider.ingestionStatus === "polling" ? "Polling" : "Telegram offline"}
                  </Tag>
                ) : null}
              </td>
              {accounts.length > 0 ? (
                <td className="provider-account-cell">
                  <div className="provider-account-chips">
                    {accounts.map((account) => {
                      const linked = providerLinks.some(
                        (link) =>
                          link.accountId === account.id &&
                          link.providerId === provider.id &&
                          link.enabled,
                      );
                      const disabled = !provider.enabled || !onToggleAccountLink;
                      return (
                        <button
                          aria-label={`${linked ? "Disable" : "Enable"} ${provider.title} for ${account.label}`}
                          aria-pressed={linked}
                          className={`account-chip ${linked ? "is-on" : "is-off"}`}
                          disabled={disabled}
                          key={account.id}
                          onClick={() => onToggleAccountLink?.(account.id, provider.id, !linked)}
                          title={
                            disabled
                              ? "Enable the provider before linking accounts"
                              : `${linked ? "Disable" : "Enable"} for ${account.label}`
                          }
                          type="button"
                        >
                          {account.label}
                        </button>
                      );
                    })}
                  </div>
                </td>
              ) : null}
              <td className="data-table-actions">
                <button
                  aria-label={`Configure ${provider.title}`}
                  className="icon-btn"
                  onClick={() => onConfigure(provider)}
                  title={`Configure ${provider.title}`}
                  type="button"
                >
                  <SettingsIcon size={14} aria-hidden="true" />
                </button>
                <button
                  aria-label={`${provider.enabled ? "Pause" : "Enable"} auto-copy for ${provider.title}`}
                  className="btn btn-ghost btn-small"
                  onClick={() => onToggle(provider)}
                  type="button"
                >
                  {provider.enabled ? "Pause" : "Enable"}
                </button>
                <button
                  aria-label={`Remove provider ${provider.title}`}
                  className="btn btn-ghost btn-small btn-destructive-subtle"
                  onClick={() => onDelete(provider)}
                  type="button"
                >
                  Remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
