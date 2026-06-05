import { Database } from "bun:sqlite";
import {
  type AccountSymbolMapping,
  buildExecutionCommand,
  createLogicalTradeFromSignal,
  type ExecutionMode,
  type ExecutionQueueItem,
  type LogicalTrade,
  matchLifecycleCommandToTrade,
  type OrderType,
  type ParsedSignal,
  parseSignalText,
  parseSignalTexts,
  type QueueStatus,
  shouldRequireManualReview,
  type TakeProfitStrategy,
  type TradeSource,
} from "@telegram-tc/core";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { cors } from "hono/cors";
import { nanoid } from "nanoid";
import {
  createTelegramAdapter,
  demoDialogs,
  demoMessages,
  type TelegramAdapter,
  type TelegramCapturedMessage,
  type TelegramDialog,
  type TelegramSessionStatus,
} from "./telegram";

export interface ApiOptions {
  databasePath?: string;
  seedDemoData?: boolean;
  staticRoot?: string;
  telegram?: TelegramAdapter;
  telegramAdapter?: "mock" | "gramjs";
  telegramPollingEnabled?: boolean;
  telegramPollingIntervalMs?: number;
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
const MAX_EXECUTION_LOG_LIMIT = 500;

type SymbolAliasScope = "global" | "provider";
type AppOrderType = Extract<OrderType, "MARKET" | "LIMIT" | "STOP">;
type EquityCurveScope = "account" | "provider";
type StatsRange = "today" | "7d" | "30d" | "90d" | "all";
type ReportingCurrency = "USD" | "ZAR";

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
}

interface AccountSlotInput {
  name: string;
}

interface ProviderExecutionConfig {
  riskMode: "fixed" | "percent";
  riskAmount: number;
  takeProfitLevels: ProviderTakeProfitLevel[];
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
};

const appOrderTypes = new Set<AppOrderType>(["MARKET", "LIMIT", "STOP"]);

function defaultAccountMapping(accountId = demoAccountId): AccountSymbolMapping {
  return {
    accountId,
    canonicalOverrides: {},
    prefix: "",
    suffix: "",
    includeSymbols: [],
    excludeSymbols: [],
    availableBrokerSymbols: [],
  };
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
  app.get("/api/dashboard", (c) => c.json(store.dashboard(telegram.name)));
  app.get("/api/settings", (c) => c.json({ settings: store.appSettings() }));
  app.patch("/api/settings", async (c) => {
    const body = await c.req.json<Partial<AppSettings> & { azureOpenAIApiKey?: string }>();
    return c.json({ settings: store.updateAppSettings(body) });
  });

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
      config?: ProviderExecutionConfig;
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
      riskProfile?: string;
      lotSize?: number;
      riskMode?: "fixed" | "percent";
      riskAmount?: number;
      takeProfitLevels?: ProviderTakeProfitLevelInput[] | null;
      runner?: { enabled: boolean; lotSize: number; slBehavior: string; trailPips: number };
    }>();
    return c.json(store.updateProvider(c.req.param("id"), body));
  });

  app.delete("/api/providers/:id", (c) => c.json(store.deleteProvider(c.req.param("id"))));

  app.get("/api/providers/:id/messages", async (c) => {
    const limit = Number(c.req.query("limit") ?? 20);
    const provider = store.providerDetails(c.req.param("id"));
    const sessionId = provider ? store.connectedSessionIdForProfile(provider.profileId) : undefined;
    if (provider && sessionId) {
      try {
        const captured = await telegram.fetchRecentMessages(sessionId, provider.dialogId, limit);
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
    const captured = await telegram.fetchRecentMessages(
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
    if (provider && sessionId) {
      try {
        const captured = await telegram.fetchRecentMessages(sessionId, provider.dialogId, limit);
        if (captured.length > 0) {
          store.captureMessages(provider.id, captured);
        }
      } catch {
        if (telegram.name !== "mock") {
          return c.json({ parsed: [] });
        }
      }
    }
    return c.json({ parsed: store.parseRecentProviderMessages(providerId, limit) });
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

  app.get("/api/signals", (c) =>
    c.json({ signals: store.parsedSignals(), queue: store.queueItems() }),
  );

  app.post("/api/signals/:id/approve", async (c) => {
    const body = await optionalJson<{ executionMode?: ExecutionMode }>(c.req.raw);
    const approved = store.approveSignal(c.req.param("id"), {
      executionMode: body.executionMode,
    });
    if ("body" in approved) {
      return c.json(approved.body);
    }
    if (approved.statusCode === 409) {
      return c.json({ error: approved.error }, 409);
    }
    return c.json({ error: approved.error }, 422);
  });

  app.post("/api/signals/:id/ignore", (c) => c.json(store.ignoreSignal(c.req.param("id"))));

  app.post("/api/signals/:id/ai-review", async (c) => {
    const review = await store.aiReviewSignal(c.req.param("id"));
    if ("error" in review) {
      return c.json({ error: review.error }, review.statusCode);
    }
    return c.json(review);
  });

  app.get("/api/symbol-mappings", (c) => c.json(store.symbolMappings()));

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
    const mapping = await c.req.json<AccountSymbolMapping>();
    return c.json(store.saveAccountMapping(c.req.param("accountId"), mapping));
  });

  app.get("/api/mt5/accounts", (c) => c.json({ accounts: store.mt5Accounts() }));

  app.get("/api/account-slots", (c) => c.json({ slots: store.accountSlots() }));
  app.post("/api/account-slots", async (c) => {
    const body = await c.req.json<AccountSlotInput>();
    return c.json({ slot: store.createAccountSlot(body.name) });
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
    const body = await c.req.json<{ threshold?: number; paused?: boolean }>();
    return c.json({ guardian: store.updateEquityGuardian(c.req.param("accountId"), body) });
  });
  app.post("/api/equity-guardian/:accountId/unpause", (c) =>
    c.json({ guardian: store.unpauseEquityGuardian(c.req.param("accountId")) }),
  );

  app.get("/api/account/performance", (c) => c.json(store.accountPerformance()));
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

  if (options.staticRoot) {
    app.use("/*", serveStatic({ root: options.staticRoot }));
    app.get("*", async (c) => c.html(await Bun.file(`${options.staticRoot}/index.html`).text()));
  }

  const ingestion = createTelegramIngestionLoop(store, telegram, {
    enabled: options.telegramPollingEnabled ?? options.databasePath !== ":memory:",
    intervalMs: options.telegramPollingIntervalMs,
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

function createTelegramIngestionLoop(
  store: AppStore,
  telegram: TelegramAdapter,
  options: { enabled: boolean; intervalMs?: number },
) {
  let running = false;
  const runTelegramIngestionOnce = async (): Promise<TelegramIngestionResult> => {
    if (running) {
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
    running = true;
    try {
      return await store.ingestEnabledProviders(telegram);
    } finally {
      running = false;
    }
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
    stopTelegramIngestion: () => {
      if (timer) clearInterval(timer);
    },
  };
}

interface ExecutionReportInput {
  accountId: string;
  queueItemId: string;
  status: "EXECUTED" | "FAILED";
  retcode: number;
  retcodeExternal: number;
  brokerComment: string;
  orderTicket?: string;
  positionTicket?: string;
  dealTicket?: string;
  requestedPrice?: number;
  filledPrice?: number;
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

class AppStore {
  private readonly db: Database;
  private readonly allowDemoData: boolean;
  // Tracks providers we've already warned about for the "no connected
  // Telegram session" state, so we log once per offline→online edge instead
  // of once per poll. Reset when a session connects.
  private readonly providersWithoutSession = new Set<string>();

  constructor(databasePath: string, allowDemoData = false) {
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
          "SELECT id, profile_id, dialog_id, title, kind, enabled, parser_mode, risk_profile, lot_size, provider_config_json, last_message_at FROM providers ORDER BY title",
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
          riskProfile: String(row.risk_profile),
          lotSize: Number(row.lot_size),
          riskMode: config?.riskMode,
          riskAmount: config?.riskAmount,
          takeProfitLevels:
            config && "takeProfitLevels" in config
              ? normalizeProviderTpLevels(config.takeProfitLevels)
              : undefined,
          runner: config?.runner,
          lastMessageAt: String(row.last_message_at),
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
        "deterministic",
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
      riskProfile?: string;
      lotSize?: number;
      riskMode?: "fixed" | "percent";
      riskAmount?: number;
      takeProfitLevels?: ProviderTakeProfitLevelInput[] | null;
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
      input.riskMode !== undefined ||
      input.riskAmount !== undefined ||
      "takeProfitLevels" in input ||
      input.runner !== undefined;
    if (hasProviderConfigPatch) {
      const existingConfig = this.providerConfig(id);
      this.saveProviderConfig(id, {
        riskMode: input.riskMode ?? existingConfig.riskMode,
        riskAmount: positiveNumber(input.riskAmount, existingConfig.riskAmount),
        takeProfitLevels:
          "takeProfitLevels" in input
            ? normalizeProviderTpLevels(input.takeProfitLevels)
            : existingConfig.takeProfitLevels,
        runner: input.runner === undefined ? existingConfig.runner : input.runner,
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
    // Per-account override takes precedence; NULL config_json (or no link row) inherits
    // the provider-level default below.
    if (accountId) {
      const linkRow = this.db
        .query(
          "SELECT config_json FROM account_provider_links WHERE account_id = ? AND provider_id = ?",
        )
        .get(accountId, providerId) as Row | null;
      if (linkRow?.config_json) {
        const override = parseJson<Partial<ProviderExecutionConfig>>(String(linkRow.config_json));
        return {
          riskMode: override.riskMode === "percent" ? "percent" : "fixed",
          riskAmount: positiveNumber(override.riskAmount, fallbackAmount),
          takeProfitLevels: normalizeProviderTpLevels(override.takeProfitLevels),
          runner: override.runner,
        };
      }
    }
    const row = this.db
      .query("SELECT provider_config_json FROM providers WHERE id = ?")
      .get(providerId) as Row | null;
    const config = row?.provider_config_json
      ? parseJson<Partial<ProviderExecutionConfig>>(String(row.provider_config_json))
      : {};
    return {
      riskMode: config.riskMode === "percent" ? "percent" : "fixed",
      riskAmount: positiveNumber(config.riskAmount, fallbackAmount),
      takeProfitLevels: normalizeProviderTpLevels(config.takeProfitLevels),
      runner: config.runner,
    };
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
    input: { rawText: string; accountId?: string; config?: ProviderExecutionConfig },
  ) {
    const accountId = input.accountId ?? this.defaultParserAccountId(providerId);
    const parsed = parseSignalText(input.rawText, this.parserContext(providerId, accountId));
    const config = input.config ?? this.providerConfig(providerId);
    const settings = this.appSettings();
    return {
      providerId,
      accountId,
      parsed: applyProviderExecutionConfig(parsed, config, {
        defaultTakeProfit: { value: settings.defaultTakeProfitPips, unit: "PIPS" },
      }),
      config,
    };
  }

  private saveProviderConfig(
    providerId: string,
    config: ProviderExecutionConfig,
    accountId?: string,
  ) {
    const now = new Date().toISOString();
    if (accountId) {
      // Per-account override stored on the link row. Preserves the existing `enabled`
      // copy flag (a fresh row defaults to disabled — the Copy toggle owns that flag).
      this.db
        .query(
          "INSERT INTO account_provider_links (account_id, provider_id, enabled, updated_at, config_json) VALUES (?, ?, 0, ?, ?) ON CONFLICT(account_id, provider_id) DO UPDATE SET config_json = excluded.config_json, updated_at = excluded.updated_at",
        )
        .run(accountId, providerId, now, JSON.stringify(config));
      this.audit("provider.config.update", "info", "Per-account provider config updated", {
        providerId,
        accountId,
        config,
      });
      return;
    }
    this.db
      .query("UPDATE providers SET provider_config_json = ? WHERE id = ?")
      .run(JSON.stringify(config), providerId);
    this.db
      .query(
        "INSERT INTO provider_config_history (id, provider_id, config_json, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(`provider_config_${nanoid(10)}`, providerId, JSON.stringify(config), now);
    this.audit("provider.config.update", "info", "Provider execution config updated", {
      providerId,
      config,
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

  connectedSessionIdForProfile(profileId: string) {
    return this.connectedTelegramSession(profileId)?.id;
  }

  private providerRowsForDialog(dialogId: string) {
    return this.db
      .query(
        "SELECT id, profile_id, dialog_id, title, kind, enabled, parser_mode, risk_profile, lot_size, provider_config_json, last_message_at FROM providers WHERE dialog_id = ? ORDER BY id",
      )
      .all(dialogId) as Row[];
  }

  private providerRowById(providerId: string) {
    return this.db
      .query(
        "SELECT id, profile_id, dialog_id, title, kind, enabled, parser_mode, risk_profile, lot_size, provider_config_json, last_message_at FROM providers WHERE id = ?",
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
    this.db
      .query("UPDATE providers SET enabled = ?, last_message_at = ? WHERE id = ?")
      .run(mergedEnabled, mergedLastMessageAt, canonicalProviderId);
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

  captureMessages(providerId: string, messages: TelegramCapturedMessage[]) {
    const before = this.rawMessageCount(providerId);
    for (const message of messages) {
      const parserText = telegramParserText(message);
      const context = this.parserContext(providerId, this.defaultParserAccountId(providerId));
      const parsed = parseSignalText(parserText, context);
      const parsedSignals = parseSignalTexts(parserText, context);
      this.db
        .query(
          `INSERT INTO raw_messages (id, provider_id, telegram_message_id, message_date, raw_text, fingerprint, classification)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO NOTHING`,
        )
        .run(
          `raw_${providerId}_${message.telegramMessageId}`,
          providerId,
          message.telegramMessageId,
          message.messageDate,
          parserText,
          parsed.fingerprint,
          parsedSignals.some((signal) => signal.commandType === "OPEN_TRADE")
            ? "entry"
            : classifyParsedCommand(parsed.commandType),
        );
    }
    const after = this.rawMessageCount(providerId);
    if (messages.length > 0) {
      const latest = messages
        .map((message) => message.messageDate)
        .sort()
        .at(-1);
      if (latest) {
        this.db
          .query("UPDATE providers SET last_message_at = ? WHERE id = ?")
          .run(latest, providerId);
      }
    }
    return { captured: messages.length, inserted: after - before, total: after };
  }

  async ingestEnabledProviders(
    telegram: TelegramAdapter,
    limit = 50,
  ): Promise<TelegramIngestionResult> {
    const result: TelegramIngestionResult = {
      providers: 0,
      captured: 0,
      inserted: 0,
      parsed: 0,
      queued: 0,
      reviewRequired: 0,
      errors: 0,
    };
    for (const provider of this.providers().filter((item) => item.enabled)) {
      result.providers += 1;
      const sessionId = this.connectedSessionIdForProfile(provider.profileId);
      if (!sessionId) {
        if (!this.providersWithoutSession.has(provider.id)) {
          this.providersWithoutSession.add(provider.id);
          this.audit(
            "telegram.ingest.skip",
            "warn",
            "Enabled provider has no connected Telegram session",
            { providerId: provider.id },
          );
          log("warn", "telegram.ingest.skip", { providerId: provider.id });
        }
        continue;
      }
      // Provider reconnected — clear the warned flag so we re-log if it drops again.
      this.providersWithoutSession.delete(provider.id);
      try {
        const captured = await telegram.fetchRecentMessages(sessionId, provider.dialogId, limit, {
          dateFrom: provider.lastMessageAt,
        });
        const captureResult = this.captureMessages(provider.id, captured);
        result.captured += captureResult.captured;
        result.inserted += captureResult.inserted;
        const parsed = this.parseUnparsedProviderMessages(
          provider.id,
          Math.max(limit, captured.length),
          this.defaultParserAccountId(provider.id),
        );
        result.parsed += parsed.length;
        for (const item of parsed) {
          if (item.reviewRequired) result.reviewRequired += 1;
          if (!isAutoQueueableIngestionCommand(item.result.commandType) || item.reviewRequired) {
            continue;
          }
          const approval = this.approveSignal(item.parsedSignalId);
          if ("body" in approval) {
            result.queued +=
              approval.body.queueItems?.length ?? (approval.body.queueItemId ? 1 : 0);
          } else if (approval.statusCode !== 409) {
            result.errors += 1;
            this.audit("telegram.ingest.queue-failed", "warn", approval.error, {
              providerId: provider.id,
              parsedSignalId: item.parsedSignalId,
            });
          }
        }
      } catch (error) {
        result.errors += 1;
        this.audit("telegram.ingest.error", "error", "Telegram provider ingestion failed", {
          providerId: provider.id,
          error: error instanceof Error ? error.message : "Unknown ingestion error",
        });
      }
    }
    return result;
  }

  backtestProviderMessages(
    providerId: string,
    input: { accountId?: string; dateFrom?: string; dateTo?: string } = {},
  ) {
    const accountId = input.accountId ?? this.defaultParserAccountId(providerId);
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
      const needsReview = shouldRequireManualReview(parsed);
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
    const now = new Date().toISOString();
    const context = this.parserContext(providerId, targetAccountId);
    const firstResult = parseSignalText(rawText, context);
    const results = parseSignalTexts(rawText, context);
    this.db
      .query(
        "INSERT INTO raw_messages (id, provider_id, telegram_message_id, message_date, raw_text, fingerprint, classification) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        rawMessageId,
        providerId,
        `manual-${Date.now()}`,
        now,
        rawText,
        firstResult.fingerprint,
        "unknown",
      );
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
    );
  }

  parsedSignals() {
    return (
      this.db
        .query(
          `SELECT parsed_signals.id, parsed_signals.provider_id, parsed_signals.raw_message_id, raw_messages.classification,
            parsed_signals.result_json, parsed_signals.review_required, parsed_signals.status, parsed_signals.created_at
           FROM parsed_signals
           LEFT JOIN raw_messages ON raw_messages.id = parsed_signals.raw_message_id
           ORDER BY parsed_signals.created_at DESC`,
        )
        .all() as Row[]
    ).map((row) => ({
      id: String(row.id),
      providerId: String(row.provider_id),
      rawMessageId: String(row.raw_message_id),
      classification: String(row.classification ?? "unknown"),
      result: parseJson<ParsedSignal>(String(row.result_json)),
      reviewRequired: Boolean(row.review_required),
      status: String(row.status),
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
    options: { executionMode?: ExecutionMode } = {},
  ):
    | {
        statusCode?: 200;
        body: {
          queueItemId?: string;
          logicalTradeId?: string;
          queueItems?: string[];
          logicalTradeIds?: string[];
          status: string;
        };
      }
    | { statusCode: 409 | 422; error: string } {
    const existing = this.db
      .query("SELECT id FROM queue_items WHERE parsed_signal_id = ?")
      .get(parsedSignalId) as Row | null;
    if (existing) {
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
    const targetAccountIds = this.targetAccountIdsForProvider(
      providerId,
      signal.accountId ?? this.defaultParserAccountId(providerId),
    );
    if (targetAccountIds.length === 0) {
      return { statusCode: 422, error: "Provider is not copied by any MT5 account" };
    }
    const accountId = targetAccountIds[0] ?? this.defaultParserAccountId(providerId);
    const executionMode = options.executionMode ?? "VIRTUAL_TP";
    const settings = this.appSettings();
    const provider = this.providerDetails(providerId);
    if (signal.commandType === "OPEN_TRADE" && openTradeSourceExpired(source, settings)) {
      this.insertNonLeasedQueueItem(parsedSignalId, signal, "EXPIRED", {
        accountId,
        executionMode,
        settings,
      });
      this.db
        .query("UPDATE parsed_signals SET status = ? WHERE id = ?")
        .run("EXPIRED", parsedSignalId);
      this.audit("signal.expired", "warn", "Open trade signal expired before queueing", {
        parsedSignalId,
        providerId,
        messageDate: source?.messageDate,
        maxOpenTradeAgeSeconds: settings.maxOpenTradeAgeSeconds,
      });
      return { statusCode: 409, error: "Open trade signal is too old to queue" };
    }
    // Dedup window: only collapse against APPROVED signals within the configured window
    // so a provider re-issuing the same short-form signal (e.g. "Sell BTCUSD") after the
    // earlier position closes can still queue. Configurable via settings.dedupWindowSeconds.
    const dedupWindowSeconds = settings.dedupWindowSeconds;
    const duplicate = this.db
      .query(
        "SELECT id FROM parsed_signals WHERE provider_id = ? AND fingerprint = ? AND id != ? AND status = 'APPROVED' AND created_at > datetime('now', ?) LIMIT 1",
      )
      .get(
        String(row.provider_id),
        signal.fingerprint,
        parsedSignalId,
        `-${dedupWindowSeconds} seconds`,
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

    const defaultTakeProfit = { value: settings.defaultTakeProfitPips, unit: "PIPS" as const };
    if (signal.commandType === "OPEN_TRADE") {
      const targetSignals = targetAccountIds.map((targetAccountId) => {
        const targetConfig = this.providerConfig(providerId, targetAccountId);
        const signalForTarget =
          targetAccountId === signal.accountId
            ? signal
            : parseSignalText(signal.originalText, this.parserContext(providerId, targetAccountId));
        return {
          accountId: targetAccountId,
          config: targetConfig,
          signal: applyProviderExecutionConfig(signalForTarget, targetConfig, {
            defaultTakeProfit,
          }),
        };
      });
      for (const target of targetSignals) {
        if (
          target.signal.commandType !== "OPEN_TRADE" ||
          shouldRequireManualReview(target.signal)
        ) {
          return {
            statusCode: 422,
            error: signalApprovalReviewError(target.accountId, target.signal),
          };
        }
        const orderType = target.signal.orderType ?? "MARKET";
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
      const queueItems: string[] = [];
      const logicalTradeIds: string[] = [];
      for (const target of targetSignals) {
        const targetLogicalTradeId = `trade_${nanoid(10)}`;
        const targetQueueId = `queue_${nanoid(10)}`;
        const trade = createLogicalTradeFromSignal(target.signal, {
          id: targetLogicalTradeId,
          providerId,
          accountId: target.accountId,
          source,
          executionMode,
        });
        this.insertTrade(trade);
        const item = buildExecutionCommand(target.signal, {
          id: targetQueueId,
          accountId: target.accountId,
          logicalTradeId: targetLogicalTradeId,
          executionMode,
          volume:
            target.config.riskMode === "fixed"
              ? target.config.riskAmount
              : (provider?.lotSize ?? settings.defaultLotSize),
          riskPercent:
            target.config.riskMode === "percent"
              ? target.config.riskAmount
              : settings.defaultRiskPercent,
          runner: target.config.runner,
        });
        this.insertQueueItem(item, parsedSignalId);
        queueItems.push(targetQueueId);
        logicalTradeIds.push(targetLogicalTradeId);
      }
      this.db
        .query("UPDATE parsed_signals SET status = ? WHERE id = ?")
        .run("APPROVED", parsedSignalId);
      this.audit("signal.approve", "info", "Signal approved for MT5 queue", {
        parsedSignalId,
        queueItems,
        logicalTradeIds,
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
            : parseSignalText(signal.originalText, this.parserContext(providerId, targetAccountId)),
          targetConfig,
          { defaultTakeProfit },
        );
        const match = matchLifecycleCommandToTrade(
          targetSignal,
          this.logicalTrades().filter((trade) => trade.accountId === targetAccountId),
        );
        return { accountId: targetAccountId, config: targetConfig, signal: targetSignal, match };
      });

      for (const target of lifecycleTargets) {
        const unsafeMissingFields = target.signal.missingFields.filter(
          (field) => field !== "symbol" && field !== "brokerSymbol",
        );
        if (unsafeMissingFields.length > 0) {
          return {
            statusCode: 422,
            error: `Lifecycle command is missing ${unsafeMissingFields.join(", ")}`,
          };
        }
        if (target.match.requiresManualReview || !target.match.tradeId) {
          return {
            statusCode: 422,
            error: target.match.reason ?? "Lifecycle command needs trade matching before queueing",
          };
        }
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
        const trade = this.logicalTrade(target.match.tradeId!);
        if (!trade) {
          return { statusCode: 422, error: "Matched logical trade could not be loaded" };
        }
        const targetQueueId = `queue_${nanoid(10)}`;
        const enrichedSignal = enrichLifecycleSignalFromTrade(target.signal, trade);
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
        });
        Object.assign(queueItem.payload, this.brokerTargetForCommand(trade.id, queueItem.payload));
        this.insertQueueItem(queueItem, parsedSignalId);
        queueItems.push(targetQueueId);
        logicalTradeIds.push(trade.id);
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

  ignoreSignal(parsedSignalId: string) {
    const row = this.db
      .query("SELECT provider_id, result_json FROM parsed_signals WHERE id = ?")
      .get(parsedSignalId) as Row | null;
    if (row) {
      const existing = this.db
        .query("SELECT id FROM queue_items WHERE parsed_signal_id = ?")
        .get(parsedSignalId) as Row | null;
      if (!existing) {
        const signal = parseJson<ParsedSignal>(String(row.result_json));
        const providerId = String(row.provider_id);
        this.insertNonLeasedQueueItem(parsedSignalId, signal, "IGNORED", {
          accountId: signal.accountId ?? this.defaultParserAccountId(providerId),
          executionMode: "VIRTUAL_TP",
          settings: this.appSettings(),
        });
      }
    }
    this.db
      .query("UPDATE parsed_signals SET status = ? WHERE id = ?")
      .run("IGNORED", parsedSignalId);
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
          "SELECT id, account_id, logical_trade_id, status, payload_json, leased_at, created_at FROM queue_items ORDER BY created_at DESC",
        )
        .all() as Row[]
    ).map(queueRow);
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
    linkCode?: string;
  }): { accountId: string; status: "REGISTERED" } | { statusCode: 404; error: string } {
    const slot = input.linkCode ? this.accountSlotByCode(input.linkCode) : undefined;
    if (input.linkCode && !slot) {
      return { statusCode: 404, error: "Account slot link code was not found" };
    }
    const accountId = `mt5-${input.accountNumber}`;
    const now = nowIso();
    this.db
      .query(
        `INSERT INTO mt5_accounts
          (id, account_number, server, company, currency, balance, equity, profit, initial_balance, margin_mode, heartbeat_status, available_symbols_json, last_heartbeat_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        now,
        now,
      );
    this.saveAccountMapping(accountId, {
      ...this.accountMappingForBroker(accountId, input.availableSymbols),
    });
    this.audit("mt5.register", "info", "MT5 account registered", {
      accountId,
      marginMode: input.marginMode,
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
    linkCode?: string;
  }) {
    if (input.linkCode) {
      const slot = this.accountSlotByCode(input.linkCode);
      if (!slot || (slot.accountId && slot.accountId !== input.accountId)) {
        return { error: "Account slot link code was not found", statusCode: 404 as const };
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
    const now = nowIso();
    this.db
      .query(
        "UPDATE mt5_accounts SET balance = ?, equity = ?, profit = ?, heartbeat_status = ?, available_symbols_json = ?, last_heartbeat_at = ? WHERE id = ?",
      )
      .run(
        input.balance,
        input.equity,
        input.profit ?? null,
        "online",
        JSON.stringify(input.availableSymbols ?? []),
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
    this.recordEquityCurveSamples(input, now);
    return { accountId: input.accountId, heartbeatStatus: "online", at: now };
  }

  leaseNextQueueItem(accountId?: string): ReturnType<typeof queueRow> | null {
    this.recoverStaleLeases();
    this.expireStaleOpenTradeQueueItems(accountId);
    const rows = accountId
      ? (this.db
          .query(
            "SELECT id, account_id, logical_trade_id, status, payload_json, leased_at, created_at FROM queue_items WHERE status = 'PENDING' AND account_id = ? ORDER BY created_at LIMIT 25",
          )
          .all(accountId) as Row[])
      : (this.db
          .query(
            "SELECT id, account_id, logical_trade_id, status, payload_json, leased_at, created_at FROM queue_items WHERE status = 'PENDING' ORDER BY created_at LIMIT 25",
          )
          .all() as Row[]);
    const row = rows.find((candidate) => {
      const item = queueRow(candidate);
      if (item.payload.commandType !== "OPEN_TRADE") return true;
      if (!this.isEquityGuardianPaused(item.accountId)) return true;
      const now = new Date().toISOString();
      this.db
        .query("UPDATE queue_items SET status = ?, updated_at = ? WHERE id = ?")
        .run("FAILED", now, item.id);
      this.audit("equity-guardian.reject", "warn", "OPEN_TRADE rejected by Equity Guardian", item);
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
        "SELECT id, lease_count FROM queue_items WHERE status = 'LEASED' AND leased_at IS NOT NULL AND leased_at < ?",
      )
      .all(cutoff) as Row[];
    for (const row of stale) {
      const leaseCount = Number(row.lease_count ?? 0);
      const nextStatus = leaseCount >= settings.maxLeaseAttempts ? "EXPIRED" : "PENDING";
      this.db
        .query("UPDATE queue_items SET status = ?, leased_at = NULL, updated_at = ? WHERE id = ?")
        .run(nextStatus, new Date().toISOString(), String(row.id));
      this.audit(
        "queue.lease-recovery",
        nextStatus === "EXPIRED" ? "warn" : "info",
        `Queue lease moved to ${nextStatus}`,
        {
          queueItemId: String(row.id),
          leaseCount,
        },
      );
    }
  }

  private expireStaleOpenTradeQueueItems(accountId?: string) {
    const settings = this.appSettings();
    const rows = accountId
      ? (this.db
          .query(
            `SELECT queue_items.id, queue_items.logical_trade_id, queue_items.payload_json, queue_items.created_at, logical_trades.data_json
             FROM queue_items
             LEFT JOIN logical_trades ON logical_trades.id = queue_items.logical_trade_id
             WHERE queue_items.status = 'PENDING' AND queue_items.account_id = ?`,
          )
          .all(accountId) as Row[])
      : (this.db
          .query(
            `SELECT queue_items.id, queue_items.logical_trade_id, queue_items.payload_json, queue_items.created_at, logical_trades.data_json
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
        .query("UPDATE queue_items SET status = ?, leased_at = NULL, updated_at = ? WHERE id = ?")
        .run("EXPIRED", now, String(row.id));
      if (trade && trade.status !== "CLOSED" && trade.status !== "CANCELLED") {
        const updated = cancelLogicalTrade(trade, {
          evidence: "Open trade queue expired before MT5 execution",
          lastSnapshotAt: now,
        });
        this.db
          .query("UPDATE logical_trades SET status = ?, data_json = ? WHERE id = ?")
          .run(updated.status, JSON.stringify(updated), trade.id);
      }
      this.audit("queue.expired-open", "warn", "Expired stale open-trade queue item", {
        queueItemId: String(row.id),
        logicalTradeId: String(row.logical_trade_id ?? ""),
        sourceDate,
        maxOpenTradeAgeSeconds: settings.maxOpenTradeAgeSeconds,
      });
    }
  }

  equityGuardians() {
    return this.mt5Accounts().map((account) => this.equityGuardian(account.id));
  }

  equityGuardian(accountId: string) {
    const account = this.mt5Accounts().find((item) => item.id === accountId);
    const row = this.db
      .query(
        "SELECT account_id, threshold, current_drawdown, paused, breach_json, updated_at FROM equity_guardians WHERE account_id = ?",
      )
      .get(accountId) as Row | null;
    const currentDrawdown = row
      ? Number(row.current_drawdown)
      : drawdownPercent(account?.balance ?? 0, account?.equity ?? 0);
    return {
      accountId,
      accountNumber: account?.accountNumber ?? "",
      threshold: row ? Number(row.threshold) : 10,
      currentDrawdown,
      paused: row ? Boolean(row.paused) : false,
      breaches: row ? parseJson<unknown[]>(String(row.breach_json || "[]")) : [],
      updatedAt: row ? String(row.updated_at) : "",
    };
  }

  updateEquityGuardian(
    accountId: string,
    input: { threshold?: number; paused?: boolean; currentDrawdown?: number },
  ) {
    const current = this.equityGuardian(accountId);
    const threshold = positiveNumber(input.threshold, current.threshold);
    const currentDrawdown = Number.isFinite(input.currentDrawdown)
      ? Number(input.currentDrawdown)
      : current.currentDrawdown;
    const breached = currentDrawdown >= threshold;
    const paused = input.paused ?? (current.paused || breached);
    const breaches = [...current.breaches];
    if (breached && !current.paused) {
      breaches.push({ at: new Date().toISOString(), drawdown: currentDrawdown, action: "paused" });
    }
    this.db
      .query(
        "INSERT INTO equity_guardians (account_id, threshold, current_drawdown, paused, breach_json, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET threshold = excluded.threshold, current_drawdown = excluded.current_drawdown, paused = excluded.paused, breach_json = excluded.breach_json, updated_at = excluded.updated_at",
      )
      .run(
        accountId,
        threshold,
        currentDrawdown,
        Number(paused),
        JSON.stringify(breaches),
        new Date().toISOString(),
      );
    return this.equityGuardian(accountId);
  }

  unpauseEquityGuardian(accountId: string) {
    const current = this.equityGuardian(accountId);
    const breaches = [
      ...current.breaches,
      { at: new Date().toISOString(), drawdown: current.currentDrawdown, action: "manual_unpause" },
    ];
    this.db
      .query(
        "INSERT INTO equity_guardians (account_id, threshold, current_drawdown, paused, breach_json, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET threshold = excluded.threshold, current_drawdown = excluded.current_drawdown, paused = excluded.paused, breach_json = excluded.breach_json, updated_at = excluded.updated_at",
      )
      .run(
        accountId,
        current.threshold,
        current.currentDrawdown,
        0,
        JSON.stringify(breaches),
        new Date().toISOString(),
      );
    this.audit("equity-guardian.unpause", "info", "Equity Guardian manually unpaused", {
      accountId,
    });
    return this.equityGuardian(accountId);
  }

  private isEquityGuardianPaused(accountId?: string) {
    return accountId ? this.equityGuardian(accountId).paused : false;
  }

  executionReport(input: ExecutionReportInput) {
    const id = `report_${nanoid(10)}`;
    const now = new Date().toISOString();
    this.db
      .query(
        `INSERT INTO execution_reports
          (id, queue_item_id, account_id, status, retcode, retcode_external, broker_comment, order_ticket, position_ticket, deal_ticket, requested_price, filled_price, volume, error_text, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.queueItemId,
        input.accountId,
        input.status,
        input.retcode,
        input.retcodeExternal,
        input.brokerComment,
        input.orderTicket ?? "",
        input.positionTicket ?? "",
        input.dealTicket ?? "",
        input.requestedPrice ?? null,
        input.filledPrice ?? null,
        input.volume ?? null,
        input.errorText ?? "",
        now,
      );
    this.db
      .query("UPDATE queue_items SET status = ?, updated_at = ? WHERE id = ?")
      .run(input.status, now, input.queueItemId);
    this.reconcileExecutionReport(input);
    this.recordBrokerOrder(input);
    this.audit(
      "mt5.report",
      input.status === "EXECUTED" ? "info" : "error",
      "MT5 execution report received",
      input,
    );
    log(input.status === "EXECUTED" ? "info" : "error", "mt5.report", {
      accountId: input.accountId,
      queueItemId: input.queueItemId,
      status: input.status,
      retcode: input.retcode,
      brokerComment: input.brokerComment,
      orderTicket: input.orderTicket,
      errorText: input.errorText,
    });
    return { reportId: id, status: input.status };
  }

  saveSnapshot(input: {
    accountId: string;
    positions: unknown[];
    orders: unknown[];
    symbols?: unknown[];
  }) {
    const now = new Date().toISOString();
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
    this.reconcileSnapshotState(input.accountId, input.positions, input.orders);
    this.reconcileManualBrokerClosures(input.accountId, input.positions, input.orders);
    this.evaluateVirtualTakeProfits({
      accountId: input.accountId,
      positions: input.positions,
      symbols: input.symbols,
    });
    // Snapshots arrive every ~2 s per account. The full payload is already
    // persisted in mt5_snapshots; writing an audit_logs row per poll was
    // producing ~43k rows/day per account with zero diagnostic value.
    return {
      accountId: input.accountId,
      status: "RECORDED",
      openPositionCount: input.positions.length,
      pendingOrderCount: input.orders.length,
    };
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
      for (const leg of trade.legs) {
        if (leg.status !== "OPEN") continue;
        const targetPrice = virtualTpTargetPrice(trade, leg, openPrice, quote.point);
        if (!targetPrice) continue;
        const hit = trade.direction === "BUY" ? price >= targetPrice : price <= targetPrice;
        if (!hit) continue;
        const queued = this.queueVirtualTpClose(trade, leg.leg, positionTicket, price);
        if (queued) {
          const updated: LogicalTrade = {
            ...trade,
            legs: trade.legs.map((item) =>
              item.leg === leg.leg
                ? {
                    ...item,
                    status: "HIT",
                    brokerEvidence: `app price ${price} crossed TP${leg.leg} ${targetPrice}`,
                  }
                : item,
            ),
          };
          this.db
            .query("UPDATE logical_trades SET status = ?, data_json = ? WHERE id = ?")
            .run(updated.status, JSON.stringify(updated), trade.id);
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
         ORDER BY created_at ASC LIMIT 1`,
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
    const allocatedVolume =
      managedVolume > 0 ? Number(((managedVolume * leg.allocationPercent) / 100).toFixed(2)) : 0;
    const plannedVolume = plannedTp?.volume && plannedTp.volume > 0 ? plannedTp.volume : 0;
    const fallbackVolume =
      plannedVolume > 0 && managedVolume > 0
        ? Number(Math.min(plannedVolume, managedVolume).toFixed(2))
        : 0;
    const volume =
      brokerOpenVolume !== undefined
        ? allocatedVolume > 0
          ? allocatedVolume
          : fallbackVolume
        : (plannedTp?.volume ?? allocatedVolume);
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
      if (newStopLoss) {
        this.queueModifySlAfterVirtualTp({
          trade,
          positionTicket,
          newStopLoss,
          parsedSignalId: open.parsedSignalId,
          originalText: `App-managed TP${legNumber} SL strategy`,
          auditEvent: "virtual-tp.sl-strategy",
          auditMessage: "App-managed virtual TP queued SL strategy",
          auditFields: { leg: legNumber },
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
    originalText: string;
    auditEvent: string;
    auditMessage: string;
    auditFields?: Record<string, unknown>;
  }) {
    if (
      this.hasLifecycleQueue(
        input.trade.id,
        (payload) =>
          payload.commandType === "MODIFY_SL" &&
          payload.targetPositionTicket === input.positionTicket &&
          payload.newStopLoss === input.newStopLoss,
      )
    ) {
      return;
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
    if (!nextLegs.length || nextLegs.some((leg) => leg.status !== "CLOSED")) return;

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
      this.insertQueueItem(item, open.parsedSignalId);
      this.audit("virtual-tp.runner-trail", "info", "App-managed runner queued trailing stop", {
        logicalTradeId: trade.id,
        positionTicket,
        trailPips: runner.trailPips,
      });
      return;
    }

    const newStopLoss =
      runner.slBehavior === "last-tp"
        ? this.lastClosedVirtualTpPrice({ ...trade, legs: nextLegs })
        : this.openPriceForTrade(trade.id);
    if (!newStopLoss) return;
    this.queueModifySlAfterVirtualTp({
      trade,
      positionTicket,
      newStopLoss,
      parsedSignalId: open.parsedSignalId,
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
      basePrice = trade.legs.find((leg) => leg.leg === strategy.tpLeg)?.targetPrice ?? 0;
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
    if (!trade) return;
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
          "SELECT id, account_number, server, company, currency, balance, equity, profit, initial_balance, margin_mode, heartbeat_status, available_symbols_json, last_heartbeat_at, drawdown_warn_pct, drawdown_danger_pct FROM mt5_accounts ORDER BY account_number",
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

  accountSlots() {
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
      equityCurve: this.equityCurve(primary.id, initial, accountOrders),
      monthlyReturns: this.monthlyReturns(primary.id, initial, accountOrders, floatingPnl ?? 0),
    };
  }

  private aggregateAccountPerformance(
    accounts: ReturnType<AppStore["mt5Accounts"]>,
    settings: AppSettings,
  ) {
    const currency = settings.reportingCurrency;
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
    const hasLiveAccounts = liveAccounts.length > 0;
    const heartbeatStatus = aggregateHeartbeatStatus(
      accounts.map((account) => account.heartbeatStatus),
    );
    const lastHeartbeatAt =
      accounts
        .map((account) => account.lastHeartbeatAt)
        .sort()
        .reverse()[0] ?? null;
    const realizedPnl = sumPnl(accountOrders);
    const floatingPnl = hasLiveAccounts
      ? roundCurrency(
          liveAccounts.reduce((sum, account) => {
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
    const currentBalance = hasLiveAccounts
      ? roundCurrency(
          liveAccounts.reduce(
            (sum, account) => sum + convert(account.balance, account.currency),
            0,
          ),
        )
      : null;
    const currentEquity = hasLiveAccounts
      ? roundCurrency(
          liveAccounts.reduce((sum, account) => sum + convert(account.equity, account.currency), 0),
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
      equityCurve: aggregateEquityCurve(initial, accountOrders, floatingPnl ?? 0),
      monthlyReturns: aggregateMonthlyReturns(initial, accountOrders, floatingPnl ?? 0),
    };
  }

  providerPerformance(accountId?: string, accounts = this.mt5Accounts()) {
    const initialBalanceDenominator = accountId
      ? (accounts.find((account) => account.id === accountId)?.initialBalance ?? 0)
      : accounts.reduce((sum, account) => sum + (account.initialBalance ?? 0), 0);
    return this.providers().map((provider) => {
      const trades = this.logicalTrades().filter(
        (trade) =>
          trade.providerId === provider.id && (!accountId || trade.accountId === accountId),
      );
      const orders = trades.flatMap((trade) => this.brokerOrders(trade.id));
      const pnl = orders.reduce((sum, order) => sum + (order.pnlCurrency ?? 0), 0);
      const pips = orders.reduce((sum, order) => sum + (order.pnlPips ?? 0), 0);
      const pnlByTrade = trades.map((trade) => sumPnl(this.brokerOrders(trade.id)));
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

  symbolMappings() {
    const aliases = [
      ...Object.entries(this.globalAliases()).map(([rawSymbol, canonicalSymbol]) => ({
        rawSymbol,
        canonicalSymbol,
        brokerSymbol: canonicalSymbol,
        status: "mapped",
        scope: "global",
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
    const accountMappings = (
      this.db
        .query("SELECT account_id, mapping_json FROM account_symbol_mappings ORDER BY account_id")
        .all() as Row[]
    ).map((row) => parseJson<AccountSymbolMapping>(String(row.mapping_json)));
    const preview = [
      ...aliases,
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

  saveAccountMapping(accountId: string, mapping: AccountSymbolMapping) {
    const existing = this.storedAccountMapping(accountId) ?? defaultAccountMapping(accountId);
    const incomingOverrides = normalizeCanonicalOverrides(mapping.canonicalOverrides);
    const merged: AccountSymbolMapping = {
      accountId,
      canonicalOverrides: {
        ...(existing.canonicalOverrides ?? {}),
        ...incomingOverrides,
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

  updateAppSettings(input: Partial<AppSettings> & { azureOpenAIApiKey?: string }) {
    if (input.azureOpenAIApiKey?.trim()) {
      this.saveSecret("azureOpenAIApiKey", input.azureOpenAIApiKey.trim());
    }
    const settings = normalizeAppSettings({ ...this.appSettings(), ...input });
    this.db
      .query("INSERT OR REPLACE INTO app_settings (id, settings_json, updated_at) VALUES (?, ?, ?)")
      .run("default", JSON.stringify(settings), new Date().toISOString());
    this.audit("settings.update", "info", "Application settings updated", settings);
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

  dashboard(telegramAdapter = process.env.TELEGRAM_ADAPTER ?? "mock") {
    const providers = this.providers();
    const parsed = this.parsedSignals();
    const accounts = this.mt5Accounts();
    const queue = this.queueItems();
    return {
      health: {
        status: "ok",
        database: "connected",
        telegramAdapter,
      },
      appSettings: this.appSettings(),
      accountPerformance: this.accountPerformance(accounts),
      providerPerformance: this.providerPerformance(undefined, accounts),
      providerPerformanceByAccount: Object.fromEntries(
        accounts.map((account) => [account.id, this.providerPerformance(account.id, accounts)]),
      ),
      accountSlots: this.accountSlots(),
      accountProviderLinks: this.accountProviderLinks(),
      equityGuardians: this.equityGuardians(),
      telegramSessions: this.telegramSessionSummaries(),
      providers: providers.map((provider) => ({
        id: provider.id,
        dialogId: provider.dialogId,
        title: provider.title,
        enabled: provider.enabled,
        parserMode: provider.parserMode,
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
        server: account.server,
        currency: account.currency,
        balance: account.balance,
        equity: account.equity,
        profit: account.profit,
        initialBalance: account.initialBalance,
        heartbeatStatus: account.heartbeatStatus,
        marginMode: account.marginMode,
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
      parserResults: parsed.slice(0, 8).map((signal) => ({
        id: signal.id,
        rawMessageId: signal.rawMessageId,
        classification: signal.classification,
        providerTitle:
          providers.find((provider) => provider.id === signal.providerId)?.title ??
          signal.providerId,
        rawText: signal.result.originalText,
        commandType: signal.result.commandType,
        canonicalSymbol: signal.result.canonicalSymbol ?? "",
        brokerSymbol: signal.result.brokerSymbol ?? "",
        mappingStatus: signal.result.mappingStatus,
        confidence: signal.result.confidence,
        reviewRequired: signal.reviewRequired,
      })),
      parserFixtures: this.fixtures().slice(0, 20),
      signalQueue: queue.map((item) => ({
        id: item.id,
        commandType: item.payload.commandType,
        symbol: item.payload.brokerSymbol ?? item.payload.canonicalSymbol ?? "unmapped",
        status: item.status,
      })),
      logicalTrades: this.logicalTradesForDashboard(),
      symbolMappings: this.symbolMappings().preview,
      executionLogs: this.executionLogs(undefined, 10).map((log) => ({
        id: log.id,
        queueItemId: log.queueItemId,
        retcode: log.retcode,
        brokerComment: log.brokerComment,
        status: log.status,
        timestamp: log.createdAt,
      })),
    };
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
        last_message_at TEXT NOT NULL
      );
    `);
    this.ensureColumn("providers", "risk_profile", "TEXT NOT NULL DEFAULT 'balanced'");
    this.ensureColumn("providers", "lot_size", "REAL NOT NULL DEFAULT 0.1");
    this.ensureColumn("providers", "provider_config_json", "TEXT NOT NULL DEFAULT '{}'");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS provider_config_history (
        id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL,
        config_json TEXT NOT NULL,
        created_at TEXT NOT NULL
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
        last_heartbeat_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    this.ensureColumn("mt5_accounts", "profit", "REAL");
    this.ensureColumn("mt5_accounts", "initial_balance", "REAL NOT NULL DEFAULT 0");
    this.ensureColumn("mt5_accounts", "drawdown_warn_pct", "REAL");
    this.ensureColumn("mt5_accounts", "drawdown_danger_pct", "REAL");
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
        breach_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
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
        error_text TEXT,
        created_at TEXT NOT NULL
      );
    `);
    this.ensureColumn("execution_reports", "position_ticket", "TEXT");
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
        "deterministic",
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
          "INSERT INTO raw_messages (id, provider_id, telegram_message_id, message_date, raw_text, fingerprint, classification) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          `raw_demo_${providerId}_${index}`,
          providerId,
          message.telegramMessageId,
          message.messageDate,
          message.rawText,
          parsed.fingerprint,
          classifyParsedCommand(parsed.commandType),
        );
    });
  }

  private parserContext(providerId: string, accountId: string) {
    const settings = this.appSettings();
    return {
      providerId,
      accountId,
      globalAliases: this.globalAliases(),
      providerAliases: this.providerAliases(),
      providerDefaultSymbols: this.providerDefaultSymbols(),
      accountMappings: this.accountMappings(accountId),
      defaultStopLoss: { value: settings.defaultStopLossPips, unit: "PIPS" as const },
      defaultTakeProfit: { value: settings.defaultTakeProfitPips, unit: "PIPS" as const },
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
        .filter((provider) => provider.title.toLowerCase().includes("kal"))
        .map((provider) => [provider.id, "XAUUSD"]),
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
    const existing = this.storedAccountMapping(accountId) ?? defaultAccountMapping(accountId);
    const nextAvailable = availableSymbols ?? existing.availableBrokerSymbols ?? [];
    if (isLegacyDemoAccountMapping(existing) && brokerReportsPlainCoreSymbols(nextAvailable)) {
      return {
        accountId,
        canonicalOverrides: {},
        prefix: "",
        suffix: "",
        includeSymbols: [],
        excludeSymbols: existing.excludeSymbols ?? [],
        availableBrokerSymbols: nextAvailable,
      };
    }
    return {
      ...existing,
      accountId,
      availableBrokerSymbols: nextAvailable,
    };
  }

  private parseUnparsedProviderMessages(providerId: string, limit: number, accountId: string) {
    const rows = this.db
      .query(
        `SELECT id, provider_id, telegram_message_id, message_date, raw_text, fingerprint, classification
         FROM raw_messages
         WHERE provider_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM parsed_signals WHERE parsed_signals.raw_message_id = raw_messages.id
           )
         ORDER BY message_date ASC
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
    return input.results.map((result) => {
      const parsedSignalId = `parse_${nanoid(10)}`;
      const reviewRequired = shouldRequireManualReview(result);
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
  }

  private insertNonLeasedQueueItem(
    parsedSignalId: string,
    signal: ParsedSignal,
    status: Extract<QueueStatus, "DUPLICATE" | "IGNORED" | "EXPIRED">,
    options: {
      accountId: string;
      executionMode: ExecutionMode;
      settings: AppSettings;
    },
  ) {
    const item = buildExecutionCommand(signal, {
      id: `queue_${nanoid(10)}`,
      accountId: options.accountId,
      executionMode: options.executionMode,
      volume: options.settings.defaultLotSize,
      riskPercent: options.settings.defaultRiskPercent,
    });
    item.status = status;
    this.insertQueueItem(item, parsedSignalId);
  }

  private insertQueueItem(item: ExecutionQueueItem, parsedSignalId: string) {
    const now = new Date().toISOString();
    this.db
      .query(
        "INSERT INTO queue_items (id, parsed_signal_id, logical_trade_id, account_id, status, payload_json, lease_count, leased_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        item.id,
        parsedSignalId,
        item.logicalTradeId ?? "",
        item.accountId ?? "",
        item.status,
        JSON.stringify(item.payload),
        0,
        item.leasedAt ?? null,
        now,
        now,
      );
  }

  private mt5SnapshotsByAccount() {
    const rows = this.db
      .query(
        "SELECT account_id, positions_json, orders_json, symbols_json, updated_at FROM mt5_snapshots",
      )
      .all() as Row[];
    return Object.fromEntries(
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
      if (!hasBrokerState || trade.status === "CLOSED" || trade.status === "CANCELLED") continue;
      if (this.hasRecordedRealFullClose(trade.id)) continue;

      const match = snapshotMatchForTrade(
        positions,
        orders,
        trade,
        this.brokerOrderTicketsForTrade(trade.id),
      );
      const missingPendingOpen =
        match.status === "missing" ? this.missingPendingOpenOrder(trade.id) : null;
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

  private missingPendingOpenOrder(tradeId: string) {
    const row = this.db
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
    return row
      ? {
          orderTicket: String(row.order_ticket ?? ""),
          brokerComment: String(row.broker_comment ?? ""),
          createdAt: String(row.created_at ?? ""),
        }
      : null;
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
      return {
        id: trade.id,
        symbol: trade.symbol.brokerSymbol ?? trade.symbol.canonicalSymbol ?? "unmapped",
        direction: trade.direction,
        status: trade.status,
        executionMode: trade.executionMode,
        source: trade.source,
        outOfSyncReason: trade.outOfSyncReason,
        livePositionExists: trade.livePositionExists,
        matchedBrokerTickets: trade.matchedBrokerTickets,
        brokerComment: trade.brokerComment,
        lastSnapshotAt: trade.lastSnapshotAt,
        legs: trade.legs.map((leg) => ({
          leg: leg.leg,
          targetPrice: leg.targetPrice,
          targetSource: leg.targetSource,
          defaultDistance: leg.defaultDistance,
          allocationPercent: leg.allocationPercent,
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
    if (!trade) return;
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
    const updated: LogicalTrade = {
      ...trade,
      legs: trade.legs.map((leg) => {
        const shouldMark = hitLeg === "all" || (typeof hitLeg === "number" && leg.leg === hitLeg);
        return shouldMark ? { ...leg, status: "HIT", brokerEvidence: "provider-announced" } : leg;
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
  }

  private reconcileExecutionReport(input: ExecutionReportInput) {
    const row = this.db
      .query("SELECT logical_trade_id, payload_json FROM queue_items WHERE id = ?")
      .get(input.queueItemId) as Row | null;
    const tradeId = row?.logical_trade_id ? String(row.logical_trade_id) : "";
    if (!row || !tradeId) return;

    const trade = this.logicalTrade(tradeId);
    if (!trade) return;

    const payload = parseJson<ExecutionQueueItem["payload"]>(String(row.payload_json));
    const evidence = executionEvidence(input);
    const virtualTpLeg = virtualTpLegFromExecutionReport(payload, input);
    let updated: LogicalTrade = trade;

    if (input.status === "FAILED") {
      updated = {
        ...trade,
        status: payload.commandType === "OPEN_TRADE" ? "OUT_OF_SYNC" : trade.status,
        legs:
          payload.commandType === "OPEN_TRADE"
            ? trade.legs.map((leg) => ({ ...leg, status: "FAILED", brokerEvidence: evidence }))
            : trade.legs,
      };
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
      updated = {
        ...trade,
        status: "CLOSED",
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
        payload.volume ?? null,
        input.volume ?? null,
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
    if (action === "CANCEL_PENDING") {
      const order = rows.find(
        (row) =>
          truthyBrokerTicket(row.orderTicket) &&
          (row.action === "OPEN" || row.action === "PENDING_OPEN"),
      );
      return { targetOrderTicket: order?.orderTicket, targetPositionTicket: order?.positionTicket };
    }
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
    if (!input.filledPrice || !input.volume || !payload.direction) {
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

  private audit(
    eventType: string,
    level: "info" | "warn" | "error",
    message: string,
    data: unknown,
  ) {
    this.db
      .query(
        "INSERT INTO audit_logs (id, event_type, level, message, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        `audit_${nanoid(10)}`,
        eventType,
        level,
        message,
        JSON.stringify(data),
        new Date().toISOString(),
      );
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

function isPendingOrderAcceptance(
  payload: ExecutionQueueItem["payload"],
  input: ExecutionReportInput,
) {
  return (
    payload.commandType === "OPEN_TRADE" &&
    (payload.orderType === "LIMIT" || payload.orderType === "STOP") &&
    !truthyBrokerTicket(input.positionTicket) &&
    !truthyBrokerTicket(input.dealTicket) &&
    Number(input.filledPrice ?? 0) <= 0
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
  if (legs.every((leg) => leg.status === "CLOSED") && !runnerEnabled) return "CLOSED";
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
    const now = new Date();
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
  const configuredLegs = new Set(config.takeProfitLevels.map((level) => level.leg));
  const takeProfits = signal.takeProfits
    .filter((target) => configuredLegs.has(target.leg))
    .map((target, index) => {
      const level = levelsByLeg.get(target.leg) ?? config.takeProfitLevels[index];
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
  return {
    ...signal,
    takeProfits,
  };
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
  const filledVolume = Number(input.volume ?? 0);
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

function isAutoQueueableIngestionCommand(commandType: string) {
  return commandType !== "NO_SIGNAL" && commandType !== "TRADE_SETUP";
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
