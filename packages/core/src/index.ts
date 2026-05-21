export type Direction = "BUY" | "SELL";
export type OrderType = "MARKET" | "LIMIT" | "STOP";
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
  | "EXPIRED";

export interface AccountSymbolMapping {
  accountId: string;
  canonicalOverrides?: Record<string, string>;
  prefix?: string;
  suffix?: string;
  includeSymbols?: string[];
  excludeSymbols?: string[];
  availableBrokerSymbols?: string[];
}

export interface ParserContext {
  providerId?: string;
  accountId?: string;
  globalAliases?: Record<string, string>;
  providerAliases?: Record<string, Record<string, string>>;
  providerDefaultSymbols?: Record<string, string>;
  accountMappings?: Record<string, AccountSymbolMapping>;
  defaultStopLoss?: DistanceInstruction;
  defaultTakeProfit?: DistanceInstruction;
}

export interface SymbolResolution {
  rawSymbol: string;
  canonicalSymbol?: string;
  brokerSymbol?: string;
  mappingStatus: MappingStatus;
  mappingSource:
    | "provider_alias"
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
  fingerprint: string;
}

export interface LogicalTrade {
  id: string;
  providerId?: string;
  accountId?: string;
  source?: TradeSource;
  symbol: SymbolResolution;
  direction: Direction;
  status: "PLANNED" | "OPEN" | "PENDING" | "CLOSED" | "OUT_OF_SYNC" | "CANCELLED";
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
  "USDCHF",
  "USDJPY",
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
  NASDAQ: "NAS100",
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
]);

export function normalizeSymbolText(symbol: string): string {
  return symbol.toUpperCase().replace(/\s+/g, "").replace("-", "").trim();
}

export function canonicalKey(value: string): string {
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
  const providerAliases = context.providerId
    ? context.providerAliases?.[context.providerId]
    : undefined;
  const providerMatch = findAliasMatch(raw, providerAliases);
  const builtInOrGlobal = {
    ...BUILT_IN_ALIASES,
    ...(context.globalAliases ?? {}),
  };
  const globalMatch = findAliasMatch(raw, builtInOrGlobal);
  const canonicalSymbol =
    providerMatch ?? globalMatch ?? canonicalFromBrokerVariant(raw) ?? normalized.replace("/", "");
  let mappingSource: SymbolResolution["mappingSource"] = providerMatch
    ? "provider_alias"
    : globalMatch
      ? "global_alias"
      : "fallback";
  const warnings: string[] = [];

  if (!isRecognizedCanonical(canonicalSymbol)) {
    return {
      rawSymbol: raw,
      canonicalSymbol,
      mappingStatus: "unmapped",
      mappingSource,
      warnings: ["Symbol could not be mapped to a broker symbol"],
    };
  }

  const account = context.accountId ? context.accountMappings?.[context.accountId] : undefined;
  const availableBrokerSymbols = normalizedSymbolList(account?.availableBrokerSymbols);
  let brokerSymbol = canonicalSymbol;
  if (account?.canonicalOverrides?.[canonicalSymbol]) {
    brokerSymbol = account.canonicalOverrides[canonicalSymbol];
    mappingSource = "account_override";
  } else if (availableBrokerSymbols.length) {
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
  } else {
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

export function parseSignalText(originalText: string, context: ParserContext = {}): ParsedSignal {
  const original = originalText.replace(/\r\n/g, "\n").trim();
  const candidate = extractSignalCandidate(original);
  const text = candidate.text;
  const upper = text.toUpperCase();
  const matchedPatternIds: string[] = [...candidate.matchedPatternIds];
  const warnings: string[] = [];
  const missingFields: string[] = [];
  const commandType = detectCommandType(upper, matchedPatternIds);
  let direction = detectDirection(upper);
  const orderType = detectOrderType(upper);
  const entry = commandType === "OPEN_TRADE" ? extractEntry(text, direction, orderType) : undefined;
  const stopLoss = extractStopLoss(text);
  const takeProfits = extractTakeProfits(text);
  const lotSize = commandType === "OPEN_TRADE" ? extractLotSize(text) : undefined;
  const riskPercent = commandType === "OPEN_TRADE" ? extractRiskPercent(text) : undefined;
  direction ??= inferDirectionFromPrices(entry, stopLoss, takeProfits);
  const rawSymbol = extractRawSymbol(text, context, commandType);
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
      ? parseSignalText(candidate.quotedText, context)
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

  if (commandType === "OPEN_TRADE") {
    if (!direction) missingFields.push("direction");
    if (!effectiveRawSymbol) missingFields.push("symbol");
    if (effectiveMappingStatus !== "mapped") missingFields.push("brokerSymbol");
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
    fingerprint: createMessageFingerprint(original),
  };
}

export function parseSignalTexts(
  originalText: string,
  context: ParserContext = {},
): ParsedSignal[] {
  const base = parseSignalText(originalText, context);
  const candidate = extractSignalCandidate(originalText.replace(/\r\n/g, "\n").trim());
  const prices = extractDirectionalZonePrices(candidate.text);
  if (base.commandType !== "OPEN_TRADE" || prices.length <= 1) return [base];

  return prices.map((price, index) => ({
    ...base,
    entry: { from: price },
    fingerprint: createMessageFingerprint(`${base.originalText}\nzone-entry:${index + 1}:${price}`),
  }));
}

export function shouldRequireManualReview(signal: ParsedSignal): boolean {
  return (
    signal.confidence < 0.75 ||
    signal.mappingStatus !== "mapped" ||
    (signal.commandType === "OPEN_TRADE" && signal.missingFields.length > 0) ||
    (signal.commandType !== "OPEN_TRADE" &&
      signal.missingFields.some((field) => field !== "symbol")) ||
    signal.commandType === "TRADE_SETUP" ||
    signal.commandType === "NO_SIGNAL" ||
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

function extractSignalCandidate(text: string) {
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
  const hasSymbol = /\b(GOLD|XAUUSD|XAU\/USD|[A-Z]{3}\/?[A-Z]{3})\b/.test(upper);
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
    !/\bENTRY\b/.test(upper)
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
  if (!entry || stopLoss === undefined || !takeProfits[0]?.price) return undefined;
  const entryMid = entry.to === undefined ? entry.from : (entry.from + entry.to) / 2;
  const firstTarget = takeProfits[0].price;
  if (firstTarget > entryMid && stopLoss < entryMid) return "BUY";
  if (firstTarget < entryMid && stopLoss > entryMid) return "SELL";
  return undefined;
}

function detectOrderType(upper: string): OrderType {
  if (isDirectionalZoneSignal(upper)) return "LIMIT";
  if (/\bLIMIT\b/.test(upper)) return "LIMIT";
  if (/\bSTOP\b/.test(upper)) return "STOP";
  return "MARKET";
}

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

  if (context.providerId && commandType !== "NO_SIGNAL") {
    return context.providerDefaultSymbols?.[context.providerId];
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

  const standaloneZone = text.match(/(?:^|\n)\s*(\d+(?:\.\d+)?)\s*(?:-|TO)\s*(\d+(?:\.\d+)?)/i);
  if (standaloneZone?.[1] && standaloneZone[2]) {
    return {
      from: Number(standaloneZone[1]),
      to: normalizeZoneEnd(standaloneZone[1], standaloneZone[2]),
    };
  }

  const atPrice = text.match(/@\s*(\d+(?:\.\d+)?)/);
  if (atPrice?.[1]) {
    return { from: Number(atPrice[1]) };
  }

  const orderZone = text.match(
    /\b(?:BUY|SELL)\s+(?:LIMIT|STOP)?\s*(\d+(?:\.\d+)?)\s*(?:-|TO)\s*(\d+(?:\.\d+)?)/i,
  );
  if (orderZone?.[1] && orderZone[2]) {
    return { from: Number(orderZone[1]), to: normalizeZoneEnd(orderZone[1], orderZone[2]) };
  }

  if (!direction) return undefined;
  const directionLine = text.match(new RegExp(`\\b${direction}\\b[^\\n]*?(\\d+(?:\\.\\d+)?)`, "i"));
  if (directionLine?.[1] && !/\bNOW\b/i.test(directionLine[0])) {
    return { from: Number(directionLine[1]) };
  }

  if (orderType && orderType !== "MARKET") {
    const firstPrice = text.match(/\b(\d+(?:\.\d+)?)\b/);
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

function extractStopLoss(text: string): number | undefined {
  return extractPriceNearToken(text, "SL");
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
