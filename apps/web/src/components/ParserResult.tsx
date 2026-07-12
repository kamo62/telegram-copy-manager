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
  status,
}: {
  result: {
    id: string;
    rawMessageId?: string;
    classification?: "entry" | "management" | "noise" | "unknown";
    providerTitle: string;
    rawText: string;
    commandType: string;
    canonicalSymbol: string;
    brokerSymbol: string;
    mappingStatus: string;
    confidence: number;
    reviewRequired: boolean;
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
  status?: string;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const classification =
    fixtureClassification ?? result.classification ?? defaultClassification(result.commandType);

  return (
    <article className="parser-result" key={result.id}>
      <div className="parser-source">
        <strong>{result.providerTitle}</strong>
        <code>{result.rawText}</code>
      </div>
      <div className="parser-fields">
        <Field label="Command" value={result.commandType} />
        <Field label="Canonical" value={result.canonicalSymbol} />
        <Field label="Broker" value={result.brokerSymbol} />
        <Field label="Confidence" value={`${Math.round(result.confidence * 100)}%`} />
      </div>
      <div className="parser-actions">
        <Tag tone={result.reviewRequired ? "warn" : "good"}>
          {result.reviewRequired ? "Needs GPT extraction" : result.mappingStatus}
        </Tag>
        {result.reviewRequired && onAiReview ? (
          <button
            className="btn btn-ghost btn-small"
            onClick={onAiReview}
            title="Extract entry, SL, and TPs"
            type="button"
          >
            <Sparkles aria-hidden="true" size={13} />
            Extract with GPT
          </button>
        ) : null}
        {onApprove ? (
          <button
            className="btn btn-primary btn-small"
            onClick={onApprove}
            title="Approve this parser output for the MT5 queue"
            type="button"
          >
            <Check aria-hidden="true" size={13} />
            Approve
          </button>
        ) : null}
        {onIgnore ? (
          <button
            className="btn btn-ghost btn-small btn-destructive-subtle"
            onClick={onIgnore}
            title="Ignore this parser output"
            type="button"
          >
            <X aria-hidden="true" size={13} />
            Ignore
          </button>
        ) : null}
        {onForcePush ? (
          <button
            className="btn btn-ghost btn-small"
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
            {status ? <small className="fixture-status">{status}</small> : null}
          </div>
        ) : null}
      </div>
    </article>
  );
}
