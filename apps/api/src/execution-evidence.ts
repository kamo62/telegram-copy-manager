import type { ParsedSignal } from "@telegram-tc/core";

export type OpenEvidencePolicy = "structured-id" | "prose-complete";
export type EvidenceTier = "action-required" | "fyi";

export interface ExecutionEvidenceProviderConfig {
  openEvidence: OpenEvidencePolicy;
}

export interface LifecycleResolutionEvidence {
  method: "provider-order-id" | "reply-link" | "inline-quote" | "same-symbol-fallback" | "none";
  status: "MATCHED" | "AMBIGUOUS" | "UNMATCHED";
  activeTradeCount: number;
  suggestion?: string;
}

export interface OrderIdNoveltyLookup {
  providerOrderIdNeverSeen: boolean;
}

export interface ExecutionEvidenceInput {
  parsedSignal: ParsedSignal;
  providerConfig: ExecutionEvidenceProviderConfig;
  lifecycleResolution?: LifecycleResolutionEvidence;
  orderIdNovelty: OrderIdNoveltyLookup;
  forwarded: boolean;
}

export type ExecutionEvidenceVerdict = {
  verdict: "EXECUTE" | "HOLD" | "DROP";
  reason: string;
  tier?: EvidenceTier;
  suggestion?: string;
};

export function evaluateExecutionEvidence(input: ExecutionEvidenceInput): ExecutionEvidenceVerdict {
  const { parsedSignal: signal } = input;
  const demotionMarkers = signal.evidence?.demotionMarkers ?? [];
  if (signal.commandType === "NO_SIGNAL" && hasRiskOffVocabulary(signal.originalText)) {
    return hold("RISK_OFF_NO_SIGNAL", "action-required");
  }
  const base =
    signal.commandType === "OPEN_TRADE"
      ? evaluateOpen(input)
      : isLifecycleCandidate(signal)
        ? evaluateLifecycle(input)
        : demotionMarkers.length > 0
          ? hold("DEMOTION_MARKER", "fyi")
          : drop("NO_EXECUTABLE_SIGNAL");

  if (base.verdict !== "EXECUTE") return base;
  if (input.forwarded) return hold("FORWARDED_MESSAGE", "fyi");
  if (demotionMarkers.length > 0) {
    return hold(`DEMOTION_MARKER:${demotionMarkers.join(",")}`, "fyi");
  }
  return base;
}

function evaluateOpen(input: ExecutionEvidenceInput): ExecutionEvidenceVerdict {
  const signal = input.parsedSignal;
  if (signal.closeAll) return hold("CLOSE_ALL_REQUIRES_LATER_GATE");
  if (!hasCompleteGeometry(signal)) return hold("OPEN_GEOMETRY_INCOMPLETE");

  if (input.providerConfig.openEvidence === "structured-id") {
    if (signal.evidence?.structuralKind !== "copier-new") {
      return hold("STRUCTURED_OPEN_EVIDENCE_REQUIRED");
    }
    if (!signal.providerOrderId) return hold("OPEN_PROVIDER_ORDER_ID_REQUIRED");
    if (!input.orderIdNovelty.providerOrderIdNeverSeen) {
      return hold("OPEN_PROVIDER_ORDER_ID_RESEEN");
    }
    return execute("STRUCTURED_OPEN_EVIDENCE");
  }

  if (input.providerConfig.openEvidence === "prose-complete") {
    if (hasActivationVocabulary(signal)) return hold("OPEN_ACTIVATION_VOCABULARY");
    return execute("COMPLETE_PROSE_OPEN_EVIDENCE");
  }

  return hold("OPEN_EVIDENCE_POLICY_REQUIRED");
}

function evaluateLifecycle(input: ExecutionEvidenceInput): ExecutionEvidenceVerdict {
  if (input.parsedSignal.closeAll) return hold("CLOSE_ALL_REQUIRES_OPERATOR");
  const resolution = input.lifecycleResolution;
  if (resolution?.method === "inline-quote") {
    if (resolution.status === "MATCHED" && resolution.activeTradeCount === 1) {
      return execute("LIFECYCLE_INLINE_QUOTE");
    }
    return {
      ...hold(
        resolution.status === "UNMATCHED"
          ? "INLINE_QUOTE_ORIGIN_UNMATCHED"
          : resolution.status === "AMBIGUOUS"
            ? "INLINE_QUOTE_ORIGIN_AMBIGUOUS"
            : `INLINE_QUOTE_ACTIVE_TRADE_COUNT:${resolution.activeTradeCount}`,
      ),
      ...(resolution.suggestion ? { suggestion: resolution.suggestion } : {}),
    };
  }
  if (
    resolution &&
    (resolution.method === "provider-order-id" || resolution.method === "reply-link") &&
    resolution.status === "MATCHED" &&
    resolution.activeTradeCount === 1
  ) {
    return execute(`LIFECYCLE_${resolution.method.toUpperCase()}`);
  }

  return {
    ...hold("LIFECYCLE_RESOLUTION_REQUIRED"),
    ...(resolution?.suggestion ? { suggestion: resolution.suggestion } : {}),
  };
}

function isLifecycleCandidate(signal: ParsedSignal) {
  return (
    signal.commandType !== "OPEN_TRADE" &&
    signal.commandType !== "NO_SIGNAL" &&
    signal.commandType !== "TRADE_SETUP"
  );
}

function hasRiskOffVocabulary(text: string) {
  return /\b(?:CLOSE(?:D|S|ING)?|CANCEL(?:LED|ED|S|ING)?|DELETE(?:D|S|ING)?|REMOVE(?:D|S|ING)?)\b/i.test(
    text,
  );
}

function hasCompleteGeometry(signal: ParsedSignal) {
  return Boolean(
    signal.direction &&
      signal.rawSymbol &&
      signal.entry &&
      Number.isFinite(signal.entry.from) &&
      Number.isFinite(signal.stopLoss) &&
      signal.takeProfits.some((target) => Number.isFinite(target.price)),
  );
}

function hasActivationVocabulary(signal: ParsedSignal) {
  return signal.matchedPatternIds.some((pattern) => pattern.startsWith("lifecycle.activation"));
}

function execute(reason: string): ExecutionEvidenceVerdict {
  return { verdict: "EXECUTE", reason };
}

function hold(reason: string, tier: EvidenceTier = "action-required"): ExecutionEvidenceVerdict {
  return { verdict: "HOLD", reason, tier };
}

function drop(reason: string): ExecutionEvidenceVerdict {
  return { verdict: "DROP", reason };
}
