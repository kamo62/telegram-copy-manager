import { Plus, Send, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useFocusTrap } from "../hooks/useFocusTrap";

export interface ManualSignalSeed {
  accountId?: string;
  providerId?: string;
  rawMessageId?: string;
  rawText?: string;
  brokerSymbol?: string;
  canonicalSymbol?: string;
  direction?: "BUY" | "SELL";
  orderType?: "MARKET" | "LIMIT" | "STOP";
  entry?: { from?: number; to?: number };
  stopLoss?: number;
  takeProfits?: Array<{ price: number } | number>;
  volume?: number;
  executionMode?: "VIRTUAL_TP" | "SPLIT_ORDER";
}

export interface ManualSignalPayload {
  accountId: string;
  providerId?: string;
  rawMessageId?: string;
  rawText?: string;
  brokerSymbol: string;
  canonicalSymbol?: string;
  direction: "BUY" | "SELL";
  orderType: "MARKET" | "LIMIT" | "STOP";
  entry?: { from: number; to?: number };
  stopLoss?: number;
  takeProfits: Array<{ price: number }>;
  volume?: number;
  executionMode: "VIRTUAL_TP" | "SPLIT_ORDER";
}

interface AccountOption {
  id: string;
  accountNumber: string;
  server?: string;
  availableSymbols?: string[];
}

interface TpRow {
  id: string;
  price: string;
}

interface FieldErrors {
  entryFrom?: string;
  entryTo?: string;
  stopLoss?: string;
  volume?: string;
  takeProfits: Record<string, string>;
}

export function validateManualSignalValues(input: {
  direction: "BUY" | "SELL";
  orderType: "MARKET" | "LIMIT" | "STOP";
  entryFrom: string;
  entryTo: string;
  stopLoss: string;
  volume: string;
  takeProfits: string[];
}) {
  const errors: {
    entryFrom?: string;
    entryTo?: string;
    stopLoss?: string;
    volume?: string;
    takeProfits: string[];
  } = { takeProfits: [] };
  const entryFrom = input.entryFrom.trim() ? Number(input.entryFrom) : undefined;
  const entryTo = input.entryTo.trim() ? Number(input.entryTo) : undefined;
  const stopLoss = input.stopLoss.trim() ? Number(input.stopLoss) : undefined;
  const volume = input.volume.trim() ? Number(input.volume) : undefined;

  if (input.orderType !== "MARKET") {
    if (!Number.isFinite(entryFrom) || entryFrom === undefined || entryFrom <= 0) {
      errors.entryFrom = "Entry price must be a positive number";
    }
    if (entryTo !== undefined && (!Number.isFinite(entryTo) || entryTo <= 0)) {
      errors.entryTo = "Entry range end must be a positive number";
    } else if (entryFrom !== undefined && entryTo !== undefined && entryTo < entryFrom) {
      errors.entryTo = "Entry range end cannot be below entry start";
    }
  }
  if (stopLoss !== undefined && (!Number.isFinite(stopLoss) || stopLoss <= 0)) {
    errors.stopLoss = "Stop loss must be a positive number";
  } else if (
    stopLoss !== undefined &&
    entryFrom !== undefined &&
    Number.isFinite(entryFrom) &&
    ((input.direction === "BUY" && stopLoss >= entryFrom) ||
      (input.direction === "SELL" && stopLoss <= entryFrom))
  ) {
    errors.stopLoss = `Stop loss must be ${input.direction === "BUY" ? "below" : "above"} entry`;
  }
  if (volume !== undefined && (!Number.isFinite(volume) || volume <= 0)) {
    errors.volume = "Volume must be a positive number";
  }
  for (const [index, takeProfit] of input.takeProfits.entries()) {
    if (!takeProfit.trim()) continue;
    const price = Number(takeProfit);
    if (!Number.isFinite(price) || price <= 0) {
      errors.takeProfits[index] = `TP${index + 1} must be a positive number`;
    }
  }
  return errors;
}

let tpCounter = 0;
const newTp = (price = ""): TpRow => ({ id: `tp-${++tpCounter}`, price });

/**
 * Compose or correct a trade and force-push it straight to one account's MT5
 * queue, bypassing the parser. Opened blank for a fresh ticket, or seeded from a
 * mis-parsed message so the operator only fixes the wrong fields. The Equity
 * Guardian still gates execution server-side; staleness/dedup are skipped.
 */
export function ManualSignalModal({
  open,
  seed,
  accounts,
  onClose,
  onSubmit,
}: {
  open: boolean;
  seed?: ManualSignalSeed;
  accounts: AccountOption[];
  onClose: () => void;
  onSubmit: (payload: ManualSignalPayload) => Promise<void> | void;
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const [accountId, setAccountId] = useState("");
  const [direction, setDirection] = useState<"BUY" | "SELL">("BUY");
  const [orderType, setOrderType] = useState<"MARKET" | "LIMIT" | "STOP">("LIMIT");
  const [symbol, setSymbol] = useState("");
  const [entryFrom, setEntryFrom] = useState("");
  const [entryTo, setEntryTo] = useState("");
  const [stopLoss, setStopLoss] = useState("");
  const [tps, setTps] = useState<TpRow[]>([newTp()]);
  const [volume, setVolume] = useState("");
  const [executionMode, setExecutionMode] = useState<"VIRTUAL_TP" | "SPLIT_ORDER">("VIRTUAL_TP");
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({ takeProfits: {} });
  const [submitting, setSubmitting] = useState(false);
  const seededAccountId = accounts.some((account) => account.id === seed?.accountId)
    ? seed?.accountId
    : undefined;

  useEffect(() => {
    if (!open) return;
    setAccountId(seededAccountId ?? accounts[0]?.id ?? "");
    setSymbol(seed?.brokerSymbol ?? "");
    setDirection(seed?.direction ?? "BUY");
    setOrderType(seed?.orderType ?? "LIMIT");
    setEntryFrom(seed?.entry?.from == null ? "" : String(seed.entry.from));
    setEntryTo(seed?.entry?.to == null ? "" : String(seed.entry.to));
    setStopLoss(seed?.stopLoss == null ? "" : String(seed.stopLoss));
    setTps(
      seed?.takeProfits === undefined
        ? [newTp()]
        : seed.takeProfits.map((tp) => newTp(String(typeof tp === "number" ? tp : tp.price))),
    );
    setVolume(seed?.volume == null ? "" : String(seed.volume));
    setExecutionMode(seed?.executionMode ?? "VIRTUAL_TP");
    setError("");
    setFieldErrors({ takeProfits: {} });
    setSubmitting(false);
  }, [open, seed, accounts, seededAccountId]);

  useFocusTrap(dialogRef, open, onClose);
  if (!open) return null;

  const account = accounts.find((item) => item.id === accountId);
  const availableSymbols = account?.availableSymbols ?? [];

  async function submit() {
    setError("");
    if (!accountId) return setError("Select an account");
    if (!symbol.trim()) return setError("Select or enter a symbol");
    const entryFromValue = entryFrom.trim() ? Number(entryFrom) : undefined;
    const entryToValue = entryTo.trim() ? Number(entryTo) : undefined;
    const stopLossValue = stopLoss.trim() ? Number(stopLoss) : undefined;
    const volumeValue = volume.trim() ? Number(volume) : undefined;
    const validation = validateManualSignalValues({
      direction,
      orderType,
      entryFrom,
      entryTo,
      stopLoss,
      volume,
      takeProfits: tps.map((tp) => tp.price),
    });
    const errors: FieldErrors = {
      ...validation,
      takeProfits: Object.fromEntries(
        tps.flatMap((tp, index) =>
          validation.takeProfits[index] ? [[tp.id, validation.takeProfits[index]]] : [],
        ),
      ),
    };
    const takeProfits = tps.flatMap((tp, index) => {
      if (!tp.price.trim()) return [];
      const price = Number(tp.price);
      if (validation.takeProfits[index]) return [];
      return [{ price }];
    });
    if (
      errors.entryFrom ||
      errors.entryTo ||
      errors.stopLoss ||
      errors.volume ||
      Object.keys(errors.takeProfits).length > 0
    ) {
      setFieldErrors(errors);
      return setError("Correct the highlighted fields");
    }
    setFieldErrors({ takeProfits: {} });
    const payload: ManualSignalPayload = {
      accountId,
      providerId: seed?.providerId,
      rawMessageId: seed?.rawMessageId,
      rawText: seed?.rawText,
      brokerSymbol: symbol.trim(),
      canonicalSymbol: seed?.canonicalSymbol,
      direction,
      orderType,
      entry: orderType === "MARKET" ? undefined : { from: entryFromValue!, to: entryToValue },
      stopLoss: stopLossValue,
      takeProfits,
      volume: volumeValue,
      executionMode,
    };
    setSubmitting(true);
    try {
      await onSubmit(payload);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to push signal");
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-overlay">
      <div
        aria-labelledby="manual-signal-title"
        aria-modal="true"
        className="modal modal-wide"
        ref={dialogRef}
        role="dialog"
      >
        <header className="modal-head">
          <div>
            <h2 id="manual-signal-title">Force-push trade</h2>
            <span className="modal-subtle">
              Send a manually composed or corrected signal straight to one account's MT5 queue. A
              paused Equity Guardian still blocks it.
            </span>
          </div>
          <button aria-label="Close" className="icon-btn" onClick={onClose} type="button">
            <X size={14} aria-hidden="true" />
          </button>
        </header>

        <form
          className="modal-form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {seed?.rawText ? (
            <section className="config-section">
              <h3 className="config-section-title">Original message</h3>
              <code className="manual-signal-source">{seed.rawText}</code>
            </section>
          ) : null}

          <div className="manual-signal-grid">
            <label className="manual-field">
              <span>Account</span>
              <select
                className="settings-input"
                disabled={Boolean(seededAccountId)}
                onChange={(event) => {
                  setAccountId(event.target.value);
                  setSymbol("");
                }}
                value={accountId}
              >
                <option disabled value="">
                  Select account
                </option>
                {accounts.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.accountNumber}
                    {item.server ? ` · ${item.server}` : ""}
                  </option>
                ))}
              </select>
            </label>

            <label className="manual-field" htmlFor="manual-symbol">
              <span>Symbol</span>
              {availableSymbols.length > 0 ? (
                <select
                  className="settings-input"
                  id="manual-symbol"
                  onChange={(event) => setSymbol(event.target.value)}
                  value={symbol}
                >
                  <option disabled value="">
                    Select symbol
                  </option>
                  {availableSymbols.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  className="settings-input"
                  id="manual-symbol"
                  onChange={(event) => setSymbol(event.target.value)}
                  placeholder="e.g. XAUUSD"
                  value={symbol}
                />
              )}
            </label>

            <label className="manual-field">
              <span>Direction</span>
              <select
                className="settings-input"
                onChange={(event) => setDirection(event.target.value as "BUY" | "SELL")}
                value={direction}
              >
                <option value="BUY">BUY</option>
                <option value="SELL">SELL</option>
              </select>
            </label>

            <label className="manual-field">
              <span>Order type</span>
              <select
                className="settings-input"
                onChange={(event) =>
                  setOrderType(event.target.value as "MARKET" | "LIMIT" | "STOP")
                }
                value={orderType}
              >
                <option value="MARKET">MARKET</option>
                <option value="LIMIT">LIMIT</option>
                <option value="STOP">STOP</option>
              </select>
            </label>

            {orderType !== "MARKET" ? (
              <>
                <label className="manual-field">
                  <span>Entry from</span>
                  <input
                    aria-invalid={Boolean(fieldErrors.entryFrom)}
                    className="settings-input"
                    inputMode="decimal"
                    onChange={(event) => setEntryFrom(event.target.value)}
                    value={entryFrom}
                  />
                  {fieldErrors.entryFrom ? (
                    <span className="manual-signal-error">{fieldErrors.entryFrom}</span>
                  ) : null}
                </label>
                <label className="manual-field">
                  <span>Entry to (optional)</span>
                  <input
                    aria-invalid={Boolean(fieldErrors.entryTo)}
                    className="settings-input"
                    inputMode="decimal"
                    onChange={(event) => setEntryTo(event.target.value)}
                    value={entryTo}
                  />
                  {fieldErrors.entryTo ? (
                    <span className="manual-signal-error">{fieldErrors.entryTo}</span>
                  ) : null}
                </label>
              </>
            ) : null}

            <label className="manual-field">
              <span>Stop loss</span>
              <input
                aria-invalid={Boolean(fieldErrors.stopLoss)}
                className="settings-input"
                inputMode="decimal"
                onChange={(event) => setStopLoss(event.target.value)}
                value={stopLoss}
              />
              {fieldErrors.stopLoss ? (
                <span className="manual-signal-error">{fieldErrors.stopLoss}</span>
              ) : null}
            </label>

            <label className="manual-field">
              <span>Volume (lots)</span>
              <input
                aria-invalid={Boolean(fieldErrors.volume)}
                className="settings-input"
                inputMode="decimal"
                onChange={(event) => setVolume(event.target.value)}
                placeholder="default if blank"
                value={volume}
              />
              {fieldErrors.volume ? (
                <span className="manual-signal-error">{fieldErrors.volume}</span>
              ) : null}
            </label>

            <label className="manual-field">
              <span>Execution</span>
              <select
                className="settings-input"
                onChange={(event) =>
                  setExecutionMode(event.target.value as "VIRTUAL_TP" | "SPLIT_ORDER")
                }
                value={executionMode}
              >
                <option value="VIRTUAL_TP">Virtual TP</option>
                <option value="SPLIT_ORDER">Split order</option>
              </select>
            </label>
          </div>

          <section className="config-section">
            <h3 className="config-section-title">Take profits</h3>
            {tps.map((tp, index) => (
              <div className="manual-tp-row" key={tp.id}>
                <input
                  aria-invalid={Boolean(fieldErrors.takeProfits[tp.id])}
                  className="settings-input"
                  inputMode="decimal"
                  onChange={(event) =>
                    setTps((prev) =>
                      prev.map((row) =>
                        row.id === tp.id ? { ...row, price: event.target.value } : row,
                      ),
                    )
                  }
                  placeholder={`TP${index + 1} price`}
                  value={tp.price}
                />
                {fieldErrors.takeProfits[tp.id] ? (
                  <span className="manual-signal-error">{fieldErrors.takeProfits[tp.id]}</span>
                ) : null}
                <button
                  aria-label={`Remove TP${index + 1}`}
                  className="icon-btn"
                  onClick={() => setTps((prev) => prev.filter((row) => row.id !== tp.id))}
                  type="button"
                >
                  <Trash2 size={13} aria-hidden="true" />
                </button>
              </div>
            ))}
            <button
              className="btn btn-ghost btn-small"
              onClick={() => setTps((prev) => [...prev, newTp()])}
              type="button"
            >
              <Plus size={13} aria-hidden="true" />
              Add TP
            </button>
          </section>

          {error ? <p className="manual-signal-error">{error}</p> : null}

          <footer className="modal-foot">
            <button className="btn btn-ghost" onClick={onClose} type="button">
              Cancel
            </button>
            <button className="btn btn-primary" disabled={submitting} type="submit">
              <Send size={13} aria-hidden="true" />
              {submitting ? "Pushing..." : "Force-push to MT5"}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}
