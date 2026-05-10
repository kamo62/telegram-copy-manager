import { useEffect, useRef, useState } from "react";
import { Plus, Trash2, X } from "lucide-react";
import type { ProviderRowData } from "./ProvidersTable";

export interface ProviderConfigSubmission {
  parserMode: string;
  lotSize: number;
  riskMode: "fixed" | "percent";
  riskAmount: number;
  takeProfitLevels: Array<{ leg: number; percentage: number; strategy: string }>;
}

type RiskMode = "fixed" | "percent";

const DEFAULT_TPS = [
  { leg: 1, percentage: 25, strategy: "Set SL to ENTRY + 0 pips" },
  { leg: 2, percentage: 25, strategy: "Set SL to ENTRY + 1 pips" },
  { leg: 3, percentage: 25, strategy: "Set SL to TP1 + 0 pips" },
  { leg: 4, percentage: 25, strategy: "Set SL to TP2 + 0 pips" },
];

export function ProviderConfigModal({
  provider,
  open,
  onClose,
  onSave,
}: {
  provider: ProviderRowData | null;
  open: boolean;
  onClose: () => void;
  onSave: (provider: ProviderRowData, payload: ProviderConfigSubmission) => Promise<void> | void;
}) {
  const formRef = useRef<HTMLFormElement | null>(null);
  const [riskMode, setRiskMode] = useState<RiskMode>("fixed");
  const [riskAmount, setRiskAmount] = useState("0.10");
  const [tps, setTps] = useState(DEFAULT_TPS);

  useEffect(() => {
    if (provider) {
      setRiskMode("fixed");
      setRiskAmount(provider.lotSize.toFixed(2));
      setTps(DEFAULT_TPS);
    }
  }, [provider]);

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open || !provider) return null;

  const riskValueNumeric = Number(riskAmount.replace(",", ".")) || 0;

  function performSave() {
    const form = formRef.current;
    if (!form || !provider) return;
    const data = new FormData(form);
    const lotRaw = String(data.get("lotSize") ?? "0").replace(",", ".");
    const lotValue = Number(lotRaw) || provider.lotSize;
    void onSave(provider, {
      parserMode: String(data.get("parserMode") ?? provider.parserMode),
      lotSize: riskMode === "fixed" ? lotValue : provider.lotSize,
      riskMode,
      riskAmount: lotValue,
      takeProfitLevels: tps,
    });
  }

  function distributeEqually() {
    if (tps.length === 0) return;
    const share = Math.round((100 / tps.length) * 10) / 10;
    setTps(tps.map((tp) => ({ ...tp, percentage: share })));
  }

  function updateTp(index: number, patch: Partial<(typeof tps)[number]>) {
    setTps(tps.map((tp, i) => (i === index ? { ...tp, ...patch } : tp)));
  }

  function deleteTp(index: number) {
    if (tps.length <= 1) return;
    setTps(tps.filter((_tp, i) => i !== index).map((tp, i) => ({ ...tp, leg: i + 1 })));
  }

  function addTp() {
    if (tps.length >= 6) return;
    setTps([
      ...tps,
      {
        leg: tps.length + 1,
        percentage: 0,
        strategy: `Set SL to TP${tps.length} + 0 pips`,
      },
    ]);
  }

  return (
    <div
      aria-labelledby="provider-config-title"
      aria-modal="true"
      className="modal-overlay"
      onClick={onClose}
      role="dialog"
    >
      <div
        className="modal modal-wide"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <header className="modal-head">
          <div>
            <h2 id="provider-config-title">{provider.title}</h2>
            <button className="modal-link" type="button">
              Settings History
            </button>
          </div>
          <button
            aria-label="Close configuration"
            className="icon-btn"
            onClick={onClose}
            type="button"
          >
            <X size={14} aria-hidden="true" />
          </button>
        </header>

        <form
          className="modal-form"
          key={provider.id}
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            performSave();
          }}
          ref={formRef}
        >
          <div className="modal-section">
            <h3 className="modal-section-title">
              <span className="section-icon" aria-hidden="true">
                ✈
              </span>
              1. Message Template
            </h3>
            <div className="modal-row">
              <label className="floating-field has-value template-select">
                <select
                  aria-label={`Parser mode for ${provider.title}`}
                  defaultValue={provider.parserMode}
                  name="parserMode"
                >
                  <option value="deterministic">Automatic</option>
                  <option value="kal-vip">KAL VIP tuned</option>
                </select>
                <span className="floating-field-label">Template</span>
              </label>
              <button className="btn-primary btn-small" type="button">
                Test message
              </button>
            </div>
          </div>

          <div className="modal-section">
            <h3 className="modal-section-title">
              <span className="section-icon shield" aria-hidden="true">
                ◯
              </span>
              2. Risk Management
            </h3>
            <div className="risk-row">
              <label className="floating-field has-value">
                <input
                  aria-label={`Channel lot size for ${provider.title}`}
                  defaultValue={provider.lotSize.toFixed(2)}
                  inputMode="decimal"
                  name="lotSize"
                  onChange={(event) => setRiskAmount(event.target.value)}
                  pattern="[0-9]*[.,]?[0-9]*"
                  type="text"
                />
                <span className="floating-field-label">
                  {riskMode === "fixed" ? "Fixed lots" : "% of balance"}
                </span>
              </label>
              <div className="risk-mode-options">
                <button
                  aria-pressed={riskMode === "fixed"}
                  className={`risk-mode-pill ${riskMode === "fixed" ? "active" : ""}`}
                  onClick={() => setRiskMode("fixed")}
                  type="button"
                >
                  <span className="risk-mode-label">Use fixed lots</span>
                  <span className="risk-mode-value">
                    {riskMode === "fixed" ? riskValueNumeric.toFixed(2) : "0.01"}
                  </span>
                </button>
                <button
                  aria-pressed={riskMode === "percent"}
                  className={`risk-mode-pill ${riskMode === "percent" ? "active" : ""}`}
                  onClick={() => setRiskMode("percent")}
                  type="button"
                >
                  <span className="risk-mode-label">Risk a % of your account balance</span>
                  <span className="risk-mode-value">
                    {riskMode === "percent" ? `${riskValueNumeric.toFixed(2)}%` : "0.5%"}
                  </span>
                </button>
              </div>
            </div>
          </div>

          <div className="modal-section">
            <h3 className="modal-section-title">
              <span className="section-icon" aria-hidden="true">
                ╱
              </span>
              3. Take Profit Levels
              <button
                className="modal-link section-action"
                onClick={distributeEqually}
                type="button"
              >
                Distribute % equally
              </button>
            </h3>
            <div className="tp-table">
              <div className="tp-table-head">
                <span>TP #</span>
                <span>Percentage</span>
                <span>Strategy</span>
                <span aria-hidden="true" />
              </div>
              {tps.map((tp, index) => (
                <div className="tp-table-row" key={tp.leg}>
                  <span className="tp-table-cell tp-leg-cell">TP {tp.leg}</span>
                  <div className="tp-table-cell percent-cell">
                    <button
                      aria-label={`Decrease TP${tp.leg} percentage`}
                      className="step-btn"
                      onClick={() =>
                        updateTp(index, {
                          percentage: Math.max(0, tp.percentage - 5),
                        })
                      }
                      type="button"
                    >
                      −
                    </button>
                    <input
                      aria-label={`TP${tp.leg} percentage`}
                      className="percent-input"
                      inputMode="decimal"
                      onChange={(event) =>
                        updateTp(index, { percentage: Number(event.target.value) || 0 })
                      }
                      type="text"
                      value={tp.percentage}
                    />
                    <button
                      aria-label={`Increase TP${tp.leg} percentage`}
                      className="step-btn"
                      onClick={() =>
                        updateTp(index, {
                          percentage: Math.min(100, tp.percentage + 5),
                        })
                      }
                      type="button"
                    >
                      +
                    </button>
                  </div>
                  <input
                    aria-label={`TP${tp.leg} strategy`}
                    className="tp-strategy-input"
                    onChange={(event) => updateTp(index, { strategy: event.target.value })}
                    type="text"
                    value={tp.strategy}
                  />
                  <button
                    aria-label={`Delete TP${tp.leg}`}
                    className="icon-btn icon-btn-danger"
                    onClick={() => deleteTp(index)}
                    type="button"
                  >
                    <Trash2 size={14} aria-hidden="true" />
                  </button>
                </div>
              ))}
              <button className="tp-table-add" onClick={addTp} type="button">
                <Plus size={14} aria-hidden="true" />
                Add a new Take Profit level
              </button>
            </div>
          </div>

          <div className="modal-section order-resume">
            <h3 className="modal-section-title">3.1. Order Resume</h3>
            <p className="resume-line">
              <strong>ONE order</strong> with <strong>{riskValueNumeric.toFixed(2)}</strong>{" "}
              {riskMode === "fixed" ? "lots" : "% of balance"} will be inserted.
            </p>
            {tps.map((tp) => {
              const lots = (riskValueNumeric * tp.percentage) / 100;
              return (
                <p className="resume-line" key={tp.leg}>
                  When <strong>TP{tp.leg}</strong> hits, <strong>{lots.toFixed(2)}</strong>{" "}
                  {riskMode === "fixed" ? "lots" : "%"} will be closed.
                </p>
              );
            })}
            <p className="resume-line resume-foot">
              For signals with fewer TPs than configured, the lot size stays the same and the
              position closes fully once the final TP in the signal is reached.
            </p>
          </div>

          <div className="modal-foot">
            <button
              aria-label={`Save provider settings for ${provider.title}`}
              className="btn-primary"
              onClick={performSave}
              type="button"
            >
              Save changes
            </button>
            <button className="btn-ghost" onClick={onClose} type="button">
              Close
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
