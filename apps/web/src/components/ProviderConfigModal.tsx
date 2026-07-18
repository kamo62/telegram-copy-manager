import { Play, Plus, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useFocusTrap } from "../hooks/useFocusTrap";
import type { ProviderRowData } from "./ProvidersTable";

/**
 * Structured TP-leg SL movement strategy. Was previously a freeform string
 * ("Set SL to ENTRY + 0 pips") that nobody actually parsed — the EA ignored
 * it entirely, the backend stored it as opaque text. Discriminated union
 * means the EA / backend can act on it without regex-parsing English.
 *
 * - entry: move SL to the entry price (optionally + N pips toward profit)
 * - tp:    move SL to a prior TP leg's price (offset added in profit direction)
 * - none:  leave SL where it is when this TP fires
 */
export type TpStrategy =
  | { kind: "set-sl-to-entry"; offsetPips: number }
  | { kind: "set-sl-to-tp"; tpLeg: number; offsetPips: number }
  | { kind: "no-change" };

export interface TpStrategyLevel {
  leg: number;
  percentage: number;
  strategy: TpStrategy;
}

export interface TpDraftLevel {
  leg: number;
  percentage: string;
  strategy: TpStrategy;
}

export interface ProviderConfigSubmission {
  parserMode: string;
  lockedSymbol?: string;
  lotSize: number;
  riskMode: "fixed" | "percent";
  riskAmount: number;
  takeProfitLevels: TpStrategyLevel[];
  runner: RunnerConfig;
}

/** Render a structured strategy as the legacy human-readable string for the Order Summary block. */
export function strategyLabel(strategy: TpStrategy): string {
  switch (strategy.kind) {
    case "set-sl-to-entry":
      return "Move SL to BE";
    case "set-sl-to-tp":
      return `Move SL to TP${strategy.tpLeg}`;
    case "no-change":
      return "Leave SL unchanged";
  }
}

function formatPercent(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, "");
}

function parseDecimal(value: string): number | null {
  const normalized = value.trim().replace(",", ".");
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatDraftNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)));
}

function normalizeSymbolLock(value: FormDataEntryValue | null): string | undefined {
  const normalized = String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
  return normalized || undefined;
}

function normalizedStrategyForLeg(strategy: TpStrategy, leg: number): TpStrategy {
  switch (strategy.kind) {
    case "no-change":
      return { kind: "no-change" };
    case "set-sl-to-entry":
      return { kind: "set-sl-to-entry", offsetPips: 0 };
    case "set-sl-to-tp":
      return leg > 1
        ? { kind: "set-sl-to-tp", tpLeg: leg - 1, offsetPips: 0 }
        : { kind: "set-sl-to-entry", offsetPips: 0 };
  }
}

function toDraftTpLevels(levels: TpStrategyLevel[]): TpDraftLevel[] {
  return levels.slice(0, MAX_TP_LEVELS).map((level) => ({
    leg: level.leg,
    percentage: formatDraftNumber(level.percentage),
    strategy: normalizedStrategyForLeg(level.strategy, level.leg),
  }));
}

function normalizeDraftTpLevels(levels: TpDraftLevel[]): TpDraftLevel[] {
  return levels.slice(0, MAX_TP_LEVELS).map((level, index) => {
    const leg = index + 1;
    return {
      ...level,
      leg,
      strategy: normalizedStrategyForLeg(level.strategy, leg),
    };
  });
}

function toSubmissionTpLevels(levels: TpDraftLevel[]): TpStrategyLevel[] {
  return normalizeDraftTpLevels(levels).map((level) => ({
    leg: level.leg,
    percentage: parseDecimal(level.percentage) ?? 0,
    strategy: normalizedStrategyForLeg(level.strategy, level.leg),
  }));
}

export interface TpAllocationPreviewRow {
  leg: number;
  enteredPercent: number;
  effectivePercent: number;
  lots: number | null;
}

export interface TpAllocationPreview {
  canPreviewLots: boolean;
  totalEnteredPercent: number;
  totalOrderLots: number | null;
  runnerLots: number | null;
  tpCloseLots: number | null;
  rows: TpAllocationPreviewRow[];
}

export interface ProviderConfigDraft {
  riskMode: RiskMode;
  riskAmountText: string;
  tps: TpDraftLevel[];
  runner: RunnerConfig;
  runnerLotText?: string;
}

function runnerLotValue(draft: ProviderConfigDraft): number | null {
  if (!draft.runner.enabled) return 0;
  if (draft.runnerLotText !== undefined) return parseDecimal(draft.runnerLotText);
  return Number.isFinite(draft.runner.lotSize) ? draft.runner.lotSize : null;
}

export function computeTpAllocationPreview(draft: ProviderConfigDraft): TpAllocationPreview {
  const parsedPercentages = draft.tps.map((tp) => Math.max(0, parseDecimal(tp.percentage) ?? 0));
  const totalEnteredPercent = parsedPercentages.reduce((sum, percentage) => sum + percentage, 0);
  const effectivePercentages =
    totalEnteredPercent > 0
      ? parsedPercentages.map((percentage) => (percentage / totalEnteredPercent) * 100)
      : parsedPercentages.map(() => 0);
  const totalOrderLots =
    draft.riskMode === "fixed" ? Math.max(0, parseDecimal(draft.riskAmountText) ?? 0) : null;
  const parsedRunnerLots = runnerLotValue(draft);
  const runnerLots =
    draft.riskMode === "fixed" && draft.runner.enabled
      ? Math.max(0, parsedRunnerLots ?? 0)
      : draft.riskMode === "fixed"
        ? 0
        : null;
  const canPreviewLots =
    draft.riskMode === "fixed" && totalOrderLots !== null && totalOrderLots > 0;
  const tpCloseLots =
    canPreviewLots && totalOrderLots !== null && runnerLots !== null
      ? Math.max(0, totalOrderLots - runnerLots)
      : null;

  return {
    canPreviewLots,
    totalEnteredPercent,
    totalOrderLots,
    runnerLots,
    tpCloseLots,
    rows: draft.tps.map((tp, index) => ({
      leg: tp.leg,
      enteredPercent: parsedPercentages[index] ?? 0,
      effectivePercent: effectivePercentages[index] ?? 0,
      lots:
        canPreviewLots && tpCloseLots !== null
          ? (tpCloseLots * (effectivePercentages[index] ?? 0)) / 100
          : null,
    })),
  };
}

export function validateProviderConfigDraft(draft: ProviderConfigDraft): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  const riskValue = parseDecimal(draft.riskAmountText);
  if (riskValue === null || riskValue <= 0) {
    errors.push(
      draft.riskMode === "fixed"
        ? "Enter a positive fixed lot size."
        : "Enter a positive risk percent.",
    );
  }

  let positiveTpPercentages = 0;
  for (const tp of draft.tps) {
    const percentage = parseDecimal(tp.percentage);
    if (percentage === null) {
      errors.push(`Enter a percentage for TP${tp.leg}.`);
    } else if (percentage < 0) {
      errors.push(`TP${tp.leg} percentage cannot be negative.`);
    } else if (percentage > 0) {
      positiveTpPercentages += 1;
    }

    if (tp.strategy.kind === "set-sl-to-tp" && tp.leg <= 1) {
      errors.push(`TP${tp.leg} cannot move SL to a prior TP.`);
    }
  }

  if (draft.tps.length > 0 && positiveTpPercentages === 0) {
    errors.push("Enter a positive percentage for at least one TP.");
  }

  const runnerLot = runnerLotValue(draft);
  if (draft.runner.enabled) {
    if (runnerLot === null || runnerLot <= 0) {
      errors.push("Enter a positive runner lot size.");
    } else if (
      draft.riskMode === "fixed" &&
      draft.tps.length > 0 &&
      riskValue !== null &&
      riskValue > 0 &&
      runnerLot >= riskValue
    ) {
      errors.push("Runner lot must be less than the fixed lot size.");
    }
  }

  return { valid: errors.length === 0, errors };
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

const DEFAULT_TPS: TpStrategyLevel[] = [
  { leg: 1, percentage: 25, strategy: { kind: "set-sl-to-entry", offsetPips: 0 } },
  { leg: 2, percentage: 25, strategy: { kind: "set-sl-to-entry", offsetPips: 0 } },
  { leg: 3, percentage: 25, strategy: { kind: "set-sl-to-tp", tpLeg: 2, offsetPips: 0 } },
  { leg: 4, percentage: 25, strategy: { kind: "set-sl-to-tp", tpLeg: 3, offsetPips: 0 } },
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
  accountLabel,
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
  // When set, the modal edits this account's per-account config override.
  accountLabel?: string;
}) {
  const formRef = useRef<HTMLFormElement | null>(null);
  const [riskMode, setRiskMode] = useState<RiskMode>("fixed");
  const [riskAmount, setRiskAmount] = useState("0.10");
  const [tps, setTps] = useState<TpDraftLevel[]>(() => toDraftTpLevels(DEFAULT_TPS));
  const [runner, setRunner] = useState<RunnerConfig>(DEFAULT_RUNNER);
  const [runnerLotText, setRunnerLotText] = useState(formatDraftNumber(DEFAULT_RUNNER.lotSize));
  const [testRawText, setTestRawText] = useState(DEFAULT_TEST_MESSAGE);
  const [testResult, setTestResult] = useState<ProviderConfigTestResult | null>(null);
  const [testBusy, setTestBusy] = useState(false);

  useEffect(() => {
    if (provider) {
      const nextRunner = provider.runner ?? DEFAULT_RUNNER;
      setRiskMode(provider.riskMode ?? "fixed");
      setRiskAmount((provider.riskAmount ?? provider.lotSize).toFixed(2));
      setTps(
        provider.takeProfitLevels !== undefined
          ? toDraftTpLevels(provider.takeProfitLevels)
          : toDraftTpLevels(DEFAULT_TPS),
      );
      setRunner(nextRunner);
      setRunnerLotText(formatDraftNumber(nextRunner.lotSize));
      setTestRawText(DEFAULT_TEST_MESSAGE);
      setTestResult(null);
      setTestBusy(false);
    }
  }, [provider]);

  const dialogRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(dialogRef, open && Boolean(provider), onClose);

  if (!open || !provider) return null;

  const draft: ProviderConfigDraft = {
    riskMode,
    riskAmountText: riskAmount,
    tps,
    runner,
    runnerLotText,
  };
  const validation = validateProviderConfigDraft(draft);
  const allocationPreview = computeTpAllocationPreview(draft);
  const riskValueNumeric = parseDecimal(riskAmount) ?? 0;
  const runnerLotNumeric = runnerLotValue(draft) ?? runner.lotSize;

  function buildPayload() {
    const form = formRef.current;
    if (!form || !provider || !validation.valid) return null;
    const data = new FormData(form);
    const lotValue = parseDecimal(String(data.get("lotSize") ?? riskAmount)) ?? provider.lotSize;
    const nextRunner = {
      ...runner,
      lotSize: runner.enabled ? runnerLotNumeric : (parseDecimal(runnerLotText) ?? runner.lotSize),
    };
    return {
      parserMode: String(data.get("parserMode") ?? provider.parserMode),
      lockedSymbol: accountLabel ? undefined : normalizeSymbolLock(data.get("lockedSymbol")),
      lotSize: riskMode === "fixed" ? lotValue : provider.lotSize,
      riskMode,
      riskAmount: lotValue,
      takeProfitLevels: toSubmissionTpLevels(tps),
      runner: nextRunner,
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
    setTps(tps.map((tp) => ({ ...tp, percentage: formatDraftNumber(share) })));
  }

  function updateTp(index: number, patch: Partial<TpDraftLevel>) {
    setTps(tps.map((tp, i) => (i === index ? { ...tp, ...patch } : tp)));
  }

  function deleteTp(index: number) {
    setTps(normalizeDraftTpLevels(tps.filter((_tp, i) => i !== index)));
  }

  function addTp() {
    if (tps.length >= MAX_TP_LEVELS) return;
    const leg = tps.length + 1;
    setTps([
      ...tps,
      {
        leg,
        percentage: "0",
        strategy:
          leg === 1
            ? { kind: "set-sl-to-entry", offsetPips: 0 }
            : { kind: "set-sl-to-tp", tpLeg: leg - 1, offsetPips: 0 },
      },
    ]);
  }

  function updateStrategy(index: number, nextKind: TpStrategy["kind"]) {
    setTps(
      tps.map((tp, i) => {
        if (i !== index) return tp;
        if (nextKind === "no-change") {
          return { ...tp, strategy: { kind: "no-change" } };
        }
        if (nextKind === "set-sl-to-entry") {
          return { ...tp, strategy: { kind: "set-sl-to-entry", offsetPips: 0 } };
        }
        return {
          ...tp,
          strategy:
            tp.leg > 1
              ? { kind: "set-sl-to-tp", tpLeg: tp.leg - 1, offsetPips: 0 }
              : { kind: "set-sl-to-entry", offsetPips: 0 },
        };
      }),
    );
  }

  // --- Resume math --------------------------------------------------------
  const totalOrder = allocationPreview.totalOrderLots ?? riskValueNumeric;
  const reservedRunner =
    riskMode === "fixed" ? (allocationPreview.runnerLots ?? 0) : runnerLotNumeric;
  const tradedPortion = allocationPreview.tpCloseLots ?? 0;
  const totalPercent = allocationPreview.totalEnteredPercent;
  const lastTpLabel = tps.length ? `TP${tps[tps.length - 1]!.leg}` : "the TP sequence";
  const tpCloseBasis = runner.enabled
    ? allocationPreview.canPreviewLots
      ? `${numberFmt.format(tradedPortion)} lots assigned to TP closes`
      : "the execution-sized TP pool"
    : allocationPreview.canPreviewLots
      ? "the full order"
      : "the execution-sized order";

  return (
    <div className="modal-overlay">
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
            <span className="modal-subtle">
              {accountLabel ? `Configuration for account ${accountLabel}` : "Channel configuration"}
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
          {!accountLabel ? (
            <section className="config-section">
              <h3 className="config-section-title">Message template</h3>
              <div className="config-row">
                <label className="config-field config-field-grow">
                  <span className="config-label">Template</span>
                  <select
                    aria-label={`Parser mode for ${provider.title}`}
                    defaultValue={provider.parserMode === "aggressive" ? "aggressive" : "automatic"}
                    name="parserMode"
                    title="Aggressive: signals missing a stop, target, or exact entry are still executed using this provider's default settings (for example a 60-pip SL). Lifecycle commands that cannot be tied to one specific open trade are still skipped for safety."
                  >
                    <option value="automatic">Automatic</option>
                    <option value="aggressive">Aggressive</option>
                  </select>
                </label>
                <button
                  aria-label={`Test provider config for ${provider.title}`}
                  className="btn btn-ghost btn-small"
                  disabled={!onTest || testBusy || !testRawText.trim() || !validation.valid}
                  onClick={performTest}
                  type="button"
                >
                  <Play aria-hidden="true" size={13} />
                  Test message
                </button>
              </div>
              <label className="config-field">
                <span className="config-label">Locked symbol</span>
                <input
                  aria-label={`Locked symbol for ${provider.title}`}
                  defaultValue={provider.lockedSymbol ?? ""}
                  name="lockedSymbol"
                  placeholder="XAUUSD"
                />
              </label>
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
          ) : null}

          <section className="config-section">
            <h3 className="config-section-title">Risk management</h3>
            <div className="config-row">
              <label className="config-field">
                <span className="config-label">
                  {riskMode === "fixed" ? "Fixed lots" : "% of balance"}
                </span>
                <input
                  aria-label={`Channel lot size for ${provider.title}`}
                  defaultValue={(provider.riskAmount ?? provider.lotSize).toFixed(2)}
                  inputMode="decimal"
                  name="lotSize"
                  onInput={(event) => setRiskAmount(event.currentTarget.value)}
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
                <span>Lots</span>
                <span aria-hidden="true" />
              </div>
              {tps.map((tp, index) => {
                const enteredPercent = parseDecimal(tp.percentage) ?? 0;
                const rowPreview = allocationPreview.rows[index];
                const strategyValue =
                  tp.strategy.kind === "set-sl-to-tp" && tp.leg === 1
                    ? "set-sl-to-entry"
                    : tp.strategy.kind;
                return (
                  <div className="config-tp-row" key={tp.leg}>
                    <span className="config-tp-leg">TP{tp.leg}</span>
                    <div className="config-stepper">
                      <button
                        aria-label={`Decrease TP${tp.leg} percentage`}
                        onClick={() =>
                          updateTp(index, {
                            percentage: formatDraftNumber(Math.max(0, enteredPercent - 5)),
                          })
                        }
                        type="button"
                      >
                        -
                      </button>
                      <input
                        aria-label={`TP${tp.leg} percentage`}
                        inputMode="decimal"
                        onInput={(event) =>
                          updateTp(index, { percentage: event.currentTarget.value })
                        }
                        type="text"
                        value={tp.percentage}
                      />
                      <button
                        aria-label={`Increase TP${tp.leg} percentage`}
                        onClick={() =>
                          updateTp(index, {
                            percentage: formatDraftNumber(Math.min(100, enteredPercent + 5)),
                          })
                        }
                        type="button"
                      >
                        +
                      </button>
                    </div>
                    <div className="config-strategy-controls">
                      <select
                        aria-label={`TP${tp.leg} strategy action`}
                        className="config-strategy-input"
                        onChange={(event) =>
                          updateStrategy(index, event.target.value as TpStrategy["kind"])
                        }
                        value={strategyValue}
                      >
                        <option value="set-sl-to-entry">Move SL to BE</option>
                        {tp.leg > 1 ? (
                          <option value="set-sl-to-tp">Move SL to prior TP</option>
                        ) : null}
                        <option value="no-change">Leave SL unchanged</option>
                      </select>
                    </div>
                    <span className="config-tp-lots">
                      <strong>
                        {rowPreview?.lots !== null && rowPreview?.lots !== undefined
                          ? numberFmt.format(rowPreview.lots)
                          : "--"}
                      </strong>
                      <small>{allocationPreview.canPreviewLots ? "lots" : "at execution"}</small>
                    </span>
                    <button
                      aria-label={`Delete TP${tp.leg}`}
                      className="config-row-delete"
                      onClick={() => deleteTp(index)}
                      type="button"
                    >
                      <Trash2 size={13} aria-hidden="true" />
                    </button>
                  </div>
                );
              })}
              {tps.length < MAX_TP_LEVELS ? (
                <button className="config-tp-add" onClick={addTp} type="button">
                  <Plus size={13} aria-hidden="true" />
                  Add a take-profit level
                </button>
              ) : null}
              {totalPercent !== 100 && totalPercent > 0 && tps.length > 0 ? (
                <p className="config-hint">
                  TP percentages total {formatPercent(totalPercent)}%; the app treats them as
                  weights across {tpCloseBasis}.{runner.enabled ? " Runner stays separate." : ""}
                </p>
              ) : null}
              {riskMode === "percent" && tps.length > 0 ? (
                <p className="config-hint config-hint-soft">
                  Exact TP lots calculate at execution.
                </p>
              ) : null}
            </div>
          </section>

          <section className="config-section">
            <header className="config-section-head">
              <h3 className="config-section-title">Runner</h3>
              <label className="config-toggle">
                <input
                  aria-label="Keep runner open after TP sequence"
                  checked={runner.enabled}
                  onChange={(event) => setRunner({ ...runner, enabled: event.target.checked })}
                  type="checkbox"
                />
                <span>Keep runner open after the TP sequence</span>
              </label>
            </header>
            {runner.enabled ? (
              <div className="config-row config-row-three">
                <label className="config-field">
                  <span className="config-label">Lot size</span>
                  <input
                    aria-label="Runner lot size"
                    inputMode="decimal"
                    onInput={(event) => {
                      const nextValue = event.currentTarget.value;
                      const parsed = parseDecimal(nextValue);
                      setRunnerLotText(nextValue);
                      if (parsed !== null) {
                        setRunner({ ...runner, lotSize: parsed });
                      }
                    }}
                    type="text"
                    value={runnerLotText}
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
                Off — the full order is assigned to the configured TP levels.
              </p>
            )}
          </section>

          {validation.errors.length > 0 ? (
            <div className="config-validation" role="alert">
              <ul>
                {validation.errors.map((error) => (
                  <li key={error}>{error}</li>
                ))}
              </ul>
            </div>
          ) : null}

          <section className="config-resume">
            <h3 className="config-resume-title">Order summary</h3>
            <div className="config-resume-grid">
              <div className="config-resume-stat">
                <span>Total order</span>
                <strong>
                  {allocationPreview.canPreviewLots
                    ? numberFmt.format(totalOrder)
                    : formatPercent(riskValueNumeric)}
                </strong>
                <small>{riskMode === "fixed" ? "lots" : "% of balance"}</small>
              </div>
              <div className="config-resume-stat">
                <span>Allocated to TPs</span>
                <strong>
                  {allocationPreview.canPreviewLots
                    ? numberFmt.format(tradedPortion)
                    : "At execution"}
                </strong>
                <small>
                  {tps.length} levels ·{" "}
                  {totalPercent === 100
                    ? "100%"
                    : `${formatPercent(totalPercent)}% entered, scaled`}
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
              {tps.map((tp, index) => {
                const rowPreview = allocationPreview.rows[index];
                const effectivePercent = rowPreview?.effectivePercent ?? 0;
                const closed = rowPreview?.lots;
                return (
                  <li key={tp.leg}>
                    <strong>TP{tp.leg}</strong> hit · close{" "}
                    {closed !== null && closed !== undefined ? (
                      <>
                        <span className="num">{numberFmt.format(closed)}</span> lots{" "}
                      </>
                    ) : (
                      <span className="num">at execution</span>
                    )}
                    <span className="config-resume-percent">
                      ({formatPercent(effectivePercent)}% effective)
                    </span>
                    <span className="config-resume-strategy"> · {strategyLabel(tp.strategy)}</span>
                  </li>
                );
              })}
              {runner.enabled ? (
                <li className="config-resume-runner">
                  <strong>Runner remains open</strong> · keep{" "}
                  <span className="num">{numberFmt.format(reservedRunner)}</span> lots after{" "}
                  {lastTpLabel} ·{" "}
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
              disabled={!validation.valid}
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
