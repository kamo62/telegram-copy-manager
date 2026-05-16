import { ArrowRight, Plug, Plus, Server } from "lucide-react";
import { AccountRow } from "../components/AccountRow";
import { EmptyState } from "../components/EmptyState";
import { Panel } from "../components/Panel";

export function LinkedAccountsPage({
  slots,
  accounts,
  providers = [],
  providerLinks = [],
  onCreateSlot,
  onEditProviderLinks,
  variant = "page",
}: {
  slots: Array<{
    id: string;
    name: string;
    linkCode: string;
    status: string;
    accountNumber: string;
    server: string;
  }>;
  accounts: Parameters<typeof AccountRow>[0]["account"][];
  providers?: Array<{ id: string; title: string }>;
  providerLinks?: Array<{ accountId: string; providerId: string; enabled: boolean }>;
  onCreateSlot: (event: React.FormEvent<HTMLFormElement>) => void;
  onEditProviderLinks?: () => void;
  variant?: "page" | "live";
}) {
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
            {pendingSlots.map((slot) => (
              <li className="linked-slot-row" key={slot.id}>
                <div className="linked-slot-icon" aria-hidden="true">
                  <Server size={14} />
                </div>
                <div className="linked-slot-body">
                  <strong>{slot.name}</strong>
                  <span>
                    Link code <code>{slot.linkCode}</code> · waiting for EA
                  </span>
                  <span>Open this slot from the sidebar to see EA setup steps.</span>
                </div>
              </li>
            ))}
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
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </Panel>
  );
}
