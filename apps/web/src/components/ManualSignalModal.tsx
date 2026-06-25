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
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setAccountId(seed?.accountId ?? accounts[0]?.id ?? "");
    setSymbol(seed?.brokerSymbol ?? "");
    setDirection("BUY");
    setOrderType("LIMIT");
    setEntryFrom("");
    setEntryTo("");
    setStopLoss("");
    setTps([newTp()]);
    setVolume("");
    setExecutionMode("VIRTUAL_TP");
    setError("");
    setSubmitting(false);
  }, [open, seed, accounts]);

  useFocusTrap(dialogRef, open, onClose);
  if (!open) return null;

  const account = accounts.find((item) => item.id === accountId);
  const availableSymbols = account?.availableSymbols ?? [];

  async function submit() {
    setError("");
    if (!accountId) return setError("Select an account");
    if (!symbol.trim()) return setError("Select or enter a symbol");
    if (orderType !== "MARKET" && !entryFrom.trim()) {
      return setError("Entry price is required for limit and stop orders");
    }
    const takeProfits = tps
      .map((tp) => Number(tp.price))
      .filter((price) => Number.isFinite(price) && price > 0)
      .map((price) => ({ price }));
    const payload: ManualSignalPayload = {
      accountId,
      providerId: seed?.providerId,
      rawMessageId: seed?.rawMessageId,
      rawText: seed?.rawText,
      brokerSymbol: symbol.trim(),
      canonicalSymbol: seed?.canonicalSymbol,
      direction,
      orderType,
      entry:
        orderType === "MARKET"
          ? undefined
          : { from: Number(entryFrom), to: entryTo.trim() ? Number(entryTo) : undefined },
      stopLoss: stopLoss.trim() ? Number(stopLoss) : undefined,
      takeProfits,
      volume: volume.trim() ? Number(volume) : undefined,
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
                    className="settings-input"
                    inputMode="decimal"
                    onChange={(event) => setEntryFrom(event.target.value)}
                    value={entryFrom}
                  />
                </label>
                <label className="manual-field">
                  <span>Entry to (optional)</span>
                  <input
                    className="settings-input"
                    inputMode="decimal"
                    onChange={(event) => setEntryTo(event.target.value)}
                    value={entryTo}
                  />
                </label>
              </>
            ) : null}

            <label className="manual-field">
              <span>Stop loss</span>
              <input
                className="settings-input"
                inputMode="decimal"
                onChange={(event) => setStopLoss(event.target.value)}
                value={stopLoss}
              />
            </label>

            <label className="manual-field">
              <span>Volume (lots)</span>
              <input
                className="settings-input"
                inputMode="decimal"
                onChange={(event) => setVolume(event.target.value)}
                placeholder="default if blank"
                value={volume}
              />
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
