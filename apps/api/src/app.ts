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
  type QueueStatus,
  shouldRequireManualReview,
  type TakeProfitStrategy,
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

type SymbolAliasScope = "global" | "provider";
type AppOrderType = Extract<OrderType, "MARKET" | "LIMIT" | "STOP">;

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
    c.json({ config: store.providerConfig(c.req.param("id")) }),
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
      takeProfitLevels?: ProviderTakeProfitLevelInput[];
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
    const body = await c.req.json<{ enabled?: boolean }>();
    return c.json({
      link: store.updateAccountProviderLink(
        c.req.param("accountId"),
        c.req.param("providerId"),
        body.enabled ?? true,
      ),
    });
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
  app.get("/api/providers/performance", (c) => c.json({ providers: store.providerPerformance() }));

  app.post("/api/mt5/register", async (c) => {
    const parsed = await mt5Json<{
      accountNumber: string;
      server: string;
      company: string;
      currency: string;
      balance: number;
      equity: number;
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
    c.json({ logs: store.executionLogs(c.req.query("accountId")) }),
  );
  app.get("/api/execution-logs/:id", (c) => c.json(store.executionLogDetails(c.req.param("id"))));

  app.get("/api/mt5/accounts/:accountId/logs", (c) =>
    c.json(store.mt5AccountLogs(c.req.param("accountId"))),
  );

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
  symbol?: string;
  price?: number;
  volume?: number;
  profit?: number;
  commission?: number;
  swap?: number;
  comment?: string;
  time?: string;
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
    const now = new Date().toISOString();
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
    const now = new Date().toISOString();
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
          "SELECT id, profile_id, dialog_id, title, kind, enabled, parser_mode, risk_profile, lot_size, last_message_at FROM providers ORDER BY title",
        )
        .all() as Row[]
    )
      .filter(
        (row) =>
          this.allowDemoData ||
          (String(row.profile_id) !== "profile-demo" && String(row.dialog_id) !== "dialog-alpha"),
      )
      .map((row) => ({
        id: String(row.id),
        profileId: String(row.profile_id),
        dialogId: String(row.dialog_id),
        title: String(row.title),
        kind: String(row.kind),
        enabled: Boolean(row.enabled),
        parserMode: String(row.parser_mode),
        riskProfile: String(row.risk_profile),
        lotSize: Number(row.lot_size),
        lastMessageAt: String(row.last_message_at),
      }));
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
    const now = new Date().toISOString();
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
      takeProfitLevels?: ProviderTakeProfitLevelInput[];
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
    if (input.riskMode || input.takeProfitLevels || input.runner) {
      this.saveProviderConfig(id, {
        riskMode: input.riskMode ?? "fixed",
        riskAmount: positiveNumber(input.riskAmount ?? input.lotSize, current.lotSize),
        takeProfitLevels: normalizeProviderTpLevels(input.takeProfitLevels),
        runner: input.runner,
      });
    }
    this.audit("provider.update", "info", "Provider settings updated", {
      providerId: id,
      ...input,
    });
    return { provider: this.providers().find((provider) => provider.id === id) };
  }

  providerConfig(providerId: string): ProviderExecutionConfig {
    const provider = this.providerDetails(providerId);
    const row = this.db
      .query("SELECT provider_config_json FROM providers WHERE id = ?")
      .get(providerId) as Row | null;
    const config = row?.provider_config_json
      ? parseJson<Partial<ProviderExecutionConfig>>(String(row.provider_config_json))
      : {};
    return {
      riskMode: config.riskMode === "percent" ? "percent" : "fixed",
      riskAmount: positiveNumber(
        config.riskAmount,
        provider?.lotSize ?? defaultAppSettings.defaultLotSize,
      ),
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
    const accountId = input.accountId ?? this.defaultParserAccountId();
    const parsed = parseSignalText(input.rawText, this.parserContext(providerId, accountId));
    const config = input.config ?? this.providerConfig(providerId);
    return {
      providerId,
      accountId,
      parsed: applyProviderExecutionConfig(parsed, config),
      config,
    };
  }

  private saveProviderConfig(providerId: string, config: ProviderExecutionConfig) {
    this.db
      .query("UPDATE providers SET provider_config_json = ? WHERE id = ?")
      .run(JSON.stringify(config), providerId);
    this.db
      .query(
        "INSERT INTO provider_config_history (id, provider_id, config_json, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(
        `provider_config_${nanoid(10)}`,
        providerId,
        JSON.stringify(config),
        new Date().toISOString(),
      );
    this.audit("provider.config.update", "info", "Provider execution config updated", {
      providerId,
      config,
    });
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
      .query("SELECT account_id, enabled FROM account_provider_links WHERE provider_id = ?")
      .all(duplicateProviderId) as Row[];
    const now = new Date().toISOString();
    for (const link of duplicateLinks) {
      const existing = this.db
        .query(
          "SELECT enabled FROM account_provider_links WHERE account_id = ? AND provider_id = ?",
        )
        .get(String(link.account_id), canonicalProviderId) as Row | null;
      if (existing) {
        this.db
          .query(
            "UPDATE account_provider_links SET enabled = ?, updated_at = ? WHERE account_id = ? AND provider_id = ?",
          )
          .run(
            Number(Boolean(existing.enabled) || Boolean(link.enabled)),
            now,
            String(link.account_id),
            canonicalProviderId,
          );
      } else {
        this.db
          .query(
            "INSERT INTO account_provider_links (account_id, provider_id, enabled, updated_at) VALUES (?, ?, ?, ?)",
          )
          .run(String(link.account_id), canonicalProviderId, Number(link.enabled), now);
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
      const parsed = parseSignalText(
        parserText,
        this.parserContext(providerId, this.defaultParserAccountId()),
      );
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
          classifyParsedCommand(parsed.commandType),
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
          this.defaultParserAccountId(),
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
    const accountId = input.accountId ?? this.defaultParserAccountId();
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

  parseProviderMessage(
    providerId: string,
    rawText: string,
    accountId = this.defaultParserAccountId(),
  ) {
    const rawMessageId = `raw_${nanoid(10)}`;
    const parsedSignalId = `parse_${nanoid(10)}`;
    const now = new Date().toISOString();
    const result = parseSignalText(rawText, this.parserContext(providerId, accountId));
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
        result.fingerprint,
        "unknown",
      );
    this.db
      .query(
        "INSERT INTO parsed_signals (id, provider_id, raw_message_id, result_json, review_required, fingerprint, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        parsedSignalId,
        providerId,
        rawMessageId,
        JSON.stringify(result),
        Number(shouldRequireManualReview(result)),
        result.fingerprint,
        "PARSED",
        now,
      );
    return {
      parsedSignalId,
      reviewRequired: shouldRequireManualReview(result),
      result,
    };
  }

  parseRecentProviderMessages(
    providerId: string,
    limit: number,
    accountId = this.defaultParserAccountId(),
  ) {
    this.recentMessages(providerId, limit);
    return this.parseUnparsedProviderMessages(providerId, limit, accountId);
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
    const providerId = String(row.provider_id);
    const targetAccountIds = this.targetAccountIdsForProvider(
      providerId,
      signal.accountId ?? this.defaultParserAccountId(),
    );
    const accountId = targetAccountIds[0] ?? this.defaultParserAccountId();
    const executionMode = options.executionMode ?? "VIRTUAL_TP";
    const settings = this.appSettings();
    const provider = this.providerDetails(providerId);
    const providerConfig = this.providerConfig(providerId);
    if (executionMode === "SPLIT_ORDER" && providerConfig.runner?.enabled) {
      return {
        statusCode: 422,
        error: "Runner mode is only supported for VIRTUAL_TP execution today",
      };
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

    const signalForQueue = applyProviderExecutionConfig(signal, providerConfig);
    if (signal.commandType === "OPEN_TRADE") {
      const targetSignals = targetAccountIds.map((targetAccountId) => {
        const signalForTarget =
          targetAccountId === signal.accountId
            ? signal
            : parseSignalText(signal.originalText, this.parserContext(providerId, targetAccountId));
        return {
          accountId: targetAccountId,
          signal: applyProviderExecutionConfig(signalForTarget, providerConfig),
        };
      });
      for (const target of targetSignals) {
        if (
          target.signal.commandType !== "OPEN_TRADE" ||
          shouldRequireManualReview(target.signal)
        ) {
          return {
            statusCode: 422,
            error: "Signal needs GPT extraction or operator confirmation before queueing",
          };
        }
        const orderType = target.signal.orderType ?? "MARKET";
        if (!settings.allowedOrderTypes.includes(orderType)) {
          return { statusCode: 422, error: `${orderType} orders are not allowed by settings` };
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
          executionMode,
        });
        this.insertTrade(trade);
        const item = buildExecutionCommand(target.signal, {
          id: targetQueueId,
          accountId: target.accountId,
          logicalTradeId: targetLogicalTradeId,
          executionMode,
          volume:
            providerConfig.riskMode === "fixed"
              ? providerConfig.riskAmount
              : (provider?.lotSize ?? settings.defaultLotSize),
          riskPercent:
            providerConfig.riskMode === "percent"
              ? providerConfig.riskAmount
              : settings.defaultRiskPercent,
          runner: providerConfig.runner,
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
        const targetSignal =
          targetAccountId === signal.accountId
            ? signalForQueue
            : applyProviderExecutionConfig(
                parseSignalText(
                  signal.originalText,
                  this.parserContext(providerId, targetAccountId),
                ),
                providerConfig,
              );
        const match = matchLifecycleCommandToTrade(
          targetSignal,
          this.logicalTrades().filter((trade) => trade.accountId === targetAccountId),
        );
        return { accountId: targetAccountId, signal: targetSignal, match };
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
            providerConfig.riskMode === "fixed"
              ? providerConfig.riskAmount
              : (provider?.lotSize ?? settings.defaultLotSize),
          riskPercent:
            providerConfig.riskMode === "percent"
              ? providerConfig.riskAmount
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
      .query("SELECT result_json FROM parsed_signals WHERE id = ?")
      .get(parsedSignalId) as Row | null;
    if (row) {
      const existing = this.db
        .query("SELECT id FROM queue_items WHERE parsed_signal_id = ?")
        .get(parsedSignalId) as Row | null;
      if (!existing) {
        const signal = parseJson<ParsedSignal>(String(row.result_json));
        this.insertNonLeasedQueueItem(parsedSignalId, signal, "IGNORED", {
          accountId: signal.accountId ?? this.defaultParserAccountId(),
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
    marginMode: "HEDGING" | "NETTING";
    availableSymbols?: string[];
    linkCode?: string;
  }): { accountId: string; status: "REGISTERED" } | { statusCode: 404; error: string } {
    const slot = input.linkCode ? this.accountSlotByCode(input.linkCode) : undefined;
    if (input.linkCode && !slot) {
      return { statusCode: 404, error: "Account slot link code was not found" };
    }
    const accountId = `mt5-${input.accountNumber}`;
    const now = new Date().toISOString();
    this.db
      .query(
        `INSERT INTO mt5_accounts
          (id, account_number, server, company, currency, balance, equity, initial_balance, margin_mode, heartbeat_status, available_symbols_json, last_heartbeat_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
          server = excluded.server,
          company = excluded.company,
          currency = excluded.currency,
          balance = excluded.balance,
          equity = excluded.equity,
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
    const now = new Date().toISOString();
    this.db
      .query(
        "UPDATE mt5_accounts SET balance = ?, equity = ?, heartbeat_status = ?, available_symbols_json = ?, last_heartbeat_at = ? WHERE id = ?",
      )
      .run(
        input.balance,
        input.equity,
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
    return { accountId: input.accountId, heartbeatStatus: "online", at: now };
  }

  leaseNextQueueItem(accountId?: string): ReturnType<typeof queueRow> | null {
    this.recoverStaleLeases();
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

  saveBrokerHistory(input: { accountId: string; deals: Mt5HistoryDealInput[] }) {
    let recorded = 0;
    for (const deal of input.deals) {
      if (!deal.dealTicket) continue;
      const exists = this.db
        .query("SELECT id FROM broker_orders WHERE deal_ticket = ? LIMIT 1")
        .get(deal.dealTicket) as Row | null;
      if (exists) continue;
      const tradeId = this.logicalTradeIdForHistoryDeal(deal);
      if (!tradeId) continue;
      const open = this.openBrokerOrderForDeal(tradeId, deal);
      const action = historyDealAction(
        deal,
        open ? this.positionStillOpen(input.accountId, String(open.position_ticket ?? "")) : false,
      );
      const openPrice = nullableNumber(open?.filled_price ?? open?.requested_price);
      const trade = this.logicalTrade(tradeId);
      const signedPips =
        openPrice && deal.price
          ? trade?.direction === "SELL"
            ? openPrice - deal.price
            : deal.price - openPrice
          : null;
      const pnlPips =
        signedPips !== null
          ? Number((signedPips / brokerPipSize(deal.symbol ?? "")).toFixed(1))
          : null;
      const source = brokerOrderSourceForDealReason(deal.reason);
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
          Number(((deal.profit ?? 0) + (deal.commission ?? 0) + (deal.swap ?? 0)).toFixed(2)),
          pnlPips,
          source,
          deal.time ?? new Date().toISOString(),
        );
      recorded += 1;
    }
    return { accountId: input.accountId, received: input.deals.length, recorded };
  }

  mt5Accounts() {
    const snapshots = this.mt5SnapshotsByAccount();
    return (
      this.db
        .query(
          "SELECT id, account_number, server, company, currency, balance, equity, initial_balance, margin_mode, heartbeat_status, available_symbols_json, last_heartbeat_at FROM mt5_accounts ORDER BY account_number",
        )
        .all() as Row[]
    ).map((row) => ({
      id: String(row.id),
      accountNumber: String(row.account_number),
      server: String(row.server),
      company: String(row.company),
      currency: String(row.currency),
      balance: Number(row.balance),
      equity: Number(row.equity),
      initialBalance: Number(row.initial_balance ?? row.balance),
      marginMode: String(row.margin_mode),
      heartbeatStatus: heartbeatFreshness(String(row.last_heartbeat_at)),
      availableSymbols: parseJson<string[]>(String(row.available_symbols_json)),
      lastHeartbeatAt: String(row.last_heartbeat_at),
      openPositionCount: snapshots[String(row.id)]?.positions.length ?? 0,
      pendingOrderCount: snapshots[String(row.id)]?.orders.length ?? 0,
      lastSnapshotAt: snapshots[String(row.id)]?.updatedAt,
    }));
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
          "SELECT account_id, provider_id, enabled, updated_at FROM account_provider_links ORDER BY account_id, provider_id",
        )
        .all() as Row[]
    ).map((row) => ({
      accountId: String(row.account_id),
      providerId: String(row.provider_id),
      enabled: Boolean(row.enabled),
      updatedAt: String(row.updated_at),
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
    return enabled.length ? [...new Set(enabled)] : [fallback];
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

  executionLogs(accountId?: string) {
    const rows = accountId
      ? (this.db
          .query(
            "SELECT id, queue_item_id, account_id, status, retcode, retcode_external, broker_comment, order_ticket, position_ticket, deal_ticket, requested_price, filled_price, volume, error_text, created_at FROM execution_reports WHERE account_id = ? ORDER BY created_at DESC",
          )
          .all(accountId) as Row[])
      : (this.db
          .query(
            "SELECT id, queue_item_id, account_id, status, retcode, retcode_external, broker_comment, order_ticket, position_ticket, deal_ticket, requested_price, filled_price, volume, error_text, created_at FROM execution_reports ORDER BY created_at DESC",
          )
          .all() as Row[]);
    return rows.map((row) => ({
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
    }));
  }

  executionLogDetails(reportId: string) {
    const row = this.db
      .query(
        "SELECT id, queue_item_id, account_id, status, retcode, retcode_external, broker_comment, order_ticket, position_ticket, deal_ticket, requested_price, filled_price, volume, error_text, created_at FROM execution_reports WHERE id = ?",
      )
      .get(reportId) as Row | null;
    if (!row) return { error: "Execution log not found" };
    const log = this.executionLogs().find((item) => item.id === reportId);
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

  brokerOrders(logicalTradeId: string) {
    return (
      this.db
        .query(
          `SELECT id, logical_trade_id, leg_id, action, queue_item_id, account_id, order_ticket, position_ticket, deal_ticket,
            requested_volume, filled_volume, requested_price, filled_price, retcode, retcode_external, broker_comment, pnl_currency, pnl_pips, source, created_at
           FROM broker_orders WHERE logical_trade_id = ? ORDER BY created_at ASC`,
        )
        .all(logicalTradeId) as Row[]
    ).map((row) => ({
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
    }));
  }

  accountPerformance() {
    const accounts = this.mt5Accounts();
    const primary = accounts[0];
    if (!primary) {
      return {
        currency: "$",
        initialBalance: null,
        totalProfit: null,
        today: null,
        thisWeek: null,
        thisMonth: null,
        equityCurve: [],
        monthlyReturns: [],
      };
    }
    const initial = primary.initialBalance || primary.balance;
    const accountOrders = this.brokerOrdersForAccount(primary.id);
    const brokerPnl = sumPnl(accountOrders);
    const totalProfit = accountOrders.length ? brokerPnl : primary.equity - initial;
    return {
      accountId: primary.id,
      currency: primary.currency,
      initialBalance: initial,
      totalProfit,
      today: sumPnl(accountOrders.filter((order) => withinDays(order.createdAt, 1))),
      thisWeek: sumPnl(accountOrders.filter((order) => withinDays(order.createdAt, 7))),
      thisMonth: sumPnl(accountOrders.filter((order) => withinCurrentMonth(order.createdAt))),
      equityCurve: this.equityCurve(primary.id, initial, accountOrders),
      monthlyReturns: this.monthlyReturns(primary.id, initial, accountOrders),
    };
  }

  providerPerformance() {
    return this.providers().map((provider) => {
      const trades = this.logicalTrades().filter((trade) => trade.providerId === provider.id);
      const orders = trades.flatMap((trade) => this.brokerOrders(trade.id));
      const pnl = orders.reduce((sum, order) => sum + (order.pnlCurrency ?? 0), 0);
      const pips = orders.reduce((sum, order) => sum + (order.pnlPips ?? 0), 0);
      const pnlByTrade = trades.map((trade) => sumPnl(this.brokerOrders(trade.id)));
      const closed = pnlByTrade.filter((value) => value !== 0);
      return {
        id: provider.id,
        title: provider.title,
        lots: provider.lotSize,
        tradeCount: trades.length,
        pips,
        pnl,
        profit: pnl,
        gain: Number(
          (
            pnl /
            Math.max(
              1,
              orders.reduce(
                (sum, order) => sum + (order.requestedVolume ?? order.filledVolume ?? 0),
                0,
              ),
            )
          ).toFixed(2),
        ),
        winRate: closed.length ? closed.filter((value) => value > 0).length / closed.length : 0,
        averageDrawdown: 0,
      };
    });
  }

  private equityCurve(
    accountId: string,
    initialBalance?: number,
    orders = this.brokerOrdersForAccount(accountId),
  ) {
    const account = this.mt5Accounts().find((item) => item.id === accountId);
    if (!account) return [];
    const initial = initialBalance ?? account.initialBalance ?? account.balance;
    let equity = initial;
    let peak = initial;
    const points = [{ x: 0, equity, drawdown: 0 }];
    orders
      .filter((order) => order.pnlCurrency !== undefined)
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
      .forEach((order, index) => {
        equity += order.pnlCurrency ?? 0;
        peak = Math.max(peak, equity);
        points.push({
          x: index + 1,
          equity: Number(equity.toFixed(2)),
          drawdown: drawdownPercent(peak, equity),
        });
      });
    if (points.length === 1)
      points.push({
        x: 1,
        equity: account.equity,
        drawdown: drawdownPercent(account.balance, account.equity),
      });
    return points;
  }

  private monthlyReturns(
    accountId: string,
    initialBalance: number,
    orders = this.brokerOrdersForAccount(accountId),
  ) {
    const account = this.mt5Accounts().find((item) => item.id === accountId);
    if (!account || initialBalance <= 0) return [];
    const byMonth = new Map<string, number>();
    for (const order of orders) {
      const month = order.createdAt.slice(0, 7);
      byMonth.set(month, (byMonth.get(month) ?? 0) + (order.pnlCurrency ?? 0));
    }
    if (byMonth.size === 0) {
      return [
        {
          month: new Date().toISOString().slice(0, 7),
          returnPercent: ((account.equity - initialBalance) / initialBalance) * 100,
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
          "SELECT logical_trade_id FROM broker_orders WHERE account_id = ? GROUP BY logical_trade_id",
        )
        .all(accountId) as Row[]
    ).flatMap((row) => this.brokerOrders(String(row.logical_trade_id)));
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
    this.db
      .query(
        "INSERT INTO account_symbol_mappings (account_id, mapping_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET mapping_json = excluded.mapping_json, updated_at = excluded.updated_at",
      )
      .run(accountId, JSON.stringify({ ...mapping, accountId }), new Date().toISOString());
    return { accountId, mapping: { ...mapping, accountId } };
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
      this.parserContext(message.providerId, this.defaultParserAccountId()),
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
      accountPerformance: this.accountPerformance(),
      providerPerformance: this.providerPerformance(),
      accountSlots: this.accountSlots(),
      accountProviderLinks: this.accountProviderLinks(),
      equityGuardians: this.equityGuardians(),
      telegramSessions: (
        this.db
          .query(
            "SELECT id, profile_id, phone, status FROM telegram_sessions ORDER BY created_at DESC",
          )
          .all() as Row[]
      ).map((row) => ({
        id: String(row.id),
        profileId: String(row.profile_id),
        phone: maskPhone(String(row.phone)),
        status: String(row.status),
      })),
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
        heartbeatStatus: account.heartbeatStatus,
        marginMode: account.marginMode,
        openPositionCount: account.openPositionCount,
        pendingOrderCount: account.pendingOrderCount,
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
      executionLogs: this.executionLogs()
        .slice(0, 10)
        .map((log) => ({
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

  private defaultParserAccountId() {
    return this.mt5Accounts()[0]?.id ?? fallbackAccountId;
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
        initial_balance REAL NOT NULL DEFAULT 0,
        margin_mode TEXT NOT NULL,
        heartbeat_status TEXT NOT NULL,
        available_symbols_json TEXT NOT NULL,
        last_heartbeat_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    this.ensureColumn("mt5_accounts", "initial_balance", "REAL NOT NULL DEFAULT 0");
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
        PRIMARY KEY (account_id, provider_id)
      );
    `);
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
        this.parserContext(providerId, this.defaultParserAccountId()),
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
    return rows.map((row) =>
      this.insertParsedSignal({
        providerId,
        rawMessageId: String(row.id),
        rawText: String(row.raw_text),
        accountId,
      }),
    );
  }

  private insertParsedSignal(input: {
    providerId: string;
    rawMessageId: string;
    rawText: string;
    accountId: string;
  }) {
    const parsedSignalId = `parse_${nanoid(10)}`;
    const result = parseSignalText(
      input.rawText,
      this.parserContext(input.providerId, input.accountId),
    );
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
        new Date().toISOString(),
      );
    return {
      parsedSignalId,
      reviewRequired,
      result,
    };
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
    status: Extract<QueueStatus, "DUPLICATE" | "IGNORED">,
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
    const brokerRecords = [...positions, ...orders];
    for (const trade of this.logicalTrades().filter((item) => item.accountId === accountId)) {
      const hasBrokerState = trade.legs.some((leg) => leg.status !== "PLANNED");
      if (!hasBrokerState || trade.status === "CLOSED") continue;

      const matched = brokerRecords.some((record) => brokerRecordContainsTrade(record, trade.id));
      if (matched && trade.status === "OUT_OF_SYNC") {
        this.db
          .query("UPDATE logical_trades SET status = ?, data_json = ? WHERE id = ?")
          .run("OPEN", JSON.stringify({ ...trade, status: "OPEN" }), trade.id);
      }
      if (!matched && trade.status !== "OUT_OF_SYNC") {
        this.db
          .query("UPDATE logical_trades SET status = ?, data_json = ? WHERE id = ?")
          .run("OUT_OF_SYNC", JSON.stringify({ ...trade, status: "OUT_OF_SYNC" }), trade.id);
      }
    }
  }

  private logicalTradesForDashboard() {
    return this.logicalTrades().map((trade) => {
      return {
        id: trade.id,
        symbol: trade.symbol.brokerSymbol ?? trade.symbol.canonicalSymbol ?? "unmapped",
        direction: trade.direction,
        status: trade.status,
        executionMode: trade.executionMode,
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
    const virtualTpLeg = virtualTpLegFromBrokerComment(input.brokerComment);
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
        status: legs.every((leg) => leg.status === "CLOSED") ? "CLOSED" : trade.status,
        legs,
      };
    } else if (payload.commandType === "OPEN_TRADE") {
      updated = {
        ...trade,
        status: "OPEN",
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
      updated = {
        ...trade,
        legs: trade.legs.map((leg) =>
          leg.leg === payload.partialClose?.value
            ? { ...leg, status: "CLOSED", brokerEvidence: evidence }
            : leg,
        ),
      };
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
    const pnl = this.computeBrokerOrderPnl(tradeId, payload, input);
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
        brokerAction(payload.commandType),
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
        brokerOrderSourceForPayload(payload),
        now,
      );
  }

  private brokerTargetForCommand(logicalTradeId: string, payload: ExecutionQueueItem["payload"]) {
    const action = brokerAction(payload.commandType);
    const rows = this.brokerOrders(logicalTradeId).slice().reverse();
    if (action === "CANCEL_PENDING") {
      const order = rows.find((row) => row.orderTicket && row.action === "OPEN");
      return { targetOrderTicket: order?.orderTicket, targetPositionTicket: order?.positionTicket };
    }
    const position = rows.find(
      (row) => row.positionTicket && row.action !== "FULL_CLOSE" && row.action !== "PARTIAL_CLOSE",
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
        "SELECT logical_trade_id, leg_id, position_ticket, order_ticket FROM broker_orders WHERE account_id = ? AND action = 'OPEN' AND (position_ticket != '' OR order_ticket != '')",
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
    if (fromComment) return fromComment;
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
    return "";
  }

  private openBrokerOrderForDeal(tradeId: string, deal: Mt5HistoryDealInput) {
    if (deal.positionTicket) {
      const row = this.db
        .query(
          "SELECT * FROM broker_orders WHERE logical_trade_id = ? AND position_ticket = ? AND action = 'OPEN' ORDER BY created_at ASC LIMIT 1",
        )
        .get(tradeId, deal.positionTicket) as Row | null;
      if (row) return row;
    }
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

  private computeBrokerOrderPnl(
    tradeId: string,
    payload: ExecutionQueueItem["payload"],
    input: ExecutionReportInput,
  ) {
    if (!input.filledPrice || !input.volume || !payload.direction) {
      return { pnlCurrency: null, pnlPips: null };
    }
    const action = brokerAction(payload.commandType);
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
        "SELECT filled_price FROM broker_orders WHERE logical_trade_id = ? AND action = 'OPEN' AND filled_price IS NOT NULL ORDER BY created_at ASC LIMIT 1",
      )
      .get(tradeId) as Row | null;
    const openPrice = nullableNumber(open?.filled_price);
    if (!openPrice) return { pnlCurrency: null, pnlPips: null };
    const signed =
      payload.direction === "BUY" ? input.filledPrice - openPrice : openPrice - input.filledPrice;
    const pipSize = brokerPipSize(payload.brokerSymbol ?? payload.canonicalSymbol ?? "");
    return {
      pnlCurrency: Number((signed * input.volume).toFixed(4)),
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

function brokerOrderSourceForPayload(payload: ExecutionQueueItem["payload"]) {
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
  const virtualTp = virtualTpLegFromBrokerComment(input.brokerComment);
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

function brokerTicketFromSnapshot(record: unknown) {
  if (!record || typeof record !== "object") return "";
  const value = (record as Record<string, unknown>).ticket;
  return value === undefined || value === null ? "" : String(value);
}

function logicalTradeIdFromComment(comment: string) {
  const match = comment.match(/telegram-tc(?:-close|-virtual-tp)?:([^:\s]+)/i);
  return match?.[1] ?? "";
}

function historyDealAction(deal: Mt5HistoryDealInput, positionStillOpen: boolean) {
  const entry = String(deal.entry ?? "").toUpperCase();
  if (entry.includes("IN") && !entry.includes("OUT")) return "OPEN";
  return positionStillOpen ? "PARTIAL_CLOSE" : "FULL_CLOSE";
}

function historyDealLegId(deal: Mt5HistoryDealInput) {
  const match = String(deal.comment ?? "").match(/:tp(\d+)/i);
  return match?.[1] ? `tp${match[1]}` : "trade";
}

function drawdownPercent(balance: number, equity: number) {
  if (!Number.isFinite(balance) || balance <= 0 || !Number.isFinite(equity)) return 0;
  return Number(Math.max(0, ((balance - equity) / balance) * 100).toFixed(2));
}

function sumPnl(orders: Array<{ pnlCurrency?: number }>) {
  return Number(orders.reduce((sum, order) => sum + (order.pnlCurrency ?? 0), 0).toFixed(2));
}

function withinDays(iso: string, days: number) {
  const time = Date.parse(iso);
  return Number.isFinite(time) && Date.now() - time <= days * 24 * 60 * 60 * 1000;
}

function withinCurrentMonth(iso: string) {
  return iso.slice(0, 7) === new Date().toISOString().slice(0, 7);
}

function heartbeatFreshness(iso: string) {
  const ageMs = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ageMs)) return "offline";
  if (ageMs <= 10_000) return "online";
  if (ageMs <= 30_000) return "stale";
  return "offline";
}

function normalizeProviderTpLevels(
  levels?: ProviderTakeProfitLevelInput[],
): ProviderTakeProfitLevel[] {
  const source = levels?.length
    ? levels
    : Array.from({ length: MAX_PROVIDER_TP_LEVELS }, (_, index) => ({
        leg: index + 1,
        percentage: 25,
        strategy: { kind: "no-change" as const },
      }));
  const cleaned = source
    .map((level, index) => ({
      leg: Number.isFinite(level.leg) && level.leg > 0 ? Math.round(level.leg) : index + 1,
      percentage: Math.max(0, Number(level.percentage) || 0),
      strategy: normalizeTakeProfitStrategy(level.strategy),
    }))
    .slice(0, MAX_PROVIDER_TP_LEVELS);
  const total = cleaned.reduce((sum, level) => sum + level.percentage, 0);
  if (total <= 0) {
    return Array.from({ length: MAX_PROVIDER_TP_LEVELS }, (_, index) => ({
      leg: index + 1,
      percentage: 25,
      strategy: { kind: "no-change" },
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
): ParsedSignal {
  if (signal.commandType !== "OPEN_TRADE" || signal.takeProfits.length === 0) return signal;
  const levelsByLeg = new Map(config.takeProfitLevels.map((level) => [level.leg, level]));
  return {
    ...signal,
    takeProfits: signal.takeProfits.map((target, index) => {
      const level = levelsByLeg.get(target.leg) ?? config.takeProfitLevels[index];
      return {
        ...target,
        allocationPercent: level?.percentage ?? target.allocationPercent,
        strategy: level?.strategy ?? target.strategy ?? { kind: "no-change" },
      };
    }),
  };
}

function virtualTpLegFromBrokerComment(comment: string) {
  const match = comment.match(/:tp([1-4])\b/i);
  return match?.[1] ? Number(match[1]) : undefined;
}

function tpHitLegFromText(text: string, trade: LogicalTrade): number | "all" | undefined {
  if (/\bFULL\s+TP\b/i.test(text)) return "all";
  const explicit = text.match(/\bTP\s*([1-4])\b/i);
  if (explicit?.[1]) return Number(explicit[1]);
  return trade.legs.find((leg) => leg.status !== "HIT" && leg.status !== "CLOSED")?.leg;
}

function brokerRecordContainsTrade(record: unknown, tradeId: string) {
  if (!record || typeof record !== "object") return false;
  const values = Object.values(record as Record<string, unknown>);
  return values.some((value) => typeof value === "string" && value.includes(tradeId));
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

function normalizeAppSettings(input: Partial<AppSettings>): AppSettings {
  const allowedOrderTypes =
    input.allowedOrderTypes?.filter((orderType): orderType is AppOrderType =>
      appOrderTypes.has(orderType as AppOrderType),
    ) ?? defaultAppSettings.allowedOrderTypes;
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
  };
}

function positiveNumber(value: unknown, fallback: number) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
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
