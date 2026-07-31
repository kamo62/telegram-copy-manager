import { Database } from "bun:sqlite";
import { copyFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  type AccountSymbolMapping,
  buildExecutionCommand,
  correlateMessages,
  createLogicalTradeFromSignal,
  createMessageFingerprint,
  type Direction,
  downsampleSeries,
  type ExecutionMode,
  type ExecutionQueueItem,
  type LogicalTrade,
  matchLifecycleCommandToTrade,
  type OrderType,
  type ParsedSignal,
  type ParserContext,
  type ParserMode,
  parseSignalText,
  parseSignalTexts,
  type QueueStatus,
  resolveSymbol,
  shouldRequireManualReview,
  type TakeProfitStrategy,
  type TradeSource,
  withTakeProfitVolumes,
} from "@telegram-tc/core";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { nanoid } from "nanoid";
import {
  type EvidenceTier,
  type ExecutionEvidenceProviderConfig,
  type ExecutionEvidenceVerdict,
  evaluateExecutionEvidence,
  type LifecycleResolutionEvidence,
} from "./execution-evidence";
import {
  createTelegramAdapter,
  demoDialogs,
  demoMessages,
  type TelegramAdapter,
  type TelegramCapturedMessage,
  type TelegramDialog,
  type TelegramFetchGap,
  TelegramRpcTimeoutError,
  type TelegramSessionHealth,
  type TelegramSessionStatus,
  withTelegramRpcTimeout,
} from "./telegram";

export interface ApiOptions {
  databasePath?: string;
  seedDemoData?: boolean;
  staticRoot?: string;
  assetArchiveRoot?: string;
  telegram?: TelegramAdapter;
  telegramAdapter?: "mock" | "gramjs";
  telegramPollingEnabled?: boolean;
  telegramPollingIntervalMs?: number;
  telegramRpcTimeoutMs?: number;
}

const DEFAULT_TELEGRAM_RPC_TIMEOUT_MS = 20_000;
const MAX_TELEGRAM_RPC_TIMEOUT_MS = 30_000;
const TELEGRAM_PROVIDER_STALL_FAILURES = 2;

function rawForwardedFrom(message: TelegramCapturedMessage) {
  return message.forwardedFrom ? JSON.stringify(message.forwardedFrom) : null;
}

function telegramRpcTimeoutMs(value?: number) {
  const configured = value ?? Number(process.env.TELEGRAM_RPC_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0
    ? Math.min(Math.floor(configured), MAX_TELEGRAM_RPC_TIMEOUT_MS)
    : DEFAULT_TELEGRAM_RPC_TIMEOUT_MS;
}

const demoAccountId = "mt5-100200300";
const demoProviderId = "provider-alpha";

/**
 * Emit a single-line JSON log to stdout. Visible in `docker logs telegram-tc -f`.
 * Use for events the operator needs to see in real time (request errors, queue
 * transitions, EA reports). The audit_logs table remains the persistent record.
 */
export function log(
  level: "info" | "warn" | "error",
  event: string,
  fields: Record<string, unknown> = {},
): void {
  const line = JSON.stringify({ t: new Date().toISOString(), level, event, ...fields });
  if (level === "error") console.error(line);
  else console.log(line);
}

const defaultGlobalAliases = {
  GOLD: "XAUUSD",
  "EUR/USD": "EURUSD",
  US30: "DJI30",
};

const defaultProviderAliases: Record<string, Record<string, string>> = {};
const CLOSE_VOLUME_EPSILON = 0.000001;
const EQUITY_CURVE_RETENTION_DAYS = 90;
// Wire cap for dashboard equity curves: charts render a few hundred columns at
// most, while raw snapshot curves grow into the thousands and dominated the
// /api/dashboard payload (~295 KB per curve at ~6k points).
const EQUITY_CURVE_MAX_POINTS = 500;
const MAX_EXECUTION_LOG_LIMIT = 500;
// Snapshots arrive with each heartbeat, seconds apart. Anything older than this is a
// silent EA, not a market price, and must not drive an execution decision.
const QUOTE_FRESHNESS_MAX_AGE_MS = 5 * 60_000;
const LANE2_CLOSE_CAPABILITY = "lane2-close-contract";
const PENDING_CLOSE_FLATTEN_CAPABILITY = "pending-close-flatten-v1";

function capEquityCurve<T extends { equity: number }>(points: T[]): T[] {
  return downsampleSeries(points, EQUITY_CURVE_MAX_POINTS, (point) => point.equity);
}

type SymbolAliasScope = "global" | "provider";
type AccountMappingInput = AccountSymbolMapping & {
  direct?: boolean;
  rawSymbol?: string;
  brokerSymbol?: string;
};
type AppOrderType = Extract<OrderType, "MARKET" | "LIMIT" | "STOP">;
type EquityCurveScope = "account" | "provider";
type StatsRange = "today" | "7d" | "30d" | "90d" | "all";
type ReportingCurrency = "USD" | "ZAR";
type AccountAttributionBucket = "provider" | "manual_external" | "unknown_ea";
type AlertSetting =
  | "alertOnGuardianPause"
  | "alertOnEaOffline"
  | "alertOnExecFailed"
  | "alertOnHeld"
  | "alertOnDroppedLifecycle"
  | "alertOnTelegramStall";

class ReleaseConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReleaseConflictError";
  }
}

type DeferredAlert = {
  event: string;
  key: string;
  text: string;
  setting: AlertSetting;
  force: boolean;
};

type RequeueSuccess =
  | {
      queueItemId: string;
      originQueueItemId: string;
      accountId: string;
      logicalTradeId?: string;
      mode: string;
      status: "PENDING";
      droppedLifecycleCount: number;
      droppedLifecycle: string[];
      remainingHeldQueueItems?: string[];
      remainingTradeCount?: number;
    }
  | {
      originQueueItemId: string;
      accountId: string;
      logicalTradeId: string;
      logicalTradeIds: string[];
      mode: string;
      status: "RECORDED";
    };

type RequeueError = { statusCode: 404 | 409 | 422; error: string };

export function hasExitVocabularyForDropAudit(text: string) {
  return /\b(?:CLOS|CANCEL|DELET|REMOV)/i.test(text);
}

interface AppSettings {
  defaultLotSize: number;
  defaultRiskPercent: number;
  pollingIntervalSeconds: number;
  allowedOrderTypes: AppOrderType[];
  defaultStopLossPips: number;
  defaultTakeProfitPips: number;
  azureOpenAIKeyConfigured: boolean;
  leaseTimeoutSeconds: number;
  maxLeaseAttempts: number;
  dedupWindowSeconds: number;
  maxOpenTradeAgeSeconds: number;
  drawdownWarnPct: number;
  drawdownDangerPct: number;
  reportingCurrency: ReportingCurrency;
  usdZarRate: number;
  releaseHeldOnGuardianUnpause: boolean;
  releaseHeldOnEaReconnect: boolean;
  alertBotToken: string;
  alertChatId: string;
  alertOnGuardianPause: boolean;
  alertOnEaOffline: boolean;
  alertOnExecFailed: boolean;
  alertOnHeld: boolean;
  alertOnDroppedLifecycle: boolean;
  alertOnTelegramStall: boolean;
}

interface AccountSlotInput {
  name: string;
}

interface ProviderExecutionConfig {
  openEvidence?: ExecutionEvidenceProviderConfig["openEvidence"];
  parserMode?: ParserMode | string;
  lockedSymbol?: string;
  tradedSymbols?: string[];
  shorthandLevels?: boolean;
  riskMode: "fixed" | "percent";
  riskAmount: number;
  takeProfitLevels: ProviderTakeProfitLevel[];
  workFromTpLeg?: number;
  runner?: { enabled: boolean; lotSize: number; slBehavior: string; trailPips: number };
}

interface ProviderTakeProfitLevel {
  leg: number;
  percentage: number;
  strategy: TakeProfitStrategy;
}

type ProviderTakeProfitLevelInput = {
  leg: number;
  percentage: number;
  strategy?: TakeProfitStrategy | string | null;
};

const fallbackAccountId = process.env.DEFAULT_MT5_ACCOUNT_ID ?? demoAccountId;
const MAX_PROVIDER_TP_LEVELS = 4;
const REFERENCE_PRICE_MAX_AGE_SECONDS = 60;

const defaultAppSettings: AppSettings = {
  defaultLotSize: 0.1,
  defaultRiskPercent: 1,
  pollingIntervalSeconds: 2,
  allowedOrderTypes: ["MARKET", "LIMIT", "STOP"],
  defaultStopLossPips: 50,
  defaultTakeProfitPips: 200,
  azureOpenAIKeyConfigured: false,
  leaseTimeoutSeconds: 15,
  maxLeaseAttempts: 3,
  dedupWindowSeconds: 300,
  maxOpenTradeAgeSeconds: 0,
  drawdownWarnPct: 10,
  drawdownDangerPct: 20,
  reportingCurrency: "USD",
  usdZarRate: 16,
  releaseHeldOnGuardianUnpause: false,
  releaseHeldOnEaReconnect: true,
  alertBotToken: "",
  alertChatId: "",
  alertOnGuardianPause: false,
  alertOnEaOffline: false,
  alertOnExecFailed: false,
  // Alerting is off by default. It cannot deliver anything without a bot token and
  // chat ID anyway, and defaulting these on produced "enabled" toggles on a channel
  // that silently discarded every message. Turn them on once delivery is configured
  // and proven with Send test message.
  alertOnHeld: false,
  alertOnDroppedLifecycle: false,
  alertOnTelegramStall: false,
};
const pendingOpenMissingGraceSeconds = 10;
const EA_HEARTBEAT_SECONDS = 5;
const EQUITY_GUARDIAN_HEARTBEAT_MAX_AGE_SECONDS = 30;
const GUARDIAN_AUTO_RELEASE_MAX_AGE_SECONDS = 60 * 60;
const EA_OFFLINE_RELEASE_MAX_AGE_SECONDS = 15 * 60;

type EvidenceTarget = {
  accountId: string;
  signal: ParsedSignal;
  verdict: ExecutionEvidenceVerdict;
};

export function normalizeEvidenceTargets(targets: EvidenceTarget[]) {
  if (!targets.some((target) => target.verdict.verdict !== "DROP")) return targets;
  return targets.map((target) =>
    target.verdict.verdict === "DROP"
      ? {
          ...target,
          verdict: {
            ...target.verdict,
            verdict: "HOLD" as const,
            tier: "action-required" as const,
          },
        }
      : target,
  );
}
const ALERT_DEDUP_MS = 30 * 60 * 1000;
const MANUAL_PUSH_DEDUP_SECONDS = 10;
const OPEN_SIGNAL_DEDUP_SECONDS = 24 * 60 * 60;

const appOrderTypes = new Set<AppOrderType>(["MARKET", "LIMIT", "STOP"]);
const BROKER_AFFIX_CANONICALS = [
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
];

function defaultAccountMapping(accountId = demoAccountId): AccountSymbolMapping {
  return {
    accountId,
    canonicalOverrides: {},
    directBrokerOverrides: {},
    prefix: "",
    suffix: "",
    includeSymbols: [],
    excludeSymbols: [],
    availableBrokerSymbols: [],
  };
}

export const ASSET_ARCHIVE_MAX_FILES = 256;

export function archiveStaticAssets(
  staticRoot: string,
  archiveRoot: string,
  maxFiles = ASSET_ARCHIVE_MAX_FILES,
) {
  const currentAssets = join(staticRoot, "assets");
  const archivedAssets = join(archiveRoot, "assets");
  mkdirSync(archivedAssets, { recursive: true });

  let archived = 0;
  const currentAssetNames = new Set<string>();
  for (const entry of readdirSync(currentAssets, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    currentAssetNames.add(entry.name);
    copyFileSync(join(currentAssets, entry.name), join(archivedAssets, entry.name));
    archived += 1;
  }

  const archivedEntries = readdirSync(archivedAssets, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => ({
      name: entry.name,
      mtimeMs: statSync(join(archivedAssets, entry.name)).mtimeMs,
    }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
  const staleEntries = archivedEntries.filter((entry) => !currentAssetNames.has(entry.name));
  const staleRetention = Math.max(0, maxFiles - currentAssetNames.size);
  const pruned = staleEntries.slice(staleRetention);
  for (const entry of pruned) unlinkSync(join(archivedAssets, entry.name));

  return { archived, pruned: pruned.length, retained: archivedEntries.length - pruned.length };
}

export function createApi(options: ApiOptions = {}) {
  const shouldSeedDemoData = options.seedDemoData ?? process.env.SEED_DEMO_DATA === "true";
  const store = new AppStore(
    options.databasePath ?? process.env.DATABASE_PATH ?? "data/telegram-tc.db",
    shouldSeedDemoData,
  );
  const telegram =
    options.telegram ??
    createTelegramAdapter(
      options.telegramAdapter ?? (options.databasePath === ":memory:" ? "mock" : undefined),
    );
  if (shouldSeedDemoData) {
    store.seedDemoData();
  }

  const app = new Hono();
  app.use("/api/*", cors());

  const healthPayload = () => ({
    status: "ok",
    database: "connected",
    telegramAdapter: telegram.name,
  });

  app.get("/api/health", (c) => c.json(healthPayload()));
  app.get("/health", (c) => c.json(healthPayload()));

  app.get("/api/telegram/status", (c) => c.json(store.telegramStatus(telegram.name)));
  app.get("/api/dashboard", (c) =>
    c.json(store.dashboard(telegram.name, c.req.query("accountId"))),
  );
  app.get("/api/settings", (c) => c.json({ settings: store.settingsProjection() }));
  app.patch("/api/settings", async (c) => {
    const body = await c.req.json<Partial<AppSettings> & { azureOpenAIApiKey?: string }>();
    store.updateAppSettings(body);
    return c.json({ settings: store.settingsProjection() });
  });
  app.post("/api/admin/alert-test", async (c) => {
    const result = await store.sendAlertTest();
    if ("error" in result) return c.json({ error: result.error }, result.statusCode);
    return c.json(result);
  });
  app.post("/api/admin/backup", (c) => {
    const result = store.backupDatabase();
    if ("error" in result) return c.json({ error: result.error }, result.statusCode);
    return c.json({ filename: result.filename });
  });
  app.get("/api/admin/backups", (c) => c.json({ backups: store.backups() }));

  app.post("/api/telegram/start", async (c) => {
    const body = await c.req.json<{
      apiId?: string;
      apiHash?: string;
      phone: string;
    }>();
    const apiId = body.apiId?.trim() || process.env.TELEGRAM_API_ID;
    const apiHash = body.apiHash?.trim() || process.env.TELEGRAM_API_HASH;
    if (!apiId || !apiHash) {
      return c.json(
        {
          error:
            "Telegram API credentials are not configured. Set TELEGRAM_API_ID and TELEGRAM_API_HASH on the server.",
        },
        400,
      );
    }
    const credentials = { apiId, apiHash, phone: body.phone };
    const started = store.startTelegramSession(credentials);
    const adapterStatus = await telegram.startLogin({
      ...credentials,
      appSessionId: started.sessionId,
      profileId: started.profileId,
    });
    if (adapterStatus.status !== started.status) {
      store.updateTelegramSession(started.sessionId, adapterStatus.status);
    }
    return c.json({
      ...started,
      status: adapterStatus.status,
      isCodeViaApp: adapterStatus.isCodeViaApp,
      passwordHint: adapterStatus.passwordHint,
    });
  });

  app.post("/api/telegram/verify-code", async (c) => {
    const body = await c.req.json<{ sessionId: string; code: string }>();
    const status = await telegram.submitCode(body.sessionId, body.code);
    return c.json({
      ...store.updateTelegramSession(body.sessionId, status.status),
      passwordHint: status.passwordHint,
    });
  });

  app.post("/api/telegram/submit-password", async (c) => {
    const body = await c.req.json<{ sessionId: string; password: string }>();
    if (!body.password) {
      return c.json({ error: "2FA password is required" }, 400);
    }
    const status = await telegram.submitPassword(body.sessionId, body.password);
    return c.json(store.updateTelegramSession(body.sessionId, status.status));
  });

  app.post("/api/telegram/disconnect", async (c) => {
    const body = await c.req.json<{ sessionId: string }>();
    await telegram.disconnect(body.sessionId);
    return c.json(store.updateTelegramSession(body.sessionId, "DISCONNECTED"));
  });

  app.get("/api/telegram/dialogs", async (c) => {
    const profileId = c.req.query("profileId");
    const sessionId = profileId ? store.connectedSessionIdForProfile(profileId) : undefined;
    if (sessionId) {
      try {
        return c.json({ dialogs: await telegram.listDialogs(sessionId) });
      } catch {
        if (telegram.name !== "mock") {
          return c.json({ dialogs: [] });
        }
      }
    }
    if (telegram.name !== "mock") return c.json({ dialogs: [] });
    return c.json({ dialogs: store.dialogs(profileId) });
  });

  app.get("/api/providers", (c) => c.json({ providers: store.providers() }));
  app.get("/api/providers/:id/config", (c) =>
    c.json({ config: store.providerConfig(c.req.param("id"), c.req.query("accountId")) }),
  );
  app.get("/api/providers/:id/config-history", (c) =>
    c.json({ history: store.providerConfigHistory(c.req.param("id")) }),
  );
  app.post("/api/providers/:id/test-config", async (c) => {
    const body = await c.req.json<{
      rawText: string;
      accountId?: string;
      config?: Partial<ProviderExecutionConfig>;
    }>();
    return c.json(store.testProviderConfig(c.req.param("id"), body));
  });

  app.post("/api/providers", async (c) => {
    const body = await c.req.json<{ profileId: string; dialogId: string; title?: string }>();
    return c.json(store.selectProvider(body));
  });

  app.post("/api/providers/resync-current-session", async (c) => {
    let body: { profileId?: string } = {};
    try {
      body = await c.req.json<{ profileId?: string }>();
    } catch {
      body = {};
    }
    const session = store.connectedTelegramSession(body.profileId);
    if (!session) {
      return c.json({ error: "Connected Telegram session not found" }, 404);
    }
    const dialogs = await telegram.listDialogs(session.id);
    return c.json({
      sessionId: session.id,
      ...store.resyncProvidersToTelegramSession({
        profileId: session.profileId,
        dialogs,
      }),
    });
  });

  app.patch("/api/providers/:id", async (c) => {
    const body = await c.req.json<{
      enabled?: boolean;
      parserMode?: string;
      lockedSymbol?: string | null;
      tradedSymbols?: string[] | null;
      riskProfile?: string;
      lotSize?: number;
      riskMode?: "fixed" | "percent";
      riskAmount?: number;
      openEvidence?: ExecutionEvidenceProviderConfig["openEvidence"];
      takeProfitLevels?: ProviderTakeProfitLevelInput[] | null;
      workFromTpLeg?: number;
      runner?: { enabled: boolean; lotSize: number; slBehavior: string; trailPips: number };
    }>();
    return c.json(store.updateProvider(c.req.param("id"), body));
  });

  app.post("/api/providers/:id/not-an-instrument", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Malformed JSON" }, 400);
    }
    const token =
      body && typeof body === "object" && !Array.isArray(body) && "token" in body
        ? (body as { token?: unknown }).token
        : undefined;
    const result = store.suppressProviderSymbol(c.req.param("id"), token);
    if ("error" in result) return c.json({ error: result.error }, result.statusCode);
    return c.json(result);
  });

  app.delete("/api/providers/:id", (c) => c.json(store.deleteProvider(c.req.param("id"))));

  app.get("/api/providers/:id/messages", async (c) => {
    const limit = Number(c.req.query("limit") ?? 20);
    const provider = store.providerDetails(c.req.param("id"));
    const sessionId = provider ? store.connectedSessionIdForProfile(provider.profileId) : undefined;
    if (provider && sessionId) {
      try {
        const { messages: captured } = await telegram.fetchRecentMessages(
          sessionId,
          provider.dialogId,
          limit,
        );
        if (captured.length > 0) {
          store.captureMessages(provider.id, captured);
          return c.json({ messages: store.recentMessages(provider.id, limit, false) });
        }
      } catch {
        if (telegram.name !== "mock") {
          return c.json({ messages: [] });
        }
      }
    }
    return c.json({ messages: store.recentMessages(c.req.param("id"), limit) });
  });

  app.get("/api/providers/:id/detected-symbols", async (c) => {
    const providerId = c.req.param("id");
    const provider = store.providerDetails(providerId);
    if (!provider) return c.json({ error: "Provider not found" }, 404);
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 1000), 1), 50_000);
    const sessionId = store.connectedSessionIdForProfile(provider.profileId);
    let messages: TelegramCapturedMessage[];
    if (sessionId) {
      try {
        await telegram.listDialogs(sessionId);
        ({ messages } = await telegram.fetchRecentMessages(sessionId, provider.dialogId, limit));
      } catch {
        messages = store.recentMessages(providerId, limit, false);
      }
    } else {
      messages = store.recentMessages(providerId, limit, false);
    }
    return c.json({ symbols: store.detectedSymbols(providerId, messages) });
  });

  app.post("/api/providers/:id/import-messages", async (c) => {
    const body = await c.req.json<{
      limit?: number;
      dateFrom?: string;
      dateTo?: string;
    }>();
    const provider = store.providerDetails(c.req.param("id"));
    const sessionId = provider ? store.connectedSessionIdForProfile(provider.profileId) : undefined;
    if (!provider || !sessionId) {
      return c.json({ error: "Provider or connected Telegram session not found" }, 404);
    }
    await telegram.listDialogs(sessionId);
    const { messages: captured } = await telegram.fetchRecentMessages(
      sessionId,
      provider.dialogId,
      Math.min(Math.max(Number(body.limit ?? 5000), 1), 50_000),
      { dateFrom: body.dateFrom, dateTo: body.dateTo },
    );
    const result = store.captureMessages(provider.id, captured);
    return c.json({ providerId: provider.id, ...result });
  });

  app.post("/api/providers/:id/backtest", async (c) => {
    const body = await c.req.json<{ accountId?: string; dateFrom?: string; dateTo?: string }>();
    return c.json(
      store.backtestProviderMessages(c.req.param("id"), {
        accountId: body.accountId,
        dateFrom: body.dateFrom,
        dateTo: body.dateTo,
      }),
    );
  });

  app.post("/api/providers/:id/parse-recent", async (c) => {
    const providerId = c.req.param("id");
    const limit = Number(c.req.query("limit") ?? 10);
    const provider = store.providerDetails(providerId);
    const sessionId = provider ? store.connectedSessionIdForProfile(provider.profileId) : undefined;
    let captured = 0;
    let inserted = 0;
    let fetchError: string | undefined;
    if (provider && sessionId) {
      try {
        const { messages } = await telegram.fetchRecentMessages(
          sessionId,
          provider.dialogId,
          limit,
        );
        captured = messages.length;
        if (messages.length > 0) {
          inserted = store.captureMessages(provider.id, messages).inserted;
        }
      } catch (error) {
        if (telegram.name !== "mock") {
          fetchError = error instanceof Error ? error.message : "Telegram fetch failed";
        }
      }
    }
    try {
      const parsed = store.parseRecentProviderMessages(providerId, limit);
      return c.json({
        parsed,
        provider: {
          providerId,
          captured,
          inserted,
          parsed: parsed.length,
          ...(fetchError ? { error: fetchError } : {}),
        },
      });
    } catch (error) {
      return c.json({
        parsed: [],
        provider: {
          providerId,
          captured,
          inserted,
          parsed: 0,
          error: error instanceof Error ? error.message : "Parser failed",
        },
      });
    }
  });

  app.patch("/api/messages/:id/classification", async (c) => {
    const body = await c.req.json<{ classification: RawMessageClassification }>();
    const updated = store.classifyMessage(c.req.param("id"), body.classification);
    if ("error" in updated) {
      return c.json({ error: updated.error }, 422);
    }
    return c.json(updated);
  });

  app.post("/api/messages/:id/fixture", async (c) => {
    const body = await c.req.json<{
      classification?: RawMessageClassification;
      redacted?: boolean;
      redactedRawText?: string;
      expectedCommandType?: string;
      expectedSymbol?: string;
    }>();
    const saved = store.saveFixtureFromMessage(c.req.param("id"), body);
    if ("error" in saved) {
      return c.json({ error: saved.error }, 422);
    }
    return c.json(saved);
  });

  app.post("/api/parser/parse", async (c) => {
    const body = await c.req.json<{ providerId: string; rawText: string; accountId?: string }>();
    const parsed = store.parseProviderMessage(body.providerId, body.rawText, body.accountId);
    return c.json(parsed);
  });

  app.post("/api/parser/fixtures", async (c) => {
    const body = await c.req.json<{
      providerLabel: string;
      rawText: string;
      expectedCommandType: string;
      expectedSymbol?: string;
      redacted?: boolean;
    }>();
    return c.json(store.saveFixture(body));
  });

  app.get("/api/parser/fixtures", (c) => c.json({ fixtures: store.fixtures() }));

  app.get("/api/signals", (c) => {
    const queue = store.queueItems();
    return c.json({ signals: store.parsedSignals(), queue });
  });

  app.get("/api/queue-items/held", (c) => c.json({ items: store.heldQueueItems() }));
  app.post("/api/queue-items/:id/requeue", async (c) => {
    const body = await c.req.json<{ mode?: string; logicalTradeId?: string }>();
    const result = store.requeueQueueItem(c.req.param("id"), body.mode, body.logicalTradeId);
    if ("error" in result) return c.json({ error: result.error }, result.statusCode);
    return c.json(result);
  });
  app.post("/api/queue-items/:id/dismiss", (c) => {
    const result = store.dismissQueueItem(c.req.param("id"));
    if ("error" in result) return c.json({ error: result.error }, result.statusCode);
    return c.json(result);
  });

  app.post("/api/signals/:id/approve", async (c) => {
    const body = await optionalJson<{ executionMode?: ExecutionMode }>(c.req.raw);
    const approved = store.approveSignal(c.req.param("id"), {
      executionMode: body.executionMode,
      trigger: "operator",
    });
    if ("body" in approved) {
      return c.json(approved.body);
    }
    if (approved.statusCode === 409) {
      return c.json({ error: approved.error }, 409);
    }
    return c.json({ error: approved.error }, 422);
  });

  app.post("/api/signals/:id/ignore", (c) => {
    const ignored = store.ignoreSignal(c.req.param("id"));
    if ("error" in ignored) return c.json({ error: ignored.error }, ignored.statusCode);
    return c.json(ignored);
  });

  app.post("/api/signals/manual", async (c) => {
    const body = await c.req.json<ManualSignalInput>();
    const result = store.submitManualSignal(body);
    if ("body" in result) return c.json(result.body);
    return c.json({ error: result.error }, result.statusCode);
  });

  app.post("/api/signals/:id/ai-review", async (c) => {
    const review = await store.aiReviewSignal(c.req.param("id"));
    if ("error" in review) {
      return c.json({ error: review.error }, review.statusCode);
    }
    return c.json(review);
  });

  app.get("/api/symbol-mappings", (c) => c.json(store.symbolMappings(c.req.query("accountId"))));

  app.put("/api/symbol-mappings/aliases", async (c) => {
    const body = await c.req.json<{
      scope: SymbolAliasScope;
      providerId?: string;
      rawSymbol: string;
      canonicalSymbol: string;
    }>();
    return c.json(store.saveSymbolAlias(body));
  });
  app.delete("/api/symbol-mappings/aliases", async (c) => {
    const body = await c.req.json<{
      scope: SymbolAliasScope;
      providerId?: string;
      rawSymbol: string;
    }>();
    return c.json(store.deleteSymbolAlias(body.scope, body.rawSymbol, body.providerId));
  });

  app.put("/api/symbol-mappings/account/:accountId", async (c) => {
    const mapping = await c.req.json<AccountMappingInput>();
    const saved = store.saveAccountMapping(c.req.param("accountId"), mapping);
    if ("error" in saved) return c.json(saved, 400);
    return c.json(saved);
  });
  app.delete("/api/symbol-mappings/account/:accountId/direct", async (c) => {
    const body = await c.req.json<{ rawSymbol: string }>();
    return c.json(store.deleteDirectBrokerOverride(c.req.param("accountId"), body.rawSymbol));
  });

  app.get("/api/mt5/accounts", (c) => c.json({ accounts: store.mt5Accounts() }));
  app.patch("/api/mt5/accounts/:accountId", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      !Object.hasOwn(body, "nickname") ||
      !(
        typeof (body as Record<string, unknown>).nickname === "string" ||
        (body as Record<string, unknown>).nickname === null
      )
    ) {
      return c.json({ error: "nickname must be text or null" }, 400);
    }
    const result = store.updateAccountNickname(
      c.req.param("accountId"),
      (body as { nickname: string | null }).nickname,
    );
    if ("error" in result) return c.json(result, result.statusCode);
    return c.json(result);
  });
  app.delete("/api/mt5/accounts/:accountId", (c) => {
    const result = store.deleteMt5Account(c.req.param("accountId"));
    if ("error" in result) return c.json(result, 404);
    return c.json(result);
  });

  app.get("/api/account-slots", (c) => c.json({ slots: store.accountSlots() }));
  app.post("/api/account-slots", async (c) => {
    const body = await c.req.json<AccountSlotInput>();
    return c.json({ slot: store.createAccountSlot(body.name) });
  });
  app.delete("/api/account-slots/:id", (c) => {
    const result = store.deleteAccountSlot(c.req.param("id"));
    if ("error" in result) return c.json({ error: result.error }, result.statusCode);
    return c.json(result);
  });
  app.post("/api/account-slots/:id/rotate", (c) =>
    c.json({ slot: store.rotateAccountSlot(c.req.param("id")) }),
  );
  app.post("/api/account-slots/:id/unlink", (c) =>
    c.json({ slot: store.unlinkAccountSlot(c.req.param("id")) }),
  );

  app.get("/api/account-provider-links", (c) => c.json({ links: store.accountProviderLinks() }));
  app.put("/api/account-provider-links/:accountId/:providerId", async (c) => {
    const body = await c.req.json<{
      enabled?: boolean;
      config?: {
        lotSize?: number;
        riskMode?: "fixed" | "percent";
        riskAmount?: number;
        takeProfitLevels?: ProviderTakeProfitLevelInput[] | null;
        workFromTpLeg?: number;
        runner?: { enabled: boolean; lotSize: number; slBehavior: string; trailPips: number };
      };
    }>();
    const accountId = c.req.param("accountId");
    const providerId = c.req.param("providerId");
    // Only touch the copy flag when `enabled` is explicitly provided, so a config-only
    // save from the modal does not silently enable/disable copying.
    const link =
      body.enabled !== undefined
        ? store.updateAccountProviderLink(accountId, providerId, body.enabled)
        : store
            .accountProviderLinks()
            .find((l) => l.accountId === accountId && l.providerId === providerId);
    const config = body.config
      ? store.updateAccountProviderConfig(accountId, providerId, body.config)
      : undefined;
    return c.json({ link, config });
  });

  app.get("/api/equity-guardian", (c) => c.json({ guardians: store.equityGuardians() }));
  app.patch("/api/equity-guardian/:accountId", async (c) => {
    const body = await c.req.json<{ threshold?: number; enabled?: boolean; paused?: boolean }>();
    const accountId = c.req.param("accountId");
    const guardian = store.updateEquityGuardian(accountId, {
      threshold: body.threshold,
      enabled: body.enabled,
      paused: body.paused,
    });
    if (body.paused !== false) return c.json({ guardian });
    const result = store.unpauseEquityGuardian(accountId);
    if ("error" in result)
      return c.json({ error: result.error, guardian: result.guardian }, result.statusCode);
    return c.json(result);
  });
  app.post("/api/equity-guardian/:accountId/unpause", (c) => {
    const result = store.unpauseEquityGuardian(c.req.param("accountId"));
    if ("error" in result)
      return c.json({ error: result.error, guardian: result.guardian }, result.statusCode);
    return c.json(result);
  });

  app.get("/api/account/performance", (c) => c.json(store.accountPerformance()));
  app.get("/api/accounts/:accountId/attribution", (c) =>
    c.json(store.accountAttribution(c.req.param("accountId"), { range: c.req.query("range") })),
  );
  app.get("/api/accounts/:accountId/stats", (c) =>
    c.json(
      store.accountStats(c.req.param("accountId"), {
        range: c.req.query("range"),
        scope: c.req.query("scope"),
        providerId: c.req.query("providerId"),
      }),
    ),
  );
  app.patch("/api/accounts/:accountId/risk-thresholds", async (c) => {
    const body = await c.req.json<{ warnPct?: number | null; dangerPct?: number | null }>();
    const result = store.updateAccountRiskThresholds(c.req.param("accountId"), body);
    if (!result) {
      return c.json({ error: "Account not found" }, 404);
    }
    return c.json(result);
  });
  app.get("/api/providers/performance/export.csv", (c) => {
    const csv = store.providerPerformanceCsv(c.req.query("accountId"));
    const filename = `provider-performance-${new Date(Date.now()).toISOString().slice(0, 10)}.csv`;
    return c.text(csv, 200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
    });
  });
  app.get("/api/providers/performance", (c) => c.json({ providers: store.providerPerformance() }));

  app.get("/api/providers/:id/score", (c) => {
    const score = store.providerScore(c.req.param("id"));
    if (!score) return c.json({ error: "Provider not found" }, 404);
    return c.json(score);
  });

  app.delete("/api/providers/:id/learning", (c) =>
    c.json(store.resetProviderLearning(c.req.param("id"))),
  );

  app.post("/api/mt5/register", async (c) => {
    const parsed = await mt5Json<{
      accountNumber: string;
      server: string;
      company: string;
      currency: string;
      balance: number;
      equity: number;
      profit?: number;
      marginMode: "HEDGING" | "NETTING";
      availableSymbols?: string[];
      eaVersion?: string;
      eaCapabilities?: string[];
      linkCode?: string;
    }>(c.req.raw);
    if ("error" in parsed) return c.json({ error: parsed.error }, 400);
    const body = parsed.body;
    const registered = store.registerMt5Account(body);
    if ("error" in registered) return c.json({ error: registered.error }, registered.statusCode);
    return c.json(registered);
  });

  app.post("/api/mt5/heartbeat", async (c) => {
    const parsed = await mt5Json<{
      accountId: string;
      balance: number;
      equity: number;
      profit?: number;
      availableSymbols?: string[];
      eaVersion?: string;
      eaCapabilities?: string[];
      linkCode?: string;
    }>(c.req.raw);
    if ("error" in parsed) return c.json({ error: parsed.error }, 400);
    const body = parsed.body;
    const heartbeat = store.heartbeat(body);
    if ("error" in heartbeat) return c.json({ error: heartbeat.error }, heartbeat.statusCode);
    return c.json(heartbeat);
  });

  app.get("/api/mt5/poll", (c) =>
    c.json({ item: store.leaseNextQueueItem(c.req.query("accountId")) }),
  );

  app.get("/api/mt5/poll-line", (c) => {
    const item = store.leaseNextQueueItem(c.req.query("accountId"));
    const settings = store.appSettings();
    return c.text(item ? toMt5LinePayload(item, settings) : toMt5NoWorkPayload(settings), 200, {
      "content-type": "text/plain; charset=utf-8",
    });
  });

  app.post("/api/mt5/report", async (c) => {
    const parsed = await mt5Json<ExecutionReportInput>(c.req.raw);
    if ("error" in parsed) return c.json({ error: parsed.error }, 400);
    return c.json(store.executionReport(parsed.body));
  });

  app.post("/api/mt5/snapshot", async (c) => {
    const parsed = await mt5Json<{
      accountId: string;
      positions: unknown[];
      orders: unknown[];
      symbols?: unknown[];
    }>(c.req.raw);
    if ("error" in parsed) return c.json({ error: parsed.error }, 400);
    return c.json(store.saveSnapshot(parsed.body));
  });

  app.post("/api/mt5/history", async (c) => {
    const parsed = await mt5Json<{
      accountId: string;
      deals: Mt5HistoryDealInput[];
    }>(c.req.raw);
    if ("error" in parsed) return c.json({ error: parsed.error }, 400);
    return c.json(store.saveBrokerHistory(parsed.body));
  });

  app.get("/api/execution-logs", (c) =>
    c.json({
      logs: store.executionLogs(
        c.req.query("accountId"),
        optionalPositiveInteger(c.req.query("limit"), MAX_EXECUTION_LOG_LIMIT),
      ),
    }),
  );
  app.get("/api/execution-logs/:id", (c) => c.json(store.executionLogDetails(c.req.param("id"))));

  app.get("/api/mt5/accounts/:accountId/logs", (c) =>
    c.json(store.mt5AccountLogs(c.req.param("accountId"))),
  );

  // Active virtual-TP plans for diagnostics and backward-compatible inspection.
  // Current EA builds no longer consume this endpoint; TP ownership lives in the app.
  app.get("/api/mt5/active-plans", (c) => {
    const accountId = c.req.query("accountId");
    if (!accountId) return c.text("error=accountId is required\n", 400);
    return c.text(renderActiveVirtualTpPlansLine(store.activeVirtualTpPlans(accountId)), 200, {
      "content-type": "text/plain; charset=utf-8",
    });
  });

  app.get("/api/trades/:id/broker-orders", (c) =>
    c.json({ orders: store.brokerOrders(c.req.param("id")) }),
  );
  app.post("/api/trades/:id/resolve", async (c) => {
    const body = await c.req.json<{ action?: string }>();
    const result = store.resolveTrade(c.req.param("id"), body.action);
    if ("error" in result) return c.json({ error: result.error }, result.statusCode);
    return c.json(result);
  });
  app.post("/api/trades/:id/cancel-pending", (c) => {
    const result = store.cancelPendingTrade(c.req.param("id"));
    if ("error" in result) return c.json({ error: result.error }, result.statusCode);
    return c.json(result);
  });

  app.get("/api/audit-logs", (c) =>
    c.json({
      logs: store.listAuditLogs({
        limit: optionalPositiveInteger(c.req.query("limit"), 500),
        event: c.req.query("event"),
      }),
    }),
  );

  app.get("/api/export/trades", (c) =>
    c.json({
      trades: store.exportClosedTrades({
        accountId: c.req.query("accountId"),
        from: c.req.query("from"),
        to: c.req.query("to"),
      }),
    }),
  );

  app.get("/api/accounts/:accountId/symbol-metadata", (c) =>
    c.json({ symbols: store.symbolMetadata(c.req.param("accountId")) }),
  );

  app.get("/api/export/journal", (c) => {
    const input = {
      accountId: c.req.query("accountId"),
      from: c.req.query("from"),
      to: c.req.query("to"),
    };
    if ((c.req.query("format") ?? "json").toLowerCase() === "csv") {
      const filename = `trade-journal-${new Date(Date.now()).toISOString().slice(0, 10)}.csv`;
      return c.text(store.exportTradeJournalCsv(input), 200, {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${filename}"`,
      });
    }
    return c.json({ journal: store.exportTradeJournal(input) });
  });

  // Real-time dashboard push. Replaces the 15s client poll: the client opens
  // one EventSource and the server forwards typed deltas as they happen. The
  // client keeps /api/dashboard for initial hydration and polling fallback.
  app.get("/api/events", (c) =>
    streamSSE(c, async (stream) => {
      const pending: AppStoreEvent[] = [];
      const unsubscribe = store.subscribeEvents((event) => {
        pending.push(event);
      });
      stream.onAbort(() => {
        unsubscribe();
      });
      await stream.writeSSE({ event: "hello", data: JSON.stringify({ ts: Date.now() }) });
      // ponytail: 250ms drain loop rather than a true push wakeup. Ceiling — up
      // to ~250ms added delivery latency; upgrade path is an async notifier.
      let sinceHeartbeatMs = 0;
      while (!stream.aborted && !stream.closed) {
        if (pending.length > 0) {
          const batch = pending.splice(0, pending.length);
          for (const event of batch) {
            await stream.writeSSE({ event: String(event.type), data: JSON.stringify(event) });
          }
          sinceHeartbeatMs = 0;
          continue;
        }
        await stream.sleep(250);
        sinceHeartbeatMs += 250;
        // Heartbeat well under the server idleTimeout so idle SSE connections are
        // never closed mid-stream (which makes EventSource reconnect in a loop).
        if (sinceHeartbeatMs >= 10_000) {
          await stream.writeSSE({ event: "ping", data: JSON.stringify({ ts: Date.now() }) });
          sinceHeartbeatMs = 0;
        }
      }
      unsubscribe();
    }),
  );

  if (options.staticRoot) {
    app.use(
      "/*",
      serveStatic({
        root: options.staticRoot,
        onFound: (path, c) => {
          if (c.req.path.startsWith("/assets/")) {
            c.header("Cache-Control", "public, max-age=31536000, immutable");
          } else if (path.endsWith("/index.html")) {
            c.header("Cache-Control", "no-cache");
          }
        },
      }),
    );
    if (options.assetArchiveRoot) {
      app.use(
        "/assets/*",
        serveStatic({
          root: options.assetArchiveRoot,
          onFound: (_path, c) => {
            c.header("Cache-Control", "public, max-age=31536000, immutable");
          },
        }),
      );
    }
    app.get("*", async (c) => {
      c.header("Cache-Control", "no-cache");
      return c.html(await Bun.file(`${options.staticRoot}/index.html`).text());
    });
  }

  const ingestion = createTelegramIngestionLoop(store, telegram, {
    enabled:
      options.telegramPollingEnabled ??
      (process.env.NODE_ENV !== "test" && options.databasePath !== ":memory:"),
    intervalMs: options.telegramPollingIntervalMs,
    rpcTimeoutMs: options.telegramRpcTimeoutMs,
  });

  return Object.assign(app, ingestion);
}

interface TelegramIngestionResult {
  providers: number;
  captured: number;
  inserted: number;
  parsed: number;
  queued: number;
  reviewRequired: number;
  errors: number;
  skipped?: boolean;
}

interface TelegramProviderHealth {
  providerId: string;
  sessionId: string;
  healthy: boolean;
  stalled: boolean;
  consecutiveFailures: number;
  checkedAt: string;
  error?: string;
}

type TelegramProvider = {
  id: string;
  profileId: string;
  dialogId: string;
  title: string;
  enabled: boolean;
  lastMessageAt: string;
  backfillCursorId?: string;
  backfillFloorAt?: string;
};

function pickNewerOffsetId(a: unknown, b: unknown): string | undefined {
  const left = a === null || a === undefined || a === "" ? undefined : Number(a);
  const right = b === null || b === undefined || b === "" ? undefined : Number(b);
  const valid = [left, right].filter((value): value is number => Number.isFinite(value));
  return valid.length === 0 ? undefined : String(Math.max(...valid));
}

function pickOlderIso(a: unknown, b: unknown): string | undefined {
  const valid = [a, b]
    .filter((value): value is string => typeof value === "string" && value !== "")
    .sort();
  return valid[0];
}

function createTelegramIngestionLoop(
  store: AppStore,
  telegram: TelegramAdapter,
  options: { enabled: boolean; intervalMs?: number; rpcTimeoutMs?: number },
) {
  let activeRun: Promise<TelegramIngestionResult> | undefined;
  const runTelegramIngestionOnce = async (): Promise<TelegramIngestionResult> => {
    if (activeRun) {
      return {
        providers: 0,
        captured: 0,
        inserted: 0,
        parsed: 0,
        queued: 0,
        reviewRequired: 0,
        errors: 0,
        skipped: true,
      };
    }
    activeRun = store
      .ingestEnabledProviders(telegram, 50, telegramRpcTimeoutMs(options.rpcTimeoutMs))
      .finally(() => {
        activeRun = undefined;
      });
    return activeRun;
  };
  const intervalMs =
    options.intervalMs ?? Math.max(1000, store.appSettings().pollingIntervalSeconds * 1000);
  const timer = options.enabled
    ? setInterval(() => {
        void runTelegramIngestionOnce();
      }, intervalMs)
    : undefined;
  if (timer) {
    (timer as { unref?: () => void }).unref?.();
    void runTelegramIngestionOnce();
  }
  return {
    runTelegramIngestionOnce,
    stopTelegramIngestion: async () => {
      if (timer) clearInterval(timer);
      await activeRun;
    },
  };
}

interface ManualSignalInput {
  accountId: string;
  providerId?: string;
  rawMessageId?: string;
  rawText?: string;
  commandType?: string;
  direction: Direction;
  orderType?: OrderType;
  brokerSymbol: string;
  canonicalSymbol?: string;
  entry?: { from?: number; to?: number };
  stopLoss?: number;
  takeProfits?: Array<{ price: number; allocationPercent?: number }>;
  volume?: number;
  riskPercent?: number;
  executionMode?: ExecutionMode;
}

function manualTicketSummary(
  input: { direction: Direction; stopLoss?: number; takeProfits?: Array<{ price: number }> },
  brokerSymbol: string,
  orderType: OrderType,
  entry: { from: number; to: number } | undefined,
): string {
  const parts = [`${input.direction} ${brokerSymbol} ${orderType}`];
  if (entry) {
    parts.push(entry.from === entry.to ? `@ ${entry.from}` : `@ ${entry.from}-${entry.to}`);
  }
  if (Number.isFinite(input.stopLoss)) parts.push(`SL ${input.stopLoss}`);
  const tps = (input.takeProfits ?? []).filter((tp) => Number.isFinite(tp.price));
  if (tps.length > 0) parts.push(`TP ${tps.map((tp) => tp.price).join("/")}`);
  return `Manual: ${parts.join(" ")}`;
}

interface ExecutionReportInput {
  accountId: string;
  queueItemId: string;
  status: "EXECUTED" | "PARTIAL" | "FAILED" | "UNKNOWN";
  retcode: number;
  retcodeExternal: number;
  brokerComment: string;
  orderTicket?: string;
  positionTicket?: string;
  dealTicket?: string;
  requestedPrice?: number;
  filledPrice?: number;
  requestedVolume?: number;
  filledVolume?: number;
  remainingVolume?: number;
  /** Legacy EA compatibility; replaced by requestedVolume/filledVolume. */
  volume?: number;
  errorText?: string;
}

interface AiSignalReview {
  verdict:
    | "EXECUTABLE_SIGNAL"
    | "TRADE_SETUP"
    | "LIFECYCLE_COMMAND"
    | "RESULT_UPDATE"
    | "PROVIDER_STRATEGY_NOTE"
    | "NOISE";
  shouldQueue: boolean;
  needsConfirmation: boolean;
  confidence: number;
  reason: string;
  symbol: string;
  direction: string;
  entry: string;
  stopLoss: string;
  takeProfits: string[];
  lifecycleAction: string;
}

interface Mt5HistoryDealInput {
  dealTicket: string;
  orderTicket?: string;
  positionTicket?: string;
  entry?: string;
  type?: string;
  /** MT5 ENUM_DEAL_REASON: 0=CLIENT, 1=MOBILE, 2=WEB, 3=EXPERT, 4=SL, 5=TP, 6=SO, 7=ROLLOVER, 8=VMARGIN, 9=SPLIT */
  reason?: number;
  magic?: number;
  symbol?: string;
  price?: number;
  volume?: number;
  profit?: number;
  commission?: number;
  swap?: number;
  fee?: number;
  comment?: string;
  time?: string;
  timeMsc?: number;
}

interface OperatorStateTableSnapshot {
  count: number;
  fingerprint: string;
}

interface OperatorStateSnapshot {
  accountProviderLinks: OperatorStateTableSnapshot;
  accountSymbolMappings: OperatorStateTableSnapshot;
  symbolAliases: OperatorStateTableSnapshot;
  providers: OperatorStateTableSnapshot;
  providerConfigHistory: OperatorStateTableSnapshot;
}

/**
 * MT5 ENUM_DEAL_REASON → broker_orders.source mapping. The source field is
 * what surfaces in the History tab so the operator knows whether a position
 * closed because SL was hit, TP fired, the user clicked Close in the terminal,
 * or an EA managed the exit.
 */
export function brokerOrderSourceForDealReason(reason: number | undefined): string {
  switch (reason) {
    case 0:
      return "manual-terminal";
    case 1:
      return "manual-mobile";
    case 2:
      return "manual-web";
    case 3:
      return "expert";
    case 4:
      return "sl-hit";
    case 5:
      return "tp-hit";
    case 6:
      return "stop-out";
    case 7:
      return "rollover";
    case 8:
      return "variation-margin";
    case 9:
      return "split";
    default:
      return "history";
  }
}

type RawMessageClassification = "entry" | "management" | "noise" | "unknown";
type CorrelationMode = "off" | "shadow";
type LifecycleResolution = {
  method: "provider-order-id" | "reply-link" | "inline-quote" | "none";
  status: "MATCHED" | "AMBIGUOUS" | "UNMATCHED";
  activeTradeCount: number;
  tradeId?: string;
  tradeIds?: string[];
  reason?: string;
};
type LifecycleActionState = {
  verdict: "act" | "cancel" | "noop" | "hold";
  reason: string;
};

export function evaluateLifecycleActionState(
  commandType: string,
  tradeStatus: LogicalTrade["status"] | undefined,
  opts: { closeOnProviderTp?: boolean } = {},
): LifecycleActionState {
  const status = tradeStatus === "PLANNED" ? "PENDING" : tradeStatus;
  const active = status === "OPEN" || status === "PENDING";
  if (!status) return { verdict: "hold", reason: "missing-trade" };
  if (status === "CLOSED" || status === "CANCELLED" || status === "ARCHIVED") {
    return { verdict: "noop", reason: "trade-inactive" };
  }
  if (commandType === "CANCEL_PENDING") {
    if (status === "PENDING") return { verdict: "act", reason: "cancel-pending" };
    if (status === "OPEN") return { verdict: "hold", reason: "cancel-on-open" };
    return { verdict: "hold", reason: "cancel-incompatible-state" };
  }
  if (commandType === "CLOSE_TRADE" || commandType === "CLOSE_PARTIAL") {
    if (status === "OPEN") return { verdict: "act", reason: "close-open" };
    if (status === "PENDING") {
      return commandType === "CLOSE_TRADE"
        ? { verdict: "act", reason: "flatten-pending" }
        : { verdict: "cancel", reason: "close-partial-pending" };
    }
    return { verdict: "hold", reason: "close-incompatible-state" };
  }
  if (
    commandType === "MODIFY_SL" ||
    commandType === "MODIFY_TP" ||
    commandType === "MOVE_SL_TO_BE" ||
    commandType === "TRAILING_STOP"
  ) {
    return active
      ? { verdict: "act", reason: "modify-active" }
      : { verdict: "hold", reason: "modify-incompatible-state" };
  }
  if (commandType === "MARK_TP_HIT") {
    if (!active) return { verdict: "hold", reason: "tp-hit-incompatible-state" };
    return {
      verdict: "act",
      reason: opts.closeOnProviderTp ? "tp-hit-close-opt-in" : "tp-hit-record-only",
    };
  }
  return { verdict: "hold", reason: "unsupported-lifecycle-command" };
}

/**
 * A minimal real-time delta pushed over the SSE stream. `type` names the
 * subsystem (queue, trade, snapshot, heartbeat, audit, reconciliation, score);
 * the remaining fields are an intentionally small payload, not a full snapshot.
 */
export interface AppStoreEvent {
  type: string;
  [key: string]: unknown;
}

// Telegram RPC errors that mean the session's auth key is permanently dead and
// the operator must log in again. Kept deliberately separate from transient
// network/timeout errors: those must NOT disconnect a live session, or a brief
// connectivity blip would log the operator out.
const TELEGRAM_DEAD_SESSION_ERROR_CODES = [
  "AUTH_KEY_UNREGISTERED",
  "AUTH_KEY_INVALID",
  "AUTH_KEY_DUPLICATED",
  "SESSION_REVOKED",
  "SESSION_EXPIRED",
  "USER_DEACTIVATED",
  "USER_DEACTIVATED_BAN",
];

export function isTelegramDeadSessionError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toUpperCase();
  return TELEGRAM_DEAD_SESSION_ERROR_CODES.some((code) => message.includes(code));
}

interface Mt5SnapshotState {
  positions: unknown[];
  orders: unknown[];
  symbols: unknown[];
  updatedAt: string;
}

const volatilePositionFields = new Set(["profit"]);
const volatileSymbolFields = new Set(["ask", "bid", "timeMsc"]);
const noVolatileSnapshotFields = new Set<string>();

function stableSnapshotRecords(records: unknown[], volatileFields: ReadonlySet<string>) {
  return records
    .map((record) => {
      if (!record || typeof record !== "object" || Array.isArray(record)) {
        return JSON.stringify(record);
      }
      return JSON.stringify(
        Object.fromEntries(
          Object.entries(record as Record<string, unknown>)
            .filter(([key]) => !volatileFields.has(key))
            .sort(([left], [right]) => left.localeCompare(right)),
        ),
      );
    })
    .sort();
}

function durableMt5SnapshotSignature(snapshot: Mt5SnapshotState) {
  return JSON.stringify({
    positions: stableSnapshotRecords(snapshot.positions, volatilePositionFields),
    orders: stableSnapshotRecords(snapshot.orders, noVolatileSnapshotFields),
    symbols: stableSnapshotRecords(snapshot.symbols, volatileSymbolFields),
  });
}

class AppStore {
  private readonly db: Database;
  private readonly databasePath: string;
  private readonly allowDemoData: boolean;
  // Tick-level P/L and quotes are live telemetry, not durable business events.
  // Keep the latest full snapshot in memory while SQLite stores only structural changes.
  private readonly liveMt5Snapshots = new Map<string, Mt5SnapshotState>();
  private readonly persistedMt5SnapshotSignatures = new Map<string, string>();
  // Tracks providers we've already warned about for the "no connected
  // Telegram session" state, so we log once per offline→online edge instead
  // of once per poll. Reset when a session connects.
  private readonly providersWithoutSession = new Set<string>();
  // Last known Telegram session health per session id, recorded by the capture
  // loop and surfaced in the dashboard so a silent stall is visible.
  private readonly telegramHealth = new Map<string, TelegramSessionHealth>();
  // Per-provider state is kept separately because one stalled dialog RPC must
  // not wait for another provider before becoming visible to the operator.
  private readonly telegramProviderHealth = new Map<string, TelegramProviderHealth>();
  // In-memory pub/sub for the SSE stream. Subscribers are SSE connections that
  // forward typed deltas to the dashboard so it stops polling on a timer.
  // ponytail: single-process in-memory bus. Ceiling — events do not survive a
  // restart and do not fan out across multiple API processes; the upgrade path
  // is a shared broker (Redis/Postgres LISTEN) if the API is ever scaled out.
  private readonly eventSubscribers = new Set<(event: AppStoreEvent) => void>();
  private readonly alertSentAt = new Map<string, number>();
  private deferredAlerts: DeferredAlert[] | undefined;
  private storeRevision = 0;
  private observedDataVersion: number | undefined;
  private dashboardPerformanceCache:
    | {
        revision: number;
        heartbeatStatusKey: string;
        accountPerformance: ReturnType<AppStore["accountPerformance"]>;
        accountPerformanceByAccount: Record<string, ReturnType<AppStore["accountPerformance"]>>;
        providerPerformance: ReturnType<AppStore["providerPerformance"]>;
        providerPerformanceByAccount: Record<string, ReturnType<AppStore["providerPerformance"]>>;
      }
    | undefined;
  private readonly providerScoreCache = new Map<
    string,
    {
      revision: number;
      score:
        | (ProviderScoreResult & { providerId: string; title: string; learnedPatterns: number })
        | null;
    }
  >();

  constructor(databasePath: string, allowDemoData = false) {
    this.databasePath = databasePath;
    this.allowDemoData = allowDemoData;
    if (databasePath !== ":memory:") {
      const dir = databasePath.split("/").slice(0, -1).join("/");
      if (dir) {
        Bun.spawnSync(["mkdir", "-p", dir]);
      }
    }
    this.db = new Database(databasePath);
    this.db.run("PRAGMA journal_mode = WAL");
    this.migrate();
  }

  // Thrown when the HELD source row does not transition exactly once. Escapes the transaction so
  // SQLite rolls the whole release back, then becomes a 409 instead of an unhandled 500.
  // This boundary must remain top-level: converting ReleaseConflictError to a returned 409 inside
  // an outer release transaction would let that outer transaction commit after a savepoint rollback.
  private releaseTransaction<T>(operation: () => T): T | { statusCode: 409; error: string } {
    const deferredAlerts: DeferredAlert[] = [];
    const previousDeferredAlerts = this.deferredAlerts;
    this.deferredAlerts = deferredAlerts;
    let result: T;
    try {
      result = this.db.transaction(operation)();
    } catch (error) {
      this.deferredAlerts = previousDeferredAlerts;
      if (error instanceof ReleaseConflictError) {
        return { statusCode: 409 as const, error: error.message };
      }
      throw error;
    }
    this.deferredAlerts = previousDeferredAlerts;
    for (const alert of deferredAlerts) {
      this.dispatchAlert(alert.event, alert.key, alert.text, alert.setting, alert.force);
    }
    return result;
  }

  startTelegramSession(input: { apiId: string; apiHash: string; phone: string }) {
    const profileId = `profile_${nanoid(10)}`;
    const sessionId = `tg_${nanoid(10)}`;
    const now = nowIso();
    this.db
      .query("INSERT INTO profiles (id, display_name, created_at) VALUES (?, ?, ?)")
      .run(profileId, `Telegram ${maskPhone(input.phone)}`, now);
    this.db
      .query(
        "INSERT INTO telegram_sessions (id, profile_id, phone, api_id_hint, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(sessionId, profileId, input.phone, hashHint(input.apiId), "CODE_REQUIRED", now, now);
    this.audit("telegram.start", "info", "Telegram login code requested", {
      profileId,
      phone: maskPhone(input.phone),
    });
    return { profileId, sessionId, status: "CODE_REQUIRED" as TelegramSessionStatus };
  }

  updateTelegramSession(sessionId: string, status: TelegramSessionStatus) {
    const now = nowIso();
    this.db
      .query("UPDATE telegram_sessions SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, now, sessionId);
    const session = this.db
      .query("SELECT id, profile_id, phone, status FROM telegram_sessions WHERE id = ?")
      .get(sessionId) as Row | null;
    if (!session) {
      return { error: "Session not found" };
    }
    if (status === "CONNECTED") {
      if (this.allowDemoData) this.ensureMockProvider(String(session.profile_id));
    }
    this.audit("telegram.status", "info", `Telegram session moved to ${status}`, {
      sessionId,
      status,
    });
    return {
      sessionId,
      profileId: String(session.profile_id),
      phone: maskPhone(String(session.phone)),
      status,
    };
  }

  dialogs(_profileId?: string): TelegramDialog[] {
    return demoDialogs();
  }

  providers() {
    return (
      this.db
        .query(
          "SELECT id, profile_id, dialog_id, title, kind, enabled, parser_mode, risk_profile, lot_size, provider_config_json, last_message_at, backfill_cursor_id, backfill_floor_at FROM providers ORDER BY title",
        )
        .all() as Row[]
    )
      .filter(
        (row) =>
          this.allowDemoData ||
          (String(row.profile_id) !== "profile-demo" && String(row.dialog_id) !== "dialog-alpha"),
      )
      .map((row) => {
        const config = row.provider_config_json
          ? parseJson<Partial<ProviderExecutionConfig>>(String(row.provider_config_json))
          : undefined;
        return {
          id: String(row.id),
          profileId: String(row.profile_id),
          dialogId: String(row.dialog_id),
          title: String(row.title),
          kind: String(row.kind),
          enabled: Boolean(row.enabled),
          parserMode: String(row.parser_mode),
          lockedSymbol: normalizeLockedSymbol(config?.lockedSymbol),
          tradedSymbols: normalizeTradedSymbols(config?.tradedSymbols),
          riskProfile: String(row.risk_profile),
          lotSize: Number(row.lot_size),
          riskMode: config?.riskMode,
          riskAmount: config?.riskAmount,
          takeProfitLevels:
            config && "takeProfitLevels" in config
              ? normalizeProviderTpLevels(config.takeProfitLevels)
              : undefined,
          workFromTpLeg: normalizeWorkFromTpLeg(config?.workFromTpLeg),
          runner: config?.runner,
          lastMessageAt: String(row.last_message_at),
          backfillCursorId: row.backfill_cursor_id ? String(row.backfill_cursor_id) : undefined,
          backfillFloorAt: row.backfill_floor_at ? String(row.backfill_floor_at) : undefined,
        };
      });
  }

  connectedTelegramSession(profileId?: string) {
    const row = profileId
      ? (this.db
          .query(
            "SELECT id, profile_id FROM telegram_sessions WHERE profile_id = ? AND status = 'CONNECTED' ORDER BY updated_at DESC LIMIT 1",
          )
          .get(profileId) as Row | null)
      : (this.db
          .query(
            "SELECT id, profile_id FROM telegram_sessions WHERE status = 'CONNECTED' ORDER BY updated_at DESC LIMIT 1",
          )
          .get() as Row | null);
    return row
      ? {
          id: String(row.id),
          profileId: String(row.profile_id),
        }
      : undefined;
  }

  selectProvider(input: { profileId: string; dialogId: string; title?: string }) {
    const dialog = this.dialogs(input.profileId).find((item) => item.id === input.dialogId);
    const existing = this.collapseDuplicateProvidersForDialog(input.dialogId);
    if (existing) {
      const title = input.title ?? dialog?.title ?? String(existing.title);
      const kind = dialog?.type ?? String(existing.kind);
      this.db
        .query("UPDATE providers SET profile_id = ?, title = ?, kind = ? WHERE id = ?")
        .run(input.profileId, title, kind, String(existing.id));
      this.audit("provider.rebind", "info", "Provider bound to Telegram session profile", {
        providerId: String(existing.id),
        dialogId: input.dialogId,
        fromProfileId: String(existing.profile_id),
        toProfileId: input.profileId,
      });
      return { provider: this.providers().find((provider) => provider.id === String(existing.id)) };
    }
    const id =
      input.dialogId === "dialog-alpha"
        ? demoProviderId
        : `provider_${hashHint(input.dialogId).replace(/^api_/, "")}`;
    const now = nowIso();
    this.db
      .query(
        "INSERT OR IGNORE INTO providers (id, profile_id, dialog_id, title, kind, enabled, parser_mode, risk_profile, lot_size, last_message_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        input.profileId,
        input.dialogId,
        input.title ?? dialog?.title ?? input.dialogId,
        dialog?.type ?? "channel",
        0,
        "automatic",
        "balanced",
        defaultAppSettings.defaultLotSize,
        now,
      );
    return { provider: this.providers().find((provider) => provider.id === id) };
  }

  resyncProvidersToTelegramSession(input: { profileId: string; dialogs: TelegramDialog[] }) {
    const dialogMap = new Map(input.dialogs.map((dialog) => [dialog.id, dialog]));
    const rebound: Array<{ providerId: string; fromProfileId: string; toProfileId: string }> = [];
    let alreadyCurrent = 0;
    for (const dialog of dialogMap.values()) {
      const provider = this.collapseDuplicateProvidersForDialog(dialog.id);
      if (!provider) continue;
      const fromProfileId = String(provider.profile_id);
      this.db
        .query("UPDATE providers SET profile_id = ?, title = ?, kind = ? WHERE id = ?")
        .run(input.profileId, dialog.title, dialog.type, String(provider.id));
      if (fromProfileId === input.profileId) {
        alreadyCurrent += 1;
      } else {
        rebound.push({
          providerId: String(provider.id),
          fromProfileId,
          toProfileId: input.profileId,
        });
      }
    }
    const stillOffline = this.providers()
      .filter(
        (provider) =>
          provider.enabled &&
          !dialogMap.has(provider.dialogId) &&
          !this.connectedSessionIdForProfile(provider.profileId),
      )
      .map((provider) => ({
        providerId: provider.id,
        dialogId: provider.dialogId,
        title: provider.title,
      }));
    this.audit("provider.resync", "info", "Providers resynced against Telegram session dialogs", {
      profileId: input.profileId,
      dialogsSeen: input.dialogs.length,
      rebound: rebound.length,
      alreadyCurrent,
      stillOffline: stillOffline.length,
    });
    return {
      profileId: input.profileId,
      dialogsSeen: input.dialogs.length,
      rebound,
      alreadyCurrent,
      stillOffline,
      providers: this.providers(),
    };
  }

  updateProvider(
    id: string,
    input: {
      enabled?: boolean;
      parserMode?: string;
      lockedSymbol?: string | null;
      tradedSymbols?: string[] | null;
      shorthandLevels?: boolean;
      riskProfile?: string;
      lotSize?: number;
      riskMode?: "fixed" | "percent";
      riskAmount?: number;
      openEvidence?: ExecutionEvidenceProviderConfig["openEvidence"];
      takeProfitLevels?: ProviderTakeProfitLevelInput[] | null;
      workFromTpLeg?: number;
      runner?: { enabled: boolean; lotSize: number; slBehavior: string; trailPips: number };
    },
  ) {
    const current = this.providers().find((provider) => provider.id === id);
    if (!current) return { error: "Provider not found" };
    this.db
      .query(
        "UPDATE providers SET enabled = ?, parser_mode = ?, risk_profile = ?, lot_size = ? WHERE id = ?",
      )
      .run(
        input.enabled === undefined ? Number(current.enabled) : Number(input.enabled),
        input.parserMode ?? current.parserMode,
        input.riskProfile ?? current.riskProfile,
        positiveNumber(input.lotSize, current.lotSize),
        id,
      );
    const hasProviderConfigPatch =
      "lockedSymbol" in input ||
      "tradedSymbols" in input ||
      "shorthandLevels" in input ||
      input.openEvidence !== undefined ||
      input.riskMode !== undefined ||
      input.riskAmount !== undefined ||
      "takeProfitLevels" in input ||
      "workFromTpLeg" in input ||
      input.runner !== undefined;
    if (hasProviderConfigPatch) {
      const existingConfig = this.providerConfig(id);
      this.saveProviderConfig(id, {
        riskMode: input.riskMode ?? existingConfig.riskMode,
        riskAmount: positiveNumber(input.riskAmount, existingConfig.riskAmount),
        openEvidence: input.openEvidence ?? existingConfig.openEvidence,
        takeProfitLevels:
          "takeProfitLevels" in input
            ? normalizeProviderTpLevels(input.takeProfitLevels)
            : existingConfig.takeProfitLevels,
        workFromTpLeg:
          "workFromTpLeg" in input
            ? normalizeWorkFromTpLeg(input.workFromTpLeg)
            : existingConfig.workFromTpLeg,
        runner: input.runner === undefined ? existingConfig.runner : input.runner,
        lockedSymbol:
          "lockedSymbol" in input
            ? normalizeLockedSymbol(input.lockedSymbol)
            : existingConfig.lockedSymbol,
        tradedSymbols:
          "tradedSymbols" in input
            ? normalizeTradedSymbols(input.tradedSymbols)
            : existingConfig.tradedSymbols,
        shorthandLevels:
          "shorthandLevels" in input
            ? Boolean(input.shorthandLevels)
            : existingConfig.shorthandLevels,
      });
    }
    this.audit("provider.update", "info", "Provider settings updated", {
      providerId: id,
      ...input,
    });
    return { provider: this.providers().find((provider) => provider.id === id) };
  }

  providerConfig(providerId: string, accountId?: string): ProviderExecutionConfig {
    const provider = this.providerDetails(providerId);
    const fallbackAmount = provider?.lotSize ?? defaultAppSettings.defaultLotSize;
    const row = this.db
      .query("SELECT provider_config_json FROM providers WHERE id = ?")
      .get(providerId) as Row | null;
    const config = row?.provider_config_json
      ? parseJson<Partial<ProviderExecutionConfig>>(String(row.provider_config_json))
      : {};
    const providerTitle = provider?.title.toLowerCase() ?? "";
    const openEvidence =
      config.openEvidence === "structured-id" || config.openEvidence === "prose-complete"
        ? config.openEvidence
        : providerId === "provider_15k9j3v" || providerTitle.includes("vip gold")
          ? "structured-id"
          : providerId === "provider_1gfxfwd" || providerTitle.includes("kal")
            ? "prose-complete"
            : "prose-complete";
    const providerLevelConfig: ProviderExecutionConfig = {
      openEvidence,
      parserMode: normalizeParserMode(provider?.parserMode),
      lockedSymbol: normalizeLockedSymbol(config.lockedSymbol),
      tradedSymbols: normalizeTradedSymbols(config.tradedSymbols),
      shorthandLevels: config.shorthandLevels === true,
      riskMode: config.riskMode === "percent" ? "percent" : "fixed",
      riskAmount: positiveNumber(config.riskAmount, fallbackAmount),
      takeProfitLevels: normalizeProviderTpLevels(config.takeProfitLevels),
      workFromTpLeg: normalizeWorkFromTpLeg(config.workFromTpLeg),
      runner: config.runner,
    };
    // Per-account override takes precedence; NULL config_json (or no link row) inherits
    // the provider-level execution defaults below. Parser mode and symbol lock remain
    // provider-owned so an account override cannot silently widen the parser surface.
    if (accountId) {
      const linkRow = this.db
        .query(
          "SELECT config_json FROM account_provider_links WHERE account_id = ? AND provider_id = ?",
        )
        .get(accountId, providerId) as Row | null;
      if (linkRow?.config_json) {
        const override = parseJson<Partial<ProviderExecutionConfig>>(String(linkRow.config_json));
        return {
          openEvidence: providerLevelConfig.openEvidence,
          parserMode: providerLevelConfig.parserMode,
          lockedSymbol: providerLevelConfig.lockedSymbol,
          tradedSymbols: providerLevelConfig.tradedSymbols,
          shorthandLevels: providerLevelConfig.shorthandLevels,
          riskMode: override.riskMode === "percent" ? "percent" : "fixed",
          riskAmount: positiveNumber(override.riskAmount, fallbackAmount),
          takeProfitLevels: normalizeProviderTpLevels(override.takeProfitLevels),
          workFromTpLeg: normalizeWorkFromTpLeg(override.workFromTpLeg),
          runner: override.runner,
        };
      }
    }
    return providerLevelConfig;
  }

  providerConfigHistory(providerId: string) {
    return (
      this.db
        .query(
          "SELECT id, provider_id, config_json, created_at FROM provider_config_history WHERE provider_id = ? ORDER BY created_at DESC",
        )
        .all(providerId) as Row[]
    ).map((row) => ({
      id: String(row.id),
      providerId: String(row.provider_id),
      config: parseJson<ProviderExecutionConfig>(String(row.config_json)),
      createdAt: String(row.created_at),
    }));
  }

  testProviderConfig(
    providerId: string,
    input: { rawText: string; accountId?: string; config?: Partial<ProviderExecutionConfig> },
  ) {
    const accountId = input.accountId ?? this.defaultParserAccountId(providerId);
    const currentConfig = this.providerConfig(providerId, accountId);
    const config: ProviderExecutionConfig = input.config
      ? {
          parserMode: input.config.parserMode ?? currentConfig.parserMode,
          lockedSymbol:
            "lockedSymbol" in input.config
              ? normalizeLockedSymbol(input.config.lockedSymbol)
              : currentConfig.lockedSymbol,
          tradedSymbols:
            "tradedSymbols" in input.config
              ? normalizeTradedSymbols(input.config.tradedSymbols)
              : currentConfig.tradedSymbols,
          shorthandLevels:
            "shorthandLevels" in input.config
              ? Boolean(input.config.shorthandLevels)
              : currentConfig.shorthandLevels,
          riskMode: input.config.riskMode === "percent" ? "percent" : currentConfig.riskMode,
          riskAmount: positiveNumber(input.config.riskAmount, currentConfig.riskAmount),
          takeProfitLevels:
            "takeProfitLevels" in input.config
              ? normalizeProviderTpLevels(input.config.takeProfitLevels)
              : currentConfig.takeProfitLevels,
          workFromTpLeg:
            "workFromTpLeg" in input.config
              ? normalizeWorkFromTpLeg(input.config.workFromTpLeg)
              : currentConfig.workFromTpLeg,
          runner: input.config.runner === undefined ? currentConfig.runner : input.config.runner,
        }
      : currentConfig;
    const context = this.parserContext(providerId, accountId, config);
    const parsedSignals = parseSignalTexts(input.rawText, context);
    const settings = this.appSettings();
    const applyConfig = (signal: ParsedSignal) =>
      applyProviderExecutionConfig(signal, config, {
        defaultTakeProfit: { value: settings.defaultTakeProfitPips, unit: "PIPS" },
      });
    const results = parsedSignals.map(applyConfig);
    return {
      providerId,
      accountId,
      parsed: results[0],
      results,
      signalCount: results.length,
      config,
    };
  }

  private saveProviderConfig(
    providerId: string,
    config: ProviderExecutionConfig,
    accountId?: string,
  ) {
    const normalizedConfig: ProviderExecutionConfig = {
      ...config,
      lockedSymbol: normalizeLockedSymbol(config.lockedSymbol),
      tradedSymbols: normalizeTradedSymbols(config.tradedSymbols),
    };
    const now = new Date().toISOString();
    if (accountId) {
      // Per-account override stored on the link row. Preserves the existing `enabled`
      // copy flag (a fresh row defaults to disabled — the Copy toggle owns that flag).
      this.db
        .query(
          "INSERT INTO account_provider_links (account_id, provider_id, enabled, updated_at, config_json) VALUES (?, ?, 0, ?, ?) ON CONFLICT(account_id, provider_id) DO UPDATE SET config_json = excluded.config_json, updated_at = excluded.updated_at",
        )
        .run(accountId, providerId, now, JSON.stringify(normalizedConfig));
      this.audit("provider.config.update", "info", "Per-account provider config updated", {
        providerId,
        accountId,
        config: normalizedConfig,
      });
      return;
    }
    this.db
      .query("UPDATE providers SET provider_config_json = ? WHERE id = ?")
      .run(JSON.stringify(normalizedConfig), providerId);
    this.db
      .query(
        "INSERT INTO provider_config_history (id, provider_id, config_json, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(`provider_config_${nanoid(10)}`, providerId, JSON.stringify(normalizedConfig), now);
    this.audit("provider.config.update", "info", "Provider execution config updated", {
      providerId,
      config: normalizedConfig,
    });
  }

  /**
   * Normalize + persist a per-account provider config override (lot/risk/TP/runner),
   * inheriting any unspecified field from the currently-resolved config for this account.
   * Mirrors the config-patch logic in {@link updateProvider} but writes to the link row.
   */
  updateAccountProviderConfig(
    accountId: string,
    providerId: string,
    input: {
      lotSize?: number;
      riskMode?: "fixed" | "percent";
      riskAmount?: number;
      takeProfitLevels?: ProviderTakeProfitLevelInput[] | null;
      workFromTpLeg?: number;
      runner?: { enabled: boolean; lotSize: number; slBehavior: string; trailPips: number };
    },
  ) {
    const existing = this.providerConfig(providerId, accountId);
    this.saveProviderConfig(
      providerId,
      {
        riskMode: input.riskMode ?? existing.riskMode,
        riskAmount: positiveNumber(input.riskAmount ?? input.lotSize, existing.riskAmount),
        takeProfitLevels:
          "takeProfitLevels" in input
            ? normalizeProviderTpLevels(input.takeProfitLevels)
            : existing.takeProfitLevels,
        workFromTpLeg:
          "workFromTpLeg" in input
            ? normalizeWorkFromTpLeg(input.workFromTpLeg)
            : existing.workFromTpLeg,
        runner: input.runner === undefined ? existing.runner : input.runner,
      },
      accountId,
    );
    return this.providerConfig(providerId, accountId);
  }

  providerDetails(providerId: string) {
    return this.providers().find((provider) => provider.id === providerId);
  }

  deleteProvider(providerId: string) {
    const provider = this.providerDetails(providerId);
    if (!provider) return { error: "Provider not found" };
    this.db.query("DELETE FROM providers WHERE id = ?").run(providerId);
    this.audit("provider.delete", "warn", "Provider removed", {
      providerId,
      title: provider.title,
    });
    return { providerId, status: "DELETED" };
  }

  // Hard-delete an MT5 account and every row scoped to it. account_slots is
  // freed (unlinked) rather than dropped so the provisioning link code can be
  // reused. Wrapped in a transaction so a failure can't leave half the rows.
  deleteMt5Account(accountId: string) {
    const account = this.mt5Accounts().find((item) => item.id === accountId);
    if (!account) return { error: "Account not found" };
    const accountScopedTables = [
      "queue_items",
      "logical_trades",
      "account_provider_links",
      "equity_guardians",
      "account_symbol_mappings",
      "mt5_snapshots",
      "equity_curve_points",
      "equity_curve_state",
      "drawdown_events",
      "execution_reports",
      "broker_orders",
      "external_closes",
    ];
    const now = new Date().toISOString();
    const removeAll = this.db.transaction(() => {
      for (const table of accountScopedTables) {
        this.db.query(`DELETE FROM ${table} WHERE account_id = ?`).run(accountId);
      }
      this.db
        .query(
          "UPDATE account_slots SET status = ?, account_id = '', updated_at = ? WHERE account_id = ?",
        )
        .run("waiting", now, accountId);
      this.db.query("DELETE FROM mt5_accounts WHERE id = ?").run(accountId);
    });
    removeAll();
    this.audit("mt5-account.delete", "warn", "MT5 account hard-deleted", {
      accountId,
      accountNumber: account.accountNumber,
      server: account.server,
    });
    return { accountId, status: "DELETED" };
  }

  connectedSessionIdForProfile(profileId: string) {
    return this.connectedTelegramSession(profileId)?.id;
  }

  private providerRowsForDialog(dialogId: string) {
    return this.db
      .query(
        "SELECT id, profile_id, dialog_id, title, kind, enabled, parser_mode, risk_profile, lot_size, provider_config_json, last_message_at, backfill_cursor_id, backfill_floor_at FROM providers WHERE dialog_id = ? ORDER BY id",
      )
      .all(dialogId) as Row[];
  }

  private providerRowById(providerId: string) {
    return this.db
      .query(
        "SELECT id, profile_id, dialog_id, title, kind, enabled, parser_mode, risk_profile, lot_size, provider_config_json, last_message_at, backfill_cursor_id, backfill_floor_at FROM providers WHERE id = ?",
      )
      .get(providerId) as Row | null;
  }

  private collapseDuplicateProvidersForDialog(dialogId: string) {
    const rows = this.providerRowsForDialog(dialogId);
    if (rows.length <= 1) return rows[0];
    const [canonical, ...duplicates] = [...rows].sort(
      (left, right) => this.providerMergeScore(right) - this.providerMergeScore(left),
    );
    if (!canonical) return undefined;
    for (const duplicate of duplicates) {
      this.mergeProviderInto(String(canonical.id), duplicate);
    }
    return this.providerRowById(String(canonical.id)) ?? canonical;
  }

  private providerMergeScore(row: Row) {
    const providerId = String(row.id);
    const count = (table: string) =>
      Number(
        (
          this.db
            .query(`SELECT COUNT(*) AS count FROM ${table} WHERE provider_id = ?`)
            .get(providerId) as Row | null
        )?.count ?? 0,
      );
    const hasConfig = !isEmptyJsonObject(String(row.provider_config_json ?? "{}"));
    return (
      count("raw_messages") * 1000 +
      count("parsed_signals") * 500 +
      count("logical_trades") * 250 +
      count("account_provider_links") * 100 +
      count("symbol_aliases") * 50 +
      (hasConfig ? 25 : 0) +
      (Number(row.enabled) ? 10 : 0)
    );
  }

  private mergeProviderInto(canonicalProviderId: string, duplicate: Row) {
    const duplicateProviderId = String(duplicate.id);
    if (canonicalProviderId === duplicateProviderId) return;
    const canonical = this.providerRowById(canonicalProviderId);
    if (!canonical) return;
    const canonicalConfig = String(canonical.provider_config_json ?? "{}");
    const duplicateConfig = String(duplicate.provider_config_json ?? "{}");
    const mergedEnabled = Number(Boolean(canonical.enabled) || Boolean(duplicate.enabled));
    const mergedLastMessageAt =
      String(duplicate.last_message_at) > String(canonical.last_message_at)
        ? String(duplicate.last_message_at)
        : String(canonical.last_message_at);
    // Carry any unfinished backlog across the collapse. Dropping the duplicate
    // row with a cursor still on it would strand the messages it was there to
    // fetch. Keep the oldest floor and the newest resume point, so the surviving
    // row drains the union of both outstanding windows.
    const mergedCursor =
      pickNewerOffsetId(canonical.backfill_cursor_id, duplicate.backfill_cursor_id) ?? null;
    const mergedFloorAt =
      pickOlderIso(canonical.backfill_floor_at, duplicate.backfill_floor_at) ?? null;
    this.db
      .query(
        "UPDATE providers SET enabled = ?, last_message_at = ?, backfill_cursor_id = ?, backfill_floor_at = ? WHERE id = ?",
      )
      .run(mergedEnabled, mergedLastMessageAt, mergedCursor, mergedFloorAt, canonicalProviderId);
    if (isEmptyJsonObject(canonicalConfig) && !isEmptyJsonObject(duplicateConfig)) {
      this.db
        .query(
          "UPDATE providers SET parser_mode = ?, risk_profile = ?, lot_size = ?, provider_config_json = ? WHERE id = ?",
        )
        .run(
          String(duplicate.parser_mode),
          String(duplicate.risk_profile),
          Number(duplicate.lot_size),
          duplicateConfig,
          canonicalProviderId,
        );
    }

    this.db
      .query("UPDATE raw_messages SET provider_id = ? WHERE provider_id = ?")
      .run(canonicalProviderId, duplicateProviderId);
    this.db
      .query("UPDATE parsed_signals SET provider_id = ? WHERE provider_id = ?")
      .run(canonicalProviderId, duplicateProviderId);
    this.db
      .query("UPDATE logical_trades SET provider_id = ? WHERE provider_id = ?")
      .run(canonicalProviderId, duplicateProviderId);
    this.db
      .query("UPDATE provider_config_history SET provider_id = ? WHERE provider_id = ?")
      .run(canonicalProviderId, duplicateProviderId);

    const duplicateLinks = this.db
      .query(
        "SELECT account_id, enabled, config_json FROM account_provider_links WHERE provider_id = ?",
      )
      .all(duplicateProviderId) as Row[];
    const now = new Date().toISOString();
    for (const link of duplicateLinks) {
      const existing = this.db
        .query(
          "SELECT enabled, config_json FROM account_provider_links WHERE account_id = ? AND provider_id = ?",
        )
        .get(String(link.account_id), canonicalProviderId) as Row | null;
      const duplicateConfig = link.config_json ? String(link.config_json) : null;
      if (existing) {
        this.db
          .query(
            "UPDATE account_provider_links SET enabled = ?, updated_at = ?, config_json = COALESCE(config_json, ?) WHERE account_id = ? AND provider_id = ?",
          )
          .run(
            Number(Boolean(existing.enabled) || Boolean(link.enabled)),
            now,
            duplicateConfig,
            String(link.account_id),
            canonicalProviderId,
          );
      } else {
        this.db
          .query(
            "INSERT INTO account_provider_links (account_id, provider_id, enabled, updated_at, config_json) VALUES (?, ?, ?, ?, ?)",
          )
          .run(
            String(link.account_id),
            canonicalProviderId,
            Number(link.enabled),
            now,
            duplicateConfig,
          );
      }
    }
    this.db
      .query("DELETE FROM account_provider_links WHERE provider_id = ?")
      .run(duplicateProviderId);

    const duplicateAliases = this.db
      .query(
        "SELECT raw_symbol, canonical_symbol, updated_at FROM symbol_aliases WHERE scope = 'provider' AND provider_id = ?",
      )
      .all(duplicateProviderId) as Row[];
    for (const alias of duplicateAliases) {
      this.db
        .query(
          `INSERT INTO symbol_aliases (scope, provider_id, raw_symbol, canonical_symbol, updated_at)
           VALUES ('provider', ?, ?, ?, ?)
           ON CONFLICT(scope, provider_id, raw_symbol) DO NOTHING`,
        )
        .run(
          canonicalProviderId,
          String(alias.raw_symbol),
          String(alias.canonical_symbol),
          String(alias.updated_at),
        );
    }
    this.db
      .query("DELETE FROM symbol_aliases WHERE scope = 'provider' AND provider_id = ?")
      .run(duplicateProviderId);
    this.db.query("DELETE FROM providers WHERE id = ?").run(duplicateProviderId);
    this.audit("provider.merge", "info", "Duplicate provider row merged by Telegram dialog", {
      providerId: canonicalProviderId,
      duplicateProviderId,
      dialogId: String(duplicate.dialog_id),
    });
  }

  recentMessages(providerId: string, limit: number, seedIfEmpty = true) {
    if (seedIfEmpty) {
      this.ensureMessages(providerId);
    }
    return (
      this.db
        .query(
          "SELECT id, provider_id, telegram_message_id, message_date, raw_text, fingerprint, classification FROM raw_messages WHERE provider_id = ? ORDER BY message_date DESC LIMIT ?",
        )
        .all(providerId, limit) as Row[]
    ).map((row) => ({
      id: String(row.id),
      providerId: String(row.provider_id),
      telegramMessageId: String(row.telegram_message_id),
      messageDate: String(row.message_date),
      rawText: String(row.raw_text),
      fingerprint: String(row.fingerprint),
      classification: String(row.classification),
    }));
  }

  detectedSymbols(providerId: string, messages: TelegramCapturedMessage[]) {
    const context = this.parserContext(providerId, this.defaultParserAccountId(providerId));
    const counts = new Map<string, number>();
    for (const message of messages) {
      for (const signal of parseSignalTexts(
        this.telegramParserText(providerId, message),
        context,
      )) {
        if (signal.commandType !== "OPEN_TRADE" || !signal.canonicalSymbol) continue;
        counts.set(signal.canonicalSymbol, (counts.get(signal.canonicalSymbol) ?? 0) + 1);
      }
    }
    return [...counts]
      .map(([symbol, count]) => ({ symbol, count }))
      .sort((left, right) => right.count - left.count || left.symbol.localeCompare(right.symbol));
  }

  classifyMessage(messageId: string, classification: RawMessageClassification) {
    if (!isRawMessageClassification(classification)) {
      return { error: "Unsupported message classification" };
    }
    const row = this.rawMessage(messageId);
    if (!row) {
      return { error: "Raw message not found" };
    }
    this.db
      .query("UPDATE raw_messages SET classification = ? WHERE id = ?")
      .run(classification, messageId);
    return {
      message: {
        ...row,
        classification,
      },
    };
  }

  /** Per-provider correlation window in seconds (0 disables). Default 30s. */
  private correlationWindowSeconds(providerId: string): number {
    const row = this.db
      .query("SELECT provider_config_json FROM providers WHERE id = ?")
      .get(providerId) as Row | null;
    if (!row) return 30;
    const config =
      parseJson<{ correlationWindowSeconds?: number }>(String(row.provider_config_json)) ?? {};
    const value = Number(config.correlationWindowSeconds);
    return Number.isFinite(value) && value >= 0 ? value : 30;
  }

  private correlationMode(providerId: string): CorrelationMode {
    const row = this.db
      .query("SELECT provider_config_json FROM providers WHERE id = ?")
      .get(providerId) as Row | null;
    if (!row) return "off";
    const config = parseJson<{ correlationMode?: string }>(String(row.provider_config_json)) ?? {};
    return config.correlationMode === "shadow" ? "shadow" : "off";
  }

  private resolveLifecycleTarget(
    providerId: string,
    accountId: string,
    lifecycleRawMessageId: string,
    command: ParsedSignal,
  ): LifecycleResolution {
    const providerOrderCandidates = command.providerOrderId
      ? this.logicalTrades().filter(
          (trade) =>
            trade.accountId === accountId &&
            trade.providerId === providerId &&
            trade.providerOrderId === command.providerOrderId &&
            (command.canonicalSymbol && trade.symbol.canonicalSymbol
              ? trade.symbol.canonicalSymbol === command.canonicalSymbol
              : !command.brokerSymbol ||
                !trade.symbol.brokerSymbol ||
                trade.symbol.brokerSymbol === command.brokerSymbol) &&
            (trade.status === "OPEN" || trade.status === "PENDING" || trade.status === "PLANNED"),
        )
      : [];
    if (providerOrderCandidates.length === 1) {
      return {
        method: "provider-order-id",
        status: "MATCHED",
        activeTradeCount: 1,
        tradeId: providerOrderCandidates[0]!.id,
      };
    }
    if (providerOrderCandidates.length > 1) {
      return {
        method: "provider-order-id",
        status: "AMBIGUOUS",
        activeTradeCount: providerOrderCandidates.length,
        tradeIds: providerOrderCandidates.map((trade) => trade.id),
        reason: "Multiple active logical trades share this provider order id",
      };
    }
    const lifecycle = this.db
      .query("SELECT reply_to_message_id FROM raw_messages WHERE id = ? AND provider_id = ?")
      .get(lifecycleRawMessageId, providerId) as Row | null;
    const replyToMessageId = lifecycle?.reply_to_message_id
      ? String(lifecycle.reply_to_message_id)
      : "";
    if (replyToMessageId) {
      const visited = new Set<string>();
      let telegramMessageId = replyToMessageId;
      for (let depth = 0; depth < 12; depth += 1) {
        if (visited.has(telegramMessageId)) {
          return {
            method: "reply-link",
            status: "UNMATCHED",
            activeTradeCount: 0,
            reason: "cycle",
          };
        }
        visited.add(telegramMessageId);
        const origins = this.db
          .query(
            "SELECT logical_trade_id FROM trade_origins WHERE provider_id = ? AND account_id = ? AND telegram_message_id = ?",
          )
          .all(providerId, accountId, telegramMessageId) as Row[];
        const tradeIds = [...new Set(origins.map((origin) => String(origin.logical_trade_id)))];
        if (tradeIds.length > 1) {
          return {
            method: "reply-link",
            status: "AMBIGUOUS",
            activeTradeCount: tradeIds.filter((id) => this.isActiveLogicalTrade(id)).length,
            tradeIds,
            reason: "multiple-origins",
          };
        }
        if (tradeIds.length === 1) {
          const trade = this.logicalTrade(tradeIds[0]!);
          if (trade && this.isActiveLogicalTrade(trade.id)) {
            return {
              method: "reply-link",
              status: "MATCHED",
              activeTradeCount: 1,
              tradeId: tradeIds[0],
            };
          }
          return {
            method: "reply-link",
            status: "UNMATCHED",
            activeTradeCount: 0,
            reason: "inactive-origin",
          };
        }
        const alias = this.db
          .query(
            `SELECT raw_messages.reply_to_message_id
             FROM raw_message_aliases
             JOIN raw_messages ON raw_messages.id = raw_message_aliases.raw_message_id
             WHERE raw_message_aliases.provider_id = ?
               AND raw_message_aliases.telegram_message_id = ?
               AND raw_messages.provider_id = ?`,
          )
          .get(providerId, telegramMessageId, providerId) as Row | null;
        if (!alias) {
          return {
            method: "reply-link",
            status: "UNMATCHED",
            activeTradeCount: 0,
            reason: "gap-in-graph",
          };
        }
        if (!alias.reply_to_message_id) {
          return {
            method: "reply-link",
            status: "UNMATCHED",
            activeTradeCount: 0,
            reason: "chain-ended-no-origin",
          };
        }
        telegramMessageId = String(alias.reply_to_message_id);
      }
      return {
        method: "reply-link",
        status: "UNMATCHED",
        activeTradeCount: 0,
        reason: "chain-too-deep",
      };
    }

    const inlineQuote = this.inlineQuotedSignal(lifecycleRawMessageId);
    if (inlineQuote) {
      const inlineFingerprint = createMessageFingerprint(inlineQuote);
      const origins = this.db
        .query(
          `SELECT DISTINCT trade_origins.logical_trade_id
           FROM raw_messages
           JOIN trade_origins
             ON trade_origins.provider_id = raw_messages.provider_id
            AND trade_origins.telegram_message_id = raw_messages.telegram_message_id
           WHERE raw_messages.provider_id = ?
             AND raw_messages.fingerprint = ?
             AND trade_origins.account_id = ?`,
        )
        .all(providerId, inlineFingerprint, accountId) as Row[];
      const tradeIds = [...new Set(origins.map((origin) => String(origin.logical_trade_id)))];
      const activeTradeIds = tradeIds.filter((id) => this.isActiveLogicalTrade(id));
      if (tradeIds.length === 0) {
        return {
          method: "inline-quote",
          status: "UNMATCHED",
          activeTradeCount: 0,
          reason: "no-origin-fingerprint",
        };
      }
      if (tradeIds.length !== 1) {
        return {
          method: "inline-quote",
          status: "AMBIGUOUS",
          activeTradeCount: activeTradeIds.length,
          tradeIds,
          reason: "multiple-origin-fingerprints",
        };
      }
      if (activeTradeIds.length === 1) {
        return {
          method: "inline-quote",
          status: "MATCHED",
          activeTradeCount: 1,
          tradeId: activeTradeIds[0],
        };
      }
      return {
        method: "inline-quote",
        status: "UNMATCHED",
        activeTradeCount: 0,
        reason: "inactive-origin",
      };
    }

    return { method: "none", status: "UNMATCHED", activeTradeCount: 0, reason: "no-evidence" };
  }

  private inlineQuotedSignal(rawMessageId: string) {
    const row = this.db
      .query("SELECT raw_text FROM raw_messages WHERE id = ?")
      .get(rawMessageId) as Row | null;
    const rawText = row?.raw_text ? String(row.raw_text) : "";
    return rawText
      .match(/^Quoted signal:\s*([\s\S]*?)(?:\n\nComment:|\s+---\s+Comment:)/i)?.[1]
      ?.trim();
  }

  private isActiveLogicalTrade(tradeId: string) {
    const status = this.logicalTrade(tradeId)?.status;
    return status === "OPEN" || status === "PENDING" || status === "PLANNED";
  }

  private shadowLifecycleCorrelation(
    providerId: string,
    parsedSignalId: string,
    signal: ParsedSignal,
  ) {
    const raw = this.db
      .query(
        `SELECT parsed_signals.raw_message_id, raw_messages.reply_to_message_id
         FROM parsed_signals
         JOIN raw_messages ON raw_messages.id = parsed_signals.raw_message_id
         WHERE parsed_signals.id = ? AND parsed_signals.provider_id = ?`,
      )
      .get(parsedSignalId, providerId) as Row | null;
    if (!raw?.raw_message_id) throw new Error("Lifecycle parsed signal has no raw message");
    const targetAccountIds = this.targetAccountIdsForProvider(
      providerId,
      signal.accountId ?? this.defaultParserAccountId(providerId),
    );
    const settings = this.appSettings();
    const defaultTakeProfit = { value: settings.defaultTakeProfitPips, unit: "PIPS" as const };
    const accounts = targetAccountIds.map((accountId) => {
      const config = this.providerConfig(providerId, accountId);
      const targetSignal = applyProviderExecutionConfig(
        accountId === signal.accountId
          ? signal
          : this.reparseSignalForAccount(signal, providerId, accountId),
        config,
        { defaultTakeProfit },
      );
      const legacy = matchLifecycleCommandToTrade(
        targetSignal,
        this.logicalTrades().filter((trade) => trade.accountId === accountId),
      );
      const resolved = this.resolveLifecycleTarget(
        providerId,
        accountId,
        String(raw.raw_message_id),
        targetSignal,
      );
      const resolvedTrade = resolved.tradeId ? this.logicalTrade(resolved.tradeId) : undefined;
      return {
        accountId,
        legacy,
        resolved,
        actionState: evaluateLifecycleActionState(targetSignal.commandType, resolvedTrade?.status),
        agreement: resolved.tradeId === legacy.tradeId,
      };
    });
    this.audit("correlation.shadow", "info", "Lifecycle correlation shadow result", {
      providerId,
      parsedSignalId,
      commandType: signal.commandType,
      replyToMessageId: raw.reply_to_message_id ? String(raw.reply_to_message_id) : undefined,
      accounts,
    });
  }

  private rawMessageAliasOwner(providerId: string, telegramMessageId: string) {
    const row = this.db
      .query(
        "SELECT raw_message_id FROM raw_message_aliases WHERE provider_id = ? AND telegram_message_id = ?",
      )
      .get(providerId, telegramMessageId) as Row | null;
    if (!row) return undefined;
    const owner = String(row.raw_message_id);
    return owner === `raw_${providerId}_${telegramMessageId}` ? undefined : owner;
  }

  captureMessages(providerId: string, messages: TelegramCapturedMessage[]) {
    const before = this.rawMessageCount(providerId);
    // Correlate same-sender follow-up fragments into their directional anchor so
    // a "BUY GOLD" + "SL 2290 TP 2320" pair parses as one complete signal. For a
    // lone message this is a no-op (group of one), so existing behaviour is kept.
    // ponytail: correlation only spans a single capture batch; if the anchor and
    // its fragment arrive in separate polls they are stored separately. Upgrade
    // path is correlating against recently stored raw_messages.
    const windowSeconds = this.correlationWindowSeconds(providerId);
    const groups =
      windowSeconds > 0
        ? correlateMessages(messages, windowSeconds)
        : messages.map((message) => ({
            ...message,
            correlatedMessageIds: [message.telegramMessageId],
          }));
    for (const group of groups) {
      // A message already folded into another group's anchor must not come back
      // as a row of its own. Splitting one poll into a live and a backfill pass
      // can put an anchor and its fragment in different batches, and the primary
      // key only covers the anchor id, so a "TP1 HIT" fragment stored under its
      // anchor would re-insert standalone and parse as an executable lifecycle
      // command. The alias table is what records that folding.
      if (this.rawMessageAliasOwner(providerId, group.telegramMessageId)) continue;
      const parserText = this.telegramParserText(providerId, group);
      const context = this.parserContext(providerId, this.defaultParserAccountId(providerId));
      const parsed = parseSignalText(parserText, context);
      const parsedSignals = parseSignalTexts(parserText, context);
      this.db
        .query(
          `INSERT INTO raw_messages (id, provider_id, telegram_message_id, reply_to_message_id, message_date, raw_text, fingerprint, classification, forwarded_from, forward_date)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO NOTHING`,
        )
        .run(
          `raw_${providerId}_${group.telegramMessageId}`,
          providerId,
          group.telegramMessageId,
          group.replyToMessageId ?? null,
          group.messageDate,
          parserText,
          parsed.fingerprint,
          parsedSignals.some((signal) => signal.commandType === "OPEN_TRADE")
            ? "entry"
            : classifyParsedCommand(parsed.commandType),
          rawForwardedFrom(group),
          group.forwardedDate ?? null,
        );
      const rawMessageId = `raw_${providerId}_${group.telegramMessageId}`;
      for (const telegramMessageId of group.correlatedMessageIds) {
        this.db
          .query(
            "INSERT INTO raw_message_aliases (provider_id, telegram_message_id, raw_message_id) VALUES (?, ?, ?) ON CONFLICT(provider_id, telegram_message_id) DO NOTHING",
          )
          .run(providerId, telegramMessageId, rawMessageId);
      }
    }
    const after = this.rawMessageCount(providerId);
    if (messages.length > 0) {
      const latest = messages
        .map((message) => message.messageDate)
        .sort()
        .at(-1);
      if (latest) {
        this.db
          .query("UPDATE providers SET last_message_at = ? WHERE id = ? AND last_message_at < ?")
          .run(latest, providerId, latest);
      }
    }
    return { captured: messages.length, inserted: after - before, total: after };
  }

  async ingestEnabledProviders(
    telegram: TelegramAdapter,
    limit = 50,
    rpcTimeoutMs = telegramRpcTimeoutMs(),
  ): Promise<TelegramIngestionResult> {
    const providers = this.providers().filter((provider) => provider.enabled);
    const results = await Promise.all(
      providers.map((provider) => this.ingestProvider(telegram, provider, limit, rpcTimeoutMs)),
    );
    return results.reduce(
      (total, result) => ({
        providers: total.providers + result.providers,
        captured: total.captured + result.captured,
        inserted: total.inserted + result.inserted,
        parsed: total.parsed + result.parsed,
        queued: total.queued + result.queued,
        reviewRequired: total.reviewRequired + result.reviewRequired,
        errors: total.errors + result.errors,
      }),
      {
        providers: 0,
        captured: 0,
        inserted: 0,
        parsed: 0,
        queued: 0,
        reviewRequired: 0,
        errors: 0,
      },
    );
  }

  private async ingestProvider(
    telegram: TelegramAdapter,
    provider: TelegramProvider,
    limit: number,
    rpcTimeoutMs: number,
  ): Promise<TelegramIngestionResult> {
    const result: TelegramIngestionResult = {
      providers: 1,
      captured: 0,
      inserted: 0,
      parsed: 0,
      queued: 0,
      reviewRequired: 0,
      errors: 0,
    };
    const sessionId = this.connectedSessionIdForProfile(provider.profileId);
    if (!sessionId) {
      if (!this.providersWithoutSession.has(provider.id)) {
        this.providersWithoutSession.add(provider.id);
        this.audit(
          "telegram.ingest.skip",
          "warn",
          "Enabled provider has no connected Telegram session",
          {
            providerId: provider.id,
          },
        );
        log("warn", "telegram.ingest.skip", { providerId: provider.id });
      }
      return result;
    }

    this.providersWithoutSession.delete(provider.id);
    let recordedHealth = false;
    try {
      const startedAt = Date.now();
      const originalLastMessageAt = provider.lastMessageAt;
      const captured: TelegramCapturedMessage[] = [];
      // The floor is the watermark as it stood when the outstanding backlog
      // opened, and it is what the backfill drains down to. It cannot be the
      // current watermark: the live pass advances that to the newest message it
      // just captured, so a backfill resuming on a later poll would find its
      // very first older message already past the cutoff, stop immediately,
      // report no gap, and have its cursor cleared with the backlog untouched.
      //
      // An existing floor always predates a new one, so a second outage keeps
      // the older floor and takes the newer resume point. Walking back from the
      // newer cursor to the older floor covers both windows; the already
      // captured middle re-inserts idempotently.
      const recordGap = (gap: TelegramFetchGap, openedFrom: string) => {
        const resumeOffsetId = gap.resumeOffsetId;
        if (resumeOffsetId) {
          this.db
            .query(
              "UPDATE providers SET backfill_cursor_id = ?, backfill_floor_at = COALESCE(backfill_floor_at, ?) WHERE id = ?",
            )
            .run(resumeOffsetId, openedFrom, provider.id);
        }
        this.audit(
          "telegram.ingest.gap",
          resumeOffsetId ? "warn" : "error",
          "Telegram backlog drain was truncated",
          {
            providerId: provider.id,
            fromIso: gap.fromIso,
            toIso: gap.toIso,
            reason: gap.reason,
            resumeOffsetId,
          },
        );
      };
      const capturePass = (messages: TelegramCapturedMessage[]) => {
        const captureResult = this.captureMessages(provider.id, messages);
        result.captured += captureResult.captured;
        result.inserted += captureResult.inserted;
        captured.push(...messages);
      };
      // Each pass gets a share of the poll as its own drain budget, but the
      // timeout wrapped around it stays the full configured value. The drain
      // has to be what stops the drain: if the race fires first it rejects a
      // pass that was about to return its partial batch, and everything
      // captured is discarded because it only persists once the fetch resolves.
      // The outer timeout is left as the backstop for a genuinely hung RPC.
      const liveBudgetMs = Math.floor(rpcTimeoutMs / 2);
      const live = await withTelegramRpcTimeout(
        telegram.fetchRecentMessages(sessionId, provider.dialogId, limit, {
          dateFrom: originalLastMessageAt,
          budgetMs: liveBudgetMs,
        }),
        rpcTimeoutMs,
      );
      capturePass(live.messages);
      if (live.gap) recordGap(live.gap, originalLastMessageAt);

      const cursor = live.gap?.resumeOffsetId ?? provider.backfillCursorId;
      const floor = provider.backfillFloorAt ?? originalLastMessageAt;
      const remainingBudgetMs = rpcTimeoutMs - (Date.now() - startedAt);
      if (cursor && remainingBudgetMs > 0) {
        const backfill = await withTelegramRpcTimeout(
          telegram.fetchRecentMessages(sessionId, provider.dialogId, limit, {
            dateFrom: floor,
            offsetId: cursor,
            budgetMs: remainingBudgetMs,
          }),
          rpcTimeoutMs,
        );
        capturePass(backfill.messages);
        if (backfill.gap) {
          recordGap(backfill.gap, floor);
        } else {
          this.db
            .query(
              "UPDATE providers SET backfill_cursor_id = NULL, backfill_floor_at = NULL WHERE id = ?",
            )
            .run(provider.id);
          this.audit(
            "telegram.ingest.backfill-complete",
            "info",
            "Telegram backlog drain completed",
            {
              providerId: provider.id,
            },
          );
        }
      }
      const parsed = this.parseUnparsedProviderMessages(
        provider.id,
        Math.max(limit, captured.length),
        this.defaultParserAccountId(provider.id),
      );
      result.parsed += parsed.length;
      for (const item of parsed) {
        const tradedSymbolHoldReason = this.tradedSymbolHoldReason(provider.id, item.result);
        if (tradedSymbolHoldReason) {
          this.holdSignalForTradedSymbol(item.parsedSignalId, item.result, tradedSymbolHoldReason);
          result.reviewRequired += 1;
          continue;
        }
        if (item.reviewRequired) result.reviewRequired += 1;
        if (
          item.result.commandType !== "OPEN_TRADE" &&
          item.result.commandType !== "NO_SIGNAL" &&
          item.result.commandType !== "TRADE_SETUP"
        ) {
          try {
            if (this.correlationMode(provider.id) === "shadow") {
              this.shadowLifecycleCorrelation(provider.id, item.parsedSignalId, item.result);
            }
          } catch (error) {
            this.audit("correlation.shadow-error", "error", "Lifecycle correlation shadow failed", {
              providerId: provider.id,
              parsedSignalId: item.parsedSignalId,
              commandType: item.result.commandType,
              error: error instanceof Error ? error.message : "Unknown correlation shadow error",
            });
          }
        }
        const approval = this.approveSignal(item.parsedSignalId, { trigger: "ingest" });
        if ("body" in approval) {
          if (approval.body.status === "PENDING") {
            result.queued +=
              approval.body.queuedCount ??
              approval.body.queueItems?.length ??
              (approval.body.queueItemId ? 1 : 0);
          }
        } else if (approval.statusCode !== 409) {
          result.errors += 1;
          const lifecycleCommand =
            item.result.commandType !== "OPEN_TRADE" &&
            item.result.commandType !== "NO_SIGNAL" &&
            item.result.commandType !== "TRADE_SETUP";
          this.audit(
            "telegram.ingest.queue-failed",
            lifecycleCommand ? "error" : "warn",
            approval.error,
            {
              providerId: provider.id,
              parsedSignalId: item.parsedSignalId,
            },
          );
          if (lifecycleCommand) {
            this.dispatchAlert(
              "lifecycle-dropped",
              item.parsedSignalId,
              `Telegram TC dropped ${item.result.commandType} for provider ${provider.id}: ${approval.error}`,
              "alertOnDroppedLifecycle",
            );
          }
          if (isUnmatchedLifecycleError(approval.error)) {
            const linked = this.linkDroppedLifecycle(provider.id, item.parsedSignalId, item.result);
            if (linked > 0) {
              this.audit(
                "telegram.ingest.lifecycle-dropped",
                "warn",
                "Linked dropped lifecycle command to held open trade",
                {
                  providerId: provider.id,
                  parsedSignalId: item.parsedSignalId,
                  commandType: item.result.commandType,
                  linked,
                },
              );
            }
          }
        }
      }
    } catch (error) {
      result.errors += 1;
      this.audit(
        "telegram.ingest.error",
        error instanceof TelegramRpcTimeoutError ? "warn" : "error",
        "Telegram provider ingestion failed",
        {
          providerId: provider.id,
          error: error instanceof Error ? error.message : "Unknown ingestion error",
        },
      );
      this.recordProviderHealth(telegram, provider, sessionId, error);
      recordedHealth = true;
      // A revoked/expired GramJS auth key keeps the DB row CONNECTED forever
      // (gramjs just retries the dead key), so reconcile it without letting a
      // stuck disconnect hold the provider health record or the ingestion pass.
      if (isTelegramDeadSessionError(error)) {
        await this.reconcileDeadTelegramSession(telegram, sessionId, error, rpcTimeoutMs);
      }
    } finally {
      if (!recordedHealth) this.recordProviderHealth(telegram, provider, sessionId);
    }
    return result;
  }

  private linkDroppedLifecycle(providerId: string, parsedSignalId: string, signal: ParsedSignal) {
    const raw = this.db
      .query("SELECT raw_message_id FROM parsed_signals WHERE id = ?")
      .get(parsedSignalId) as Row | null;
    if (!raw?.raw_message_id) return 0;
    const rows = this.db
      .query(
        `SELECT queue_items.id, queue_items.payload_json
         FROM queue_items
         JOIN parsed_signals ON parsed_signals.id = queue_items.parsed_signal_id
         WHERE queue_items.status = 'HELD'
           AND parsed_signals.provider_id = ?
           AND json_extract(queue_items.payload_json, '$.commandType') = 'OPEN_TRADE'`,
      )
      .all(providerId) as Row[];
    const lifecycleSymbols = [signal.brokerSymbol, signal.canonicalSymbol, signal.rawSymbol]
      .map((value) => normalizeLockedSymbol(value))
      .filter((value): value is string => Boolean(value));
    let linked = 0;
    for (const row of rows) {
      const payload = parseJson<ExecutionQueueItem["payload"]>(String(row.payload_json));
      const heldSymbols = [payload.brokerSymbol, payload.canonicalSymbol]
        .map((value) => normalizeLockedSymbol(value))
        .filter((value): value is string => Boolean(value));
      if (
        lifecycleSymbols.length > 0 &&
        !lifecycleSymbols.some((symbol) => heldSymbols.includes(symbol))
      ) {
        continue;
      }
      const inserted = this.db
        .query(
          `INSERT OR IGNORE INTO held_lifecycle_drops
            (id, held_queue_item_id, raw_message_id, command_type, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          `held_drop_${nanoid(10)}`,
          String(row.id),
          String(raw.raw_message_id),
          signal.commandType,
          nowIso(),
        );
      if (inserted.changes > 0) linked += 1;
    }
    return linked;
  }

  // A GramJS session's auth key can be revoked server-side (logged out from
  // another device, session expired, account deactivated). GramJS surfaces it
  // as AUTH_KEY_UNREGISTERED on the next RPC and then retries the dead key
  // forever, but nothing flips the DB row off CONNECTED — so telegramStatus()
  // keeps reporting connected:true and the login form stays hidden. Drop the
  // dead client and mark the row DISCONNECTED so re-login becomes possible.
  private async reconcileDeadTelegramSession(
    telegram: TelegramAdapter,
    sessionId: string,
    error: unknown,
    rpcTimeoutMs: number,
  ) {
    const current = this.db
      .query("SELECT status FROM telegram_sessions WHERE id = ?")
      .get(sessionId) as Row | null;
    if (!current || String(current.status) === "DISCONNECTED") return;
    // disconnect() also removes the dead session file, so reconnect attempts
    // stop and the file can't be re-imported on next boot.
    await withTelegramRpcTimeout(telegram.disconnect(sessionId), rpcTimeoutMs).catch(
      () => undefined,
    );
    this.updateTelegramSession(sessionId, "DISCONNECTED");
    this.audit(
      "telegram.session.dead",
      "error",
      "Telegram session auth key is dead — operator must re-login",
      { sessionId, error: error instanceof Error ? error.message : String(error) },
    );
  }

  private recordTelegramHealth(telegram: TelegramAdapter, sessionIds: Set<string>) {
    if (!telegram.sessionHealth) return;
    for (const sessionId of sessionIds) {
      const health = telegram.sessionHealth(sessionId);
      const previous = this.telegramHealth.get(sessionId);
      this.telegramHealth.set(sessionId, health);
      // Log the healthy->stalled and stalled->recovered edges once each so the
      // condition lands in the audit log, not only the live snapshot.
      if (health.stalled && !previous?.stalled) {
        this.audit("telegram.session.stalled", "error", "Telegram session stalled", {
          sessionId,
          lastContactAt: health.lastContactAt,
          stalledSeconds: health.stalledSeconds,
        });
        this.dispatchAlert(
          "telegram-stalled",
          sessionId,
          `Telegram ingestion stalled for session ${sessionId}.`,
          "alertOnTelegramStall",
        );
      } else if (!health.stalled && previous?.stalled) {
        this.audit("telegram.session.recovered", "info", "Telegram session recovered", {
          sessionId,
        });
      }
    }
  }

  private recordProviderHealth(
    telegram: TelegramAdapter,
    provider: TelegramProvider,
    sessionId: string,
    error?: unknown,
  ) {
    const sessionHealth = telegram.sessionHealth?.(sessionId);
    const timeout = error instanceof TelegramRpcTimeoutError;
    const previous = this.telegramProviderHealth.get(provider.id);
    const consecutiveFailures = error ? (previous?.consecutiveFailures ?? 0) + 1 : 0;
    const stalled =
      Boolean(sessionHealth?.stalled) ||
      (timeout && consecutiveFailures >= TELEGRAM_PROVIDER_STALL_FAILURES);
    const healthy = !error && !sessionHealth?.stalled;
    const health: TelegramProviderHealth = {
      providerId: provider.id,
      sessionId,
      healthy,
      stalled,
      consecutiveFailures,
      checkedAt: nowIso(),
      error: error instanceof Error ? error.message : error ? String(error) : undefined,
    };
    this.telegramProviderHealth.set(provider.id, health);
    this.recordTelegramHealth(telegram, new Set([sessionId]));
    if (stalled && !previous?.stalled) {
      this.audit("telegram.provider.stalled", "error", "Telegram provider ingestion stalled", {
        providerId: provider.id,
        sessionId,
        error: health.error,
      });
      this.dispatchAlert(
        "telegram-provider-stalled",
        provider.id,
        `Telegram ingestion stalled for provider ${provider.title}.`,
        "alertOnTelegramStall",
      );
    } else if (healthy && previous?.stalled) {
      this.audit("telegram.provider.recovered", "info", "Telegram provider ingestion recovered", {
        providerId: provider.id,
        sessionId,
      });
    }
  }

  telegramSessionHealth(): TelegramSessionHealth[] {
    return [...this.telegramHealth.values()];
  }

  telegramProviderHealthSnapshot(): TelegramProviderHealth[] {
    return [...this.telegramProviderHealth.values()];
  }

  // Operational conditions that silently block trading and should be shown
  // prominently in the UI: a latched Equity Guardian rejecting every signal,
  // or a Telegram session that has stopped receiving updates.
  operationalAlerts() {
    const alerts: Array<{
      kind:
        | "guardian-paused"
        | "telegram-stalled"
        | "telegram-provider-stalled"
        | "unmapped-symbols"
        | "provider-health";
      severity: "warn" | "error";
      message: string;
      accountId?: string;
      detail?: Record<string, unknown>;
    }> = [];
    for (const guardian of this.equityGuardians()) {
      if (!guardian.paused) continue;
      const lastBreach = guardian.breaches.at(-1) as { at?: string; drawdown?: number } | undefined;
      alerts.push({
        kind: "guardian-paused",
        severity: "error",
        message: `Equity Guardian paused for account ${
          guardian.accountNumber || guardian.accountId
        } — OPEN_TRADE signals are being rejected`,
        accountId: guardian.accountId,
        detail: {
          threshold: guardian.threshold,
          breachedAt: lastBreach?.at,
          drawdown: lastBreach?.drawdown,
        },
      });
      this.dispatchAlert(
        "guardian-paused",
        guardian.accountId,
        `Equity Guardian paused for account ${guardian.accountNumber || guardian.accountId}.`,
        "alertOnGuardianPause",
      );
    }
    for (const account of this.mt5Accounts()) {
      const lastHeartbeat = Date.parse(account.lastHeartbeatAt);
      if (
        Number.isFinite(lastHeartbeat) &&
        Date.now() - lastHeartbeat > EA_HEARTBEAT_SECONDS * 3 * 1000
      ) {
        this.dispatchAlert(
          "ea-offline",
          account.id,
          `EA offline for account ${account.accountNumber || account.id}.`,
          "alertOnEaOffline",
        );
      }
    }
    for (const health of this.telegramSessionHealth()) {
      if (!health.stalled) continue;
      alerts.push({
        kind: "telegram-stalled",
        severity: "error",
        message:
          "Telegram session is not receiving updates — incoming signals may be delayed or missed",
        detail: {
          sessionId: health.sessionId,
          lastContactAt: health.lastContactAt,
          stalledSeconds: health.stalledSeconds,
        },
      });
    }
    for (const health of this.telegramProviderHealthSnapshot()) {
      if (!health.stalled) continue;
      const provider = this.providerDetails(health.providerId);
      if (!provider?.enabled) continue;
      alerts.push({
        kind: "telegram-provider-stalled",
        severity: "error",
        message: `Telegram provider ${provider?.title ?? health.providerId} is stalled — incoming signals may be delayed or missed`,
        detail: { ...health },
      });
    }
    for (const item of this.unmappedProviderSymbolAlerts()) {
      alerts.push({
        kind: "unmapped-symbols",
        severity: "warn",
        message: `${item.rawSymbol} is unmapped for ${item.accountLabel} and is blocking ${item.blockedSignalCount} ${item.blockedSignalCount === 1 ? "signal" : "signals"}.`,
        accountId: item.accountId,
        detail: item,
      });
    }
    // Provider health: surface providers whose rolling win rate has turned red.
    for (const provider of this.providers()) {
      const score = this.providerScore(provider.id, false);
      if (!score) continue;
      const breach = providerScoreAlert(provider.title, score);
      if (!breach) continue;
      alerts.push({
        kind: "provider-health",
        severity: "warn",
        message: breach.message,
        detail: { providerId: provider.id, winRate: breach.winRate, badge: score.badge },
      });
    }
    return alerts;
  }

  /**
   * Symbols the operator's PROVIDERS have actually posted that do not currently
   * resolve to a broker symbol — the actionable "configure a mapping" set.
   * Deliberately NOT driven by the EA's reported instrument catalog: a broker
   * advertises hundreds/thousands of CFDs the operator will never trade, so
   * alerting on those is pure noise. Re-resolves against current mappings so the
   * alert clears once the symbol is mapped.
   * ponytail: re-resolves recent signals on each dashboard build. Ceiling —
   * O(distinct provider symbols); upgrade path is caching resolution per symbol.
   */
  providerSymbolsNeedingMapping(): string[] {
    return [...new Set(this.unmappedProviderSymbolAlerts().map((item) => item.rawSymbol))].slice(
      0,
      12,
    );
  }

  suppressProviderSymbol(providerId: string, token: unknown) {
    const provider = this.providerDetails(providerId);
    const rawToken = typeof token === "string" ? token.trim() : "";
    const tokenKey = rawToken.replace(/[^a-z0-9]/gi, "").toUpperCase();
    if (!provider) return { statusCode: 404 as const, error: "Provider not found" };
    if (!tokenKey) return { statusCode: 400 as const, error: "token is required" };
    const normalizedToken = rawToken.toUpperCase();
    this.db
      .query(
        `INSERT OR IGNORE INTO suppressed_provider_symbols (provider_id, token, token_key, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(providerId, normalizedToken, tokenKey, new Date().toISOString());
    this.audit(
      "provider-symbol.suppress",
      "info",
      "Provider symbol marked as not an instrument",
      {
        providerId,
        token: normalizedToken,
      },
      "operator",
    );
    return { providerId, token: normalizedToken, status: "SUPPRESSED" as const };
  }

  private unmappedProviderSymbolAlerts() {
    const rows = this.db
      .query(
        `SELECT parsed_signals.id, parsed_signals.provider_id, parsed_signals.result_json, parsed_signals.status,
                EXISTS (
                  SELECT 1 FROM queue_items
                  WHERE queue_items.parsed_signal_id = parsed_signals.id
                    AND queue_items.status = 'HELD'
                    AND queue_items.held_reason LIKE 'SYMBOL_MAPPING_%'
                ) AS has_current_mapping_hold
         FROM parsed_signals
         ORDER BY parsed_signals.created_at DESC
         LIMIT 300`,
      )
      .all() as Row[];
    const accounts = new Map(this.mt5Accounts().map((account) => [account.id, account]));
    const providers = new Map(this.providers().map((provider) => [provider.id, provider]));
    const currentMappingHoldAccounts = new Set(
      (
        this.db
          .query(
            `SELECT parsed_signal_id, account_id FROM queue_items
             WHERE status = 'HELD' AND held_reason LIKE 'SYMBOL_MAPPING_%'`,
          )
          .all() as Row[]
      ).map((row) => `${String(row.parsed_signal_id)}:${String(row.account_id)}`),
    );
    const suppressed = new Set(
      (
        this.db
          .query("SELECT provider_id, token_key FROM suppressed_provider_symbols")
          .all() as Row[]
      ).map((row) => `${row.provider_id}:${row.token_key}`),
    );
    const contexts = new Map<string, ParserContext>();
    const quotedByAccount = new Map<string, Set<string>>();
    const contextFor = (providerId: string, accountId: string) => {
      const key = `${providerId}:${accountId}`;
      let context = contexts.get(key);
      if (!context) {
        context = this.parserContext(providerId, accountId);
        contexts.set(key, context);
      }
      return context;
    };
    const quotedFor = (accountId: string) => {
      let quoted = quotedByAccount.get(accountId);
      if (!quoted) {
        quoted = new Set(
          this.symbolMetadata(accountId)
            .filter(
              (item) => item.bid !== null && item.ask !== null && item.bid > 0 && item.ask > 0,
            )
            .map((item) => item.symbol.toUpperCase()),
        );
        quotedByAccount.set(accountId, quoted);
      }
      return quoted;
    };
    const grouped = new Map<
      string,
      {
        kind: "unmapped-symbols";
        token: string;
        rawSymbol: string;
        canonicalSymbol: string;
        providerId: string;
        providerTitle: string;
        accountId: string;
        accountLabel: string;
        blockedSignalCount: number;
        suggestedBrokerSymbol?: string;
      }
    >();
    for (const row of rows) {
      const signal = parseJson<ParsedSignal>(String(row.result_json));
      const actionable = String(row.status) === "PARSED";
      const hasCurrentMappingHold = Boolean(row.has_current_mapping_hold);
      if (
        !signal ||
        signal.commandType !== "OPEN_TRADE" ||
        !signal.rawSymbol ||
        (!actionable && !hasCurrentMappingHold)
      )
        continue;
      const providerId = String(row.provider_id);
      const tokenKey = signal.rawSymbol.replace(/[^a-z0-9]/gi, "").toUpperCase();
      if (suppressed.has(`${providerId}:${tokenKey}`)) continue;
      const targets = this.targetAccountIdsForProvider(
        providerId,
        signal.accountId ?? this.defaultParserAccountId(providerId),
      );
      for (const accountId of targets) {
        if (!actionable && !currentMappingHoldAccounts.has(`${String(row.id)}:${accountId}`))
          continue;
        const context = contextFor(providerId, accountId);
        const resolved = resolveSymbol(signal.rawSymbol, context);
        if (resolved.mappingStatus === "mapped") continue;
        const account = accounts.get(accountId);
        const provider = providers.get(providerId);
        const key = `${providerId}:${signal.rawSymbol.replace(/[^a-z0-9]/gi, "").toUpperCase()}:${accountId}`;
        const current = grouped.get(key);
        if (current) {
          current.blockedSignalCount += 1;
          continue;
        }
        grouped.set(key, {
          kind: "unmapped-symbols",
          token: signal.rawSymbol,
          rawSymbol: signal.rawSymbol,
          canonicalSymbol: resolved.canonicalSymbol ?? signal.canonicalSymbol ?? signal.rawSymbol,
          providerId,
          providerTitle: provider?.title ?? providerId,
          accountId,
          accountLabel: account?.accountNumber || accountId,
          blockedSignalCount: 1,
          suggestedBrokerSymbol: account
            ? rankBrokerSymbols(
                account.availableSymbols ?? [],
                resolved.canonicalSymbol ?? signal.rawSymbol,
                quotedFor(accountId),
              )[0]
            : undefined,
        });
      }
    }
    return [...grouped.values()].slice(0, 12);
  }

  /** Broker symbol metadata with current quote status when the EA has reported it. */
  symbolMetadata(accountId: string) {
    const rows = (
      this.db
        .query(
          "SELECT symbol, point, digits, pip_size, updated_at FROM symbol_metadata WHERE account_id = ? ORDER BY symbol",
        )
        .all(accountId) as Row[]
    ).map((row) => ({
      symbol: String(row.symbol),
      point: nullableNumber(row.point) ?? null,
      digits: nullableNumber(row.digits) ?? null,
      pipSize: nullableNumber(row.pip_size) ?? null,
      updatedAt: String(row.updated_at),
    }));
    const live = this.liveMt5Snapshots.get(accountId)?.symbols ?? [];
    const liveBySymbol = new Map(
      live
        .filter((item): item is Record<string, unknown> =>
          Boolean(item && typeof item === "object"),
        )
        .map((item) => [String(item.symbol ?? "").toUpperCase(), item]),
    );
    return [...new Set([...rows.map((row) => row.symbol), ...liveBySymbol.keys()])]
      .sort()
      .map((symbol) => {
        const row = rows.find((item) => item.symbol === symbol);
        const quote = liveBySymbol.get(symbol.toUpperCase());
        return {
          symbol,
          point: row?.point ?? nullableNumber(quote?.point) ?? null,
          digits: row?.digits ?? nullableNumber(quote?.digits) ?? null,
          pipSize: row?.pipSize ?? null,
          bid: nullableNumber(quote?.bid) ?? null,
          ask: nullableNumber(quote?.ask) ?? null,
          updatedAt: row?.updatedAt ?? this.liveMt5Snapshots.get(accountId)?.updatedAt ?? "",
        };
      });
  }

  private persistSymbolMetadata(accountId: string, symbols: unknown[]) {
    const now = new Date().toISOString();
    for (const entry of symbols) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      const symbol = typeof record.symbol === "string" ? record.symbol : null;
      if (!symbol) continue;
      const point = nullableNumber(record.point);
      const digits = nullableNumber(record.digits);
      // 3/5-digit FX/metals quote in fractional pips, so a pip is 10 points.
      const pipSize =
        point !== undefined ? (digits === 3 || digits === 5 ? point * 10 : point) : undefined;
      this.db
        .query(
          `INSERT INTO symbol_metadata (account_id, symbol, point, digits, pip_size, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(account_id, symbol) DO UPDATE SET
             point = COALESCE(excluded.point, symbol_metadata.point),
             digits = COALESCE(excluded.digits, symbol_metadata.digits),
             pip_size = COALESCE(excluded.pip_size, symbol_metadata.pip_size),
             updated_at = excluded.updated_at`,
        )
        .run(accountId, symbol, point ?? null, digits ?? null, pipSize ?? null, now);
    }
  }

  backtestProviderMessages(
    providerId: string,
    input: { accountId?: string; dateFrom?: string; dateTo?: string } = {},
  ) {
    const accountId = input.accountId ?? this.defaultParserAccountId(providerId);
    const aggressive =
      normalizeParserMode(this.providerConfig(providerId).parserMode) === "aggressive";
    const rows = this.rawMessagesForBacktest(providerId, input);
    const commandCounts: Record<string, number> = {};
    const mappingStatusCounts: Record<string, number> = {};
    const missingFieldCounts: Record<string, number> = {};
    const reviewReasonCounts: Record<string, number> = {};
    const patternCounts: Record<string, number> = {};
    const warningCounts: Record<string, number> = {};
    const examples: Array<{
      telegramMessageId: string;
      messageDate: string;
      commandType: string;
      confidence: number;
      reviewRequired: boolean;
      missingFields: string[];
      warnings: string[];
      rawText: string;
    }> = [];
    let reviewRequired = 0;
    let actionableMessages = 0;
    let actionableReviewRequired = 0;
    let openSignals = 0;
    let lifecycleCommands = 0;

    for (const row of rows) {
      const parsed = parseSignalText(
        String(row.raw_text),
        this.parserContext(providerId, accountId),
      );
      commandCounts[parsed.commandType] = (commandCounts[parsed.commandType] ?? 0) + 1;
      mappingStatusCounts[parsed.mappingStatus] =
        (mappingStatusCounts[parsed.mappingStatus] ?? 0) + 1;
      for (const field of parsed.missingFields) {
        missingFieldCounts[field] = (missingFieldCounts[field] ?? 0) + 1;
      }
      for (const pattern of parsed.matchedPatternIds) {
        patternCounts[pattern] = (patternCounts[pattern] ?? 0) + 1;
      }
      for (const warning of parsed.warnings) {
        warningCounts[warning] = (warningCounts[warning] ?? 0) + 1;
      }
      if (parsed.commandType === "OPEN_TRADE") openSignals += 1;
      else if (parsed.commandType !== "NO_SIGNAL") lifecycleCommands += 1;
      if (parsed.commandType !== "NO_SIGNAL") actionableMessages += 1;
      const needsReview = shouldRequireManualReview(parsed, aggressive);
      if (needsReview) reviewRequired += 1;
      if (needsReview && parsed.commandType !== "NO_SIGNAL") actionableReviewRequired += 1;
      if (needsReview && parsed.commandType !== "NO_SIGNAL") {
        for (const reason of reviewReasons(parsed)) {
          reviewReasonCounts[reason] = (reviewReasonCounts[reason] ?? 0) + 1;
        }
      }
      if (
        parsed.commandType !== "NO_SIGNAL" &&
        (needsReview || parsed.warnings.length > 0) &&
        examples.length < 25
      ) {
        examples.push({
          telegramMessageId: String(row.telegram_message_id),
          messageDate: String(row.message_date),
          commandType: parsed.commandType,
          confidence: parsed.confidence,
          reviewRequired: needsReview,
          missingFields: parsed.missingFields,
          warnings: parsed.warnings,
          rawText: String(row.raw_text),
        });
      }
    }

    return {
      providerId,
      accountId,
      totalMessages: rows.length,
      openSignals,
      lifecycleCommands,
      actionableMessages,
      autoActionableMessages: actionableMessages - actionableReviewRequired,
      reviewRequired,
      reviewRate: rows.length ? Number((reviewRequired / rows.length).toFixed(4)) : 0,
      actionableReviewRequired,
      actionableReviewRate: actionableMessages
        ? Number((actionableReviewRequired / actionableMessages).toFixed(4))
        : 0,
      commandCounts,
      mappingStatusCounts,
      missingFieldCounts,
      reviewReasonCounts,
      patternCounts,
      warningCounts,
      examples,
    };
  }

  parseProviderMessage(providerId: string, rawText: string, accountId?: string) {
    const targetAccountId = accountId ?? this.defaultParserAccountId(providerId);
    const rawMessageId = `raw_${nanoid(10)}`;
    const telegramMessageId = `manual-${Date.now()}`;
    const now = new Date().toISOString();
    const context = this.parserContext(providerId, targetAccountId);
    const firstResult = parseSignalText(rawText, context);
    const results = parseSignalTexts(rawText, context);
    this.db
      .query(
        "INSERT INTO raw_messages (id, provider_id, telegram_message_id, reply_to_message_id, message_date, raw_text, fingerprint, classification, forwarded_from, forward_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        rawMessageId,
        providerId,
        telegramMessageId,
        null,
        now,
        rawText,
        firstResult.fingerprint,
        "unknown",
        null,
        null,
      );
    this.db
      .query(
        "INSERT INTO raw_message_aliases (provider_id, telegram_message_id, raw_message_id) VALUES (?, ?, ?) ON CONFLICT(provider_id, telegram_message_id) DO NOTHING",
      )
      .run(providerId, telegramMessageId, rawMessageId);
    const parsedSignals = this.insertParsedSignalRows({
      providerId,
      rawMessageId,
      results,
      createdAt: now,
    });
    const first = parsedSignals[0]!;
    return {
      parsedSignalId: first.parsedSignalId,
      parsedSignalIds: parsedSignals.map((signal) => signal.parsedSignalId),
      reviewRequired: first.reviewRequired,
      result: first.result,
      results: parsedSignals.map((signal) => signal.result),
    };
  }

  parseRecentProviderMessages(providerId: string, limit: number, accountId?: string) {
    this.recentMessages(providerId, limit);
    return this.parseUnparsedProviderMessages(
      providerId,
      limit,
      accountId ?? this.defaultParserAccountId(providerId),
      true,
    );
  }

  parsedSignals(limit?: number) {
    const rows = (
      this.db
        .query(
          `SELECT parsed_signals.id, parsed_signals.provider_id, parsed_signals.raw_message_id, raw_messages.classification,
            parsed_signals.result_json, parsed_signals.review_required, parsed_signals.status, parsed_signals.created_at
           FROM parsed_signals
           LEFT JOIN raw_messages ON raw_messages.id = parsed_signals.raw_message_id
           ORDER BY parsed_signals.created_at DESC`,
        )
        .all() as Row[]
    ).slice(0, limit);
    const ids = rows.map((row) => String(row.id));
    const heldReasons = new Map<string, string>();
    if (ids.length > 0) {
      const placeholders = ids.map(() => "?").join(", ");
      const heldRows = this.db
        .query(
          `SELECT parsed_signal_id, held_reason FROM queue_items
           WHERE parsed_signal_id IN (${placeholders})
           ORDER BY parsed_signal_id, created_at DESC`,
        )
        .all(...ids) as Row[];
      for (const row of heldRows) {
        const id = String(row.parsed_signal_id);
        if (!heldReasons.has(id)) heldReasons.set(id, String(row.held_reason ?? ""));
      }
    }
    return rows.map((row) => ({
      id: String(row.id),
      providerId: String(row.provider_id),
      rawMessageId: String(row.raw_message_id),
      classification: String(row.classification ?? "unknown"),
      result: parseJson<ParsedSignal>(String(row.result_json)),
      reviewRequired: Boolean(row.review_required),
      status: String(row.status),
      heldReason: heldReasons.get(String(row.id)) ?? "",
      createdAt: String(row.created_at),
    }));
  }

  private sourceForParsedSignal(
    parsedSignalId: string,
    signal: ParsedSignal,
  ): TradeSource | undefined {
    const row = this.db
      .query(
        `SELECT parsed_signals.raw_message_id, raw_messages.telegram_message_id,
                raw_messages.message_date, raw_messages.raw_text
         FROM parsed_signals
         LEFT JOIN raw_messages ON raw_messages.id = parsed_signals.raw_message_id
         WHERE parsed_signals.id = ?`,
      )
      .get(parsedSignalId) as Row | null;
    if (!row?.raw_message_id) return undefined;
    return {
      parsedSignalId,
      rawMessageId: String(row.raw_message_id),
      telegramMessageId: String(row.telegram_message_id ?? ""),
      messageDate: String(row.message_date ?? ""),
      rawText: String(row.raw_text ?? signal.originalText),
    };
  }

  approveSignal(
    parsedSignalId: string,
    options: {
      executionMode?: ExecutionMode;
      trigger?: "ingest" | "operator";
      targetAccountId?: string;
      releasingQueueItemId?: string;
    } = {},
  ):
    | {
        statusCode?: 200;
        body: {
          queueItemId?: string;
          logicalTradeId?: string;
          queueItems?: string[];
          heldQueueItems?: string[];
          logicalTradeIds?: string[];
          queuedCount?: number;
          fanoutCount?: number;
          status: string;
        };
      }
    | { statusCode: 409 | 422; error: string } {
    const existing = this.db
      .query("SELECT id, status, account_id FROM queue_items WHERE parsed_signal_id = ?")
      .all(parsedSignalId) as Row[];
    const releasingQueueItemId = options.releasingQueueItemId;
    const releasingRow = releasingQueueItemId
      ? existing.find((item) => String(item.id) === releasingQueueItemId)
      : undefined;
    // The evidence gate holds one row per linked account, all sharing this parsed signal, and a
    // release is always scoped to a single account. Sibling accounts own their own rows, so a
    // release must judge only its own account or releasing the second account would 409 on the
    // first account's freshly queued row. Same-account rows still block unless already terminal:
    // that is the real double-approval this guard exists for.
    const blocking = existing.filter((item) => {
      if (String(item.id) === releasingQueueItemId) return false;
      if (!releasingRow) return true;
      if (String(item.account_id ?? "") !== String(releasingRow.account_id ?? "")) return false;
      const status = String(item.status ?? "");
      return status !== "DISMISSED" && status !== "IGNORED";
    });
    if (blocking.length > 0) {
      return { statusCode: 409, error: "Signal has already been approved or queued" };
    }

    const row = this.db
      .query("SELECT provider_id, result_json FROM parsed_signals WHERE id = ?")
      .get(parsedSignalId) as Row | null;
    if (!row) {
      return { statusCode: 422, error: "Parsed signal not found" };
    }
    const signal = parseJson<ParsedSignal>(String(row.result_json));
    const source = this.sourceForParsedSignal(parsedSignalId, signal);
    const providerId = String(row.provider_id);
    const tradedSymbolHoldReason = this.tradedSymbolHoldReason(providerId, signal);
    if (tradedSymbolHoldReason) {
      return { statusCode: 422, error: tradedSymbolHoldReason };
    }
    const linkedAccountIds = this.targetAccountIdsForProvider(
      providerId,
      signal.accountId ?? this.defaultParserAccountId(providerId),
    );
    const targetAccountIds = options.targetAccountId
      ? linkedAccountIds.filter((accountId) => accountId === options.targetAccountId)
      : linkedAccountIds;
    const executionMode = options.executionMode ?? "VIRTUAL_TP";
    const settings = this.appSettings();
    if (targetAccountIds.length === 0) {
      const queueItemId = this.insertNonLeasedQueueItem(parsedSignalId, signal, "HELD", {
        accountId: signal.accountId ?? this.defaultParserAccountId(providerId),
        executionMode,
        settings,
        heldReason: "NO_ACCOUNT",
      });
      this.db
        .query("UPDATE parsed_signals SET status = ? WHERE id = ?")
        .run("HELD", parsedSignalId);
      this.audit("signal.no-account", "warn", "Signal held because no MT5 account is linked", {
        parsedSignalId,
        providerId,
        queueItemId,
        heldReason: "NO_ACCOUNT",
      });
      this.alertHeldQueueItem(queueItemId, "NO_ACCOUNT");
      return { body: { queueItemId, status: "HELD" } };
    }
    const accountId = targetAccountIds[0] ?? this.defaultParserAccountId(providerId);
    const provider = this.providerDetails(providerId);
    const defaultTakeProfit = { value: settings.defaultTakeProfitPips, unit: "PIPS" as const };
    if (options.trigger !== "operator") {
      const evidenceTargets = normalizeEvidenceTargets(
        targetAccountIds.map((targetAccountId) => {
          const targetConfig = this.providerConfig(providerId, targetAccountId);
          const targetSignal = applyProviderExecutionConfig(
            targetAccountId === signal.accountId
              ? signal
              : this.reparseSignalForAccount(signal, providerId, targetAccountId),
            targetConfig,
            { defaultTakeProfit },
          );
          const resolution =
            targetSignal.commandType !== "OPEN_TRADE" &&
            targetSignal.commandType !== "NO_SIGNAL" &&
            targetSignal.commandType !== "TRADE_SETUP"
              ? this.resolveLifecycleTarget(
                  providerId,
                  targetAccountId,
                  source?.rawMessageId ?? "",
                  targetSignal,
                )
              : undefined;
          const suggestion = resolution
            ? matchLifecycleCommandToTrade(
                targetSignal,
                this.logicalTrades().filter((trade) => trade.accountId === targetAccountId),
              )
            : undefined;
          const lifecycleResolution: LifecycleResolutionEvidence | undefined = resolution
            ? {
                method: resolution.method,
                status: resolution.status,
                activeTradeCount: resolution.activeTradeCount,
                ...(suggestion?.status === "MATCHED" && suggestion.tradeId
                  ? { suggestion: `same-symbol trade ${suggestion.tradeId}` }
                  : {}),
              }
            : undefined;
          const verdict = evaluateExecutionEvidence({
            parsedSignal: targetSignal,
            providerConfig: { openEvidence: targetConfig.openEvidence ?? "prose-complete" },
            lifecycleResolution,
            orderIdNovelty: {
              providerOrderIdNeverSeen: !this.hasDuplicateProviderOrderId(
                providerId,
                targetAccountId,
                targetSignal,
              ),
            },
            forwarded: this.forwardedForParsedSignal(parsedSignalId),
          });
          return { accountId: targetAccountId, signal: targetSignal, verdict };
        }),
      );
      const failed = evidenceTargets.find((target) => target.verdict.verdict !== "EXECUTE");
      if (failed) {
        if (failed.verdict.verdict === "DROP") {
          const queueItemId = this.dropForEvidence(
            parsedSignalId,
            failed.signal,
            accountId,
            executionMode,
            settings,
            failed.verdict.reason,
          );
          return { body: { queueItemId, status: "IGNORED" } };
        }
        const heldQueueItems = evidenceTargets.map((target) =>
          this.holdForEvidence(
            parsedSignalId,
            target.signal,
            target.accountId,
            executionMode,
            settings,
            target.verdict.verdict === "HOLD" ? target.verdict.reason : failed.verdict.reason,
            target.verdict.suggestion,
            target.verdict.verdict === "HOLD" ? target.verdict.tier : failed.verdict.tier,
          ),
        );
        return {
          body: {
            queueItemId: heldQueueItems[0],
            heldQueueItems,
            queuedCount: 0,
            status: "HELD",
          },
        };
      }
    }
    if (signal.commandType === "OPEN_TRADE" && openTradeSourceExpired(source, settings)) {
      const queueItemId = this.insertNonLeasedQueueItem(parsedSignalId, signal, "HELD", {
        accountId,
        executionMode,
        settings,
        heldReason: "EXPIRED_LATE",
      });
      this.db
        .query("UPDATE parsed_signals SET status = ? WHERE id = ?")
        .run("HELD", parsedSignalId);
      this.audit("signal.expired", "warn", "Open trade signal expired before queueing", {
        parsedSignalId,
        providerId,
        queueItemId,
        heldReason: "EXPIRED_LATE",
        messageDate: source?.messageDate,
        maxOpenTradeAgeSeconds: settings.maxOpenTradeAgeSeconds,
      });
      this.alertHeldQueueItem(queueItemId, "EXPIRED_LATE");
      return { body: { queueItemId, status: "HELD" } };
    }
    // Keep exact lifecycle retries idempotent. Open-trade deduplication is handled
    // below per target account so provider order IDs can take precedence.
    if (signal.commandType !== "OPEN_TRADE") {
      const duplicate = this.db
        .query(
          "SELECT id FROM parsed_signals WHERE provider_id = ? AND fingerprint = ? AND id != ? AND status = 'APPROVED' AND created_at > datetime('now', ?) LIMIT 1",
        )
        .get(
          String(row.provider_id),
          signal.fingerprint,
          parsedSignalId,
          `-${settings.dedupWindowSeconds} seconds`,
        ) as Row | null;
      if (duplicate) {
        this.insertNonLeasedQueueItem(parsedSignalId, signal, "DUPLICATE", {
          accountId,
          executionMode,
          settings,
        });
        this.db
          .query("UPDATE parsed_signals SET status = ? WHERE id = ?")
          .run("DUPLICATE", parsedSignalId);
        return { statusCode: 409, error: "Signal has already been approved or queued" };
      }
    }
    // Close-all is never executable by any path. The operator approve endpoint passes
    // trigger:"operator", which skips the evidence gate, so an innocuous "Approve" click used to
    // reach the provider-wide fan-out and flatten the whole book. The fan-out is gone; this hold
    // sits after the gate so it catches the operator bypass too. The corpus contains zero close-all
    // messages, so this costs nothing real and fails closed if one ever arrives.
    if (signal.commandType === "CLOSE_TRADE" && signal.closeAll) {
      const heldQueueItems = targetAccountIds.map((targetAccountId) => {
        const targetConfig = this.providerConfig(providerId, targetAccountId);
        const targetSignal = applyProviderExecutionConfig(
          targetAccountId === signal.accountId
            ? signal
            : this.reparseSignalForAccount(signal, providerId, targetAccountId),
          targetConfig,
          { defaultTakeProfit },
        );
        return this.holdForEvidence(
          parsedSignalId,
          targetSignal,
          targetAccountId,
          executionMode,
          settings,
          "CLOSE_ALL_REQUIRES_OPERATOR",
        );
      });
      return {
        body: {
          queueItemId: heldQueueItems[0],
          heldQueueItems,
          queuedCount: 0,
          status: "HELD",
        },
      };
    }
    if (signal.commandType === "OPEN_TRADE") {
      const targetSignals = targetAccountIds.map((targetAccountId) => {
        const targetConfig = this.providerConfig(providerId, targetAccountId);
        const signalForTarget =
          targetAccountId === signal.accountId
            ? signal
            : this.reparseSignalForAccount(signal, providerId, targetAccountId);
        return {
          accountId: targetAccountId,
          config: targetConfig,
          signal: applyProviderExecutionConfig(signalForTarget, targetConfig, {
            defaultTakeProfit,
          }),
        };
      });
      const accountFreshness = new Map(
        this.mt5Accounts().map((account) => [account.id, account.heartbeatStatus]),
      );
      // Hold only a genuinely silent EA (>30s), not the "stale" 10-30s tier. Heartbeats
      // arrive every ~5s, so gating on "online" (<=10s) would hold live signals for manual
      // approval on a single missed cycle and cost real trades.
      const offlineTargetSignals = targetSignals.filter(
        (target) => accountFreshness.get(target.accountId) === "offline",
      );
      const onlineTargetSignals = targetSignals.filter(
        (target) => accountFreshness.get(target.accountId) !== "offline",
      );
      const mappingHolds = onlineTargetSignals.filter(
        (target) => target.signal.mappingStatus !== "mapped",
      );
      const routableTargets = onlineTargetSignals.filter(
        (target) => target.signal.mappingStatus === "mapped",
      );
      const nakedPendingTargets: typeof routableTargets = [];
      for (const target of routableTargets) {
        const targetTradedSymbolHoldReason = this.tradedSymbolHoldReason(
          providerId,
          target.signal,
          target.config,
        );
        if (targetTradedSymbolHoldReason) {
          return { statusCode: 422, error: targetTradedSymbolHoldReason };
        }
        // Infer first, then review the signal we will actually send. Reviewing the
        // pre-inference signal let a held "no quote, away-from-market entry" fall back
        // to MARKET and execute immediately — the exact 4028-intended/4023.8-filled
        // failure this inference exists to prevent.
        const inferred = this.inferPendingOrderType(target.signal, target.accountId);
        const safetyHoldReason = this.executionPayloadHoldReason(
          target.accountId,
          buildExecutionCommand(inferred, { id: "safety-check", accountId: target.accountId })
            .payload,
        );
        if (safetyHoldReason === "NAKED_PENDING_ENTRY") {
          nakedPendingTargets.push(target);
          continue;
        }
        if (
          inferred.commandType !== "OPEN_TRADE" ||
          shouldRequireManualReview(inferred, target.config.parserMode === "aggressive")
        ) {
          return {
            statusCode: 422,
            error: signalApprovalReviewError(target.accountId, inferred),
          };
        }
        // Validate the type we will actually send, not the pre-inference one: a defaulted
        // MARKET can still become LIMIT/STOP below, which would otherwise let an inferred
        // order bypass allowedOrderTypes (or be rejected for a type it never ends up as).
        const orderType = inferred.orderType ?? "MARKET";
        if (!settings.allowedOrderTypes.includes(orderType)) {
          return { statusCode: 422, error: `${orderType} orders are not allowed by settings` };
        }
        // Runner mode is VIRTUAL_TP-only; enforce per target since config is per-account.
        if (executionMode === "SPLIT_ORDER" && target.config.runner?.enabled) {
          return {
            statusCode: 422,
            error: "Runner mode is only supported for VIRTUAL_TP execution today",
          };
        }
      }
      const duplicateOrderIdTargets = routableTargets.filter((target) =>
        this.hasDuplicateProviderOrderId(providerId, target.accountId, target.signal),
      );
      const queueableTargets = routableTargets.filter(
        (target) =>
          !duplicateOrderIdTargets.includes(target) && !nakedPendingTargets.includes(target),
      );
      const duplicateTargets = queueableTargets.filter(
        (target) =>
          this.hasDuplicateSignalFingerprint(
            providerId,
            target.accountId,
            target.signal,
            parsedSignalId,
          ) || this.hasDuplicateOpenSignal(providerId, target.accountId, target.signal),
      );
      const queueableCleanTargets = queueableTargets.filter(
        (target) => !duplicateTargets.includes(target),
      );
      const heldQueueItems = mappingHolds.map((target) => {
        const heldReason = `SYMBOL_MAPPING_${target.signal.mappingStatus.toUpperCase()}`;
        const queueItemId = this.insertNonLeasedQueueItem(parsedSignalId, target.signal, "HELD", {
          accountId: target.accountId,
          executionMode,
          settings,
          heldReason,
        });
        this.audit(
          "signal.symbol-mapping",
          "warn",
          "Signal held for one account's symbol mapping",
          {
            parsedSignalId,
            providerId,
            accountId: target.accountId,
            rawSymbol: target.signal.rawSymbol,
            canonicalSymbol: target.signal.canonicalSymbol,
            mappingStatus: target.signal.mappingStatus,
            queueItemId,
            heldReason,
          },
        );
        this.alertHeldQueueItem(queueItemId, `${heldReason}:${target.accountId}`);
        return queueItemId;
      });
      for (const target of duplicateOrderIdTargets) {
        const queueItemId = this.insertNonLeasedQueueItem(parsedSignalId, target.signal, "HELD", {
          accountId: target.accountId,
          executionMode,
          settings,
          heldReason: "DUPLICATE_ORDER_ID",
        });
        heldQueueItems.push(queueItemId);
        this.audit(
          "signal.duplicate-order-id",
          "warn",
          "Duplicate provider order id held for review",
          {
            parsedSignalId,
            providerId,
            accountId: target.accountId,
            providerOrderId: target.signal.providerOrderId,
            queueItemId,
            heldReason: "DUPLICATE_ORDER_ID",
          },
        );
        this.alertHeldQueueItem(queueItemId, `DUPLICATE_ORDER_ID:${target.accountId}`);
      }
      for (const target of nakedPendingTargets) {
        const queueItemId = this.insertNonLeasedQueueItem(parsedSignalId, target.signal, "HELD", {
          accountId: target.accountId,
          executionMode,
          settings,
          heldReason: "NAKED_PENDING_ENTRY",
        });
        heldQueueItems.push(queueItemId);
        this.audit("signal.naked-order", "warn", "Pending order held without a valid entry price", {
          parsedSignalId,
          providerId,
          accountId: target.accountId,
          queueItemId,
          heldReason: "NAKED_PENDING_ENTRY",
        });
        this.alertHeldQueueItem(queueItemId, `NAKED_PENDING_ENTRY:${target.accountId}`);
      }
      for (const target of offlineTargetSignals) {
        const queueItemId = this.insertNonLeasedQueueItem(parsedSignalId, target.signal, "HELD", {
          accountId: target.accountId,
          executionMode,
          settings,
          heldReason: "EA_OFFLINE",
        });
        heldQueueItems.push(queueItemId);
        this.audit("signal.ea-offline", "warn", "OPEN_TRADE held for a silent MT5 account", {
          parsedSignalId,
          providerId,
          accountId: target.accountId,
          queueItemId,
          heldReason: "EA_OFFLINE",
        });
        this.alertHeldQueueItem(queueItemId, `EA_OFFLINE:${target.accountId}`);
      }
      for (const duplicateTarget of duplicateTargets) {
        const duplicateQueueItemId = this.insertNonLeasedQueueItem(
          parsedSignalId,
          duplicateTarget.signal,
          "DUPLICATE",
          {
            accountId: duplicateTarget.accountId,
            executionMode,
            settings,
            heldReason: "DUPLICATE_OPEN_SIGNAL",
          },
        );
        heldQueueItems.push(duplicateQueueItemId);
        this.audit("signal.duplicate-open", "warn", "Duplicate open signal held for this account", {
          parsedSignalId,
          providerId,
          accountId: duplicateTarget.accountId,
          queueItemId: duplicateQueueItemId,
          heldReason: "DUPLICATE_OPEN_SIGNAL",
        });
      }
      if (queueableTargets.length > 0 && queueableCleanTargets.length === 0) {
        this.db
          .query("UPDATE parsed_signals SET status = ? WHERE id = ?")
          .run("DUPLICATE", parsedSignalId);
        return {
          statusCode: 409,
          error: "Matching open signal has already been queued",
        };
      }
      if (queueableTargets.length === 0) {
        this.db
          .query("UPDATE parsed_signals SET status = ? WHERE id = ?")
          .run("HELD", parsedSignalId);
        return {
          body: {
            queueItemId: heldQueueItems[0],
            queueItems: heldQueueItems,
            heldQueueItems,
            queuedCount: 0,
            status: "HELD",
          },
        };
      }
      const queueItems: string[] = [];
      const logicalTradeIds: string[] = [];
      for (const target of queueableCleanTargets) {
        const targetLogicalTradeId = `trade_${nanoid(10)}`;
        const targetQueueId = `queue_${nanoid(10)}`;
        const item = buildExecutionCommand(
          this.inferPendingOrderType(target.signal, target.accountId),
          {
            id: targetQueueId,
            accountId: target.accountId,
            logicalTradeId: targetLogicalTradeId,
            executionMode,
            volume: target.config.riskMode === "fixed" ? target.config.riskAmount : 0,
            riskPercent:
              target.config.riskMode === "percent"
                ? target.config.riskAmount
                : settings.defaultRiskPercent,
            runner: target.config.runner,
          },
        );
        const trade = createLogicalTradeFromSignal(
          { ...target.signal, takeProfits: item.payload.takeProfits },
          {
            id: targetLogicalTradeId,
            providerId,
            accountId: target.accountId,
            source,
            executionMode,
          },
        );
        this.insertTrade(trade);
        this.insertQueueItem(item, parsedSignalId);
        queueItems.push(targetQueueId);
        logicalTradeIds.push(targetLogicalTradeId);
      }
      this.db
        .query("UPDATE parsed_signals SET status = ? WHERE id = ?")
        .run("APPROVED", parsedSignalId);
      this.audit(
        "signal.approve",
        "info",
        "Signal approved for MT5 queue",
        {
          parsedSignalId,
          queueItems,
          heldQueueItems,
          logicalTradeIds,
        },
        "operator",
      );
      return {
        body: {
          queueItemId: queueItems[0],
          logicalTradeId: logicalTradeIds[0],
          queueItems,
          heldQueueItems,
          logicalTradeIds,
          status: "PENDING",
        },
      };
    } else if (signal.commandType === "NO_SIGNAL") {
      return { statusCode: 422, error: "Message is not a trade signal" };
    } else if (signal.commandType === "TRADE_SETUP") {
      return {
        statusCode: 422,
        error: "Trade setup posts require manual conversion before queueing",
      };
    } else {
      const lifecycleTargets = targetAccountIds.map((targetAccountId) => {
        const targetConfig = this.providerConfig(providerId, targetAccountId);
        const targetSignal = applyProviderExecutionConfig(
          targetAccountId === signal.accountId
            ? signal
            : this.reparseSignalForAccount(signal, providerId, targetAccountId),
          targetConfig,
          { defaultTakeProfit },
        );
        const resolved = this.resolveLifecycleTarget(
          providerId,
          targetAccountId,
          source?.rawMessageId ?? "",
          targetSignal,
        );
        // Several active trades can legitimately share ONE provider order id: they are legs of a
        // single position the provider identified with that id, so closing all of them is the
        // intended fan-out, not a guess. Every OTHER kind of ambiguity IS a guess - the old
        // condition promoted those too and silently closed tradeIds[0] - so it now falls through
        // to the AMBIGUOUS branch and is held for an operator.
        const sharesOneProviderOrderId =
          targetSignal.commandType === "CLOSE_TRADE" &&
          resolved.status === "AMBIGUOUS" &&
          resolved.method === "provider-order-id" &&
          (resolved.tradeIds?.length ?? 0) > 0;
        const match =
          resolved.status === "MATCHED" && resolved.tradeId
            ? {
                status: "MATCHED" as const,
                tradeId: resolved.tradeId,
                tradeIds: resolved.tradeIds,
                confidence: resolved.method === "provider-order-id" ? 0.99 : 0.97,
                requiresManualReview: false,
              }
            : sharesOneProviderOrderId
              ? {
                  status: "MATCHED" as const,
                  tradeId: resolved.tradeIds![0]!,
                  tradeIds: resolved.tradeIds,
                  confidence: 0.99,
                  requiresManualReview: false,
                }
              : resolved.status === "AMBIGUOUS"
                ? {
                    status: "AMBIGUOUS" as const,
                    confidence: 0.45,
                    requiresManualReview: true,
                    reason: "Multiple open logical trades match this provider command",
                  }
                : matchLifecycleCommandToTrade(
                    targetSignal,
                    this.logicalTrades().filter((trade) => trade.accountId === targetAccountId),
                  );
        const matchedTradeExecutionMode = match.tradeId
          ? this.logicalTrade(match.tradeId)?.executionMode
          : undefined;
        return {
          accountId: targetAccountId,
          config: targetConfig,
          signal: targetSignal,
          match,
          runner:
            (matchedTradeExecutionMode ?? executionMode) === "VIRTUAL_TP"
              ? targetConfig.runner
              : undefined,
        };
      });

      const lifecycleFailure = lifecycleTargets.find((target) => {
        const unsafeMissingFields = target.signal.missingFields.filter(
          (field) => field !== "symbol" && field !== "brokerSymbol",
        );
        return (
          unsafeMissingFields.length > 0 ||
          target.match.requiresManualReview ||
          !target.match.tradeId
        );
      });
      if (lifecycleFailure) {
        const heldQueueItems = lifecycleTargets.map((target) =>
          this.holdLifecycleForReconciliation(
            parsedSignalId,
            target.signal,
            target.accountId,
            executionMode,
            settings,
            target.runner,
            lifecycleFailure.match.reason ??
              `missing ${lifecycleFailure.signal.missingFields.filter((field) => field !== "symbol" && field !== "brokerSymbol").join(", ")}`,
          ),
        );
        return {
          body: {
            queueItemId: heldQueueItems[0],
            heldQueueItems,
            queuedCount: 0,
            status: "HELD",
          },
        };
      }

      if (signal.commandType === "MARK_TP_HIT") {
        const logicalTradeIds: string[] = [];
        for (const target of lifecycleTargets) {
          const trade = this.logicalTrade(target.match.tradeId!);
          if (!trade) {
            return { statusCode: 422, error: "Matched logical trade could not be loaded" };
          }
          this.recordProviderTpHit(trade.id, target.signal);
          logicalTradeIds.push(trade.id);
        }
        this.db
          .query("UPDATE parsed_signals SET status = ? WHERE id = ?")
          .run("APPROVED", parsedSignalId);
        this.audit("signal.tp-hit", "info", "Provider TP hit recorded for logical trade", {
          parsedSignalId,
          logicalTradeIds,
        });
        return {
          body: {
            logicalTradeId: logicalTradeIds[0],
            logicalTradeIds,
            status: "RECORDED",
          },
        };
      }

      const queueItems: string[] = [];
      const logicalTradeIds: string[] = [];
      for (const target of lifecycleTargets) {
        const tradeIds = target.match.tradeIds ?? [target.match.tradeId!];
        for (const tradeId of tradeIds) {
          const trade = this.logicalTrade(tradeId);
          if (!trade) {
            const queueItemId = this.holdLifecycleForReconciliation(
              parsedSignalId,
              target.signal,
              target.accountId,
              executionMode,
              settings,
              target.runner,
              "matched-logical-trade-could-not-be-loaded",
            );
            return { body: { queueItemId, heldQueueItems: [queueItemId], status: "HELD" } };
          }
          const targetQueueId = `queue_${nanoid(10)}`;
          const actionState = evaluateLifecycleActionState(target.signal.commandType, trade.status);
          if (actionState.verdict === "noop" || actionState.verdict === "hold") {
            const queueItemId = this.holdLifecycleForReconciliation(
              parsedSignalId,
              target.signal,
              target.accountId,
              executionMode,
              settings,
              target.runner,
              `${actionState.reason}:trade-${trade.status}`,
            );
            return { body: { queueItemId, heldQueueItems: [queueItemId], status: "HELD" } };
          }
          const routedSignal =
            actionState.verdict === "cancel"
              ? {
                  ...target.signal,
                  commandType: "CANCEL_PENDING" as const,
                  partialClose: undefined,
                }
              : target.signal;
          const enrichedSignal = enrichLifecycleSignalFromTrade(routedSignal, trade);
          const absoluteSignal = this.withAbsolutePartialCloseTarget(
            enrichedSignal,
            trade,
            target.accountId,
          );
          if (!absoluteSignal) {
            const queueItemId = this.holdLifecycleForReconciliation(
              parsedSignalId,
              target.signal,
              target.accountId,
              executionMode,
              settings,
              target.runner,
              "percentage-close-needs-current-broker-position-snapshot",
            );
            return { body: { queueItemId, heldQueueItems: [queueItemId], status: "HELD" } };
          }
          this.appendTradeCommand(trade.id, target.signal);
          const queueItem = buildExecutionCommand(enrichedSignal, {
            id: targetQueueId,
            accountId: target.accountId,
            logicalTradeId: trade.id,
            executionMode,
            volume:
              target.config.riskMode === "fixed"
                ? target.config.riskAmount
                : (provider?.lotSize ?? settings.defaultLotSize),
            riskPercent:
              target.config.riskMode === "percent"
                ? target.config.riskAmount
                : settings.defaultRiskPercent,
            runner: trade.executionMode === "VIRTUAL_TP" ? target.config.runner : undefined,
          });
          if (absoluteSignal.partialClose?.kind === "PERCENT") {
            queueItem.payload.partialClose = absoluteSignal.partialClose;
          }
          Object.assign(
            queueItem.payload,
            this.brokerTargetForCommand(trade.id, queueItem.payload),
          );
          this.insertQueueItem(queueItem, parsedSignalId);
          queueItems.push(targetQueueId);
          logicalTradeIds.push(trade.id);
        }
      }
      this.db
        .query("UPDATE parsed_signals SET status = ? WHERE id = ?")
        .run("APPROVED", parsedSignalId);
      this.audit("signal.approve", "info", "Signal approved for MT5 queue", {
        parsedSignalId,
        queueItems,
        logicalTradeIds,
      });
      log("info", "signal.approve", {
        parsedSignalId,
        queueItems,
        logicalTradeIds,
        providerId: signal.providerId,
        symbol: signal.brokerSymbol ?? signal.canonicalSymbol,
        direction: signal.direction,
        commandType: signal.commandType,
      });
      return {
        body: {
          queueItemId: queueItems[0],
          logicalTradeId: logicalTradeIds[0],
          queueItems,
          logicalTradeIds,
          status: "PENDING",
        },
      };
    }
  }

  private tradedSymbolHoldReason(
    providerId: string,
    signal: ParsedSignal,
    config = this.providerConfig(providerId),
  ) {
    const tradedSymbols = normalizeTradedSymbols(config.tradedSymbols);
    if (signal.commandType !== "OPEN_TRADE" || !tradedSymbols?.length) return undefined;
    const symbol = normalizeLockedSymbol(signal.canonicalSymbol);
    if (symbol && tradedSymbols.includes(symbol)) return undefined;
    return `Symbol ${symbol ?? "unavailable"} is not in this provider's traded symbols`;
  }

  private holdSignalForTradedSymbol(
    parsedSignalId: string,
    signal: ParsedSignal,
    heldReason: string,
  ) {
    const providerIdRow = this.db
      .query("SELECT provider_id FROM parsed_signals WHERE id = ?")
      .get(parsedSignalId) as Row | null;
    if (!providerIdRow) return;
    const providerId = String(providerIdRow.provider_id);
    const accountId =
      this.targetAccountIdsForProvider(
        providerId,
        signal.accountId ?? this.defaultParserAccountId(providerId),
      )[0] ??
      signal.accountId ??
      this.defaultParserAccountId(providerId);
    const queueItemId = this.insertNonLeasedQueueItem(parsedSignalId, signal, "HELD", {
      accountId,
      executionMode: "VIRTUAL_TP",
      settings: this.appSettings(),
      heldReason: "SYMBOL_NOT_TRADED",
    });
    this.db.query("UPDATE parsed_signals SET status = ? WHERE id = ?").run("HELD", parsedSignalId);
    this.audit("signal.symbol-not-traded", "warn", heldReason, {
      parsedSignalId,
      providerId,
      queueItemId,
      heldReason: "SYMBOL_NOT_TRADED",
    });
    this.alertHeldQueueItem(queueItemId, "SYMBOL_NOT_TRADED");
  }

  // Force-push a manually composed or corrected signal straight to one
  // account's MT5 queue, bypassing the parser. Used when the parser got a
  // Telegram signal wrong (or missed it). Operator-supplied values are used
  // as-is — no provider TP/risk config is layered on top — and the staleness
  // and dedup guards are skipped (the source timestamp is "now"). The Equity
  // Guardian still gates execution at lease time, so a paused account is not
  // silently overridden.
  submitManualSignal(input: ManualSignalInput):
    | {
        body: {
          queueItemId: string;
          logicalTradeId: string;
          parsedSignalId: string;
          status: string;
        };
      }
    | { statusCode: 404 | 409 | 422; error: string } {
    const account = this.mt5Accounts().find((item) => item.id === input.accountId);
    if (!account) return { statusCode: 404, error: "Account not found" };
    if ((input.commandType ?? "OPEN_TRADE") !== "OPEN_TRADE") {
      return { statusCode: 422, error: "Manual push currently supports open trades only" };
    }
    if (input.direction !== "BUY" && input.direction !== "SELL") {
      return { statusCode: 422, error: "direction must be BUY or SELL" };
    }
    const brokerSymbol = input.brokerSymbol?.trim();
    if (!brokerSymbol) return { statusCode: 422, error: "symbol is required" };

    const settings = this.appSettings();
    const orderType: OrderType = input.orderType ?? "MARKET";
    if (!settings.allowedOrderTypes.includes(orderType)) {
      return { statusCode: 422, error: `${orderType} orders are not allowed by settings` };
    }
    if (orderType !== "MARKET" && !Number.isFinite(input.entry?.from)) {
      return { statusCode: 422, error: "entry price is required for limit and stop orders" };
    }

    const executionMode: ExecutionMode = input.executionMode ?? "VIRTUAL_TP";
    const riskPercent = Number.isFinite(input.riskPercent) ? Number(input.riskPercent) : undefined;
    const volume = Number.isFinite(input.volume)
      ? Number(input.volume)
      : riskPercent !== undefined
        ? undefined
        : settings.defaultLotSize;

    const legs = (input.takeProfits ?? []).filter((tp) => Number.isFinite(tp.price));
    const takeProfits = legs.map((tp, index) => ({
      leg: index + 1,
      price: Number(tp.price),
      allocationPercent:
        Number.isFinite(tp.allocationPercent) && Number(tp.allocationPercent) > 0
          ? Number(tp.allocationPercent)
          : Math.floor(100 / Math.max(legs.length, 1)),
    }));

    const entry =
      orderType === "MARKET"
        ? undefined
        : { from: Number(input.entry?.from), to: Number(input.entry?.to ?? input.entry?.from) };
    const originalText =
      input.rawText?.trim() || manualTicketSummary(input, brokerSymbol, orderType, entry);
    const fingerprint = createMessageFingerprint(
      JSON.stringify({
        accountId: input.accountId,
        providerId: input.providerId ?? "",
        rawMessageIdentity: input.rawMessageId ?? input.rawText?.trim() ?? "",
        brokerSymbol,
        direction: input.direction,
        orderType,
        entry,
        stopLoss: input.stopLoss,
        takeProfits: input.takeProfits,
        volume,
        riskPercent,
        executionMode,
      }),
    );
    const duplicate = this.db
      .query(
        "SELECT id FROM parsed_signals WHERE fingerprint = ? AND unixepoch(created_at) >= unixepoch('now') - ? LIMIT 1",
      )
      .get(fingerprint, MANUAL_PUSH_DEDUP_SECONDS) as Row | null;
    if (duplicate) {
      return { statusCode: 409, error: "Duplicate manual push rejected; retry after 10 seconds" };
    }

    const signal: ParsedSignal = {
      originalText,
      commandType: "OPEN_TRADE",
      direction: input.direction,
      orderType,
      rawSymbol: brokerSymbol,
      canonicalSymbol: input.canonicalSymbol?.trim() || brokerSymbol,
      brokerSymbol,
      mappingStatus: "mapped",
      mappingSource: "manual",
      mappingWarnings: [],
      entry,
      stopLoss: Number.isFinite(input.stopLoss) ? Number(input.stopLoss) : undefined,
      takeProfits,
      lotSize: volume,
      riskPercent,
      confidence: 1,
      matchedPatternIds: ["manual"],
      missingFields: [],
      warnings: [],
      providerId: input.providerId,
      accountId: input.accountId,
      executionMode,
      fingerprint,
    };

    const now = new Date().toISOString();
    const providerId = input.providerId ?? "";
    // Reuse the linked raw message when correcting one; otherwise synthesize a
    // manual raw message so the trade keeps a source and audit trail.
    let rawMessageId = input.rawMessageId;
    if (!rawMessageId) {
      rawMessageId = `raw_${nanoid(10)}`;
      const telegramMessageId = `manual-${Date.now()}`;
      this.db
        .query(
          "INSERT INTO raw_messages (id, provider_id, telegram_message_id, reply_to_message_id, message_date, raw_text, fingerprint, classification, forwarded_from, forward_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          rawMessageId,
          providerId,
          telegramMessageId,
          null,
          now,
          originalText,
          fingerprint,
          "entry",
          null,
          null,
        );
      this.db
        .query(
          "INSERT INTO raw_message_aliases (provider_id, telegram_message_id, raw_message_id) VALUES (?, ?, ?) ON CONFLICT(provider_id, telegram_message_id) DO NOTHING",
        )
        .run(providerId, telegramMessageId, rawMessageId);
    }
    const parsedSignalId = `parse_${nanoid(10)}`;
    this.db
      .query(
        "INSERT INTO parsed_signals (id, provider_id, raw_message_id, result_json, review_required, fingerprint, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        parsedSignalId,
        providerId,
        rawMessageId,
        JSON.stringify(signal),
        0,
        fingerprint,
        "APPROVED",
        now,
      );

    const source: TradeSource = {
      parsedSignalId,
      rawMessageId,
      telegramMessageId: "manual",
      messageDate: now,
      rawText: originalText,
    };
    const logicalTradeId = `trade_${nanoid(10)}`;
    const queueItemId = `queue_${nanoid(10)}`;
    const trade = createLogicalTradeFromSignal(signal, {
      id: logicalTradeId,
      providerId: input.providerId,
      accountId: input.accountId,
      source,
      executionMode,
    });
    this.insertTrade(trade);
    const item = buildExecutionCommand(signal, {
      id: queueItemId,
      accountId: input.accountId,
      logicalTradeId,
      executionMode,
      volume,
      riskPercent,
    });
    this.insertQueueItem(item, parsedSignalId);

    this.audit(
      "signal.manual-push",
      "warn",
      "Manual signal force-pushed to MT5 queue",
      {
        parsedSignalId,
        queueItemId,
        logicalTradeId,
        accountId: input.accountId,
        brokerSymbol,
        direction: input.direction,
        orderType,
        force: true,
      },
      "operator",
    );
    // Operator force-pushing a signal teaches the parser this approved structure.
    if (input.providerId) this.recordTrainingExample(input.providerId, originalText, signal);
    return { body: { queueItemId, logicalTradeId, parsedSignalId, status: "PENDING" } };
  }

  ignoreSignal(
    parsedSignalId: string,
  ): { parsedSignalId: string; status: "IGNORED" } | { statusCode: 404 | 409; error: string } {
    const row = this.db
      .query("SELECT provider_id, result_json FROM parsed_signals WHERE id = ?")
      .get(parsedSignalId) as Row | null;
    if (!row) return { statusCode: 404, error: "Parsed signal not found" };
    const existing = this.db
      .query("SELECT id FROM queue_items WHERE parsed_signal_id = ?")
      .get(parsedSignalId) as Row | null;
    if (existing) {
      return { statusCode: 409, error: "Signal has already been approved or queued" };
    }
    const signal = parseJson<ParsedSignal>(String(row.result_json));
    const providerId = String(row.provider_id);
    this.insertNonLeasedQueueItem(parsedSignalId, signal, "IGNORED", {
      accountId: signal.accountId ?? this.defaultParserAccountId(providerId),
      executionMode: "VIRTUAL_TP",
      settings: this.appSettings(),
    });
    this.db
      .query("UPDATE parsed_signals SET status = ? WHERE id = ?")
      .run("IGNORED", parsedSignalId);
    this.audit(
      "signal.ignore",
      "info",
      "Signal ignored by operator",
      { parsedSignalId },
      "operator",
    );
    return { parsedSignalId, status: "IGNORED" };
  }

  async aiReviewSignal(
    parsedSignalId: string,
  ): Promise<
    | { parsedSignalId: string; review: AiSignalReview; model: string }
    | { statusCode: 404 | 409 | 503 | 502; error: string }
  > {
    const row = this.db
      .query(
        `SELECT parsed_signals.id, parsed_signals.provider_id, parsed_signals.result_json, parsed_signals.review_required, raw_messages.classification
         FROM parsed_signals
         LEFT JOIN raw_messages ON raw_messages.id = parsed_signals.raw_message_id
         WHERE parsed_signals.id = ?`,
      )
      .get(parsedSignalId) as Row | null;
    if (!row) return { statusCode: 404, error: "Parsed signal not found" };
    const signal = parseJson<ParsedSignal>(String(row.result_json));
    if (signal.commandType === "NO_SIGNAL") {
      return {
        statusCode: 409,
        error: "GPT extraction is not available for NO_SIGNAL parser outputs",
      };
    }
    if (!row.review_required) {
      return { statusCode: 409, error: "AI review is only available for signals requiring review" };
    }

    const provider = this.providerDetails(String(row.provider_id));
    const model = process.env.AZURE_OPENAI_DEPLOYMENT ?? "gpt-5.4-mini";
    const review = await reviewSignalWithAzureOpenAI({
      signal,
      providerTitle: provider?.title ?? String(row.provider_id),
      classification: String(row.classification ?? "unknown"),
      model,
      apiKey: this.secret("azureOpenAIApiKey"),
    });
    if ("error" in review) return review;
    this.audit("signal.ai-review", "info", "AI parser review completed", {
      parsedSignalId,
      model,
      verdict: review.verdict,
    });
    return { parsedSignalId, review, model };
  }

  queueItems() {
    this.expireStaleOpenTradeQueueItems();
    return (
      this.db
        .query(
          "SELECT id, account_id, logical_trade_id, status, payload_json, held_reason, held_tier, suggestion, origin_queue_item_id, leased_at, created_at FROM queue_items ORDER BY created_at DESC",
        )
        .all() as Row[]
    ).map(queueRow);
  }

  heldQueueItems() {
    const rows = this.db
      .query(
        `SELECT queue_items.id, queue_items.account_id, queue_items.logical_trade_id,
                queue_items.status, queue_items.payload_json, queue_items.held_reason,
                queue_items.held_tier, queue_items.suggestion,
                queue_items.origin_queue_item_id, queue_items.created_at,
                parsed_signals.provider_id, parsed_signals.result_json,
                providers.title AS provider_title
         FROM queue_items
         LEFT JOIN parsed_signals ON parsed_signals.id = queue_items.parsed_signal_id
         LEFT JOIN providers ON providers.id = parsed_signals.provider_id
         WHERE queue_items.status IN ('HELD', 'DUPLICATE')
         ORDER BY queue_items.created_at DESC`,
      )
      .all() as Row[];
    const droppedByQueueItem = this.droppedLifecycleForQueueItems(
      rows.map((row) => String(row.id)),
    );
    return rows.map((row) => {
      const payload = parseJson<ExecutionQueueItem["payload"]>(String(row.payload_json));
      const accountId = String(row.account_id ?? "");
      const currentPrice = this.freshestEaReportedPrice(accountId, payload);
      const symbol = payload.brokerSymbol ?? payload.canonicalSymbol ?? "";
      const originalEntry = payload.entry?.from;
      const droppedLifecycle = droppedByQueueItem.get(String(row.id)) ?? [];
      const candidateLogicalTradeIds =
        payload.commandType !== "OPEN_TRADE"
          ? this.logicalTrades()
              .filter(
                (trade) =>
                  (!row.logical_trade_id || trade.id === String(row.logical_trade_id)) &&
                  trade.providerId === String(row.provider_id ?? "") &&
                  trade.accountId === accountId &&
                  this.isActiveLogicalTrade(trade.id) &&
                  (!symbol ||
                    normalizeLockedSymbol(
                      trade.symbol.brokerSymbol ?? trade.symbol.canonicalSymbol ?? "",
                    ) === normalizeLockedSymbol(symbol)),
              )
              .map((trade) => trade.id)
          : [];
      const driftPct =
        originalEntry !== undefined && currentPrice?.price !== undefined && originalEntry !== 0
          ? Number((((currentPrice.price - originalEntry) / originalEntry) * 100).toFixed(2))
          : undefined;
      return {
        id: String(row.id),
        actionable: String(row.status) === "HELD",
        heldReason: String(row.held_reason ?? ""),
        heldTier: row.held_tier ? String(row.held_tier) : undefined,
        suggestion: row.suggestion ? String(row.suggestion) : undefined,
        accountId,
        providerId: String(row.provider_id ?? ""),
        providerTitle: row.provider_id ? String(row.provider_title ?? row.provider_id) : undefined,
        commandType: payload.commandType,
        symbol,
        originalEntry,
        currentPrice: currentPrice?.price,
        driftPct,
        droppedLifecycleCount: droppedLifecycle.length,
        droppedLifecycle,
        candidateLogicalTradeIds,
        createdAt: String(row.created_at),
      };
    });
  }

  private droppedLifecycleForQueueItems(queueItemIds: string[]) {
    const dropped = new Map<string, string[]>();
    if (queueItemIds.length === 0) return dropped;
    const placeholders = queueItemIds.map(() => "?").join(", ");
    const rows = this.db
      .query(
        `SELECT held_queue_item_id, command_type
         FROM held_lifecycle_drops
         WHERE held_queue_item_id IN (${placeholders})
         ORDER BY created_at ASC`,
      )
      .all(...queueItemIds) as Row[];
    for (const row of rows) {
      const id = String(row.held_queue_item_id);
      const commands = dropped.get(id) ?? [];
      commands.push(String(row.command_type));
      dropped.set(id, commands);
    }
    return dropped;
  }

  requeueQueueItem(
    id: string,
    mode?: string,
    selectedLogicalTradeId?: string,
  ): RequeueSuccess | RequeueError {
    if (mode !== "market" && mode !== "original") {
      return {
        statusCode: 422 as const,
        error: 'Requeue mode must be "market" or "original"',
      };
    }
    const row = this.db
      .query(
        `SELECT queue_items.id, queue_items.account_id, queue_items.logical_trade_id,
                queue_items.status, queue_items.held_reason, queue_items.payload_json, queue_items.parsed_signal_id,
                parsed_signals.provider_id, parsed_signals.result_json
         FROM queue_items
         LEFT JOIN parsed_signals ON parsed_signals.id = queue_items.parsed_signal_id
         WHERE queue_items.id = ?`,
      )
      .get(id) as Row | null;
    if (!row) return { statusCode: 404 as const, error: "Held queue item not found" };
    if (String(row.status) !== "HELD") {
      return { statusCode: 409 as const, error: "Only HELD queue items can be requeued" };
    }

    const heldReason = String(row.held_reason ?? "");
    const logicalTradeId = String(row.logical_trade_id ?? "");
    if (
      heldReason.startsWith("LIFECYCLE_RECONCILIATION:") &&
      !logicalTradeId &&
      !selectedLogicalTradeId?.trim()
    ) {
      return {
        statusCode: 409 as const,
        error: "Lifecycle reconciliation item must be bound to a logical trade before requeue",
      };
    }

    const originalAccountId = String(row.account_id ?? "");
    const targetAccountId = originalAccountId;
    if (this.isEquityGuardianPaused(targetAccountId)) {
      return {
        statusCode: 409 as const,
        error: "Cannot requeue while the target account's Equity Guardian is paused",
      };
    }

    const originalPayload = parseJson<ExecutionQueueItem["payload"]>(String(row.payload_json));
    const boundLogicalTrade = logicalTradeId ? this.logicalTrade(logicalTradeId) : undefined;
    if (originalPayload.commandType === "OPEN_TRADE" && !boundLogicalTrade) {
      return this.requeueHeldOpen(id, row, originalPayload);
    }
    if (
      originalPayload.commandType !== "OPEN_TRADE" &&
      (!logicalTradeId || heldReason.startsWith("EVIDENCE_"))
    ) {
      return this.requeueHeldLifecycle(id, row, mode, selectedLogicalTradeId);
    }
    const payload =
      mode === "market"
        ? { ...originalPayload, orderType: "MARKET" as const, entry: undefined }
        : originalPayload;
    if (payload.executionMode !== "VIRTUAL_TP") payload.runner = undefined;
    return this.releaseTransaction(() => {
      const queueItemId = `queue_${nanoid(10)}`;
      const item: ExecutionQueueItem = {
        id: queueItemId,
        accountId: targetAccountId || undefined,
        logicalTradeId: logicalTradeId || undefined,
        status: "PENDING",
        payload,
      };
      this.insertQueueItem(item, String(row.parsed_signal_id ?? ""), { originQueueItemId: id });
      this.dismissReleasedQueueItem(id, String(row.parsed_signal_id ?? ""));
      this.audit(
        "queue.requeue",
        "info",
        "Held queue item requeued by operator",
        {
          heldQueueItemId: id,
          queueItemId,
          mode,
          accountId: targetAccountId,
        },
        "operator",
      );
      const droppedLifecycle = this.droppedLifecycleForQueueItems([id]).get(id) ?? [];
      return {
        queueItemId,
        originQueueItemId: id,
        accountId: targetAccountId,
        logicalTradeId: logicalTradeId || undefined,
        mode,
        status: "PENDING" as const,
        droppedLifecycleCount: droppedLifecycle.length,
        droppedLifecycle,
      };
    });
  }

  private requeueHeldOpen(id: string, row: Row, payload: ExecutionQueueItem["payload"]) {
    const accountId = String(row.account_id ?? "");
    const parsedSignalId = String(row.parsed_signal_id ?? "");
    if (!accountId || !parsedSignalId) {
      return {
        statusCode: 409 as const,
        error: "Held OPEN has no account or parsed signal binding",
      };
    }
    try {
      return this.releaseTransaction(() => {
        this.dismissReleasedQueueItem(id, parsedSignalId, null);
        const approval = this.approveSignal(parsedSignalId, {
          executionMode: payload.executionMode,
          trigger: "operator",
          targetAccountId: accountId,
          releasingQueueItemId: id,
        });
        if (!("body" in approval) || approval.body.status !== "PENDING") {
          const reason = "error" in approval ? approval.error : `status=${approval.body.status}`;
          throw new Error(reason);
        }
        const queueItems =
          approval.body.queueItems ??
          (approval.body.queueItemId ? [approval.body.queueItemId] : []);
        if (
          queueItems.length === 0 ||
          queueItems.some(
            (queueItemId) => !this.logicalTrade(this.queueLogicalTradeId(queueItemId)),
          )
        ) {
          throw new Error("Approved OPEN did not produce a bound logical trade");
        }
        const placeholders = queueItems.map(() => "?").join(", ");
        this.db
          .query(`UPDATE queue_items SET origin_queue_item_id = ? WHERE id IN (${placeholders})`)
          .run(id, ...queueItems);
        const queueItemId = queueItems[0]!;
        this.audit(
          "queue.requeue",
          "info",
          "Held OPEN requeued through approved trade materialization",
          { heldQueueItemId: id, queueItemId, queueItems, accountId },
          "operator",
        );
        const droppedLifecycle = this.droppedLifecycleForQueueItems([id]).get(id) ?? [];
        return {
          queueItemId,
          originQueueItemId: id,
          accountId,
          logicalTradeId: this.queueLogicalTradeId(queueItemId),
          mode: "approved-open",
          status: "PENDING" as const,
          droppedLifecycleCount: droppedLifecycle.length,
          droppedLifecycle,
        };
      });
    } catch (error) {
      return {
        statusCode: 409 as const,
        error: `Held OPEN remains held; no unbound command was queued: ${error instanceof Error ? error.message : "approval failed"}`,
      };
    }
  }

  private requeueHeldLifecycle(
    id: string,
    row: Row,
    mode: string,
    selectedLogicalTradeId?: string,
  ) {
    const selectedId = selectedLogicalTradeId?.trim() ?? "";
    const logicalTradeId = String(row.logical_trade_id ?? "");
    if (!selectedId) {
      return {
        statusCode: 409 as const,
        error: "Lifecycle release requires an explicitly selected active logicalTradeId",
      };
    }
    const trade = this.logicalTrade(selectedId);
    const accountId = String(row.account_id ?? "");
    const providerId = String(row.provider_id ?? "");
    if (
      !trade ||
      !accountId ||
      trade.accountId !== accountId ||
      trade.providerId !== providerId ||
      !["OPEN", "PENDING", "PLANNED"].includes(trade.status)
    ) {
      return {
        statusCode: 409 as const,
        error: "Selected logicalTradeId is missing, inactive, or does not belong to this lifecycle",
      };
    }
    if (logicalTradeId && selectedId !== logicalTradeId) {
      return {
        statusCode: 409 as const,
        error: "Selected logicalTradeId does not match the trade bound to this held lifecycle",
      };
    }
    const signal = row.result_json ? parseJson<ParsedSignal>(String(row.result_json)) : undefined;
    if (!signal) {
      return { statusCode: 409 as const, error: "Held lifecycle has no parsed signal binding" };
    }
    // The question here is whether the parser invented this token, which is a
    // global one. Resolving against the account would drop a real instrument
    // that this account simply cannot trade, and a dropped symbol disables the
    // mismatch guard below entirely — an operator could then release a gold
    // cancel against a EURUSD trade. Only a token unknown as an instrument
    // anywhere is treated as "no symbol stated".
    const signalSymbol = [signal.brokerSymbol, signal.canonicalSymbol, signal.rawSymbol]
      .map((value) => normalizeLockedSymbol(value))
      .find((value) => value !== undefined && resolveSymbol(value, {}).mappingStatus === "mapped");
    const tradeSymbol = [
      trade?.symbol.brokerSymbol,
      trade?.symbol.canonicalSymbol,
      trade?.symbol.rawSymbol,
    ]
      .map((value) => normalizeLockedSymbol(value))
      .find(Boolean);
    if (signalSymbol && tradeSymbol && signalSymbol !== tradeSymbol) {
      return {
        statusCode: 409 as const,
        error: "Selected logicalTradeId does not match the held lifecycle symbol",
      };
    }
    const actionState = evaluateLifecycleActionState(signal.commandType, trade.status);
    if (actionState.verdict === "noop" || actionState.verdict === "hold") {
      return { statusCode: 409 as const, error: actionState.reason };
    }
    const parsedSignalId = String(row.parsed_signal_id ?? "");
    if (signal.commandType === "MARK_TP_HIT") {
      return this.releaseTransaction(() => {
        this.recordProviderTpHit(trade.id, signal);
        this.dismissReleasedQueueItem(id, parsedSignalId, "APPROVED");
        this.audit("signal.tp-hit", "info", "Provider TP hit recorded for logical trade", {
          parsedSignalId,
          logicalTradeIds: [trade.id],
        });
        return {
          originQueueItemId: id,
          accountId,
          logicalTradeId: trade.id,
          logicalTradeIds: [trade.id],
          mode,
          status: "RECORDED" as const,
        };
      });
    }
    const routedSignal =
      actionState.verdict === "cancel"
        ? { ...signal, commandType: "CANCEL_PENDING" as const, partialClose: undefined }
        : signal;
    const enrichedSignal = enrichLifecycleSignalFromTrade(routedSignal, trade);
    const absoluteSignal = this.withAbsolutePartialCloseTarget(enrichedSignal, trade, accountId);
    if (!absoluteSignal) {
      return {
        statusCode: 409 as const,
        error: "Lifecycle release needs a current broker position snapshot",
      };
    }
    const settings = this.appSettings();
    const config = this.providerConfig(providerId, accountId);
    const provider = this.providerDetails(providerId);
    return this.releaseTransaction(() => {
      const queueItemId = `queue_${nanoid(10)}`;
      const queueItem = buildExecutionCommand(enrichedSignal, {
        id: queueItemId,
        accountId,
        logicalTradeId: trade.id,
        executionMode: trade.executionMode ?? "VIRTUAL_TP",
        volume:
          config.riskMode === "fixed"
            ? config.riskAmount
            : (provider?.lotSize ?? settings.defaultLotSize),
        riskPercent:
          config.riskMode === "percent" ? config.riskAmount : settings.defaultRiskPercent,
        runner: trade.executionMode === "VIRTUAL_TP" ? config.runner : undefined,
      });
      if (absoluteSignal.partialClose?.kind === "PERCENT") {
        queueItem.payload.partialClose = absoluteSignal.partialClose;
      }
      Object.assign(queueItem.payload, this.brokerTargetForCommand(trade.id, queueItem.payload));
      this.appendTradeCommand(trade.id, signal);
      this.insertQueueItem(queueItem, parsedSignalId, { originQueueItemId: id });
      this.dismissReleasedQueueItem(id, parsedSignalId);
      const remainingHeldQueueItems = signal.closeAll
        ? this.holdRemainingCloseAllTrades({
            parsedSignalId,
            signal,
            accountId,
            providerId,
            selectedLogicalTradeId: trade.id,
            executionMode: trade.executionMode ?? "VIRTUAL_TP",
            settings,
          })
        : [];
      this.audit(
        "queue.requeue",
        "info",
        "Evidence-held lifecycle requeued with selected logical trade",
        {
          heldQueueItemId: id,
          queueItemId,
          accountId,
          logicalTradeId: trade.id,
          remainingHeldQueueItems,
        },
        "operator",
      );
      const droppedLifecycle = this.droppedLifecycleForQueueItems([id]).get(id) ?? [];
      return {
        queueItemId,
        originQueueItemId: id,
        accountId,
        logicalTradeId: trade.id,
        mode,
        status: "PENDING" as const,
        droppedLifecycleCount: droppedLifecycle.length,
        droppedLifecycle,
        ...(signal.closeAll
          ? {
              remainingHeldQueueItems,
              remainingTradeCount: remainingHeldQueueItems.length,
            }
          : {}),
      };
    });
  }

  private holdRemainingCloseAllTrades(input: {
    parsedSignalId: string;
    signal: ParsedSignal;
    accountId: string;
    providerId: string;
    selectedLogicalTradeId: string;
    executionMode: ExecutionMode;
    settings: AppSettings;
  }) {
    const representedRows = this.db
      .query(
        `SELECT logical_trade_id FROM queue_items
         WHERE parsed_signal_id = ?
           AND account_id = ?
           AND logical_trade_id != ''
           AND status IN ('HELD', 'PENDING', 'LEASED', 'EXECUTED')`,
      )
      .all(input.parsedSignalId, input.accountId) as Row[];
    const representedTradeIds = new Set(
      representedRows.map((row) => String(row.logical_trade_id ?? "")).filter(Boolean),
    );
    representedTradeIds.add(input.selectedLogicalTradeId);
    const signalSymbol = normalizeLockedSymbol(
      input.signal.brokerSymbol ?? input.signal.canonicalSymbol ?? input.signal.rawSymbol,
    );
    const remainingTrades = this.logicalTrades().filter((candidate) => {
      const candidateSymbol = normalizeLockedSymbol(
        candidate.symbol.brokerSymbol ??
          candidate.symbol.canonicalSymbol ??
          candidate.symbol.rawSymbol,
      );
      return (
        candidate.providerId === input.providerId &&
        candidate.accountId === input.accountId &&
        this.isActiveLogicalTrade(candidate.id) &&
        !representedTradeIds.has(candidate.id) &&
        (!signalSymbol || candidateSymbol === signalSymbol)
      );
    });
    return remainingTrades.map((remainingTrade) => {
      const heldQueueItemId = this.holdForEvidence(
        input.parsedSignalId,
        input.signal,
        input.accountId,
        input.executionMode,
        input.settings,
        "CLOSE_ALL_REQUIRES_OPERATOR",
        `Close-all remains incomplete: release trade ${remainingTrade.id} explicitly`,
      );
      this.db
        .query("UPDATE queue_items SET logical_trade_id = ? WHERE id = ?")
        .run(remainingTrade.id, heldQueueItemId);
      return heldQueueItemId;
    });
  }

  private dismissReleasedQueueItem(
    id: string,
    parsedSignalId: string,
    parsedStatus: string | null = "PENDING",
  ) {
    // Compare-and-swap: the source must still be HELD and must transition exactly once. If a
    // concurrent release, a crash retry, or a stale card got there first, abort so we never leave
    // both an executable row and the original HELD row behind. A leaked PENDING row is immediately
    // leasable by the EA, so this must fail the whole release rather than warn.
    const dismissed = this.db
      .query("UPDATE queue_items SET status = ?, updated_at = ? WHERE id = ? AND status = 'HELD'")
      .run("DISMISSED", nowIso(), id);
    if (dismissed.changes !== 1) {
      throw new ReleaseConflictError(
        "Held queue item was already released or is no longer HELD; nothing was queued",
      );
    }
    if (parsedSignalId && parsedStatus) {
      this.db
        .query("UPDATE parsed_signals SET status = ? WHERE id = ?")
        .run(parsedStatus, parsedSignalId);
    }
  }

  private queueLogicalTradeId(queueItemId: string) {
    const row = this.db
      .query("SELECT logical_trade_id FROM queue_items WHERE id = ?")
      .get(queueItemId) as Row | null;
    return String(row?.logical_trade_id ?? "");
  }

  dismissQueueItem(id: string) {
    const row = this.db
      .query("SELECT status, parsed_signal_id FROM queue_items WHERE id = ?")
      .get(id) as Row | null;
    if (!row) return { statusCode: 404 as const, error: "Held queue item not found" };
    if (!["HELD", "DUPLICATE"].includes(String(row.status))) {
      return {
        statusCode: 409 as const,
        error: "Only HELD or DUPLICATE queue items can be dismissed",
      };
    }
    this.db
      .query(
        "UPDATE queue_items SET status = ?, updated_at = ? WHERE id = ? AND status IN ('HELD','DUPLICATE')",
      )
      .run("DISMISSED", nowIso(), id);
    if (row.parsed_signal_id) {
      // One signal fans out to a queue item per account, so dismissing one of
      // them must not mark the whole signal dismissed while its siblings are
      // still queued or awaiting a decision. Only the last one closes it.
      const remaining = this.db
        .query(
          "SELECT count(*) AS pending FROM queue_items WHERE parsed_signal_id = ? AND status NOT IN ('DISMISSED','CANCELLED')",
        )
        .get(String(row.parsed_signal_id)) as Row | null;
      if (Number(remaining?.pending ?? 0) === 0) {
        this.db
          .query("UPDATE parsed_signals SET status = ? WHERE id = ?")
          .run("DISMISSED", String(row.parsed_signal_id));
      }
    }
    this.audit(
      "queue.dismiss",
      "info",
      "Held queue item dismissed by operator",
      {
        queueItemId: id,
      },
      "operator",
    );
    return { queueItemId: id, status: "DISMISSED" as const };
  }

  private freshestEaReportedPrice(accountId: string, payload: ExecutionQueueItem["payload"]) {
    if (!accountId) return undefined;
    const snapshot = this.mt5SnapshotsByAccount()[accountId];
    const targetSymbol = normalizeLockedSymbol(payload.brokerSymbol ?? payload.canonicalSymbol);
    if (!snapshot || !targetSymbol) return undefined;
    const record = snapshot.symbols.find((item) => {
      if (!item || typeof item !== "object") return false;
      const symbol = normalizeLockedSymbol(
        String((item as Record<string, unknown>).symbol ?? (item as Record<string, unknown>).name),
      );
      return symbol === targetSymbol;
    });
    if (!record || typeof record !== "object") return undefined;
    const quote = record as Record<string, unknown>;
    const bid = Number(quote.bid ?? 0);
    const ask = Number(quote.ask ?? 0);
    const price = bid > 0 && ask > 0 ? (bid + ask) / 2 : bid > 0 ? bid : ask > 0 ? ask : undefined;
    return price === undefined ? undefined : { price, updatedAt: snapshot.updatedAt };
  }

  private supportsLane2CloseContract(accountId: string) {
    const row = this.db
      .query("SELECT ea_capabilities_json FROM mt5_accounts WHERE id = ?")
      .get(accountId) as Row | null;
    return parseJson<string[]>(String(row?.ea_capabilities_json ?? "[]")).includes(
      LANE2_CLOSE_CAPABILITY,
    );
  }

  private supportsPendingCloseFlattenContract(accountId: string) {
    const row = this.db
      .query(
        "SELECT ea_version, ea_capabilities_json, last_heartbeat_at FROM mt5_accounts WHERE id = ?",
      )
      .get(accountId) as Row | null;
    const heartbeatAt = Date.parse(String(row?.last_heartbeat_at ?? ""));
    const heartbeatFresh =
      Number.isFinite(heartbeatAt) &&
      Date.now() - heartbeatAt <= EQUITY_GUARDIAN_HEARTBEAT_MAX_AGE_SECONDS * 1000;
    if (!heartbeatFresh) return false;
    // Capability string only, deliberately no version fallback: an EA reporting
    // 1.57.1 predates both this capability and the empty-logicalTradeId wildcard
    // fix, so a version check would admit a build that flattens the wrong trades.
    return parseJson<string[]>(String(row?.ea_capabilities_json ?? "[]")).includes(
      PENDING_CLOSE_FLATTEN_CAPABILITY,
    );
  }

  private requiresPendingCloseFlattenContract(item: ReturnType<typeof queueRow>) {
    if (item.payload.commandType !== "CLOSE_TRADE" || !item.logicalTradeId) return false;
    const trade = this.logicalTrade(item.logicalTradeId);
    return trade?.status === "PENDING";
  }

  registerMt5Account(input: {
    accountNumber: string;
    server: string;
    company: string;
    currency: string;
    balance: number;
    equity: number;
    profit?: number;
    marginMode: "HEDGING" | "NETTING";
    availableSymbols?: string[];
    eaVersion?: string;
    eaCapabilities?: string[];
    linkCode?: string;
  }): { accountId: string; status: "REGISTERED" } | { statusCode: 404 | 409; error: string } {
    const slot = input.linkCode ? this.accountSlotByCode(input.linkCode) : undefined;
    if (input.linkCode && !slot) {
      return { statusCode: 404, error: "Account slot link code was not found" };
    }
    if (slot?.status === "expired") {
      return { statusCode: 409, error: "Account slot link code has expired" };
    }
    const accountId = `mt5-${input.accountNumber}`;
    const now = nowIso();
    this.db
      .query(
        `INSERT INTO mt5_accounts
          (id, account_number, server, company, currency, balance, equity, profit, initial_balance, margin_mode, heartbeat_status, available_symbols_json, ea_version, ea_capabilities_json, last_heartbeat_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
          server = excluded.server,
          company = excluded.company,
          currency = excluded.currency,
          balance = excluded.balance,
          equity = excluded.equity,
          profit = excluded.profit,
          margin_mode = excluded.margin_mode,
          heartbeat_status = excluded.heartbeat_status,
          available_symbols_json = excluded.available_symbols_json,
          ea_version = excluded.ea_version,
          ea_capabilities_json = excluded.ea_capabilities_json,
          last_heartbeat_at = excluded.last_heartbeat_at`,
      )
      .run(
        accountId,
        input.accountNumber,
        input.server,
        input.company,
        input.currency,
        input.balance,
        input.equity,
        input.profit ?? null,
        input.balance,
        input.marginMode,
        "online",
        JSON.stringify(input.availableSymbols ?? []),
        input.eaVersion ?? null,
        JSON.stringify(input.eaCapabilities ?? []),
        now,
        now,
      );
    this.saveAccountMapping(accountId, {
      ...this.accountMappingForBroker(accountId, input.availableSymbols),
    });
    const releasedQueueItemIds = this.appSettings().releaseHeldOnEaReconnect
      ? this.releaseEaOfflineHeldQueueItems(accountId)
      : [];
    this.audit("mt5.register", "info", "MT5 account registered", {
      accountId,
      marginMode: input.marginMode,
      releasedQueueItemIds,
    });
    if (slot) this.attachAccountSlot(slot.id, accountId, input);
    else this.ensureLegacyAccountSlot(accountId, input);
    this.updateEquityGuardian(accountId, {
      currentDrawdown: drawdownPercent(input.balance, input.equity),
    });
    return { accountId, status: "REGISTERED" };
  }

  heartbeat(input: {
    accountId: string;
    balance: number;
    equity: number;
    profit?: number;
    availableSymbols?: string[];
    eaVersion?: string;
    eaCapabilities?: string[];
    linkCode?: string;
  }) {
    if (input.linkCode) {
      const slot = this.accountSlotByCode(input.linkCode);
      if (!slot || (slot.accountId && slot.accountId !== input.accountId)) {
        return { error: "Account slot link code was not found", statusCode: 404 as const };
      }
      if (slot.status === "expired") {
        return { error: "Account slot link code has expired", statusCode: 409 as const };
      }
    } else {
      const slot = this.accountSlots().find((item) => item.accountId === input.accountId);
      if (slot && slot.status !== "legacy") {
        return {
          error: "Heartbeat missing link code for linked account slot",
          statusCode: 404 as const,
        };
      }
    }
    const previousHeartbeat = this.db
      .query("SELECT last_heartbeat_at FROM mt5_accounts WHERE id = ?")
      .get(input.accountId) as Row | null;
    const previousHeartbeatAt = Date.parse(String(previousHeartbeat?.last_heartbeat_at ?? ""));
    const wasOffline =
      !Number.isFinite(previousHeartbeatAt) ||
      Date.now() - previousHeartbeatAt > EQUITY_GUARDIAN_HEARTBEAT_MAX_AGE_SECONDS * 1000;
    const now = nowIso();
    this.db
      .query(
        "UPDATE mt5_accounts SET balance = ?, equity = ?, profit = ?, heartbeat_status = ?, available_symbols_json = ?, ea_version = ?, ea_capabilities_json = ?, last_heartbeat_at = ? WHERE id = ?",
      )
      .run(
        input.balance,
        input.equity,
        input.profit ?? null,
        "online",
        JSON.stringify(input.availableSymbols ?? []),
        input.eaVersion ?? null,
        JSON.stringify(input.eaCapabilities ?? []),
        now,
        input.accountId,
      );
    this.updateEquityGuardian(input.accountId, {
      currentDrawdown: drawdownPercent(input.balance, input.equity),
    });
    if (input.availableSymbols !== undefined) {
      this.saveAccountMapping(
        input.accountId,
        this.accountMappingForBroker(input.accountId, input.availableSymbols),
      );
    }
    if (input.linkCode) {
      const slot = this.accountSlotByCode(input.linkCode);
      if (slot) {
        this.db
          .query(
            "UPDATE account_slots SET account_id = ?, balance = ?, equity = ?, last_heartbeat_at = ?, updated_at = ?, status = ? WHERE id = ?",
          )
          .run(input.accountId, input.balance, input.equity, now, now, "linked", slot.id);
      }
    }
    const releasedQueueItemIds =
      wasOffline && this.appSettings().releaseHeldOnEaReconnect
        ? this.releaseEaOfflineHeldQueueItems(input.accountId)
        : [];
    this.recordEquityCurveSamples(input, now);
    this.emitEvent({
      type: "heartbeat",
      accountId: input.accountId,
      balance: input.balance,
      equity: input.equity,
      profit: input.profit,
      heartbeatStatus: "online",
      now,
    });
    return { accountId: input.accountId, heartbeatStatus: "online", at: now, releasedQueueItemIds };
  }

  leaseNextQueueItem(accountId?: string): ReturnType<typeof queueRow> | null {
    this.recoverStaleLeases();
    this.expireStaleOpenTradeQueueItems(accountId);
    const rows = accountId
      ? (this.db
          .query(
            `SELECT id, account_id, logical_trade_id, status, payload_json, held_reason, origin_queue_item_id, leased_at, created_at
             FROM queue_items
             WHERE status = 'PENDING' AND account_id = ?
             ORDER BY created_at,
               CASE
                 WHEN json_extract(payload_json, '$.commandType') = 'MODIFY_SL'
                 THEN CASE
                   WHEN json_extract(payload_json, '$.direction') = 'SELL'
                   THEN -CAST(json_extract(payload_json, '$.newStopLoss') AS REAL)
                   ELSE CAST(json_extract(payload_json, '$.newStopLoss') AS REAL)
                 END
                 ELSE 0
               END,
               rowid
             LIMIT 25`,
          )
          .all(accountId) as Row[])
      : (this.db
          .query(
            `SELECT id, account_id, logical_trade_id, status, payload_json, held_reason, origin_queue_item_id, leased_at, created_at
             FROM queue_items
             WHERE status = 'PENDING'
             ORDER BY created_at,
               CASE
                 WHEN json_extract(payload_json, '$.commandType') = 'MODIFY_SL'
                 THEN CASE
                   WHEN json_extract(payload_json, '$.direction') = 'SELL'
                   THEN -CAST(json_extract(payload_json, '$.newStopLoss') AS REAL)
                   ELSE CAST(json_extract(payload_json, '$.newStopLoss') AS REAL)
                 END
                 ELSE 0
               END,
               rowid
             LIMIT 25`,
          )
          .all() as Row[]);
    const row = rows.find((candidate) => {
      const item = queueRow(candidate);
      if (
        requiresLane2CloseContract(item.payload) &&
        !this.supportsLane2CloseContract(item.accountId)
      ) {
        const now = new Date().toISOString();
        this.db
          .query(
            "UPDATE queue_items SET status = ?, held_reason = ?, leased_at = NULL, updated_at = ? WHERE id = ?",
          )
          .run("HELD", "EA_CAPABILITY_UNAVAILABLE", now, item.id);
        this.audit(
          "queue.ea-capability-hold",
          "warn",
          "Lifecycle command held for legacy EA",
          item,
        );
        this.alertHeldQueueItem(item.id, "EA_CAPABILITY_UNAVAILABLE");
        return false;
      }
      if (
        this.requiresPendingCloseFlattenContract(item) &&
        !this.supportsPendingCloseFlattenContract(item.accountId)
      ) {
        const now = new Date().toISOString();
        this.db
          .query(
            "UPDATE queue_items SET status = ?, held_reason = ?, leased_at = NULL, updated_at = ? WHERE id = ?",
          )
          .run(
            "HELD",
            `EA_CAPABILITY_UNAVAILABLE:${PENDING_CLOSE_FLATTEN_CAPABILITY}`,
            now,
            item.id,
          );
        this.audit(
          "queue.ea-capability-hold",
          "warn",
          "Pending-close flatten held until the new EA contract is confirmed",
          { ...item, reason: PENDING_CLOSE_FLATTEN_CAPABILITY },
        );
        this.alertHeldQueueItem(
          item.id,
          `EA_CAPABILITY_UNAVAILABLE:${PENDING_CLOSE_FLATTEN_CAPABILITY}`,
        );
        return false;
      }
      // Only app-managed stop strategies may be skipped as already-satisfied. A provider or
      // operator MODIFY_SL is a deliberate instruction and can legitimately widen a stop to
      // give a trade room. Swallowing those and reporting them EXECUTED would override a human
      // decision and misreport it as delivered.
      if (
        item.payload.commandType === "MODIFY_SL" &&
        item.logicalTradeId &&
        item.payload.targetPositionTicket &&
        isAppManagedStopPayload(item.payload)
      ) {
        const trade = this.logicalTrade(item.logicalTradeId);
        const desired = Number(item.payload.newStopLoss ?? 0);
        if (trade && Number.isFinite(desired) && desired > 0) {
          const broker = this.latestPositionStop(trade, item.payload.targetPositionTicket);
          if (broker.known && this.stopIsSatisfied(trade, broker.stopLoss, desired)) {
            const now = nowIso();
            this.db
              .query(
                `UPDATE queue_items
                 SET status = 'EXECUTED', held_reason = NULL, leased_at = NULL, updated_at = ?
                 WHERE id = ?`,
              )
              .run(now, item.id);
            this.db
              .query(
                `UPDATE reference_stop_actions SET resolution = 'SATISFIED', updated_at = ?
                 WHERE queue_item_id = ?`,
              )
              .run(now, item.id);
            this.audit(
              "virtual-tp.modify-sl-satisfied",
              "info",
              "Queued stop skipped because the live broker stop is already protective",
              { queueItemId: item.id, brokerStopLoss: broker.stopLoss, desiredStopLoss: desired },
            );
            return false;
          }
        }
      }
      if (item.payload.commandType !== "OPEN_TRADE") return true;
      const safetyHoldReason = this.executionPayloadHoldReason(item.accountId, item.payload);
      if (safetyHoldReason) {
        const now = new Date().toISOString();
        this.db
          .query(
            "UPDATE queue_items SET status = ?, held_reason = ?, leased_at = NULL, updated_at = ? WHERE id = ?",
          )
          .run("HELD", safetyHoldReason, now, item.id);
        this.audit("queue.safety-hold", "warn", "OPEN_TRADE held before reaching the EA", {
          queueItemId: item.id,
          accountId: item.accountId,
          heldReason: safetyHoldReason,
        });
        this.alertHeldQueueItem(item.id, safetyHoldReason);
        return false;
      }
      if (!this.isEquityGuardianPaused(item.accountId)) return true;
      const now = new Date().toISOString();
      this.db
        .query(
          "UPDATE queue_items SET status = ?, held_reason = ?, leased_at = NULL, updated_at = ? WHERE id = ?",
        )
        .run("HELD", "GUARDIAN", now, item.id);
      this.audit("equity-guardian.reject", "warn", "OPEN_TRADE rejected by Equity Guardian", item);
      this.dispatchAlert(
        "guardian-rejection",
        item.id,
        `Equity Guardian rejected OPEN_TRADE queue item ${item.id} for account ${item.accountId}.`,
        "alertOnGuardianPause",
      );
      this.alertHeldQueueItem(item.id, "GUARDIAN");
      return false;
    }) as Row | undefined;
    if (!row) return null;
    const leasedAt = new Date().toISOString();
    this.db
      .query(
        "UPDATE queue_items SET status = ?, leased_at = ?, lease_count = COALESCE(lease_count, 0) + 1, updated_at = ? WHERE id = ?",
      )
      .run("LEASED", leasedAt, leasedAt, String(row.id));
    return queueRow({ ...row, status: "LEASED", leased_at: leasedAt });
  }

  private recoverStaleLeases() {
    const settings = this.appSettings();
    const cutoff = new Date(Date.now() - settings.leaseTimeoutSeconds * 1000).toISOString();
    const stale = this.db
      .query(
        "SELECT id, lease_count, payload_json FROM queue_items WHERE status = 'LEASED' AND leased_at IS NOT NULL AND leased_at < ?",
      )
      .all(cutoff) as Row[];
    for (const row of stale) {
      const leaseCount = Number(row.lease_count ?? 0);
      const payload = parseJson<ExecutionQueueItem["payload"]>(String(row.payload_json));
      const mustReconcileBeforeReplay = payload.commandType !== "OPEN_TRADE";
      const openTrade = payload.commandType === "OPEN_TRADE";
      const nextStatus =
        openTrade || mustReconcileBeforeReplay
          ? "HELD"
          : leaseCount >= settings.maxLeaseAttempts
            ? "EXPIRED"
            : "PENDING";
      const heldReason = openTrade || mustReconcileBeforeReplay ? "DELIVERY_UNKNOWN" : null;
      this.db
        .query(
          "UPDATE queue_items SET status = ?, held_reason = ?, leased_at = NULL, updated_at = ? WHERE id = ?",
        )
        .run(nextStatus, heldReason, new Date().toISOString(), String(row.id));
      this.audit(
        "queue.lease-recovery",
        nextStatus === "EXPIRED" ? "warn" : "info",
        `Queue lease moved to ${nextStatus}`,
        {
          queueItemId: String(row.id),
          leaseCount,
        },
      );
      if (nextStatus === "HELD") this.alertHeldQueueItem(String(row.id), String(heldReason));
    }
  }

  private expireStaleOpenTradeQueueItems(accountId?: string) {
    const settings = this.appSettings();
    const rows = accountId
      ? (this.db
          .query(
            `SELECT queue_items.id, queue_items.parsed_signal_id, queue_items.logical_trade_id, queue_items.payload_json, queue_items.created_at, logical_trades.data_json
             FROM queue_items
             LEFT JOIN logical_trades ON logical_trades.id = queue_items.logical_trade_id
             WHERE queue_items.status = 'PENDING' AND queue_items.account_id = ?`,
          )
          .all(accountId) as Row[])
      : (this.db
          .query(
            `SELECT queue_items.id, queue_items.parsed_signal_id, queue_items.logical_trade_id, queue_items.payload_json, queue_items.created_at, logical_trades.data_json
             FROM queue_items
             LEFT JOIN logical_trades ON logical_trades.id = queue_items.logical_trade_id
             WHERE queue_items.status = 'PENDING'`,
          )
          .all() as Row[]);
    const now = new Date().toISOString();
    for (const row of rows) {
      const payload = parseJson<ExecutionQueueItem["payload"]>(String(row.payload_json));
      if (payload.commandType !== "OPEN_TRADE") continue;
      const trade = row.data_json ? parseJson<LogicalTrade>(String(row.data_json)) : undefined;
      const sourceDate = trade?.source?.messageDate || String(row.created_at);
      if (!openTradeTimestampExpired(sourceDate, settings)) continue;
      this.db
        .query(
          "UPDATE queue_items SET status = ?, held_reason = ?, leased_at = NULL, updated_at = ? WHERE id = ?",
        )
        .run("HELD", "EXPIRED_LATE", now, String(row.id));
      if (row.parsed_signal_id) {
        this.db
          .query(
            "UPDATE parsed_signals SET status = ? WHERE id = ? AND status NOT IN ('IGNORED','HELD')",
          )
          .run("HELD", String(row.parsed_signal_id));
      }
      this.audit("queue.expired-open", "warn", "Expired stale open-trade queue item", {
        queueItemId: String(row.id),
        logicalTradeId: String(row.logical_trade_id ?? ""),
        heldReason: "EXPIRED_LATE",
        sourceDate,
        maxOpenTradeAgeSeconds: settings.maxOpenTradeAgeSeconds,
      });
      this.alertHeldQueueItem(String(row.id), "EXPIRED_LATE");
    }
  }

  equityGuardians() {
    return this.mt5Accounts().map((account) => this.equityGuardian(account.id));
  }

  equityGuardian(accountId: string) {
    const account = this.mt5Accounts().find((item) => item.id === accountId);
    const row = this.db
      .query(
        "SELECT account_id, threshold, current_drawdown, paused, enabled, breach_json, updated_at FROM equity_guardians WHERE account_id = ?",
      )
      .get(accountId) as Row | null;
    const currentDrawdown = row
      ? Number(row.current_drawdown)
      : drawdownPercent(account?.balance ?? 0, account?.equity ?? 0);
    return {
      accountId,
      accountNumber: account?.accountNumber ?? "",
      threshold: row ? Number(row.threshold) : 0,
      currentDrawdown,
      paused: row ? Boolean(row.paused) : false,
      // Existing rows predate this field and remain active so configured guardians keep working.
      enabled: row ? row.enabled === undefined || Boolean(row.enabled) : false,
      breaches: row ? parseJson<unknown[]>(String(row.breach_json || "[]")) : [],
      updatedAt: row ? String(row.updated_at) : "",
    };
  }

  updateEquityGuardian(
    accountId: string,
    input: { threshold?: number; enabled?: boolean; paused?: boolean; currentDrawdown?: number },
  ) {
    const current = this.equityGuardian(accountId);
    const enabled =
      input.enabled ??
      (input.threshold !== undefined || input.paused === true ? true : current.enabled);
    const threshold = enabled
      ? positiveNumber(input.threshold, current.threshold || 10)
      : current.threshold;
    const currentDrawdown = Number.isFinite(input.currentDrawdown)
      ? Number(input.currentDrawdown)
      : current.currentDrawdown;
    const breached = enabled && currentDrawdown >= threshold;
    const paused = input.paused === true || current.paused || breached;
    const breaches = [...current.breaches];
    if (breached && !current.paused) {
      breaches.push({ at: new Date().toISOString(), drawdown: currentDrawdown, action: "paused" });
    }
    this.db
      .query(
        "INSERT INTO equity_guardians (account_id, threshold, current_drawdown, paused, enabled, breach_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET threshold = excluded.threshold, current_drawdown = excluded.current_drawdown, paused = excluded.paused, enabled = excluded.enabled, breach_json = excluded.breach_json, updated_at = excluded.updated_at",
      )
      .run(
        accountId,
        threshold,
        currentDrawdown,
        Number(paused),
        Number(enabled),
        JSON.stringify(breaches),
        new Date().toISOString(),
      );
    if (paused && !current.paused) {
      this.audit("equity-guardian.pause", "warn", "Equity Guardian paused after drawdown breach", {
        accountId,
        currentDrawdown,
        threshold,
      });
      this.dispatchAlert(
        "guardian-paused",
        accountId,
        `Equity Guardian paused for account ${current.accountNumber || accountId}.`,
        "alertOnGuardianPause",
      );
    }
    return this.equityGuardian(accountId);
  }

  unpauseEquityGuardian(accountId: string) {
    const current = this.equityGuardian(accountId);
    const blocked = this.equityGuardianUnpauseBlocker(accountId, current);
    if (blocked) {
      const breaches = [
        ...current.breaches,
        {
          at: new Date().toISOString(),
          drawdown: current.currentDrawdown,
          action: "manual_unpause_rejected",
        },
      ];
      this.db
        .query(
          "INSERT INTO equity_guardians (account_id, threshold, current_drawdown, paused, enabled, breach_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET threshold = excluded.threshold, current_drawdown = excluded.current_drawdown, paused = excluded.paused, enabled = excluded.enabled, breach_json = excluded.breach_json, updated_at = excluded.updated_at",
        )
        .run(
          accountId,
          current.threshold,
          current.currentDrawdown,
          1,
          Number(current.enabled),
          JSON.stringify(breaches),
          new Date().toISOString(),
        );
      const guardian = this.equityGuardian(accountId);
      this.audit(
        "equity-guardian.unpause-rejected",
        "warn",
        "Equity Guardian remains paused because the safety check failed",
        {
          accountId,
          currentDrawdown: current.currentDrawdown,
          threshold: current.threshold,
          blocked,
        },
      );
      return {
        statusCode: 409 as const,
        error: `Equity Guardian remains paused because ${blocked}`,
        guardian,
      };
    }
    const breaches = [
      ...current.breaches,
      { at: new Date().toISOString(), drawdown: current.currentDrawdown, action: "manual_unpause" },
    ];
    this.db
      .query(
        "INSERT INTO equity_guardians (account_id, threshold, current_drawdown, paused, enabled, breach_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET threshold = excluded.threshold, current_drawdown = excluded.current_drawdown, paused = excluded.paused, enabled = excluded.enabled, breach_json = excluded.breach_json, updated_at = excluded.updated_at",
      )
      .run(
        accountId,
        current.threshold,
        current.currentDrawdown,
        0,
        Number(current.enabled),
        JSON.stringify(breaches),
        new Date().toISOString(),
      );
    const releasedQueueItemIds = this.appSettings().releaseHeldOnGuardianUnpause
      ? this.releaseGuardianHeldQueueItems(accountId)
      : [];
    this.audit("equity-guardian.unpause", "info", "Equity Guardian manually unpaused", {
      accountId,
      releasedQueueItemIds,
    });
    return { guardian: this.equityGuardian(accountId), releasedQueueItemIds };
  }

  private releaseGuardianHeldQueueItems(accountId: string): string[] {
    const held = this.db
      .query(
        `SELECT queue_items.id, queue_items.created_at, logical_trades.data_json
         FROM queue_items
         LEFT JOIN logical_trades ON logical_trades.id = queue_items.logical_trade_id
         WHERE queue_items.account_id = ? AND queue_items.status = 'HELD' AND queue_items.held_reason = 'GUARDIAN'`,
      )
      .all(accountId) as Row[];
    return held.flatMap((row) => {
      const trade = row.data_json ? parseJson<LogicalTrade>(String(row.data_json)) : undefined;
      const sourceDate = trade?.source?.messageDate || String(row.created_at);
      if (this.guardianReleaseExpired(sourceDate)) {
        this.audit(
          "equity-guardian.release-skipped",
          "warn",
          "Guardian-held trade was too old to release",
          {
            accountId,
            queueItemId: String(row.id),
            sourceDate,
          },
        );
        return [];
      }
      const result = this.requeueQueueItem(String(row.id), "market");
      return "queueItemId" in result && result.queueItemId ? [result.queueItemId] : [];
    });
  }

  private releaseEaOfflineHeldQueueItems(accountId: string): string[] {
    const held = this.db
      .query(
        `SELECT queue_items.id, queue_items.created_at, queue_items.payload_json, logical_trades.data_json
         FROM queue_items
         LEFT JOIN logical_trades ON logical_trades.id = queue_items.logical_trade_id
         WHERE queue_items.account_id = ? AND queue_items.status = 'HELD' AND queue_items.held_reason = 'EA_OFFLINE'`,
      )
      .all(accountId) as Row[];
    return held.flatMap((row) => {
      const queueItemId = String(row.id);
      const trade = row.data_json ? parseJson<LogicalTrade>(String(row.data_json)) : undefined;
      const sourceDate = trade?.source?.messageDate || String(row.created_at);
      const sourceTimestamp = Date.parse(normalizedDateInput(sourceDate));
      if (
        Number.isFinite(sourceTimestamp) &&
        Date.now() - sourceTimestamp > EA_OFFLINE_RELEASE_MAX_AGE_SECONDS * 1000
      ) {
        this.audit(
          "queue.ea-offline-release-skipped",
          "warn",
          "EA_OFFLINE held item too old to auto-release",
          { accountId, queueItemId, sourceDate, reason: "too_old" },
        );
        return [];
      }
      const payload = parseJson<ExecutionQueueItem["payload"]>(String(row.payload_json));
      if (payload.orderType !== "LIMIT" && payload.orderType !== "STOP") {
        this.audit(
          "queue.ea-offline-release-skipped",
          "warn",
          "EA_OFFLINE held item is not a pending order",
          { accountId, queueItemId, sourceDate, reason: "market_not_auto_released" },
        );
        return [];
      }
      const result = this.requeueQueueItem(queueItemId, "original");
      if ("queueItemId" in result && result.queueItemId) return [result.queueItemId];
      this.audit(
        "queue.ea-offline-release-skipped",
        "warn",
        "EA_OFFLINE held item could not be requeued",
        {
          accountId,
          queueItemId,
          sourceDate,
          reason: "requeue_blocked",
          error: "error" in result ? result.error : "release did not queue executable work",
        },
      );
      return [];
    });
  }

  private equityGuardianUnpauseBlocker(
    accountId: string,
    current: ReturnType<AppStore["equityGuardian"]>,
  ): string | undefined {
    const row = this.db
      .query("SELECT last_heartbeat_at FROM mt5_accounts WHERE id = ?")
      .get(accountId) as Row | null;
    const heartbeatAt = Date.parse(String(row?.last_heartbeat_at ?? ""));
    if (
      !Number.isFinite(heartbeatAt) ||
      Date.now() - heartbeatAt > EQUITY_GUARDIAN_HEARTBEAT_MAX_AGE_SECONDS * 1000
    ) {
      return "the latest equity heartbeat is stale or unavailable";
    }
    if (current.currentDrawdown >= current.threshold) {
      return "current drawdown is still at or above its threshold";
    }
    return undefined;
  }

  private guardianReleaseExpired(sourceDate: string) {
    const settings = this.appSettings();
    if (openTradeTimestampExpired(sourceDate, settings)) return true;
    const timestamp = Date.parse(normalizedDateInput(sourceDate));
    return (
      Number.isFinite(timestamp) &&
      Date.now() - timestamp > GUARDIAN_AUTO_RELEASE_MAX_AGE_SECONDS * 1000
    );
  }

  private isEquityGuardianPaused(accountId?: string) {
    const guardian = accountId ? this.equityGuardian(accountId) : undefined;
    return Boolean(guardian?.enabled && guardian.paused);
  }

  executionReport(input: ExecutionReportInput) {
    const verifiedInput = this.verifyRunnerCloseReport(input);
    const id = `report_${nanoid(10)}`;
    const now = new Date().toISOString();
    this.db
      .query(
        `INSERT INTO execution_reports
          (id, queue_item_id, account_id, status, retcode, retcode_external, broker_comment, order_ticket, position_ticket, deal_ticket, requested_price, filled_price, volume, requested_volume, filled_volume, remaining_volume, error_text, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        verifiedInput.queueItemId,
        verifiedInput.accountId,
        verifiedInput.status,
        verifiedInput.retcode,
        verifiedInput.retcodeExternal,
        verifiedInput.brokerComment,
        verifiedInput.orderTicket ?? "",
        verifiedInput.positionTicket ?? "",
        verifiedInput.dealTicket ?? "",
        verifiedInput.requestedPrice ?? null,
        verifiedInput.filledPrice ?? null,
        verifiedInput.filledVolume ?? verifiedInput.volume ?? null,
        verifiedInput.requestedVolume ?? verifiedInput.volume ?? null,
        verifiedInput.filledVolume ?? verifiedInput.volume ?? null,
        verifiedInput.remainingVolume ?? null,
        verifiedInput.errorText ?? "",
        now,
      );
    const queueStatus =
      verifiedInput.status === "PARTIAL" || verifiedInput.status === "UNKNOWN"
        ? "HELD"
        : verifiedInput.status;
    const heldReason =
      verifiedInput.status === "PARTIAL"
        ? "PARTIAL_FILL"
        : verifiedInput.status === "UNKNOWN"
          ? "DELIVERY_UNKNOWN"
          : null;
    this.db
      .query("UPDATE queue_items SET status = ?, held_reason = ?, updated_at = ? WHERE id = ?")
      .run(queueStatus, heldReason, now, input.queueItemId);
    this.recordBrokerOrder(verifiedInput);
    this.reconcileExecutionReport(verifiedInput);
    this.audit(
      "mt5.report",
      verifiedInput.status === "EXECUTED" ? "info" : "warn",
      "MT5 execution report received",
      verifiedInput,
    );
    if (verifiedInput.status !== "EXECUTED") {
      this.dispatchAlert(
        "execution-failed",
        verifiedInput.queueItemId,
        `MT5 execution ${verifiedInput.status.toLowerCase()} for queue item ${verifiedInput.queueItemId}: ${verifiedInput.brokerComment || verifiedInput.errorText || "unknown error"}.`,
        "alertOnExecFailed",
      );
    }
    log(verifiedInput.status === "EXECUTED" ? "info" : "warn", "mt5.report", {
      accountId: verifiedInput.accountId,
      queueItemId: verifiedInput.queueItemId,
      status: verifiedInput.status,
      retcode: verifiedInput.retcode,
      brokerComment: verifiedInput.brokerComment,
      orderTicket: verifiedInput.orderTicket,
      errorText: verifiedInput.errorText,
    });
    return { reportId: id, status: queueStatus };
  }

  private verifyRunnerCloseReport(input: ExecutionReportInput): ExecutionReportInput {
    if (input.status !== "EXECUTED") return input;
    const row = this.db
      .query(
        "SELECT logical_trade_id, parsed_signal_id, payload_json FROM queue_items WHERE id = ?",
      )
      .get(input.queueItemId) as Row | null;
    if (!row?.logical_trade_id) return input;
    const payload = parseJson<ExecutionQueueItem["payload"]>(String(row.payload_json));
    const runner = payload.runner;
    if (payload.commandType !== "CLOSE_TRADE" || !runner?.enabled) return input;
    const remaining = Number(input.remainingVolume);
    if (!Number.isFinite(remaining) || remaining <= CLOSE_VOLUME_EPSILON) return input;
    const trade = this.logicalTrade(String(row.logical_trade_id));
    const symbol = trade?.symbol.brokerSymbol ?? trade?.symbol.canonicalSymbol ?? "";
    const step = this.brokerVolumeStep(input.accountId, symbol);
    const tolerance = step > 0 ? step / 2 : CLOSE_VOLUME_EPSILON;
    if (Math.abs(remaining - runner.lotSize) <= tolerance) return input;
    return {
      ...input,
      status: "PARTIAL",
      brokerComment: `${input.brokerComment}; runner remainder ${remaining} does not match configured ${runner.lotSize}`,
    };
  }

  private brokerVolumeStep(accountId: string, symbol: string) {
    const snapshot = this.mt5SnapshotsByAccount()[accountId];
    const row = snapshot?.symbols?.find(
      (item) =>
        item &&
        typeof item === "object" &&
        String((item as Record<string, unknown>).symbol ?? "").toUpperCase() ===
          symbol.toUpperCase(),
    ) as Record<string, unknown> | undefined;
    const step = Number(row?.volumeStep ?? 0);
    return Number.isFinite(step) && step > 0 ? step : 0;
  }

  private runnerRemainderMatches(
    accountId: string,
    trade: LogicalTrade,
    remaining: number,
    runnerLotSize: number,
  ) {
    const symbol = trade.symbol.brokerSymbol ?? trade.symbol.canonicalSymbol ?? "";
    const step = this.brokerVolumeStep(accountId, symbol);
    return Math.abs(remaining - runnerLotSize) <= (step > 0 ? step / 2 : CLOSE_VOLUME_EPSILON);
  }

  private snapshotOpenPrice(accountId: string | undefined, positionTicket: string) {
    const position = accountId
      ? this.mt5SnapshotsByAccount()[accountId]?.positions.find(
          (item) =>
            item &&
            typeof item === "object" &&
            String((item as Record<string, unknown>).ticket ?? "") === positionTicket,
        )
      : undefined;
    const price = Number(
      position && typeof position === "object"
        ? ((position as Record<string, unknown>).openPrice ?? 0)
        : 0,
    );
    return Number.isFinite(price) && price > 0 ? price : undefined;
  }

  saveSnapshot(input: {
    accountId: string;
    positions: unknown[];
    orders: unknown[];
    symbols?: unknown[];
  }) {
    const now = new Date().toISOString();
    const snapshot = {
      positions: input.positions,
      orders: input.orders,
      symbols: input.symbols ?? [],
      updatedAt: now,
    };
    this.liveMt5Snapshots.set(input.accountId, snapshot);

    const signature = durableMt5SnapshotSignature(snapshot);
    let persistedSignature = this.persistedMt5SnapshotSignatures.get(input.accountId);
    if (persistedSignature === undefined) {
      const row = this.db
        .query(
          "SELECT positions_json, orders_json, symbols_json, updated_at FROM mt5_snapshots WHERE account_id = ?",
        )
        .get(input.accountId) as Row | null;
      persistedSignature = row
        ? durableMt5SnapshotSignature({
            positions: parseJson<unknown[]>(String(row.positions_json)),
            orders: parseJson<unknown[]>(String(row.orders_json)),
            symbols: parseJson<unknown[]>(String(row.symbols_json)),
            updatedAt: String(row.updated_at),
          })
        : "";
      this.persistedMt5SnapshotSignatures.set(input.accountId, persistedSignature);
    }
    if (signature !== persistedSignature) {
      this.db
        .query(
          `INSERT INTO mt5_snapshots (account_id, positions_json, orders_json, symbols_json, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(account_id) DO UPDATE SET
             positions_json = excluded.positions_json,
             orders_json = excluded.orders_json,
             symbols_json = excluded.symbols_json,
             updated_at = excluded.updated_at`,
        )
        .run(
          input.accountId,
          JSON.stringify(input.positions),
          JSON.stringify(input.orders),
          JSON.stringify(input.symbols ?? []),
          now,
        );
      this.persistSymbolMetadata(input.accountId, input.symbols ?? []);
      this.persistedMt5SnapshotSignatures.set(input.accountId, signature);
    }
    this.reconcileSnapshotState(input.accountId, input.positions, input.orders);
    this.reconcileManualBrokerClosures(input.accountId, input.positions, input.orders);
    this.evaluateVirtualTakeProfits({
      accountId: input.accountId,
      positions: input.positions,
      symbols: input.symbols,
    });
    this.invalidateDashboardCaches();
    // Snapshot telemetry arrives every second; auditing each poll would add
    // ~86k rows/day per account without recording a business event.
    return {
      accountId: input.accountId,
      status: "RECORDED",
      openPositionCount: input.positions.length,
      pendingOrderCount: input.orders.length,
    };
  }

  /**
   * Latest broker quote for a symbol, plus whether the account is quoting anything at
   * all. The distinction matters: no snapshot means we simply have no market data, while
   * a snapshot that omits this symbol means the EA is not watching it (quotes only cover
   * MarketWatch-selected symbols) and we genuinely cannot price the entry.
   */
  private latestQuote(accountId: string, brokerSymbol: string | undefined) {
    const live = this.liveMt5Snapshots.get(accountId);
    const row = live
      ? null
      : (this.db
          .query("SELECT symbols_json, updated_at FROM mt5_snapshots WHERE account_id = ?")
          .get(accountId) as Row | null);
    // Snapshots refresh with the heartbeat (seconds apart). A stale one means the EA has
    // gone quiet — an account sat 145 minutes silent while still reading "online" — and a
    // two-hour-old price must not be used to decide whether an entry is away from market.
    // Treat it as unpriceable so the caller holds rather than firing at market.
    const updatedAt = Date.parse(String(live?.updatedAt ?? row?.updated_at ?? ""));
    const fresh =
      Number.isFinite(updatedAt) && Date.now() - updatedAt <= QUOTE_FRESHNESS_MAX_AGE_MS;
    const quotes = fresh
      ? quotesBySymbol(live?.symbols ?? (row ? parseJson<unknown[]>(String(row.symbols_json)) : []))
      : null;
    return {
      // A stale snapshot still counts as "this account quotes things", so an unpriceable
      // entry is held for review instead of silently falling through to MARKET.
      hasQuoteData: (quotes?.size ?? 0) > 0 || ((live !== undefined || row !== null) && !fresh),
      quote: brokerSymbol ? quotes?.get(brokerSymbol.toUpperCase()) : undefined,
    };
  }

  /**
   * A signal carrying an explicit entry away from the current market is a pending
   * order, even when the provider omitted the words "limit" or "stop". Without this
   * "Gold sell / 4028-29 / Sl 4034" fired at market and filled 4-5 points worse than
   * the provider intended. Entries at or near market stay MARKET; with no quote to
   * compare against the signal is left untouched.
   */
  private inferPendingOrderType(signal: ParsedSignal, accountId: string): ParsedSignal {
    if (signal.commandType !== "OPEN_TRADE") return signal;
    if (signal.orderType && signal.orderType !== "MARKET") return signal;
    const entry = signal.entry?.from;
    if (!entry || !signal.direction) return signal;
    // "BUY XAUUSD NOW @ 4020" means market even though it carries an entry price.
    // Only a MARKET that was defaulted (no explicit market wording) may be inferred.
    if (/\b(?:NOW|MARKET|CMP|INSTANT|CURRENT\s+PRICE)\b/i.test(signal.originalText ?? "")) {
      return signal;
    }
    const { hasQuoteData, quote } = this.latestQuote(accountId, signal.brokerSymbol);
    const mid = quote ? (quote.bid + quote.ask) / 2 : 0;
    if (!mid) {
      // The account is quoting other symbols but not this one, so the EA is not watching
      // it and we cannot tell a pending entry from a market one. Firing at market would
      // repeat the incident where an intended 4028 sell limit filled at 4023.8, so hold.
      // With no quote data at all there is nothing to reason from; leave the signal be.
      if (!hasQuoteData) return signal;
      return {
        ...signal,
        missingFields: [...signal.missingFields, "orderType"],
        warnings: [
          ...signal.warnings,
          `Entry ${entry} given without an order type and ${signal.brokerSymbol ?? "the symbol"} is not quoted by this account, so LIMIT or STOP could not be inferred; held for review.`,
        ],
      };
    }
    const tolerance = Math.max((quote?.point ?? 0) * 20, mid * 0.0002);
    if (Math.abs(entry - mid) <= tolerance) return signal;
    const below = entry < mid;
    const orderType: OrderType =
      signal.direction === "BUY" ? (below ? "LIMIT" : "STOP") : below ? "STOP" : "LIMIT";
    return {
      ...signal,
      orderType,
      warnings: [
        ...signal.warnings,
        `Inferred ${orderType} order: entry ${entry} is away from market ${mid.toFixed(2)} and the signal named no order type.`,
      ],
    };
  }

  private persistReferenceWatermark(
    trade: LogicalTrade,
    positionTicket: string,
    price: number,
  ): LogicalTrade {
    const previous =
      trade.virtualTpWatermark?.positionTicket === positionTicket
        ? trade.virtualTpWatermark.favorablePrice
        : undefined;
    const favorablePrice =
      previous === undefined
        ? price
        : trade.direction === "BUY"
          ? Math.max(previous, price)
          : Math.min(previous, price);
    if (previous === favorablePrice) return trade;
    const updated: LogicalTrade = {
      ...trade,
      virtualTpWatermark: {
        positionTicket,
        favorablePrice,
        observedAt: nowIso(),
      },
    };
    this.db
      .query("UPDATE logical_trades SET data_json = ? WHERE id = ?")
      .run(JSON.stringify(updated), updated.id);
    return updated;
  }

  private backfillHitReferenceStopActions(trade: LogicalTrade, positionTicket: string) {
    const missing = trade.legs.filter(
      (leg) =>
        leg.status === "HIT" &&
        isReferenceVirtualTpLeg(leg) &&
        !this.db
          .query("SELECT 1 FROM reference_stop_actions WHERE logical_trade_id = ? AND leg = ?")
          .get(trade.id, leg.leg),
    );
    if (!missing.length) return;
    const prior = (
      this.db
        .query(
          `SELECT id, payload_json FROM queue_items
           WHERE logical_trade_id = ? ORDER BY created_at DESC, rowid DESC`,
        )
        .all(trade.id) as Row[]
    ).find((row) => {
      const payload = parseJson<ExecutionQueueItem["payload"]>(String(row.payload_json));
      return (
        payload.commandType === "MODIFY_SL" &&
        payload.targetPositionTicket === positionTicket &&
        (payload.idempotencyKey?.startsWith("reference-stop:") ||
          payload.originalText.includes("reference TP"))
      );
    });
    const now = nowIso();
    for (const leg of missing) {
      const needsStop = Boolean(leg.strategy && leg.strategy.kind !== "no-change");
      const desired = needsStop ? this.strategyStopPrice(trade, leg.strategy!) : undefined;
      if (needsStop && !desired) continue;
      this.db
        .query(
          `INSERT INTO reference_stop_actions
             (logical_trade_id, leg, position_ticket, desired_stop_loss, resolution, queue_item_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(logical_trade_id, leg) DO NOTHING`,
        )
        .run(
          trade.id,
          leg.leg,
          positionTicket,
          desired ?? null,
          desired ? "NEEDS_RECONCILE" : "NO_CHANGE",
          prior ? String(prior.id) : null,
          now,
          now,
        );
    }
  }

  private reconcileDeliveryUnknownModifySl(input: {
    trade: LogicalTrade;
    positionTicket: string;
    brokerStopLoss?: number;
    marketPrice: number;
  }) {
    const rows = this.db
      .query(
        `SELECT id, status, held_reason, leased_at, payload_json FROM queue_items
         WHERE logical_trade_id = ? AND status IN ('LEASED','HELD')
         ORDER BY created_at, rowid`,
      )
      .all(input.trade.id) as Row[];
    const cutoff = Date.now() - this.appSettings().leaseTimeoutSeconds * 1000;
    for (const row of rows) {
      const payload = parseJson<ExecutionQueueItem["payload"]>(String(row.payload_json));
      if (
        payload.commandType !== "MODIFY_SL" ||
        payload.targetPositionTicket !== input.positionTicket
      ) {
        continue;
      }
      const staleLease =
        String(row.status) === "LEASED" && Date.parse(String(row.leased_at ?? "")) < cutoff;
      const deliveryUnknown =
        String(row.status) === "HELD" && String(row.held_reason) === "DELIVERY_UNKNOWN";
      if (!staleLease && !deliveryUnknown) continue;
      const desired = Number(payload.newStopLoss ?? 0);
      if (!Number.isFinite(desired) || desired <= 0) continue;
      const satisfied = this.stopIsSatisfied(input.trade, input.brokerStopLoss, desired);
      if (!satisfied && !this.stopCanBePlaced(input.trade, desired, input.marketPrice)) continue;
      const now = nowIso();
      const status = satisfied ? "EXECUTED" : "PENDING";
      this.db.transaction(() => {
        this.db
          .query(
            `UPDATE queue_items
             SET status = ?, held_reason = NULL, leased_at = NULL, updated_at = ? WHERE id = ?`,
          )
          .run(status, now, String(row.id));
        this.db
          .query(
            `UPDATE reference_stop_actions SET resolution = ?, updated_at = ?
             WHERE queue_item_id = ?`,
          )
          .run(satisfied ? "SATISFIED" : "QUEUED", now, String(row.id));
      })();
      this.audit(
        satisfied ? "virtual-tp.modify-sl-satisfied" : "virtual-tp.modify-sl-replay",
        satisfied ? "info" : "warn",
        satisfied
          ? "Delivery-unknown stop confirmed from live broker state"
          : "Delivery-unknown stop replayed from live broker state",
        { logicalTradeId: input.trade.id, queueItemId: String(row.id), desiredStopLoss: desired },
      );
    }
  }

  private reconcileReferenceStopActions(input: {
    trade: LogicalTrade;
    positionTicket: string;
    brokerStopLoss?: number;
    marketPrice: number;
  }) {
    const actions = this.db
      .query(
        `SELECT leg, desired_stop_loss, queue_item_id FROM reference_stop_actions
         WHERE logical_trade_id = ? AND position_ticket = ? AND desired_stop_loss IS NOT NULL`,
      )
      .all(input.trade.id, input.positionTicket) as Row[];
    if (!actions.length) return;
    const desired = actions
      .map((row) => Number(row.desired_stop_loss))
      .filter((value) => Number.isFinite(value) && value > 0);
    if (!desired.length) return;
    const best = desired.reduce((current, candidate) =>
      this.improvesStop(input.trade, candidate, current) ? candidate : current,
    );
    const linkedIds = new Set(
      actions.map((row) => String(row.queue_item_id ?? "")).filter(Boolean),
    );

    if (this.stopIsSatisfied(input.trade, input.brokerStopLoss, best)) {
      this.db.transaction(() => {
        const now = nowIso();
        this.db
          .query(
            `UPDATE reference_stop_actions SET resolution = 'SATISFIED', updated_at = ?
             WHERE logical_trade_id = ? AND position_ticket = ? AND desired_stop_loss IS NOT NULL`,
          )
          .run(now, input.trade.id, input.positionTicket);
        for (const id of linkedIds) {
          this.db
            .query(
              `UPDATE queue_items
               SET status = 'EXECUTED', held_reason = NULL, leased_at = NULL, updated_at = ?
               WHERE id = ? AND status IN ('PENDING','LEASED','HELD')`,
            )
            .run(now, id);
        }
      })();
      return;
    }

    const queueRows = (
      this.db
        .query(
          `SELECT id, status, held_reason, leased_at, payload_json FROM queue_items
           WHERE logical_trade_id = ? ORDER BY created_at DESC, rowid DESC`,
        )
        .all(input.trade.id) as Row[]
    ).filter((row) => linkedIds.has(String(row.id)));
    const active = queueRows.find((row) => {
      if (!["PENDING", "LEASED"].includes(String(row.status))) return false;
      if (String(row.status) === "LEASED") {
        const leasedAt = Date.parse(String(row.leased_at ?? ""));
        const timeout = this.appSettings().leaseTimeoutSeconds * 1000;
        if (Number.isFinite(leasedAt) && leasedAt < Date.now() - timeout) return false;
      }
      const payload = parseJson<ExecutionQueueItem["payload"]>(String(row.payload_json));
      return this.stopIsSatisfied(input.trade, Number(payload.newStopLoss), best);
    });
    if (active) return;

    const queued = this.activeModifySlFloor(input.trade, input.positionTicket);
    if (this.stopIsSatisfied(input.trade, queued.stopLoss, best) && queued.queueItemId) {
      this.db
        .query(
          `UPDATE reference_stop_actions
           SET resolution = 'QUEUED', queue_item_id = ?, updated_at = ?
           WHERE logical_trade_id = ? AND position_ticket = ? AND desired_stop_loss IS NOT NULL`,
        )
        .run(queued.queueItemId, nowIso(), input.trade.id, input.positionTicket);
      return;
    }
    if (!this.stopCanBePlaced(input.trade, best, input.marketPrice)) return;
    const open = this.originalOpenQueue(input.trade.id);
    if (!open) return;
    this.db.transaction(() => {
      const legs = actions.map((row) => Number(row.leg)).sort((left, right) => left - right);
      const queueItemId = this.queueModifySlAfterVirtualTp({
        trade: input.trade,
        positionTicket: input.positionTicket,
        newStopLoss: best,
        parsedSignalId: open.parsedSignalId,
        idempotencyKey: `reference-stop:${input.trade.id}:${input.positionTicket}:${legs.join(",")}`,
        originalText: "App-managed reference TP SL repair",
        auditEvent: "virtual-tp.reference-sl-repair",
        auditMessage: "Reference TP stop repaired from live broker state",
      });
      this.db
        .query(
          `UPDATE reference_stop_actions
           SET resolution = 'QUEUED', queue_item_id = ?, updated_at = ?
           WHERE logical_trade_id = ? AND position_ticket = ? AND desired_stop_loss IS NOT NULL`,
        )
        .run(queueItemId, nowIso(), input.trade.id, input.positionTicket);
    })();
  }

  private evaluateVirtualTakeProfits(input: {
    accountId: string;
    positions: unknown[];
    symbols?: unknown[];
  }) {
    const quotes = quotesBySymbol(input.symbols ?? []);
    for (const trade of this.logicalTrades().filter(
      (item) =>
        item.accountId === input.accountId &&
        item.status === "OPEN" &&
        item.executionMode === "VIRTUAL_TP",
    )) {
      const position = matchedBrokerRecordForTrade(
        input.positions,
        trade,
        this.brokerOrderTicketsForTrade(trade.id),
      );
      if (!position) continue;
      const positionTicket = brokerTicketFromSnapshot(position);
      if (!positionTicket) continue;
      const quote = quotes.get(
        (trade.symbol.brokerSymbol ?? trade.symbol.canonicalSymbol ?? "").toUpperCase(),
      );
      if (!quote) continue;
      const price = trade.direction === "BUY" ? quote.bid : quote.ask;
      if (!price) continue;
      const openPrice =
        brokerOpenPriceFromSnapshot(position) ??
        this.openPriceForTrade(trade.id) ??
        trade.entry?.from;
      const payload = this.originalOpenQueue(trade.id)?.payload;
      const brokerManagedLeg = brokerManagedVirtualTpLeg(payload);
      let current = this.persistReferenceWatermark(trade, positionTicket, price);
      const brokerStopLoss = brokerStopLossFromSnapshot(position);
      this.backfillHitReferenceStopActions(current, positionTicket);
      this.reconcileDeliveryUnknownModifySl({
        trade: current,
        positionTicket,
        brokerStopLoss,
        marketPrice: price,
      });
      this.reconcileReferenceStopActions({
        trade: current,
        positionTicket,
        brokerStopLoss,
        marketPrice: price,
      });
      const favorablePrice = current.virtualTpWatermark?.favorablePrice ?? price;
      // Resolve every crossed 0%-allocation leg first, as one batch. These legs close no
      // volume and exist only to move the stop, so a price gap through several of them must
      // settle on a single most-protective stop. Doing them before any closing leg also
      // means the closing leg's `break` cannot strand a later reference leg for a tick, by
      // which time price may have retraced past its target.
      current = this.applyCrossedReferenceLegs({
        trade: current,
        positionTicket,
        price: favorablePrice,
        marketPrice: price,
        openPrice,
        point: quote.point,
        brokerStopLoss,
      });
      for (const leg of current.legs) {
        if (leg.status !== "OPEN" || isReferenceVirtualTpLeg(leg)) continue;
        const targetPrice = virtualTpTargetPrice(current, leg, openPrice, quote.point);
        if (!targetPrice) continue;
        if (
          leg.leg === brokerManagedLeg &&
          brokerTakeProfitMatchesTarget(
            position,
            targetPrice,
            current.symbol.brokerSymbol ?? current.symbol.canonicalSymbol ?? "",
          )
        ) {
          continue;
        }
        const hit = current.direction === "BUY" ? price >= targetPrice : price <= targetPrice;
        if (!hit) continue;
        const queued = this.queueVirtualTpClose(current, leg.leg, positionTicket, price);
        if (queued) {
          current = {
            ...current,
            legs: current.legs.map((item) =>
              item.leg === leg.leg
                ? {
                    ...item,
                    status: "HIT" as const,
                    brokerEvidence: `app price ${price} crossed TP${leg.leg} ${targetPrice}`,
                  }
                : item,
            ),
          };
          this.db
            .query("UPDATE logical_trades SET status = ?, data_json = ? WHERE id = ?")
            .run(current.status, JSON.stringify(current), current.id);
        }
        break;
      }
    }
  }

  saveBrokerHistory(input: { accountId: string; deals: Mt5HistoryDealInput[] }) {
    let recorded = 0;
    let updated = 0;
    let repairedPnlDelta = 0;
    const deals = this.relevantHistoryDeals(input.accountId, input.deals);
    const existingByDealTicket = this.brokerOrdersByDealTicket(
      deals.map((deal) => deal.dealTicket).filter((ticket): ticket is string => Boolean(ticket)),
    );
    for (const deal of deals) {
      if (!deal.dealTicket) continue;
      const exists = existingByDealTicket.get(deal.dealTicket) ?? null;
      const source = brokerOrderSourceForDealReason(deal.reason);
      const pnlCurrency = historyDealCurrencyPnl(deal);
      const createdAt = historyDealTimestamp(deal);
      const matchedTradeId = this.logicalTradeIdForHistoryDeal(deal);
      const tradeId = matchedTradeId ?? externalHistoryTradeId(input.accountId, deal);
      if (!tradeId || !deal.symbol || !deal.volume) continue;
      const open = this.openBrokerOrderForDeal(tradeId, deal);
      const positionTicket = String(deal.positionTicket || open?.position_ticket || "");
      const positionStillOpen = this.positionStillOpen(input.accountId, positionTicket);
      const trade = this.logicalTrade(tradeId);
      const inferredAction = trade
        ? this.historyDealActionForTrade(
            tradeId,
            deal,
            positionTicket,
            positionStillOpen,
            createdAt,
            exists ? String(exists.id) : undefined,
          )
        : historyDealAction(deal, positionStillOpen);
      const action = brokerHistoryAction(String(exists?.action ?? ""), inferredAction);
      const openPrice = nullableNumber(open?.filled_price ?? open?.requested_price);
      const signedPips =
        trade && openPrice && deal.price
          ? trade?.direction === "SELL"
            ? openPrice - deal.price
            : deal.price - openPrice
          : null;
      const pnlPips =
        signedPips !== null
          ? Number((signedPips / brokerPipSize(deal.symbol ?? "")).toFixed(1))
          : null;
      if (exists) {
        const next = {
          legId: historyDealLegId(deal),
          action,
          orderTicket: deal.orderTicket ?? String(exists.order_ticket ?? ""),
          positionTicket: deal.positionTicket ?? String(exists.position_ticket ?? ""),
          filledVolume: deal.volume ?? nullableNumber(exists.filled_volume) ?? null,
          filledPrice: deal.price ?? nullableNumber(exists.filled_price) ?? null,
          brokerComment: deal.comment ?? String(exists.broker_comment ?? "MT5 history deal"),
          pnlCurrency,
          pnlPips,
          source,
          createdAt,
        };
        if (brokerHistoryRowMatches(exists, next)) {
          continue;
        }
        const oldPnl = nullableNumber(exists.pnl_currency);
        const delta = roundCurrency(pnlCurrency - (oldPnl ?? 0));
        const oldPips = nullableNumber(exists.pnl_pips);
        const pipsDelta = pnlPips === null ? 0 : Number((pnlPips - (oldPips ?? 0)).toFixed(1));
        this.db
          .query(
            `UPDATE broker_orders
             SET leg_id = ?,
                 action = ?,
                 order_ticket = ?,
                 position_ticket = ?,
                 filled_volume = ?,
                 filled_price = ?,
                 broker_comment = ?,
                 pnl_currency = ?,
                 pnl_pips = ?,
                 source = ?,
                 created_at = ?
             WHERE id = ?`,
          )
          .run(
            next.legId,
            next.action,
            next.orderTicket,
            next.positionTicket,
            next.filledVolume,
            next.filledPrice,
            next.brokerComment,
            next.pnlCurrency,
            next.pnlPips,
            next.source,
            next.createdAt,
            String(exists.id),
          );
        updated += 1;
        repairedPnlDelta = roundCurrency(repairedPnlDelta + delta);
        existingByDealTicket.set(deal.dealTicket, {
          ...exists,
          leg_id: next.legId,
          action: next.action,
          order_ticket: next.orderTicket,
          position_ticket: next.positionTicket,
          filled_volume: next.filledVolume,
          filled_price: next.filledPrice,
          broker_comment: next.brokerComment,
          pnl_currency: next.pnlCurrency,
          pnl_pips: next.pnlPips,
          source: next.source,
          created_at: next.createdAt,
        });
        if (trade) {
          this.reconcileHistoryDeal(tradeId, deal, action, source, positionTicket);
        } else {
          this.recordExternalHistoryDeal(
            input.accountId,
            deal,
            action,
            source,
            delta,
            pipsDelta,
            createdAt,
          );
        }
        continue;
      }
      // If a snapshot-diff synthetic 'manual' close was written first (it
      // races the broker's history sweep by a few seconds), delete it before
      // recording the real close — otherwise the trade would show two close
      // legs in the Closed view, one with null P/L and one with the real P/L.
      if (
        (action === "FULL_CLOSE" || action === "PARTIAL_CLOSE") &&
        source !== "manual" &&
        positionTicket
      ) {
        this.db
          .query(
            `DELETE FROM broker_orders
             WHERE logical_trade_id = ?
               AND action = 'FULL_CLOSE'
               AND source = 'manual'
               AND position_ticket = ?
               AND broker_comment = 'Manual terminal intervention detected from snapshot diff'`,
          )
          .run(tradeId, positionTicket);
      }
      this.db
        .query(
          `INSERT INTO broker_orders
            (id, logical_trade_id, leg_id, action, queue_item_id, account_id, order_ticket, position_ticket, deal_ticket,
             requested_volume, filled_volume, requested_price, filled_price, retcode, retcode_external, broker_comment, pnl_currency, pnl_pips, source, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          `broker_${nanoid(10)}`,
          tradeId,
          historyDealLegId(deal),
          action,
          "history",
          input.accountId,
          deal.orderTicket ?? "",
          deal.positionTicket ?? "",
          deal.dealTicket,
          null,
          deal.volume ?? null,
          null,
          deal.price ?? null,
          0,
          0,
          deal.comment ?? "MT5 history deal",
          pnlCurrency,
          pnlPips,
          source,
          createdAt,
        );
      if (!trade) {
        this.recordExternalHistoryDeal(
          input.accountId,
          deal,
          action,
          source,
          pnlCurrency,
          pnlPips,
          createdAt,
        );
      }
      if (trade) {
        this.reconcileHistoryDeal(tradeId, deal, action, source, positionTicket);
      }
      recorded += 1;
    }
    if (updated > 0) {
      this.audit("mt5.history.repair", "info", "MT5 history repaired existing broker P/L rows", {
        accountId: input.accountId,
        repairedRows: updated,
        totalPnlDelta: repairedPnlDelta,
      });
    }
    if (recorded > 0 || updated > 0) this.invalidateDashboardCaches();
    return {
      accountId: input.accountId,
      received: input.deals.length,
      recorded,
      updated,
      repairedPnlDelta,
    };
  }

  private relevantHistoryDeals(accountId: string, deals: Mt5HistoryDealInput[]) {
    if (deals.length < 1000) return deals;
    const latest = this.db
      .query("SELECT MAX(created_at) AS latest FROM broker_orders WHERE account_id = ?")
      .get(accountId) as Row | null;
    const latestTime = Date.parse(normalizedDateInput(String(latest?.latest ?? "")));
    if (!Number.isFinite(latestTime)) return deals;
    const cutoffTime = latestTime - 3 * 60 * 60 * 1000;
    return deals.filter((deal) => {
      const dealTime = Date.parse(normalizedDateInput(historyDealTimestamp(deal)));
      return !Number.isFinite(dealTime) || dealTime >= cutoffTime;
    });
  }

  private brokerOrdersByDealTicket(dealTickets: string[]) {
    const rows = new Map<string, Row>();
    const uniqueTickets = [...new Set(dealTickets)];
    const chunkSize = 500;
    for (let index = 0; index < uniqueTickets.length; index += chunkSize) {
      const chunk = uniqueTickets.slice(index, index + chunkSize);
      if (chunk.length === 0) continue;
      const placeholders = chunk.map(() => "?").join(", ");
      for (const row of this.db
        .query(`SELECT * FROM broker_orders WHERE deal_ticket IN (${placeholders})`)
        .all(...chunk) as Row[]) {
        rows.set(String(row.deal_ticket), row);
      }
    }
    return rows;
  }

  private recordExternalHistoryDeal(
    accountId: string,
    deal: Mt5HistoryDealInput,
    action: string,
    source: string,
    pnlCurrency: number,
    pnlPips: number | null,
    createdAt: string,
  ) {
    const positionTicket = String(deal.positionTicket || deal.orderTicket || deal.dealTicket || "");
    if (!positionTicket || !deal.symbol) return;
    const existing = this.db
      .query("SELECT * FROM external_closes WHERE account_id = ? AND position_ticket = ?")
      .get(accountId, positionTicket) as Row | null;
    const now = new Date().toISOString();
    const direction =
      action === "OPEN"
        ? directionFromOpenDealType(deal.type)
        : String(existing?.direction ?? "") || directionFromCloseDealType(deal.type);
    this.db
      .query(
        `INSERT INTO external_closes
          (account_id, position_ticket, symbol, direction, volume, pnl_currency, pnl_pips, source, magic, comment, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id, position_ticket) DO UPDATE SET
          symbol = excluded.symbol,
          direction = CASE WHEN external_closes.direction = '' THEN excluded.direction ELSE external_closes.direction END,
          volume = COALESCE(external_closes.volume, excluded.volume),
          pnl_currency = COALESCE(external_closes.pnl_currency, 0) + COALESCE(excluded.pnl_currency, 0),
          pnl_pips = COALESCE(external_closes.pnl_pips, 0) + COALESCE(excluded.pnl_pips, 0),
          source = excluded.source,
          magic = excluded.magic,
          comment = excluded.comment,
          updated_at = excluded.updated_at`,
      )
      .run(
        accountId,
        positionTicket,
        deal.symbol,
        direction,
        deal.volume ?? null,
        action === "OPEN" ? 0 : pnlCurrency,
        action === "OPEN" ? 0 : (pnlPips ?? 0),
        source,
        Number(deal.magic ?? 0),
        deal.comment ?? "",
        now,
        now,
      );

    if (action === "OPEN") {
      this.db
        .query(
          `UPDATE external_closes
           SET direction = ?,
               volume = ?,
               open_price = ?,
               open_at = ?,
               open_deal_ticket = ?,
               updated_at = ?
           WHERE account_id = ? AND position_ticket = ?`,
        )
        .run(
          directionFromOpenDealType(deal.type),
          deal.volume ?? null,
          deal.price ?? null,
          createdAt,
          deal.dealTicket,
          now,
          accountId,
          positionTicket,
        );
      return;
    }

    if (action === "FULL_CLOSE") {
      this.db
        .query(
          `UPDATE external_closes
           SET close_price = ?,
               close_at = ?,
               close_deal_ticket = ?,
               updated_at = ?
           WHERE account_id = ? AND position_ticket = ?`,
        )
        .run(deal.price ?? null, createdAt, deal.dealTicket, now, accountId, positionTicket);
    }
  }

  private originalOpenQueue(tradeId: string) {
    const row = this.db
      .query(
        `SELECT parsed_signal_id, payload_json FROM queue_items
         WHERE logical_trade_id = ?
           AND json_extract(payload_json, '$.commandType') = 'OPEN_TRADE'
         ORDER BY created_at ASC, rowid ASC LIMIT 1`,
      )
      .get(tradeId) as Row | null;
    if (!row) return undefined;
    return {
      parsedSignalId: String(row.parsed_signal_id),
      payload: parseJson<ExecutionQueueItem["payload"]>(String(row.payload_json)),
    };
  }

  private queueVirtualTpClose(
    trade: LogicalTrade,
    legNumber: number,
    positionTicket: string,
    triggerPrice: number,
  ) {
    if (
      this.hasLifecycleQueue(
        trade.id,
        (payload) =>
          payload.commandType === "CLOSE_PARTIAL" &&
          payload.partialClose?.kind === "TP_LEG" &&
          payload.partialClose.value === legNumber,
      )
    ) {
      return true;
    }
    const open = this.originalOpenQueue(trade.id);
    if (!open) return false;
    const leg = trade.legs.find((item) => item.leg === legNumber);
    if (!leg) return false;
    const plannedTp = open.payload.takeProfits.find((item) => item.leg === legNumber);
    const brokerOpenVolume = this.openVolumeForTrade(trade.id, positionTicket);
    const managedVolume = managedVirtualTpVolume(open.payload, brokerOpenVolume);
    const plannedVolume =
      plannedTp?.volume && plannedTp.volume > 0
        ? plannedTp.volume
        : Math.max(0, leg.allocationPercent);
    const plannedTotalByVolume = open.payload.takeProfits.reduce(
      (sum, target) => sum + Math.max(0, Number(target.volume) || 0),
      0,
    );
    const plannedTotal =
      plannedTotalByVolume > 0
        ? plannedTotalByVolume
        : trade.legs.reduce((sum, item) => sum + Math.max(0, item.allocationPercent), 0);
    const volume = virtualTpCloseVolume({
      plannedVolume,
      plannedTotal,
      managedVolume,
      brokerOpenVolume,
    });
    if (!volume || volume <= 0) return false;
    const item: ExecutionQueueItem = {
      id: `queue_${nanoid(10)}`,
      accountId: trade.accountId,
      logicalTradeId: trade.id,
      status: "PENDING",
      payload: {
        commandType: "CLOSE_PARTIAL",
        brokerSymbol: trade.symbol.brokerSymbol,
        canonicalSymbol: trade.symbol.canonicalSymbol,
        direction: trade.direction,
        partialClose: {
          kind: "TP_LEG",
          value: legNumber,
          allocationPercent: leg.allocationPercent,
          volume,
        },
        takeProfits: [],
        executionMode: "VIRTUAL_TP",
        volume: brokerOpenVolume ?? open.payload.volume,
        runner: open.payload.runner,
        targetPositionTicket: positionTicket,
        originalText: `App-managed TP${legNumber} hit at ${triggerPrice}`,
      },
    };
    this.insertQueueItem(item, open.parsedSignalId);
    this.audit("virtual-tp.hit", "info", "App-managed virtual TP queued a partial close", {
      logicalTradeId: trade.id,
      leg: legNumber,
      triggerPrice,
      positionTicket,
    });
    return true;
  }

  private latestPositionStop(trade: LogicalTrade, positionTicket: string) {
    const snapshot = trade.accountId ? this.liveMt5Snapshots.get(trade.accountId) : undefined;
    const position = snapshot?.positions.find(
      (item) => brokerTicketFromSnapshot(item) === positionTicket,
    );
    return {
      known: position !== undefined,
      stopLoss: brokerStopLossFromSnapshot(position),
    };
  }

  private activeModifySlFloor(trade: LogicalTrade, positionTicket: string) {
    const rows = this.db
      .query(
        `SELECT id, payload_json FROM queue_items
         WHERE logical_trade_id = ? AND status IN ('PENDING','LEASED')
         ORDER BY created_at, rowid`,
      )
      .all(trade.id) as Row[];
    let stopLoss: number | undefined;
    let queueItemId: string | undefined;
    for (const row of rows) {
      const payload = parseJson<ExecutionQueueItem["payload"]>(String(row.payload_json));
      if (payload.commandType !== "MODIFY_SL" || payload.targetPositionTicket !== positionTicket) {
        continue;
      }
      const value = Number(payload.newStopLoss ?? 0);
      if (
        Number.isFinite(value) &&
        value > 0 &&
        (stopLoss === undefined || this.improvesStop(trade, value, stopLoss))
      ) {
        stopLoss = value;
        queueItemId = String(row.id);
      }
    }
    return { stopLoss, queueItemId };
  }

  private effectiveStopFloor(
    trade: LogicalTrade,
    input: {
      positionTicket: string;
      brokerStateKnown: boolean;
      brokerStopLoss?: number;
    },
  ) {
    const candidates: number[] = [];
    if (input.brokerStopLoss !== undefined) candidates.push(input.brokerStopLoss);
    if (!input.brokerStateKnown && trade.stopLoss !== undefined && trade.stopLoss > 0) {
      candidates.push(trade.stopLoss);
    }
    const active = this.activeModifySlFloor(trade, input.positionTicket).stopLoss;
    if (active !== undefined) candidates.push(active);
    if (!candidates.length) return undefined;
    return trade.direction === "BUY" ? Math.max(...candidates) : Math.min(...candidates);
  }

  private improvesStop(trade: LogicalTrade, candidate: number, incumbent?: number) {
    if (!Number.isFinite(candidate) || candidate <= 0) return false;
    if (incumbent === undefined) return true;
    return trade.direction === "BUY" ? candidate > incumbent : candidate < incumbent;
  }

  private stopIsSatisfied(trade: LogicalTrade, incumbent: number | undefined, desired: number) {
    return (
      incumbent !== undefined &&
      Number.isFinite(incumbent) &&
      incumbent > 0 &&
      !this.improvesStop(trade, desired, incumbent)
    );
  }

  private stopCanBePlaced(trade: LogicalTrade, desired: number, marketPrice?: number) {
    if (!marketPrice || !Number.isFinite(marketPrice)) return false;
    return trade.direction === "BUY" ? desired < marketPrice : desired > marketPrice;
  }

  // Coalesces a set of reference legs into at most ONE MODIFY_SL at the most protective stop,
  // and returns the legs whose work is now real and may therefore be marked HIT. Shared by the
  // price-monitor path and the provider-announced path so both obey the same guarantees.
  private queueCoalescedReferenceStop(input: {
    trade: LogicalTrade;
    positionTicket: string;
    legs: Array<LogicalTrade["legs"][number]>;
    source: string;
    brokerStateKnown: boolean;
    brokerStopLoss?: number;
    marketPrice?: number;
  }): Set<number> {
    const resolved = new Set<number>();
    if (!input.legs.length) return resolved;
    const open = this.originalOpenQueue(input.trade.id);
    if (!open) return resolved;

    const existing = new Set(
      (
        this.db
          .query("SELECT leg FROM reference_stop_actions WHERE logical_trade_id = ?")
          .all(input.trade.id) as Row[]
      ).map((row) => Number(row.leg)),
    );
    const noChange: Array<{ leg: number; desired?: number }> = [];
    const computed: Array<{ leg: number; desired: number }> = [];
    for (const leg of input.legs) {
      if (existing.has(leg.leg)) {
        resolved.add(leg.leg);
        continue;
      }
      const strategy = leg.strategy;
      if (!strategy || strategy.kind === "no-change") {
        noChange.push({ leg: leg.leg });
        continue;
      }
      const stop = this.strategyStopPrice(input.trade, strategy);
      if (!stop) continue; // not computable yet; leave OPEN and retry
      computed.push({ leg: leg.leg, desired: stop });
    }

    let resolution: "QUEUED" | "SATISFIED" | undefined;
    let queueItemId: string | undefined;
    if (computed.length && input.brokerStateKnown) {
      const best = computed.reduce((current, candidate) =>
        this.improvesStop(input.trade, candidate.desired, current.desired) ? candidate : current,
      );
      if (this.stopIsSatisfied(input.trade, input.brokerStopLoss, best.desired)) {
        resolution = "SATISFIED";
      } else {
        const active = this.activeModifySlFloor(input.trade, input.positionTicket);
        if (this.stopIsSatisfied(input.trade, active.stopLoss, best.desired)) {
          resolution = "QUEUED";
          queueItemId = active.queueItemId;
        } else if (this.stopCanBePlaced(input.trade, best.desired, input.marketPrice)) {
          const legs = computed.map((item) => item.leg).sort((left, right) => left - right);
          queueItemId = this.queueModifySlAfterVirtualTp({
            trade: input.trade,
            positionTicket: input.positionTicket,
            newStopLoss: best.desired,
            parsedSignalId: open.parsedSignalId,
            idempotencyKey: `reference-stop:${input.trade.id}:${input.positionTicket}:${legs.join(",")}`,
            originalText: `App-managed reference TP${best.leg} SL strategy`,
            auditEvent: "virtual-tp.reference-sl-strategy",
            auditMessage: "Reference TP leg queued SL strategy",
            auditFields: {
              leg: best.leg,
              source: input.source,
              coalescedLegs: legs,
              brokerStopLoss: input.brokerStopLoss ?? null,
            },
          });
          resolution = "QUEUED";
        }
      }
    }

    const actions = [
      ...noChange.map((item) => ({ ...item, resolution: "NO_CHANGE" })),
      ...(resolution ? computed.map((item) => ({ ...item, resolution })) : []),
    ];
    const now = nowIso();
    for (const action of actions) {
      this.db
        .query(
          `INSERT INTO reference_stop_actions
             (logical_trade_id, leg, position_ticket, desired_stop_loss, resolution, queue_item_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(logical_trade_id, leg) DO NOTHING`,
        )
        .run(
          input.trade.id,
          action.leg,
          input.positionTicket,
          action.desired ?? null,
          action.resolution,
          queueItemId ?? null,
          now,
          now,
        );
      resolved.add(action.leg);
    }
    return resolved;
  }

  // Resolves every crossed 0%-allocation reference leg in one pass.
  //
  // A reference leg closes no volume; it exists to move the stop when price reaches its
  // target. Three properties this must hold, each of which is a money bug if broken:
  //
  //  - Coalesce. If price gaps through several reference legs, queue ONE MODIFY_SL at the
  //    most protective resulting stop. The queue also orders same-time stop work from less
  //    protective to more protective as a final execution-order safeguard.
  //  - Never regress. A strategy that computes a stop no better than the one the broker
  //    already holds is dropped, so a late or out-of-order leg cannot widen risk.
  //  - Only burn a leg once the work is real. A leg is marked HIT only when its strategy
  //    was queued, was already satisfied, or is a deliberate no-change. A leg whose stop
  //    price is not yet computable (market entry with no fill price recorded) stays OPEN
  //    and is retried on the next snapshot.
  //
  // Deliberately does not call queueRunnerManagementAfterFinalTp: a reference leg closes no
  // volume so it is never the final TP that hands the remainder to the runner.
  private applyCrossedReferenceLegs(input: {
    trade: LogicalTrade;
    positionTicket: string;
    price: number;
    marketPrice: number;
    openPrice?: number;
    point?: number;
    brokerStopLoss?: number;
  }): LogicalTrade {
    const { trade, positionTicket, price } = input;

    const crossedLegs: Array<LogicalTrade["legs"][number]> = [];
    const targetPriceByLeg = new Map<number, number>();
    for (const leg of trade.legs) {
      if (leg.status !== "OPEN" || !isReferenceVirtualTpLeg(leg)) continue;
      const targetPrice = virtualTpTargetPrice(trade, leg, input.openPrice, input.point);
      if (!targetPrice) continue;
      const crossed = trade.direction === "BUY" ? price >= targetPrice : price <= targetPrice;
      if (!crossed) continue;
      crossedLegs.push(leg);
      targetPriceByLeg.set(leg.leg, targetPrice);
    }
    if (!crossedLegs.length) return trade;

    return this.db.transaction(() => {
      const resolved = this.queueCoalescedReferenceStop({
        trade,
        positionTicket,
        legs: crossedLegs,
        source: "price-monitor",
        brokerStateKnown: true,
        brokerStopLoss: input.brokerStopLoss,
        marketPrice: input.marketPrice,
      });
      if (!resolved.size) return trade;

      const updated: LogicalTrade = {
        ...trade,
        legs: trade.legs.map((leg) =>
          resolved.has(leg.leg)
            ? {
                ...leg,
                status: "HIT" as const,
                brokerEvidence: `app favorable price ${price} crossed reference TP${leg.leg} ${targetPriceByLeg.get(leg.leg)}`,
              }
            : leg,
        ),
      };
      this.db
        .query("UPDATE logical_trades SET status = ?, data_json = ? WHERE id = ?")
        .run(updated.status, JSON.stringify(updated), updated.id);
      return updated;
    })();
  }

  private queueSlStrategyAfterTpClose(
    trade: LogicalTrade,
    legNumber: number,
    positionTicket: string,
  ) {
    const open = this.originalOpenQueue(trade.id);
    if (!open) return;
    const leg = trade.legs.find((item) => item.leg === legNumber);
    const strategy = leg?.strategy;
    if (strategy && strategy.kind !== "no-change") {
      const newStopLoss = this.strategyStopPrice(trade, strategy);
      const broker = this.latestPositionStop(trade, positionTicket);
      const floor = this.effectiveStopFloor(trade, {
        positionTicket,
        brokerStateKnown: broker.known,
        brokerStopLoss: broker.stopLoss,
      });
      if (newStopLoss && this.improvesStop(trade, newStopLoss, floor)) {
        this.queueModifySlAfterVirtualTp({
          trade,
          positionTicket,
          newStopLoss,
          parsedSignalId: open.parsedSignalId,
          idempotencyKey: `virtual-tp-stop:${trade.id}:${positionTicket}:leg:${legNumber}`,
          originalText: `App-managed TP${legNumber} SL strategy`,
          auditEvent: "virtual-tp.sl-strategy",
          auditMessage: "App-managed virtual TP queued SL strategy",
          auditFields: { leg: legNumber, stopFloor: floor ?? null },
        });
      }
    }

    this.queueRunnerManagementAfterFinalTp(trade, legNumber, positionTicket, open);
  }

  private queueModifySlAfterVirtualTp(input: {
    trade: LogicalTrade;
    positionTicket: string;
    newStopLoss: number;
    parsedSignalId: string;
    idempotencyKey: string;
    originalText: string;
    auditEvent: string;
    auditMessage: string;
    auditFields?: Record<string, unknown>;
  }) {
    const existing = this.db
      .query(
        `SELECT id FROM queue_items
         WHERE logical_trade_id = ?
           AND status IN ('PENDING','LEASED','HELD')
           AND json_extract(payload_json, '$.idempotencyKey') = ?
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(input.trade.id, input.idempotencyKey) as Row | null;
    if (existing) {
      return String(existing.id);
    }
    const item: ExecutionQueueItem = {
      id: `queue_${nanoid(10)}`,
      accountId: input.trade.accountId,
      logicalTradeId: input.trade.id,
      status: "PENDING",
      payload: {
        commandType: "MODIFY_SL",
        brokerSymbol: input.trade.symbol.brokerSymbol,
        canonicalSymbol: input.trade.symbol.canonicalSymbol,
        direction: input.trade.direction,
        newStopLoss: input.newStopLoss,
        takeProfits: [],
        executionMode: "VIRTUAL_TP",
        targetPositionTicket: input.positionTicket,
        idempotencyKey: input.idempotencyKey,
        originalText: input.originalText,
      },
    };
    this.insertQueueItem(item, input.parsedSignalId);
    this.audit(input.auditEvent, "info", input.auditMessage, {
      logicalTradeId: input.trade.id,
      newStopLoss: input.newStopLoss,
      positionTicket: input.positionTicket,
      ...(input.auditFields ?? {}),
    });
    return item.id;
  }

  private queueRunnerManagementAfterFinalTp(
    trade: LogicalTrade,
    legNumber: number,
    positionTicket: string,
    open: { parsedSignalId: string; payload: ExecutionQueueItem["payload"] },
  ) {
    const runner = open.payload.runner;
    if (!runner?.enabled || runner.lotSize <= 0) return;
    const nextLegs = trade.legs.map((leg) =>
      leg.leg === legNumber ? { ...leg, status: "CLOSED" as const } : leg,
    );
    // Reference legs close no volume, so they never reach CLOSED. Requiring them to would
    // block runner hand-off forever on any trade that uses a 0%-allocation stop trigger.
    const volumeLegs = nextLegs.filter((leg) => !isReferenceVirtualTpLeg(leg));
    if (!volumeLegs.length || volumeLegs.some((leg) => leg.status !== "CLOSED")) return;

    this.queueRunnerSlStrategy(trade, positionTicket, runner, open.parsedSignalId, nextLegs);
  }

  private queueRunnerSlStrategy(
    trade: LogicalTrade,
    positionTicket: string,
    runner: NonNullable<ExecutionQueueItem["payload"]["runner"]>,
    parsedSignalId: string,
    legs = trade.legs,
  ) {
    if (runner.slBehavior === "trail") {
      if (!runner.trailPips || runner.trailPips <= 0) return;
      if (
        this.hasLifecycleQueue(
          trade.id,
          (payload) =>
            payload.commandType === "TRAILING_STOP" &&
            payload.targetPositionTicket === positionTicket &&
            payload.trailingStop?.value === runner.trailPips &&
            payload.trailingStop.unit === "PIPS",
        )
      ) {
        return;
      }
      const item: ExecutionQueueItem = {
        id: `queue_${nanoid(10)}`,
        accountId: trade.accountId,
        logicalTradeId: trade.id,
        status: "PENDING",
        payload: {
          commandType: "TRAILING_STOP",
          brokerSymbol: trade.symbol.brokerSymbol,
          canonicalSymbol: trade.symbol.canonicalSymbol,
          direction: trade.direction,
          trailingStop: { value: runner.trailPips, unit: "PIPS" },
          takeProfits: [],
          executionMode: "VIRTUAL_TP",
          targetPositionTicket: positionTicket,
          originalText: "App-managed runner trailing stop",
        },
      };
      this.insertQueueItem(item, parsedSignalId);
      this.audit("virtual-tp.runner-trail", "info", "App-managed runner queued trailing stop", {
        logicalTradeId: trade.id,
        positionTicket,
        trailPips: runner.trailPips,
      });
      return;
    }

    const newStopLoss =
      runner.slBehavior === "last-tp"
        ? this.lastClosedVirtualTpPrice({ ...trade, legs })
        : (this.openPriceForTrade(trade.id) ??
          this.snapshotOpenPrice(trade.accountId, positionTicket));
    if (!newStopLoss) return;
    const broker = this.latestPositionStop(trade, positionTicket);
    const floor = this.effectiveStopFloor(trade, {
      positionTicket,
      brokerStateKnown: broker.known,
      brokerStopLoss: broker.stopLoss,
    });
    if (!this.improvesStop(trade, newStopLoss, floor)) return;
    this.queueModifySlAfterVirtualTp({
      trade,
      positionTicket,
      newStopLoss,
      parsedSignalId,
      idempotencyKey: `virtual-tp-runner-stop:${trade.id}:${positionTicket}`,
      originalText: "App-managed runner SL strategy",
      auditEvent: "virtual-tp.runner-sl",
      auditMessage: "App-managed runner queued SL strategy",
    });
  }

  private lastClosedVirtualTpPrice(trade: LogicalTrade) {
    const openPrice = this.openPriceForTrade(trade.id) ?? trade.entry?.from;
    for (const leg of trade.legs.slice().sort((left, right) => right.leg - left.leg)) {
      if (leg.status !== "CLOSED") continue;
      const price = virtualTpTargetPrice(trade, leg, openPrice);
      if (price) return price;
    }
    return undefined;
  }

  private hasLifecycleQueue(
    tradeId: string,
    matches: (payload: ExecutionQueueItem["payload"]) => boolean,
  ) {
    const rows = this.db
      .query(
        `SELECT status, payload_json FROM queue_items
         WHERE logical_trade_id = ?
         ORDER BY created_at DESC`,
      )
      .all(tradeId) as Row[];
    return rows.some((row) => {
      const status = String(row.status);
      if (!["PENDING", "LEASED", "EXECUTED"].includes(status)) return false;
      return matches(parseJson<ExecutionQueueItem["payload"]>(String(row.payload_json)));
    });
  }

  private strategyStopPrice(trade: LogicalTrade, strategy: TakeProfitStrategy) {
    const symbol = trade.symbol.brokerSymbol ?? trade.symbol.canonicalSymbol ?? "";
    const pipSize = brokerPipSize(symbol);
    const offset = strategy.kind === "no-change" ? 0 : strategy.offsetPips * pipSize;
    let basePrice = 0;
    if (strategy.kind === "set-sl-to-entry") {
      basePrice = this.openPriceForTrade(trade.id) ?? trade.entry?.from ?? 0;
    } else if (strategy.kind === "set-sl-to-tp") {
      const leg = trade.legs.find((item) => item.leg === strategy.tpLeg);
      basePrice = leg
        ? (virtualTpTargetPrice(
            trade,
            leg,
            this.openPriceForTrade(trade.id) ?? trade.entry?.from,
          ) ?? 0)
        : 0;
    }
    if (!basePrice) return undefined;
    const next = trade.direction === "BUY" ? basePrice + offset : basePrice - offset;
    return Number(next.toFixed(5));
  }

  private openPriceForTrade(tradeId: string) {
    const row = this.db
      .query(
        `SELECT filled_price, requested_price FROM broker_orders
         WHERE logical_trade_id = ?
           AND action = 'OPEN'
           AND position_ticket IS NOT NULL
           AND position_ticket NOT IN ('','0')
           AND filled_price IS NOT NULL
           AND filled_price > 0
         ORDER BY created_at ASC
         LIMIT 1`,
      )
      .get(tradeId) as Row | null;
    const filled = nullableNumber(row?.filled_price);
    if (filled && filled > 0) return filled;
    const requested = nullableNumber(row?.requested_price);
    return requested && requested > 0 ? requested : undefined;
  }

  private openVolumeForTrade(tradeId: string, positionTicket?: string) {
    if (truthyBrokerTicket(positionTicket)) {
      const exact = this.db
        .query(
          `SELECT COALESCE(SUM(filled_volume), 0) AS volume FROM broker_orders
           WHERE logical_trade_id = ?
             AND position_ticket = ?
             AND action = 'OPEN'
             AND filled_volume IS NOT NULL
             AND filled_volume > 0`,
        )
        .get(tradeId, positionTicket) as Row | null;
      const exactVolume = nullableNumber(exact?.volume);
      if (exactVolume && exactVolume > 0) return exactVolume;
    }
    const row = this.db
      .query(
        `SELECT COALESCE(SUM(filled_volume), 0) AS volume FROM broker_orders
         WHERE logical_trade_id = ?
           AND action = 'OPEN'
           AND position_ticket IS NOT NULL
           AND position_ticket NOT IN ('','0')
           AND filled_volume IS NOT NULL
           AND filled_volume > 0`,
      )
      .get(tradeId) as Row | null;
    const volume = nullableNumber(row?.volume);
    return volume && volume > 0 ? volume : undefined;
  }

  private closeVolumeBeforeDeal(
    tradeId: string,
    positionTicket: string | undefined,
    createdAt: string,
    currentDealTicket?: string,
    existingBrokerOrderId?: string,
  ) {
    const params = [tradeId];
    let ticketFilter = "";
    if (truthyBrokerTicket(positionTicket)) {
      ticketFilter = "AND position_ticket = ?";
      params.push(positionTicket);
    }
    const rows = this.db
      .query(
        `SELECT id, deal_ticket, filled_volume, created_at
         FROM broker_orders
         WHERE logical_trade_id = ?
           ${ticketFilter}
           AND action IN ('FULL_CLOSE','PARTIAL_CLOSE')
           AND filled_volume IS NOT NULL
           AND filled_volume > 0`,
      )
      .all(...params) as Row[];
    const currentTime = Date.parse(normalizedDateInput(createdAt));
    const currentDealNumber = numericTicket(currentDealTicket);
    return rows.reduce((sum, row) => {
      if (existingBrokerOrderId && String(row.id) === existingBrokerOrderId) return sum;
      const rowDealNumber = numericTicket(String(row.deal_ticket ?? ""));
      if (
        currentDealNumber !== null &&
        rowDealNumber !== null &&
        rowDealNumber < currentDealNumber
      ) {
        return sum + (nullableNumber(row.filled_volume) ?? 0);
      }
      const rowCreatedAt = String(row.created_at ?? "");
      const rowTime = Date.parse(normalizedDateInput(rowCreatedAt));
      if (Number.isFinite(currentTime)) {
        if (!Number.isFinite(rowTime) || rowTime >= currentTime) return sum;
      } else if (rowCreatedAt >= createdAt) {
        return sum;
      }
      return sum + (nullableNumber(row.filled_volume) ?? 0);
    }, 0);
  }

  private closeVolumeCoversOpen(
    tradeId: string,
    positionTicket: string | undefined,
    nextCloseVolume: number | undefined,
    createdAt: string,
    currentDealTicket?: string,
    existingBrokerOrderId?: string,
  ) {
    const openVolume = this.openVolumeForTrade(tradeId, positionTicket);
    const volume = nullableNumber(nextCloseVolume);
    if (!openVolume || !volume || volume <= 0) return false;
    return (
      this.closeVolumeBeforeDeal(
        tradeId,
        positionTicket,
        createdAt,
        currentDealTicket,
        existingBrokerOrderId,
      ) +
        volume >=
      openVolume - CLOSE_VOLUME_EPSILON
    );
  }

  private historyDealActionForTrade(
    tradeId: string,
    deal: Mt5HistoryDealInput,
    positionTicket: string,
    positionStillOpen: boolean,
    createdAt: string,
    existingBrokerOrderId?: string,
  ) {
    const action = historyDealAction(deal, positionStillOpen);
    if (action === "OPEN") return action;
    return this.closeVolumeCoversOpen(
      tradeId,
      positionTicket,
      deal.volume,
      createdAt,
      deal.dealTicket,
      existingBrokerOrderId,
    )
      ? "FULL_CLOSE"
      : "PARTIAL_CLOSE";
  }

  private reconcileHistoryDeal(
    tradeId: string,
    deal: Mt5HistoryDealInput,
    action: string,
    source: string,
    positionTicket: string,
  ) {
    const trade = this.logicalTrade(tradeId);
    if (!trade || trade.status === "ARCHIVED") return;
    const evidence = [source, deal.comment, deal.dealTicket ? `deal:${deal.dealTicket}` : ""]
      .filter(Boolean)
      .join(" | ");
    let updated: LogicalTrade = trade;
    let closedLeg: number | undefined;
    if (action === "OPEN") {
      if (trade.status === "CLOSED" || this.hasRecordedRealFullClose(tradeId)) return;
      updated = {
        ...trade,
        status: "OPEN",
        outOfSyncReason: undefined,
        livePositionExists: true,
        matchedBrokerTickets: positionTicket ? [positionTicket] : trade.matchedBrokerTickets,
        brokerComment: deal.comment,
        lastSnapshotAt: deal.time ?? new Date().toISOString(),
        legs: trade.legs.map((leg) =>
          leg.status === "PLANNED" ? { ...leg, status: "OPEN", brokerEvidence: evidence } : leg,
        ),
      };
    } else if (action === "PARTIAL_CLOSE") {
      const legId = historyDealLegId(deal);
      const match = legId.match(/^tp(\d)$/);
      closedLeg = match?.[1] ? Number(match[1]) : undefined;
      if (!closedLeg) return;
      const legs = trade.legs.map((leg) =>
        leg.leg === closedLeg
          ? { ...leg, status: "CLOSED" as const, brokerEvidence: evidence }
          : leg,
      );
      const openPayload = this.originalOpenQueue(trade.id)?.payload;
      updated = {
        ...trade,
        status: virtualTpStatusAfterLegClose(trade, legs, openPayload),
        legs,
      };
    } else if (action === "FULL_CLOSE") {
      updated = {
        ...trade,
        status: "CLOSED",
        livePositionExists: false,
        outOfSyncReason: undefined,
        matchedBrokerTickets: positionTicket ? [positionTicket] : trade.matchedBrokerTickets,
        brokerComment: deal.comment,
        lastSnapshotAt: deal.time ?? new Date().toISOString(),
        legs: trade.legs.map((leg) =>
          leg.status === "CLOSED"
            ? leg
            : { ...leg, status: "SKIPPED" as const, brokerEvidence: evidence },
        ),
      };
    }
    if (JSON.stringify(updated) !== JSON.stringify(trade)) {
      this.db
        .query("UPDATE logical_trades SET status = ?, data_json = ? WHERE id = ?")
        .run(updated.status, JSON.stringify(updated), trade.id);
    }
    if (closedLeg && positionTicket) {
      this.queueSlStrategyAfterTpClose(updated, closedLeg, positionTicket);
    }
  }

  mt5Accounts() {
    const snapshots = this.mt5SnapshotsByAccount();
    return (
      this.db
        .query(
          "SELECT id, account_number, nickname, server, company, currency, balance, equity, profit, initial_balance, margin_mode, heartbeat_status, available_symbols_json, ea_version, ea_capabilities_json, last_heartbeat_at, drawdown_warn_pct, drawdown_danger_pct FROM mt5_accounts ORDER BY account_number",
        )
        .all() as Row[]
    ).map((row) => {
      const snap = snapshots[String(row.id)];
      const positions = (snap?.positions ?? []) as Array<Record<string, unknown>>;
      const orders = (snap?.orders ?? []) as Array<Record<string, unknown>>;
      const isExternalFlag = (record: Record<string, unknown>) =>
        record.isExternal === true || record.isExternal === "true";
      const appPositionsRaw = positions.filter((p) => !isExternalFlag(p));
      const appOrdersRaw = orders.filter((o) => !isExternalFlag(o));
      const externalPositions = positions.filter(isExternalFlag).map(externalRecord);
      const externalOrders = orders.filter(isExternalFlag).map(externalRecord);
      // App positions go through the same `externalRecord` strip — the shape is
      // identical and the distinction is which array a row lives in, not what
      // fields it carries. UI uses this for the Open Positions table.
      const appPositions = appPositionsRaw.map(externalRecord);
      const appOrders = appOrdersRaw.map(externalRecord);
      // Surface the snapshot's per-symbol market quote so the UI can compute
      // "current price" for open positions (BUY closes at bid, SELL at ask).
      const symbols = (snap?.symbols ?? []) as Array<Record<string, unknown>>;
      const accountId = String(row.id);
      return {
        id: accountId,
        accountNumber: String(row.account_number),
        nickname: row.nickname ? String(row.nickname) : null,
        server: String(row.server),
        company: String(row.company),
        currency: String(row.currency),
        balance: Number(row.balance),
        equity: Number(row.equity),
        profit: nullableNumber(row.profit),
        initialBalance: Number(row.initial_balance ?? row.balance),
        marginMode: String(row.margin_mode),
        heartbeatStatus: heartbeatFreshness(String(row.last_heartbeat_at)),
        availableSymbols: parseJson<string[]>(String(row.available_symbols_json)),
        eaVersion: row.ea_version ? String(row.ea_version) : undefined,
        eaCapabilities: parseJson<string[]>(String(row.ea_capabilities_json ?? "[]")),
        lastHeartbeatAt: String(row.last_heartbeat_at),
        // Counts split into app-driven vs external so the UI can show both
        // without conflating manual positions with our auto-copy state.
        openPositionCount: appPositions.length,
        pendingOrderCount: appOrders.length,
        externalPositionCount: externalPositions.length,
        externalOrderCount: externalOrders.length,
        appPositions,
        appOrders,
        externalPositions,
        externalOrders,
        symbols,
        // Per-signal rollup for the History › Closed sub-tab. See
        // `closedTradesForAccount` for the shape; broker-level leg detail is
        // nested under each trade for the expand-row UX.
        closedTrades: this.closedTradesForAccount(accountId),
        externalCloses: this.externalClosesForAccount(accountId),
        lastSnapshotAt: snap?.updatedAt,
        drawdownWarnPctOverride: nullableNumber(row.drawdown_warn_pct) ?? null,
        drawdownDangerPctOverride: nullableNumber(row.drawdown_danger_pct) ?? null,
      };
    });
  }

  updateAccountNickname(accountId: string, value: string | null) {
    if (!this.mt5Accounts().some((account) => account.id === accountId)) {
      return { statusCode: 404 as const, error: "MT5 account not found" };
    }
    const nickname = typeof value === "string" ? value.trim() : "";
    if (nickname.length > 80) {
      return { statusCode: 400 as const, error: "Nickname must be 80 characters or fewer" };
    }
    this.db
      .query("UPDATE mt5_accounts SET nickname = ? WHERE id = ?")
      .run(nickname || null, accountId);
    this.audit("mt5.account.rename", "info", "MT5 account nickname updated", {
      accountId,
      nickname: nickname || null,
    });
    return { account: this.mt5Accounts().find((account) => account.id === accountId) };
  }

  accountSlots() {
    const expiryCutoff = Date.now() - 24 * 60 * 60 * 1000;
    const waiting = this.db
      .query("SELECT id, created_at FROM account_slots WHERE status = 'waiting'")
      .all() as Row[];
    for (const row of waiting) {
      const createdAt = Date.parse(String(row.created_at));
      if (!Number.isFinite(createdAt) || createdAt >= expiryCutoff) continue;
      this.db
        .query(
          "UPDATE account_slots SET status = ?, updated_at = ? WHERE id = ? AND status = 'waiting'",
        )
        .run("expired", nowIso(), String(row.id));
      this.audit("account-slot.expired", "warn", "Waiting MT5 account slot expired", {
        slotId: String(row.id),
      });
    }
    return (
      this.db
        .query(
          "SELECT id, name, link_code, status, account_id, account_number, server, broker, currency, balance, equity, last_heartbeat_at, created_at, updated_at FROM account_slots ORDER BY created_at DESC",
        )
        .all() as Row[]
    ).map((row) => ({
      id: String(row.id),
      name: String(row.name),
      linkCode: String(row.link_code),
      status: String(row.status),
      accountId: String(row.account_id ?? ""),
      accountNumber: String(row.account_number ?? ""),
      server: String(row.server ?? ""),
      broker: String(row.broker ?? ""),
      currency: String(row.currency ?? ""),
      balance: nullableNumber(row.balance),
      equity: nullableNumber(row.equity),
      lastHeartbeatAt: String(row.last_heartbeat_at ?? ""),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }));
  }

  accountProviderLinks() {
    return (
      this.db
        .query(
          "SELECT account_id, provider_id, enabled, updated_at, config_json FROM account_provider_links ORDER BY account_id, provider_id",
        )
        .all() as Row[]
    ).map((row) => ({
      accountId: String(row.account_id),
      providerId: String(row.provider_id),
      enabled: Boolean(row.enabled),
      updatedAt: String(row.updated_at),
      // Raw per-account config override (undefined = inherits the provider default).
      config: row.config_json
        ? parseJson<Partial<ProviderExecutionConfig>>(String(row.config_json))
        : undefined,
    }));
  }

  updateAccountProviderLink(accountId: string, providerId: string, enabled: boolean) {
    const now = new Date().toISOString();
    this.db
      .query(
        "INSERT INTO account_provider_links (account_id, provider_id, enabled, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(account_id, provider_id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at",
      )
      .run(accountId, providerId, Number(enabled), now);
    this.audit("account-provider-link.update", "info", "Account provider routing updated", {
      accountId,
      providerId,
      enabled,
    });
    return this.accountProviderLinks().find(
      (link) => link.accountId === accountId && link.providerId === providerId,
    );
  }

  private targetAccountIdsForProvider(providerId: string, fallback: string) {
    const links = this.accountProviderLinks().filter((link) => link.providerId === providerId);
    const enabled = links.filter((link) => link.enabled).map((link) => link.accountId);
    if (enabled.length) return [...new Set(enabled)];
    return links.length ? [] : [fallback];
  }

  createAccountSlot(name: string) {
    const now = new Date().toISOString();
    const slot = {
      id: `slot_${nanoid(10)}`,
      name: name?.trim() || "MT5 Account Slot",
      linkCode: nanoid(8).toUpperCase(),
      status: "waiting",
    };
    this.db
      .query(
        "INSERT INTO account_slots (id, name, link_code, status, account_id, account_number, server, broker, currency, balance, equity, last_heartbeat_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        slot.id,
        slot.name,
        slot.linkCode,
        slot.status,
        "",
        "",
        "",
        "",
        "",
        null,
        null,
        "",
        now,
        now,
      );
    return this.accountSlots().find((item) => item.id === slot.id);
  }

  deleteAccountSlot(id: string) {
    const slot = this.accountSlots().find((item) => item.id === id);
    if (!slot) return { statusCode: 404 as const, error: "Account slot not found" };
    if (slot.status !== "waiting" && slot.status !== "expired") {
      return {
        statusCode: 409 as const,
        error: "Only waiting or expired account slots can be deleted",
      };
    }
    this.db.query("DELETE FROM account_slots WHERE id = ?").run(id);
    this.audit(
      "account-slot.delete",
      "warn",
      "MT5 account slot deleted",
      {
        slotId: id,
        status: slot.status,
      },
      "operator",
    );
    return { slotId: id, status: "DELETED" as const };
  }

  rotateAccountSlot(id: string) {
    this.db
      .query("UPDATE account_slots SET link_code = ?, updated_at = ? WHERE id = ?")
      .run(nanoid(8).toUpperCase(), new Date().toISOString(), id);
    return this.accountSlots().find((item) => item.id === id);
  }

  unlinkAccountSlot(id: string) {
    this.db
      .query("UPDATE account_slots SET status = ?, account_id = '', updated_at = ? WHERE id = ?")
      .run("waiting", new Date().toISOString(), id);
    return this.accountSlots().find((item) => item.id === id);
  }

  private accountSlotByCode(linkCode: string) {
    return this.accountSlots().find((slot) => slot.linkCode === linkCode);
  }

  private attachAccountSlot(
    slotId: string,
    accountId: string,
    input: {
      accountNumber: string;
      server: string;
      company: string;
      currency: string;
      balance: number;
      equity: number;
    },
  ) {
    this.db
      .query(
        "UPDATE account_slots SET status = ?, account_id = ?, account_number = ?, server = ?, broker = ?, currency = ?, balance = ?, equity = ?, last_heartbeat_at = ?, updated_at = ? WHERE id = ?",
      )
      .run(
        "linked",
        accountId,
        input.accountNumber,
        input.server,
        input.company,
        input.currency,
        input.balance,
        input.equity,
        new Date().toISOString(),
        new Date().toISOString(),
        slotId,
      );
  }

  private ensureLegacyAccountSlot(
    accountId: string,
    input: {
      accountNumber: string;
      server: string;
      company: string;
      currency: string;
      balance: number;
      equity: number;
    },
  ) {
    const existing = this.accountSlots().find((slot) => slot.accountId === accountId);
    if (existing) return;
    const now = new Date().toISOString();
    this.db
      .query(
        "INSERT INTO account_slots (id, name, link_code, status, account_id, account_number, server, broker, currency, balance, equity, last_heartbeat_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        `slot_${nanoid(10)}`,
        "Unlinked smoke / legacy",
        nanoid(8).toUpperCase(),
        "legacy",
        accountId,
        input.accountNumber,
        input.server,
        input.company,
        input.currency,
        input.balance,
        input.equity,
        now,
        now,
        now,
      );
  }

  executionLogs(accountId?: string, limit?: number) {
    const boundedLimit = optionalPositiveInteger(limit, MAX_EXECUTION_LOG_LIMIT);
    const rows = accountId
      ? boundedLimit
        ? (this.db
            .query(
              "SELECT id, queue_item_id, account_id, status, retcode, retcode_external, broker_comment, order_ticket, position_ticket, deal_ticket, requested_price, filled_price, volume, error_text, created_at FROM execution_reports WHERE account_id = ? ORDER BY created_at DESC LIMIT ?",
            )
            .all(accountId, boundedLimit) as Row[])
        : (this.db
            .query(
              "SELECT id, queue_item_id, account_id, status, retcode, retcode_external, broker_comment, order_ticket, position_ticket, deal_ticket, requested_price, filled_price, volume, error_text, created_at FROM execution_reports WHERE account_id = ? ORDER BY created_at DESC",
            )
            .all(accountId) as Row[])
      : boundedLimit
        ? (this.db
            .query(
              "SELECT id, queue_item_id, account_id, status, retcode, retcode_external, broker_comment, order_ticket, position_ticket, deal_ticket, requested_price, filled_price, volume, error_text, created_at FROM execution_reports ORDER BY created_at DESC LIMIT ?",
            )
            .all(boundedLimit) as Row[])
        : (this.db
            .query(
              "SELECT id, queue_item_id, account_id, status, retcode, retcode_external, broker_comment, order_ticket, position_ticket, deal_ticket, requested_price, filled_price, volume, error_text, created_at FROM execution_reports ORDER BY created_at DESC",
            )
            .all() as Row[]);
    return rows.map((row) => this.executionLogFromRow(row));
  }

  private executionLogFromRow(row: Row) {
    return {
      id: String(row.id),
      queueItemId: String(row.queue_item_id),
      accountId: String(row.account_id),
      status: String(row.status),
      retcode: Number(row.retcode),
      retcodeExternal: Number(row.retcode_external),
      brokerComment: String(row.broker_comment),
      orderTicket: String(row.order_ticket),
      positionTicket: String(row.position_ticket ?? ""),
      dealTicket: String(row.deal_ticket),
      requestedPrice: row.requested_price === null ? undefined : Number(row.requested_price),
      filledPrice: row.filled_price === null ? undefined : Number(row.filled_price),
      volume: row.volume === null ? undefined : Number(row.volume),
      errorText: String(row.error_text),
      createdAt: String(row.created_at),
    };
  }

  executionLogDetails(reportId: string) {
    const row = this.db
      .query(
        "SELECT id, queue_item_id, account_id, status, retcode, retcode_external, broker_comment, order_ticket, position_ticket, deal_ticket, requested_price, filled_price, volume, error_text, created_at FROM execution_reports WHERE id = ?",
      )
      .get(reportId) as Row | null;
    if (!row) return { error: "Execution log not found" };
    const log = this.executionLogFromRow(row);
    const queue = this.db
      .query(
        "SELECT id, account_id, logical_trade_id, status, payload_json, leased_at, created_at FROM queue_items WHERE id = ?",
      )
      .get(String(row.queue_item_id)) as Row | null;
    const queueItem = queue ? queueRow(queue) : null;
    return {
      log,
      queueItem,
      brokerOrders: queueItem?.logicalTradeId ? this.brokerOrders(queueItem.logicalTradeId) : [],
    };
  }

  /**
   * Open VIRTUAL_TP plans for the given account. Kept as a diagnostics surface
   * and backward-compatible app API while the app owns virtual TP decisions.
   * Returns the original OPEN_TRADE payload, queue item id, matched broker
   * position ticket, and compact logical-trade id.
   */
  activeVirtualTpPlans(accountId: string) {
    const trades = this.logicalTrades().filter(
      (trade) =>
        trade.accountId === accountId &&
        trade.status === "OPEN" &&
        trade.executionMode === "VIRTUAL_TP" &&
        trade.legs.some((leg) => leg.status === "OPEN" || leg.status === "HIT"),
    );
    const plans: Array<{
      logicalTradeId: string;
      shortId: string;
      queueItemId: string;
      symbol: string;
      direction: string;
      positionTicket: string;
      payload: ExecutionQueueItem["payload"];
    }> = [];
    for (const trade of trades) {
      // Find the original OPEN_TRADE queue item (not subsequent lifecycle ones).
      const queueRow = this.db
        .query(
          `SELECT id, payload_json FROM queue_items
           WHERE logical_trade_id = ?
           ORDER BY created_at ASC LIMIT 1`,
        )
        .get(trade.id) as Row | null;
      if (!queueRow) continue;
      const payload = parseJson<ExecutionQueueItem["payload"]>(String(queueRow.payload_json));
      if (payload.commandType !== "OPEN_TRADE") continue;
      const openOrder = this.db
        .query(
          `SELECT position_ticket FROM broker_orders
           WHERE logical_trade_id = ?
             AND action = 'OPEN'
             AND position_ticket IS NOT NULL
             AND position_ticket NOT IN ('','0')
             AND filled_price IS NOT NULL
             AND filled_price > 0
           ORDER BY created_at ASC LIMIT 1`,
        )
        .get(trade.id) as Row | null;
      plans.push({
        logicalTradeId: trade.id,
        shortId: shortLogicalTradeId(trade.id),
        queueItemId: String(queueRow.id),
        symbol: payload.brokerSymbol ?? payload.canonicalSymbol ?? "",
        direction: payload.direction ?? "",
        positionTicket: String(openOrder?.position_ticket ?? ""),
        payload,
      });
    }
    return plans;
  }

  brokerOrders(logicalTradeId: string) {
    return (
      this.db
        .query(
          `SELECT id, logical_trade_id, leg_id, action, queue_item_id, account_id, order_ticket, position_ticket, deal_ticket,
            requested_volume, filled_volume, requested_price, filled_price, retcode, retcode_external, broker_comment, pnl_currency, pnl_pips, source, created_at
           FROM broker_orders WHERE logical_trade_id = ? ORDER BY created_at ASC`,
        )
        .all(logicalTradeId) as Row[]
    ).map((row) => this.brokerOrderFromRow(row));
  }

  cancelPendingTrade(tradeId: string) {
    const trade = this.logicalTrade(tradeId);
    if (!trade) return { statusCode: 404 as const, error: "Logical trade not found" };
    if (trade.status !== "PENDING") {
      return {
        statusCode: 409 as const,
        error: "Only PENDING trades can be cancelled; use close for open trades",
      };
    }
    if (!trade.accountId) return { statusCode: 409 as const, error: "Trade has no account" };

    const enrichedSignal = enrichLifecycleSignalFromTrade(
      {
        originalText: "Operator requested pending order cancellation",
        commandType: "CANCEL_PENDING",
        mappingStatus: trade.symbol.mappingStatus,
        mappingSource: trade.symbol.mappingSource,
        mappingWarnings: [],
        takeProfits: [],
        confidence: 1,
        matchedPatternIds: ["operator.cancel-pending"],
        missingFields: [],
        warnings: [],
        fingerprint: `operator-cancel:${trade.id}`,
      },
      trade,
    );
    const queueItemId = `queue_${nanoid(10)}`;
    const settings = this.appSettings();
    const queueItem = buildExecutionCommand(enrichedSignal, {
      id: queueItemId,
      accountId: trade.accountId,
      logicalTradeId: trade.id,
      executionMode: trade.executionMode ?? "VIRTUAL_TP",
      volume: settings.defaultLotSize,
      riskPercent: settings.defaultRiskPercent,
    });
    Object.assign(queueItem.payload, this.brokerTargetForCommand(trade.id, queueItem.payload));
    this.appendTradeCommand(trade.id, enrichedSignal);
    this.insertQueueItem(queueItem, "");
    this.audit(
      "trade.cancel-pending",
      "info",
      "Pending order cancel requested by operator",
      { tradeId, accountId: trade.accountId, queueItemId },
      "operator",
    );
    return { queueItemId, tradeId, accountId: trade.accountId, status: "CANCELLING" as const };
  }

  resolveTrade(tradeId: string, action?: string) {
    if (action !== "close_from_history" && action !== "readopt" && action !== "archive") {
      return {
        statusCode: 422 as const,
        error: 'Trade resolve action must be "close_from_history", "readopt", or "archive"',
      };
    }
    const trade = this.logicalTrade(tradeId);
    if (!trade) return { statusCode: 404 as const, error: "Logical trade not found" };
    if (trade.status !== "OUT_OF_SYNC") {
      return { statusCode: 409 as const, error: "Only OUT_OF_SYNC trades can be resolved" };
    }

    let updated: LogicalTrade;
    if (action === "archive") {
      updated = {
        ...trade,
        status: "ARCHIVED",
        livePositionExists: false,
        outOfSyncReason: undefined,
        matchedBrokerTickets: [],
        brokerComment: undefined,
        legs: trade.legs.map((leg) =>
          leg.status === "CLOSED" || leg.status === "HIT"
            ? leg
            : { ...leg, status: "SKIPPED" as const, brokerEvidence: "Archived by operator" },
        ),
      };
    } else if (action === "readopt") {
      const candidates = this.reconcilerCandidateBrokerTickets(trade);
      const snapshot = trade.accountId ? this.mt5SnapshotsByAccount()[trade.accountId] : undefined;
      const position = snapshot?.positions.find((record) =>
        candidates.includes(brokerTicketFromSnapshot(record)),
      );
      const positionTicket = position ? brokerTicketFromSnapshot(position) : "";
      if (!positionTicket) {
        return {
          statusCode: 409 as const,
          error: "No live broker position candidate is available for readopt",
        };
      }
      updated = {
        ...trade,
        status: "OPEN",
        livePositionExists: true,
        outOfSyncReason: undefined,
        matchedBrokerTickets: [positionTicket],
        brokerComment: brokerCommentFromSnapshot(position),
        lastSnapshotAt: snapshot?.updatedAt,
        legs: trade.legs.map((leg) =>
          leg.status === "CLOSED" || leg.status === "HIT"
            ? leg
            : {
                ...leg,
                status: "OPEN" as const,
                brokerEvidence: `Readopted ticket ${positionTicket}`,
              },
        ),
      };
    } else {
      const closeOrders = this.brokerOrders(tradeId).filter(
        (order) =>
          (order.action === "FULL_CLOSE" || order.action === "PARTIAL_CLOSE") &&
          order.source !== "manual" &&
          !order.source.startsWith("app-"),
      );
      if (closeOrders.length === 0) {
        return {
          statusCode: 409 as const,
          error: "No matching broker history close deal is available",
        };
      }
      const closedLegs = new Set(
        closeOrders
          .map((order) => parseLegIndex(order.legId))
          .filter((leg): leg is number => leg !== undefined),
      );
      const matchedBrokerTickets = [
        ...new Set(
          closeOrders
            .map((order) => order.positionTicket)
            .filter((ticket): ticket is string => truthyBrokerTicket(ticket)),
        ),
      ];
      updated = {
        ...trade,
        status: "CLOSED",
        livePositionExists: false,
        outOfSyncReason: undefined,
        matchedBrokerTickets: matchedBrokerTickets.length
          ? matchedBrokerTickets
          : trade.matchedBrokerTickets,
        legs: trade.legs.map((leg) =>
          closedLegs.has(leg.leg)
            ? { ...leg, status: "CLOSED" as const, brokerEvidence: "Resolved from broker history" }
            : { ...leg, status: "SKIPPED" as const, brokerEvidence: "No matching history deal" },
        ),
      };
    }
    this.db
      .query("UPDATE logical_trades SET status = ?, data_json = ? WHERE id = ?")
      .run(updated.status, JSON.stringify(updated), tradeId);
    this.audit(
      "logical-trade.resolved",
      "info",
      `Logical trade resolved via ${action}`,
      {
        logicalTradeId: tradeId,
        action,
        status: updated.status,
        matchedBrokerTickets: updated.matchedBrokerTickets,
      },
      "operator",
    );
    this.emitEvent({
      type: "reconciliation",
      tradeId,
      accountId: trade.accountId,
      to: updated.status,
    });
    return {
      tradeId,
      action,
      status: updated.status,
      matchedBrokerTickets: updated.matchedBrokerTickets ?? [],
    };
  }

  private reconcilerCandidateBrokerTickets(trade: LogicalTrade) {
    const tickets = new Set(
      (trade.matchedBrokerTickets ?? []).filter((ticket) => truthyBrokerTicket(ticket)),
    );
    for (const ticket of this.brokerPositionTicketsForTrade(trade.id)) tickets.add(ticket);
    const snapshot = trade.accountId ? this.mt5SnapshotsByAccount()[trade.accountId] : undefined;
    const match = snapshot
      ? matchedBrokerRecordForTrade(snapshot.positions, trade, tickets)
      : undefined;
    const ticket = match ? brokerTicketFromSnapshot(match) : "";
    if (ticket) tickets.add(ticket);
    return [...tickets];
  }

  private brokerPositionTicketsForTrade(tradeId: string) {
    return (
      this.db
        .query(
          `SELECT position_ticket FROM broker_orders
           WHERE logical_trade_id = ?
             AND action = 'OPEN'
             AND position_ticket IS NOT NULL
             AND position_ticket NOT IN ('', '0')`,
        )
        .all(tradeId) as Row[]
    )
      .map((row) => String(row.position_ticket))
      .filter((ticket) => truthyBrokerTicket(ticket));
  }

  private brokerOrderFromRow(row: Row) {
    return {
      id: String(row.id),
      logicalTradeId: String(row.logical_trade_id),
      legId: String(row.leg_id),
      action: String(row.action),
      queueItemId: String(row.queue_item_id),
      accountId: String(row.account_id),
      orderTicket: String(row.order_ticket ?? ""),
      positionTicket: String(row.position_ticket ?? ""),
      dealTicket: String(row.deal_ticket ?? ""),
      requestedVolume: nullableNumber(row.requested_volume),
      filledVolume: nullableNumber(row.filled_volume),
      requestedPrice: nullableNumber(row.requested_price),
      filledPrice: nullableNumber(row.filled_price),
      retcode: Number(row.retcode),
      retcodeExternal: Number(row.retcode_external),
      brokerComment: String(row.broker_comment),
      pnlCurrency: nullableNumber(row.pnl_currency),
      pnlPips: nullableNumber(row.pnl_pips),
      source: String(row.source),
      createdAt: String(row.created_at),
    };
  }

  accountPerformance(accounts = this.mt5Accounts()) {
    const settings = this.appSettings();
    if (usesMixedCurrencies(accounts)) {
      return this.aggregateAccountPerformance(accounts, settings);
    }
    const primary = this.primaryAccount(accounts);
    if (!primary) {
      return {
        currency: settings.reportingCurrency,
        heartbeatStatus: "offline",
        lastHeartbeatAt: null,
        initialBalance: null,
        currentBalance: null,
        currentEquity: null,
        currentProfit: null,
        totalProfit: null,
        realizedPnl: null,
        floatingPnl: null,
        netDeposits: null,
        today: null,
        thisWeek: null,
        thisMonth: null,
        equityCurve: [],
        monthlyReturns: [],
      };
    }
    const initial = primary.initialBalance || primary.balance;
    const accountOrders = this.brokerOrdersForAccount(primary.id);
    const realizedPnl = sumPnl(accountOrders);
    const isOnline = primary.heartbeatStatus === "online";
    const brokerFloatingPnl = isOnline ? nullableNumber(primary.profit) : null;
    const floatingPnl = isOnline
      ? (brokerFloatingPnl ??
        roundCurrency(
          Number.isFinite(primary.equity) && Number.isFinite(primary.balance)
            ? primary.equity - primary.balance
            : floatingPnlFromPositions(this.mt5SnapshotsByAccount()[primary.id]?.positions ?? []),
        ))
      : null;
    const totalProfit = floatingPnl === null ? null : roundCurrency(realizedPnl + floatingPnl);
    const netDeposits =
      isOnline && totalProfit !== null
        ? roundCurrency(primary.equity - initial - totalProfit)
        : null;
    const today = sumPnl(accountOrders.filter((order) => withinCurrentDay(order.createdAt)));
    const thisWeek = sumPnl(accountOrders.filter((order) => withinDays(order.createdAt, 7)));
    const thisMonth = sumPnl(accountOrders.filter((order) => withinCurrentMonth(order.createdAt)));
    return {
      accountId: primary.id,
      currency: primary.currency,
      heartbeatStatus: primary.heartbeatStatus,
      lastHeartbeatAt: primary.lastHeartbeatAt,
      initialBalance: initial,
      currentBalance: isOnline ? primary.balance : null,
      currentEquity: isOnline ? primary.equity : null,
      currentProfit: floatingPnl,
      totalProfit,
      realizedPnl,
      floatingPnl,
      netDeposits,
      today,
      thisWeek,
      thisMonth,
      equityCurve: capEquityCurve(this.equityCurve(primary.id, initial, accountOrders)),
      monthlyReturns: this.monthlyReturns(primary.id, initial, accountOrders, floatingPnl ?? 0),
    };
  }

  private aggregateAccountPerformance(
    accounts: ReturnType<AppStore["mt5Accounts"]>,
    settings: AppSettings,
  ) {
    const currency = settings.reportingCurrency;
    const heartbeatStatus = aggregateHeartbeatStatus(
      accounts.map((account) => account.heartbeatStatus),
    );
    const lastHeartbeatAt =
      accounts
        .map((account) => account.lastHeartbeatAt)
        .sort()
        .reverse()[0] ?? null;
    const unsupportedCurrencies = accounts
      .map((account) => normalizedMoneyCurrency(account.currency))
      .filter((accountCurrency) => !canConvertMoneyCurrency(accountCurrency));
    if (unsupportedCurrencies.length > 0) {
      return {
        accountId: "aggregate",
        currency,
        heartbeatStatus,
        lastHeartbeatAt,
        initialBalance: null,
        currentBalance: null,
        currentEquity: null,
        currentProfit: null,
        totalProfit: null,
        realizedPnl: null,
        floatingPnl: null,
        netDeposits: null,
        today: null,
        thisWeek: null,
        thisMonth: null,
        equityCurve: [],
        monthlyReturns: [],
      };
    }
    const convert = (value: number | null | undefined, fromCurrency: string) =>
      convertMoney(value, fromCurrency, currency, settings.usdZarRate);
    const accountOrders = accounts.flatMap((account) =>
      this.brokerOrdersForAccount(account.id).map((order) => ({
        ...order,
        pnlCurrency: convert(order.pnlCurrency, account.currency),
      })),
    );
    const initial = roundCurrency(
      accounts.reduce(
        (sum, account) =>
          sum + convert(account.initialBalance || account.balance, account.currency),
        0,
      ),
    );
    const liveAccounts = accounts.filter((account) => account.heartbeatStatus === "online");
    const allOnline = accounts.length > 0 && liveAccounts.length === accounts.length;
    const realizedPnl = sumPnl(accountOrders);
    const floatingPnl = allOnline
      ? roundCurrency(
          accounts.reduce((sum, account) => {
            const brokerFloatingPnl = nullableNumber(account.profit);
            const fallbackFloatingPnl = roundCurrency(
              Number.isFinite(account.equity) && Number.isFinite(account.balance)
                ? account.equity - account.balance
                : floatingPnlFromPositions(
                    this.mt5SnapshotsByAccount()[account.id]?.positions ?? [],
                  ),
            );
            return sum + convert(brokerFloatingPnl ?? fallbackFloatingPnl, account.currency);
          }, 0),
        )
      : null;
    const totalProfit = floatingPnl === null ? null : roundCurrency(realizedPnl + floatingPnl);
    const currentBalance = allOnline
      ? roundCurrency(
          accounts.reduce((sum, account) => sum + convert(account.balance, account.currency), 0),
        )
      : null;
    const currentEquity = allOnline
      ? roundCurrency(
          accounts.reduce((sum, account) => sum + convert(account.equity, account.currency), 0),
        )
      : null;
    const netDeposits =
      allOnline && currentEquity !== null && totalProfit !== null
        ? roundCurrency(currentEquity - initial - totalProfit)
        : null;
    return {
      accountId: "aggregate",
      currency,
      heartbeatStatus,
      lastHeartbeatAt,
      initialBalance: initial,
      currentBalance,
      currentEquity,
      currentProfit: floatingPnl,
      totalProfit,
      realizedPnl,
      floatingPnl,
      netDeposits,
      today: sumPnl(accountOrders.filter((order) => withinCurrentDay(order.createdAt))),
      thisWeek: sumPnl(accountOrders.filter((order) => withinDays(order.createdAt, 7))),
      thisMonth: sumPnl(accountOrders.filter((order) => withinCurrentMonth(order.createdAt))),
      equityCurve: capEquityCurve(aggregateEquityCurve(initial, accountOrders, floatingPnl ?? 0)),
      monthlyReturns: aggregateMonthlyReturns(initial, accountOrders, floatingPnl ?? 0),
    };
  }

  providerPerformance(accountId?: string, accounts = this.mt5Accounts()) {
    const settings = this.appSettings();
    const accountsById = new Map(accounts.map((account) => [account.id, account]));
    const providerCurrency = accountId
      ? (accountsById.get(accountId)?.currency ?? settings.reportingCurrency)
      : settings.reportingCurrency;
    const convertForAccount = (value: number | null | undefined, sourceAccountId?: string) => {
      if (accountId) return roundCurrency(value ?? 0);
      const sourceCurrency = sourceAccountId
        ? (accountsById.get(sourceAccountId)?.currency ?? providerCurrency)
        : providerCurrency;
      return convertMoney(value, sourceCurrency, settings.reportingCurrency, settings.usdZarRate);
    };
    const initialBalanceDenominator = accountId
      ? (accounts.find((account) => account.id === accountId)?.initialBalance ?? 0)
      : accounts.reduce(
          (sum, account) =>
            sum +
            convertMoney(
              account.initialBalance ?? 0,
              account.currency,
              settings.reportingCurrency,
              settings.usdZarRate,
            ),
          0,
        );
    return this.providers().map((provider) => {
      const trades = this.logicalTrades().filter(
        (trade) =>
          trade.providerId === provider.id && (!accountId || trade.accountId === accountId),
      );
      const ordersByTrade = new Map(
        trades.map((trade) => [
          trade.id,
          this.brokerOrders(trade.id).map((order) => ({
            ...order,
            pnlCurrency: convertForAccount(order.pnlCurrency, trade.accountId),
          })),
        ]),
      );
      const orders = [...ordersByTrade.values()].flat();
      const pnl = orders.reduce((sum, order) => sum + (order.pnlCurrency ?? 0), 0);
      const pips = orders.reduce((sum, order) => sum + (order.pnlPips ?? 0), 0);
      const pnlByTrade = trades.map((trade) => sumPnl(ordersByTrade.get(trade.id) ?? []));
      const closed = pnlByTrade.filter((value) => value !== 0);
      const copiedDrawdown = this.maxCurveDrawdown("provider", accountId, provider.id);
      const totalVolume = orders.reduce(
        (sum, order) => sum + (order.requestedVolume ?? order.filledVolume ?? 0),
        0,
      );
      const gain = Number((pnl / Math.max(1, totalVolume)).toFixed(2));
      const gainPct =
        initialBalanceDenominator > 0
          ? Number(((pnl / initialBalanceDenominator) * 100).toFixed(2))
          : 0;
      return {
        id: provider.id,
        title: provider.title,
        currency: providerCurrency,
        lots: provider.lotSize,
        tradeCount: trades.length,
        pips,
        pnl,
        profit: pnl,
        gain,
        gainPct,
        winRate: closed.length ? closed.filter((value) => value > 0).length / closed.length : 0,
        averageDrawdown: this.averageCurveDrawdown("provider", accountId, provider.id),
        copiedDrawdown,
      };
    });
  }

  providerPerformanceCsv(accountId?: string) {
    const accounts = this.mt5Accounts();
    const links = this.accountProviderLinks();
    const rows = this.providerPerformance(accountId);
    const header = [
      "title",
      "enabled",
      "linked_accounts",
      "lots",
      "pips",
      "win_rate",
      "avg_drawdown",
      "p_l",
      "profit",
      "gain",
      "trade_count",
      "copied_drawdown",
      "gain_pct",
    ];
    const lines = rows.map((row) => {
      const provider = this.providers().find((item) => item.id === row.id);
      const linked = links
        .filter(
          (link) =>
            link.providerId === row.id &&
            link.enabled &&
            (!accountId || link.accountId === accountId),
        )
        .map(
          (link) =>
            accounts.find((account) => account.id === link.accountId)?.accountNumber ??
            link.accountId,
        );
      return [
        row.title,
        provider?.enabled ? "true" : "false",
        linked.join("; "),
        row.lots,
        roundCurrency(row.pips),
        Number((row.winRate * 100).toFixed(2)),
        row.averageDrawdown,
        roundCurrency(row.pnl),
        roundCurrency(row.profit),
        row.gain,
        row.tradeCount,
        row.copiedDrawdown,
        row.gainPct,
      ]
        .map(csvCell)
        .join(",");
    });
    return `${header.join(",")}\n${lines.join("\n")}${lines.length ? "\n" : ""}`;
  }

  accountStats(
    accountId: string,
    input: { range?: string; scope?: string; providerId?: string } = {},
  ) {
    const range = normalizeStatsRange(input.range);
    const providerId = input.providerId?.trim() || "";
    const scope: EquityCurveScope =
      input.scope === "provider" && providerId ? "provider" : "account";
    const from = statsRangeStart(range);
    const account = this.mt5Accounts().find((item) => item.id === accountId);
    const trades = this.closedTradeStats(accountId, { from, providerId, scope });
    const totalPnl = roundCurrency(trades.reduce((sum, trade) => sum + trade.pnl, 0));
    const wins = trades.filter((trade) => trade.pnl > 0);
    const losses = trades.filter((trade) => trade.pnl < 0);
    const breakEven = trades.filter((trade) => trade.pnl === 0);
    const grossProfit = roundCurrency(wins.reduce((sum, trade) => sum + trade.pnl, 0));
    const grossLoss = roundCurrency(losses.reduce((sum, trade) => sum + trade.pnl, 0));
    const averageWin = wins.length ? roundCurrency(grossProfit / wins.length) : 0;
    const averageLoss = losses.length ? roundCurrency(grossLoss / losses.length) : 0;
    const expectancy = trades.length ? roundCurrency(totalPnl / trades.length) : 0;
    const byDay = pnlByCalendarDay(trades);
    const byWeekday = pnlByWeekday(trades);
    const risk = this.curveRiskStats(scope, accountId, scope === "provider" ? providerId : "");
    risk.recoveryFactor =
      risk.maxDrawdown > 0 ? Number((totalPnl / risk.maxDrawdown).toFixed(2)) : 0;
    const initial = account?.initialBalance || account?.balance || 0;
    const durations = trades
      .map((trade) => trade.durationMinutes)
      .filter((value): value is number => value !== undefined && Number.isFinite(value));
    return {
      accountId,
      providerId: scope === "provider" ? providerId : undefined,
      scope,
      range,
      currency: account?.currency ?? "$",
      generatedAt: nowIso(),
      profitReturn: {
        totalPnl,
        roiPercent: initial > 0 ? Number(((totalPnl / initial) * 100).toFixed(2)) : 0,
        bestDay: bestMapValue(byDay),
        worstDay: worstMapValue(byDay),
      },
      winLoss: {
        wins: wins.length,
        losses: losses.length,
        breakEven: breakEven.length,
        winRate: trades.length ? Number((wins.length / trades.length).toFixed(4)) : 0,
        averageWin,
        averageLoss,
      },
      riskDrawdown: risk,
      quality: {
        profitFactor:
          grossLoss < 0
            ? Number((grossProfit / Math.abs(grossLoss)).toFixed(2))
            : grossProfit > 0
              ? 999
              : 0,
        grossProfit,
        grossLoss,
        averageTrade: expectancy,
        expectancy,
      },
      streaks: streakStats(trades),
      timing: {
        averageTradeMinutes: durations.length
          ? Number((durations.reduce((sum, value) => sum + value, 0) / durations.length).toFixed(1))
          : 0,
        bestWeekday: bestMapKey(byWeekday),
        worstWeekday: worstMapKey(byWeekday),
      },
      riskThresholds: this.resolveRiskThresholds(accountId),
    };
  }

  accountAttribution(accountId: string, input: { range?: string } = {}) {
    const range = normalizeStatsRange(input.range);
    const from = statsRangeStart(range);
    const account = this.mt5Accounts().find((item) => item.id === accountId);
    const logicalTrades = new Map(this.logicalTrades().map((trade) => [trade.id, trade]));
    const providers = new Map(this.providers().map((provider) => [provider.id, provider.title]));
    const externalRows = new Map(
      (
        this.db
          .query(
            `SELECT position_ticket, symbol, direction, open_at, close_at
             FROM external_closes
             WHERE account_id = ?`,
          )
          .all(accountId) as Row[]
      ).map((row) => [
        String(row.position_ticket),
        {
          symbol: String(row.symbol ?? ""),
          direction: String(row.direction ?? ""),
          openAt: nullableString(row.open_at),
          closeAt: nullableString(row.close_at),
        },
      ]),
    );
    const grouped = new Map<
      string,
      {
        tradeId: string;
        bucket: AccountAttributionBucket;
        providerId?: string;
        providerTitle?: string;
        symbol: string;
        direction: string;
        pnl: number;
        closeAt: string;
        openAt?: string;
        closeSources: string[];
        allSources: string[];
      }
    >();
    const allOrders = this.brokerOrdersForAccount(accountId);
    const openTimes = new Map<string, string>();
    const allSourcesByTrade = new Map<string, Set<string>>();
    const positionsByTrade = new Map<string, Set<string>>();
    for (const order of allOrders) {
      if (!allSourcesByTrade.has(order.logicalTradeId)) {
        allSourcesByTrade.set(order.logicalTradeId, new Set());
      }
      allSourcesByTrade.get(order.logicalTradeId)?.add(order.source);
      if (order.positionTicket) {
        if (!positionsByTrade.has(order.logicalTradeId)) {
          positionsByTrade.set(order.logicalTradeId, new Set());
        }
        positionsByTrade.get(order.logicalTradeId)?.add(order.positionTicket);
      }
      if (order.action === "OPEN") {
        const current = openTimes.get(order.logicalTradeId);
        if (!current || order.createdAt < current) {
          openTimes.set(order.logicalTradeId, order.createdAt);
        }
      }
    }

    for (const order of allOrders) {
      if (order.action !== "FULL_CLOSE" && order.action !== "PARTIAL_CLOSE") continue;
      if (from && Date.parse(normalizedDateInput(order.createdAt)) < Date.parse(from)) continue;
      const trade = logicalTrades.get(order.logicalTradeId);
      const sources = [...(allSourcesByTrade.get(order.logicalTradeId) ?? new Set<string>())];
      const bucket = attributionBucketForTrade(order.logicalTradeId, trade, sources);
      const providerTitle = trade?.providerId ? providers.get(trade.providerId) : undefined;
      const external = externalSummaryForTrade(
        positionsByTrade.get(order.logicalTradeId) ?? new Set<string>(),
        externalRows,
      );
      const current = grouped.get(order.logicalTradeId) ?? {
        tradeId: order.logicalTradeId,
        bucket,
        providerId: trade?.providerId,
        providerTitle,
        symbol:
          trade?.symbol.brokerSymbol ??
          trade?.symbol.canonicalSymbol ??
          external?.symbol ??
          "unmapped",
        direction: trade?.direction ?? external?.direction ?? "",
        pnl: 0,
        closeAt: order.createdAt,
        openAt: openTimes.get(order.logicalTradeId) ?? external?.openAt,
        closeSources: [],
        allSources: sources,
      };
      current.pnl = roundCurrency(current.pnl + (order.pnlCurrency ?? 0));
      if (order.createdAt > current.closeAt) current.closeAt = order.createdAt;
      if (!current.openAt && external?.openAt) current.openAt = external.openAt;
      current.closeSources.push(order.source);
      grouped.set(order.logicalTradeId, current);
    }

    const trades = [...grouped.values()].map((trade) => {
      const closeReason = deriveCloseResult(trade.closeSources);
      const source = primaryAttributionSource(trade.closeSources);
      const displayId = trade.tradeId.startsWith("external_")
        ? trade.tradeId.replace(/^external_/, "external-").replaceAll("_", "-")
        : trade.tradeId;
      return {
        ...trade,
        displayId,
        source,
        sourceLabel:
          trade.bucket === "provider"
            ? `Provider: ${trade.providerTitle ?? trade.providerId ?? "Unknown"}`
            : brokerSourceLabel(source),
        closeReason,
      };
    });

    const totals = {
      totalPnl: roundCurrency(trades.reduce((sum, trade) => sum + trade.pnl, 0)),
      providerPnl: sumBucketPnl(trades, "provider"),
      manualExternalPnl: sumBucketPnl(trades, "manual_external"),
      unknownEaPnl: sumBucketPnl(trades, "unknown_ea"),
    };
    const bucketLabels: Record<AccountAttributionBucket, string> = {
      provider: "Provider-linked",
      manual_external: "Manual / external",
      unknown_ea: "Unknown / EA",
    };
    const attributionRows = (
      ["provider", "manual_external", "unknown_ea"] as AccountAttributionBucket[]
    ).map((bucket) => {
      const rows = trades.filter((trade) => trade.bucket === bucket);
      return {
        bucket,
        label: bucketLabels[bucket],
        tradeCount: rows.length,
        pnl: roundCurrency(rows.reduce((sum, trade) => sum + trade.pnl, 0)),
      };
    });
    const sourceGroups = new Map<string, { source: string; tradeCount: number; pnl: number }>();
    for (const trade of trades) {
      const current = sourceGroups.get(trade.source) ?? {
        source: trade.source,
        tradeCount: 0,
        pnl: 0,
      };
      current.tradeCount += 1;
      current.pnl = roundCurrency(current.pnl + trade.pnl);
      sourceGroups.set(trade.source, current);
    }
    const sourceBreakdown = [...sourceGroups.values()]
      .map((row) => ({ ...row, label: brokerSourceLabel(row.source) }))
      .sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl) || a.label.localeCompare(b.label));
    const losses = trades
      .filter((trade) => trade.pnl < 0)
      .sort((a, b) => a.pnl - b.pnl)
      .slice(0, 5);
    const wins = trades
      .filter((trade) => trade.pnl > 0)
      .sort((a, b) => b.pnl - a.pnl)
      .slice(0, 5);
    const breakEven = trades.filter((trade) => trade.pnl === 0).slice(0, 5);
    const topTrades = [...losses, ...wins, ...breakEven]
      .sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl) || b.closeAt.localeCompare(a.closeAt))
      .slice(0, 10)
      .map((trade) => ({
        tradeId: trade.displayId,
        bucket: trade.bucket,
        providerId: trade.providerId,
        providerTitle: trade.providerTitle,
        source: trade.source,
        sourceLabel: trade.sourceLabel,
        closeReason: trade.closeReason,
        symbol: trade.symbol,
        direction: trade.direction,
        pnl: trade.pnl,
        openAt: trade.openAt,
        closeAt: trade.closeAt,
      }));
    return {
      accountId,
      range,
      currency: account?.currency ?? "$",
      generatedAt: nowIso(),
      totals,
      attributionRows,
      sourceBreakdown,
      topTrades,
    };
  }

  private resolveRiskThresholds(accountId: string): {
    warnPct: number;
    dangerPct: number;
    accountWarnPct: number | null;
    accountDangerPct: number | null;
  } {
    const globals = this.appSettings();
    const row = this.db
      .query(`SELECT drawdown_warn_pct, drawdown_danger_pct FROM mt5_accounts WHERE id = ?`)
      .get(accountId) as Row | null;
    const accountWarn = nullableNumber(row?.drawdown_warn_pct);
    const accountDanger = nullableNumber(row?.drawdown_danger_pct);
    const warnPct = accountWarn ?? globals.drawdownWarnPct;
    const dangerPct = Math.max(accountDanger ?? globals.drawdownDangerPct, warnPct);
    return {
      warnPct,
      dangerPct,
      accountWarnPct: accountWarn ?? null,
      accountDangerPct: accountDanger ?? null,
    };
  }

  updateAccountRiskThresholds(
    accountId: string,
    input: { warnPct?: number | null; dangerPct?: number | null },
  ) {
    const row = this.db
      .query(`SELECT id, drawdown_warn_pct, drawdown_danger_pct FROM mt5_accounts WHERE id = ?`)
      .get(accountId) as Row | null;
    if (!row) return null;
    const hasWarn = hasOwn(input, "warnPct");
    const hasDanger = hasOwn(input, "dangerPct");
    const currentWarn = nullableNumber(row.drawdown_warn_pct) ?? null;
    const currentDanger = nullableNumber(row.drawdown_danger_pct) ?? null;
    const warn = hasWarn
      ? input.warnPct === null
        ? null
        : clampPercent(input.warnPct, 0)
      : currentWarn;
    let danger = hasDanger
      ? input.dangerPct === null
        ? null
        : clampPercent(input.dangerPct, 0)
      : currentDanger;
    if (warn !== null && danger !== null && danger < warn) {
      danger = warn;
    }
    this.db
      .query(`UPDATE mt5_accounts SET drawdown_warn_pct = ?, drawdown_danger_pct = ? WHERE id = ?`)
      .run(warn, danger, accountId);
    this.audit("accounts.risk-thresholds.update", "info", `Risk thresholds updated`, {
      accountId,
      warnPct: warn,
      dangerPct: danger,
    });
    return this.resolveRiskThresholds(accountId);
  }

  private recordEquityCurveSamples(
    input: {
      accountId: string;
      balance: number;
      equity: number;
      profit?: number;
    },
    sampledAt: string,
  ) {
    const accountContributor = {
      brokerProfit: input.profit ?? null,
      externalFloatingPnl: this.externalFloatingPnl(input.accountId),
    };
    const accountState = this.updateEquityCurveState({
      scope: "account",
      accountId: input.accountId,
      providerId: "",
      value: input.equity,
      initialPeak: input.balance,
      sampledAt,
      contributor: accountContributor,
    });
    this.upsertEquityCurvePoint({
      scope: "account",
      accountId: input.accountId,
      providerId: "",
      bucketStart: minuteBucket(sampledAt),
      value: input.equity,
      balance: input.balance,
      brokerProfit: input.profit ?? null,
      externalFloatingPnl: accountContributor.externalFloatingPnl,
      realizedPnl: null,
      floatingPnl: input.profit ?? null,
      netPnl: input.equity,
      drawdownAmount: accountState.drawdownAmount,
      drawdownPct: accountState.drawdownPct,
      openTradeIds: [],
      positionTickets: [],
      updatedAt: sampledAt,
    });

    for (const sample of this.providerEquitySamples(input.accountId)) {
      const providerState = this.updateEquityCurveState({
        scope: "provider",
        accountId: input.accountId,
        providerId: sample.providerId,
        value: sample.netPnl,
        initialPeak: 0,
        sampledAt,
        contributor: {
          openTradeIds: sample.openTradeIds,
          positionTickets: sample.positionTickets,
          floatingPnl: sample.floatingPnl,
          realizedPnl: sample.realizedPnl,
        },
      });
      this.upsertEquityCurvePoint({
        scope: "provider",
        accountId: input.accountId,
        providerId: sample.providerId,
        bucketStart: minuteBucket(sampledAt),
        value: sample.netPnl,
        balance: null,
        brokerProfit: null,
        externalFloatingPnl: 0,
        realizedPnl: sample.realizedPnl,
        floatingPnl: sample.floatingPnl,
        netPnl: sample.netPnl,
        drawdownAmount: providerState.drawdownAmount,
        drawdownPct: providerState.drawdownPct,
        openTradeIds: sample.openTradeIds,
        positionTickets: sample.positionTickets,
        updatedAt: sampledAt,
      });
    }
    this.pruneEquityCurvePoints(sampledAt);
  }

  private providerEquitySamples(accountId: string) {
    const snapshot = this.mt5SnapshotsByAccount()[accountId];
    const positions = snapshot?.positions ?? [];
    const trades = this.logicalTrades().filter(
      (trade) => trade.accountId === accountId && trade.providerId,
    );
    const grouped = new Map<
      string,
      {
        providerId: string;
        realizedPnl: number;
        floatingPnl: number;
        netPnl: number;
        openTradeIds: string[];
        positionTickets: string[];
      }
    >();
    for (const trade of trades) {
      if (!trade.providerId) continue;
      const current = grouped.get(trade.providerId) ?? {
        providerId: trade.providerId,
        realizedPnl: 0,
        floatingPnl: 0,
        netPnl: 0,
        openTradeIds: [],
        positionTickets: [],
      };
      current.realizedPnl = roundCurrency(
        current.realizedPnl + sumPnl(this.brokerOrders(trade.id)),
      );
      const match = matchedBrokerRecordForTrade(
        positions,
        trade,
        this.brokerOrderTicketsForTrade(trade.id),
      );
      if (match) {
        current.openTradeIds.push(trade.id);
        const ticket = brokerTicketFromSnapshot(match);
        if (ticket) current.positionTickets.push(ticket);
        current.floatingPnl = roundCurrency(
          current.floatingPnl + (nullableNumber((match as Record<string, unknown>).profit) ?? 0),
        );
      }
      current.netPnl = roundCurrency(current.realizedPnl + current.floatingPnl);
      grouped.set(trade.providerId, current);
    }
    return [...grouped.values()];
  }

  private externalFloatingPnl(accountId: string) {
    const positions = this.mt5SnapshotsByAccount()[accountId]?.positions ?? [];
    return floatingPnlFromPositions(positions.filter(isExternalSnapshotRecord));
  }

  private updateEquityCurveState(input: {
    scope: EquityCurveScope;
    accountId: string;
    providerId: string;
    value: number;
    initialPeak: number;
    sampledAt: string;
    contributor: unknown;
  }) {
    const existing = this.db
      .query(
        `SELECT peak_value, max_drawdown_amount, max_drawdown_pct
         FROM equity_curve_state
         WHERE scope = ? AND account_id = ? AND provider_id = ?`,
      )
      .get(input.scope, input.accountId, input.providerId) as Row | null;
    const fallbackPeak =
      input.scope === "provider"
        ? Math.max(0, input.value)
        : Math.max(input.initialPeak, input.value);
    const peakValue = Math.max(nullableNumber(existing?.peak_value) ?? fallbackPeak, input.value);
    const drawdownAmount = roundCurrency(Math.max(0, peakValue - input.value));
    const drawdownPct = peakValue > 0 ? Number(((drawdownAmount / peakValue) * 100).toFixed(2)) : 0;
    const previousMax = nullableNumber(existing?.max_drawdown_amount) ?? 0;
    const maxDrawdownAmount = Math.max(previousMax, drawdownAmount);
    const maxDrawdownPct =
      drawdownAmount >= previousMax
        ? drawdownPct
        : (nullableNumber(existing?.max_drawdown_pct) ?? 0);
    const contributorJson = JSON.stringify(input.contributor ?? {});
    this.db
      .query(
        `INSERT INTO equity_curve_state
          (scope, account_id, provider_id, peak_value, latest_value, max_drawdown_amount, max_drawdown_pct, max_drawdown_at, contributor_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(scope, account_id, provider_id) DO UPDATE SET
          peak_value = excluded.peak_value,
          latest_value = excluded.latest_value,
          max_drawdown_amount = excluded.max_drawdown_amount,
          max_drawdown_pct = excluded.max_drawdown_pct,
          max_drawdown_at = CASE
            WHEN excluded.max_drawdown_amount >= equity_curve_state.max_drawdown_amount
            THEN excluded.max_drawdown_at
            ELSE equity_curve_state.max_drawdown_at
          END,
          contributor_json = CASE
            WHEN excluded.max_drawdown_amount >= equity_curve_state.max_drawdown_amount
            THEN excluded.contributor_json
            ELSE equity_curve_state.contributor_json
          END,
          updated_at = excluded.updated_at`,
      )
      .run(
        input.scope,
        input.accountId,
        input.providerId,
        peakValue,
        input.value,
        maxDrawdownAmount,
        maxDrawdownPct,
        drawdownAmount >= previousMax ? input.sampledAt : null,
        contributorJson,
        input.sampledAt,
      );
    if (drawdownAmount > previousMax) {
      this.db
        .query(
          `INSERT INTO drawdown_events
            (id, scope, account_id, provider_id, sampled_at, value, peak_value, drawdown_amount, drawdown_pct, contributor_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          `dd_${nanoid(10)}`,
          input.scope,
          input.accountId,
          input.providerId,
          input.sampledAt,
          input.value,
          peakValue,
          drawdownAmount,
          drawdownPct,
          contributorJson,
        );
    }
    return { drawdownAmount, drawdownPct };
  }

  private upsertEquityCurvePoint(input: {
    scope: EquityCurveScope;
    accountId: string;
    providerId: string;
    bucketStart: string;
    value: number;
    balance: number | null;
    brokerProfit: number | null;
    externalFloatingPnl: number | null;
    realizedPnl: number | null;
    floatingPnl: number | null;
    netPnl: number | null;
    drawdownAmount: number;
    drawdownPct: number;
    openTradeIds: string[];
    positionTickets: string[];
    updatedAt: string;
  }) {
    this.db
      .query(
        `INSERT INTO equity_curve_points
          (scope, account_id, provider_id, bucket_start, open_value, high_value, low_value, close_value,
           balance, broker_profit, external_floating_pnl, realized_pnl, floating_pnl, net_pnl,
           drawdown_amount, drawdown_pct, sample_count, open_trade_ids_json, position_tickets_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
         ON CONFLICT(scope, account_id, provider_id, bucket_start) DO UPDATE SET
          high_value = MAX(equity_curve_points.high_value, excluded.close_value),
          low_value = MIN(equity_curve_points.low_value, excluded.close_value),
          close_value = excluded.close_value,
          balance = excluded.balance,
          broker_profit = excluded.broker_profit,
          external_floating_pnl = excluded.external_floating_pnl,
          realized_pnl = excluded.realized_pnl,
          floating_pnl = excluded.floating_pnl,
          net_pnl = excluded.net_pnl,
          drawdown_amount = excluded.drawdown_amount,
          drawdown_pct = excluded.drawdown_pct,
          sample_count = equity_curve_points.sample_count + 1,
          open_trade_ids_json = excluded.open_trade_ids_json,
          position_tickets_json = excluded.position_tickets_json,
          updated_at = excluded.updated_at`,
      )
      .run(
        input.scope,
        input.accountId,
        input.providerId,
        input.bucketStart,
        input.value,
        input.value,
        input.value,
        input.value,
        input.balance,
        input.brokerProfit,
        input.externalFloatingPnl,
        input.realizedPnl,
        input.floatingPnl,
        input.netPnl,
        input.drawdownAmount,
        input.drawdownPct,
        JSON.stringify(input.openTradeIds),
        JSON.stringify(input.positionTickets),
        input.updatedAt,
      );
  }

  private pruneEquityCurvePoints(sampledAt: string) {
    const cutoff = new Date(
      Date.parse(sampledAt) - EQUITY_CURVE_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    this.db.query("DELETE FROM equity_curve_points WHERE bucket_start < ?").run(cutoff);
  }

  private sampledEquityCurve(accountId: string) {
    const rows = this.db
      .query(
        `SELECT bucket_start, close_value, drawdown_pct
         FROM equity_curve_points
         WHERE scope = 'account' AND account_id = ? AND provider_id = ''
         ORDER BY bucket_start ASC`,
      )
      .all(accountId) as Row[];
    return rows.map((row) => ({
      x: Math.floor(Date.parse(String(row.bucket_start)) / 1000),
      equity: roundCurrency(Number(row.close_value ?? 0)),
      drawdown: Number(Number(row.drawdown_pct ?? 0).toFixed(2)),
    }));
  }

  private averageCurveDrawdown(
    scope: EquityCurveScope,
    accountId: string | undefined,
    providerId: string,
  ) {
    const params: string[] = [scope, providerId];
    const accountFilter = accountId ? "AND account_id = ?" : "";
    if (accountId) params.push(accountId);
    const row = this.db
      .query(
        `SELECT AVG(drawdown_amount) AS average_drawdown
         FROM equity_curve_points
         WHERE scope = ? AND provider_id = ? ${accountFilter}
           AND open_trade_ids_json != '[]'`,
      )
      .get(...params) as Row | null;
    return roundCurrency(nullableNumber(row?.average_drawdown) ?? 0);
  }

  private maxCurveDrawdown(
    scope: EquityCurveScope,
    accountId: string | undefined,
    providerId: string,
  ) {
    const params: string[] = [scope, providerId];
    const accountFilter = accountId ? "AND account_id = ?" : "";
    if (accountId) params.push(accountId);
    const row = this.db
      .query(
        `SELECT MAX(max_drawdown_amount) AS max_drawdown
         FROM equity_curve_state
         WHERE scope = ? AND provider_id = ? ${accountFilter}`,
      )
      .get(...params) as Row | null;
    return roundCurrency(nullableNumber(row?.max_drawdown) ?? 0);
  }

  private curveRiskStats(scope: EquityCurveScope, accountId: string, providerId: string) {
    const state = this.db
      .query(
        `SELECT max_drawdown_amount, max_drawdown_pct
         FROM equity_curve_state
         WHERE scope = ? AND account_id = ? AND provider_id = ?`,
      )
      .get(scope, accountId, providerId) as Row | null;
    const latest = this.db
      .query(
        `SELECT drawdown_amount, drawdown_pct
         FROM equity_curve_points
         WHERE scope = ? AND account_id = ? AND provider_id = ?
         ORDER BY bucket_start DESC
         LIMIT 1`,
      )
      .get(scope, accountId, providerId) as Row | null;
    const average = this.db
      .query(
        `SELECT AVG(drawdown_amount) AS average_drawdown,
                AVG(drawdown_pct)    AS average_drawdown_pct
         FROM equity_curve_points
         WHERE scope = ? AND account_id = ? AND provider_id = ?
           AND drawdown_amount > 0`,
      )
      .get(scope, accountId, providerId) as Row | null;
    const maxDrawdown = roundCurrency(nullableNumber(state?.max_drawdown_amount) ?? 0);
    const averageActiveDrawdownPctRaw = nullableNumber(average?.average_drawdown_pct);
    return {
      maxDrawdown,
      maxDrawdownPct: nullableNumber(state?.max_drawdown_pct) ?? 0,
      currentDrawdown: roundCurrency(nullableNumber(latest?.drawdown_amount) ?? 0),
      currentDrawdownPct: nullableNumber(latest?.drawdown_pct) ?? 0,
      averageActiveDrawdown: roundCurrency(nullableNumber(average?.average_drawdown) ?? 0),
      averageActiveDrawdownPct:
        averageActiveDrawdownPctRaw !== undefined
          ? Number(averageActiveDrawdownPctRaw.toFixed(2))
          : 0,
      recoveryFactor: maxDrawdown > 0 ? 0 : 0,
    };
  }

  private closedTradeStats(
    accountId: string,
    input: { from?: string; scope: EquityCurveScope; providerId?: string },
  ) {
    const providerTradeIds =
      input.scope === "provider" && input.providerId
        ? new Set(
            this.logicalTrades()
              .filter(
                (trade) => trade.accountId === accountId && trade.providerId === input.providerId,
              )
              .map((trade) => trade.id),
          )
        : null;
    const grouped = new Map<
      string,
      {
        tradeId: string;
        pnl: number;
        closeAt: string;
        openAt?: string;
        durationMinutes?: number;
      }
    >();
    const allOrders = this.brokerOrdersForAccount(accountId);
    const openTimes = new Map<string, string>();
    for (const order of allOrders) {
      if (providerTradeIds && !providerTradeIds.has(order.logicalTradeId)) continue;
      if (order.action === "OPEN") {
        const current = openTimes.get(order.logicalTradeId);
        if (!current || order.createdAt < current)
          openTimes.set(order.logicalTradeId, order.createdAt);
      }
    }
    for (const order of allOrders) {
      if (providerTradeIds && !providerTradeIds.has(order.logicalTradeId)) continue;
      if (order.action !== "FULL_CLOSE" && order.action !== "PARTIAL_CLOSE") continue;
      if (input.from && normalizedDateInput(order.createdAt) < input.from) continue;
      const current = grouped.get(order.logicalTradeId) ?? {
        tradeId: order.logicalTradeId,
        pnl: 0,
        closeAt: order.createdAt,
        openAt: openTimes.get(order.logicalTradeId),
      };
      current.pnl = roundCurrency(current.pnl + (order.pnlCurrency ?? 0));
      if (order.createdAt > current.closeAt) current.closeAt = order.createdAt;
      grouped.set(order.logicalTradeId, current);
    }
    return [...grouped.values()]
      .map((trade) => {
        const openTime = trade.openAt ? Date.parse(normalizedDateInput(trade.openAt)) : NaN;
        const closeTime = Date.parse(normalizedDateInput(trade.closeAt));
        return {
          ...trade,
          durationMinutes:
            Number.isFinite(openTime) && Number.isFinite(closeTime)
              ? Number(((closeTime - openTime) / 60000).toFixed(1))
              : undefined,
        };
      })
      .sort((a, b) => normalizedDateInput(a.closeAt).localeCompare(normalizedDateInput(b.closeAt)));
  }

  private equityCurve(
    accountId: string,
    initialBalance?: number,
    orders = this.brokerOrdersForAccount(accountId),
  ) {
    const account = this.mt5Accounts().find((item) => item.id === accountId);
    if (!account) return [];
    const sampled = this.sampledEquityCurve(accountId);
    if (sampled.length > 0) return sampled;
    const initial = initialBalance ?? account.initialBalance ?? account.balance;
    let equity = initial;
    let peak = initial;
    const points = [{ x: 0, equity, drawdown: 0 }];
    orders
      .filter((order) => order.pnlCurrency !== undefined)
      .sort(
        (a, b) =>
          Date.parse(normalizedDateInput(a.createdAt)) -
          Date.parse(normalizedDateInput(b.createdAt)),
      )
      .forEach((order, index) => {
        equity += order.pnlCurrency ?? 0;
        peak = Math.max(peak, equity);
        points.push({
          x: index + 1,
          equity: Number(equity.toFixed(2)),
          drawdown: drawdownPercent(peak, equity),
        });
      });
    const floatingPnl = floatingPnlFromPositions(
      this.mt5SnapshotsByAccount()[accountId]?.positions ?? [],
    );
    const currentTradingEquity = roundCurrency(initial + sumPnl(orders) + floatingPnl);
    if (points.length === 1 || points[points.length - 1]?.equity !== currentTradingEquity) {
      peak = Math.max(peak, currentTradingEquity);
      points.push({
        x: points.length,
        equity: currentTradingEquity,
        drawdown: drawdownPercent(peak, currentTradingEquity),
      });
    }
    return points;
  }

  private monthlyReturns(
    accountId: string,
    initialBalance: number,
    orders = this.brokerOrdersForAccount(accountId),
    floatingPnl = floatingPnlFromPositions(
      this.mt5SnapshotsByAccount()[accountId]?.positions ?? [],
    ),
  ) {
    const account = this.mt5Accounts().find((item) => item.id === accountId);
    if (!account || initialBalance <= 0) return [];
    const byMonth = new Map<string, number>();
    for (const order of orders) {
      const month = monthKey(order.createdAt);
      byMonth.set(month, (byMonth.get(month) ?? 0) + (order.pnlCurrency ?? 0));
    }
    const currentMonth = new Date().toISOString().slice(0, 7);
    if (floatingPnl !== 0) {
      byMonth.set(currentMonth, (byMonth.get(currentMonth) ?? 0) + floatingPnl);
    }
    if (byMonth.size === 0) {
      return [
        {
          month: currentMonth,
          returnPercent: 0,
        },
      ];
    }
    return [...byMonth.entries()].map(([month, pnl]) => ({
      month,
      returnPercent: Number(((pnl / initialBalance) * 100).toFixed(2)),
    }));
  }

  private brokerOrdersForAccount(accountId: string) {
    return (
      this.db
        .query(
          `SELECT id, logical_trade_id, leg_id, action, queue_item_id, account_id, order_ticket, position_ticket, deal_ticket,
            requested_volume, filled_volume, requested_price, filled_price, retcode, retcode_external, broker_comment, pnl_currency, pnl_pips, source, created_at
           FROM broker_orders WHERE account_id = ? ORDER BY created_at ASC`,
        )
        .all(accountId) as Row[]
    ).map((row) => this.brokerOrderFromRow(row));
  }

  /**
   * Rolls up CLOSED logical trades on this account into a per-signal record for
   * the History › Closed sub-tab. Each entry summarises the trade at signal
   * level (entry ticket, weighted-avg open/close, total realized P/L, why it
   * closed) plus a `legs[]` array of individual close events so the UI can
   * expand for per-TP detail without a second roundtrip.
   *
   * Trades are considered "closed" when status === "CLOSED" — this excludes
   * OPEN, PENDING, and OUT_OF_SYNC trades (which belong in History › Open).
   */
  closedTradesForAccount(accountId: string) {
    const trades = this.logicalTrades().filter(
      (trade) => trade.accountId === accountId && trade.status === "CLOSED",
    );
    return trades
      .map((trade) => {
        const orders = this.brokerOrders(trade.id);
        const openEvents = orders.filter(isRealOpenBrokerOrder);
        const closeEvents = orders.filter(
          (o) => o.action === "FULL_CLOSE" || o.action === "PARTIAL_CLOSE",
        );
        // Without any close events we can't say the trade is "done" from the
        // broker's perspective even if logical status is CLOSED — skip.
        if (closeEvents.length === 0) return null;
        const entry = openEvents[0];
        const entryTicket = entry?.positionTicket || entry?.orderTicket || "";
        const totalOpenVolume = openEvents.reduce((sum, o) => sum + (o.filledVolume ?? 0), 0);
        const weightedOpenPrice =
          totalOpenVolume > 0
            ? openEvents.reduce((sum, o) => sum + (o.filledPrice ?? 0) * (o.filledVolume ?? 0), 0) /
              totalOpenVolume
            : (entry?.filledPrice ?? 0);
        const totalCloseVolume = closeEvents.reduce((sum, o) => sum + (o.filledVolume ?? 0), 0);
        const weightedClosePrice =
          totalCloseVolume > 0
            ? closeEvents.reduce(
                (sum, o) => sum + (o.filledPrice ?? 0) * (o.filledVolume ?? 0),
                0,
              ) / totalCloseVolume
            : 0;
        const realizedPnl = closeEvents.reduce((sum, o) => sum + (o.pnlCurrency ?? 0), 0);
        const closedAt = closeEvents
          .map((o) => o.createdAt)
          .sort()
          .reverse()[0]!;
        const result = deriveCloseResult(closeEvents.map((o) => o.source));
        const netResult = netResultForPnl(realizedPnl);
        const origin = closeEvents.some((o) => o.source.startsWith("manual")) ? "manual" : "ea";
        const tpLegs = trade.legs
          .filter((leg) => leg.targetPrice !== undefined || leg.defaultDistance !== undefined)
          .map((leg) => ({
            leg: leg.leg,
            targetPrice: leg.targetPrice,
            hit: leg.status === "HIT" || leg.status === "CLOSED",
          }));
        const tpHits = tpLegs.filter((leg) => leg.hit).length;
        const legs = closeEvents.map((order) => {
          const legIndex = parseLegIndex(order.legId);
          const matchingTpLeg =
            legIndex !== undefined ? trade.legs.find((leg) => leg.leg === legIndex) : undefined;
          return {
            id: order.id,
            action: order.action,
            legId: order.legId,
            legIndex,
            targetPrice: matchingTpLeg?.targetPrice,
            volume: order.filledVolume ?? 0,
            price: order.filledPrice ?? 0,
            pnl: order.pnlCurrency ?? 0,
            source: order.source,
            closedAt: order.createdAt,
            orderTicket: order.orderTicket,
            positionTicket: order.positionTicket,
            dealTicket: order.dealTicket,
          };
        });
        return {
          tradeId: trade.id,
          shortId: shortLogicalTradeId(trade.id),
          ticket: entryTicket,
          symbol: trade.symbol.brokerSymbol ?? trade.symbol.canonicalSymbol ?? "unmapped",
          direction: trade.direction,
          origin,
          volume: roundLot(totalOpenVolume),
          openPrice: weightedOpenPrice,
          closePrice: weightedClosePrice,
          realizedPnl: roundCurrency(realizedPnl),
          result,
          closeReason: result,
          netResult,
          closedAt,
          tpLegs,
          tpHitCount: tpHits,
          tpTotal: tpLegs.length,
          legs,
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      .sort((a, b) => (a.closedAt < b.closedAt ? 1 : -1));
  }

  externalClosesForAccount(accountId: string) {
    const closeEventsByPosition = this.externalCloseEventsByPosition(accountId);
    return (
      this.db.query("SELECT * FROM external_closes WHERE account_id = ?").all(accountId) as Row[]
    )
      .map((row) => {
        const positionTicket = String(row.position_ticket);
        const closeEvents = closeEventsByPosition.get(positionTicket) ?? [];
        const hasFinalClose = Boolean(row.close_at);
        if (!hasFinalClose && closeEvents.length === 0) return null;
        const latestCloseEvent = closeEvents[closeEvents.length - 1];
        const sources =
          closeEvents.length > 0
            ? closeEvents.map((event) => event.source)
            : [String(row.source ?? "history")];
        const realizedPnl =
          closeEvents.length > 0
            ? sumPnl(closeEvents)
            : roundCurrency(Number(row.pnl_currency ?? 0));
        const closeReason = deriveCloseResult(sources);
        const closeAt = hasFinalClose ? String(row.close_at) : latestCloseEvent?.createdAt;
        if (!closeAt) return null;
        const closeVolume = closeEvents.reduce((sum, event) => sum + (event.filledVolume ?? 0), 0);
        const volume = hasFinalClose ? (nullableNumber(row.volume) ?? closeVolume) : closeVolume;
        const weightedClosePrice =
          closeVolume > 0
            ? closeEvents.reduce(
                (sum, event) => sum + (event.filledPrice ?? 0) * (event.filledVolume ?? 0),
                0,
              ) / closeVolume
            : (nullableNumber(row.close_price) ?? latestCloseEvent?.filledPrice ?? 0);
        const tradeIdSuffix = hasFinalClose
          ? positionTicket
          : `${positionTicket}-${latestCloseEvent?.dealTicket ?? "partial"}`;
        const fallbackSource = String(row.source ?? "history");
        const legs =
          closeEvents.length > 0
            ? closeEvents.map((event) => ({
                id: event.id,
                action: event.action === "PARTIAL_CLOSE" ? "PARTIAL_CLOSE" : "FULL_CLOSE",
                legId: event.legId,
                legIndex: parseLegIndex(event.legId),
                volume: roundLot(event.filledVolume ?? 0),
                price: event.filledPrice ?? 0,
                pnl: event.pnlCurrency ?? 0,
                source: event.source,
                closedAt: event.createdAt,
                orderTicket: event.orderTicket,
                positionTicket: event.positionTicket,
                dealTicket: event.dealTicket,
              }))
            : [
                {
                  id: String(row.close_deal_ticket ?? `external-${positionTicket}`),
                  action: "FULL_CLOSE",
                  legId: "trade",
                  volume: roundLot(volume),
                  price: weightedClosePrice,
                  pnl: realizedPnl,
                  source: fallbackSource,
                  closedAt: closeAt,
                  orderTicket: "",
                  positionTicket,
                  dealTicket: String(row.close_deal_ticket ?? ""),
                },
              ];
        return {
          tradeId: `external-${String(row.account_id)}-${tradeIdSuffix}`,
          shortId: positionTicket,
          ticket: positionTicket,
          symbol: String(row.symbol),
          direction: String(row.direction) === "SELL" ? "SELL" : "BUY",
          origin: "manual",
          volume: roundLot(volume),
          openPrice: nullableNumber(row.open_price) ?? 0,
          closePrice: weightedClosePrice,
          realizedPnl,
          result: closeReason,
          closeReason,
          netResult: netResultForPnl(realizedPnl),
          closedAt: closeAt,
          tpLegs: [],
          tpHitCount: 0,
          tpTotal: 0,
          legs,
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      .sort((a, b) => (a.closedAt < b.closedAt ? 1 : -1));
  }

  private externalCloseEventsByPosition(accountId: string) {
    const rows = this.db
      .query(
        `SELECT id, logical_trade_id, leg_id, action, queue_item_id, account_id, order_ticket, position_ticket, deal_ticket,
          requested_volume, filled_volume, requested_price, filled_price, retcode, retcode_external, broker_comment, pnl_currency, pnl_pips, source, created_at
         FROM broker_orders
         WHERE account_id = ?
           AND logical_trade_id GLOB 'external_*'
           AND action IN ('FULL_CLOSE','PARTIAL_CLOSE')
           AND pnl_currency IS NOT NULL
         ORDER BY created_at ASC`,
      )
      .all(accountId) as Row[];
    const byPosition = new Map<string, ReturnType<AppStore["brokerOrderFromRow"]>[]>();
    for (const row of rows) {
      const order = this.brokerOrderFromRow(row);
      if (!truthyBrokerTicket(order.positionTicket)) continue;
      const events = byPosition.get(order.positionTicket) ?? [];
      events.push(order);
      byPosition.set(order.positionTicket, events);
    }
    return byPosition;
  }

  mt5AccountLogs(accountId: string) {
    const account = this.mt5Accounts().find((item) => item.id === accountId);
    const snapshot = this.mt5SnapshotsByAccount()[accountId];
    return {
      accountId,
      account,
      snapshot: {
        openPositionCount: snapshot?.positions.length ?? 0,
        pendingOrderCount: snapshot?.orders.length ?? 0,
        symbolCount: snapshot?.symbols.length ?? 0,
        lastSnapshotAt: snapshot?.updatedAt,
      },
      logs: this.executionLogs(accountId),
    };
  }

  symbolMappings(previewAccountId?: string) {
    const accountMappings = (
      this.db
        .query("SELECT account_id, mapping_json FROM account_symbol_mappings ORDER BY account_id")
        .all() as Row[]
    ).map((row) => parseJson<AccountSymbolMapping>(String(row.mapping_json)));
    const accountMappingsById = Object.fromEntries(
      accountMappings.map((mapping) => [mapping.accountId, mapping]),
    );
    const aliases = [
      ...Object.entries(this.globalAliases()).map(([rawSymbol, canonicalSymbol]) => ({
        rawSymbol,
        canonicalSymbol,
        brokerSymbol: canonicalSymbol,
        status: "mapped",
        scope: "global",
        providerId: undefined,
      })),
      ...Object.entries(this.providerAliases()).flatMap(([providerId, values]) =>
        Object.entries(values).map(([rawSymbol, canonicalSymbol]) => ({
          rawSymbol,
          canonicalSymbol,
          brokerSymbol: canonicalSymbol,
          status: "mapped",
          scope: "provider",
          providerId,
        })),
      ),
    ];
    const previewAliases = aliases.map((alias) => {
      const resolution = resolveSymbol(
        alias.rawSymbol,
        alias.scope === "provider"
          ? {
              providerId: alias.providerId,
              globalAliases: this.globalAliases(),
              providerAliases: this.providerAliases(),
              accountId: previewAccountId,
              accountMappings: accountMappingsById,
            }
          : {
              globalAliases: this.globalAliases(),
              accountId: previewAccountId,
              accountMappings: accountMappingsById,
            },
      );
      return {
        ...alias,
        canonicalSymbol: resolution.canonicalSymbol ?? alias.canonicalSymbol,
        brokerSymbol: resolution.brokerSymbol ?? alias.canonicalSymbol,
        status: resolution.mappingStatus,
        hint: resolution.warnings[0],
      };
    });
    const preview = [
      ...previewAliases,
      ...accountMappings.flatMap((mapping) =>
        Object.entries(mapping.canonicalOverrides ?? {}).map(([canonicalSymbol, brokerSymbol]) => ({
          rawSymbol: canonicalSymbol,
          canonicalSymbol,
          brokerSymbol,
          status:
            mapping.availableBrokerSymbols?.includes(brokerSymbol) === false
              ? "unavailable"
              : "mapped",
          scope: "account",
          accountId: mapping.accountId,
        })),
      ),
      ...accountMappings.flatMap((mapping) =>
        Object.entries(mapping.directBrokerOverrides ?? {}).map(([rawSymbol, brokerSymbol]) => {
          const resolution = resolveSymbol(rawSymbol, {
            accountId: mapping.accountId,
            accountMappings: { [mapping.accountId]: mapping },
          });
          return {
            rawSymbol,
            canonicalSymbol: resolution.canonicalSymbol ?? brokerSymbol,
            brokerSymbol: resolution.brokerSymbol ?? brokerSymbol,
            status: resolution.mappingStatus,
            scope: "account · direct",
            accountId: mapping.accountId,
            hint: resolution.warnings[0],
          };
        }),
      ),
    ];
    return {
      globalAliases: this.globalAliases(),
      providerAliases: this.providerAliases(),
      accountMappings,
      preview,
    };
  }

  deleteSymbolAlias(scope: SymbolAliasScope, rawSymbol: string, providerId = "") {
    this.db
      .query("DELETE FROM symbol_aliases WHERE scope = ? AND provider_id = ? AND raw_symbol = ?")
      .run(scope, scope === "provider" ? providerId : "", rawSymbol.trim().toUpperCase());
    return this.symbolMappings();
  }

  deleteDirectBrokerOverride(accountId: string, rawSymbol: string) {
    const existing = this.storedAccountMapping(accountId);
    if (!existing) return this.symbolMappings();
    const directBrokerOverrides = { ...(existing.directBrokerOverrides ?? {}) };
    const key = Object.keys(directBrokerOverrides).find(
      (candidate) => directBrokerOverrideKey(candidate) === directBrokerOverrideKey(rawSymbol),
    );
    if (!key) return this.symbolMappings();
    delete directBrokerOverrides[key];
    const mapping = { ...existing, directBrokerOverrides };
    this.db
      .query(
        "INSERT INTO account_symbol_mappings (account_id, mapping_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET mapping_json = excluded.mapping_json, updated_at = excluded.updated_at",
      )
      .run(accountId, JSON.stringify(mapping), new Date().toISOString());
    return { accountId, mapping };
  }

  saveSymbolAlias(input: {
    scope: SymbolAliasScope;
    providerId?: string;
    rawSymbol: string;
    canonicalSymbol: string;
  }) {
    if (input.scope !== "global" && input.scope !== "provider") {
      return { error: "Unsupported alias scope" };
    }
    if (input.scope === "provider" && !input.providerId) {
      return { error: "Provider alias requires providerId" };
    }
    const rawSymbol = input.rawSymbol.trim().toUpperCase();
    const canonicalSymbol = input.canonicalSymbol.trim().toUpperCase().replace("/", "");
    if (!rawSymbol || !canonicalSymbol) {
      return { error: "rawSymbol and canonicalSymbol are required" };
    }
    const providerId = input.scope === "provider" ? input.providerId! : "";
    this.db
      .query(
        `INSERT INTO symbol_aliases (scope, provider_id, raw_symbol, canonical_symbol, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(scope, provider_id, raw_symbol) DO UPDATE SET
           canonical_symbol = excluded.canonical_symbol,
           updated_at = excluded.updated_at`,
      )
      .run(input.scope, providerId, rawSymbol, canonicalSymbol, new Date().toISOString());
    this.audit("symbol_alias.save", "info", "Symbol alias saved", {
      scope: input.scope,
      providerId,
      rawSymbol,
      canonicalSymbol,
    });
    return {
      alias: {
        scope: input.scope,
        providerId: providerId || undefined,
        rawSymbol,
        canonicalSymbol,
      },
    };
  }

  saveAccountMapping(accountId: string, mapping: AccountMappingInput) {
    if (mapping.direct) {
      const rawSymbol = mapping.rawSymbol?.trim();
      const brokerSymbol = mapping.brokerSymbol?.trim();
      if (!rawSymbol || !brokerSymbol) {
        return { error: "Direct mapping requires provider and broker symbols" };
      }
      mapping = { accountId, directBrokerOverrides: { [rawSymbol]: brokerSymbol } };
    }
    const existing = this.storedAccountMapping(accountId) ?? defaultAccountMapping(accountId);
    const incomingOverrides = normalizeCanonicalOverrides(mapping.canonicalOverrides);
    const incomingDirectOverrides = normalizeDirectBrokerOverrides(mapping.directBrokerOverrides);
    const merged: AccountSymbolMapping = {
      accountId,
      canonicalOverrides: {
        ...(existing.canonicalOverrides ?? {}),
        ...incomingOverrides,
      },
      directBrokerOverrides: {
        ...(existing.directBrokerOverrides ?? {}),
        ...incomingDirectOverrides,
      },
      prefix: mapping.prefix ?? existing.prefix ?? "",
      suffix: mapping.suffix ?? existing.suffix ?? "",
      includeSymbols: mapping.includeSymbols ?? existing.includeSymbols ?? [],
      excludeSymbols: mapping.excludeSymbols ?? existing.excludeSymbols ?? [],
      availableBrokerSymbols:
        mapping.availableBrokerSymbols ?? existing.availableBrokerSymbols ?? [],
    };
    this.db
      .query(
        "INSERT INTO account_symbol_mappings (account_id, mapping_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET mapping_json = excluded.mapping_json, updated_at = excluded.updated_at",
      )
      .run(accountId, JSON.stringify(merged), new Date().toISOString());
    return { accountId, mapping: merged };
  }

  saveFixture(input: {
    providerLabel: string;
    rawText: string;
    expectedCommandType: string;
    expectedSymbol?: string;
    redacted?: boolean;
  }) {
    const id = `fixture_${nanoid(10)}`;
    const expected = {
      commandType: input.expectedCommandType,
      canonicalSymbol: input.expectedSymbol ?? "",
    };
    this.db
      .query(
        `INSERT INTO parser_fixtures
          (id, provider_label, raw_message_id, telegram_message_id, message_date, classification, raw_text, expected_command_type, expected_symbol, expected_json, redacted, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.providerLabel,
        "",
        "",
        "",
        "unknown",
        input.rawText,
        input.expectedCommandType,
        input.expectedSymbol ?? "",
        JSON.stringify(expected),
        Number(input.redacted ?? false),
        new Date().toISOString(),
      );
    return { fixtureId: id, status: "SAVED" };
  }

  saveFixtureFromMessage(
    messageId: string,
    input: {
      classification?: RawMessageClassification;
      redacted?: boolean;
      redactedRawText?: string;
      expectedCommandType?: string;
      expectedSymbol?: string;
    },
  ) {
    const message = this.rawMessage(messageId);
    if (!message) {
      return { error: "Raw message not found" };
    }
    const classification = input.classification ?? message.classification;
    if (!isRawMessageClassification(classification)) {
      return { error: "Unsupported message classification" };
    }
    if (classification !== message.classification) {
      this.classifyMessage(messageId, classification);
    }
    const provider = this.providerDetails(message.providerId);
    const rawText = input.redactedRawText?.trim() || message.rawText;
    const parsed = parseSignalText(
      rawText,
      this.parserContext(message.providerId, this.defaultParserAccountId(message.providerId)),
    );
    const expected = fixtureExpected(parsed);
    const expectedCommandType = input.expectedCommandType ?? parsed.commandType;
    const expectedSymbol = input.expectedSymbol ?? parsed.canonicalSymbol ?? "";
    const id = `fixture_${nanoid(10)}`;
    const now = new Date().toISOString();

    this.db
      .query(
        `INSERT INTO parser_fixtures
          (id, provider_label, raw_message_id, telegram_message_id, message_date, classification, raw_text, expected_command_type, expected_symbol, expected_json, redacted, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        provider?.title ?? message.providerId,
        message.id,
        message.telegramMessageId,
        message.messageDate,
        classification,
        rawText,
        expectedCommandType,
        expectedSymbol,
        JSON.stringify(expected),
        Number(input.redacted ?? false),
        now,
      );

    const fixture = {
      id,
      providerLabel: provider?.title ?? message.providerId,
      rawMessageId: message.id,
      telegramMessageId: message.telegramMessageId,
      messageDate: message.messageDate,
      classification,
      rawText,
      expectedCommandType,
      expectedSymbol,
      expected,
      redacted: Boolean(input.redacted ?? false),
      createdAt: now,
    };
    return { fixtureId: id, status: "SAVED", fixture };
  }

  fixtures() {
    return (
      this.db.query("SELECT * FROM parser_fixtures ORDER BY created_at DESC").all() as Row[]
    ).map((row) => ({
      id: String(row.id),
      providerLabel: String(row.provider_label),
      rawMessageId: String(row.raw_message_id ?? ""),
      telegramMessageId: String(row.telegram_message_id ?? ""),
      messageDate: String(row.message_date ?? ""),
      classification: String(row.classification ?? "unknown"),
      rawText: String(row.raw_text),
      expectedCommandType: String(row.expected_command_type),
      expectedSymbol: String(row.expected_symbol ?? ""),
      expected: parseJson<Record<string, unknown>>(String(row.expected_json ?? "{}")),
      redacted: Boolean(row.redacted),
      createdAt: String(row.created_at),
    }));
  }

  appSettings(): AppSettings {
    const row = this.db
      .query("SELECT settings_json FROM app_settings WHERE id = 'default'")
      .get() as Row | null;
    const settings = row
      ? normalizeAppSettings(parseJson<Partial<AppSettings>>(String(row.settings_json)))
      : { ...defaultAppSettings };
    return {
      ...settings,
      azureOpenAIKeyConfigured: Boolean(
        process.env.AZURE_OPENAI_API_KEY || this.secret("azureOpenAIApiKey"),
      ),
    };
  }

  settingsProjection() {
    const { alertBotToken, ...settings } = this.appSettings();
    return { ...settings, alertBotConfigured: Boolean(alertBotToken) };
  }

  updateAppSettings(input: Partial<AppSettings> & { azureOpenAIApiKey?: string }) {
    if (input.azureOpenAIApiKey?.trim()) {
      this.saveSecret("azureOpenAIApiKey", input.azureOpenAIApiKey.trim());
    }
    const settings = normalizeAppSettings({ ...this.appSettings(), ...input });
    this.db
      .query("INSERT OR REPLACE INTO app_settings (id, settings_json, updated_at) VALUES (?, ?, ?)")
      .run("default", JSON.stringify(settings), new Date().toISOString());
    this.audit("settings.update", "info", "Application settings updated", settings, "operator");
    return settings;
  }

  private saveSecret(key: string, value: string) {
    this.db
      .query("INSERT OR REPLACE INTO app_secrets (key, value, updated_at) VALUES (?, ?, ?)")
      .run(key, value, new Date().toISOString());
  }

  private secret(key: string) {
    const row = this.db.query("SELECT value FROM app_secrets WHERE key = ?").get(key) as Row | null;
    return row ? String(row.value) : "";
  }

  async sendAlertTest() {
    const settings = this.appSettings();
    if (!settings.alertBotToken || !settings.alertChatId) {
      return {
        statusCode: 400 as const,
        error: "Alert bot token and chat id must be configured",
      };
    }
    const result = await this.postTelegramAlert(
      settings.alertBotToken,
      settings.alertChatId,
      "Telegram TC alert test: outbound alerting is configured.",
    );
    if (!result.ok) {
      this.audit("alert.delivery-failed", "error", "Telegram alert test failed", {
        error: result.error,
      });
      return { statusCode: 502 as const, error: result.error };
    }
    this.audit("alert.test", "info", "Telegram alert test sent", {}, "operator");
    return { status: "SENT" as const };
  }

  private dispatchAlert(
    event: string,
    key: string,
    text: string,
    setting: AlertSetting,
    force = false,
  ) {
    if (this.deferredAlerts) {
      this.deferredAlerts.push({ event, key, text, setting, force });
      return;
    }
    const settings = this.appSettings();
    if ((!settings[setting] && !force) || !settings.alertBotToken || !settings.alertChatId) return;
    const dedupKey = `${event}:${key}`;
    const lastSentAt = this.alertSentAt.get(dedupKey) ?? 0;
    if (Date.now() - lastSentAt < ALERT_DEDUP_MS) return;
    this.alertSentAt.set(dedupKey, Date.now());
    void this.postTelegramAlert(settings.alertBotToken, settings.alertChatId, text).then(
      (result) => {
        if (result.ok) return;
        this.audit("alert.delivery-failed", "error", "Telegram alert delivery failed", {
          event,
          key,
          error: result.error,
        });
      },
    );
  }

  private async postTelegramAlert(token: string, chatId: string, text: string) {
    try {
      const response = await fetch(
        `https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text }),
          signal: AbortSignal.timeout(5000),
        },
      );
      if (!response.ok) return { ok: false as const, error: `Telegram HTTP ${response.status}` };
      return { ok: true as const };
    } catch (error) {
      return {
        ok: false as const,
        error: error instanceof Error ? error.message : "Unknown Telegram alert error",
      };
    }
  }

  private alertHeldQueueItem(queueItemId: string, reason: string, force = false) {
    this.dispatchAlert(
      "held",
      queueItemId,
      `Telegram TC held queue item ${queueItemId}: ${reason}`,
      "alertOnHeld",
      force,
    );
  }

  backupDatabase() {
    if (this.databasePath === ":memory:") {
      return { statusCode: 400 as const, error: "Backups require a file-backed database" };
    }
    const backupDir = join(dirname(this.databasePath), "backups");
    Bun.spawnSync(["mkdir", "-p", backupDir]);
    const timestamp = new Date()
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d{3}Z$/, "Z");
    const filename = `telegram-tc-${timestamp}.db`;
    const path = join(backupDir, filename);
    try {
      this.db.query("VACUUM INTO ?").run(path);
      this.pruneBackups(backupDir);
      this.audit("admin.backup", "info", "SQLite backup created", { filename }, "operator");
      return { filename };
    } catch (error) {
      return {
        statusCode: 500 as const,
        error: error instanceof Error ? error.message : "Database backup failed",
      };
    }
  }

  backups() {
    if (this.databasePath === ":memory:") return [];
    return this.backupFiles(join(dirname(this.databasePath), "backups")).map((file) => file.name);
  }

  private pruneBackups(backupDir: string) {
    const files = this.backupFiles(backupDir);
    for (const file of files.slice(14)) unlinkSync(join(backupDir, file.name));
  }

  private backupFiles(backupDir: string) {
    try {
      return readdirSync(backupDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && /^telegram-tc-.+\.db$/.test(entry.name))
        .map((entry) => ({ name: basename(entry.name) }))
        .sort((a, b) => b.name.localeCompare(a.name));
    } catch {
      return [];
    }
  }

  telegramSessionSummaries() {
    return (
      this.db
        .query(
          "SELECT id, profile_id, phone, status FROM telegram_sessions ORDER BY updated_at DESC",
        )
        .all() as Row[]
    ).map((row) => ({
      id: String(row.id),
      profileId: String(row.profile_id),
      phone: maskPhone(String(row.phone)),
      status: String(row.status),
    }));
  }

  telegramStatus(telegramAdapter = process.env.TELEGRAM_ADAPTER ?? "mock") {
    const telegramSessions = this.telegramSessionSummaries();
    const connected = telegramSessions.find((session) => session.status === "CONNECTED");
    return {
      telegramAdapter,
      connected: Boolean(connected),
      activeProfileId: connected?.profileId,
      telegramSessions,
    };
  }

  dashboard(telegramAdapter = process.env.TELEGRAM_ADAPTER ?? "mock", previewAccountId?: string) {
    this.syncExternalStoreRevision();
    const providers = this.providers();
    const queue = this.queueItems();
    const parsed = this.parsedSignals(8);
    const accounts = this.mt5Accounts();
    const performance = this.dashboardPerformance(accounts);
    return {
      health: {
        status: "ok",
        database: "connected",
        telegramAdapter,
      },
      appSettings: this.settingsProjection(),
      accountPerformance: performance.accountPerformance,
      accountPerformanceByAccount: performance.accountPerformanceByAccount,
      providerPerformance: performance.providerPerformance,
      providerPerformanceByAccount: performance.providerPerformanceByAccount,
      accountSlots: this.accountSlots(),
      accountProviderLinks: this.accountProviderLinks(),
      equityGuardians: this.equityGuardians(),
      telegramSessions: this.telegramSessionSummaries(),
      telegramHealth: this.telegramSessionHealth(),
      telegramProviderHealth: this.telegramProviderHealthSnapshot(),
      alerts: this.operationalAlerts(),
      providers: providers.map((provider) => ({
        id: provider.id,
        dialogId: provider.dialogId,
        title: provider.title,
        enabled: provider.enabled,
        parserMode: provider.parserMode,
        lockedSymbol: provider.lockedSymbol,
        riskProfile: provider.riskProfile,
        lotSize: provider.lotSize,
        lastMessageAt: provider.lastMessageAt,
        ingestionStatus: provider.enabled
          ? this.connectedSessionIdForProfile(provider.profileId)
            ? "polling"
            : "telegram-offline"
          : "paused",
      })),
      mt5Accounts: accounts.map((account) => ({
        id: account.id,
        accountNumber: account.accountNumber,
        nickname: account.nickname,
        server: account.server,
        currency: account.currency,
        balance: account.balance,
        equity: account.equity,
        profit: account.profit,
        initialBalance: account.initialBalance,
        heartbeatStatus: account.heartbeatStatus,
        marginMode: account.marginMode,
        eaVersion: account.eaVersion,
        eaCapabilities: account.eaCapabilities,
        availableSymbols: account.availableSymbols,
        openPositionCount: account.openPositionCount,
        pendingOrderCount: account.pendingOrderCount,
        externalPositionCount: account.externalPositionCount,
        externalOrderCount: account.externalOrderCount,
        appPositions: account.appPositions,
        appOrders: account.appOrders,
        externalPositions: account.externalPositions,
        externalOrders: account.externalOrders,
        symbols: account.symbols,
        closedTrades: account.closedTrades,
        externalCloses: account.externalCloses,
        lastHeartbeatAt: account.lastHeartbeatAt,
        lastSnapshotAt: account.lastSnapshotAt,
      })),
      parserResults: parsed.map((signal) => ({
        id: signal.id,
        accountId: signal.result.accountId,
        providerId: signal.result.providerId ?? signal.providerId,
        rawMessageId: signal.rawMessageId,
        classification: signal.classification,
        providerTitle:
          providers.find((provider) => provider.id === signal.providerId)?.title ??
          signal.providerId,
        rawText: signal.result.originalText,
        commandType: signal.result.commandType,
        direction: signal.result.direction,
        orderType: signal.result.orderType,
        entry: signal.result.entry,
        stopLoss: signal.result.stopLoss,
        takeProfits: signal.result.takeProfits,
        volume: signal.result.lotSize,
        executionMode: signal.result.executionMode,
        rawSymbol: signal.result.rawSymbol ?? "",
        canonicalSymbol: signal.result.canonicalSymbol ?? "",
        brokerSymbol: signal.result.brokerSymbol ?? "",
        mappingStatus: signal.result.mappingStatus,
        mappingSource: signal.result.mappingSource,
        mappingWarnings: signal.result.mappingWarnings,
        confidence: signal.result.confidence,
        matchedPatternIds: signal.result.matchedPatternIds,
        missingFields: signal.result.missingFields,
        warnings: signal.result.warnings,
        reviewRequired: signal.reviewRequired,
        status: signal.status,
        heldReason: signal.heldReason || undefined,
      })),
      parserFixtures: this.fixtures().slice(0, 20),
      signalQueue: queue.map((item) => ({
        id: item.id,
        commandType: item.payload.commandType,
        symbol: item.payload.brokerSymbol ?? item.payload.canonicalSymbol ?? "unmapped",
        status: item.status,
        volume: item.payload.volume ?? null,
        riskPercent: item.payload.riskPercent ?? null,
      })),
      logicalTrades: this.logicalTradesForDashboard(),
      symbolMappings: this.symbolMappings(previewAccountId ?? accounts[0]?.id).preview,
      executionLogs: this.executionLogs(undefined, 10).map((log) => ({
        id: log.id,
        queueItemId: log.queueItemId,
        retcode: log.retcode,
        retcodeExternal: log.retcodeExternal,
        brokerComment: log.brokerComment,
        errorText: log.errorText,
        orderTicket: log.orderTicket,
        positionTicket: log.positionTicket,
        dealTicket: log.dealTicket,
        requestedPrice: log.requestedPrice,
        filledPrice: log.filledPrice,
        volume: log.volume,
        status: log.status,
        timestamp: log.createdAt,
      })),
    };
  }

  private dashboardPerformance(accounts: ReturnType<AppStore["mt5Accounts"]>) {
    const heartbeatStatusKey = accounts
      .map((account) => `${account.id}:${account.heartbeatStatus}`)
      .sort()
      .join("|");
    if (
      this.dashboardPerformanceCache?.revision === this.storeRevision &&
      this.dashboardPerformanceCache.heartbeatStatusKey === heartbeatStatusKey
    ) {
      return this.dashboardPerformanceCache;
    }
    const projections = {
      revision: this.storeRevision,
      heartbeatStatusKey,
      accountPerformance: this.accountPerformance(accounts),
      accountPerformanceByAccount: Object.fromEntries(
        accounts.map((account) => [account.id, this.accountPerformance([account])]),
      ),
      providerPerformance: this.providerPerformance(undefined, accounts),
      providerPerformanceByAccount: Object.fromEntries(
        accounts.map((account) => [account.id, this.providerPerformance(account.id, accounts)]),
      ),
    };
    this.dashboardPerformanceCache = projections;
    return projections;
  }

  seedDemoData() {
    const existing = this.db.query("SELECT id FROM profiles LIMIT 1").get() as Row | null;
    if (existing) return;
    const now = new Date().toISOString();
    this.db
      .query("INSERT INTO profiles (id, display_name, created_at) VALUES (?, ?, ?)")
      .run("profile-demo", "Demo operator", now);
    this.db
      .query(
        "INSERT INTO telegram_sessions (id, profile_id, phone, api_id_hint, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run("tg-demo", "profile-demo", "+27821234567", "api_123", "CONNECTED", now, now);
    this.ensureMockProvider("profile-demo");
    this.registerMt5Account({
      accountNumber: "100200300",
      server: "MetaQuotes-Demo",
      company: "MetaQuotes Ltd",
      currency: "USD",
      balance: 10000,
      equity: 10000,
      marginMode: "HEDGING",
      availableSymbols: ["EURUSD.raw", "XAUUSD.r", "DJI30.raw"],
      eaVersion: "1.57.2",
      eaCapabilities: [LANE2_CLOSE_CAPABILITY, PENDING_CLOSE_FLATTEN_CAPABILITY],
    });
    const rawText =
      "BUY EURUSD @ 1.0850\nSL 1.0810\nTP1 1.0900\nTP2 1.0950\nTP3 1.1000\nTP4 1.1050";
    const parsed = this.parseProviderMessage(demoProviderId, rawText, demoAccountId);
    const signal = parsed.result;
    const trade = createLogicalTradeFromSignal(signal, {
      id: "trade-demo-1",
      providerId: demoProviderId,
      accountId: demoAccountId,
      source: this.sourceForParsedSignal(parsed.parsedSignalId, signal),
      executionMode: "VIRTUAL_TP",
    });
    this.insertTrade(trade);
    this.insertQueueItem(
      buildExecutionCommand(signal, {
        id: "queue-demo-1",
        accountId: demoAccountId,
        logicalTradeId: trade.id,
        executionMode: "VIRTUAL_TP",
        volume: defaultAppSettings.defaultLotSize,
        riskPercent: defaultAppSettings.defaultRiskPercent,
      }),
      parsed.parsedSignalId,
    );
  }

  ensureProviderForProfile(profileId: string) {
    if (this.allowDemoData) this.ensureMockProvider(profileId);
  }

  private primaryAccount(accounts = this.mt5Accounts()) {
    return [...accounts].sort((a, b) => {
      const statusDelta =
        accountFreshnessScore(b.heartbeatStatus) - accountFreshnessScore(a.heartbeatStatus);
      if (statusDelta !== 0) return statusDelta;
      const fundedDelta = accountFundedScore(b) - accountFundedScore(a);
      if (fundedDelta !== 0) return fundedDelta;
      const heartbeatDelta = Date.parse(b.lastHeartbeatAt) - Date.parse(a.lastHeartbeatAt);
      if (Number.isFinite(heartbeatDelta) && heartbeatDelta !== 0) return heartbeatDelta;
      return a.accountNumber.localeCompare(b.accountNumber);
    })[0];
  }

  private defaultParserAccountId(providerId?: string) {
    const accounts = this.mt5Accounts();
    const linkedAccountIds = providerId
      ? new Set(
          this.accountProviderLinks()
            .filter((link) => link.providerId === providerId && link.enabled)
            .map((link) => link.accountId),
        )
      : undefined;
    const candidates = linkedAccountIds?.size
      ? accounts.filter((account) => linkedAccountIds.has(account.id))
      : accounts;
    return (
      this.primaryAccount(candidates)?.id ?? this.primaryAccount(accounts)?.id ?? fallbackAccountId
    );
  }

  private migrate() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS profiles (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS app_secrets (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS telegram_sessions (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        phone TEXT NOT NULL,
        api_id_hint TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS providers (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        dialog_id TEXT NOT NULL,
        title TEXT NOT NULL,
        kind TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        parser_mode TEXT NOT NULL,
        risk_profile TEXT NOT NULL DEFAULT 'balanced',
        lot_size REAL NOT NULL DEFAULT 0.1,
        provider_config_json TEXT NOT NULL DEFAULT '{}',
        last_message_at TEXT NOT NULL,
        backfill_cursor_id TEXT,
        backfill_floor_at TEXT
      );
    `);
    this.ensureColumn("providers", "risk_profile", "TEXT NOT NULL DEFAULT 'balanced'");
    this.ensureColumn("providers", "lot_size", "REAL NOT NULL DEFAULT 0.1");
    this.ensureColumn("providers", "provider_config_json", "TEXT NOT NULL DEFAULT '{}'");
    this.ensureColumn("providers", "backfill_cursor_id", "TEXT");
    this.ensureColumn("providers", "backfill_floor_at", "TEXT");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS provider_config_history (
        id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL,
        config_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS suppressed_provider_symbols (
        provider_id TEXT NOT NULL,
        token TEXT NOT NULL,
        token_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (provider_id, token_key)
      );
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS raw_messages (
        id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL,
        telegram_message_id TEXT NOT NULL,
        message_date TEXT NOT NULL,
        raw_text TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        classification TEXT NOT NULL
      );
    `);
    this.ensureColumn("raw_messages", "reply_to_message_id", "TEXT");
    this.ensureColumn("raw_messages", "forwarded_from", "TEXT");
    this.ensureColumn("raw_messages", "forward_date", "TEXT");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS raw_message_aliases (
        provider_id TEXT NOT NULL,
        telegram_message_id TEXT NOT NULL,
        raw_message_id TEXT NOT NULL,
        UNIQUE(provider_id, telegram_message_id)
      );
    `);
    this.db.run(
      "CREATE INDEX IF NOT EXISTS idx_raw_message_aliases_provider_telegram ON raw_message_aliases(provider_id, telegram_message_id)",
    );
    this.db.run(`
      CREATE TABLE IF NOT EXISTS parsed_signals (
        id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL,
        raw_message_id TEXT NOT NULL,
        result_json TEXT NOT NULL,
        review_required INTEGER NOT NULL,
        fingerprint TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS logical_trades (
        id TEXT PRIMARY KEY,
        provider_id TEXT,
        account_id TEXT,
        status TEXT NOT NULL,
        data_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    this.db.run(
      "CREATE INDEX IF NOT EXISTS idx_logical_trades_account_provider_created ON logical_trades(account_id, provider_id, status, created_at)",
    );
    this.db.run(`
      CREATE TABLE IF NOT EXISTS trade_origins (
        provider_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        telegram_message_id TEXT NOT NULL,
        logical_trade_id TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );
    `);
    this.db.run(
      "CREATE INDEX IF NOT EXISTS idx_trade_origins_provider_account_telegram ON trade_origins(provider_id, account_id, telegram_message_id)",
    );
    this.db.run(`
      CREATE TABLE IF NOT EXISTS queue_items (
        id TEXT PRIMARY KEY,
        parsed_signal_id TEXT NOT NULL,
        logical_trade_id TEXT,
        account_id TEXT,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        lease_count INTEGER NOT NULL DEFAULT 0,
        leased_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    this.ensureColumn("queue_items", "lease_count", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("queue_items", "held_reason", "TEXT");
    this.ensureColumn("queue_items", "held_tier", "TEXT");
    this.ensureColumn("queue_items", "suggestion", "TEXT");
    this.ensureColumn("queue_items", "origin_queue_item_id", "TEXT");
    this.db.run(
      "CREATE INDEX IF NOT EXISTS idx_queue_items_parsed_signal_created ON queue_items(parsed_signal_id, created_at)",
    );
    this.db.run(`
      CREATE TABLE IF NOT EXISTS reference_stop_actions (
        logical_trade_id TEXT NOT NULL,
        leg INTEGER NOT NULL,
        position_ticket TEXT NOT NULL,
        desired_stop_loss REAL,
        resolution TEXT NOT NULL,
        queue_item_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (logical_trade_id, leg)
      );
    `);
    this.db.run(
      "CREATE INDEX IF NOT EXISTS idx_reference_stop_actions_queue ON reference_stop_actions(queue_item_id)",
    );
    this.db.run(`
      CREATE TABLE IF NOT EXISTS held_lifecycle_drops (
        id TEXT PRIMARY KEY,
        held_queue_item_id TEXT NOT NULL,
        raw_message_id TEXT NOT NULL,
        command_type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (held_queue_item_id, raw_message_id)
      );
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS mt5_accounts (
        id TEXT PRIMARY KEY,
        account_number TEXT NOT NULL,
        server TEXT NOT NULL,
        company TEXT NOT NULL,
        currency TEXT NOT NULL,
        balance REAL NOT NULL,
        equity REAL NOT NULL,
        profit REAL,
        initial_balance REAL NOT NULL DEFAULT 0,
        margin_mode TEXT NOT NULL,
        heartbeat_status TEXT NOT NULL,
        available_symbols_json TEXT NOT NULL,
        ea_version TEXT,
        ea_capabilities_json TEXT NOT NULL DEFAULT '[]',
        last_heartbeat_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    this.ensureColumn("mt5_accounts", "profit", "REAL");
    this.ensureColumn("mt5_accounts", "initial_balance", "REAL NOT NULL DEFAULT 0");
    this.ensureColumn("mt5_accounts", "ea_version", "TEXT");
    this.ensureColumn("mt5_accounts", "ea_capabilities_json", "TEXT NOT NULL DEFAULT '[]'");
    this.ensureColumn("mt5_accounts", "drawdown_warn_pct", "REAL");
    this.ensureColumn("mt5_accounts", "drawdown_danger_pct", "REAL");
    this.ensureColumn("mt5_accounts", "nickname", "TEXT");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS account_slots (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        link_code TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        account_id TEXT,
        account_number TEXT,
        server TEXT,
        broker TEXT,
        currency TEXT,
        balance REAL,
        equity REAL,
        last_heartbeat_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS account_provider_links (
        account_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        config_json TEXT,
        PRIMARY KEY (account_id, provider_id)
      );
    `);
    // Per-account provider config override. NULL = inherit the provider-level default.
    this.ensureColumn("account_provider_links", "config_json", "TEXT");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS equity_guardians (
        account_id TEXT PRIMARY KEY,
        threshold REAL NOT NULL,
        current_drawdown REAL NOT NULL,
        paused INTEGER NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        breach_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    this.ensureColumn("equity_guardians", "enabled", "INTEGER NOT NULL DEFAULT 1");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS account_symbol_mappings (
        account_id TEXT PRIMARY KEY,
        mapping_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS symbol_aliases (
        scope TEXT NOT NULL,
        provider_id TEXT NOT NULL DEFAULT '',
        raw_symbol TEXT NOT NULL,
        canonical_symbol TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (scope, provider_id, raw_symbol)
      );
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS app_settings (
        id TEXT PRIMARY KEY,
        settings_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS mt5_snapshots (
        account_id TEXT PRIMARY KEY,
        positions_json TEXT NOT NULL,
        orders_json TEXT NOT NULL,
        symbols_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS equity_curve_points (
        scope TEXT NOT NULL,
        account_id TEXT NOT NULL,
        provider_id TEXT NOT NULL DEFAULT '',
        bucket_start TEXT NOT NULL,
        open_value REAL NOT NULL,
        high_value REAL NOT NULL,
        low_value REAL NOT NULL,
        close_value REAL NOT NULL,
        balance REAL,
        broker_profit REAL,
        external_floating_pnl REAL,
        realized_pnl REAL,
        floating_pnl REAL,
        net_pnl REAL,
        drawdown_amount REAL NOT NULL DEFAULT 0,
        drawdown_pct REAL NOT NULL DEFAULT 0,
        sample_count INTEGER NOT NULL DEFAULT 1,
        open_trade_ids_json TEXT NOT NULL DEFAULT '[]',
        position_tickets_json TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL,
        PRIMARY KEY (scope, account_id, provider_id, bucket_start)
      );
    `);
    this.db.run(
      "CREATE INDEX IF NOT EXISTS idx_equity_curve_points_scope_account_time ON equity_curve_points(scope, account_id, provider_id, bucket_start DESC)",
    );
    this.db.run(`
      CREATE TABLE IF NOT EXISTS equity_curve_state (
        scope TEXT NOT NULL,
        account_id TEXT NOT NULL,
        provider_id TEXT NOT NULL DEFAULT '',
        peak_value REAL NOT NULL,
        latest_value REAL NOT NULL,
        max_drawdown_amount REAL NOT NULL,
        max_drawdown_pct REAL NOT NULL,
        max_drawdown_at TEXT,
        contributor_json TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL,
        PRIMARY KEY (scope, account_id, provider_id)
      );
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS drawdown_events (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        account_id TEXT NOT NULL,
        provider_id TEXT NOT NULL DEFAULT '',
        sampled_at TEXT NOT NULL,
        value REAL NOT NULL,
        peak_value REAL NOT NULL,
        drawdown_amount REAL NOT NULL,
        drawdown_pct REAL NOT NULL,
        contributor_json TEXT NOT NULL
      );
    `);
    this.db.run(
      "CREATE INDEX IF NOT EXISTS idx_drawdown_events_scope_account_time ON drawdown_events(scope, account_id, provider_id, sampled_at DESC)",
    );
    this.db.run(`
      CREATE TABLE IF NOT EXISTS execution_reports (
        id TEXT PRIMARY KEY,
        queue_item_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        status TEXT NOT NULL,
        retcode INTEGER NOT NULL,
        retcode_external INTEGER NOT NULL,
        broker_comment TEXT NOT NULL,
        order_ticket TEXT,
        deal_ticket TEXT,
        requested_price REAL,
        filled_price REAL,
        volume REAL,
        requested_volume REAL,
        filled_volume REAL,
        remaining_volume REAL,
        error_text TEXT,
        created_at TEXT NOT NULL
      );
    `);
    this.ensureColumn("execution_reports", "position_ticket", "TEXT");
    this.ensureColumn("execution_reports", "requested_volume", "REAL");
    this.ensureColumn("execution_reports", "filled_volume", "REAL");
    this.ensureColumn("execution_reports", "remaining_volume", "REAL");
    this.db.run(
      "CREATE INDEX IF NOT EXISTS idx_execution_reports_created ON execution_reports(created_at DESC)",
    );
    this.db.run(
      "CREATE INDEX IF NOT EXISTS idx_execution_reports_account_created ON execution_reports(account_id, created_at DESC)",
    );
    this.db.run(`
      CREATE TABLE IF NOT EXISTS broker_orders (
        id TEXT PRIMARY KEY,
        logical_trade_id TEXT NOT NULL,
        leg_id TEXT NOT NULL,
        action TEXT NOT NULL,
        queue_item_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        order_ticket TEXT,
        position_ticket TEXT,
        deal_ticket TEXT,
        requested_volume REAL,
        filled_volume REAL,
        requested_price REAL,
        filled_price REAL,
        retcode INTEGER NOT NULL,
        retcode_external INTEGER NOT NULL,
        broker_comment TEXT NOT NULL,
        pnl_currency REAL,
        pnl_pips REAL,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    this.ensureColumn("broker_orders", "pnl_currency", "REAL");
    this.ensureColumn("broker_orders", "pnl_pips", "REAL");
    this.db.run(
      "CREATE INDEX IF NOT EXISTS idx_broker_orders_deal_ticket ON broker_orders(deal_ticket)",
    );
    this.db.run(
      "CREATE INDEX IF NOT EXISTS idx_broker_orders_account_created ON broker_orders(account_id, created_at)",
    );
    this.db.run(
      "CREATE INDEX IF NOT EXISTS idx_broker_orders_trade_created ON broker_orders(logical_trade_id, created_at)",
    );
    this.db.run(
      "CREATE INDEX IF NOT EXISTS idx_broker_orders_position_created ON broker_orders(position_ticket, created_at)",
    );
    this.db.run(
      "CREATE INDEX IF NOT EXISTS idx_broker_orders_order_created ON broker_orders(order_ticket, created_at)",
    );
    this.db.run(`
      CREATE TABLE IF NOT EXISTS external_closes (
        account_id TEXT NOT NULL,
        position_ticket TEXT NOT NULL,
        symbol TEXT NOT NULL,
        direction TEXT NOT NULL,
        volume REAL,
        open_price REAL,
        open_at TEXT,
        open_deal_ticket TEXT,
        close_price REAL,
        close_at TEXT,
        close_deal_ticket TEXT,
        pnl_currency REAL,
        pnl_pips REAL,
        source TEXT,
        magic INTEGER NOT NULL DEFAULT 0,
        comment TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (account_id, position_ticket)
      );
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS parser_fixtures (
        id TEXT PRIMARY KEY,
        provider_label TEXT NOT NULL,
        raw_message_id TEXT,
        telegram_message_id TEXT,
        message_date TEXT,
        classification TEXT NOT NULL DEFAULT 'unknown',
        raw_text TEXT NOT NULL,
        expected_command_type TEXT NOT NULL,
        expected_symbol TEXT,
        expected_json TEXT NOT NULL DEFAULT '{}',
        redacted INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    this.ensureColumn("parser_fixtures", "raw_message_id", "TEXT");
    this.ensureColumn("parser_fixtures", "telegram_message_id", "TEXT");
    this.ensureColumn("parser_fixtures", "message_date", "TEXT");
    this.ensureColumn("parser_fixtures", "classification", "TEXT NOT NULL DEFAULT 'unknown'");
    this.ensureColumn("parser_fixtures", "expected_json", "TEXT NOT NULL DEFAULT '{}'");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        level TEXT NOT NULL,
        message TEXT NOT NULL,
        data_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS symbol_metadata (
        account_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        point REAL,
        digits INTEGER,
        pip_size REAL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (account_id, symbol)
      );
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS parser_training_examples (
        id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        raw_text TEXT NOT NULL,
        command_type TEXT NOT NULL,
        symbol TEXT,
        direction TEXT,
        entry REAL,
        stop_loss REAL,
        take_profits_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL
      );
    `);
    this.db.run(
      "CREATE INDEX IF NOT EXISTS idx_parser_training_provider_fingerprint ON parser_training_examples(provider_id, fingerprint)",
    );
    const operatorStateBefore = this.operatorStateSnapshot();
    this.backfillStuckOutOfSyncTrades();
    this.assertOperatorStatePreserved(
      "startup-maintenance",
      operatorStateBefore,
      this.operatorStateSnapshot(),
    );
  }

  private operatorStateSnapshot(): OperatorStateSnapshot {
    return {
      accountProviderLinks: this.operatorStateTable(
        "SELECT account_id, provider_id, enabled FROM account_provider_links ORDER BY account_id, provider_id",
      ),
      accountSymbolMappings: this.operatorStateTable(
        "SELECT account_id, mapping_json FROM account_symbol_mappings ORDER BY account_id",
      ),
      symbolAliases: this.operatorStateTable(
        "SELECT scope, provider_id, raw_symbol, canonical_symbol FROM symbol_aliases ORDER BY scope, provider_id, raw_symbol",
      ),
      providers: this.operatorStateTable(
        "SELECT id, enabled, parser_mode, risk_profile, lot_size, provider_config_json FROM providers ORDER BY id",
      ),
      providerConfigHistory: this.operatorStateTable(
        "SELECT provider_id, config_json, created_at FROM provider_config_history ORDER BY provider_id, created_at",
      ),
    };
  }

  private operatorStateTable(query: string): OperatorStateTableSnapshot {
    const rows = this.db.query(query).all() as Row[];
    return { count: rows.length, fingerprint: JSON.stringify(rows) };
  }

  private assertOperatorStatePreserved(
    context: string,
    before: OperatorStateSnapshot,
    after: OperatorStateSnapshot,
  ) {
    const changedTables = (Object.keys(before) as Array<keyof OperatorStateSnapshot>).filter(
      (table) => before[table].fingerprint !== after[table].fingerprint,
    );
    const beforeCounts = Object.fromEntries(
      (Object.keys(before) as Array<keyof OperatorStateSnapshot>).map((table) => [
        table,
        before[table].count,
      ]),
    );
    const afterCounts = Object.fromEntries(
      (Object.keys(after) as Array<keyof OperatorStateSnapshot>).map((table) => [
        table,
        after[table].count,
      ]),
    );
    if (changedTables.length > 0) {
      this.audit("operator-state.changed", "error", "Operator state changed during startup", {
        context,
        changedTables,
        beforeCounts,
        afterCounts,
      });
      throw new Error(`Operator state changed during ${context}: ${changedTables.join(", ")}`);
    }

    const protectedRows = Object.values(before).reduce((sum, table) => sum + table.count, 0);
    if (protectedRows > 0) {
      this.audit("operator-state.preserved", "info", "Operator state preserved during startup", {
        context,
        protectedRows,
        counts: beforeCounts,
      });
    }
  }

  /**
   * One-shot reconciliation for OUT_OF_SYNC logical_trades that already have a
   * real close recorded in broker_orders. These got stuck because every
   * snapshot poll used to overwrite their status back to OUT_OF_SYNC (race
   * with the history sweep — see hasRecordedRealFullClose comment). The fix
   * landed alongside this migration; this method heals trades that drifted
   * before the fix was deployed.
   *
   * Two operations per affected trade:
   * 1. Delete the synthetic 'manual' FULL_CLOSE row from snapshot-diff if a
   *    real-source FULL_CLOSE exists for the same position — otherwise the
   *    Closed view would count one close twice (once with pnl=null, once with
   *    the real pnl).
   * 2. Flip logical_trade.status to CLOSED + mark legs SKIPPED for any that
   *    were still PLANNED (the close fired before the TPs ran).
   *
   * Idempotent across restarts: a CLOSED trade with no duplicate manual row
   * matches nothing and the loop is a no-op.
   */
  private backfillStuckOutOfSyncTrades() {
    const stuck = this.db
      .query(
        `SELECT id, status, data_json FROM logical_trades WHERE status IN ('OUT_OF_SYNC','OPEN')`,
      )
      .all() as Row[];
    if (stuck.length === 0) return;
    let healed = 0;
    for (const row of stuck) {
      const tradeId = String(row.id);
      const currentStatus = String(row.status ?? "");
      const fullClose = this.db
        .query(
          `SELECT id, action, position_ticket, source, broker_comment, pnl_currency, created_at
           FROM broker_orders
           WHERE logical_trade_id = ?
             AND action = 'FULL_CLOSE'
             AND source IN ('sl-hit','tp-hit','expert','stop-out','manual-terminal','manual-mobile','manual-web','history')
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(tradeId) as Row | null;
      const realClose = fullClose ?? this.coveringCloseForTrade(tradeId);
      if (!realClose) {
        if (currentStatus !== "OUT_OF_SYNC") continue;
        const recoverableOpen = this.db
          .query(
            `SELECT action, order_ticket, position_ticket, broker_comment, created_at
             FROM broker_orders
             WHERE logical_trade_id = ?
               AND (
                 (
                   action = 'OPEN'
                   AND position_ticket IS NOT NULL
                   AND position_ticket NOT IN ('','0')
                   AND filled_price IS NOT NULL
                   AND filled_price > 0
                 )
                 OR (
                   action = 'PENDING_OPEN'
                   AND order_ticket IS NOT NULL
                   AND order_ticket NOT IN ('','0')
                 )
               )
             ORDER BY created_at DESC LIMIT 1`,
          )
          .get(tradeId) as Row | null;
        if (recoverableOpen) {
          const recovered = this.recoverOutOfSyncOpenTrade(row, recoverableOpen);
          if (recovered) healed += 1;
        } else {
          const trade = parseJson<LogicalTrade>(String(row.data_json));
          const evidence =
            "No broker OPEN row recorded; trade cannot be recovered from MT5 history";
          const updated: LogicalTrade = {
            ...trade,
            status: "CANCELLED",
            livePositionExists: false,
            outOfSyncReason: undefined,
            matchedBrokerTickets: [],
            brokerComment: undefined,
            legs: trade.legs.map((leg) =>
              leg.status === "CLOSED"
                ? leg
                : { ...leg, status: "SKIPPED", brokerEvidence: evidence },
            ),
          };
          this.db
            .query("UPDATE logical_trades SET status = ?, data_json = ? WHERE id = ?")
            .run("CANCELLED", JSON.stringify(updated), tradeId);
          healed += 1;
        }
        continue;
      }
      if (String(realClose.action) !== "FULL_CLOSE" && realClose.id) {
        this.db
          .query("UPDATE broker_orders SET action = 'FULL_CLOSE' WHERE id = ?")
          .run(String(realClose.id));
      }
      const positionTicket = String(realClose.position_ticket ?? "");
      if (positionTicket) {
        // Drop the synthetic snapshot-diff row that pre-empted the real close.
        // Targeted by the comment + source + position combo to avoid touching
        // any actually-manual close the operator made through the terminal
        // (those have source='manual-terminal', not source='manual').
        this.db
          .query(
            `DELETE FROM broker_orders
             WHERE logical_trade_id = ?
               AND action = 'FULL_CLOSE'
               AND source = 'manual'
               AND position_ticket = ?
               AND broker_comment = 'Manual terminal intervention detected from snapshot diff'`,
          )
          .run(tradeId, positionTicket);
      }
      const trade = parseJson<LogicalTrade>(String(row.data_json));
      const evidence = [
        String(realClose.source),
        String(realClose.broker_comment ?? ""),
        `pnl:${realClose.pnl_currency ?? "0"}`,
      ]
        .filter(Boolean)
        .join(" | ");
      const updated: LogicalTrade = {
        ...trade,
        status: "CLOSED",
        livePositionExists: false,
        outOfSyncReason: undefined,
        matchedBrokerTickets: positionTicket ? [positionTicket] : trade.matchedBrokerTickets,
        lastSnapshotAt: String(realClose.created_at),
        legs: trade.legs.map((leg) =>
          leg.status === "CLOSED" || leg.status === "HIT"
            ? leg
            : { ...leg, status: "SKIPPED" as const, brokerEvidence: evidence },
        ),
      };
      this.db
        .query("UPDATE logical_trades SET status = ?, data_json = ? WHERE id = ?")
        .run("CLOSED", JSON.stringify(updated), tradeId);
      healed += 1;
    }
    if (healed > 0) {
      this.audit(
        "logical-trade.backfill",
        "info",
        `Reconciled ${healed} stuck trade${healed === 1 ? "" : "s"} with recorded close events`,
        { healed, scanned: stuck.length },
      );
    }
  }

  private recoverOutOfSyncOpenTrade(row: Row, openRow: Row) {
    const tradeId = String(row.id);
    const trade = parseJson<LogicalTrade>(String(row.data_json));
    const openQueue = this.originalOpenQueue(tradeId);
    if (!openQueue) return false;
    const action = String(openRow.action);
    const positionTicket = String(openRow.position_ticket ?? "");
    const orderTicket = String(openRow.order_ticket ?? "");
    const isOpen = action === "OPEN" && truthyBrokerTicket(positionTicket);
    const isPending = action === "PENDING_OPEN" && truthyBrokerTicket(orderTicket);
    if (!isOpen && !isPending) return false;

    const matchedTicket = isOpen ? positionTicket : orderTicket;
    const evidence = [
      "startup recovery",
      action.toLowerCase(),
      String(openRow.broker_comment ?? ""),
      matchedTicket ? `ticket:${matchedTicket}` : "",
    ]
      .filter(Boolean)
      .join(" | ");
    const nextLegStatus = isOpen ? "OPEN" : "PLANNED";
    const updated: LogicalTrade = {
      ...trade,
      status: isOpen ? "OPEN" : "PENDING",
      livePositionExists: isOpen,
      outOfSyncReason: undefined,
      matchedBrokerTickets: matchedTicket ? [matchedTicket] : trade.matchedBrokerTickets,
      brokerComment: String(openRow.broker_comment ?? trade.brokerComment ?? ""),
      lastSnapshotAt: String(openRow.created_at ?? new Date().toISOString()),
      legs: trade.legs.map((leg) =>
        leg.status === "CLOSED" || leg.status === "HIT"
          ? leg
          : { ...leg, status: nextLegStatus, brokerEvidence: evidence },
      ),
    };
    this.db
      .query("UPDATE logical_trades SET status = ?, data_json = ? WHERE id = ?")
      .run(updated.status, JSON.stringify(updated), tradeId);
    this.audit("logical-trade.backfill-recovered-open", "info", "Recovered stuck live trade", {
      logicalTradeId: tradeId,
      status: updated.status,
      matchedTicket,
      parsedSignalId: openQueue.parsedSignalId,
    });
    return true;
  }

  private ensureMockProvider(profileId: string) {
    this.db
      .query(
        "INSERT OR IGNORE INTO providers (id, profile_id, dialog_id, title, kind, enabled, parser_mode, risk_profile, lot_size, last_message_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        demoProviderId,
        profileId,
        "dialog-alpha",
        "Alpha FX Signals",
        "channel",
        0,
        "automatic",
        "balanced",
        defaultAppSettings.defaultLotSize,
        new Date().toISOString(),
      );
    this.ensureMessages(demoProviderId);
  }

  private ensureMessages(providerId: string) {
    const existing = this.db
      .query("SELECT id FROM raw_messages WHERE provider_id = ? LIMIT 1")
      .get(providerId) as Row | null;
    if (existing) return;
    demoMessages().forEach((message, index) => {
      const parsed = parseSignalText(
        message.rawText,
        this.parserContext(providerId, this.defaultParserAccountId(providerId)),
      );
      this.db
        .query(
          "INSERT INTO raw_messages (id, provider_id, telegram_message_id, message_date, raw_text, fingerprint, classification, forwarded_from, forward_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          `raw_demo_${providerId}_${index}`,
          providerId,
          message.telegramMessageId,
          message.messageDate,
          message.rawText,
          parsed.fingerprint,
          classifyParsedCommand(parsed.commandType),
          null,
          null,
        );
    });
  }

  private parserContext(
    providerId: string,
    accountId: string,
    overrides?: Pick<
      ProviderExecutionConfig,
      "parserMode" | "lockedSymbol" | "tradedSymbols" | "shorthandLevels"
    >,
  ) {
    const settings = this.appSettings();
    const providerConfig = this.providerConfig(providerId);
    const lockedSymbol = normalizeLockedSymbol(
      overrides?.lockedSymbol ?? providerConfig.lockedSymbol,
    );
    const tradedSymbols = normalizeTradedSymbols(
      overrides?.tradedSymbols ?? providerConfig.tradedSymbols,
    );
    const fallbackSymbol = tradedSymbols?.[0] ?? lockedSymbol;
    const providerDefaultSymbols = this.providerDefaultSymbols();
    if (fallbackSymbol) providerDefaultSymbols[providerId] = fallbackSymbol;
    const shorthandLevels = overrides?.shorthandLevels ?? providerConfig.shorthandLevels === true;
    return {
      providerId,
      accountId,
      parserMode: normalizeParserMode(overrides?.parserMode ?? providerConfig.parserMode),
      globalAliases: this.globalAliases(),
      providerAliases: this.providerAliases(),
      providerDefaultSymbols,
      geometryInferenceSymbol: fallbackSymbol,
      referencePrices: this.referencePricesForAccount(accountId),
      accountMappings: this.accountMappings(accountId),
      defaultStopLoss: { value: settings.defaultStopLossPips, unit: "PIPS" as const },
      defaultTakeProfit: { value: settings.defaultTakeProfitPips, unit: "PIPS" as const },
      shorthandLevels,
    };
  }

  private globalAliases() {
    const rows = this.db
      .query(
        "SELECT raw_symbol, canonical_symbol FROM symbol_aliases WHERE scope = 'global' ORDER BY raw_symbol",
      )
      .all() as Row[];
    return {
      ...defaultGlobalAliases,
      ...Object.fromEntries(
        rows.map((row) => [String(row.raw_symbol), String(row.canonical_symbol)]),
      ),
    };
  }

  private providerAliases() {
    const aliases: Record<string, Record<string, string>> = Object.fromEntries(
      Object.entries(defaultProviderAliases).map(([providerId, mappings]) => [
        providerId,
        { ...mappings },
      ]),
    );
    const rows = this.db
      .query(
        "SELECT provider_id, raw_symbol, canonical_symbol FROM symbol_aliases WHERE scope = 'provider' ORDER BY provider_id, raw_symbol",
      )
      .all() as Row[];
    for (const row of rows) {
      const providerId = String(row.provider_id);
      aliases[providerId] = {
        ...(aliases[providerId] ?? {}),
        [String(row.raw_symbol)]: String(row.canonical_symbol),
      };
    }
    return aliases;
  }

  private providerDefaultSymbols() {
    return Object.fromEntries(
      this.providers()
        .map((provider) => {
          const tradedSymbol = normalizeTradedSymbols(provider.tradedSymbols)?.[0];
          if (tradedSymbol) return [provider.id, tradedSymbol] as const;
          const lockedSymbol = normalizeLockedSymbol(provider.lockedSymbol);
          if (lockedSymbol) return [provider.id, lockedSymbol] as const;
          if (provider.title.toLowerCase().includes("kal")) return [provider.id, "XAUUSD"] as const;
          return undefined;
        })
        .filter((entry): entry is readonly [string, string] => Boolean(entry)),
    );
  }

  private referencePricesForAccount(accountId: string) {
    const snapshot = this.mt5SnapshotsByAccount()[accountId];
    if (!snapshot) return {};
    const updatedAt = Date.parse(snapshot.updatedAt);
    if (
      !Number.isFinite(updatedAt) ||
      Date.now() - updatedAt > REFERENCE_PRICE_MAX_AGE_SECONDS * 1000
    ) {
      return {};
    }

    const prices: Record<string, number> = {};
    for (const record of snapshot.symbols) {
      if (!record || typeof record !== "object") continue;
      const item = record as Record<string, unknown>;
      const rawSymbol = item.symbol ?? item.name;
      const symbol =
        typeof rawSymbol === "string" || typeof rawSymbol === "number"
          ? normalizeLockedSymbol(String(rawSymbol))
          : undefined;
      const bid = Number(item.bid ?? 0);
      const ask = Number(item.ask ?? 0);
      const price =
        Number.isFinite(bid) && bid > 0 && Number.isFinite(ask) && ask > 0
          ? (bid + ask) / 2
          : Number.isFinite(bid) && bid > 0
            ? bid
            : Number.isFinite(ask) && ask > 0
              ? ask
              : undefined;
      if (!symbol || price === undefined) continue;
      prices[symbol] = price;
      const compact = symbol.replace(/[\s/_.#-]/g, "");
      prices[compact] = price;
      if (compact.includes("XAUUSD") || compact.includes("GOLD")) {
        prices.XAUUSD = price;
        prices.GOLD = price;
      }
    }
    return prices;
  }

  private reparseSignalForAccount(
    signal: ParsedSignal,
    providerId: string,
    accountId: string,
  ): ParsedSignal {
    const context = this.parserContext(providerId, accountId);
    const candidates = parseSignalTexts(signal.originalText, context);
    return (
      candidates.find((candidate) => candidate.fingerprint === signal.fingerprint) ??
      candidates.find(
        (candidate) =>
          candidate.commandType === signal.commandType &&
          candidate.direction === signal.direction &&
          candidate.entry?.from === signal.entry?.from &&
          candidate.entry?.to === signal.entry?.to,
      ) ??
      candidates[0] ??
      parseSignalText(signal.originalText, context)
    );
  }

  private accountMappings(accountId: string): Record<string, AccountSymbolMapping> {
    return {
      [accountId]: this.storedAccountMapping(accountId) ?? defaultAccountMapping(accountId),
    };
  }

  private storedAccountMapping(accountId: string): AccountSymbolMapping | undefined {
    const row = this.db
      .query("SELECT mapping_json FROM account_symbol_mappings WHERE account_id = ?")
      .get(accountId) as Row | null;
    return row ? parseJson<AccountSymbolMapping>(String(row.mapping_json)) : undefined;
  }

  private accountMappingForBroker(
    accountId: string,
    availableSymbols: string[] | undefined,
  ): AccountSymbolMapping {
    const stored = this.storedAccountMapping(accountId);
    const existing = stored ?? defaultAccountMapping(accountId);
    const nextAvailable = availableSymbols ?? existing.availableBrokerSymbols ?? [];
    if (isLegacyDemoAccountMapping(existing) && brokerReportsPlainCoreSymbols(nextAvailable)) {
      return {
        accountId,
        canonicalOverrides: {},
        directBrokerOverrides: existing.directBrokerOverrides ?? {},
        prefix: "",
        suffix: "",
        includeSymbols: [],
        excludeSymbols: existing.excludeSymbols ?? [],
        availableBrokerSymbols: nextAvailable,
      };
    }
    // A stored mapping is operator-owned. Only infer affixes for a new account so a
    // dashboard heartbeat can never overwrite a prefix/suffix the operator set.
    if (stored) return { ...existing, accountId, availableBrokerSymbols: nextAvailable };
    const inferred = inferBrokerAffixes(nextAvailable);
    return {
      ...existing,
      accountId,
      ...inferred,
      availableBrokerSymbols: nextAvailable,
    };
  }

  private parseUnparsedProviderMessages(
    providerId: string,
    limit: number,
    accountId: string,
    newestFirst = false,
  ) {
    const rows = this.db
      .query(
        `SELECT id, provider_id, telegram_message_id, message_date, raw_text, fingerprint, classification
         FROM raw_messages
         WHERE provider_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM parsed_signals WHERE parsed_signals.raw_message_id = raw_messages.id
           )
         ORDER BY message_date ${newestFirst ? "DESC" : "ASC"}
         LIMIT ?`,
      )
      .all(providerId, limit) as Row[];
    return rows.flatMap((row) =>
      this.insertParsedSignals({
        providerId,
        rawMessageId: String(row.id),
        rawText: String(row.raw_text),
        accountId,
      }),
    );
  }

  private insertParsedSignals(input: {
    providerId: string;
    rawMessageId: string;
    rawText: string;
    accountId: string;
  }) {
    const results = parseSignalTexts(
      input.rawText,
      this.parserContext(input.providerId, input.accountId),
    );
    return this.insertParsedSignalRows({
      providerId: input.providerId,
      rawMessageId: input.rawMessageId,
      results,
      createdAt: new Date().toISOString(),
    });
  }

  private insertParsedSignalRows(input: {
    providerId: string;
    rawMessageId: string;
    results: ParsedSignal[];
    createdAt: string;
  }) {
    const aggressive =
      normalizeParserMode(this.providerConfig(input.providerId).parserMode) === "aggressive";
    return input.results.map((unfilteredResult) => {
      const tradedSymbolHoldReason = this.tradedSymbolHoldReason(
        input.providerId,
        unfilteredResult,
      );
      const result = tradedSymbolHoldReason
        ? {
            ...unfilteredResult,
            warnings: [...unfilteredResult.warnings, tradedSymbolHoldReason],
          }
        : unfilteredResult;
      const parsedSignalId = `parse_${nanoid(10)}`;
      // Adaptive learning: if the operator has approved this signal structure
      // enough times, stop flagging mapped open trades for review.
      const reviewRequired =
        (Boolean(tradedSymbolHoldReason) || shouldRequireManualReview(result, aggressive)) &&
        !learnedOverrideApplies(
          result,
          this.trainingExampleCount(input.providerId, structuralFingerprint(result.originalText)),
        );
      this.db
        .query(
          "INSERT INTO parsed_signals (id, provider_id, raw_message_id, result_json, review_required, fingerprint, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          parsedSignalId,
          input.providerId,
          input.rawMessageId,
          JSON.stringify(result),
          Number(reviewRequired),
          result.fingerprint,
          "PARSED",
          input.createdAt,
        );
      return {
        parsedSignalId,
        reviewRequired,
        result,
      };
    });
  }

  private telegramParserText(providerId: string, message: TelegramCapturedMessage) {
    if (message.quotedText) return telegramParserText(message);
    if (!message.replyToMessageId) return message.rawText;
    const quoted = this.db
      .query(
        `SELECT raw_messages.raw_text
         FROM raw_message_aliases
         JOIN raw_messages ON raw_messages.id = raw_message_aliases.raw_message_id
         WHERE raw_message_aliases.provider_id = ?
           AND raw_message_aliases.telegram_message_id = ?
           AND raw_messages.provider_id = ?`,
      )
      .get(providerId, message.replyToMessageId, providerId) as Row | null;
    return quoted?.raw_text
      ? telegramParserText({ ...message, quotedText: String(quoted.raw_text) })
      : message.rawText;
  }

  private rawMessageCount(providerId: string) {
    const row = this.db
      .query("SELECT COUNT(*) AS count FROM raw_messages WHERE provider_id = ?")
      .get(providerId) as Row | null;
    return Number(row?.count ?? 0);
  }

  private rawMessagesForBacktest(
    providerId: string,
    input: { dateFrom?: string; dateTo?: string },
  ) {
    if (input.dateFrom && input.dateTo) {
      return this.db
        .query(
          "SELECT telegram_message_id, message_date, raw_text FROM raw_messages WHERE provider_id = ? AND message_date >= ? AND message_date <= ? ORDER BY message_date ASC",
        )
        .all(providerId, input.dateFrom, input.dateTo) as Row[];
    }
    if (input.dateFrom) {
      return this.db
        .query(
          "SELECT telegram_message_id, message_date, raw_text FROM raw_messages WHERE provider_id = ? AND message_date >= ? ORDER BY message_date ASC",
        )
        .all(providerId, input.dateFrom) as Row[];
    }
    if (input.dateTo) {
      return this.db
        .query(
          "SELECT telegram_message_id, message_date, raw_text FROM raw_messages WHERE provider_id = ? AND message_date <= ? ORDER BY message_date ASC",
        )
        .all(providerId, input.dateTo) as Row[];
    }
    return this.db
      .query(
        "SELECT telegram_message_id, message_date, raw_text FROM raw_messages WHERE provider_id = ? ORDER BY message_date ASC",
      )
      .all(providerId) as Row[];
  }

  private rawMessage(messageId: string) {
    const row = this.db
      .query(
        "SELECT id, provider_id, telegram_message_id, message_date, raw_text, fingerprint, classification FROM raw_messages WHERE id = ?",
      )
      .get(messageId) as Row | null;
    if (!row) return undefined;
    return {
      id: String(row.id),
      providerId: String(row.provider_id),
      telegramMessageId: String(row.telegram_message_id),
      messageDate: String(row.message_date),
      rawText: String(row.raw_text),
      fingerprint: String(row.fingerprint),
      classification: String(row.classification) as RawMessageClassification,
    };
  }

  private ensureColumn(table: string, column: string, definition: string) {
    const columns = this.db.query(`PRAGMA table_info(${table})`).all() as Row[];
    if (columns.some((row) => row.name === column)) return;
    this.db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  private insertTrade(trade: LogicalTrade) {
    this.db
      .query(
        "INSERT OR REPLACE INTO logical_trades (id, provider_id, account_id, status, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        trade.id,
        trade.providerId ?? "",
        trade.accountId ?? "",
        trade.status,
        JSON.stringify(trade),
        trade.openedAt,
      );
    const telegramMessageId = trade.source?.telegramMessageId;
    if (telegramMessageId && telegramMessageId !== "manual") {
      this.db
        .query(
          "INSERT INTO trade_origins (provider_id, account_id, telegram_message_id, logical_trade_id, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(logical_trade_id) DO UPDATE SET provider_id = excluded.provider_id, account_id = excluded.account_id, telegram_message_id = excluded.telegram_message_id, created_at = excluded.created_at",
        )
        .run(
          trade.providerId ?? "",
          trade.accountId ?? "",
          telegramMessageId,
          trade.id,
          trade.openedAt,
        );
    }
  }

  private insertNonLeasedQueueItem(
    parsedSignalId: string,
    signal: ParsedSignal,
    status: Extract<QueueStatus, "DUPLICATE" | "IGNORED" | "EXPIRED" | "HELD">,
    options: {
      accountId: string;
      executionMode: ExecutionMode;
      settings: AppSettings;
      runner?: ProviderExecutionConfig["runner"];
      heldReason?: string;
      heldTier?: EvidenceTier;
      suggestion?: string;
    },
  ) {
    const providerId = signal.providerId ?? "";
    const providerConfig = this.providerConfig(providerId, options.accountId);
    const provider = this.providerDetails(providerId);
    const item = buildExecutionCommand(signal, {
      id: `queue_${nanoid(10)}`,
      accountId: options.accountId,
      executionMode: options.executionMode,
      volume:
        providerConfig.riskMode === "fixed"
          ? providerConfig.riskAmount
          : signal.commandType === "OPEN_TRADE"
            ? 0
            : (provider?.lotSize ?? options.settings.defaultLotSize),
      riskPercent:
        providerConfig.riskMode === "percent"
          ? providerConfig.riskAmount
          : options.settings.defaultRiskPercent,
      runner: options.runner,
    });
    item.status = status;
    return this.insertQueueItem(item, parsedSignalId, {
      heldReason: options.heldReason,
      heldTier: options.heldTier,
      suggestion: options.suggestion,
    });
  }

  private forwardedForParsedSignal(parsedSignalId: string) {
    const row = this.db
      .query(
        `SELECT raw_messages.forwarded_from, raw_messages.forward_date
         FROM parsed_signals
         JOIN raw_messages ON raw_messages.id = parsed_signals.raw_message_id
         WHERE parsed_signals.id = ?`,
      )
      .get(parsedSignalId) as Row | null;
    return Boolean(row?.forwarded_from || row?.forward_date);
  }

  private holdForEvidence(
    parsedSignalId: string,
    signal: ParsedSignal,
    accountId: string,
    executionMode: ExecutionMode,
    settings: AppSettings,
    reason: string,
    suggestion?: string,
    tier: EvidenceTier = "action-required",
  ) {
    const heldReason = `EVIDENCE_${reason}`;
    const queueItemId = this.insertNonLeasedQueueItem(parsedSignalId, signal, "HELD", {
      accountId,
      executionMode,
      settings,
      heldReason,
      heldTier: tier,
      suggestion,
    });
    this.db.query("UPDATE parsed_signals SET status = ? WHERE id = ?").run("HELD", parsedSignalId);
    this.audit("signal.evidence-hold", "warn", "Signal held by execution evidence gate", {
      parsedSignalId,
      providerId: signal.providerId,
      accountId,
      queueItemId,
      heldReason,
      suggestion,
    });
    this.alertHeldQueueItem(queueItemId, heldReason, true);
    return queueItemId;
  }

  private dropForEvidence(
    parsedSignalId: string,
    signal: ParsedSignal,
    accountId: string,
    executionMode: ExecutionMode,
    settings: AppSettings,
    reason: string,
  ) {
    const queueItemId = this.insertNonLeasedQueueItem(parsedSignalId, signal, "IGNORED", {
      accountId,
      executionMode,
      settings,
    });
    this.db
      .query("UPDATE parsed_signals SET status = ? WHERE id = ?")
      .run("IGNORED", parsedSignalId);
    this.audit("signal.evidence-drop", "warn", "Signal dropped by execution evidence gate", {
      parsedSignalId,
      providerId: signal.providerId,
      accountId,
      queueItemId,
      reason,
      firstWeekVocabularyAudit: hasExitVocabularyForDropAudit(signal.originalText),
    });
    return queueItemId;
  }

  private holdLifecycleForReconciliation(
    parsedSignalId: string,
    signal: ParsedSignal,
    accountId: string,
    executionMode: ExecutionMode,
    settings: AppSettings,
    runner: ProviderExecutionConfig["runner"],
    reason: string,
  ) {
    const heldReason = `LIFECYCLE_RECONCILIATION:${reason}`;
    const queueItemId = this.insertNonLeasedQueueItem(parsedSignalId, signal, "HELD", {
      accountId,
      executionMode,
      settings,
      runner: executionMode === "VIRTUAL_TP" ? runner : undefined,
      heldReason,
    });
    this.db.query("UPDATE parsed_signals SET status = ? WHERE id = ?").run("HELD", parsedSignalId);
    this.audit(
      "lifecycle.reconciliation-hold",
      "warn",
      "Lifecycle command held for reconciliation",
      {
        parsedSignalId,
        accountId,
        queueItemId,
        commandType: signal.commandType,
        reason,
        evidence: signal.originalText,
        heldReason,
      },
    );
    this.alertHeldQueueItem(queueItemId, heldReason);
    const providerRow = this.db
      .query("SELECT provider_id FROM parsed_signals WHERE id = ?")
      .get(parsedSignalId) as Row | null;
    if (providerRow?.provider_id && signal.commandType !== "OPEN_TRADE") {
      this.linkDroppedLifecycle(String(providerRow.provider_id), parsedSignalId, signal);
    }
    return queueItemId;
  }

  private hasDuplicateSignalFingerprint(
    providerId: string,
    accountId: string,
    signal: ParsedSignal,
    parsedSignalId: string,
  ) {
    if (signal.commandType !== "OPEN_TRADE") return false;
    const rows = this.db
      .query(
        `SELECT queue_items.status, logical_trades.status AS trade_status
         FROM parsed_signals
         JOIN queue_items ON queue_items.parsed_signal_id = parsed_signals.id
         LEFT JOIN logical_trades ON logical_trades.id = queue_items.logical_trade_id
         WHERE parsed_signals.provider_id = ?
           AND parsed_signals.fingerprint = ?
           AND parsed_signals.id != ?
           AND parsed_signals.status = 'APPROVED'
           AND queue_items.account_id = ?
           AND json_extract(queue_items.payload_json, '$.commandType') = 'OPEN_TRADE'
           AND parsed_signals.created_at > datetime('now', ?)`,
      )
      .all(
        providerId,
        signal.fingerprint,
        parsedSignalId,
        accountId,
        `-${this.appSettings().dedupWindowSeconds} seconds`,
      ) as Row[];
    return rows.some((row) => {
      const tradeStatus = row.trade_status ? String(row.trade_status) : "";
      if (tradeStatus && !["OPEN", "PENDING", "PLANNED", "OUT_OF_SYNC"].includes(tradeStatus)) {
        return false;
      }
      return ["PENDING", "LEASED", "HELD", "EXECUTED"].includes(String(row.status));
    });
  }

  private insertQueueItem(
    item: ExecutionQueueItem,
    parsedSignalId: string,
    metadata: {
      heldReason?: string;
      heldTier?: EvidenceTier;
      suggestion?: string;
      originQueueItemId?: string;
    } = {},
  ) {
    const now = new Date().toISOString();
    this.db
      .query(
        "INSERT INTO queue_items (id, parsed_signal_id, logical_trade_id, account_id, status, payload_json, lease_count, held_reason, held_tier, suggestion, origin_queue_item_id, leased_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        item.id,
        parsedSignalId,
        item.logicalTradeId ?? "",
        item.accountId ?? "",
        item.status,
        JSON.stringify(item.payload),
        0,
        metadata.heldReason ?? null,
        metadata.heldTier ?? null,
        metadata.suggestion ?? null,
        metadata.originQueueItemId ?? null,
        item.leasedAt ?? null,
        now,
        now,
      );
    return item.id;
  }

  private hasDuplicateOpenSignal(providerId: string, accountId: string, signal: ParsedSignal) {
    const symbol = normalizeLockedSymbol(
      signal.brokerSymbol ?? signal.canonicalSymbol ?? signal.rawSymbol,
    );
    if (
      signal.commandType !== "OPEN_TRADE" ||
      signal.providerOrderId ||
      !symbol ||
      !signal.direction ||
      !signal.orderType ||
      !signal.entry
    ) {
      return false;
    }
    const metadata = this.db
      .query(
        "SELECT digits FROM symbol_metadata WHERE account_id = ? AND upper(symbol) = upper(?) LIMIT 1",
      )
      .get(accountId, symbol) as Row | null;
    const fallbackDigits = Math.max(0, Math.ceil(-Math.log10(brokerPipSize(symbol))));
    const digits = Math.min(
      8,
      Math.max(0, Math.round(nullableNumber(metadata?.digits) ?? fallbackDigits)),
    );
    const entry = Number(signal.entry.from.toFixed(digits));
    const rows = this.db
      .query(
        `SELECT queue_items.payload_json, queue_items.status, logical_trades.status AS trade_status
         FROM queue_items
         JOIN parsed_signals ON parsed_signals.id = queue_items.parsed_signal_id
         LEFT JOIN logical_trades ON logical_trades.id = queue_items.logical_trade_id
         WHERE parsed_signals.provider_id = ?
           AND queue_items.account_id = ?
           AND json_extract(queue_items.payload_json, '$.commandType') = 'OPEN_TRADE'
           AND queue_items.status IN ('PENDING','LEASED','EXECUTED')
           AND (
             queue_items.status IN ('PENDING','LEASED')
             OR logical_trades.status IN ('OPEN','PENDING','OUT_OF_SYNC')
             OR unixepoch(queue_items.created_at) >= unixepoch('now') - ?
           )`,
      )
      .all(providerId, accountId, OPEN_SIGNAL_DEDUP_SECONDS) as Row[];
    return rows.some((row) => {
      const payload = parseJson<ExecutionQueueItem["payload"]>(String(row.payload_json));
      const tradeStatus = row.trade_status ? String(row.trade_status) : "";
      if (tradeStatus && !["OPEN", "PENDING", "PLANNED", "OUT_OF_SYNC"].includes(tradeStatus)) {
        return false;
      }
      const payloadSymbol = normalizeLockedSymbol(payload.brokerSymbol ?? payload.canonicalSymbol);
      return (
        payloadSymbol === symbol &&
        payload.direction === signal.direction &&
        payload.orderType === signal.orderType &&
        payload.entry !== undefined &&
        Number(payload.entry.from.toFixed(digits)) === entry &&
        (payload.stopLoss ?? null) === (signal.stopLoss ?? null) &&
        (["PENDING", "LEASED"].includes(String(row.status)) ||
          (tradeStatus && ["OPEN", "PENDING", "PLANNED", "OUT_OF_SYNC"].includes(tradeStatus)))
      );
    });
  }

  private hasDuplicateProviderOrderId(
    providerId: string,
    _accountId: string,
    signal: ParsedSignal,
  ) {
    if (signal.commandType !== "OPEN_TRADE" || !signal.providerOrderId) return false;
    // The provider id is durable evidence across accounts and terminal states;
    // a reposted id is an echo, not a new open.
    return (
      this.logicalTrades().some(
        (trade) =>
          trade.providerId === providerId &&
          trade.providerOrderId === signal.providerOrderId &&
          ["OPEN", "PENDING", "PLANNED", "CLOSED", "CANCELLED", "ARCHIVED", "OUT_OF_SYNC"].includes(
            trade.status,
          ),
      ) ||
      this.db
        .query(
          `SELECT 1
           FROM trade_origins
           JOIN logical_trades ON logical_trades.id = trade_origins.logical_trade_id
           WHERE trade_origins.provider_id = ?
             AND json_extract(logical_trades.data_json, '$.providerOrderId') = ?
           LIMIT 1`,
        )
        .get(providerId, signal.providerOrderId) !== null
    );
  }

  private executionPayloadHoldReason(
    accountId: string | undefined,
    payload: ExecutionQueueItem["payload"],
  ) {
    if (payload.commandType !== "OPEN_TRADE") return undefined;
    const orderType = payload.orderType ?? "MARKET";
    if (
      (orderType === "STOP" || orderType === "LIMIT") &&
      (!payload.entry || !Number.isFinite(payload.entry.from) || payload.entry.from <= 0)
    ) {
      return "NAKED_PENDING_ENTRY";
    }
    if (orderType !== "MARKET") return undefined;
    const quote = accountId ? this.latestQuote(accountId, payload.brokerSymbol) : undefined;
    // ponytail: no backend snapshot leaves fresh terminal-quote validation to the EA; hold once
    // the account snapshot proves it is watching symbols without a valid quote for this one.
    if (!quote?.hasQuoteData) return undefined;
    if (
      !quote?.quote ||
      !Number.isFinite(quote.quote.bid) ||
      !Number.isFinite(quote.quote.ask) ||
      quote.quote.bid <= 0 ||
      quote.quote.ask <= 0
    ) {
      return "NAKED_MARKET_NO_QUOTE";
    }
    return undefined;
  }

  private mt5SnapshotsByAccount() {
    const rows = this.db
      .query(
        "SELECT account_id, positions_json, orders_json, symbols_json, updated_at FROM mt5_snapshots",
      )
      .all() as Row[];
    const persisted = Object.fromEntries(
      rows.map((row) => [
        String(row.account_id),
        {
          positions: parseJson<unknown[]>(String(row.positions_json)),
          orders: parseJson<unknown[]>(String(row.orders_json)),
          symbols: parseJson<unknown[]>(String(row.symbols_json)),
          updatedAt: String(row.updated_at),
        },
      ]),
    );
    return { ...persisted, ...Object.fromEntries(this.liveMt5Snapshots) };
  }

  private reconcileSnapshotState(accountId: string, positions: unknown[], orders: unknown[]) {
    for (const trade of this.logicalTrades().filter((item) => item.accountId === accountId)) {
      const hasBrokerState =
        trade.status !== "PLANNED" || trade.legs.some((leg) => leg.status !== "PLANNED");
      // Skip trades we already know are done. Without the hasRecordedRealFullClose
      // guard, a snapshot poll would race the MT5 history sweep — history sets
      // status='CLOSED' when an SL/TP/expert close arrives, then 2 seconds later
      // the next snapshot doesn't see the ticket in positions[] and overwrites
      // status back to 'OUT_OF_SYNC'. That's how we ended up with 6 stuck
      // trades on prod despite the closes being recorded correctly.
      if (
        !hasBrokerState ||
        trade.status === "CLOSED" ||
        trade.status === "CANCELLED" ||
        trade.status === "ARCHIVED"
      )
        continue;
      if (this.hasRecordedRealFullClose(trade.id)) continue;

      const match = snapshotMatchForTrade(
        positions,
        orders,
        trade,
        this.brokerOrderTicketsForTrade(trade.id),
      );
      const pendingOpen = match.status === "missing" ? this.pendingOpenOrder(trade.id) : null;
      if (match.status === "missing" && this.pendingOpenMissingGraceActive(pendingOpen)) continue;
      const missingPendingOpen = pendingOpen ? this.missingPendingOpenOrder(pendingOpen) : null;
      const updated = missingPendingOpen
        ? cancelLogicalTrade(trade, {
            evidence: [
              "Pending broker order disappeared from latest MT5 snapshot",
              missingPendingOpen.orderTicket ? `order:${missingPendingOpen.orderTicket}` : "",
            ]
              .filter(Boolean)
              .join(" | "),
            lastSnapshotAt: match.lastSnapshotAt,
          })
        : snapshotSyncTradeState(trade, match);
      if (JSON.stringify(updated) === JSON.stringify(trade)) continue;
      this.db
        .query("UPDATE logical_trades SET status = ?, data_json = ? WHERE id = ?")
        .run(updated.status, JSON.stringify(updated), trade.id);
      // Only surface an event/audit on a real status transition — snapshots
      // arrive every ~2s and most updates only refresh lastSnapshotAt.
      if (updated.status !== trade.status) {
        this.emitEvent({
          type: "reconciliation",
          tradeId: trade.id,
          accountId,
          from: trade.status,
          to: updated.status,
        });
        this.audit(
          "logical-trade.reconciled",
          updated.status === "OUT_OF_SYNC" ? "warn" : "info",
          `Trade reconciled ${trade.status} → ${updated.status}`,
          {
            logicalTradeId: trade.id,
            accountId,
            from: trade.status,
            to: updated.status,
            reason: updated.outOfSyncReason,
          },
        );
      }
      if (missingPendingOpen) {
        this.audit(
          "logical-trade.pending-missing",
          "warn",
          "Cancelled missing broker pending order",
          {
            logicalTradeId: trade.id,
            orderTicket: missingPendingOpen.orderTicket,
            accountId,
          },
        );
      }
    }
  }

  private pendingOpenOrder(tradeId: string) {
    return this.db
      .query(
        `SELECT order_ticket, broker_comment, created_at
         FROM broker_orders
         WHERE logical_trade_id = ?
           AND action = 'PENDING_OPEN'
           AND order_ticket IS NOT NULL
           AND order_ticket NOT IN ('','0')
           AND NOT EXISTS (
             SELECT 1 FROM broker_orders AS opened
             WHERE opened.logical_trade_id = broker_orders.logical_trade_id
               AND opened.action = 'OPEN'
               AND opened.position_ticket IS NOT NULL
               AND opened.position_ticket NOT IN ('','0')
               AND opened.filled_price IS NOT NULL
               AND opened.filled_price > 0
           )
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(tradeId) as Row | null;
  }

  private pendingOpenMissingGraceActive(row: Row | null) {
    if (!row) return null;
    const createdAt = String(row.created_at ?? "");
    const created = Date.parse(normalizedDateInput(createdAt));
    const graceMs =
      Math.max(pendingOpenMissingGraceSeconds, this.appSettings().pollingIntervalSeconds * 2) *
      1000;
    return Number.isFinite(created) && Date.now() - created < graceMs;
  }

  private missingPendingOpenOrder(row: Row) {
    if (this.pendingOpenMissingGraceActive(row)) return null;
    const createdAt = String(row.created_at ?? "");
    return {
      orderTicket: String(row.order_ticket ?? ""),
      brokerComment: String(row.broker_comment ?? ""),
      createdAt,
    };
  }

  /**
   * True if there's at least one FULL_CLOSE row in broker_orders whose source
   * is a real DEAL_REASON close (TP hit, SL hit, EA close, manual terminal /
   * mobile / web, stop-out). Excludes the synthetic 'manual' rows written by
   * the snapshot-diff sweep so we don't treat a transient snapshot gap as
   * proof the trade is over.
   */
  private hasRecordedRealFullClose(tradeId: string): boolean {
    const row = this.db
      .query(
        `SELECT 1 FROM broker_orders
         WHERE logical_trade_id = ?
           AND action = 'FULL_CLOSE'
           AND source IN ('sl-hit','tp-hit','expert','stop-out','manual-terminal','manual-mobile','manual-web','history')
         LIMIT 1`,
      )
      .get(tradeId) as Row | null;
    return Boolean(row) || Boolean(this.coveringCloseForTrade(tradeId));
  }

  private coveringCloseForTrade(tradeId: string) {
    const openRows = this.db
      .query(
        `SELECT position_ticket, filled_volume
         FROM broker_orders
         WHERE logical_trade_id = ?
           AND action = 'OPEN'
           AND filled_volume IS NOT NULL
           AND filled_volume > 0
         ORDER BY created_at ASC`,
      )
      .all(tradeId) as Row[];

    const openVolumeByTicket = new Map<string, number>();
    for (const openRow of openRows) {
      const openVolume = nullableNumber(openRow.filled_volume);
      if (!openVolume || openVolume <= 0) continue;
      const rawPositionTicket = String(openRow.position_ticket ?? "");
      const positionTicket = truthyBrokerTicket(rawPositionTicket) ? rawPositionTicket : "";
      openVolumeByTicket.set(
        positionTicket,
        (openVolumeByTicket.get(positionTicket) ?? 0) + openVolume,
      );
    }

    let coveringClose: Row | null = null;
    for (const [positionTicket, openVolume] of openVolumeByTicket) {
      const params = [tradeId];
      let ticketFilter = "";
      if (truthyBrokerTicket(positionTicket)) {
        ticketFilter = "AND position_ticket = ?";
        params.push(positionTicket);
      }
      const closeRows = this.db
        .query(
          `SELECT id, action, position_ticket, source, broker_comment, pnl_currency, created_at, filled_volume
           FROM broker_orders
           WHERE logical_trade_id = ?
             ${ticketFilter}
             AND action IN ('FULL_CLOSE','PARTIAL_CLOSE')
             AND source != 'manual'
             AND filled_volume IS NOT NULL
             AND filled_volume > 0
           ORDER BY created_at ASC`,
        )
        .all(...params) as Row[];
      let closedVolume = 0;
      let ticketCoveringClose: Row | null = null;
      for (const closeRow of closeRows) {
        closedVolume += nullableNumber(closeRow.filled_volume) ?? 0;
        if (closedVolume >= openVolume - CLOSE_VOLUME_EPSILON) {
          ticketCoveringClose = closeRow;
          break;
        }
      }
      if (!ticketCoveringClose) return null;
      coveringClose = ticketCoveringClose;
    }
    return coveringClose;
  }

  private logicalTradesForDashboard() {
    return this.logicalTrades().map((trade) => {
      const matchedBrokerTickets =
        trade.status === "OUT_OF_SYNC"
          ? this.reconcilerCandidateBrokerTickets(trade)
          : (trade.matchedBrokerTickets ?? []);
      return {
        id: trade.id,
        symbol: trade.symbol.brokerSymbol ?? trade.symbol.canonicalSymbol ?? "unmapped",
        direction: trade.direction,
        status: trade.status,
        executionMode: trade.executionMode,
        source: trade.source,
        outOfSyncReason: trade.outOfSyncReason,
        livePositionExists: trade.livePositionExists,
        matchedBrokerTickets,
        brokerComment: trade.brokerComment,
        lastSnapshotAt: trade.lastSnapshotAt,
        legs: trade.legs.map((leg) => ({
          leg: leg.leg,
          targetPrice: leg.targetPrice,
          targetSource: leg.targetSource,
          defaultDistance: leg.defaultDistance,
          allocationPercent: leg.allocationPercent,
          volume: leg.volume,
          status: leg.status,
        })),
      };
    });
  }

  private logicalTrades() {
    return (
      this.db.query("SELECT data_json FROM logical_trades ORDER BY created_at DESC").all() as Row[]
    ).map((row) => parseJson<LogicalTrade>(String(row.data_json)));
  }

  private logicalTrade(tradeId: string) {
    const row = this.db
      .query("SELECT data_json FROM logical_trades WHERE id = ?")
      .get(tradeId) as Row | null;
    return row ? parseJson<LogicalTrade>(String(row.data_json)) : undefined;
  }

  private logicalTradeIdByShortId(shortId: string) {
    if (!shortId) return "";
    const matches = this.logicalTrades().filter(
      (trade) => shortLogicalTradeId(trade.id) === shortId,
    );
    return matches.length === 1 ? matches[0]!.id : "";
  }

  private appendTradeCommand(tradeId: string, signal: ParsedSignal) {
    const trade = this.logicalTrade(tradeId);
    if (!trade || trade.status === "ARCHIVED") return;
    const updated: LogicalTrade = {
      ...trade,
      commandHistory: [
        ...trade.commandHistory,
        {
          commandType: signal.commandType,
          text: signal.originalText,
          at: new Date().toISOString(),
        },
      ],
    };
    this.db
      .query("UPDATE logical_trades SET data_json = ? WHERE id = ?")
      .run(JSON.stringify(updated), tradeId);
  }

  private recordProviderTpHit(tradeId: string, signal: ParsedSignal) {
    const trade = this.logicalTrade(tradeId);
    if (!trade) return;

    const hitLeg = tpHitLegFromText(signal.originalText, trade);
    const announced = (leg: LogicalTrade["legs"][number]) =>
      hitLeg === "all" || (typeof hitLeg === "number" && leg.leg === hitLeg);

    // A provider-announced TP hit on a 0%-allocation leg must still move the stop. Marking the
    // leg HIT takes it out of the virtual-TP monitor's reach, so the announcement would
    // otherwise silently consume the only trigger the stop strategy had. Providers that post
    // "TP1 hit" (KAL VIP does) would never get break-even applied.
    //
    // Resolve the stop BEFORE persisting any HIT. A normal OPEN_TRADE report clears
    // matchedBrokerTickets until the next matching snapshot, so an announcement landing in that
    // window has no ticket to modify. Burning the leg there would strand the original stop for
    // the life of the trade, so those legs stay OPEN and the monitor picks them up instead.
    const positionTicket = trade.matchedBrokerTickets?.find((ticket) => truthyBrokerTicket(ticket));
    const pendingReference = trade.legs.filter(
      (leg) => announced(leg) && leg.status === "OPEN" && isReferenceVirtualTpLeg(leg),
    );
    const broker = positionTicket
      ? this.latestPositionStop(trade, positionTicket)
      : { known: false, stopLoss: undefined };
    const quote = this.liveMt5Snapshots
      .get(trade.accountId ?? "")
      ?.symbols.find(
        (item) =>
          item &&
          typeof item === "object" &&
          String((item as Record<string, unknown>).symbol ?? "").toUpperCase() ===
            (trade.symbol.brokerSymbol ?? trade.symbol.canonicalSymbol ?? "").toUpperCase(),
      ) as Record<string, unknown> | undefined;
    const marketPrice = Number(trade.direction === "BUY" ? (quote?.bid ?? 0) : (quote?.ask ?? 0));

    this.db.transaction(() => {
      const resolvedReference =
        positionTicket && broker.known
          ? this.queueCoalescedReferenceStop({
              trade,
              positionTicket,
              legs: pendingReference,
              source: "provider-announced",
              brokerStateKnown: true,
              brokerStopLoss: broker.stopLoss,
              marketPrice,
            })
          : new Set<number>();
      // The provider telling us a target was reached is durable evidence of a crossing, even
      // when the stop cannot be placed right now (price retraced past it while we were down, so
      // the desired stop sits on the wrong side of market). Record the crossing on the watermark
      // so the monitor retries it. Without this the announcement is discarded and break-even is
      // never applied, which is the incident shape that motivated v1.65.4 in the first place.
      const unresolved = pendingReference.filter((leg) => !resolvedReference.has(leg.leg));
      const openPrice = this.openPriceForTrade(trade.id) ?? trade.entry?.from;
      let watermark = trade.virtualTpWatermark;
      if (positionTicket && unresolved.length) {
        const reached = unresolved
          .map((leg) => virtualTpTargetPrice(trade, leg, openPrice))
          .filter((value): value is number => Number.isFinite(value) && (value ?? 0) > 0);
        if (reached.length) {
          const best = trade.direction === "BUY" ? Math.max(...reached) : Math.min(...reached);
          const previous =
            watermark?.positionTicket === positionTicket ? watermark.favorablePrice : undefined;
          const favorablePrice =
            previous === undefined
              ? best
              : trade.direction === "BUY"
                ? Math.max(previous, best)
                : Math.min(previous, best);
          if (favorablePrice !== previous) {
            watermark = { positionTicket, favorablePrice, observedAt: nowIso() };
          }
        }
      }
      const updated: LogicalTrade = {
        ...trade,
        virtualTpWatermark: watermark,
        legs: trade.legs.map((leg) => {
          if (!announced(leg)) return leg;
          if (isReferenceVirtualTpLeg(leg) && !resolvedReference.has(leg.leg)) return leg;
          return { ...leg, status: "HIT", brokerEvidence: "provider-announced" };
        }),
        commandHistory: [
          ...trade.commandHistory,
          {
            commandType: signal.commandType,
            text: signal.originalText,
            at: new Date().toISOString(),
          },
        ],
      };
      this.db
        .query("UPDATE logical_trades SET data_json = ? WHERE id = ?")
        .run(JSON.stringify(updated), tradeId);
    })();
  }

  private resizePartialOpen(
    trade: LogicalTrade,
    payload: ExecutionQueueItem["payload"],
    input: ExecutionReportInput,
  ) {
    const filledVolume = Number(input.filledVolume ?? 0);
    if (!Number.isFinite(filledVolume) || filledVolume <= 0) return trade;
    const takeProfits = withTakeProfitVolumes(
      payload.takeProfits,
      "OPEN_TRADE",
      filledVolume,
      payload.runner,
    );
    const byLeg = new Map(takeProfits.map((target) => [target.leg, target]));
    const updated: LogicalTrade = {
      ...trade,
      status: "OPEN",
      outOfSyncReason: `Partial open fill: ${filledVolume} filled of ${input.requestedVolume ?? payload.volume ?? "unknown"}`,
      legs: trade.legs.map((leg) => {
        const target = byLeg.get(leg.leg);
        return target
          ? {
              ...leg,
              allocationPercent: target.allocationPercent,
              volume: target.volume,
              // A reference leg that already fired must not be reopened by a late partial
              // opening report, or the next snapshot evaluates it a second time.
              status: leg.status === "HIT" ? ("HIT" as const) : ("OPEN" as const),
              brokerEvidence: leg.status === "HIT" ? leg.brokerEvidence : executionEvidence(input),
            }
          : { ...leg, allocationPercent: 0, volume: undefined, status: "SKIPPED" as const };
      }),
    };
    this.db
      .query("UPDATE queue_items SET payload_json = ? WHERE id = ?")
      .run(JSON.stringify({ ...payload, takeProfits, volume: filledVolume }), input.queueItemId);
    return updated;
  }

  private reconcileExecutionReport(input: ExecutionReportInput) {
    const row = this.db
      .query("SELECT logical_trade_id, payload_json FROM queue_items WHERE id = ?")
      .get(input.queueItemId) as Row | null;
    const tradeId = row?.logical_trade_id ? String(row.logical_trade_id) : "";
    if (!row || !tradeId) return;

    const trade = this.logicalTrade(tradeId);
    if (!trade || trade.status === "ARCHIVED") return;

    const payload = parseJson<ExecutionQueueItem["payload"]>(String(row.payload_json));
    const evidence = executionEvidence(input);
    const virtualTpLeg = virtualTpLegFromExecutionReport(payload, input);
    let updated: LogicalTrade = trade;

    if (
      input.status === "PARTIAL" &&
      payload.commandType === "OPEN_TRADE" &&
      Number(input.filledVolume ?? 0) > 0
    ) {
      // Keep the partially filled position manageable, but hold its original
      // queue item so no retry can enlarge it.
      updated = this.resizePartialOpen(trade, payload, input);
    } else if (input.status === "UNKNOWN" || input.status === "PARTIAL") {
      // A broker action may already have happened. Keep the trade live and the
      // queue held until snapshot/history evidence reconciles it; never replay.
      updated = trade;
    } else if (input.status === "FAILED") {
      if (payload.commandType === "OPEN_TRADE") {
        updated = {
          ...trade,
          status: "OUT_OF_SYNC",
          legs: trade.legs.map((leg) => ({ ...leg, status: "FAILED", brokerEvidence: evidence })),
        };
      } else if (isPositionGoneFailure(input) && trade.status !== "PENDING") {
        // The targeted position is already gone, so the close/SL-modify is
        // effectively done. Mark the targeted leg(s) terminal so nothing
        // re-queues this command against a vanished position (the virtual-TP
        // retry loop). A full-close / SL-modify with no specific leg retires
        // every still-open leg; a TP-leg close retires just that leg.
        const targetLeg =
          virtualTpLegFromExecutionReport(payload, input) ??
          (payload.commandType === "CLOSE_PARTIAL" && payload.partialClose?.kind === "TP_LEG"
            ? payload.partialClose.value
            : undefined);
        const legs = trade.legs.map((leg) =>
          (targetLeg === undefined || leg.leg === targetLeg) && leg.status !== "CLOSED"
            ? {
                ...leg,
                status: "CLOSED" as const,
                brokerEvidence: `position gone: ${input.brokerComment}`,
              }
            : leg,
        );
        updated = { ...trade, status: virtualTpStatusAfterLegClose(trade, legs, payload), legs };
      }
      // Other failures (invalid stops, no money, autotrading disabled) leave the
      // trade unchanged so the operator can intervene.
    } else if (virtualTpLeg !== undefined) {
      const legs = trade.legs.map((leg) =>
        leg.leg === virtualTpLeg
          ? { ...leg, status: "CLOSED" as const, brokerEvidence: evidence }
          : leg,
      );
      updated = {
        ...trade,
        status: virtualTpStatusAfterLegClose(trade, legs, payload),
        legs,
      };
      const positionTicket = input.positionTicket;
      if (truthyBrokerTicket(positionTicket)) {
        this.queueSlStrategyAfterTpClose(updated, virtualTpLeg, positionTicket);
      }
    } else if (isPendingOrderAcceptance(payload, input)) {
      updated = {
        ...trade,
        status: "PENDING",
        outOfSyncReason: undefined,
        livePositionExists: false,
        matchedBrokerTickets: input.orderTicket ? [input.orderTicket] : trade.matchedBrokerTickets,
        brokerComment: input.brokerComment,
        lastSnapshotAt: new Date().toISOString(),
        legs: trade.legs.map((leg) =>
          leg.status === "OPEN" ? { ...leg, status: "PLANNED" as const } : leg,
        ),
      };
    } else if (payload.commandType === "OPEN_TRADE") {
      updated = {
        ...trade,
        status: "OPEN",
        outOfSyncReason: undefined,
        livePositionExists: undefined,
        matchedBrokerTickets: undefined,
        brokerComment: undefined,
        lastSnapshotAt: undefined,
        legs: trade.legs.map((leg) =>
          leg.status === "PLANNED" ? { ...leg, status: "OPEN", brokerEvidence: evidence } : leg,
        ),
      };
    } else if (payload.commandType === "CLOSE_TRADE") {
      if (this.coveringCloseForTrade(trade.id)) {
        updated = {
          ...trade,
          status: "CLOSED",
          legs: trade.legs.map((leg) => ({ ...leg, status: "CLOSED", brokerEvidence: evidence })),
        };
      } else if (input.status === "EXECUTED") {
        const filled = Number(input.filledVolume ?? 0);
        const remaining = Number(input.remainingVolume ?? 0);
        const runnerPreserved =
          payload.runner?.enabled &&
          remaining > CLOSE_VOLUME_EPSILON &&
          this.runnerRemainderMatches(input.accountId, trade, remaining, payload.runner.lotSize);
        updated = {
          ...trade,
          status:
            trade.status === "PENDING" && filled <= 0 && !truthyBrokerTicket(input.positionTicket)
              ? "CANCELLED"
              : runnerPreserved
                ? "OPEN"
                : "CLOSED",
          livePositionExists: runnerPreserved,
          matchedBrokerTickets:
            runnerPreserved && input.positionTicket ? [input.positionTicket] : [],
          legs: trade.legs.map((leg) => ({
            ...leg,
            status:
              trade.status === "PENDING" && filled <= 0 && !truthyBrokerTicket(input.positionTicket)
                ? "SKIPPED"
                : "CLOSED",
            brokerEvidence: evidence,
          })),
        };
        if (runnerPreserved && truthyBrokerTicket(input.positionTicket) && payload.runner) {
          this.queueRunnerSlStrategy(
            updated,
            input.positionTicket,
            payload.runner,
            String(row.parsed_signal_id ?? ""),
          );
        }
      }
    } else if (payload.commandType === "CANCEL_PENDING") {
      updated = {
        ...trade,
        status: "CANCELLED",
        livePositionExists: false,
        matchedBrokerTickets: [],
        legs: trade.legs.map((leg) => ({ ...leg, status: "CLOSED", brokerEvidence: evidence })),
      };
    } else if (payload.commandType === "CLOSE_PARTIAL" && payload.partialClose?.kind === "TP_LEG") {
      const closedLeg = payload.partialClose.value;
      updated = {
        ...trade,
        legs: trade.legs.map((leg) =>
          leg.leg === closedLeg ? { ...leg, status: "CLOSED", brokerEvidence: evidence } : leg,
        ),
      };
      if (truthyBrokerTicket(input.positionTicket)) {
        this.queueSlStrategyAfterTpClose(updated, closedLeg, input.positionTicket);
      }
    }

    if (updated === trade) return;
    this.db
      .query("UPDATE logical_trades SET status = ?, data_json = ? WHERE id = ?")
      .run(updated.status, JSON.stringify(updated), trade.id);
  }

  private recordBrokerOrder(input: ExecutionReportInput) {
    const row = this.db
      .query("SELECT logical_trade_id, payload_json FROM queue_items WHERE id = ?")
      .get(input.queueItemId) as Row | null;
    const tradeId = row?.logical_trade_id ? String(row.logical_trade_id) : "";
    if (!row || !tradeId) return;

    const payload = parseJson<ExecutionQueueItem["payload"]>(String(row.payload_json));
    const action = brokerActionForReport(payload, input);
    const pnl = this.computeBrokerOrderPnl(tradeId, payload, input, action);
    const now = new Date().toISOString();
    this.db
      .query(
        `INSERT INTO broker_orders
          (id, logical_trade_id, leg_id, action, queue_item_id, account_id, order_ticket, position_ticket, deal_ticket,
           requested_volume, filled_volume, requested_price, filled_price, retcode, retcode_external, broker_comment, pnl_currency, pnl_pips, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `broker_${nanoid(10)}`,
        tradeId,
        brokerLegId(payload, input),
        action,
        input.queueItemId,
        input.accountId,
        input.orderTicket ?? "",
        input.positionTicket ?? "",
        input.dealTicket ?? "",
        input.requestedVolume ?? payload.volume ?? null,
        input.filledVolume ?? input.volume ?? null,
        input.requestedPrice ?? null,
        input.filledPrice ?? null,
        input.retcode,
        input.retcodeExternal,
        input.brokerComment,
        pnl.pnlCurrency,
        pnl.pnlPips,
        brokerOrderSourceForPayload(payload, input),
        now,
      );
  }

  private brokerTargetForCommand(logicalTradeId: string, payload: ExecutionQueueItem["payload"]) {
    const action = brokerAction(payload.commandType);
    const rows = this.brokerOrders(logicalTradeId).slice().reverse();
    // Pending cancellations and full closes deliberately omit a target ticket:
    // the EA matches every still-live order/position bearing this logical trade
    // comment and confirms the command only after the full set is handled.
    if (action === "CANCEL_PENDING" || action === "FULL_CLOSE") return {};
    const position = rows.find(
      (row) =>
        truthyBrokerTicket(row.positionTicket) &&
        row.action !== "FULL_CLOSE" &&
        row.action !== "PARTIAL_CLOSE" &&
        row.action !== "PENDING_OPEN",
    );
    return {
      targetPositionTicket: position?.positionTicket,
      targetOrderTicket: position?.orderTicket,
      targetDealTicket: position?.dealTicket,
    };
  }

  private withAbsolutePartialCloseTarget(
    signal: ParsedSignal,
    trade: LogicalTrade,
    accountId: string,
  ) {
    if (signal.commandType !== "CLOSE_PARTIAL" || signal.partialClose?.kind !== "PERCENT") {
      return signal;
    }
    const snapshot = this.mt5SnapshotsByAccount()[accountId];
    if (!snapshot) return undefined;
    const position = matchedBrokerRecordForTrade(
      snapshot.positions,
      trade,
      this.brokerOrderTicketsForTrade(trade.id),
    );
    const currentVolume = Number((position as Record<string, unknown> | undefined)?.volume ?? 0);
    if (!Number.isFinite(currentVolume) || currentVolume <= 0) return undefined;
    const targetRemainingVolume = Number(
      (currentVolume * (1 - signal.partialClose.value / 100)).toFixed(8),
    );
    if (targetRemainingVolume < 0 || targetRemainingVolume >= currentVolume) return undefined;
    return {
      ...signal,
      partialClose: { ...signal.partialClose, targetRemainingVolume },
    };
  }

  private reconcileManualBrokerClosures(
    accountId: string,
    positions: unknown[],
    orders: unknown[],
  ) {
    const liveTickets = new Set(
      [...positions, ...orders]
        .map((record) => brokerTicketFromSnapshot(record))
        .filter((value): value is string => Boolean(value)),
    );
    const rows = this.db
      .query(
        `SELECT logical_trade_id, leg_id, position_ticket, order_ticket
         FROM broker_orders
         WHERE account_id = ?
           AND action = 'OPEN'
           AND position_ticket IS NOT NULL
           AND position_ticket NOT IN ('','0')`,
      )
      .all(accountId) as Row[];
    for (const row of rows) {
      const ticket = String(row.position_ticket || row.order_ticket || "");
      if (!ticket || liveTickets.has(ticket)) continue;
      // Skip if a snapshot-diff manual row already exists, OR if the broker
      // history sweep has already recorded the close with a real reason
      // (sl-hit, tp-hit, expert, manual-mobile, etc). Without this guard,
      // every TP/SL close would also get a duplicate `source='manual'` row
      // from the snapshot diff, polluting the History trail.
      const duplicate = this.db
        .query(
          `SELECT id FROM broker_orders
           WHERE account_id = ? AND (position_ticket = ? OR order_ticket = ?)
             AND (
               (action = 'FULL_CLOSE' AND source = 'manual')
               OR (action IN ('FULL_CLOSE','PARTIAL_CLOSE') AND source IN
                   ('sl-hit','tp-hit','expert','manual-terminal','manual-mobile','manual-web','stop-out','history'))
             )
           LIMIT 1`,
        )
        .get(accountId, ticket, ticket) as Row | null;
      if (duplicate) continue;
      this.db
        .query(
          `INSERT INTO broker_orders
            (id, logical_trade_id, leg_id, action, queue_item_id, account_id, order_ticket, position_ticket, deal_ticket,
             requested_volume, filled_volume, requested_price, filled_price, retcode, retcode_external, broker_comment, pnl_currency, pnl_pips, source, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          `broker_${nanoid(10)}`,
          String(row.logical_trade_id),
          String(row.leg_id || "trade"),
          "FULL_CLOSE",
          "manual",
          accountId,
          String(row.order_ticket ?? ""),
          String(row.position_ticket ?? ""),
          "",
          null,
          null,
          null,
          null,
          0,
          0,
          "Manual terminal intervention detected from snapshot diff",
          null,
          null,
          "manual",
          new Date().toISOString(),
        );
    }
  }

  private logicalTradeIdForHistoryDeal(deal: Mt5HistoryDealInput) {
    const fromComment = logicalTradeIdFromComment(deal.comment ?? "");
    if (fromComment && this.logicalTrade(fromComment)) return fromComment;
    const fromShortComment = this.logicalTradeIdByShortId(
      shortLogicalTradeIdFromComment(deal.comment ?? ""),
    );
    if (fromShortComment) return fromShortComment;
    if (deal.positionTicket) {
      const row = this.db
        .query(
          "SELECT logical_trade_id FROM broker_orders WHERE position_ticket = ? ORDER BY created_at DESC LIMIT 1",
        )
        .get(deal.positionTicket) as Row | null;
      if (row) return String(row.logical_trade_id);
    }
    if (deal.orderTicket) {
      const row = this.db
        .query(
          "SELECT logical_trade_id FROM broker_orders WHERE order_ticket = ? ORDER BY created_at DESC LIMIT 1",
        )
        .get(deal.orderTicket) as Row | null;
      if (row) return String(row.logical_trade_id);
    }
    return undefined;
  }

  private openBrokerOrderForDeal(tradeId: string, deal: Mt5HistoryDealInput) {
    if (deal.positionTicket) {
      const row = this.db
        .query(
          `SELECT * FROM broker_orders
           WHERE logical_trade_id = ?
             AND position_ticket = ?
             AND action = 'OPEN'
             AND filled_price IS NOT NULL
             AND filled_price > 0
           ORDER BY created_at ASC LIMIT 1`,
        )
        .get(tradeId, deal.positionTicket) as Row | null;
      if (row) return row;
    }
    const realOpen = this.db
      .query(
        `SELECT * FROM broker_orders
         WHERE logical_trade_id = ?
           AND action = 'OPEN'
           AND position_ticket IS NOT NULL
           AND position_ticket NOT IN ('','0')
           AND filled_price IS NOT NULL
           AND filled_price > 0
         ORDER BY created_at ASC LIMIT 1`,
      )
      .get(tradeId) as Row | null;
    if (realOpen) return realOpen;
    return this.db
      .query(
        "SELECT * FROM broker_orders WHERE logical_trade_id = ? AND action = 'OPEN' ORDER BY created_at ASC LIMIT 1",
      )
      .get(tradeId) as Row | null;
  }

  private positionStillOpen(accountId: string, positionTicket: string) {
    if (!positionTicket) return false;
    const snapshot = this.mt5SnapshotsByAccount()[accountId];
    return (
      snapshot?.positions.some((record) => brokerTicketFromSnapshot(record) === positionTicket) ??
      false
    );
  }

  private brokerOrderTicketsForTrade(tradeId: string) {
    const rows = this.db
      .query(
        "SELECT position_ticket, order_ticket FROM broker_orders WHERE logical_trade_id = ? AND (position_ticket != '' OR order_ticket != '')",
      )
      .all(tradeId) as Row[];
    return new Set(
      rows
        .flatMap((row) => [String(row.position_ticket || ""), String(row.order_ticket || "")])
        .filter(Boolean),
    );
  }

  private computeBrokerOrderPnl(
    tradeId: string,
    payload: ExecutionQueueItem["payload"],
    input: ExecutionReportInput,
    action = brokerAction(payload.commandType),
  ) {
    const filledVolume = input.filledVolume ?? input.volume;
    if (!input.filledPrice || !filledVolume || !payload.direction) {
      return { pnlCurrency: null, pnlPips: null };
    }
    if (
      action === "OPEN" ||
      action === "MODIFY_SL" ||
      action === "MODIFY_TP" ||
      action === "CANCEL_PENDING"
    ) {
      return { pnlCurrency: null, pnlPips: null };
    }
    const open = this.db
      .query(
        `SELECT filled_price FROM broker_orders
         WHERE logical_trade_id = ?
           AND action = 'OPEN'
           AND position_ticket IS NOT NULL
           AND position_ticket NOT IN ('','0')
           AND filled_price IS NOT NULL
           AND filled_price > 0
         ORDER BY created_at ASC LIMIT 1`,
      )
      .get(tradeId) as Row | null;
    const openPrice = nullableNumber(open?.filled_price);
    if (!openPrice) return { pnlCurrency: null, pnlPips: null };
    const signed =
      payload.direction === "BUY" ? input.filledPrice - openPrice : openPrice - input.filledPrice;
    const pipSize = brokerPipSize(payload.brokerSymbol ?? payload.canonicalSymbol ?? "");
    return {
      pnlCurrency: null,
      pnlPips: pipSize > 0 ? Number((signed / pipSize).toFixed(1)) : null,
    };
  }

  /**
   * Record an operator-approved signal shape so the parser can learn to stop
   * flagging that structure for review. Stored per provider, keyed by a
   * number-stripped structural fingerprint.
   */
  private recordTrainingExample(providerId: string, rawText: string, signal: ParsedSignal) {
    if (!providerId || signal.commandType !== "OPEN_TRADE" || !rawText.trim()) return;
    this.db
      .query(
        `INSERT INTO parser_training_examples
           (id, provider_id, fingerprint, raw_text, command_type, symbol, direction, entry, stop_loss, take_profits_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `train_${nanoid(10)}`,
        providerId,
        structuralFingerprint(rawText),
        rawText,
        signal.commandType,
        signal.canonicalSymbol ?? signal.rawSymbol ?? null,
        signal.direction ?? null,
        signal.entry?.from ?? null,
        signal.stopLoss ?? null,
        JSON.stringify(signal.takeProfits.map((tp) => tp.price ?? null)),
        nowIso(),
      );
  }

  private trainingExampleCount(providerId: string, fingerprint: string): number {
    const row = this.db
      .query(
        "SELECT COUNT(*) AS count FROM parser_training_examples WHERE provider_id = ? AND fingerprint = ?",
      )
      .get(providerId, fingerprint) as Row | null;
    return Number(row?.count ?? 0);
  }

  /** Number of distinct structures the parser has learned (>=3 examples) for a provider. */
  learnedPatternCount(providerId: string): number {
    const row = this.db
      .query(
        "SELECT COUNT(*) AS count FROM (SELECT fingerprint FROM parser_training_examples WHERE provider_id = ? GROUP BY fingerprint HAVING COUNT(*) >= 3)",
      )
      .get(providerId) as Row | null;
    return Number(row?.count ?? 0);
  }

  /** Clears learned examples for a provider and reverts to default review behaviour. */
  resetProviderLearning(providerId: string): { providerId: string; cleared: number } {
    const before = this.db
      .query("SELECT COUNT(*) AS count FROM parser_training_examples WHERE provider_id = ?")
      .get(providerId) as Row | null;
    this.db.query("DELETE FROM parser_training_examples WHERE provider_id = ?").run(providerId);
    const cleared = Number(before?.count ?? 0);
    this.audit(
      "provider.learning.reset",
      "info",
      "Parser learning reset for provider",
      { providerId, cleared },
      "operator",
    );
    return { providerId, cleared };
  }

  /** Rolling provider quality score from broker fills, cached until the store mutates. */
  providerScore(providerId: string, syncExternalRevision = true) {
    if (syncExternalRevision) this.syncExternalStoreRevision();
    const cached = this.providerScoreCache.get(providerId);
    if (cached?.revision === this.storeRevision) return cached.score;
    const score = this.computeProviderScore(providerId);
    this.providerScoreCache.set(providerId, { revision: this.storeRevision, score });
    return score;
  }

  private computeProviderScore(providerId: string) {
    const provider = this.providers().find((item) => item.id === providerId);
    if (!provider) return null;
    const trades = this.logicalTrades().filter((trade) => trade.providerId === providerId);
    const scoreTrades: ScoreTrade[] = [];
    for (const trade of trades) {
      const orders = this.brokerOrders(trade.id);
      const closeOrders = orders.filter(
        (order) => order.action === "FULL_CLOSE" || order.action === "PARTIAL_CLOSE",
      );
      if (closeOrders.length === 0) continue;
      const pnl = roundCurrency(
        closeOrders.reduce((sum, order) => sum + (order.pnlCurrency ?? 0), 0),
      );
      const pips = Number(
        closeOrders.reduce((sum, order) => sum + (order.pnlPips ?? 0), 0).toFixed(1),
      );
      const closeAt = closeOrders
        .map((order) => order.createdAt)
        .sort()
        .at(-1) as string;
      const openAt = orders
        .filter((order) => order.action === "OPEN")
        .map((order) => order.createdAt)
        .sort()[0];
      const signalAt = trade.source?.messageDate;
      let latencyMs: number | undefined;
      if (signalAt && openAt) {
        const delta =
          Date.parse(normalizedDateInput(openAt)) - Date.parse(normalizedDateInput(signalAt));
        if (Number.isFinite(delta)) latencyMs = Math.max(0, delta);
      }
      scoreTrades.push({ pnl, pips, closeAt, latencyMs });
    }
    const reviewRow = this.db
      .query(
        "SELECT COUNT(*) AS total, COALESCE(SUM(review_required), 0) AS reviewed FROM parsed_signals WHERE provider_id = ?",
      )
      .get(providerId) as Row | null;
    const cfgRow = this.db
      .query("SELECT provider_config_json FROM providers WHERE id = ?")
      .get(providerId) as Row | null;
    const config = cfgRow
      ? (parseJson<{ scoreThresholds?: { green?: number; amber?: number } }>(
          String(cfgRow.provider_config_json),
        ) ?? {})
      : {};
    const score = computeProviderScore(scoreTrades, {
      reviewRequired: Number(reviewRow?.reviewed ?? 0),
      reviewTotal: Number(reviewRow?.total ?? 0),
      thresholds: config.scoreThresholds,
    });
    return {
      providerId,
      title: provider.title,
      learnedPatterns: this.learnedPatternCount(providerId),
      ...score,
    };
  }

  /** Closed trades with full detail across one or all accounts, for JSON export. */
  exportClosedTrades(input: { accountId?: string; from?: string; to?: string } = {}) {
    const accounts = input.accountId
      ? this.mt5Accounts().filter((account) => account.id === input.accountId)
      : this.mt5Accounts();
    const providerTitle = new Map(
      this.providers().map((provider) => [provider.id, provider.title]),
    );
    const tradeProvider = new Map(
      this.logicalTrades().map((trade) => [trade.id, trade.providerId]),
    );
    const out: Array<Record<string, unknown>> = [];
    for (const account of accounts) {
      for (const trade of this.closedTradesForAccount(account.id)) {
        const closedAtIso = normalizedDateInput(trade.closedAt);
        if (input.from && closedAtIso < input.from) continue;
        if (input.to && closedAtIso > input.to) continue;
        const providerId = tradeProvider.get(trade.tradeId);
        out.push({
          ...trade,
          accountId: account.id,
          accountNumber: account.accountNumber,
          providerId: providerId ?? null,
          provider: providerId ? (providerTitle.get(providerId) ?? null) : null,
        });
      }
    }
    return out.sort((a, b) => String(b.closedAt).localeCompare(String(a.closedAt)));
  }

  /** One flat row per closed trade, suitable for spreadsheet analysis. */
  exportTradeJournal(input: { accountId?: string; from?: string; to?: string } = {}) {
    return this.exportClosedTrades(input).map((trade) => ({
      tradeId: trade.tradeId,
      accountNumber: trade.accountNumber,
      provider: trade.provider,
      symbol: trade.symbol,
      direction: trade.direction,
      volume: trade.volume,
      openPrice: trade.openPrice,
      closePrice: trade.closePrice,
      realizedPnl: trade.realizedPnl,
      result: trade.result,
      tpHitCount: trade.tpHitCount,
      tpTotal: trade.tpTotal,
      closedAt: trade.closedAt,
    }));
  }

  exportTradeJournalCsv(input: { accountId?: string; from?: string; to?: string } = {}) {
    const rows = this.exportTradeJournal(input);
    const header = [
      "trade_id",
      "account_number",
      "provider",
      "symbol",
      "direction",
      "volume",
      "open_price",
      "close_price",
      "realized_pnl",
      "result",
      "tp_hit_count",
      "tp_total",
      "closed_at",
    ];
    const lines = rows.map((row) =>
      [
        row.tradeId,
        row.accountNumber,
        row.provider,
        row.symbol,
        row.direction,
        row.volume,
        row.openPrice,
        row.closePrice,
        row.realizedPnl,
        row.result,
        row.tpHitCount,
        row.tpTotal,
        row.closedAt,
      ]
        .map(csvCell)
        .join(","),
    );
    return `${header.join(",")}\n${lines.join("\n")}${lines.length ? "\n" : ""}`;
  }

  /** Subscribe an SSE connection to the event bus. Returns an unsubscribe fn. */
  subscribeEvents(listener: (event: AppStoreEvent) => void): () => void {
    this.eventSubscribers.add(listener);
    return () => {
      this.eventSubscribers.delete(listener);
    };
  }

  /** Broadcast a delta to every subscriber. A broken listener never blocks a write. */
  emitEvent(event: AppStoreEvent) {
    this.invalidateDashboardCaches();
    for (const listener of this.eventSubscribers) {
      try {
        listener(event);
      } catch {
        // A slow or closed SSE connection must not break the write path.
      }
    }
  }

  private invalidateDashboardCaches() {
    this.storeRevision += 1;
    this.dashboardPerformanceCache = undefined;
    this.providerScoreCache.clear();
  }

  private syncExternalStoreRevision() {
    const row = this.db.query("PRAGMA data_version").get() as Row | null;
    const dataVersion = Number(row?.data_version ?? 0);
    if (this.observedDataVersion === undefined) {
      this.observedDataVersion = dataVersion;
    } else if (dataVersion !== this.observedDataVersion) {
      this.observedDataVersion = dataVersion;
      this.invalidateDashboardCaches();
    }
  }

  private audit(
    eventType: string,
    level: "info" | "warn" | "error",
    message: string,
    data: unknown,
    actor: "operator" | "system" = "system",
  ) {
    // actor lives inside data_json so no schema migration is needed.
    // ponytail: a dedicated audit_logs.actor column is the upgrade path once
    // multi-user identity exists.
    const payload =
      data && typeof data === "object" && !Array.isArray(data)
        ? { ...(data as Record<string, unknown>), actor }
        : { value: data, actor };
    this.db
      .query(
        "INSERT INTO audit_logs (id, event_type, level, message, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        `audit_${nanoid(10)}`,
        eventType,
        level,
        message,
        JSON.stringify(payload),
        new Date().toISOString(),
      );
    this.emitEvent({ type: "audit", event: eventType, level, actor });
  }

  /**
   * Chronological operator + system action feed. Supports an `event` filter that
   * may be an exact event type or a `prefix*` wildcard (e.g. `signal.*`).
   */
  listAuditLogs(opts: { limit?: number; event?: string } = {}) {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
    const event = opts.event?.trim();
    const rows = (
      event
        ? this.db
            .query(
              "SELECT id, event_type, level, message, data_json, created_at FROM audit_logs WHERE event_type LIKE ? ORDER BY created_at DESC, id DESC LIMIT ?",
            )
            .all(event.endsWith("*") ? `${event.slice(0, -1)}%` : event, limit)
        : this.db
            .query(
              "SELECT id, event_type, level, message, data_json, created_at FROM audit_logs ORDER BY created_at DESC, id DESC LIMIT ?",
            )
            .all(limit)
    ) as Row[];
    return rows.map((row) => {
      const data = parseJson<Record<string, unknown>>(String(row.data_json)) ?? {};
      const actor = typeof data.actor === "string" ? data.actor : "system";
      return {
        id: String(row.id),
        eventType: String(row.event_type),
        level: String(row.level),
        message: String(row.message),
        actor,
        data,
        createdAt: String(row.created_at),
      };
    });
  }
}

type Row = Record<string, unknown>;

function executionEvidence(input: ExecutionReportInput) {
  return [
    input.brokerComment,
    input.orderTicket ? `order:${input.orderTicket}` : "",
    input.dealTicket ? `deal:${input.dealTicket}` : "",
  ]
    .filter(Boolean)
    .join(" | ");
}

function nullableNumber(value: unknown) {
  return value === null || value === undefined || value === "" ? undefined : Number(value);
}

function sameOptionalNumber(left: unknown, right: number | null | undefined) {
  const normalizedLeft = nullableNumber(left);
  const normalizedRight = right === null || right === undefined ? undefined : Number(right);
  if (normalizedLeft === undefined || normalizedRight === undefined) {
    return normalizedLeft === normalizedRight;
  }
  return Math.abs(normalizedLeft - normalizedRight) < 0.0000001;
}

function brokerHistoryRowMatches(
  row: Row,
  next: {
    legId: string;
    action: string;
    orderTicket: string;
    positionTicket: string;
    filledVolume: number | null;
    filledPrice: number | null;
    brokerComment: string;
    pnlCurrency: number;
    pnlPips: number | null;
    source: string;
    createdAt: string;
  },
) {
  return (
    String(row.leg_id ?? "") === next.legId &&
    String(row.action ?? "") === next.action &&
    String(row.order_ticket ?? "") === next.orderTicket &&
    String(row.position_ticket ?? "") === next.positionTicket &&
    sameOptionalNumber(row.filled_volume, next.filledVolume) &&
    sameOptionalNumber(row.filled_price, next.filledPrice) &&
    String(row.broker_comment ?? "") === next.brokerComment &&
    sameOptionalNumber(row.pnl_currency, next.pnlCurrency) &&
    sameOptionalNumber(row.pnl_pips, next.pnlPips) &&
    String(row.source ?? "") === next.source &&
    String(row.created_at ?? "") === next.createdAt
  );
}

function brokerAction(commandType: string) {
  if (commandType === "OPEN_TRADE") return "OPEN";
  if (commandType === "CLOSE_PARTIAL") return "PARTIAL_CLOSE";
  if (commandType === "CLOSE_TRADE") return "FULL_CLOSE";
  if (commandType === "MODIFY_SL") return "MODIFY_SL";
  if (commandType === "MODIFY_TP") return "MODIFY_TP";
  if (commandType === "CANCEL_PENDING") return "CANCEL_PENDING";
  if (commandType === "TRAILING_STOP") return "TRAIL";
  return commandType;
}

function requiresLane2CloseContract(payload: ExecutionQueueItem["payload"]) {
  return (
    payload.commandType === "CLOSE_TRADE" ||
    payload.commandType === "CLOSE_PARTIAL" ||
    payload.commandType === "CANCEL_PENDING"
  );
}

function isPendingOrderAcceptance(
  payload: ExecutionQueueItem["payload"],
  input: ExecutionReportInput,
) {
  return (
    input.status === "EXECUTED" &&
    payload.commandType === "OPEN_TRADE" &&
    (payload.orderType === "LIMIT" || payload.orderType === "STOP") &&
    truthyBrokerTicket(input.orderTicket) &&
    Number(input.filledVolume ?? 0) <= 0 &&
    Number(input.remainingVolume ?? input.requestedVolume ?? input.volume ?? 0) > 0
  );
}

/**
 * A close / SL-modify report can come back FAILED because the targeted broker
 * position no longer exists (closed by an earlier TP, stop-out, or manual
 * action). The close intent is therefore already satisfied, so this must be
 * treated as terminal rather than retried — historically a virtual-TP retry
 * loop re-issued the same command every poll and produced tens of thousands of
 * identical "virtual TP position ticket not found" FAILED reports from a
 * handful of stuck items.
 */
function isPositionGoneFailure(input: ExecutionReportInput): boolean {
  const comment = (input.brokerComment ?? "").toLowerCase();
  return (
    input.retcode === 0 &&
    (comment.includes("position ticket not found") || comment.includes("no matching position"))
  );
}

function truthyBrokerTicket(value: string | undefined): value is string {
  return Boolean(value && value !== "0");
}

function numericTicket(value: string | undefined) {
  if (!value || !/^\d+$/.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function brokerActionForReport(
  payload: ExecutionQueueItem["payload"],
  input: ExecutionReportInput,
) {
  if (isPendingOrderAcceptance(payload, input)) return "PENDING_OPEN";
  if (virtualTpLegFromExecutionReport(payload, input) !== undefined) return "PARTIAL_CLOSE";
  return brokerAction(payload.commandType);
}

function brokerOrderSourceForPayload(
  payload: ExecutionQueueItem["payload"],
  input?: ExecutionReportInput,
) {
  if (input && virtualTpLegFromExecutionReport(payload, input) !== undefined) return "app-close";
  switch (payload.commandType) {
    case "OPEN_TRADE":
      return "signal";
    case "CLOSE_TRADE":
    case "CLOSE_PARTIAL":
      return "app-close";
    case "TRAILING_STOP":
      return "app-trailing";
    case "MODIFY_SL":
    case "MODIFY_TP":
    case "MOVE_SL_TO_BE":
      return "app-modify";
    case "CANCEL_PENDING":
      return "app-cancel";
    default:
      return "app-command";
  }
}

function brokerLegId(payload: ExecutionQueueItem["payload"], input: ExecutionReportInput) {
  const virtualTp = virtualTpLegFromExecutionReport(payload, input);
  if (virtualTp !== undefined) return `tp${virtualTp}`;
  if (payload.partialClose?.kind === "TP_LEG") return `tp${payload.partialClose.value}`;
  if (payload.commandType === "OPEN_TRADE") return "entry";
  return "trade";
}

function brokerPipSize(symbol: string) {
  const upper = symbol.toUpperCase();
  if (upper.includes("XAU") || upper.includes("GOLD")) return 0.1;
  if (/JPY/.test(upper)) return 0.01;
  return 0.0001;
}

/**
 * Render active virtual-TP plans as a line-oriented diagnostics payload.
 * Plans are separated by a blank line. Empty plan list yields planCount=0.
 */
function renderActiveVirtualTpPlansLine(
  plans: ReturnType<AppStore["activeVirtualTpPlans"]>,
): string {
  if (plans.length === 0) return "planCount=0\n";
  const blocks: string[] = [`planCount=${plans.length}`];
  for (const plan of plans) {
    const lines: string[] = [
      "plan=begin",
      `logicalTradeId=${plan.logicalTradeId}`,
      `shortId=${plan.shortId}`,
      `queueItemId=${plan.queueItemId}`,
      `symbol=${plan.symbol}`,
      `direction=${plan.direction}`,
      `positionTicket=${plan.positionTicket}`,
      `tpCount=${plan.payload.takeProfits?.length ?? 0}`,
    ];
    const tps = plan.payload.takeProfits ?? [];
    for (const tp of tps) {
      const k = `tp${tp.leg}`;
      lines.push(
        `${k}Price=${tp.price ?? 0}`,
        `${k}Volume=${tp.volume ?? 0}`,
        `${k}Allocation=${tp.allocationPercent ?? 0}`,
        `${k}StrategyKind=${tp.strategy?.kind ?? "no-change"}`,
        `${k}StrategyReferenceLeg=${tp.strategy?.kind === "set-sl-to-tp" ? tp.strategy.tpLeg : 0}`,
        `${k}StrategyOffsetPips=${
          tp.strategy && tp.strategy.kind !== "no-change" ? tp.strategy.offsetPips : 0
        }`,
      );
    }
    const runner = plan.payload.runner;
    lines.push(
      `runnerEnabled=${runner?.enabled ? "true" : "false"}`,
      `runnerVolume=${runner?.lotSize ?? 0}`,
      `runnerSlBehavior=${runner?.slBehavior ?? ""}`,
      `runnerTrailPips=${runner?.trailPips ?? 0}`,
      "plan=end",
    );
    blocks.push(lines.join("\n"));
  }
  return `${blocks.join("\n\n")}\n`;
}

/**
 * Strip a raw snapshot position/order record down to the fields safe to expose
 * to the UI for external (non-magic) entries. We expose enough for the
 * operator to recognise the position (symbol, side, volume, prices, comment)
 * but skip nothing — we never modify external positions, so all fields are
 * read-only context.
 */
function externalRecord(record: Record<string, unknown>) {
  return {
    ticket: String(record.ticket ?? ""),
    symbol: String(record.symbol ?? ""),
    type: Number(record.type ?? 0),
    volume: Number(record.volume ?? 0),
    openPrice: Number(record.openPrice ?? 0),
    sl: Number(record.sl ?? 0),
    tp: Number(record.tp ?? 0),
    profit: typeof record.profit === "number" ? record.profit : undefined,
    magic: typeof record.magic === "number" ? record.magic : Number(record.magic ?? 0),
    comment: String(record.comment ?? ""),
  };
}

function brokerTicketFromSnapshot(record: unknown) {
  if (!record || typeof record !== "object") return "";
  const value = (record as Record<string, unknown>).ticket;
  return value === undefined || value === null ? "" : String(value);
}

function brokerCommentFromSnapshot(record: unknown) {
  if (!record || typeof record !== "object") return "";
  const value = (record as Record<string, unknown>).comment;
  return value === undefined || value === null ? "" : String(value);
}

function brokerOpenPriceFromSnapshot(record: unknown) {
  if (!record || typeof record !== "object") return undefined;
  const value = Number((record as Record<string, unknown>).openPrice ?? 0);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

// The stop the broker currently holds on a snapshotted position. MT5 reports 0 for "no
// stop", which must read as absent rather than as a stop at price zero.
// Stop modifications the app generated from a configured strategy, as opposed to a provider
// instruction or an operator action. Only these may be skipped when the live broker stop is
// already at least as protective; a human asking for a wider stop must always be delivered.
const APP_MANAGED_STOP_KEY_PREFIXES = [
  "reference-stop:",
  "virtual-tp-stop:",
  "virtual-tp-runner-stop:",
];

function isAppManagedStopPayload(payload: ExecutionQueueItem["payload"]) {
  const key = payload.idempotencyKey ?? "";
  return APP_MANAGED_STOP_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function brokerStopLossFromSnapshot(record: unknown) {
  if (!record || typeof record !== "object") return undefined;
  const value = Number((record as Record<string, unknown>).sl ?? 0);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function quotesBySymbol(symbols: unknown[]) {
  const quotes = new Map<string, { bid: number; ask: number; point?: number }>();
  for (const record of symbols) {
    if (!record || typeof record !== "object") continue;
    const item = record as Record<string, unknown>;
    const symbol = String(item.symbol ?? "").toUpperCase();
    const bid = Number(item.bid ?? 0);
    const ask = Number(item.ask ?? 0);
    const point = Number(item.point ?? 0);
    if (!symbol || !bid || !ask) continue;
    quotes.set(symbol, { bid, ask, point: point > 0 ? point : undefined });
  }
  return quotes;
}

function virtualTpTargetPrice(
  trade: LogicalTrade,
  leg: LogicalTrade["legs"][number],
  openPrice?: number,
  point?: number,
) {
  if (leg.targetPrice) return leg.targetPrice;
  if (!leg.defaultDistance || !openPrice) return undefined;
  const symbol = trade.symbol.brokerSymbol ?? trade.symbol.canonicalSymbol ?? "";
  const delta = distanceToPriceDelta(symbol, leg.defaultDistance, point);
  if (!delta) return undefined;
  const price = trade.direction === "BUY" ? openPrice + delta : openPrice - delta;
  return Number(price.toFixed(5));
}

function distanceToPriceDelta(
  symbol: string,
  distance: { value: number; unit: "PIPS" | "POINTS" },
  point?: number,
) {
  if (!distance.value || distance.value <= 0) return 0;
  if (distance.unit === "POINTS") {
    return distance.value * (point && point > 0 ? point : brokerPipSize(symbol) / 10);
  }
  return distance.value * (point && point > 0 ? point * 10 : brokerPipSize(symbol));
}

function managedVirtualTpVolume(payload: ExecutionQueueItem["payload"], brokerOpenVolume?: number) {
  const totalVolume = Number(brokerOpenVolume ?? payload.volume ?? 0);
  if (!Number.isFinite(totalVolume) || totalVolume <= 0) return 0;
  const runnerVolume = payload.runner?.enabled
    ? Math.min(totalVolume, Math.max(0, Number(payload.runner.lotSize) || 0))
    : 0;
  return Number(Math.max(0, totalVolume - runnerVolume).toFixed(2));
}

function virtualTpStatusAfterLegClose(
  trade: LogicalTrade,
  legs: LogicalTrade["legs"],
  payload?: ExecutionQueueItem["payload"],
) {
  const runnerEnabled = Boolean(payload?.runner?.enabled && Number(payload.runner.lotSize) > 0);
  if (
    legs.filter((leg) => !isReferenceVirtualTpLeg(leg)).every((leg) => leg.status === "CLOSED") &&
    !runnerEnabled
  ) {
    return "CLOSED";
  }
  return trade.status === "CLOSED" ? "CLOSED" : "OPEN";
}

function logicalTradeIdFromComment(comment: string) {
  const match = comment.match(/telegram-tc(?:-close|-virtual-tp)?:([^:\s]+)/i);
  return match?.[1] ?? "";
}

function shortLogicalTradeId(tradeId: string) {
  if (tradeId.startsWith("trade_")) return tradeId.slice("trade_".length);
  if (tradeId.startsWith("trade-")) return tradeId.slice("trade-".length);
  return tradeId;
}

function shortLogicalTradeIdFromComment(comment: string) {
  const compact = comment.match(/\bttc:([^:\s]+)/i);
  if (compact?.[1]) return compact[1];
  const legacy = logicalTradeIdFromComment(comment);
  return legacy ? shortLogicalTradeId(legacy) : "";
}

function externalHistoryTradeId(accountId: string, deal: Mt5HistoryDealInput) {
  const ticket = String(deal.positionTicket || deal.orderTicket || deal.dealTicket || "").trim();
  if (!ticket) return undefined;
  return `external_${safeHistoryKey(accountId)}_${safeHistoryKey(ticket)}`;
}

function safeHistoryKey(value: string) {
  return value.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "unknown";
}

function historyDealAction(deal: Mt5HistoryDealInput, positionStillOpen: boolean) {
  const rawEntry = String(deal.entry ?? "").trim();
  if (rawEntry !== "" && Number.isFinite(Number(rawEntry))) {
    const entryNumber = Number(rawEntry);
    if (entryNumber === 0) return "OPEN";
    return positionStillOpen ? "PARTIAL_CLOSE" : "FULL_CLOSE";
  }
  const entry = rawEntry.toUpperCase();
  if (entry.includes("IN") && !entry.includes("OUT")) return "OPEN";
  return positionStillOpen ? "PARTIAL_CLOSE" : "FULL_CLOSE";
}

function brokerHistoryAction(existingAction: string, inferredAction: string) {
  if (!existingAction) return inferredAction;
  if (existingAction === "FULL_CLOSE") return "FULL_CLOSE";
  if (existingAction === "PARTIAL_CLOSE" && inferredAction === "FULL_CLOSE") return "FULL_CLOSE";
  return existingAction;
}

function historyDealLegId(deal: Mt5HistoryDealInput) {
  const match = String(deal.comment ?? "").match(/:tp(\d+)/i);
  return match?.[1] ? `tp${match[1]}` : "trade";
}

function historyDealCurrencyPnl(deal: Mt5HistoryDealInput) {
  return roundCurrency(
    (deal.profit ?? 0) + (deal.commission ?? 0) + (deal.swap ?? 0) + (deal.fee ?? 0),
  );
}

function historyDealTimestamp(deal: Mt5HistoryDealInput) {
  const timeMsc = Number(deal.timeMsc);
  if (Number.isFinite(timeMsc) && timeMsc > 0) {
    return new Date(timeMsc).toISOString();
  }
  return parseBrokerTimestamp(deal.time) ?? new Date().toISOString();
}

function parseBrokerTimestamp(value: string | undefined) {
  if (!value?.trim()) return undefined;
  const normalized = normalizedDateInput(value.trim());
  const timestamp = Date.parse(hasTimezoneSuffix(normalized) ? normalized : `${normalized}Z`);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function hasTimezoneSuffix(value: string) {
  return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
}

function directionFromOpenDealType(type: string | undefined) {
  return Number(type) === 1 ? "SELL" : "BUY";
}

function directionFromCloseDealType(type: string | undefined) {
  return Number(type) === 0 ? "SELL" : "BUY";
}

function drawdownPercent(balance: number, equity: number) {
  if (!Number.isFinite(balance) || balance <= 0 || !Number.isFinite(equity)) return 0;
  return Number(Math.max(0, ((balance - equity) / balance) * 100).toFixed(2));
}

function roundCurrency(value: number) {
  return Number((Number.isFinite(value) ? value : 0).toFixed(2));
}

function roundLot(value: number) {
  return Number((Number.isFinite(value) ? value : 0).toFixed(2));
}

function netResultForPnl(value: number): "WIN" | "LOSS" | "BE" {
  if (value > 0) return "WIN";
  if (value < 0) return "LOSS";
  return "BE";
}

function parseLegIndex(legId: string): number | undefined {
  const match = legId.match(/^tp(\d+)$/i);
  if (match?.[1]) return Number(match[1]);
  return undefined;
}

/**
 * Reduce a collection of broker_orders.source values for the close events on a
 * single trade into a single "Result" label for the parent row. The intent is
 * to answer "what closed this trade?" at a glance — when the answer is mixed
 * (e.g. TPs 1+2 hit, then SL fired on the runner), we say "Mixed" rather than
 * picking one source and discarding the rest.
 */
function deriveCloseResult(sources: string[]): string {
  if (sources.length === 0) return "—";
  const unique = new Set(sources);
  if (unique.has("stop-out")) return "Stop-out";
  const isTp = (s: string) => s === "tp-hit";
  const isSl = (s: string) => s === "sl-hit";
  const isManual = (s: string) => s.startsWith("manual");
  const hasTp = sources.some(isTp);
  const hasSl = sources.some(isSl);
  const hasManual = sources.some(isManual);
  if (hasTp && hasSl) return "Mixed";
  if (hasTp && hasManual) return "Mixed";
  if (hasSl && hasManual) return "Mixed";
  if (sources.every(isTp)) return "TP hit";
  if (sources.every(isSl)) return "SL hit";
  if (sources.every(isManual)) return "Manual";
  if (sources.every((s) => s === "expert")) return "Closed by EA";
  return "Mixed";
}

function attributionBucketForTrade(
  tradeId: string,
  trade: LogicalTrade | undefined,
  sources: string[],
): AccountAttributionBucket {
  if (trade?.providerId) return "provider";
  if (sources.some(isManualSource)) return "manual_external";
  if (tradeId.startsWith("external_") && !sources.some((source) => source === "expert")) {
    return "manual_external";
  }
  return "unknown_ea";
}

function isManualSource(source: string) {
  return source === "manual" || source.startsWith("manual-");
}

function primaryAttributionSource(sources: string[]) {
  if (sources.length === 0) return "history";
  if (sources.includes("stop-out")) return "stop-out";
  if (sources.every((source) => source === sources[0])) return sources[0] ?? "history";
  const priority = [
    "manual-mobile",
    "manual-terminal",
    "manual-web",
    "manual",
    "sl-hit",
    "tp-hit",
    "expert",
    "history",
  ];
  return priority.find((source) => sources.includes(source)) ?? sources[0] ?? "history";
}

function brokerSourceLabel(source: string) {
  const labels: Record<string, string> = {
    "app-cancel": "App cancel",
    "app-close": "App close",
    "app-command": "App command",
    "app-modify": "App modify",
    "app-trailing": "App trailing",
    expert: "Expert",
    history: "History",
    manual: "Manual",
    "manual-mobile": "Manual mobile",
    "manual-terminal": "Manual terminal",
    "manual-web": "Manual web",
    signal: "Signal",
    "sl-hit": "SL hit",
    "stop-out": "Stop-out",
    "tp-hit": "TP hit",
  };
  if (labels[source]) return labels[source];
  return source
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

function sumBucketPnl(
  trades: Array<{ bucket: AccountAttributionBucket; pnl: number }>,
  bucket: AccountAttributionBucket,
) {
  return roundCurrency(
    trades.filter((trade) => trade.bucket === bucket).reduce((sum, trade) => sum + trade.pnl, 0),
  );
}

function externalSummaryForTrade(
  positionTickets: Set<string>,
  rows: Map<string, { symbol: string; direction: string; openAt?: string; closeAt?: string }>,
) {
  for (const ticket of positionTickets) {
    const row = rows.get(ticket);
    if (row) return row;
  }
  return undefined;
}

function nullableString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value);
  return text ? text : undefined;
}

function isRealOpenBrokerOrder(order: {
  action: string;
  positionTicket: string;
  filledPrice?: number;
  filledVolume?: number;
}) {
  return (
    order.action === "OPEN" &&
    truthyBrokerTicket(order.positionTicket) &&
    Number(order.filledPrice ?? 0) > 0 &&
    Number(order.filledVolume ?? 0) > 0
  );
}

function sumPnl(orders: Array<{ pnlCurrency?: number }>) {
  return roundCurrency(orders.reduce((sum, order) => sum + (order.pnlCurrency ?? 0), 0));
}

export interface ScoreTrade {
  pnl: number;
  pips: number;
  closeAt: string;
  latencyMs?: number;
}

/**
 * Pure provider-quality scoring over a list of closed trades. Kept side-effect
 * free so it is unit-testable without a database. Win rate / streak use the most
 * recent 20 trades; the badge is a configurable traffic light.
 */
export function computeProviderScore(
  trades: ScoreTrade[],
  input: {
    reviewRequired?: number;
    reviewTotal?: number;
    thresholds?: { green?: number; amber?: number };
  } = {},
) {
  const sorted = [...trades].sort((a, b) => a.closeAt.localeCompare(b.closeAt));
  const recent = sorted.slice(-20);
  const wins = recent.filter((trade) => trade.pnl > 0).length;
  const winRate = recent.length ? wins / recent.length : 0;

  let streak = 0;
  let streakKind: "win" | "loss" | "none" = "none";
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const kind = (sorted[i] as ScoreTrade).pnl > 0 ? "win" : "loss";
    if (streakKind === "none") {
      streakKind = kind;
      streak = 1;
    } else if (kind === streakKind) {
      streak += 1;
    } else {
      break;
    }
  }

  const avgPips = recent.length
    ? Number((recent.reduce((sum, trade) => sum + trade.pips, 0) / recent.length).toFixed(1))
    : 0;
  const bestTrade = sorted.length ? roundCurrency(Math.max(...sorted.map((t) => t.pnl))) : 0;
  const worstTrade = sorted.length ? roundCurrency(Math.min(...sorted.map((t) => t.pnl))) : 0;
  const latencies = sorted
    .map((trade) => trade.latencyMs)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const avgFillLatencyMs = latencies.length
    ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
    : null;
  const reviewTotal = input.reviewTotal ?? 0;
  const reviewRate = reviewTotal > 0 ? (input.reviewRequired ?? 0) / reviewTotal : 0;

  const green = input.thresholds?.green ?? 0.55;
  const amber = input.thresholds?.amber ?? 0.4;
  const badge: "green" | "amber" | "red" | "neutral" =
    sorted.length < 5 ? "neutral" : winRate >= green ? "green" : winRate >= amber ? "amber" : "red";

  return {
    tradeCount: sorted.length,
    sampleSize: recent.length,
    winRate: Number(winRate.toFixed(4)),
    wins,
    losses: recent.length - wins,
    streak,
    streakKind,
    avgPips,
    bestTrade,
    worstTrade,
    avgFillLatencyMs,
    reviewRate: Number(reviewRate.toFixed(4)),
    badge,
  };
}

type ProviderScoreResult = ReturnType<typeof computeProviderScore>;

/**
 * Operational alert when a provider's rolling health turns red (win rate below
 * the danger threshold) with a meaningful sample. Null when healthy or too new.
 */
export function providerScoreAlert(
  title: string,
  score: ProviderScoreResult,
): { message: string; winRate: number } | null {
  if (score.badge !== "red" || score.sampleSize < 5) return null;
  return {
    message: `Provider ${title} win rate dropped to ${Math.round(
      score.winRate * 100,
    )}% (last ${score.sampleSize} trades)`,
    winRate: score.winRate,
  };
}

function roundToLotStep(lots: number, lotStep: number, minLot: number) {
  const step = lotStep > 0 ? lotStep : 0.01;
  const rounded = Math.round(lots / step) * step;
  const clamped = Math.max(rounded, minLot > 0 ? minLot : 0);
  return Number(clamped.toFixed(2));
}

export interface VolumePreviewInput {
  riskMode: "fixed" | "percent";
  /** Lots when riskMode=fixed, percent-of-balance when riskMode=percent. */
  riskAmount: number;
  balance?: number;
  /** Absolute stop distance in price terms (|entry - SL|). */
  stopLossDistancePrice?: number;
  tickSize?: number;
  tickValue?: number;
  minLot?: number;
  lotStep?: number;
}

/**
 * App-side mirror of the EA's volume sizing so the operator can preview the lot
 * size a signal will execute at before it is handed to MT5. Display-only.
 * Returns null lots when percent sizing is requested but the required broker
 * metadata (balance, SL distance, tick size/value) is not yet known.
 */
export function computeVolumePreview(input: VolumePreviewInput) {
  const minLot = input.minLot ?? 0;
  const lotStep = input.lotStep ?? 0.01;
  const hasRiskInputs =
    typeof input.stopLossDistancePrice === "number" &&
    input.stopLossDistancePrice > 0 &&
    typeof input.tickSize === "number" &&
    input.tickSize > 0 &&
    typeof input.tickValue === "number" &&
    input.tickValue > 0;
  const valuePerLot = hasRiskInputs
    ? ((input.stopLossDistancePrice as number) / (input.tickSize as number)) *
      (input.tickValue as number)
    : null;

  if (input.riskMode === "fixed") {
    const lots = roundToLotStep(Math.max(input.riskAmount, 0), lotStep, minLot);
    const riskCurrency = valuePerLot !== null ? Number((valuePerLot * lots).toFixed(2)) : null;
    return {
      lots,
      riskCurrency,
      riskPercentOfBalance:
        riskCurrency !== null && input.balance
          ? Number(((riskCurrency / input.balance) * 100).toFixed(2))
          : null,
      basis: "fixed" as const,
    };
  }

  // percent of balance
  if (!input.balance || valuePerLot === null || valuePerLot <= 0) {
    return {
      lots: null,
      riskCurrency: null,
      riskPercentOfBalance: input.riskAmount,
      basis: "unavailable" as const,
    };
  }
  const riskCurrency = (input.riskAmount / 100) * input.balance;
  const lots = roundToLotStep(riskCurrency / valuePerLot, lotStep, minLot);
  return {
    lots,
    riskCurrency: Number(riskCurrency.toFixed(2)),
    riskPercentOfBalance: input.riskAmount,
    basis: "percent" as const,
  };
}

export interface ReconciliationInput {
  status: string;
  openedAtMs: number;
  nowMs: number;
  /** True if any matched broker ticket is present in the latest snapshot. */
  matchedInCurrentSnapshot: boolean;
  /** How many consecutive snapshots have missed this trade's tickets. */
  consecutiveMissingSnapshots: number;
  /** A close deal for the position exists in broker history. */
  hasCloseDealInHistory: boolean;
  /** The trade was actually executed (an OPEN broker order / EXECUTED report exists). */
  wasExecuted: boolean;
  /** Minimum age before a trade can be reconciled (default 60s). */
  minAgeSeconds?: number;
}

export type ReconciliationAction = "none" | "close" | "cancel" | "out_of_sync";

/**
 * Decide how to heal a logical trade that has no matching broker position.
 * Pure so the transition rules are unit-testable without a database.
 * - close: broker history shows the position was closed.
 * - cancel: the trade was never executed.
 * - out_of_sync: executed but the position vanished with no close deal (ambiguous).
 */
export function classifyReconciliation(input: ReconciliationInput): {
  action: ReconciliationAction;
  reason?: string;
} {
  if (input.status !== "OPEN" && input.status !== "PENDING") return { action: "none" };
  if (input.matchedInCurrentSnapshot) return { action: "none" };
  const ageSeconds = (input.nowMs - input.openedAtMs) / 1000;
  if (ageSeconds < (input.minAgeSeconds ?? 60)) return { action: "none", reason: "too-fresh" };
  if (input.consecutiveMissingSnapshots < 2) {
    return { action: "none", reason: "needs-confirmation" };
  }
  if (input.hasCloseDealInHistory) return { action: "close", reason: "broker-close-deal" };
  if (!input.wasExecuted) return { action: "cancel", reason: "never-executed" };
  return { action: "out_of_sync", reason: "executed-but-vanished" };
}

/**
 * Structural fingerprint of a message: numbers collapse to `#` so signals that
 * differ only in their price levels share a fingerprint. Used to recognise a
 * provider's repeated signal shapes for adaptive learning.
 */
export function structuralFingerprint(text: string): string {
  return text
    .toUpperCase()
    .replace(/\d+(\.\d+)?/g, "#")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Whether enough approved examples of this signal's structure exist to skip the
 * manual-review gate. Only relaxes confidence-based review for mapped open
 * trades — never auto-approves an unmapped symbol.
 */
export function learnedOverrideApplies(
  signal: Pick<ParsedSignal, "commandType" | "mappingStatus">,
  exampleCount: number,
): boolean {
  return (
    signal.commandType === "OPEN_TRADE" && signal.mappingStatus === "mapped" && exampleCount >= 3
  );
}

function floatingPnlFromPositions(positions: unknown[]) {
  return roundCurrency(
    positions.reduce<number>((sum, record) => {
      if (!record || typeof record !== "object") return sum;
      const profit = nullableNumber((record as Record<string, unknown>).profit);
      return sum + (profit ?? 0);
    }, 0),
  );
}

function normalizedDateInput(value: string) {
  return value.replace(/^(\d{4})\.(\d{2})\.(\d{2})(\s+)/, "$1-$2-$3T");
}

function nowIso() {
  return new Date(Date.now()).toISOString();
}

function minuteBucket(iso: string) {
  const time = Date.parse(normalizedDateInput(iso));
  const date = new Date(Number.isFinite(time) ? time : Date.now());
  date.setUTCSeconds(0, 0);
  return date.toISOString();
}

function normalizeStatsRange(value: string | undefined): StatsRange {
  return value === "today" || value === "7d" || value === "90d" || value === "all" ? value : "30d";
}

function statsRangeStart(range: StatsRange) {
  if (range === "all") return undefined;
  if (range === "today") {
    const now = new Date(Date.now());
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return start.toISOString();
  }
  const days = range === "7d" ? 7 : range === "90d" ? 90 : 30;
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function pnlByCalendarDay(trades: Array<{ closeAt: string; pnl: number }>) {
  const byDay = new Map<string, number>();
  for (const trade of trades) {
    const day = normalizedDateInput(trade.closeAt).slice(0, 10);
    byDay.set(day, roundCurrency((byDay.get(day) ?? 0) + trade.pnl));
  }
  return byDay;
}

function pnlByWeekday(trades: Array<{ closeAt: string; pnl: number }>) {
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const byWeekday = new Map<string, number>();
  for (const trade of trades) {
    const time = Date.parse(normalizedDateInput(trade.closeAt));
    const weekday = names[Number.isFinite(time) ? new Date(time).getUTCDay() : 0] ?? "Sun";
    byWeekday.set(weekday, roundCurrency((byWeekday.get(weekday) ?? 0) + trade.pnl));
  }
  return byWeekday;
}

function bestMapValue(values: Map<string, number>) {
  return values.size ? Math.max(...values.values()) : 0;
}

function worstMapValue(values: Map<string, number>) {
  return values.size ? Math.min(...values.values()) : 0;
}

function bestMapKey(values: Map<string, number>) {
  if (values.size === 0) return "—";
  return [...values.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "—";
}

function worstMapKey(values: Map<string, number>) {
  if (values.size === 0) return "—";
  return [...values.entries()].sort((a, b) => a[1] - b[1])[0]?.[0] ?? "—";
}

function streakStats(trades: Array<{ pnl: number }>) {
  let currentType: "W" | "L" | "BE" = "BE";
  let currentCount = 0;
  let maxWins = 0;
  let maxLosses = 0;
  for (const trade of trades) {
    const type = trade.pnl > 0 ? "W" : trade.pnl < 0 ? "L" : "BE";
    if (type === currentType) currentCount += 1;
    else {
      currentType = type;
      currentCount = 1;
    }
    if (type === "W") maxWins = Math.max(maxWins, currentCount);
    if (type === "L") maxLosses = Math.max(maxLosses, currentCount);
  }
  return {
    current: trades.length ? `${currentType}${currentCount}` : "—",
    maxWins,
    maxLosses,
  };
}

function csvCell(value: unknown) {
  const text = value === undefined || value === null ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function isExternalSnapshotRecord(record: unknown) {
  if (!record || typeof record !== "object") return false;
  const item = record as Record<string, unknown>;
  if (item.isExternal === true) return true;
  const magic = nullableNumber(item.magic) ?? 0;
  return magic === 0;
}

function withinDays(iso: string, days: number) {
  const time = Date.parse(normalizedDateInput(iso));
  return Number.isFinite(time) && Date.now() - time <= days * 24 * 60 * 60 * 1000;
}

function withinCurrentDay(iso: string) {
  return dayKey(iso) === new Date(Date.now()).toISOString().slice(0, 10);
}

function withinCurrentMonth(iso: string) {
  return monthKey(iso) === new Date(Date.now()).toISOString().slice(0, 7);
}

function dayKey(iso: string) {
  const normalized = normalizedDateInput(iso);
  const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match
    ? `${match[1]}-${match[2]}-${match[3]}`
    : new Date(Date.now()).toISOString().slice(0, 10);
}

function monthKey(iso: string) {
  const normalized = normalizedDateInput(iso);
  const match = normalized.match(/^(\d{4})-(\d{2})/);
  return match ? `${match[1]}-${match[2]}` : new Date(Date.now()).toISOString().slice(0, 7);
}

function heartbeatFreshness(iso: string) {
  const ageMs = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ageMs)) return "offline";
  if (ageMs <= 10_000) return "online";
  if (ageMs <= 30_000) return "stale";
  return "offline";
}

function isUnmatchedLifecycleError(error: string) {
  return error.includes("No open logical trade matched this provider command");
}

function accountFreshnessScore(status: string) {
  if (status === "online") return 3;
  if (status === "stale") return 2;
  return 1;
}

function accountFundedScore(account: { balance?: number; equity?: number }) {
  return (account.balance ?? 0) > 0 || (account.equity ?? 0) > 0 ? 1 : 0;
}

function normalizeProviderTpLevels(
  levels?: ProviderTakeProfitLevelInput[] | null,
): ProviderTakeProfitLevel[] {
  if (!Array.isArray(levels)) {
    return Array.from({ length: MAX_PROVIDER_TP_LEVELS }, (_, index) => ({
      leg: index + 1,
      percentage: 25,
      strategy: { kind: "no-change" as const },
    }));
  }
  if (levels.length === 0) return [];

  const cleaned = levels
    .map((level, index) => ({
      leg: Number.isFinite(level.leg) && level.leg > 0 ? Math.round(level.leg) : index + 1,
      percentage: Math.max(0, Number(level.percentage) || 0),
      strategy: normalizeTakeProfitStrategy(level.strategy),
    }))
    .slice(0, MAX_PROVIDER_TP_LEVELS);
  const total = cleaned.reduce((sum, level) => sum + level.percentage, 0);
  if (total <= 0) {
    const equal = 100 / cleaned.length;
    return cleaned.map((level) => ({
      ...level,
      percentage: Number(equal.toFixed(2)),
    }));
  }
  return cleaned.map((level) => ({
    ...level,
    percentage: Number(((level.percentage / total) * 100).toFixed(2)),
  }));
}

function normalizeWorkFromTpLeg(value: unknown): number | undefined {
  const leg = Math.round(Number(value));
  return Number.isFinite(leg) && leg >= 1 && leg <= MAX_PROVIDER_TP_LEVELS ? leg : undefined;
}

function normalizeParserMode(value: unknown): ParserMode {
  return value === "aggressive" ? "aggressive" : "automatic";
}

function normalizeLockedSymbol(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const normalized = String(value).trim().toUpperCase().replace(/\s+/g, "");
  return normalized ? normalized : undefined;
}

function normalizeTradedSymbols(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const symbols = [
    ...new Set(
      value
        .map((symbol) => normalizeLockedSymbol(symbol)?.replace(/[/-]/g, ""))
        .filter(Boolean) as string[],
    ),
  ];
  return symbols.length > 0 ? symbols : undefined;
}

function normalizeTakeProfitStrategy(
  input: TakeProfitStrategy | string | null | undefined,
): TakeProfitStrategy {
  if (!input) return { kind: "no-change" };
  if (typeof input === "object") {
    if (input.kind === "set-sl-to-entry") {
      return { kind: "set-sl-to-entry", offsetPips: Math.max(0, Number(input.offsetPips) || 0) };
    }
    if (input.kind === "set-sl-to-tp") {
      return {
        kind: "set-sl-to-tp",
        tpLeg: Math.min(MAX_PROVIDER_TP_LEVELS, Math.max(1, Math.round(Number(input.tpLeg) || 1))),
        offsetPips: Math.max(0, Number(input.offsetPips) || 0),
      };
    }
    return { kind: "no-change" };
  }

  const value = input.trim().toLowerCase();
  if (!value || value.includes("unchanged") || value.includes("no change")) {
    return { kind: "no-change" };
  }
  if (!/\b(sl|stop|move|set)\b/i.test(value)) {
    return { kind: "no-change" };
  }
  if (value.includes("entry") || value.includes("break-even") || value.includes("breakeven")) {
    return { kind: "set-sl-to-entry", offsetPips: strategyOffsetPips(value) };
  }
  const tpMatch = value.match(/tp\s*([1-4])/i);
  if (tpMatch?.[1]) {
    return {
      kind: "set-sl-to-tp",
      tpLeg: Number(tpMatch[1]),
      offsetPips: strategyOffsetPips(value),
    };
  }
  return { kind: "no-change" };
}

function strategyOffsetPips(value: string) {
  const match = value.match(/([+-]?\s*\d+(?:\.\d+)?)\s*pips?/i);
  return match?.[1] ? Math.max(0, Number(match[1].replace(/\s+/g, "")) || 0) : 0;
}

function applyProviderExecutionConfig(
  signal: ParsedSignal,
  config: ProviderExecutionConfig,
  defaults?: Pick<ParsedSignal, "defaultTakeProfit">,
): ParsedSignal {
  if (signal.commandType !== "OPEN_TRADE") return signal;
  if (signal.takeProfits.length === 0) {
    return signal.defaultTakeProfit || !defaults?.defaultTakeProfit
      ? signal
      : { ...signal, defaultTakeProfit: defaults.defaultTakeProfit };
  }
  if (config.takeProfitLevels.length === 0) {
    return {
      ...signal,
      takeProfits: [],
      defaultTakeProfit: signal.defaultTakeProfit ?? defaults?.defaultTakeProfit,
    };
  }
  const levelsByLeg = new Map(config.takeProfitLevels.map((level) => [level.leg, level]));
  const unconfiguredLegs: number[] = [];
  let takeProfits = signal.takeProfits.map((target) => {
    const level = levelsByLeg.get(target.leg);
    if (!levelsByLeg.has(target.leg)) unconfiguredLegs.push(target.leg);
    return {
      ...target,
      allocationPercent: level?.percentage ?? target.allocationPercent,
      strategy: level?.strategy ?? target.strategy ?? { kind: "no-change" },
    };
  });
  if (takeProfits.length === 0) {
    return {
      ...signal,
      takeProfits: [],
      defaultTakeProfit: signal.defaultTakeProfit ?? defaults?.defaultTakeProfit,
    };
  }
  const actionable = takeProfits.filter(
    (target) => (target.price ?? 0) > 0 && target.allocationPercent > 0,
  );
  const workFrom =
    actionable.find((target) => target.leg === config.workFromTpLeg) ?? actionable[0];
  if (workFrom && config.workFromTpLeg !== undefined) {
    takeProfits = takeProfits.map((target) =>
      target.allocationPercent > 0
        ? { ...target, allocationPercent: target.leg === workFrom.leg ? 100 : 0 }
        : target,
    );
  }
  if (actionable.length === 1) {
    takeProfits = takeProfits.map((target) =>
      target.leg === actionable[0]?.leg ? { ...target, allocationPercent: 100 } : target,
    );
  } else {
    const totalAllocation = takeProfits.reduce((sum, target) => sum + target.allocationPercent, 0);
    if (totalAllocation > 0 && totalAllocation !== 100) {
      // Rescale only the legs that actually close volume, and give the rounding
      // remainder to the last of those. A leg configured at 0% is a stop-loss
      // reference for set-sl-to-tp (KAL VIP runs 50/0/0/50); handing it leftover
      // percent would turn it into a closing leg and break SL trailing.
      const lastAllocatedLeg = takeProfits
        .filter((target) => target.allocationPercent > 0)
        .at(-1)?.leg;
      let allocated = 0;
      takeProfits = takeProfits.map((target) => {
        if (target.allocationPercent <= 0) return target;
        if (target.leg === lastAllocatedLeg) {
          return { ...target, allocationPercent: Number((100 - allocated).toFixed(2)) };
        }
        const allocationPercent = Number(
          ((target.allocationPercent / totalAllocation) * 100).toFixed(2),
        );
        allocated += allocationPercent;
        return { ...target, allocationPercent };
      });
    }
  }
  return {
    ...signal,
    takeProfits,
    warnings:
      unconfiguredLegs.length > 0
        ? [
            ...signal.warnings,
            `Provider TP configuration has no leg ${unconfiguredLegs.join(", ")}; retained signal target allocation.`,
          ]
        : signal.warnings,
  };
}

function brokerManagedVirtualTpLeg(payload: ExecutionQueueItem["payload"] | undefined) {
  if (payload?.runner?.enabled) return undefined;
  return payload?.takeProfits
    .filter(
      (target) =>
        (target.price ?? 0) > 0 && target.allocationPercent > 0 && (target.volume ?? 0) > 0,
    )
    .at(-1)?.leg;
}

function isReferenceVirtualTpLeg(leg: LogicalTrade["legs"][number]) {
  return leg.allocationPercent <= 0;
}

function brokerTakeProfitMatchesTarget(record: unknown, targetPrice: number, symbol: string) {
  if (!record || typeof record !== "object") return false;
  const brokerTakeProfit = Number((record as Record<string, unknown>).tp ?? 0);
  if (!Number.isFinite(brokerTakeProfit) || brokerTakeProfit <= 0) return false;
  return Math.abs(brokerTakeProfit - targetPrice) <= brokerPipSize(symbol);
}

function virtualTpCloseVolume(input: {
  plannedVolume: number;
  plannedTotal: number;
  managedVolume: number;
  brokerOpenVolume?: number;
}) {
  if (input.plannedVolume <= 0) return 0;
  if (input.brokerOpenVolume !== undefined && input.managedVolume <= 0) return 0;
  const baseVolume = input.managedVolume > 0 ? input.managedVolume : input.plannedTotal;
  if (baseVolume <= 0 || input.plannedTotal <= 0) return 0;
  let volume = Number(((input.plannedVolume / input.plannedTotal) * baseVolume).toFixed(2));
  if (
    input.brokerOpenVolume &&
    volume >= input.brokerOpenVolume &&
    input.plannedVolume < input.plannedTotal
  ) {
    volume = Number(Math.max(0, input.brokerOpenVolume - 0.01).toFixed(2));
  }
  return volume;
}

function virtualTpLegFromBrokerComment(comment: string) {
  const match = comment.match(/:tp([1-4])\b/i);
  return match?.[1] ? Number(match[1]) : undefined;
}

function virtualTpLegFromExecutionReport(
  payload: ExecutionQueueItem["payload"],
  input: ExecutionReportInput,
) {
  const fromComment = virtualTpLegFromBrokerComment(input.brokerComment);
  if (fromComment !== undefined) return fromComment;
  if (payload.commandType !== "OPEN_TRADE" || payload.executionMode !== "VIRTUAL_TP") {
    return undefined;
  }
  const filledVolume = Number(input.filledVolume ?? input.volume ?? 0);
  const plannedVolume = Number(payload.volume ?? 0);
  if (!filledVolume || !plannedVolume || filledVolume >= plannedVolume) return undefined;
  const price = Number(input.filledPrice ?? input.requestedPrice ?? 0);
  if (!price) return undefined;
  const pipSize = brokerPipSize(payload.brokerSymbol ?? payload.canonicalSymbol ?? "");
  const tolerance = Math.max(0.00001, pipSize * 2);
  let bestLeg: number | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const takeProfit of payload.takeProfits) {
    if (!takeProfit.price) continue;
    const distance = Math.abs(price - takeProfit.price);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestLeg = takeProfit.leg;
    }
  }
  return bestLeg !== undefined && bestDistance <= tolerance ? bestLeg : undefined;
}

function tpHitLegFromText(text: string, trade: LogicalTrade): number | "all" | undefined {
  if (/\bFULL\s+TP\b/i.test(text)) return "all";
  const explicit = text.match(/\bTP\s*([1-4])\b/i);
  if (explicit?.[1]) return Number(explicit[1]);
  return trade.legs.find((leg) => leg.status !== "HIT" && leg.status !== "CLOSED")?.leg;
}

interface SnapshotTradeMatch {
  status: "matched" | "partial" | "pending" | "missing";
  reason?: string;
  livePositionExists: boolean;
  matchedBrokerTickets: string[];
  brokerComment?: string;
  lastSnapshotAt: string;
}

function snapshotMatchForTrade(
  positions: unknown[],
  orders: unknown[],
  trade: LogicalTrade,
  knownTickets: Set<string>,
): SnapshotTradeMatch {
  const positionMatch = snapshotMatchForRecords(positions, trade, knownTickets);
  if (positionMatch.status !== "missing") return positionMatch;
  const orderMatch = snapshotMatchForRecords(orders, trade, knownTickets);
  if (orderMatch.status === "missing") return orderMatch;
  return {
    ...orderMatch,
    status: "pending",
    livePositionExists: false,
  };
}

function matchedBrokerRecordForTrade(
  records: unknown[],
  trade: LogicalTrade,
  knownTickets: Set<string>,
) {
  const shortId = shortLogicalTradeId(trade.id);
  for (const record of records) {
    if (!record || typeof record !== "object") continue;
    const values = Object.values(record as Record<string, unknown>).map((value) =>
      value === undefined || value === null ? "" : String(value),
    );
    const ticket = brokerTicketFromSnapshot(record);
    if (values.some((value) => value.includes(trade.id))) return record;
    if (
      shortId &&
      values.some((value) => new RegExp(`(^|:)${escapeRegExp(shortId)}($|:)`).test(value))
    ) {
      return record;
    }
    if (ticket && knownTickets.has(ticket)) return record;
  }
  return undefined;
}

function snapshotMatchForRecords(
  records: unknown[],
  trade: LogicalTrade,
  knownTickets: Set<string>,
): SnapshotTradeMatch {
  const now = new Date().toISOString();
  const shortId = shortLogicalTradeId(trade.id);
  for (const record of records) {
    if (!record || typeof record !== "object") continue;
    const values = Object.values(record as Record<string, unknown>).map((value) =>
      value === undefined || value === null ? "" : String(value),
    );
    const ticket = brokerTicketFromSnapshot(record);
    const comment = brokerCommentFromSnapshot(record);
    if (values.some((value) => value.includes(trade.id))) {
      return {
        status: "matched",
        livePositionExists: true,
        matchedBrokerTickets: ticket ? [ticket] : [],
        brokerComment: comment,
        lastSnapshotAt: now,
      };
    }
    const compactMatches =
      shortId &&
      values.some((value) => new RegExp(`(^|:)${escapeRegExp(shortId)}($|:)`).test(value));
    if (compactMatches) {
      return {
        status: "matched",
        livePositionExists: true,
        matchedBrokerTickets: ticket ? [ticket] : [],
        brokerComment: comment,
        lastSnapshotAt: now,
      };
    }
    const ticketMatches = Boolean(ticket && knownTickets.has(ticket));
    if (ticketMatches) {
      return {
        status: "partial",
        reason: "Live broker position exists, but EA tracking comment is truncated",
        livePositionExists: true,
        matchedBrokerTickets: ticket ? [ticket] : [],
        brokerComment: comment,
        lastSnapshotAt: now,
      };
    }
  }
  return {
    status: "missing",
    reason: "No matching broker position or order found in latest MT5 snapshot",
    livePositionExists: false,
    matchedBrokerTickets: [],
    lastSnapshotAt: now,
  };
}

function openTradeSourceExpired(source: TradeSource | undefined, settings: AppSettings) {
  return openTradeTimestampExpired(source?.messageDate, settings);
}

function openTradeTimestampExpired(value: string | undefined, settings: AppSettings) {
  if (settings.maxOpenTradeAgeSeconds <= 0) return false;
  if (!value) return false;
  const timestamp = Date.parse(normalizedDateInput(value));
  if (!Number.isFinite(timestamp)) return false;
  return Date.now() - timestamp > settings.maxOpenTradeAgeSeconds * 1000;
}

function cancelLogicalTrade(
  trade: LogicalTrade,
  input: { evidence: string; lastSnapshotAt: string },
): LogicalTrade {
  return {
    ...trade,
    status: "CANCELLED",
    livePositionExists: false,
    outOfSyncReason: undefined,
    matchedBrokerTickets: [],
    brokerComment: undefined,
    lastSnapshotAt: input.lastSnapshotAt,
    legs: trade.legs.map((leg) =>
      leg.status === "CLOSED" || leg.status === "HIT"
        ? leg
        : { ...leg, status: "SKIPPED" as const, brokerEvidence: input.evidence },
    ),
  };
}

function snapshotSyncTradeState(trade: LogicalTrade, match: SnapshotTradeMatch): LogicalTrade {
  if (match.status === "matched") {
    return {
      ...trade,
      status: "OPEN",
      outOfSyncReason: undefined,
      livePositionExists: true,
      matchedBrokerTickets: match.matchedBrokerTickets,
      brokerComment: match.brokerComment,
      lastSnapshotAt: match.lastSnapshotAt,
      legs: trade.legs.map((leg) =>
        leg.status === "PLANNED" ? { ...leg, status: "OPEN" as const } : leg,
      ),
    };
  }
  if (match.status === "partial") {
    return {
      ...trade,
      status: "OPEN",
      outOfSyncReason: match.reason,
      livePositionExists: true,
      matchedBrokerTickets: match.matchedBrokerTickets,
      brokerComment: match.brokerComment,
      lastSnapshotAt: match.lastSnapshotAt,
      legs: trade.legs.map((leg) =>
        leg.status === "PLANNED" ? { ...leg, status: "OPEN" as const } : leg,
      ),
    };
  }
  if (match.status === "pending") {
    return {
      ...trade,
      status: "PENDING",
      outOfSyncReason: match.reason,
      livePositionExists: false,
      matchedBrokerTickets: match.matchedBrokerTickets,
      brokerComment: match.brokerComment,
      lastSnapshotAt: match.lastSnapshotAt,
    };
  }
  return {
    ...trade,
    status: "OUT_OF_SYNC",
    outOfSyncReason: match.reason,
    livePositionExists: false,
    matchedBrokerTickets: [],
    brokerComment: undefined,
    lastSnapshotAt: match.lastSnapshotAt,
  };
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function queueRow(row: Row) {
  return {
    id: String(row.id),
    accountId: String(row.account_id),
    logicalTradeId: String(row.logical_trade_id),
    status: String(row.status),
    payload: parseJson<ExecutionQueueItem["payload"]>(String(row.payload_json)),
    leaseCount: Number(row.lease_count ?? 0),
    heldReason: row.held_reason ? String(row.held_reason) : undefined,
    heldTier: row.held_tier ? String(row.held_tier) : undefined,
    suggestion: row.suggestion ? String(row.suggestion) : undefined,
    originQueueItemId: row.origin_queue_item_id ? String(row.origin_queue_item_id) : undefined,
    leasedAt: row.leased_at ? String(row.leased_at) : undefined,
    createdAt: String(row.created_at),
  };
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function isEmptyJsonObject(value: string) {
  return value.trim() === "" || value.trim() === "{}";
}

function isRawMessageClassification(value: string): value is RawMessageClassification {
  return value === "entry" || value === "management" || value === "noise" || value === "unknown";
}

function classifyParsedCommand(commandType: string): RawMessageClassification {
  if (commandType === "OPEN_TRADE") return "entry";
  if (commandType === "NO_SIGNAL") return "noise";
  return "management";
}

function telegramParserText(message: TelegramCapturedMessage) {
  if (!message.quotedText) return message.rawText;
  return `Quoted signal:\n${message.quotedText}\n\nComment:\n${message.rawText}`;
}

function reviewReasons(signal: ParsedSignal) {
  const reasons: string[] = [];
  if (signal.confidence < 0.75) reasons.push("low-confidence");
  if (signal.mappingStatus !== "mapped") reasons.push(`mapping-${signal.mappingStatus}`);
  for (const field of signal.missingFields) reasons.push(`missing-${field}`);
  for (const warning of signal.warnings) {
    if (warning.startsWith("Geometry-inferred")) reasons.push(warning);
  }
  if (signal.commandType !== "OPEN_TRADE" && signal.missingFields.includes("symbol")) {
    reasons.push("lifecycle-missing-symbol");
  }
  return reasons.length ? reasons : ["operator-confirmation-rule"];
}

function signalApprovalReviewError(accountId: string, signal: ParsedSignal) {
  const symbolPath = [signal.rawSymbol, signal.canonicalSymbol, signal.brokerSymbol]
    .filter(Boolean)
    .join(" -> ");
  const reasons = reviewReasons(signal).join(", ");
  return `Signal needs GPT extraction or operator confirmation before queueing for ${accountId}: ${
    symbolPath || "symbol unavailable"
  } (${reasons})`;
}

async function reviewSignalWithAzureOpenAI(input: {
  signal: ParsedSignal;
  providerTitle: string;
  classification: string;
  model: string;
  apiKey?: string;
}): Promise<AiSignalReview | { statusCode: 503 | 502; error: string }> {
  const apiKey = process.env.AZURE_OPENAI_API_KEY || input.apiKey;
  if (!apiKey) {
    return { statusCode: 503, error: "AZURE_OPENAI_API_KEY is not configured" };
  }
  const endpoint = (
    process.env.AZURE_OPENAI_ENDPOINT ??
    "https://kamogelo-dev-resource.cognitiveservices.azure.com/openai/v1/"
  ).replace(/\/$/, "");
  const response = await fetch(`${endpoint}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
      "api-key": apiKey,
    },
    body: JSON.stringify({
      model: input.model,
      messages: [
        {
          role: "system",
          content:
            "You normalize uncertain Telegram trading-signal parser outputs. Return strict JSON only. KAL VIP trades Gold/XAUUSD only, so missing symbols can be interpreted as XAUUSD. Your primary job is to extract actionable trading fields: ENTRY, SL, and TP levels. Conditional or multi-scenario commentary can be classified as TRADE_SETUP, but you must still extract any entry, SL, and TP values you can find. Result recaps and strategy notes must not be queued automatically.",
        },
        {
          role: "user",
          content: JSON.stringify({
            task: "Extract ENTRY, SL, and TP levels from this uncertain parser output and classify it for operator confirmation.",
            allowedVerdicts: [
              "EXECUTABLE_SIGNAL",
              "TRADE_SETUP",
              "LIFECYCLE_COMMAND",
              "RESULT_UPDATE",
              "PROVIDER_STRATEGY_NOTE",
              "NOISE",
            ],
            requiredJsonShape: {
              verdict: "one allowed verdict",
              shouldQueue: "boolean; true only for direct executable/lifecycle commands",
              needsConfirmation: "boolean; true when the operator should confirm before queueing",
              confidence: "number from 0 to 1",
              reason: "short explanation",
              symbol: "normalized symbol, default XAUUSD for KAL VIP when applicable",
              direction: "BUY, SELL, BOTH, or empty string",
              entry: "ENTRY value/zone as text, or empty string",
              stopLoss: "SL value/zone/distance as text, or empty string",
              takeProfits: "array of TP values/levels as text, empty array if none",
              lifecycleAction: "close/cancel/modify/tp-hit action as text, or empty string",
            },
            provider: input.providerTitle,
            currentClassification: input.classification,
            parserOutput: input.signal,
          }),
        },
      ],
      response_format: { type: "json_object" },
    }),
  });
  const text = await response.text();
  if (!response.ok) {
    return { statusCode: 502, error: `Azure OpenAI review failed: ${text}` };
  }
  const payload = parseJson<{ choices?: Array<{ message?: { content?: string } }> }>(text);
  const content = payload.choices?.[0]?.message?.content;
  if (!content) return { statusCode: 502, error: "Azure OpenAI review returned no content" };
  return normalizeAiSignalReview(parseJson<Partial<AiSignalReview>>(content));
}

function normalizeAiSignalReview(input: Partial<AiSignalReview>): AiSignalReview {
  const verdicts = new Set<AiSignalReview["verdict"]>([
    "EXECUTABLE_SIGNAL",
    "TRADE_SETUP",
    "LIFECYCLE_COMMAND",
    "RESULT_UPDATE",
    "PROVIDER_STRATEGY_NOTE",
    "NOISE",
  ]);
  const verdict = verdicts.has(input.verdict as AiSignalReview["verdict"])
    ? (input.verdict as AiSignalReview["verdict"])
    : "NOISE";
  return {
    verdict,
    shouldQueue:
      Boolean(input.shouldQueue) &&
      (verdict === "EXECUTABLE_SIGNAL" || verdict === "LIFECYCLE_COMMAND"),
    needsConfirmation: input.needsConfirmation ?? verdict !== "EXECUTABLE_SIGNAL",
    confidence: Math.max(0, Math.min(1, Number(input.confidence ?? 0))),
    reason: String(input.reason ?? "No reason returned"),
    symbol: String(input.symbol ?? ""),
    direction: String(input.direction ?? ""),
    entry: String(input.entry ?? ""),
    stopLoss: String(input.stopLoss ?? ""),
    takeProfits: Array.isArray(input.takeProfits) ? input.takeProfits.map(String) : [],
    lifecycleAction: String(input.lifecycleAction ?? ""),
  };
}

function fixtureExpected(signal: ParsedSignal) {
  return {
    commandType: signal.commandType,
    rawSymbol: signal.rawSymbol ?? "",
    canonicalSymbol: signal.canonicalSymbol ?? "",
    brokerSymbol: signal.brokerSymbol ?? "",
    mappingStatus: signal.mappingStatus,
    entry: signal.entry,
    stopLoss: signal.stopLoss,
    takeProfits: signal.takeProfits,
    partialClose: signal.partialClose,
    closeAll: signal.closeAll,
    newStopLoss: signal.newStopLoss,
    trailingStop: signal.trailingStop,
    confidence: signal.confidence,
    missingFields: signal.missingFields,
    warnings: signal.warnings,
    matchedPatternIds: signal.matchedPatternIds,
  };
}

function maskPhone(phone: string) {
  return phone.replace(/(\+\d{2})\d+(\d{3})$/, "$1******$2");
}

function isLegacyDemoAccountMapping(mapping: AccountSymbolMapping) {
  const overrides = mapping.canonicalOverrides ?? {};
  return (
    overrides.XAUUSD === "XAUUSD.r" &&
    mapping.suffix === ".raw" &&
    listMatches(mapping.includeSymbols, ["EURUSD.raw", "XAUUSD.r", "DJI30.raw"])
  );
}

function brokerReportsPlainCoreSymbols(symbols: string[]) {
  const available = new Set(symbols.map((symbol) => symbol.toUpperCase()));
  return available.has("BTCUSD") || available.has("XAUUSD") || available.has("EURUSD");
}

function rankBrokerSymbols(symbols: string[], canonical: string, quoted: Set<string>) {
  const target = canonical.replace(/[^a-z0-9]/gi, "").toUpperCase();
  if (!target) return [];
  return symbols
    .map((symbol) => {
      const upper = symbol.toUpperCase();
      const normalized = symbol.replace(/[^a-z0-9]/gi, "").toUpperCase();
      const likeness =
        normalized === target
          ? 1000
          : normalized.startsWith(target)
            ? 800
            : normalized.includes(target)
              ? 600
              : target.includes(normalized)
                ? 500
                : 0;
      return { symbol, score: likeness > 0 ? likeness + (quoted.has(upper) ? 10_000 : 0) : 0 };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.symbol.localeCompare(right.symbol))
    .map((item) => item.symbol);
}

function inferBrokerAffixes(symbols: string[]) {
  const prefixes = new Map<string, number>();
  const suffixes = new Map<string, number>();
  for (const symbol of symbols) {
    const upper = symbol.trim().toUpperCase();
    for (const canonical of BROKER_AFFIX_CANONICALS) {
      const index = upper.indexOf(canonical);
      if (index === -1) continue;
      const prefix = symbol.slice(0, index);
      const suffix = symbol.slice(index + canonical.length);
      if (prefix) prefixes.set(prefix, (prefixes.get(prefix) ?? 0) + 1);
      if (suffix) suffixes.set(suffix, (suffixes.get(suffix) ?? 0) + 1);
    }
  }
  // A global affix affects every resolution, so require 60% of all broker symbols
  // (and at least two matches). One outlier such as XAUUSDb must stay a direct override.
  const majority = Math.max(2, Math.ceil(symbols.length * 0.6));
  const best = (values: Map<string, number>) =>
    [...values.entries()].find(([, count]) => count >= majority)?.[0] ?? "";
  return { prefix: best(prefixes), suffix: best(suffixes) };
}

function listMatches(left: string[] | undefined, right: string[]) {
  if (!left || left.length !== right.length) return false;
  const normalized = left.map((item) => item.toUpperCase()).sort();
  const expected = right.map((item) => item.toUpperCase()).sort();
  return normalized.every((item, index) => item === expected[index]);
}

function normalizeCanonicalOverrides(overrides: Record<string, string> | undefined) {
  if (!overrides) return {};
  return Object.fromEntries(
    Object.entries(overrides)
      .map(([canonicalSymbol, brokerSymbol]) => [
        canonicalSymbol.trim().toUpperCase().replace("/", ""),
        brokerSymbol.trim(),
      ])
      .filter(([canonicalSymbol, brokerSymbol]) => canonicalSymbol && brokerSymbol),
  );
}

function normalizeDirectBrokerOverrides(overrides: Record<string, string> | undefined) {
  if (!overrides) return {};
  return Object.fromEntries(
    Object.entries(overrides)
      .map(([rawSymbol, brokerSymbol]) => [directBrokerOverrideKey(rawSymbol), brokerSymbol.trim()])
      .filter(([rawSymbol, brokerSymbol]) => rawSymbol && brokerSymbol),
  );
}

function directBrokerOverrideKey(value: string) {
  return value
    .toUpperCase()
    .replace(/[\s/_.#-]/g, "")
    .trim();
}

function normalizeAppSettings(input: Partial<AppSettings>): AppSettings {
  const allowedOrderTypes =
    input.allowedOrderTypes?.filter((orderType): orderType is AppOrderType =>
      appOrderTypes.has(orderType as AppOrderType),
    ) ?? defaultAppSettings.allowedOrderTypes;
  const drawdownWarnPct = clampPercent(input.drawdownWarnPct, defaultAppSettings.drawdownWarnPct);
  const drawdownDangerPct = Math.max(
    clampPercent(input.drawdownDangerPct, defaultAppSettings.drawdownDangerPct),
    drawdownWarnPct,
  );
  const reportingCurrency =
    input.reportingCurrency === "ZAR" || input.reportingCurrency === "USD"
      ? input.reportingCurrency
      : defaultAppSettings.reportingCurrency;
  const maxOpenTradeAgeInput = Number(input.maxOpenTradeAgeSeconds);
  const maxOpenTradeAgeSeconds =
    Number.isFinite(maxOpenTradeAgeInput) && maxOpenTradeAgeInput >= 0
      ? maxOpenTradeAgeInput === 0
        ? 0
        : Math.max(60, Math.min(86_400, Math.round(maxOpenTradeAgeInput)))
      : defaultAppSettings.maxOpenTradeAgeSeconds;
  return {
    defaultLotSize: positiveNumber(input.defaultLotSize, defaultAppSettings.defaultLotSize),
    defaultRiskPercent: positiveNumber(
      input.defaultRiskPercent,
      defaultAppSettings.defaultRiskPercent,
    ),
    pollingIntervalSeconds: Math.max(
      1,
      Math.round(
        positiveNumber(input.pollingIntervalSeconds, defaultAppSettings.pollingIntervalSeconds),
      ),
    ),
    allowedOrderTypes,
    defaultStopLossPips: positiveNumber(
      input.defaultStopLossPips,
      defaultAppSettings.defaultStopLossPips,
    ),
    defaultTakeProfitPips: positiveNumber(
      input.defaultTakeProfitPips,
      defaultAppSettings.defaultTakeProfitPips,
    ),
    azureOpenAIKeyConfigured: Boolean(input.azureOpenAIKeyConfigured),
    leaseTimeoutSeconds: positiveNumber(
      input.leaseTimeoutSeconds,
      defaultAppSettings.leaseTimeoutSeconds,
    ),
    maxLeaseAttempts: Math.max(
      1,
      Math.round(positiveNumber(input.maxLeaseAttempts, defaultAppSettings.maxLeaseAttempts)),
    ),
    dedupWindowSeconds: Math.max(
      60,
      Math.min(
        3600,
        Math.round(positiveNumber(input.dedupWindowSeconds, defaultAppSettings.dedupWindowSeconds)),
      ),
    ),
    maxOpenTradeAgeSeconds,
    drawdownWarnPct,
    drawdownDangerPct,
    reportingCurrency,
    usdZarRate: positiveNumber(input.usdZarRate, defaultAppSettings.usdZarRate),
    releaseHeldOnGuardianUnpause: input.releaseHeldOnGuardianUnpause === true,
    releaseHeldOnEaReconnect: input.releaseHeldOnEaReconnect !== false,
    alertBotToken: typeof input.alertBotToken === "string" ? input.alertBotToken.trim() : "",
    alertChatId: typeof input.alertChatId === "string" ? input.alertChatId.trim() : "",
    alertOnGuardianPause: input.alertOnGuardianPause === true,
    alertOnEaOffline: input.alertOnEaOffline === true,
    alertOnExecFailed: input.alertOnExecFailed === true,
    alertOnHeld: input.alertOnHeld === true,
    alertOnDroppedLifecycle: input.alertOnDroppedLifecycle !== false,
    alertOnTelegramStall: input.alertOnTelegramStall === true,
  };
}

function usesMixedCurrencies(accounts: Array<{ currency: string }>) {
  const currencies = new Set(accounts.map((account) => normalizedMoneyCurrency(account.currency)));
  return currencies.size > 1;
}

function normalizedMoneyCurrency(currency: string): ReportingCurrency | string {
  const normalized = currency.trim().toUpperCase();
  if (normalized === "$") return "USD";
  if (normalized === "R") return "ZAR";
  return normalized;
}

function canConvertMoneyCurrency(currency: string) {
  return currency === "USD" || currency === "ZAR";
}

function convertMoney(
  value: number | null | undefined,
  fromCurrency: string,
  toCurrency: ReportingCurrency,
  usdZarRate: number,
) {
  if (value === null || value === undefined) return 0;
  const from = normalizedMoneyCurrency(fromCurrency);
  if (from === toCurrency) return roundCurrency(value);
  if (from === "USD" && toCurrency === "ZAR") return roundCurrency(value * usdZarRate);
  if (from === "ZAR" && toCurrency === "USD") return roundCurrency(value / usdZarRate);
  return roundCurrency(value);
}

function aggregateHeartbeatStatus(statuses: string[]) {
  if (statuses.length === 0) return "offline";
  if (statuses.some((status) => status === "online")) return "online";
  if (statuses.some((status) => status === "stale")) return "stale";
  return "offline";
}

function aggregateEquityCurve(
  initialBalance: number,
  orders: Array<{ pnlCurrency?: number; createdAt: string }>,
  floatingPnl: number,
) {
  let equity = initialBalance;
  let peak = initialBalance;
  const points = [{ x: 0, equity, drawdown: 0 }];
  orders
    .filter((order) => order.pnlCurrency !== undefined && order.pnlCurrency !== null)
    .sort(
      (a, b) =>
        Date.parse(normalizedDateInput(a.createdAt)) - Date.parse(normalizedDateInput(b.createdAt)),
    )
    .forEach((order, index) => {
      equity += order.pnlCurrency ?? 0;
      peak = Math.max(peak, equity);
      points.push({
        x: index + 1,
        equity: roundCurrency(equity),
        drawdown: drawdownPercent(peak, equity),
      });
    });
  const currentTradingEquity = roundCurrency(initialBalance + sumPnl(orders) + floatingPnl);
  if (points.length === 1 || points[points.length - 1]?.equity !== currentTradingEquity) {
    peak = Math.max(peak, currentTradingEquity);
    points.push({
      x: points.length,
      equity: currentTradingEquity,
      drawdown: drawdownPercent(peak, currentTradingEquity),
    });
  }
  return points;
}

function aggregateMonthlyReturns(
  initialBalance: number,
  orders: Array<{ pnlCurrency?: number; createdAt: string }>,
  floatingPnl: number,
) {
  if (initialBalance <= 0) return [];
  const byMonth = new Map<string, number>();
  for (const order of orders) {
    const month = monthKey(order.createdAt);
    byMonth.set(month, (byMonth.get(month) ?? 0) + (order.pnlCurrency ?? 0));
  }
  const currentMonth = new Date().toISOString().slice(0, 7);
  if (floatingPnl !== 0) {
    byMonth.set(currentMonth, (byMonth.get(currentMonth) ?? 0) + floatingPnl);
  }
  if (byMonth.size === 0) {
    return [{ month: currentMonth, returnPercent: 0 }];
  }
  return [...byMonth.entries()].map(([month, pnl]) => ({
    month,
    returnPercent: Number(((pnl / initialBalance) * 100).toFixed(2)),
  }));
}

function clampPercent(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(100, n);
}

function hasOwn(object: object, key: string): boolean {
  return Object.hasOwn(object, key);
}

function positiveNumber(value: unknown, fallback: number) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function optionalPositiveInteger(value: unknown, max: number) {
  if (value === undefined || value === null || value === "") return undefined;
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return undefined;
  const integer = Math.floor(number);
  return integer > 0 ? Math.min(integer, max) : undefined;
}

function hashHint(value: string) {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 33) ^ value.charCodeAt(index);
  }
  return `api_${(hash >>> 0).toString(36).slice(0, 8)}`;
}

function toMt5LinePayload(item: ReturnType<typeof queueRow>, settings: AppSettings) {
  const lines = [
    "status=WORK",
    `pollSeconds=${settings.pollingIntervalSeconds}`,
    `queueItemId=${item.id}`,
    `logicalTradeId=${item.logicalTradeId}`,
    `commandType=${item.payload.commandType}`,
    `brokerSymbol=${item.payload.brokerSymbol ?? ""}`,
    `canonicalSymbol=${item.payload.canonicalSymbol ?? ""}`,
    `direction=${item.payload.direction ?? ""}`,
    `orderType=${item.payload.orderType ?? ""}`,
    `executionMode=${item.payload.executionMode}`,
    `volume=${item.payload.volume ?? ""}`,
    `riskPercent=${item.payload.riskPercent ?? ""}`,
    `entryFrom=${item.payload.entry?.from ?? ""}`,
    `entryTo=${item.payload.entry?.to ?? ""}`,
    `stopLoss=${item.payload.stopLoss ?? ""}`,
    `defaultStopLossValue=${item.payload.defaultStopLoss?.value ?? ""}`,
    `defaultStopLossUnit=${item.payload.defaultStopLoss?.unit ?? ""}`,
    `newStopLoss=${item.payload.newStopLoss ?? ""}`,
    `defaultTakeProfitValue=${item.payload.defaultTakeProfit?.value ?? ""}`,
    `defaultTakeProfitUnit=${item.payload.defaultTakeProfit?.unit ?? ""}`,
    `trailingStopValue=${item.payload.trailingStop?.value ?? ""}`,
    `trailingStopUnit=${item.payload.trailingStop?.unit ?? ""}`,
    `partialCloseKind=${item.payload.partialClose?.kind ?? ""}`,
    `partialCloseValue=${item.payload.partialClose?.value ?? ""}`,
    `partialCloseVolume=${item.payload.partialClose?.volume ?? ""}`,
    `partialCloseAllocation=${item.payload.partialClose?.allocationPercent ?? ""}`,
    `targetRemainingVolume=${item.payload.partialClose?.targetRemainingVolume ?? ""}`,
    `idempotencyKey=${item.payload.idempotencyKey ?? item.id}`,
    `runnerEnabled=${item.payload.runner?.enabled ? "true" : "false"}`,
    `runnerVolume=${item.payload.runner?.lotSize ?? ""}`,
    `runnerSlBehavior=${item.payload.runner?.slBehavior ?? ""}`,
    `runnerTrailPips=${item.payload.runner?.trailPips ?? ""}`,
    `targetOrderTicket=${item.payload.targetOrderTicket ?? ""}`,
    `targetPositionTicket=${item.payload.targetPositionTicket ?? ""}`,
    `targetDealTicket=${item.payload.targetDealTicket ?? ""}`,
  ];
  for (const takeProfit of item.payload.takeProfits) {
    lines.push(`tp${takeProfit.leg}=${takeProfit.price ?? ""}`);
    lines.push(`tp${takeProfit.leg}Allocation=${takeProfit.allocationPercent}`);
    lines.push(`tp${takeProfit.leg}Volume=${takeProfit.volume ?? ""}`);
    lines.push(`tp${takeProfit.leg}StrategyKind=${takeProfit.strategy?.kind ?? "no-change"}`);
    lines.push(
      `tp${takeProfit.leg}StrategyReferenceLeg=${strategyReferenceLeg(takeProfit.strategy)}`,
    );
    lines.push(
      `tp${takeProfit.leg}StrategyOffsetPips=${strategyOffsetForPayload(takeProfit.strategy)}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function strategyReferenceLeg(strategy: TakeProfitStrategy | undefined) {
  return strategy?.kind === "set-sl-to-tp" ? strategy.tpLeg : 0;
}

function strategyOffsetForPayload(strategy: TakeProfitStrategy | undefined) {
  return strategy?.kind === "set-sl-to-entry" || strategy?.kind === "set-sl-to-tp"
    ? strategy.offsetPips
    : 0;
}

function toMt5NoWorkPayload(settings: AppSettings) {
  return `status=NO_WORK\npollSeconds=${settings.pollingIntervalSeconds}\n`;
}

async function optionalJson<T extends Record<string, unknown>>(
  request: Request,
): Promise<Partial<T>> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return {};
  }
  try {
    return (await request.json()) as Partial<T>;
  } catch {
    return {};
  }
}

async function mt5Json<T>(request: Request): Promise<{ body: T } | { error: string }> {
  try {
    let text = await request.text();
    while (text.endsWith("\0")) {
      text = text.slice(0, -1);
    }
    return { body: JSON.parse(text) as T };
  } catch {
    return { error: "Malformed MT5 JSON payload" };
  }
}

function enrichLifecycleSignalFromTrade(signal: ParsedSignal, trade: LogicalTrade): ParsedSignal {
  const tpLeg =
    signal.partialClose?.kind === "TP_LEG"
      ? trade.legs.find((leg) => leg.leg === signal.partialClose?.value)
      : undefined;
  return {
    ...signal,
    rawSymbol: signal.rawSymbol ?? trade.symbol.rawSymbol,
    canonicalSymbol: signal.canonicalSymbol ?? trade.symbol.canonicalSymbol,
    brokerSymbol: signal.brokerSymbol ?? trade.symbol.brokerSymbol,
    direction: signal.direction ?? trade.direction,
    mappingStatus: trade.symbol.mappingStatus,
    mappingWarnings: trade.symbol.warnings,
    partialClose:
      signal.partialClose?.kind === "TP_LEG" && tpLeg
        ? {
            ...signal.partialClose,
            allocationPercent: tpLeg.allocationPercent,
          }
        : signal.partialClose,
    providerId: signal.providerId ?? trade.providerId,
    accountId: signal.accountId ?? trade.accountId,
    missingFields: signal.missingFields.filter(
      (field) => field !== "symbol" && field !== "brokerSymbol",
    ),
    warnings: signal.warnings.filter(
      (warning) => warning !== "Symbol could not be mapped to a broker symbol",
    ),
  };
}
