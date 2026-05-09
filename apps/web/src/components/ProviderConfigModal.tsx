import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { ProviderRowData } from "./ProvidersTable";

export interface ProviderConfigSubmission {
  parserMode: string;
  riskProfile: string;
  lotSize: number;
}

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
  const [lotPreview, setLotPreview] = useState(0);

  useEffect(() => {
    if (provider) setLotPreview(provider.lotSize);
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

  function performSave() {
    const form = formRef.current;
    if (!form || !provider) return;
    const data = new FormData(form);
    const lotRaw = String(data.get("lotSize") ?? "0").replace(",", ".");
    void onSave(provider, {
      parserMode: String(data.get("parserMode") ?? provider.parserMode),
      riskProfile: String(data.get("riskProfile") ?? provider.riskProfile),
      lotSize: Number(lotRaw) || provider.lotSize,
    });
  }

  function recomputeLotPreview() {
    const form = formRef.current;
    if (!form) return;
    const raw = String(new FormData(form).get("lotSize") ?? "0").replace(",", ".");
    const value = Number(raw);
    setLotPreview(Number.isFinite(value) ? value : 0);
  }

  const perLeg = lotPreview / 4;

  return (
    <div
      aria-labelledby="provider-config-title"
      aria-modal="true"
      className="modal-overlay"
      onClick={onClose}
      role="dialog"
    >
      <div
        className="modal"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <header className="modal-head">
          <div>
            <h2 id="provider-config-title">Configure {provider.title}</h2>
            <span className="modal-subtle">
              {provider.parserMode} · {provider.riskProfile}
            </span>
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
            <h3 className="modal-section-title">Channel lot size</h3>
            <p className="modal-section-help">
              Operator-controlled volume for every approved trade from this channel.
              Provider-sent lot/risk hints are captured but never executed.
            </p>
            <label className="floating-field has-value">
              <input
                aria-label={`Channel lot size for ${provider.title}`}
                defaultValue={provider.lotSize.toFixed(2)}
                inputMode="decimal"
                name="lotSize"
                onChange={recomputeLotPreview}
                pattern="[0-9]*[.,]?[0-9]*"
                type="text"
              />
              <span className="floating-field-label">Lot size (e.g. 0.20)</span>
            </label>
            <p className="modal-derived">
              Allocation 25/25/25/25 → {perLeg.toFixed(2)} per TP leg.
            </p>
          </div>

          <div className="modal-section">
            <h3 className="modal-section-title">Parsing &amp; risk</h3>
            <div className="modal-grid">
              <label className="floating-field has-value">
                <select
                  aria-label={`Parser mode for ${provider.title}`}
                  defaultValue={provider.parserMode}
                  name="parserMode"
                >
                  <option value="deterministic">Deterministic</option>
                  <option value="kal-vip">KAL VIP tuned</option>
                </select>
                <span className="floating-field-label">Parser mode</span>
              </label>
              <label className="floating-field has-value">
                <select
                  aria-label={`Risk profile for ${provider.title}`}
                  defaultValue={provider.riskProfile}
                  name="riskProfile"
                >
                  <option value="balanced">Balanced</option>
                  <option value="conservative">Conservative</option>
                  <option value="aggressive">Aggressive</option>
                </select>
                <span className="floating-field-label">Risk profile</span>
              </label>
            </div>
          </div>

          <div className="modal-foot">
            <button className="btn-ghost" onClick={onClose} type="button">
              Cancel
            </button>
            <button
              aria-label={`Save provider settings for ${provider.title}`}
              className="btn-primary"
              onClick={performSave}
              type="button"
            >
              Save
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
