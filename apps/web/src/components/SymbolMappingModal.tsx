import { X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
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

export interface BrokerSymbolMetadata {
  symbol: string;
  bid?: number | null;
  ask?: number | null;
}

export interface SymbolMappingSeed {
  source: "provider" | "canonical";
  sourceSymbol: string;
  brokerSymbol?: string;
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

function normalizedSymbol(value: string) {
  return value.replace(/[^a-z0-9]/gi, "").toUpperCase();
}

function editDistance(left: string, right: string) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    let diagonal = previous[0] ?? 0;
    previous[0] = row;
    for (let column = 1; column <= right.length; column += 1) {
      const above = previous[column] ?? 0;
      previous[column] = Math.min(
        (previous[column - 1] ?? 0) + 1,
        above + 1,
        diagonal + (left[row - 1] === right[column - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return previous[right.length] ?? left.length;
}

function brokerScore(symbol: string, canonical: string, query: string, quoted: boolean) {
  const candidate = normalizedSymbol(symbol);
  const target = normalizedSymbol(canonical);
  const needle = normalizedSymbol(query);
  const likeness = (value: string) => {
    if (!value || !target) return 0;
    if (value === target) return 1000;
    if (value.startsWith(target)) return 800;
    if (value.includes(target)) return 600;
    if (target.includes(value)) return 500;
    return Math.max(0, 300 - editDistance(value, target));
  };
  const search = needle
    ? candidate === needle
      ? 800
      : candidate.startsWith(needle)
        ? 500
        : candidate.includes(needle)
          ? 300
          : 0
    : 0;
  return (quoted ? 1_000_000 : 0) + Math.max(likeness(candidate), search);
}

function guessAffix(symbols: string[], canonical: string) {
  const target = normalizedSymbol(canonical);
  if (!target) return undefined;
  const counts = new Map<string, { kind: "prefix" | "suffix"; count: number }>();
  for (const symbol of symbols) {
    const upper = symbol.toUpperCase();
    const core = upper.match(/[A-Z]{6}/);
    const index = core?.index ?? -1;
    if (index < 0 || !core) continue;
    const prefix = symbol.slice(0, index);
    const suffix = symbol.slice(index + core[0].length);
    if (prefix) {
      const key = `prefix:${prefix}`;
      const current = counts.get(key);
      counts.set(key, { kind: "prefix", count: (current?.count ?? 0) + 1 });
    }
    if (suffix) {
      const key = `suffix:${suffix}`;
      const current = counts.get(key);
      counts.set(key, { kind: "suffix", count: (current?.count ?? 0) + 1 });
    }
  }
  const best = [...counts.entries()].sort((left, right) => right[1].count - left[1].count)[0];
  const majority = Math.max(2, Math.ceil(symbols.length * 0.6));
  if (!best || best[1].count < majority) return undefined;
  return { value: best[0].slice(best[0].indexOf(":") + 1), kind: best[1].kind };
}

function BrokerSymbolCombobox({
  symbols,
  metadata,
  canonicalSymbol,
  value,
  onChange,
  onSelect,
  required,
}: {
  symbols: string[];
  metadata: BrokerSymbolMetadata[];
  canonicalSymbol: string;
  value: string;
  onChange: (value: string) => void;
  onSelect: (value: string) => void;
  required: boolean;
}) {
  const [open, setOpen] = useState(true);
  const [activeIndex, setActiveIndex] = useState(0);
  const quoted = useMemo(
    () =>
      new Set(
        metadata
          .filter((item) => Number(item.bid) > 0 && Number(item.ask) > 0)
          .map((item) => item.symbol.toUpperCase()),
      ),
    [metadata],
  );
  const ranked = useMemo(
    () =>
      [...new Set(symbols)]
        .filter((symbol) => !value || normalizedSymbol(symbol).includes(normalizedSymbol(value)))
        .sort(
          (left, right) =>
            brokerScore(right, canonicalSymbol, value, quoted.has(right.toUpperCase())) -
              brokerScore(left, canonicalSymbol, value, quoted.has(left.toUpperCase())) ||
            left.localeCompare(right),
        ),
    [canonicalSymbol, quoted, symbols, value],
  );

  function choose(symbol: string) {
    onSelect(symbol);
    onChange(symbol);
    setOpen(false);
  }

  return (
    <div className="symbol-combobox">
      <input
        aria-activedescendant={
          open && ranked[activeIndex] ? `broker-symbol-${activeIndex}` : undefined
        }
        aria-autocomplete="list"
        aria-controls="broker-symbol-options"
        aria-expanded={open}
        aria-label="Broker symbol for this account"
        autoComplete="off"
        id="account-broker-symbol"
        name="accountBroker"
        onChange={(event) => {
          const next = event.target.value;
          onChange(next);
          onSelect(symbols.includes(next) ? next : "");
          setActiveIndex(0);
          setOpen(true);
        }}
        onInput={(event) => {
          const next = event.currentTarget.value;
          onChange(next);
          onSelect(symbols.includes(next) ? next : "");
          setActiveIndex(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
            setActiveIndex((current) => Math.min(current + 1, Math.max(0, ranked.length - 1)));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setActiveIndex((current) => Math.max(0, current - 1));
          } else if (event.key === "Enter" && open && ranked[activeIndex]) {
            event.preventDefault();
            choose(ranked[activeIndex]);
          } else if (event.key === "Escape") {
            setOpen(false);
          }
        }}
        placeholder="Search broker symbols"
        required={required}
        role="combobox"
        type="search"
        value={value}
      />
      {open ? (
        <div
          aria-label="Broker symbols"
          className="symbol-combobox-options"
          id="broker-symbol-options"
          role="listbox"
        >
          {ranked.length ? (
            ranked.map((symbol, index) => {
              const isQuoted = quoted.has(symbol.toUpperCase());
              return (
                <div
                  aria-selected={symbol === value}
                  className={index === activeIndex ? "active" : ""}
                  id={`broker-symbol-${index}`}
                  key={symbol}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    choose(symbol);
                  }}
                  role="option"
                  tabIndex={-1}
                >
                  <span>{symbol}</span>
                  <small>{isQuoted ? "QUOTED" : "UNQUOTED"}</small>
                </div>
              );
            })
          ) : (
            <li className="symbol-combobox-empty">No broker symbols match</li>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function SymbolMappingModal({
  open,
  defaultAccountId,
  availableBrokerSymbols,
  brokerSymbolMetadata = [],
  defaultProviderId,
  initialMapping,
  onClose,
  onSaveGlobalAlias,
  onSaveAccountMapping,
}: {
  open: boolean;
  defaultAccountId: string;
  availableBrokerSymbols: string[];
  brokerSymbolMetadata?: BrokerSymbolMetadata[];
  defaultProviderId?: string;
  initialMapping?: SymbolMappingSeed;
  onClose: () => void;
  onSaveGlobalAlias: (payload: GlobalAliasPayload) => Promise<void> | void;
  onSaveAccountMapping: (payload: AccountMappingPayload) => Promise<void> | void;
}) {
  const formRef = useRef<HTMLFormElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const [tab, setTab] = useState<Tab>(initialMapping ? "account" : "global");
  const [onlyProvider, setOnlyProvider] = useState(false);
  const [source, setSource] = useState<Source>(initialMapping?.source ?? "canonical");
  const [sourceSymbol, setSourceSymbol] = useState(initialMapping?.sourceSymbol ?? "");
  const [brokerSymbol, setBrokerSymbol] = useState(initialMapping?.brokerSymbol ?? "");
  const [selectedBrokerSymbol, setSelectedBrokerSymbol] = useState(
    initialMapping?.brokerSymbol ?? "",
  );
  const [advanced, setAdvanced] = useState<Record<AdvancedField, string>>({
    prefix: "",
    suffix: "",
    includeSymbols: "",
    excludeSymbols: "",
  });
  const advancedDirty = useRef<Partial<Record<AdvancedField, true>>>({});
  const [saveError, setSaveError] = useState("");
  const hasFocusedAccount = Boolean(defaultAccountId);
  const affixGuess = useMemo(
    () => (source === "canonical" ? guessAffix(availableBrokerSymbols, sourceSymbol) : undefined),
    [availableBrokerSymbols, source, sourceSymbol],
  );

  useFocusTrap(dialogRef, open, onClose);

  if (!open) return null;

  function selectTab(nextTab: Tab) {
    if (nextTab === "account" && !hasFocusedAccount) return;
    setTab(nextTab);
    setAdvanced({ prefix: "", suffix: "", includeSymbols: "", excludeSymbols: "" });
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

      const accountSourceSymbol = String(data.get("accountSource") ?? "").trim();
      const accountBrokerSymbol = String(data.get("accountBroker") ?? "").trim();
      if (
        accountBrokerSymbol &&
        (accountBrokerSymbol !== selectedBrokerSymbol ||
          !availableBrokerSymbols.includes(accountBrokerSymbol))
      ) {
        setSaveError("Select a broker symbol from the list");
        return;
      }
      const hasDirtyAccountRules = Object.values(advancedDirty.current).some(Boolean);
      if (source === "provider") {
        await onSaveAccountMapping({
          accountId: defaultAccountId,
          rawSymbol: accountSourceSymbol,
          brokerSymbol: accountBrokerSymbol,
          direct: true,
        });
        return;
      }
      if (!accountBrokerSymbol && !hasDirtyAccountRules) {
        setSaveError("Select a broker symbol or edit an account rule");
        return;
      }

      await onSaveAccountMapping({
        accountId: defaultAccountId,
        canonicalSymbol: accountSourceSymbol,
        ...(accountBrokerSymbol ? { brokerSymbol: accountBrokerSymbol } : {}),
        ...(advancedDirty.current.prefix ? { prefix: advanced.prefix.trim() } : {}),
        ...(advancedDirty.current.suffix ? { suffix: advanced.suffix.trim() } : {}),
        ...(advancedDirty.current.includeSymbols
          ? { includeSymbols: commaList(advanced.includeSymbols) }
          : {}),
        ...(advancedDirty.current.excludeSymbols
          ? { excludeSymbols: commaList(advanced.excludeSymbols) }
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
                      onClick={() => setSource("provider")}
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
                      onClick={() => setSource("canonical")}
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
                      onInput={(event) => setSourceSymbol(event.currentTarget.value)}
                      placeholder={source === "provider" ? "GOLD" : "XAUUSD"}
                      required
                      type="text"
                      defaultValue={sourceSymbol}
                    />
                  </label>
                  <label className="config-field config-field-grow" htmlFor="account-broker-symbol">
                    <span className="config-label">Broker symbol (this account)</span>
                    <BrokerSymbolCombobox
                      canonicalSymbol={sourceSymbol}
                      metadata={brokerSymbolMetadata}
                      onChange={setBrokerSymbol}
                      onSelect={setSelectedBrokerSymbol}
                      required={source === "provider"}
                      symbols={availableBrokerSymbols}
                      value={brokerSymbol}
                    />
                    {affixGuess && !advanced[affixGuess.kind] ? (
                      <button
                        className="config-link"
                        onClick={() => {
                          markAdvancedDirty(affixGuess.kind);
                          setAdvanced((current) => ({
                            ...current,
                            [affixGuess.kind]: affixGuess.value,
                          }));
                        }}
                        type="button"
                      >
                        Looks like a <code>{affixGuess.value}</code> {affixGuess.kind} - apply to
                        all?
                      </button>
                    ) : null}
                  </label>
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
                      onChange={(event) => {
                        markAdvancedDirty("prefix");
                        setAdvanced((current) => ({ ...current, prefix: event.target.value }));
                      }}
                      onInput={(event) => {
                        const value = event.currentTarget.value;
                        markAdvancedDirty("prefix");
                        setAdvanced((current) => ({ ...current, prefix: value }));
                      }}
                      placeholder="m."
                      type="text"
                      value={advanced.prefix}
                    />
                  </label>
                  <label className="config-field config-field-narrow">
                    <span className="config-label">Mapping suffix</span>
                    <input
                      aria-label="Mapping suffix"
                      name="accountSuffix"
                      onBlur={() => markAdvancedDirty("suffix")}
                      onChange={(event) => {
                        markAdvancedDirty("suffix");
                        setAdvanced((current) => ({ ...current, suffix: event.target.value }));
                      }}
                      onInput={(event) => {
                        const value = event.currentTarget.value;
                        markAdvancedDirty("suffix");
                        setAdvanced((current) => ({ ...current, suffix: value }));
                      }}
                      placeholder=".raw or r"
                      type="text"
                      value={advanced.suffix}
                    />
                  </label>
                  <label className="config-field config-field-grow">
                    <span className="config-label">Mapping include symbols</span>
                    <input
                      aria-label="Mapping include symbols"
                      name="accountInclude"
                      onBlur={() => markAdvancedDirty("includeSymbols")}
                      onChange={(event) => {
                        markAdvancedDirty("includeSymbols");
                        setAdvanced((current) => ({
                          ...current,
                          includeSymbols: event.target.value,
                        }));
                      }}
                      onInput={(event) => {
                        const value = event.currentTarget.value;
                        markAdvancedDirty("includeSymbols");
                        setAdvanced((current) => ({ ...current, includeSymbols: value }));
                      }}
                      placeholder="XAUUSD.r, EURUSD.raw"
                      type="text"
                      value={advanced.includeSymbols}
                    />
                  </label>
                  <label className="config-field config-field-grow">
                    <span className="config-label">Mapping exclude symbols</span>
                    <input
                      aria-label="Mapping exclude symbols"
                      name="accountExclude"
                      onBlur={() => markAdvancedDirty("excludeSymbols")}
                      onChange={(event) => {
                        markAdvancedDirty("excludeSymbols");
                        setAdvanced((current) => ({
                          ...current,
                          excludeSymbols: event.target.value,
                        }));
                      }}
                      onInput={(event) => {
                        const value = event.currentTarget.value;
                        markAdvancedDirty("excludeSymbols");
                        setAdvanced((current) => ({ ...current, excludeSymbols: value }));
                      }}
                      placeholder="US30.raw"
                      type="text"
                      value={advanced.excludeSymbols}
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
