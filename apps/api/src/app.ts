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
}

const demoAccountId = "mt5-100200300";
const demoProviderId = "provider-alpha";

const defaultGlobalAliases = {
  GOLD: "XAUUSD",
  "EUR/USD": "EURUSD",
  US30: "DJI30",
};

const defaultProviderAliases = {
  [demoProviderId]: {
    GOLD: "XAUUSD",
  },
};

type SymbolAliasScope = "global" | "provider";
type AppOrderType = Extract<OrderType, "MARKET" | "LIMIT" | "STOP">;

interface AppSettings {
  defaultLotSize: number;
  defaultRiskPercent: number;
  pollingIntervalSeconds: number;
  allowedOrderTypes: AppOrderType[];
}

const defaultAppSettings: AppSettings = {
  defaultLotSize: 0.1,
  defaultRiskPercent: 1,
  pollingIntervalSeconds: 2,
  allowedOrderTypes: ["MARKET", "LIMIT", "STOP"],
};

const appOrderTypes = new Set<AppOrderType>(["MARKET", "LIMIT", "STOP"]);

function defaultAccountMapping(accountId = demoAccountId): AccountSymbolMapping {
  return {
    accountId,
    canonicalOverrides: {
      XAUUSD: "XAUUSD.r",
    },
    suffix: ".raw",
    includeSymbols: ["EURUSD.raw", "XAUUSD.r", "DJI30.raw"],
    excludeSymbols: [],
    availableBrokerSymbols: ["EURUSD.raw", "XAUUSD.r", "DJI30.raw"],
  };
}

export function createApi(options: ApiOptions = {}) {
  const store = new AppStore(
    options.databasePath ?? process.env.DATABASE_PATH ?? "data/telegram-tc.db",
  );
  const telegram =
    options.telegram ??
    createTelegramAdapter(
      options.telegramAdapter ?? (options.databasePath === ":memory:" ? "mock" : undefined),
    );
  if (options.seedDemoData ?? true) {
    store.seedDemoData();
  }

  const app = new Hono();
  app.use("/api/*", cors());

  app.get("/api/health", (c) =>
    c.json({
      status: "ok",
      database: "connected",
      telegramAdapter: telegram.name,
    }),
  );

  app.get("/api/dashboard", (c) => c.json(store.dashboard()));
  app.get("/api/settings", (c) => c.json({ settings: store.appSettings() }));
  app.patch("/api/settings", async (c) => {
    const body = await c.req.json<Partial<AppSettings>>();
    return c.json({ settings: store.updateAppSettings(body) });
  });

  app.post("/api/telegram/start", async (c) => {
    const body = await c.req.json<{
      apiId: string;
      apiHash: string;
      phone: string;
    }>();
    const started = store.startTelegramSession(body);
    const adapterStatus = await telegram.startLogin({
      ...body,
      appSessionId: started.sessionId,
      profileId: started.profileId,
    });
    if (adapterStatus.status !== started.status) {
      store.updateTelegramSession(started.sessionId, adapterStatus.status);
    } else if (adapterStatus.status === "CONNECTED") {
      store.ensureProviderForProfile(started.profileId);
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
    return c.json({ dialogs: store.dialogs(profileId) });
  });

  app.get("/api/providers", (c) => c.json({ providers: store.providers() }));

  app.post("/api/providers", async (c) => {
    const body = await c.req.json<{ profileId: string; dialogId: string; title?: string }>();
    return c.json(store.selectProvider(body));
  });

  app.patch("/api/providers/:id", async (c) => {
    const body = await c.req.json<{
      enabled?: boolean;
      parserMode?: string;
      riskProfile?: string;
    }>();
    return c.json(store.updateProvider(c.req.param("id"), body));
  });

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

  app.put("/api/symbol-mappings/account/:accountId", async (c) => {
    const mapping = await c.req.json<AccountSymbolMapping>();
    return c.json(store.saveAccountMapping(c.req.param("accountId"), mapping));
  });

  app.get("/api/mt5/accounts", (c) => c.json({ accounts: store.mt5Accounts() }));

  app.post("/api/mt5/register", async (c) => {
    const body = await c.req.json<{
      accountNumber: string;
      server: string;
      company: string;
      currency: string;
      balance: number;
      equity: number;
      marginMode: "HEDGING" | "NETTING";
      availableSymbols?: string[];
    }>();
    return c.json(store.registerMt5Account(body));
  });

  app.post("/api/mt5/heartbeat", async (c) => {
    const body = await c.req.json<{
      accountId: string;
      balance: number;
      equity: number;
      availableSymbols?: string[];
    }>();
    return c.json(store.heartbeat(body));
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
    const body = await c.req.json<ExecutionReportInput>();
    return c.json(store.executionReport(body));
  });

  app.post("/api/mt5/snapshot", async (c) => {
    const body = await c.req.json<{
      accountId: string;
      positions: unknown[];
      orders: unknown[];
      symbols?: unknown[];
    }>();
    return c.json(store.saveSnapshot(body));
  });

  app.get("/api/execution-logs", (c) =>
    c.json({ logs: store.executionLogs(c.req.query("accountId")) }),
  );

  app.get("/api/mt5/accounts/:accountId/logs", (c) =>
    c.json(store.mt5AccountLogs(c.req.param("accountId"))),
  );

  if (options.staticRoot) {
    app.use("/*", serveStatic({ root: options.staticRoot }));
    app.get("*", async (c) => c.html(await Bun.file(`${options.staticRoot}/index.html`).text()));
  }

  return app;
}

interface ExecutionReportInput {
  accountId: string;
  queueItemId: string;
  status: "EXECUTED" | "FAILED";
  retcode: number;
  retcodeExternal: number;
  brokerComment: string;
  orderTicket?: string;
  dealTicket?: string;
  requestedPrice?: number;
  filledPrice?: number;
  volume?: number;
  errorText?: string;
}

type RawMessageClassification = "entry" | "management" | "noise" | "unknown";

class AppStore {
  private readonly db: Database;

  constructor(databasePath: string) {
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
      this.ensureMockProvider(String(session.profile_id));
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
    ).map((row) => ({
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

  selectProvider(input: { profileId: string; dialogId: string; title?: string }) {
    const dialog = this.dialogs(input.profileId).find((item) => item.id === input.dialogId);
    const id =
      input.dialogId === "dialog-alpha"
        ? demoProviderId
        : `provider_${hashHint(`${input.profileId}:${input.dialogId}`).replace(/^api_/, "")}`;
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

  updateProvider(
    id: string,
    input: { enabled?: boolean; parserMode?: string; riskProfile?: string; lotSize?: number },
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
    this.audit("provider.update", "info", "Provider settings updated", {
      providerId: id,
      ...input,
    });
    return { provider: this.providers().find((provider) => provider.id === id) };
  }

  providerDetails(providerId: string) {
    return this.providers().find((provider) => provider.id === providerId);
  }

  connectedSessionIdForProfile(profileId: string) {
    const row = this.db
      .query(
        "SELECT id FROM telegram_sessions WHERE profile_id = ? AND status = 'CONNECTED' ORDER BY updated_at DESC LIMIT 1",
      )
      .get(profileId) as Row | null;
    return row ? String(row.id) : undefined;
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
      const parsed = parseSignalText(parserText, this.parserContext(providerId, demoAccountId));
      this.db
        .query(
          `INSERT INTO raw_messages (id, provider_id, telegram_message_id, message_date, raw_text, fingerprint, classification)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             message_date = excluded.message_date,
             raw_text = excluded.raw_text,
             fingerprint = excluded.fingerprint,
             classification = excluded.classification`,
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

  backtestProviderMessages(
    providerId: string,
    input: { accountId?: string; dateFrom?: string; dateTo?: string } = {},
  ) {
    const accountId = input.accountId ?? demoAccountId;
    const rows = this.rawMessagesForBacktest(providerId, input);
    const commandCounts: Record<string, number> = {};
    const mappingStatusCounts: Record<string, number> = {};
    const missingFieldCounts: Record<string, number> = {};
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
      if (parsed.commandType === "OPEN_TRADE") openSignals += 1;
      else if (parsed.commandType !== "NO_SIGNAL") lifecycleCommands += 1;
      if (parsed.commandType !== "NO_SIGNAL") actionableMessages += 1;
      const needsReview = shouldRequireManualReview(parsed);
      if (needsReview) reviewRequired += 1;
      if (needsReview && parsed.commandType !== "NO_SIGNAL") actionableReviewRequired += 1;
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
      reviewRequired,
      reviewRate: rows.length ? Number((reviewRequired / rows.length).toFixed(4)) : 0,
      actionableReviewRequired,
      actionableReviewRate: actionableMessages
        ? Number((actionableReviewRequired / actionableMessages).toFixed(4))
        : 0,
      commandCounts,
      mappingStatusCounts,
      missingFieldCounts,
      examples,
    };
  }

  parseProviderMessage(providerId: string, rawText: string, accountId = demoAccountId) {
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

  parseRecentProviderMessages(providerId: string, limit: number, accountId = demoAccountId) {
    return this.recentMessages(providerId, limit).flatMap((message) => {
      const existing = this.db
        .query("SELECT id FROM parsed_signals WHERE raw_message_id = ? LIMIT 1")
        .get(message.id) as Row | null;
      if (existing) return [];
      const parsedSignalId = `parse_${nanoid(10)}`;
      const result = parseSignalText(message.rawText, this.parserContext(providerId, accountId));
      this.db
        .query(
          "INSERT INTO parsed_signals (id, provider_id, raw_message_id, result_json, review_required, fingerprint, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          parsedSignalId,
          providerId,
          message.id,
          JSON.stringify(result),
          Number(shouldRequireManualReview(result)),
          result.fingerprint,
          "PARSED",
          new Date().toISOString(),
        );
      return [
        {
          parsedSignalId,
          reviewRequired: shouldRequireManualReview(result),
          result,
        },
      ];
    });
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
        body: { queueItemId?: string; logicalTradeId?: string; status: string };
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
    const accountId = signal.accountId ?? demoAccountId;
    const executionMode = options.executionMode ?? "VIRTUAL_TP";
    const settings = this.appSettings();
    const provider = this.providerDetails(String(row.provider_id));
    const duplicate = this.db
      .query(
        "SELECT id FROM parsed_signals WHERE provider_id = ? AND fingerprint = ? AND id != ? AND status = 'APPROVED' LIMIT 1",
      )
      .get(String(row.provider_id), signal.fingerprint, parsedSignalId) as Row | null;
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

    const queueId = `queue_${nanoid(10)}`;
    let logicalTradeId: string | undefined;
    let signalForQueue = signal;
    if (signal.commandType === "OPEN_TRADE") {
      if (shouldRequireManualReview(signal)) {
        return { statusCode: 422, error: "Signal still requires manual review before queueing" };
      }
      const orderType = signal.orderType ?? "MARKET";
      if (!settings.allowedOrderTypes.includes(orderType)) {
        return { statusCode: 422, error: `${orderType} orders are not allowed by settings` };
      }
      logicalTradeId = `trade_${nanoid(10)}`;
      const trade = createLogicalTradeFromSignal(signal, {
        id: logicalTradeId,
        providerId: String(row.provider_id),
        accountId,
        executionMode,
      });
      this.insertTrade(trade);
    } else if (signal.commandType === "NO_SIGNAL") {
      return { statusCode: 422, error: "Message is not a trade signal" };
    } else {
      const match = matchLifecycleCommandToTrade(signal, this.logicalTrades());
      if (match.requiresManualReview || !match.tradeId) {
        return {
          statusCode: 422,
          error: match.reason ?? "Lifecycle command requires manual review before queueing",
        };
      }
      const trade = this.logicalTrade(match.tradeId);
      if (!trade) {
        return { statusCode: 422, error: "Matched logical trade could not be loaded" };
      }
      logicalTradeId = trade.id;
      if (signal.commandType === "MARK_TP_HIT") {
        this.recordProviderTpHit(trade.id, signal);
        this.db
          .query("UPDATE parsed_signals SET status = ? WHERE id = ?")
          .run("APPROVED", parsedSignalId);
        this.audit("signal.tp-hit", "info", "Provider TP hit recorded for logical trade", {
          parsedSignalId,
          logicalTradeId: trade.id,
        });
        return { body: { logicalTradeId: trade.id, status: "RECORDED" } };
      }
      signalForQueue = enrichLifecycleSignalFromTrade(signal, trade);
      this.appendTradeCommand(trade.id, signal);
    }
    const queueItem = buildExecutionCommand(signalForQueue, {
      id: queueId,
      accountId,
      logicalTradeId,
      executionMode,
      volume: provider?.lotSize ?? settings.defaultLotSize,
      riskPercent: settings.defaultRiskPercent,
    });
    this.insertQueueItem(queueItem, parsedSignalId);
    this.db
      .query("UPDATE parsed_signals SET status = ? WHERE id = ?")
      .run("APPROVED", parsedSignalId);
    this.audit("signal.approve", "info", "Signal approved for MT5 queue", {
      parsedSignalId,
      queueId,
    });
    return { body: { queueItemId: queueId, logicalTradeId, status: "PENDING" } };
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
          accountId: signal.accountId ?? demoAccountId,
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
  }) {
    const accountId = `mt5-${input.accountNumber}`;
    const now = new Date().toISOString();
    this.db
      .query(
        `INSERT INTO mt5_accounts
          (id, account_number, server, company, currency, balance, equity, margin_mode, heartbeat_status, available_symbols_json, last_heartbeat_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        input.marginMode,
        "online",
        JSON.stringify(input.availableSymbols ?? []),
        now,
        now,
      );
    this.saveAccountMapping(accountId, {
      ...defaultAccountMapping(accountId),
      availableBrokerSymbols:
        input.availableSymbols ?? defaultAccountMapping(accountId).availableBrokerSymbols,
    });
    this.audit("mt5.register", "info", "MT5 account registered", {
      accountId,
      marginMode: input.marginMode,
    });
    return { accountId, status: "REGISTERED" };
  }

  heartbeat(input: {
    accountId: string;
    balance: number;
    equity: number;
    availableSymbols?: string[];
  }) {
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
    return { accountId: input.accountId, heartbeatStatus: "online", at: now };
  }

  leaseNextQueueItem(accountId?: string): ReturnType<typeof queueRow> | null {
    const row = accountId
      ? (this.db
          .query(
            "SELECT id, account_id, logical_trade_id, status, payload_json, leased_at, created_at FROM queue_items WHERE status = 'PENDING' AND account_id = ? ORDER BY created_at LIMIT 1",
          )
          .get(accountId) as Row | null)
      : (this.db
          .query(
            "SELECT id, account_id, logical_trade_id, status, payload_json, leased_at, created_at FROM queue_items WHERE status = 'PENDING' ORDER BY created_at LIMIT 1",
          )
          .get() as Row | null);
    if (!row) return null;
    const leasedAt = new Date().toISOString();
    this.db
      .query("UPDATE queue_items SET status = ?, leased_at = ?, updated_at = ? WHERE id = ?")
      .run("LEASED", leasedAt, leasedAt, String(row.id));
    return queueRow({ ...row, status: "LEASED", leased_at: leasedAt });
  }

  executionReport(input: ExecutionReportInput) {
    const id = `report_${nanoid(10)}`;
    const now = new Date().toISOString();
    this.db
      .query(
        `INSERT INTO execution_reports
          (id, queue_item_id, account_id, status, retcode, retcode_external, broker_comment, order_ticket, deal_ticket, requested_price, filled_price, volume, error_text, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    this.audit(
      "mt5.report",
      input.status === "EXECUTED" ? "info" : "error",
      "MT5 execution report received",
      input,
    );
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
    this.audit("mt5.snapshot", "info", "MT5 state snapshot received", input);
    return {
      accountId: input.accountId,
      status: "RECORDED",
      openPositionCount: input.positions.length,
      pendingOrderCount: input.orders.length,
    };
  }

  mt5Accounts() {
    const snapshots = this.mt5SnapshotsByAccount();
    return (
      this.db
        .query(
          "SELECT id, account_number, server, company, currency, balance, equity, margin_mode, heartbeat_status, available_symbols_json, last_heartbeat_at FROM mt5_accounts ORDER BY account_number",
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
      marginMode: String(row.margin_mode),
      heartbeatStatus: String(row.heartbeat_status),
      availableSymbols: parseJson<string[]>(String(row.available_symbols_json)),
      lastHeartbeatAt: String(row.last_heartbeat_at),
      openPositionCount: snapshots[String(row.id)]?.positions.length ?? 0,
      pendingOrderCount: snapshots[String(row.id)]?.orders.length ?? 0,
      lastSnapshotAt: snapshots[String(row.id)]?.updatedAt,
    }));
  }

  executionLogs(accountId?: string) {
    const rows = accountId
      ? (this.db
          .query(
            "SELECT id, queue_item_id, account_id, status, retcode, retcode_external, broker_comment, order_ticket, deal_ticket, requested_price, filled_price, volume, error_text, created_at FROM execution_reports WHERE account_id = ? ORDER BY created_at DESC",
          )
          .all(accountId) as Row[])
      : (this.db
          .query(
            "SELECT id, queue_item_id, account_id, status, retcode, retcode_external, broker_comment, order_ticket, deal_ticket, requested_price, filled_price, volume, error_text, created_at FROM execution_reports ORDER BY created_at DESC",
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
      dealTicket: String(row.deal_ticket),
      requestedPrice: row.requested_price === null ? undefined : Number(row.requested_price),
      filledPrice: row.filled_price === null ? undefined : Number(row.filled_price),
      volume: row.volume === null ? undefined : Number(row.volume),
      errorText: String(row.error_text),
      createdAt: String(row.created_at),
    }));
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
    return {
      globalAliases: this.globalAliases(),
      providerAliases: this.providerAliases(),
      accountMappings: (
        this.db
          .query("SELECT account_id, mapping_json FROM account_symbol_mappings ORDER BY account_id")
          .all() as Row[]
      ).map((row) => parseJson<AccountSymbolMapping>(String(row.mapping_json))),
      preview: [
        {
          rawSymbol: "GOLD",
          canonicalSymbol: "XAUUSD",
          brokerSymbol: "XAUUSD.r",
          status: "mapped",
        },
        {
          rawSymbol: "EUR/USD",
          canonicalSymbol: "EURUSD",
          brokerSymbol: "EURUSD.raw",
          status: "mapped",
        },
        {
          rawSymbol: "US30",
          canonicalSymbol: "DJI30",
          brokerSymbol: "DJI30.raw",
          status: "mapped",
        },
      ],
    };
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
    const parsed = parseSignalText(rawText, this.parserContext(message.providerId, demoAccountId));
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
    if (!row) return { ...defaultAppSettings };
    return normalizeAppSettings(parseJson<Partial<AppSettings>>(String(row.settings_json)));
  }

  updateAppSettings(input: Partial<AppSettings>) {
    const settings = normalizeAppSettings({ ...this.appSettings(), ...input });
    this.db
      .query("INSERT OR REPLACE INTO app_settings (id, settings_json, updated_at) VALUES (?, ?, ?)")
      .run("default", JSON.stringify(settings), new Date().toISOString());
    this.audit("settings.update", "info", "Application settings updated", settings);
    return settings;
  }

  dashboard() {
    const providers = this.providers();
    const parsed = this.parsedSignals();
    const accounts = this.mt5Accounts();
    const queue = this.queueItems();
    return {
      health: {
        status: "ok",
        database: "connected",
        telegramAdapter: process.env.TELEGRAM_ADAPTER ?? "mock",
      },
      appSettings: this.appSettings(),
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
        title: provider.title,
        enabled: provider.enabled,
        parserMode: provider.parserMode,
        riskProfile: provider.riskProfile,
        lotSize: provider.lotSize,
        lastMessageAt: provider.lastMessageAt,
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
    this.ensureMockProvider(profileId);
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
        last_message_at TEXT NOT NULL
      );
    `);
    this.ensureColumn("providers", "risk_profile", "TEXT NOT NULL DEFAULT 'balanced'");
    this.ensureColumn("providers", "lot_size", "REAL NOT NULL DEFAULT 0.1");
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
        leased_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
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
        margin_mode TEXT NOT NULL,
        heartbeat_status TEXT NOT NULL,
        available_symbols_json TEXT NOT NULL,
        last_heartbeat_at TEXT NOT NULL,
        created_at TEXT NOT NULL
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
        this.parserContext(providerId, demoAccountId),
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
    return {
      providerId,
      accountId,
      globalAliases: this.globalAliases(),
      providerAliases: this.providerAliases(),
      providerDefaultSymbols: this.providerDefaultSymbols(),
      accountMappings: this.accountMappings(accountId),
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
    const row = this.db
      .query("SELECT mapping_json FROM account_symbol_mappings WHERE account_id = ?")
      .get(accountId) as Row | null;
    return {
      [accountId]: row
        ? parseJson<AccountSymbolMapping>(String(row.mapping_json))
        : defaultAccountMapping(accountId),
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
        "INSERT INTO queue_items (id, parsed_signal_id, logical_trade_id, account_id, status, payload_json, leased_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        item.id,
        parsedSignalId,
        item.logicalTradeId ?? "",
        item.accountId ?? "",
        item.status,
        JSON.stringify(item.payload),
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
    leasedAt: row.leased_at ? String(row.leased_at) : undefined,
    createdAt: String(row.created_at),
  };
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
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
    `newStopLoss=${item.payload.newStopLoss ?? ""}`,
    `trailingStopValue=${item.payload.trailingStop?.value ?? ""}`,
    `trailingStopUnit=${item.payload.trailingStop?.unit ?? ""}`,
    `partialCloseKind=${item.payload.partialClose?.kind ?? ""}`,
    `partialCloseValue=${item.payload.partialClose?.value ?? ""}`,
  ];
  for (const takeProfit of item.payload.takeProfits) {
    lines.push(`tp${takeProfit.leg}=${takeProfit.price}`);
    lines.push(`tp${takeProfit.leg}Allocation=${takeProfit.allocationPercent}`);
    lines.push(`tp${takeProfit.leg}Volume=${takeProfit.volume ?? ""}`);
  }
  return `${lines.join("\n")}\n`;
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

function enrichLifecycleSignalFromTrade(signal: ParsedSignal, trade: LogicalTrade): ParsedSignal {
  return {
    ...signal,
    rawSymbol: signal.rawSymbol ?? trade.symbol.rawSymbol,
    canonicalSymbol: signal.canonicalSymbol ?? trade.symbol.canonicalSymbol,
    brokerSymbol: signal.brokerSymbol ?? trade.symbol.brokerSymbol,
    mappingStatus: trade.symbol.mappingStatus,
    mappingWarnings: trade.symbol.warnings,
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
