import { describe, expect, test } from "bun:test";
import { brokerOrderSourceForDealReason, createApi } from "./app";
import type { TelegramAdapter, TelegramCapturedMessage, TelegramDialog } from "./telegram";

const json = async <T>(response: Response) => (await response.json()) as T;

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
      return messages;
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
      return messages;
    },
  };
}

async function configureProviderWithAccount(
  app: ReturnType<typeof createApi>,
  input: { availableSymbols: string[] },
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
    }),
    headers: { "content-type": "application/json" },
  });
  return selected.provider.id;
}

describe("Telegram TC API", () => {
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
        rawText: "SELL BTCUSD",
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
      body: JSON.stringify({ providerId, rawText: recent.messages[0]!.rawText }),
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
    expect(dashboard.signalQueue.some((item) => item.status === "FAILED")).toBe(true);
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
    expect(approval.status).toBe(422);
    expect((await json<{ error: string }>(approval)).error).toContain(
      "Multiple open logical trades",
    );
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
      logicalTrades: Array<{ id: string; status: string }>;
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
        positions: [],
        orders: [],
        symbols: [],
      }),
      headers: { "content-type": "application/json" },
    });

    const missing = await json<{ logicalTrades: Array<{ id: string; status: string }> }>(
      await app.request("/api/dashboard"),
    );
    expect(missing.logicalTrades.find((trade) => trade.id === "trade-demo-1")?.status).toBe(
      "OUT_OF_SYNC",
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
        return [
          {
            telegramMessageId: "555",
            messageDate: "2026-05-09T08:00:00.000Z",
            rawText: "SELL XAUUSD 2365\nSL 2375\nTP1 2350",
            senderName: "Real FX Channel",
          },
        ];
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

  test("updates provider parser mode, risk profile, and channel lot size settings", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: true });
    const providers = await json<{
      providers: Array<{ id: string; parserMode: string; riskProfile: string; lotSize: number }>;
    }>(await app.request("/api/providers"));
    const providerId = providers.providers[0]!.id;
    expect(providers.providers[0]!.riskProfile).toBe("balanced");
    expect(providers.providers[0]!.lotSize).toBe(0.1);

    const update = await json<{
      provider: { id: string; parserMode: string; riskProfile: string; lotSize: number };
    }>(
      await app.request(`/api/providers/${providerId}`, {
        method: "PATCH",
        body: JSON.stringify({ parserMode: "kal-vip", riskProfile: "conservative", lotSize: 0.2 }),
        headers: { "content-type": "application/json" },
      }),
    );

    expect(update.provider).toMatchObject({
      id: providerId,
      parserMode: "kal-vip",
      riskProfile: "conservative",
      lotSize: 0.2,
    });
    const refreshed = await json<{
      providers: Array<{ id: string; parserMode: string; riskProfile: string; lotSize: number }>;
    }>(await app.request("/api/providers"));
    expect(refreshed.providers[0]!.riskProfile).toBe("conservative");
    expect(refreshed.providers[0]!.lotSize).toBe(0.2);

    const dashboard = await json<{
      providers: Array<{ id: string; parserMode: string; riskProfile: string; lotSize: number }>;
    }>(await app.request("/api/dashboard"));
    expect(dashboard.providers[0]!.riskProfile).toBe("conservative");
    expect(dashboard.providers[0]!.lotSize).toBe(0.2);
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
      pollingIntervalSeconds: 2,
      allowedOrderTypes: ["MARKET", "LIMIT", "STOP"],
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

  test("matches lifecycle commands to an existing logical trade and rejects duplicate management messages", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: true });
    await app.request("/api/mt5/poll-line?accountId=mt5-100200300");

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
    expect(pollLine).toContain("commandType=CLOSE_PARTIAL");
    expect(pollLine).toContain("logicalTradeId=trade-demo-1");
    expect(pollLine).toContain("brokerSymbol=EURUSD.raw");
    expect(pollLine).toContain("partialCloseKind=PERCENT");
    expect(pollLine).toContain("partialCloseValue=50");

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
    expect(modifyApproval.status).toBe(422);
    expect((await json<{ error: string }>(modifyApproval)).error).toContain("newStopLoss");

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
    expect(trailingApproval.status).toBe(422);
    expect((await json<{ error: string }>(trailingApproval)).error).toContain("trailingStop");
  });

  test("auto-ingests clean lifecycle commands after matching an active provider trade", async () => {
    const telegram = createQueuedTelegramAdapter([
      {
        telegramMessageId: "btc-open-1",
        messageDate: "2026-05-16T18:51:10.000Z",
        rawText: "SELL BTCUSD",
      },
      {
        telegramMessageId: "btc-trail-1",
        messageDate: "2026-05-16T18:51:20.000Z",
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

  test("sends runner configuration to MT5 for virtual-TP work and blocks split-order runner mode", async () => {
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
    expect(pollLine).toContain("runnerEnabled=true");
    expect(pollLine).toContain("runnerVolume=0.02");
    expect(pollLine).toContain("runnerSlBehavior=trail");
    expect(pollLine).toContain("runnerTrailPips=25");
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
});
