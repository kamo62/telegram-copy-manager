import { useRef } from "react";
import { Field } from "./Field";
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
  };
  fixtureClassification?: "entry" | "management" | "noise" | "unknown";
  onClassify: (classification: "entry" | "management" | "noise" | "unknown") => void;
  redactedText: string;
  onRedactedChange: (value: string) => void;
  onSaveFixture: (redactedText: string) => void;
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
          {result.reviewRequired ? "Manual review" : result.mappingStatus}
        </Tag>
        {result.rawMessageId ? (
          <div className="fixture-controls">
            <select
              aria-label={`Classification for ${result.providerTitle}`}
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
              onChange={(event) => onRedactedChange(event.target.value)}
              placeholder="Optional redacted fixture text"
              ref={textareaRef}
              value={redactedText}
            />
            <button
              onClick={() => {
                const text = textareaRef.current?.value.trim() ?? "";
                void onSaveFixture(text);
              }}
              title="Save parser fixture"
              type="button"
            >
              Save fixture
            </button>
            {status ? <small>{status}</small> : null}
          </div>
        ) : null}
      </div>
    </article>
  );
}
