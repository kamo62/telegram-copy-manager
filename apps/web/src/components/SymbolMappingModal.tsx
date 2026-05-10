import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

export interface GlobalAliasPayload {
  rawSymbol: string;
  canonicalSymbol: string;
}

export interface AccountMappingPayload {
  accountId: string;
  canonicalSymbol: string;
  brokerSymbol: string;
  suffix: string;
  includeSymbols: string[];
  excludeSymbols: string[];
}

type Scope = "global" | "account";

function commaList(value: string): string[] {
  return value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

export function SymbolMappingModal({
  open,
  defaultAccountId,
  onClose,
  onSaveGlobalAlias,
  onSaveAccountMapping,
}: {
  open: boolean;
  defaultAccountId: string;
  onClose: () => void;
  onSaveGlobalAlias: (payload: GlobalAliasPayload) => Promise<void> | void;
  onSaveAccountMapping: (payload: AccountMappingPayload) => Promise<void> | void;
}) {
  const formRef = useRef<HTMLFormElement | null>(null);
  const [scope, setScope] = useState<Scope>("global");

  useEffect(() => {
    if (open) setScope("global");
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  function performSave() {
    const form = formRef.current;
    if (!form) return;
    const data = new FormData(form);
    if (scope === "global") {
      void onSaveGlobalAlias({
        rawSymbol: String(data.get("aliasRaw") ?? "").trim(),
        canonicalSymbol: String(data.get("aliasCanonical") ?? "").trim(),
      });
    } else {
      void onSaveAccountMapping({
        accountId: String(data.get("accountId") ?? "").trim(),
        canonicalSymbol: String(data.get("accountCanonical") ?? "").trim(),
        brokerSymbol: String(data.get("accountBroker") ?? "").trim(),
        suffix: String(data.get("accountSuffix") ?? "").trim(),
        includeSymbols: commaList(String(data.get("accountInclude") ?? "")),
        excludeSymbols: commaList(String(data.get("accountExclude") ?? "")),
      });
    }
  }

  return (
    <div
      aria-labelledby="symbol-mapping-title"
      aria-modal="true"
      className="modal-overlay"
      onClick={onClose}
      role="dialog"
    >
      <div className="modal modal-wide" onClick={(event) => event.stopPropagation()}>
        <header className="modal-head">
          <div>
            <h2 id="symbol-mapping-title">Add symbol mapping</h2>
            <span className="modal-subtle">
              Layer aliases or per-account overrides on top of the parser
            </span>
          </div>
          <button
            aria-label="Close mapping"
            className="icon-btn"
            onClick={onClose}
            type="button"
          >
            <X size={14} aria-hidden="true" />
          </button>
        </header>

        <form
          className="modal-form modal-form-clean"
          key={scope}
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            performSave();
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
                aria-selected={scope === "account"}
                className={scope === "account" ? "active" : ""}
                onClick={() => setScope("account")}
                role="tab"
                type="button"
              >
                Account-specific
              </button>
            </div>
            <p className="config-hint config-hint-soft">
              {scope === "global"
                ? "Maps a raw provider symbol to the app's canonical symbol everywhere. Example: GOLD → XAUUSD."
                : "Overrides the broker symbol for a specific MT5 account, plus its suffix and include/exclude rules."}
            </p>
          </section>

          {scope === "global" ? (
            <section className="config-section">
              <h3 className="config-section-title">Global alias</h3>
              <div className="config-row">
                <label className="config-field config-field-grow">
                  <span className="config-label">Alias raw symbol</span>
                  <input
                    aria-label="Alias raw symbol"
                    defaultValue=""
                    name="aliasRaw"
                    placeholder="GOLD"
                    type="text"
                  />
                </label>
                <label className="config-field config-field-grow">
                  <span className="config-label">Alias canonical symbol</span>
                  <input
                    aria-label="Alias canonical symbol"
                    defaultValue=""
                    name="aliasCanonical"
                    placeholder="XAUUSD"
                    type="text"
                  />
                </label>
              </div>
            </section>
          ) : (
            <>
              <section className="config-section">
                <h3 className="config-section-title">Target account</h3>
                <label className="config-field">
                  <span className="config-label">Mapping account ID</span>
                  <input
                    aria-label="Mapping account ID"
                    defaultValue={defaultAccountId}
                    name="accountId"
                    type="text"
                  />
                </label>
              </section>

              <section className="config-section">
                <h3 className="config-section-title">Symbol override</h3>
                <div className="config-row">
                  <label className="config-field config-field-grow">
                    <span className="config-label">Mapping canonical symbol</span>
                    <input
                      aria-label="Mapping canonical symbol"
                      defaultValue=""
                      name="accountCanonical"
                      placeholder="XAUUSD"
                      type="text"
                    />
                  </label>
                  <label className="config-field config-field-grow">
                    <span className="config-label">Mapping broker symbol</span>
                    <input
                      aria-label="Mapping broker symbol"
                      defaultValue=""
                      name="accountBroker"
                      placeholder="XAUUSD.r"
                      type="text"
                    />
                  </label>
                  <label className="config-field config-field-narrow">
                    <span className="config-label">Mapping suffix</span>
                    <input
                      aria-label="Mapping suffix"
                      defaultValue=""
                      name="accountSuffix"
                      placeholder=".raw"
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
            <button className="btn-ghost" onClick={onClose} type="button">
              Close
            </button>
            <button
              aria-label={scope === "global" ? "Save global alias" : "Save account mapping"}
              className="btn-primary"
              onClick={performSave}
              type="button"
            >
              {scope === "global" ? "Save global alias" : "Save account mapping"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
