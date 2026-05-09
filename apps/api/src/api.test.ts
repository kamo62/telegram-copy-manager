import { describe, expect, test } from "bun:test";
import { createApi } from "./app";
import type { TelegramAdapter } from "./telegram";

const json = async <T>(response: Response) => (await response.json()) as T;

describe("Telegram TC API", () => {
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
    expect((await json<{ logs: Array<{ retcode: number }> }>(logs)).logs[0]?.retcode).toBe(10009);

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
      brokerSymbol: "XAUUSD.r",
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
        pollingIntervalSeconds: number;
        allowedOrderTypes: string[];
      };
    }>(await app.request("/api/settings"));
    expect(defaults.settings).toEqual({
      defaultLotSize: 0.1,
      defaultRiskPercent: 1,
      pollingIntervalSeconds: 2,
      allowedOrderTypes: ["MARKET", "LIMIT", "STOP"],
    });

    const updated = await json<{
      settings: {
        defaultLotSize: number;
        defaultRiskPercent: number;
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
});
