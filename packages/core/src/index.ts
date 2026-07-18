export type Direction = "BUY" | "SELL";
export type OrderType = "MARKET" | "LIMIT" | "STOP";
export type ParserMode = "automatic" | "aggressive";
export type CommandType =
  | "NO_SIGNAL"
  | "OPEN_TRADE"
  | "CANCEL_PENDING"
  | "CLOSE_TRADE"
  | "CLOSE_PARTIAL"
  | "MOVE_SL_TO_BE"
  | "MODIFY_SL"
  | "MODIFY_TP"
  | "TRAILING_STOP"
  | "MARK_TP_HIT"
  | "TRADE_SETUP";
export type MappingStatus = "mapped" | "unmapped" | "ambiguous" | "excluded" | "unavailable";
export type ExecutionMode = "VIRTUAL_TP" | "SPLIT_ORDER";
export type QueueStatus =
  | "PENDING"
  | "LEASED"
  | "EXECUTED"
  | "FAILED"
  | "IGNORED"
  | "DUPLICATE"
  | "EXPIRED"
  | "HELD"
  | "DISMISSED";

export interface AccountSymbolMapping {
  accountId: string;
  canonicalOverrides?: Record<string, string>;
  directBrokerOverrides?: Record<string, string>;
  prefix?: string;
  suffix?: string;
  includeSymbols?: string[];
  excludeSymbols?: string[];
  availableBrokerSymbols?: string[];
}

export interface ParserContext {
  providerId?: string;
  accountId?: string;
  parserMode?: ParserMode | string;
  globalAliases?: Record<string, string>;
  providerAliases?: Record<string, Record<string, string>>;
  providerDefaultSymbols?: Record<string, string>;
  geometryInferenceSymbol?: string;
  referencePrices?: Record<string, number>;
  accountMappings?: Record<string, AccountSymbolMapping>;
  defaultStopLoss?: DistanceInstruction;
  defaultTakeProfit?: DistanceInstruction;
  /** Per-provider opt-in for terse shorthand-level posts ("41 / 56 / 03" expanded
   * from a live reference price). Off by default: the grammar is loose enough to
   * read prose as levels, so it only runs for providers that explicitly enable it. */
  shorthandLevels?: boolean;
}

export interface SymbolResolution {
  rawSymbol: string;
  canonicalSymbol?: string;
  brokerSymbol?: string;
  mappingStatus: MappingStatus;
  mappingSource:
    | "manual"
    | "provider_alias"
    | "account_direct"
    | "account_override"
    | "global_alias"
    | "broker_exact"
    | "broker_variant"
    | "prefix_suffix"
    | "fallback";
  warnings: string[];
}

export interface PriceZone {
  from: number;
  to?: number;
}

export interface TakeProfitTarget {
  leg: number;
  price?: number;
  allocationPercent: number;
  volume?: number;
  targetSource?: "explicit" | "default-distance";
  defaultDistance?: DistanceInstruction;
  strategy?: TakeProfitStrategy;
}

export interface PartialCloseInstruction {
  kind: "PERCENT" | "TP_LEG" | "LOTS";
  value: number;
  allocationPercent?: number;
  volume?: number;
}

export interface DistanceInstruction {
  value: number;
  unit: "PIPS" | "POINTS";
}

export interface ParsedSignal {
  originalText: string;
  commandType: CommandType;
  direction?: Direction;
  orderType?: OrderType;
  rawSymbol?: string;
  canonicalSymbol?: string;
  brokerSymbol?: string;
  mappingStatus: MappingStatus;
  mappingSource: SymbolResolution["mappingSource"];
  mappingWarnings: string[];
  entry?: PriceZone;
  stopLoss?: number;
  defaultStopLoss?: DistanceInstruction;
  takeProfits: TakeProfitTarget[];
  defaultTakeProfit?: DistanceInstruction;
  lotSize?: number;
  riskPercent?: number;
  newStopLoss?: number;
  trailingStop?: DistanceInstruction;
  partialClose?: PartialCloseInstruction;
  confidence: number;
  matchedPatternIds: string[];
  missingFields: string[];
  warnings: string[];
  providerId?: string;
  accountId?: string;
  executionMode?: ExecutionMode;
  /** Provider-side order id (e.g. VIP Gold "# 299490138"), when the message carries one. */
  providerOrderId?: string;
  fingerprint: string;
}

export interface LogicalTrade {
  id: string;
  providerId?: string;
  accountId?: string;
  source?: TradeSource;
  symbol: SymbolResolution;
  direction: Direction;
  status: "PLANNED" | "OPEN" | "PENDING" | "CLOSED" | "OUT_OF_SYNC" | "CANCELLED" | "ARCHIVED";
  executionMode: ExecutionMode;
  entry?: PriceZone;
  stopLoss?: number;
  legs: TradeLeg[];
  commandHistory: Array<{ commandType: CommandType; text: string; at: string }>;
  openedAt: string;
  outOfSyncReason?: string;
  livePositionExists?: boolean;
  matchedBrokerTickets?: string[];
  brokerComment?: string;
  lastSnapshotAt?: string;
}

export interface TradeSource {
  parsedSignalId: string;
  rawMessageId: string;
  telegramMessageId: string;
  messageDate: string;
  rawText: string;
}

export interface TradeLeg {
  leg: number;
  targetPrice?: number;
  targetSource?: "explicit" | "default-distance";
  defaultDistance?: DistanceInstruction;
  allocationPercent: number;
  strategy?: TakeProfitStrategy;
  status: "PLANNED" | "OPEN" | "HIT" | "CLOSED" | "SKIPPED" | "FAILED" | "UNKNOWN";
  brokerEvidence?: string;
}

export type TakeProfitStrategy =
  | { kind: "set-sl-to-entry"; offsetPips: number }
  | { kind: "set-sl-to-tp"; tpLeg: number; offsetPips: number }
  | { kind: "no-change" };

export interface RunnerConfig {
  enabled: boolean;
  lotSize: number;
  slBehavior: "break-even" | "last-tp" | "trail" | string;
  trailPips: number;
}

export interface LifecycleMatch {
  status: "MATCHED" | "UNMATCHED" | "AMBIGUOUS";
  tradeId?: string;
  confidence: number;
  requiresManualReview: boolean;
  reason?: string;
}

export interface ExecutionQueueItem {
  id: string;
  accountId?: string;
  logicalTradeId?: string;
  status: QueueStatus;
  leasedAt?: string;
  payload: {
    commandType: CommandType;
    brokerSymbol?: string;
    canonicalSymbol?: string;
    direction?: Direction;
    orderType?: OrderType;
    entry?: PriceZone;
    stopLoss?: number;
    defaultStopLoss?: DistanceInstruction;
    newStopLoss?: number;
    trailingStop?: DistanceInstruction;
    partialClose?: PartialCloseInstruction;
    takeProfits: TakeProfitTarget[];
    defaultTakeProfit?: DistanceInstruction;
    runner?: RunnerConfig;
    executionMode: ExecutionMode;
    volume?: number;
    riskPercent?: number;
    targetOrderTicket?: string;
    targetPositionTicket?: string;
    targetDealTicket?: string;
    originalText: string;
  };
}

const DEFAULT_CANONICAL_SYMBOLS = new Set([
  "AUDCAD",
  "AUDJPY",
  "AUDUSD",
  "BTCUSD",
  "DJI30",
  "EURCAD",
  "EURGBP",
  "EURJPY",
  "EURUSD",
  "GBPJPY",
  "GBPUSD",
  "NAS100",
  "NZDUSD",
  "US30",
  "US100",
  "SPX500",
  "GER40",
  "UK100",
  "JP225",
  "USDCHF",
  "USDJPY",
  "USOIL",
  "XAGUSD",
  "XAUUSD",
]);

const BUILT_IN_ALIASES: Record<string, string> = {
  GOLD: "XAUUSD",
  "XAU/USD": "XAUUSD",
  SILVER: "XAGUSD",
  "EUR/USD": "EURUSD",
  "GBP/USD": "GBPUSD",
  US30: "US30",
  DOW: "DJI30",
  DJIA: "DJI30",
  WS30: "DJI30",
  NASDAQ: "NAS100",
  NAS100: "NAS100",
  US100: "US100",
  USTEC: "NAS100",
  NDX: "NAS100",
  NASDAQ100: "NAS100",
  SPX500: "SPX500",
  SPX: "SPX500",
  SP500: "SPX500",
  US500: "SPX500",
  GER40: "GER40",
  GER30: "GER40",
  DE40: "GER40",
  DE30: "GER40",
  DAX: "GER40",
  DAX40: "GER40",
  UK100: "UK100",
  FTSE: "UK100",
  FTSE100: "UK100",
  JP225: "JP225",
  JPN225: "JP225",
  NIKKEI: "JP225",
  N225: "JP225",
  WTI: "USOIL",
  WTIUSD: "USOIL",
  "WTI/USD": "USOIL",
  XTIUSD: "USOIL",
  CRUDE: "USOIL",
  USOIL: "USOIL",
};

const BROKER_SYMBOL_VARIANTS: Record<string, string[]> = {
  BTCUSD: ["BTCUSD", "BTCUSD#", "BTCUSDm", "BTCUSD.raw", "BTCUSD.r", "BTCUSD.pro"],
  DJI30: ["DJI30", "DJI30#", "DJI30.raw", "DJI30.r", "US30", "US30#", "US30.raw", "US30.r"],
  EURUSD: ["EURUSD", "EURUSD#", "EURUSDm", "EURUSD.raw", "EURUSD.r", "EURUSD.pro"],
  GBPUSD: ["GBPUSD", "GBPUSD#", "GBPUSDm", "GBPUSD.raw", "GBPUSD.r", "GBPUSD.pro"],
  NAS100: ["NAS100", "NAS100#", "NAS100.raw", "NAS100.r", "USTEC", "USTEC#", "USTEC.raw"],
  US30: ["US30", "US30#", "US30.raw", "US30.r", "DJI30", "DJI30#", "DJI30.raw", "DJI30.r"],
  XAGUSD: ["XAGUSD", "XAGUSD#", "XAGUSDm", "XAGUSD.raw", "XAGUSD.r", "SILVER", "SILVER#"],
  XAUUSD: [
    "XAUUSD",
    "XAUUSD#",
    "XAUUSDm",
    "XAUUSDr",
    "XAUUSD.raw",
    "XAUUSD.r",
    "XAUUSD.pro",
    "GOLD",
    "GOLD#",
    "GOLD.raw",
    "GOLD.r",
  ],
};

const COMMAND_ALIASES = new Set([
  "BUY",
  "SELL",
  "LIMIT",
  "STOP",
  "NOW",
  "ENTRY",
  "SL",
  "TP",
  "TP1",
  "TP2",
  "TP3",
  "TP4",
  "CLOSE",
  "CANCEL",
  "PENDING",
  "SCALP",
  "SCALPS",
  "SCENARIO",
  "SETUP",
  "SIGNAL",
  "TRADE",
  "MOVE",
  "MODIFY",
  "UPDATE",
  "DELETED",
  "NEW",
  "CLOSED",
  "ORDER",
  "POSITION",
  "POSITIONS",
  "OPPORTUNITY",
  "OPPORTUNITIES",
  "FOLLOW",
  "EMOTION",
  "OUTLOOK",
]);

function normalizeSymbolText(symbol: string): string {
  return symbol.toUpperCase().replace(/\s+/g, "").replace("-", "").trim();
}

function canonicalKey(value: string): string {
  return value.toUpperCase().trim();
}

function brokerSymbolKey(value: string): string {
  return value
    .toUpperCase()
    .replace(/[\s/_.#-]/g, "")
    .trim();
}

export function resolveSymbol(rawSymbol: string, context: ParserContext = {}): SymbolResolution {
  const raw = rawSymbol.trim();
  const normalized = normalizeSymbolText(raw);
  const account = context.accountId ? context.accountMappings?.[context.accountId] : undefined;
  const directBrokerSymbol = findDirectBrokerOverride(raw, account?.directBrokerOverrides);
  const providerAliases = context.providerId
    ? context.providerAliases?.[context.providerId]
    : undefined;
  const providerMatch = findAliasMatch(raw, providerAliases);
  const builtInOrGlobal = {
    ...BUILT_IN_ALIASES,
    ...(context.globalAliases ?? {}),
  };
  const globalMatch = findAliasMatch(raw, builtInOrGlobal);
  const canonicalSymbol = directBrokerSymbol
    ? (canonicalFromBrokerVariant(directBrokerSymbol) ?? directBrokerSymbol)
    : (providerMatch ??
      globalMatch ??
      canonicalFromBrokerVariant(raw) ??
      normalized.replace("/", ""));
  let mappingSource: SymbolResolution["mappingSource"] = directBrokerSymbol
    ? "account_direct"
    : providerMatch
      ? "provider_alias"
      : globalMatch
        ? "global_alias"
        : "fallback";
  const warnings: string[] = [];

  if (!directBrokerSymbol && !isRecognizedCanonical(canonicalSymbol)) {
    return {
      rawSymbol: raw,
      canonicalSymbol,
      mappingStatus: "unmapped",
      mappingSource,
      warnings: ["Symbol could not be mapped to a broker symbol"],
    };
  }

  const availableBrokerSymbols = normalizedSymbolList(account?.availableBrokerSymbols);
  let brokerSymbol = directBrokerSymbol
    ? (findAvailableBrokerSymbol([directBrokerSymbol], availableBrokerSymbols) ??
      directBrokerSymbol)
    : canonicalSymbol;
  if (!directBrokerSymbol && account?.canonicalOverrides?.[canonicalSymbol]) {
    brokerSymbol = account.canonicalOverrides[canonicalSymbol];
    mappingSource = "account_override";
  } else if (!directBrokerSymbol && availableBrokerSymbols.length) {
    const exact = findAvailableBrokerSymbol([canonicalSymbol], availableBrokerSymbols);
    if (exact) {
      brokerSymbol = exact;
      mappingSource = "broker_exact";
    } else {
      const variant = findAvailableBrokerSymbol(
        brokerVariantCandidates(canonicalSymbol).filter(
          (candidate) => candidate !== canonicalSymbol,
        ),
        availableBrokerSymbols,
      );
      if (variant) {
        brokerSymbol = variant;
        mappingSource = "broker_variant";
      } else {
        const prefixSuffix = findAvailableBrokerSymbol(
          prefixSuffixCandidates(canonicalSymbol, account),
          availableBrokerSymbols,
        );
        if (prefixSuffix) {
          brokerSymbol = prefixSuffix;
          mappingSource = "prefix_suffix";
        }
      }
    }
  } else if (!directBrokerSymbol) {
    const prefixSuffix = prefixSuffixCandidates(canonicalSymbol, account)[0];
    if (prefixSuffix) {
      brokerSymbol = prefixSuffix;
      mappingSource = "prefix_suffix";
    }
  }

  if (
    symbolListIncludes(account?.excludeSymbols, brokerSymbol) ||
    symbolListIncludes(account?.excludeSymbols, canonicalSymbol)
  ) {
    warnings.push("Symbol is excluded for this account");
    return {
      rawSymbol: raw,
      canonicalSymbol,
      brokerSymbol,
      mappingStatus: "excluded",
      mappingSource,
      warnings,
    };
  }

  if (
    account?.includeSymbols?.length &&
    !symbolListIncludes(account.includeSymbols, brokerSymbol)
  ) {
    warnings.push("Symbol is outside the account include list");
    return {
      rawSymbol: raw,
      canonicalSymbol,
      brokerSymbol,
      mappingStatus: "unavailable",
      mappingSource,
      warnings,
    };
  }

  if (availableBrokerSymbols.length && !symbolListIncludes(availableBrokerSymbols, brokerSymbol)) {
    warnings.push("Broker symbol was mapped but is not in the EA-reported symbol list");
    return {
      rawSymbol: raw,
      canonicalSymbol,
      brokerSymbol,
      mappingStatus: "unavailable",
      mappingSource,
      warnings,
    };
  }

  return {
    rawSymbol: raw,
    canonicalSymbol,
    brokerSymbol,
    mappingStatus: "mapped",
    mappingSource,
    warnings,
  };
}

function findDirectBrokerOverride(rawSymbol: string, overrides?: Record<string, string>) {
  if (!overrides) return undefined;
  const rawKey = canonicalKey(rawSymbol);
  const normalizedRaw = normalizeSymbolText(rawSymbol);
  const brokerRaw = brokerSymbolKey(rawSymbol);
  return Object.entries(overrides).find(([alias]) => {
    return (
      canonicalKey(alias) === rawKey ||
      normalizeSymbolText(alias) === normalizedRaw ||
      brokerSymbolKey(alias) === brokerRaw
    );
  })?.[1];
}

export function parseSignalText(originalText: string, context: ParserContext = {}): ParsedSignal {
  const original = originalText.replace(/\r\n/g, "\n").trim();
  const candidate = extractSignalCandidate(original);
  const text = candidate.text;
  const upper = text.toUpperCase();
  const matchedPatternIds: string[] = [...candidate.matchedPatternIds];
  const warnings: string[] = [];
  const missingFields: string[] = [];
  let commandType = detectCommandType(upper, matchedPatternIds);
  let direction = detectDirection(upper);
  let orderType: OrderType | undefined = detectOrderType(upper);
  let entry = commandType === "OPEN_TRADE" ? extractEntry(text, direction, orderType) : undefined;
  const stopLossResult = extractStopLoss(text);
  const stopLoss = stopLossResult.value;
  const takeProfits = extractTakeProfits(text);
  let geometryInferred = false;
  if (
    commandType === "NO_SIGNAL" &&
    context.geometryInferenceSymbol &&
    (!candidate.quotedText || candidate.commentText === text) &&
    !/Quoted signal:/i.test(text) &&
    !/\b\d+\s*PIPS?\b/i.test(text) &&
    !/\b(still valid|as posted|from earlier|reminder|recap|already)\b/i.test(text) &&
    stopLoss !== undefined &&
    takeProfits.length > 0
  ) {
    const inferredEntry = extractEntry(text, undefined, orderType);
    const inferredDirection = inferDirectionFromPrices(inferredEntry, stopLoss, takeProfits);
    const entryValues = inferredEntry
      ? [inferredEntry.from, ...(inferredEntry.to === undefined ? [] : [inferredEntry.to])]
      : [];
    const exitValues = [
      stopLoss,
      ...takeProfits.flatMap((target) => (target.price === undefined ? [] : [target.price])),
    ];
    if (
      inferredEntry &&
      inferredDirection &&
      entryValues.every((value) => !exitValues.includes(value))
    ) {
      commandType = "OPEN_TRADE";
      direction = inferredDirection;
      entry = inferredEntry;
      geometryInferred = true;
      const noisePattern = matchedPatternIds.indexOf("noise.no-signal");
      if (noisePattern !== -1) matchedPatternIds.splice(noisePattern, 1);
      matchedPatternIds.push("open.geometry-inferred");

      const referencePrice = referencePriceForSymbol(context.geometryInferenceSymbol, context);
      const entryLow = Math.min(entry.from, entry.to ?? entry.from);
      const entryHigh = Math.max(entry.from, entry.to ?? entry.from);
      if (/\bLIMITS?\b/.test(upper)) {
        orderType = "LIMIT";
      } else if (hasPendingStopToken(upper)) {
        orderType = "STOP";
      } else if (referencePrice !== undefined) {
        if (direction === "BUY") {
          orderType =
            entryHigh < referencePrice ? "LIMIT" : entryLow > referencePrice ? "STOP" : undefined;
        } else {
          orderType =
            entryLow > referencePrice ? "LIMIT" : entryHigh < referencePrice ? "STOP" : undefined;
        }
      } else {
        orderType = undefined;
      }

      const referenceGeometryValid =
        referencePrice === undefined ||
        orderType === undefined ||
        (direction === "BUY" && orderType === "LIMIT" && entryHigh < referencePrice) ||
        (direction === "BUY" && orderType === "STOP" && entryLow > referencePrice) ||
        (direction === "SELL" && orderType === "LIMIT" && entryLow > referencePrice) ||
        (direction === "SELL" && orderType === "STOP" && entryHigh < referencePrice);
      if (orderType === undefined) {
        warnings.push("Geometry-inferred order type requires operator review");
      } else if (!referenceGeometryValid) {
        warnings.push("Geometry-inferred order type conflicts with the reference price");
      }

      const pendingStop = text.match(/\bSTOPS?\s+(?:FOR|AT)\s+(\d{1,2})\b/i);
      if (pendingStop?.[1]) {
        const expanded =
          referencePrice === undefined
            ? undefined
            : expandShortLevel(pendingStop[1], referencePrice);
        warnings.push(
          `Geometry-inferred signal also references pending stops at ${expanded ?? pendingStop[1]}`,
        );
      }
    }
  }
  const lotSize = commandType === "OPEN_TRADE" ? extractLotSize(text) : undefined;
  const riskPercent = commandType === "OPEN_TRADE" ? extractRiskPercent(text) : undefined;
  direction ??= inferDirectionFromPrices(entry, stopLoss, takeProfits);
  const rawSymbol = geometryInferred
    ? context.geometryInferenceSymbol
    : extractRawSymbol(text, context, commandType);
  const symbol = rawSymbol
    ? resolveSymbol(rawSymbol, context)
    : {
        rawSymbol: "",
        mappingStatus: "unmapped" as MappingStatus,
        mappingSource: "fallback" as const,
        warnings: ["No provider symbol found"],
      };
  const newStopLoss = commandType === "MODIFY_SL" ? extractLifecyclePrice(text, "SL") : undefined;
  const trailingStop = commandType === "TRAILING_STOP" ? extractTrailingStop(upper) : undefined;
  const partialClose = commandType === "CLOSE_PARTIAL" ? extractPartialClose(upper) : undefined;
  const quotedSignal =
    candidate.quotedText && commandType !== "OPEN_TRADE" && commandType !== "NO_SIGNAL"
      ? parseSignalText(candidate.quotedText, { ...context, geometryInferenceSymbol: undefined })
      : undefined;
  const inheritedSymbol = quotedSignal?.canonicalSymbol ? quotedSignal : undefined;
  const effectiveRawSymbol = rawSymbol ?? inheritedSymbol?.rawSymbol;
  const effectiveCanonicalSymbol = symbol.canonicalSymbol ?? inheritedSymbol?.canonicalSymbol;
  const effectiveBrokerSymbol = symbol.brokerSymbol ?? inheritedSymbol?.brokerSymbol;
  const effectiveMappingStatus = rawSymbol
    ? symbol.mappingStatus
    : (inheritedSymbol?.mappingStatus ?? symbol.mappingStatus);
  const effectiveMappingWarnings = rawSymbol
    ? symbol.warnings
    : (inheritedSymbol?.mappingWarnings ?? symbol.warnings);
  const effectiveMappingSource = rawSymbol
    ? symbol.mappingSource
    : (inheritedSymbol?.mappingSource ?? symbol.mappingSource);
  const defaultStopLoss =
    commandType === "OPEN_TRADE" && stopLoss === undefined ? context.defaultStopLoss : undefined;
  const defaultTakeProfit =
    commandType === "OPEN_TRADE" && takeProfits.length === 0
      ? context.defaultTakeProfit
      : undefined;

  if (direction && rawSymbol && commandType === "OPEN_TRADE") {
    matchedPatternIds.push(entry ? "open.direction-symbol-entry" : "open.direction-symbol-market");
  }
  if (commandType === "OPEN_TRADE" && isDirectionalZoneSignal(upper)) {
    matchedPatternIds.push("open.directional-entry-zones");
  }
  if (takeProfits.length > 0) {
    matchedPatternIds.push("targets.tp");
  }
  if (stopLoss !== undefined) {
    matchedPatternIds.push("risk.stop-loss");
  }
  if (stopLossResult.conflict) {
    warnings.push("Conflicting stop-loss values found; using the explicit STOP LOSS value");
  }

  if (commandType === "OPEN_TRADE") {
    if (!direction) missingFields.push("direction");
    if (geometryInferred && !orderType) missingFields.push("orderType");
    if (!effectiveRawSymbol) missingFields.push("symbol");
    if (effectiveMappingStatus !== "mapped") missingFields.push("brokerSymbol");
    if ((orderType === "LIMIT" || orderType === "STOP") && !entry) missingFields.push("entry");
    if (stopLoss === undefined && !defaultStopLoss) missingFields.push("stopLoss");
    if (takeProfits.length === 0 && !defaultTakeProfit) missingFields.push("takeProfit");
  } else if (commandType !== "NO_SIGNAL" && !rawSymbol && commandType !== "CLOSE_TRADE") {
    if (!inheritedSymbol?.canonicalSymbol) missingFields.push("symbol");
  }
  if (commandType === "MODIFY_SL" && newStopLoss === undefined) {
    missingFields.push("newStopLoss");
  }
  if (commandType === "TRAILING_STOP" && !trailingStop) {
    missingFields.push("trailingStop");
  }

  if (commandType !== "NO_SIGNAL" && effectiveMappingStatus !== "mapped") {
    warnings.push("Symbol could not be mapped to a broker symbol");
  }
  if (commandType !== "NO_SIGNAL") {
    warnings.push(...effectiveMappingWarnings);
  }

  const confidence = calculateConfidence({
    commandType,
    direction,
    symbolStatus: effectiveMappingStatus,
    hasEntry: Boolean(entry),
    hasStopLoss: stopLoss !== undefined || Boolean(defaultStopLoss),
    takeProfitCount: takeProfits.length || (defaultTakeProfit ? 1 : 0),
    missingFieldCount: missingFields.length,
  });

  return {
    originalText: original,
    commandType,
    direction,
    orderType: commandType === "OPEN_TRADE" ? orderType : undefined,
    rawSymbol: effectiveRawSymbol ?? undefined,
    canonicalSymbol: effectiveCanonicalSymbol,
    brokerSymbol: effectiveBrokerSymbol,
    mappingStatus: effectiveMappingStatus,
    mappingSource: effectiveMappingSource,
    mappingWarnings: effectiveMappingWarnings,
    entry,
    stopLoss,
    defaultStopLoss,
    takeProfits,
    defaultTakeProfit,
    lotSize,
    riskPercent,
    newStopLoss,
    trailingStop,
    partialClose,
    confidence,
    matchedPatternIds: [...new Set(matchedPatternIds)],
    missingFields,
    warnings: [...new Set(warnings)],
    providerId: context.providerId,
    accountId: context.accountId,
    providerOrderId: text.match(/#\s*(\d{6,})/)?.[1],
    fingerprint: createMessageFingerprint(original),
  };
}

/** Cap on how many entries one message may expand into (ladder or zone), so a
 * false positive or an oversized post can never spray unbounded orders. */
const MAX_ENTRIES_PER_SIGNAL = 5;

export function parseSignalTexts(
  originalText: string,
  context: ParserContext = {},
): ParsedSignal[] {
  const candidate = extractSignalCandidate(originalText.replace(/\r\n/g, "\n").trim());

  // Shorthand ladder levels (e.g. "41 / 56 / 03" expanded from a live reference
  // price) are part of the default path now, gated by an explicit per-provider
  // capability that is off by default (the grammar is loose enough to read prose as
  // levels). Never runs on a quoted reply, and only when a provider default symbol
  // plus a reference price make the levels resolvable. Runs before the base parse so
  // a terse level post expands instead of being read as one literal entry, and is
  // capped so a false positive cannot spray orders.
  if (context.shorthandLevels && !candidate.quotedText && !/Quoted signal:/i.test(candidate.text)) {
    const ladder = parseKalVipExtendedLevelSignals(originalText, candidate.text, context);
    if (ladder.length > 0) return ladder.slice(0, MAX_ENTRIES_PER_SIGNAL);
  }

  const base = parseSignalText(originalText, context);
  const prices = extractDirectionalZonePrices(candidate.text);
  if (base.commandType !== "OPEN_TRADE" || prices.length <= 1) return [base];

  return prices.slice(0, MAX_ENTRIES_PER_SIGNAL).map((price, index) => ({
    ...base,
    entry: { from: price },
    fingerprint: createMessageFingerprint(`${base.originalText}\nzone-entry:${index + 1}:${price}`),
  }));
}

export function shouldRequireManualReview(signal: ParsedSignal, aggressive = false): boolean {
  // Aggressive mode executes the parser's "guessed" opens (low confidence and
  // direction/entry inferred from price geometry) instead of holding them. It does
  // NOT waive the genuine safety holds below: an unmapped symbol, a missing field
  // (including a pending order with no level), conflicting stop geometry, or a
  // non-signal all still hold in both modes.
  return (
    (!aggressive && signal.confidence < 0.75) ||
    signal.mappingStatus !== "mapped" ||
    (signal.commandType === "OPEN_TRADE" && signal.missingFields.length > 0) ||
    (signal.commandType !== "OPEN_TRADE" &&
      signal.missingFields.some((field) => field !== "symbol")) ||
    signal.commandType === "TRADE_SETUP" ||
    signal.commandType === "NO_SIGNAL" ||
    signal.warnings.some((warning) => warning.startsWith("Conflicting stop-loss values")) ||
    (!aggressive && signal.warnings.some((warning) => warning.startsWith("Geometry-inferred"))) ||
    (signal.commandType !== "OPEN_TRADE" && signal.missingFields.includes("symbol"))
  );
}

export function createLogicalTradeFromSignal(
  signal: ParsedSignal,
  options: {
    id: string;
    providerId?: string;
    accountId?: string;
    source?: TradeSource;
    executionMode: ExecutionMode;
    allocation?: number[];
  },
): LogicalTrade {
  if (signal.commandType !== "OPEN_TRADE" || !signal.direction) {
    throw new Error("Only open trade signals can create a logical trade");
  }
  const legs = logicalTradeLegs(signal, options.allocation);
  return {
    id: options.id,
    providerId: options.providerId ?? signal.providerId,
    accountId: options.accountId ?? signal.accountId,
    ...(options.source ? { source: options.source } : {}),
    symbol: {
      rawSymbol: signal.rawSymbol ?? "",
      canonicalSymbol: signal.canonicalSymbol,
      brokerSymbol: signal.brokerSymbol,
      mappingStatus: signal.mappingStatus,
      mappingSource: "fallback",
      warnings: signal.mappingWarnings,
    },
    direction: signal.direction,
    status: "OPEN",
    executionMode: options.executionMode,
    entry: signal.entry,
    stopLoss: signal.stopLoss,
    legs,
    commandHistory: [
      { commandType: signal.commandType, text: signal.originalText, at: new Date().toISOString() },
    ],
    openedAt: new Date().toISOString(),
  };
}

export function matchLifecycleCommandToTrade(
  command: ParsedSignal,
  trades: LogicalTrade[],
): LifecycleMatch {
  if (command.commandType === "OPEN_TRADE" || command.commandType === "NO_SIGNAL") {
    return {
      status: "UNMATCHED",
      confidence: 0,
      requiresManualReview: true,
      reason: "Open commands create trades instead of matching existing trades",
    };
  }

  const candidates = trades.filter((trade) => {
    const active =
      trade.status === "OPEN" || trade.status === "PENDING" || trade.status === "PLANNED";
    const sameProvider =
      !command.providerId || !trade.providerId || command.providerId === trade.providerId;
    const sameSymbol =
      !command.canonicalSymbol ||
      !trade.symbol.canonicalSymbol ||
      command.canonicalSymbol === trade.symbol.canonicalSymbol;
    return active && sameProvider && sameSymbol;
  });

  if (candidates.length === 1) {
    return {
      status: "MATCHED",
      tradeId: candidates[0]!.id,
      confidence: command.canonicalSymbol ? 0.92 : 0.8,
      requiresManualReview: false,
    };
  }

  if (candidates.length > 1) {
    return {
      status: "AMBIGUOUS",
      confidence: 0.45,
      requiresManualReview: true,
      reason: "Multiple open logical trades match this provider command",
    };
  }

  return {
    status: "UNMATCHED",
    confidence: 0.2,
    requiresManualReview: true,
    reason: "No open logical trade matched this provider command",
  };
}

export function buildExecutionCommand(
  signal: ParsedSignal,
  options: {
    id: string;
    accountId?: string;
    logicalTradeId?: string;
    executionMode?: ExecutionMode;
    volume?: number;
    riskPercent?: number;
    runner?: RunnerConfig;
  },
): ExecutionQueueItem {
  const takeProfits = withTakeProfitVolumes(
    normalizeTakeProfitAllocations(signal.takeProfits, signal.commandType),
    signal.commandType,
    options.volume,
    options.runner,
  );
  const partialClose = withPartialCloseVolume(
    signal.partialClose,
    signal.commandType,
    options.volume,
  );
  return {
    id: options.id,
    accountId: options.accountId ?? signal.accountId,
    logicalTradeId: options.logicalTradeId,
    status: "PENDING",
    payload: {
      commandType: signal.commandType,
      brokerSymbol: signal.brokerSymbol,
      canonicalSymbol: signal.canonicalSymbol,
      direction: signal.direction,
      orderType: signal.orderType,
      entry: signal.entry,
      stopLoss: signal.stopLoss,
      defaultStopLoss: signal.defaultStopLoss,
      newStopLoss: signal.newStopLoss,
      trailingStop: signal.trailingStop,
      partialClose,
      takeProfits,
      defaultTakeProfit: signal.defaultTakeProfit,
      runner: normalizeRunnerConfig(options.runner, options.volume),
      executionMode: options.executionMode ?? "VIRTUAL_TP",
      volume: options.volume,
      riskPercent: options.riskPercent,
      originalText: signal.originalText,
    },
  };
}

export function createMessageFingerprint(rawText: string): string {
  const normalized = rawText.toLowerCase().replace(/\s+/g, " ").trim();
  const digest = stableHash(normalized).toString(36);
  return `msg_${digest}`;
}

function findAliasMatch(rawSymbol: string, aliases?: Record<string, string>): string | undefined {
  if (!aliases) return undefined;
  const rawKey = canonicalKey(rawSymbol);
  const normalizedRaw = normalizeSymbolText(rawSymbol);
  const brokerRaw = brokerSymbolKey(rawSymbol);
  for (const [alias, canonical] of Object.entries(aliases)) {
    if (
      canonicalKey(alias) === rawKey ||
      normalizeSymbolText(alias) === normalizedRaw ||
      brokerSymbolKey(alias) === brokerRaw
    ) {
      return normalizeSymbolText(canonical).replace("/", "");
    }
  }
  return undefined;
}

function canonicalFromBrokerVariant(rawSymbol: string): string | undefined {
  const rawKey = brokerSymbolKey(rawSymbol);
  for (const [canonical, variants] of Object.entries(BROKER_SYMBOL_VARIANTS)) {
    if (brokerSymbolKey(canonical) === rawKey) return canonical;
    if (variants.some((variant) => brokerSymbolKey(variant) === rawKey)) return canonical;
  }
  return undefined;
}

function isRecognizedCanonical(symbol: string): boolean {
  return DEFAULT_CANONICAL_SYMBOLS.has(symbol) || /^[A-Z]{6}$/.test(symbol);
}

function brokerVariantCandidates(canonicalSymbol: string): string[] {
  return uniqueSymbols([canonicalSymbol, ...(BROKER_SYMBOL_VARIANTS[canonicalSymbol] ?? [])]);
}

function prefixSuffixCandidates(canonicalSymbol: string, account?: AccountSymbolMapping): string[] {
  if (!account?.prefix && !account?.suffix) return [];
  return [`${account.prefix ?? ""}${canonicalSymbol}${account.suffix ?? ""}`];
}

function findAvailableBrokerSymbol(candidates: string[], availableBrokerSymbols: string[]) {
  for (const candidate of candidates) {
    const match = availableBrokerSymbols.find(
      (symbol) => symbol.toUpperCase() === candidate.toUpperCase(),
    );
    if (match) return match;
  }
  return undefined;
}

function normalizedSymbolList(values?: string[]) {
  return values?.map((value) => value.trim()).filter(Boolean) ?? [];
}

function symbolListIncludes(values: string[] | undefined, symbol: string) {
  return Boolean(values?.some((value) => value.toUpperCase() === symbol.toUpperCase()));
}

function uniqueSymbols(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

// Some providers post in French. Map their trading vocabulary onto the English
// tokens the parser already understands, but only when a French buy/sell verb is
// actually present, so English text (and every current live provider) parses
// byte-identically and cannot regress.
const FRENCH_DIRECTION_RE =
  /\b(ACHAT|ACHATS|ACHETER|ACH[EÉÈ]TE|ACH[EÉÈ]TENT|VENTE|VENTES|VENDRE|VENDS|VEND|VENDEZ|VENDENT)\b/i;

function normalizeFrenchVocabulary(text: string): string {
  if (!FRENCH_DIRECTION_RE.test(text)) return text;
  return (
    text
      .replace(/\b(ACHAT|ACHATS|ACHETER|ACH[EÉÈ]TE|ACH[EÉÈ]TENT)\b/gi, "BUY")
      .replace(/\b(VENTE|VENTES|VENDRE|VENDS|VENDEZ|VENDENT|VEND)\b/gi, "SELL")
      // French writes decimals with a comma; convert only inside a French message.
      .replace(/(\d),(\d{2,})/g, "$1.$2")
      // Drop the article/preposition/filler that sits between verb, symbol and price
      // ("VENDRE L'EURNZD MAINTENANT À 1.99" -> "SELL EURNZD 1.99").
      .replace(/\bL['’]\s*/gi, " ")
      .replace(/\b(LES|LE|LA|DES|DU|AUX|AU|MAINTENANT)\b/gi, " ")
      .replace(/[àÀ]/g, " ")
      .replace(/[ \t]{2,}/g, " ")
      .trim()
  );
}

function extractSignalCandidate(text: string) {
  text = normalizeFrenchVocabulary(text);
  const quoted = text.match(/Quoted signal:\n([\s\S]*?)(?:\n\nComment:\n([\s\S]*))?$/i);
  if (
    quoted?.[1] &&
    /\b(PUT\s+THIS\s+BACK|PUT\s+.*BACK|REINSTATE|BACK\s+ON)\b/i.test(quoted[2] ?? "")
  ) {
    return {
      text: quoted[1].trim(),
      matchedPatternIds: ["quote.reinstated-signal"],
      quotedText: quoted[1].trim(),
      commentText: quoted[2]?.trim(),
    };
  }
  if (quoted?.[1] && quoted[2]) {
    return {
      text: quoted[2].trim(),
      matchedPatternIds: ["quote.reply-context"],
      quotedText: quoted[1].trim(),
      commentText: quoted[2].trim(),
    };
  }

  const execution = text.match(/\bExecution\s+(?:Model|Plan)\b[\s\S]*/i);
  if (
    execution?.[0] &&
    /\bENTRY\b/i.test(execution[0]) &&
    /\bSL\b/i.test(execution[0]) &&
    /\bTP\b/i.test(execution[0])
  ) {
    const end = execution[0].search(/\n\s*If\s+/i);
    return {
      text: (end > 0 ? execution[0].slice(0, end) : execution[0]).trim(),
      matchedPatternIds: ["analysis.execution-block"],
    };
  }

  return { text, matchedPatternIds: [], quotedText: undefined, commentText: undefined };
}

function detectCommandType(upper: string, matchedPatternIds: string[]): CommandType {
  if (isEducationOrAnalysisOnly(upper)) {
    matchedPatternIds.push("noise.education-analysis");
    return "NO_SIGNAL";
  }
  if (isConditionalTradeSetup(upper)) {
    matchedPatternIds.push("setup.conditional-or-multi-scenario");
    return "TRADE_SETUP";
  }
  // "Deleted <side> <type> on <symbol> # <id>" is a pending-order cancellation,
  // not a new open. Without this it parses as a BUY/SELL with the order id read
  // as an entry price. Keyed to the order id downstream via providerOrderId.
  if (/\bDELETED\s+(?:BUY|SELL)\b/.test(upper)) {
    matchedPatternIds.push("lifecycle.deleted-cancel");
    return "CANCEL_PENDING";
  }
  // "CLOSED - <symbol> <side>" (with the "{ CLOSED }" block / profit report) is the
  // provider closing its position. Align by closing our matching trade.
  if (/\bCLOSED\s*[-–—]\s*[A-Z]{2,}/.test(upper) || /\{\s*CLOSED\s*\}/.test(upper)) {
    matchedPatternIds.push("lifecycle.provider-closed");
    return "CLOSE_TRADE";
  }
  if (/\bTP\b.*\b(NOT\s+(?:REACHED|HIT)|WAIT|MONITOR)\b/.test(upper)) {
    matchedPatternIds.push("noise.tp-not-reached");
    return "NO_SIGNAL";
  }
  if (isTakeProfitHitUpdate(upper)) {
    matchedPatternIds.push("lifecycle.tp-hit");
    return "MARK_TP_HIT";
  }
  if (/\bTRAIL(?:ING)?\s+(?:STOP|SL)\b|\bTRAIL\s+BY\b/.test(upper)) {
    matchedPatternIds.push("lifecycle.trailing-stop");
    return "TRAILING_STOP";
  }
  if (isStopLossResultUpdate(upper) || isResultSummary(upper)) {
    matchedPatternIds.push("noise.result-update");
    return "NO_SIGNAL";
  }
  if (/\bCANCEL\b/.test(upper)) {
    matchedPatternIds.push("lifecycle.cancel");
    return "CANCEL_PENDING";
  }
  if (/\bMOVE\s+SL\b.*\b(BE|BREAK\s*EVEN|ENTRY)\b|\bSL\s+(TO\s+)?(BE|ENTRY)\b/.test(upper)) {
    matchedPatternIds.push("lifecycle.move-sl-be");
    return "MOVE_SL_TO_BE";
  }
  if (isCloseCommand(upper)) {
    matchedPatternIds.push("lifecycle.close");
    if (/\b(HALF|PARTIAL)\b|\b\d{1,3}\s*%(?=\s|$)|\bTP\s*[1-4]\b/.test(upper)) {
      return "CLOSE_PARTIAL";
    }
    return "CLOSE_TRADE";
  }
  if (/\b(MODIFY|UPDATE|SET)\b.*\bSL\b|\bSL\b.*\b(MODIFY|UPDATE|SET)\b/.test(upper)) {
    matchedPatternIds.push("lifecycle.modify-sl");
    return "MODIFY_SL";
  }
  if (
    /\b(MODIFY|UPDATE|SET)\b.*\bTP\s*[1-4]?\b|\bTP\s*[1-4]?\b.*\b(MODIFY|UPDATE|SET)\b/.test(upper)
  ) {
    matchedPatternIds.push("lifecycle.modify-tp");
    return "MODIFY_TP";
  }
  if (
    !/\b(BUY|SELL)\b/.test(upper) &&
    (/\b\d+\s*PIPS?\b/.test(upper) ||
      /\b(STILL VALID|AS POSTED|FROM EARLIER|REMINDER|RECAP|ALREADY)\b/.test(upper))
  ) {
    matchedPatternIds.push("noise.result-update");
    return "NO_SIGNAL";
  }
  if (hasOpenTradeIntent(upper)) return "OPEN_TRADE";
  matchedPatternIds.push("noise.no-signal");
  return "NO_SIGNAL";
}

function isEducationOrAnalysisOnly(upper: string): boolean {
  if (/\bExecution\s+(?:MODEL|PLAN)\b/i.test(upper)) return false;
  if (/^\s*GOLD\s+(BUY|SELL)\s+(LIMIT|STOP)\b/.test(upper)) return false;
  if (/^\s*(BUY|SELL)\b/.test(upper) && /\b(SL|TP|LIMIT|STOP)\b/.test(upper)) return false;
  return (
    /\b(I\s+(?:TAUGHT|MENTION|SAID|KNOW|SAW)|NOBODY\s+TOOK|THESE\s+AREN.?T\s+FOREIGN|I\s+WILL\s+NOT\s+PROVIDE\s+SIGNALS)\b/.test(
      upper,
    ) ||
    /\b(VALID\s+PINBAR|PINBAR\s+ENTRY\s+MODEL|MARKET\s+STRUCTURE|VOLUME\s+PROFILE|FIBONACCI|SMC\s*\/\s*ICT)\b/.test(
      upper,
    ) ||
    /\bPAY\s+CLOSE\s+ATTENTION\b/.test(upper)
  );
}

function isConditionalMultiScenarioPlan(upper: string): boolean {
  const hasBuyScenario =
    /\b(BUY\s+SCALP|BUY\s+SCENARIO|PRE[-\s]?NFP\s+BUY|IF\s+PRICE\s+DUMPS)\b/.test(upper);
  const hasSellScenario =
    /\b(SELL\s+SCALP|SELL\s+SCENARIO|PRE[-\s]?NFP\s+SELL|IF\s+PRICE\s+SPIKES)\b/.test(upper);
  const conditional = /\b(ONLY\s+IF|IF\s+PRICE|REACTION-BASED|NO\s+BLIND|WAIT\s+FOR)\b/.test(upper);
  return hasBuyScenario && hasSellScenario && conditional;
}

function isConditionalTradeSetup(upper: string): boolean {
  const hasBuy = /\bBUY\b/.test(upper);
  const hasSell = /\bSELL\b/.test(upper);
  const hasPlan = /\b(EXECUTION\s+(?:PLAN|MODEL)|SETUP|SCENARIO|BIAS|ENTRY)\b/.test(upper);
  const hasRiskReward = /\b(ENTRY|SL|STOP|TP|TARGET)\b/.test(upper);
  const conditional =
    /\b(ONLY\s+IF|IF\s+PRICE|CONFIRMATION\s+NEEDED|WAIT\s+FOR|REACTION\s+TRADE|REACTION-BASED|NO\s+BLIND|MUST\s+SEE|INVALID|FLIP\s+SCENARIO)\b/.test(
      upper,
    );
  return (
    isConditionalMultiScenarioPlan(upper) ||
    (hasBuy && hasSell && hasPlan && hasRiskReward) ||
    (hasPlan && hasRiskReward && conditional)
  );
}

function isCloseCommand(upper: string): boolean {
  return (
    /^\s*CLOSE\b/.test(upper) ||
    /\b(?:YOU\s+CAN\s+)?CLOSE\s+(?:YOUR\s+)?(?:TRADES?|POSITIONS?|HALF|PARTIAL|TP\s*[1-4]|\d{1,3}\s*%)\b/.test(
      upper,
    ) ||
    /\bCLOSE\s+\d{1,3}\s*%\b/.test(upper)
  );
}

function hasOpenTradeIntent(upper: string): boolean {
  const hasDirection = /\b(BUY|SELL)\b/.test(upper);
  const hasSymbol =
    /\b(GOLD|XAUUSD|XAU\/USD|WTI|WTIUSD|USOIL|XTIUSD|CRUDE|OIL|US30|US100|US500|NAS100|SPX500|SP500|GER40|GER30|DE40|DE30|UK100|JP225|JPN225|N225|DJI30|DJIA|DOW|DAX|DAX40|NDX|FTSE|FTSE100|NIKKEI|USTEC|NASDAQ|[A-Z]{3}\/?[A-Z]{3})\b/.test(
      upper,
    );
  const hasEntryPlan = /\b(ENTRY|EXECUTION\s+MODEL|EXECUTION\s+PLAN)\b/.test(upper);
  const hasRiskPlan = /\bSL\b|\bSTOP\s*LOSS\b/.test(upper);
  const hasTargetPlan = /\bTP\b|\bTAKE\s*PROFIT\b/.test(upper);
  const startsWithTrade = /^\s*(BUY|SELL)\b/.test(upper);
  return (
    (hasDirection && hasSymbol && (hasRiskPlan || /\b(LIMIT|STOP)\b/.test(upper))) ||
    (hasDirection && isDirectionalZoneSignal(upper)) ||
    (hasDirection && hasEntryPlan && hasRiskPlan && hasTargetPlan) ||
    (hasEntryPlan && hasRiskPlan && hasTargetPlan) ||
    (startsWithTrade && !/\b(PIPS?|MISSED|HIT\s+SL)\b/.test(upper))
  );
}

function isTakeProfitHitUpdate(upper: string): boolean {
  return (
    /^\s*(?:DONE\s+)?TP\s*[1-4]?\b/.test(upper) ||
    /\bFULL\s+TP\b/.test(upper) ||
    /\bTP\s*[1-4]\b.*(?:✅|PIPS?)/.test(upper) ||
    /\b(BUY|SELL)\s+\d+(?:\.\d+)?\s+TP\s*[1-4]\b/.test(upper)
  );
}

function isStopLossResultUpdate(upper: string): boolean {
  return /\bHIT\s+SL\b|\bHIT\s+STOP\s*LOSS\b|\bSPIKED\s+SL\b/.test(upper);
}

function isResultSummary(upper: string): boolean {
  if (
    /\b\d+\s*PIPS?\b/.test(upper) &&
    /\b(CLOSED?|HOLDING|POSITIONS?|NOT\s+A\s+BAD\s+TRADE)\b/.test(upper) &&
    !/\bFULL\s+TP\b/.test(upper) &&
    !/\bTP\s*[1-4]\b/.test(upper)
  ) {
    return true;
  }
  return (
    /\b\d+\s*PIPS?\b/.test(upper) &&
    !/\bSL\b/.test(upper) &&
    !/\bTP\b/.test(upper) &&
    !/\bENTRY\b/.test(upper) &&
    // Spelled-out levels ("Stoploss : 4048", "Take Profit : 4037 ( 70pips )") mean
    // this is a real signal with a pip annotation, not a bare "+250 pips" recap.
    !/\bSTOP\s*-?\s*LOSS\b/.test(upper) &&
    !/\bTAKE\s*-?\s*PROFIT\b/.test(upper)
  );
}

function detectDirection(upper: string): Direction | undefined {
  if (/\bBUY\b/.test(upper)) return "BUY";
  if (/\bSELL\b/.test(upper)) return "SELL";
  return undefined;
}

function inferDirectionFromPrices(
  entry?: PriceZone,
  stopLoss?: number,
  takeProfits: TakeProfitTarget[] = [],
): Direction | undefined {
  if (!entry || stopLoss === undefined || takeProfits.length === 0) return undefined;
  const targets = takeProfits.map((target) => target.price);
  if (targets.some((target) => target === undefined)) return undefined;
  const entryLow = Math.min(entry.from, entry.to ?? entry.from);
  const entryHigh = Math.max(entry.from, entry.to ?? entry.from);
  if (stopLoss < entryLow && targets.every((target) => target! > entryHigh)) return "BUY";
  if (stopLoss > entryHigh && targets.every((target) => target! < entryLow)) return "SELL";
  return undefined;
}

function detectOrderType(upper: string): OrderType {
  if (isDirectionalZoneSignal(upper)) return "LIMIT";
  if (/\bLIMITS?\b/.test(upper)) return "LIMIT";
  return hasPendingStopToken(upper) ? "STOP" : "MARKET";
}

// A 6-letter token made of two known ISO currency codes is an FX pair even when it
// sits on its own line (Elliott Wave: "CHFJPY 4H" then "Buy @ ..."). Matching the
// currency set instead of a bare [A-Z]{6} avoids false hits like "SHOULD"/"MISSED".
const FX_CURRENCY =
  "USD|EUR|GBP|JPY|CHF|CAD|AUD|NZD|XAU|XAG|ZAR|SGD|HKD|NOK|SEK|DKK|MXN|TRY|CNH|PLN|CZK";
const FX_PAIR_RE = new RegExp(`\\b(?:${FX_CURRENCY})/?(?:${FX_CURRENCY})\\b`, "i");

function extractRawSymbol(
  text: string,
  context: ParserContext,
  commandType: CommandType,
): string | undefined {
  const aliasKeys = [
    ...Object.keys(BUILT_IN_ALIASES),
    ...Object.keys(context.globalAliases ?? {}),
    ...Object.keys(context.providerId ? (context.providerAliases?.[context.providerId] ?? {}) : {}),
  ].sort((a, b) => b.length - a.length);

  for (const alias of aliasKeys) {
    const pattern = new RegExp(`(^|[^A-Z0-9/])(${escapeRegExp(alias)})(?=$|[^A-Z0-9/])`, "i");
    const match = text.match(pattern);
    if (match?.[2]) return match[2];
  }

  const directionSymbol = text.match(/\b(?:BUY|SELL)\s+([A-Z]{3}\/?[A-Z]{3}|[A-Z]{6,12})\b/i);
  if (directionSymbol?.[1] && !COMMAND_ALIASES.has(directionSymbol[1].toUpperCase())) {
    return directionSymbol[1];
  }

  const symbolDirection = text.match(/\b([A-Z]{3}\/?[A-Z]{3}|[A-Z]{6,12})\s+(?:BUY|SELL)\b/i);
  if (symbolDirection?.[1] && !COMMAND_ALIASES.has(symbolDirection[1].toUpperCase())) {
    return symbolDirection[1];
  }

  const lifecycle = text.match(
    /\b(?:CANCEL|CLOSE|BE|MODIFY|UPDATE|SET|TRAIL(?:ING)?)\b.*?\b([A-Z]{3}\/?[A-Z]{3}|[A-Z]{6,12})\b|\b([A-Z]{3}\/?[A-Z]{3}|[A-Z]{6,12})\b.*?\b(?:CANCEL|CLOSE|BE|MODIFY|UPDATE|SET|TRAIL(?:ING)?)\b/i,
  );
  const lifecycleSymbol = lifecycle?.[1] ?? lifecycle?.[2];
  if (lifecycleSymbol && !COMMAND_ALIASES.has(lifecycleSymbol.toUpperCase())) {
    return lifecycleSymbol;
  }

  // "... on XAUUSD" (e.g. VIP Gold "Deleted Buy Stop on XAUUSD").
  const onSymbol = text.match(/\bON\s+([A-Z]{3}\/?[A-Z]{3}|[A-Z]{6,12})\b/i);
  if (onSymbol?.[1] && !COMMAND_ALIASES.has(onSymbol[1].toUpperCase())) {
    return onSymbol[1];
  }

  if (context.providerId && commandType !== "NO_SIGNAL") {
    const providerDefault = context.providerDefaultSymbols?.[context.providerId];
    if (providerDefault) return providerDefault;
  }

  // Recognised ticker that is not adjacent to the direction word: on its own line,
  // in a "SYM/SYM" pair, or tagged like "XAUUSD (ELVIS)". Scan the known symbols and
  // aliases and take the earliest occurrence. "/" counts as a boundary so
  // "NAS100/US100" and "XAUUSD/GOLD" resolve to their first ticker. Guarded to real
  // signals so noise and locked/default providers are unaffected.
  if (commandType !== "NO_SIGNAL") {
    const scanTargets = [...DEFAULT_CANONICAL_SYMBOLS, ...aliasKeys].sort(
      (a, b) => b.length - a.length,
    );
    let earliest: { sym: string; idx: number } | undefined;
    for (const symbol of scanTargets) {
      if (COMMAND_ALIASES.has(symbol.toUpperCase())) continue;
      const match = text.match(
        new RegExp(`(^|[^A-Z0-9])(${escapeRegExp(symbol)})(?=$|[^A-Z0-9])`, "i"),
      );
      if (match?.index !== undefined && match[2]) {
        const idx = match.index + (match[1]?.length ?? 0);
        if (!earliest || idx < earliest.idx) earliest = { sym: match[2], idx };
      }
    }
    const fxPair = text.match(FX_PAIR_RE);
    if (fxPair?.index !== undefined && (!earliest || fxPair.index < earliest.idx)) {
      earliest = { sym: fxPair[0].replace(/\//g, ""), idx: fxPair.index };
    }
    if (earliest) return earliest.sym;
  }

  return undefined;
}

function extractEntry(
  text: string,
  direction?: Direction,
  orderType?: OrderType,
): PriceZone | undefined {
  const zone = text.match(/\bENTRY\s*[:@]?\s*-?\s*(\d+(?:\.\d+)?)\s*(?:-|TO)\s*(\d+(?:\.\d+)?)/i);
  if (zone?.[1] && zone[2]) {
    return { from: Number(zone[1]), to: normalizeZoneEnd(zone[1], zone[2]) };
  }

  const singleEntry = text.match(/\bENTRY\s*[:@]?\s*(\d+(?:\.\d+)?)/i);
  if (singleEntry?.[1]) {
    return { from: Number(singleEntry[1]) };
  }

  const atPrice = text.match(/@\s*(\d+(?:\.\d+)?)/);
  if (atPrice?.[1]) {
    return { from: Number(atPrice[1]) };
  }

  const riskOrTarget = text.search(/\b(?:SL|S\s*\/\s*L|STOP[\s-]*LOSS|TP\d*|TAKE\s+PROFIT)\b/i);
  const entryText = riskOrTarget === -1 ? text : text.slice(0, riskOrTarget);

  const standaloneZone = entryText.match(
    /(?:^|\n)\s*(\d+(?:\.\d+)?)\s*(?:-|TO)\s*(\d+(?:\.\d+)?)/i,
  );
  if (standaloneZone?.[1] && standaloneZone[2]) {
    return {
      from: Number(standaloneZone[1]),
      to: normalizeZoneEnd(standaloneZone[1], standaloneZone[2]),
    };
  }

  const orderZone = entryText.match(
    /\b(?:BUY|SELL)\s+(?:LIMIT|STOP)?\s*(\d+(?:\.\d+)?)\s*(?:-|TO)\s*(\d+(?:\.\d+)?)/i,
  );
  if (orderZone?.[1] && orderZone[2]) {
    return { from: Number(orderZone[1]), to: normalizeZoneEnd(orderZone[1], orderZone[2]) };
  }

  if (!direction) return undefined;
  const directionLine = entryText.match(
    new RegExp(`\\b${direction}\\b[^\\n]*?(\\d+(?:\\.\\d+)?)`, "i"),
  );
  if (directionLine?.[1] && !/\bNOW\b/i.test(directionLine[0])) {
    return { from: Number(directionLine[1]) };
  }

  if (orderType && orderType !== "MARKET") {
    const firstPrice = entryText.match(/\b(\d+(?:\.\d+)?)\b/);
    if (firstPrice?.[1]) return { from: Number(firstPrice[1]) };
  }

  return undefined;
}

function isDirectionalZoneSignal(upper: string): boolean {
  return (
    /\b(BUY|SELL)\s+ZONES?\b|\bZONES?\s+(BUY|SELL)\b/.test(upper) &&
    extractDirectionalZonePrices(upper).length > 0
  );
}

function extractDirectionalZonePrices(text: string): number[] {
  if (!/\b(BUY|SELL)\s+ZONES?\b|\bZONES?\s+(BUY|SELL)\b/i.test(text)) return [];
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^\d+(?:\.\d+)?$/.test(line))
    .map(Number);
}

function parseKalVipExtendedLevelSignals(
  originalText: string,
  text: string,
  context: ParserContext,
): ParsedSignal[] {
  const rawSymbol =
    (context.providerId ? context.providerDefaultSymbols?.[context.providerId] : undefined) ??
    extractRawSymbol(text, context, "OPEN_TRADE");
  if (!rawSymbol) return [];

  const referencePrice = referencePriceForSymbol(rawSymbol, context);
  if (referencePrice === undefined) return [];

  const levels = extractKalVipExtendedLevels(text, referencePrice);
  if (levels.length === 0) return [];

  const original = originalText.replace(/\r\n/g, "\n").trim();
  return levels.map((level, index) => {
    const signal = parseSignalText(`${rawSymbol} ${level.direction} LIMIT ${level.price}`, context);
    return {
      ...signal,
      originalText: original,
      matchedPatternIds: [...new Set([...signal.matchedPatternIds, "open.kal-vip-extended-level"])],
      fingerprint: createMessageFingerprint(
        `${original}\nextended-level:${index + 1}:${level.direction}:${level.price}`,
      ),
    };
  });
}

function referencePriceForSymbol(rawSymbol: string, context: ParserContext): number | undefined {
  const referencePrices = context.referencePrices ?? {};
  const resolved = resolveSymbol(rawSymbol, context);
  const keys = [
    rawSymbol,
    normalizeSymbolText(rawSymbol),
    resolved.canonicalSymbol,
    resolved.brokerSymbol,
  ].filter((value): value is string => Boolean(value));

  for (const key of keys) {
    const direct = referencePrices[key];
    if (Number.isFinite(direct)) return direct;
    const upper = referencePrices[key.toUpperCase()];
    if (Number.isFinite(upper)) return upper;
  }
  return undefined;
}

function extractKalVipExtendedLevels(
  text: string,
  referencePrice: number,
): Array<{ direction: Direction; price: number }> {
  const levels: Array<{ direction: Direction; price: number }> = [];
  let pendingDirection: Direction | undefined;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const upper = line.toUpperCase();
    const lineDirection = /\bBUY\b/.test(upper)
      ? "BUY"
      : /\bSELL\b/.test(upper)
        ? "SELL"
        : undefined;
    if (lineDirection && /\b(FIRST|SECOND|THIRD|FOURTH|ZONE|LEVEL|AROUND|IS|AT)\b/.test(upper)) {
      pendingDirection = lineDirection;
    }

    const levelText = extractShortLevelText(line);
    const direction = lineDirection ?? pendingDirection;
    if (!direction || !levelText) continue;
    const price = expandShortLevel(levelText, referencePrice);
    if (price !== undefined) levels.push({ direction, price });
  }

  return levels;
}

function extractShortLevelText(line: string): string | undefined {
  const patterns = [
    /\bAROUND\s+(\d{1,2})\s+LEVEL\b/i,
    /\b(\d{1,2})\s+LEVEL\b/i,
    /\b(?:IS|AT)\s+(\d{1,2})\b/i,
    /\b(\d{1,2})\s+CAN\s+BE\s+(?:A\s+)?(?:BUY|SELL)\b/i,
  ];
  for (const pattern of patterns) {
    const match = line.match(pattern);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function expandShortLevel(levelText: string, referencePrice: number): number | undefined {
  if (!Number.isFinite(referencePrice) || referencePrice <= 0) return undefined;
  const numeric = Number(levelText);
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > 99) return undefined;
  const base = Math.floor(referencePrice / 100) * 100;
  return [base - 100 + numeric, base + numeric, base + 100 + numeric].reduce(
    (nearest, candidate) =>
      Math.abs(candidate - referencePrice) < Math.abs(nearest - referencePrice)
        ? candidate
        : nearest,
  );
}

function extractStopLoss(text: string): { value?: number; conflict: boolean } {
  const labels = ["STOP[\\s-]*LOSS", "S\\s*[./]\\s*L", "SL"];
  const values = labels.flatMap((label) => {
    // No word boundary after the label: providers write "SL2286" and "STOPLOSS2286"
    // with no separator, and \b between a letter and a digit never matches.
    const regex = new RegExp(
      `\\b${label}\\s*(?:[:@=]|TO|BELOW|ABOVE)?\\s*(\\d+(?:\\.\\d+)?)`,
      "gi",
    );
    return [...text.matchAll(regex)].map((match) => Number(match[1]));
  });
  const value = values[0];
  return {
    value,
    conflict: value !== undefined && values.some((candidate) => candidate !== value),
  };
}

function hasPendingStopToken(text: string): boolean {
  const stop = /\bSTOPS?\b/g;
  let match = stop.exec(text);
  while (match) {
    if (!/^\s*-?\s*LOSS\b/.test(text.slice(match.index + match[0].length))) return true;
    match = stop.exec(text);
  }
  return false;
}

function normalizeZoneEnd(start: string, end: string): number {
  if (end.includes(".") || end.length >= start.length) return Number(end);
  return Number(`${start.slice(0, start.length - end.length)}${end}`);
}

function extractPriceNearToken(text: string, token: string): number | undefined {
  const regex = new RegExp(`\\b${token}\\b\\s*(?:[:@]|TO|BELOW|ABOVE)?\\s*(\\d+(?:\\.\\d+)?)`, "i");
  const match = text.match(regex);
  return match?.[1] ? Number(match[1]) : undefined;
}

function extractLifecyclePrice(text: string, token: string): number | undefined {
  const near = extractPriceNearToken(text, token);
  if (near !== undefined) return near;
  const numbers = [...text.matchAll(/\b\d+(?:\.\d+)?\b/g)].map((match) => Number(match[0]));
  return numbers.at(-1);
}

function extractTakeProfits(text: string): TakeProfitTarget[] {
  const targets = new Map<number, number>();
  const tpRegex = /\bTP\s*([1-4])\b\s*(?:[:@]|-|=)?\s*(\d+(?:\.\d+)?)/gi;
  let match = tpRegex.exec(text);
  while (match) {
    const leg = Number(match[1]);
    targets.set(leg, Number(match[2]));
    match = tpRegex.exec(text);
  }

  const unlabeledTpRegex = /\bTP\b\s*(?:[:@]|-|=)?\s*(\d+(?:\.\d+)?)/gi;
  match = unlabeledTpRegex.exec(text);
  while (match) {
    const leg = targets.size + 1;
    targets.set(leg, Number(match[1]));
    match = unlabeledTpRegex.exec(text);
  }

  const takeProfit = text.match(/\bTAKE\s+PROFIT\s*[:@]?\s*(\d+(?:\.\d+)?)/i);
  if (takeProfit?.[1] && targets.size === 0) {
    targets.set(1, Number(takeProfit[1]));
  }

  const targetLine = text.match(/\bTP\b\s*([\d.]+(?:\s*-\s*[\d.]+){1,6})/i);
  if (targetLine?.[1] && targets.size <= 1) {
    targetLine[1]
      .split(/\s*-\s*/)
      .slice(0, 4)
      .forEach((value, index) => {
        targets.set(index + 1, Number(value));
      });
  }

  const modifyTp = text.match(/\bTP\s*([1-4])\b.*?(\d+(?:\.\d+)?)/i);
  if (modifyTp?.[1] && modifyTp[2] && targets.size === 0) {
    targets.set(Number(modifyTp[1]), Number(modifyTp[2]));
  }

  return [...targets.entries()]
    .sort(([a], [b]) => a - b)
    .slice(0, 4)
    .map(([leg, price]) => ({ leg, price, allocationPercent: 25 }));
}

function extractLotSize(text: string): number | undefined {
  const match = text.match(/\b(?:LOT|LOTS|VOLUME)\s*(?:SIZE)?\s*[:=]?\s*(\d+(?:\.\d+)?)/i);
  return match?.[1] ? Number(match[1]) : undefined;
}

function extractRiskPercent(text: string): number | undefined {
  const match = text.match(/\bRISK\s*[:=]?\s*(\d+(?:\.\d+)?)\s*%?/i);
  return match?.[1] ? Number(match[1]) : undefined;
}

function extractPartialClose(upper: string): PartialCloseInstruction | undefined {
  const tpLeg = upper.match(/\bTP\s*([1-4])\b/);
  if (tpLeg?.[1]) return { kind: "TP_LEG", value: Number(tpLeg[1]) };
  const percent = upper.match(/\b(\d{1,3})\s*%(?=\s|$)/);
  if (percent?.[1]) return { kind: "PERCENT", value: Number(percent[1]) };
  if (/\bHALF\b/.test(upper)) return { kind: "PERCENT", value: 50 };
  return undefined;
}

function extractTrailingStop(upper: string): DistanceInstruction | undefined {
  const explicit = upper.match(
    /\b(?:TRAIL(?:ING)?\s+(?:STOP|SL)|TRAIL\s+BY)\D*(\d+(?:\.\d+)?)\s*(PIPS?|POINTS?|PTS?)\b/,
  );
  if (explicit?.[1]) {
    return {
      value: Number(explicit[1]),
      unit: /PIP/.test(explicit[2] ?? "") ? "PIPS" : "POINTS",
    };
  }
  const reversed = upper.match(/\b(\d+(?:\.\d+)?)\s*(PIPS?|POINTS?|PTS?)\b.*\bTRAIL/);
  if (reversed?.[1]) {
    return {
      value: Number(reversed[1]),
      unit: /PIP/.test(reversed[2] ?? "") ? "PIPS" : "POINTS",
    };
  }
  return undefined;
}

function calculateConfidence(input: {
  commandType: CommandType;
  direction?: Direction;
  symbolStatus: MappingStatus;
  hasEntry: boolean;
  hasStopLoss: boolean;
  takeProfitCount: number;
  missingFieldCount: number;
}): number {
  let score = 0.55;
  if (input.commandType !== "OPEN_TRADE") score += 0.2;
  if (input.direction) score += 0.1;
  if (input.symbolStatus === "mapped") score += 0.16;
  if (input.hasEntry || input.commandType !== "OPEN_TRADE") score += 0.05;
  if (input.hasStopLoss || input.commandType !== "OPEN_TRADE") score += 0.08;
  if (input.takeProfitCount > 0 || input.commandType !== "OPEN_TRADE") score += 0.08;
  score -= input.missingFieldCount * 0.12;
  return Math.max(0, Math.min(0.99, Number(score.toFixed(2))));
}

function normalizeAllocation(allocation: number[] | undefined, takeProfitCount: number): number[] {
  if (allocation?.length) return allocation;
  if (takeProfitCount <= 0) return [];
  const equal = Math.floor(100 / takeProfitCount);
  const values = Array.from({ length: takeProfitCount }, () => equal);
  values[values.length - 1]! += 100 - values.reduce((sum, value) => sum + value, 0);
  return values;
}

function logicalTradeLegs(signal: ParsedSignal, allocationInput?: number[]): TradeLeg[] {
  if (signal.takeProfits.length > 0) {
    const allocation = normalizeAllocation(allocationInput, signal.takeProfits.length);
    return signal.takeProfits.map((target, index) => ({
      leg: target.leg,
      targetPrice: target.price,
      targetSource: target.targetSource ?? "explicit",
      allocationPercent: allocation[index] ?? target.allocationPercent,
      strategy: target.strategy,
      status: "PLANNED",
    }));
  }

  if (signal.defaultTakeProfit) {
    return [
      {
        leg: 1,
        targetSource: "default-distance",
        defaultDistance: signal.defaultTakeProfit,
        allocationPercent: 100,
        status: "PLANNED",
      },
    ];
  }

  return [];
}

function normalizeTakeProfitAllocations(
  takeProfits: TakeProfitTarget[],
  commandType: CommandType,
): TakeProfitTarget[] {
  if (commandType !== "OPEN_TRADE" || takeProfits.length === 0) {
    return takeProfits;
  }
  const allocation = normalizeAllocation(undefined, takeProfits.length);
  return takeProfits.map((target, index) => ({
    ...target,
    allocationPercent: allocation[index] ?? target.allocationPercent,
  }));
}

function withTakeProfitVolumes(
  takeProfits: TakeProfitTarget[],
  commandType: CommandType,
  totalVolume?: number,
  runner?: RunnerConfig,
): TakeProfitTarget[] {
  if (commandType !== "OPEN_TRADE" || takeProfits.length === 0 || !totalVolume) {
    return takeProfits;
  }

  const runnerVolume = runner?.enabled ? Math.min(runner.lotSize, totalVolume) : 0;
  const tradedVolume = Math.max(0, totalVolume - runnerVolume);
  const volumes = splitVolumeByCent(tradedVolume, takeProfits.length);
  return takeProfits.map((target, index) => ({
    ...target,
    volume: volumes[index],
  }));
}

function withPartialCloseVolume(
  partialClose: PartialCloseInstruction | undefined,
  commandType: CommandType,
  totalVolume?: number,
): PartialCloseInstruction | undefined {
  if (commandType !== "CLOSE_PARTIAL" || !partialClose) return partialClose;
  if (partialClose.volume !== undefined) return partialClose;
  if (partialClose.kind !== "TP_LEG" || !totalVolume || !partialClose.allocationPercent) {
    return partialClose;
  }
  return {
    ...partialClose,
    volume: Number(((totalVolume * partialClose.allocationPercent) / 100).toFixed(2)),
  };
}

function normalizeRunnerConfig(
  runner: RunnerConfig | undefined,
  totalVolume?: number,
): RunnerConfig | undefined {
  if (!runner?.enabled || !totalVolume) return undefined;
  const lotSize = Math.min(Math.max(0, runner.lotSize), totalVolume);
  if (lotSize <= 0) return undefined;
  return {
    enabled: true,
    lotSize,
    slBehavior: runner.slBehavior,
    trailPips: runner.trailPips,
  };
}

function splitVolumeByCent(totalVolume: number, count: number): number[] {
  const totalCents = Math.round(totalVolume * 100);
  const baseCents = Math.floor(totalCents / count);
  const remainder = totalCents - baseCents * count;
  return Array.from({ length: count }, (_, index) =>
    Number(((baseCents + (index < remainder ? 1 : 0)) / 100).toFixed(2)),
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stableHash(value: string): number {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 33) ^ value.charCodeAt(index);
  }
  return hash >>> 0;
}

// --- Multi-message correlation (parser pre-processing) ---------------------
//
// Some providers post a directional signal and then a rapid follow-up that only
// carries SL/TP levels ("BUY GOLD" then "SL 2290 TP 2320" a few seconds later).
// Parsing each message in isolation produces an incomplete OPEN_TRADE plus a
// stray fragment. correlateMessages() folds short follow-up fragments into the
// preceding directional anchor when they arrive from the same sender inside a
// time window, so the parser sees one complete signal.

const CORRELATION_DIRECTION_RE = /\b(BUY|SELL|LONG|SHORT)\b/i;
const CORRELATION_SLTP_RE = /\b(SL|TP\d?|T\/?P|S\/?L|STOP\s*LOSS|TAKE\s*PROFIT|TARGET|ENTRY|@)\b/i;

/** Minimal structural shape correlateMessages needs from a captured message. */
export interface CorrelatableMessage {
  telegramMessageId: string;
  messageDate: string;
  rawText: string;
  senderName?: string;
}

export type CorrelatedMessage<T extends CorrelatableMessage> = T & {
  /** Merged text the parser should run against (anchor text + folded fragments). */
  rawText: string;
  /** telegramMessageIds folded into this group, anchor first. Length 1 = untouched. */
  correlatedMessageIds: string[];
};

function correlationHasDirection(text: string): boolean {
  return CORRELATION_DIRECTION_RE.test(text);
}

/**
 * A follow-up fragment is a short line with no direction of its own that carries
 * SL/TP/level information meant to complete the previous directional message.
 */
function isCorrelationFragment(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length >= 50) return false;
  if (correlationHasDirection(trimmed)) return false;
  const hasNumber = /\d/.test(trimmed);
  if (!hasNumber) return false;
  return CORRELATION_SLTP_RE.test(trimmed) || /^[\s\d.,/-]+$/.test(trimmed);
}

function correlationSecondsBetween(earlier: string, later: string): number {
  const a = Date.parse(earlier);
  const b = Date.parse(later);
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.POSITIVE_INFINITY;
  return Math.abs(b - a) / 1000;
}

/**
 * Group consecutive same-sender messages that form a single signal. A message
 * with directional intent becomes an anchor; subsequent short SL/TP fragments
 * within `windowSeconds` of the previous message in the group are folded in.
 *
 * ponytail: heuristic correlation. Ceiling — it only merges fragments that
 * follow a directional anchor in arrival order; it will not reorder messages or
 * correlate across interleaved providers. Upgrade path is per-provider quote/
 * reply threading if a provider interleaves multiple concurrent setups.
 */
export function correlateMessages<T extends CorrelatableMessage>(
  messages: T[],
  windowSeconds = 30,
): Array<CorrelatedMessage<T>> {
  const out: Array<CorrelatedMessage<T>> = [];
  let anchor: T | null = null;
  let anchorHasDirection = false;
  let mergedText = "";
  let mergedIds: string[] = [];
  let lastDate = "";

  const flush = () => {
    if (!anchor) return;
    out.push({
      ...anchor,
      rawText: mergedText,
      correlatedMessageIds: mergedIds,
    });
    anchor = null;
    anchorHasDirection = false;
    mergedText = "";
    mergedIds = [];
    lastDate = "";
  };

  for (const message of messages) {
    const sameSender = anchor === null || (anchor.senderName ?? "") === (message.senderName ?? "");
    const withinWindow =
      anchor !== null && correlationSecondsBetween(lastDate, message.messageDate) <= windowSeconds;

    if (
      anchor !== null &&
      anchorHasDirection &&
      sameSender &&
      withinWindow &&
      isCorrelationFragment(message.rawText)
    ) {
      mergedText = `${mergedText}\n${message.rawText.trim()}`;
      mergedIds.push(message.telegramMessageId);
      lastDate = message.messageDate;
      continue;
    }

    flush();
    anchor = message;
    anchorHasDirection = correlationHasDirection(message.rawText);
    mergedText = message.rawText;
    mergedIds = [message.telegramMessageId];
    lastDate = message.messageDate;
  }
  flush();
  return out;
}

/**
 * Cap a chart series to `maxPoints` while retaining the first/last points and
 * each bucket's low and high of `selectValue(point)`, in chronological order.
 * Point averaging would flatten peaks and drawdown depth; this keeps them.
 */
export function downsampleSeries<T>(
  points: T[],
  maxPoints: number,
  selectValue: (point: T) => number,
): T[] {
  const target = Math.max(0, Math.floor(maxPoints));
  if (points.length <= target) return points;
  if (target === 0) return [];

  const values = points.map(selectValue);
  const lastIndex = values.length - 1;
  let lowIndex = 0;
  let highIndex = 0;
  for (let index = 1; index < values.length; index += 1) {
    if ((values[index] as number) < (values[lowIndex] as number)) lowIndex = index;
    if ((values[index] as number) > (values[highIndex] as number)) highIndex = index;
  }
  if (target === 1) return [points[lowIndex] as T];

  const selected = new Set([lowIndex, highIndex, 0, lastIndex]);
  const bucketCount = Math.floor(Math.max(0, target - selected.size) / 2);
  for (let bucket = 0; bucket < bucketCount; bucket += 1) {
    const start = 1 + Math.floor((bucket * (values.length - 2)) / bucketCount);
    const end = 1 + Math.floor(((bucket + 1) * (values.length - 2)) / bucketCount);
    let bucketLow = start;
    let bucketHigh = start;
    for (let index = start + 1; index < end; index += 1) {
      if ((values[index] as number) < (values[bucketLow] as number)) bucketLow = index;
      if ((values[index] as number) > (values[bucketHigh] as number)) bucketHigh = index;
    }
    selected.add(bucketLow);
    selected.add(bucketHigh);
  }
  for (let slot = 1; selected.size < target && slot < target; slot += 1) {
    selected.add(Math.floor((slot * lastIndex) / target));
  }
  return [...selected]
    .sort((a, b) => a - b)
    .slice(0, target)
    .map((index) => points[index] as T);
}
