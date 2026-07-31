import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSignalText } from "@telegram-tc/core";
import {
  brokerOrderSourceForDealReason,
  createApi,
  evaluateLifecycleActionState,
  hasExitVocabularyForDropAudit,
  normalizeEvidenceTargets,
} from "./app";
import { corpusMessages } from "./fixtures/provider-messages";
import type { TelegramAdapter, TelegramCapturedMessage, TelegramDialog } from "./telegram";

const json = async <T>(response: Response) => (await response.json()) as T;

// Verbatim 2026-07-29 incident messages supplied by the operator. They are kept
// outside the locked 1,945-message corpus so its command tallies remain unchanged.
const realKalBuy4016Incident = "Gold buy limit\n\n4016-15\n\nSl 4010\n\nTp 4021\nTp 4028";
const realKalCancelOtherEntriesIncident = "Cancel other entries\n\nWe done today";

function createQueuedTelegramAdapter(messages: TelegramCapturedMessage[]): TelegramAdapter {
  return {
    name: "mock",
    async startLogin() {
      return { status: "CODE_REQUIRED" as const };
    },
    async submitCode() {
      return { status: "CONNECTED" as const };
    },
    async submitPassword() {
      return { status: "CONNECTED" as const };
    },
    async disconnect() {},
    async listDialogs() {
      return [
        {
          id: "dialog-btc",
          title: "Test Forex Group",
          type: "group" as const,
          unreadCount: messages.length,
        },
      ];
    },
    async fetchRecentMessages() {
      return { messages, gap: undefined };
    },
  };
}

function createDialogTelegramAdapter(
  dialogs: TelegramDialog[],
  messages: TelegramCapturedMessage[] = [],
): TelegramAdapter {
  return {
    name: "mock",
    async startLogin() {
      return { status: "CODE_REQUIRED" as const };
    },
    async submitCode() {
      return { status: "CONNECTED" as const };
    },
    async submitPassword() {
      return { status: "CONNECTED" as const };
    },
    async disconnect() {},
    async listDialogs() {
      return dialogs;
    },
    async fetchRecentMessages() {
      return { messages, gap: undefined };
    },
  };
}

function realFixtureMessages(ids: string[]): TelegramCapturedMessage[] {
  return ids.map((telegramMessageId, index) => {
    const fixture = corpusMessages.find(
      (message) => message.telegramMessageId === telegramMessageId,
    );
    if (!fixture) throw new Error(`Missing committed provider fixture ${telegramMessageId}`);
    return {
      telegramMessageId,
      replyToMessageId: fixture.replyToMessageId ?? undefined,
      messageDate: `2026-07-26T00:${String(index).padStart(2, "0")}:00.000Z`,
      rawText: fixture.rawText,
    };
  });
}

// Opens a VIRTUAL_TP trade end to end: parse, approve, drain the open command, report it
// filled. Returns the approval so callers can post snapshots against the same position.
async function openVirtualTpTrade(
  app: ReturnType<typeof createApi>,
  providerId: string,
  input: { rawText: string; ticket: string; filledPrice: number; volume?: number },
) {
  const parsed = await json<{ parsedSignalId: string }>(
    await app.request("/api/parser/parse", {
      method: "POST",
      body: JSON.stringify({
        providerId,
        accountId: "mt5-63442826",
        rawText: input.rawText,
      }),
      headers: { "content-type": "application/json" },
    }),
  );
  const approval = await json<{ queueItemId: string; logicalTradeId: string }>(
    await app.request(`/api/signals/${parsed.parsedSignalId}/approve`, { method: "POST" }),
  );
  const shortId = approval.logicalTradeId.replace(/^trade[_-]/, "");
  await (await app.request("/api/mt5/poll-line?accountId=mt5-63442826")).text();
  await app.request("/api/mt5/report", {
    method: "POST",
    body: JSON.stringify({
      accountId: "mt5-63442826",
      queueItemId: approval.queueItemId,
      status: "EXECUTED",
      retcode: 10009,
      retcodeExternal: 0,
      brokerComment: `ttc:${shortId}`,
      orderTicket: input.ticket,
      positionTicket: input.ticket,
      dealTicket: `6${input.ticket}`,
      requestedPrice: input.filledPrice,
      filledPrice: input.filledPrice,
      volume: input.volume ?? 0.02,
      errorText: "",
    }),
    headers: { "content-type": "application/json" },
  });
  return { ...approval, shortId };
}

async function postVirtualTpSnapshot(
  app: ReturnType<typeof createApi>,
  approval: { shortId: string },
  input: { ticket: string; bid: number; ask: number; sl: number; volume?: number },
) {
  return app.request("/api/mt5/snapshot", {
    method: "POST",
    body: JSON.stringify({
      accountId: "mt5-63442826",
      positions: [
        {
          ticket: input.ticket,
          symbol: "EURUSD.raw",
          type: 0,
          volume: input.volume ?? 0.02,
          openPrice: 1.086,
          sl: input.sl,
          tp: 0,
          profit: 40,
          magic: 26050901,
          isExternal: false,
          comment: `ttc:${approval.shortId}`,
        },
      ],
      orders: [],
      symbols: [{ symbol: "EURUSD.raw", bid: input.bid, ask: input.ask, point: 0.00001 }],
    }),
    headers: { "content-type": "application/json" },
  });
}

async function configureVirtualTpProvider(
  app: ReturnType<typeof createApi>,
  config: Record<string, unknown>,
) {
  const providerId = await configureProviderWithAccount(app, {
    availableSymbols: ["EURUSD.raw"],
  });
  await app.request(`/api/providers/${providerId}`, {
    method: "PATCH",
    body: JSON.stringify({ riskMode: "fixed", riskAmount: 0.02, ...config }),
    headers: { "content-type": "application/json" },
  });
  return providerId;
}

async function reportExecutedQueue(
  app: ReturnType<typeof createApi>,
  input: { queueItemId: string; ticket: string; price: number; volume?: number },
) {
  await app.request("/api/mt5/report", {
    method: "POST",
    body: JSON.stringify({
      accountId: "mt5-63442826",
      queueItemId: input.queueItemId,
      status: "EXECUTED",
      retcode: 10009,
      retcodeExternal: 0,
      brokerComment: "Request executed",
      orderTicket: input.ticket,
      positionTicket: input.ticket,
      dealTicket: `deal-${input.queueItemId}`,
      requestedPrice: input.price,
      filledPrice: input.price,
      volume: input.volume ?? 0.02,
      errorText: "",
    }),
    headers: { "content-type": "application/json" },
  });
}

async function configureProviderWithAccount(
  app: ReturnType<typeof createApi>,
  input: {
    availableSymbols: string[];
    eaVersion?: string;
    eaCapabilities?: string[];
  },
) {
  const started = await json<{ profileId: string; sessionId: string }>(
    await app.request("/api/telegram/start", {
      method: "POST",
      body: JSON.stringify({ apiId: "12345", apiHash: "hash", phone: "+27821234567" }),
      headers: { "content-type": "application/json" },
    }),
  );
  await app.request("/api/telegram/verify-code", {
    method: "POST",
    body: JSON.stringify({ sessionId: started.sessionId, code: "11111" }),
    headers: { "content-type": "application/json" },
  });
  const selected = await json<{ provider: { id: string } }>(
    await app.request("/api/providers", {
      method: "POST",
      body: JSON.stringify({
        profileId: started.profileId,
        dialogId: "dialog-btc",
        title: "Test Forex Group",
      }),
      headers: { "content-type": "application/json" },
    }),
  );
  await app.request(`/api/providers/${selected.provider.id}`, {
    method: "PATCH",
    body: JSON.stringify({ enabled: true }),
    headers: { "content-type": "application/json" },
  });
  await app.request("/api/mt5/register", {
    method: "POST",
    body: JSON.stringify({
      accountNumber: "63442826",
      server: "OctaFX-Real",
      company: "OctaFX",
      currency: "USD",
      balance: 10000,
      equity: 10000,
      marginMode: "HEDGING",
      availableSymbols: input.availableSymbols,
      eaVersion: input.eaVersion ?? "1.57.2",
      eaCapabilities: input.eaCapabilities ?? ["lane2-close-contract", "pending-close-flatten-v1"],
    }),
    headers: { "content-type": "application/json" },
  });
  return selected.provider.id;
}

async function heartbeatConfiguredAccount(app: ReturnType<typeof createApi>) {
  return app.request("/api/mt5/heartbeat", {
    method: "POST",
    body: JSON.stringify({
      accountId: "mt5-63442826",
      balance: 10000,
      equity: 10000,
      availableSymbols: ["XAUUSD", "EURUSD"],
    }),
    headers: { "content-type": "application/json" },
  });
}

async function approveGoldBuyLimit(
  app: ReturnType<typeof createApi>,
  rawText = "Gold buy limit\n\n4541-40\n\nSL 4535\n\nTP 4546\nTP 4553\nTP 4561\nTP 4579",
  beforeApprove?: () => void,
) {
  const providerId = await configureProviderWithAccount(app, { availableSymbols: ["XAUUSD"] });
  await app.request(`/api/providers/${providerId}`, {
    method: "PATCH",
    body: JSON.stringify({
      riskMode: "fixed",
      riskAmount: 0.04,
      takeProfitLevels: [
        { leg: 1, percentage: 25, strategy: { kind: "set-sl-to-entry", offsetPips: 0 } },
        { leg: 2, percentage: 25, strategy: { kind: "set-sl-to-entry", offsetPips: 1 } },
        { leg: 3, percentage: 25, strategy: { kind: "no-change" } },
        { leg: 4, percentage: 25, strategy: { kind: "no-change" } },
      ],
    }),
    headers: { "content-type": "application/json" },
  });
  const parsed = await json<{ parsedSignalId: string }>(
    await app.request("/api/parser/parse", {
      method: "POST",
      body: JSON.stringify({
        providerId,
        accountId: "mt5-63442826",
        rawText,
      }),
      headers: { "content-type": "application/json" },
    }),
  );
  beforeApprove?.();
  const approval = await json<{ queueItemId: string; logicalTradeId: string }>(
    await app.request(`/api/signals/${parsed.parsedSignalId}/approve`, { method: "POST" }),
  );
  return {
    ...approval,
    providerId,
    shortId: approval.logicalTradeId?.replace(/^trade[_-]/, "") ?? "",
  };
}

async function createEaOfflineApproval(
  input: { rawText?: string; releaseHeldOnEaReconnect?: boolean } = {},
) {
  const tempDir = await mkdtemp(join(tmpdir(), "telegram-tc-ea-offline-"));
  const databasePath = join(tempDir, "app.db");
  const app = createApi({ databasePath, seedDemoData: false, telegramAdapter: "mock" });
  if (input.releaseHeldOnEaReconnect === false) {
    await app.request("/api/settings", {
      method: "PATCH",
      body: JSON.stringify({ releaseHeldOnEaReconnect: false }),
      headers: { "content-type": "application/json" },
    });
  }
  const approved = await approveGoldBuyLimit(app, input.rawText, () => {
    const db = new Database(databasePath);
    db.query("UPDATE mt5_accounts SET last_heartbeat_at = ? WHERE id = ?").run(
      new Date(Date.now() - 31_000).toISOString(),
      "mt5-63442826",
    );
    db.close();
  });
  return { app, approved, databasePath, tempDir };
}

async function approveGoldSellSmallRunnerLimit(
  app: ReturnType<typeof createApi>,
  options: { executionMode?: "VIRTUAL_TP" | "SPLIT_ORDER"; enableRunner?: boolean } = {},
) {
  const providerId = await configureProviderWithAccount(app, { availableSymbols: ["XAUUSD"] });
  await app.request(`/api/providers/${providerId}`, {
    method: "PATCH",
    body: JSON.stringify({
      riskMode: "fixed",
      riskAmount: 0.02,
      ...(options.enableRunner === false
        ? {}
        : { runner: { enabled: true, lotSize: 0.01, slBehavior: "break-even", trailPips: 10 } }),
      takeProfitLevels: [
        { leg: 1, percentage: 25, strategy: { kind: "set-sl-to-entry", offsetPips: 0 } },
        { leg: 2, percentage: 25, strategy: { kind: "no-change" } },
        { leg: 3, percentage: 25, strategy: { kind: "no-change" } },
        { leg: 4, percentage: 25, strategy: { kind: "no-change" } },
      ],
    }),
    headers: { "content-type": "application/json" },
  });
  const parsed = await json<{ parsedSignalId: string }>(
    await app.request("/api/parser/parse", {
      method: "POST",
      body: JSON.stringify({
        providerId,
        accountId: "mt5-63442826",
        rawText: "Gold sell limit\n\n4488-89\n\nSL 4494\n\nTP 4483\nTP 4476\nTP 4468\nTP 4454",
      }),
      headers: { "content-type": "application/json" },
    }),
  );
  const approval = await json<{ queueItemId: string; logicalTradeId: string }>(
    await app.request(`/api/signals/${parsed.parsedSignalId}/approve`, {
      method: "POST",
      body: options.executionMode
        ? JSON.stringify({ executionMode: options.executionMode })
        : undefined,
      headers: options.executionMode ? { "content-type": "application/json" } : undefined,
    }),
  );
  return {
    ...approval,
    providerId,
    shortId: approval.logicalTradeId.replace(/^trade[_-]/, ""),
  };
}

async function reportPendingAccepted(
  app: ReturnType<typeof createApi>,
  input: { queueItemId: string; orderTicket?: string },
) {
  await app.request("/api/mt5/report", {
    method: "POST",
    body: JSON.stringify({
      accountId: "mt5-63442826",
      queueItemId: input.queueItemId,
      status: "EXECUTED",
      retcode: 10009,
      retcodeExternal: 0,
      brokerComment: "Request executed",
      orderTicket: input.orderTicket ?? "247596888",
      positionTicket: "0",
      dealTicket: "0",
      requestedPrice: 4541,
      filledPrice: 0,
      volume: 0.04,
      errorText: "",
    }),
    headers: { "content-type": "application/json" },
  });
}

async function reportGoldFill(
  app: ReturnType<typeof createApi>,
  input: { logicalTradeId: string; shortId: string; orderTicket?: string; positionTicket?: string },
) {
  await app.request("/api/mt5/history", {
    method: "POST",
    body: JSON.stringify({
      accountId: "mt5-63442826",
      deals: [
        {
          dealTicket: "244236610",
          orderTicket: input.orderTicket ?? "247596888",
          positionTicket: input.positionTicket ?? "247596888",
          entry: "0",
          reason: 3,
          symbol: "XAUUSD",
          price: 4540.9,
          volume: 0.04,
          profit: 0,
          commission: 0,
          swap: 0,
          comment: `ttc:${input.shortId}`,
          time: "2026.05.18 18:01:12",
        },
      ],
    }),
    headers: { "content-type": "application/json" },
  });
}

async function sendGoldSnapshot(
  app: ReturnType<typeof createApi>,
  input: {
    shortId: string;
    bid: number;
    positions?: unknown[];
    orders?: unknown[];
    positionTicket?: string;
  },
) {
  await app.request("/api/mt5/snapshot", {
    method: "POST",
    body: JSON.stringify({
      accountId: "mt5-63442826",
      positions: input.positions ?? [
        {
          ticket: input.positionTicket ?? "247596888",
          symbol: "XAUUSD",
          type: 0,
          volume: 0.04,
          openPrice: 4540.9,
          sl: 4535,
          tp: 0,
          profit: 0,
          magic: 26050901,
          isExternal: false,
          comment: `ttc:${input.shortId}`,
        },
      ],
      orders: input.orders ?? [],
      symbols: [{ symbol: "XAUUSD", bid: input.bid, ask: input.bid + 0.3 }],
    }),
    headers: { "content-type": "application/json" },
  });
}

describe("Telegram TC API", () => {
  test("flags real remove vocabulary for the first-week drop audit", () => {
    const message = realFixtureMessages(["15496"])[0]!;
    expect(message.rawText).toContain("remove him");
    expect(hasExitVocabularyForDropAudit(message.rawText)).toBe(true);
  });

  test("preserves renamed dashboard nicknames and validates account nickname PATCH bodies", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: false });
    const registered = await json<{ accountId: string }>(
      await app.request("/api/mt5/register", {
        method: "POST",
        body: JSON.stringify({
          accountNumber: "300400500",
          server: "MetaQuotes-Demo",
          company: "MetaQuotes Ltd",
          currency: "USD",
          balance: 10000,
          equity: 10000,
          marginMode: "HEDGING",
          availableSymbols: ["XAUUSD"],
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    const path = `/api/mt5/accounts/${registered.accountId}`;
    const headers = { "content-type": "application/json" };

    expect((await app.request(path, { method: "PATCH", body: "{", headers })).status).toBe(400);
    expect(
      (await app.request(path, { method: "PATCH", body: JSON.stringify({}), headers })).status,
    ).toBe(400);
    expect(
      (
        await app.request(path, {
          method: "PATCH",
          body: JSON.stringify({ nickname: 123 }),
          headers,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await app.request(path, {
          method: "PATCH",
          body: JSON.stringify({ nickname: "x".repeat(81) }),
          headers,
        })
      ).status,
    ).toBe(400);

    const renamed = await app.request(path, {
      method: "PATCH",
      body: JSON.stringify({ nickname: "Primary" }),
      headers,
    });
    expect(renamed.status).toBe(200);
    const dashboard = await json<{
      mt5Accounts: Array<{ id: string; nickname: string | null }>;
    }>(await app.request("/api/dashboard"));
    expect(dashboard.mt5Accounts).toContainEqual(
      expect.objectContaining({ id: registered.accountId, nickname: "Primary" }),
    );

    const omitted = await app.request(path, {
      method: "PATCH",
      body: JSON.stringify({}),
      headers,
    });
    expect(omitted.status).toBe(400);
    const unchanged = await json<{ accounts: Array<{ nickname: string | null }> }>(
      await app.request("/api/mt5/accounts"),
    );
    expect(unchanged.accounts[0]?.nickname).toBe("Primary");

    const cleared = await app.request(path, {
      method: "PATCH",
      body: JSON.stringify({ nickname: null }),
      headers,
    });
    expect(cleared.status).toBe(200);
    const afterClear = await json<{ accounts: Array<{ nickname: string | null }> }>(
      await app.request("/api/mt5/accounts"),
    );
    expect(afterClear.accounts[0]?.nickname).toBeNull();
  });
  test("serves backend health from both API and root health routes", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: false });

    const apiHealth = await json<{
      status: string;
      database: string;
      telegramAdapter: string;
    }>(await app.request("/api/health"));
    const rootHealth = await json<{
      status: string;
      database: string;
      telegramAdapter: string;
    }>(await app.request("/health"));

    expect(apiHealth).toEqual({
      status: "ok",
      database: "connected",
      telegramAdapter: "mock",
    });
    expect(rootHealth).toEqual(apiHealth);
  });

  test("auto-ingests enabled provider messages, dedupes them, and queues clean trades", async () => {
    const telegram = createQueuedTelegramAdapter([
      {
        telegramMessageId: "btc-1",
        messageDate: "2026-05-16T18:51:10.000Z",
        rawText: "SELL BTCUSD @ 50000\nSL 50100\nTP 49800",
      },
    ]);
    const app = createApi({
      databasePath: ":memory:",
      seedDemoData: false,
      telegram,
      telegramPollingEnabled: false,
    });

    await configureProviderWithAccount(app, {
      availableSymbols: ["BTCUSD", "XAUUSD", "EURUSD"],
    });

    const firstRun = await app.runTelegramIngestionOnce();
    const secondRun = await app.runTelegramIngestionOnce();

    expect(firstRun.captured).toBe(1);
    expect(firstRun.parsed).toBe(1);
    expect(firstRun.queued).toBe(1);
    expect(secondRun.queued).toBe(0);

    const dashboard = await json<{
      signalQueue: Array<{ symbol: string; status: string }>;
      parserResults: Array<{ brokerSymbol: string; reviewRequired: boolean }>;
    }>(await app.request("/api/dashboard"));
    expect(dashboard.parserResults[0]).toMatchObject({
      brokerSymbol: "BTCUSD",
      reviewRequired: false,
    });
    expect(dashboard.signalQueue.filter((item) => item.status === "PENDING")).toHaveLength(1);
    expect(dashboard.signalQueue[0]?.symbol).toBe("BTCUSD");
  });

  test("audits a Telegram ingestion gap reported by the adapter", async () => {
    const telegram: TelegramAdapter = {
      ...createQueuedTelegramAdapter([]),
      async fetchRecentMessages() {
        return {
          messages: [
            {
              telegramMessageId: "gap-130",
              messageDate: "2026-07-01T00:02:10.000Z",
              rawText: "BUY XAUUSD",
            },
          ],
          gap: {
            fromIso: "2026-06-30T00:00:00.000Z",
            toIso: "2026-07-01T00:00:31.000Z",
            reason: "page-cap",
          },
        };
      },
    };
    const app = createApi({
      databasePath: ":memory:",
      seedDemoData: false,
      telegram,
      telegramPollingEnabled: false,
    });
    const providerId = await configureProviderWithAccount(app, { availableSymbols: ["XAUUSD"] });

    await app.runTelegramIngestionOnce();

    const audit = await json<{
      logs: Array<{
        eventType: string;
        level: string;
        message: string;
        data: Record<string, unknown>;
      }>;
    }>(await app.request("/api/audit-logs?event=telegram.ingest.gap"));
    expect(audit.logs).toHaveLength(1);
    expect(audit.logs[0]).toMatchObject({
      eventType: "telegram.ingest.gap",
      level: "error",
      message: "Telegram backlog drain was truncated",
      data: {
        providerId,
        fromIso: "2026-06-30T00:00:00.000Z",
        toIso: "2026-07-01T00:00:31.000Z",
        reason: "page-cap",
      },
    });
  });

  test("uses the freshest online linked account for provider parsing and mixed dashboard money", async () => {
    const telegram = createQueuedTelegramAdapter([
      {
        telegramMessageId: "gold-live-1",
        messageDate: "2026-05-26T05:30:00.000Z",
        rawText: "Gold sell limit\n\n4560-4561\n\nSl 4566\n\nTp 4555\nTp 4548\nTp 4540\nTp 4522",
      },
    ]);
    const app = createApi({
      databasePath: ":memory:",
      seedDemoData: false,
      telegram,
      telegramPollingEnabled: false,
    });

    await app.request("/api/mt5/register", {
      method: "POST",
      body: JSON.stringify({
        accountNumber: "54870107",
        server: "HFMarketsSA",
        company: "HF Markets SA (Pty) Ltd",
        currency: "ZAR",
        balance: 0,
        equity: 0,
        marginMode: "HEDGING",
        availableSymbols: ["EURUSD"],
      }),
      headers: { "content-type": "application/json" },
    });
    const providerId = await configureProviderWithAccount(app, { availableSymbols: ["XAUUSD"] });
    for (const accountId of ["mt5-54870107", "mt5-63442826"]) {
      await app.request(`/api/account-provider-links/${accountId}/${providerId}`, {
        method: "PUT",
        body: JSON.stringify({ enabled: true }),
        headers: { "content-type": "application/json" },
      });
    }

    const parsedRecent = await json<{
      parsed: Array<{
        reviewRequired: boolean;
        result: {
          accountId?: string;
          brokerSymbol?: string;
          mappingStatus: string;
          confidence: number;
        };
      }>;
    }>(
      await app.request(`/api/providers/${providerId}/parse-recent?limit=1`, {
        method: "POST",
      }),
    );
    const dashboard = await json<{
      accountPerformance: {
        accountId: string;
        currency: string;
        currentBalance: number | null;
        currentEquity: number | null;
      };
      mt5Accounts: Array<{
        id: string;
        currency?: string;
        balance?: number;
        equity?: number;
      }>;
    }>(await app.request("/api/dashboard"));

    expect(parsedRecent.parsed[0]).toMatchObject({
      reviewRequired: false,
      result: {
        accountId: "mt5-63442826",
        brokerSymbol: "XAUUSD",
        mappingStatus: "mapped",
      },
    });
    expect(parsedRecent.parsed[0]?.result.confidence).toBeGreaterThanOrEqual(0.95);
    expect(dashboard.accountPerformance).toMatchObject({
      accountId: "aggregate",
      currency: "USD",
      currentBalance: 10000,
      currentEquity: 10000,
    });
    expect(dashboard.mt5Accounts.find((account) => account.id === "mt5-63442826")).toMatchObject({
      currency: "USD",
      balance: 10000,
      equity: 10000,
    });
  });

  test("routes a mapped account while holding only the linked account with an unavailable symbol", async () => {
    const app = createApi({
      databasePath: ":memory:",
      seedDemoData: false,
      telegram: createQueuedTelegramAdapter([
        {
          telegramMessageId: "mapping-isolation-1",
          messageDate: "2026-07-20T10:00:00.000Z",
          rawText: "BUY XAUUSD @ 4510\nSL 4500\nTP 4520",
        },
      ]),
      telegramPollingEnabled: false,
    });
    const providerId = await configureProviderWithAccount(app, { availableSymbols: ["XAUUSD"] });
    await app.request(`/api/account-provider-links/mt5-63442826/${providerId}`, {
      method: "PUT",
      body: JSON.stringify({ enabled: true }),
      headers: { "content-type": "application/json" },
    });
    await app.request("/api/mt5/register", {
      method: "POST",
      body: JSON.stringify({
        accountNumber: "54870107",
        server: "HFMarketsSA",
        company: "HF Markets SA (Pty) Ltd",
        currency: "ZAR",
        balance: 20000,
        equity: 20000,
        marginMode: "HEDGING",
        availableSymbols: ["EURUSD"],
      }),
      headers: { "content-type": "application/json" },
    });
    await app.request(`/api/account-provider-links/mt5-54870107/${providerId}`, {
      method: "PUT",
      body: JSON.stringify({ enabled: true }),
      headers: { "content-type": "application/json" },
    });

    expect(await app.runTelegramIngestionOnce()).toMatchObject({ queued: 1 });
    const signals = await json<{
      queue: Array<{
        accountId: string;
        status: string;
        heldReason?: string;
        payload: { brokerSymbol?: string };
      }>;
    }>(await app.request("/api/signals"));
    expect(signals.queue).toContainEqual(
      expect.objectContaining({
        accountId: "mt5-63442826",
        status: "PENDING",
        payload: expect.objectContaining({ brokerSymbol: "XAUUSD" }),
      }),
    );
    expect(signals.queue).toContainEqual(
      expect.objectContaining({
        accountId: "mt5-54870107",
        status: "HELD",
        heldReason: "SYMBOL_MAPPING_UNAVAILABLE",
      }),
    );
  });

  test("approved logical trades keep their source Telegram message lineage", async () => {
    const telegram = createQueuedTelegramAdapter([
      {
        telegramMessageId: "lineage-1",
        messageDate: "2026-05-19T09:10:11.000Z",
        rawText: "BUY XAUUSD @ 4525\nSL 4515\nTP 4535\nTP 4545",
      },
    ]);
    const app = createApi({
      databasePath: ":memory:",
      seedDemoData: false,
      telegram,
      telegramPollingEnabled: false,
    });

    await configureProviderWithAccount(app, {
      availableSymbols: ["XAUUSD", "EURUSD"],
    });

    const ingest = await app.runTelegramIngestionOnce();
    expect(ingest.parsed).toBe(1);
    expect(ingest.queued).toBe(1);

    const dashboard = await json<{
      logicalTrades: Array<{
        id: string;
        source?: {
          parsedSignalId: string;
          rawMessageId: string;
          telegramMessageId: string;
          messageDate: string;
          rawText: string;
        };
      }>;
    }>(await app.request("/api/dashboard"));

    expect(dashboard.logicalTrades).toHaveLength(1);
    expect(dashboard.logicalTrades[0]!.source).toMatchObject({
      parsedSignalId: expect.any(String),
      rawMessageId: expect.any(String),
      telegramMessageId: "lineage-1",
      messageDate: "2026-05-19T09:10:11.000Z",
      rawText: "BUY XAUUSD @ 4525\nSL 4515\nTP 4535\nTP 4545",
    });
    expect(dashboard.logicalTrades[0]!.source!.parsedSignalId).not.toBe("");
    expect(dashboard.logicalTrades[0]!.source!.rawMessageId).not.toBe("");
  });

  test("auto-ingestion keeps review-required signals out of the MT5 queue", async () => {
    const telegram = createQueuedTelegramAdapter([
      {
        telegramMessageId: "unknown-1",
        messageDate: "2026-05-16T18:52:23.000Z",
        rawText: "SELL UNKNOWNPAIR",
      },
    ]);
    const app = createApi({
      databasePath: ":memory:",
      seedDemoData: false,
      telegram,
      telegramPollingEnabled: false,
    });

    await configureProviderWithAccount(app, {
      availableSymbols: ["BTCUSD", "XAUUSD", "EURUSD"],
    });

    const result = await app.runTelegramIngestionOnce();

    expect(result.parsed).toBe(1);
    expect(result.reviewRequired).toBe(1);
    expect(result.queued).toBe(0);

    const dashboard = await json<{
      signalQueue: Array<{ status: string }>;
      parserResults: Array<{ mappingStatus: string; reviewRequired: boolean }>;
    }>(await app.request("/api/dashboard"));
    expect(dashboard.signalQueue.filter((item) => item.status === "PENDING")).toHaveLength(0);
    expect(dashboard.parserResults[0]).toMatchObject({
      mappingStatus: "unmapped",
      reviewRequired: true,
    });
  });

  test("does not suggest unrelated quoted symbols, suppresses alerts, and still holds for review", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: false });
    const providerId = await configureProviderWithAccount(app, {
      availableSymbols: ["XAUUSD", "EURUSD.raw"],
    });
    await app.request("/api/mt5/snapshot", {
      method: "POST",
      body: JSON.stringify({
        accountId: "mt5-63442826",
        positions: [],
        orders: [],
        symbols: [{ symbol: "EURUSD.raw", bid: 1.1, ask: 1.1001, point: 0.00001, digits: 5 }],
      }),
      headers: { "content-type": "application/json" },
    });
    const parsed = await json<{ parsedSignalId: string }>(
      await app.request("/api/parser/parse", {
        method: "POST",
        body: JSON.stringify({
          providerId,
          accountId: "mt5-63442826",
          rawText: "SELL UNKNOWNPAIR\nSL 100\nTP 90",
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    const before = await json<{
      alerts: Array<{
        kind: string;
        accountId?: string;
        detail?: Record<string, unknown>;
      }>;
    }>(await app.request("/api/dashboard"));
    const unmapped = before.alerts.find((alert) => alert.kind === "unmapped-symbols");
    expect(unmapped).toMatchObject({
      accountId: "mt5-63442826",
      detail: {
        token: "UNKNOWNPAIR",
        providerId,
        accountId: "mt5-63442826",
        blockedSignalCount: 1,
        accountLabel: "63442826",
      },
    });
    expect(unmapped?.detail?.suggestedBrokerSymbol).toBeUndefined();

    const suppressed = await app.request(`/api/providers/${providerId}/not-an-instrument`, {
      method: "POST",
      body: JSON.stringify({ token: "UNKNOWNPAIR" }),
      headers: { "content-type": "application/json" },
    });
    expect(suppressed.status).toBe(200);
    const after = await json<{ alerts: Array<{ kind: string; detail?: Record<string, unknown> }> }>(
      await app.request("/api/dashboard"),
    );
    expect(after.alerts.some((alert) => alert.kind === "unmapped-symbols")).toBe(false);
    const audit = await json<{ logs: Array<{ eventType: string; data: Record<string, unknown> }> }>(
      await app.request("/api/audit-logs?event=provider-symbol.suppress"),
    );
    expect(audit.logs[0]).toMatchObject({
      eventType: "provider-symbol.suppress",
      data: { providerId, token: "UNKNOWNPAIR", actor: "operator" },
    });

    const approval = await app.request(`/api/signals/${parsed.parsedSignalId}/approve`, {
      method: "POST",
    });
    expect(approval.status).toBe(200);
    const approved = await json<{ status: string; queueItemId: string }>(approval);
    expect(approved.status).toBe("HELD");
    const held = await json<{ items: Array<{ id: string; heldReason: string }> }>(
      await app.request("/api/queue-items/held"),
    );
    expect(held.items).toContainEqual(
      expect.objectContaining({ id: approved.queueItemId, heldReason: "SYMBOL_MAPPING_UNMAPPED" }),
    );
  });

  test("rejects malformed suppression JSON and non-string tokens", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: false });
    const providerId = await configureProviderWithAccount(app, { availableSymbols: ["XAUUSD"] });
    const malformed = await app.request(`/api/providers/${providerId}/not-an-instrument`, {
      method: "POST",
      body: "{",
      headers: { "content-type": "application/json" },
    });
    expect(malformed.status).toBe(400);

    const nonString = await app.request(`/api/providers/${providerId}/not-an-instrument`, {
      method: "POST",
      body: JSON.stringify({ token: 1 }),
      headers: { "content-type": "application/json" },
    });
    expect(nonString.status).toBe(400);
  });

  test("counts only actionable open signals and current mapping holds", async () => {
    const directory = await mkdtemp(join(tmpdir(), "telegram-tc-alerts-"));
    const databasePath = join(directory, "alerts.db");
    const app = createApi({
      databasePath,
      seedDemoData: false,
      telegramAdapter: "mock",
      telegramPollingEnabled: false,
    });
    const providerId = await configureProviderWithAccount(app, { availableSymbols: ["XAUUSD"] });
    const parse = async (rawText: string) =>
      json<{ parsedSignalId: string }>(
        await app.request("/api/parser/parse", {
          method: "POST",
          body: JSON.stringify({ providerId, accountId: "mt5-63442826", rawText }),
          headers: { "content-type": "application/json" },
        }),
      );

    const historical = await parse("SELL HISTORICALPAIR\nSL 100\nTP 90");
    const ignored = await parse("SELL IGNOREDPAIR\nSL 100\nTP 90");
    await app.request(`/api/signals/${ignored.parsedSignalId}/ignore`, { method: "POST" });
    await parse("CLOSE HISTORICALPAIR");
    const held = await parse("SELL HELDPAIR\nSL 100\nTP 90");
    const approval = await app.request(`/api/signals/${held.parsedSignalId}/approve`, {
      method: "POST",
    });
    expect(approval.status).toBe(200);

    const db = new Database(databasePath);
    db.query("UPDATE parsed_signals SET status = ?, created_at = ? WHERE id = ?").run(
      "APPROVED",
      "2020-01-01T00:00:00.000Z",
      historical.parsedSignalId,
    );
    db.close();

    const dashboard = await json<{
      alerts: Array<{ kind: string; detail?: { token?: string; blockedSignalCount?: number } }>;
    }>(await app.request("/api/dashboard"));
    const alerts = dashboard.alerts.filter((alert) => alert.kind === "unmapped-symbols");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.detail).toMatchObject({ token: "HELDPAIR", blockedSignalCount: 1 });
    await rm(directory, { recursive: true, force: true });
  });

  test("attributes a held mapping block to its queue account after provider relinking", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: false });
    const providerId = await configureProviderWithAccount(app, { availableSymbols: ["XAUUSD"] });
    const parsed = await json<{ parsedSignalId: string }>(
      await app.request("/api/parser/parse", {
        method: "POST",
        body: JSON.stringify({
          providerId,
          accountId: "mt5-63442826",
          rawText: "SELL RELINKPAIR\nSL 100\nTP 90",
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    const approval = await app.request(`/api/signals/${parsed.parsedSignalId}/approve`, {
      method: "POST",
    });
    expect(approval.status).toBe(200);

    await app.request("/api/mt5/register", {
      method: "POST",
      body: JSON.stringify({
        accountNumber: "200300400",
        server: "MetaQuotes-Demo",
        company: "MetaQuotes Ltd",
        currency: "USD",
        balance: 10000,
        equity: 10000,
        marginMode: "HEDGING",
        availableSymbols: ["XAUUSD"],
      }),
      headers: { "content-type": "application/json" },
    });
    for (const accountId of ["mt5-63442826", "mt5-200300400"]) {
      await app.request(`/api/account-provider-links/${accountId}/${providerId}`, {
        method: "PUT",
        body: JSON.stringify({ enabled: true }),
        headers: { "content-type": "application/json" },
      });
    }

    const dashboard = await json<{
      alerts: Array<{ kind: string; accountId?: string; detail?: Record<string, unknown> }>;
    }>(await app.request("/api/dashboard"));
    const alerts = dashboard.alerts.filter((alert) => alert.kind === "unmapped-symbols");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      accountId: "mt5-63442826",
      detail: {
        accountId: "mt5-63442826",
        blockedSignalCount: 1,
      },
    });
    expect(alerts.some((alert) => alert.accountId === "mt5-200300400")).toBe(false);
  });

  test("preloads dashboard alert state for repeated unmapped signals", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: false });
    const providerId = await configureProviderWithAccount(app, { availableSymbols: ["XAUUSD"] });
    for (const token of ["FIRSTPAIR", "SECONDPAIR"]) {
      await app.request("/api/parser/parse", {
        method: "POST",
        body: JSON.stringify({
          providerId,
          accountId: "mt5-63442826",
          rawText: `SELL ${token}\nSL 100\nTP 90`,
        }),
        headers: { "content-type": "application/json" },
      });
    }

    const originalQuery = Database.prototype.query;
    let suppressionQueries = 0;
    let metadataQueries = 0;
    Database.prototype.query = function (this: Database, sql: string) {
      if (sql.includes("FROM suppressed_provider_symbols")) suppressionQueries += 1;
      if (sql.includes("FROM symbol_metadata WHERE account_id")) metadataQueries += 1;
      return originalQuery.call(this, sql);
    } as typeof originalQuery;
    try {
      const dashboard = await json<{ alerts: Array<{ kind: string }> }>(
        await app.request("/api/dashboard"),
      );
      expect(dashboard.alerts.filter((alert) => alert.kind === "unmapped-symbols")).toHaveLength(2);
    } finally {
      Database.prototype.query = originalQuery;
    }
    expect(suppressionQueries).toBe(1);
    expect(metadataQueries).toBe(1);
  });

  test("symbol metadata includes the latest quote used by the picker", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: false });
    await app.request("/api/mt5/register", {
      method: "POST",
      body: JSON.stringify({
        accountNumber: "63442826",
        server: "OctaFX-Real",
        company: "OctaFX",
        currency: "USD",
        balance: 10000,
        equity: 10000,
        marginMode: "HEDGING",
        availableSymbols: ["XAUUSD.raw", "XAUUSD.pro"],
      }),
      headers: { "content-type": "application/json" },
    });
    await app.request("/api/mt5/snapshot", {
      method: "POST",
      body: JSON.stringify({
        accountId: "mt5-63442826",
        positions: [],
        orders: [],
        symbols: [
          { symbol: "XAUUSD.raw", bid: 2450, ask: 2450.2, point: 0.01, digits: 2 },
          { symbol: "XAUUSD.pro", bid: 0, ask: 0, point: 0.01, digits: 2 },
        ],
      }),
      headers: { "content-type": "application/json" },
    });
    const metadata = await json<{
      symbols: Array<{ symbol: string; bid: number | null; ask: number | null }>;
    }>(await app.request("/api/accounts/mt5-63442826/symbol-metadata"));
    expect(metadata.symbols).toContainEqual(
      expect.objectContaining({ symbol: "XAUUSD.raw", bid: 2450, ask: 2450.2 }),
    );
  });

  test("repairs stale demo account mappings when the broker reports plain OctaFX symbols", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: false });

    await app.request("/api/mt5/register", {
      method: "POST",
      body: JSON.stringify({
        accountNumber: "63442826",
        server: "OctaFX-Real",
        company: "OctaFX",
        currency: "USD",
        balance: 10000,
        equity: 10000,
        marginMode: "HEDGING",
        availableSymbols: ["BTCUSD.raw", "XAUUSD.r", "EURUSD.raw"],
      }),
      headers: { "content-type": "application/json" },
    });
    await app.request("/api/symbol-mappings/account/mt5-63442826", {
      method: "PUT",
      body: JSON.stringify({
        accountId: "mt5-63442826",
        canonicalOverrides: { XAUUSD: "XAUUSD.r" },
        suffix: ".raw",
        includeSymbols: ["EURUSD.raw", "XAUUSD.r", "DJI30.raw"],
        excludeSymbols: [],
        availableBrokerSymbols: ["BTCUSD.raw", "XAUUSD.r", "EURUSD.raw"],
      }),
      headers: { "content-type": "application/json" },
    });

    await app.request("/api/mt5/heartbeat", {
      method: "POST",
      body: JSON.stringify({
        accountId: "mt5-63442826",
        balance: 10000,
        equity: 10000,
        availableSymbols: ["BTCUSD", "XAUUSD", "EURUSD"],
      }),
      headers: { "content-type": "application/json" },
    });

    const parsed = await json<{
      result: { brokerSymbol: string; mappingStatus: string; missingFields: string[] };
    }>(
      await app.request("/api/parser/parse", {
        method: "POST",
        body: JSON.stringify({
          providerId: "provider-alpha",
          accountId: "mt5-63442826",
          rawText: "SELL BTCUSD",
        }),
        headers: { "content-type": "application/json" },
      }),
    );

    expect(parsed.result).toMatchObject({
      brokerSymbol: "BTCUSD",
      mappingStatus: "mapped",
      missingFields: [],
    });
  });

  test("runs Telegram setup through code and 2FA without returning long-lived secrets", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: false });

    const start = await app.request("/api/telegram/start", {
      method: "POST",
      body: JSON.stringify({
        apiId: "12345",
        apiHash: "super-secret-hash",
        phone: "+27821234567",
      }),
      headers: { "content-type": "application/json" },
    });
    const started = await json<{
      profileId: string;
      sessionId: string;
      status: string;
      apiHash?: string;
    }>(start);

    expect(start.status).toBe(200);
    expect(started.status).toBe("CODE_REQUIRED");
    expect(started.apiHash).toBeUndefined();

    const code = await app.request("/api/telegram/verify-code", {
      method: "POST",
      body: JSON.stringify({ sessionId: started.sessionId, code: "22222" }),
      headers: { "content-type": "application/json" },
    });
    expect((await json<{ status: string }>(code)).status).toBe("PASSWORD_REQUIRED");

    const password = await app.request("/api/telegram/submit-password", {
      method: "POST",
      body: JSON.stringify({ sessionId: started.sessionId, password: "not-for-browser-storage" }),
      headers: { "content-type": "application/json" },
    });
    expect((await json<{ status: string }>(password)).status).toBe("CONNECTED");

    const dialogs = await app.request(`/api/telegram/dialogs?profileId=${started.profileId}`);
    expect((await json<{ dialogs: unknown[] }>(dialogs)).dialogs.length).toBeGreaterThan(0);
  });

  test("reports Telegram connection status without loading the full dashboard", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: false });

    const disconnected = await json<{
      connected: boolean;
      telegramSessions: Array<{ status: string }>;
    }>(await app.request("/api/telegram/status"));
    expect(disconnected.connected).toBe(false);
    expect(disconnected.telegramSessions).toEqual([]);

    const started = await json<{ profileId: string; sessionId: string }>(
      await app.request("/api/telegram/start", {
        method: "POST",
        body: JSON.stringify({ apiId: "12345", apiHash: "hash", phone: "+27821234567" }),
        headers: { "content-type": "application/json" },
      }),
    );
    await app.request("/api/telegram/verify-code", {
      method: "POST",
      body: JSON.stringify({ sessionId: started.sessionId, code: "11111" }),
      headers: { "content-type": "application/json" },
    });

    const connected = await json<{
      activeProfileId?: string;
      connected: boolean;
      telegramAdapter: string;
      telegramSessions: Array<{ id: string; phone: string; profileId: string; status: string }>;
    }>(await app.request("/api/telegram/status"));
    expect(connected).toMatchObject({
      activeProfileId: started.profileId,
      connected: true,
      telegramAdapter: "mock",
    });
    expect(connected.telegramSessions[0]).toMatchObject({
      id: started.sessionId,
      phone: "+27******567",
      profileId: started.profileId,
      status: "CONNECTED",
    });
  });

  test("selects providers, parses recent messages, approves one signal, and prevents duplicates", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: true });

    const providersResponse = await app.request("/api/providers");
    const providers = await json<{ providers: Array<{ id: string }> }>(providersResponse);
    expect(providers.providers.length).toBeGreaterThan(0);

    const providerId = providers.providers[0]!.id;
    const messages = await app.request(`/api/providers/${providerId}/messages?limit=3`);
    const recent = await json<{ messages: Array<{ rawText: string }> }>(messages);
    expect(recent.messages.length).toBeGreaterThan(0);

    const parse = await app.request("/api/parser/parse", {
      method: "POST",
      body: JSON.stringify({
        providerId,
        rawText: recent.messages[0]!.rawText.replace("@ 1.0850", "@ 1.0860"),
      }),
      headers: { "content-type": "application/json" },
    });
    const parsed = await json<{ parsedSignalId: string; result: { commandType: string } }>(parse);
    expect(parsed.result.commandType).toBe("OPEN_TRADE");

    const approve = await app.request(`/api/signals/${parsed.parsedSignalId}/approve`, {
      method: "POST",
    });
    const approved = await json<{ queueItemId: string; status: string }>(approve);
    expect(approved.status).toBe("PENDING");

    const duplicate = await app.request(`/api/signals/${parsed.parsedSignalId}/approve`, {
      method: "POST",
    });
    expect(duplicate.status).toBe(409);
  });

  test("uses Azure GPT extraction only for parser outputs needing normalization", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: true });
    const previousFetch = globalThis.fetch;
    const previousKey = process.env.AZURE_OPENAI_API_KEY;
    process.env.AZURE_OPENAI_API_KEY = "test-key";

    const providersResponse = await app.request("/api/providers");
    const providers = await json<{ providers: Array<{ id: string }> }>(providersResponse);
    const providerId = providers.providers[0]!.id;

    const needsExtraction = await json<{ parsedSignalId: string; reviewRequired: boolean }>(
      await app.request("/api/parser/parse", {
        method: "POST",
        body: JSON.stringify({ providerId, rawText: "Buy 45-44" }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(needsExtraction.reviewRequired).toBe(true);

    let azureCalled = false;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      azureCalled = true;
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe("gpt-5.4-mini");
      expect(body.messages[0].content).toContain("ENTRY, SL, and TP");
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                verdict: "EXECUTABLE_SIGNAL",
                shouldQueue: true,
                needsConfirmation: false,
                confidence: 0.91,
                reason: "Short KAL VIP gold buy with defaults applied.",
                symbol: "XAUUSD",
                direction: "BUY",
                entry: "45-44",
                stopLoss: "50 pips default",
                takeProfits: ["200 pips default"],
                lifecycleAction: "",
              }),
            },
          },
        ],
      });
    }) as typeof fetch;

    const review = await app.request(`/api/signals/${needsExtraction.parsedSignalId}/ai-review`, {
      method: "POST",
    });
    expect(review.status).toBe(200);
    const reviewed = await json<{
      review: { entry: string; stopLoss: string; takeProfits: string[]; shouldQueue: boolean };
    }>(review);
    expect(azureCalled).toBe(true);
    expect(reviewed.review.entry).toBe("45-44");
    expect(reviewed.review.stopLoss).toBe("50 pips default");
    expect(reviewed.review.takeProfits).toEqual(["200 pips default"]);
    expect(reviewed.review.shouldQueue).toBe(true);

    const safeParse = await json<{ parsedSignalId: string; reviewRequired: boolean }>(
      await app.request("/api/parser/parse", {
        method: "POST",
        body: JSON.stringify({
          providerId,
          rawText: "BUY EURUSD @ 1.0850\nSL 1.0810\nTP1 1.0900",
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(safeParse.reviewRequired).toBe(false);
    const rejected = await app.request(`/api/signals/${safeParse.parsedSignalId}/ai-review`, {
      method: "POST",
    });
    expect(rejected.status).toBe(409);

    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.AZURE_OPENAI_API_KEY;
    else process.env.AZURE_OPENAI_API_KEY = previousKey;
  });

  test("registers an MT5 account, leases queue work, accepts execution reports, and updates logs", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: true });

    const register = await app.request("/api/mt5/register", {
      method: "POST",
      body: JSON.stringify({
        accountNumber: "100200300",
        server: "MetaQuotes-Demo",
        company: "MetaQuotes Ltd",
        currency: "USD",
        balance: 10000,
        equity: 10000,
        marginMode: "HEDGING",
        availableSymbols: ["EURUSD.raw", "XAUUSD.r"],
      }),
      headers: { "content-type": "application/json" },
    });
    const account = await json<{ accountId: string }>(register);
    expect(register.status).toBe(200);

    const dashboard = await app.request("/api/dashboard");
    const initial = await json<{ signalQueue: Array<{ id: string; status: string }> }>(dashboard);
    expect(initial.signalQueue.some((item) => item.status === "PENDING")).toBe(true);

    const poll = await app.request(`/api/mt5/poll?accountId=${account.accountId}`);
    const lease = await json<{ item: { id: string; status: string } | null }>(poll);
    expect(lease.item?.status).toBe("LEASED");

    const report = await app.request("/api/mt5/report", {
      method: "POST",
      body: JSON.stringify({
        accountId: account.accountId,
        queueItemId: lease.item!.id,
        status: "EXECUTED",
        retcode: 10009,
        retcodeExternal: 0,
        brokerComment: "Request completed",
        orderTicket: "50001",
        positionTicket: "70001",
        dealTicket: "60001",
        requestedPrice: 1.085,
        filledPrice: 1.0851,
        volume: 0.1,
        errorText: "",
      }),
      headers: { "content-type": "application/json" },
    });
    expect(report.status).toBe(200);

    const logs = await app.request("/api/execution-logs");
    const executionLogs = await json<{ logs: Array<{ retcode: number; positionTicket: string }> }>(
      logs,
    );
    expect(executionLogs.logs[0]?.retcode).toBe(10009);
    expect(executionLogs.logs[0]?.positionTicket).toBe("70001");

    const brokerTrail = await json<{
      orders: Array<{
        action: string;
        orderTicket: string;
        positionTicket: string;
        dealTicket: string;
      }>;
    }>(await app.request("/api/trades/trade-demo-1/broker-orders"));
    expect(brokerTrail.orders[0]).toMatchObject({
      action: "OPEN",
      orderTicket: "50001",
      positionTicket: "70001",
      dealTicket: "60001",
    });

    const history = await app.request("/api/mt5/history", {
      method: "POST",
      body: JSON.stringify({
        accountId: account.accountId,
        deals: [
          {
            dealTicket: "60002",
            orderTicket: "50002",
            positionTicket: "70001",
            entry: "OUT",
            symbol: "EURUSD.raw",
            price: 1.0861,
            volume: 0.1,
            profit: 10.5,
            commission: -0.5,
            swap: 0,
            comment: "telegram-tc:trade-demo-1",
            time: "2026-05-10T12:00:00.000Z",
          },
        ],
      }),
      headers: { "content-type": "application/json" },
    });
    expect(history.status).toBe(200);
    expect((await json<{ recorded: number }>(history)).recorded).toBe(1);

    const brokerTrailAfterHistory = await json<{
      orders: Array<{ action: string; dealTicket: string; pnlCurrency?: number; pnlPips?: number }>;
    }>(await app.request("/api/trades/trade-demo-1/broker-orders"));
    expect(
      brokerTrailAfterHistory.orders.some(
        (order) => order.action === "FULL_CLOSE" && order.dealTicket === "60002",
      ),
    ).toBe(true);
    expect(
      brokerTrailAfterHistory.orders.find((order) => order.dealTicket === "60002")?.pnlCurrency,
    ).toBe(10);

    const accountLogs = await json<{
      accountId: string;
      account?: { id: string; heartbeatStatus: string };
      snapshot: { openPositionCount: number; pendingOrderCount: number };
      logs: Array<{ retcode: number; accountId: string }>;
    }>(await app.request(`/api/mt5/accounts/${account.accountId}/logs`));
    expect(accountLogs.accountId).toBe(account.accountId);
    expect(accountLogs.account?.id).toBe(account.accountId);
    expect(accountLogs.snapshot).toMatchObject({
      openPositionCount: 0,
      pendingOrderCount: 0,
    });
    expect(accountLogs.logs[0]).toMatchObject({
      accountId: account.accountId,
      retcode: 10009,
    });
  });

  test("limits execution log reads when callers request a recent slice", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "telegram-tc-logs-"));
    const databasePath = join(tempDir, "telegram-tc.db");
    const app = createApi({ databasePath, seedDemoData: false });
    const writer = new Database(databasePath);
    try {
      const insert = writer.query(
        "INSERT INTO execution_reports (id, queue_item_id, account_id, status, retcode, retcode_external, broker_comment, order_ticket, position_ticket, deal_ticket, requested_price, filled_price, volume, error_text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (let index = 0; index < 15; index += 1) {
        insert.run(
          `report-${index}`,
          `queue-${index}`,
          index % 2 === 0 ? "mt5-alpha" : "mt5-beta",
          "EXECUTED",
          index,
          0,
          `Report ${index}`,
          `${5000 + index}`,
          `${6000 + index}`,
          `${7000 + index}`,
          1,
          1,
          0.01,
          "",
          new Date(Date.UTC(2026, 4, 25, 12, 0, index)).toISOString(),
        );
      }

      const recent = await json<{ logs: Array<{ retcode: number }> }>(
        await app.request("/api/execution-logs?limit=3"),
      );
      expect(recent.logs.map((log) => log.retcode)).toEqual([14, 13, 12]);

      const accountRecent = await json<{ logs: Array<{ accountId: string; retcode: number }> }>(
        await app.request("/api/execution-logs?accountId=mt5-beta&limit=2"),
      );
      expect(accountRecent.logs).toEqual([
        expect.objectContaining({ accountId: "mt5-beta", retcode: 13 }),
        expect.objectContaining({ accountId: "mt5-beta", retcode: 11 }),
      ]);
    } finally {
      writer.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("links MT5 registration through account slots and blocks new opens when Equity Guardian is paused", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: true });

    const slotResponse = await app.request("/api/account-slots", {
      method: "POST",
      body: JSON.stringify({ name: "Main Demo" }),
      headers: { "content-type": "application/json" },
    });
    const slot = await json<{ slot: { id: string; linkCode: string; status: string } }>(
      slotResponse,
    );
    expect(slot.slot.status).toBe("waiting");

    const badRegister = await app.request("/api/mt5/register", {
      method: "POST",
      body: JSON.stringify({
        accountNumber: "777",
        server: "MetaQuotes-Demo",
        company: "MetaQuotes Ltd",
        currency: "USD",
        balance: 10000,
        equity: 10000,
        marginMode: "HEDGING",
        linkCode: "BADCODE",
      }),
      headers: { "content-type": "application/json" },
    });
    expect(badRegister.status).toBe(404);

    const register = await app.request("/api/mt5/register", {
      method: "POST",
      body: JSON.stringify({
        accountNumber: "777",
        server: "MetaQuotes-Demo",
        company: "MetaQuotes Ltd",
        currency: "USD",
        balance: 10000,
        equity: 10000,
        marginMode: "HEDGING",
        linkCode: slot.slot.linkCode,
      }),
      headers: { "content-type": "application/json" },
    });
    expect(register.status).toBe(200);
    const linkedSlots = await json<{
      slots: Array<{ id: string; accountNumber: string; status: string }>;
    }>(await app.request("/api/account-slots"));
    expect(linkedSlots.slots.find((item) => item.id === slot.slot.id)).toMatchObject({
      accountNumber: "777",
      status: "linked",
    });

    await app.request("/api/equity-guardian/mt5-100200300", {
      method: "PATCH",
      body: JSON.stringify({ threshold: 1, paused: true }),
      headers: { "content-type": "application/json" },
    });
    const pollLine = await (await app.request("/api/mt5/poll-line?accountId=mt5-100200300")).text();
    expect(pollLine).toContain("status=NO_WORK");
    const dashboard = await json<{ signalQueue: Array<{ status: string }> }>(
      await app.request("/api/dashboard"),
    );
    expect(dashboard.signalQueue.some((item) => item.status === "HELD")).toBe(true);
  });

  test("defaults a new Equity Guardian to off until an operator sets a threshold", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: false });
    await app.request("/api/mt5/register", {
      method: "POST",
      body: JSON.stringify({
        accountNumber: "900100200",
        server: "MetaQuotes-Demo",
        company: "MetaQuotes Ltd",
        currency: "USD",
        balance: 100,
        equity: 50,
        marginMode: "HEDGING",
      }),
      headers: { "content-type": "application/json" },
    });
    const before = await json<{
      guardians: Array<{ enabled: boolean; paused: boolean; threshold: number }>;
    }>(await app.request("/api/equity-guardian"));
    expect(before.guardians).toContainEqual(
      expect.objectContaining({ enabled: false, paused: false, threshold: 0 }),
    );
    const enabled = await json<{ guardian: { enabled: boolean; threshold: number } }>(
      await app.request("/api/equity-guardian/mt5-900100200", {
        method: "PATCH",
        body: JSON.stringify({ enabled: true, threshold: 10 }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(enabled.guardian).toMatchObject({ enabled: true, threshold: 10 });
  });

  test("releases guardian-held work at market on safe unpause when configured", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: false });
    const approved = await approveGoldBuyLimit(app);

    await app.request("/api/mt5/snapshot", {
      method: "POST",
      body: JSON.stringify({
        accountId: "mt5-63442826",
        positions: [],
        orders: [],
        symbols: [{ symbol: "XAUUSD", bid: 4540, ask: 4540.2 }],
      }),
      headers: { "content-type": "application/json" },
    });
    await app.request("/api/equity-guardian/mt5-63442826", {
      method: "PATCH",
      body: JSON.stringify({ paused: true }),
      headers: { "content-type": "application/json" },
    });
    await app.request("/api/mt5/poll-line?accountId=mt5-63442826");

    const held = await json<{
      items: Array<{
        id: string;
        heldReason: string;
        accountId: string;
        providerId?: string;
        commandType: string;
        symbol: string;
        originalEntry?: number;
        currentPrice?: number;
        driftPct?: number;
        droppedLifecycleCount: number;
        droppedLifecycle: string[];
      }>;
    }>(await app.request("/api/queue-items/held"));
    expect(held.items).toContainEqual(
      expect.objectContaining({
        id: approved.queueItemId,
        heldReason: "GUARDIAN",
        accountId: "mt5-63442826",
        providerId: expect.any(String),
        commandType: "OPEN_TRADE",
        symbol: "XAUUSD",
        originalEntry: 4541,
        currentPrice: 4540.1,
        driftPct: -0.02,
        droppedLifecycleCount: 0,
        droppedLifecycle: [],
      }),
    );

    const refused = await app.request(`/api/queue-items/${approved.queueItemId}/requeue`, {
      method: "POST",
      body: JSON.stringify({ mode: "market" }),
      headers: { "content-type": "application/json" },
    });
    expect(refused.status).toBe(409);

    await app.request("/api/settings", {
      method: "PATCH",
      body: JSON.stringify({ releaseHeldOnGuardianUnpause: true }),
      headers: { "content-type": "application/json" },
    });
    const unpaused = await json<{ guardian: { paused: boolean }; releasedQueueItemIds: string[] }>(
      await app.request("/api/equity-guardian/mt5-63442826/unpause", { method: "POST" }),
    );
    expect(unpaused.guardian.paused).toBe(false);
    expect(unpaused.releasedQueueItemIds).toHaveLength(1);

    const queue = await json<{
      queue: Array<{
        id: string;
        status: string;
        originQueueItemId?: string;
        payload: { orderType?: string; entry?: unknown };
      }>;
    }>(await app.request("/api/signals"));
    expect(queue.queue).toContainEqual(
      expect.objectContaining({
        id: approved.queueItemId,
        status: "DISMISSED",
      }),
    );
    expect(queue.queue).toContainEqual(
      expect.objectContaining({
        id: unpaused.releasedQueueItemIds[0],
        status: "PENDING",
        originQueueItemId: approved.queueItemId,
        payload: expect.objectContaining({ orderType: "MARKET" }),
      }),
    );
  });

  test("rejects PATCH unpause drawdown spoofing and allows safe guardian updates", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: false });
    const approved = await approveGoldBuyLimit(app);
    await app.request("/api/equity-guardian/mt5-63442826", {
      method: "PATCH",
      body: JSON.stringify({ threshold: 10, paused: true }),
      headers: { "content-type": "application/json" },
    });
    await app.request("/api/mt5/poll?accountId=mt5-63442826");
    await app.request("/api/settings", {
      method: "PATCH",
      body: JSON.stringify({ releaseHeldOnGuardianUnpause: true }),
      headers: { "content-type": "application/json" },
    });
    await app.request("/api/mt5/heartbeat", {
      method: "POST",
      body: JSON.stringify({ accountId: "mt5-63442826", balance: 10000, equity: 8000 }),
      headers: { "content-type": "application/json" },
    });

    const patchUnpause = await app.request("/api/equity-guardian/mt5-63442826", {
      method: "PATCH",
      body: JSON.stringify({ paused: false, currentDrawdown: 0 }),
      headers: { "content-type": "application/json" },
    });
    expect(patchUnpause.status).toBe(409);
    expect(
      await json<{ error: string; guardian: { paused: boolean; currentDrawdown: number } }>(
        patchUnpause,
      ),
    ).toMatchObject({
      error: expect.stringContaining("remains paused"),
      guardian: { paused: true, currentDrawdown: 20 },
    });
    const blockedQueue = await json<{ queue: Array<{ id: string; status: string }> }>(
      await app.request("/api/signals"),
    );
    expect(blockedQueue.queue.find((item) => item.id === approved.queueItemId)?.status).toBe(
      "HELD",
    );

    const thresholdPatch = await app.request("/api/equity-guardian/mt5-63442826", {
      method: "PATCH",
      body: JSON.stringify({ threshold: 12 }),
      headers: { "content-type": "application/json" },
    });
    expect(thresholdPatch.status).toBe(200);
    expect(
      await json<{ guardian: { paused: boolean; threshold: number } }>(thresholdPatch),
    ).toMatchObject({
      guardian: { paused: true, threshold: 12 },
    });

    await app.request("/api/mt5/heartbeat", {
      method: "POST",
      body: JSON.stringify({ accountId: "mt5-63442826", balance: 10000, equity: 10000 }),
      headers: { "content-type": "application/json" },
    });
    const unpause = await app.request("/api/equity-guardian/mt5-63442826/unpause", {
      method: "POST",
    });
    expect(unpause.status).toBe(200);
    expect(await json<{ guardian: { paused: boolean } }>(unpause)).toMatchObject({
      guardian: { paused: false },
    });
  });

  test("refuses guardian unpause when the latest equity heartbeat is stale", async () => {
    const originalDateNow = Date.now;
    const now = Date.UTC(2026, 6, 14, 10, 0, 0);
    Date.now = () => now;
    try {
      const app = createApi({ databasePath: ":memory:", seedDemoData: true });
      await app.request("/api/mt5/heartbeat", {
        method: "POST",
        body: JSON.stringify({ accountId: "mt5-100200300", balance: 10000, equity: 10000 }),
        headers: { "content-type": "application/json" },
      });
      Date.now = () => now + 31_000;
      const unpause = await app.request("/api/equity-guardian/mt5-100200300/unpause", {
        method: "POST",
      });
      expect(unpause.status).toBe(409);
      expect(await json<{ error: string; guardian: { paused: boolean } }>(unpause)).toMatchObject({
        error: expect.stringContaining("heartbeat is stale"),
        guardian: { paused: true },
      });
    } finally {
      Date.now = originalDateNow;
    }
  });

  test("releases guardian-held work only to its original account", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: false });
    const providerId = await configureProviderWithAccount(app, { availableSymbols: ["XAUUSD"] });
    await app.request("/api/mt5/register", {
      method: "POST",
      body: JSON.stringify({
        accountNumber: "100200300",
        server: "MetaQuotes-Demo",
        company: "MetaQuotes Ltd",
        currency: "USD",
        balance: 10000,
        equity: 10000,
        marginMode: "HEDGING",
        availableSymbols: ["XAUUSD"],
      }),
      headers: { "content-type": "application/json" },
    });
    for (const accountId of ["mt5-100200300", "mt5-63442826"]) {
      await app.request(`/api/account-provider-links/${accountId}/${providerId}`, {
        method: "PUT",
        body: JSON.stringify({ enabled: true }),
        headers: { "content-type": "application/json" },
      });
    }
    const parsed = await json<{ parsedSignalId: string }>(
      await app.request("/api/parser/parse", {
        method: "POST",
        body: JSON.stringify({
          providerId,
          accountId: "mt5-63442826",
          rawText: "BUY XAUUSD @ 4541\nSL 4535\nTP 4546",
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    await app.request(`/api/signals/${parsed.parsedSignalId}/approve`, { method: "POST" });
    const before = await json<{
      queue: Array<{ id: string; accountId: string; logicalTradeId: string; status: string }>;
    }>(await app.request("/api/signals"));
    const held = before.queue.find((item) => item.accountId === "mt5-63442826");
    expect(held).toBeDefined();
    await app.request("/api/equity-guardian/mt5-63442826", {
      method: "PATCH",
      body: JSON.stringify({ paused: true }),
      headers: { "content-type": "application/json" },
    });
    await app.request("/api/mt5/poll?accountId=mt5-63442826");
    await app.request("/api/settings", {
      method: "PATCH",
      body: JSON.stringify({ releaseHeldOnGuardianUnpause: true }),
      headers: { "content-type": "application/json" },
    });
    const unpaused = await json<{ releasedQueueItemIds: string[] }>(
      await app.request("/api/equity-guardian/mt5-63442826/unpause", { method: "POST" }),
    );
    const after = await json<{
      queue: Array<{
        id: string;
        accountId: string;
        logicalTradeId: string;
        originQueueItemId?: string;
        status: string;
      }>;
    }>(await app.request("/api/signals"));
    const released = after.queue.find((item) => item.id === unpaused.releasedQueueItemIds[0]);
    expect(released).toMatchObject({
      accountId: "mt5-63442826",
      logicalTradeId: held?.logicalTradeId,
      originQueueItemId: held?.id,
      status: "PENDING",
    });
    expect(
      after.queue.some(
        (item) => item.originQueueItemId === held?.id && item.accountId === "mt5-100200300",
      ),
    ).toBe(false);
  });

  test("does not auto-release stale guardian-held open trades", async () => {
    const originalDateNow = Date.now;
    const now = originalDateNow();
    try {
      const app = createApi({ databasePath: ":memory:", seedDemoData: false });
      const approved = await approveGoldBuyLimit(app);
      await app.request("/api/equity-guardian/mt5-63442826", {
        method: "PATCH",
        body: JSON.stringify({ paused: true }),
        headers: { "content-type": "application/json" },
      });
      await app.request("/api/mt5/poll?accountId=mt5-63442826");
      Date.now = () => now + 61_000;
      await app.request("/api/mt5/heartbeat", {
        method: "POST",
        body: JSON.stringify({ accountId: "mt5-63442826", balance: 10000, equity: 10000 }),
        headers: { "content-type": "application/json" },
      });
      await app.request("/api/settings", {
        method: "PATCH",
        body: JSON.stringify({ releaseHeldOnGuardianUnpause: true, maxOpenTradeAgeSeconds: 60 }),
        headers: { "content-type": "application/json" },
      });
      const unpaused = await json<{ releasedQueueItemIds: string[] }>(
        await app.request("/api/equity-guardian/mt5-63442826/unpause", { method: "POST" }),
      );
      expect(unpaused.releasedQueueItemIds).toEqual([]);
      const queue = await json<{ queue: Array<{ id: string; status: string }> }>(
        await app.request("/api/signals"),
      );
      expect(queue.queue.find((item) => item.id === approved.queueItemId)?.status).toBe("HELD");
    } finally {
      Date.now = originalDateNow;
    }
  });

  test("allows the same manual force-push after its 10-second dedup window", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "telegram-tc-manual-dedup-"));
    const databasePath = join(tempDir, "app.db");
    try {
      const app = createApi({
        databasePath,
        seedDemoData: false,
        telegramAdapter: "mock",
        telegramPollingEnabled: false,
      });
      await app.request("/api/mt5/register", {
        method: "POST",
        body: JSON.stringify({
          accountNumber: "63442826",
          server: "OctaFX-Real",
          company: "OctaFX",
          currency: "USD",
          balance: 10000,
          equity: 10000,
          marginMode: "HEDGING",
        }),
        headers: { "content-type": "application/json" },
      });
      const body = {
        accountId: "mt5-63442826",
        direction: "BUY",
        orderType: "MARKET",
        brokerSymbol: "GOLD",
        stopLoss: 4100,
        takeProfits: [{ price: 4200 }],
        volume: 0.01,
      };
      const push = () =>
        app.request("/api/signals/manual", {
          method: "POST",
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
        });
      expect((await push()).status).toBe(200);
      const db = new Database(databasePath);
      db.query("UPDATE parsed_signals SET created_at = ?").run(
        new Date(Date.now() - 30_000).toISOString(),
      );
      db.close();
      expect((await push()).status).toBe(200);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("holds approval with no linked account as NO_ACCOUNT", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: false });
    const providerId = await configureProviderWithAccount(app, { availableSymbols: ["XAUUSD"] });
    await app.request(`/api/account-provider-links/mt5-63442826/${providerId}`, {
      method: "PUT",
      body: JSON.stringify({ enabled: false }),
      headers: { "content-type": "application/json" },
    });

    const parsed = await json<{ parsedSignalId: string }>(
      await app.request("/api/parser/parse", {
        method: "POST",
        body: JSON.stringify({
          providerId,
          accountId: "mt5-63442826",
          rawText: "Gold buy limit\n\n4541-40\n\nSL 4535\n\nTP 4546",
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    const approval = await json<{ queueItemId: string; status: string }>(
      await app.request(`/api/signals/${parsed.parsedSignalId}/approve`, { method: "POST" }),
    );
    expect(approval.status).toBe("HELD");

    const held = await json<{ items: Array<{ id: string; heldReason: string }> }>(
      await app.request("/api/queue-items/held"),
    );
    expect(held.items).toContainEqual(
      expect.objectContaining({ id: approval.queueItemId, heldReason: "NO_ACCOUNT" }),
    );
  });

  test("moves a stale leased OPEN_TRADE to HELD/DELIVERY_UNKNOWN without auto-requeue", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "telegram-tc-"));
    const databasePath = join(tempDir, "app.db");
    try {
      const app = createApi({
        databasePath,
        seedDemoData: false,
        telegramAdapter: "mock",
        telegramPollingEnabled: false,
      });
      const approved = await approveGoldBuyLimit(app);
      await app.request(`/api/mt5/poll?accountId=mt5-63442826`);

      const db = new Database(databasePath);
      db.query("UPDATE queue_items SET leased_at = ? WHERE id = ?").run(
        new Date(0).toISOString(),
        approved.queueItemId,
      );
      db.close();

      const poll = await json<{ item: unknown }>(
        await app.request("/api/mt5/poll?accountId=mt5-63442826"),
      );
      expect(poll.item).toBeNull();
      const held = await json<{ items: Array<{ id: string; heldReason: string }> }>(
        await app.request("/api/queue-items/held"),
      );
      expect(held.items).toContainEqual(
        expect.objectContaining({
          id: approved.queueItemId,
          heldReason: "DELIVERY_UNKNOWN",
        }),
      );
      const queue = await json<{
        queue: Array<{ id: string; status: string }>;
      }>(await app.request("/api/signals"));
      expect(queue.queue).toContainEqual(
        expect.objectContaining({ id: approved.queueItemId, status: "HELD" }),
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("deletes waiting and expired slots but guards linked slots", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "telegram-tc-"));
    const databasePath = join(tempDir, "app.db");
    try {
      const app = createApi({ databasePath, seedDemoData: false, telegramAdapter: "mock" });
      const waiting = await json<{ slot: { id: string } }>(
        await app.request("/api/account-slots", {
          method: "POST",
          body: JSON.stringify({ name: "Waiting" }),
          headers: { "content-type": "application/json" },
        }),
      );
      const waitingDelete = await app.request(`/api/account-slots/${waiting.slot.id}`, {
        method: "DELETE",
      });
      expect(waitingDelete.status).toBe(200);

      const linked = await json<{ slot: { id: string; linkCode: string } }>(
        await app.request("/api/account-slots", {
          method: "POST",
          body: JSON.stringify({ name: "Linked" }),
          headers: { "content-type": "application/json" },
        }),
      );
      await app.request("/api/mt5/register", {
        method: "POST",
        body: JSON.stringify({
          accountNumber: "777",
          server: "MetaQuotes-Demo",
          company: "MetaQuotes Ltd",
          currency: "USD",
          balance: 10000,
          equity: 10000,
          marginMode: "HEDGING",
          linkCode: linked.slot.linkCode,
        }),
        headers: { "content-type": "application/json" },
      });
      const linkedDelete = await app.request(`/api/account-slots/${linked.slot.id}`, {
        method: "DELETE",
      });
      expect(linkedDelete.status).toBe(409);

      const expired = await json<{ slot: { id: string; linkCode: string } }>(
        await app.request("/api/account-slots", {
          method: "POST",
          body: JSON.stringify({ name: "Expired" }),
          headers: { "content-type": "application/json" },
        }),
      );
      const db = new Database(databasePath);
      db.query("UPDATE account_slots SET created_at = ? WHERE id = ?").run(
        new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
        expired.slot.id,
      );
      db.close();

      const slots = await json<{ slots: Array<{ id: string; status: string }> }>(
        await app.request("/api/account-slots"),
      );
      expect(slots.slots).toContainEqual(
        expect.objectContaining({ id: expired.slot.id, status: "expired" }),
      );
      const expiredRegister = await app.request("/api/mt5/register", {
        method: "POST",
        body: JSON.stringify({
          accountNumber: "778",
          server: "MetaQuotes-Demo",
          company: "MetaQuotes Ltd",
          currency: "USD",
          balance: 10000,
          equity: 10000,
          marginMode: "HEDGING",
          linkCode: expired.slot.linkCode,
        }),
        headers: { "content-type": "application/json" },
      });
      expect(expiredRegister.status).toBe(409);
      const expiredDelete = await app.request(`/api/account-slots/${expired.slot.id}`, {
        method: "DELETE",
      });
      expect(expiredDelete.status).toBe(200);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("defaults held-release settings and allows updating them", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: false });
    const initial = await json<{
      settings: { releaseHeldOnGuardianUnpause: boolean; releaseHeldOnEaReconnect: boolean };
    }>(await app.request("/api/settings"));
    expect(initial.settings.releaseHeldOnGuardianUnpause).toBe(false);
    expect(initial.settings.releaseHeldOnEaReconnect).toBe(true);
    const updated = await json<{
      settings: { releaseHeldOnGuardianUnpause: boolean; releaseHeldOnEaReconnect: boolean };
    }>(
      await app.request("/api/settings", {
        method: "PATCH",
        body: JSON.stringify({
          releaseHeldOnGuardianUnpause: true,
          releaseHeldOnEaReconnect: false,
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(updated.settings.releaseHeldOnGuardianUnpause).toBe(true);
    expect(updated.settings.releaseHeldOnEaReconnect).toBe(false);
  });

  test("accepts MT5 JSON requests with trailing null bytes and rejects malformed MT5 JSON cleanly", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: false });
    const registerPayload = {
      accountNumber: "777",
      server: "MetaQuotes-Demo",
      company: "MetaQuotes Ltd",
      currency: "USD",
      balance: 10000,
      equity: 10000,
      marginMode: "HEDGING",
      availableSymbols: ["EURUSD"],
    };

    const register = await app.request("/api/mt5/register", {
      method: "POST",
      body: `${JSON.stringify(registerPayload)}\0\0`,
      headers: { "content-type": "application/json" },
    });
    expect(register.status).toBe(200);
    expect((await json<{ accountId: string }>(register)).accountId).toBe("mt5-777");

    const malformed = await app.request("/api/mt5/heartbeat", {
      method: "POST",
      body: '{"accountId":"mt5-777"',
      headers: { "content-type": "application/json" },
    });
    expect(malformed.status).toBe(400);
    expect((await json<{ error: string }>(malformed)).error).toBe("Malformed MT5 JSON payload");
  });

  test("fans out approved provider signals to every linked MT5 account", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: false });
    const selected = await json<{ provider: { id: string } }>(
      await app.request("/api/providers", {
        method: "POST",
        body: JSON.stringify({
          profileId: "profile-real",
          dialogId: "dialog-gold",
          title: "Gold Room London",
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    for (const accountNumber of ["100200300", "200300400"]) {
      await app.request("/api/mt5/register", {
        method: "POST",
        body: JSON.stringify({
          accountNumber,
          server: "MetaQuotes-Demo",
          company: "MetaQuotes Ltd",
          currency: "USD",
          balance: 10000,
          equity: 10000,
          marginMode: "HEDGING",
          availableSymbols: ["EURUSD.raw", "XAUUSD.r"],
        }),
        headers: { "content-type": "application/json" },
      });
      await app.request(
        `/api/account-provider-links/mt5-${accountNumber}/${selected.provider.id}`,
        {
          method: "PUT",
          body: JSON.stringify({ enabled: true }),
          headers: { "content-type": "application/json" },
        },
      );
    }

    const parsed = await json<{ parsedSignalId: string }>(
      await app.request("/api/parser/parse", {
        method: "POST",
        body: JSON.stringify({
          providerId: selected.provider.id,
          rawText: "BUY EURUSD @ 1.0850\nSL 1.0810\nTP1 1.0900",
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    const approval = await json<{ queueItems: string[]; logicalTradeIds: string[] }>(
      await app.request(`/api/signals/${parsed.parsedSignalId}/approve`, { method: "POST" }),
    );
    expect(approval.queueItems).toHaveLength(2);
    expect(approval.logicalTradeIds).toHaveLength(2);

    const firstPoll = await (
      await app.request("/api/mt5/poll-line?accountId=mt5-100200300")
    ).text();
    const secondPoll = await (
      await app.request("/api/mt5/poll-line?accountId=mt5-200300400")
    ).text();
    expect(firstPoll).toContain("status=WORK");
    expect(secondPoll).toContain("status=WORK");
  });

  test("sizes each linked account with its own per-account provider config (and inherits the default)", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: false });
    const selected = await json<{ provider: { id: string } }>(
      await app.request("/api/providers", {
        method: "POST",
        body: JSON.stringify({
          profileId: "profile-real",
          dialogId: "dialog-gold",
          title: "Gold Room London",
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    const providerId = selected.provider.id;
    for (const accountNumber of ["100200300", "200300400"]) {
      await app.request("/api/mt5/register", {
        method: "POST",
        body: JSON.stringify({
          accountNumber,
          server: "MetaQuotes-Demo",
          company: "MetaQuotes Ltd",
          currency: "USD",
          balance: 10000,
          equity: 10000,
          marginMode: "HEDGING",
          availableSymbols: ["EURUSD.raw"],
        }),
        headers: { "content-type": "application/json" },
      });
      await app.request(`/api/account-provider-links/mt5-${accountNumber}/${providerId}`, {
        method: "PUT",
        body: JSON.stringify({ enabled: true }),
        headers: { "content-type": "application/json" },
      });
    }

    // Override only the first account; the second inherits the provider default (0.1 lots).
    await app.request(`/api/account-provider-links/mt5-100200300/${providerId}`, {
      method: "PUT",
      body: JSON.stringify({ config: { riskMode: "fixed", riskAmount: 0.5 } }),
      headers: { "content-type": "application/json" },
    });

    const overrideConfig = await json<{ config: { riskMode: string; riskAmount: number } }>(
      await app.request(`/api/providers/${providerId}/config?accountId=mt5-100200300`),
    );
    expect(overrideConfig.config).toMatchObject({ riskMode: "fixed", riskAmount: 0.5 });

    const inheritedConfig = await json<{ config: { riskAmount: number } }>(
      await app.request(`/api/providers/${providerId}/config?accountId=mt5-200300400`),
    );
    expect(inheritedConfig.config.riskAmount).toBe(0.1);

    const parsed = await json<{ parsedSignalId: string }>(
      await app.request("/api/parser/parse", {
        method: "POST",
        body: JSON.stringify({
          providerId,
          rawText: "BUY EURUSD @ 1.0850\nSL 1.0810\nTP1 1.0900",
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    await app.request(`/api/signals/${parsed.parsedSignalId}/approve`, { method: "POST" });

    const overridePoll = await (
      await app.request("/api/mt5/poll-line?accountId=mt5-100200300")
    ).text();
    const inheritedPoll = await (
      await app.request("/api/mt5/poll-line?accountId=mt5-200300400")
    ).text();
    expect(overridePoll).toContain("volume=0.5");
    expect(inheritedPoll).toContain("volume=0.1");
  });

  test("a config-only link update does not change the copy flag", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: false });
    const selected = await json<{ provider: { id: string } }>(
      await app.request("/api/providers", {
        method: "POST",
        body: JSON.stringify({
          profileId: "profile-real",
          dialogId: "dialog-gold",
          title: "Gold Room London",
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    const providerId = selected.provider.id;
    await app.request("/api/mt5/register", {
      method: "POST",
      body: JSON.stringify({
        accountNumber: "100200300",
        server: "MetaQuotes-Demo",
        company: "MetaQuotes Ltd",
        currency: "USD",
        balance: 10000,
        equity: 10000,
        marginMode: "HEDGING",
        availableSymbols: ["EURUSD.raw"],
      }),
      headers: { "content-type": "application/json" },
    });

    // Saving config for an account that is not copying must not enable copying.
    await app.request(`/api/account-provider-links/mt5-100200300/${providerId}`, {
      method: "PUT",
      body: JSON.stringify({ config: { riskMode: "fixed", riskAmount: 0.3 } }),
      headers: { "content-type": "application/json" },
    });
    const links = await json<{ links: Array<{ accountId: string; enabled: boolean }> }>(
      await app.request("/api/account-provider-links"),
    );
    const link = links.links.find((l) => l.accountId === "mt5-100200300");
    expect(link?.enabled).toBe(false);
  });

  test("does not fall back to the default account after the last provider copy link is disabled", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: false });
    const selected = await json<{ provider: { id: string } }>(
      await app.request("/api/providers", {
        method: "POST",
        body: JSON.stringify({
          profileId: "profile-real",
          dialogId: "dialog-gold",
          title: "Gold Room London",
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    const providerId = selected.provider.id;
    await app.request("/api/mt5/register", {
      method: "POST",
      body: JSON.stringify({
        accountNumber: "100200300",
        server: "MetaQuotes-Demo",
        company: "MetaQuotes Ltd",
        currency: "USD",
        balance: 10000,
        equity: 10000,
        marginMode: "HEDGING",
        availableSymbols: ["EURUSD.raw"],
      }),
      headers: { "content-type": "application/json" },
    });
    await app.request(`/api/account-provider-links/mt5-100200300/${providerId}`, {
      method: "PUT",
      body: JSON.stringify({ enabled: true }),
      headers: { "content-type": "application/json" },
    });
    await app.request(`/api/account-provider-links/mt5-100200300/${providerId}`, {
      method: "PUT",
      body: JSON.stringify({ enabled: false }),
      headers: { "content-type": "application/json" },
    });

    const parsed = await json<{ parsedSignalId: string }>(
      await app.request("/api/parser/parse", {
        method: "POST",
        body: JSON.stringify({
          providerId,
          accountId: "mt5-100200300",
          rawText: "BUY EURUSD @ 1.0850\nSL 1.0810\nTP1 1.0900",
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    const approval = await app.request(`/api/signals/${parsed.parsedSignalId}/approve`, {
      method: "POST",
    });
    expect(approval.status).toBe(200);
    expect((await json<{ status: string }>(approval)).status).toBe("HELD");
    expect(
      await (await app.request("/api/mt5/poll-line?accountId=mt5-100200300")).text(),
    ).toContain("status=NO_WORK");
  });

  test("uses the target account override when checking split-order runner compatibility", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: false });
    const providerId = await configureProviderWithAccount(app, {
      availableSymbols: ["EURUSD.raw"],
    });
    await app.request(`/api/providers/${providerId}`, {
      method: "PATCH",
      body: JSON.stringify({
        riskMode: "fixed",
        riskAmount: 0.1,
        runner: { enabled: true, lotSize: 0.02, slBehavior: "trail", trailPips: 25 },
      }),
      headers: { "content-type": "application/json" },
    });
    await app.request(`/api/account-provider-links/mt5-63442826/${providerId}`, {
      method: "PUT",
      body: JSON.stringify({
        enabled: true,
        config: {
          riskMode: "fixed",
          riskAmount: 0.1,
          runner: { enabled: false, lotSize: 0.02, slBehavior: "trail", trailPips: 25 },
        },
      }),
      headers: { "content-type": "application/json" },
    });

    const parsed = await json<{ parsedSignalId: string }>(
      await app.request("/api/parser/parse", {
        method: "POST",
        body: JSON.stringify({
          providerId,
          accountId: "mt5-63442826",
          rawText: "BUY EURUSD @ 1.0850\nSL 1.0810\nTP1 1.0900\nTP2 1.0950",
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    const approval = await app.request(`/api/signals/${parsed.parsedSignalId}/approve`, {
      method: "POST",
      body: JSON.stringify({ executionMode: "SPLIT_ORDER" }),
      headers: { "content-type": "application/json" },
    });
    expect(approval.status).toBe(200);
    expect(await (await app.request("/api/mt5/poll-line?accountId=mt5-63442826")).text()).toContain(
      "executionMode=SPLIT_ORDER",
    );
  });

  test("fans out lifecycle commands across linked MT5 accounts", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: false });
    const selected = await json<{ provider: { id: string } }>(
      await app.request("/api/providers", {
        method: "POST",
        body: JSON.stringify({
          profileId: "profile-real",
          dialogId: "dialog-gold",
          title: "Gold Room London",
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    for (const accountNumber of ["100200300", "200300400"]) {
      await app.request("/api/mt5/register", {
        method: "POST",
        body: JSON.stringify({
          accountNumber,
          server: "MetaQuotes-Demo",
          company: "MetaQuotes Ltd",
          currency: "USD",
          balance: 10000,
          equity: 10000,
          marginMode: "HEDGING",
          availableSymbols: ["EURUSD.raw"],
        }),
        headers: { "content-type": "application/json" },
      });
      await app.request(
        `/api/account-provider-links/mt5-${accountNumber}/${selected.provider.id}`,
        {
          method: "PUT",
          body: JSON.stringify({ enabled: true }),
          headers: { "content-type": "application/json" },
        },
      );
    }

    const openParsed = await json<{ parsedSignalId: string }>(
      await app.request("/api/parser/parse", {
        method: "POST",
        body: JSON.stringify({
          providerId: selected.provider.id,
          rawText: "BUY EURUSD @ 1.0850\nSL 1.0810\nTP1 1.0900",
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    const openApproval = await json<{ queueItems: string[]; logicalTradeIds: string[] }>(
      await app.request(`/api/signals/${openParsed.parsedSignalId}/approve`, { method: "POST" }),
    );
    expect(openApproval.queueItems).toHaveLength(2);
    expect(openApproval.logicalTradeIds).toHaveLength(2);

    await app.request("/api/mt5/poll-line?accountId=mt5-100200300");
    await app.request("/api/mt5/poll-line?accountId=mt5-200300400");

    const trailParsed = await json<{ parsedSignalId: string }>(
      await app.request("/api/parser/parse", {
        method: "POST",
        body: JSON.stringify({
          providerId: selected.provider.id,
          rawText: "Trail stop EURUSD by 25 pips",
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    const trailApprovalResponse = await app.request(
      `/api/signals/${trailParsed.parsedSignalId}/approve`,
      { method: "POST" },
    );
    expect(trailApprovalResponse.status).toBe(200);
    const trailApproval = await json<{ queueItems: string[]; logicalTradeIds: string[] }>(
      trailApprovalResponse,
    );
    expect(trailApproval.queueItems).toHaveLength(2);
    expect(trailApproval.logicalTradeIds).toEqual(openApproval.logicalTradeIds);

    const firstPoll = await (
      await app.request("/api/mt5/poll-line?accountId=mt5-100200300")
    ).text();
    const secondPoll = await (
      await app.request("/api/mt5/poll-line?accountId=mt5-200300400")
    ).text();
    expect(firstPoll).toContain("commandType=TRAILING_STOP");
    expect(secondPoll).toContain("commandType=TRAILING_STOP");
    expect(firstPoll).toContain("trailingStopValue=25");
    expect(secondPoll).toContain("trailingStopValue=25");
  });

  test("leaves ambiguous same-account lifecycle commands for operator review", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: false });
    const providerId = await configureProviderWithAccount(app, {
      availableSymbols: ["EURUSD.raw"],
    });

    for (const rawText of [
      "BUY EURUSD @ 1.0850\nSL 1.0810\nTP1 1.0900",
      "BUY EURUSD @ 1.0860\nSL 1.0820\nTP1 1.0910",
    ]) {
      const parsed = await json<{ parsedSignalId: string }>(
        await app.request("/api/parser/parse", {
          method: "POST",
          body: JSON.stringify({ providerId, accountId: "mt5-63442826", rawText }),
          headers: { "content-type": "application/json" },
        }),
      );
      const approval = await app.request(`/api/signals/${parsed.parsedSignalId}/approve`, {
        method: "POST",
      });
      expect(approval.status).toBe(200);
    }

    const lifecycle = await json<{ parsedSignalId: string }>(
      await app.request("/api/parser/parse", {
        method: "POST",
        body: JSON.stringify({
          providerId,
          accountId: "mt5-63442826",
          rawText: "Trail stop EURUSD by 20 pips",
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    const approval = await app.request(`/api/signals/${lifecycle.parsedSignalId}/approve`, {
      method: "POST",
    });
    expect(approval.status).toBe(200);
    const held = await json<{ status: string; queueItemId: string }>(approval);
    expect(held.status).toBe("HELD");
    const queue = await json<{ queue: Array<{ id: string; status: string; heldReason: string }> }>(
      await app.request("/api/signals"),
    );
    expect(queue.queue).toContainEqual(
      expect.objectContaining({
        id: held.queueItemId,
        status: "HELD",
        heldReason: expect.stringContaining("LIFECYCLE_RECONCILIATION:"),
      }),
    );
  });

  test("replays VIP Gold order, activation reply, and close without a phantom trade", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "telegram-tc-vipgold-lifecycle-"));
    const databasePath = join(tempDir, "app.db");
    const order =
      "NEW ORDER - XAUUSD Buy Stop 🚀\n# 300424022\n\n----------{ NEW }----------\nEntry: 4023.80 [Lots: 0.01]\nSL:    4017.80\nTP:    4035.80\n---------------------------";
    try {
      const app = createApi({
        databasePath,
        seedDemoData: false,
        telegram: createQueuedTelegramAdapter([
          { telegramMessageId: "484", messageDate: "2026-07-19T22:15:00.000Z", rawText: order },
          {
            telegramMessageId: "485",
            replyToMessageId: "484",
            messageDate: "2026-07-20T02:48:49.000Z",
            quotedText: order,
            rawText: "🚀 Buy Stop activated 🚀\n# 300424022",
          },
          {
            telegramMessageId: "487",
            replyToMessageId: "484",
            messageDate: "2026-07-20T02:48:58.000Z",
            rawText: "Closed ✅",
          },
        ]),
        telegramPollingEnabled: false,
      });
      await configureProviderWithAccount(app, { availableSymbols: ["XAUUSD"] });
      await app.runTelegramIngestionOnce();

      const db = new Database(databasePath);
      try {
        const trades = db.query("SELECT id, data_json FROM logical_trades").all() as Array<{
          id: string;
          data_json: string;
        }>;
        const queues = db
          .query("SELECT logical_trade_id, payload_json FROM queue_items ORDER BY created_at")
          .all() as Array<{ logical_trade_id: string; payload_json: string }>;
        expect(trades).toHaveLength(1);
        expect(JSON.parse(trades[0]!.data_json).providerOrderId).toBe("300424022");
        expect(queues).toHaveLength(3);
        expect(
          queues.filter((queue) => JSON.parse(queue.payload_json).commandType === "NO_SIGNAL"),
        ).toHaveLength(1);
        expect(
          queues.filter((queue) => JSON.parse(queue.payload_json).commandType === "CLOSE_TRADE"),
        ).toEqual([expect.objectContaining({ logical_trade_id: trades[0]!.id })]);
        const reply = db
          .query(
            `SELECT parsed_signals.result_json
             FROM parsed_signals
             JOIN raw_messages ON raw_messages.id = parsed_signals.raw_message_id
             WHERE raw_messages.telegram_message_id = '487'`,
          )
          .get() as { result_json: string };
        expect(JSON.parse(reply.result_json).originalText).toContain("Quoted signal:");
      } finally {
        db.close();
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("covers the live VIP Gold 545/546/547 safety fixture across accounts", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "telegram-tc-vipgold-live-safety-"));
    const databasePath = join(tempDir, "app.db");
    const order =
      "NEW ORDER - XAUUSD Sell Stop 📉  # 306947863  ----------{ NEW }---------- Entry: 4051.30 [Lots: 0.01] SL: 4057.30 TP: 4039.30";
    try {
      const app = createApi({
        databasePath,
        seedDemoData: false,
        telegram: createQueuedTelegramAdapter([
          { telegramMessageId: "545", messageDate: "2026-07-24T13:00:00.000Z", rawText: order },
          {
            telegramMessageId: "546",
            replyToMessageId: "545",
            messageDate: "2026-07-24T13:01:00.000Z",
            rawText: "🚀 Sell Stop activated 🚀 # 306947863 XAUUSD @ 4051.30",
            quotedText: order,
          },
          {
            telegramMessageId: "547",
            replyToMessageId: "545",
            messageDate: "2026-07-24T13:02:00.000Z",
            rawText:
              "🟢 CLOSED - XAUUSD Sell 🟢 # 306947863 ...{ CLOSED }... Profit: 2.21$ ... Profit: 0.21%",
            quotedText: order,
          },
        ]),
        telegramPollingEnabled: false,
      });
      const providerId = await configureProviderWithAccount(app, { availableSymbols: ["XAUUSD"] });
      await app.request(`/api/account-provider-links/mt5-63442826/${providerId}`, {
        method: "PUT",
        body: JSON.stringify({ enabled: true }),
        headers: { "content-type": "application/json" },
      });
      await app.request("/api/mt5/register", {
        method: "POST",
        body: JSON.stringify({
          accountNumber: "54945785",
          server: "HFMarkets-Demo",
          company: "HF Markets",
          currency: "USD",
          balance: 10000,
          equity: 10000,
          marginMode: "HEDGING",
          availableSymbols: ["XAUUSD"],
          eaVersion: "1.56.2",
          eaCapabilities: ["lane-2-close-contract"],
        }),
        headers: { "content-type": "application/json" },
      });
      await app.request(`/api/account-provider-links/mt5-54945785/${providerId}`, {
        method: "PUT",
        body: JSON.stringify({ enabled: true }),
        headers: { "content-type": "application/json" },
      });

      const ingestion = await app.runTelegramIngestionOnce();
      expect(ingestion.queued).toBe(4);

      const db = new Database(databasePath);
      try {
        const trades = db
          .query("SELECT id, account_id, data_json FROM logical_trades")
          .all() as Array<{
          id: string;
          account_id: string;
          data_json: string;
        }>;
        const queues = db
          .query(
            "SELECT account_id, logical_trade_id, status, held_reason, payload_json FROM queue_items",
          )
          .all() as Array<{
          account_id: string;
          logical_trade_id: string;
          status: string;
          held_reason: string | null;
          payload_json: string;
        }>;
        expect(trades).toHaveLength(2);
        expect(trades.map((trade) => JSON.parse(trade.data_json).providerOrderId)).toEqual([
          "306947863",
          "306947863",
        ]);
        expect(db.query("SELECT logical_trade_id FROM trade_origins").all()).toHaveLength(2);
        expect(
          queues.filter((queue) => JSON.parse(queue.payload_json).commandType === "OPEN_TRADE"),
        ).toHaveLength(2);
        expect(
          queues.filter((queue) => JSON.parse(queue.payload_json).commandType === "CLOSE_TRADE"),
        ).toHaveLength(2);
        expect(
          queues
            .filter((queue) => JSON.parse(queue.payload_json).commandType === "CLOSE_TRADE")
            .every((queue) => JSON.parse(queue.payload_json).targetPositionTicket === undefined),
        ).toBe(true);
        expect(queues.filter((queue) => queue.status === "HELD")).toHaveLength(0);
      } finally {
        db.close();
      }

      const duplicate = await json<{ parsedSignalId: string }>(
        await app.request("/api/parser/parse", {
          method: "POST",
          body: JSON.stringify({
            providerId,
            accountId: "mt5-63442826",
            rawText: order,
          }),
          headers: { "content-type": "application/json" },
        }),
      );
      const duplicateApproval = await json<{
        status: string;
        heldQueueItems: string[];
      }>(await app.request(`/api/signals/${duplicate.parsedSignalId}/approve`, { method: "POST" }));
      expect(duplicateApproval.status).toBe("HELD");
      expect(duplicateApproval.heldQueueItems).toHaveLength(2);
      const held = await json<{ queue: Array<{ status: string; heldReason: string }> }>(
        await app.request("/api/signals"),
      );
      expect(held.queue.filter((item) => item.heldReason === "DUPLICATE_ORDER_ID")).toHaveLength(2);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("synthetic: close-all stays per-trade and reparses broker symbols per account", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "telegram-tc-close-all-"));
    const databasePath = join(tempDir, "app.db");
    const previousFetch = globalThis.fetch;
    const alerts: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      alerts.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
      return Response.json({ ok: true });
    }) as typeof fetch;
    try {
      const app = createApi({ databasePath, seedDemoData: false, telegramAdapter: "mock" });
      const providerId = await configureProviderWithAccount(app, { availableSymbols: ["XAUUSD"] });
      await app.request("/api/settings", {
        method: "PATCH",
        body: JSON.stringify({ alertBotToken: "bot-token", alertChatId: "chat-1" }),
        headers: { "content-type": "application/json" },
      });
      await app.request(`/api/account-provider-links/mt5-63442826/${providerId}`, {
        method: "PUT",
        body: JSON.stringify({ enabled: true }),
        headers: { "content-type": "application/json" },
      });
      await app.request("/api/mt5/register", {
        method: "POST",
        body: JSON.stringify({
          accountNumber: "54945785",
          server: "HFMarkets-Demo",
          company: "HF Markets",
          currency: "USD",
          balance: 10000,
          equity: 10000,
          marginMode: "HEDGING",
          availableSymbols: ["XAUUSD.r"],
          eaVersion: "1.59.0",
          eaCapabilities: ["lane2-close-contract", "pending-close-flatten-v1"],
        }),
        headers: { "content-type": "application/json" },
      });
      await app.request(`/api/account-provider-links/mt5-54945785/${providerId}`, {
        method: "PUT",
        body: JSON.stringify({ enabled: true }),
        headers: { "content-type": "application/json" },
      });
      await app.request("/api/mt5/heartbeat", {
        method: "POST",
        body: JSON.stringify({
          accountId: "mt5-54945785",
          balance: 10000,
          equity: 10000,
          availableSymbols: ["XAUUSD.r"],
          eaVersion: "1.59.0",
          eaCapabilities: ["lane2-close-contract", "pending-close-flatten-v1"],
        }),
        headers: { "content-type": "application/json" },
      });
      const opened = await json<{ parsedSignalId: string }>(
        await app.request("/api/parser/parse", {
          method: "POST",
          body: JSON.stringify({
            providerId,
            accountId: "mt5-63442826",
            rawText: "Gold buy limit\n\n4541-40\n\nSL 4535\n\nTP 4546",
          }),
          headers: { "content-type": "application/json" },
        }),
      );
      const openApproval = await json<{
        queueItems: string[];
        logicalTradeIds: string[];
      }>(await app.request(`/api/signals/${opened.parsedSignalId}/approve`, { method: "POST" }));
      expect(openApproval.queueItems).toHaveLength(2);
      for (const [index, queueItemId] of openApproval.queueItems.entries()) {
        await app.request("/api/mt5/report", {
          method: "POST",
          body: JSON.stringify({
            accountId: index === 0 ? "mt5-63442826" : "mt5-54945785",
            queueItemId,
            status: "EXECUTED",
            retcode: 10009,
            retcodeExternal: 0,
            brokerComment: "opened",
            orderTicket: `close-all-open-${index}`,
            positionTicket: `close-all-position-${index}`,
            dealTicket: `close-all-deal-${index}`,
            requestedVolume: 0.1,
            filledVolume: 0.1,
            remainingVolume: 0.1,
          }),
          headers: { "content-type": "application/json" },
        });
      }
      const secondOpen = await json<{ parsedSignalId: string }>(
        await app.request("/api/parser/parse", {
          method: "POST",
          body: JSON.stringify({
            providerId,
            accountId: "mt5-63442826",
            rawText: "Gold buy limit\n\n4528-27\n\nSL 4521\n\nTP 4534",
          }),
          headers: { "content-type": "application/json" },
        }),
      );
      const secondOpenApproval = await json<{
        queueItems: string[];
        logicalTradeIds: string[];
      }>(
        await app.request(`/api/signals/${secondOpen.parsedSignalId}/approve`, { method: "POST" }),
      );
      expect(secondOpenApproval.queueItems).toHaveLength(2);
      for (const [index, queueItemId] of secondOpenApproval.queueItems.entries()) {
        await app.request("/api/mt5/report", {
          method: "POST",
          body: JSON.stringify({
            accountId: index === 0 ? "mt5-63442826" : "mt5-54945785",
            queueItemId,
            status: "EXECUTED",
            retcode: 10009,
            retcodeExternal: 0,
            brokerComment: "opened",
            orderTicket: `close-all-second-open-${index}`,
            positionTicket: `close-all-second-position-${index}`,
            dealTicket: `close-all-second-deal-${index}`,
            requestedVolume: 0.1,
            filledVolume: 0.1,
            remainingVolume: 0.1,
          }),
          headers: { "content-type": "application/json" },
        });
      }
      const allLogicalTradeIds = [
        ...openApproval.logicalTradeIds,
        ...secondOpenApproval.logicalTradeIds,
      ];
      const close = await json<{ parsedSignalId: string }>(
        await app.request("/api/parser/parse", {
          method: "POST",
          body: JSON.stringify({
            providerId,
            accountId: "mt5-63442826",
            rawText: "Close all positions XAUUSD",
          }),
          headers: { "content-type": "application/json" },
        }),
      );
      // This endpoint passes trigger:"operator", which SKIPS the evidence gate. Before the fan-out
      // was deleted, one "Approve" click here flattened every active trade on every linked account.
      // It must now hold on both accounts and queue nothing executable.
      const approval = await json<{
        heldQueueItems: string[];
        queuedCount: number;
        status: string;
      }>(await app.request(`/api/signals/${close.parsedSignalId}/approve`, { method: "POST" }));
      expect(approval).toMatchObject({ queuedCount: 0, status: "HELD" });
      expect(approval.heldQueueItems).toHaveLength(2);
      const heldCards = await json<{
        items: Array<{
          id: string;
          accountId: string;
          symbol: string;
          candidateLogicalTradeIds: string[];
        }>;
      }>(await app.request("/api/queue-items/held"));
      expect(heldCards.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            accountId: "mt5-63442826",
            symbol: "XAUUSD",
          }),
          expect.objectContaining({
            accountId: "mt5-54945785",
            symbol: "XAUUSD.r",
          }),
        ]),
      );
      expect(heldCards.items.every((item) => item.candidateLogicalTradeIds.length === 2)).toBe(
        true,
      );
      const db = new Database(databasePath, { readonly: true });
      try {
        // The provider-wide fan-out audit must no longer exist at all.
        expect(
          db
            .query("SELECT COUNT(*) AS count FROM audit_logs WHERE event_type = 'signal.close-all'")
            .get() as { count: number },
        ).toMatchObject({ count: 0 });
        // Two HELD rows, one per linked account, and nothing the EA could ever lease.
        expect(
          db
            .query(
              "SELECT COUNT(*) AS count FROM queue_items WHERE parsed_signal_id = ? AND status = 'HELD'",
            )
            .get(close.parsedSignalId) as { count: number },
        ).toMatchObject({ count: 2 });
        expect(
          db
            .query(
              "SELECT COUNT(*) AS count FROM queue_items WHERE parsed_signal_id = ? AND status IN ('PENDING','LEASED','EXECUTED')",
            )
            .get(close.parsedSignalId) as { count: number },
        ).toMatchObject({ count: 0 });
        // The originally opened trades must still be active - nothing was flattened.
        expect(
          db
            .query(
              `SELECT COUNT(*) AS count FROM logical_trades WHERE id IN (${allLogicalTradeIds.map(() => "?").join(", ")})
               AND json_extract(data_json, '$.status') IN ('OPEN','PENDING','PLANNED')`,
            )
            .get(...allLogicalTradeIds) as { count: number },
        ).toMatchObject({ count: 4 });
      } finally {
        db.close();
      }
      const firstAccountCard = heldCards.items.find((item) => item.accountId === "mt5-63442826")!;
      const selectedTradeId = firstAccountCard.candidateLogicalTradeIds[0]!;
      const released = await json<{
        queueItemId: string;
        logicalTradeId: string;
        remainingHeldQueueItems: string[];
        remainingTradeCount: number;
      }>(
        await app.request(`/api/queue-items/${firstAccountCard.id}/requeue`, {
          method: "POST",
          body: JSON.stringify({
            mode: "original",
            logicalTradeId: selectedTradeId,
          }),
          headers: { "content-type": "application/json" },
        }),
      );
      expect(released).toMatchObject({
        logicalTradeId: selectedTradeId,
        remainingTradeCount: 1,
      });
      expect(released.remainingHeldQueueItems).toHaveLength(1);
      const afterRelease = await json<{
        items: Array<{ id: string; accountId: string; candidateLogicalTradeIds: string[] }>;
      }>(await app.request("/api/queue-items/held"));
      expect(afterRelease.items).toContainEqual(
        expect.objectContaining({
          id: released.remainingHeldQueueItems[0],
          accountId: "mt5-63442826",
          candidateLogicalTradeIds: [
            firstAccountCard.candidateLogicalTradeIds.find((id) => id !== selectedTradeId),
          ],
        }),
      );
      const releaseDb = new Database(databasePath, { readonly: true });
      try {
        expect(
          releaseDb
            .query(
              "SELECT COUNT(*) AS count FROM queue_items WHERE parsed_signal_id = ? AND account_id = ? AND status = 'PENDING'",
            )
            .get(close.parsedSignalId, "mt5-63442826"),
        ).toEqual({ count: 1 });
      } finally {
        releaseDb.close();
      }
      expect(alerts.length).toBeGreaterThanOrEqual(1);
      expect(String(alerts[0]?.body.text)).toContain("CLOSE_ALL_REQUIRES_OPERATOR");
    } finally {
      globalThis.fetch = previousFetch;
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("holds a naked STOP before it can be sent to the EA", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: false });
    const providerId = await configureProviderWithAccount(app, { availableSymbols: ["XAUUSD"] });
    const parsed = await json<{ parsedSignalId: string }>(
      await app.request("/api/parser/parse", {
        method: "POST",
        body: JSON.stringify({
          providerId,
          accountId: "mt5-63442826",
          rawText: "XAUUSD Sell Stop\nSL: 4057.30\nTP: 4039.30",
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    const approval = await json<{ status: string; queueItemId: string }>(
      await app.request(`/api/signals/${parsed.parsedSignalId}/approve`, { method: "POST" }),
    );
    expect(approval.status).toBe("HELD");
    const queue = await json<{ queue: Array<{ id: string; status: string; heldReason: string }> }>(
      await app.request("/api/signals"),
    );
    expect(queue.queue).toContainEqual(
      expect.objectContaining({
        id: approval.queueItemId,
        status: "HELD",
        heldReason: "NAKED_PENDING_ENTRY",
      }),
    );
    expect(
      await (await app.request("/api/mt5/poll-line?accountId=mt5-63442826")).text(),
    ).not.toContain("commandType=OPEN_TRADE");
  });

  test("holds a MARKET order when the account reports no quote for its symbol", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: false });
    await configureProviderWithAccount(app, { availableSymbols: ["XAUUSD"] });
    await app.request("/api/mt5/snapshot", {
      method: "POST",
      body: JSON.stringify({
        accountId: "mt5-63442826",
        positions: [],
        orders: [],
        symbols: [{ symbol: "EURUSD", bid: 1.08, ask: 1.0802, point: 0.00001 }],
      }),
      headers: { "content-type": "application/json" },
    });
    const pushed = await app.request("/api/signals/manual", {
      method: "POST",
      body: JSON.stringify({
        accountId: "mt5-63442826",
        direction: "BUY",
        orderType: "MARKET",
        brokerSymbol: "XAUUSD",
        stopLoss: 4050,
        takeProfits: [{ price: 4070 }],
        volume: 0.01,
      }),
      headers: { "content-type": "application/json" },
    });
    expect(pushed.status).toBe(200);
    expect(
      await (await app.request("/api/mt5/poll-line?accountId=mt5-63442826")).text(),
    ).not.toContain("commandType=OPEN_TRADE");
    const queue = await json<{ queue: Array<{ status: string; heldReason?: string }> }>(
      await app.request("/api/signals"),
    );
    expect(queue.queue).toContainEqual(
      expect.objectContaining({ status: "HELD", heldReason: "NAKED_MARKET_NO_QUOTE" }),
    );
  });

  test("uses a fresh live quote when the durable snapshot is older than five minutes", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "telegram-tc-live-quote-preference-"));
    const databasePath = join(tempDir, "app.db");
    const originalDateNow = Date.now;
    const now = originalDateNow();
    try {
      const app = createApi({
        databasePath,
        seedDemoData: false,
        telegramAdapter: "mock",
        telegramPollingEnabled: false,
      });
      await configureProviderWithAccount(app, { availableSymbols: ["XAUUSD"] });
      await app.request("/api/mt5/snapshot", {
        method: "POST",
        body: JSON.stringify({
          accountId: "mt5-63442826",
          positions: [],
          orders: [],
          symbols: [{ symbol: "XAUUSD", bid: 4050, ask: 4050.2, point: 0.01 }],
        }),
        headers: { "content-type": "application/json" },
      });
      const db = new Database(databasePath);
      db.query("UPDATE mt5_snapshots SET updated_at = ? WHERE account_id = ?").run(
        new Date(now - 6 * 60_000).toISOString(),
        "mt5-63442826",
      );
      db.close();
      Date.now = () => now;
      await app.request("/api/mt5/snapshot", {
        method: "POST",
        body: JSON.stringify({
          accountId: "mt5-63442826",
          positions: [],
          orders: [],
          symbols: [{ symbol: "XAUUSD", bid: 4051, ask: 4051.2, point: 0.01 }],
        }),
        headers: { "content-type": "application/json" },
      });
      const pushed = await app.request("/api/signals/manual", {
        method: "POST",
        body: JSON.stringify({
          accountId: "mt5-63442826",
          direction: "BUY",
          orderType: "MARKET",
          brokerSymbol: "XAUUSD",
          stopLoss: 4040,
          takeProfits: [{ price: 4060 }],
          volume: 0.01,
        }),
        headers: { "content-type": "application/json" },
      });
      expect(pushed.status).toBe(200);
      expect(
        await (await app.request("/api/mt5/poll-line?accountId=mt5-63442826")).text(),
      ).toContain("commandType=OPEN_TRADE");
    } finally {
      Date.now = originalDateNow;
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("fans a provider CLOSE out to every active logical trade for its order id", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "telegram-tc-close-order-id-fanout-"));
    const databasePath = join(tempDir, "app.db");
    try {
      const app = createApi({
        databasePath,
        seedDemoData: false,
        telegramAdapter: "mock",
        telegramPollingEnabled: false,
      });
      const providerId = await configureProviderWithAccount(app, { availableSymbols: ["XAUUSD"] });
      const opened = await json<{ parsedSignalId: string }>(
        await app.request("/api/parser/parse", {
          method: "POST",
          body: JSON.stringify({
            providerId,
            accountId: "mt5-63442826",
            rawText:
              "NEW ORDER - XAUUSD Sell Stop # 306947863 Entry: 4051.30 SL: 4057.30 TP: 4039.30",
          }),
          headers: { "content-type": "application/json" },
        }),
      );
      const approval = await json<{ logicalTradeId: string }>(
        await app.request(`/api/signals/${opened.parsedSignalId}/approve`, { method: "POST" }),
      );

      const db = new Database(databasePath);
      const original = db
        .query(
          "SELECT provider_id, account_id, status, data_json, created_at FROM logical_trades WHERE id = ?",
        )
        .get(approval.logicalTradeId) as {
        provider_id: string;
        account_id: string;
        status: string;
        data_json: string;
        created_at: string;
      };
      const duplicate = { ...JSON.parse(original.data_json), id: "trade_duplicate-order-id" };
      db.query(
        "INSERT INTO logical_trades (id, provider_id, account_id, status, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(
        duplicate.id,
        original.provider_id,
        original.account_id,
        original.status,
        JSON.stringify(duplicate),
        original.created_at,
      );
      db.close();

      const closed = await json<{ parsedSignalId: string }>(
        await app.request("/api/parser/parse", {
          method: "POST",
          body: JSON.stringify({
            providerId,
            accountId: "mt5-63442826",
            rawText: "CLOSED - XAUUSD Sell # 306947863",
          }),
          headers: { "content-type": "application/json" },
        }),
      );
      const closeApproval = await json<{ logicalTradeIds: string[]; queueItems: string[] }>(
        await app.request(`/api/signals/${closed.parsedSignalId}/approve`, { method: "POST" }),
      );
      expect(closeApproval.logicalTradeIds).toEqual(
        expect.arrayContaining([approval.logicalTradeId, duplicate.id]),
      );
      expect(closeApproval.queueItems).toHaveLength(2);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("uses a reply link to disambiguate duplicate provider order ids", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "telegram-tc-reply-lifecycle-"));
    const databasePath = join(tempDir, "app.db");
    try {
      const app = createApi({
        databasePath,
        seedDemoData: false,
        telegram: createQueuedTelegramAdapter([
          {
            telegramMessageId: "1",
            messageDate: "2026-07-20T02:00:00.000Z",
            rawText: "BUY XAUUSD 4500\nSL 4490\nTP 4520\n# 300424022",
          },
          {
            telegramMessageId: "2",
            messageDate: "2026-07-20T02:01:00.000Z",
            rawText: "BUY XAUUSD 4501\nSL 4491\nTP 4521\n# 300424022",
          },
          {
            telegramMessageId: "3",
            replyToMessageId: "1",
            messageDate: "2026-07-20T02:02:00.000Z",
            rawText: "CLOSED - XAUUSD Buy\n# 300424022",
          },
        ]),
        telegramPollingEnabled: false,
      });
      await configureProviderWithAccount(app, { availableSymbols: ["XAUUSD"] });
      await app.runTelegramIngestionOnce();

      const db = new Database(databasePath, { readonly: true });
      try {
        const queues = db
          .query("SELECT logical_trade_id, payload_json FROM queue_items ORDER BY created_at")
          .all() as Array<{ logical_trade_id: string; payload_json: string }>;
        const close = queues.find(
          (queue) => JSON.parse(queue.payload_json).commandType === "CLOSE_TRADE",
        );
        expect(close?.logical_trade_id).toBe(queues[0]!.logical_trade_id);
      } finally {
        db.close();
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("does not route a reused provider order id to another symbol", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "telegram-tc-symbol-lifecycle-"));
    const databasePath = join(tempDir, "app.db");
    try {
      const app = createApi({
        databasePath,
        seedDemoData: false,
        telegram: createQueuedTelegramAdapter([
          {
            telegramMessageId: "1",
            messageDate: "2026-07-20T02:00:00.000Z",
            rawText: "BUY EURUSD 1.0850\nSL 1.0800\nTP 1.0950",
          },
          {
            telegramMessageId: "2",
            messageDate: "2026-07-20T02:01:00.000Z",
            rawText: "BUY XAUUSD 4500\nSL 4490\nTP 4520\n# 300424022",
          },
          {
            telegramMessageId: "3",
            messageDate: "2026-07-20T02:02:00.000Z",
            rawText: "CLOSED - EURUSD Buy\n# 300424022",
          },
        ]),
        telegramPollingEnabled: false,
      });
      await configureProviderWithAccount(app, { availableSymbols: ["EURUSD.raw", "XAUUSD"] });
      await app.runTelegramIngestionOnce();

      const db = new Database(databasePath, { readonly: true });
      try {
        const queues = db
          .query("SELECT logical_trade_id, payload_json FROM queue_items ORDER BY created_at")
          .all() as Array<{ logical_trade_id: string; payload_json: string }>;
        const close = queues.find(
          (queue) => JSON.parse(queue.payload_json).commandType === "CLOSE_TRADE",
        );
        expect(close?.logical_trade_id).toBe("");
      } finally {
        db.close();
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("holds an ambiguous close for reconciliation instead of dropping it", async () => {
    const app = createApi({
      databasePath: ":memory:",
      seedDemoData: false,
      telegram: createQueuedTelegramAdapter(realFixtureMessages(["15226", "15227", "16669"])),
      telegramPollingEnabled: false,
    });
    await configureProviderWithAccount(app, { availableSymbols: ["XAUUSD"] });
    const ingestion = await app.runTelegramIngestionOnce();
    expect(ingestion.errors).toBe(0);
    const queue = await json<{
      queue: Array<{
        id: string;
        status: string;
        heldReason?: string;
        payload: { commandType: string };
      }>;
    }>(await app.request("/api/signals"));
    const held = queue.queue.find(
      (item) => item.status === "HELD" && item.heldReason?.startsWith("EVIDENCE_"),
    );
    expect(held).toMatchObject(
      expect.objectContaining({
        status: "HELD",
        heldReason: expect.stringMatching(/^EVIDENCE_/),
        payload: expect.objectContaining({ commandType: "CANCEL_PENDING" }),
      }),
    );
    const requeue = await app.request(`/api/queue-items/${held?.id}/requeue`, {
      method: "POST",
      body: JSON.stringify({ mode: "original" }),
      headers: { "content-type": "application/json" },
    });
    expect(requeue.status).toBe(409);
    expect(await requeue.json()).toMatchObject({
      error: expect.stringContaining("selected active logicalTradeId"),
    });
    const heldAfter = await json<{ queue: Array<{ id: string; status: string }> }>(
      await app.request("/api/signals"),
    );
    expect(heldAfter.queue.find((item) => item.id === held?.id)?.status).toBe("HELD");
    const audit = await json<{ logs: Array<{ eventType: string; level: string }> }>(
      await app.request("/api/audit-logs?event=telegram.ingest.queue-failed"),
    );
    expect(audit.logs).toHaveLength(0);
  });

  test("demotes a real-corpus target DROP when linked-account evidence disagrees", () => {
    const fixture = corpusMessages.find((message) => message.telegramMessageId === "15226")!;
    const signal = parseSignalText(fixture.rawText, {
      providerId: fixture.providerId,
      accountId: "account-a",
      accountMappings: {
        "account-a": {
          accountId: "account-a",
          includeSymbols: ["XAUUSD"],
          availableBrokerSymbols: ["XAUUSD"],
        },
      },
    });
    const targets = normalizeEvidenceTargets([
      {
        accountId: "account-a",
        signal,
        verdict: { verdict: "DROP", reason: "NO_EXECUTABLE_SIGNAL" },
      },
      {
        accountId: "account-b",
        signal,
        verdict: { verdict: "EXECUTE", reason: "COMPLETE_PROSE_OPEN_EVIDENCE" },
      },
    ]);

    expect(targets[0]?.verdict).toMatchObject({
      verdict: "HOLD",
      reason: "NO_EXECUTABLE_SIGNAL",
      tier: "action-required",
    });
    expect(targets[1]?.verdict.verdict).toBe("EXECUTE");
    expect(
      normalizeEvidenceTargets([targets[0]!, targets[0]!]).every(
        (target) => target.verdict.verdict === "HOLD",
      ),
    ).toBe(true);
  });

  test("reconciles MT5 execution reports back into logical trade TP leg state", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: true });

    const poll = await app.request("/api/mt5/poll?accountId=mt5-100200300");
    const lease = await json<{ item: { id: string } | null }>(poll);
    expect(lease.item?.id).toBe("queue-demo-1");

    await app.request("/api/mt5/report", {
      method: "POST",
      body: JSON.stringify({
        accountId: "mt5-100200300",
        queueItemId: lease.item!.id,
        status: "EXECUTED",
        retcode: 10009,
        retcodeExternal: 0,
        brokerComment: "Request completed",
        orderTicket: "50001",
        dealTicket: "60001",
        requestedPrice: 1.085,
        filledPrice: 1.0851,
        volume: 0.1,
        errorText: "",
      }),
      headers: { "content-type": "application/json" },
    });

    const opened = await json<{
      logicalTrades: Array<{
        id: string;
        status: string;
        legs: Array<{ leg: number; status: string }>;
      }>;
    }>(await app.request("/api/dashboard"));
    const trade = opened.logicalTrades.find((item) => item.id === "trade-demo-1");
    expect(trade?.status).toBe("OPEN");
    expect(trade?.legs.map((leg) => [leg.leg, leg.status])).toEqual([
      [1, "OPEN"],
      [2, "OPEN"],
      [3, "OPEN"],
      [4, "OPEN"],
    ]);

    await app.request("/api/mt5/report", {
      method: "POST",
      body: JSON.stringify({
        accountId: "mt5-100200300",
        queueItemId: lease.item!.id,
        status: "EXECUTED",
        retcode: 10009,
        retcodeExternal: 0,
        brokerComment: "telegram-tc-virtual-tp:trade-demo-1:tp1",
        orderTicket: "50002",
        dealTicket: "60002",
        requestedPrice: 1.09,
        filledPrice: 1.09,
        volume: 0.03,
        errorText: "",
      }),
      headers: { "content-type": "application/json" },
    });

    const updated = await json<{
      logicalTrades: Array<{ id: string; legs: Array<{ leg: number; status: string }> }>;
    }>(await app.request("/api/dashboard"));
    expect(
      updated.logicalTrades
        .find((item) => item.id === "trade-demo-1")
        ?.legs.map((leg) => [leg.leg, leg.status]),
    ).toEqual([
      [1, "CLOSED"],
      [2, "OPEN"],
      [3, "OPEN"],
      [4, "OPEN"],
    ]);
  });

  test("classifies generic virtual TP execution reports as partial closes by intended leg", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: true });

    const lease = await json<{ item: { id: string } | null }>(
      await app.request("/api/mt5/poll?accountId=mt5-100200300"),
    );
    expect(lease.item?.id).toBe("queue-demo-1");

    await app.request("/api/mt5/report", {
      method: "POST",
      body: JSON.stringify({
        accountId: "mt5-100200300",
        queueItemId: lease.item!.id,
        status: "EXECUTED",
        retcode: 10009,
        retcodeExternal: 0,
        brokerComment: "Request executed",
        orderTicket: "50001",
        positionTicket: "70001",
        dealTicket: "60001",
        requestedPrice: 1.085,
        filledPrice: 1.0851,
        volume: 0.1,
        errorText: "",
      }),
      headers: { "content-type": "application/json" },
    });

    await app.request("/api/mt5/report", {
      method: "POST",
      body: JSON.stringify({
        accountId: "mt5-100200300",
        queueItemId: lease.item!.id,
        status: "EXECUTED",
        retcode: 10009,
        retcodeExternal: 0,
        brokerComment: "Request executed",
        orderTicket: "50002",
        positionTicket: "70001",
        dealTicket: "60002",
        requestedPrice: 1.09,
        filledPrice: 1.09,
        volume: 0.03,
        errorText: "",
      }),
      headers: { "content-type": "application/json" },
    });

    const dashboard = await json<{
      logicalTrades: Array<{ id: string; legs: Array<{ leg: number; status: string }> }>;
    }>(await app.request("/api/dashboard"));
    expect(
      dashboard.logicalTrades
        .find((item) => item.id === "trade-demo-1")
        ?.legs.map((leg) => [leg.leg, leg.status]),
    ).toEqual([
      [1, "CLOSED"],
      [2, "OPEN"],
      [3, "OPEN"],
      [4, "OPEN"],
    ]);

    const brokerTrail = await json<{
      orders: Array<{ action: string; legId: string; dealTicket: string; source: string }>;
    }>(await app.request("/api/trades/trade-demo-1/broker-orders"));
    expect(brokerTrail.orders.find((order) => order.dealTicket === "60002")).toMatchObject({
      action: "PARTIAL_CLOSE",
      legId: "tp1",
      source: "app-close",
    });
  });

  test("maps numeric MT5 history deal entries to open and partial-close actions", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: true });
    const lease = await json<{ item: { id: string } | null }>(
      await app.request("/api/mt5/poll?accountId=mt5-100200300"),
    );

    await app.request("/api/mt5/report", {
      method: "POST",
      body: JSON.stringify({
        accountId: "mt5-100200300",
        queueItemId: lease.item!.id,
        status: "EXECUTED",
        retcode: 10009,
        retcodeExternal: 0,
        brokerComment: "Request completed",
        orderTicket: "50001",
        positionTicket: "70001",
        dealTicket: "60001",
        requestedPrice: 1.085,
        filledPrice: 1.0851,
        volume: 0.1,
        errorText: "",
      }),
      headers: { "content-type": "application/json" },
    });
    await app.request("/api/mt5/snapshot", {
      method: "POST",
      body: JSON.stringify({
        accountId: "mt5-100200300",
        positions: [{ ticket: "70001", symbol: "EURUSD.raw", volume: 0.07 }],
        orders: [],
        symbols: [],
      }),
      headers: { "content-type": "application/json" },
    });

    const history = await app.request("/api/mt5/history", {
      method: "POST",
      body: JSON.stringify({
        accountId: "mt5-100200300",
        deals: [
          {
            dealTicket: "60002",
            orderTicket: "50001",
            positionTicket: "70001",
            entry: "0",
            symbol: "EURUSD.raw",
            price: 1.0851,
            volume: 0.1,
            profit: 0,
            commission: 0,
            swap: 0,
            comment: "ttc:demo-1",
            time: "2026-05-10T12:00:00.000Z",
          },
          {
            dealTicket: "60003",
            orderTicket: "50002",
            positionTicket: "70001",
            entry: "1",
            symbol: "EURUSD.raw",
            price: 1.09,
            volume: 0.03,
            profit: 14.7,
            commission: 0,
            swap: 0,
            comment: "ttc:demo-1:tp1",
            time: "2026-05-10T12:05:00.000Z",
          },
        ],
      }),
      headers: { "content-type": "application/json" },
    });
    expect(history.status).toBe(200);

    const brokerTrail = await json<{
      orders: Array<{ action: string; dealTicket: string; legId: string }>;
    }>(await app.request("/api/trades/trade-demo-1/broker-orders"));
    expect(brokerTrail.orders.find((order) => order.dealTicket === "60002")).toMatchObject({
      action: "OPEN",
      legId: "trade",
    });
    expect(brokerTrail.orders.find((order) => order.dealTicket === "60003")).toMatchObject({
      action: "PARTIAL_CLOSE",
      legId: "tp1",
    });
  });

  test("keeps pending virtual-TP limit orders unarmed even when current price is beyond TP1", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: false });
    const approved = await approveGoldBuyLimit(app);
    await reportPendingAccepted(app, approved);

    await sendGoldSnapshot(app, {
      shortId: approved.shortId,
      bid: 4548,
      positions: [],
      orders: [
        {
          ticket: "247596888",
          symbol: "XAUUSD",
          type: 2,
          volume: 0.04,
          openPrice: 4541,
          sl: 4535,
          tp: 0,
          magic: 26050901,
          isExternal: false,
          comment: `ttc:${approved.shortId}`,
        },
      ],
    });

    const dashboard = await json<{
      logicalTrades: Array<{ id: string; status: string; legs: Array<{ status: string }> }>;
    }>(await app.request("/api/dashboard"));
    expect(
      dashboard.logicalTrades.find((trade) => trade.id === approved.logicalTradeId),
    ).toMatchObject({
      status: "PENDING",
      legs: [
        { status: "PLANNED" },
        { status: "PLANNED" },
        { status: "PLANNED" },
        { status: "PLANNED" },
      ],
    });

    const noWork = await (await app.request("/api/mt5/poll-line?accountId=mt5-63442826")).text();
    expect(noWork).toContain("status=NO_WORK");
  });

  test("queues an operator pending-order cancellation and rejects open trades", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: false });
    const approved = await approveGoldBuyLimit(app);
    await reportPendingAccepted(app, approved);

    const cancellation = await app.request(
      `/api/trades/${approved.logicalTradeId}/cancel-pending`,
      { method: "POST" },
    );
    expect(cancellation.status).toBe(200);
    const result = await json<{
      queueItemId: string;
      tradeId: string;
      accountId: string;
      status: string;
    }>(cancellation);
    expect(result).toMatchObject({
      tradeId: approved.logicalTradeId,
      accountId: "mt5-63442826",
      status: "CANCELLING",
    });
    const signals = await json<{
      queue: Array<{
        id: string;
        accountId?: string;
        logicalTradeId?: string;
        payload: { commandType: string; targetOrderTicket?: string };
      }>;
    }>(await app.request("/api/signals"));
    expect(signals.queue).toContainEqual(
      expect.objectContaining({
        id: result.queueItemId,
        accountId: "mt5-63442826",
        logicalTradeId: approved.logicalTradeId,
        payload: expect.objectContaining({ commandType: "CANCEL_PENDING" }),
      }),
    );

    const openApp = createApi({ databasePath: ":memory:", seedDemoData: false });
    const openTrade = await approveGoldBuyLimit(openApp);
    await reportPendingAccepted(openApp, openTrade);
    await reportGoldFill(openApp, openTrade);
    const rejected = await openApp.request(
      `/api/trades/${openTrade.logicalTradeId}/cancel-pending`,
      {
        method: "POST",
      },
    );
    expect(rejected.status).toBe(409);
    expect(await json<{ error: string }>(rejected)).toEqual({
      error: "Only PENDING trades can be cancelled; use close for open trades",
    });
  });

  test("queues one app-managed TP1 partial close only after the pending order fills", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: false });
    const approved = await approveGoldBuyLimit(app);
    await reportPendingAccepted(app, approved);
    await reportGoldFill(app, approved);

    await sendGoldSnapshot(app, { shortId: approved.shortId, bid: 4546.2 });
    const closeWork = await (await app.request("/api/mt5/poll-line?accountId=mt5-63442826")).text();
    expect(closeWork).toContain("commandType=CLOSE_PARTIAL");
    expect(closeWork).toContain("partialCloseKind=TP_LEG");
    expect(closeWork).toContain("partialCloseValue=1");
    expect(closeWork).toContain("partialCloseVolume=0.01");
    expect(closeWork).toContain("targetPositionTicket=247596888");

    await sendGoldSnapshot(app, { shortId: approved.shortId, bid: 4547 });
    const noDuplicate = await (
      await app.request("/api/mt5/poll-line?accountId=mt5-63442826")
    ).text();
    expect(noDuplicate).toContain("status=NO_WORK");
  });

  test("retires a virtual-TP leg when the broker reports the position is gone, with no retry loop", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: false });
    const approved = await approveGoldBuyLimit(app);
    await reportPendingAccepted(app, approved);
    await reportGoldFill(app, approved);

    // Price crosses TP1 -> the app queues a CLOSE_PARTIAL for leg 1.
    await sendGoldSnapshot(app, { shortId: approved.shortId, bid: 4546.2 });
    const lease = await json<{ item: { id: string; payload: { commandType: string } } | null }>(
      await app.request("/api/mt5/poll?accountId=mt5-63442826"),
    );
    expect(lease.item?.payload.commandType).toBe("CLOSE_PARTIAL");

    // The broker reports the targeted position no longer exists. This must be
    // treated as terminal (the close intent is already satisfied) so the command
    // is never re-issued — previously this drove a retry loop that produced tens
    // of thousands of identical "position ticket not found" FAILED reports.
    await app.request("/api/mt5/report", {
      method: "POST",
      body: JSON.stringify({
        accountId: "mt5-63442826",
        queueItemId: lease.item!.id,
        status: "FAILED",
        retcode: 0,
        retcodeExternal: 0,
        brokerComment: "virtual TP position ticket not found",
        orderTicket: "0",
        positionTicket: "247596888",
        dealTicket: "0",
        requestedPrice: 4546,
        filledPrice: 0,
        volume: 0.01,
        errorText: "virtual TP position ticket not found",
      }),
      headers: { "content-type": "application/json" },
    });

    const dashboard = await json<{
      logicalTrades: Array<{ id: string; legs: Array<{ leg: number; status: string }> }>;
    }>(await app.request("/api/dashboard"));
    const trade = dashboard.logicalTrades.find((item) => item.id === approved.logicalTradeId);
    // Leg 1 is terminal, not left in a HIT/OPEN state that any path could retry.
    expect(trade?.legs.find((leg) => leg.leg === 1)?.status).toBe("CLOSED");

    // A further snapshot beyond TP1 must not re-queue the vanished close.
    await sendGoldSnapshot(app, { shortId: approved.shortId, bid: 4547 });
    const noWork = await (await app.request("/api/mt5/poll-line?accountId=mt5-63442826")).text();
    expect(noWork).toContain("status=NO_WORK");
  });

  test("sizes app-managed TP closes from broker-filled volume when EA lot override changes actual size", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: false });
    const approved = await approveGoldBuyLimit(app);
    await reportPendingAccepted(app, approved);
    await app.request("/api/mt5/history", {
      method: "POST",
      body: JSON.stringify({
        accountId: "mt5-63442826",
        deals: [
          {
            dealTicket: "244236611",
            orderTicket: "247596888",
            positionTicket: "247596888",
            entry: "0",
            reason: 3,
            symbol: "XAUUSD",
            price: 4540.9,
            volume: 0.08,
            profit: 0,
            commission: 0,
            swap: 0,
            comment: `ttc:${approved.shortId}`,
            time: "2026.05.18 18:01:12",
          },
        ],
      }),
      headers: { "content-type": "application/json" },
    });

    await sendGoldSnapshot(app, {
      shortId: approved.shortId,
      bid: 4546.2,
      positions: [
        {
          ticket: "247596888",
          symbol: "XAUUSD",
          type: 0,
          volume: 0.08,
          openPrice: 4540.9,
          sl: 4535,
          tp: 0,
          profit: 0,
          magic: 26050901,
          isExternal: false,
          comment: `ttc:${approved.shortId}`,
        },
      ],
    });

    const closeWork = await (await app.request("/api/mt5/poll-line?accountId=mt5-63442826")).text();
    expect(closeWork).toContain("commandType=CLOSE_PARTIAL");
    expect(closeWork).toContain("partialCloseKind=TP_LEG");
    expect(closeWork).toContain("partialCloseValue=1");
    expect(closeWork).toContain("partialCloseVolume=0.02");
    expect(closeWork).toContain("targetPositionTicket=247596888");
  });

  test("keeps a configured runner open after a provider CLOSE_TRADE", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: false });
    const approved = await approveGoldSellSmallRunnerLimit(app);
    await app.request("/api/mt5/report", {
      method: "POST",
      body: JSON.stringify({
        accountId: "mt5-63442826",
        queueItemId: approved.queueItemId,
        status: "EXECUTED",
        retcode: 10009,
        retcodeExternal: 0,
        brokerComment: "opened",
        orderTicket: "247694735",
        positionTicket: "247694735",
        dealTicket: "247694735",
        requestedVolume: 0.02,
        filledVolume: 0.02,
        remainingVolume: 0.02,
      }),
      headers: { "content-type": "application/json" },
    });
    await sendGoldSnapshot(app, {
      shortId: approved.shortId,
      bid: 4488.0,
      positions: [
        {
          ticket: "247694735",
          symbol: "XAUUSD",
          type: 1,
          volume: 0.02,
          openPrice: 4488.46,
          sl: 4494,
          tp: 0,
          profit: 0,
          magic: 26050901,
          isExternal: false,
          comment: `ttc:${approved.shortId}`,
        },
      ],
    });

    const parsed = await json<{ parsedSignalId: string }>(
      await app.request("/api/parser/parse", {
        method: "POST",
        body: JSON.stringify({
          providerId: approved.providerId,
          accountId: "mt5-63442826",
          rawText: "CLOSED - XAUUSD Sell",
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    const close = await json<{ queueItemId: string }>(
      await app.request(`/api/signals/${parsed.parsedSignalId}/approve`, { method: "POST" }),
    );
    const closeWork = await (await app.request("/api/mt5/poll-line?accountId=mt5-63442826")).text();
    expect(closeWork).toContain("commandType=CLOSE_TRADE");
    expect(closeWork).toContain("runnerEnabled=true");
    expect(closeWork).toContain("runnerVolume=0.01");

    await app.request("/api/mt5/report", {
      method: "POST",
      body: JSON.stringify({
        accountId: "mt5-63442826",
        queueItemId: close.queueItemId,
        status: "EXECUTED",
        retcode: 10009,
        retcodeExternal: 0,
        brokerComment: "runner remains",
        positionTicket: "247694735",
        dealTicket: "247694736",
        requestedVolume: 0.01,
        filledVolume: 0.01,
        remainingVolume: 0.01,
      }),
      headers: { "content-type": "application/json" },
    });
    const dashboard = await json<{
      logicalTrades: Array<{ id: string; status: string; livePositionExists?: boolean }>;
    }>(await app.request("/api/dashboard"));
    expect(
      dashboard.logicalTrades.find((trade) => trade.id === approved.logicalTradeId),
    ).toMatchObject({
      status: "OPEN",
      livePositionExists: true,
    });
    const runnerManagement = await (
      await app.request("/api/mt5/poll-line?accountId=mt5-63442826")
    ).text();
    expect(runnerManagement).toContain("commandType=MODIFY_SL");
    expect(runnerManagement).toContain("newStopLoss=4488.46");
  });

  test("holds an EXECUTED runner close when the broker remainder is not the configured lot", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: false });
    const approved = await approveGoldSellSmallRunnerLimit(app);
    await app.request("/api/mt5/report", {
      method: "POST",
      body: JSON.stringify({
        accountId: "mt5-63442826",
        queueItemId: approved.queueItemId,
        status: "EXECUTED",
        retcode: 10009,
        retcodeExternal: 0,
        brokerComment: "opened",
        orderTicket: "247694737",
        positionTicket: "247694737",
        dealTicket: "247694737",
        requestedVolume: 0.02,
        filledVolume: 0.02,
        remainingVolume: 0.02,
      }),
      headers: { "content-type": "application/json" },
    });
    await sendGoldSnapshot(app, {
      shortId: approved.shortId,
      bid: 4488,
      positions: [
        {
          ticket: "247694737",
          symbol: "XAUUSD",
          type: 1,
          volume: 0.02,
          openPrice: 4488.46,
          sl: 4494,
          tp: 0,
          profit: 0,
          magic: 26050901,
          isExternal: false,
          comment: `ttc:${approved.shortId}`,
        },
      ],
    });
    const parsed = await json<{ parsedSignalId: string }>(
      await app.request("/api/parser/parse", {
        method: "POST",
        body: JSON.stringify({
          providerId: approved.providerId,
          accountId: "mt5-63442826",
          rawText: "CLOSED - XAUUSD Sell",
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    const close = await json<{ queueItemId: string }>(
      await app.request(`/api/signals/${parsed.parsedSignalId}/approve`, { method: "POST" }),
    );
    const report = await json<{ status: string }>(
      await app.request("/api/mt5/report", {
        method: "POST",
        body: JSON.stringify({
          accountId: "mt5-63442826",
          queueItemId: close.queueItemId,
          status: "EXECUTED",
          retcode: 10009,
          retcodeExternal: 0,
          brokerComment: "runner remainder was 0.02",
          positionTicket: "247694737",
          dealTicket: "247694738",
          requestedVolume: 0.01,
          filledVolume: 0.01,
          remainingVolume: 0.02,
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(report.status).toBe("HELD");
    const dashboard = await json<{
      logicalTrades: Array<{ id: string; status: string; livePositionExists?: boolean }>;
    }>(await app.request("/api/dashboard"));
    expect(
      dashboard.logicalTrades.find((trade) => trade.id === approved.logicalTradeId),
    ).toMatchObject({ status: "OPEN", livePositionExists: true });
  });

  test("does not apply a runner enabled after a SPLIT_ORDER trade opened", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: false });
    const approved = await approveGoldSellSmallRunnerLimit(app, {
      executionMode: "SPLIT_ORDER",
      enableRunner: false,
    });
    await app.request(`/api/providers/${approved.providerId}`, {
      method: "PATCH",
      body: JSON.stringify({
        runner: { enabled: true, lotSize: 0.01, slBehavior: "break-even", trailPips: 10 },
      }),
      headers: { "content-type": "application/json" },
    });
    await app.request("/api/mt5/report", {
      method: "POST",
      body: JSON.stringify({
        accountId: "mt5-63442826",
        queueItemId: approved.queueItemId,
        status: "EXECUTED",
        retcode: 10009,
        retcodeExternal: 0,
        brokerComment: "opened",
        orderTicket: "247694736",
        positionTicket: "247694736",
        dealTicket: "247694736",
        requestedVolume: 0.02,
        filledVolume: 0.02,
        remainingVolume: 0.02,
      }),
      headers: { "content-type": "application/json" },
    });
    await sendGoldSnapshot(app, {
      shortId: approved.shortId,
      bid: 4488,
      positions: [
        {
          ticket: "247694736",
          symbol: "XAUUSD",
          type: 1,
          volume: 0.02,
          openPrice: 4488.46,
          sl: 4494,
          tp: 0,
          profit: 0,
          magic: 26050901,
          isExternal: false,
          comment: `ttc:${approved.shortId}`,
        },
      ],
    });

    const parsed = await json<{ parsedSignalId: string }>(
      await app.request("/api/parser/parse", {
        method: "POST",
        body: JSON.stringify({
          providerId: approved.providerId,
          accountId: "mt5-63442826",
          rawText: "CLOSED - XAUUSD Sell",
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    await app.request(`/api/signals/${parsed.parsedSignalId}/approve`, { method: "POST" });
    const closeWork = await (await app.request("/api/mt5/poll-line?accountId=mt5-63442826")).text();
    expect(closeWork).toContain("commandType=CLOSE_TRADE");
    expect(closeWork).toContain("executionMode=VIRTUAL_TP");
    expect(closeWork).toContain("runnerEnabled=false");
    expect(closeWork).toContain("runnerVolume=");
    expect(closeWork).not.toContain("runnerEnabled=true");
  });

  test("aborts a bound release whose HELD source row does not transition exactly once", async () => {
    // The bound requeue path never calls approveSignal, so its dedup cannot backstop a lost
    // dismissal here. Without a compare-and-swap a crash or concurrent release leaves BOTH the new
    // executable row and the original HELD row, and the leaked PENDING row is immediately leasable
    // by the EA. The trigger below makes the HELD -> DISMISSED update a silent no-op, which is
    // exactly what that race looks like from inside the transaction.
    const tempDir = await mkdtemp(join(tmpdir(), "telegram-tc-release-cas-"));
    const databasePath = join(tempDir, "app.db");
    try {
      const app = createApi({
        databasePath,
        seedDemoData: false,
        telegramAdapter: "mock",
        telegramPollingEnabled: false,
      });
      const approved = await approveGoldSellSmallRunnerLimit(app, { enableRunner: false });
      const parsed = await json<{ parsedSignalId: string }>(
        await app.request("/api/parser/parse", {
          method: "POST",
          body: JSON.stringify({
            providerId: approved.providerId,
            accountId: "mt5-63442826",
            rawText: "Cancel pending XAUUSD",
          }),
          headers: { "content-type": "application/json" },
        }),
      );
      const held = await json<{ queueItemId: string; status: string }>(
        await app.request(`/api/signals/${parsed.parsedSignalId}/approve`, { method: "POST" }),
      );
      expect(held.status).toBe("HELD");

      const setup = new Database(databasePath);
      const sourceId = held.queueItemId.replaceAll("'", "''");
      try {
        setup
          .query("UPDATE queue_items SET logical_trade_id = ? WHERE id = ?")
          .run(approved.logicalTradeId, held.queueItemId);
        setup.run(`
          CREATE TRIGGER cas_bound_release_race BEFORE UPDATE OF status ON queue_items
          WHEN OLD.id = '${sourceId}' AND NEW.status = 'DISMISSED'
          BEGIN
            SELECT RAISE(IGNORE);
          END
        `);
      } finally {
        setup.close();
      }

      const before = new Database(databasePath, { readonly: true });
      let queueCountBefore: number;
      try {
        queueCountBefore = (
          before.query("SELECT COUNT(*) AS n FROM queue_items").get() as { n: number }
        ).n;
      } finally {
        before.close();
      }

      const response = await app.request(`/api/queue-items/${held.queueItemId}/requeue`, {
        method: "POST",
        body: JSON.stringify({ mode: "original" }),
        headers: { "content-type": "application/json" },
      });
      expect(response.status).toBe(409);

      const after = new Database(databasePath, { readonly: true });
      try {
        // The whole release must have rolled back: no new queue row, source still HELD.
        expect(after.query("SELECT COUNT(*) AS n FROM queue_items").get()).toEqual({
          n: queueCountBefore,
        });
        expect(
          after.query("SELECT status FROM queue_items WHERE id = ?").get(held.queueItemId),
        ).toEqual({ status: "HELD" });
      } finally {
        after.close();
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("does not carry a runner into SPLIT_ORDER hold or requeue payloads", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "telegram-tc-split-runner-hold-"));
    const databasePath = join(tempDir, "app.db");
    try {
      const app = createApi({
        databasePath,
        seedDemoData: false,
        telegramAdapter: "mock",
        telegramPollingEnabled: false,
      });
      const approved = await approveGoldSellSmallRunnerLimit(app, {
        executionMode: "SPLIT_ORDER",
        enableRunner: false,
      });
      await app.request("/api/mt5/report", {
        method: "POST",
        body: JSON.stringify({
          accountId: "mt5-63442826",
          queueItemId: approved.queueItemId,
          status: "EXECUTED",
          retcode: 10009,
          retcodeExternal: 0,
          brokerComment: "opened",
          orderTicket: "247694739",
          positionTicket: "247694739",
          dealTicket: "247694739",
          requestedVolume: 0.02,
          filledVolume: 0.02,
          remainingVolume: 0.02,
        }),
        headers: { "content-type": "application/json" },
      });
      await app.request(`/api/providers/${approved.providerId}`, {
        method: "PATCH",
        body: JSON.stringify({
          runner: { enabled: true, lotSize: 0.01, slBehavior: "break-even", trailPips: 10 },
        }),
        headers: { "content-type": "application/json" },
      });
      const parsed = await json<{ parsedSignalId: string }>(
        await app.request("/api/parser/parse", {
          method: "POST",
          body: JSON.stringify({
            providerId: approved.providerId,
            accountId: "mt5-63442826",
            rawText: "Cancel pending XAUUSD",
          }),
          headers: { "content-type": "application/json" },
        }),
      );
      const held = await json<{ queueItemId: string; status: string }>(
        await app.request(`/api/signals/${parsed.parsedSignalId}/approve`, { method: "POST" }),
      );
      expect(held.status).toBe("HELD");

      const db = new Database(databasePath);
      const heldRow = db
        .query("SELECT payload_json FROM queue_items WHERE id = ?")
        .get(held.queueItemId) as { payload_json: string };
      const heldPayload = JSON.parse(heldRow.payload_json) as Record<string, unknown>;
      expect(heldPayload.runner).toBeUndefined();
      db.query("UPDATE queue_items SET logical_trade_id = ?, payload_json = ? WHERE id = ?").run(
        approved.logicalTradeId,
        JSON.stringify({
          ...heldPayload,
          executionMode: "SPLIT_ORDER",
          runner: { enabled: true, lotSize: 0.01, slBehavior: "break-even", trailPips: 10 },
        }),
        held.queueItemId,
      );
      db.close();

      const requeued = await json<{ queueItemId: string }>(
        await app.request(`/api/queue-items/${held.queueItemId}/requeue`, {
          method: "POST",
          body: JSON.stringify({ mode: "original" }),
          headers: { "content-type": "application/json" },
        }),
      );
      const requeueDb = new Database(databasePath, { readonly: true });
      try {
        const row = requeueDb
          .query("SELECT payload_json FROM queue_items WHERE id = ?")
          .get(requeued.queueItemId) as { payload_json: string };
        expect(JSON.parse(row.payload_json).runner).toBeUndefined();
      } finally {
        requeueDb.close();
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("uses planned TP volume when small runner allocation would round below broker minimum", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: false });
    const approved = await approveGoldSellSmallRunnerLimit(app);
    await app.request("/api/mt5/report", {
      method: "POST",
      body: JSON.stringify({
        accountId: "mt5-63442826",
        queueItemId: approved.queueItemId,
        status: "EXECUTED",
        retcode: 10009,
        retcodeExternal: 0,
        brokerComment: "Request executed",
        orderTicket: "247694735",
        positionTicket: "0",
        dealTicket: "0",
        requestedPrice: 4488,
        filledPrice: 0,
        volume: 0.02,
        errorText: "",
      }),
      headers: { "content-type": "application/json" },
    });
    await app.request("/api/mt5/history", {
      method: "POST",
      body: JSON.stringify({
        accountId: "mt5-63442826",
        deals: [
          {
            dealTicket: "244348195",
            orderTicket: "247694735",
            positionTicket: "247694735",
            entry: "0",
            reason: 3,
            symbol: "XAUUSD",
            price: 4488.46,
            volume: 0.02,
            profit: 0,
            commission: 0,
            swap: 0,
            comment: `ttc:${approved.shortId}`,
            time: "2026.05.20 11:30:10",
          },
        ],
      }),
      headers: { "content-type": "application/json" },
    });

    await sendGoldSnapshot(app, {
      shortId: approved.shortId,
      bid: 4482.6,
      positions: [
        {
          ticket: "247694735",
          symbol: "XAUUSD",
          type: 1,
          volume: 0.02,
          openPrice: 4488.46,
          sl: 4494,
          tp: 0,
          profit: 11,
          magic: 26050901,
          isExternal: false,
          comment: `ttc:${approved.shortId}`,
        },
      ],
    });

    const closeWork = await (await app.request("/api/mt5/poll-line?accountId=mt5-63442826")).text();
    expect(closeWork).toContain("commandType=CLOSE_PARTIAL");
    expect(closeWork).toContain("partialCloseKind=TP_LEG");
    expect(closeWork).toContain("partialCloseValue=1");
    expect(closeWork).toContain("partialCloseVolume=0.01");
    expect(closeWork).toContain("targetPositionTicket=247694735");
  });

  test("does not queue a virtual TP close when the broker fill is fully reserved for the runner", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: false });
    const providerId = await configureProviderWithAccount(app, { availableSymbols: ["XAUUSD"] });
    await app.request(`/api/providers/${providerId}`, {
      method: "PATCH",
      body: JSON.stringify({
        riskMode: "fixed",
        riskAmount: 0.04,
        runner: { enabled: true, lotSize: 0.02, slBehavior: "break-even", trailPips: 10 },
        takeProfitLevels: [
          { leg: 1, percentage: 25, strategy: { kind: "set-sl-to-entry", offsetPips: 0 } },
          { leg: 2, percentage: 25, strategy: { kind: "no-change" } },
          { leg: 3, percentage: 25, strategy: { kind: "no-change" } },
          { leg: 4, percentage: 25, strategy: { kind: "no-change" } },
        ],
      }),
      headers: { "content-type": "application/json" },
    });
    const parsed = await json<{ parsedSignalId: string }>(
      await app.request("/api/parser/parse", {
        method: "POST",
        body: JSON.stringify({
          providerId,
          accountId: "mt5-63442826",
          rawText: "Gold sell limit\n\n4488-89\n\nSL 4494\n\nTP 4483\nTP 4476\nTP 4468\nTP 4454",
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    const approved = await json<{ queueItemId: string; logicalTradeId: string }>(
      await app.request(`/api/signals/${parsed.parsedSignalId}/approve`, { method: "POST" }),
    );
    const shortId = approved.logicalTradeId.replace(/^trade[_-]/, "");
    await app.request("/api/mt5/report", {
      method: "POST",
      body: JSON.stringify({
        accountId: "mt5-63442826",
        queueItemId: approved.queueItemId,
        status: "EXECUTED",
        retcode: 10009,
        retcodeExternal: 0,
        brokerComment: "Request executed",
        orderTicket: "247694736",
        positionTicket: "0",
        dealTicket: "0",
        requestedPrice: 4488,
        filledPrice: 0,
        volume: 0.04,
        errorText: "",
      }),
      headers: { "content-type": "application/json" },
    });
    await app.request("/api/mt5/history", {
      method: "POST",
      body: JSON.stringify({
        accountId: "mt5-63442826",
        deals: [
          {
            dealTicket: "244348196",
            orderTicket: "247694736",
            positionTicket: "247694736",
            entry: "0",
            reason: 3,
            symbol: "XAUUSD",
            price: 4488.46,
            volume: 0.02,
            profit: 0,
            commission: 0,
            swap: 0,
            comment: `ttc:${shortId}`,
            time: "2026.05.20 11:30:10",
          },
        ],
      }),
      headers: { "content-type": "application/json" },
    });

    await sendGoldSnapshot(app, {
      shortId,
      bid: 4482.6,
      positions: [
        {
          ticket: "247694736",
          symbol: "XAUUSD",
          type: 1,
          volume: 0.02,
          openPrice: 4488.46,
          sl: 4494,
          tp: 0,
          profit: 11,
          magic: 26050901,
          isExternal: false,
          comment: `ttc:${shortId}`,
        },
      ],
    });

    const noWork = await (await app.request("/api/mt5/poll-line?accountId=mt5-63442826")).text();
    expect(noWork).toContain("status=NO_WORK");
  });

  test("keeps a history close partial when it only covers one of several open fills", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: false });
    const approved = await approveGoldBuyLimit(app);
    await reportPendingAccepted(app, approved);
    await app.request("/api/mt5/history", {
      method: "POST",
      body: JSON.stringify({
        accountId: "mt5-63442826",
        deals: [
          {
            dealTicket: "244236611",
            orderTicket: "247596888",
            positionTicket: "247596888",
            entry: "0",
            reason: 3,
            symbol: "XAUUSD",
            price: 4540.9,
            volume: 0.03,
            profit: 0,
            commission: 0,
            swap: 0,
            comment: `ttc:${approved.shortId}`,
            time: "2026.05.18 18:01:12",
          },
          {
            dealTicket: "244236612",
            orderTicket: "247596889",
            positionTicket: "247596888",
            entry: "0",
            reason: 3,
            symbol: "XAUUSD",
            price: 4540.95,
            volume: 0.02,
            profit: 0,
            commission: 0,
            swap: 0,
            comment: `ttc:${approved.shortId}`,
            time: "2026.05.18 18:01:13",
          },
        ],
      }),
      headers: { "content-type": "application/json" },
    });
    await sendGoldSnapshot(app, {
      shortId: approved.shortId,
      bid: 4542,
      positions: [
        {
          ticket: "247596888",
          symbol: "XAUUSD",
          type: 0,
          volume: 0.02,
          openPrice: 4540.9,
          sl: 4535,
          tp: 0,
          profit: 5,
          magic: 26050901,
          isExternal: false,
          comment: `ttc:${approved.shortId}`,
        },
      ],
    });

    await app.request("/api/mt5/history", {
      method: "POST",
      body: JSON.stringify({
        accountId: "mt5-63442826",
        deals: [
          {
            dealTicket: "244236870",
            orderTicket: "247597475",
            positionTicket: "247596888",
            entry: "1",
            reason: 5,
            symbol: "XAUUSD",
            price: 4546,
            volume: 0.03,
            profit: 15,
            commission: 0,
            swap: 0,
            comment: "[tp 4546.00]",
            time: "2026.05.18 18:02:27",
          },
        ],
      }),
      headers: { "content-type": "application/json" },
    });

    const dashboard = await json<{ logicalTrades: Array<{ id: string; status: string }> }>(
      await app.request("/api/dashboard"),
    );
    expect(
      dashboard.logicalTrades.find((trade) => trade.id === approved.logicalTradeId)?.status,
    ).toBe("OPEN");
  });

  test("confirms app-managed TP1 close before queueing the configured SL move", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: false });
    const approved = await approveGoldBuyLimit(app);
    await reportPendingAccepted(app, approved);
    await reportGoldFill(app, approved);
    await sendGoldSnapshot(app, { shortId: approved.shortId, bid: 4546.2 });

    const closeWork = await (await app.request("/api/mt5/poll-line?accountId=mt5-63442826")).text();
    const closeQueueId = closeWork.match(/queueItemId=([^\n]+)/)?.[1];
    expect(closeQueueId).toBeTruthy();

    await app.request("/api/mt5/report", {
      method: "POST",
      body: JSON.stringify({
        accountId: "mt5-63442826",
        queueItemId: closeQueueId,
        status: "EXECUTED",
        retcode: 10009,
        retcodeExternal: 0,
        brokerComment: `ttc:${approved.shortId}:tp1`,
        orderTicket: "247597001",
        positionTicket: "247596888",
        dealTicket: "244236700",
        requestedPrice: 4546,
        filledPrice: 4546,
        volume: 0.01,
        errorText: "",
      }),
      headers: { "content-type": "application/json" },
    });

    const dashboard = await json<{
      logicalTrades: Array<{ id: string; legs: Array<{ leg: number; status: string }> }>;
    }>(await app.request("/api/dashboard"));
    expect(
      dashboard.logicalTrades
        .find((trade) => trade.id === approved.logicalTradeId)
        ?.legs.map((leg) => [leg.leg, leg.status]),
    ).toEqual([
      [1, "CLOSED"],
      [2, "OPEN"],
      [3, "OPEN"],
      [4, "OPEN"],
    ]);

    const slWork = await (await app.request("/api/mt5/poll-line?accountId=mt5-63442826")).text();
    expect(slWork).toContain("commandType=MODIFY_SL");
    expect(slWork).toContain("newStopLoss=4540.9");
    expect(slWork).toContain("targetPositionTicket=247596888");
  });

  test("reconciles an SL history close before TP confirmation without marking TP1 closed or failed", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: false });
    const approved = await approveGoldBuyLimit(app);
    await reportPendingAccepted(app, approved);
    await reportGoldFill(app, approved);

    await app.request("/api/mt5/history", {
      method: "POST",
      body: JSON.stringify({
        accountId: "mt5-63442826",
        deals: [
          {
            dealTicket: "244236869",
            orderTicket: "247597474",
            positionTicket: "247596888",
            entry: "1",
            reason: 4,
            symbol: "XAUUSD",
            price: 4534.73,
            volume: 0.04,
            profit: -24.68,
            commission: 0,
            swap: 0,
            comment: "[sl 4535.00]",
            time: "2026.05.18 18:02:27",
          },
        ],
      }),
      headers: { "content-type": "application/json" },
    });

    const dashboard = await json<{
      logicalTrades: Array<{
        id: string;
        status: string;
        legs: Array<{ leg: number; status: string }>;
      }>;
    }>(await app.request("/api/dashboard"));
    expect(
      dashboard.logicalTrades.find((trade) => trade.id === approved.logicalTradeId),
    ).toMatchObject({
      status: "CLOSED",
      legs: [
        { leg: 1, status: "SKIPPED" },
        { leg: 2, status: "SKIPPED" },
        { leg: 3, status: "SKIPPED" },
        { leg: 4, status: "SKIPPED" },
      ],
    });
  });

  test("classifies stale-snapshot SL history as a full close when the deal covers the open volume", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: false });
    const approved = await approveGoldBuyLimit(app);
    await reportPendingAccepted(app, approved);
    await reportGoldFill(app, approved);
    await sendGoldSnapshot(app, { shortId: approved.shortId, bid: 4542 });

    await app.request("/api/mt5/history", {
      method: "POST",
      body: JSON.stringify({
        accountId: "mt5-63442826",
        deals: [
          {
            dealTicket: "244236870",
            orderTicket: "247597475",
            positionTicket: "247596888",
            entry: "1",
            reason: 4,
            symbol: "XAUUSD",
            price: 4534.73,
            volume: 0.04,
            profit: -24.68,
            commission: 0,
            swap: 0,
            comment: "[sl 4535.00]",
            time: "2026.05.18 18:02:27",
          },
        ],
      }),
      headers: { "content-type": "application/json" },
    });

    await sendGoldSnapshot(app, {
      shortId: approved.shortId,
      bid: 4534,
      positions: [],
      orders: [],
    });

    const dashboard = await json<{
      logicalTrades: Array<{
        id: string;
        status: string;
        legs: Array<{ leg: number; status: string }>;
      }>;
    }>(await app.request("/api/dashboard"));
    expect(
      dashboard.logicalTrades.find((trade) => trade.id === approved.logicalTradeId),
    ).toMatchObject({
      status: "CLOSED",
      legs: [
        { leg: 1, status: "SKIPPED" },
        { leg: 2, status: "SKIPPED" },
        { leg: 3, status: "SKIPPED" },
        { leg: 4, status: "SKIPPED" },
      ],
    });

    const trail = await json<{
      orders: Array<{ action: string; dealTicket: string; source: string }>;
    }>(await app.request(`/api/trades/${approved.logicalTradeId}/broker-orders`));
    expect(trail.orders.find((order) => order.dealTicket === "244236870")).toMatchObject({
      action: "FULL_CLOSE",
      source: "sl-hit",
    });
  });

  test("closes remaining virtual-TP volume from SL history after TP1 even when the snapshot is stale", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: false });
    const approved = await approveGoldBuyLimit(app);
    await reportPendingAccepted(app, approved);
    await reportGoldFill(app, approved);
    await sendGoldSnapshot(app, { shortId: approved.shortId, bid: 4546.2 });

    const closeWork = await (await app.request("/api/mt5/poll-line?accountId=mt5-63442826")).text();
    const closeQueueId = closeWork.match(/queueItemId=([^\n]+)/)?.[1];
    expect(closeQueueId).toBeTruthy();
    await app.request("/api/mt5/report", {
      method: "POST",
      body: JSON.stringify({
        accountId: "mt5-63442826",
        queueItemId: closeQueueId,
        status: "EXECUTED",
        retcode: 10009,
        retcodeExternal: 0,
        brokerComment: `ttc:${approved.shortId}:tp1`,
        orderTicket: "247597001",
        positionTicket: "247596888",
        dealTicket: "244236700",
        requestedPrice: 4546,
        filledPrice: 4546,
        volume: 0.01,
        errorText: "",
      }),
      headers: { "content-type": "application/json" },
    });
    await sendGoldSnapshot(app, {
      shortId: approved.shortId,
      bid: 4534,
      positions: [
        {
          ticket: "247596888",
          symbol: "XAUUSD",
          type: 0,
          volume: 0.03,
          openPrice: 4540.9,
          sl: 4535,
          tp: 0,
          profit: -20,
          magic: 26050901,
          isExternal: false,
          comment: `ttc:${approved.shortId}`,
        },
      ],
    });

    await app.request("/api/mt5/history", {
      method: "POST",
      body: JSON.stringify({
        accountId: "mt5-63442826",
        deals: [
          {
            dealTicket: "244236871",
            orderTicket: "247597476",
            positionTicket: "247596888",
            entry: "1",
            reason: 4,
            symbol: "XAUUSD",
            price: 4534.73,
            volume: 0.03,
            profit: -18.51,
            commission: 0,
            swap: 0,
            comment: "[sl 4535.00]",
            time: "2026.05.18 18:03:27",
          },
        ],
      }),
      headers: { "content-type": "application/json" },
    });

    await sendGoldSnapshot(app, {
      shortId: approved.shortId,
      bid: 4534,
      positions: [],
      orders: [],
    });

    const dashboard = await json<{
      logicalTrades: Array<{
        id: string;
        status: string;
        legs: Array<{ leg: number; status: string }>;
      }>;
    }>(await app.request("/api/dashboard"));
    expect(
      dashboard.logicalTrades
        .find((trade) => trade.id === approved.logicalTradeId)
        ?.legs.map((leg) => [leg.leg, leg.status]),
    ).toEqual([
      [1, "CLOSED"],
      [2, "SKIPPED"],
      [3, "SKIPPED"],
      [4, "SKIPPED"],
    ]);
    expect(
      dashboard.logicalTrades.find((trade) => trade.id === approved.logicalTradeId)?.status,
    ).toBe("CLOSED");
  });

  test("closed rollups ignore pending-order acceptance rows after the order fills", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: false });
    const approved = await approveGoldBuyLimit(app);
    await reportPendingAccepted(app, approved);
    await reportGoldFill(app, approved);

    await app.request("/api/mt5/history", {
      method: "POST",
      body: JSON.stringify({
        accountId: "mt5-63442826",
        deals: [
          {
            dealTicket: "244236869",
            orderTicket: "247597474",
            positionTicket: "247596888",
            entry: "1",
            reason: 4,
            symbol: "XAUUSD",
            price: 4534.73,
            volume: 0.04,
            profit: -24.68,
            commission: 0,
            swap: 0,
            comment: "[sl 4535.00]",
            time: "2026.05.18 18:02:27",
          },
        ],
      }),
      headers: { "content-type": "application/json" },
    });

    const dashboard = await json<{
      mt5Accounts: Array<{
        id: string;
        closedTrades: Array<{
          tradeId: string;
          ticket: string;
          volume: number;
          openPrice: number;
          closePrice: number;
          realizedPnl: number;
          result: string;
        }>;
      }>;
    }>(await app.request("/api/dashboard"));
    const account = dashboard.mt5Accounts.find((item) => item.id === "mt5-63442826");
    const closed = account?.closedTrades.find((trade) => trade.tradeId === approved.logicalTradeId);
    expect(closed).toMatchObject({
      ticket: "247596888",
      volume: 0.04,
      openPrice: 4540.9,
      closePrice: 4534.73,
      realizedPnl: -24.68,
      result: "SL hit",
    });
  });

  test("records provider-announced TP hits without queueing unsupported MT5 work", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: true });
    const lease = await json<{ item: { id: string } | null }>(
      await app.request("/api/mt5/poll?accountId=mt5-100200300"),
    );
    await app.request("/api/mt5/report", {
      method: "POST",
      body: JSON.stringify({
        accountId: "mt5-100200300",
        queueItemId: lease.item!.id,
        status: "EXECUTED",
        retcode: 10009,
        retcodeExternal: 0,
        brokerComment: "Request completed",
        orderTicket: "50001",
        dealTicket: "60001",
        requestedPrice: 1.085,
        filledPrice: 1.0851,
        volume: 0.1,
        errorText: "",
      }),
      headers: { "content-type": "application/json" },
    });

    const parsed = await json<{ parsedSignalId: string; result: { commandType: string } }>(
      await app.request("/api/parser/parse", {
        method: "POST",
        body: JSON.stringify({ providerId: "provider-alpha", rawText: "TP 1" }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(parsed.result.commandType).toBe("MARK_TP_HIT");

    const approval = await json<{ logicalTradeId: string; status: string }>(
      await app.request(`/api/signals/${parsed.parsedSignalId}/approve`, { method: "POST" }),
    );
    expect(approval).toMatchObject({ logicalTradeId: "trade-demo-1", status: "RECORDED" });

    const dashboard = await json<{
      logicalTrades: Array<{ id: string; legs: Array<{ leg: number; status: string }> }>;
    }>(await app.request("/api/dashboard"));
    expect(
      dashboard.logicalTrades
        .find((item) => item.id === "trade-demo-1")
        ?.legs.map((leg) => [leg.leg, leg.status]),
    ).toEqual([
      [1, "HIT"],
      [2, "OPEN"],
      [3, "OPEN"],
      [4, "OPEN"],
    ]);

    const noWork = await (await app.request("/api/mt5/poll-line?accountId=mt5-100200300")).text();
    expect(noWork).toContain("status=NO_WORK");
  });

  test("keeps live PnL in memory while persisting only structural snapshot changes", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "telegram-tc-live-snapshot-"));
    const databasePath = join(tempDir, "app.db");
    try {
      const app = createApi({ databasePath, seedDemoData: false });
      await app.request("/api/mt5/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          accountNumber: "100200300",
          server: "MetaQuotes-Demo",
          company: "MetaQuotes",
          currency: "USD",
          balance: 10000,
          equity: 10000,
          marginMode: "HEDGING",
          availableSymbols: ["XAUUSD"],
        }),
      });
      const sendSnapshot = (profit: number, bid: number, stopLoss: number, point = 0.01) =>
        app.request("/api/mt5/snapshot", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            accountId: "mt5-100200300",
            positions: [
              {
                ticket: "50001",
                symbol: "XAUUSD",
                volume: 0.1,
                openPrice: 2400,
                sl: stopLoss,
                tp: 2450,
                profit,
                isExternal: false,
              },
            ],
            orders: [],
            symbols: [
              {
                symbol: "XAUUSD",
                bid,
                ask: bid + 0.02,
                timeMsc: Date.now(),
                point,
                digits: point === 0.01 ? 2 : 3,
              },
            ],
          }),
        });

      await sendSnapshot(10, 2410, 2380);
      await sendSnapshot(25, 2415, 2380);

      let db = new Database(databasePath, { readonly: true });
      let persisted = db
        .query("SELECT positions_json, symbols_json FROM mt5_snapshots WHERE account_id = ?")
        .get("mt5-100200300") as { positions_json: string; symbols_json: string };
      db.close();
      expect(JSON.parse(persisted.positions_json)[0].profit).toBe(10);
      expect(JSON.parse(persisted.symbols_json)[0].bid).toBe(2410);

      const dashboard = await json<{
        mt5Accounts: Array<{
          appPositions: Array<{ profit: number }>;
          symbols: Array<{ bid: number }>;
        }>;
      }>(await app.request("/api/dashboard"));
      expect(dashboard.mt5Accounts[0]?.appPositions[0]?.profit).toBe(25);
      expect(dashboard.mt5Accounts[0]?.symbols[0]?.bid).toBe(2415);

      await sendSnapshot(30, 2420, 2390, 0.001);
      db = new Database(databasePath, { readonly: true });
      persisted = db
        .query("SELECT positions_json, symbols_json FROM mt5_snapshots WHERE account_id = ?")
        .get("mt5-100200300") as { positions_json: string; symbols_json: string };
      const metadata = db
        .query("SELECT point, digits FROM symbol_metadata WHERE account_id = ? AND symbol = ?")
        .get("mt5-100200300", "XAUUSD") as { point: number; digits: number };
      db.close();
      expect(JSON.parse(persisted.positions_json)[0]).toMatchObject({ profit: 30, sl: 2390 });
      expect(JSON.parse(persisted.symbols_json)[0].bid).toBe(2420);
      expect(metadata).toMatchObject({ point: 0.001, digits: 3 });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("persists MT5 snapshots and marks logical trades out of sync when broker state is missing", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: true });
    const lease = await json<{ item: { id: string } | null }>(
      await app.request("/api/mt5/poll?accountId=mt5-100200300"),
    );
    await app.request("/api/mt5/report", {
      method: "POST",
      body: JSON.stringify({
        accountId: "mt5-100200300",
        queueItemId: lease.item!.id,
        status: "EXECUTED",
        retcode: 10009,
        retcodeExternal: 0,
        brokerComment: "Request completed",
        orderTicket: "50001",
        dealTicket: "60001",
        requestedPrice: 1.085,
        filledPrice: 1.0851,
        volume: 0.1,
        errorText: "",
      }),
      headers: { "content-type": "application/json" },
    });

    await app.request("/api/mt5/snapshot", {
      method: "POST",
      body: JSON.stringify({
        accountId: "mt5-100200300",
        positions: [
          {
            ticket: "50001",
            symbol: "EURUSD.raw",
            volume: 0.1,
            comment: "telegram-tc:trade-demo-1",
          },
        ],
        orders: [],
        symbols: [],
      }),
      headers: { "content-type": "application/json" },
    });

    const synced = await json<{
      mt5Accounts: Array<{
        openPositionCount: number;
        pendingOrderCount: number;
        lastSnapshotAt?: string;
      }>;
      logicalTrades: Array<{
        id: string;
        status: string;
        outOfSyncReason?: string;
        livePositionExists?: boolean;
        matchedBrokerTickets?: string[];
        brokerComment?: string;
        lastSnapshotAt?: string;
      }>;
    }>(await app.request("/api/dashboard"));
    expect(synced.mt5Accounts[0]).toMatchObject({
      openPositionCount: 1,
      pendingOrderCount: 0,
    });
    expect(synced.mt5Accounts[0]!.lastSnapshotAt).toBeTruthy();
    expect(synced.logicalTrades.find((trade) => trade.id === "trade-demo-1")?.status).toBe("OPEN");

    await app.request("/api/mt5/snapshot", {
      method: "POST",
      body: JSON.stringify({
        accountId: "mt5-100200300",
        positions: [
          {
            ticket: "50001",
            symbol: "EURUSD.raw",
            volume: 0.1,
            comment: "telegram-tc-virtual-tp:trade-de",
          },
        ],
        orders: [],
        symbols: [],
      }),
      headers: { "content-type": "application/json" },
    });

    const truncated = await json<{
      logicalTrades: Array<{
        id: string;
        status: string;
        outOfSyncReason?: string;
        livePositionExists?: boolean;
        matchedBrokerTickets?: string[];
        brokerComment?: string;
        lastSnapshotAt?: string;
      }>;
    }>(await app.request("/api/dashboard"));
    expect(truncated.logicalTrades.find((trade) => trade.id === "trade-demo-1")).toMatchObject({
      status: "OPEN",
      livePositionExists: true,
      matchedBrokerTickets: ["50001"],
      brokerComment: "telegram-tc-virtual-tp:trade-de",
      outOfSyncReason: "Live broker position exists, but EA tracking comment is truncated",
    });
    expect(
      truncated.logicalTrades.find((trade) => trade.id === "trade-demo-1")?.lastSnapshotAt,
    ).toBeTruthy();

    await app.request("/api/mt5/snapshot", {
      method: "POST",
      body: JSON.stringify({
        accountId: "mt5-100200300",
        positions: [],
        orders: [],
        symbols: [],
      }),
      headers: { "content-type": "application/json" },
    });

    const missing = await json<{
      logicalTrades: Array<{
        id: string;
        status: string;
        outOfSyncReason?: string;
        livePositionExists?: boolean;
      }>;
    }>(await app.request("/api/dashboard"));
    expect(missing.logicalTrades.find((trade) => trade.id === "trade-demo-1")).toMatchObject({
      status: "OUT_OF_SYNC",
      livePositionExists: false,
      outOfSyncReason: "No matching broker position or order found in latest MT5 snapshot",
    });
  });

  test("cancels accepted pending orders that disappear from broker snapshots", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: false });
    const approved = await approveGoldBuyLimit(app);
    const originalDateNow = Date.now;
    await app.request("/api/mt5/report", {
      method: "POST",
      body: JSON.stringify({
        accountId: "mt5-63442826",
        queueItemId: approved.queueItemId,
        status: "EXECUTED",
        retcode: 10009,
        retcodeExternal: 0,
        brokerComment: "Request executed",
        orderTicket: "70001",
        positionTicket: "0",
        dealTicket: "0",
        requestedPrice: 4541,
        filledPrice: 0,
        volume: 0.04,
        errorText: "",
      }),
      headers: { "content-type": "application/json" },
    });

    try {
      await app.request("/api/mt5/snapshot", {
        method: "POST",
        body: JSON.stringify({
          accountId: "mt5-63442826",
          positions: [],
          orders: [],
          symbols: [],
        }),
        headers: { "content-type": "application/json" },
      });

      const immediate = await json<{
        logicalTrades: Array<{ id: string; status: string; legs: Array<{ status: string }> }>;
      }>(await app.request("/api/dashboard"));
      expect(
        immediate.logicalTrades.find((item) => item.id === approved.logicalTradeId)?.status,
      ).not.toBe("CANCELLED");

      Date.now = () => originalDateNow() + 60_000;
      await app.request("/api/mt5/snapshot", {
        method: "POST",
        body: JSON.stringify({
          accountId: "mt5-63442826",
          positions: [],
          orders: [],
          symbols: [],
        }),
        headers: { "content-type": "application/json" },
      });

      const dashboard = await json<{
        logicalTrades: Array<{
          id: string;
          status: string;
          outOfSyncReason?: string;
          livePositionExists?: boolean;
          legs: Array<{ status: string }>;
        }>;
      }>(await app.request("/api/dashboard"));
      const trade = dashboard.logicalTrades.find((item) => item.id === approved.logicalTradeId);
      expect(trade).toMatchObject({
        status: "CANCELLED",
        livePositionExists: false,
      });
      expect(trade?.outOfSyncReason).toBeUndefined();
      expect(trade?.legs.every((leg) => leg.status === "SKIPPED")).toBe(true);
    } finally {
      Date.now = originalDateNow;
    }
  });

  test("holds stale open-trade Telegram replays as EXPIRED_LATE", async () => {
    const oldMessageDate = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const telegram = createQueuedTelegramAdapter([
      {
        telegramMessageId: "old-gold-1",
        messageDate: oldMessageDate,
        rawText: "Gold buy limit\n\n4541-40\n\nSL 4535\n\nTP 4546\nTP 4553",
      },
    ]);
    const app = createApi({
      databasePath: ":memory:",
      seedDemoData: false,
      telegram,
      telegramPollingEnabled: false,
    });
    await configureProviderWithAccount(app, { availableSymbols: ["XAUUSD"] });
    await app.request("/api/settings", {
      method: "PATCH",
      body: JSON.stringify({ maxOpenTradeAgeSeconds: 30 * 60 }),
      headers: { "content-type": "application/json" },
    });

    const result = await app.runTelegramIngestionOnce();
    const dashboard = await json<{
      signalQueue: Array<{ status: string; commandType: string }>;
      logicalTrades: Array<{ status: string }>;
    }>(await app.request("/api/dashboard"));

    expect(result.queued).toBe(0);
    expect(dashboard.signalQueue).toContainEqual(
      expect.objectContaining({ commandType: "OPEN_TRADE", status: "HELD" }),
    );
    expect(dashboard.signalQueue.filter((item) => item.status === "PENDING")).toHaveLength(0);
    expect(dashboard.logicalTrades).toHaveLength(0);
    const held = await json<{ items: Array<{ heldReason: string }> }>(
      await app.request("/api/queue-items/held"),
    );
    expect(held.items).toContainEqual(expect.objectContaining({ heldReason: "EXPIRED_LATE" }));
  });

  test("expires parsed signal state when stale open-trade queue work expires", async () => {
    const oldMessageDate = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const telegram = createQueuedTelegramAdapter([
      {
        telegramMessageId: "old-gold-queued",
        messageDate: oldMessageDate,
        rawText: "Gold buy limit\n\n4541-40\n\nSL 4535\n\nTP 4546\nTP 4553",
      },
    ]);
    const app = createApi({
      databasePath: ":memory:",
      seedDemoData: false,
      telegram,
      telegramPollingEnabled: false,
    });
    await configureProviderWithAccount(app, { availableSymbols: ["XAUUSD"] });

    const result = await app.runTelegramIngestionOnce();
    expect(result.queued).toBe(1);

    const beforeExpiry = await json<{
      signals: Array<{ id: string; status: string; result: { commandType: string } }>;
    }>(await app.request("/api/signals"));
    const parsedSignalId = beforeExpiry.signals.find(
      (signal) => signal.result.commandType === "OPEN_TRADE",
    )?.id;
    expect(parsedSignalId).toBeTruthy();

    await app.request("/api/settings", {
      method: "PATCH",
      body: JSON.stringify({ maxOpenTradeAgeSeconds: 30 * 60 }),
      headers: { "content-type": "application/json" },
    });

    const signals = await json<{
      signals: Array<{ id: string; status: string }>;
      queue: Array<{ status: string; payload: { commandType: string } }>;
    }>(await app.request("/api/signals"));

    expect(signals.signals).toContainEqual(
      expect.objectContaining({ id: parsedSignalId, status: "HELD" }),
    );
    expect(signals.queue).toContainEqual(
      expect.objectContaining({
        payload: expect.objectContaining({ commandType: "OPEN_TRADE" }),
        status: "HELD",
      }),
    );
  });

  test("exposes a line-oriented MT5 poll payload for the MQL5 expert advisor", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: true });

    const response = await app.request("/api/mt5/poll-line?accountId=mt5-100200300");
    const payload = await response.text();

    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(payload).toContain("queueItemId=queue-demo-1");
    expect(payload).toContain("commandType=OPEN_TRADE");
    expect(payload).toContain("brokerSymbol=EURUSD.raw");
    expect(payload).toContain("tp1=1.09");
    expect(payload).toContain("executionMode=VIRTUAL_TP");
  });

  test("can drive Telegram dialogs and recent-message capture through a real adapter boundary", async () => {
    const calls: string[] = [];
    const telegram: TelegramAdapter = {
      name: "fake-real",
      async startLogin(input) {
        calls.push(`start:${input.phone}`);
        return { status: "CODE_REQUIRED", isCodeViaApp: true };
      },
      async submitCode(sessionId, code) {
        calls.push(`code:${sessionId}:${code}`);
        return { status: "CONNECTED" };
      },
      async submitPassword(sessionId) {
        calls.push(`password:${sessionId}`);
        return { status: "CONNECTED" };
      },
      async disconnect(sessionId) {
        calls.push(`disconnect:${sessionId}`);
      },
      async listDialogs(sessionId) {
        calls.push(`dialogs:${sessionId}`);
        return [
          {
            id: "real-dialog-1",
            title: "Real FX Channel",
            type: "channel",
            unreadCount: 7,
          },
        ];
      },
      async fetchRecentMessages(sessionId, dialogId, limit) {
        calls.push(`messages:${sessionId}:${dialogId}:${limit}`);
        return {
          messages: [
            {
              telegramMessageId: "555",
              messageDate: "2026-05-09T08:00:00.000Z",
              rawText: "SELL XAUUSD 2365\nSL 2375\nTP1 2350",
              senderName: "Real FX Channel",
            },
          ],
          gap: undefined,
        };
      },
    };
    const app = createApi({ databasePath: ":memory:", seedDemoData: false, telegram });

    const start = await app.request("/api/telegram/start", {
      method: "POST",
      body: JSON.stringify({ apiId: "12345", apiHash: "secret", phone: "+27820000000" }),
      headers: { "content-type": "application/json" },
    });
    const started = await json<{ profileId: string; sessionId: string; status: string }>(start);
    expect(started.status).toBe("CODE_REQUIRED");

    await app.request("/api/telegram/verify-code", {
      method: "POST",
      body: JSON.stringify({ sessionId: started.sessionId, code: "12345" }),
      headers: { "content-type": "application/json" },
    });

    const dialogs = await json<{
      dialogs: Array<{ id: string; title: string; type: string; unreadCount: number }>;
    }>(await app.request(`/api/telegram/dialogs?profileId=${started.profileId}`));
    expect(dialogs.dialogs[0]).toEqual({
      id: "real-dialog-1",
      title: "Real FX Channel",
      type: "channel",
      unreadCount: 7,
    });

    const provider = await json<{ provider: { id: string } }>(
      await app.request("/api/providers", {
        method: "POST",
        body: JSON.stringify({
          profileId: started.profileId,
          dialogId: "real-dialog-1",
          title: "Real FX Channel",
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    const messages = await json<{
      messages: Array<{ rawText: string; telegramMessageId: string }>;
    }>(await app.request(`/api/providers/${provider.provider.id}/messages?limit=1`));
    const parsedRecent = await json<{
      parsed: Array<{ result: { commandType: string; brokerSymbol: string } }>;
      provider: {
        providerId: string;
        captured: number;
        inserted: number;
        parsed: number;
        error?: string;
      };
    }>(
      await app.request(`/api/providers/${provider.provider.id}/parse-recent?limit=1`, {
        method: "POST",
      }),
    );

    expect(messages.messages[0]?.rawText).toContain("SELL XAUUSD");
    expect(messages.messages[0]?.telegramMessageId).toBe("555");
    expect(parsedRecent.parsed[0]?.result).toMatchObject({
      commandType: "OPEN_TRADE",
      brokerSymbol: "XAUUSD",
    });
    expect(parsedRecent.provider).toMatchObject({
      providerId: provider.provider.id,
      captured: 1,
      parsed: 1,
    });
    expect(parsedRecent.provider.error).toBeUndefined();
    expect(calls).toContain(`messages:${started.sessionId}:real-dialog-1:1`);
  });

  test("keeps Telegram provider selection stable when the same dialog is selected twice", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: false });
    const start = await json<{ profileId: string; sessionId: string }>(
      await app.request("/api/telegram/start", {
        method: "POST",
        body: JSON.stringify({ apiId: "12345", apiHash: "secret", phone: "+27820000000" }),
        headers: { "content-type": "application/json" },
      }),
    );
    await app.request("/api/telegram/verify-code", {
      method: "POST",
      body: JSON.stringify({ sessionId: start.sessionId, code: "12345" }),
      headers: { "content-type": "application/json" },
    });

    const first = await json<{ provider: { id: string } }>(
      await app.request("/api/providers", {
        method: "POST",
        body: JSON.stringify({
          profileId: start.profileId,
          dialogId: "dialog-gold",
          title: "Gold Room London",
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    const second = await json<{ provider: { id: string } }>(
      await app.request("/api/providers", {
        method: "POST",
        body: JSON.stringify({
          profileId: start.profileId,
          dialogId: "dialog-gold",
          title: "Gold Room London",
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    const providers = await json<{ providers: Array<{ dialogId: string }> }>(
      await app.request("/api/providers"),
    );

    expect(second.provider.id).toBe(first.provider.id);
    expect(
      providers.providers.filter((provider) => provider.dialogId === "dialog-gold"),
    ).toHaveLength(1);
  });

  test("does not insert the hidden demo provider when a real Telegram session connects", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: false });
    const start = await json<{ profileId: string; sessionId: string }>(
      await app.request("/api/telegram/start", {
        method: "POST",
        body: JSON.stringify({ apiId: "12345", apiHash: "secret", phone: "+27820000000" }),
        headers: { "content-type": "application/json" },
      }),
    );
    await app.request("/api/telegram/verify-code", {
      method: "POST",
      body: JSON.stringify({ sessionId: start.sessionId, code: "12345" }),
      headers: { "content-type": "application/json" },
    });

    const dashboard = await json<{
      providers: Array<{ dialogId: string; profileId?: string }>;
    }>(await app.request("/api/dashboard"));
    expect(
      dashboard.providers.filter((provider) => provider.dialogId === "dialog-alpha"),
    ).toHaveLength(0);
  });

  test("rebinds an existing provider when the same Telegram dialog is selected from a new session", async () => {
    const app = createApi({
      databasePath: ":memory:",
      seedDemoData: false,
      telegram: createDialogTelegramAdapter([
        { id: "kal-dialog", title: "KAL VIP", type: "channel", unreadCount: 0 },
      ]),
    });
    const firstSession = await json<{ profileId: string; sessionId: string }>(
      await app.request("/api/telegram/start", {
        method: "POST",
        body: JSON.stringify({ apiId: "12345", apiHash: "secret", phone: "+27820000000" }),
        headers: { "content-type": "application/json" },
      }),
    );
    await app.request("/api/telegram/verify-code", {
      method: "POST",
      body: JSON.stringify({ sessionId: firstSession.sessionId, code: "12345" }),
      headers: { "content-type": "application/json" },
    });

    const first = await json<{ provider: { id: string } }>(
      await app.request("/api/providers", {
        method: "POST",
        body: JSON.stringify({
          profileId: firstSession.profileId,
          dialogId: "kal-dialog",
          title: "KAL VIP",
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    await app.request(`/api/providers/${first.provider.id}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: true, lotSize: 0.24 }),
      headers: { "content-type": "application/json" },
    });
    await app.request("/api/telegram/disconnect", {
      method: "POST",
      body: JSON.stringify({ sessionId: firstSession.sessionId }),
      headers: { "content-type": "application/json" },
    });

    const secondSession = await json<{ profileId: string; sessionId: string }>(
      await app.request("/api/telegram/start", {
        method: "POST",
        body: JSON.stringify({ apiId: "12345", apiHash: "secret", phone: "+27820000000" }),
        headers: { "content-type": "application/json" },
      }),
    );
    await app.request("/api/telegram/verify-code", {
      method: "POST",
      body: JSON.stringify({ sessionId: secondSession.sessionId, code: "12345" }),
      headers: { "content-type": "application/json" },
    });

    const second = await json<{ provider: { id: string; lotSize: number } }>(
      await app.request("/api/providers", {
        method: "POST",
        body: JSON.stringify({
          profileId: secondSession.profileId,
          dialogId: "kal-dialog",
          title: "KAL VIP",
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    const providers = await json<{
      providers: Array<{ id: string; dialogId: string; lotSize: number; ingestionStatus?: string }>;
    }>(await app.request("/api/dashboard"));
    const kalProviders = providers.providers.filter(
      (provider) => provider.dialogId === "kal-dialog",
    );

    expect(second.provider.id).toBe(first.provider.id);
    expect(second.provider.lotSize).toBe(0.24);
    expect(kalProviders).toHaveLength(1);
    expect(kalProviders[0]).toMatchObject({ id: first.provider.id, ingestionStatus: "polling" });
  });

  test("preserves per-account provider config when duplicate provider rows are merged", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "telegram-tc-"));
    const dbPath = join(tempDir, "telegram-tc.db");
    try {
      const app = createApi({
        databasePath: dbPath,
        seedDemoData: false,
        telegram: createDialogTelegramAdapter([
          { id: "kal-dialog", title: "KAL VIP", type: "channel", unreadCount: 0 },
        ]),
      });
      const session = await json<{ profileId: string; sessionId: string }>(
        await app.request("/api/telegram/start", {
          method: "POST",
          body: JSON.stringify({ apiId: "12345", apiHash: "secret", phone: "+27820000000" }),
          headers: { "content-type": "application/json" },
        }),
      );
      await app.request("/api/telegram/verify-code", {
        method: "POST",
        body: JSON.stringify({ sessionId: session.sessionId, code: "12345" }),
        headers: { "content-type": "application/json" },
      });
      const canonical = await json<{ provider: { id: string } }>(
        await app.request("/api/providers", {
          method: "POST",
          body: JSON.stringify({
            profileId: session.profileId,
            dialogId: "kal-dialog",
            title: "KAL VIP",
          }),
          headers: { "content-type": "application/json" },
        }),
      );
      await app.request(`/api/providers/${canonical.provider.id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: true, riskMode: "fixed", riskAmount: 0.2 }),
        headers: { "content-type": "application/json" },
      });
      await app.request(`/api/account-provider-links/mt5-111/${canonical.provider.id}`, {
        method: "PUT",
        body: JSON.stringify({ enabled: true }),
        headers: { "content-type": "application/json" },
      });

      const now = new Date().toISOString();
      const duplicateId = "provider_duplicate_kal";
      const duplicateConfig = {
        riskMode: "fixed",
        riskAmount: 0.7,
        takeProfitLevels: [],
        runner: { enabled: false, lotSize: 0.01, slBehavior: "break-even", trailPips: 10 },
      };
      const db = new Database(dbPath);
      db.query(
        "INSERT INTO providers (id, profile_id, dialog_id, title, kind, enabled, parser_mode, risk_profile, lot_size, provider_config_json, last_message_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        duplicateId,
        "profile-stale",
        "kal-dialog",
        "KAL VIP stale",
        "channel",
        1,
        "deterministic",
        "balanced",
        0.1,
        "{}",
        now,
      );
      db.query(
        "INSERT INTO account_provider_links (account_id, provider_id, enabled, updated_at, config_json) VALUES (?, ?, ?, ?, ?)",
      ).run("mt5-222", duplicateId, 1, now, JSON.stringify(duplicateConfig));
      db.close();

      await app.request("/api/providers", {
        method: "POST",
        body: JSON.stringify({
          profileId: session.profileId,
          dialogId: "kal-dialog",
          title: "KAL VIP",
        }),
        headers: { "content-type": "application/json" },
      });
      const links = await json<{
        links: Array<{
          accountId: string;
          providerId: string;
          enabled: boolean;
          config?: { riskAmount?: number };
        }>;
      }>(await app.request("/api/account-provider-links"));

      expect(links.links).toContainEqual(
        expect.objectContaining({
          accountId: "mt5-222",
          providerId: canonical.provider.id,
          enabled: true,
          config: expect.objectContaining({ riskAmount: 0.7 }),
        }),
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("resyncs stale providers to the current connected Telegram session when their dialogs are visible", async () => {
    const app = createApi({
      databasePath: ":memory:",
      seedDemoData: false,
      telegram: createDialogTelegramAdapter([
        { id: "kal-dialog", title: "KAL VIP", type: "channel", unreadCount: 0 },
      ]),
    });
    const firstSession = await json<{ profileId: string; sessionId: string }>(
      await app.request("/api/telegram/start", {
        method: "POST",
        body: JSON.stringify({ apiId: "12345", apiHash: "secret", phone: "+27820000000" }),
        headers: { "content-type": "application/json" },
      }),
    );
    await app.request("/api/telegram/verify-code", {
      method: "POST",
      body: JSON.stringify({ sessionId: firstSession.sessionId, code: "12345" }),
      headers: { "content-type": "application/json" },
    });
    const selected = await json<{ provider: { id: string } }>(
      await app.request("/api/providers", {
        method: "POST",
        body: JSON.stringify({
          profileId: firstSession.profileId,
          dialogId: "kal-dialog",
          title: "KAL VIP",
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    await app.request(`/api/providers/${selected.provider.id}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: true }),
      headers: { "content-type": "application/json" },
    });
    await app.request("/api/telegram/disconnect", {
      method: "POST",
      body: JSON.stringify({ sessionId: firstSession.sessionId }),
      headers: { "content-type": "application/json" },
    });

    const secondSession = await json<{ profileId: string; sessionId: string }>(
      await app.request("/api/telegram/start", {
        method: "POST",
        body: JSON.stringify({ apiId: "12345", apiHash: "secret", phone: "+27820000000" }),
        headers: { "content-type": "application/json" },
      }),
    );
    await app.request("/api/telegram/verify-code", {
      method: "POST",
      body: JSON.stringify({ sessionId: secondSession.sessionId, code: "12345" }),
      headers: { "content-type": "application/json" },
    });

    const before = await json<{
      providers: Array<{ id: string; dialogId: string; ingestionStatus?: string }>;
    }>(await app.request("/api/dashboard"));
    expect(before.providers.find((provider) => provider.id === selected.provider.id)).toMatchObject(
      {
        ingestionStatus: "telegram-offline",
      },
    );

    const resync = await json<{
      rebound: Array<{ providerId: string; fromProfileId: string; toProfileId: string }>;
    }>(
      await app.request("/api/providers/resync-current-session", {
        method: "POST",
        body: JSON.stringify({ profileId: secondSession.profileId }),
        headers: { "content-type": "application/json" },
      }),
    );
    const after = await json<{
      providers: Array<{ id: string; dialogId: string; ingestionStatus?: string }>;
    }>(await app.request("/api/dashboard"));

    expect(resync.rebound).toEqual([
      {
        providerId: selected.provider.id,
        fromProfileId: firstSession.profileId,
        toProfileId: secondSession.profileId,
      },
    ]);
    expect(after.providers.find((provider) => provider.id === selected.provider.id)).toMatchObject({
      ingestionStatus: "polling",
    });
  });

  test("updates provider parser mode, symbol lock, risk profile, and channel lot size settings", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: true });
    const providers = await json<{
      providers: Array<{
        id: string;
        parserMode: string;
        lockedSymbol?: string;
        riskProfile: string;
        lotSize: number;
      }>;
    }>(await app.request("/api/providers"));
    const providerId = providers.providers[0]!.id;
    expect(providers.providers[0]!.riskProfile).toBe("balanced");
    expect(providers.providers[0]!.lotSize).toBe(0.1);

    const update = await json<{
      provider: {
        id: string;
        parserMode: string;
        lockedSymbol?: string;
        riskProfile: string;
        lotSize: number;
      };
    }>(
      await app.request(`/api/providers/${providerId}`, {
        method: "PATCH",
        body: JSON.stringify({
          parserMode: "aggressive",
          lockedSymbol: "XAUUSD",
          riskProfile: "conservative",
          lotSize: 0.2,
        }),
        headers: { "content-type": "application/json" },
      }),
    );

    expect(update.provider).toMatchObject({
      id: providerId,
      parserMode: "aggressive",
      lockedSymbol: "XAUUSD",
      riskProfile: "conservative",
      lotSize: 0.2,
    });
    const refreshed = await json<{
      providers: Array<{
        id: string;
        parserMode: string;
        lockedSymbol?: string;
        riskProfile: string;
        lotSize: number;
      }>;
    }>(await app.request("/api/providers"));
    expect(refreshed.providers[0]!.parserMode).toBe("aggressive");
    expect(refreshed.providers[0]!.lockedSymbol).toBe("XAUUSD");
    expect(refreshed.providers[0]!.riskProfile).toBe("conservative");
    expect(refreshed.providers[0]!.lotSize).toBe(0.2);

    const dashboard = await json<{
      providers: Array<{
        id: string;
        parserMode: string;
        lockedSymbol?: string;
        riskProfile: string;
        lotSize: number;
      }>;
    }>(await app.request("/api/dashboard"));
    expect(dashboard.providers[0]!.lockedSymbol).toBe("XAUUSD");
    expect(dashboard.providers[0]!.riskProfile).toBe("conservative");
    expect(dashboard.providers[0]!.lotSize).toBe(0.2);
  });

  test("dry-runs KAL VIP extended parser config with a locked symbol and fresh EA price", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: true });
    await app.request("/api/mt5/snapshot", {
      method: "POST",
      body: JSON.stringify({
        accountId: "mt5-100200300",
        positions: [],
        orders: [],
        symbols: [{ symbol: "XAUUSD.r", bid: 4444.1, ask: 4444.5 }],
      }),
      headers: { "content-type": "application/json" },
    });

    const result = await json<{
      parsed: { commandType: string; direction?: string; entry?: { from: number } };
      signalCount: number;
      config: { parserMode?: string; lockedSymbol?: string };
    }>(
      await app.request("/api/providers/provider-alpha/test-config", {
        method: "POST",
        body: JSON.stringify({
          rawText: [
            "First sell zone is the head on the pinbar",
            "",
            "Around 41 level",
            "",
            "Second sell is 56",
            "",
            "The 03 level can be a buy",
          ].join("\n"),
          accountId: "mt5-100200300",
          config: {
            parserMode: "automatic",
            shorthandLevels: true,
            lockedSymbol: "XAUUSD",
            riskMode: "fixed",
            riskAmount: 0.02,
            takeProfitLevels: [],
          },
        }),
        headers: { "content-type": "application/json" },
      }),
    );

    expect(result.signalCount).toBe(3);
    expect(result.parsed).toMatchObject({
      commandType: "OPEN_TRADE",
      direction: "SELL",
      entry: { from: 4441 },
    });
    expect(result.config).toMatchObject({
      shorthandLevels: true,
      lockedSymbol: "XAUUSD",
    });
  });

  test("persists app settings and enforces allowed order behavior", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: true });

    const defaults = await json<{
      settings: {
        defaultLotSize: number;
        defaultRiskPercent: number;
        defaultStopLossPips: number;
        defaultTakeProfitPips: number;
        azureOpenAIKeyConfigured: boolean;
        leaseTimeoutSeconds: number;
        maxLeaseAttempts: number;
        pollingIntervalSeconds: number;
        allowedOrderTypes: string[];
        dedupWindowSeconds: number;
        maxOpenTradeAgeSeconds: number;
        drawdownWarnPct: number;
        drawdownDangerPct: number;
        reportingCurrency: string;
        usdZarRate: number;
        releaseHeldOnGuardianUnpause: boolean;
        releaseHeldOnEaReconnect: boolean;
        alertBotConfigured: boolean;
        alertChatId: string;
        alertOnGuardianPause: boolean;
        alertOnEaOffline: boolean;
        alertOnExecFailed: boolean;
        alertOnHeld: boolean;
        alertOnDroppedLifecycle: boolean;
        alertOnTelegramStall: boolean;
      };
    }>(await app.request("/api/settings"));
    expect(defaults.settings).toEqual({
      defaultLotSize: 0.1,
      defaultRiskPercent: 1,
      defaultStopLossPips: 50,
      defaultTakeProfitPips: 200,
      azureOpenAIKeyConfigured: false,
      leaseTimeoutSeconds: 15,
      maxLeaseAttempts: 3,
      dedupWindowSeconds: 300,
      maxOpenTradeAgeSeconds: 0,
      pollingIntervalSeconds: 2,
      allowedOrderTypes: ["MARKET", "LIMIT", "STOP"],
      drawdownWarnPct: 10,
      drawdownDangerPct: 20,
      reportingCurrency: "USD",
      usdZarRate: 16,
      releaseHeldOnGuardianUnpause: false,
      releaseHeldOnEaReconnect: true,
      alertBotConfigured: false,
      alertChatId: "",
      alertOnGuardianPause: false,
      alertOnEaOffline: false,
      alertOnExecFailed: false,
      alertOnHeld: false,
      alertOnDroppedLifecycle: false,
      alertOnTelegramStall: false,
    });

    const updated = await json<{
      settings: {
        defaultLotSize: number;
        defaultRiskPercent: number;
        defaultStopLossPips: number;
        defaultTakeProfitPips: number;
        pollingIntervalSeconds: number;
        allowedOrderTypes: string[];
      };
    }>(
      await app.request("/api/settings", {
        method: "PATCH",
        body: JSON.stringify({
          defaultLotSize: 0.25,
          defaultRiskPercent: 0.75,
          pollingIntervalSeconds: 5,
          allowedOrderTypes: ["LIMIT", "STOP"],
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(updated.settings.allowedOrderTypes).toEqual(["LIMIT", "STOP"]);

    const dashboard = await json<{
      appSettings: { defaultLotSize: number; allowedOrderTypes: string[] };
    }>(await app.request("/api/dashboard"));
    expect(dashboard.appSettings.defaultLotSize).toBe(0.25);
    expect(dashboard.appSettings.allowedOrderTypes).toEqual(["LIMIT", "STOP"]);
    expect(dashboard.appSettings).not.toHaveProperty("alertBotToken");

    const parsed = await json<{ parsedSignalId: string; result: { orderType: string } }>(
      await app.request("/api/parser/parse", {
        method: "POST",
        body: JSON.stringify({
          providerId: "provider-alpha",
          rawText: "BUY EURUSD @ 1.0860\nSL 1.0810\nTP1 1.0910",
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(parsed.result.orderType).toBe("MARKET");

    const approve = await app.request(`/api/signals/${parsed.parsedSignalId}/approve`, {
      method: "POST",
    });
    expect(approve.status).toBe(422);
    expect((await json<{ error: string }>(approve)).error).toContain("not allowed");
  });

  test("preserves the stored alert token when an unrelated settings save omits it", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: false });
    const headers = { "content-type": "application/json" };
    await app.request("/api/settings", {
      method: "PATCH",
      body: JSON.stringify({ alertBotToken: "bot-token", alertChatId: "chat-1" }),
      headers,
    });
    const saved = await json<{ settings: { alertBotConfigured: boolean } }>(
      await app.request("/api/settings", {
        method: "PATCH",
        body: JSON.stringify({ defaultLotSize: 0.25 }),
        headers,
      }),
    );

    expect(saved.settings.alertBotConfigured).toBe(true);
    expect(saved.settings).not.toHaveProperty("alertBotToken");

    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async () => Response.json({ ok: true })) as unknown as typeof fetch;
    try {
      expect((await app.request("/api/admin/alert-test", { method: "POST" })).status).toBe(200);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  test("reports mixed USD and ZAR account performance in the configured reporting currency", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "telegram-tc-"));
    const databasePath = join(tempDir, "app.db");
    const app = createApi({ databasePath, seedDemoData: false });

    try {
      await app.request("/api/mt5/register", {
        method: "POST",
        body: JSON.stringify({
          accountNumber: "100200300",
          server: "OctaFX-Live",
          company: "OctaFX",
          currency: "USD",
          balance: 100,
          equity: 110,
          profit: 10,
          marginMode: "HEDGING",
          availableSymbols: ["XAUUSD"],
        }),
        headers: { "content-type": "application/json" },
      });
      await app.request("/api/mt5/register", {
        method: "POST",
        body: JSON.stringify({
          accountNumber: "54870107",
          server: "HF-Live",
          company: "HF",
          currency: "ZAR",
          balance: 1600,
          equity: 1760,
          profit: 160,
          marginMode: "HEDGING",
          availableSymbols: ["XAUUSD"],
        }),
        headers: { "content-type": "application/json" },
      });

      const defaults = await json<{
        accountPerformance: {
          accountId: string;
          currency: string;
          heartbeatStatus: string;
          currentBalance: number | null;
          currentEquity: number | null;
          currentProfit: number | null;
        };
      }>(await app.request("/api/dashboard"));

      expect(defaults.accountPerformance).toMatchObject({
        accountId: "aggregate",
        currency: "USD",
        heartbeatStatus: "online",
        currentBalance: 200,
        currentEquity: 220,
        currentProfit: 20,
      });

      const db = new Database(databasePath);
      db.query("UPDATE mt5_accounts SET last_heartbeat_at = ? WHERE id = ?").run(
        "2026-05-20T09:00:00.000Z",
        "mt5-54870107",
      );
      db.close();

      const partialLive = await json<{
        accountPerformance: {
          heartbeatStatus: string;
          currentBalance: number | null;
          currentEquity: number | null;
          currentProfit: number | null;
        };
      }>(await app.request("/api/dashboard"));
      expect(partialLive.accountPerformance).toMatchObject({
        heartbeatStatus: "online",
        currentBalance: null,
        currentEquity: null,
        currentProfit: null,
      });

      await app.request("/api/settings", {
        method: "PATCH",
        body: JSON.stringify({ reportingCurrency: "ZAR", usdZarRate: 20 }),
        headers: { "content-type": "application/json" },
      });
      const updated = await json<{
        accountPerformance: {
          accountId: string;
          currency: string;
          currentBalance: number | null;
          currentEquity: number | null;
          currentProfit: number | null;
        };
      }>(await app.request("/api/dashboard"));

      expect(updated.accountPerformance).toMatchObject({
        accountId: "aggregate",
        currency: "ZAR",
        currentBalance: null,
        currentEquity: null,
        currentProfit: null,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("refreshes cached performance when a heartbeat ages offline", async () => {
    const originalDateNow = Date.now;
    const now = originalDateNow();
    try {
      const app = createApi({ databasePath: ":memory:", seedDemoData: false });
      await app.request("/api/mt5/register", {
        method: "POST",
        body: JSON.stringify({
          accountNumber: "54945785",
          server: "HF-Live",
          company: "HF",
          currency: "USD",
          balance: 1000,
          equity: 1000,
          profit: 0,
          marginMode: "HEDGING",
          availableSymbols: ["XAUUSD"],
        }),
        headers: { "content-type": "application/json" },
      });
      const immediate = await json<{
        accountPerformance: { heartbeatStatus: string; currentBalance: number | null };
      }>(await app.request("/api/dashboard"));
      expect(immediate.accountPerformance).toMatchObject({
        heartbeatStatus: "online",
        currentBalance: 1000,
      });

      Date.now = () => now + 145 * 60_000;
      const stale = await json<{
        accountPerformance: {
          heartbeatStatus: string;
          currentBalance: number | null;
          currentEquity: number | null;
          currentProfit: number | null;
        };
      }>(await app.request("/api/dashboard"));
      expect(stale.accountPerformance).toMatchObject({
        heartbeatStatus: "offline",
        currentBalance: null,
        currentEquity: null,
        currentProfit: null,
      });
    } finally {
      Date.now = originalDateNow;
    }
  });

  test("holds new open trades for a silent account instead of queueing them for reconnect", async () => {
    const originalDateNow = Date.now;
    const now = originalDateNow();
    try {
      const app = createApi({ databasePath: ":memory:", seedDemoData: false });
      const providerId = await configureProviderWithAccount(app, { availableSymbols: ["XAUUSD"] });
      await app.request(`/api/account-provider-links/mt5-63442826/${providerId}`, {
        method: "PUT",
        body: JSON.stringify({ enabled: true }),
        headers: { "content-type": "application/json" },
      });
      Date.now = () => now + 145 * 60_000;
      const parsed = await json<{ parsedSignalId: string }>(
        await app.request("/api/parser/parse", {
          method: "POST",
          body: JSON.stringify({
            providerId,
            accountId: "mt5-63442826",
            rawText: "BUY XAUUSD NOW\nSL 4010\nTP 4040",
          }),
          headers: { "content-type": "application/json" },
        }),
      );
      const approval = await json<{ status: string }>(
        await app.request(`/api/signals/${parsed.parsedSignalId}/approve`, { method: "POST" }),
      );
      expect(approval.status).toBe("HELD");
      const held = await json<{ items: Array<{ heldReason: string }> }>(
        await app.request("/api/queue-items/held"),
      );
      expect(held.items).toContainEqual(expect.objectContaining({ heldReason: "EA_OFFLINE" }));
    } finally {
      Date.now = originalDateNow;
    }
  });

  test("releases fresh EA_OFFLINE LIMIT work when the EA registers again", async () => {
    const prepared = await createEaOfflineApproval();
    try {
      const { app, approved } = prepared;
      const before = await json<{ queue: Array<{ id: string; status: string }> }>(
        await app.request("/api/signals"),
      );
      expect(before.queue.find((item) => item.id === approved.queueItemId)?.status).toBe("HELD");

      await app.request("/api/mt5/register", {
        method: "POST",
        body: JSON.stringify({
          accountNumber: "63442826",
          server: "OctaFX-Real",
          company: "OctaFX",
          currency: "USD",
          balance: 10000,
          equity: 10000,
          marginMode: "HEDGING",
          availableSymbols: ["XAUUSD"],
        }),
        headers: { "content-type": "application/json" },
      });
      const after = await json<{
        queue: Array<{
          id: string;
          status: string;
          originQueueItemId?: string;
          accountId: string;
          logicalTradeId: string;
          payload: { orderType: string };
        }>;
      }>(await app.request("/api/signals"));
      expect(after.queue).toContainEqual(
        expect.objectContaining({ id: approved.queueItemId, status: "DISMISSED" }),
      );
      const released = after.queue.find(
        (item) => item.originQueueItemId === approved.queueItemId && item.status === "PENDING",
      );
      expect(released).toMatchObject({
        accountId: "mt5-63442826",
        originQueueItemId: approved.queueItemId,
        payload: expect.objectContaining({ orderType: "LIMIT" }),
      });
      expect(released?.logicalTradeId).toBeTruthy();
      expect(
        await (await app.request("/api/mt5/poll-line?accountId=mt5-63442826")).text(),
      ).toContain(`logicalTradeId=${released?.logicalTradeId}`);
    } finally {
      await rm(prepared.tempDir, { recursive: true, force: true });
    }
  });

  test("rolls back a failed EA_OFFLINE held OPEN release before retrying", async () => {
    const prepared = await createEaOfflineApproval();
    const sentAlerts: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input, init) => {
      sentAlerts.push(String(init?.body ?? ""));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
    try {
      const { app, approved, databasePath } = prepared;
      await app.request("/api/settings", {
        method: "PATCH",
        body: JSON.stringify({ alertBotToken: "token", alertChatId: "chat", alertOnHeld: true }),
        headers: { "content-type": "application/json" },
      });
      const failed = await app.request(`/api/queue-items/${approved.queueItemId}/requeue`, {
        method: "POST",
        body: JSON.stringify({ mode: "original" }),
        headers: { "content-type": "application/json" },
      });
      expect(failed.status).toBe(409);
      await Promise.resolve();

      const db = new Database(databasePath, { readonly: true });
      try {
        expect(
          db
            .query(
              "SELECT id, status FROM queue_items WHERE parsed_signal_id = (SELECT parsed_signal_id FROM queue_items WHERE id = ?)",
            )
            .all(approved.queueItemId),
        ).toEqual([{ id: approved.queueItemId, status: "HELD" }]);
        expect(db.query("SELECT COUNT(*) AS n FROM logical_trades").get()).toEqual({ n: 0 });
        expect(db.query("SELECT COUNT(*) AS n FROM trade_origins").get()).toEqual({ n: 0 });
      } finally {
        db.close();
      }
      expect(sentAlerts).toHaveLength(0);

      await app.request("/api/mt5/register", {
        method: "POST",
        body: JSON.stringify({
          accountNumber: "63442826",
          server: "OctaFX-Real",
          company: "OctaFX",
          currency: "USD",
          balance: 10000,
          equity: 10000,
          marginMode: "HEDGING",
          availableSymbols: ["XAUUSD"],
        }),
        headers: { "content-type": "application/json" },
      });
      const after = await json<{
        queue: Array<{ id: string; status: string; originQueueItemId?: string }>;
      }>(await app.request("/api/signals"));
      expect(after.queue.filter((item) => item.status === "HELD")).toHaveLength(0);
      expect(
        after.queue.filter(
          (item) => item.originQueueItemId === approved.queueItemId && item.status === "PENDING",
        ),
      ).toHaveLength(1);
    } finally {
      globalThis.fetch = originalFetch;
      await rm(prepared.tempDir, { recursive: true, force: true });
    }
  });

  test("does not release an already-dismissed held OPEN twice", async () => {
    const prepared = await createEaOfflineApproval();
    try {
      const { app, approved } = prepared;
      await app.request("/api/mt5/register", {
        method: "POST",
        body: JSON.stringify({
          accountNumber: "63442826",
          server: "OctaFX-Real",
          company: "OctaFX",
          currency: "USD",
          balance: 10000,
          equity: 10000,
          marginMode: "HEDGING",
          availableSymbols: ["XAUUSD"],
        }),
        headers: { "content-type": "application/json" },
      });
      const second = await app.request(`/api/queue-items/${approved.queueItemId}/requeue`, {
        method: "POST",
        body: JSON.stringify({ mode: "original" }),
        headers: { "content-type": "application/json" },
      });
      expect(second.status).toBe(409);

      // This OPEN-path race is rejected by hasDuplicateOpenSignal because the trigger leaves the
      // source HELD and it matches itself; it does not isolate the dismissal CAS. The bound-path
      // regression "aborts a bound release whose HELD source row does not transition exactly once"
      // is the dedicated CAS test because that path has no approveSignal dedup backstop.
      const raced = await createEaOfflineApproval({ releaseHeldOnEaReconnect: false });
      try {
        await raced.app.request("/api/mt5/register", {
          method: "POST",
          body: JSON.stringify({
            accountNumber: "63442826",
            server: "OctaFX-Real",
            company: "OctaFX",
            currency: "USD",
            balance: 10000,
            equity: 10000,
            marginMode: "HEDGING",
            availableSymbols: ["XAUUSD"],
          }),
          headers: { "content-type": "application/json" },
        });
        const raceDb = new Database(raced.databasePath);
        const sourceId = raced.approved.queueItemId.replaceAll("'", "''");
        try {
          raceDb.run(`
            CREATE TRIGGER cas_release_race BEFORE UPDATE OF status ON queue_items
            WHEN OLD.id = '${sourceId}' AND NEW.status = 'DISMISSED'
            BEGIN
              SELECT RAISE(IGNORE);
            END
          `);
        } finally {
          raceDb.close();
        }
        const casFailure = await raced.app.request(
          `/api/queue-items/${raced.approved.queueItemId}/requeue`,
          {
            method: "POST",
            body: JSON.stringify({ mode: "original" }),
            headers: { "content-type": "application/json" },
          },
        );
        expect(casFailure.status).toBe(409);
        const afterCas = new Database(raced.databasePath, { readonly: true });
        try {
          expect(
            afterCas
              .query(
                "SELECT COUNT(*) AS n FROM queue_items WHERE parsed_signal_id = (SELECT parsed_signal_id FROM queue_items WHERE id = ?)",
              )
              .get(raced.approved.queueItemId),
          ).toEqual({ n: 1 });
          expect(
            afterCas
              .query("SELECT status FROM queue_items WHERE id = ?")
              .get(raced.approved.queueItemId),
          ).toEqual({ status: "HELD" });
        } finally {
          afterCas.close();
        }
      } finally {
        await rm(raced.tempDir, { recursive: true, force: true });
      }
    } finally {
      await rm(prepared.tempDir, { recursive: true, force: true });
    }
  });

  test("does not auto-release EA_OFFLINE MARKET work on reconnect", async () => {
    const prepared = await createEaOfflineApproval({ rawText: "BUY XAUUSD NOW\nSL 4535\nTP 4546" });
    try {
      const { app, approved } = prepared;
      await app.request("/api/mt5/register", {
        method: "POST",
        body: JSON.stringify({
          accountNumber: "63442826",
          server: "OctaFX-Real",
          company: "OctaFX",
          currency: "USD",
          balance: 10000,
          equity: 10000,
          marginMode: "HEDGING",
          availableSymbols: ["XAUUSD"],
        }),
        headers: { "content-type": "application/json" },
      });
      const queue = await json<{
        queue: Array<{ id: string; status: string; payload: { orderType: string } }>;
      }>(await app.request("/api/signals"));
      expect(queue.queue.find((item) => item.id === approved.queueItemId)).toMatchObject({
        status: "HELD",
        payload: { orderType: "MARKET" },
      });
    } finally {
      await rm(prepared.tempDir, { recursive: true, force: true });
    }
  });

  test("does not auto-release EA_OFFLINE work older than fifteen minutes", async () => {
    const prepared = await createEaOfflineApproval();
    try {
      const { app, approved, databasePath } = prepared;
      const db = new Database(databasePath);
      db.query("UPDATE queue_items SET created_at = ? WHERE id = ?").run(
        new Date(Date.now() - 16 * 60_000).toISOString(),
        approved.queueItemId,
      );
      db.close();
      await app.request("/api/mt5/register", {
        method: "POST",
        body: JSON.stringify({
          accountNumber: "63442826",
          server: "OctaFX-Real",
          company: "OctaFX",
          currency: "USD",
          balance: 10000,
          equity: 10000,
          marginMode: "HEDGING",
          availableSymbols: ["XAUUSD"],
        }),
        headers: { "content-type": "application/json" },
      });
      const queue = await json<{ queue: Array<{ id: string; status: string }> }>(
        await app.request("/api/signals"),
      );
      expect(queue.queue.find((item) => item.id === approved.queueItemId)?.status).toBe("HELD");
    } finally {
      await rm(prepared.tempDir, { recursive: true, force: true });
    }
  });

  test("releases EA_OFFLINE work only on a heartbeat after an offline transition", async () => {
    const prepared = await createEaOfflineApproval();
    try {
      const { app, approved } = prepared;
      const heartbeat = () =>
        app.request("/api/mt5/heartbeat", {
          method: "POST",
          body: JSON.stringify({ accountId: "mt5-63442826", balance: 10000, equity: 10000 }),
          headers: { "content-type": "application/json" },
        });
      expect(
        (await json<{ releasedQueueItemIds: string[] }>(await heartbeat())).releasedQueueItemIds,
      ).toHaveLength(1);
      expect(
        (await json<{ releasedQueueItemIds: string[] }>(await heartbeat())).releasedQueueItemIds,
      ).toEqual([]);
      const queue = await json<{ queue: Array<{ originQueueItemId?: string }> }>(
        await app.request("/api/signals"),
      );
      expect(
        queue.queue.filter((item) => item.originQueueItemId === approved.queueItemId),
      ).toHaveLength(1);
    } finally {
      await rm(prepared.tempDir, { recursive: true, force: true });
    }
  });

  test("keeps EA_OFFLINE work held when reconnect release is disabled", async () => {
    const prepared = await createEaOfflineApproval({ releaseHeldOnEaReconnect: false });
    try {
      const { app, approved } = prepared;
      await app.request("/api/mt5/register", {
        method: "POST",
        body: JSON.stringify({
          accountNumber: "63442826",
          server: "OctaFX-Real",
          company: "OctaFX",
          currency: "USD",
          balance: 10000,
          equity: 10000,
          marginMode: "HEDGING",
          availableSymbols: ["XAUUSD"],
        }),
        headers: { "content-type": "application/json" },
      });
      const queue = await json<{ queue: Array<{ id: string; status: string }> }>(
        await app.request("/api/signals"),
      );
      expect(queue.queue.find((item) => item.id === approved.queueItemId)?.status).toBe("HELD");
    } finally {
      await rm(prepared.tempDir, { recursive: true, force: true });
    }
  });

  test("mixed-currency performance blanks unsupported currency aggregates", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: false });

    await app.request("/api/mt5/register", {
      method: "POST",
      body: JSON.stringify({
        accountNumber: "100200300",
        server: "OctaFX-Live",
        company: "OctaFX",
        currency: "USD",
        balance: 100,
        equity: 110,
        profit: 10,
        marginMode: "HEDGING",
        availableSymbols: ["XAUUSD"],
      }),
      headers: { "content-type": "application/json" },
    });
    await app.request("/api/mt5/register", {
      method: "POST",
      body: JSON.stringify({
        accountNumber: "200300400",
        server: "Broker-EUR",
        company: "Broker",
        currency: "EUR",
        balance: 100,
        equity: 120,
        profit: 20,
        marginMode: "HEDGING",
        availableSymbols: ["XAUUSD"],
      }),
      headers: { "content-type": "application/json" },
    });

    const dashboard = await json<{
      accountPerformance: {
        accountId: string;
        currency: string;
        currentBalance: number | null;
        currentEquity: number | null;
        totalProfit: number | null;
      };
    }>(await app.request("/api/dashboard"));

    expect(dashboard.accountPerformance).toMatchObject({
      accountId: "aggregate",
      currency: "USD",
      currentBalance: null,
      currentEquity: null,
      totalProfit: null,
    });
  });

  test("passes configured channel lot size through to the MT5 line payload", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: true });

    await app.request("/api/mt5/poll-line?accountId=mt5-100200300");
    await app.request("/api/providers/provider-alpha", {
      method: "PATCH",
      body: JSON.stringify({ lotSize: 0.25 }),
      headers: { "content-type": "application/json" },
    });

    const parsed = await json<{ parsedSignalId: string }>(
      await app.request("/api/parser/parse", {
        method: "POST",
        body: JSON.stringify({
          providerId: "provider-alpha",
          rawText: "BUY EURUSD @ 1.0860\nSL 1.0810\nTP1 1.0910",
        }),
        headers: { "content-type": "application/json" },
      }),
    );

    const approve = await app.request(`/api/signals/${parsed.parsedSignalId}/approve`, {
      method: "POST",
    });
    expect(approve.status).toBe(200);

    const payload = await (await app.request("/api/mt5/poll-line?accountId=mt5-100200300")).text();
    expect(payload).toContain("volume=0.25");
  });

  test("caps provider take-profit config at TP1 through TP4", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: true });

    const oversizedLevels = Array.from({ length: 6 }, (_, index) => ({
      leg: index + 1,
      percentage: 10,
      strategy: `TP${index + 1} strategy`,
    }));

    const update = await app.request("/api/providers/provider-alpha", {
      method: "PATCH",
      body: JSON.stringify({
        riskMode: "fixed",
        riskAmount: 0.2,
        takeProfitLevels: oversizedLevels,
      }),
      headers: { "content-type": "application/json" },
    });
    expect(update.status).toBe(200);

    const saved = await json<{
      config: {
        takeProfitLevels: Array<{
          leg: number;
          percentage: number;
          strategy: { kind: string };
        }>;
      };
    }>(await app.request("/api/providers/provider-alpha/config"));

    expect(saved.config.takeProfitLevels).toEqual([
      { leg: 1, percentage: 25, strategy: { kind: "no-change" } },
      { leg: 2, percentage: 25, strategy: { kind: "no-change" } },
      { leg: 3, percentage: 25, strategy: { kind: "no-change" } },
      { leg: 4, percentage: 25, strategy: { kind: "no-change" } },
    ]);
  });

  test("uses the configured work-from TP as the sole closing target", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: true });
    await app.request("/api/mt5/poll-line?accountId=mt5-100200300");
    await app.request("/api/providers/provider-alpha", {
      method: "PATCH",
      body: JSON.stringify({
        riskMode: "fixed",
        riskAmount: 0.01,
        workFromTpLeg: 2,
        takeProfitLevels: [
          { leg: 1, percentage: 50, strategy: { kind: "no-change" } },
          { leg: 2, percentage: 50, strategy: { kind: "no-change" } },
        ],
      }),
      headers: { "content-type": "application/json" },
    });
    const parsed = await json<{ parsedSignalId: string }>(
      await app.request("/api/parser/parse", {
        method: "POST",
        body: JSON.stringify({
          providerId: "provider-alpha",
          rawText: "BUY EURUSD @ 1.0860\nSL 1.0810\nTP1 1.0910\nTP2 1.0950",
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(
      await app.request(`/api/signals/${parsed.parsedSignalId}/approve`, { method: "POST" }),
    ).toHaveProperty("status", 200);
    const payload = await (await app.request("/api/mt5/poll-line?accountId=mt5-100200300")).text();
    expect(payload).toContain("tp1Allocation=0");
    expect(payload).toContain("tp2Allocation=100");
  });

  test("normalizes null provider TP config without failing provider updates", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: true });

    const update = await app.request("/api/providers/provider-alpha", {
      method: "PATCH",
      body: JSON.stringify({
        riskMode: "fixed",
        riskAmount: 0.2,
        takeProfitLevels: null,
      }),
      headers: { "content-type": "application/json" },
    });
    expect(update.status).toBe(200);

    const saved = await json<{
      config: {
        takeProfitLevels: Array<{
          leg: number;
          percentage: number;
          strategy: { kind: string };
        }>;
      };
    }>(await app.request("/api/providers/provider-alpha/config"));

    expect(saved.config.takeProfitLevels).toEqual([
      { leg: 1, percentage: 25, strategy: { kind: "no-change" } },
      { leg: 2, percentage: 25, strategy: { kind: "no-change" } },
      { leg: 3, percentage: 25, strategy: { kind: "no-change" } },
      { leg: 4, percentage: 25, strategy: { kind: "no-change" } },
    ]);
  });

  test("null-only provider TP patch resets TP config without losing risk settings", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: true });

    const runner = {
      enabled: true,
      lotSize: 0.01,
      slBehavior: "break-even",
      trailPips: 10,
    };
    await app.request("/api/providers/provider-alpha", {
      method: "PATCH",
      body: JSON.stringify({
        riskMode: "percent",
        riskAmount: 1.5,
        takeProfitLevels: [{ leg: 1, percentage: 100, strategy: { kind: "no-change" } }],
        runner,
      }),
      headers: { "content-type": "application/json" },
    });

    const update = await app.request("/api/providers/provider-alpha", {
      method: "PATCH",
      body: JSON.stringify({ takeProfitLevels: null }),
      headers: { "content-type": "application/json" },
    });
    expect(update.status).toBe(200);

    const saved = await json<{
      config: {
        riskMode: string;
        riskAmount: number;
        runner: typeof runner;
        takeProfitLevels: Array<{ leg: number; percentage: number; strategy: { kind: string } }>;
      };
    }>(await app.request("/api/providers/provider-alpha/config"));

    expect(saved.config.riskMode).toBe("percent");
    expect(saved.config.riskAmount).toBe(1.5);
    expect(saved.config.runner).toEqual(runner);
    expect(saved.config.takeProfitLevels).toEqual([
      { leg: 1, percentage: 25, strategy: { kind: "no-change" } },
      { leg: 2, percentage: 25, strategy: { kind: "no-change" } },
      { leg: 3, percentage: 25, strategy: { kind: "no-change" } },
      { leg: 4, percentage: 25, strategy: { kind: "no-change" } },
    ]);
  });

  test("preserves an empty provider TP config and falls back to app default TP", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: true });
    await app.request("/api/mt5/poll-line?accountId=mt5-100200300");

    const update = await app.request("/api/providers/provider-alpha", {
      method: "PATCH",
      body: JSON.stringify({
        riskMode: "fixed",
        riskAmount: 0.02,
        takeProfitLevels: [],
      }),
      headers: { "content-type": "application/json" },
    });
    expect(update.status).toBe(200);

    const saved = await json<{ config: { takeProfitLevels: unknown[] } }>(
      await app.request("/api/providers/provider-alpha/config"),
    );
    expect(saved.config.takeProfitLevels).toEqual([]);

    const parsed = await json<{ parsedSignalId: string }>(
      await app.request("/api/parser/parse", {
        method: "POST",
        body: JSON.stringify({
          providerId: "provider-alpha",
          rawText: "BUY EURUSD @ 1.0860\nSL 1.0810\nTP1 1.0910\nTP2 1.0950",
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    const approve = await app.request(`/api/signals/${parsed.parsedSignalId}/approve`, {
      method: "POST",
    });
    expect(approve.status).toBe(200);

    const payload = await (await app.request("/api/mt5/poll-line?accountId=mt5-100200300")).text();
    expect(payload).toContain("defaultTakeProfitValue=200");
    expect(payload).toContain("defaultTakeProfitUnit=PIPS");
    expect(payload).not.toContain("tp1=1.091");
    expect(payload).not.toContain("tp2=1.095");
  });

  test("empty provider TP config keeps app SL and TP defaults for bare market signals", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: true });
    await app.request("/api/mt5/poll-line?accountId=mt5-100200300");

    await app.request("/api/providers/provider-alpha", {
      method: "PATCH",
      body: JSON.stringify({
        riskMode: "fixed",
        riskAmount: 0.02,
        takeProfitLevels: [],
      }),
      headers: { "content-type": "application/json" },
    });

    const parsed = await json<{ parsedSignalId: string }>(
      await app.request("/api/parser/parse", {
        method: "POST",
        body: JSON.stringify({
          providerId: "provider-alpha",
          rawText: "BUY EURUSD",
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    const approve = await app.request(`/api/signals/${parsed.parsedSignalId}/approve`, {
      method: "POST",
    });
    expect(approve.status).toBe(200);

    const payload = await (await app.request("/api/mt5/poll-line?accountId=mt5-100200300")).text();
    expect(payload).toContain("defaultStopLossValue=50");
    expect(payload).toContain("defaultStopLossUnit=PIPS");
    expect(payload).toContain("defaultTakeProfitValue=200");
    expect(payload).toContain("defaultTakeProfitUnit=PIPS");
  });

  test("queues one defaulted pending limit for each directional zone price line", async () => {
    const app = createApi({
      databasePath: ":memory:",
      seedDemoData: false,
      telegram: createDialogTelegramAdapter([
        { id: "kal-dialog", title: "KAL VIP", type: "channel", unreadCount: 0 },
      ]),
    });
    const started = await json<{ profileId: string; sessionId: string }>(
      await app.request("/api/telegram/start", {
        method: "POST",
        body: JSON.stringify({ apiId: "12345", apiHash: "hash", phone: "+27821234567" }),
        headers: { "content-type": "application/json" },
      }),
    );
    await app.request("/api/telegram/verify-code", {
      method: "POST",
      body: JSON.stringify({ sessionId: started.sessionId, code: "11111" }),
      headers: { "content-type": "application/json" },
    });
    const selected = await json<{ provider: { id: string } }>(
      await app.request("/api/providers", {
        method: "POST",
        body: JSON.stringify({
          profileId: started.profileId,
          dialogId: "kal-dialog",
          title: "KAL VIP",
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    await app.request(`/api/providers/${selected.provider.id}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: true, riskMode: "fixed", riskAmount: 0.02 }),
      headers: { "content-type": "application/json" },
    });
    await app.request("/api/mt5/register", {
      method: "POST",
      body: JSON.stringify({
        accountNumber: "63442826",
        server: "OctaFX-Real",
        company: "OctaFX",
        currency: "USD",
        balance: 10000,
        equity: 10000,
        marginMode: "HEDGING",
        availableSymbols: ["XAUUSD"],
      }),
      headers: { "content-type": "application/json" },
    });

    const parsed = await json<{
      parsedSignalId: string;
      parsedSignalIds: string[];
      results: Array<{
        commandType: string;
        direction?: string;
        orderType?: string;
        entry?: { from: number };
        defaultStopLoss?: { value: number; unit: string };
        defaultTakeProfit?: { value: number; unit: string };
      }>;
    }>(
      await app.request("/api/parser/parse", {
        method: "POST",
        body: JSON.stringify({
          providerId: selected.provider.id,
          accountId: "mt5-63442826",
          rawText: "4512 \n4500 \n4580\n\nBuy zones",
        }),
        headers: { "content-type": "application/json" },
      }),
    );

    expect(parsed.parsedSignalIds).toHaveLength(3);
    const firstParsedSignalId = parsed.parsedSignalIds[0];
    expect(firstParsedSignalId).toBeTruthy();
    expect(parsed.parsedSignalId).toBe(firstParsedSignalId as string);
    expect(parsed.results.map((result) => result.entry?.from)).toEqual([4512, 4500, 4580]);
    for (const result of parsed.results) {
      expect(result.commandType).toBe("OPEN_TRADE");
      expect(result.direction).toBe("BUY");
      expect(result.orderType).toBe("LIMIT");
      expect(result.defaultStopLoss).toEqual({ value: 50, unit: "PIPS" });
      expect(result.defaultTakeProfit).toEqual({ value: 200, unit: "PIPS" });
    }

    for (const parsedSignalId of parsed.parsedSignalIds) {
      const approval = await app.request(`/api/signals/${parsedSignalId}/approve`, {
        method: "POST",
      });
      expect(approval.status).toBe(200);
    }

    const pollLines = await Promise.all(
      [0, 1, 2].map(async () => app.request("/api/mt5/poll-line?accountId=mt5-63442826")),
    );
    const payloads = await Promise.all(pollLines.map((response) => response.text()));
    expect(payloads.map((payload) => payload.match(/entryFrom=([^\n]+)/)?.[1])).toEqual([
      "4512",
      "4500",
      "4580",
    ]);
    for (const payload of payloads) {
      expect(payload).toContain("commandType=OPEN_TRADE");
      expect(payload).toContain("direction=BUY");
      expect(payload).toContain("orderType=LIMIT");
      expect(payload).toContain("defaultStopLossValue=50");
      expect(payload).toContain("defaultTakeProfitValue=200");
    }
  });

  test("queues KAL VIP extended short levels against the locked symbol reference price", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: true });
    await app.request("/api/mt5/poll-line?accountId=mt5-100200300");
    await app.request("/api/providers/provider-alpha", {
      method: "PATCH",
      body: JSON.stringify({
        parserMode: "automatic",
        shorthandLevels: true,
        lockedSymbol: "XAUUSD",
        riskMode: "fixed",
        riskAmount: 0.02,
      }),
      headers: { "content-type": "application/json" },
    });
    await app.request("/api/mt5/snapshot", {
      method: "POST",
      body: JSON.stringify({
        accountId: "mt5-100200300",
        positions: [],
        orders: [],
        symbols: [{ symbol: "XAUUSD.r", bid: 4444.1, ask: 4444.5 }],
      }),
      headers: { "content-type": "application/json" },
    });

    const parsed = await json<{
      parsedSignalIds: string[];
      results: Array<{ commandType: string; direction?: string; entry?: { from: number } }>;
    }>(
      await app.request("/api/parser/parse", {
        method: "POST",
        body: JSON.stringify({
          providerId: "provider-alpha",
          accountId: "mt5-100200300",
          rawText: [
            "First sell zone is the head on the pinbar",
            "",
            "Around 41 level",
            "",
            "Second sell is 56",
            "",
            "The 03 level can be a buy",
          ].join("\n"),
        }),
        headers: { "content-type": "application/json" },
      }),
    );

    expect(parsed.parsedSignalIds).toHaveLength(3);
    expect(parsed.results.map((result) => [result.direction, result.entry?.from])).toEqual([
      ["SELL", 4441],
      ["SELL", 4456],
      ["BUY", 4403],
    ]);

    for (const parsedSignalId of parsed.parsedSignalIds) {
      const approval = await app.request(`/api/signals/${parsedSignalId}/approve`, {
        method: "POST",
      });
      expect(approval.status).toBe(200);
    }

    const pollLines = await Promise.all(
      [0, 1, 2].map(async () => app.request("/api/mt5/poll-line?accountId=mt5-100200300")),
    );
    const payloads = await Promise.all(pollLines.map((response) => response.text()));
    expect(payloads.map((payload) => payload.match(/entryFrom=([^\n]+)/)?.[1])).toEqual([
      "4441",
      "4456",
      "4403",
    ]);
    expect(payloads.map((payload) => payload.match(/direction=([^\n]+)/)?.[1])).toEqual([
      "SELL",
      "SELL",
      "BUY",
    ]);
  });

  test("uses provider channel lot size and ignores Telegram-provided lot and risk hints", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: true });

    await app.request("/api/mt5/poll-line?accountId=mt5-100200300");
    await app.request("/api/providers/provider-alpha", {
      method: "PATCH",
      body: JSON.stringify({ lotSize: 0.2 }),
      headers: { "content-type": "application/json" },
    });
    await app.request("/api/settings", {
      method: "PATCH",
      body: JSON.stringify({
        defaultLotSize: 0.33,
        defaultRiskPercent: 1.25,
        pollingIntervalSeconds: 2,
        allowedOrderTypes: ["MARKET", "LIMIT", "STOP"],
      }),
      headers: { "content-type": "application/json" },
    });
    const parsed = await json<{
      parsedSignalId: string;
      result: { lotSize: number; riskPercent: number };
    }>(
      await app.request("/api/parser/parse", {
        method: "POST",
        body: JSON.stringify({
          providerId: "provider-alpha",
          rawText:
            "BUY EURUSD @ 1.0860\nSL 1.0810\nTP1 1.0910\nTP2 1.0920\nTP3 1.0930\nTP4 1.0940\nLot 0.66\nRisk 0.5%",
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(parsed.result).toMatchObject({ lotSize: 0.66, riskPercent: 0.5 });

    const approve = await app.request(`/api/signals/${parsed.parsedSignalId}/approve`, {
      method: "POST",
    });
    expect(approve.status).toBe(200);

    const payload = await (await app.request("/api/mt5/poll-line?accountId=mt5-100200300")).text();
    expect(payload).toContain("volume=0.2");
    expect(payload).toContain("riskPercent=1.25");
    expect(payload).toContain("tp1Volume=0.05");
    expect(payload).toContain("tp2Volume=0.05");
    expect(payload).toContain("tp3Volume=0.05");
    expect(payload).toContain("tp4Volume=0.05");
  });

  test("sends zero fixed volume when provider sizing uses risk percent", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: true });
    await app.request("/api/mt5/poll-line?accountId=mt5-100200300");
    await app.request("/api/providers/provider-alpha", {
      method: "PATCH",
      body: JSON.stringify({ riskMode: "percent", riskAmount: 1.25, lotSize: 0.2 }),
      headers: { "content-type": "application/json" },
    });
    const parsed = await json<{ parsedSignalId: string }>(
      await app.request("/api/parser/parse", {
        method: "POST",
        body: JSON.stringify({
          providerId: "provider-alpha",
          rawText: "BUY EURUSD @ 1.0860\nSL 1.0810\nTP1 1.0910",
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(
      (await app.request(`/api/signals/${parsed.parsedSignalId}/approve`, { method: "POST" }))
        .status,
    ).toBe(200);

    const payload = await (await app.request("/api/mt5/poll-line?accountId=mt5-100200300")).text();
    expect(payload).toContain("volume=0");
    expect(payload).toContain("riskPercent=1.25");
    expect(payload).not.toContain("volume=0.2");
  });

  test("passes configured MT5 polling interval through work and no-work line payloads", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: true });

    await app.request("/api/settings", {
      method: "PATCH",
      body: JSON.stringify({
        defaultLotSize: 0.1,
        defaultRiskPercent: 1,
        pollingIntervalSeconds: 5,
        allowedOrderTypes: ["MARKET", "LIMIT", "STOP"],
      }),
      headers: { "content-type": "application/json" },
    });

    const workPayload = await (
      await app.request("/api/mt5/poll-line?accountId=mt5-100200300")
    ).text();
    expect(workPayload).toContain("status=WORK");
    expect(workPayload).toContain("pollSeconds=5");

    const noWorkPayload = await (
      await app.request("/api/mt5/poll-line?accountId=mt5-100200300")
    ).text();
    expect(noWorkPayload).toContain("status=NO_WORK");
    expect(noWorkPayload).toContain("pollSeconds=5");
  });

  test("records duplicate parsed signals as non-leaseable queue items", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: true });
    await app.request("/api/mt5/poll-line?accountId=mt5-100200300");

    const rawText = "BUY EURUSD @ 1.0860\nSL 1.0810\nTP1 1.0910";
    const firstParsed = await json<{ parsedSignalId: string }>(
      await app.request("/api/parser/parse", {
        method: "POST",
        body: JSON.stringify({ providerId: "provider-alpha", rawText }),
        headers: { "content-type": "application/json" },
      }),
    );
    const firstApproval = await app.request(`/api/signals/${firstParsed.parsedSignalId}/approve`, {
      method: "POST",
    });
    expect(firstApproval.status).toBe(200);

    const duplicateParsed = await json<{ parsedSignalId: string }>(
      await app.request("/api/parser/parse", {
        method: "POST",
        body: JSON.stringify({ providerId: "provider-alpha", rawText }),
        headers: { "content-type": "application/json" },
      }),
    );
    const duplicateApproval = await app.request(
      `/api/signals/${duplicateParsed.parsedSignalId}/approve`,
      { method: "POST" },
    );
    expect(duplicateApproval.status).toBe(409);

    const dashboard = await json<{
      signalQueue: Array<{ status: string; commandType: string }>;
    }>(await app.request("/api/dashboard"));
    expect(
      dashboard.signalQueue.some(
        (item) => item.status === "DUPLICATE" && item.commandType === "OPEN_TRADE",
      ),
    ).toBe(true);

    await app.request("/api/mt5/poll-line?accountId=mt5-100200300");
    const noWork = await (await app.request("/api/mt5/poll-line?accountId=mt5-100200300")).text();
    expect(noWork).toContain("status=NO_WORK");
  });

  test("deduplicates reworded open signals by execution parameters", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: true });
    await app.request("/api/mt5/poll-line?accountId=mt5-100200300");

    const first = await json<{ parsedSignalId: string }>(
      await app.request("/api/parser/parse", {
        method: "POST",
        body: JSON.stringify({
          providerId: "provider-alpha",
          rawText: "BUY EURUSD LIMIT @ 1.0860\nSL 1.0810\nTP1 1.0910",
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(
      (await app.request(`/api/signals/${first.parsedSignalId}/approve`, { method: "POST" }))
        .status,
    ).toBe(200);

    const restated = await json<{ parsedSignalId: string }>(
      await app.request("/api/parser/parse", {
        method: "POST",
        body: JSON.stringify({
          providerId: "provider-alpha",
          rawText: "EURUSD BUY LIMIT ENTRY 1.08604\nSTOP LOSS 1.0810\nTP 1.0920",
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(
      (await app.request(`/api/signals/${restated.parsedSignalId}/approve`, { method: "POST" }))
        .status,
    ).toBe(409);

    const dashboard = await json<{ signalQueue: Array<{ status: string }> }>(
      await app.request("/api/dashboard"),
    );
    expect(dashboard.signalQueue.filter((item) => item.status === "PENDING")).toHaveLength(1);
    expect(dashboard.signalQueue.some((item) => item.status === "DUPLICATE")).toBe(true);
  });

  test("excludes HELD from open dedup while PENDING, LEASED, and live trades still block", async () => {
    const priorSignal = realFixtureMessages(["17126"])[0]!.rawText;
    for (const status of ["HELD", "PENDING", "LEASED"] as const) {
      const prepared = await createEaOfflineApproval({
        rawText: priorSignal,
        releaseHeldOnEaReconnect: false,
      });
      try {
        if (status !== "HELD") {
          const db = new Database(prepared.databasePath);
          db.query("UPDATE queue_items SET status = ? WHERE id = ?").run(
            status,
            prepared.approved.queueItemId,
          );
          db.close();
        }
        expect((await heartbeatConfiguredAccount(prepared.app)).status).toBe(200);
        const parsed = await json<{ parsedSignalId: string }>(
          await prepared.app.request("/api/parser/parse", {
            method: "POST",
            body: JSON.stringify({
              providerId: prepared.approved.providerId,
              accountId: "mt5-63442826",
              rawText: realKalBuy4016Incident,
            }),
            headers: { "content-type": "application/json" },
          }),
        );
        const approval = await prepared.app.request(
          `/api/signals/${parsed.parsedSignalId}/approve`,
          { method: "POST" },
        );
        if (status === "HELD") {
          expect(approval.status).toBe(200);
          expect(await json<{ status: string }>(approval)).toMatchObject({ status: "PENDING" });
        } else {
          expect(approval.status).toBe(409);
        }
      } finally {
        await rm(prepared.tempDir, { recursive: true, force: true });
      }
    }

    const tempDir = await mkdtemp(join(tmpdir(), "telegram-tc-live-open-dedup-"));
    const databasePath = join(tempDir, "app.db");
    try {
      const app = createApi({ databasePath, seedDemoData: false, telegramAdapter: "mock" });
      const live = await approveGoldBuyLimit(app, priorSignal);
      const db = new Database(databasePath);
      db.query("UPDATE queue_items SET status = 'EXECUTED' WHERE id = ?").run(live.queueItemId);
      db.query(
        "UPDATE logical_trades SET status = 'OPEN', data_json = json_set(data_json, '$.status', 'OPEN') WHERE id = ?",
      ).run(live.logicalTradeId);
      expect(
        db.query("SELECT status FROM logical_trades WHERE id = ?").get(live.logicalTradeId),
      ).toEqual({ status: "OPEN" });
      db.close();

      const parsed = await json<{ parsedSignalId: string }>(
        await app.request("/api/parser/parse", {
          method: "POST",
          body: JSON.stringify({
            providerId: live.providerId,
            accountId: "mt5-63442826",
            rawText: realKalBuy4016Incident,
          }),
          headers: { "content-type": "application/json" },
        }),
      );
      expect(
        (await app.request(`/api/signals/${parsed.parsedSignalId}/approve`, { method: "POST" }))
          .status,
      ).toBe(409);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("queues the real 4016 incident after a prior-day EA_OFFLINE hold with no trade", async () => {
    const prepared = await createEaOfflineApproval({
      rawText: realFixtureMessages(["17126"])[0]!.rawText,
      releaseHeldOnEaReconnect: false,
    });
    try {
      const db = new Database(prepared.databasePath);
      db.query("UPDATE queue_items SET created_at = ?, updated_at = ? WHERE id = ?").run(
        new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
        new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
        prepared.approved.queueItemId,
      );
      expect(
        db
          .query("SELECT logical_trade_id, status, held_reason FROM queue_items WHERE id = ?")
          .get(prepared.approved.queueItemId),
      ).toEqual({ logical_trade_id: "", status: "HELD", held_reason: "EA_OFFLINE" });
      db.close();

      expect((await heartbeatConfiguredAccount(prepared.app)).status).toBe(200);
      const parsed = await json<{ parsedSignalId: string }>(
        await prepared.app.request("/api/parser/parse", {
          method: "POST",
          body: JSON.stringify({
            providerId: prepared.approved.providerId,
            accountId: "mt5-63442826",
            rawText: realKalBuy4016Incident,
          }),
          headers: { "content-type": "application/json" },
        }),
      );
      const response = await prepared.app.request(`/api/signals/${parsed.parsedSignalId}/approve`, {
        method: "POST",
      });
      expect(response.status).toBe(200);
      const approval = await json<{ queueItemId: string; status: string }>(response);
      expect(approval.status).toBe("PENDING");
      const after = new Database(prepared.databasePath, { readonly: true });
      expect(
        after.query("SELECT status FROM queue_items WHERE id = ?").get(approval.queueItemId),
      ).toEqual({ status: "PENDING" });
      expect(
        after.query("SELECT COUNT(*) AS n FROM queue_items WHERE status = 'DUPLICATE'").get(),
      ).toEqual({ n: 0 });
      after.close();
    } finally {
      await rm(prepared.tempDir, { recursive: true, force: true });
    }
  });

  test("does not let an unscoped manual trade suppress the provider at the same price", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: false });
    const providerId = await configureProviderWithAccount(app, {
      availableSymbols: ["XAUUSD", "EURUSD"],
    });
    const manual = await app.request("/api/signals/manual", {
      method: "POST",
      body: JSON.stringify({
        accountId: "mt5-63442826",
        direction: "BUY",
        orderType: "LIMIT",
        brokerSymbol: "XAUUSD",
        canonicalSymbol: "XAUUSD",
        entry: { from: 4016, to: 4015 },
        stopLoss: 4010,
        takeProfits: [{ price: 4021 }, { price: 4028 }],
      }),
      headers: { "content-type": "application/json" },
    });
    expect(manual.status).toBe(200);

    const parsed = await json<{ parsedSignalId: string }>(
      await app.request("/api/parser/parse", {
        method: "POST",
        body: JSON.stringify({
          providerId,
          accountId: "mt5-63442826",
          rawText: realKalBuy4016Incident,
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    const providerApproval = await app.request(`/api/signals/${parsed.parsedSignalId}/approve`, {
      method: "POST",
    });
    expect(providerApproval.status).toBe(200);
    expect(await json<{ status: string }>(providerApproval)).toMatchObject({ status: "PENDING" });
    const queue = await json<{ queue: Array<{ status: string }> }>(
      await app.request("/api/signals"),
    );
    expect(queue.queue.filter((item) => item.status === "PENDING")).toHaveLength(2);
    expect(queue.queue.some((item) => item.status === "DUPLICATE")).toBe(false);
  });

  test("partitions parameter deduplication by linked account", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: false });
    const providerId = await configureProviderWithAccount(app, { availableSymbols: ["XAUUSD"] });
    await app.request(`/api/account-provider-links/mt5-63442826/${providerId}`, {
      method: "PUT",
      body: JSON.stringify({ enabled: true }),
      headers: { "content-type": "application/json" },
    });
    await app.request("/api/mt5/register", {
      method: "POST",
      body: JSON.stringify({
        accountNumber: "200300400",
        server: "OctaFX-Real",
        company: "OctaFX",
        currency: "USD",
        balance: 10000,
        equity: 10000,
        marginMode: "HEDGING",
        availableSymbols: ["XAUUSD"],
        eaVersion: "1.57.4",
        eaCapabilities: ["lane2-close-contract", "pending-close-flatten-v1"],
      }),
      headers: { "content-type": "application/json" },
    });
    await app.request(`/api/account-provider-links/mt5-200300400/${providerId}`, {
      method: "PUT",
      body: JSON.stringify({ enabled: false }),
      headers: { "content-type": "application/json" },
    });

    const first = await json<{ parsedSignalId: string }>(
      await app.request("/api/parser/parse", {
        method: "POST",
        body: JSON.stringify({
          providerId,
          accountId: "mt5-63442826",
          rawText: "BUY XAUUSD LIMIT @ 1.0860\nSL 1.0810\nTP1 1.0910",
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(
      (await app.request(`/api/signals/${first.parsedSignalId}/approve`, { method: "POST" }))
        .status,
    ).toBe(200);

    await app.request(`/api/account-provider-links/mt5-200300400/${providerId}`, {
      method: "PUT",
      body: JSON.stringify({ enabled: true }),
      headers: { "content-type": "application/json" },
    });
    const second = await json<{ parsedSignalId: string }>(
      await app.request("/api/parser/parse", {
        method: "POST",
        body: JSON.stringify({
          providerId,
          rawText: "XAUUSD BUY LIMIT ENTRY 1.08604\nSTOP LOSS 1.0810\nTP 1.0920",
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    const approval = await json<{
      queueItems: string[];
      heldQueueItems: string[];
      status: string;
    }>(await app.request(`/api/signals/${second.parsedSignalId}/approve`, { method: "POST" }));
    expect(approval.status).toBe("PENDING");
    expect(approval.queueItems).toHaveLength(1);
    expect(approval.heldQueueItems).toHaveLength(1);
    expect(
      await (await app.request("/api/mt5/poll-line?accountId=mt5-200300400")).text(),
    ).toContain("status=WORK");

    const queue = await json<{
      queue: Array<{ accountId: string; status: string; heldReason?: string }>;
    }>(await app.request("/api/signals"));
    expect(queue.queue).toContainEqual(
      expect.objectContaining({
        accountId: "mt5-63442826",
        status: "DUPLICATE",
        heldReason: "DUPLICATE_OPEN_SIGNAL",
      }),
    );
    expect(queue.queue).toContainEqual(
      expect.objectContaining({ accountId: "mt5-200300400", status: "LEASED" }),
    );
  });

  test("releases an unmapped legacy cancel without weakening real symbol mismatch protection", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "telegram-tc-unmapped-cancel-release-"));
    const databasePath = join(tempDir, "app.db");
    try {
      const app = createApi({ databasePath, seedDemoData: false, telegramAdapter: "mock" });
      const open = await approveGoldBuyLimit(app, realFixtureMessages(["17126"])[0]!.rawText);
      await reportPendingAccepted(app, { queueItemId: open.queueItemId });
      const manualTrade = async (brokerSymbol: string, entry: number) => {
        const response = await app.request("/api/signals/manual", {
          method: "POST",
          body: JSON.stringify({
            accountId: "mt5-63442826",
            providerId: open.providerId,
            direction: "BUY",
            orderType: "LIMIT",
            brokerSymbol,
            canonicalSymbol: brokerSymbol,
            entry: { from: entry },
            stopLoss: entry - 1,
            takeProfits: [{ price: entry + 1 }],
          }),
          headers: { "content-type": "application/json" },
        });
        expect(response.status).toBe(200);
        return json<{ logicalTradeId: string }>(response);
      };
      await manualTrade("XAUUSD", 4050);
      const eurTrade = await manualTrade("EURUSD", 1.08);

      const cancel = await json<{
        parsedSignalId: string;
        result: { commandType: string; rawSymbol?: string };
      }>(
        await app.request("/api/parser/parse", {
          method: "POST",
          body: JSON.stringify({
            providerId: open.providerId,
            accountId: "mt5-63442826",
            rawText: realKalCancelOtherEntriesIncident,
          }),
          headers: { "content-type": "application/json" },
        }),
      );
      expect(cancel.result).toMatchObject({ commandType: "CANCEL_PENDING" });
      expect(cancel.result.rawSymbol).toBeUndefined();
      const heldCancel = await json<{ queueItemId: string; status: string }>(
        await app.request(`/api/signals/${cancel.parsedSignalId}/approve`, { method: "POST" }),
      );
      expect(heldCancel.status).toBe("HELD");

      // Preserve one pre-fix held row to exercise the release guard independently
      // from the parser correction.
      const db = new Database(databasePath);
      db.query(
        `UPDATE parsed_signals
         SET result_json = json_set(
           result_json,
           '$.rawSymbol', 'entries',
           '$.canonicalSymbol', 'ENTRIES',
           '$.mappingStatus', 'unmapped'
         )
         WHERE id = ?`,
      ).run(cancel.parsedSignalId);
      db.close();

      const released = await app.request(`/api/queue-items/${heldCancel.queueItemId}/requeue`, {
        method: "POST",
        body: JSON.stringify({ mode: "original", logicalTradeId: open.logicalTradeId }),
        headers: { "content-type": "application/json" },
      });
      const releasedBody = await json<{
        error?: string;
        logicalTradeId?: string;
        status?: string;
      }>(released);
      expect({ httpStatus: released.status, ...releasedBody }).toMatchObject({
        httpStatus: 200,
        logicalTradeId: open.logicalTradeId,
        status: "PENDING",
      });

      const realGoldCancel = realFixtureMessages(["16456"])[0]!.rawText;
      const mismatch = await json<{ parsedSignalId: string }>(
        await app.request("/api/parser/parse", {
          method: "POST",
          body: JSON.stringify({
            providerId: open.providerId,
            accountId: "mt5-63442826",
            rawText: realGoldCancel,
          }),
          headers: { "content-type": "application/json" },
        }),
      );
      const heldMismatch = await json<{ queueItemId: string; status: string }>(
        await app.request(`/api/signals/${mismatch.parsedSignalId}/approve`, { method: "POST" }),
      );
      expect(heldMismatch.status).toBe("HELD");
      const refused = await app.request(`/api/queue-items/${heldMismatch.queueItemId}/requeue`, {
        method: "POST",
        body: JSON.stringify({ mode: "original", logicalTradeId: eurTrade.logicalTradeId }),
        headers: { "content-type": "application/json" },
      });
      expect(refused.status).toBe(409);
      expect(await json<{ error: string }>(refused)).toMatchObject({
        error: "Selected logicalTradeId does not match the held lifecycle symbol",
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("projects duplicate suppressions as dismissible but never releasable", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: false });
    const first = await approveGoldBuyLimit(app, realFixtureMessages(["17126"])[0]!.rawText);
    const second = await json<{ parsedSignalId: string }>(
      await app.request("/api/parser/parse", {
        method: "POST",
        body: JSON.stringify({
          providerId: first.providerId,
          accountId: "mt5-63442826",
          rawText: realKalBuy4016Incident,
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(
      (await app.request(`/api/signals/${second.parsedSignalId}/approve`, { method: "POST" }))
        .status,
    ).toBe(409);

    const projected = await json<{
      items: Array<{
        id: string;
        actionable: boolean;
        heldReason: string;
        commandType: string;
      }>;
    }>(await app.request("/api/queue-items/held"));
    const duplicate = projected.items.find((item) => item.heldReason === "DUPLICATE_OPEN_SIGNAL");
    expect(duplicate).toMatchObject({
      actionable: false,
      commandType: "OPEN_TRADE",
      heldReason: "DUPLICATE_OPEN_SIGNAL",
    });

    const release = await app.request(`/api/queue-items/${duplicate!.id}/requeue`, {
      method: "POST",
      body: JSON.stringify({ mode: "original" }),
      headers: { "content-type": "application/json" },
    });
    expect(release.status).toBe(409);
    expect(await json<{ error: string }>(release)).toEqual({
      error: "Only HELD queue items can be requeued",
    });
    const dismiss = await app.request(`/api/queue-items/${duplicate!.id}/dismiss`, {
      method: "POST",
    });
    expect(dismiss.status).toBe(200);
    expect(await json<{ queueItemId: string; status: string }>(dismiss)).toEqual({
      queueItemId: duplicate!.id,
      status: "DISMISSED",
    });
    const after = await json<{ items: Array<{ id: string }> }>(
      await app.request("/api/queue-items/held"),
    );
    expect(after.items.some((item) => item.id === duplicate!.id)).toBe(false);
  });

  test("ingests the same held Telegram message twice into one raw, parse, and queue row", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "telegram-tc-same-message-ingestion-"));
    const databasePath = join(tempDir, "app.db");
    const realMessage = {
      ...realFixtureMessages(["521"])[0]!,
      messageDate: new Date().toISOString(),
    };
    try {
      const app = createApi({
        databasePath,
        seedDemoData: false,
        telegram: createQueuedTelegramAdapter([realMessage]),
        telegramPollingEnabled: false,
      });
      const providerId = await configureProviderWithAccount(app, {
        availableSymbols: ["XAUUSD"],
      });
      await app.request(`/api/providers/${providerId}`, {
        method: "PATCH",
        body: JSON.stringify({ openEvidence: "structured-id" }),
        headers: { "content-type": "application/json" },
      });
      const db = new Database(databasePath);
      db.query("UPDATE mt5_accounts SET last_heartbeat_at = ? WHERE id = ?").run(
        new Date(Date.now() - 31_000).toISOString(),
        "mt5-63442826",
      );
      db.close();

      const firstRun = await app.runTelegramIngestionOnce();
      const secondRun = await app.runTelegramIngestionOnce();
      expect(firstRun.errors).toBe(0);
      expect(secondRun.errors).toBe(0);

      const rows = new Database(databasePath, { readonly: true });
      expect(rows.query("SELECT COUNT(*) AS n FROM raw_messages").get()).toEqual({ n: 1 });
      expect(rows.query("SELECT COUNT(*) AS n FROM parsed_signals").get()).toEqual({ n: 1 });
      expect(rows.query("SELECT COUNT(*) AS n FROM queue_items").get()).toEqual({ n: 1 });
      expect(rows.query("SELECT status, held_reason FROM queue_items").get()).toEqual({
        status: "HELD",
        held_reason: "EA_OFFLINE",
      });
      rows.close();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("sends a new provider order after an identical terminal order", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "telegram-tc-order-id-terminal-dedup-"));
    const databasePath = join(tempDir, "app.db");
    try {
      const app = createApi({
        databasePath,
        seedDemoData: false,
        telegramAdapter: "mock",
        telegramPollingEnabled: false,
      });
      const providerId = await configureProviderWithAccount(app, { availableSymbols: ["XAUUSD"] });
      const parseOpen = async (providerOrderId: string) =>
        json<{ parsedSignalId: string }>(
          await app.request("/api/parser/parse", {
            method: "POST",
            body: JSON.stringify({
              providerId,
              accountId: "mt5-63442826",
              rawText: `NEW ORDER - XAUUSD Buy Stop # ${providerOrderId} Entry: 4141.10 SL: 4135.10 TP: 4150.10`,
            }),
            headers: { "content-type": "application/json" },
          }),
        );

      const first = await parseOpen("306307354");
      const firstApproval = await app.request(`/api/signals/${first.parsedSignalId}/approve`, {
        method: "POST",
      });
      expect(firstApproval.status).toBe(200);

      const db = new Database(databasePath);
      const row = db
        .query("SELECT id, data_json FROM logical_trades WHERE provider_id = ? LIMIT 1")
        .get(providerId) as { id: string; data_json: string };
      const terminalTrade = { ...JSON.parse(row.data_json), status: "CANCELLED" };
      db.query("UPDATE logical_trades SET status = ?, data_json = ? WHERE id = ?").run(
        "CANCELLED",
        JSON.stringify(terminalTrade),
        row.id,
      );
      db.close();

      const second = await parseOpen("306307354");
      const secondApproval = await app.request(`/api/signals/${second.parsedSignalId}/approve`, {
        method: "POST",
      });
      expect(secondApproval.status).toBe(200);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("records ignored parsed signals as non-leaseable queue items", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: true });
    await app.request("/api/mt5/poll-line?accountId=mt5-100200300");

    const parsed = await json<{ parsedSignalId: string; result: { commandType: string } }>(
      await app.request("/api/parser/parse", {
        method: "POST",
        body: JSON.stringify({
          providerId: "provider-alpha",
          rawText: "This is an education note about market structure, not a signal.",
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(parsed.result.commandType).toBe("NO_SIGNAL");

    const ignored = await json<{ status: string }>(
      await app.request(`/api/signals/${parsed.parsedSignalId}/ignore`, { method: "POST" }),
    );
    expect(ignored.status).toBe("IGNORED");

    const dashboard = await json<{
      signalQueue: Array<{ status: string; commandType: string }>;
    }>(await app.request("/api/dashboard"));
    expect(
      dashboard.signalQueue.some(
        (item) => item.status === "IGNORED" && item.commandType === "NO_SIGNAL",
      ),
    ).toBe(true);

    const noWork = await (await app.request("/api/mt5/poll-line?accountId=mt5-100200300")).text();
    expect(noWork).toContain("status=NO_WORK");
  });

  test("saves configurable symbol aliases and uses them in parser resolution", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: true });

    const alias = await app.request("/api/symbol-mappings/aliases", {
      method: "PUT",
      body: JSON.stringify({
        scope: "global",
        rawSymbol: "SILVER",
        canonicalSymbol: "XAGUSD",
      }),
      headers: { "content-type": "application/json" },
    });
    expect(alias.status).toBe(200);

    const accountMapping = await app.request("/api/symbol-mappings/account/mt5-100200300", {
      method: "PUT",
      body: JSON.stringify({
        accountId: "mt5-100200300",
        canonicalOverrides: {
          XAGUSD: "XAGUSD.pro",
        },
        suffix: ".raw",
        includeSymbols: ["XAGUSD.pro"],
        excludeSymbols: [],
        availableBrokerSymbols: ["XAGUSD.pro"],
      }),
      headers: { "content-type": "application/json" },
    });
    expect(accountMapping.status).toBe(200);

    const parsed = await json<{ result: { canonicalSymbol: string; brokerSymbol: string } }>(
      await app.request("/api/parser/parse", {
        method: "POST",
        body: JSON.stringify({
          providerId: "provider-alpha",
          accountId: "mt5-100200300",
          rawText: "BUY SILVER @ 31.20\nSL 30.90\nTP1 31.80",
        }),
        headers: { "content-type": "application/json" },
      }),
    );

    expect(parsed.result.canonicalSymbol).toBe("XAGUSD");
    expect(parsed.result.brokerSymbol).toBe("XAGUSD.pro");

    const mappings = await json<{
      globalAliases: Record<string, string>;
      accountMappings: Array<{ canonicalOverrides: Record<string, string> }>;
    }>(await app.request("/api/symbol-mappings"));
    expect(mappings.globalAliases.SILVER).toBe("XAGUSD");
    expect(mappings.accountMappings[0]?.canonicalOverrides.XAGUSD).toBe("XAGUSD.pro");
  });

  test("round-trips direct broker overrides and previews unrecognized aliases accurately", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: true });

    await app.request("/api/symbol-mappings/aliases", {
      method: "PUT",
      body: JSON.stringify({ scope: "global", rawSymbol: "GOLD", canonicalSymbol: "XAUUSD.RAW" }),
      headers: { "content-type": "application/json" },
    });
    await app.request("/api/symbol-mappings/account/mt5-100200300", {
      method: "PUT",
      body: JSON.stringify({ availableBrokerSymbols: ["XAUUSD.raw", "XAUUSD.pro"] }),
      headers: { "content-type": "application/json" },
    });
    const saved = await app.request("/api/symbol-mappings/account/mt5-100200300", {
      method: "PUT",
      body: JSON.stringify({
        accountId: "mt5-100200300",
        rawSymbol: " gold ",
        brokerSymbol: "XAUUSD.raw",
        direct: true,
      }),
      headers: { "content-type": "application/json" },
    });
    expect(saved.status).toBe(200);

    const mappings = await json<{
      accountMappings: Array<{ accountId: string; directBrokerOverrides: Record<string, string> }>;
      preview: Array<{
        rawSymbol: string;
        brokerSymbol: string;
        status: string;
        scope?: string;
        hint?: string;
      }>;
    }>(await app.request("/api/symbol-mappings"));
    expect(
      mappings.accountMappings.find((mapping) => mapping.accountId === "mt5-100200300")
        ?.directBrokerOverrides,
    ).toEqual({ GOLD: "XAUUSD.raw" });
    expect(
      mappings.preview.find(
        (mapping) => mapping.rawSymbol === "GOLD" && mapping.scope === "global",
      ),
    ).toMatchObject({ status: "unmapped", hint: "Symbol could not be mapped to a broker symbol" });
    expect(
      mappings.preview.find(
        (mapping) => mapping.rawSymbol === "GOLD" && mapping.scope === "account · direct",
      ),
    ).toMatchObject({ brokerSymbol: "XAUUSD.raw", status: "mapped" });

    const parsed = await json<{
      result: { canonicalSymbol: string; brokerSymbol: string; mappingStatus: string };
    }>(
      await app.request("/api/parser/parse", {
        method: "POST",
        body: JSON.stringify({
          providerId: "provider-alpha",
          accountId: "mt5-100200300",
          rawText: "BUY GOLD @ 3300\nSL 3290\nTP1 3310",
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(parsed.result).toMatchObject({
      canonicalSymbol: "XAUUSD",
      brokerSymbol: "XAUUSD.raw",
      mappingStatus: "mapped",
    });
    const dashboard = await json<{
      alerts?: Array<{ kind: string; detail?: { symbols?: string[] } }>;
    }>(await app.request("/api/dashboard"));
    expect(
      dashboard.alerts?.some(
        (alert) => alert.kind === "unmapped-symbols" && alert.detail?.symbols?.includes("GOLD"),
      ),
    ).toBe(false);
  });

  test("direct mapping saves preserve account safety settings and can be deleted", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: true });
    const accountId = "mt5-100200300";

    await app.request(`/api/symbol-mappings/account/${accountId}`, {
      method: "PUT",
      body: JSON.stringify({
        accountId,
        canonicalOverrides: { XAUUSD: "XAUUSD.raw" },
        suffix: ".raw",
        includeSymbols: ["XAUUSD.raw"],
        excludeSymbols: ["US30.raw"],
        availableBrokerSymbols: ["XAUUSD.raw"],
      }),
      headers: { "content-type": "application/json" },
    });
    const saved = await app.request(`/api/symbol-mappings/account/${accountId}`, {
      method: "PUT",
      body: JSON.stringify({
        accountId,
        rawSymbol: "GOLD",
        brokerSymbol: "XAUUSD.raw",
        direct: true,
      }),
      headers: { "content-type": "application/json" },
    });
    expect(saved.status).toBe(200);
    expect(
      await json<{ mapping: { suffix: string; excludeSymbols: string[] } }>(saved),
    ).toMatchObject({ mapping: { suffix: ".raw", excludeSymbols: ["US30.raw"] } });

    const deleted = await app.request(`/api/symbol-mappings/account/${accountId}/direct`, {
      method: "DELETE",
      body: JSON.stringify({ rawSymbol: "GOLD" }),
      headers: { "content-type": "application/json" },
    });
    expect(deleted.status).toBe(200);
    const mappings = await json<{
      accountMappings: Array<{ accountId: string; directBrokerOverrides: Record<string, string> }>;
    }>(await app.request("/api/symbol-mappings"));
    expect(
      mappings.accountMappings.find((mapping) => mapping.accountId === accountId)
        ?.directBrokerOverrides,
    ).toEqual({});
  });

  test("rejects direct mappings without a provider symbol", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: true });
    const response = await app.request("/api/symbol-mappings/account/mt5-100200300", {
      method: "PUT",
      body: JSON.stringify({ direct: true, rawSymbol: "", brokerSymbol: "XAUUSD.raw" }),
      headers: { "content-type": "application/json" },
    });
    expect(response.status).toBe(400);
    expect(await json<{ error: string }>(response)).toEqual({
      error: "Direct mapping requires provider and broker symbols",
    });
  });

  test("previews aliases against the selected account safety rules", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: true });
    const accountId = "mt5-100200300";
    await app.request(`/api/symbol-mappings/account/${accountId}`, {
      method: "PUT",
      body: JSON.stringify({
        accountId,
        canonicalOverrides: { XAUUSD: "XAUUSD.raw" },
        excludeSymbols: ["XAUUSD.raw"],
        availableBrokerSymbols: ["XAUUSD.raw"],
      }),
      headers: { "content-type": "application/json" },
    });

    const mappings = await json<{
      preview: Array<{ rawSymbol: string; scope?: string; status: string; hint?: string }>;
    }>(await app.request(`/api/symbol-mappings?accountId=${accountId}`));
    expect(
      mappings.preview.find(
        (mapping) => mapping.rawSymbol === "GOLD" && mapping.scope === "global",
      ),
    ).toMatchObject({ status: "excluded", hint: "Symbol is excluded for this account" });
  });

  test("parses a reply cancel before its comment-only replacement and infers the replacement limit", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: false });
    const providerId = await configureProviderWithAccount(app, { availableSymbols: ["XAUUSD"] });
    await app.request(`/api/providers/${providerId}`, {
      method: "PATCH",
      body: JSON.stringify({ lockedSymbol: "XAUUSD" }),
      headers: { "content-type": "application/json" },
    });
    await app.request(`/api/account-provider-links/mt5-63442826/${providerId}`, {
      method: "PUT",
      body: JSON.stringify({ enabled: true }),
      headers: { "content-type": "application/json" },
    });
    await app.request("/api/symbol-mappings/aliases", {
      method: "PUT",
      body: JSON.stringify({ scope: "global", rawSymbol: "GOLD", canonicalSymbol: "XAUUSD" }),
      headers: { "content-type": "application/json" },
    });
    await app.request("/api/mt5/snapshot", {
      method: "POST",
      body: JSON.stringify({
        accountId: "mt5-63442826",
        positions: [],
        orders: [],
        symbols: [{ symbol: "XAUUSD", bid: 4019.8, ask: 4020.2, point: 0.01 }],
      }),
      headers: { "content-type": "application/json" },
    });
    const parsed = await json<{
      parsedSignalIds: string[];
      results: Array<{
        commandType: string;
        direction?: string;
        entry?: { from: number };
        mappingStatus?: string;
        brokerSymbol?: string;
      }>;
    }>(
      await app.request("/api/parser/parse", {
        method: "POST",
        body: JSON.stringify({
          providerId,
          accountId: "mt5-63442826",
          rawText:
            "Quoted signal:\nGold sell\n\n4028-29\n\nSl 4034\n\nTp 4023\nTp 4016\nTp 4010\n\nComment:\nCancel this … price dropped from 24 instead of 28 soo it's technically missed . We can sell from 4043 instead",
        }),
        headers: { "content-type": "application/json" },
      }),
    );

    expect(parsed.results).toMatchObject([
      { commandType: "CANCEL_PENDING" },
      {
        commandType: "OPEN_TRADE",
        direction: "SELL",
        entry: { from: 4043 },
        mappingStatus: "mapped",
        brokerSymbol: "XAUUSD",
      },
    ]);
    const approval = await app.request(`/api/signals/${parsed.parsedSignalIds[1]}/approve`, {
      method: "POST",
    });
    expect(approval.status).toBe(200);
    expect(await json<{ status: string }>(approval)).toMatchObject({ status: "PENDING" });
    const work = await (await app.request("/api/mt5/poll-line?accountId=mt5-63442826")).text();
    expect(work).toContain("commandType=OPEN_TRADE");
    expect(work).toContain("orderType=LIMIT");
    expect(work).toContain("entryFrom=4043");
  });

  test("merges account symbol mapping edits with EA-reported symbols", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: true });

    await app.request("/api/mt5/register", {
      method: "POST",
      body: JSON.stringify({
        accountNumber: "54870107",
        server: "HFMarketsSA-Live2",
        company: "HF Markets SA (Pty) Ltd",
        currency: "USD",
        balance: 10000,
        equity: 10000,
        marginMode: "HEDGING",
        availableSymbols: ["XAUUSDr", "EURUSDr"],
      }),
      headers: { "content-type": "application/json" },
    });

    await app.request("/api/symbol-mappings/account/mt5-54870107", {
      method: "PUT",
      body: JSON.stringify({
        accountId: "mt5-54870107",
        canonicalOverrides: { XAUUSD: "XAUUSDr" },
        prefix: "",
        suffix: "r",
        includeSymbols: ["XAUUSDr"],
        excludeSymbols: [],
      }),
      headers: { "content-type": "application/json" },
    });

    await app.request("/api/symbol-mappings/account/mt5-54870107", {
      method: "PUT",
      body: JSON.stringify({
        accountId: "mt5-54870107",
        canonicalOverrides: { EURUSD: "EURUSDr" },
        prefix: "",
        suffix: "r",
        includeSymbols: ["XAUUSDr", "EURUSDr"],
        excludeSymbols: ["BTCUSDr"],
      }),
      headers: { "content-type": "application/json" },
    });

    const mappings = await json<{
      accountMappings: Array<{
        accountId: string;
        canonicalOverrides: Record<string, string>;
        prefix: string;
        suffix: string;
        includeSymbols: string[];
        excludeSymbols: string[];
        availableBrokerSymbols: string[];
      }>;
    }>(await app.request("/api/symbol-mappings"));
    const hfMapping = mappings.accountMappings.find(
      (mapping) => mapping.accountId === "mt5-54870107",
    );
    expect(hfMapping).toMatchObject({
      canonicalOverrides: {
        XAUUSD: "XAUUSDr",
        EURUSD: "EURUSDr",
      },
      prefix: "",
      suffix: "r",
      includeSymbols: ["XAUUSDr", "EURUSDr"],
      excludeSymbols: ["BTCUSDr"],
      availableBrokerSymbols: ["XAUUSDr", "EURUSDr"],
    });

    const parsed = await json<{ result: { brokerSymbol: string; mappingStatus: string } }>(
      await app.request("/api/parser/parse", {
        method: "POST",
        body: JSON.stringify({
          providerId: "provider-alpha",
          accountId: "mt5-54870107",
          rawText: "Gold buy limit\n\n4487-86\n\nSL 4481\n\nTP 4492",
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(parsed.result.brokerSymbol).toBe("XAUUSDr");
    expect(parsed.result.mappingStatus).toBe("mapped");
  });

  test("does not infer a global suffix from one HF-Markets-shaped outlier", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: false });
    const majors = ["EURUSD", "GBPUSD", "AUDUSD"];
    const availableSymbols = [
      ...Array.from({ length: 386 }, (_, index) => majors[index % majors.length]!),
      "XAUUSDb",
    ];
    await app.request("/api/mt5/register", {
      method: "POST",
      body: JSON.stringify({
        accountNumber: "700001",
        server: "HF-Markets",
        company: "HF Markets",
        currency: "USD",
        balance: 10000,
        equity: 10000,
        marginMode: "HEDGING",
        availableSymbols,
      }),
      headers: { "content-type": "application/json" },
    });
    const mappings = await json<{
      accountMappings: Array<{ accountId: string; prefix: string; suffix: string }>;
    }>(await app.request("/api/symbol-mappings"));
    expect(mappings.accountMappings).toContainEqual(
      expect.objectContaining({ accountId: "mt5-700001", prefix: "", suffix: "" }),
    );
  });

  test("infers a .raw suffix when it covers a clear majority of a broker inventory", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: false });
    const majors = ["EURUSD", "GBPUSD", "AUDUSD"];
    const availableSymbols = [
      ...Array.from({ length: 300 }, (_, index) => `${majors[index % majors.length]}.raw`),
      ...Array.from({ length: 87 }, (_, index) => majors[index % majors.length]!),
    ];
    await app.request("/api/mt5/register", {
      method: "POST",
      body: JSON.stringify({
        accountNumber: "700002",
        server: "Trive",
        company: "Trive",
        currency: "USD",
        balance: 10000,
        equity: 10000,
        marginMode: "HEDGING",
        availableSymbols,
      }),
      headers: { "content-type": "application/json" },
    });
    const mappings = await json<{
      accountMappings: Array<{ accountId: string; prefix: string; suffix: string }>;
    }>(await app.request("/api/symbol-mappings"));
    expect(mappings.accountMappings).toContainEqual(
      expect.objectContaining({ accountId: "mt5-700002", prefix: "", suffix: ".raw" }),
    );
  });

  test("holds an approval when its only target lacks a symbol mapping", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: false });
    const providerId = await configureProviderWithAccount(app, { availableSymbols: ["EURUSD"] });

    const parsed = await json<{ parsedSignalId: string }>(
      await app.request("/api/parser/parse", {
        method: "POST",
        body: JSON.stringify({
          providerId,
          accountId: "mt5-63442826",
          rawText: "Gold buy limit\n\n4487-86\n\nSL 4481\n\nTP 4492",
        }),
        headers: { "content-type": "application/json" },
      }),
    );

    const approval = await app.request(`/api/signals/${parsed.parsedSignalId}/approve`, {
      method: "POST",
    });
    expect(approval.status).toBe(200);
    expect(await json<{ status: string }>(approval)).toMatchObject({ status: "HELD" });
  });

  test("matches lifecycle commands to an existing logical trade and rejects duplicate management messages", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: true });
    await app.request("/api/mt5/poll-line?accountId=mt5-100200300");
    await app.request("/api/mt5/snapshot", {
      method: "POST",
      body: JSON.stringify({
        accountId: "mt5-100200300",
        positions: [
          {
            ticket: "70001",
            symbol: "EURUSD.raw",
            type: 0,
            volume: 0.1,
            openPrice: 1.085,
            sl: 1.081,
            tp: 0,
            magic: 26050901,
            isExternal: false,
            comment: "ttc:demo-1",
          },
        ],
        orders: [],
      }),
      headers: { "content-type": "application/json" },
    });

    const firstParse = await json<{ parsedSignalId: string; reviewRequired: boolean }>(
      await app.request("/api/parser/parse", {
        method: "POST",
        body: JSON.stringify({ providerId: "provider-alpha", rawText: "Close half" }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(firstParse.reviewRequired).toBe(true);

    const firstApprove = await app.request(`/api/signals/${firstParse.parsedSignalId}/approve`, {
      method: "POST",
    });
    const approved = await json<{ queueItemId: string; logicalTradeId: string; status: string }>(
      firstApprove,
    );
    expect(firstApprove.status).toBe(200);
    expect(approved.logicalTradeId).toBe("trade-demo-1");
    expect(approved.status).toBe("PENDING");

    const pollLine = await (await app.request("/api/mt5/poll-line?accountId=mt5-100200300")).text();
    expect(pollLine).toContain("commandType=CLOSE_TRADE");
    expect(pollLine).toContain("logicalTradeId=trade-demo-1");
    expect(pollLine).toContain("brokerSymbol=EURUSD.raw");
    expect(pollLine).toContain("partialCloseKind=");
    expect(pollLine).toContain("runnerEnabled=false");

    const duplicateParse = await json<{ parsedSignalId: string }>(
      await app.request("/api/parser/parse", {
        method: "POST",
        body: JSON.stringify({ providerId: "provider-alpha", rawText: "Close half" }),
        headers: { "content-type": "application/json" },
      }),
    );
    const duplicateApprove = await app.request(
      `/api/signals/${duplicateParse.parsedSignalId}/approve`,
      {
        method: "POST",
      },
    );
    expect(duplicateApprove.status).toBe(409);
  });

  test("flattens a pending order that fills between provider close approval and EA execution", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: false });
    const providerId = await configureProviderWithAccount(app, { availableSymbols: ["XAUUSD"] });
    const opened = await json<{ parsedSignalId: string }>(
      await app.request("/api/parser/parse", {
        method: "POST",
        body: JSON.stringify({
          providerId,
          accountId: "mt5-63442826",
          rawText: "BUY XAUUSD STOP @ 4500\nSL 4490\nTP 4520",
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    const opening = await json<{ queueItemId: string; logicalTradeId: string }>(
      await app.request(`/api/signals/${opened.parsedSignalId}/approve`, { method: "POST" }),
    );
    await app.request("/api/mt5/poll-line?accountId=mt5-63442826");
    await app.request("/api/mt5/report", {
      method: "POST",
      body: JSON.stringify({
        accountId: "mt5-63442826",
        queueItemId: opening.queueItemId,
        status: "EXECUTED",
        retcode: 10008,
        retcodeExternal: 0,
        brokerComment: "pending accepted",
        orderTicket: "50001",
        positionTicket: "70001",
        requestedPrice: 4500,
        filledPrice: 4500,
        requestedVolume: 0.04,
        filledVolume: 0,
        remainingVolume: 0.04,
      }),
      headers: { "content-type": "application/json" },
    });
    await app.request("/api/mt5/snapshot", {
      method: "POST",
      body: JSON.stringify({
        accountId: "mt5-63442826",
        positions: [],
        orders: [],
        symbols: [],
      }),
      headers: { "content-type": "application/json" },
    });
    const closing = await json<{ parsedSignalId: string }>(
      await app.request("/api/parser/parse", {
        method: "POST",
        body: JSON.stringify({
          providerId,
          accountId: "mt5-63442826",
          rawText: "CLOSED - XAUUSD Buy",
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    const cancellation = await json<{ queueItemId: string }>(
      await app.request(`/api/signals/${closing.parsedSignalId}/approve`, { method: "POST" }),
    );
    await app.request("/api/mt5/snapshot", {
      method: "POST",
      body: JSON.stringify({
        accountId: "mt5-63442826",
        positions: [
          {
            ticket: "70002",
            symbol: "XAUUSD",
            type: 0,
            volume: 0.04,
            openPrice: 4501,
            magic: 26050901,
            isExternal: false,
            comment: `ttc:${opening.logicalTradeId.slice(6)}`,
          },
        ],
        orders: [],
        symbols: [],
      }),
      headers: { "content-type": "application/json" },
    });
    const work = await (await app.request("/api/mt5/poll-line?accountId=mt5-63442826")).text();
    expect(work).toContain("commandType=CLOSE_TRADE");
    expect(work).not.toContain("targetOrderTicket=50001");
    expect(
      (
        await json<{ logicalTrades: Array<{ id: string; status: string }> }>(
          await app.request("/api/dashboard"),
        )
      ).logicalTrades.find((trade) => trade.id === opening.logicalTradeId)?.status,
    ).toBe("OPEN");

    await app.request("/api/mt5/report", {
      method: "POST",
      body: JSON.stringify({
        accountId: "mt5-63442826",
        queueItemId: cancellation.queueItemId,
        status: "EXECUTED",
        retcode: 10009,
        retcodeExternal: 0,
        brokerComment: "pending order and position flattened",
        orderTicket: "50001",
        positionTicket: "70002",
        requestedVolume: 0.04,
        filledVolume: 0.04,
        remainingVolume: 0,
      }),
      headers: { "content-type": "application/json" },
    });
    expect(
      (
        await json<{ logicalTrades: Array<{ id: string; status: string }> }>(
          await app.request("/api/dashboard"),
        )
      ).logicalTrades.find((trade) => trade.id === opening.logicalTradeId)?.status,
    ).toBe("CLOSED");
  });

  test("records a partial market open at its actual fill and resizes its TP legs", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: true });
    const open = await json<{ item: { id: string } | null }>(
      await app.request("/api/mt5/poll?accountId=mt5-100200300"),
    );
    await app.request("/api/mt5/report", {
      method: "POST",
      body: JSON.stringify({
        accountId: "mt5-100200300",
        queueItemId: open.item!.id,
        status: "PARTIAL",
        retcode: 10010,
        retcodeExternal: 0,
        brokerComment: "partial IOC fill",
        orderTicket: "70001",
        positionTicket: "70001",
        dealTicket: "70001",
        requestedVolume: 0.1,
        filledVolume: 0.01,
        remainingVolume: 0.09,
        requestedPrice: 1.085,
        filledPrice: 1.085,
      }),
      headers: { "content-type": "application/json" },
    });

    const orders = await json<{ orders: Array<{ requestedVolume: number; filledVolume: number }> }>(
      await app.request("/api/trades/trade-demo-1/broker-orders"),
    );
    expect(orders.orders[0]).toMatchObject({ requestedVolume: 0.1, filledVolume: 0.01 });
    const dashboard = await json<{
      logicalTrades: Array<{
        id: string;
        status: string;
        legs: Array<{ leg: number; volume?: number; allocationPercent: number; status: string }>;
      }>;
    }>(await app.request("/api/dashboard"));
    const trade = dashboard.logicalTrades.find((item) => item.id === "trade-demo-1");
    expect(trade?.status).toBe("OPEN");
    expect(trade?.legs[0]).toMatchObject({
      leg: 1,
      volume: 0.01,
      allocationPercent: 100,
      status: "OPEN",
    });
    expect(trade?.legs.slice(1)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ leg: 2, allocationPercent: 0, status: "SKIPPED" }),
      ]),
    );
  });

  test("holds lane-2 close work for an EA that reports no version or capability", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: true });
    const open = await json<{ item: { id: string } | null }>(
      await app.request("/api/mt5/poll?accountId=mt5-100200300"),
    );
    await app.request("/api/mt5/report", {
      method: "POST",
      body: JSON.stringify({
        accountId: "mt5-100200300",
        queueItemId: open.item!.id,
        status: "EXECUTED",
        retcode: 10009,
        retcodeExternal: 0,
        brokerComment: "opened",
        orderTicket: "70001",
        positionTicket: "70001",
        dealTicket: "70001",
        requestedVolume: 0.1,
        filledVolume: 0.1,
        remainingVolume: 0.1,
        requestedPrice: 1.085,
        filledPrice: 1.085,
      }),
      headers: { "content-type": "application/json" },
    });
    await app.request("/api/mt5/heartbeat", {
      method: "POST",
      body: JSON.stringify({
        accountId: "mt5-100200300",
        balance: 10000,
        equity: 10000,
        availableSymbols: ["EURUSD.raw"],
      }),
      headers: { "content-type": "application/json" },
    });
    const parsed = await json<{ parsedSignalId: string }>(
      await app.request("/api/parser/parse", {
        method: "POST",
        body: JSON.stringify({ providerId: "provider-alpha", rawText: "Close EURUSD" }),
        headers: { "content-type": "application/json" },
      }),
    );
    const close = await json<{ queueItemId: string }>(
      await app.request(`/api/signals/${parsed.parsedSignalId}/approve`, { method: "POST" }),
    );
    expect(
      await (await app.request("/api/mt5/poll-line?accountId=mt5-100200300")).text(),
    ).toContain("status=NO_WORK");
    const dashboard = await json<{
      mt5Accounts: Array<{ id: string; eaVersion?: string; eaCapabilities?: string[] }>;
    }>(await app.request("/api/dashboard"));
    expect(dashboard.mt5Accounts[0]?.eaVersion).toBeUndefined();
    expect(dashboard.mt5Accounts[0]?.eaCapabilities).toEqual([]);
    const queue = await json<{ queue: Array<{ id: string; status: string; heldReason?: string }> }>(
      await app.request("/api/signals"),
    );
    expect(queue.queue).toContainEqual(
      expect.objectContaining({
        id: close.queueItemId,
        status: "HELD",
        heldReason: "EA_CAPABILITY_UNAVAILABLE",
      }),
    );
  });

  test("holds pending close flattening without the capability even at version 1.57.1", async () => {
    for (const eaCapabilities of [["lane2-close-contract"], []]) {
      const app = createApi({ databasePath: ":memory:", seedDemoData: false });
      const providerId = await configureProviderWithAccount(app, {
        availableSymbols: ["XAUUSD"],
        eaVersion: "1.57.1",
        eaCapabilities,
      });
      const opened = await json<{ parsedSignalId: string }>(
        await app.request("/api/parser/parse", {
          method: "POST",
          body: JSON.stringify({
            providerId,
            accountId: "mt5-63442826",
            rawText: "BUY XAUUSD STOP @ 4500\nSL 4490\nTP 4520",
          }),
          headers: { "content-type": "application/json" },
        }),
      );
      const opening = await json<{ queueItemId: string }>(
        await app.request(`/api/signals/${opened.parsedSignalId}/approve`, { method: "POST" }),
      );
      await app.request("/api/mt5/poll-line?accountId=mt5-63442826");
      await app.request("/api/mt5/report", {
        method: "POST",
        body: JSON.stringify({
          accountId: "mt5-63442826",
          queueItemId: opening.queueItemId,
          status: "EXECUTED",
          retcode: 10008,
          retcodeExternal: 0,
          brokerComment: "pending accepted",
          orderTicket: "50001",
          requestedVolume: 0.04,
          filledVolume: 0,
          remainingVolume: 0.04,
        }),
        headers: { "content-type": "application/json" },
      });
      const closing = await json<{ parsedSignalId: string }>(
        await app.request("/api/parser/parse", {
          method: "POST",
          body: JSON.stringify({
            providerId,
            accountId: "mt5-63442826",
            rawText: "CLOSED - XAUUSD Buy",
          }),
          headers: { "content-type": "application/json" },
        }),
      );
      const close = await json<{ queueItemId: string }>(
        await app.request(`/api/signals/${closing.parsedSignalId}/approve`, { method: "POST" }),
      );
      expect(
        await (await app.request("/api/mt5/poll-line?accountId=mt5-63442826")).text(),
      ).toContain("status=NO_WORK");
      const queue = await json<{
        queue: Array<{ id: string; status: string; heldReason?: string }>;
      }>(await app.request("/api/signals"));
      expect(queue.queue).toContainEqual(
        expect.objectContaining({
          id: close.queueItemId,
          status: "HELD",
          heldReason: eaCapabilities.includes("lane2-close-contract")
            ? "EA_CAPABILITY_UNAVAILABLE:pending-close-flatten-v1"
            : "EA_CAPABILITY_UNAVAILABLE",
        }),
      );
    }
  });

  test("holds a partial close with actual fill evidence instead of terminalizing the trade", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: true });
    const open = await json<{ item: { id: string } | null }>(
      await app.request("/api/mt5/poll?accountId=mt5-100200300"),
    );
    await app.request("/api/mt5/report", {
      method: "POST",
      body: JSON.stringify({
        accountId: "mt5-100200300",
        queueItemId: open.item!.id,
        status: "EXECUTED",
        retcode: 10009,
        retcodeExternal: 0,
        brokerComment: "opened",
        orderTicket: "70001",
        positionTicket: "70001",
        dealTicket: "70001",
        requestedVolume: 0.03,
        filledVolume: 0.03,
        remainingVolume: 0.03,
        requestedPrice: 1.085,
        filledPrice: 1.085,
      }),
      headers: { "content-type": "application/json" },
    });
    const parsed = await json<{ parsedSignalId: string }>(
      await app.request("/api/parser/parse", {
        method: "POST",
        body: JSON.stringify({ providerId: "provider-alpha", rawText: "Close EURUSD" }),
        headers: { "content-type": "application/json" },
      }),
    );
    const close = await json<{ queueItemId: string }>(
      await app.request(`/api/signals/${parsed.parsedSignalId}/approve`, { method: "POST" }),
    );
    await app.request("/api/mt5/poll-line?accountId=mt5-100200300");
    await app.request("/api/mt5/report", {
      method: "POST",
      body: JSON.stringify({
        accountId: "mt5-100200300",
        queueItemId: close.queueItemId,
        status: "PARTIAL",
        retcode: 10010,
        retcodeExternal: 0,
        brokerComment: "partial IOC fill",
        orderTicket: "70002",
        positionTicket: "70001",
        dealTicket: "70002",
        requestedVolume: 0.03,
        filledVolume: 0.01,
        remainingVolume: 0.02,
        requestedPrice: 1.085,
        filledPrice: 1.0849,
      }),
      headers: { "content-type": "application/json" },
    });
    const dashboard = await json<{ logicalTrades: Array<{ id: string; status: string }> }>(
      await app.request("/api/dashboard"),
    );
    const queue = await json<{ queue: Array<{ id: string; status: string; heldReason?: string }> }>(
      await app.request("/api/signals"),
    );
    expect(dashboard.logicalTrades.find((trade) => trade.id === "trade-demo-1")?.status).toBe(
      "OPEN",
    );
    expect(queue.queue).toContainEqual(
      expect.objectContaining({
        id: close.queueItemId,
        status: "HELD",
        heldReason: "PARTIAL_FILL",
      }),
    );

    const retry = await json<{ queueItemId: string }>(
      await app.request(`/api/queue-items/${close.queueItemId}/requeue`, {
        method: "POST",
        body: JSON.stringify({ mode: "original" }),
        headers: { "content-type": "application/json" },
      }),
    );
    const retryWork = await (
      await app.request("/api/mt5/poll-line?accountId=mt5-100200300")
    ).text();
    expect(retryWork).toContain(`queueItemId=${retry.queueItemId}`);
    await app.request("/api/mt5/report", {
      method: "POST",
      body: JSON.stringify({
        accountId: "mt5-100200300",
        queueItemId: retry.queueItemId,
        status: "EXECUTED",
        retcode: 10009,
        retcodeExternal: 0,
        brokerComment: "remaining close confirmed",
        positionTicket: "70001",
        dealTicket: "70003",
        requestedVolume: 0.02,
        filledVolume: 0.02,
        remainingVolume: 0,
      }),
      headers: { "content-type": "application/json" },
    });
    const flattened = await json<{ logicalTrades: Array<{ id: string; status: string }> }>(
      await app.request("/api/dashboard"),
    );
    expect(flattened.logicalTrades.find((trade) => trade.id === "trade-demo-1")?.status).toBe(
      "CLOSED",
    );
    expect(
      await (await app.request("/api/mt5/poll-line?accountId=mt5-100200300")).text(),
    ).toContain("status=NO_WORK");
  });

  test("holds a lost provider-close delivery rather than replaying it against the remainder", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "telegram-tc-lifecycle-unknown-"));
    const databasePath = join(tempDir, "app.db");
    try {
      const app = createApi({ databasePath, seedDemoData: true });
      const open = await json<{ item: { id: string } | null }>(
        await app.request("/api/mt5/poll?accountId=mt5-100200300"),
      );
      await app.request("/api/mt5/report", {
        method: "POST",
        body: JSON.stringify({
          accountId: "mt5-100200300",
          queueItemId: open.item!.id,
          status: "EXECUTED",
          retcode: 10009,
          retcodeExternal: 0,
          brokerComment: "opened",
          orderTicket: "70001",
          positionTicket: "70001",
          dealTicket: "70001",
          requestedVolume: 0.04,
          filledVolume: 0.04,
          remainingVolume: 0.04,
          requestedPrice: 1.085,
          filledPrice: 1.085,
        }),
        headers: { "content-type": "application/json" },
      });
      await app.request("/api/mt5/snapshot", {
        method: "POST",
        body: JSON.stringify({
          accountId: "mt5-100200300",
          positions: [
            {
              ticket: "70001",
              symbol: "EURUSD.raw",
              type: 0,
              volume: 0.04,
              openPrice: 1.085,
              sl: 1.081,
              tp: 0,
              magic: 26050901,
              isExternal: false,
              comment: "ttc:demo-1",
            },
          ],
          orders: [],
        }),
        headers: { "content-type": "application/json" },
      });
      const parsed = await json<{ parsedSignalId: string }>(
        await app.request("/api/parser/parse", {
          method: "POST",
          body: JSON.stringify({ providerId: "provider-alpha", rawText: "Close half EURUSD" }),
          headers: { "content-type": "application/json" },
        }),
      );
      const close = await json<{ queueItemId: string }>(
        await app.request(`/api/signals/${parsed.parsedSignalId}/approve`, { method: "POST" }),
      );
      const firstWork = await (
        await app.request("/api/mt5/poll-line?accountId=mt5-100200300")
      ).text();
      expect(firstWork).toContain("commandType=CLOSE_TRADE");
      expect(firstWork).toContain(`idempotencyKey=${close.queueItemId}`);

      const db = new Database(databasePath);
      db.query("UPDATE queue_items SET leased_at = ? WHERE id = ?").run(
        new Date(0).toISOString(),
        close.queueItemId,
      );
      db.close();

      const retryWork = await (
        await app.request("/api/mt5/poll-line?accountId=mt5-100200300")
      ).text();
      expect(retryWork).toContain("status=NO_WORK");
      const queue = await json<{
        queue: Array<{ id: string; status: string; heldReason?: string }>;
      }>(await app.request("/api/signals"));
      expect(queue.queue).toContainEqual(
        expect.objectContaining({
          id: close.queueItemId,
          status: "HELD",
          heldReason: "DELIVERY_UNKNOWN",
        }),
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("queues trailing-stop lifecycle commands with pips or points preserved for the EA", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: true });
    await app.request("/api/mt5/poll-line?accountId=mt5-100200300");

    const parsed = await json<{ parsedSignalId: string; reviewRequired: boolean }>(
      await app.request("/api/parser/parse", {
        method: "POST",
        body: JSON.stringify({ providerId: "provider-alpha", rawText: "Trail stop 50 pips" }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(parsed.reviewRequired).toBe(true);

    const approve = await app.request(`/api/signals/${parsed.parsedSignalId}/approve`, {
      method: "POST",
    });
    expect(approve.status).toBe(200);

    const pollLine = await (await app.request("/api/mt5/poll-line?accountId=mt5-100200300")).text();
    expect(pollLine).toContain("commandType=TRAILING_STOP");
    expect(pollLine).toContain("logicalTradeId=trade-demo-1");
    expect(pollLine).toContain("trailingStopValue=50");
    expect(pollLine).toContain("trailingStopUnit=PIPS");
  });

  test("refuses lifecycle approvals that are missing executable values", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: true });

    const modifySl = await json<{ parsedSignalId: string; reviewRequired: boolean }>(
      await app.request("/api/parser/parse", {
        method: "POST",
        body: JSON.stringify({ providerId: "provider-alpha", rawText: "Modify SL EURUSD" }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(modifySl.reviewRequired).toBe(true);
    const modifyApproval = await app.request(`/api/signals/${modifySl.parsedSignalId}/approve`, {
      method: "POST",
    });
    expect(modifyApproval.status).toBe(200);
    expect((await json<{ status: string }>(modifyApproval)).status).toBe("HELD");

    const trailing = await json<{ parsedSignalId: string; reviewRequired: boolean }>(
      await app.request("/api/parser/parse", {
        method: "POST",
        body: JSON.stringify({ providerId: "provider-alpha", rawText: "Trail stop EURUSD" }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(trailing.reviewRequired).toBe(true);
    const trailingApproval = await app.request(`/api/signals/${trailing.parsedSignalId}/approve`, {
      method: "POST",
    });
    expect(trailingApproval.status).toBe(200);
    expect((await json<{ status: string }>(trailingApproval)).status).toBe("HELD");
  });

  test("auto-ingests clean lifecycle commands after matching an active provider trade", async () => {
    const telegram = createQueuedTelegramAdapter([
      {
        telegramMessageId: "btc-open-1",
        messageDate: "2026-05-16T18:51:10.000Z",
        rawText: "SELL BTCUSD @ 50000\nSL 50100\nTP 49800",
      },
      {
        telegramMessageId: "btc-trail-1",
        messageDate: "2026-05-16T18:51:20.000Z",
        replyToMessageId: "btc-open-1",
        rawText: "Trail stop BTCUSD by 50 pips",
      },
    ]);
    const app = createApi({
      databasePath: ":memory:",
      seedDemoData: false,
      telegram,
      telegramPollingEnabled: false,
    });
    await configureProviderWithAccount(app, {
      availableSymbols: ["BTCUSD", "XAUUSD", "EURUSD"],
    });

    const result = await app.runTelegramIngestionOnce();

    expect(result.parsed).toBe(2);
    expect(result.reviewRequired).toBe(0);
    expect(result.queued).toBe(2);

    const openPayload = await (
      await app.request("/api/mt5/poll-line?accountId=mt5-63442826")
    ).text();
    const trailPayload = await (
      await app.request("/api/mt5/poll-line?accountId=mt5-63442826")
    ).text();
    expect(openPayload).toContain("commandType=OPEN_TRADE");
    expect(trailPayload).toContain("commandType=TRAILING_STOP");
    expect(trailPayload).toContain("trailingStopValue=50");
    expect(trailPayload).toContain("trailingStopUnit=PIPS");
  });

  test("enriches TP-leg partial closes with the planned close volume", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: true });
    await app.request("/api/mt5/poll-line?accountId=mt5-100200300");

    const parsed = await json<{ parsedSignalId: string }>(
      await app.request("/api/parser/parse", {
        method: "POST",
        body: JSON.stringify({ providerId: "provider-alpha", rawText: "Close TP1 EURUSD" }),
        headers: { "content-type": "application/json" },
      }),
    );
    const approve = await app.request(`/api/signals/${parsed.parsedSignalId}/approve`, {
      method: "POST",
    });
    expect(approve.status).toBe(200);

    const pollLine = await (await app.request("/api/mt5/poll-line?accountId=mt5-100200300")).text();
    expect(pollLine).toContain("commandType=CLOSE_PARTIAL");
    expect(pollLine).toContain("partialCloseKind=TP_LEG");
    expect(pollLine).toContain("partialCloseValue=1");
    expect(pollLine).toContain("partialCloseVolume=0.03");
  });

  test("preserves percent-risk runner configuration for MT5 and blocks split-order runner mode", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: false });
    const providerId = await configureProviderWithAccount(app, {
      availableSymbols: ["EURUSD.raw"],
    });
    await app.request(`/api/providers/${providerId}`, {
      method: "PATCH",
      body: JSON.stringify({
        riskMode: "percent",
        riskAmount: 1,
        runner: { enabled: true, lotSize: 0.02, slBehavior: "trail", trailPips: 25 },
      }),
      headers: { "content-type": "application/json" },
    });

    const splitParsed = await json<{ parsedSignalId: string }>(
      await app.request("/api/parser/parse", {
        method: "POST",
        body: JSON.stringify({
          providerId,
          accountId: "mt5-63442826",
          rawText: "BUY EURUSD @ 1.0850\nSL 1.0810\nTP1 1.0900",
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    const splitApproval = await app.request(`/api/signals/${splitParsed.parsedSignalId}/approve`, {
      method: "POST",
      body: JSON.stringify({ executionMode: "SPLIT_ORDER" }),
      headers: { "content-type": "application/json" },
    });
    expect(splitApproval.status).toBe(422);
    expect((await json<{ error: string }>(splitApproval)).error).toContain("Runner");

    const virtualParsed = await json<{ parsedSignalId: string }>(
      await app.request("/api/parser/parse", {
        method: "POST",
        body: JSON.stringify({
          providerId,
          accountId: "mt5-63442826",
          rawText: "BUY EURUSD @ 1.0860\nSL 1.0810\nTP1 1.0910",
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    const virtualApproval = await app.request(
      `/api/signals/${virtualParsed.parsedSignalId}/approve`,
      {
        method: "POST",
      },
    );
    expect(virtualApproval.status).toBe(200);

    const pollLine = await (await app.request("/api/mt5/poll-line?accountId=mt5-63442826")).text();
    expect(pollLine).toContain("executionMode=VIRTUAL_TP");
    expect(pollLine).toContain("volume=0");
    expect(pollLine).toContain("runnerEnabled=true");
    expect(pollLine).toContain("runnerVolume=0.02");
    expect(pollLine).toContain("runnerSlBehavior=trail");
    expect(pollLine).toContain("runnerTrailPips=25");
  });

  test("app-managed default TP closes the traded portion and moves runner SL to break-even", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: false });
    const providerId = await configureProviderWithAccount(app, {
      availableSymbols: ["EURUSD.raw"],
    });
    await app.request(`/api/providers/${providerId}`, {
      method: "PATCH",
      body: JSON.stringify({
        riskMode: "fixed",
        riskAmount: 0.02,
        runner: { enabled: true, lotSize: 0.01, slBehavior: "break-even", trailPips: 10 },
      }),
      headers: { "content-type": "application/json" },
    });

    const parsed = await json<{ parsedSignalId: string }>(
      await app.request("/api/parser/parse", {
        method: "POST",
        body: JSON.stringify({
          providerId,
          accountId: "mt5-63442826",
          rawText: "BUY EURUSD",
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    const approval = await json<{ queueItemId: string; logicalTradeId: string }>(
      await app.request(`/api/signals/${parsed.parsedSignalId}/approve`, { method: "POST" }),
    );
    const shortId = approval.logicalTradeId.replace(/^trade[_-]/, "");
    const openWork = await (await app.request("/api/mt5/poll-line?accountId=mt5-63442826")).text();
    expect(openWork).toContain("defaultTakeProfitValue=200");
    expect(openWork).toContain("runnerVolume=0.01");

    await app.request("/api/mt5/report", {
      method: "POST",
      body: JSON.stringify({
        accountId: "mt5-63442826",
        queueItemId: approval.queueItemId,
        status: "EXECUTED",
        retcode: 10009,
        retcodeExternal: 0,
        brokerComment: `ttc:${shortId}`,
        orderTicket: "70001",
        positionTicket: "70001",
        dealTicket: "60001",
        requestedPrice: 1.086,
        filledPrice: 1.086,
        volume: 0.02,
        errorText: "",
      }),
      headers: { "content-type": "application/json" },
    });

    await app.request("/api/mt5/snapshot", {
      method: "POST",
      body: JSON.stringify({
        accountId: "mt5-63442826",
        positions: [
          {
            ticket: "70001",
            symbol: "EURUSD.raw",
            type: 0,
            volume: 0.02,
            openPrice: 1.086,
            sl: 1.081,
            tp: 0,
            profit: 40,
            magic: 26050901,
            isExternal: false,
            comment: `ttc:${shortId}`,
          },
        ],
        orders: [],
        symbols: [{ symbol: "EURUSD.raw", bid: 1.106, ask: 1.1062, point: 0.00001 }],
      }),
      headers: { "content-type": "application/json" },
    });

    const closeWork = await (await app.request("/api/mt5/poll-line?accountId=mt5-63442826")).text();
    expect(closeWork).toContain("commandType=CLOSE_PARTIAL");
    expect(closeWork).toContain("partialCloseKind=TP_LEG");
    expect(closeWork).toContain("partialCloseValue=1");
    expect(closeWork).toContain("partialCloseVolume=0.01");
    expect(closeWork).toContain("targetPositionTicket=70001");
    const closeQueueId = closeWork.match(/queueItemId=([^\n]+)/)?.[1];
    expect(closeQueueId).toBeTruthy();

    await app.request("/api/mt5/report", {
      method: "POST",
      body: JSON.stringify({
        accountId: "mt5-63442826",
        queueItemId: closeQueueId,
        status: "EXECUTED",
        retcode: 10009,
        retcodeExternal: 0,
        brokerComment: "Request executed",
        orderTicket: "70002",
        positionTicket: "70001",
        dealTicket: "60002",
        requestedPrice: 1.106,
        filledPrice: 1.106,
        volume: 0.01,
        errorText: "",
      }),
      headers: { "content-type": "application/json" },
    });

    const slWork = await (await app.request("/api/mt5/poll-line?accountId=mt5-63442826")).text();
    expect(slWork).toContain("commandType=MODIFY_SL");
    expect(slWork).toContain("newStopLoss=1.086");
    expect(slWork).toContain("targetPositionTicket=70001");

    const dashboard = await json<{
      logicalTrades: Array<{ id: string; status: string; legs: Array<{ status: string }> }>;
    }>(await app.request("/api/dashboard"));
    expect(
      dashboard.logicalTrades.find((trade) => trade.id === approval.logicalTradeId),
    ).toMatchObject({
      status: "OPEN",
      legs: [{ status: "CLOSED" }],
    });
  });

  test("retains unconfigured Telegram TP legs instead of silently dropping them", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: false });
    const providerId = await configureProviderWithAccount(app, {
      availableSymbols: ["EURUSD.raw"],
    });
    await app.request(`/api/providers/${providerId}`, {
      method: "PATCH",
      body: JSON.stringify({
        riskMode: "fixed",
        riskAmount: 0.02,
        takeProfitLevels: [
          { leg: 1, percentage: 100, strategy: { kind: "set-sl-to-entry", offsetPips: 0 } },
        ],
      }),
      headers: { "content-type": "application/json" },
    });

    const parsed = await json<{ parsedSignalId: string }>(
      await app.request("/api/parser/parse", {
        method: "POST",
        body: JSON.stringify({
          providerId,
          accountId: "mt5-63442826",
          rawText: "BUY EURUSD @ 1.0860\nSL 1.0810\nTP1 1.0910\nTP2 1.0950",
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    const approval = await json<{ queueItemId: string; logicalTradeId: string }>(
      await app.request(`/api/signals/${parsed.parsedSignalId}/approve`, { method: "POST" }),
    );
    const shortId = approval.logicalTradeId.replace(/^trade[_-]/, "");
    const openWork = await (await app.request("/api/mt5/poll-line?accountId=mt5-63442826")).text();
    expect(openWork).not.toContain("defaultTakeProfitValue=200");
    expect(openWork).toContain("runnerEnabled=false");
    expect(openWork).toContain("tp1=1.091");
    expect(openWork).toContain("tp1Allocation=50");
    expect(openWork).toContain("tp2=1.095");
    expect(openWork).toContain("tp2Allocation=50");

    await app.request("/api/mt5/report", {
      method: "POST",
      body: JSON.stringify({
        accountId: "mt5-63442826",
        queueItemId: approval.queueItemId,
        status: "EXECUTED",
        retcode: 10009,
        retcodeExternal: 0,
        brokerComment: `ttc:${shortId}`,
        orderTicket: "70001",
        positionTicket: "70001",
        dealTicket: "60001",
        requestedPrice: 1.086,
        filledPrice: 1.086,
        volume: 0.02,
        errorText: "",
      }),
      headers: { "content-type": "application/json" },
    });

    await app.request("/api/mt5/snapshot", {
      method: "POST",
      body: JSON.stringify({
        accountId: "mt5-63442826",
        positions: [
          {
            ticket: "70001",
            symbol: "EURUSD.raw",
            type: 0,
            volume: 0.02,
            openPrice: 1.086,
            sl: 1.081,
            tp: 0,
            profit: 40,
            magic: 26050901,
            isExternal: false,
            comment: `ttc:${shortId}`,
          },
        ],
        orders: [],
        symbols: [{ symbol: "EURUSD.raw", bid: 1.091, ask: 1.0912, point: 0.00001 }],
      }),
      headers: { "content-type": "application/json" },
    });

    const closeWork = await (await app.request("/api/mt5/poll-line?accountId=mt5-63442826")).text();
    expect(closeWork).toContain("commandType=CLOSE_PARTIAL");
    expect(closeWork).toContain("partialCloseKind=TP_LEG");
    expect(closeWork).toContain("partialCloseValue=1");
    expect(closeWork).toContain("partialCloseVolume=0.01");
    expect(closeWork).toContain("targetPositionTicket=70001");
  });

  test("a 0 percent reference TP leg moves the stop without closing volume", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: false });
    const providerId = await configureProviderWithAccount(app, {
      availableSymbols: ["EURUSD.raw"],
    });
    // KAL VIP shape: leg 1 carries no volume and exists only to move the stop to
    // entry when price reaches TP1. Leg 2 closes the whole position.
    await app.request(`/api/providers/${providerId}`, {
      method: "PATCH",
      body: JSON.stringify({
        riskMode: "fixed",
        riskAmount: 0.02,
        takeProfitLevels: [
          { leg: 1, percentage: 0, strategy: { kind: "set-sl-to-entry", offsetPips: 0 } },
          { leg: 2, percentage: 100, strategy: { kind: "set-sl-to-tp", tpLeg: 1, offsetPips: 0 } },
        ],
      }),
      headers: { "content-type": "application/json" },
    });

    const parsed = await json<{ parsedSignalId: string }>(
      await app.request("/api/parser/parse", {
        method: "POST",
        body: JSON.stringify({
          providerId,
          accountId: "mt5-63442826",
          rawText: "BUY EURUSD @ 1.0860\nSL 1.0810\nTP1 1.0910\nTP2 1.0950",
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    const approval = await json<{ queueItemId: string; logicalTradeId: string }>(
      await app.request(`/api/signals/${parsed.parsedSignalId}/approve`, { method: "POST" }),
    );
    const shortId = approval.logicalTradeId.replace(/^trade[_-]/, "");
    await (await app.request("/api/mt5/poll-line?accountId=mt5-63442826")).text();

    await app.request("/api/mt5/report", {
      method: "POST",
      body: JSON.stringify({
        accountId: "mt5-63442826",
        queueItemId: approval.queueItemId,
        status: "EXECUTED",
        retcode: 10009,
        retcodeExternal: 0,
        brokerComment: `ttc:${shortId}`,
        orderTicket: "70101",
        positionTicket: "70101",
        dealTicket: "60101",
        requestedPrice: 1.086,
        filledPrice: 1.086,
        volume: 0.02,
        errorText: "",
      }),
      headers: { "content-type": "application/json" },
    });

    // Price crosses TP1 (1.0910) but not TP2 (1.0950).
    await app.request("/api/mt5/snapshot", {
      method: "POST",
      body: JSON.stringify({
        accountId: "mt5-63442826",
        positions: [
          {
            ticket: "70101",
            symbol: "EURUSD.raw",
            type: 0,
            volume: 0.02,
            openPrice: 1.086,
            sl: 1.081,
            tp: 0,
            profit: 40,
            magic: 26050901,
            isExternal: false,
            comment: `ttc:${shortId}`,
          },
        ],
        orders: [],
        symbols: [{ symbol: "EURUSD.raw", bid: 1.0911, ask: 1.0913, point: 0.00001 }],
      }),
      headers: { "content-type": "application/json" },
    });

    const work = await (await app.request("/api/mt5/poll-line?accountId=mt5-63442826")).text();
    // The reference leg must move the stop to the filled open price...
    expect(work).toContain("commandType=MODIFY_SL");
    expect(work).toContain("newStopLoss=1.086");
    expect(work).toContain("targetPositionTicket=70101");
    // ...and must never close volume, because it is allocated 0 percent.
    expect(work).not.toContain("commandType=CLOSE_PARTIAL");
  });

  test("coalesces several crossed reference legs into one most-protective stop", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: false });
    const providerId = await configureProviderWithAccount(app, {
      availableSymbols: ["EURUSD.raw"],
    });
    await app.request(`/api/providers/${providerId}`, {
      method: "PATCH",
      body: JSON.stringify({
        riskMode: "fixed",
        riskAmount: 0.02,
        takeProfitLevels: [
          { leg: 1, percentage: 0, strategy: { kind: "set-sl-to-entry", offsetPips: 0 } },
          { leg: 2, percentage: 0, strategy: { kind: "set-sl-to-tp", tpLeg: 1, offsetPips: 0 } },
          { leg: 3, percentage: 100, strategy: { kind: "no-change" } },
        ],
      }),
      headers: { "content-type": "application/json" },
    });
    const approval = await openVirtualTpTrade(app, providerId, {
      rawText: "BUY EURUSD @ 1.0860\nSL 1.0810\nTP1 1.0910\nTP2 1.0920\nTP3 1.0950",
      ticket: "70201",
      filledPrice: 1.086,
    });
    // Price gaps past TP1 (1.0910) and TP2 (1.0920), not TP3.
    await postVirtualTpSnapshot(app, approval, {
      ticket: "70201",
      bid: 1.093,
      ask: 1.0932,
      sl: 1.081,
    });

    const first = await (await app.request("/api/mt5/poll-line?accountId=mt5-63442826")).text();
    // Leg 2's set-sl-to-tp(1) yields 1.0910, which beats leg 1's entry of 1.0860 on a BUY.
    expect(first).toContain("commandType=MODIFY_SL");
    expect(first).toContain("newStopLoss=1.091");
    // Exactly one stop command: a second poll must find no further reference work.
    const second = await (await app.request("/api/mt5/poll-line?accountId=mt5-63442826")).text();
    expect(second).not.toContain("commandType=MODIFY_SL");
  });

  test("never regresses a stop the broker already holds at a better level", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: false });
    const providerId = await configureProviderWithAccount(app, {
      availableSymbols: ["EURUSD.raw"],
    });
    await app.request(`/api/providers/${providerId}`, {
      method: "PATCH",
      body: JSON.stringify({
        riskMode: "fixed",
        riskAmount: 0.02,
        takeProfitLevels: [
          { leg: 1, percentage: 0, strategy: { kind: "set-sl-to-entry", offsetPips: 0 } },
          { leg: 2, percentage: 100, strategy: { kind: "no-change" } },
        ],
      }),
      headers: { "content-type": "application/json" },
    });
    const approval = await openVirtualTpTrade(app, providerId, {
      rawText: "BUY EURUSD @ 1.0860\nSL 1.0810\nTP1 1.0910\nTP2 1.0950",
      ticket: "70301",
      filledPrice: 1.086,
    });
    // The broker stop is already at 1.0900, better than set-sl-to-entry's 1.0860 on a BUY.
    await postVirtualTpSnapshot(app, approval, {
      ticket: "70301",
      bid: 1.0911,
      ask: 1.0913,
      sl: 1.09,
    });

    const work = await (await app.request("/api/mt5/poll-line?accountId=mt5-63442826")).text();
    expect(work).not.toContain("commandType=MODIFY_SL");
    expect(work).not.toContain("commandType=CLOSE_PARTIAL");
  });

  test("a provider-announced TP hit still moves the stop on a reference leg", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: false });
    const providerId = await configureProviderWithAccount(app, {
      availableSymbols: ["EURUSD.raw"],
    });
    await app.request(`/api/providers/${providerId}`, {
      method: "PATCH",
      body: JSON.stringify({
        riskMode: "fixed",
        riskAmount: 0.02,
        takeProfitLevels: [
          { leg: 1, percentage: 0, strategy: { kind: "set-sl-to-entry", offsetPips: 0 } },
          { leg: 2, percentage: 100, strategy: { kind: "no-change" } },
        ],
      }),
      headers: { "content-type": "application/json" },
    });
    const approval = await openVirtualTpTrade(app, providerId, {
      rawText: "BUY EURUSD @ 1.0860\nSL 1.0810\nTP1 1.0910\nTP2 1.0950",
      ticket: "70401",
      filledPrice: 1.086,
    });
    // Price has NOT reached TP1, so the monitor cannot be the trigger.
    await postVirtualTpSnapshot(app, approval, {
      ticket: "70401",
      bid: 1.0875,
      ask: 1.0877,
      sl: 1.081,
    });
    expect(
      await (await app.request("/api/mt5/poll-line?accountId=mt5-63442826")).text(),
    ).not.toContain("commandType=MODIFY_SL");

    // The provider announces TP1 instead.
    const hit = await json<{ parsedSignalId: string }>(
      await app.request("/api/parser/parse", {
        method: "POST",
        body: JSON.stringify({ providerId, accountId: "mt5-63442826", rawText: "TP 1" }),
        headers: { "content-type": "application/json" },
      }),
    );
    await app.request(`/api/signals/${hit.parsedSignalId}/approve`, { method: "POST" });

    const work = await (await app.request("/api/mt5/poll-line?accountId=mt5-63442826")).text();
    expect(work).toContain("commandType=MODIFY_SL");
    expect(work).toContain("newStopLoss=1.086");
  });

  test("a provider TP hit before the first snapshot does not burn the reference leg", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: false });
    const providerId = await configureProviderWithAccount(app, {
      availableSymbols: ["EURUSD.raw"],
    });
    await app.request(`/api/providers/${providerId}`, {
      method: "PATCH",
      body: JSON.stringify({
        riskMode: "fixed",
        riskAmount: 0.02,
        takeProfitLevels: [
          { leg: 1, percentage: 0, strategy: { kind: "set-sl-to-entry", offsetPips: 0 } },
          { leg: 2, percentage: 100, strategy: { kind: "no-change" } },
        ],
      }),
      headers: { "content-type": "application/json" },
    });
    // The OPEN_TRADE report clears matchedBrokerTickets until the next matching snapshot, so
    // an announcement landing in this window has no position to modify.
    const approval = await openVirtualTpTrade(app, providerId, {
      rawText: "BUY EURUSD @ 1.0860\nSL 1.0810\nTP1 1.0910\nTP2 1.0950",
      ticket: "70501",
      filledPrice: 1.086,
    });

    const hit = await json<{ parsedSignalId: string }>(
      await app.request("/api/parser/parse", {
        method: "POST",
        body: JSON.stringify({ providerId, accountId: "mt5-63442826", rawText: "TP 1" }),
        headers: { "content-type": "application/json" },
      }),
    );
    await app.request(`/api/signals/${hit.parsedSignalId}/approve`, { method: "POST" });
    // Nothing could be queued, so the leg must NOT have been consumed.
    expect(
      await (await app.request("/api/mt5/poll-line?accountId=mt5-63442826")).text(),
    ).not.toContain("commandType=MODIFY_SL");

    // The monitor must still be able to fire it once a snapshot arrives past TP1.
    await postVirtualTpSnapshot(app, approval, {
      ticket: "70501",
      bid: 1.0911,
      ask: 1.0913,
      sl: 1.081,
    });
    const work = await (await app.request("/api/mt5/poll-line?accountId=mt5-63442826")).text();
    expect(work).toContain("commandType=MODIFY_SL");
    expect(work).toContain("newStopLoss=1.086");
  });

  test("repairs an executed reference stop when the live position no longer holds it", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: false });
    const providerId = await configureVirtualTpProvider(app, {
      takeProfitLevels: [
        { leg: 1, percentage: 0, strategy: { kind: "set-sl-to-entry", offsetPips: 0 } },
        { leg: 2, percentage: 100, strategy: { kind: "no-change" } },
      ],
    });
    const approval = await openVirtualTpTrade(app, providerId, {
      rawText: "BUY EURUSD @ 1.0860\nSL 1.0810\nTP1 1.0910\nTP2 1.0950",
      ticket: "70601",
      filledPrice: 1.086,
    });
    await postVirtualTpSnapshot(app, approval, {
      ticket: "70601",
      bid: 1.0911,
      ask: 1.0913,
      sl: 1.081,
    });
    const firstWork = await (await app.request("/api/mt5/poll-line?accountId=mt5-63442826")).text();
    const firstQueueItemId = firstWork.match(/queueItemId=([^\n]+)/)?.[1];
    expect(firstWork).toContain("newStopLoss=1.086");
    expect(firstQueueItemId).toBeTruthy();
    await reportExecutedQueue(app, {
      queueItemId: firstQueueItemId!,
      ticket: "70601",
      price: 1.086,
    });

    await postVirtualTpSnapshot(app, approval, {
      ticket: "70601",
      bid: 1.087,
      ask: 1.0872,
      sl: 0,
    });
    const repairWork = await (
      await app.request("/api/mt5/poll-line?accountId=mt5-63442826")
    ).text();
    expect(repairWork).toContain("commandType=MODIFY_SL");
    expect(repairWork).toContain("newStopLoss=1.086");
    expect(repairWork).not.toContain(`queueItemId=${firstQueueItemId}`);
  });

  test("reconciles a delivery-unknown reference stop after restart without duplicating it", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "telegram-tc-reference-restart-"));
    const databasePath = join(tempDir, "app.db");
    try {
      const app = createApi({
        databasePath,
        seedDemoData: false,
        telegramAdapter: "mock",
        telegramPollingEnabled: false,
      });
      const providerId = await configureVirtualTpProvider(app, {
        takeProfitLevels: [
          { leg: 1, percentage: 0, strategy: { kind: "set-sl-to-entry", offsetPips: 0 } },
          { leg: 2, percentage: 100, strategy: { kind: "no-change" } },
        ],
      });
      const approval = await openVirtualTpTrade(app, providerId, {
        rawText: "BUY EURUSD @ 1.0860\nSL 1.0810\nTP1 1.0910\nTP2 1.0950",
        ticket: "70701",
        filledPrice: 1.086,
      });
      await postVirtualTpSnapshot(app, approval, {
        ticket: "70701",
        bid: 1.0911,
        ask: 1.0913,
        sl: 1.081,
      });
      const leased = await (await app.request("/api/mt5/poll-line?accountId=mt5-63442826")).text();
      const queueItemId = leased.match(/queueItemId=([^\n]+)/)?.[1];
      expect(queueItemId).toBeTruthy();

      const setup = new Database(databasePath);
      setup
        .query("UPDATE queue_items SET leased_at = ? WHERE id = ?")
        .run("2000-01-01T00:00:00.000Z", queueItemId!);
      setup.close();
      await app.request("/api/mt5/poll-line?accountId=mt5-63442826");

      const held = new Database(databasePath);
      expect(
        held.query("SELECT status, held_reason FROM queue_items WHERE id = ?").get(queueItemId!),
      ).toEqual({ status: "HELD", held_reason: "DELIVERY_UNKNOWN" });
      // Simulate an upgrade from v1.65.4, before durable reference-stop actions existed.
      held
        .query("DELETE FROM reference_stop_actions WHERE logical_trade_id = ?")
        .run(approval.logicalTradeId);
      held.close();

      const restarted = createApi({
        databasePath,
        seedDemoData: false,
        telegramAdapter: "mock",
        telegramPollingEnabled: false,
      });
      await postVirtualTpSnapshot(restarted, approval, {
        ticket: "70701",
        bid: 1.087,
        ask: 1.0872,
        sl: 1.081,
      });
      const replayed = await (
        await restarted.request("/api/mt5/poll-line?accountId=mt5-63442826")
      ).text();
      expect(replayed).toContain(`queueItemId=${queueItemId}`);
      expect(replayed).toContain("newStopLoss=1.086");

      const verify = new Database(databasePath, { readonly: true });
      expect(
        verify
          .query(
            "SELECT COUNT(*) AS n FROM queue_items WHERE json_extract(payload_json, '$.idempotencyKey') LIKE 'reference-stop:%'",
          )
          .get(),
      ).toEqual({ n: 1 });
      verify.close();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("rolls back queue insertion with HIT persistence and retains a crossing across restart", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "telegram-tc-reference-atomic-"));
    const databasePath = join(tempDir, "app.db");
    try {
      const app = createApi({
        databasePath,
        seedDemoData: false,
        telegramAdapter: "mock",
        telegramPollingEnabled: false,
      });
      const providerId = await configureVirtualTpProvider(app, {
        takeProfitLevels: [
          { leg: 1, percentage: 0, strategy: { kind: "set-sl-to-entry", offsetPips: 0 } },
          { leg: 2, percentage: 100, strategy: { kind: "no-change" } },
        ],
      });
      const approval = await openVirtualTpTrade(app, providerId, {
        rawText: "BUY EURUSD @ 1.0860\nSL 1.0810\nTP1 1.0910\nTP2 1.0950",
        ticket: "70801",
        filledPrice: 1.086,
      });
      const setup = new Database(databasePath);
      const tradeId = approval.logicalTradeId.replaceAll("'", "''");
      setup.run(`
        CREATE TRIGGER abort_reference_hit BEFORE UPDATE OF data_json ON logical_trades
        WHEN OLD.id = '${tradeId}'
         AND EXISTS (
           SELECT 1 FROM reference_stop_actions WHERE logical_trade_id = OLD.id
         )
        BEGIN
          SELECT RAISE(ABORT, 'reference HIT write failed');
        END
      `);
      setup.close();

      const failed = await postVirtualTpSnapshot(app, approval, {
        ticket: "70801",
        bid: 1.0911,
        ask: 1.0913,
        sl: 1.081,
      });
      expect(failed.status).toBe(500);

      const afterFailure = new Database(databasePath);
      expect(
        afterFailure
          .query(
            "SELECT COUNT(*) AS n FROM queue_items WHERE json_extract(payload_json, '$.commandType') = 'MODIFY_SL'",
          )
          .get(),
      ).toEqual({ n: 0 });
      expect(afterFailure.query("SELECT COUNT(*) AS n FROM reference_stop_actions").get()).toEqual({
        n: 0,
      });
      const persisted = afterFailure
        .query("SELECT data_json FROM logical_trades WHERE id = ?")
        .get(approval.logicalTradeId) as { data_json: string };
      const trade = JSON.parse(persisted.data_json) as {
        legs: Array<{ status: string }>;
        virtualTpWatermark?: { favorablePrice: number };
      };
      expect(trade.legs[0]?.status).toBe("OPEN");
      expect(trade.virtualTpWatermark?.favorablePrice).toBe(1.0911);
      afterFailure.run("DROP TRIGGER abort_reference_hit");
      afterFailure.close();

      const restarted = createApi({
        databasePath,
        seedDemoData: false,
        telegramAdapter: "mock",
        telegramPollingEnabled: false,
      });
      // The watermark remembers the crossing, but a BUY stop cannot be placed above the
      // current bid. Keep the leg open until price is back above the desired stop.
      await postVirtualTpSnapshot(restarted, approval, {
        ticket: "70801",
        bid: 1.0855,
        ask: 1.0857,
        sl: 1.081,
      });
      expect(
        await (await restarted.request("/api/mt5/poll-line?accountId=mt5-63442826")).text(),
      ).not.toContain("commandType=MODIFY_SL");

      await postVirtualTpSnapshot(restarted, approval, {
        ticket: "70801",
        bid: 1.087,
        ask: 1.0872,
        sl: 1.081,
      });
      const work = await (
        await restarted.request("/api/mt5/poll-line?accountId=mt5-63442826")
      ).text();
      expect(work).toContain("commandType=MODIFY_SL");
      expect(work).toContain("newStopLoss=1.086");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("coalesces SELL reference legs when the broker reports no stop", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: false });
    const providerId = await configureVirtualTpProvider(app, {
      takeProfitLevels: [
        { leg: 1, percentage: 0, strategy: { kind: "set-sl-to-entry", offsetPips: 0 } },
        { leg: 2, percentage: 0, strategy: { kind: "set-sl-to-tp", tpLeg: 1, offsetPips: 0 } },
        { leg: 3, percentage: 100, strategy: { kind: "no-change" } },
      ],
    });
    const approval = await openVirtualTpTrade(app, providerId, {
      rawText: "SELL EURUSD @ 1.1000\nSL 1.1050\nTP1 1.0950\nTP2 1.0900\nTP3 1.0850",
      ticket: "70901",
      filledPrice: 1.1,
    });
    await app.request("/api/mt5/snapshot", {
      method: "POST",
      body: JSON.stringify({
        accountId: "mt5-63442826",
        positions: [
          {
            ticket: "70901",
            symbol: "EURUSD.raw",
            type: 1,
            volume: 0.02,
            openPrice: 1.1,
            sl: 0,
            tp: 0,
            profit: 40,
            magic: 26050901,
            isExternal: false,
            comment: `ttc:${approval.shortId}`,
          },
        ],
        orders: [],
        symbols: [{ symbol: "EURUSD.raw", bid: 1.0896, ask: 1.0898, point: 0.00001 }],
      }),
      headers: { "content-type": "application/json" },
    });
    const work = await (await app.request("/api/mt5/poll-line?accountId=mt5-63442826")).text();
    expect(work).toContain("commandType=MODIFY_SL");
    expect(work).toContain("newStopLoss=1.095");
    expect(
      await (await app.request("/api/mt5/poll-line?accountId=mt5-63442826")).text(),
    ).not.toContain("commandType=MODIFY_SL");
  });

  test("computes set-sl-to-tp from a default-distance reference", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "telegram-tc-reference-default-distance-"));
    const databasePath = join(tempDir, "app.db");
    try {
      const app = createApi({
        databasePath,
        seedDemoData: false,
        telegramAdapter: "mock",
        telegramPollingEnabled: false,
      });
      const providerId = await configureVirtualTpProvider(app, {
        takeProfitLevels: [
          { leg: 1, percentage: 0, strategy: { kind: "set-sl-to-tp", tpLeg: 2, offsetPips: 0 } },
          { leg: 2, percentage: 0, strategy: { kind: "no-change" } },
          { leg: 3, percentage: 100, strategy: { kind: "no-change" } },
        ],
      });
      const approval = await openVirtualTpTrade(app, providerId, {
        rawText: "BUY EURUSD @ 1.0860\nSL 1.0810\nTP1 1.0910\nTP2 1.0920\nTP3 1.1000",
        ticket: "70902",
        filledPrice: 1.086,
      });

      const setup = new Database(databasePath);
      const row = setup
        .query("SELECT data_json FROM logical_trades WHERE id = ?")
        .get(approval.logicalTradeId) as { data_json: string };
      const stored = JSON.parse(row.data_json) as {
        legs: Array<{ targetPrice?: number; defaultDistance?: { value: number; unit: string } }>;
      };
      delete stored.legs[1]!.targetPrice;
      stored.legs[1]!.defaultDistance = { value: 60, unit: "PIPS" };
      setup
        .query("UPDATE logical_trades SET data_json = ? WHERE id = ?")
        .run(JSON.stringify(stored), approval.logicalTradeId);
      setup.close();

      await postVirtualTpSnapshot(app, approval, {
        ticket: "70902",
        bid: 1.093,
        ask: 1.0932,
        sl: 1.081,
      });
      const work = await (await app.request("/api/mt5/poll-line?accountId=mt5-63442826")).text();
      expect(work).toContain("commandType=MODIFY_SL");
      expect(work).toContain("newStopLoss=1.092");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("keeps a PLANNED reference leg unconsumed on a provider TP announcement", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "telegram-tc-reference-planned-"));
    const databasePath = join(tempDir, "app.db");
    try {
      const app = createApi({
        databasePath,
        seedDemoData: false,
        telegramAdapter: "mock",
        telegramPollingEnabled: false,
      });
      const providerId = await configureVirtualTpProvider(app, {
        takeProfitLevels: [
          { leg: 1, percentage: 0, strategy: { kind: "set-sl-to-entry", offsetPips: 0 } },
          { leg: 2, percentage: 100, strategy: { kind: "no-change" } },
        ],
      });
      const approval = await openVirtualTpTrade(app, providerId, {
        rawText: "BUY EURUSD @ 1.0860\nSL 1.0810\nTP1 1.0910\nTP2 1.0950",
        ticket: "70951",
        filledPrice: 1.086,
      });
      await postVirtualTpSnapshot(app, approval, {
        ticket: "70951",
        bid: 1.087,
        ask: 1.0872,
        sl: 1.081,
      });

      const setup = new Database(databasePath);
      const row = setup
        .query("SELECT data_json FROM logical_trades WHERE id = ?")
        .get(approval.logicalTradeId) as { data_json: string };
      const stored = JSON.parse(row.data_json) as { legs: Array<{ status: string }> };
      stored.legs[0]!.status = "PLANNED";
      setup
        .query("UPDATE logical_trades SET data_json = ? WHERE id = ?")
        .run(JSON.stringify(stored), approval.logicalTradeId);
      setup.close();

      const hit = await json<{ parsedSignalId: string }>(
        await app.request("/api/parser/parse", {
          method: "POST",
          body: JSON.stringify({
            providerId,
            accountId: "mt5-63442826",
            rawText: "TP 1",
          }),
          headers: { "content-type": "application/json" },
        }),
      );
      await app.request(`/api/signals/${hit.parsedSignalId}/approve`, { method: "POST" });

      const verify = new Database(databasePath, { readonly: true });
      const persisted = verify
        .query("SELECT data_json FROM logical_trades WHERE id = ?")
        .get(approval.logicalTradeId) as { data_json: string };
      verify.close();
      expect(
        (JSON.parse(persisted.data_json) as { legs: Array<{ status: string }> }).legs[0]?.status,
      ).toBe("PLANNED");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("coalesces a provider FULL TP announcement into one reference stop", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: false });
    const providerId = await configureVirtualTpProvider(app, {
      takeProfitLevels: [
        { leg: 1, percentage: 0, strategy: { kind: "set-sl-to-entry", offsetPips: 0 } },
        { leg: 2, percentage: 0, strategy: { kind: "set-sl-to-entry", offsetPips: 2 } },
        { leg: 3, percentage: 100, strategy: { kind: "no-change" } },
      ],
    });
    const approval = await openVirtualTpTrade(app, providerId, {
      rawText: "BUY EURUSD @ 1.0860\nSL 1.0810\nTP1 1.0910\nTP2 1.0920\nTP3 1.0950",
      ticket: "71001",
      filledPrice: 1.086,
    });
    await postVirtualTpSnapshot(app, approval, {
      ticket: "71001",
      bid: 1.087,
      ask: 1.0872,
      sl: 1.081,
    });
    const hit = await json<{ parsedSignalId: string }>(
      await app.request("/api/parser/parse", {
        method: "POST",
        body: JSON.stringify({
          providerId,
          accountId: "mt5-63442826",
          rawText: "EURUSD FULL TP",
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    await app.request(`/api/signals/${hit.parsedSignalId}/approve`, { method: "POST" });

    const first = await (await app.request("/api/mt5/poll-line?accountId=mt5-63442826")).text();
    expect(first).toContain("commandType=MODIFY_SL");
    expect(first).toContain("newStopLoss=1.0862");
    expect(
      await (await app.request("/api/mt5/poll-line?accountId=mt5-63442826")).text(),
    ).not.toContain("commandType=MODIFY_SL");
  });

  test("does not let closing-leg or runner strategies regress the live broker stop", async () => {
    for (const scenario of ["closing-leg", "runner"] as const) {
      const app = createApi({ databasePath: ":memory:", seedDemoData: false });
      const providerId = await configureVirtualTpProvider(app, {
        ...(scenario === "runner"
          ? { runner: { enabled: true, lotSize: 0.01, slBehavior: "break-even", trailPips: 10 } }
          : {}),
        takeProfitLevels: [
          {
            leg: 1,
            percentage: 100,
            strategy:
              scenario === "closing-leg"
                ? { kind: "set-sl-to-entry", offsetPips: 0 }
                : { kind: "no-change" },
          },
        ],
      });
      const ticket = scenario === "closing-leg" ? "71101" : "71102";
      const approval = await openVirtualTpTrade(app, providerId, {
        rawText: "BUY EURUSD @ 1.0860\nSL 1.0810\nTP1 1.0910",
        ticket,
        filledPrice: 1.086,
      });
      await postVirtualTpSnapshot(app, approval, {
        ticket,
        bid: 1.0911,
        ask: 1.0913,
        sl: 1.09,
      });
      const closeWork = await (
        await app.request("/api/mt5/poll-line?accountId=mt5-63442826")
      ).text();
      const closeQueueItemId = closeWork.match(/queueItemId=([^\n]+)/)?.[1];
      expect(closeWork).toContain("commandType=CLOSE_PARTIAL");
      expect(closeQueueItemId).toBeTruthy();
      await reportExecutedQueue(app, {
        queueItemId: closeQueueItemId!,
        ticket,
        price: 1.0911,
        volume: Number(closeWork.match(/partialCloseVolume=([^\n]+)/)?.[1] ?? 0.01),
      });
      expect(
        await (await app.request("/api/mt5/poll-line?accountId=mt5-63442826")).text(),
      ).not.toContain("commandType=MODIFY_SL");
    }
  });

  test("reads the opening plan even when an older lifecycle row exists", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "telegram-tc-original-open-"));
    const databasePath = join(tempDir, "app.db");
    try {
      const app = createApi({
        databasePath,
        seedDemoData: false,
        telegramAdapter: "mock",
        telegramPollingEnabled: false,
      });
      const providerId = await configureVirtualTpProvider(app, {
        runner: { enabled: true, lotSize: 0.01, slBehavior: "trail", trailPips: 10 },
        takeProfitLevels: [{ leg: 1, percentage: 100, strategy: { kind: "no-change" } }],
      });
      const approval = await openVirtualTpTrade(app, providerId, {
        rawText: "BUY EURUSD @ 1.0860\nSL 1.0810\nTP1 1.0910",
        ticket: "71201",
        filledPrice: 1.086,
      });
      const setup = new Database(databasePath);
      const source = setup
        .query("SELECT parsed_signal_id, account_id FROM queue_items WHERE id = ?")
        .get(approval.queueItemId) as { parsed_signal_id: string; account_id: string };
      const fakePayload = {
        commandType: "MODIFY_SL",
        brokerSymbol: "EURUSD.raw",
        direction: "BUY",
        newStopLoss: 1.085,
        takeProfits: [],
        executionMode: "VIRTUAL_TP",
        targetPositionTicket: "71201",
        originalText: "older lifecycle row",
      };
      setup
        .query(
          `INSERT INTO queue_items
             (id, parsed_signal_id, logical_trade_id, account_id, status, payload_json, lease_count, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'EXECUTED', ?, 0, ?, ?)`,
        )
        .run(
          "queue_older_lifecycle",
          source.parsed_signal_id,
          approval.logicalTradeId,
          source.account_id,
          JSON.stringify(fakePayload),
          "2000-01-01T00:00:00.000Z",
          "2000-01-01T00:00:00.000Z",
        );
      setup.close();

      await postVirtualTpSnapshot(app, approval, {
        ticket: "71201",
        bid: 1.0911,
        ask: 1.0913,
        sl: 1.081,
      });
      const closeWork = await (
        await app.request("/api/mt5/poll-line?accountId=mt5-63442826")
      ).text();
      expect(closeWork).toContain("commandType=CLOSE_PARTIAL");
      expect(closeWork).toContain("partialCloseVolume=0.01");
      const closeQueueItemId = closeWork.match(/queueItemId=([^\n]+)/)?.[1];
      await reportExecutedQueue(app, {
        queueItemId: closeQueueItemId!,
        ticket: "71201",
        price: 1.0911,
        volume: 0.01,
      });
      expect(
        await (await app.request("/api/mt5/poll-line?accountId=mt5-63442826")).text(),
      ).toContain("commandType=TRAILING_STOP");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("leases less-protective same-time stop work first", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "telegram-tc-stop-order-"));
    const databasePath = join(tempDir, "app.db");
    try {
      const app = createApi({
        databasePath,
        seedDemoData: false,
        telegramAdapter: "mock",
        telegramPollingEnabled: false,
      });
      const providerId = await configureVirtualTpProvider(app, {
        takeProfitLevels: [
          { leg: 1, percentage: 0, strategy: { kind: "set-sl-to-entry", offsetPips: 0 } },
          { leg: 2, percentage: 0, strategy: { kind: "set-sl-to-tp", tpLeg: 1, offsetPips: 0 } },
          { leg: 3, percentage: 100, strategy: { kind: "no-change" } },
        ],
      });
      const approval = await openVirtualTpTrade(app, providerId, {
        rawText: "BUY EURUSD @ 1.0860\nSL 1.0810\nTP1 1.0910\nTP2 1.0920\nTP3 1.0950",
        ticket: "71301",
        filledPrice: 1.086,
      });
      await postVirtualTpSnapshot(app, approval, {
        ticket: "71301",
        bid: 1.093,
        ask: 1.0932,
        sl: 1.081,
      });

      const setup = new Database(databasePath);
      const original = setup
        .query(
          `SELECT parsed_signal_id, logical_trade_id, account_id, payload_json, created_at
           FROM queue_items
           WHERE json_extract(payload_json, '$.commandType') = 'MODIFY_SL'`,
        )
        .get() as {
        parsed_signal_id: string;
        logical_trade_id: string;
        account_id: string;
        payload_json: string;
        created_at: string;
      };
      const lessProtective = JSON.parse(original.payload_json) as Record<string, unknown>;
      lessProtective.newStopLoss = 1.086;
      lessProtective.idempotencyKey = "same-time-less-protective";
      setup
        .query(
          `INSERT INTO queue_items
             (id, parsed_signal_id, logical_trade_id, account_id, status, payload_json, lease_count, created_at, updated_at)
           VALUES ('queue_less_protective', ?, ?, ?, 'PENDING', ?, 0, ?, ?)`,
        )
        .run(
          original.parsed_signal_id,
          original.logical_trade_id,
          original.account_id,
          JSON.stringify(lessProtective),
          original.created_at,
          original.created_at,
        );
      setup.close();

      const first = await (await app.request("/api/mt5/poll-line?accountId=mt5-63442826")).text();
      expect(first).toContain("queueItemId=queue_less_protective");
      expect(first).toContain("newStopLoss=1.086");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("delivers a provider stop widening even when the broker stop is already tighter", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: false });
    const providerId = await configureProviderWithAccount(app, {
      availableSymbols: ["EURUSD.raw"],
    });
    await app.request(`/api/providers/${providerId}`, {
      method: "PATCH",
      body: JSON.stringify({
        riskMode: "fixed",
        riskAmount: 0.02,
        takeProfitLevels: [{ leg: 1, percentage: 100, strategy: { kind: "no-change" } }],
      }),
      headers: { "content-type": "application/json" },
    });
    const approval = await openVirtualTpTrade(app, providerId, {
      rawText: "BUY EURUSD @ 1.0860\nSL 1.0810\nTP1 1.0910",
      ticket: "70601",
      filledPrice: 1.086,
    });
    // The broker already holds a tighter stop than the provider is about to ask for.
    await postVirtualTpSnapshot(app, approval, {
      ticket: "70601",
      bid: 1.0875,
      ask: 1.0877,
      sl: 1.087,
    });
    await (await app.request("/api/mt5/poll-line?accountId=mt5-63442826")).text();

    // The provider deliberately widens the stop to give the trade room.
    const move = await json<{ parsedSignalId: string }>(
      await app.request("/api/parser/parse", {
        method: "POST",
        body: JSON.stringify({
          providerId,
          accountId: "mt5-63442826",
          rawText: "EURUSD Set SL 1.0840",
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    const approvedMove = await json<{ status?: string; queueItemId?: string; error?: string }>(
      await app.request(`/api/signals/${move.parsedSignalId}/approve`, { method: "POST" }),
    );
    // The command must be queued for delivery, bound to the open trade.
    expect(approvedMove.status).toBe("PENDING");

    // It must reach the EA. Swallowing it as "already protective" would override a human
    // instruction and report it as executed without delivering it.
    const work = await (await app.request("/api/mt5/poll-line?accountId=mt5-63442826")).text();
    expect(work).toContain("commandType=MODIFY_SL");
    expect(work).toContain("newStopLoss=1.084");
  });

  test("a limit order that fills via snapshot still moves the stop on a reference leg", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: false });
    const providerId = await configureProviderWithAccount(app, {
      availableSymbols: ["EURUSD.raw"],
    });
    await app.request(`/api/providers/${providerId}`, {
      method: "PATCH",
      body: JSON.stringify({
        riskMode: "fixed",
        riskAmount: 0.02,
        takeProfitLevels: [
          { leg: 1, percentage: 0, strategy: { kind: "set-sl-to-entry", offsetPips: 0 } },
          { leg: 2, percentage: 100, strategy: { kind: "set-sl-to-tp", tpLeg: 1, offsetPips: 0 } },
        ],
      }),
      headers: { "content-type": "application/json" },
    });
    const parsed = await json<{ parsedSignalId: string }>(
      await app.request("/api/parser/parse", {
        method: "POST",
        body: JSON.stringify({
          providerId,
          accountId: "mt5-63442826",
          rawText: "BUY LIMIT EURUSD @ 1.0860\nSL 1.0810\nTP1 1.0910\nTP2 1.0950",
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    const approval = await json<{ queueItemId: string; logicalTradeId: string }>(
      await app.request(`/api/signals/${parsed.parsedSignalId}/approve`, { method: "POST" }),
    );
    const shortId = approval.logicalTradeId.replace(/^trade[_-]/, "");
    await (await app.request("/api/mt5/poll-line?accountId=mt5-63442826")).text();

    // The EA reports the PENDING order accepted: an order ticket, no position yet.
    await app.request("/api/mt5/report", {
      method: "POST",
      body: JSON.stringify({
        accountId: "mt5-63442826",
        queueItemId: approval.queueItemId,
        status: "EXECUTED",
        retcode: 10009,
        retcodeExternal: 0,
        brokerComment: "Request executed",
        orderTicket: "70701",
        positionTicket: "0",
        dealTicket: "0",
        requestedPrice: 1.086,
        filledPrice: 0,
        volume: 0.02,
        errorText: "",
      }),
      headers: { "content-type": "application/json" },
    });

    const snap = async (bid: number, ask: number) =>
      await app.request("/api/mt5/snapshot", {
        method: "POST",
        body: JSON.stringify({
          accountId: "mt5-63442826",
          positions: [
            {
              ticket: "70701",
              symbol: "EURUSD.raw",
              type: 0,
              volume: 0.02,
              openPrice: 1.086,
              sl: 1.081,
              tp: 0,
              profit: 10,
              magic: 26050901,
              isExternal: false,
              comment: `ttc:${shortId}`,
            },
          ],
          orders: [],
          symbols: [{ symbol: "EURUSD.raw", bid, ask, point: 0.00001 }],
        }),
        headers: { "content-type": "application/json" },
      });

    // The limit fills: the position appears in the snapshot, below TP1.
    await snap(1.0865, 1.0867);
    // Price then crosses TP1 (1.0910), the 0% reference leg.
    await snap(1.0915, 1.0917);

    const work = await (await app.request("/api/mt5/poll-line?accountId=mt5-63442826")).text();
    expect(work).toContain("commandType=MODIFY_SL");
    expect(work).toContain("newStopLoss=1.086");
  });

  test("uses an unconfigured single Telegram TP at 100 percent", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: false });
    const providerId = await configureProviderWithAccount(app, {
      availableSymbols: ["EURUSD.raw"],
    });
    await app.request(`/api/providers/${providerId}`, {
      method: "PATCH",
      body: JSON.stringify({
        riskMode: "fixed",
        riskAmount: 0.02,
        takeProfitLevels: [
          { leg: 1, percentage: 100, strategy: { kind: "set-sl-to-entry", offsetPips: 0 } },
        ],
      }),
      headers: { "content-type": "application/json" },
    });

    const parsed = await json<{ parsedSignalId: string }>(
      await app.request("/api/parser/parse", {
        method: "POST",
        body: JSON.stringify({
          providerId,
          accountId: "mt5-63442826",
          rawText: "BUY EURUSD @ 1.0860\nSL 1.0810\nTP2 1.0950",
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    const approval = await json<{ queueItemId: string; logicalTradeId: string }>(
      await app.request(`/api/signals/${parsed.parsedSignalId}/approve`, { method: "POST" }),
    );
    const shortId = approval.logicalTradeId.replace(/^trade[_-]/, "");

    const openWork = await (await app.request("/api/mt5/poll-line?accountId=mt5-63442826")).text();
    expect(openWork).toContain("tp2=1.095");
    expect(openWork).toContain("tp2Allocation=100");

    await app.request("/api/mt5/report", {
      method: "POST",
      body: JSON.stringify({
        accountId: "mt5-63442826",
        queueItemId: approval.queueItemId,
        status: "EXECUTED",
        retcode: 10009,
        retcodeExternal: 0,
        brokerComment: `ttc:${shortId}`,
        orderTicket: "70002",
        positionTicket: "70002",
        dealTicket: "70002",
        requestedPrice: 1.086,
        filledPrice: 1.086,
        volume: 0.02,
        errorText: "",
      }),
      headers: { "content-type": "application/json" },
    });
    await app.request("/api/mt5/snapshot", {
      method: "POST",
      body: JSON.stringify({
        accountId: "mt5-63442826",
        positions: [
          {
            ticket: "70002",
            symbol: "EURUSD.raw",
            type: 0,
            volume: 0.02,
            openPrice: 1.086,
            sl: 1.081,
            tp: 0,
            magic: 26050901,
            isExternal: false,
            comment: `ttc:${shortId}`,
          },
        ],
        orders: [],
        symbols: [{ symbol: "EURUSD.raw", bid: 1.095, ask: 1.0952, point: 0.00001 }],
      }),
      headers: { "content-type": "application/json" },
    });
    const closeWork = await (await app.request("/api/mt5/poll-line?accountId=mt5-63442826")).text();
    expect(closeWork).toContain("commandType=CLOSE_PARTIAL");
    expect(closeWork).toContain("partialCloseValue=2");
  });

  test("single configured TP without runner falls back to app default TP when no Telegram TP exists", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: false });
    const providerId = await configureProviderWithAccount(app, {
      availableSymbols: ["EURUSD.raw"],
    });
    await app.request(`/api/providers/${providerId}`, {
      method: "PATCH",
      body: JSON.stringify({
        riskMode: "fixed",
        riskAmount: 0.02,
        takeProfitLevels: [
          { leg: 1, percentage: 100, strategy: { kind: "set-sl-to-entry", offsetPips: 0 } },
        ],
      }),
      headers: { "content-type": "application/json" },
    });

    const parsed = await json<{ parsedSignalId: string }>(
      await app.request("/api/parser/parse", {
        method: "POST",
        body: JSON.stringify({
          providerId,
          accountId: "mt5-63442826",
          rawText: "BUY EURUSD",
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    await app.request(`/api/signals/${parsed.parsedSignalId}/approve`, { method: "POST" });

    const openWork = await (await app.request("/api/mt5/poll-line?accountId=mt5-63442826")).text();
    expect(openWork).toContain("defaultTakeProfitValue=200");
    expect(openWork).toContain("runnerEnabled=false");
  });

  test("sends structured TP strategy fields to MT5 for virtual TP SL movement", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: false });
    const providerId = await configureProviderWithAccount(app, {
      availableSymbols: ["EURUSD.raw"],
    });
    await app.request(`/api/providers/${providerId}`, {
      method: "PATCH",
      body: JSON.stringify({
        riskMode: "fixed",
        riskAmount: 0.1,
        takeProfitLevels: [
          {
            leg: 1,
            percentage: 50,
            strategy: { kind: "set-sl-to-entry", offsetPips: 2 },
          },
          {
            leg: 2,
            percentage: 50,
            strategy: { kind: "set-sl-to-tp", tpLeg: 1, offsetPips: 1 },
          },
        ],
      }),
      headers: { "content-type": "application/json" },
    });

    const parsed = await json<{ parsedSignalId: string }>(
      await app.request("/api/parser/parse", {
        method: "POST",
        body: JSON.stringify({
          providerId,
          accountId: "mt5-63442826",
          rawText: "BUY EURUSD @ 1.0850\nSL 1.0810\nTP1 1.0900\nTP2 1.0950",
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    const approval = await app.request(`/api/signals/${parsed.parsedSignalId}/approve`, {
      method: "POST",
    });
    expect(approval.status).toBe(200);

    const pollLine = await (await app.request("/api/mt5/poll-line?accountId=mt5-63442826")).text();
    expect(pollLine).toContain("tp1StrategyKind=set-sl-to-entry");
    expect(pollLine).toContain("tp1StrategyReferenceLeg=0");
    expect(pollLine).toContain("tp1StrategyOffsetPips=2");
    expect(pollLine).toContain("tp2StrategyKind=set-sl-to-tp");
    expect(pollLine).toContain("tp2StrategyReferenceLeg=1");
    expect(pollLine).toContain("tp2StrategyOffsetPips=1");
  });

  test("keeps KAL VIP zero-percent TP references for its TP1 SL move", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: false });
    const providerId = await configureProviderWithAccount(app, { availableSymbols: ["XAUUSD"] });
    await app.request(`/api/providers/${providerId}`, {
      method: "PATCH",
      body: JSON.stringify({
        riskMode: "fixed",
        riskAmount: 0.02,
        takeProfitLevels: [
          { leg: 1, percentage: 50, strategy: { kind: "set-sl-to-tp", tpLeg: 2, offsetPips: 0 } },
          { leg: 2, percentage: 0, strategy: { kind: "no-change" } },
          { leg: 3, percentage: 0, strategy: { kind: "no-change" } },
          { leg: 4, percentage: 50, strategy: { kind: "no-change" } },
        ],
      }),
      headers: { "content-type": "application/json" },
    });
    const parsed = await json<{ parsedSignalId: string }>(
      await app.request("/api/parser/parse", {
        method: "POST",
        body: JSON.stringify({
          providerId,
          accountId: "mt5-63442826",
          rawText: "BUY XAUUSD @ 4500\nSL 4490\nTP1 4510\nTP2 4520\nTP3 4530\nTP4 4540",
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    const approval = await json<{ queueItemId: string; logicalTradeId: string }>(
      await app.request(`/api/signals/${parsed.parsedSignalId}/approve`, { method: "POST" }),
    );
    const shortId = approval.logicalTradeId.replace(/^trade[_-]/, "");
    const openWork = await (await app.request("/api/mt5/poll-line?accountId=mt5-63442826")).text();
    expect(openWork).toContain("tp1Volume=0.01");
    expect(openWork).toContain("tp2Volume=");
    expect(openWork).toContain("tp4Volume=0.01");

    await app.request("/api/mt5/report", {
      method: "POST",
      body: JSON.stringify({
        accountId: "mt5-63442826",
        queueItemId: approval.queueItemId,
        status: "EXECUTED",
        retcode: 10009,
        retcodeExternal: 0,
        brokerComment: "Request executed",
        orderTicket: "9001",
        positionTicket: "9001",
        dealTicket: "9001",
        requestedPrice: 4500,
        filledPrice: 4500,
        volume: 0.02,
        errorText: "",
      }),
      headers: { "content-type": "application/json" },
    });
    await sendGoldSnapshot(app, {
      shortId,
      bid: 4530,
      positions: [
        {
          ticket: "9001",
          symbol: "XAUUSD",
          type: 0,
          volume: 0.02,
          openPrice: 4500,
          sl: 4490,
          tp: 0,
          profit: 40,
          magic: 26050901,
          isExternal: false,
          comment: `ttc:${shortId}`,
        },
      ],
    });
    const closeWork = await (await app.request("/api/mt5/poll-line?accountId=mt5-63442826")).text();
    const closeQueueId = closeWork.match(/queueItemId=([^\n]+)/)?.[1];
    expect(closeWork).toContain("partialCloseValue=1");
    expect(closeQueueId).toBeDefined();
    await app.request("/api/mt5/report", {
      method: "POST",
      body: JSON.stringify({
        accountId: "mt5-63442826",
        queueItemId: closeQueueId,
        status: "EXECUTED",
        retcode: 10009,
        retcodeExternal: 0,
        brokerComment: `ttc:${shortId}:tp1`,
        orderTicket: "9002",
        positionTicket: "9001",
        dealTicket: "9002",
        requestedPrice: 4510,
        filledPrice: 4510,
        volume: 0.01,
        errorText: "",
      }),
      headers: { "content-type": "application/json" },
    });
    const slWork = await (await app.request("/api/mt5/poll-line?accountId=mt5-63442826")).text();
    expect(slWork).toContain("commandType=MODIFY_SL");
    expect(slWork).toContain("newStopLoss=4520");
  });

  test("records SELL broker history pips in the profitable direction", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: false });
    const providerId = await configureProviderWithAccount(app, {
      availableSymbols: ["EURUSD.raw"],
    });
    const parsed = await json<{ parsedSignalId: string }>(
      await app.request("/api/parser/parse", {
        method: "POST",
        body: JSON.stringify({
          providerId,
          accountId: "mt5-63442826",
          rawText: "SELL EURUSD @ 1.1000\nSL 1.1050\nTP1 1.0900",
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    const approval = await json<{ queueItemId: string; logicalTradeId: string }>(
      await app.request(`/api/signals/${parsed.parsedSignalId}/approve`, { method: "POST" }),
    );
    await app.request("/api/mt5/report", {
      method: "POST",
      body: JSON.stringify({
        accountId: "mt5-63442826",
        queueItemId: approval.queueItemId,
        status: "EXECUTED",
        retcode: 10009,
        retcodeExternal: 0,
        brokerComment: "Request completed",
        orderTicket: "50001",
        positionTicket: "70001",
        dealTicket: "60001",
        requestedPrice: 1.1,
        filledPrice: 1.1,
        volume: 0.1,
        errorText: "",
      }),
      headers: { "content-type": "application/json" },
    });

    await app.request("/api/mt5/history", {
      method: "POST",
      body: JSON.stringify({
        accountId: "mt5-63442826",
        deals: [
          {
            dealTicket: "60002",
            orderTicket: "50002",
            positionTicket: "70001",
            entry: "OUT",
            reason: 5,
            symbol: "EURUSD.raw",
            price: 1.09,
            volume: 0.1,
            profit: 100,
            commission: 0,
            swap: 0,
            comment: `telegram-tc:${approval.logicalTradeId}`,
            time: "2026-05-10T12:00:00.000Z",
          },
        ],
      }),
      headers: { "content-type": "application/json" },
    });

    const brokerTrail = await json<{
      orders: Array<{ dealTicket: string; pnlPips?: number; source?: string }>;
    }>(await app.request(`/api/trades/${approval.logicalTradeId}/broker-orders`));
    const close = brokerTrail.orders.find((order) => order.dealTicket === "60002");
    expect(close?.pnlPips).toBe(100);
    expect(close?.source).toBe("tp-hit");
  });

  test("can approve an open signal with split-order execution mode instead of the virtual-TP default", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: false });
    await app.request("/api/mt5/register", {
      method: "POST",
      body: JSON.stringify({
        accountNumber: "100200300",
        server: "MetaQuotes-Demo",
        company: "MetaQuotes Ltd",
        currency: "USD",
        balance: 10000,
        equity: 10000,
        marginMode: "HEDGING",
        availableSymbols: ["EURUSD.raw"],
      }),
      headers: { "content-type": "application/json" },
    });

    const parsed = await json<{ parsedSignalId: string }>(
      await app.request("/api/parser/parse", {
        method: "POST",
        body: JSON.stringify({
          providerId: "provider-alpha",
          accountId: "mt5-100200300",
          rawText: "BUY EURUSD @ 1.0850\nSL 1.0810\nTP1 1.0900\nTP2 1.0950",
        }),
        headers: { "content-type": "application/json" },
      }),
    );

    const approve = await app.request(`/api/signals/${parsed.parsedSignalId}/approve`, {
      method: "POST",
      body: JSON.stringify({ executionMode: "SPLIT_ORDER" }),
      headers: { "content-type": "application/json" },
    });
    expect(approve.status).toBe(200);

    const pollLine = await (await app.request("/api/mt5/poll-line?accountId=mt5-100200300")).text();
    expect(pollLine).toContain("commandType=OPEN_TRADE");
    expect(pollLine).toContain("executionMode=SPLIT_ORDER");
    expect(pollLine).toContain("tp1Allocation=50");
    expect(pollLine).toContain("tp2Allocation=50");
  });

  test("classifies captured provider messages and saves parser fixtures with Telegram metadata", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: true });
    const messages = await json<{
      messages: Array<{
        id: string;
        telegramMessageId: string;
        messageDate: string;
        rawText: string;
      }>;
    }>(await app.request("/api/providers/provider-alpha/messages?limit=1"));
    const message = messages.messages[0]!;

    const classification = await json<{
      message: { id: string; classification: string };
    }>(
      await app.request(`/api/messages/${message.id}/classification`, {
        method: "PATCH",
        body: JSON.stringify({ classification: "entry" }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(classification.message).toMatchObject({
      id: message.id,
      classification: "entry",
    });

    const saved = await json<{
      fixtureId: string;
      fixture: {
        telegramMessageId: string;
        messageDate: string;
        classification: string;
        expectedCommandType: string;
        expectedSymbol: string;
        expected: {
          entry?: { from: number };
          stopLoss?: number;
          takeProfits: Array<{ leg: number; price: number }>;
          confidence: number;
          warnings: string[];
        };
      };
    }>(
      await app.request(`/api/messages/${message.id}/fixture`, {
        method: "POST",
        body: JSON.stringify({ classification: "entry", redacted: true }),
        headers: { "content-type": "application/json" },
      }),
    );

    expect(saved.fixture.telegramMessageId).toBe(message.telegramMessageId);
    expect(saved.fixture.messageDate).toBe(message.messageDate);
    expect(saved.fixture.classification).toBe("entry");
    expect(saved.fixture.expectedCommandType).toBe("OPEN_TRADE");
    expect(saved.fixture.expectedSymbol).toBe("EURUSD");
    expect(saved.fixture.expected.entry?.from).toBe(1.085);
    expect(saved.fixture.expected.stopLoss).toBe(1.081);
    expect(saved.fixture.expected.takeProfits.map((target) => target.price)).toEqual([
      1.09, 1.095, 1.1, 1.105,
    ]);

    const fixtures = await json<{
      fixtures: Array<{ id: string; telegramMessageId: string; expected: { confidence: number } }>;
    }>(await app.request("/api/parser/fixtures"));
    expect(fixtures.fixtures[0]?.id).toBe(saved.fixtureId);
    expect(fixtures.fixtures[0]?.telegramMessageId).toBe(message.telegramMessageId);
    expect(fixtures.fixtures[0]?.expected.confidence).toBeGreaterThanOrEqual(0.85);
  });

  test("maps every MT5 DEAL_REASON code to a distinct broker order source", () => {
    expect(brokerOrderSourceForDealReason(0)).toBe("manual-terminal");
    expect(brokerOrderSourceForDealReason(1)).toBe("manual-mobile");
    expect(brokerOrderSourceForDealReason(2)).toBe("manual-web");
    expect(brokerOrderSourceForDealReason(3)).toBe("expert");
    expect(brokerOrderSourceForDealReason(4)).toBe("sl-hit");
    expect(brokerOrderSourceForDealReason(5)).toBe("tp-hit");
    expect(brokerOrderSourceForDealReason(6)).toBe("stop-out");
    expect(brokerOrderSourceForDealReason(7)).toBe("rollover");
    expect(brokerOrderSourceForDealReason(8)).toBe("variation-margin");
    expect(brokerOrderSourceForDealReason(9)).toBe("split");
    // Unknown / undefined falls back to a safe label so the History tab is
    // never blank for an unexpected broker code.
    expect(brokerOrderSourceForDealReason(undefined)).toBe("history");
    expect(brokerOrderSourceForDealReason(99)).toBe("history");
  });

  test("splits app-driven and external positions in the snapshot", async () => {
    const app = createApi({
      databasePath: ":memory:",
      telegramAdapter: "mock",
      seedDemoData: true,
    });
    // Snapshot using the seeded demo account with one EA-opened position and
    // two external positions (manual click, other-EA).
    await app.request("/api/mt5/snapshot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        accountId: "mt5-100200300",
        positions: [
          {
            ticket: "1",
            symbol: "XAUUSD",
            type: 0,
            volume: 0.04,
            openPrice: 4500,
            sl: 4490,
            tp: 0,
            profit: 5,
            magic: 26050901,
            isExternal: false,
            comment: "ttc:abc:tp1",
          },
          {
            ticket: "2",
            symbol: "EURUSD",
            type: 0,
            volume: 1.0,
            openPrice: 1.085,
            sl: 0,
            tp: 0,
            profit: -20,
            magic: 0,
            isExternal: true,
            comment: "manual click",
          },
          {
            ticket: "3",
            symbol: "BTCUSD",
            type: 1,
            volume: 0.5,
            openPrice: 78000,
            sl: 0,
            tp: 0,
            profit: 150,
            magic: 99999,
            isExternal: true,
            comment: "other-EA",
          },
        ],
        orders: [],
        symbols: [],
      }),
    });
    const dash = await json<{
      mt5Accounts: Array<{
        id: string;
        openPositionCount: number;
        externalPositionCount: number;
        externalPositions: Array<{ ticket: string }>;
        appPositions: Array<{ ticket: string; symbol: string; magic: number }>;
      }>;
    }>(await app.request("/api/dashboard"));
    const account = dash.mt5Accounts.find((a) => a.id === "mt5-100200300");
    expect(account).toBeDefined();
    expect(account!.openPositionCount).toBe(1);
    expect(account!.externalPositionCount).toBe(2);
    expect(account!.externalPositions).toHaveLength(2);
    expect(account!.appPositions).toHaveLength(1);
    // The single EA-driven position (magic 26050901, XAUUSD) lives in appPositions —
    // not externalPositions — so the Open sub-tab can colour-code origin per row.
    expect(account!.appPositions[0]!.ticket).toBe("1");
    expect(account!.appPositions[0]!.symbol).toBe("XAUUSD");
    expect(account!.appPositions[0]!.magic).toBe(26050901);
  });

  test("broker history overwrites app-estimated partial close PnL for the same deal ticket", async () => {
    const app = createApi({
      databasePath: ":memory:",
      telegramAdapter: "mock",
      seedDemoData: true,
    });

    const lease = await json<{ item: { id: string } | null }>(
      await app.request("/api/mt5/poll?accountId=mt5-100200300"),
    );
    await app.request("/api/mt5/report", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        queueItemId: lease.item!.id,
        accountId: "mt5-100200300",
        status: "EXECUTED",
        retcode: 10009,
        retcodeExternal: 0,
        brokerComment: "ttc:demo-1",
        orderTicket: "order-open",
        positionTicket: "position-1",
        dealTicket: "deal-open",
        requestedPrice: 1.085,
        filledPrice: 1.085,
        volume: 0.1,
      }),
    });
    await app.request("/api/mt5/report", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        queueItemId: lease.item!.id,
        accountId: "mt5-100200300",
        status: "EXECUTED",
        retcode: 10009,
        retcodeExternal: 0,
        brokerComment: "ttc:demo-1:tp1",
        orderTicket: "order-tp1",
        positionTicket: "position-1",
        dealTicket: "deal-tp1",
        requestedPrice: 1.09,
        filledPrice: 1.09,
        volume: 0.03,
      }),
    });

    const before = await json<{
      orders: Array<{ dealTicket: string; pnlCurrency?: number | null; pnlPips?: number | null }>;
    }>(await app.request("/api/trades/trade-demo-1/broker-orders"));
    expect(
      before.orders.find((order) => order.dealTicket === "deal-tp1")?.pnlCurrency,
    ).toBeUndefined();

    const historyBody = {
      accountId: "mt5-100200300",
      deals: [
        {
          dealTicket: "deal-tp1",
          orderTicket: "order-tp1",
          positionTicket: "position-1",
          entry: "1",
          type: "1",
          reason: 5,
          symbol: "EURUSD.raw",
          price: 1.09,
          volume: 0.03,
          profit: 20,
          commission: -0.25,
          swap: 0,
          fee: -0.05,
          comment: "ttc:demo-1:tp1",
          timeMsc: Date.UTC(2026, 4, 18, 10, 42, 14),
        },
      ],
    };
    const history = await json<{ recorded: number; updated: number; repairedPnlDelta: number }>(
      await app.request("/api/mt5/history", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(historyBody),
      }),
    );
    expect(history.recorded).toBe(0);
    expect(history.updated).toBe(1);
    expect(history.repairedPnlDelta).toBe(19.7);

    const repeat = await json<{ recorded: number; updated: number; repairedPnlDelta: number }>(
      await app.request("/api/mt5/history", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(historyBody),
      }),
    );
    expect(repeat.recorded).toBe(0);
    expect(repeat.updated).toBe(0);
    expect(repeat.repairedPnlDelta).toBe(0);

    const after = await json<{
      orders: Array<{ dealTicket: string; pnlCurrency?: number | null; pnlPips?: number | null }>;
    }>(await app.request("/api/trades/trade-demo-1/broker-orders"));
    const tp1 = after.orders.find((order) => order.dealTicket === "deal-tp1");
    expect(tp1?.pnlCurrency).toBe(19.7);
    expect(tp1?.pnlPips).toBe(50);
  });

  test("broker history upgrades the final existing partial close to a full position close", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "telegram-tc-"));
    const databasePath = join(tempDir, "app.db");
    try {
      const app = createApi({
        databasePath,
        telegramAdapter: "mock",
        seedDemoData: true,
      });
      const closeLegs = [
        {
          id: "broker-close-1",
          dealTicket: "deal-close-1",
          orderTicket: "order-close-1",
          price: 4560.3,
          pnl: 5.92,
          timeMsc: Date.parse("2026-05-21T04:54:06.757Z"),
        },
        {
          id: "broker-close-2",
          dealTicket: "deal-close-2",
          orderTicket: "order-close-2",
          price: 4553.39,
          pnl: 12.83,
          timeMsc: Date.parse("2026-05-21T05:12:54.175Z"),
        },
        {
          id: "broker-close-3",
          dealTicket: "deal-close-3",
          orderTicket: "order-close-3",
          price: 4545.72,
          pnl: 20.5,
          timeMsc: Date.parse("2026-05-21T05:25:45.642Z"),
        },
        {
          id: "broker-close-4",
          dealTicket: "deal-close-4",
          orderTicket: "order-close-4",
          price: 4520.13,
          pnl: 46.09,
          timeMsc: Date.parse("2026-05-21T08:30:24.173Z"),
        },
      ];

      const db = new Database(databasePath);
      const tradeRow = db
        .query("SELECT data_json FROM logical_trades WHERE id = ?")
        .get("trade-demo-1") as { data_json: string } | null;
      expect(tradeRow).toBeDefined();
      const openTrade = {
        ...JSON.parse(tradeRow!.data_json),
        status: "OPEN",
        livePositionExists: true,
        matchedBrokerTickets: ["position-1"],
        legs: JSON.parse(tradeRow!.data_json).legs.map((leg: { status: string }) => ({
          ...leg,
          status: "OPEN",
        })),
      };
      db.query("UPDATE logical_trades SET status = ?, data_json = ? WHERE id = ?").run(
        "OPEN",
        JSON.stringify(openTrade),
        "trade-demo-1",
      );
      db.query(
        `INSERT INTO broker_orders
          (id, logical_trade_id, leg_id, action, queue_item_id, account_id, order_ticket, position_ticket, deal_ticket,
           requested_volume, filled_volume, requested_price, filled_price, retcode, retcode_external, broker_comment,
           pnl_currency, pnl_pips, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "broker-open",
        "trade-demo-1",
        "trade",
        "OPEN",
        "queue-demo-1",
        "mt5-100200300",
        "order-open",
        "position-1",
        "deal-open",
        null,
        0.04,
        null,
        4566.22,
        0,
        0,
        "ttc:demo-1",
        0,
        0,
        "expert",
        "2026-05-21T04:23:17.766Z",
      );
      const closeInsert = db.query(
        `INSERT INTO broker_orders
          (id, logical_trade_id, leg_id, action, queue_item_id, account_id, order_ticket, position_ticket, deal_ticket,
           requested_volume, filled_volume, requested_price, filled_price, retcode, retcode_external, broker_comment,
           pnl_currency, pnl_pips, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const leg of closeLegs) {
        closeInsert.run(
          leg.id,
          "trade-demo-1",
          "trade",
          "PARTIAL_CLOSE",
          "history",
          "mt5-100200300",
          leg.orderTicket,
          "position-1",
          leg.dealTicket,
          null,
          0.01,
          null,
          leg.price,
          0,
          0,
          "ttc:demo-1:close",
          leg.pnl,
          null,
          "expert",
          new Date(leg.timeMsc).toISOString(),
        );
      }
      db.close();

      const history = await json<{ updated: number }>(
        await app.request("/api/mt5/history", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            accountId: "mt5-100200300",
            deals: closeLegs.map((leg) => ({
              dealTicket: leg.dealTicket,
              orderTicket: leg.orderTicket,
              positionTicket: "position-1",
              entry: "1",
              type: "1",
              reason: 3,
              symbol: "XAUUSD",
              price: leg.price,
              volume: 0.01,
              profit: leg.pnl,
              commission: 0,
              swap: 0,
              fee: 0,
              comment: "ttc:demo-1:close",
              timeMsc: leg.timeMsc,
            })),
          }),
        }),
      );
      expect(history.updated).toBeGreaterThan(0);

      const dash = await json<{
        logicalTrades: Array<{ id: string; status: string }>;
        mt5Accounts: Array<{
          id: string;
          closedTrades: Array<{
            tradeId: string;
            closePrice: number;
            realizedPnl: number;
            legs: Array<{ action: string; dealTicket: string }>;
          }>;
        }>;
      }>(await app.request("/api/dashboard"));
      expect(dash.logicalTrades.find((trade) => trade.id === "trade-demo-1")?.status).toBe(
        "CLOSED",
      );
      const closed = dash.mt5Accounts
        .find((account) => account.id === "mt5-100200300")
        ?.closedTrades.find((trade) => trade.tradeId === "trade-demo-1");
      expect(closed?.realizedPnl).toBe(85.34);
      expect(closed?.closePrice).toBeCloseTo(4544.885, 5);
      expect(closed?.legs.map((leg) => [leg.dealTicket, leg.action])).toEqual([
        ["deal-close-1", "PARTIAL_CLOSE"],
        ["deal-close-2", "PARTIAL_CLOSE"],
        ["deal-close-3", "PARTIAL_CLOSE"],
        ["deal-close-4", "FULL_CLOSE"],
      ]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("large repeated MT5 history backfills skip old already-covered windows", async () => {
    const app = createApi({
      databasePath: ":memory:",
      telegramAdapter: "mock",
      seedDemoData: false,
    });

    await app.request("/api/mt5/history", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        accountId: "mt5-live",
        deals: [
          {
            dealTicket: "existing-close",
            orderTicket: "existing-order",
            positionTicket: "existing-position",
            entry: "1",
            type: "1",
            reason: 0,
            symbol: "XAUUSD",
            price: 4500,
            volume: 0.01,
            profit: 1,
            commission: 0,
            swap: 0,
            fee: 0,
            comment: "",
            timeMsc: Date.UTC(2026, 4, 20, 10, 0, 0),
          },
        ],
      }),
    });

    const oldDeals = Array.from({ length: 1000 }, (_, index) => ({
      dealTicket: `old-close-${index}`,
      orderTicket: `old-order-${index}`,
      positionTicket: `old-position-${index}`,
      entry: "1",
      type: "1",
      reason: 0,
      symbol: "XAUUSD",
      price: 4500,
      volume: 0.01,
      profit: 1,
      commission: 0,
      swap: 0,
      fee: 0,
      comment: "",
      timeMsc: Date.UTC(2026, 4, 19, 1, 0, index % 60),
    }));
    const result = await json<{ received: number; recorded: number; updated: number }>(
      await app.request("/api/mt5/history", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          accountId: "mt5-live",
          deals: [
            ...oldDeals,
            {
              dealTicket: "new-close",
              orderTicket: "new-order",
              positionTicket: "new-position",
              entry: "1",
              type: "1",
              reason: 0,
              symbol: "XAUUSD",
              price: 4510,
              volume: 0.01,
              profit: 2,
              commission: 0,
              swap: 0,
              fee: 0,
              comment: "",
              timeMsc: Date.UTC(2026, 4, 20, 10, 5, 0),
            },
          ],
        }),
      }),
    );

    expect(result.received).toBe(1001);
    expect(result.recorded).toBe(1);
    expect(result.updated).toBe(0);
  });

  test("broker history normalizes dotted MT5 timestamps before persisting rows", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "telegram-tc-"));
    const databasePath = join(tempDir, "app.db");
    try {
      const app = createApi({
        databasePath,
        telegramAdapter: "mock",
        seedDemoData: true,
      });

      await app.request("/api/mt5/history", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          accountId: "mt5-100200300",
          deals: [
            {
              dealTicket: "manual-dotted-close",
              orderTicket: "manual-dotted-order",
              positionTicket: "manual-dotted-position",
              entry: "1",
              type: "1",
              reason: 0,
              symbol: "XAUUSD",
              price: 4558.73,
              volume: 0.01,
              profit: 12,
              commission: 0,
              swap: 0,
              comment: "",
              time: "2026.05.18 10:42:14",
            },
          ],
        }),
      });

      const db = new Database(databasePath, { readonly: true });
      const row = db
        .query("SELECT created_at FROM broker_orders WHERE deal_ticket = ?")
        .get("manual-dotted-close") as { created_at: string } | null;
      db.close();
      expect(row?.created_at).toBe("2026-05-18T10:42:14.000Z");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("external close summaries refresh when existing history deal tickets are repaired", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "telegram-tc-"));
    const databasePath = join(tempDir, "app.db");
    try {
      const app = createApi({
        databasePath,
        telegramAdapter: "mock",
        seedDemoData: true,
      });

      const firstSync = await json<{ recorded: number }>(
        await app.request("/api/mt5/history", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            accountId: "mt5-100200300",
            deals: [
              {
                dealTicket: "manual-repair-open",
                orderTicket: "manual-repair-open-order",
                positionTicket: "manual-repair-position",
                entry: "0",
                type: "0",
                reason: 0,
                symbol: "XAUUSD",
                price: 4550,
                volume: 0.01,
                profit: 0,
                commission: 0,
                swap: 0,
                comment: "",
                timeMsc: Date.UTC(2026, 4, 18, 10, 40, 0),
              },
              {
                dealTicket: "manual-repair-close",
                orderTicket: "manual-repair-close-order",
                positionTicket: "manual-repair-position",
                entry: "1",
                type: "1",
                reason: 0,
                symbol: "XAUUSD",
                price: 4558,
                volume: 0.01,
                profit: 10,
                commission: 0,
                swap: 0,
                comment: "",
                timeMsc: Date.UTC(2026, 4, 18, 10, 45, 0),
              },
            ],
          }),
        }),
      );
      expect(firstSync.recorded).toBe(2);

      const repair = await json<{ updated: number }>(
        await app.request("/api/mt5/history", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            accountId: "mt5-100200300",
            deals: [
              {
                dealTicket: "manual-repair-close",
                orderTicket: "manual-repair-close-order",
                positionTicket: "manual-repair-position",
                entry: "1",
                type: "1",
                reason: 0,
                symbol: "XAUUSD",
                price: 4560,
                volume: 0.01,
                profit: 12.5,
                commission: -0.25,
                swap: 0,
                comment: "",
                timeMsc: Date.UTC(2026, 4, 18, 10, 50, 0),
              },
            ],
          }),
        }),
      );
      expect(repair.updated).toBe(1);

      const db = new Database(databasePath, { readonly: true });
      const row = db
        .query(
          "SELECT pnl_currency, close_at FROM external_closes WHERE position_ticket = ? LIMIT 1",
        )
        .get("manual-repair-position") as { pnl_currency: number; close_at: string } | null;
      db.close();
      expect(row).toMatchObject({
        pnl_currency: 12.25,
        close_at: "2026-05-18T10:50:00.000Z",
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("history close coverage orders unsafe-integer MT5 deal tickets exactly", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "telegram-tc-"));
    const databasePath = join(tempDir, "app.db");
    try {
      const app = createApi({
        databasePath,
        telegramAdapter: "mock",
        seedDemoData: true,
      });
      await app.request("/api/mt5/report", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          queueItemId: "queue-demo-1",
          accountId: "mt5-100200300",
          status: "EXECUTED",
          retcode: 10009,
          retcodeExternal: 0,
          brokerComment: "ttc:demo-1",
          orderTicket: "9007199254740990",
          positionTicket: "9007199254740990",
          dealTicket: "9007199254740994",
          requestedPrice: 1.085,
          filledPrice: 1.085,
          volume: 0.02,
        }),
      });

      const db = new Database(databasePath);
      db.query(
        `INSERT INTO broker_orders
          (id, logical_trade_id, leg_id, action, queue_item_id, account_id, order_ticket, position_ticket, deal_ticket,
           requested_volume, filled_volume, requested_price, filled_price, retcode, retcode_external, broker_comment,
           pnl_currency, pnl_pips, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "broker-unsafe-ticket-partial",
        "trade-demo-1",
        "trade",
        "PARTIAL_CLOSE",
        "history",
        "mt5-100200300",
        "9007199254740995",
        "9007199254740990",
        "9007199254740995",
        null,
        0.01,
        null,
        1.09,
        0,
        0,
        "ttc:demo-1:tp1",
        5,
        50,
        "tp-hit",
        "2026-05-18T11:00:00.000Z",
      );
      db.close();

      await app.request("/api/mt5/history", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          accountId: "mt5-100200300",
          deals: [
            {
              dealTicket: "9007199254740996",
              orderTicket: "9007199254740996",
              positionTicket: "9007199254740990",
              entry: "1",
              type: "1",
              reason: 5,
              symbol: "EURUSD.raw",
              price: 1.095,
              volume: 0.01,
              profit: 10,
              commission: 0,
              swap: 0,
              comment: "ttc:demo-1:tp2",
              time: "2026.05.18 10:00:00",
            },
          ],
        }),
      });

      const reader = new Database(databasePath, { readonly: true });
      const row = reader
        .query("SELECT action FROM broker_orders WHERE deal_ticket = ?")
        .get("9007199254740996") as { action: string } | null;
      reader.close();
      expect(row?.action).toBe("FULL_CLOSE");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("canonical SQL migration creates external close history storage", async () => {
    const migration = await readFile(join(process.cwd(), "migrations/0001_initial.sql"), "utf8");
    const db = new Database(":memory:");
    try {
      db.exec(migration);
      const table = db
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'external_closes'")
        .get() as { name: string } | null;
      expect(table?.name).toBe("external_closes");
      const executionIndexes = (
        db
          .query("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?")
          .all("execution_reports") as Array<{ name: string }>
      ).map((row) => row.name);
      expect(executionIndexes).toContain("idx_execution_reports_created");
      expect(executionIndexes).toContain("idx_execution_reports_account_created");
    } finally {
      db.close();
    }
  });

  test("database bootstrap creates execution report indexes for existing deployments", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "telegram-tc-indexes-"));
    const databasePath = join(tempDir, "telegram-tc.db");
    const app = createApi({ databasePath, seedDemoData: false });
    const response = await app.request("/api/health");
    expect(response.status).toBe(200);

    const reader = new Database(databasePath, { readonly: true });
    try {
      const executionIndexes = (
        reader
          .query("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?")
          .all("execution_reports") as Array<{ name: string }>
      ).map((row) => row.name);
      expect(executionIndexes).toContain("idx_execution_reports_created");
      expect(executionIndexes).toContain("idx_execution_reports_account_created");
    } finally {
      reader.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("closedTrades rolls up multi-leg close lifecycle with Mixed close reason and winning net result", async () => {
    const app = createApi({
      databasePath: ":memory:",
      telegramAdapter: "mock",
      seedDemoData: true,
    });
    // Open the seeded demo trade via the EA's report channel.
    await app.request("/api/mt5/report", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        queueItemId: "queue-demo-1",
        accountId: "mt5-100200300",
        status: "EXECUTED",
        retcode: 10009,
        retcodeExternal: 0,
        brokerComment: "ttc:demo-1",
        orderTicket: "order-1",
        positionTicket: "position-1",
        dealTicket: "deal-open-1",
        requestedPrice: 1.085,
        filledPrice: 1.085,
        volume: 0.1,
      }),
    });
    // Close it in three legs: TP1 (reason=5), TP2 (reason=5), then SL (reason=4)
    // wipes the remainder. The history-deals handler writes one broker_order
    // per deal, which the rollup then groups under the parent logical trade.
    await app.request("/api/mt5/history", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        accountId: "mt5-100200300",
        deals: [
          {
            dealTicket: "deal-tp1",
            orderTicket: "order-tp1",
            positionTicket: "position-1",
            entry: "1",
            type: "1",
            reason: 5,
            symbol: "EURUSD.raw",
            price: 1.09,
            volume: 0.04,
            profit: 20,
            commission: 0,
            swap: 0,
            comment: "ttc:demo-1:tp1",
            time: "2026.05.18 10:42:14",
          },
          {
            dealTicket: "deal-tp2",
            orderTicket: "order-tp2",
            positionTicket: "position-1",
            entry: "1",
            type: "1",
            reason: 5,
            symbol: "EURUSD.raw",
            price: 1.095,
            volume: 0.04,
            profit: 40,
            commission: 0,
            swap: 0,
            comment: "ttc:demo-1:tp2",
            time: "2026.05.18 10:51:03",
          },
          {
            dealTicket: "deal-sl",
            orderTicket: "order-sl",
            positionTicket: "position-1",
            entry: "1",
            type: "1",
            reason: 4,
            symbol: "EURUSD.raw",
            price: 1.08,
            volume: 0.02,
            profit: -10,
            commission: 0,
            swap: 0,
            comment: "ttc:demo-1",
            time: "2026.05.18 11:14:28",
          },
        ],
      }),
    });
    type ClosedTrade = {
      tradeId: string;
      shortId: string;
      ticket: string;
      symbol: string;
      direction: string;
      origin: string;
      result: string;
      closeReason: string;
      netResult: string;
      realizedPnl: number;
      tpHitCount: number;
      tpTotal: number;
      legs: Array<{ source: string; legIndex?: number; pnl: number; volume: number }>;
    };
    const dash = await json<{
      mt5Accounts: Array<{ id: string; closedTrades: ClosedTrade[] }>;
    }>(await app.request("/api/dashboard"));
    const account = dash.mt5Accounts.find((a) => a.id === "mt5-100200300");
    expect(account).toBeDefined();
    const closed = account!.closedTrades.find((t) => t.tradeId === "trade-demo-1");
    expect(closed).toBeDefined();
    // 2 TP-hit closes + 1 SL-hit close keeps the close reason as "Mixed",
    // while the compact result chip is driven by net realized P/L.
    expect(closed!.result).toBe("Mixed");
    expect(closed!.closeReason).toBe("Mixed");
    expect(closed!.netResult).toBe("WIN");
    // Net realized P/L = 20 + 40 + (-10) = 50 (verifies the sum is across all
    // close legs, not just the final one).
    expect(closed!.realizedPnl).toBe(50);
    expect(closed!.origin).toBe("ea");
    expect(closed!.ticket).toBe("position-1");
    expect(closed!.legs).toHaveLength(3);
    const tpSources = closed!.legs.filter((leg) => leg.source === "tp-hit");
    const slSources = closed!.legs.filter((leg) => leg.source === "sl-hit");
    expect(tpSources).toHaveLength(2);
    expect(slSources).toHaveLength(1);
  });

  test("snapshot reconcile does not overwrite CLOSED status when a real close exists", async () => {
    // Reproduces the production bug: after a sl-hit close was recorded via
    // /api/mt5/history, the next snapshot poll (with the ticket no longer
    // in positions[]) would race the history sweep and revert status back to
    // OUT_OF_SYNC. The fix skips trades that have a real-source FULL_CLOSE.
    const app = createApi({
      databasePath: ":memory:",
      telegramAdapter: "mock",
      seedDemoData: true,
    });
    await app.request("/api/mt5/report", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        queueItemId: "queue-demo-1",
        accountId: "mt5-100200300",
        status: "EXECUTED",
        retcode: 10009,
        retcodeExternal: 0,
        brokerComment: "ttc:demo-1",
        orderTicket: "order-1",
        positionTicket: "position-1",
        dealTicket: "deal-open-1",
        requestedPrice: 1.085,
        filledPrice: 1.085,
        volume: 0.1,
      }),
    });
    // SL closes the position via history sweep.
    await app.request("/api/mt5/history", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        accountId: "mt5-100200300",
        deals: [
          {
            dealTicket: "deal-sl",
            orderTicket: "order-sl",
            positionTicket: "position-1",
            entry: "1",
            type: "1",
            reason: 4,
            symbol: "EURUSD.raw",
            price: 1.08,
            volume: 0.1,
            profit: -50,
            commission: 0,
            swap: 0,
            comment: "ttc:demo-1",
            time: "2026.05.18 11:14:28",
          },
        ],
      }),
    });
    // Now a snapshot arrives with no matching position. Before the fix this
    // would flip status back to OUT_OF_SYNC. After the fix it should stay
    // CLOSED.
    await app.request("/api/mt5/snapshot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        accountId: "mt5-100200300",
        positions: [],
        orders: [],
        symbols: [],
      }),
    });
    const dash = await json<{
      logicalTrades: Array<{ id: string; status: string }>;
    }>(await app.request("/api/dashboard"));
    const trade = dash.logicalTrades.find((t) => t.id === "trade-demo-1");
    expect(trade).toBeDefined();
    expect(trade!.status).toBe("CLOSED");
  });

  test("older open history deals do not reopen trades that already have a real full close", async () => {
    const app = createApi({
      databasePath: ":memory:",
      telegramAdapter: "mock",
      seedDemoData: true,
    });
    await app.request("/api/mt5/report", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        queueItemId: "queue-demo-1",
        accountId: "mt5-100200300",
        status: "EXECUTED",
        retcode: 10009,
        retcodeExternal: 0,
        brokerComment: "ttc:demo-1",
        orderTicket: "247596888",
        positionTicket: "247596888",
        dealTicket: "deal-open-1",
        requestedPrice: 1.085,
        filledPrice: 1.085,
        volume: 0.1,
      }),
    });
    await app.request("/api/mt5/history", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        accountId: "mt5-100200300",
        deals: [
          {
            dealTicket: "deal-sl",
            orderTicket: "order-sl",
            positionTicket: "247596888",
            entry: "1",
            type: "1",
            reason: 4,
            symbol: "EURUSD.raw",
            price: 1.08,
            volume: 0.1,
            profit: -50,
            commission: 0,
            swap: 0,
            comment: "[sl 1.08000]",
            timeMsc: Date.UTC(2026, 4, 18, 11, 14, 28),
          },
        ],
      }),
    });

    await app.request("/api/mt5/history", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        accountId: "mt5-100200300",
        deals: [
          {
            dealTicket: "deal-open-replayed",
            orderTicket: "247596888",
            positionTicket: "247596888",
            entry: "0",
            type: "0",
            reason: 3,
            symbol: "EURUSD.raw",
            price: 1.085,
            volume: 0.1,
            profit: 0,
            commission: 0,
            swap: 0,
            comment: "ttc:demo-1",
            timeMsc: Date.UTC(2026, 4, 18, 10, 0, 0),
          },
        ],
      }),
    });

    const dash = await json<{
      logicalTrades: Array<{ id: string; status: string; livePositionExists?: boolean }>;
    }>(await app.request("/api/dashboard"));
    expect(dash.logicalTrades.find((t) => t.id === "trade-demo-1")).toMatchObject({
      status: "CLOSED",
      livePositionExists: false,
    });
  });

  test("backfill heals stuck OUT_OF_SYNC trades that have a real close in broker_orders", async () => {
    // Set up: a logical trade is stuck OUT_OF_SYNC (the pre-fix bug state)
    // with both a synthetic 'manual' close (snapshot-diff) AND a real sl-hit
    // close (history sweep) on the same position ticket. On next startup the
    // backfill should flip status to CLOSED and dedupe the synthetic row.
    const app = createApi({
      databasePath: ":memory:",
      telegramAdapter: "mock",
      seedDemoData: true,
    });
    await app.request("/api/mt5/report", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        queueItemId: "queue-demo-1",
        accountId: "mt5-100200300",
        status: "EXECUTED",
        retcode: 10009,
        retcodeExternal: 0,
        brokerComment: "ttc:demo-1",
        orderTicket: "247596888",
        positionTicket: "247596888",
        dealTicket: "deal-open-1",
        requestedPrice: 1.085,
        filledPrice: 1.085,
        volume: 0.1,
      }),
    });
    // Force the trade into OUT_OF_SYNC by sending a snapshot with no matching
    // position (this is how prod got stuck — snapshot saw nothing, no real
    // close arrived in time, status flipped to OUT_OF_SYNC).
    await app.request("/api/mt5/snapshot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        accountId: "mt5-100200300",
        positions: [],
        orders: [],
        symbols: [],
      }),
    });
    const dash = await json<{
      logicalTrades: Array<{ id: string; status: string }>;
    }>(await app.request("/api/dashboard"));
    let trade = dash.logicalTrades.find((t) => t.id === "trade-demo-1");
    // Pre-condition: synthetic 'manual' close was written AND status is now
    // OUT_OF_SYNC (the stuck state).
    expect(trade!.status).toBe("OUT_OF_SYNC");
    // Now a real sl-hit deal lands. With the race-fix in place,
    // reconcileSnapshotState should NOT re-stick it, AND the trade should be
    // CLOSED on the next dashboard read.
    await app.request("/api/mt5/history", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        accountId: "mt5-100200300",
        deals: [
          {
            dealTicket: "deal-sl",
            orderTicket: "order-sl",
            positionTicket: "247596888",
            entry: "1",
            type: "1",
            reason: 4,
            symbol: "EURUSD.raw",
            price: 1.08,
            volume: 0.1,
            profit: -50,
            commission: 0,
            swap: 0,
            comment: "ttc:demo-1",
            time: "2026.05.18 11:14:28",
          },
        ],
      }),
    });
    const healedDash = await json<{
      logicalTrades: Array<{ id: string; status: string }>;
      mt5Accounts: Array<{
        id: string;
        closedTrades: Array<{
          tradeId: string;
          realizedPnl: number;
          legs: Array<{ source: string }>;
        }>;
      }>;
    }>(await app.request("/api/dashboard"));
    trade = healedDash.logicalTrades.find((t) => t.id === "trade-demo-1");
    expect(trade!.status).toBe("CLOSED");
    const account = healedDash.mt5Accounts.find((a) => a.id === "mt5-100200300");
    const closed = account!.closedTrades.find((t) => t.tradeId === "trade-demo-1");
    expect(closed).toBeDefined();
    // The synthetic 'manual' close (pnl=null → 0) should be deduped, so only
    // the real sl-hit close contributes to realizedPnl (= -50).
    expect(closed!.realizedPnl).toBe(-50);
    expect(closed!.legs.every((leg) => leg.source !== "manual")).toBe(true);
  });

  test("startup backfill heals already-stuck OUT_OF_SYNC trades from persisted broker history", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "telegram-tc-"));
    const databasePath = join(tempDir, "app.db");
    try {
      const app = createApi({
        databasePath,
        telegramAdapter: "mock",
        seedDemoData: true,
      });
      await app.request("/api/mt5/report", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          queueItemId: "queue-demo-1",
          accountId: "mt5-100200300",
          status: "EXECUTED",
          retcode: 10009,
          retcodeExternal: 0,
          brokerComment: "ttc:demo-1",
          orderTicket: "247596888",
          positionTicket: "247596888",
          dealTicket: "deal-open-1",
          requestedPrice: 1.085,
          filledPrice: 1.085,
          volume: 0.1,
        }),
      });
      await app.request("/api/mt5/snapshot", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          accountId: "mt5-100200300",
          positions: [],
          orders: [],
          symbols: [],
        }),
      });

      const db = new Database(databasePath);
      db.query(
        `INSERT INTO broker_orders
          (id, logical_trade_id, leg_id, action, queue_item_id, account_id, order_ticket, position_ticket, deal_ticket,
           requested_volume, filled_volume, requested_price, filled_price, retcode, retcode_external, broker_comment,
           pnl_currency, pnl_pips, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "broker-real-sl",
        "trade-demo-1",
        "trade",
        "FULL_CLOSE",
        "history",
        "mt5-100200300",
        "order-sl",
        "247596888",
        "deal-sl",
        null,
        0.1,
        null,
        1.08,
        0,
        0,
        "[sl 1.08000]",
        -50,
        -50,
        "sl-hit",
        "2026.05.18 11:14:28",
      );
      db.close();

      const restarted = createApi({
        databasePath,
        telegramAdapter: "mock",
        seedDemoData: false,
      });
      const dash = await json<{
        logicalTrades: Array<{ id: string; status: string }>;
        mt5Accounts: Array<{
          id: string;
          closedTrades: Array<{
            tradeId: string;
            realizedPnl: number;
            legs: Array<{ source: string }>;
          }>;
        }>;
      }>(await restarted.request("/api/dashboard"));
      expect(dash.logicalTrades.find((trade) => trade.id === "trade-demo-1")?.status).toBe(
        "CLOSED",
      );
      const closed = dash.mt5Accounts
        .find((account) => account.id === "mt5-100200300")
        ?.closedTrades.find((trade) => trade.tradeId === "trade-demo-1");
      expect(closed?.realizedPnl).toBe(-50);
      expect(closed?.legs.map((leg) => leg.source)).toEqual(["sl-hit"]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("startup backfill heals OUT_OF_SYNC trades when recorded partial closes cover the open volume", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "telegram-tc-"));
    const databasePath = join(tempDir, "app.db");
    try {
      const app = createApi({
        databasePath,
        telegramAdapter: "mock",
        seedDemoData: true,
      });
      await app.request("/api/mt5/report", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          queueItemId: "queue-demo-1",
          accountId: "mt5-100200300",
          status: "EXECUTED",
          retcode: 10009,
          retcodeExternal: 0,
          brokerComment: "ttc:demo-1",
          orderTicket: "247596888",
          positionTicket: "247596888",
          dealTicket: "deal-open-1",
          requestedPrice: 1.085,
          filledPrice: 1.085,
          volume: 0.1,
        }),
      });
      await app.request("/api/mt5/snapshot", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          accountId: "mt5-100200300",
          positions: [],
          orders: [],
          symbols: [],
        }),
      });

      const db = new Database(databasePath);
      db.query(
        `INSERT INTO broker_orders
          (id, logical_trade_id, leg_id, action, queue_item_id, account_id, order_ticket, position_ticket, deal_ticket,
           requested_volume, filled_volume, requested_price, filled_price, retcode, retcode_external, broker_comment,
           pnl_currency, pnl_pips, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "broker-stale-partial-sl",
        "trade-demo-1",
        "trade",
        "PARTIAL_CLOSE",
        "history",
        "mt5-100200300",
        "order-sl",
        "247596888",
        "deal-sl",
        null,
        0.1,
        null,
        1.08,
        0,
        0,
        "[sl 1.08000]",
        -50,
        -50,
        "sl-hit",
        "2026.05.18 11:14:28",
      );
      db.close();

      const restarted = createApi({
        databasePath,
        telegramAdapter: "mock",
        seedDemoData: false,
      });
      const dash = await json<{
        logicalTrades: Array<{ id: string; status: string }>;
        mt5Accounts: Array<{
          id: string;
          closedTrades: Array<{ tradeId: string; realizedPnl: number }>;
        }>;
      }>(await restarted.request("/api/dashboard"));
      expect(dash.logicalTrades.find((t) => t.id === "trade-demo-1")?.status).toBe("CLOSED");
      const closed = dash.mt5Accounts
        .find((account) => account.id === "mt5-100200300")
        ?.closedTrades.find((trade) => trade.tradeId === "trade-demo-1");
      expect(closed).toMatchObject({ realizedPnl: -50 });

      const rows = new Database(databasePath, { readonly: true })
        .query("SELECT action FROM broker_orders WHERE id = 'broker-stale-partial-sl' LIMIT 1")
        .all() as Array<{ action: string }>;
      expect(rows[0]?.action).toBe("FULL_CLOSE");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("startup backfill closes OPEN trades when recorded partial closes cover the open volume", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "telegram-tc-"));
    const databasePath = join(tempDir, "app.db");
    try {
      const app = createApi({
        databasePath,
        telegramAdapter: "mock",
        seedDemoData: true,
      });
      await app.request("/api/mt5/report", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          queueItemId: "queue-demo-1",
          accountId: "mt5-100200300",
          status: "EXECUTED",
          retcode: 10009,
          retcodeExternal: 0,
          brokerComment: "ttc:demo-1",
          orderTicket: "247596888",
          positionTicket: "247596888",
          dealTicket: "deal-open-1",
          requestedPrice: 1.085,
          filledPrice: 1.085,
          volume: 0.1,
        }),
      });

      const db = new Database(databasePath);
      db.query(
        `INSERT INTO broker_orders
          (id, logical_trade_id, leg_id, action, queue_item_id, account_id, order_ticket, position_ticket, deal_ticket,
           requested_volume, filled_volume, requested_price, filled_price, retcode, retcode_external, broker_comment,
           pnl_currency, pnl_pips, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "broker-covered-close",
        "trade-demo-1",
        "trade",
        "PARTIAL_CLOSE",
        "history",
        "mt5-100200300",
        "order-sl",
        "247596888",
        "deal-sl",
        null,
        0.1,
        null,
        1.08,
        0,
        0,
        "[sl 1.08000]",
        -50,
        -50,
        "sl-hit",
        "2026.05.18 11:14:28",
      );
      db.close();

      const restarted = createApi({
        databasePath,
        telegramAdapter: "mock",
        seedDemoData: false,
      });
      const dash = await json<{
        logicalTrades: Array<{ id: string; status: string }>;
        mt5Accounts: Array<{
          id: string;
          closedTrades: Array<{ tradeId: string; realizedPnl: number }>;
        }>;
      }>(await restarted.request("/api/dashboard"));
      expect(dash.logicalTrades.find((t) => t.id === "trade-demo-1")?.status).toBe("CLOSED");
      const closed = dash.mt5Accounts
        .find((account) => account.id === "mt5-100200300")
        ?.closedTrades.find((trade) => trade.tradeId === "trade-demo-1");
      expect(closed).toMatchObject({ realizedPnl: -50 });

      const rows = new Database(databasePath, { readonly: true })
        .query("SELECT action FROM broker_orders WHERE id = 'broker-covered-close' LIMIT 1")
        .all() as Array<{ action: string }>;
      expect(rows[0]?.action).toBe("FULL_CLOSE");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("startup backfill keeps a partial close open when it only covers one split open fill", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "telegram-tc-"));
    const databasePath = join(tempDir, "app.db");
    try {
      const app = createApi({
        databasePath,
        telegramAdapter: "mock",
        seedDemoData: true,
      });
      await app.request("/api/mt5/report", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          queueItemId: "queue-demo-1",
          accountId: "mt5-100200300",
          status: "EXECUTED",
          retcode: 10009,
          retcodeExternal: 0,
          brokerComment: "ttc:demo-1",
          orderTicket: "247596888",
          positionTicket: "247596888",
          dealTicket: "deal-open-1",
          requestedPrice: 1.085,
          filledPrice: 1.085,
          volume: 0.03,
        }),
      });
      await app.request("/api/mt5/snapshot", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          accountId: "mt5-100200300",
          positions: [],
          orders: [],
          symbols: [],
        }),
      });

      const db = new Database(databasePath);
      db.query(
        `INSERT INTO broker_orders
          (id, logical_trade_id, leg_id, action, queue_item_id, account_id, order_ticket, position_ticket, deal_ticket,
           requested_volume, filled_volume, requested_price, filled_price, retcode, retcode_external, broker_comment,
           pnl_currency, pnl_pips, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "broker-second-open-fill",
        "trade-demo-1",
        "trade",
        "OPEN",
        "history",
        "mt5-100200300",
        "247596889",
        "247596888",
        "deal-open-2",
        null,
        0.02,
        null,
        1.0851,
        0,
        0,
        "ttc:demo-1",
        0,
        0,
        "history",
        "2026.05.18 11:14:20",
      );
      db.query(
        `INSERT INTO broker_orders
          (id, logical_trade_id, leg_id, action, queue_item_id, account_id, order_ticket, position_ticket, deal_ticket,
           requested_volume, filled_volume, requested_price, filled_price, retcode, retcode_external, broker_comment,
           pnl_currency, pnl_pips, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "broker-split-partial-close",
        "trade-demo-1",
        "trade",
        "PARTIAL_CLOSE",
        "history",
        "mt5-100200300",
        "order-partial",
        "247596888",
        "deal-partial",
        null,
        0.03,
        null,
        1.09,
        0,
        0,
        "[tp 1.09000]",
        25,
        50,
        "tp-hit",
        "2026.05.18 11:14:28",
      );
      db.close();

      const restarted = createApi({
        databasePath,
        telegramAdapter: "mock",
        seedDemoData: false,
      });
      const dash = await json<{ logicalTrades: Array<{ id: string; status: string }> }>(
        await restarted.request("/api/dashboard"),
      );
      expect(dash.logicalTrades.find((t) => t.id === "trade-demo-1")?.status).toBe("OPEN");

      const reader = new Database(databasePath, { readonly: true });
      const rows = reader
        .query("SELECT action FROM broker_orders WHERE id = 'broker-split-partial-close' LIMIT 1")
        .all() as Array<{ action: string }>;
      reader.close();
      expect(rows[0]?.action).toBe("PARTIAL_CLOSE");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("startup backfill keeps multi-ticket trades open until every ticket is covered", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "telegram-tc-"));
    const databasePath = join(tempDir, "app.db");
    try {
      const app = createApi({
        databasePath,
        telegramAdapter: "mock",
        seedDemoData: true,
      });
      await app.request("/api/mt5/report", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          queueItemId: "queue-demo-1",
          accountId: "mt5-100200300",
          status: "EXECUTED",
          retcode: 10009,
          retcodeExternal: 0,
          brokerComment: "ttc:demo-1",
          orderTicket: "247596888",
          positionTicket: "247596888",
          dealTicket: "deal-open-1",
          requestedPrice: 1.085,
          filledPrice: 1.085,
          volume: 0.03,
        }),
      });
      await app.request("/api/mt5/snapshot", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          accountId: "mt5-100200300",
          positions: [],
          orders: [],
          symbols: [],
        }),
      });

      const db = new Database(databasePath);
      const insert = db.query(
        `INSERT INTO broker_orders
          (id, logical_trade_id, leg_id, action, queue_item_id, account_id, order_ticket, position_ticket, deal_ticket,
           requested_volume, filled_volume, requested_price, filled_price, retcode, retcode_external, broker_comment,
           pnl_currency, pnl_pips, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      insert.run(
        "broker-second-position-open",
        "trade-demo-1",
        "trade",
        "OPEN",
        "history",
        "mt5-100200300",
        "247596889",
        "247596889",
        "deal-open-2",
        null,
        0.02,
        null,
        1.0851,
        0,
        0,
        "ttc:demo-1",
        0,
        0,
        "history",
        "2026.05.18 11:14:20",
      );
      insert.run(
        "broker-first-position-close",
        "trade-demo-1",
        "trade",
        "PARTIAL_CLOSE",
        "history",
        "mt5-100200300",
        "order-close-1",
        "247596888",
        "deal-close-1",
        null,
        0.03,
        null,
        1.09,
        0,
        0,
        "[tp 1.09000]",
        25,
        50,
        "tp-hit",
        "2026.05.18 11:14:28",
      );
      db.close();

      const restarted = createApi({
        databasePath,
        telegramAdapter: "mock",
        seedDemoData: false,
      });
      const dash = await json<{ logicalTrades: Array<{ id: string; status: string }> }>(
        await restarted.request("/api/dashboard"),
      );
      expect(dash.logicalTrades.find((t) => t.id === "trade-demo-1")?.status).toBe("OPEN");

      const reader = new Database(databasePath, { readonly: true });
      const rows = reader
        .query("SELECT action FROM broker_orders WHERE id = 'broker-first-position-close' LIMIT 1")
        .all() as Array<{ action: string }>;
      reader.close();
      expect(rows[0]?.action).toBe("PARTIAL_CLOSE");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("startup backfill cancels unrecoverable OUT_OF_SYNC trades with no broker open row", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "telegram-tc-"));
    const databasePath = join(tempDir, "app.db");
    try {
      createApi({
        databasePath,
        telegramAdapter: "mock",
        seedDemoData: true,
      });
      const db = new Database(databasePath);
      const row = db
        .query("SELECT data_json FROM logical_trades WHERE id = ?")
        .get("trade-demo-1") as { data_json: string } | null;
      expect(row).toBeDefined();
      const trade = { ...JSON.parse(row!.data_json), status: "OUT_OF_SYNC" };
      db.query("UPDATE logical_trades SET status = ?, data_json = ? WHERE id = ?").run(
        "OUT_OF_SYNC",
        JSON.stringify(trade),
        "trade-demo-1",
      );
      db.query(
        `INSERT INTO broker_orders
          (id, logical_trade_id, leg_id, action, queue_item_id, account_id, order_ticket, position_ticket, deal_ticket,
           requested_volume, filled_volume, requested_price, filled_price, retcode, retcode_external, broker_comment,
           pnl_currency, pnl_pips, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "broker-failed-open",
        "trade-demo-1",
        "entry",
        "OPEN",
        "queue-demo-1",
        "mt5-100200300",
        "0",
        "0",
        "0",
        0.1,
        0,
        0,
        0,
        0,
        0,
        "Invalid pending order price for current bid/ask or stop level",
        null,
        null,
        "signal",
        "2026-05-18T04:36:51.579Z",
      );
      db.close();

      const restarted = createApi({
        databasePath,
        telegramAdapter: "mock",
        seedDemoData: false,
      });
      const dash = await json<{
        logicalTrades: Array<{ id: string; status: string; legs: Array<{ status: string }> }>;
      }>(await restarted.request("/api/dashboard"));
      const cancelled = dash.logicalTrades.find((item) => item.id === "trade-demo-1");
      expect(cancelled?.status).toBe("CANCELLED");
      expect(cancelled?.legs.every((leg) => leg.status === "SKIPPED")).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("startup backfill recovers live OUT_OF_SYNC virtual TP plans with source lineage", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "telegram-tc-"));
    const databasePath = join(tempDir, "app.db");
    try {
      const telegram = createQueuedTelegramAdapter([
        {
          telegramMessageId: "recovery-1",
          messageDate: "2026-05-19T10:01:02.000Z",
          rawText: "BUY XAUUSD @ 4525\nSL 4515\nTP 4535\nTP 4545",
        },
      ]);
      const app = createApi({
        databasePath,
        seedDemoData: false,
        telegram,
        telegramPollingEnabled: false,
      });

      await configureProviderWithAccount(app, { availableSymbols: ["XAUUSD", "EURUSD"] });
      const ingest = await app.runTelegramIngestionOnce();
      expect(ingest.queued).toBe(1);

      const before = await json<{
        logicalTrades: Array<{ id: string; status: string }>;
      }>(await app.request("/api/dashboard"));
      const tradeId = before.logicalTrades[0]!.id;
      const queueDb = new Database(databasePath);
      const queueRow = queueDb
        .query("SELECT id FROM queue_items WHERE logical_trade_id = ?")
        .get(tradeId) as { id: string } | null;
      queueDb.close();
      expect(queueRow).toBeDefined();
      const queueId = queueRow!.id;

      await app.request("/api/mt5/report", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          queueItemId: queueId,
          accountId: "mt5-63442826",
          status: "EXECUTED",
          retcode: 10009,
          retcodeExternal: 0,
          brokerComment: "Request executed",
          orderTicket: "open-order-1",
          positionTicket: "open-position-1",
          dealTicket: "open-deal-1",
          requestedPrice: 4528,
          filledPrice: 4528,
          volume: 0.1,
          errorText: "",
        }),
      });

      await app.request("/api/mt5/snapshot", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          accountId: "mt5-63442826",
          positions: [],
          orders: [],
          symbols: [{ symbol: "XAUUSD", bid: 4529, ask: 4529.3 }],
        }),
      });

      const stuck = await json<{
        logicalTrades: Array<{ id: string; status: string }>;
      }>(await app.request("/api/dashboard"));
      expect(stuck.logicalTrades.find((item) => item.id === tradeId)?.status).toBe("OUT_OF_SYNC");

      const restarted = createApi({
        databasePath,
        telegramAdapter: "mock",
        seedDemoData: false,
        telegramPollingEnabled: false,
      });
      const recovered = await json<{
        logicalTrades: Array<{
          id: string;
          status: string;
          outOfSyncReason?: string;
          livePositionExists?: boolean;
          matchedBrokerTickets?: string[];
          source?: { telegramMessageId: string; rawText: string };
          legs: Array<{ status: string }>;
        }>;
      }>(await restarted.request("/api/dashboard"));
      const trade = recovered.logicalTrades.find((item) => item.id === tradeId);
      expect(trade).toBeDefined();
      expect(trade!.status).toBe("OPEN");
      expect(trade!.outOfSyncReason).toBeUndefined();
      expect(trade!.livePositionExists).toBe(true);
      expect(trade!.matchedBrokerTickets).toEqual(["open-position-1"]);
      expect(trade!.source).toMatchObject({
        telegramMessageId: "recovery-1",
        rawText: "BUY XAUUSD @ 4525\nSL 4515\nTP 4535\nTP 4545",
      });
      expect(trade!.legs.every((leg) => leg.status === "OPEN")).toBe(true);

      const activePlans = await (
        await restarted.request("/api/mt5/active-plans?accountId=mt5-63442826")
      ).text();
      expect(activePlans).toContain(`logicalTradeId=${tradeId}`);
      expect(activePlans).toContain("positionTicket=open-position-1");
      expect(activePlans).toContain("tp1Price=4535");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("startup maintenance preserves provider routing config and symbol mappings", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "telegram-tc-"));
    const databasePath = join(tempDir, "app.db");
    try {
      const app = createApi({
        databasePath,
        telegramAdapter: "mock",
        seedDemoData: false,
        telegramPollingEnabled: false,
      });
      const providerId = await configureProviderWithAccount(app, {
        availableSymbols: ["XAUUSD", "EURUSD.raw"],
      });
      await app.request(`/api/providers/${providerId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          riskMode: "fixed",
          riskAmount: 0.2,
          takeProfitLevels: [
            { leg: 1, percentage: 50, strategy: { kind: "set-sl-to-entry", offsetPips: 0 } },
            { leg: 2, percentage: 50, strategy: { kind: "no-change" } },
          ],
        }),
      });
      await app.request(`/api/accounts/mt5-63442826/providers/${providerId}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      });
      await app.request("/api/symbol-aliases", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scope: "provider",
          providerId,
          rawSymbol: "GOLD",
          canonicalSymbol: "XAUUSD",
        }),
      });
      await app.request("/api/symbol-mappings/account/mt5-63442826", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          accountId: "mt5-63442826",
          canonicalOverrides: { XAUUSD: "XAUUSD", EURUSD: "EURUSD.raw" },
          suffix: ".raw",
          includeSymbols: ["XAUUSD", "EURUSD.raw"],
          excludeSymbols: [],
        }),
      });

      const db = new Database(databasePath);
      const before = {
        links: db
          .query(
            "SELECT account_id, provider_id, enabled FROM account_provider_links ORDER BY account_id, provider_id",
          )
          .all(),
        mappings: db
          .query("SELECT account_id, mapping_json FROM account_symbol_mappings ORDER BY account_id")
          .all(),
        aliases: db
          .query(
            "SELECT scope, provider_id, raw_symbol, canonical_symbol FROM symbol_aliases ORDER BY scope, provider_id, raw_symbol",
          )
          .all(),
        configHistory: db
          .query(
            "SELECT provider_id, config_json FROM provider_config_history ORDER BY provider_id, created_at",
          )
          .all(),
      };
      db.close();

      createApi({
        databasePath,
        telegramAdapter: "mock",
        seedDemoData: false,
        telegramPollingEnabled: false,
      });

      const verifyDb = new Database(databasePath);
      expect(
        verifyDb
          .query(
            "SELECT account_id, provider_id, enabled FROM account_provider_links ORDER BY account_id, provider_id",
          )
          .all(),
      ).toEqual(before.links);
      expect(
        verifyDb
          .query("SELECT account_id, mapping_json FROM account_symbol_mappings ORDER BY account_id")
          .all(),
      ).toEqual(before.mappings);
      expect(
        verifyDb
          .query(
            "SELECT scope, provider_id, raw_symbol, canonical_symbol FROM symbol_aliases ORDER BY scope, provider_id, raw_symbol",
          )
          .all(),
      ).toEqual(before.aliases);
      expect(
        verifyDb
          .query(
            "SELECT provider_id, config_json FROM provider_config_history ORDER BY provider_id, created_at",
          )
          .all(),
      ).toEqual(before.configHistory);
      const audit = verifyDb
        .query("SELECT level, event_type FROM audit_logs WHERE event_type = ?")
        .get("operator-state.preserved") as { level: string; event_type: string } | null;
      verifyDb.close();
      expect(audit).toEqual({ level: "info", event_type: "operator-state.preserved" });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("account performance separates deposits from trading PnL and includes floating manual positions", async () => {
    const app = createApi({
      databasePath: ":memory:",
      telegramAdapter: "mock",
      seedDemoData: true,
    });

    await app.request("/api/mt5/report", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        queueItemId: "queue-demo-1",
        accountId: "mt5-100200300",
        status: "EXECUTED",
        retcode: 10009,
        retcodeExternal: 0,
        brokerComment: "ttc:demo-1",
        orderTicket: "order-1",
        positionTicket: "position-1",
        dealTicket: "deal-open-1",
        requestedPrice: 1.085,
        filledPrice: 1.085,
        volume: 0.1,
      }),
    });
    await app.request("/api/mt5/history", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        accountId: "mt5-100200300",
        deals: [
          {
            dealTicket: "deal-close-1",
            orderTicket: "order-close-1",
            positionTicket: "position-1",
            entry: "1",
            type: "1",
            reason: 4,
            symbol: "EURUSD.raw",
            price: 1.084,
            volume: 0.1,
            profit: -10,
            commission: 0,
            swap: 0,
            comment: "ttc:demo-1",
            time: "2026.05.18 09:00:00",
          },
        ],
      }),
    });
    await app.request("/api/mt5/heartbeat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        accountId: "mt5-100200300",
        balance: 10100,
        equity: 10115,
        profit: 25,
        availableSymbols: ["EURUSD.raw", "XAUUSD"],
      }),
    });
    await app.request("/api/mt5/snapshot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        accountId: "mt5-100200300",
        positions: [
          {
            ticket: "manual-1",
            symbol: "XAUUSD",
            type: 1,
            volume: 0.01,
            openPrice: 4553.73,
            sl: 4560,
            tp: 4481.29,
            profit: 25,
            magic: 0,
            isExternal: true,
            comment: "",
          },
        ],
        orders: [],
        symbols: [],
      }),
    });

    const perf = await json<{
      initialBalance: number;
      totalProfit: number;
      realizedPnl: number;
      floatingPnl: number;
      netDeposits: number;
      currentEquity: number;
    }>(await app.request("/api/account/performance"));

    expect(perf.initialBalance).toBe(10000);
    expect(perf.realizedPnl).toBe(-10);
    expect(perf.floatingPnl).toBe(25);
    expect(perf.totalProfit).toBe(15);
    expect(perf.netDeposits).toBe(100);
    expect(perf.currentEquity).toBe(10115);
  });

  test("heartbeats persist minute-bucketed account equity points for drawdown stats", async () => {
    const originalDateNow = Date.now;
    const tempDir = await mkdtemp(join(tmpdir(), "telegram-tc-"));
    const databasePath = join(tempDir, "app.db");
    try {
      Date.now = () => Date.UTC(2026, 4, 21, 8, 30, 12);
      const app = createApi({
        databasePath,
        telegramAdapter: "mock",
        seedDemoData: false,
      });
      await app.request("/api/mt5/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          accountNumber: "100200300",
          server: "MetaQuotes-Demo",
          company: "MetaQuotes",
          currency: "USD",
          balance: 10000,
          equity: 10000,
          profit: 0,
          marginMode: "HEDGING",
          availableSymbols: ["XAUUSD"],
        }),
      });

      await app.request("/api/mt5/heartbeat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          accountId: "mt5-100200300",
          balance: 10000,
          equity: 9950,
          profit: -50,
          availableSymbols: ["XAUUSD"],
        }),
      });
      Date.now = () => Date.UTC(2026, 4, 21, 8, 30, 45);
      await app.request("/api/mt5/heartbeat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          accountId: "mt5-100200300",
          balance: 10000,
          equity: 9975,
          profit: -25,
          availableSymbols: ["XAUUSD"],
        }),
      });

      const db = new Database(databasePath, { readonly: true });
      const row = db
        .query(
          `SELECT scope, account_id, provider_id, bucket_start, open_value, high_value, low_value, close_value, sample_count
           FROM equity_curve_points
           WHERE scope = 'account' AND account_id = ?`,
        )
        .get("mt5-100200300") as {
        scope: string;
        account_id: string;
        provider_id: string;
        bucket_start: string;
        open_value: number;
        high_value: number;
        low_value: number;
        close_value: number;
        sample_count: number;
      } | null;
      db.close();

      expect(row).toMatchObject({
        scope: "account",
        account_id: "mt5-100200300",
        provider_id: "",
        bucket_start: "2026-05-21T08:30:00.000Z",
        open_value: 9950,
        high_value: 9975,
        low_value: 9950,
        close_value: 9975,
        sample_count: 2,
      });
    } finally {
      Date.now = originalDateNow;
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("provider drawdown samples exclude external manual positions", async () => {
    const originalDateNow = Date.now;
    Date.now = () => Date.UTC(2026, 4, 21, 9, 0, 0);
    try {
      const app = createApi({
        databasePath: ":memory:",
        telegramAdapter: "mock",
        seedDemoData: false,
      });
      const trade = await approveGoldBuyLimit(app);
      await reportGoldFill(app, trade);
      await sendGoldSnapshot(app, {
        shortId: trade.shortId,
        bid: 4538,
        positions: [
          {
            ticket: "247596888",
            symbol: "XAUUSD",
            type: 0,
            volume: 0.04,
            openPrice: 4540.9,
            profit: -30,
            magic: 26050901,
            isExternal: false,
            comment: `ttc:${trade.shortId}`,
          },
          {
            ticket: "manual-drawdown",
            symbol: "XAUUSD",
            type: 0,
            volume: 0.1,
            openPrice: 4540.9,
            profit: -500,
            magic: 0,
            isExternal: true,
            comment: "manual hedge",
          },
        ],
      });
      await app.request("/api/mt5/heartbeat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          accountId: "mt5-63442826",
          balance: 10000,
          equity: 9470,
          profit: -530,
          availableSymbols: ["XAUUSD"],
        }),
      });

      const dashboard = await json<{
        providerPerformance: Array<{
          id: string;
          averageDrawdown: number;
          copiedDrawdown: number;
        }>;
      }>(await app.request("/api/dashboard"));
      const provider = dashboard.providerPerformance[0];

      expect(provider?.averageDrawdown).toBe(30);
      expect(provider?.copiedDrawdown).toBe(30);
    } finally {
      Date.now = originalDateNow;
    }
  });

  test("account statistics endpoint returns range-scoped trading metrics", async () => {
    const originalDateNow = Date.now;
    Date.now = () => Date.UTC(2026, 4, 21, 10, 0, 0);
    try {
      const app = createApi({
        databasePath: ":memory:",
        telegramAdapter: "mock",
        seedDemoData: true,
      });

      await app.request("/api/mt5/history", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          accountId: "mt5-100200300",
          deals: [
            {
              dealTicket: "stats-win",
              orderTicket: "stats-win-order",
              positionTicket: "stats-win-position",
              entry: "1",
              type: "1",
              reason: 0,
              symbol: "XAUUSD",
              price: 4502,
              volume: 0.01,
              profit: 25,
              commission: 0,
              swap: 0,
              fee: 0,
              comment: "",
              timeMsc: Date.UTC(2026, 4, 21, 8, 0, 0),
            },
            {
              dealTicket: "stats-loss",
              orderTicket: "stats-loss-order",
              positionTicket: "stats-loss-position",
              entry: "1",
              type: "1",
              reason: 0,
              symbol: "XAUUSD",
              price: 4501,
              volume: 0.01,
              profit: -10,
              commission: 0,
              swap: 0,
              fee: 0,
              comment: "",
              timeMsc: Date.UTC(2026, 4, 21, 9, 0, 0),
            },
          ],
        }),
      });
      await app.request("/api/mt5/heartbeat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          accountId: "mt5-100200300",
          balance: 10000,
          equity: 9990,
          profit: -10,
          availableSymbols: ["XAUUSD"],
        }),
      });

      const stats = await json<{
        scope: string;
        range: string;
        profitReturn: { totalPnl: number };
        winLoss: { wins: number; losses: number; winRate: number };
        quality: { profitFactor: number; expectancy: number };
        riskDrawdown: {
          maxDrawdown: number;
          maxDrawdownPct: number;
          currentDrawdownPct: number;
          averageActiveDrawdownPct: number;
        };
      }>(await app.request("/api/accounts/mt5-100200300/stats?range=30d&scope=account"));

      expect(stats.scope).toBe("account");
      expect(stats.range).toBe("30d");
      expect(stats.profitReturn.totalPnl).toBe(15);
      expect(stats.winLoss).toMatchObject({ wins: 1, losses: 1, winRate: 0.5 });
      expect(stats.quality).toMatchObject({ profitFactor: 2.5, expectancy: 7.5 });
      expect(stats.riskDrawdown.maxDrawdown).toBe(10);
      // The new percentage fields are part of the contract; even when zero
      // they must be numbers, not undefined.
      expect(typeof stats.riskDrawdown.maxDrawdownPct).toBe("number");
      expect(typeof stats.riskDrawdown.currentDrawdownPct).toBe("number");
      expect(typeof stats.riskDrawdown.averageActiveDrawdownPct).toBe("number");
    } finally {
      Date.now = originalDateNow;
    }
  });

  test("account attribution splits provider-linked, manual external, and unknown EA P/L", async () => {
    const originalDateNow = Date.now;
    Date.now = () => Date.UTC(2026, 4, 21, 10, 0, 0);
    try {
      const app = createApi({
        databasePath: ":memory:",
        telegramAdapter: "mock",
        seedDemoData: false,
      });

      const approved = await approveGoldBuyLimit(app);
      await reportGoldFill(app, approved);
      await app.request("/api/mt5/history", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          accountId: "mt5-63442826",
          deals: [
            {
              dealTicket: "provider-manual-close",
              orderTicket: "provider-manual-order",
              positionTicket: "247596888",
              entry: "1",
              type: "1",
              reason: 0,
              symbol: "XAUUSD",
              price: 4535,
              volume: 0.04,
              profit: -20,
              commission: 0,
              swap: 0,
              fee: 0,
              comment: "",
              timeMsc: Date.UTC(2026, 4, 21, 8, 10, 0),
            },
          ],
        }),
      });
      await app.request("/api/mt5/history", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          accountId: "mt5-63442826",
          deals: [
            {
              dealTicket: "manual-open",
              orderTicket: "manual-order-open",
              positionTicket: "manual-position",
              entry: "0",
              type: "0",
              reason: 1,
              symbol: "XAUUSD",
              price: 4540,
              volume: 0.02,
              profit: 0,
              commission: 0,
              swap: 0,
              fee: 0,
              comment: "",
              timeMsc: Date.UTC(2026, 4, 21, 8, 20, 0),
            },
            {
              dealTicket: "manual-close",
              orderTicket: "manual-order-close",
              positionTicket: "manual-position",
              entry: "1",
              type: "1",
              reason: 1,
              symbol: "XAUUSD",
              price: 4530,
              volume: 0.02,
              profit: -55,
              commission: 0,
              swap: 0,
              fee: 0,
              comment: "",
              timeMsc: Date.UTC(2026, 4, 21, 8, 25, 0),
            },
            {
              dealTicket: "expert-close",
              orderTicket: "expert-order-close",
              positionTicket: "expert-position",
              entry: "1",
              type: "1",
              reason: 3,
              symbol: "XAUUSD",
              price: 4529,
              volume: 0.01,
              profit: -7.5,
              commission: 0,
              swap: 0,
              fee: 0,
              comment: "",
              timeMsc: Date.UTC(2026, 4, 21, 8, 30, 0),
            },
          ],
        }),
      });

      const attribution = await json<{
        range: string;
        totals: {
          totalPnl: number;
          providerPnl: number;
          manualExternalPnl: number;
          unknownEaPnl: number;
        };
        attributionRows: Array<{
          bucket: string;
          label: string;
          tradeCount: number;
          pnl: number;
        }>;
        sourceBreakdown: Array<{ source: string; label: string; tradeCount: number; pnl: number }>;
        topTrades: Array<{
          bucket: string;
          sourceLabel: string;
          providerTitle?: string;
          closeReason: string;
          pnl: number;
        }>;
      }>(await app.request("/api/accounts/mt5-63442826/attribution?range=30d"));

      expect(attribution.range).toBe("30d");
      expect(attribution.totals).toMatchObject({
        totalPnl: -82.5,
        providerPnl: -20,
        manualExternalPnl: -55,
        unknownEaPnl: -7.5,
      });
      expect(attribution.attributionRows).toEqual([
        { bucket: "provider", label: "Provider-linked", tradeCount: 1, pnl: -20 },
        { bucket: "manual_external", label: "Manual / external", tradeCount: 1, pnl: -55 },
        { bucket: "unknown_ea", label: "Unknown / EA", tradeCount: 1, pnl: -7.5 },
      ]);
      expect(attribution.sourceBreakdown).toEqual(
        expect.arrayContaining([
          { source: "manual-terminal", label: "Manual terminal", tradeCount: 1, pnl: -20 },
          { source: "manual-mobile", label: "Manual mobile", tradeCount: 1, pnl: -55 },
          { source: "expert", label: "Expert", tradeCount: 1, pnl: -7.5 },
        ]),
      );
      expect(attribution.topTrades[0]).toMatchObject({
        bucket: "manual_external",
        sourceLabel: "Manual mobile",
        closeReason: "Manual",
        pnl: -55,
      });
      expect(attribution.topTrades.find((trade) => trade.bucket === "provider")).toMatchObject({
        providerTitle: "Test Forex Group",
        sourceLabel: "Provider: Test Forex Group",
        closeReason: "Manual",
        pnl: -20,
      });
    } finally {
      Date.now = originalDateNow;
    }
  });

  test("account attribution range filters by close time", async () => {
    const originalDateNow = Date.now;
    Date.now = () => Date.UTC(2026, 4, 21, 10, 0, 0);
    try {
      const app = createApi({
        databasePath: ":memory:",
        telegramAdapter: "mock",
        seedDemoData: true,
      });

      await app.request("/api/mt5/history", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          accountId: "mt5-100200300",
          deals: [
            {
              dealTicket: "old-manual-close",
              orderTicket: "old-manual-order",
              positionTicket: "old-manual-position",
              entry: "1",
              type: "1",
              reason: 1,
              symbol: "XAUUSD",
              price: 4501,
              volume: 0.01,
              profit: -99,
              commission: 0,
              swap: 0,
              fee: 0,
              comment: "",
              timeMsc: Date.UTC(2026, 3, 1, 8, 0, 0),
            },
            {
              dealTicket: "today-manual-close",
              orderTicket: "today-manual-order",
              positionTicket: "today-manual-position",
              entry: "1",
              type: "1",
              reason: 1,
              symbol: "XAUUSD",
              price: 4502,
              volume: 0.01,
              profit: -5,
              commission: 0,
              swap: 0,
              fee: 0,
              comment: "",
              timeMsc: Date.UTC(2026, 4, 21, 8, 0, 0),
            },
          ],
        }),
      });

      const attribution = await json<{ totals: { totalPnl: number }; range: string }>(
        await app.request("/api/accounts/mt5-100200300/attribution?range=today"),
      );

      expect(attribution.range).toBe("today");
      expect(attribution.totals.totalPnl).toBe(-5);
    } finally {
      Date.now = originalDateNow;
    }
  });

  test("account stats accepts range=today and echoes it back", async () => {
    const app = createApi({
      databasePath: ":memory:",
      telegramAdapter: "mock",
      seedDemoData: true,
    });

    const stats = await json<{ range: string }>(
      await app.request("/api/accounts/mt5-100200300/stats?range=today&scope=account"),
    );

    expect(stats.range).toBe("today");
  });

  test("risk thresholds default to global app settings", async () => {
    const app = createApi({
      databasePath: ":memory:",
      telegramAdapter: "mock",
      seedDemoData: true,
    });

    const stats = await json<{
      riskThresholds: { warnPct: number; dangerPct: number };
    }>(await app.request("/api/accounts/mt5-100200300/stats?range=30d&scope=account"));

    expect(stats.riskThresholds).toMatchObject({ warnPct: 10, dangerPct: 20 });
  });

  test("global drawdown thresholds can be updated through app settings", async () => {
    const app = createApi({
      databasePath: ":memory:",
      telegramAdapter: "mock",
      seedDemoData: true,
    });

    await app.request("/api/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ drawdownWarnPct: 5, drawdownDangerPct: 15 }),
    });

    const stats = await json<{
      riskThresholds: { warnPct: number; dangerPct: number };
    }>(await app.request("/api/accounts/mt5-100200300/stats?range=30d&scope=account"));

    expect(stats.riskThresholds).toMatchObject({ warnPct: 5, dangerPct: 15 });
  });

  test("global drawdown thresholds keep danger at or above warn", async () => {
    const app = createApi({
      databasePath: ":memory:",
      telegramAdapter: "mock",
      seedDemoData: true,
    });

    const updated = await json<{
      settings: { drawdownWarnPct: number; drawdownDangerPct: number };
    }>(
      await app.request("/api/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ drawdownWarnPct: 25, drawdownDangerPct: 10 }),
      }),
    );

    expect(updated.settings).toMatchObject({ drawdownWarnPct: 25, drawdownDangerPct: 25 });
  });

  test("PATCH /api/accounts/:id/risk-thresholds overrides globals for that account only", async () => {
    const app = createApi({
      databasePath: ":memory:",
      telegramAdapter: "mock",
      seedDemoData: true,
    });

    const patched = await json<{
      warnPct: number;
      dangerPct: number;
      accountWarnPct: number | null;
      accountDangerPct: number | null;
    }>(
      await app.request("/api/accounts/mt5-100200300/risk-thresholds", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ warnPct: 3, dangerPct: 9 }),
      }),
    );

    expect(patched).toMatchObject({
      warnPct: 3,
      dangerPct: 9,
      accountWarnPct: 3,
      accountDangerPct: 9,
    });

    const stats = await json<{
      riskThresholds: { warnPct: number; dangerPct: number };
    }>(await app.request("/api/accounts/mt5-100200300/stats?range=30d&scope=account"));

    expect(stats.riskThresholds).toMatchObject({ warnPct: 3, dangerPct: 9 });

    // Clearing the override returns to the global default.
    const cleared = await json<{
      warnPct: number;
      dangerPct: number;
      accountWarnPct: number | null;
      accountDangerPct: number | null;
    }>(
      await app.request("/api/accounts/mt5-100200300/risk-thresholds", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ warnPct: null, dangerPct: null }),
      }),
    );

    expect(cleared).toMatchObject({
      warnPct: 10,
      dangerPct: 20,
      accountWarnPct: null,
      accountDangerPct: null,
    });
  });

  test("PATCH /api/accounts/:id/risk-thresholds preserves omitted overrides", async () => {
    const app = createApi({
      databasePath: ":memory:",
      telegramAdapter: "mock",
      seedDemoData: true,
    });

    await app.request("/api/accounts/mt5-100200300/risk-thresholds", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ warnPct: 3, dangerPct: 9 }),
    });

    const patched = await json<{
      warnPct: number;
      dangerPct: number;
      accountWarnPct: number | null;
      accountDangerPct: number | null;
    }>(
      await app.request("/api/accounts/mt5-100200300/risk-thresholds", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ warnPct: 5 }),
      }),
    );

    expect(patched).toMatchObject({
      warnPct: 5,
      dangerPct: 9,
      accountWarnPct: 5,
      accountDangerPct: 9,
    });
  });

  test("PATCH /api/accounts/:id/risk-thresholds keeps danger at or above warn", async () => {
    const app = createApi({
      databasePath: ":memory:",
      telegramAdapter: "mock",
      seedDemoData: true,
    });

    const patched = await json<{
      warnPct: number;
      dangerPct: number;
      accountWarnPct: number | null;
      accountDangerPct: number | null;
    }>(
      await app.request("/api/accounts/mt5-100200300/risk-thresholds", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ warnPct: 12, dangerPct: 6 }),
      }),
    );

    expect(patched).toMatchObject({
      warnPct: 12,
      dangerPct: 12,
      accountWarnPct: 12,
      accountDangerPct: 12,
    });
  });

  test("PATCH /api/accounts/:id/risk-thresholds 404s when account is unknown", async () => {
    const app = createApi({
      databasePath: ":memory:",
      telegramAdapter: "mock",
      seedDemoData: true,
    });

    const response = await app.request("/api/accounts/unknown-account/risk-thresholds", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ warnPct: 5, dangerPct: 10 }),
    });

    expect(response.status).toBe(404);
  });

  test("provider performance keeps legacy gain and adds gainPct as percent of initial balance", async () => {
    const app = createApi({
      databasePath: ":memory:",
      telegramAdapter: "mock",
      seedDemoData: true,
    });

    const performance = await json<{ providers: Array<{ gain: number; gainPct: number }> }>(
      await app.request("/api/providers/performance"),
    );

    expect(Array.isArray(performance.providers)).toBe(true);
    for (const provider of performance.providers) {
      expect(typeof provider.gain).toBe("number");
      expect(typeof provider.gainPct).toBe("number");
      expect(Number.isFinite(provider.gain)).toBe(true);
      expect(Number.isFinite(provider.gainPct)).toBe(true);
    }
  });

  test("global provider performance converts USD and ZAR accounts into reporting currency", async () => {
    const app = createApi({
      databasePath: ":memory:",
      telegramAdapter: "mock",
      seedDemoData: true,
    });

    const lease = await json<{ item: { id: string } | null }>(
      await app.request("/api/mt5/poll?accountId=mt5-100200300"),
    );
    expect(lease.item).not.toBeNull();
    await app.request("/api/mt5/report", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        queueItemId: lease.item!.id,
        accountId: "mt5-100200300",
        status: "EXECUTED",
        retcode: 10009,
        retcodeExternal: 0,
        brokerComment: "ttc:demo-1",
        orderTicket: "currency-order-open",
        positionTicket: "currency-position-1",
        dealTicket: "currency-deal-open",
        requestedPrice: 1.085,
        filledPrice: 1.085,
        volume: 0.1,
      }),
    });
    await app.request("/api/mt5/report", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        queueItemId: lease.item!.id,
        accountId: "mt5-100200300",
        status: "EXECUTED",
        retcode: 10009,
        retcodeExternal: 0,
        brokerComment: "ttc:demo-1:tp1",
        orderTicket: "currency-order-close",
        positionTicket: "currency-position-1",
        dealTicket: "currency-deal-close",
        requestedPrice: 1.09,
        filledPrice: 1.09,
        volume: 0.03,
      }),
    });
    await app.request("/api/mt5/history", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        accountId: "mt5-100200300",
        deals: [
          {
            dealTicket: "currency-deal-close",
            orderTicket: "currency-order-close",
            positionTicket: "currency-position-1",
            entry: "1",
            type: "1",
            reason: 5,
            symbol: "EURUSD.raw",
            price: 1.09,
            volume: 0.03,
            profit: 20,
            commission: -0.25,
            swap: 0,
            fee: -0.05,
            comment: "ttc:demo-1:tp1",
            timeMsc: Date.UTC(2026, 4, 18, 10, 42, 14),
          },
        ],
      }),
    });
    await app.request("/api/mt5/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        accountNumber: "54870107",
        server: "HFMarketsSA-Live",
        company: "HF Markets SA",
        currency: "ZAR",
        balance: 160000,
        equity: 160000,
        marginMode: "HEDGING",
        availableSymbols: ["XAUUSD"],
      }),
    });

    const dashboard = await json<{
      providerPerformance: Array<{
        id: string;
        currency: string;
        pnl: number;
        gainPct: number;
      }>;
    }>(await app.request("/api/dashboard"));
    const provider = dashboard.providerPerformance.find((row) => row.id === "provider-alpha");

    expect(provider).toMatchObject({
      currency: "USD",
      pnl: 19.7,
      gainPct: 0.1,
    });
  });

  test("provider performance CSV export includes provider rows and copied drawdown columns", async () => {
    const app = createApi({
      databasePath: ":memory:",
      telegramAdapter: "mock",
      seedDemoData: true,
    });

    const response = await app.request(
      "/api/providers/performance/export.csv?accountId=mt5-100200300",
    );
    const csv = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/csv");
    expect(response.headers.get("content-disposition")).toContain("provider-performance-");
    expect(csv.split("\n")[0]).toBe(
      "title,enabled,linked_accounts,lots,pips,win_rate,avg_drawdown,p_l,profit,gain,trade_count,copied_drawdown,gain_pct",
    );
    expect(csv).toContain("Alpha FX Signals");
  });

  test("account performance and closed history include external manual history deals", async () => {
    const app = createApi({
      databasePath: ":memory:",
      telegramAdapter: "mock",
      seedDemoData: true,
    });

    const history = await json<{ recorded: number }>(
      await app.request("/api/mt5/history", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          accountId: "mt5-100200300",
          deals: [
            {
              dealTicket: "manual-open-1",
              orderTicket: "manual-order-open-1",
              positionTicket: "manual-position-1",
              entry: "0",
              type: "0",
              reason: 0,
              symbol: "XAUUSD",
              price: 4553.73,
              volume: 0.01,
              profit: 0,
              commission: 0,
              swap: 0,
              comment: "",
              time: "2026.05.20 09:00:00",
            },
            {
              dealTicket: "manual-close-1",
              orderTicket: "manual-order-close-1",
              positionTicket: "manual-position-1",
              entry: "1",
              type: "1",
              reason: 0,
              symbol: "XAUUSD",
              price: 4558.73,
              volume: 0.01,
              profit: 12.34,
              commission: -0.34,
              swap: 0.1,
              fee: -0.1,
              comment: "",
              time: "2026.05.20 09:05:00",
            },
          ],
        }),
      }),
    );
    expect(history.recorded).toBe(2);

    const perf = await json<{
      realizedPnl: number;
      floatingPnl: number;
      totalProfit: number;
    }>(await app.request("/api/account/performance"));

    expect(perf.realizedPnl).toBe(12);
    expect(perf.floatingPnl).toBe(0);
    expect(perf.totalProfit).toBe(12);

    const dashboard = await json<{
      mt5Accounts: Array<{
        id: string;
        externalCloses: Array<{
          tradeId: string;
          ticket: string;
          origin: string;
          symbol: string;
          direction: string;
          realizedPnl: number;
          netResult: string;
          closeReason: string;
        }>;
      }>;
    }>(await app.request("/api/dashboard"));
    const account = dashboard.mt5Accounts.find((item) => item.id === "mt5-100200300");
    expect(account?.externalCloses[0]).toMatchObject({
      tradeId: "external-mt5-100200300-manual-position-1",
      ticket: "manual-position-1",
      origin: "manual",
      symbol: "XAUUSD",
      direction: "BUY",
      realizedPnl: 12,
      netResult: "WIN",
      closeReason: "Manual",
    });
  });

  test("closed history includes external partial-close deal rows with realized P/L", async () => {
    const app = createApi({
      databasePath: ":memory:",
      telegramAdapter: "mock",
      seedDemoData: true,
    });

    await app.request("/api/mt5/history", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        accountId: "mt5-100200300",
        deals: [
          {
            dealTicket: "manual-partial-open-1",
            orderTicket: "manual-partial-order-open-1",
            positionTicket: "manual-partial-position-1",
            entry: "0",
            type: "1",
            reason: 2,
            symbol: "XAUUSD",
            price: 4552.15,
            volume: 0.02,
            profit: 0,
            commission: 0,
            swap: 0,
            fee: 0,
            comment: "",
            time: "2026.05.20 18:17:01",
            timeMsc: Date.parse("2026-05-20T18:17:01.000Z"),
          },
        ],
      }),
    });
    await app.request("/api/mt5/snapshot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        accountId: "mt5-100200300",
        positions: [
          {
            ticket: "manual-partial-position-1",
            symbol: "XAUUSD",
            type: 1,
            volume: 0.01,
            openPrice: 4552.15,
            profit: 18.4,
            magic: 0,
            isExternal: true,
            comment: "",
          },
        ],
        orders: [],
        symbols: [],
      }),
    });

    await app.request("/api/mt5/history", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        accountId: "mt5-100200300",
        deals: [
          {
            dealTicket: "manual-partial-close-1",
            orderTicket: "manual-partial-order-close-1",
            positionTicket: "manual-partial-position-1",
            entry: "1",
            type: "0",
            reason: 2,
            symbol: "XAUUSD",
            price: 4533.75,
            volume: 0.01,
            profit: 18.4,
            commission: 0,
            swap: 0,
            fee: 0,
            comment: "",
            time: "2026.05.20 19:57:17",
            timeMsc: Date.parse("2026-05-20T19:57:17.000Z"),
          },
        ],
      }),
    });

    const dashboard = await json<{
      mt5Accounts: Array<{
        id: string;
        externalCloses: Array<{
          tradeId: string;
          ticket: string;
          volume: number;
          openPrice: number;
          closePrice: number;
          realizedPnl: number;
          closedAt: string;
          legs: Array<{
            action: string;
            dealTicket: string;
            positionTicket: string;
            pnl: number;
            volume: number;
          }>;
        }>;
      }>;
    }>(await app.request("/api/dashboard"));
    const account = dashboard.mt5Accounts.find((item) => item.id === "mt5-100200300");
    const partial = account?.externalCloses.find(
      (item) =>
        item.tradeId === "external-mt5-100200300-manual-partial-position-1-manual-partial-close-1",
    );

    expect(partial).toMatchObject({
      ticket: "manual-partial-position-1",
      volume: 0.01,
      openPrice: 4552.15,
      closePrice: 4533.75,
      realizedPnl: 18.4,
      closedAt: "2026-05-20T19:57:17.000Z",
      legs: [
        {
          action: "PARTIAL_CLOSE",
          dealTicket: "manual-partial-close-1",
          positionTicket: "manual-partial-position-1",
          pnl: 18.4,
          volume: 0.01,
        },
      ],
    });
  });

  test("account performance Today uses the MT5 deal calendar day from DEAL_TIME_MSC", async () => {
    const originalDateNow = Date.now;
    Date.now = () => Date.UTC(2026, 4, 20, 10, 0, 0);
    try {
      const app = createApi({
        databasePath: ":memory:",
        telegramAdapter: "mock",
        seedDemoData: true,
      });

      await app.request("/api/mt5/history", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          accountId: "mt5-100200300",
          deals: [
            {
              dealTicket: "manual-yesterday-close",
              orderTicket: "manual-yesterday-order",
              positionTicket: "manual-yesterday-position",
              entry: "1",
              type: "1",
              reason: 0,
              symbol: "XAUUSD",
              price: 4501,
              volume: 0.01,
              profit: 7,
              commission: 0,
              swap: 0,
              fee: 0,
              comment: "",
              timeMsc: Date.UTC(2026, 4, 19, 23, 30, 0),
            },
            {
              dealTicket: "manual-today-close",
              orderTicket: "manual-today-order",
              positionTicket: "manual-today-position",
              entry: "1",
              type: "1",
              reason: 0,
              symbol: "XAUUSD",
              price: 4502,
              volume: 0.01,
              profit: 5,
              commission: 0,
              swap: 0,
              fee: 0,
              comment: "",
              timeMsc: Date.UTC(2026, 4, 20, 0, 5, 0),
            },
          ],
        }),
      });

      const perf = await json<{ realizedPnl: number; today: number; thisWeek: number }>(
        await app.request("/api/account/performance"),
      );

      expect(perf.realizedPnl).toBe(12);
      expect(perf.today).toBe(5);
      expect(perf.thisWeek).toBe(12);
    } finally {
      Date.now = originalDateNow;
    }
  });

  test("account performance blanks live KPIs when MT5 heartbeat is stale", async () => {
    const originalDateNow = Date.now;
    Date.now = () => Date.UTC(2026, 4, 20, 10, 0, 0);
    const tempDir = await mkdtemp(join(tmpdir(), "telegram-tc-"));
    const databasePath = join(tempDir, "app.db");
    try {
      const app = createApi({
        databasePath,
        telegramAdapter: "mock",
        seedDemoData: false,
      });
      await app.request("/api/mt5/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          accountNumber: "100200300",
          server: "MetaQuotes-Demo",
          company: "MetaQuotes",
          currency: "USD",
          balance: 100,
          equity: 112,
          profit: 12,
          marginMode: "HEDGING",
          availableSymbols: ["XAUUSD"],
        }),
      });
      await app.request("/api/mt5/history", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          accountId: "mt5-100200300",
          deals: [
            {
              dealTicket: "manual-stale-close",
              orderTicket: "manual-stale-order",
              positionTicket: "manual-stale-position",
              entry: "1",
              type: "1",
              reason: 0,
              symbol: "XAUUSD",
              price: 4502,
              volume: 0.01,
              profit: -57.89,
              commission: 0,
              swap: 0,
              fee: 0,
              comment: "",
              timeMsc: Date.UTC(2026, 4, 20, 8, 0, 0),
            },
          ],
        }),
      });
      const db = new Database(databasePath);
      db.query("UPDATE mt5_accounts SET last_heartbeat_at = ? WHERE id = ?").run(
        "2026-05-20T09:59:00.000Z",
        "mt5-100200300",
      );
      db.close();

      const perf = await json<{
        currentBalance: number | null;
        currentEquity: number | null;
        currentProfit: number | null;
        totalProfit: number | null;
        realizedPnl: number;
        floatingPnl: number | null;
        today: number | null;
        thisWeek: number | null;
        thisMonth: number | null;
        heartbeatStatus: string;
      }>(await app.request("/api/account/performance"));

      expect(perf.heartbeatStatus).toBe("offline");
      expect(perf.realizedPnl).toBe(-57.89);
      expect(perf.currentBalance).toBeNull();
      expect(perf.currentEquity).toBeNull();
      expect(perf.currentProfit).toBeNull();
      expect(perf.floatingPnl).toBeNull();
      expect(perf.totalProfit).toBeNull();
      expect(perf.today).toBe(-57.89);
      expect(perf.thisWeek).toBe(-57.89);
      expect(perf.thisMonth).toBe(-57.89);
    } finally {
      Date.now = originalDateNow;
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("active-plans endpoint returns line-format diagnostics for app-managed virtual TP plans", async () => {
    const app = createApi({
      databasePath: ":memory:",
      telegramAdapter: "mock",
      seedDemoData: false,
    });
    // No plans yet should produce planCount=0.
    const empty = await (await app.request("/api/mt5/active-plans?accountId=mt5-100200300")).text();
    expect(empty).toContain("planCount=0");

    // Missing accountId returns 400.
    const bad = await app.request("/api/mt5/active-plans");
    expect(bad.status).toBe(400);

    // With seeded demo data we should get at least one plan block with the
    // structured plan=begin / plan=end markers and key=value lines.
    const seeded = createApi({
      databasePath: ":memory:",
      telegramAdapter: "mock",
      seedDemoData: true,
    });
    await seeded.request("/api/mt5/report", {
      method: "POST",
      body: JSON.stringify({
        accountId: "mt5-100200300",
        queueItemId: "queue-demo-1",
        status: "EXECUTED",
        retcode: 10009,
        retcodeExternal: 0,
        brokerComment: "Request executed",
        orderTicket: "50001",
        positionTicket: "70001",
        dealTicket: "60001",
        requestedPrice: 1.085,
        filledPrice: 1.0851,
        volume: 0.1,
        errorText: "",
      }),
      headers: { "content-type": "application/json" },
    });
    const text = await (
      await seeded.request("/api/mt5/active-plans?accountId=mt5-100200300")
    ).text();
    expect(text).toContain("plan=begin");
    expect(text).toContain("plan=end");
    expect(text).toContain("logicalTradeId=");
    expect(text).toMatch(/tp\dPrice=/);

    await seeded.request("/api/mt5/snapshot", {
      method: "POST",
      body: JSON.stringify({
        accountId: "mt5-100200300",
        positions: [],
        orders: [],
        symbols: [],
      }),
      headers: { "content-type": "application/json" },
    });
    const outOfSync = await (
      await seeded.request("/api/mt5/active-plans?accountId=mt5-100200300")
    ).text();
    expect(outOfSync).toContain("planCount=0");
  });

  test("links dropped lifecycle commands to held items and returns the flat warning payload", async () => {
    const messages: TelegramCapturedMessage[] = [
      {
        telegramMessageId: "held-open-1",
        messageDate: "2026-07-11T08:00:00.000Z",
        rawText: "BUY XAUUSD @ 4541\nSL 4535\nTP1 4546",
      },
    ];
    const app = createApi({
      databasePath: ":memory:",
      seedDemoData: false,
      telegram: createQueuedTelegramAdapter(messages),
      telegramPollingEnabled: false,
    });
    const providerId = await configureProviderWithAccount(app, { availableSymbols: ["XAUUSD"] });
    await app.request("/api/settings", {
      method: "PATCH",
      body: JSON.stringify({ maxOpenTradeAgeSeconds: 1800 }),
      headers: { "content-type": "application/json" },
    });
    await app.runTelegramIngestionOnce();
    const openQueue = await json<{ queue: Array<{ id: string; status: string }> }>(
      await app.request("/api/signals"),
    );
    const openItem = openQueue.queue.find((item) => item.status === "HELD");
    expect(openItem).toBeDefined();

    messages.push({
      telegramMessageId: "held-lifecycle-1",
      messageDate: "2026-07-11T08:01:00.000Z",
      rawText: "Trail stop XAUUSD by 50 pips",
    });
    const ingest = await app.runTelegramIngestionOnce();
    expect(ingest.errors).toBe(0);

    const held = await json<{
      items: Array<{
        id: string;
        heldReason: string;
        accountId: string;
        providerId: string;
        commandType: string;
        symbol: string;
        originalEntry?: number;
        currentPrice?: number;
        driftPct?: number;
        droppedLifecycleCount: number;
        droppedLifecycle: string[];
        providerTitle?: string;
      }>;
    }>(await app.request("/api/queue-items/held"));
    const item = held.items.find((candidate) => candidate.id === openItem?.id);
    expect(item).toMatchObject({
      heldReason: "EXPIRED_LATE",
      accountId: "mt5-63442826",
      providerId,
      commandType: "OPEN_TRADE",
      symbol: "XAUUSD",
      originalEntry: 4541,
      droppedLifecycleCount: 0,
      droppedLifecycle: [],
    });
    expect(item).not.toHaveProperty("signalSummary");
    expect(item).not.toHaveProperty("provider");
    expect(item).not.toHaveProperty("account");

    const requeued = await app.request(`/api/queue-items/${openItem?.id}/requeue`, {
      method: "POST",
      body: JSON.stringify({ mode: "market" }),
      headers: { "content-type": "application/json" },
    });
    expect(requeued.status).toBe(409);
    expect(await requeued.json()).toMatchObject({
      error: expect.stringContaining("no unbound command was queued"),
    });
  });

  test("resolves OUT_OF_SYNC trades by readopting, closing from history, or archiving", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "telegram-tc-resolve-"));
    const databasePath = join(tempDir, "app.db");
    try {
      const app = createApi({
        databasePath,
        seedDemoData: false,
        telegramAdapter: "mock",
        telegramPollingEnabled: false,
      });
      const approved = await approveGoldBuyLimit(app);
      await reportPendingAccepted(app, approved);
      await reportGoldFill(app, approved);
      await sendGoldSnapshot(app, { shortId: approved.shortId, bid: 4541 });
      const setOutOfSync = () => {
        const db = new Database(databasePath);
        const row = db
          .query("SELECT data_json FROM logical_trades WHERE id = ?")
          .get(approved.logicalTradeId) as { data_json: string };
        const trade = {
          ...JSON.parse(row.data_json),
          status: "OUT_OF_SYNC",
          livePositionExists: false,
        };
        db.query("UPDATE logical_trades SET status = ?, data_json = ? WHERE id = ?").run(
          "OUT_OF_SYNC",
          JSON.stringify(trade),
          approved.logicalTradeId,
        );
        db.close();
      };

      setOutOfSync();
      const outOfSync = await json<{
        logicalTrades: Array<{ id: string; status: string; matchedBrokerTickets: string[] }>;
      }>(await app.request("/api/dashboard"));
      expect(
        outOfSync.logicalTrades.find((trade) => trade.id === approved.logicalTradeId),
      ).toMatchObject({
        status: "OUT_OF_SYNC",
        matchedBrokerTickets: ["247596888"],
      });

      const readopt = await json<{ status: string; matchedBrokerTickets: string[] }>(
        await app.request(`/api/trades/${approved.logicalTradeId}/resolve`, {
          method: "POST",
          body: JSON.stringify({ action: "readopt" }),
          headers: { "content-type": "application/json" },
        }),
      );
      expect(readopt).toMatchObject({ status: "OPEN", matchedBrokerTickets: ["247596888"] });

      await app.request("/api/mt5/snapshot", {
        method: "POST",
        body: JSON.stringify({ accountId: "mt5-63442826", positions: [], orders: [], symbols: [] }),
        headers: { "content-type": "application/json" },
      });
      await app.request("/api/mt5/history", {
        method: "POST",
        body: JSON.stringify({
          accountId: "mt5-63442826",
          deals: [
            {
              dealTicket: "history-close-1",
              orderTicket: "247596888",
              positionTicket: "247596888",
              entry: "1",
              reason: 0,
              symbol: "XAUUSD",
              price: 4530,
              volume: 0.04,
              profit: -44,
              comment: `ttc:${approved.shortId}`,
              time: "2026.07.11 08:10:00",
            },
          ],
        }),
        headers: { "content-type": "application/json" },
      });
      setOutOfSync();
      const closeFromHistory = await json<{ status: string }>(
        await app.request(`/api/trades/${approved.logicalTradeId}/resolve`, {
          method: "POST",
          body: JSON.stringify({ action: "close_from_history" }),
          headers: { "content-type": "application/json" },
        }),
      );
      expect(closeFromHistory.status).toBe("CLOSED");

      setOutOfSync();
      const archive = await json<{ status: string }>(
        await app.request(`/api/trades/${approved.logicalTradeId}/resolve`, {
          method: "POST",
          body: JSON.stringify({ action: "archive" }),
          headers: { "content-type": "application/json" },
        }),
      );
      expect(archive.status).toBe("ARCHIVED");
      const archivedDashboard = await json<{
        logicalTrades: Array<{ id: string; status: string; matchedBrokerTickets: string[] }>;
      }>(await app.request("/api/dashboard"));
      expect(
        archivedDashboard.logicalTrades.find((trade) => trade.id === approved.logicalTradeId),
      ).toMatchObject({
        status: "ARCHIVED",
        matchedBrokerTickets: [],
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("retires plain close and modify commands on retcode-zero missing-position reports", async () => {
    for (const rawText of ["Close XAUUSD", "XAUUSD update SL 4536"]) {
      const app = createApi({ databasePath: ":memory:", seedDemoData: false });
      const approved = await approveGoldBuyLimit(app);
      await reportPendingAccepted(app, approved);
      await reportGoldFill(app, approved);
      const providers = await json<{ providers: Array<{ id: string }> }>(
        await app.request("/api/providers"),
      );
      const parsed = await json<{ parsedSignalId: string }>(
        await app.request("/api/parser/parse", {
          method: "POST",
          body: JSON.stringify({
            providerId: providers.providers[0]!.id,
            accountId: "mt5-63442826",
            rawText,
          }),
          headers: { "content-type": "application/json" },
        }),
      );
      const signals = await json<{
        signals: Array<{ id: string; result: { commandType: string } }>;
      }>(await app.request("/api/signals"));
      const parsedSignal = signals.signals.find((signal) => signal.id === parsed.parsedSignalId);
      expect(parsedSignal?.result.commandType).toBe(
        rawText.startsWith("Close") ? "CLOSE_TRADE" : "MODIFY_SL",
      );
      const approval = await app.request(`/api/signals/${parsed.parsedSignalId}/approve`, {
        method: "POST",
      });
      expect(approval.status).toBe(200);
      const queueItem = await json<{ item: { id: string } | null }>(
        await app.request("/api/mt5/poll?accountId=mt5-63442826"),
      );
      expect(queueItem.item).toBeTruthy();
      await app.request("/api/mt5/report", {
        method: "POST",
        body: JSON.stringify({
          accountId: "mt5-63442826",
          queueItemId: queueItem.item!.id,
          status: "FAILED",
          retcode: 0,
          retcodeExternal: 0,
          brokerComment: "No matching position found",
          errorText: "No matching position found",
        }),
        headers: { "content-type": "application/json" },
      });
      const noSecondAttempt = await app.request("/api/mt5/poll?accountId=mt5-63442826");
      expect((await json<{ item: unknown }>(noSecondAttempt)).item).toBeNull();
    }
  });

  test("sends each configured alert event once, respects toggles, and audits delivery failures", async () => {
    const previousFetch = globalThis.fetch;
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
      return Response.json({ ok: true });
    }) as typeof fetch;
    const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
    const register = async (app: ReturnType<typeof createApi>, accountNumber: string) => {
      await app.request("/api/mt5/register", {
        method: "POST",
        body: JSON.stringify({
          accountNumber,
          server: "MetaQuotes-Demo",
          company: "MetaQuotes",
          currency: "USD",
          balance: 10000,
          equity: 10000,
          marginMode: "HEDGING",
          availableSymbols: ["XAUUSD"],
        }),
        headers: { "content-type": "application/json" },
      });
      return `mt5-${accountNumber}`;
    };
    try {
      const guardian = createApi({ databasePath: ":memory:", seedDemoData: false });
      const guardianAccount = await register(guardian, "9001");
      await guardian.request("/api/settings", {
        method: "PATCH",
        body: JSON.stringify({
          alertBotToken: "bot-token",
          alertChatId: "chat-1",
          alertOnGuardianPause: true,
          alertOnHeld: true,
          alertOnEaOffline: true,
        }),
        headers: { "content-type": "application/json" },
      });
      await guardian.request(`/api/equity-guardian/${guardianAccount}`, {
        method: "PATCH",
        body: JSON.stringify({ paused: true }),
        headers: { "content-type": "application/json" },
      });
      await settle();
      expect(calls).toHaveLength(1);
      expect(calls[0]?.body).toMatchObject({ chat_id: "chat-1" });
      await guardian.request(`/api/equity-guardian/${guardianAccount}`, {
        method: "PATCH",
        body: JSON.stringify({ paused: true }),
        headers: { "content-type": "application/json" },
      });
      await settle();
      expect(calls).toHaveLength(1);

      await guardian.request("/api/signals/manual", {
        method: "POST",
        body: JSON.stringify({
          accountId: guardianAccount,
          direction: "BUY",
          orderType: "MARKET",
          brokerSymbol: "XAUUSD",
          stopLoss: 4535,
          takeProfits: [{ price: 4546 }],
          volume: 0.01,
        }),
        headers: { "content-type": "application/json" },
      });
      await guardian.request(`/api/mt5/poll?accountId=${guardianAccount}`);
      await settle();
      expect(calls).toHaveLength(3);
      expect(String(calls[1]?.body.text)).toContain("rejected OPEN_TRADE");
      expect(String(calls[2]?.body.text)).toContain("held queue item");

      const offlineDir = await mkdtemp(join(tmpdir(), "telegram-tc-alert-"));
      const offlinePath = join(offlineDir, "app.db");
      const offlineFile = createApi({ databasePath: offlinePath, seedDemoData: false });
      const offlineFileAccount = await register(offlineFile, "9003");
      await offlineFile.request("/api/settings", {
        method: "PATCH",
        body: JSON.stringify({
          alertBotToken: "bot-token",
          alertChatId: "chat-1",
          alertOnEaOffline: true,
        }),
        headers: { "content-type": "application/json" },
      });
      const offlineFileDb = new Database(offlinePath);
      offlineFileDb
        .query("UPDATE mt5_accounts SET last_heartbeat_at = ? WHERE id = ?")
        .run(new Date(Date.now() - 20_000).toISOString(), offlineFileAccount);
      offlineFileDb.close();
      await offlineFile.request("/api/dashboard");
      await settle();
      expect(String(calls.at(-1)?.body.text)).toContain("EA offline");
      await rm(offlineDir, { recursive: true, force: true });

      const failed = createApi({ databasePath: ":memory:", seedDemoData: false });
      await failed.request("/api/settings", {
        method: "PATCH",
        body: JSON.stringify({
          alertBotToken: "bot-token",
          alertChatId: "chat-1",
          alertOnExecFailed: true,
        }),
        headers: { "content-type": "application/json" },
      });
      await approveGoldBuyLimit(failed);
      const failedLease = await json<{ item: { id: string } | null }>(
        await failed.request("/api/mt5/poll?accountId=mt5-63442826"),
      );
      await failed.request("/api/mt5/report", {
        method: "POST",
        body: JSON.stringify({
          accountId: "mt5-63442826",
          queueItemId: failedLease.item!.id,
          status: "FAILED",
          retcode: 10016,
          retcodeExternal: 0,
          brokerComment: "Invalid stops",
          errorText: "Invalid stops",
        }),
        headers: { "content-type": "application/json" },
      });
      await settle();
      expect(String(calls.at(-1)?.body.text)).toContain("MT5 execution failed");

      const stalledTelegram: TelegramAdapter = {
        ...createQueuedTelegramAdapter([]),
        sessionHealth: (sessionId) => ({
          sessionId,
          connected: false,
          stalled: true,
          stalledSeconds: 181,
        }),
      };
      const stalled = createApi({
        databasePath: ":memory:",
        seedDemoData: false,
        telegram: stalledTelegram,
        telegramPollingEnabled: false,
      });
      await configureProviderWithAccount(stalled, { availableSymbols: ["XAUUSD"] });
      await stalled.request("/api/settings", {
        method: "PATCH",
        body: JSON.stringify({
          alertBotToken: "bot-token",
          alertChatId: "chat-1",
          alertOnTelegramStall: true,
        }),
        headers: { "content-type": "application/json" },
      });
      await stalled.runTelegramIngestionOnce();
      await settle();
      expect(String(calls.at(-1)?.body.text)).toContain("ingestion stalled");

      const disabled = createApi({ databasePath: ":memory:", seedDemoData: false });
      const disabledAccount = await register(disabled, "9004");
      await disabled.request("/api/settings", {
        method: "PATCH",
        body: JSON.stringify({
          alertBotToken: "bot-token",
          alertChatId: "chat-1",
          alertOnHeld: false,
        }),
        headers: { "content-type": "application/json" },
      });
      await disabled.request(`/api/equity-guardian/${disabledAccount}`, {
        method: "PATCH",
        body: JSON.stringify({ paused: true }),
        headers: { "content-type": "application/json" },
      });
      await disabled.request("/api/signals/manual", {
        method: "POST",
        body: JSON.stringify({
          accountId: disabledAccount,
          direction: "BUY",
          orderType: "MARKET",
          brokerSymbol: "XAUUSD",
          stopLoss: 4535,
          takeProfits: [{ price: 4546 }],
          volume: 0.01,
        }),
        headers: { "content-type": "application/json" },
      });
      await disabled.request(`/api/mt5/poll?accountId=${disabledAccount}`);
      await settle();
      const beforeMissing = calls.length;
      const missing = createApi({ databasePath: ":memory:", seedDemoData: false });
      const missingAccount = await register(missing, "9005");
      await missing.request("/api/settings", {
        method: "PATCH",
        body: JSON.stringify({ alertChatId: "chat-1", alertOnHeld: true }),
        headers: { "content-type": "application/json" },
      });
      await missing.request(`/api/equity-guardian/${missingAccount}`, {
        method: "PATCH",
        body: JSON.stringify({ paused: true }),
        headers: { "content-type": "application/json" },
      });
      await missing.request("/api/signals/manual", {
        method: "POST",
        body: JSON.stringify({
          accountId: missingAccount,
          direction: "BUY",
          orderType: "MARKET",
          brokerSymbol: "XAUUSD",
          stopLoss: 4535,
          takeProfits: [{ price: 4546 }],
          volume: 0.01,
        }),
        headers: { "content-type": "application/json" },
      });
      await missing.request(`/api/mt5/poll?accountId=${missingAccount}`);
      await settle();
      expect(calls.length).toBe(beforeMissing);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  test("sends alert-test, creates intact backups, and prunes to the newest 14", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "telegram-tc-backup-"));
    const databasePath = join(tempDir, "app.db");
    try {
      const app = createApi({ databasePath, seedDemoData: false, telegramPollingEnabled: false });
      const missing = await app.request("/api/admin/alert-test", { method: "POST" });
      expect(missing.status).toBe(400);
      await app.request("/api/settings", {
        method: "PATCH",
        body: JSON.stringify({ alertBotToken: "bot-token", alertChatId: "chat-1" }),
        headers: { "content-type": "application/json" },
      });
      const previousFetch = globalThis.fetch;
      globalThis.fetch = (async () => Response.json({ ok: true })) as unknown as typeof fetch;
      const alertTest = await app.request("/api/admin/alert-test", { method: "POST" });
      expect(alertTest.status).toBe(200);
      globalThis.fetch = previousFetch;

      const backupDir = join(tempDir, "backups");
      Bun.spawnSync(["mkdir", "-p", backupDir]);
      await Bun.write(join(backupDir, "telegram-tc-20260701000000Z.db"), "old");
      for (let index = 1; index <= 14; index += 1) {
        await Bun.write(
          join(backupDir, `telegram-tc-20260702${String(index).padStart(2, "0")}0000Z.db`),
          "old",
        );
      }
      const created = await json<{ filename: string }>(
        await app.request("/api/admin/backup", { method: "POST" }),
      );
      expect(created.filename).toMatch(/^telegram-tc-\d{8}T\d{6}Z\.db$/);
      const live = new Database(databasePath);
      const backup = new Database(join(backupDir, created.filename));
      const liveTables = Number(
        (
          live.query("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table'").get() as {
            count: number;
          }
        ).count,
      );
      const backupTables = Number(
        (
          backup
            .query("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table'")
            .get() as {
            count: number;
          }
        ).count,
      );
      expect(backupTables).toBe(liveTables);
      backup.close();
      live.close();
      const backups = await json<{ backups: string[] }>(await app.request("/api/admin/backups"));
      expect(backups.backups).toHaveLength(14);
      expect(backups.backups).toContain(created.filename);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("projects ParseLab diagnostics, trade fields, lifecycle state, and execution detail", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: true });
    await app.request("/api/mt5/report", {
      method: "POST",
      body: JSON.stringify({
        accountId: "mt5-100200300",
        queueItemId: "queue-demo-1",
        status: "FAILED",
        retcode: 10016,
        retcodeExternal: 4756,
        brokerComment: "Invalid stops",
        orderTicket: "order-1",
        positionTicket: "position-1",
        dealTicket: "deal-1",
        requestedPrice: 1.085,
        filledPrice: 1.0849,
        volume: 0.1,
        errorText: "Stops are too close",
      }),
      headers: { "content-type": "application/json" },
    });

    const dashboard = await json<{
      parserResults: Array<Record<string, unknown>>;
      executionLogs: Array<Record<string, unknown>>;
    }>(await app.request("/api/dashboard"));

    expect(dashboard.parserResults[0]).toMatchObject({
      direction: "BUY",
      orderType: "MARKET",
      entry: { from: 1.085 },
      stopLoss: 1.081,
      status: "PARSED",
      rawSymbol: "EURUSD",
      canonicalSymbol: "EURUSD",
      brokerSymbol: "EURUSD.raw",
      mappingStatus: "mapped",
      mappingSource: "broker_variant",
    });
    expect(dashboard.parserResults[0]?.matchedPatternIds).toBeInstanceOf(Array);
    expect(dashboard.parserResults[0]?.missingFields).toBeInstanceOf(Array);
    expect(dashboard.executionLogs[0]).toMatchObject({
      retcodeExternal: 4756,
      errorText: "Stops are too close",
      orderTicket: "order-1",
      positionTicket: "position-1",
      dealTicket: "deal-1",
      requestedPrice: 1.085,
      filledPrice: 1.0849,
      volume: 0.1,
    });
  });

  test("projects a corrected manual signal with its actual account, provider, and execution mode", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: true });
    const pushed = await json<{ parsedSignalId: string }>(
      await app.request("/api/signals/manual", {
        method: "POST",
        body: JSON.stringify({
          accountId: "mt5-100200300",
          providerId: "provider-alpha",
          rawText: "SELL XAUUSD STOP @ 3360",
          brokerSymbol: "XAUUSD.raw",
          canonicalSymbol: "XAUUSD",
          direction: "SELL",
          orderType: "STOP",
          entry: { from: 3360 },
          stopLoss: 3370,
          takeProfits: [{ price: 3345 }],
          volume: 0.2,
          executionMode: "SPLIT_ORDER",
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    const dashboard = await json<{
      parserResults: Array<{
        id: string;
        accountId?: string;
        providerId?: string;
        executionMode?: string;
        mappingSource?: string;
      }>;
    }>(await app.request("/api/dashboard"));

    expect(
      dashboard.parserResults.find((signal) => signal.id === pushed.parsedSignalId),
    ).toMatchObject({
      accountId: "mt5-100200300",
      providerId: "provider-alpha",
      executionMode: "SPLIT_ORDER",
      mappingSource: "manual",
    });
  });

  test("keeps ParseLab status aligned after held requeue or dismissal", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: false });
    const providerId = await configureProviderWithAccount(app, { availableSymbols: ["XAUUSD"] });
    await app.request(`/api/account-provider-links/mt5-63442826/${providerId}`, {
      method: "PUT",
      body: JSON.stringify({ enabled: false }),
      headers: { "content-type": "application/json" },
    });
    const parseHeld = async (rawText: string) =>
      json<{ parsedSignalId: string }>(
        await app.request("/api/parser/parse", {
          method: "POST",
          body: JSON.stringify({ providerId, accountId: "mt5-63442826", rawText }),
          headers: { "content-type": "application/json" },
        }),
      );

    const requeuedSignal = await parseHeld("BUY XAUUSD @ 4500\nSL 4490\nTP 4520");
    const heldForRequeue = await json<{ queueItemId: string }>(
      await app.request(`/api/signals/${requeuedSignal.parsedSignalId}/approve`, {
        method: "POST",
      }),
    );
    expect(
      await app.request(`/api/queue-items/${heldForRequeue.queueItemId}/requeue`, {
        method: "POST",
        body: JSON.stringify({ mode: "original" }),
        headers: { "content-type": "application/json" },
      }),
    ).toHaveProperty("status", 409);

    const dismissedSignal = await parseHeld("SELL XAUUSD @ 4510\nSL 4520\nTP 4490");
    const heldForDismiss = await json<{ queueItemId: string }>(
      await app.request(`/api/signals/${dismissedSignal.parsedSignalId}/approve`, {
        method: "POST",
      }),
    );
    expect(
      await app.request(`/api/queue-items/${heldForDismiss.queueItemId}/dismiss`, {
        method: "POST",
      }),
    ).toHaveProperty("status", 200);

    const dashboard = await json<{ parserResults: Array<{ id: string; status: string }> }>(
      await app.request("/api/dashboard"),
    );
    expect(
      dashboard.parserResults.find((signal) => signal.id === requeuedSignal.parsedSignalId)?.status,
    ).toBe("HELD");
    expect(
      dashboard.parserResults.find((signal) => signal.id === dismissedSignal.parsedSignalId)
        ?.status,
    ).toBe("DISMISSED");
  });

  test("refuses ignore after approval so it cannot overwrite queued signal state", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: true });
    const parsed = await json<{ parsedSignalId: string }>(
      await app.request("/api/parser/parse", {
        method: "POST",
        body: JSON.stringify({
          providerId: "provider-alpha",
          accountId: "mt5-100200300",
          rawText: "BUY EURUSD @ 1.0865\nSL 1.081\nTP 1.09",
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(
      await app.request(`/api/signals/${parsed.parsedSignalId}/approve`, { method: "POST" }),
    ).toHaveProperty("status", 200);
    const ignored = await app.request(`/api/signals/${parsed.parsedSignalId}/ignore`, {
      method: "POST",
    });
    expect(ignored.status).toBe(409);
    const dashboard = await json<{ parserResults: Array<{ id: string; status: string }> }>(
      await app.request("/api/dashboard"),
    );
    expect(
      dashboard.parserResults.find((signal) => signal.id === parsed.parsedSignalId)?.status,
    ).toBe("APPROVED");
  });

  test("parses newest local backlog first for Parse recent while automated ingestion stays oldest-first", async () => {
    const messages: TelegramCapturedMessage[] = [
      {
        telegramMessageId: "order-old",
        messageDate: "2026-07-14T08:00:00.000Z",
        rawText: "BUY EURUSD",
      },
      {
        telegramMessageId: "order-mid",
        messageDate: "2026-07-14T08:01:00.000Z",
        rawText: "SELL EURUSD",
      },
      {
        telegramMessageId: "order-new",
        messageDate: "2026-07-14T08:02:00.000Z",
        rawText: "BUY XAUUSD",
      },
    ];
    const operator = createApi({
      databasePath: ":memory:",
      seedDemoData: false,
      telegram: createQueuedTelegramAdapter(messages),
      telegramPollingEnabled: false,
    });
    const operatorProviderId = await configureProviderWithAccount(operator, {
      availableSymbols: ["EURUSD", "XAUUSD"],
    });
    const recent = await json<{ parsed: Array<{ result: { originalText: string } }> }>(
      await operator.request(`/api/providers/${operatorProviderId}/parse-recent?limit=1`, {
        method: "POST",
      }),
    );
    expect(recent.parsed[0]?.result.originalText).toBe("BUY XAUUSD");

    const automated = createApi({
      databasePath: ":memory:",
      seedDemoData: false,
      telegram: createQueuedTelegramAdapter([
        {
          telegramMessageId: "automated-old",
          messageDate: "2026-07-14T08:00:00.000Z",
          rawText: "SELL BTCUSD @ 50000\nSL 50100\nTP 49800",
        },
        {
          telegramMessageId: "automated-new",
          messageDate: "2026-07-14T08:01:00.000Z",
          replyToMessageId: "automated-old",
          rawText: "Trail stop BTCUSD by 50 pips",
        },
      ]),
      telegramPollingEnabled: false,
    });
    await configureProviderWithAccount(automated, { availableSymbols: ["BTCUSD"] });
    expect(await automated.runTelegramIngestionOnce()).toMatchObject({ parsed: 2, queued: 2 });
    expect(
      await (await automated.request("/api/mt5/poll-line?accountId=mt5-63442826")).text(),
    ).toContain("commandType=OPEN_TRADE");
    expect(
      await (await automated.request("/api/mt5/poll-line?accountId=mt5-63442826")).text(),
    ).toContain("commandType=TRAILING_STOP");
  });

  test("parses local backlog even when Parse recent Telegram fetch fails", async () => {
    let failFetch = false;
    const telegram: TelegramAdapter = {
      ...createQueuedTelegramAdapter([
        {
          telegramMessageId: "backlog-1",
          messageDate: "2026-07-14T08:00:00.000Z",
          rawText: "BUY XAUUSD",
        },
      ]),
      name: "gramjs",
      async fetchRecentMessages() {
        if (failFetch) throw new Error("Telegram unavailable");
        return {
          messages: [
            {
              telegramMessageId: "backlog-1",
              messageDate: "2026-07-14T08:00:00.000Z",
              rawText: "BUY XAUUSD",
            },
          ],
          gap: undefined,
        };
      },
    };
    const app = createApi({
      databasePath: ":memory:",
      seedDemoData: false,
      telegram,
      telegramPollingEnabled: false,
    });
    const providerId = await configureProviderWithAccount(app, { availableSymbols: ["XAUUSD"] });
    await app.request(`/api/providers/${providerId}/messages?limit=1`);
    failFetch = true;
    const recent = await json<{
      parsed: Array<{ result: { originalText: string } }>;
      provider: { error?: string };
    }>(await app.request(`/api/providers/${providerId}/parse-recent?limit=1`, { method: "POST" }));
    expect(recent.parsed[0]?.result.originalText).toBe("BUY XAUUSD");
    expect(recent.provider.error).toBe("Telegram unavailable");
  });
});

describe("step 3 evidence gate wiring", () => {
  test("uses real VIP Gold fixtures for open, activation suppression, and reply close", async () => {
    const app = createApi({
      databasePath: ":memory:",
      seedDemoData: false,
      telegram: createQueuedTelegramAdapter(realFixtureMessages(["487", "489", "490"])),
      telegramPollingEnabled: false,
    });
    const providerId = await configureProviderWithAccount(app, { availableSymbols: ["XAUUSD"] });
    await app.request(`/api/providers/${providerId}`, {
      method: "PATCH",
      body: JSON.stringify({ openEvidence: "structured-id" }),
      headers: { "content-type": "application/json" },
    });

    const vipIngest = await app.runTelegramIngestionOnce();
    expect(vipIngest).toMatchObject({ queued: 2 });
    const signals = await json<{
      queue: Array<{ status: string; payload: { commandType: string; providerOrderId?: string } }>;
    }>(await app.request("/api/signals"));
    expect(signals.queue).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "PENDING",
          payload: expect.objectContaining({ commandType: "OPEN_TRADE" }),
        }),
        expect.objectContaining({
          status: "PENDING",
          payload: expect.objectContaining({ commandType: "CLOSE_TRADE" }),
        }),
      ]),
    );
  });

  test("uses real KAL fixtures for prose entry, inline TP/cancel, and quoted chatter", async () => {
    const app = createApi({
      databasePath: ":memory:",
      seedDemoData: false,
      telegram: createQueuedTelegramAdapter(
        realFixtureMessages(["15329", "15343", "15509", "15514", "15228", "15230", "15231"]),
      ),
      telegramPollingEnabled: false,
    });
    const providerId = await configureProviderWithAccount(app, { availableSymbols: ["XAUUSD"] });
    await app.request(`/api/providers/${providerId}`, {
      method: "PATCH",
      body: JSON.stringify({ openEvidence: "prose-complete" }),
      headers: { "content-type": "application/json" },
    });

    const kalIngest = await app.runTelegramIngestionOnce();
    expect(kalIngest).toMatchObject({ queued: 3, reviewRequired: 2 });
    const signals = await json<{
      signals: Array<{ status: string; result: { commandType: string } }>;
      queue: Array<{ status: string; payload: { commandType: string } }>;
    }>(await app.request("/api/signals"));
    expect(signals.queue.filter((item) => item.status === "PENDING")).toHaveLength(3);
    expect(
      signals.queue.filter(
        (item) => item.status === "PENDING" && item.payload.commandType === "OPEN_TRADE",
      ),
    ).toHaveLength(3);
    expect(
      signals.signals.filter(
        (item) => item.status === "APPROVED" && item.result.commandType === "MARK_TP_HIT",
      ),
    ).toHaveLength(2);
    expect(
      signals.signals.filter(
        (item) => item.status === "IGNORED" && item.result.commandType === "NO_SIGNAL",
      ),
    ).toHaveLength(2);
  });

  test("releases a real corpus evidence-held OPEN through trade materialization", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "telegram-tc-evidence-open-release-"));
    const databasePath = join(tempDir, "app.db");
    try {
      const app = createApi({
        databasePath,
        seedDemoData: false,
        telegram: createQueuedTelegramAdapter(realFixtureMessages(["15226"])),
        telegramPollingEnabled: false,
      });
      const providerId = await configureProviderWithAccount(app, { availableSymbols: ["XAUUSD"] });
      await app.request(`/api/providers/${providerId}`, {
        method: "PATCH",
        body: JSON.stringify({
          openEvidence: "structured-id",
          riskMode: "fixed",
          riskAmount: 0.37,
        }),
        headers: { "content-type": "application/json" },
      });
      await app.runTelegramIngestionOnce();
      const held = await json<{ items: Array<{ id: string; heldReason: string }> }>(
        await app.request("/api/queue-items/held"),
      );
      const heldOpen = held.items.find(
        (item) => item.heldReason === "EVIDENCE_STRUCTURED_OPEN_EVIDENCE_REQUIRED",
      );
      expect(heldOpen).toBeDefined();
      const signals = await json<{
        queue: Array<{ id: string; payload: { volume?: number; riskPercent?: number } }>;
      }>(await app.request("/api/signals"));
      expect(signals.queue.find((item) => item.id === heldOpen?.id)?.payload).toMatchObject({
        volume: 0.37,
      });

      const released = await json<{ queueItemId: string; logicalTradeId: string }>(
        await app.request(`/api/queue-items/${heldOpen?.id}/requeue`, {
          method: "POST",
          body: JSON.stringify({ mode: "original" }),
          headers: { "content-type": "application/json" },
        }),
      );
      expect(released.logicalTradeId).toBeTruthy();
      const db = new Database(databasePath, { readonly: true });
      try {
        expect(
          db
            .query("SELECT logical_trade_id FROM trade_origins WHERE logical_trade_id = ?")
            .get(released.logicalTradeId),
        ).toBeTruthy();
        const queue = db
          .query("SELECT logical_trade_id, payload_json FROM queue_items WHERE id = ?")
          .get(released.queueItemId) as { logical_trade_id: string; payload_json: string };
        expect(queue.logical_trade_id).toBe(released.logicalTradeId);
        expect(
          db
            .query(
              "SELECT status FROM parsed_signals WHERE id = (SELECT parsed_signal_id FROM queue_items WHERE id = ?)",
            )
            .get(released.queueItemId),
        ).toEqual({ status: "APPROVED" });
      } finally {
        db.close();
      }
      await reportPendingAccepted(app, { queueItemId: released.queueItemId });
      expect(
        (
          await json<{ logicalTrades: Array<{ id: string; status: string }> }>(
            await app.request("/api/dashboard"),
          )
        ).logicalTrades.find((trade) => trade.id === released.logicalTradeId)?.status,
      ).toBe("PENDING");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("preserves the approved parsed status when dismissing a released held OPEN", async () => {
    const source = await readFile(new URL("./app.ts", import.meta.url), "utf8");
    expect(source).toContain("this.dismissReleasedQueueItem(id, parsedSignalId, null);");
  });

  test("releases an evidence-held OPEN on every linked account, not just the first", async () => {
    // Production runs two linked accounts. The gate holds one row per account sharing a single
    // parsed signal, so a dedup that ignores only the releasing row 409s on the sibling and
    // strands both rows HELD forever. Both releases must succeed, in either order.
    const tempDir = await mkdtemp(join(tmpdir(), "telegram-tc-evidence-multi-account-release-"));
    const databasePath = join(tempDir, "app.db");
    try {
      const app = createApi({
        databasePath,
        seedDemoData: false,
        telegram: createQueuedTelegramAdapter(realFixtureMessages(["15226"])),
        telegramPollingEnabled: false,
      });
      const providerId = await configureProviderWithAccount(app, { availableSymbols: ["XAUUSD"] });
      await app.request(`/api/providers/${providerId}`, {
        method: "PATCH",
        body: JSON.stringify({ openEvidence: "structured-id" }),
        headers: { "content-type": "application/json" },
      });
      await app.request(`/api/account-provider-links/mt5-63442826/${providerId}`, {
        method: "PUT",
        body: JSON.stringify({ enabled: true }),
        headers: { "content-type": "application/json" },
      });
      await app.request("/api/mt5/register", {
        method: "POST",
        body: JSON.stringify({
          accountNumber: "63442827",
          server: "OctaFX-Real",
          company: "OctaFX",
          currency: "USD",
          balance: 10000,
          equity: 10000,
          marginMode: "HEDGING",
          availableSymbols: ["XAUUSD"],
          eaVersion: "1.57.2",
          eaCapabilities: ["lane2-close-contract", "pending-close-flatten-v1"],
        }),
        headers: { "content-type": "application/json" },
      });
      await app.request(`/api/account-provider-links/mt5-63442827/${providerId}`, {
        method: "PUT",
        body: JSON.stringify({ enabled: true }),
        headers: { "content-type": "application/json" },
      });

      await app.runTelegramIngestionOnce();
      const held = await json<{ items: Array<{ id: string; accountId: string }> }>(
        await app.request("/api/queue-items/held"),
      );
      const heldOpens = held.items.filter(
        (item) => item.accountId === "mt5-63442826" || item.accountId === "mt5-63442827",
      );
      expect(heldOpens.map((item) => item.accountId).sort()).toEqual([
        "mt5-63442826",
        "mt5-63442827",
      ]);

      for (const heldOpen of heldOpens) {
        const response = await app.request(`/api/queue-items/${heldOpen.id}/requeue`, {
          method: "POST",
          body: JSON.stringify({ mode: "original" }),
          headers: { "content-type": "application/json" },
        });
        expect({ accountId: heldOpen.accountId, status: response.status }).toEqual({
          accountId: heldOpen.accountId,
          status: 200,
        });
        const released = (await response.json()) as { accountId: string; logicalTradeId: string };
        expect(released.accountId).toBe(heldOpen.accountId);
        expect(released.logicalTradeId).toBeTruthy();
      }

      // Each account must end up with its own bound trade, and no held row may survive.
      const db = new Database(databasePath, { readonly: true });
      try {
        const pending = db
          .query("SELECT account_id FROM queue_items WHERE status = 'PENDING' ORDER BY account_id")
          .all() as Array<{ account_id: string }>;
        expect(pending.map((row) => row.account_id)).toEqual(["mt5-63442826", "mt5-63442827"]);
        expect(
          db.query("SELECT COUNT(*) AS n FROM queue_items WHERE status = 'HELD'").get(),
        ).toEqual({ n: 0 });
      } finally {
        db.close();
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("requires and honors an explicit active trade for a real corpus lifecycle release", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "telegram-tc-evidence-lifecycle-release-"));
    const databasePath = join(tempDir, "app.db");
    const messages = realFixtureMessages(["15226"]);
    try {
      const app = createApi({
        databasePath,
        seedDemoData: false,
        telegram: createQueuedTelegramAdapter(messages),
        telegramPollingEnabled: false,
      });
      await configureProviderWithAccount(app, { availableSymbols: ["XAUUSD"] });
      await app.runTelegramIngestionOnce();
      const open = await json<{
        queue: Array<{ id: string; status: string; payload: { commandType: string } }>;
      }>(await app.request("/api/signals"));
      const openItem = open.queue.find((item) => item.payload.commandType === "OPEN_TRADE");
      expect(openItem).toBeDefined();
      await reportPendingAccepted(app, { queueItemId: openItem!.id });
      const trade = await json<{
        logicalTrades: Array<{ id: string; status: string }>;
      }>(await app.request("/api/dashboard"));
      const activeTrade = trade.logicalTrades.find((item) => item.status === "PENDING");
      expect(activeTrade).toBeDefined();

      messages.push(realFixtureMessages(["16669"])[0]!);
      const ingestion = await app.runTelegramIngestionOnce();
      expect(ingestion.errors).toBe(0);
      const held = await json<{
        items: Array<{
          id: string;
          commandType: string;
          heldReason: string;
          candidateLogicalTradeIds?: string[];
        }>;
      }>(await app.request("/api/queue-items/held"));
      const heldClose = held.items.find((item) => item.commandType === "CANCEL_PENDING");
      expect(heldClose).toMatchObject({ heldReason: "EVIDENCE_INLINE_QUOTE_ORIGIN_UNMATCHED" });
      expect(heldClose?.candidateLogicalTradeIds).toContain(activeTrade?.id);

      const refused = await app.request(`/api/queue-items/${heldClose?.id}/requeue`, {
        method: "POST",
        body: JSON.stringify({ mode: "original" }),
        headers: { "content-type": "application/json" },
      });
      expect(refused.status).toBe(409);
      const released = await json<{ queueItemId: string; logicalTradeId: string }>(
        await app.request(`/api/queue-items/${heldClose?.id}/requeue`, {
          method: "POST",
          body: JSON.stringify({ mode: "original", logicalTradeId: activeTrade!.id }),
          headers: { "content-type": "application/json" },
        }),
      );
      expect(released.logicalTradeId).toBe(activeTrade!.id);
      const signals = await json<{
        queue: Array<{
          id: string;
          logicalTradeId: string;
          status: string;
          payload: { commandType: string };
        }>;
      }>(await app.request("/api/signals"));
      expect(signals.queue).toContainEqual(
        expect.objectContaining({
          id: released.queueItemId,
          logicalTradeId: activeTrade!.id,
          status: "PENDING",
          payload: expect.objectContaining({ commandType: "CANCEL_PENDING" }),
        }),
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("releases a real corpus lifecycle-reconciliation hold only to the selected trade", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "telegram-tc-reconciliation-release-"));
    const databasePath = join(tempDir, "app.db");
    const messages = realFixtureMessages(["15226", "15227"]);
    try {
      const app = createApi({
        databasePath,
        seedDemoData: false,
        telegram: createQueuedTelegramAdapter(messages),
        telegramPollingEnabled: false,
      });
      const providerId = await configureProviderWithAccount(app, {
        availableSymbols: ["XAUUSD"],
      });
      await app.runTelegramIngestionOnce();
      const opened = await json<{
        queue: Array<{ id: string; status: string; payload: { commandType: string } }>;
      }>(await app.request("/api/signals"));
      const openItems = opened.queue.filter(
        (item) => item.status === "PENDING" && item.payload.commandType === "OPEN_TRADE",
      );
      expect(openItems).toHaveLength(2);
      for (const item of openItems) await reportPendingAccepted(app, { queueItemId: item.id });

      const removeFixture = realFixtureMessages(["16669"])[0]!;
      const removeSignal = await json<{ parsedSignalId: string; result: { commandType: string } }>(
        await app.request("/api/parser/parse", {
          method: "POST",
          body: JSON.stringify({
            providerId,
            accountId: "mt5-63442826",
            rawText: removeFixture.rawText,
          }),
          headers: { "content-type": "application/json" },
        }),
      );
      expect(removeSignal.result.commandType).toBe("CANCEL_PENDING");
      const approved = await json<{ status: string; queueItemId: string }>(
        await app.request(`/api/signals/${removeSignal.parsedSignalId}/approve`, {
          method: "POST",
        }),
      );
      expect(approved.status).toBe("HELD");
      const held = await json<{
        items: Array<{
          id: string;
          heldReason: string;
          candidateLogicalTradeIds: string[];
        }>;
      }>(await app.request("/api/queue-items/held"));
      const reconciliation = held.items.find(
        (item) =>
          item.id === approved.queueItemId &&
          item.heldReason.startsWith("LIFECYCLE_RECONCILIATION:"),
      );
      expect(reconciliation?.candidateLogicalTradeIds).toHaveLength(2);

      const noSelection = await app.request(`/api/queue-items/${reconciliation!.id}/requeue`, {
        method: "POST",
        body: JSON.stringify({ mode: "original" }),
        headers: { "content-type": "application/json" },
      });
      expect(noSelection.status).toBe(409);
      const selectedLogicalTradeId = reconciliation!.candidateLogicalTradeIds[1]!;
      const released = await json<{ queueItemId: string; logicalTradeId: string }>(
        await app.request(`/api/queue-items/${reconciliation!.id}/requeue`, {
          method: "POST",
          body: JSON.stringify({ mode: "original", logicalTradeId: selectedLogicalTradeId }),
          headers: { "content-type": "application/json" },
        }),
      );
      expect(released.logicalTradeId).toBe(selectedLogicalTradeId);
      const after = await json<{
        queue: Array<{
          id: string;
          logicalTradeId: string;
          status: string;
          payload: { commandType: string };
        }>;
      }>(await app.request("/api/signals"));
      expect(after.queue).toContainEqual(
        expect.objectContaining({
          id: released.queueItemId,
          logicalTradeId: selectedLogicalTradeId,
          status: "PENDING",
          payload: expect.objectContaining({ commandType: "CANCEL_PENDING" }),
        }),
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("holds a real reply-link close with multiple origins and closes nothing", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "telegram-tc-reply-multiple-origins-"));
    const databasePath = join(tempDir, "app.db");
    const messages = realFixtureMessages(["545"]);
    try {
      const app = createApi({
        databasePath,
        seedDemoData: false,
        telegram: createQueuedTelegramAdapter(messages),
        telegramPollingEnabled: false,
      });
      const providerId = await configureProviderWithAccount(app, {
        availableSymbols: ["XAUUSD"],
      });
      await app.runTelegramIngestionOnce();
      const opened = await json<{
        queue: Array<{ id: string; logicalTradeId: string; payload: { commandType: string } }>;
      }>(await app.request("/api/signals"));
      const open = opened.queue.find((item) => item.payload.commandType === "OPEN_TRADE")!;
      await reportPendingAccepted(app, { queueItemId: open.id });

      const setup = new Database(databasePath);
      try {
        const original = setup
          .query(
            "SELECT provider_id, account_id, status, data_json, created_at FROM logical_trades WHERE id = ?",
          )
          .get(open.logicalTradeId) as {
          provider_id: string;
          account_id: string;
          status: string;
          data_json: string;
          created_at: string;
        };
        const originalData = JSON.parse(original.data_json);
        delete originalData.providerOrderId;
        setup
          .query("UPDATE logical_trades SET data_json = ? WHERE id = ?")
          .run(JSON.stringify(originalData), open.logicalTradeId);
        const duplicateId = "trade_reply_multiple_origins";
        const duplicate = { ...originalData, id: duplicateId };
        setup
          .query(
            "INSERT INTO logical_trades (id, provider_id, account_id, status, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .run(
            duplicateId,
            original.provider_id,
            original.account_id,
            original.status,
            JSON.stringify(duplicate),
            original.created_at,
          );
        setup
          .query(
            "INSERT INTO trade_origins (provider_id, account_id, telegram_message_id, logical_trade_id, created_at) VALUES (?, ?, ?, ?, ?)",
          )
          .run(original.provider_id, original.account_id, "545", duplicateId, original.created_at);
      } finally {
        setup.close();
      }

      const closeFixture = realFixtureMessages(["547"])[0]!;
      const close = await json<{ parsedSignalId: string; result: { commandType: string } }>(
        await app.request("/api/parser/parse", {
          method: "POST",
          body: JSON.stringify({
            providerId,
            accountId: "mt5-63442826",
            rawText: closeFixture.rawText,
          }),
          headers: { "content-type": "application/json" },
        }),
      );
      expect(close.result.commandType).toBe("CLOSE_TRADE");
      const correlation = new Database(databasePath);
      try {
        correlation
          .query(
            `UPDATE raw_messages
             SET telegram_message_id = ?, reply_to_message_id = ?
             WHERE id = (SELECT raw_message_id FROM parsed_signals WHERE id = ?)`,
          )
          .run("547", "545", close.parsedSignalId);
      } finally {
        correlation.close();
      }
      const approval = await json<{ status: string; queueItemId: string }>(
        await app.request(`/api/signals/${close.parsedSignalId}/approve`, { method: "POST" }),
      );
      expect(approval.status).toBe("HELD");
      const db = new Database(databasePath, { readonly: true });
      try {
        expect(
          db
            .query("SELECT held_reason FROM queue_items WHERE id = ? AND status = 'HELD'")
            .get(approval.queueItemId),
        ).toEqual({
          held_reason:
            "LIFECYCLE_RECONCILIATION:Multiple open logical trades match this provider command",
        });
        expect(
          db
            .query(
              "SELECT COUNT(*) AS n FROM queue_items WHERE parsed_signal_id = ? AND status IN ('PENDING','LEASED','EXECUTED')",
            )
            .get(close.parsedSignalId),
        ).toEqual({ n: 0 });
      } finally {
        db.close();
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("records a held real KAL TP hit without queueing an EA command", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "telegram-tc-kal-tp-release-"));
    const databasePath = join(tempDir, "app.db");
    const messages = realFixtureMessages(["15343"]);
    try {
      const app = createApi({
        databasePath,
        seedDemoData: false,
        telegram: createQueuedTelegramAdapter(messages),
        telegramPollingEnabled: false,
      });
      const providerId = await configureProviderWithAccount(app, { availableSymbols: ["XAUUSD"] });
      await app.request(`/api/providers/${providerId}`, {
        method: "PATCH",
        body: JSON.stringify({ openEvidence: "prose-complete" }),
        headers: { "content-type": "application/json" },
      });

      await app.runTelegramIngestionOnce();
      const heldBefore = await json<{
        items: Array<{ id: string; commandType: string; heldReason: string }>;
      }>(await app.request("/api/queue-items/held"));
      const heldTp = heldBefore.items.find((item) => item.commandType === "MARK_TP_HIT");
      expect(heldTp).toMatchObject({ commandType: "MARK_TP_HIT" });

      messages.push(realFixtureMessages(["15329"])[0]!);
      await app.runTelegramIngestionOnce();
      const beforeRelease = await json<{
        queue: Array<{ id: string; status: string; payload: { commandType: string } }>;
      }>(await app.request("/api/signals"));
      const openItem = beforeRelease.queue.find(
        (item) => item.payload.commandType === "OPEN_TRADE" && item.status === "PENDING",
      );
      expect(openItem).toBeDefined();
      await reportPendingAccepted(app, { queueItemId: openItem!.id });
      const dashboard = await json<{
        logicalTrades: Array<{ id: string; status: string }>;
      }>(await app.request("/api/dashboard"));
      const activeTrade = dashboard.logicalTrades.find((trade) => trade.status === "PENDING");
      expect(activeTrade).toBeDefined();

      const queueCountBefore = beforeRelease.queue.length;
      const released = await json<{
        status: string;
        queueItemId?: string;
        logicalTradeId: string;
      }>(
        await app.request(`/api/queue-items/${heldTp?.id}/requeue`, {
          method: "POST",
          body: JSON.stringify({ mode: "original", logicalTradeId: activeTrade!.id }),
          headers: { "content-type": "application/json" },
        }),
      );
      expect(released).toMatchObject({ status: "RECORDED", logicalTradeId: activeTrade!.id });
      expect(released.queueItemId).toBeUndefined();

      const after = await json<{
        signals: Array<{ status: string; result: { commandType: string } }>;
        queue: Array<{ id: string; status: string; payload: { commandType: string } }>;
      }>(await app.request("/api/signals"));
      expect(after.queue).toHaveLength(queueCountBefore);
      expect(
        after.queue.some(
          (item) => item.payload.commandType === "MARK_TP_HIT" && item.status === "PENDING",
        ),
      ).toBe(false);
      expect(after.signals.find((item) => item.result.commandType === "MARK_TP_HIT")?.status).toBe(
        "APPROVED",
      );
      const db = new Database(databasePath, { readonly: true });
      try {
        const trade = db
          .query("SELECT data_json FROM logical_trades WHERE id = ?")
          .get(activeTrade!.id) as { data_json: string };
        expect(JSON.parse(trade.data_json).legs).toEqual(
          expect.arrayContaining([expect.objectContaining({ status: "HIT" })]),
        );
      } finally {
        db.close();
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("disposes real NO_SIGNAL corpus messages: risk-off holds alert, ordinary noise audits only", async () => {
    const app = createApi({
      databasePath: ":memory:",
      seedDemoData: false,
      telegram: createQueuedTelegramAdapter(realFixtureMessages(["17114", "17183"])),
      telegramPollingEnabled: false,
    });
    await configureProviderWithAccount(app, { availableSymbols: ["XAUUSD"] });
    await app.request("/api/settings", {
      method: "PATCH",
      body: JSON.stringify({ alertBotToken: "token", alertChatId: "chat", alertOnHeld: true }),
      headers: { "content-type": "application/json" },
    });
    const sentAlerts: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input, init) => {
      sentAlerts.push(String(init?.body ?? ""));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
    try {
      await app.runTelegramIngestionOnce();
      const signals = await json<{
        signals: Array<{ status: string; result: { commandType: string; originalText: string } }>;
      }>(await app.request("/api/signals"));
      expect(signals.signals.filter((item) => item.status === "HELD")).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            result: expect.objectContaining({ commandType: "NO_SIGNAL" }),
          }),
        ]),
      );
      expect(signals.signals.filter((item) => item.status === "IGNORED")).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            result: expect.objectContaining({ commandType: "NO_SIGNAL" }),
          }),
        ]),
      );
      const held = await json<{ items: Array<{ heldReason: string }> }>(
        await app.request("/api/queue-items/held"),
      );
      expect(held.items).toContainEqual(
        expect.objectContaining({ heldReason: "EVIDENCE_RISK_OFF_NO_SIGNAL" }),
      );
      const drops = await json<{ logs: Array<{ eventType: string }> }>(
        await app.request("/api/audit-logs?event=signal.evidence-drop"),
      );
      expect(drops.logs).toHaveLength(1);
      expect(sentAlerts).toHaveLength(1);
      expect(sentAlerts[0]).toContain("EVIDENCE_RISK_OFF_NO_SIGNAL");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("holds an unmatched real inline quote with a suggestion and no symbol fallback", async () => {
    const app = createApi({
      databasePath: ":memory:",
      seedDemoData: false,
      telegram: createQueuedTelegramAdapter(realFixtureMessages(["15509", "15343"])),
      telegramPollingEnabled: false,
    });
    const providerId = await configureProviderWithAccount(app, { availableSymbols: ["XAUUSD"] });
    await app.request(`/api/providers/${providerId}`, {
      method: "PATCH",
      body: JSON.stringify({ openEvidence: "prose-complete" }),
      headers: { "content-type": "application/json" },
    });
    await app.request("/api/settings", {
      method: "PATCH",
      body: JSON.stringify({ alertOnHeld: false, alertBotToken: "token", alertChatId: "chat" }),
      headers: { "content-type": "application/json" },
    });
    const sentAlerts: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input, init) => {
      sentAlerts.push(String(init?.body ?? ""));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
    try {
      expect(await app.runTelegramIngestionOnce()).toMatchObject({ queued: 1 });
      const held = await json<{
        items: Array<{
          heldReason: string;
          heldTier?: string;
          suggestion?: string;
          commandType: string;
        }>;
      }>(await app.request("/api/queue-items/held"));
      expect(held.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            commandType: "MARK_TP_HIT",
            heldReason: "EVIDENCE_INLINE_QUOTE_ORIGIN_UNMATCHED",
            heldTier: "action-required",
          }),
        ]),
      );
      expect(held.items[0]?.suggestion).toBeTruthy();
      expect(held.items[0]?.suggestion).toMatch(/same-symbol trade/);
      expect(
        sentAlerts.some((body) => body.includes("EVIDENCE_INLINE_QUOTE_ORIGIN_UNMATCHED")),
      ).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("executes a real KAL Comment: Remove after inline quote resolution to a pending trade", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "telegram-tc-kal-inline-cancel-"));
    const databasePath = join(tempDir, "app.db");
    const messages = realFixtureMessages(["16654"]);
    try {
      const app = createApi({
        databasePath,
        seedDemoData: false,
        telegram: createQueuedTelegramAdapter(messages),
        telegramPollingEnabled: false,
      });
      const providerId = await configureProviderWithAccount(app, { availableSymbols: ["XAUUSD"] });
      await app.request(`/api/providers/${providerId}`, {
        method: "PATCH",
        body: JSON.stringify({ openEvidence: "prose-complete" }),
        headers: { "content-type": "application/json" },
      });
      expect(await app.runTelegramIngestionOnce()).toMatchObject({ queued: 1 });
      const db = new Database(databasePath);
      db.query(
        "UPDATE logical_trades SET status = 'PENDING', data_json = json_set(data_json, '$.status', 'PENDING')",
      ).run();
      db.close();
      messages.push(realFixtureMessages(["16669"])[0]!);

      expect(await app.runTelegramIngestionOnce()).toMatchObject({ queued: 1 });
      const signals = await json<{
        queue: Array<{ status: string; payload: { commandType: string } }>;
      }>(await app.request("/api/signals"));
      expect(signals.queue).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            status: "PENDING",
            payload: expect.objectContaining({ commandType: "CANCEL_PENDING" }),
          }),
        ]),
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("operator approval bypasses the evidence gate for a real VIP Gold open", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: false });
    const providerId = await configureProviderWithAccount(app, { availableSymbols: ["XAUUSD"] });
    await app.request(`/api/providers/${providerId}`, {
      method: "PATCH",
      body: JSON.stringify({ openEvidence: "structured-id" }),
      headers: { "content-type": "application/json" },
    });
    const parsed = await json<{ parsedSignalId: string }>(
      await app.request("/api/parser/parse", {
        method: "POST",
        body: JSON.stringify({
          providerId,
          accountId: "mt5-63442826",
          rawText: corpusMessages.find((message) => message.telegramMessageId === "487")!.rawText,
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    const approval = await app.request(`/api/signals/${parsed.parsedSignalId}/approve`, {
      method: "POST",
    });
    expect(approval.status).toBe(200);
    expect(await json<{ status: string }>(approval)).toMatchObject({ status: "PENDING" });
  });
});

describe("provider traded symbols", () => {
  test("round-trips normalized traded symbols and fills symbol-less signals from the first symbol", async () => {
    const app = createApi({
      databasePath: ":memory:",
      seedDemoData: false,
      telegramPollingEnabled: false,
    });
    const providerId = await configureProviderWithAccount(app, {
      availableSymbols: ["XAUUSD", "EURUSD"],
    });
    await app.request(`/api/providers/${providerId}`, {
      method: "PATCH",
      body: JSON.stringify({
        lockedSymbol: "BTCUSD",
        tradedSymbols: [" xauusd ", "EUR/USD", "XAUUSD", ""],
      }),
      headers: { "content-type": "application/json" },
    });
    const config = await json<{ config: { lockedSymbol?: string; tradedSymbols?: string[] } }>(
      await app.request(`/api/providers/${providerId}/config`),
    );
    expect(config.config).toEqual(
      expect.objectContaining({
        lockedSymbol: "BTCUSD",
        tradedSymbols: ["XAUUSD", "EURUSD"],
      }),
    );
    const parsed = await json<{ result: { canonicalSymbol?: string } }>(
      await app.request("/api/parser/parse", {
        method: "POST",
        body: JSON.stringify({ providerId, rawText: "BUY NOW" }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(parsed.result.canonicalSymbol).toBe("XAUUSD");
  });

  test("holds off-list opens during ingestion while queuing in-list opens", async () => {
    const app = createApi({
      databasePath: ":memory:",
      seedDemoData: false,
      telegram: createQueuedTelegramAdapter([
        {
          telegramMessageId: "off-list",
          messageDate: "2026-07-17T10:00:00.000Z",
          rawText: "BUY BTCUSD @ 50000\nSL 50100\nTP 49800",
        },
        {
          telegramMessageId: "in-list",
          messageDate: "2026-07-17T10:01:00.000Z",
          rawText: "BUY XAUUSD @ 4525\nSL 4515\nTP 4535",
        },
      ]),
      telegramPollingEnabled: false,
    });
    const providerId = await configureProviderWithAccount(app, {
      availableSymbols: ["BTCUSD", "XAUUSD"],
    });
    await app.request(`/api/providers/${providerId}`, {
      method: "PATCH",
      body: JSON.stringify({ tradedSymbols: ["XAUUSD"] }),
      headers: { "content-type": "application/json" },
    });
    expect(await app.runTelegramIngestionOnce()).toMatchObject({ queued: 1, reviewRequired: 1 });
    const signals = await json<{
      signals: Array<{ result: { canonicalSymbol?: string }; status: string }>;
      queue: Array<{ status: string; heldReason?: string; payload: { canonicalSymbol?: string } }>;
    }>(await app.request("/api/signals"));
    expect(
      signals.signals.find((signal) => signal.result.canonicalSymbol === "BTCUSD")?.status,
    ).toBe("HELD");
    expect(signals.queue).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "HELD",
          heldReason: "SYMBOL_NOT_TRADED",
          payload: expect.objectContaining({ canonicalSymbol: "BTCUSD" }),
        }),
        expect.objectContaining({
          status: "PENDING",
          payload: expect.objectContaining({ canonicalSymbol: "XAUUSD" }),
        }),
      ]),
    );
  });

  test("rejects manual approval of an off-list symbol and leaves empty traded symbols unchanged", async () => {
    const app = createApi({
      databasePath: ":memory:",
      seedDemoData: false,
      telegramPollingEnabled: false,
    });
    const providerId = await configureProviderWithAccount(app, { availableSymbols: ["BTCUSD"] });
    await app.request(`/api/providers/${providerId}`, {
      method: "PATCH",
      body: JSON.stringify({ tradedSymbols: ["XAUUSD"] }),
      headers: { "content-type": "application/json" },
    });
    const parsed = await json<{ parsedSignalId: string }>(
      await app.request("/api/parser/parse", {
        method: "POST",
        body: JSON.stringify({ providerId, rawText: "BUY BTCUSD" }),
        headers: { "content-type": "application/json" },
      }),
    );
    const rejected = await app.request(`/api/signals/${parsed.parsedSignalId}/approve`, {
      method: "POST",
    });
    expect(rejected.status).toBe(422);
    expect((await json<{ error: string }>(rejected)).error).toBe(
      "Symbol BTCUSD is not in this provider's traded symbols",
    );

    await app.request(`/api/providers/${providerId}`, {
      method: "PATCH",
      body: JSON.stringify({ tradedSymbols: [] }),
      headers: { "content-type": "application/json" },
    });
    const unrestricted = await json<{ parsedSignalId: string }>(
      await app.request("/api/parser/parse", {
        method: "POST",
        body: JSON.stringify({ providerId, rawText: "BUY BTCUSD" }),
        headers: { "content-type": "application/json" },
      }),
    );
    const approved = await app.request(`/api/signals/${unrestricted.parsedSignalId}/approve`, {
      method: "POST",
    });
    expect(approved.status).toBe(200);
  });

  test("scans connected Telegram messages without persisting them", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "telegram-tc-detected-symbols-"));
    const databasePath = join(tempDir, "app.db");
    const calls: string[] = [];
    const telegram: TelegramAdapter = {
      ...createQueuedTelegramAdapter([
        {
          telegramMessageId: "scan-1",
          messageDate: "2026-07-17T10:00:00.000Z",
          rawText: "BUY XAUUSD @ 4525\nSL 4515\nTP 4535",
        },
        {
          telegramMessageId: "scan-2",
          messageDate: "2026-07-17T10:01:00.000Z",
          rawText: "SELL XAUUSD",
        },
        {
          telegramMessageId: "scan-3",
          messageDate: "2026-07-17T10:02:00.000Z",
          rawText: "BUY EURUSD",
        },
      ]),
      async listDialogs(sessionId) {
        calls.push(`dialogs:${sessionId}`);
        return [{ id: "dialog-btc", title: "Test Forex Group", type: "group", unreadCount: 3 }];
      },
      async fetchRecentMessages(sessionId, dialogId, limit) {
        calls.push(`messages:${sessionId}:${dialogId}:${limit}`);
        return {
          messages: [
            {
              telegramMessageId: "scan-1",
              messageDate: "2026-07-17T10:00:00.000Z",
              rawText: "BUY XAUUSD",
            },
            {
              telegramMessageId: "scan-2",
              messageDate: "2026-07-17T10:01:00.000Z",
              rawText: "SELL XAUUSD",
            },
            {
              telegramMessageId: "scan-3",
              messageDate: "2026-07-17T10:02:00.000Z",
              rawText: "BUY EURUSD",
            },
          ],
          gap: undefined,
        };
      },
    };
    try {
      const app = createApi({
        databasePath,
        seedDemoData: false,
        telegram,
        telegramPollingEnabled: false,
      });
      const providerId = await configureProviderWithAccount(app, {
        availableSymbols: ["XAUUSD", "EURUSD"],
      });
      const before = new Database(databasePath, { readonly: true });
      const rawMessageCount = Number(
        (before.query("SELECT COUNT(*) AS count FROM raw_messages").get() as { count: number })
          .count,
      );
      before.close();
      const response = await json<{ symbols: Array<{ symbol: string; count: number }> }>(
        await app.request(`/api/providers/${providerId}/detected-symbols?limit=3`),
      );
      expect(response).toEqual({
        symbols: [
          { symbol: "XAUUSD", count: 2 },
          { symbol: "EURUSD", count: 1 },
        ],
      });
      expect(calls.some((call) => call.startsWith("dialogs:"))).toBe(true);
      expect(calls.some((call) => call.endsWith(":dialog-btc:3"))).toBe(true);
      const after = new Database(databasePath, { readonly: true });
      expect(
        Number(
          (after.query("SELECT COUNT(*) AS count FROM raw_messages").get() as { count: number })
            .count,
        ),
      ).toBe(rawMessageCount);
      after.close();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("signal correlation Phase 1 persistence", () => {
  test("persists forwarded provenance and nulls ordinary-message provenance", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "telegram-tc-forward-provenance-"));
    const databasePath = join(tempDir, "app.db");
    try {
      const app = createApi({
        databasePath,
        seedDemoData: false,
        telegram: createQueuedTelegramAdapter([
          {
            telegramMessageId: "forwarded",
            messageDate: "2026-07-17T10:00:00.000Z",
            rawText: "BUY XAUUSD",
            forwardedFrom: { peer: "channelId:991", name: "VIP Gold" },
            forwardedDate: "2026-07-17T00:26:40.000Z",
          },
          {
            telegramMessageId: "ordinary",
            messageDate: "2026-07-17T10:01:00.000Z",
            rawText: "SELL XAUUSD",
          },
        ]),
        telegramPollingEnabled: false,
      });
      const providerId = await configureProviderWithAccount(app, { availableSymbols: ["XAUUSD"] });
      await app.runTelegramIngestionOnce();

      const db = new Database(databasePath, { readonly: true });
      try {
        const rows = db
          .query(
            "SELECT telegram_message_id, forwarded_from, forward_date FROM raw_messages WHERE provider_id = ? ORDER BY telegram_message_id",
          )
          .all(providerId) as Array<{
          telegram_message_id: string;
          forwarded_from: string | null;
          forward_date: string | null;
        }>;
        expect(rows).toEqual([
          {
            telegram_message_id: "forwarded",
            forwarded_from: JSON.stringify({ peer: "channelId:991", name: "VIP Gold" }),
            forward_date: "2026-07-17T00:26:40.000Z",
          },
          {
            telegram_message_id: "ordinary",
            forwarded_from: null,
            forward_date: null,
          },
        ]);
      } finally {
        db.close();
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("migrates reply correlation storage idempotently on fresh and legacy databases", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "telegram-tc-signal-correlation-"));
    const legacyPath = join(tempDir, "legacy.db");
    const freshPath = join(tempDir, "fresh.db");
    try {
      const legacy = new Database(legacyPath);
      legacy.run(`
        CREATE TABLE raw_messages (
          id TEXT PRIMARY KEY,
          provider_id TEXT NOT NULL,
          telegram_message_id TEXT NOT NULL,
          message_date TEXT NOT NULL,
          raw_text TEXT NOT NULL,
          fingerprint TEXT NOT NULL,
          classification TEXT NOT NULL
        )
      `);
      legacy.close();

      for (const databasePath of [legacyPath, freshPath]) {
        createApi({ databasePath, seedDemoData: false, telegramPollingEnabled: false });
        createApi({ databasePath, seedDemoData: false, telegramPollingEnabled: false });
        const db = new Database(databasePath, { readonly: true });
        try {
          const columns = db.query("PRAGMA table_info(raw_messages)").all() as Array<{
            name: string;
          }>;
          expect(columns.filter((column) => column.name === "reply_to_message_id")).toHaveLength(1);
          expect(columns.filter((column) => column.name === "forwarded_from")).toHaveLength(1);
          expect(columns.filter((column) => column.name === "forward_date")).toHaveLength(1);
          const tables = db
            .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?)")
            .all("raw_message_aliases", "trade_origins") as Array<{ name: string }>;
          expect(tables.map((table) => table.name).sort()).toEqual([
            "raw_message_aliases",
            "trade_origins",
          ]);
          const indexes = db
            .query("SELECT name FROM sqlite_master WHERE type = 'index' AND name IN (?, ?)")
            .all(
              "idx_raw_message_aliases_provider_telegram",
              "idx_trade_origins_provider_account_telegram",
            ) as Array<{ name: string }>;
          expect(indexes.map((index) => index.name).sort()).toEqual([
            "idx_raw_message_aliases_provider_telegram",
            "idx_trade_origins_provider_account_telegram",
          ]);
        } finally {
          db.close();
        }
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("aliases every correlated constituent and each standalone raw message", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "telegram-tc-signal-aliases-"));
    const databasePath = join(tempDir, "app.db");
    try {
      const app = createApi({
        databasePath,
        seedDemoData: false,
        telegram: createQueuedTelegramAdapter([
          {
            telegramMessageId: "anchor",
            replyToMessageId: "opening-message",
            messageDate: "2026-07-17T10:00:00.000Z",
            rawText: "BUY XAUUSD",
          },
          {
            telegramMessageId: "folded",
            messageDate: "2026-07-17T10:00:05.000Z",
            rawText: "SL 2290 TP 2320",
          },
          {
            telegramMessageId: "standalone",
            messageDate: "2026-07-17T10:10:00.000Z",
            rawText: "SELL XAUUSD",
          },
        ]),
        telegramPollingEnabled: false,
      });
      const providerId = await configureProviderWithAccount(app, { availableSymbols: ["XAUUSD"] });
      await app.runTelegramIngestionOnce();

      const db = new Database(databasePath, { readonly: true });
      try {
        const aliases = db
          .query(
            "SELECT telegram_message_id, raw_message_id FROM raw_message_aliases WHERE provider_id = ? ORDER BY telegram_message_id",
          )
          .all(providerId) as Array<{ telegram_message_id: string; raw_message_id: string }>;
        expect(aliases).toEqual([
          { telegram_message_id: "anchor", raw_message_id: `raw_${providerId}_anchor` },
          { telegram_message_id: "folded", raw_message_id: `raw_${providerId}_anchor` },
          { telegram_message_id: "standalone", raw_message_id: `raw_${providerId}_standalone` },
        ]);
        expect(
          db
            .query("SELECT reply_to_message_id FROM raw_messages WHERE id = ?")
            .get(`raw_${providerId}_anchor`),
        ).toEqual({ reply_to_message_id: "opening-message" });
      } finally {
        db.close();
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("maps Telegram trade origins by provider and account while skipping manual origins", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "telegram-tc-trade-origins-"));
    const databasePath = join(tempDir, "app.db");
    try {
      const app = createApi({
        databasePath,
        seedDemoData: false,
        telegram: createQueuedTelegramAdapter([
          {
            telegramMessageId: "opening-telegram-id",
            messageDate: "2026-07-17T10:00:00.000Z",
            rawText: "BUY XAUUSD\nSL 2290\nTP 2320",
          },
        ]),
        telegramPollingEnabled: false,
      });
      const providerId = await configureProviderWithAccount(app, { availableSymbols: ["XAUUSD"] });
      const imported = await app.request(`/api/providers/${providerId}/import-messages`, {
        method: "POST",
        body: JSON.stringify({ limit: 1 }),
        headers: { "content-type": "application/json" },
      });
      expect(imported.status).toBe(200);
      const parsed = await json<{ parsed: Array<{ parsedSignalId: string }> }>(
        await app.request(`/api/providers/${providerId}/parse-recent?limit=1`, { method: "POST" }),
      );
      const approved = await json<{ logicalTradeIds: string[] }>(
        await app.request(`/api/signals/${parsed.parsed[0]!.parsedSignalId}/approve`, {
          method: "POST",
        }),
      );

      const db = new Database(databasePath, { readonly: true });
      try {
        const origin = db
          .query(
            "SELECT logical_trade_id FROM trade_origins WHERE provider_id = ? AND account_id = ? AND telegram_message_id = ?",
          )
          .get(providerId, "mt5-63442826", "opening-telegram-id") as {
          logical_trade_id: string;
        } | null;
        expect(origin?.logical_trade_id).toBe(approved.logicalTradeIds[0]);
      } finally {
        db.close();
      }

      await app.request("/api/signals/manual", {
        method: "POST",
        body: JSON.stringify({
          accountId: "mt5-63442826",
          providerId,
          direction: "SELL",
          orderType: "MARKET",
          brokerSymbol: "XAUUSD",
          stopLoss: 2400,
          takeProfits: [{ price: 2300 }],
          volume: 0.01,
        }),
        headers: { "content-type": "application/json" },
      });
      const verify = new Database(databasePath, { readonly: true });
      try {
        expect(
          verify
            .query(
              "SELECT COUNT(*) AS count FROM trade_origins WHERE telegram_message_id = 'manual'",
            )
            .get(),
        ).toEqual({ count: 0 });
      } finally {
        verify.close();
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("signal correlation Phase 2a shadow logging", () => {
  test("evaluates lifecycle actions against the existing logical trade states", () => {
    const cases: Array<
      [
        string,
        "PLANNED" | "PENDING" | "OPEN" | "CLOSED" | "OUT_OF_SYNC",
        "act" | "cancel" | "noop" | "hold",
      ]
    > = [
      ["CANCEL_PENDING", "PLANNED", "act"],
      ["CANCEL_PENDING", "PENDING", "act"],
      ["CANCEL_PENDING", "OPEN", "hold"],
      ["CANCEL_PENDING", "CLOSED", "noop"],
      ["CLOSE_TRADE", "OPEN", "act"],
      ["CLOSE_TRADE", "PENDING", "act"],
      ["CLOSE_TRADE", "CLOSED", "noop"],
      ["CLOSE_PARTIAL", "OPEN", "act"],
      ["CLOSE_PARTIAL", "PENDING", "cancel"],
      ["CLOSE_PARTIAL", "CLOSED", "noop"],
      ["MODIFY_SL", "OPEN", "act"],
      ["MODIFY_TP", "PENDING", "act"],
      ["MOVE_SL_TO_BE", "OPEN", "act"],
      ["TRAILING_STOP", "PENDING", "act"],
      ["MODIFY_SL", "CLOSED", "noop"],
      ["MARK_TP_HIT", "OPEN", "act"],
      ["MARK_TP_HIT", "PENDING", "act"],
      ["MARK_TP_HIT", "CLOSED", "noop"],
      ["CLOSE_TRADE", "OUT_OF_SYNC", "hold"],
    ];
    for (const [commandType, status, verdict] of cases) {
      expect(evaluateLifecycleActionState(commandType, status).verdict).toBe(verdict);
    }
    expect(evaluateLifecycleActionState("CANCEL_PENDING", "OPEN")).toMatchObject({
      verdict: "hold",
      reason: "cancel-on-open",
    });
    expect(evaluateLifecycleActionState("CLOSE_TRADE", "PENDING")).toMatchObject({
      verdict: "act",
      reason: "flatten-pending",
    });
    expect(evaluateLifecycleActionState("MARK_TP_HIT", "OPEN").reason).toBe("tp-hit-record-only");
    expect(
      evaluateLifecycleActionState("MARK_TP_HIT", "OPEN", { closeOnProviderTp: true }).reason,
    ).toBe("tp-hit-close-opt-in");
  });

  test("resolves reply chains per account and records bounded unmatched reasons in one shadow audit per lifecycle", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "telegram-tc-correlation-shadow-"));
    const databasePath = join(tempDir, "app.db");
    try {
      const messages: TelegramCapturedMessage[] = [
        {
          telegramMessageId: "open",
          messageDate: "2026-07-17T10:00:00.000Z",
          rawText: "BUY XAUUSD @ 4525\nSL 4515\nTP 4535",
        },
        {
          telegramMessageId: "update",
          replyToMessageId: "open",
          messageDate: "2026-07-17T10:01:00.000Z",
          rawText: "Trail stop XAUUSD by 10 pips",
        },
        {
          telegramMessageId: "close",
          replyToMessageId: "update",
          messageDate: "2026-07-17T10:02:00.000Z",
          rawText: "Close XAUUSD",
        },
        {
          telegramMessageId: "unrelated",
          messageDate: "2026-07-17T10:03:00.000Z",
          rawText: "Market update",
        },
        {
          telegramMessageId: "unrelated-life",
          replyToMessageId: "unrelated",
          messageDate: "2026-07-17T10:04:00.000Z",
          rawText: "Trail stop XAUUSD by 10 pips",
        },
        {
          telegramMessageId: "no-reply",
          messageDate: "2026-07-17T10:05:00.000Z",
          rawText: "Trail stop XAUUSD by 10 pips",
        },
        {
          telegramMessageId: "gap",
          replyToMessageId: "missing",
          messageDate: "2026-07-17T10:06:00.000Z",
          rawText: "Trail stop XAUUSD by 10 pips",
        },
        {
          telegramMessageId: "cycle-a",
          replyToMessageId: "cycle-b",
          messageDate: "2026-07-17T10:07:00.000Z",
          rawText: "Market update",
        },
        {
          telegramMessageId: "cycle-b",
          replyToMessageId: "cycle-a",
          messageDate: "2026-07-17T10:08:00.000Z",
          rawText: "Market update",
        },
        {
          telegramMessageId: "cycle-life",
          replyToMessageId: "cycle-a",
          messageDate: "2026-07-17T10:09:00.000Z",
          rawText: "Trail stop XAUUSD by 10 pips",
        },
        ...Array.from({ length: 13 }, (_, index) => ({
          telegramMessageId: `deep-${index}`,
          replyToMessageId: index === 0 ? undefined : `deep-${index - 1}`,
          messageDate: `2026-07-17T10:${String(10 + index).padStart(2, "0")}:00.000Z`,
          rawText: "Market update",
        })),
        {
          telegramMessageId: "deep-life",
          replyToMessageId: "deep-12",
          messageDate: "2026-07-17T10:23:00.000Z",
          rawText: "Trail stop XAUUSD by 10 pips",
        },
      ];
      const app = createApi({
        databasePath,
        seedDemoData: false,
        telegram: createQueuedTelegramAdapter(messages),
        telegramPollingEnabled: false,
      });
      const providerId = await configureProviderWithAccount(app, { availableSymbols: ["XAUUSD"] });
      await app.request(`/api/account-provider-links/mt5-63442826/${providerId}`, {
        method: "PUT",
        body: JSON.stringify({ enabled: true }),
        headers: { "content-type": "application/json" },
      });
      await app.request("/api/mt5/register", {
        method: "POST",
        body: JSON.stringify({
          accountNumber: "63442827",
          server: "OctaFX-Real",
          company: "OctaFX",
          currency: "USD",
          balance: 10000,
          equity: 10000,
          marginMode: "HEDGING",
          availableSymbols: ["XAUUSD"],
        }),
        headers: { "content-type": "application/json" },
      });
      await app.request(`/api/account-provider-links/mt5-63442827/${providerId}`, {
        method: "PUT",
        body: JSON.stringify({ enabled: true }),
        headers: { "content-type": "application/json" },
      });
      const db = new Database(databasePath);
      db.query("UPDATE providers SET provider_config_json = ? WHERE id = ?").run(
        JSON.stringify({ correlationMode: "shadow" }),
        providerId,
      );
      db.close();

      await app.runTelegramIngestionOnce();

      const verify = new Database(databasePath, { readonly: true });
      try {
        const audits = verify
          .query("SELECT data_json FROM audit_logs WHERE event_type = ?")
          .all("correlation.shadow") as Array<{ data_json: string }>;
        const byReply = new Map(
          audits.map((row) => {
            const data = JSON.parse(row.data_json) as {
              replyToMessageId?: string;
              accounts: Array<{
                accountId: string;
                resolved: { status: string; reason?: string; tradeId?: string };
                agreement: boolean;
              }>;
            };
            return [data.replyToMessageId, data] as const;
          }),
        );
        expect(byReply.get("open")?.accounts[0]?.resolved.status).toBe("MATCHED");
        expect(byReply.get("open")?.accounts).toHaveLength(2);
        expect(byReply.get("open")?.accounts[0]?.resolved.tradeId).not.toBe(
          byReply.get("open")?.accounts[1]?.resolved.tradeId,
        );
        expect(byReply.get("update")?.accounts[0]?.resolved.status).toBe("MATCHED");
        expect(byReply.get("unrelated")?.accounts[0]?.resolved.reason).toBe(
          "chain-ended-no-origin",
        );
        expect(byReply.get("missing")?.accounts[0]?.resolved.reason).toBe("gap-in-graph");
        expect(byReply.get("cycle-a")?.accounts[0]?.resolved.reason).toBe("cycle");
        expect(byReply.get("deep-12")?.accounts[0]?.resolved.reason).toBe("chain-too-deep");
        const noReply = audits
          .map(
            (row) =>
              JSON.parse(row.data_json) as {
                replyToMessageId?: string;
                accounts: Array<{ resolved: { method: string; reason?: string } }>;
              },
          )
          .find((data) => !data.replyToMessageId);
        expect(noReply?.accounts[0]?.resolved).toMatchObject({
          method: "none",
          reason: "no-evidence",
        });
      } finally {
        verify.close();
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("shadow mode is audit-only, remains off by default, and contains shadow failures", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "telegram-tc-correlation-shadow-safety-"));
    const databasePath = join(tempDir, "app.db");
    try {
      const messages: TelegramCapturedMessage[] = [
        {
          telegramMessageId: "open",
          messageDate: "2026-07-17T11:00:00.000Z",
          rawText: "BUY XAUUSD @ 4525\nSL 4515\nTP 4535",
        },
        {
          telegramMessageId: "life",
          replyToMessageId: "open",
          messageDate: "2026-07-17T11:01:00.000Z",
          rawText: "Trail stop XAUUSD by 10 pips",
        },
      ];
      const app = createApi({
        databasePath,
        seedDemoData: false,
        telegram: createQueuedTelegramAdapter(messages),
        telegramPollingEnabled: false,
      });
      const providerId = await configureProviderWithAccount(app, { availableSymbols: ["XAUUSD"] });
      const offResult = await app.runTelegramIngestionOnce();
      expect(offResult.queued).toBe(2);
      const db = new Database(databasePath);
      db.query("UPDATE providers SET provider_config_json = ? WHERE id = ?").run(
        JSON.stringify({ correlationMode: "shadow" }),
        providerId,
      );
      db.query("DELETE FROM parsed_signals WHERE provider_id = ? AND raw_message_id = ?").run(
        providerId,
        `raw_${providerId}_life`,
      );
      db.close();
      const result = await app.runTelegramIngestionOnce();
      expect(result.queued).toBe(1);

      const verify = new Database(databasePath, { readonly: true });
      try {
        expect(
          verify
            .query("SELECT COUNT(*) AS count FROM audit_logs WHERE event_type = ?")
            .get("correlation.shadow"),
        ).toEqual({ count: 1 });
        expect(verify.query("SELECT COUNT(*) AS count FROM queue_items").get()).toEqual({
          count: 3,
        });
        expect(verify.query("SELECT COUNT(*) AS count FROM parsed_signals").get()).toEqual({
          count: 2,
        });
      } finally {
        verify.close();
      }

      const failing = new Database(databasePath);
      failing
        .query("DELETE FROM parsed_signals WHERE provider_id = ? AND raw_message_id = ?")
        .run(providerId, `raw_${providerId}_life`);
      failing.close();
      const databasePrototype = Database.prototype as unknown as {
        query: (sql: string) => unknown;
      };
      const originalQuery = databasePrototype.query;
      databasePrototype.query = function (sql: string) {
        if (sql.includes("SELECT logical_trade_id FROM trade_origins")) {
          throw new Error("forced shadow resolver failure");
        }
        return originalQuery.call(this, sql);
      };
      let failureResult: Awaited<ReturnType<typeof app.runTelegramIngestionOnce>>;
      try {
        failureResult = await app.runTelegramIngestionOnce();
      } finally {
        databasePrototype.query = originalQuery;
      }
      expect(failureResult?.parsed).toBe(1);
      const errorDb = new Database(databasePath, { readonly: true });
      try {
        expect(
          errorDb
            .query("SELECT COUNT(*) AS count FROM audit_logs WHERE event_type = ?")
            .get("correlation.shadow-error"),
        ).toEqual({ count: 1 });
      } finally {
        errorDb.close();
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
