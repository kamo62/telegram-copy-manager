import { X } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
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

type Tab = "global" | "account";
type Source = "provider" | "canonical";
type AdvancedField = "prefix" | "suffix" | "includeSymbols" | "excludeSymbols";

function commaList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Failed to save symbol mapping";
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
  const [tab, setTab] = useState<Tab>("global");
  const [onlyProvider, setOnlyProvider] = useState(false);
  const [source, setSource] = useState<Source>("canonical");
  const advancedDirty = useRef<Partial<Record<AdvancedField, true>>>({});
  const [saveError, setSaveError] = useState("");
  const hasFocusedAccount = Boolean(defaultAccountId);

  useLayoutEffect(() => {
    if (!open) return;
    setTab("global");
    setOnlyProvider(false);
    setSource("canonical");
    advancedDirty.current = {};
    setSaveError("");
  }, [open]);

  useFocusTrap(dialogRef, open, onClose);

  if (!open) return null;

  function selectTab(nextTab: Tab) {
    if (nextTab === "account" && !hasFocusedAccount) return;
    setTab(nextTab);
    advancedDirty.current = {};
    setSaveError("");
  }

  function markAdvancedDirty(field: AdvancedField) {
    advancedDirty.current[field] = true;
  }

  async function performSave() {
    const form = formRef.current;
    if (!form?.reportValidity()) return;
    const data = new FormData(form);
    setSaveError("");

    try {
      if (tab === "global") {
        await onSaveGlobalAlias({
          rawSymbol: String(data.get("aliasRaw") ?? "").trim(),
          canonicalSymbol: String(data.get("aliasCanonical") ?? "").trim(),
          providerId: onlyProvider ? String(data.get("providerId") ?? "").trim() : undefined,
        });
        return;
      }

      if (!defaultAccountId) {
        setSaveError("Choose a focused account before adding an account mapping");
        return;
      }

      const sourceSymbol = String(data.get("accountSource") ?? "").trim();
      const brokerSymbol = String(data.get("accountBroker") ?? "").trim();
      if (source === "provider") {
        await onSaveAccountMapping({
          accountId: defaultAccountId,
          rawSymbol: sourceSymbol,
          brokerSymbol,
          direct: true,
        });
        return;
      }

      await onSaveAccountMapping({
        accountId: defaultAccountId,
        canonicalSymbol: sourceSymbol,
        ...(brokerSymbol ? { brokerSymbol } : {}),
        ...(advancedDirty.current.prefix
          ? { prefix: String(data.get("accountPrefix") ?? "").trim() }
          : {}),
        ...(advancedDirty.current.suffix
          ? { suffix: String(data.get("accountSuffix") ?? "").trim() }
          : {}),
        ...(advancedDirty.current.includeSymbols
          ? { includeSymbols: commaList(String(data.get("accountInclude") ?? "")) }
          : {}),
        ...(advancedDirty.current.excludeSymbols
          ? { excludeSymbols: commaList(String(data.get("accountExclude") ?? "")) }
          : {}),
      });
    } catch (error) {
      setSaveError(errorMessage(error));
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
            <X aria-hidden="true" size={14} />
          </button>
        </header>

        <form
          className="modal-form"
          key={tab}
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void performSave();
          }}
          ref={formRef}
        >
          <section className="config-section">
            <div className="segmented-control" role="tablist" aria-label="Mapping scope">
              <button
                aria-selected={tab === "global"}
                className={tab === "global" ? "active" : ""}
                onClick={() => selectTab("global")}
                role="tab"
                type="button"
              >
                Global
              </button>
              <button
                aria-selected={tab === "account"}
                className={tab === "account" ? "active" : ""}
                disabled={!hasFocusedAccount}
                onClick={() => selectTab("account")}
                role="tab"
                type="button"
              >
                Account
              </button>
            </div>
            {!hasFocusedAccount ? (
              <p className="config-hint config-hint-soft">
                Open Symbol Settings from an account to add an account mapping.
              </p>
            ) : null}
          </section>

          {tab === "global" ? (
            <section className="config-section">
              <div className="config-row">
                <label className="config-field config-field-grow">
                  <span className="config-label">Provider symbol</span>
                  <input
                    aria-label="Provider symbol"
                    name="aliasRaw"
                    placeholder="GOLD"
                    required
                    type="text"
                  />
                </label>
                <label className="config-field config-field-grow">
                  <span className="config-label">Canonical symbol</span>
                  <input
                    aria-label="Canonical symbol"
                    name="aliasCanonical"
                    placeholder="XAUUSD"
                    required
                    type="text"
                  />
                </label>
              </div>
              <label className="config-check">
                <input
                  checked={onlyProvider}
                  onChange={(event) => setOnlyProvider(event.target.checked)}
                  type="checkbox"
                />
                <span>Only for one provider</span>
              </label>
              {onlyProvider ? (
                <label className="config-field">
                  <span className="config-label">Provider ID</span>
                  <input
                    aria-label="Provider ID"
                    defaultValue={defaultProviderId ?? ""}
                    name="providerId"
                    required
                    type="text"
                  />
                </label>
              ) : null}
            </section>
          ) : (
            <>
              <section className="config-section">
                <label className="config-field">
                  <span className="config-label">Mapping account ID</span>
                  <input
                    aria-label="Mapping account ID"
                    readOnly
                    type="text"
                    value={defaultAccountId}
                  />
                </label>
              </section>

              <section className="config-section">
                <fieldset className="config-fieldset">
                  <legend className="config-label">Map from</legend>
                  <label className="config-check">
                    <input
                      aria-label="Map from provider symbol"
                      checked={source === "provider"}
                      name="mapSource"
                      onChange={() => setSource("provider")}
                      type="radio"
                    />
                    <span>Provider symbol</span>
                  </label>
                  <label className="config-check">
                    <input
                      aria-label="Map from canonical symbol"
                      checked={source === "canonical"}
                      name="mapSource"
                      onChange={() => setSource("canonical")}
                      type="radio"
                    />
                    <span>Canonical symbol</span>
                  </label>
                </fieldset>
                <div className="config-row">
                  <label className="config-field config-field-grow">
                    <span className="config-label">
                      {source === "provider" ? "Provider symbol" : "Canonical symbol"}
                    </span>
                    <input
                      aria-label="Account source symbol"
                      name="accountSource"
                      placeholder={source === "provider" ? "GOLD" : "XAUUSD"}
                      required
                      type="text"
                    />
                  </label>
                  {source === "provider" ? (
                    <label className="config-field config-field-grow">
                      <span className="config-label">Broker symbol (this account)</span>
                      <select
                        aria-label="Broker symbol for this account"
                        disabled={availableBrokerSymbols.length === 0}
                        name="accountBroker"
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
                  ) : (
                    <label className="config-field config-field-grow">
                      <span className="config-label">Broker symbol (this account)</span>
                      <input
                        aria-label="Broker symbol for this account"
                        list="available-broker-symbols"
                        name="accountBroker"
                        placeholder="XAUUSD.raw"
                        type="text"
                      />
                      <datalist id="available-broker-symbols">
                        {availableBrokerSymbols.map((symbol) => (
                          <option key={symbol} value={symbol} />
                        ))}
                      </datalist>
                    </label>
                  )}
                </div>
              </section>

              <details className="config-section">
                <summary>Advanced: account symbol rules</summary>
                <p className="config-hint config-hint-soft">
                  Leave rules untouched to preserve the account's existing settings. Comma-separated
                  lists intentionally replace the saved list when edited.
                </p>
                <div className="config-row">
                  <label className="config-field config-field-narrow">
                    <span className="config-label">Mapping prefix</span>
                    <input
                      aria-label="Mapping prefix"
                      name="accountPrefix"
                      onBlur={() => markAdvancedDirty("prefix")}
                      onChange={() => markAdvancedDirty("prefix")}
                      placeholder="m."
                      type="text"
                    />
                  </label>
                  <label className="config-field config-field-narrow">
                    <span className="config-label">Mapping suffix</span>
                    <input
                      aria-label="Mapping suffix"
                      name="accountSuffix"
                      onBlur={() => markAdvancedDirty("suffix")}
                      onChange={() => markAdvancedDirty("suffix")}
                      placeholder=".raw or r"
                      type="text"
                    />
                  </label>
                  <label className="config-field config-field-grow">
                    <span className="config-label">Mapping include symbols</span>
                    <input
                      aria-label="Mapping include symbols"
                      name="accountInclude"
                      onBlur={() => markAdvancedDirty("includeSymbols")}
                      onChange={() => markAdvancedDirty("includeSymbols")}
                      placeholder="XAUUSD.r, EURUSD.raw"
                      type="text"
                    />
                  </label>
                  <label className="config-field config-field-grow">
                    <span className="config-label">Mapping exclude symbols</span>
                    <input
                      aria-label="Mapping exclude symbols"
                      name="accountExclude"
                      onBlur={() => markAdvancedDirty("excludeSymbols")}
                      onChange={() => markAdvancedDirty("excludeSymbols")}
                      placeholder="US30.raw"
                      type="text"
                    />
                  </label>
                </div>
              </details>
            </>
          )}

          {saveError ? (
            <p className="setup-form-error" role="alert">
              {saveError}
            </p>
          ) : null}

          <div className="modal-foot">
            <button className="btn btn-ghost" onClick={onClose} type="button">
              Close
            </button>
            <button
              aria-label={tab === "global" ? "Save global alias" : "Save account mapping"}
              className="btn btn-primary"
              onClick={() => void performSave()}
              type="button"
            >
              {tab === "global" ? "Save global alias" : "Save account mapping"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
