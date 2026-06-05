import { Settings as SettingsIcon } from "lucide-react";
import { useLocale } from "../contexts/LocaleContext";
import { useSortableTable } from "../hooks/useSortableTable";
import { formatLot, formatPips, formatRelativeTime } from "../lib/format";
import { winRateTone } from "../lib/thresholds";
import { Money } from "./Money";
import { SkeletonRow } from "./Skeleton";
import { Stat } from "./Stat";
import { Tag } from "./Tag";

export interface ProviderRowData {
  id: string;
  dialogId: string;
  title: string;
  enabled: boolean;
  parserMode: string;
  lockedSymbol?: string;
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
  gainPct?: number;
}

export interface ProviderAccountLinkOption {
  id: string;
  label: string;
}

export function ProvidersTable({
  providers,
  onConfigure,
  loading = false,
  accounts = [],
  providerLinks = [],
  onToggleAccountLink,
  currency,
  accountId = null,
}: {
  providers: ProviderRowData[];
  onConfigure: (provider: ProviderRowData) => void;
  loading?: boolean;
  accounts?: ProviderAccountLinkOption[];
  providerLinks?: Array<{ accountId: string; providerId: string; enabled: boolean }>;
  onToggleAccountLink?: (accountId: string, providerId: string, enabled: boolean) => void;
  currency?: string;
  // When set, the table is scoped to one account: a single Copy toggle + per-account
  // Configure replace the global chip matrix and Pause/Remove actions.
  accountId?: string | null;
}) {
  const { locale } = useLocale();
  const isAccountMode = Boolean(accountId);
  const showCopyColumn = accounts.length > 0;
  // base stat columns (11) + optional Copy column + optional Actions column
  const columnCount = 11 + (showCopyColumn ? 1 : 0) + (isAccountMode ? 1 : 0);
  const isCopiedBy = (provider: ProviderRowData, id: string) =>
    providerLinks.some(
      (link) => link.accountId === id && link.providerId === provider.id && link.enabled,
    );
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
            {showCopyColumn ? <th scope="col">{isAccountMode ? "Copy" : "Copied by"}</th> : null}
            {isAccountMode ? <th aria-label="Actions" scope="col" /> : null}
          </tr>
        </thead>
        <tbody>
          {loading && providers.length === 0
            ? Array.from({ length: 6 }, (_, index) => (
                <SkeletonRow columns={columnCount} key={`provider-skeleton-${index}`} />
              ))
            : null}
          {!loading && providers.length === 0 ? (
            <tr className="data-table-empty">
              <td colSpan={columnCount}>
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
                {provider.winRate === undefined ? (
                  "—"
                ) : (
                  <Stat
                    value={provider.winRate * 100}
                    unit="percent"
                    locale={locale}
                    tone={winRateTone(provider.winRate) ?? "neutral"}
                  />
                )}
              </td>
              <td className="num-cell">
                <Money value={provider.averageDrawdown} currency={currency} locale={locale} />
              </td>
              <td className="num-cell">
                <Money value={provider.pnl} currency={currency} locale={locale} signTone />
              </td>
              <td className="num-cell">
                <Money value={provider.profit} currency={currency} locale={locale} signTone />
              </td>
              <td className="num-cell">
                <Stat value={provider.gainPct} unit="percent" locale={locale} signTone />
              </td>
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
              {showCopyColumn ? (
                <td className="provider-account-cell">
                  {isAccountMode && accountId ? (
                    (() => {
                      const linked = isCopiedBy(provider, accountId);
                      const disabled = !provider.enabled || !onToggleAccountLink;
                      return (
                        <button
                          aria-label={`${linked ? "Stop copying" : "Copy"} ${provider.title} on this account`}
                          aria-pressed={linked}
                          className={`account-chip ${linked ? "is-on" : "is-off"}`}
                          disabled={disabled}
                          onClick={() => onToggleAccountLink?.(accountId, provider.id, !linked)}
                          title={
                            disabled
                              ? "Enable the provider before copying"
                              : linked
                                ? "Copying — click to stop"
                                : "Not copying — click to copy"
                          }
                          type="button"
                        >
                          {linked ? "Copying" : "Copy"}
                        </button>
                      );
                    })()
                  ) : (
                    <div className="provider-account-chips">
                      {accounts.filter((account) => isCopiedBy(provider, account.id)).length ===
                      0 ? (
                        <span className="data-table-subtle">No accounts</span>
                      ) : (
                        accounts
                          .filter((account) => isCopiedBy(provider, account.id))
                          .map((account) => (
                            <span className="account-chip is-on is-readonly" key={account.id}>
                              {account.label}
                            </span>
                          ))
                      )}
                    </div>
                  )}
                </td>
              ) : null}
              {isAccountMode ? (
                <td className="data-table-actions">
                  <button
                    aria-label={`Configure ${provider.title} for this account`}
                    className="icon-btn"
                    onClick={() => onConfigure(provider)}
                    title={`Configure ${provider.title} for this account`}
                    type="button"
                  >
                    <SettingsIcon size={14} aria-hidden="true" />
                  </button>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
