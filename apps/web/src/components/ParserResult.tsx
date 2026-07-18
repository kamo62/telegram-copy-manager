import { Check, Send, Sparkles, X } from "lucide-react";
import { useRef } from "react";
import { Field } from "./Field";
import type { ManualSignalSeed } from "./ManualSignalModal";
import { Tag } from "./Tag";

function defaultClassification(commandType: string): "entry" | "management" | "noise" | "unknown" {
  if (commandType === "OPEN_TRADE") return "entry";
  if (commandType === "NO_SIGNAL") return "noise";
  if (commandType) return "management";
  return "unknown";
}

function flagReasons(result: {
  commandType: string;
  confidence: number;
  mappingStatus: string;
  mappingWarnings?: string[];
  missingFields?: string[];
  warnings?: string[];
}) {
  const reasons = [
    ...(result.commandType === "NO_SIGNAL" ? ["No trade signal"] : []),
    ...(result.commandType === "TRADE_SETUP" ? ["Conditional trade setup"] : []),
    ...(result.confidence < 0.75 ? ["Low confidence"] : []),
    ...(result.mappingStatus !== "mapped" ? [`Symbol mapping: ${result.mappingStatus}`] : []),
    ...(result.missingFields ?? []).map((field) => `Missing ${field}`),
    ...(result.warnings ?? []),
    ...(result.mappingWarnings ?? []),
  ];
  return [...new Set(reasons)];
}

export function ParserResult({
  result,
  fixtureClassification,
  onClassify,
  redactedText,
  onRedactedChange,
  onSaveFixture,
  onAiReview,
  onApprove,
  onIgnore,
  onForcePush,
  aiReview,
  actionStatus,
  actionPending = false,
  fixtureStatus,
}: {
  result: {
    id: string;
    rawMessageId?: string;
    classification?: "entry" | "management" | "noise" | "unknown";
    providerTitle: string;
    rawText: string;
    commandType: string;
    rawSymbol?: string;
    canonicalSymbol: string;
    brokerSymbol: string;
    mappingStatus: string;
    mappingSource?: string;
    mappingWarnings?: string[];
    confidence: number;
    matchedPatternIds?: string[];
    missingFields?: string[];
    warnings?: string[];
    reviewRequired: boolean;
    status?: string;
    heldReason?: string;
    accountId?: string;
    providerId?: string;
    direction?: "BUY" | "SELL";
    orderType?: "MARKET" | "LIMIT" | "STOP";
    entry?: { from?: number; to?: number };
    stopLoss?: number;
    takeProfits?: Array<{ price: number } | number>;
    volume?: number;
    executionMode?: "VIRTUAL_TP" | "SPLIT_ORDER";
  };
  fixtureClassification?: "entry" | "management" | "noise" | "unknown";
  onClassify: (classification: "entry" | "management" | "noise" | "unknown") => void;
  redactedText: string;
  onRedactedChange: (value: string) => void;
  onSaveFixture: (redactedText: string) => void;
  onAiReview?: () => void;
  onApprove?: () => void;
  onIgnore?: () => void;
  onForcePush?: (seed: ManualSignalSeed) => void;
  aiReview?: string;
  actionStatus?: string;
  actionPending?: boolean;
  fixtureStatus?: string;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const classification =
    fixtureClassification ?? result.classification ?? defaultClassification(result.commandType);
  const reasons = flagReasons(result);
  const displayedStatus = actionStatus ?? result.status;
  const terminalStatus =
    displayedStatus && displayedStatus !== "PARSED" && !actionPending ? displayedStatus : undefined;
  const canExtract = result.reviewRequired && result.commandType !== "NO_SIGNAL";

  return (
    <article className="parser-result" key={result.id}>
      <div className="parser-source">
        <strong>{result.providerTitle}</strong>
        <code>{result.rawText}</code>
      </div>
      <div className="parser-fields">
        <Field label="Command" value={result.commandType} />
        <Field label="Side" value={result.direction ?? "—"} />
        <Field label="Order" value={result.orderType ?? "—"} />
        <Field label="Entry" value={result.entry?.from?.toString() ?? "—"} />
        <Field label="SL" value={result.stopLoss?.toString() ?? "—"} />
        <Field
          label="TPs"
          value={
            (result.takeProfits ?? [])
              .map((tp) => (typeof tp === "number" ? tp : tp.price))
              .join(" / ") || "—"
          }
        />
        <Field label="Lots" value={result.volume?.toString() ?? "—"} />
        <Field label="Mode" value={result.executionMode ?? "—"} />
        <Field label="Canonical" value={result.canonicalSymbol} />
        <Field label="Broker" value={result.brokerSymbol} />
        <Field label="Confidence" value={`${Math.round(result.confidence * 100)}%`} />
      </div>
      <div className="parser-diagnostics">
        <strong>Why flagged</strong>
        {reasons.length ? (
          <ul>
            {reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        ) : (
          <span>No parser warning</span>
        )}
        <small>
          Symbol resolution: {result.rawSymbol || "—"} → {result.canonicalSymbol || "—"} →{" "}
          {result.brokerSymbol || "—"}
          {result.mappingSource ? ` (${result.mappingSource})` : ""}
        </small>
        {result.mappingWarnings?.[0] ? <small>{result.mappingWarnings[0]}</small> : null}
        {result.matchedPatternIds?.length ? (
          <small>Patterns: {result.matchedPatternIds.join(", ")}</small>
        ) : null}
      </div>
      <div className="parser-actions">
        <Tag tone={terminalStatus ? "good" : result.reviewRequired ? "warn" : "good"}>
          {terminalStatus ?? reasons[0] ?? result.mappingStatus}
        </Tag>
        {canExtract && onAiReview ? (
          <button
            className="btn btn-ghost btn-small"
            disabled={actionPending}
            onClick={onAiReview}
            title="Extract entry, SL, and TPs"
            type="button"
          >
            <Sparkles aria-hidden="true" size={13} />
            Extract with GPT
          </button>
        ) : null}
        {!terminalStatus && onApprove ? (
          <button
            className="btn btn-primary btn-small"
            disabled={actionPending}
            onClick={onApprove}
            title="Approve this parser output for the MT5 queue"
            type="button"
          >
            <Check aria-hidden="true" size={13} />
            Approve
          </button>
        ) : null}
        {!terminalStatus && onIgnore ? (
          <button
            className="btn btn-ghost btn-small btn-destructive-subtle"
            disabled={actionPending}
            onClick={onIgnore}
            title="Ignore this parser output"
            type="button"
          >
            <X aria-hidden="true" size={13} />
            Ignore
          </button>
        ) : null}
        {terminalStatus && result.heldReason ? (
          <small className="ai-review-note">{result.heldReason}</small>
        ) : null}
        {!terminalStatus && onForcePush ? (
          <button
            className="btn btn-ghost btn-small"
            disabled={actionPending}
            onClick={() =>
              onForcePush({
                accountId: result.accountId,
                providerId: result.providerId,
                rawMessageId: result.rawMessageId,
                rawText: result.rawText,
                brokerSymbol: result.brokerSymbol,
                canonicalSymbol: result.canonicalSymbol,
                direction: result.direction,
                orderType: result.orderType,
                entry: result.entry,
                stopLoss: result.stopLoss,
                takeProfits: result.takeProfits,
                volume: result.volume,
                executionMode: result.executionMode,
              })
            }
            title="Correct the fields and force-push this trade to MT5"
            type="button"
          >
            <Send aria-hidden="true" size={13} />
            Correct &amp; push
          </button>
        ) : null}
        {aiReview ? <small className="ai-review-note">{aiReview}</small> : null}
        {result.rawMessageId ? (
          <div className="fixture-controls">
            <select
              aria-label={`Classification for ${result.providerTitle}`}
              className="settings-input"
              onChange={(event) =>
                onClassify(event.target.value as "entry" | "management" | "noise" | "unknown")
              }
              value={classification}
            >
              <option value="entry">Entry</option>
              <option value="management">Management</option>
              <option value="noise">Noise</option>
              <option value="unknown">Unknown</option>
            </select>
            <small className="fixture-classification-hint">
              Fixture classification: saved only with this fixture.
            </small>
            <textarea
              aria-label={`Redacted fixture text for ${result.providerTitle}`}
              className="settings-input fixture-textarea"
              onChange={(event) => onRedactedChange(event.target.value)}
              placeholder="Optional redacted fixture text"
              ref={textareaRef}
              value={redactedText}
            />
            <button
              className="btn btn-ghost btn-small"
              onClick={() => {
                const text = textareaRef.current?.value.trim() ?? "";
                void onSaveFixture(text);
              }}
              title="Save parser fixture"
              type="button"
            >
              Save fixture
            </button>
            {fixtureStatus ? <small className="fixture-status">{fixtureStatus}</small> : null}
          </div>
        ) : null}
      </div>
    </article>
  );
}
