import { Play, Plus, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useFocusTrap } from "../hooks/useFocusTrap";
import type { ProviderRowData } from "./ProvidersTable";

export interface ProviderConfigSubmission {
  parserMode: string;
  lotSize: number;
  riskMode: "fixed" | "percent";
  riskAmount: number;
  takeProfitLevels: Array<{ leg: number; percentage: number; strategy: string }>;
  runner: RunnerConfig;
}

export interface ProviderConfigTestResult {
  ok: boolean;
  summary: string;
}

type RiskMode = "fixed" | "percent";

export type RunnerSlBehavior = "break-even" | "last-tp" | "trail";

export interface RunnerConfig {
  enabled: boolean;
  lotSize: number;
  slBehavior: RunnerSlBehavior;
  trailPips: number;
}

const DEFAULT_TPS = [
  { leg: 1, percentage: 25, strategy: "Set SL to ENTRY + 0 pips" },
  { leg: 2, percentage: 25, strategy: "Set SL to ENTRY + 1 pips" },
  { leg: 3, percentage: 25, strategy: "Set SL to TP1 + 0 pips" },
  { leg: 4, percentage: 25, strategy: "Set SL to TP2 + 0 pips" },
];

const MAX_TP_LEVELS = 4;
const DEFAULT_TEST_MESSAGE = "BUY EURUSD @ 1.0860\nSL 1.0810\nTP1 1.0910\nTP2 1.0950";

const DEFAULT_RUNNER: RunnerConfig = {
  enabled: false,
  lotSize: 0.01,
  slBehavior: "break-even",
  trailPips: 10,
};

const numberFmt = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function ProviderConfigModal({
  provider,
  open,
  onClose,
  onSave,
  onTest,
}: {
  provider: ProviderRowData | null;
  open: boolean;
  onClose: () => void;
  onSave: (provider: ProviderRowData, payload: ProviderConfigSubmission) => Promise<void> | void;
  onTest?: (
    provider: ProviderRowData,
    payload: ProviderConfigSubmission,
    rawText: string,
  ) => Promise<ProviderConfigTestResult>;
}) {
  const formRef = useRef<HTMLFormElement | null>(null);
  const [riskMode, setRiskMode] = useState<RiskMode>("fixed");
  const [riskAmount, setRiskAmount] = useState("0.10");
  const [tps, setTps] = useState(DEFAULT_TPS);
  const [runner, setRunner] = useState<RunnerConfig>(DEFAULT_RUNNER);
  const [testRawText, setTestRawText] = useState(DEFAULT_TEST_MESSAGE);
  const [testResult, setTestResult] = useState<ProviderConfigTestResult | null>(null);
  const [testBusy, setTestBusy] = useState(false);

  useEffect(() => {
    if (provider) {
      setRiskMode("fixed");
      setRiskAmount(provider.lotSize.toFixed(2));
      setTps(DEFAULT_TPS);
      setRunner(DEFAULT_RUNNER);
      setTestRawText(DEFAULT_TEST_MESSAGE);
      setTestResult(null);
      setTestBusy(false);
    }
  }, [provider]);

  const dialogRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(dialogRef, open && Boolean(provider), onClose);

  if (!open || !provider) return null;

  const riskValueNumeric = Number(riskAmount.replace(",", ".")) || 0;

  function buildPayload() {
    const form = formRef.current;
    if (!form || !provider) return null;
    const data = new FormData(form);
    const lotRaw = String(data.get("lotSize") ?? "0").replace(",", ".");
    const lotValue = Number(lotRaw) || provider.lotSize;
    return {
      parserMode: String(data.get("parserMode") ?? provider.parserMode),
      lotSize: riskMode === "fixed" ? lotValue : provider.lotSize,
      riskMode,
      riskAmount: lotValue,
      takeProfitLevels: tps,
      runner,
    };
  }

  function performSave() {
    if (!provider) return;
    const payload = buildPayload();
    if (!payload) return;
    void onSave(provider, payload);
  }

  async function performTest() {
    if (!provider || !onTest) return;
    const payload = buildPayload();
    const rawText = testRawText.trim();
    if (!payload || !rawText) return;

    setTestBusy(true);
    setTestResult(null);
    try {
      setTestResult(await onTest(provider, payload, rawText));
    } catch (error) {
      setTestResult({
        ok: false,
        summary: error instanceof Error ? error.message : "Provider config test failed",
      });
    } finally {
      setTestBusy(false);
    }
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
    if (tps.length >= MAX_TP_LEVELS) return;
    setTps([
      ...tps,
      {
        leg: tps.length + 1,
        percentage: 0,
        strategy: `Set SL to TP${tps.length} + 0 pips`,
      },
    ]);
  }

  // --- Resume math --------------------------------------------------------
  const totalOrder = riskMode === "fixed" ? riskValueNumeric : riskValueNumeric;
  const reservedRunner = runner.enabled ? Math.min(runner.lotSize, totalOrder) : 0;
  const tradedPortion = Math.max(0, totalOrder - reservedRunner);
  const totalPercent = tps.reduce((acc, tp) => acc + tp.percentage, 0);

  return (
    <div className="modal-overlay" onClick={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <div
        aria-labelledby="provider-config-title"
        aria-modal="true"
        className="modal modal-wide"
        ref={dialogRef}
        role="dialog"
      >
        <header className="modal-head">
          <div>
            <h2 id="provider-config-title">{provider.title}</h2>
            <span className="modal-subtle">Channel configuration</span>
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
          className="modal-form modal-form-clean"
          key={provider.id}
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            performSave();
          }}
          ref={formRef}
        >
          <section className="config-section">
            <h3 className="config-section-title">Message template</h3>
            <div className="config-row">
              <label className="config-field config-field-grow">
                <span className="config-label">Template</span>
                <select
                  aria-label={`Parser mode for ${provider.title}`}
                  defaultValue={provider.parserMode}
                  name="parserMode"
                >
                  <option value="deterministic">Automatic</option>
                  <option value="kal-vip">KAL VIP tuned</option>
                </select>
              </label>
              <button
                aria-label={`Test provider config for ${provider.title}`}
                className="btn btn-ghost btn-small"
                disabled={!onTest || testBusy || !testRawText.trim()}
                onClick={performTest}
                type="button"
              >
                <Play aria-hidden="true" size={13} />
                Test message
              </button>
            </div>
            <label className="config-field">
              <span className="config-label">Test message</span>
              <textarea
                aria-label={`Provider test message for ${provider.title}`}
                className="config-test-message"
                onInput={(event) => setTestRawText(event.currentTarget.value)}
                rows={4}
                value={testRawText}
              />
            </label>
            {testResult ? (
              <p className={testResult.ok ? "config-test-result ok" : "config-test-result error"}>
                {testResult.summary}
              </p>
            ) : null}
          </section>

          <section className="config-section">
            <h3 className="config-section-title">Risk management</h3>
            <div className="config-row">
              <label className="config-field">
                <span className="config-label">
                  {riskMode === "fixed" ? "Fixed lots" : "% of balance"}
                </span>
                <input
                  aria-label={`Channel lot size for ${provider.title}`}
                  defaultValue={provider.lotSize.toFixed(2)}
                  inputMode="decimal"
                  name="lotSize"
                  onChange={(event) => setRiskAmount(event.target.value)}
                  pattern="[0-9]*[.,]?[0-9]*"
                  type="text"
                />
              </label>
              <div className="segmented-control" role="tablist" aria-label="Risk mode">
                <button
                  aria-selected={riskMode === "fixed"}
                  className={riskMode === "fixed" ? "active" : ""}
                  onClick={() => setRiskMode("fixed")}
                  role="tab"
                  type="button"
                >
                  Fixed lots
                </button>
                <button
                  aria-selected={riskMode === "percent"}
                  className={riskMode === "percent" ? "active" : ""}
                  onClick={() => setRiskMode("percent")}
                  role="tab"
                  type="button"
                >
                  % of balance
                </button>
              </div>
            </div>
          </section>

          <section className="config-section">
            <header className="config-section-head">
              <h3 className="config-section-title">Take profit levels</h3>
              <button className="config-link" onClick={distributeEqually} type="button">
                Distribute % equally
              </button>
            </header>
            <div className="config-tp-table">
              <div className="config-tp-head">
                <span>TP</span>
                <span>%</span>
                <span>Strategy</span>
                <span aria-hidden="true" />
              </div>
              {tps.map((tp, index) => (
                <div className="config-tp-row" key={tp.leg}>
                  <span className="config-tp-leg">TP{tp.leg}</span>
                  <div className="config-stepper">
                    <button
                      aria-label={`Decrease TP${tp.leg} percentage`}
                      onClick={() =>
                        updateTp(index, { percentage: Math.max(0, tp.percentage - 5) })
                      }
                      type="button"
                    >
                      −
                    </button>
                    <input
                      aria-label={`TP${tp.leg} percentage`}
                      inputMode="decimal"
                      onChange={(event) =>
                        updateTp(index, { percentage: Number(event.target.value) || 0 })
                      }
                      type="text"
                      value={tp.percentage}
                    />
                    <button
                      aria-label={`Increase TP${tp.leg} percentage`}
                      onClick={() =>
                        updateTp(index, { percentage: Math.min(100, tp.percentage + 5) })
                      }
                      type="button"
                    >
                      +
                    </button>
                  </div>
                  <input
                    aria-label={`TP${tp.leg} strategy`}
                    className="config-strategy-input"
                    onChange={(event) => updateTp(index, { strategy: event.target.value })}
                    type="text"
                    value={tp.strategy}
                  />
                  <button
                    aria-label={`Delete TP${tp.leg}`}
                    className="config-row-delete"
                    onClick={() => deleteTp(index)}
                    type="button"
                  >
                    <Trash2 size={13} aria-hidden="true" />
                  </button>
                </div>
              ))}
              {tps.length < MAX_TP_LEVELS ? (
                <button className="config-tp-add" onClick={addTp} type="button">
                  <Plus size={13} aria-hidden="true" />
                  Add a take-profit level
                </button>
              ) : null}
              {totalPercent !== 100 ? (
                <p className="config-hint">
                  TPs total {totalPercent}% — anything that isn't allocated will close on the final
                  TP unless a runner is configured below.
                </p>
              ) : null}
            </div>
          </section>

          <section className="config-section">
            <header className="config-section-head">
              <h3 className="config-section-title">Runner</h3>
              <label className="config-toggle">
                <input
                  aria-label="Enable runner after final TP"
                  checked={runner.enabled}
                  onChange={(event) => setRunner({ ...runner, enabled: event.target.checked })}
                  type="checkbox"
                />
                <span>Leave a runner open after the final TP</span>
              </label>
            </header>
            {runner.enabled ? (
              <div className="config-row config-row-three">
                <label className="config-field">
                  <span className="config-label">Lot size</span>
                  <input
                    aria-label="Runner lot size"
                    inputMode="decimal"
                    onChange={(event) =>
                      setRunner({
                        ...runner,
                        lotSize: Number(event.target.value.replace(",", ".")) || 0,
                      })
                    }
                    type="text"
                    value={numberFmt.format(runner.lotSize)}
                  />
                </label>
                <label className="config-field config-field-grow">
                  <span className="config-label">SL behaviour</span>
                  <select
                    aria-label="Runner SL behaviour"
                    onChange={(event) =>
                      setRunner({
                        ...runner,
                        slBehavior: event.target.value as RunnerSlBehavior,
                      })
                    }
                    value={runner.slBehavior}
                  >
                    <option value="break-even">Move SL to break-even</option>
                    <option value="last-tp">Move SL to last hit TP</option>
                    <option value="trail">Trail by N pips</option>
                  </select>
                </label>
                {runner.slBehavior === "trail" ? (
                  <label className="config-field config-field-narrow">
                    <span className="config-label">Trail pips</span>
                    <input
                      aria-label="Runner trail pips"
                      inputMode="numeric"
                      onChange={(event) =>
                        setRunner({
                          ...runner,
                          trailPips: Number(event.target.value) || 0,
                        })
                      }
                      type="text"
                      value={runner.trailPips}
                    />
                  </label>
                ) : null}
              </div>
            ) : (
              <p className="config-hint config-hint-soft">
                Off — when the final TP hits, the position closes fully.
              </p>
            )}
          </section>

          <section className="config-resume">
            <h3 className="config-resume-title">Order summary</h3>
            <div className="config-resume-grid">
              <div className="config-resume-stat">
                <span>Total order</span>
                <strong>{numberFmt.format(totalOrder)}</strong>
                <small>{riskMode === "fixed" ? "lots" : "% of balance"}</small>
              </div>
              <div className="config-resume-stat">
                <span>Allocated to TPs</span>
                <strong>{numberFmt.format(tradedPortion)}</strong>
                <small>
                  {tps.length} levels · {totalPercent}%
                </small>
              </div>
              <div className="config-resume-stat">
                <span>Runner</span>
                <strong>{runner.enabled ? numberFmt.format(reservedRunner) : "—"}</strong>
                <small>
                  {runner.enabled
                    ? runner.slBehavior === "trail"
                      ? `Trail ${runner.trailPips} pips`
                      : runner.slBehavior === "last-tp"
                        ? "SL → last TP"
                        : "SL → break-even"
                    : "Disabled"}
                </small>
              </div>
            </div>
            <ol className="config-resume-list">
              {tps.map((tp) => {
                const closed = (tradedPortion * tp.percentage) / 100;
                return (
                  <li key={tp.leg}>
                    <strong>TP{tp.leg}</strong> hit · close{" "}
                    <span className="num">{numberFmt.format(closed)}</span> lots
                    <span className="config-resume-strategy"> · {tp.strategy}</span>
                  </li>
                );
              })}
              {runner.enabled ? (
                <li className="config-resume-runner">
                  <strong>After final TP</strong> · keep{" "}
                  <span className="num">{numberFmt.format(reservedRunner)}</span> lots open ·{" "}
                  {runner.slBehavior === "trail"
                    ? `trailing ${runner.trailPips} pips`
                    : runner.slBehavior === "last-tp"
                      ? "SL at last hit TP"
                      : "SL at break-even"}
                </li>
              ) : null}
            </ol>
          </section>

          <div className="modal-foot">
            <button className="btn btn-ghost" onClick={onClose} type="button">
              Close
            </button>
            <button
              aria-label={`Save provider settings for ${provider.title}`}
              className="btn btn-primary"
              onClick={performSave}
              type="button"
            >
              Save changes
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
