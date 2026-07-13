import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useFocusTrap } from "../hooks/useFocusTrap";

export interface GlobalAliasPayload {
  rawSymbol: string;
  canonicalSymbol: string;
  providerId?: string;
}

export interface AccountMappingPayload {
  accountId: string;
  direct?: boolean;
  rawSymbol?: string;
  canonicalSymbol?: string;
  brokerSymbol?: string;
  prefix?: string;
  suffix?: string;
  includeSymbols?: string[];
  excludeSymbols?: string[];
}

type Scope = "global" | "provider" | "account" | "account-direct";

function commaList(value: string): string[] {
  return value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

export function SymbolMappingModal({
  open,
  defaultAccountId,
  availableBrokerSymbols,
  defaultProviderId,
  onClose,
  onSaveGlobalAlias,
  onSaveAccountMapping,
}: {
  open: boolean;
  defaultAccountId: string;
  availableBrokerSymbols: string[];
  defaultProviderId?: string;
  onClose: () => void;
  onSaveGlobalAlias: (payload: GlobalAliasPayload) => Promise<void> | void;
  onSaveAccountMapping: (payload: AccountMappingPayload) => Promise<void> | void;
}) {
  const formRef = useRef<HTMLFormElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const [scope, setScope] = useState<Scope>("global");

  useEffect(() => {
    if (open) setScope("global");
  }, [open]);

  useFocusTrap(dialogRef, open, onClose);

  if (!open) return null;

  async function performSave() {
    const form = formRef.current;
    if (!form) return;
    if (!form.reportValidity()) return;
    const data = new FormData(form);
    if (scope === "global" || scope === "provider") {
      await onSaveGlobalAlias({
        rawSymbol: String(data.get("aliasRaw") ?? "").trim(),
        canonicalSymbol: String(data.get("aliasCanonical") ?? "").trim(),
        providerId: scope === "provider" ? String(data.get("providerId") ?? "").trim() : undefined,
      });
    } else if (scope === "account-direct") {
      await onSaveAccountMapping({
        accountId: String(data.get("accountId") ?? "").trim(),
        rawSymbol: String(data.get("directRaw") ?? "").trim(),
        brokerSymbol: String(data.get("directBroker") ?? "").trim(),
        direct: true,
      });
    } else {
      await onSaveAccountMapping({
        accountId: String(data.get("accountId") ?? "").trim(),
        canonicalSymbol: String(data.get("accountCanonical") ?? "").trim(),
        brokerSymbol: String(data.get("accountBroker") ?? "").trim(),
        prefix: String(data.get("accountPrefix") ?? "").trim(),
        suffix: String(data.get("accountSuffix") ?? "").trim(),
        includeSymbols: commaList(String(data.get("accountInclude") ?? "")),
        excludeSymbols: commaList(String(data.get("accountExclude") ?? "")),
      });
    }
  }

  return (
    <div className="modal-overlay">
      <div
        aria-labelledby="symbol-mapping-title"
        aria-modal="true"
        className="modal modal-wide"
        ref={dialogRef}
        role="dialog"
      >
        <header className="modal-head">
          <div>
            <h2 id="symbol-mapping-title">Add symbol mapping</h2>
            <span className="modal-subtle">
              Layer aliases or per-account overrides on top of the parser
            </span>
          </div>
          <button aria-label="Close mapping" className="icon-btn" onClick={onClose} type="button">
            <X size={14} aria-hidden="true" />
          </button>
        </header>

        <form
          className="modal-form"
          key={scope}
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void performSave();
          }}
          ref={formRef}
        >
          <section className="config-section">
            <h3 className="config-section-title">Scope</h3>
            <div className="segmented-control" role="tablist" aria-label="Mapping scope">
              <button
                aria-selected={scope === "global"}
                className={scope === "global" ? "active" : ""}
                onClick={() => setScope("global")}
                role="tab"
                type="button"
              >
                Global alias
              </button>
              <button
                aria-selected={scope === "provider"}
                className={scope === "provider" ? "active" : ""}
                onClick={() => setScope("provider")}
                role="tab"
                type="button"
              >
                Provider alias
              </button>
              <button
                aria-selected={scope === "account"}
                className={scope === "account" ? "active" : ""}
                onClick={() => setScope("account")}
                role="tab"
                type="button"
              >
                Account-specific
              </button>
              <button
                aria-selected={scope === "account-direct"}
                className={scope === "account-direct" ? "active" : ""}
                onClick={() => setScope("account-direct")}
                role="tab"
                type="button"
              >
                Provider → broker
              </button>
            </div>
            <p className="config-hint config-hint-soft">
              Flow: provider symbol → canonical (broker-agnostic) → your broker's exact symbol. The
              canonical lets one alias serve every account; the account-specific broker symbol is
              where you pick the right one when a broker lists several (XAUUSD.raw, XAUUSD.pro, …).
            </p>
            <p className="config-hint config-hint-soft">
              {scope === "global"
                ? "Global alias: maps a provider symbol to a canonical symbol everywhere. Example: GOLD → XAUUSD."
                : scope === "provider"
                  ? "Provider alias: maps a provider symbol to a canonical symbol for one Telegram provider only."
                  : scope === "account-direct"
                    ? "Provider → broker: maps one provider symbol directly to an exact broker symbol for this account."
                    : "Account-specific: maps a canonical symbol to this account's exact broker symbol (and optional suffix / include-exclude rules)."}
            </p>
          </section>

          {scope === "global" || scope === "provider" ? (
            <section className="config-section">
              <h3 className="config-section-title">
                {scope === "provider" ? "Provider alias" : "Global alias"}
              </h3>
              {scope === "provider" ? (
                <label className="config-field">
                  <span className="config-label">Provider ID</span>
                  <input
                    aria-label="Provider alias provider ID"
                    defaultValue={defaultProviderId ?? ""}
                    name="providerId"
                    type="text"
                  />
                </label>
              ) : null}
              <div className="config-row">
                <label className="config-field config-field-grow">
                  <span className="config-label">Provider symbol</span>
                  <input
                    aria-label="Provider symbol"
                    defaultValue=""
                    name="aliasRaw"
                    placeholder="GOLD"
                    type="text"
                  />
                </label>
                <label className="config-field config-field-grow">
                  <span className="config-label">Canonical symbol (broker-agnostic)</span>
                  <input
                    aria-label="Canonical symbol"
                    defaultValue=""
                    name="aliasCanonical"
                    placeholder="XAUUSD"
                    type="text"
                  />
                </label>
              </div>
            </section>
          ) : scope === "account-direct" ? (
            <>
              <section className="config-section">
                <h3 className="config-section-title">Target account</h3>
                <label className="config-field">
                  <span className="config-label">Mapping account ID</span>
                  <input
                    aria-label="Mapping account ID"
                    readOnly
                    value={defaultAccountId}
                    name="accountId"
                    type="text"
                  />
                </label>
              </section>
              <section className="config-section">
                <h3 className="config-section-title">Direct broker mapping</h3>
                <div className="config-row">
                  <label className="config-field config-field-grow">
                    <span className="config-label">Provider symbol</span>
                    <input
                      aria-label="Direct provider symbol"
                      defaultValue=""
                      name="directRaw"
                      placeholder="GOLD"
                      required
                      type="text"
                    />
                  </label>
                  <label className="config-field config-field-grow">
                    <span className="config-label">Broker symbol (this account)</span>
                    <select
                      aria-label="Direct broker symbol for this account"
                      defaultValue=""
                      disabled={availableBrokerSymbols.length === 0}
                      name="directBroker"
                      required
                    >
                      <option disabled value="">
                        {availableBrokerSymbols.length
                          ? "Select a broker symbol"
                          : "No broker symbols reported"}
                      </option>
                      {availableBrokerSymbols.map((symbol) => (
                        <option key={symbol} value={symbol}>
                          {symbol}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              </section>
            </>
          ) : (
            <>
              <section className="config-section">
                <h3 className="config-section-title">Target account</h3>
                <label className="config-field">
                  <span className="config-label">Mapping account ID</span>
                  <input
                    aria-label="Mapping account ID"
                    readOnly
                    value={defaultAccountId}
                    name="accountId"
                    type="text"
                  />
                </label>
              </section>

              <section className="config-section">
                <h3 className="config-section-title">Symbol override</h3>
                <div className="config-row">
                  <label className="config-field config-field-grow">
                    <span className="config-label">Canonical symbol</span>
                    <input
                      aria-label="Canonical symbol"
                      defaultValue=""
                      name="accountCanonical"
                      placeholder="XAUUSD"
                      type="text"
                    />
                  </label>
                  <label className="config-field config-field-grow">
                    <span className="config-label">Broker symbol (this account)</span>
                    <input
                      aria-label="Broker symbol for this account"
                      defaultValue=""
                      name="accountBroker"
                      placeholder="XAUUSD.raw"
                      type="text"
                    />
                  </label>
                  <label className="config-field config-field-narrow">
                    <span className="config-label">Mapping prefix</span>
                    <input
                      aria-label="Mapping prefix"
                      defaultValue=""
                      name="accountPrefix"
                      placeholder="m."
                      type="text"
                    />
                  </label>
                  <label className="config-field config-field-narrow">
                    <span className="config-label">Mapping suffix</span>
                    <input
                      aria-label="Mapping suffix"
                      defaultValue=""
                      name="accountSuffix"
                      placeholder=".raw or r"
                      type="text"
                    />
                  </label>
                </div>
              </section>

              <section className="config-section">
                <h3 className="config-section-title">Filters</h3>
                <p className="config-hint config-hint-soft">
                  Comma-separated lists. Include = only allow these symbols on the account; Exclude
                  = block these even if the parser resolves to them.
                </p>
                <div className="config-row">
                  <label className="config-field config-field-grow">
                    <span className="config-label">Mapping include symbols</span>
                    <input
                      aria-label="Mapping include symbols"
                      defaultValue=""
                      name="accountInclude"
                      placeholder="XAUUSD.r, EURUSD.raw"
                      type="text"
                    />
                  </label>
                  <label className="config-field config-field-grow">
                    <span className="config-label">Mapping exclude symbols</span>
                    <input
                      aria-label="Mapping exclude symbols"
                      defaultValue=""
                      name="accountExclude"
                      placeholder="US30.raw"
                      type="text"
                    />
                  </label>
                </div>
              </section>
            </>
          )}

          <div className="modal-foot">
            <button className="btn btn-ghost" onClick={onClose} type="button">
              Close
            </button>
            <button
              aria-label={
                scope === "global"
                  ? "Save global alias"
                  : scope === "account-direct"
                    ? "Save direct mapping"
                    : "Save account mapping"
              }
              className="btn btn-primary"
              onClick={() => void performSave()}
              type="button"
            >
              {scope === "global"
                ? "Save global alias"
                : scope === "account-direct"
                  ? "Save direct mapping"
                  : "Save account mapping"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
