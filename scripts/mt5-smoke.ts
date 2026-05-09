const defaultApiBase = process.env.MT5_SMOKE_API_URL ?? "http://127.0.0.1:8787/api";

export interface Mt5LinePayload {
  [key: string]: string | undefined;
  status?: string;
  queueItemId?: string;
  logicalTradeId?: string;
  commandType?: string;
  brokerSymbol?: string;
  canonicalSymbol?: string;
  direction?: string;
  executionMode?: string;
  entryFrom?: string;
  stopLoss?: string;
}

export interface ExecutionReportPayload {
  accountId: string;
  queueItemId: string;
  status: "EXECUTED";
  retcode: number;
  retcodeExternal: number;
  brokerComment: string;
  orderTicket: string;
  dealTicket: string;
  requestedPrice?: number;
  filledPrice?: number;
  volume: number;
  errorText: string;
}

export interface HeartbeatPayload {
  accountId: string;
  balance: number;
  equity: number;
  availableSymbols: string[];
}

interface ParseResponse {
  parsedSignalId: string;
  reviewRequired: boolean;
  result: {
    commandType: string;
    brokerSymbol?: string;
    missingFields: string[];
    warnings: string[];
  };
}

interface ApproveResponse {
  queueItemId: string;
  logicalTradeId?: string;
  status: string;
}

interface ExecutionLog {
  queueItemId: string;
  accountId: string;
  status: string;
  retcode: number;
}

interface HeartbeatResponse {
  accountId: string;
  heartbeatStatus: string;
  at: string;
}

interface SmokeOptions {
  apiBase?: string;
  suffix?: string;
}

export interface SmokeSummary {
  accountId: string;
  providerId: string;
  openQueueItemId: string;
  lifecycleQueueItemId: string;
  logicalTradeId: string;
  heartbeatStatus: string;
  checkedLogs: number;
}

export function parseMt5LinePayload(payload: string): Mt5LinePayload {
  const result: Mt5LinePayload = {};
  for (const line of payload.split(/\r?\n/)) {
    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) continue;
    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    result[key] = value;
  }
  return result;
}

export function buildExecutionReportPayload(input: {
  accountId: string;
  work: Mt5LinePayload;
  ticketSuffix: string;
}): ExecutionReportPayload {
  if (!input.work.queueItemId) {
    throw new Error("Cannot report MT5 execution without queueItemId");
  }
  const requestedPrice = parseOptionalNumber(input.work.entryFrom);
  const volume = parseOptionalNumber(input.work.volume) ?? 0.1;
  const payload: ExecutionReportPayload = {
    accountId: input.accountId,
    queueItemId: input.work.queueItemId,
    status: "EXECUTED",
    retcode: 10009,
    retcodeExternal: 0,
    brokerComment: "MT5 smoke contract accepted",
    orderTicket: `smoke-order-${input.ticketSuffix}`,
    dealTicket: `smoke-deal-${input.ticketSuffix}`,
    volume,
    errorText: "",
  };
  if (requestedPrice !== undefined) {
    payload.requestedPrice = requestedPrice;
    payload.filledPrice = requestedPrice;
  }
  return payload;
}

export function buildHeartbeatPayload(input: HeartbeatPayload): HeartbeatPayload {
  return {
    accountId: input.accountId,
    balance: input.balance,
    equity: input.equity,
    availableSymbols: input.availableSymbols,
  };
}

export async function runMt5Smoke(options: SmokeOptions = {}): Promise<SmokeSummary> {
  const apiBase = normalizeApiBase(options.apiBase ?? defaultApiBase);
  const suffix = sanitizeSuffix(options.suffix ?? crypto.randomUUID().slice(0, 8));
  const accountNumber = `900${Date.now().toString().slice(-9)}`;
  const providerId = `provider-mt5-smoke-${suffix}`;
  const availableSymbols = ["EURUSD.raw", "XAUUSD.r"];

  const registered = await postJson<{ accountId: string; status: string }>(
    apiBase,
    "/mt5/register",
    {
      accountNumber,
      server: "MetaQuotes-Demo",
      company: "MetaQuotes Ltd",
      currency: "USD",
      balance: 10000,
      equity: 10000,
      marginMode: "HEDGING",
      availableSymbols,
    },
  );
  assertEqual(registered.status, "REGISTERED", "MT5 account registration");

  const heartbeat = await postJson<HeartbeatResponse>(
    apiBase,
    "/mt5/heartbeat",
    buildHeartbeatPayload({
      accountId: registered.accountId,
      balance: 10025,
      equity: 10020,
      availableSymbols,
    }),
  );
  assertEqual(heartbeat.accountId, registered.accountId, "MT5 heartbeat account");
  assertEqual(heartbeat.heartbeatStatus, "online", "MT5 heartbeat status");

  const openSignal = await parseAndApprove(apiBase, {
    providerId,
    accountId: registered.accountId,
    rawText: [
      "BUY EURUSD @ 1.0850",
      "SL 1.0810",
      "TP1 1.0900",
      "TP2 1.0950",
      `Smoke ${suffix}`,
    ].join("\n"),
    expectedCommandType: "OPEN_TRADE",
    expectedBrokerSymbol: "EURUSD.raw",
  });
  const openWork = await pollWork(apiBase, registered.accountId);
  assertEqual(openWork.queueItemId, openSignal.queueItemId, "open queue item lease");
  assertEqual(openWork.commandType, "OPEN_TRADE", "open command type");
  assertEqual(openWork.brokerSymbol, "EURUSD.raw", "open broker symbol");
  await postJson(
    apiBase,
    "/mt5/report",
    buildExecutionReportPayload({
      accountId: registered.accountId,
      work: openWork,
      ticketSuffix: `${suffix}-open`,
    }),
  );

  const lifecycleSignal = await parseAndApprove(apiBase, {
    providerId,
    accountId: registered.accountId,
    rawText: [`Move SL to BE EURUSD`, `Smoke ${suffix}`].join("\n"),
    expectedCommandType: "MOVE_SL_TO_BE",
    expectedBrokerSymbol: "EURUSD.raw",
  });
  const lifecycleWork = await pollWork(apiBase, registered.accountId);
  assertEqual(lifecycleWork.queueItemId, lifecycleSignal.queueItemId, "lifecycle queue item lease");
  assertEqual(lifecycleWork.commandType, "MOVE_SL_TO_BE", "lifecycle command type");
  assertEqual(lifecycleWork.logicalTradeId, openSignal.logicalTradeId, "lifecycle trade match");
  assertEqual(lifecycleWork.brokerSymbol, "EURUSD.raw", "lifecycle broker symbol");
  await postJson(
    apiBase,
    "/mt5/report",
    buildExecutionReportPayload({
      accountId: registered.accountId,
      work: lifecycleWork,
      ticketSuffix: `${suffix}-lifecycle`,
    }),
  );

  const logs = await getJson<{ logs: ExecutionLog[] }>(apiBase, "/execution-logs");
  const openLog = logs.logs.find((log) => log.queueItemId === openSignal.queueItemId);
  const lifecycleLog = logs.logs.find((log) => log.queueItemId === lifecycleSignal.queueItemId);
  assertExecutedLog(openLog, registered.accountId, "open execution report");
  assertExecutedLog(lifecycleLog, registered.accountId, "lifecycle execution report");

  return {
    accountId: registered.accountId,
    providerId,
    openQueueItemId: openSignal.queueItemId,
    lifecycleQueueItemId: lifecycleSignal.queueItemId,
    logicalTradeId: openSignal.logicalTradeId,
    heartbeatStatus: heartbeat.heartbeatStatus,
    checkedLogs: logs.logs.length,
  };
}

async function parseAndApprove(
  apiBase: string,
  input: {
    providerId: string;
    accountId: string;
    rawText: string;
    expectedCommandType: string;
    expectedBrokerSymbol: string;
  },
) {
  const parsed = await postJson<ParseResponse>(apiBase, "/parser/parse", {
    providerId: input.providerId,
    accountId: input.accountId,
    rawText: input.rawText,
  });
  assertEqual(parsed.result.commandType, input.expectedCommandType, "parsed command type");
  assertEqual(parsed.result.brokerSymbol, input.expectedBrokerSymbol, "parsed broker symbol");
  if (parsed.reviewRequired) {
    throw new Error(
      `Parsed ${input.expectedCommandType} unexpectedly requires review: missing=${parsed.result.missingFields.join(
        ",",
      )} warnings=${parsed.result.warnings.join(",")}`,
    );
  }

  const approved = await postJson<ApproveResponse>(
    apiBase,
    `/signals/${encodeURIComponent(parsed.parsedSignalId)}/approve`,
    {},
  );
  assertEqual(approved.status, "PENDING", "approved signal status");
  if (!approved.logicalTradeId) {
    throw new Error(`Approved ${input.expectedCommandType} did not return logicalTradeId`);
  }
  return { ...approved, logicalTradeId: approved.logicalTradeId };
}

async function pollWork(apiBase: string, accountId: string) {
  const payload = await getText(
    apiBase,
    `/mt5/poll-line?accountId=${encodeURIComponent(accountId)}`,
  );
  const work = parseMt5LinePayload(payload);
  assertEqual(work.status, "WORK", "MT5 poll-line status");
  if (!work.queueItemId) {
    throw new Error(`MT5 poll-line returned work without queueItemId:\n${payload}`);
  }
  return work;
}

async function postJson<T>(apiBase: string, path: string, body: unknown): Promise<T> {
  return await parseResponse<T>(
    await fetch(`${apiBase}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

async function getJson<T>(apiBase: string, path: string): Promise<T> {
  return await parseResponse<T>(await fetch(`${apiBase}${path}`));
}

async function getText(apiBase: string, path: string): Promise<string> {
  const response = await fetch(`${apiBase}${path}`);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${path}: ${text}`);
  }
  return text;
}

async function parseResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text}`);
  }
  return JSON.parse(text) as T;
}

function assertExecutedLog(log: ExecutionLog | undefined, accountId: string, label: string) {
  if (!log) {
    throw new Error(`Missing ${label}`);
  }
  assertEqual(log.accountId, accountId, `${label} account`);
  assertEqual(log.status, "EXECUTED", `${label} status`);
  assertEqual(String(log.retcode), "10009", `${label} retcode`);
}

function assertEqual(actual: unknown, expected: unknown, label: string) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, received ${String(actual)}`);
  }
}

function parseOptionalNumber(value: string | undefined) {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeApiBase(value: string) {
  return value.replace(/\/+$/, "");
}

function sanitizeSuffix(value: string) {
  const sanitized = value.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 12);
  if (!sanitized) return Date.now().toString(36);
  return sanitized;
}

if (import.meta.main) {
  try {
    const summary = await runMt5Smoke();
    console.log(JSON.stringify({ status: "ok", ...summary }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
