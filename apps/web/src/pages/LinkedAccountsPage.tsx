import { ArrowRight, Hand, Plug, Plus, Server, Trash2 } from "lucide-react";
import type { ExternalBrokerPosition } from "../App";
import { AccountRow } from "../components/AccountRow";
import { EmptyState } from "../components/EmptyState";
import { Money } from "../components/Money";
import { Panel } from "../components/Panel";
import { useLocale } from "../contexts/LocaleContext";
import { formatLot, formatNumber } from "../lib/format";

type LinkedAccount = Parameters<typeof AccountRow>[0]["account"] & {
  externalPositions?: ExternalBrokerPosition[];
  externalOrders?: ExternalBrokerPosition[];
  externalPositionCount?: number;
  externalOrderCount?: number;
  currency?: string;
};

export function LinkedAccountsPage({
  slots,
  accounts,
  providers = [],
  providerLinks = [],
  onCreateSlot,
  onEditProviderLinks,
  onDeleteAccount,
  onDeleteSlot,
  variant = "page",
}: {
  slots: Array<{
    id: string;
    name: string;
    linkCode: string;
    status: string;
    accountNumber: string;
    server: string;
    createdAt?: string;
  }>;
  accounts: LinkedAccount[];
  providers?: Array<{ id: string; title: string }>;
  providerLinks?: Array<{ accountId: string; providerId: string; enabled: boolean }>;
  onCreateSlot: (event: React.FormEvent<HTMLFormElement>) => void;
  onEditProviderLinks?: () => void;
  onDeleteAccount?: (account: LinkedAccount) => void;
  onDeleteSlot?: (slot: { id: string; name: string; status: string }) => void;
  variant?: "page" | "live";
}) {
  const { locale } = useLocale();
  const linkedAccountIds = new Set(accounts.map((account) => account.id));
  const pendingSlots = slots.filter(
    (slot) => !slot.accountNumber && !linkedAccountIds.has(slot.id),
  );
  const showEmpty = accounts.length === 0 && pendingSlots.length === 0;
  return (
    <Panel
      className="wide-panel"
      title={variant === "live" ? "Live MT5 accounts" : "Linked accounts"}
    >
      {showEmpty ? (
        <EmptyState
          body="Create a link slot below, paste the code into the EA's LinkCode input, then attach the EA to an MT5 chart."
          glyph={<Plug aria-hidden="true" size={28} />}
          title="Connect your first MT5 Expert Advisor"
        />
      ) : null}

      <form className="linked-accounts-create" onSubmit={onCreateSlot}>
        <div className="linked-accounts-create-field">
          <label htmlFor="slot-name">Slot name</label>
          <input
            className="settings-input"
            id="slot-name"
            name="slotName"
            placeholder="e.g. Main Demo, Live · Raw Trading"
            type="text"
          />
        </div>
        <button className="btn btn-primary" type="submit">
          <Plus aria-hidden="true" size={13} />
          Create link slot
        </button>
      </form>

      {pendingSlots.length > 0 ? (
        <section className="linked-section">
          <h3 className="linked-section-title">Pending link slots</h3>
          <ul className="linked-slot-list">
            {pendingSlots.map((slot) => {
              const expired = slot.status === "expired";
              const expiresAt = slot.createdAt
                ? Date.parse(slot.createdAt) + 24 * 60 * 60 * 1000
                : 0;
              const hoursLeft = expiresAt
                ? Math.max(0, Math.ceil((expiresAt - Date.now()) / 3_600_000))
                : null;
              return (
                <li
                  className={`linked-slot-row ${expired ? "linked-slot-row-expired" : ""}`}
                  key={slot.id}
                >
                  <div className="linked-slot-icon" aria-hidden="true">
                    <Server size={14} />
                  </div>
                  <div className="linked-slot-body">
                    <strong>{slot.name}</strong>
                    <span>
                      Link code <code>{slot.linkCode}</code> ·{" "}
                      {expired ? "expired" : "waiting for EA"}
                    </span>
                    <span>
                      {expired
                        ? "This link code can no longer pair with an EA."
                        : hoursLeft === null
                          ? "Open this slot from the sidebar to see EA setup steps."
                          : `Expires in ${hoursLeft}h`}
                    </span>
                  </div>
                  {onDeleteSlot && (slot.status === "waiting" || expired) ? (
                    <button
                      aria-label={`Delete slot ${slot.name}`}
                      className="icon-btn linked-slot-delete"
                      onClick={() => onDeleteSlot(slot)}
                      title="Delete link slot"
                      type="button"
                    >
                      <Trash2 aria-hidden="true" size={13} />
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {accounts.length > 0 ? (
        <section className="linked-section">
          <h3 className="linked-section-title">Connected accounts</h3>
          <ul className="linked-account-list">
            {accounts.map((account) => {
              const copiedProviders = providers.filter((provider) =>
                providerLinks.some(
                  (link) =>
                    link.accountId === account.id &&
                    link.providerId === provider.id &&
                    link.enabled,
                ),
              );
              return (
                <li className="linked-account-card" key={account.id}>
                  <AccountRow account={account} />
                  {onDeleteAccount ? (
                    <div className="linked-account-actions">
                      <button
                        className="btn btn-ghost btn-small btn-danger"
                        onClick={() => onDeleteAccount(account)}
                        type="button"
                      >
                        <Trash2 aria-hidden="true" size={12} />
                        Remove account
                      </button>
                    </div>
                  ) : null}
                  {providers.length > 0 ? (
                    <div className="provider-link-block">
                      <div className="provider-link-summary">
                        <span className="provider-link-label">Copying from</span>
                        {copiedProviders.length > 0 ? (
                          <ul className="provider-link-summary-list">
                            {copiedProviders.map((provider) => (
                              <li key={provider.id}>{provider.title}</li>
                            ))}
                          </ul>
                        ) : (
                          <span className="provider-link-summary-empty">
                            No providers assigned. Pick providers in the Providers tab.
                          </span>
                        )}
                      </div>
                      {onEditProviderLinks ? (
                        <button
                          className="btn btn-ghost btn-small"
                          onClick={onEditProviderLinks}
                          type="button"
                        >
                          Edit in Providers
                          <ArrowRight aria-hidden="true" size={12} />
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                  <ExternalPositionsBlock account={account} locale={locale} />
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </Panel>
  );
}

/**
 * Read-only block listing positions / pending orders the broker sees on this
 * account that our EA didn't open — manual MT5 clicks, mobile/web terminal
 * trades, other EAs running on the same account. The app never modifies these;
 * they're surfaced so the operator can see what else is consuming margin /
 * affecting equity / contributing to drawdown beyond app-driven trades.
 */
function ExternalPositionsBlock({ account, locale }: { account: LinkedAccount; locale: string }) {
  const positions = account.externalPositions ?? [];
  const orders = account.externalOrders ?? [];
  if (positions.length === 0 && orders.length === 0) return null;
  const totalProfit = positions.reduce((acc, p) => acc + (p.profit ?? 0), 0);
  return (
    <div className="external-positions-block">
      <header className="external-positions-head">
        <Hand aria-hidden="true" size={13} />
        <span className="external-positions-label">External activity</span>
        <span className="external-positions-meta">
          {positions.length} position{positions.length === 1 ? "" : "s"} · {orders.length} pending ·
          floating P/L{" "}
          <Money value={totalProfit} currency={account.currency} locale={locale} signTone />
        </span>
      </header>
      <p className="external-positions-hint">
        Opened outside this app (manual terminal, mobile, web, or another EA). The app does not
        manage these — they're shown so total account drawdown and margin usage are explainable.
      </p>
      {positions.length > 0 ? (
        <ul className="external-positions-list">
          {positions.map((position) => (
            <li className="external-position-row" key={position.ticket}>
              <span className={`external-position-side ${position.type === 0 ? "buy" : "sell"}`}>
                {position.type === 0 ? "BUY" : "SELL"}
              </span>
              <strong className="external-position-symbol">{position.symbol}</strong>
              <span className="external-position-vol">{formatLot(position.volume)}</span>
              <span className="external-position-price">
                @ {formatNumber(position.openPrice, { locale, maximumFractionDigits: 5 })}
              </span>
              {position.sl > 0 ? (
                <span className="external-position-stop">
                  SL {formatNumber(position.sl, { locale, maximumFractionDigits: 5 })}
                </span>
              ) : (
                <span className="external-position-stop external-position-stop-missing">no SL</span>
              )}
              {position.tp > 0 ? (
                <span className="external-position-stop">
                  TP {formatNumber(position.tp, { locale, maximumFractionDigits: 5 })}
                </span>
              ) : null}
              {position.profit !== undefined ? (
                <Money
                  value={position.profit}
                  currency={account.currency}
                  locale={locale}
                  signTone
                  className="external-position-profit"
                />
              ) : null}
              <small className="external-position-source">
                #{position.ticket} · magic {position.magic}
                {position.comment ? ` · ${position.comment}` : ""}
              </small>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
