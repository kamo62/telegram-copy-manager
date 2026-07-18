import { describe, expect, test } from "bun:test";
import {
  classifyReconciliation,
  computeProviderScore,
  computeVolumePreview,
  createApi,
  learnedOverrideApplies,
  providerScoreAlert,
  structuralFingerprint,
} from "./app";
import type { TelegramAdapter, TelegramCapturedMessage } from "./telegram";

const json = async <T>(response: Response) => (await response.json()) as T;

function mockAdapter(messages: TelegramCapturedMessage[]): TelegramAdapter {
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

async function setupProvider(
  app: ReturnType<typeof createApi>,
  availableSymbols: string[] = ["XAUUSD"],
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
    body: JSON.stringify({ enabled: true, riskMode: "fixed", riskAmount: 0.05 }),
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
      availableSymbols,
    }),
    headers: { "content-type": "application/json" },
  });
  return selected.provider.id;
}

function at(secondsFromBase: number): string {
  return new Date(Date.parse("2026-06-26T12:00:00.000Z") + secondsFromBase * 1000).toISOString();
}

describe("multi-message correlation (Task 4 integration)", () => {
  test("a rapid SL/TP follow-up is captured as one merged signal", async () => {
    const app = createApi({
      databasePath: ":memory:",
      seedDemoData: false,
      telegram: mockAdapter([
        { telegramMessageId: "1", messageDate: at(0), rawText: "BUY XAUUSD" },
        { telegramMessageId: "2", messageDate: at(5), rawText: "SL 2290 TP 2320" },
      ]),
      telegramPollingEnabled: false,
    });

    const providerId = await setupProvider(app);
    const run = await app.runTelegramIngestionOnce();

    // Two Telegram messages were captured, but correlation merged them into one
    // stored raw message and therefore one parsed signal.
    expect(run.captured).toBe(2);
    expect(run.inserted).toBe(1);

    const { messages } = await json<{ messages: Array<{ rawText: string }> }>(
      await app.request(`/api/providers/${providerId}/messages?limit=20`),
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]?.rawText).toContain("BUY XAUUSD");
    expect(messages[0]?.rawText).toContain("SL 2290 TP 2320");
  });

  test("messages outside the window are NOT merged", async () => {
    const app = createApi({
      databasePath: ":memory:",
      seedDemoData: false,
      telegram: mockAdapter([
        { telegramMessageId: "1", messageDate: at(0), rawText: "BUY XAUUSD" },
        { telegramMessageId: "2", messageDate: at(600), rawText: "SL 2290 TP 2320" },
      ]),
      telegramPollingEnabled: false,
    });

    await setupProvider(app);
    const run = await app.runTelegramIngestionOnce();
    expect(run.captured).toBe(2);
    expect(run.inserted).toBe(2);
  });
});

describe("operator audit trail (Task 2)", () => {
  test("approving a signal writes a signal.approve audit row tagged operator", async () => {
    const app = createApi({
      databasePath: ":memory:",
      seedDemoData: false,
      telegram: mockAdapter([]),
      telegramPollingEnabled: false,
    });
    const providerId = await setupProvider(app);

    const parsed = await json<{ parsedSignalId: string }>(
      await app.request("/api/parser/parse", {
        method: "POST",
        body: JSON.stringify({
          providerId,
          accountId: "mt5-63442826",
          rawText: "BUY XAUUSD\nSL 2290\nTP 2320",
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    await app.request(`/api/signals/${parsed.parsedSignalId}/approve`, { method: "POST" });

    const all = await json<{ logs: Array<{ eventType: string; actor: string }> }>(
      await app.request("/api/audit-logs?limit=100"),
    );
    const approve = all.logs.find((row) => row.eventType === "signal.approve");
    expect(approve).toBeDefined();
    expect(approve?.actor).toBe("operator");

    // event prefix filter
    const filtered = await json<{ logs: Array<{ eventType: string }> }>(
      await app.request("/api/audit-logs?event=signal.*"),
    );
    expect(filtered.logs.length).toBeGreaterThan(0);
    expect(filtered.logs.every((row) => row.eventType.startsWith("signal."))).toBe(true);
  });

  test("settings change is recorded in the audit feed", async () => {
    const app = createApi({
      databasePath: ":memory:",
      seedDemoData: false,
      telegram: mockAdapter([]),
      telegramPollingEnabled: false,
    });
    await app.request("/api/settings", {
      method: "PATCH",
      body: JSON.stringify({ pollSeconds: 7 }),
      headers: { "content-type": "application/json" },
    });
    const { logs } = await json<{ logs: Array<{ eventType: string; actor: string }> }>(
      await app.request("/api/audit-logs?event=settings.update"),
    );
    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0]?.actor).toBe("operator");
  });
});

describe("SSE event stream (Task 1)", () => {
  test("delivers a delta within ~1s of a state change", async () => {
    const app = createApi({
      databasePath: ":memory:",
      seedDemoData: false,
      telegram: mockAdapter([]),
      telegramPollingEnabled: false,
    });

    const res = await app.request("/api/events");
    expect(res.status).toBe(200);
    const reader = res.body?.getReader();
    expect(reader).toBeDefined();
    if (!reader) throw new Error("SSE response has no readable body");
    const decoder = new TextDecoder();

    const readChunk = async (): Promise<string> => {
      const result = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((resolve) =>
          setTimeout(() => resolve({ done: true, value: undefined }), 2000),
        ),
      ]);
      if (result.done || !result.value) return "";
      return decoder.decode(result.value);
    };

    const hello = await readChunk();
    expect(hello).toContain("event: hello");

    // Trigger a state change that emits an audit event.
    await app.request("/api/settings", {
      method: "PATCH",
      body: JSON.stringify({ pollSeconds: 9 }),
      headers: { "content-type": "application/json" },
    });

    let sawAudit = false;
    for (let i = 0; i < 12 && !sawAudit; i += 1) {
      const chunk = await readChunk();
      if (chunk.includes("event: audit")) sawAudit = true;
    }
    await reader.cancel();
    expect(sawAudit).toBe(true);
  });
});

describe("provider scoring (Task 8)", () => {
  test("10 wins + 10 losses produces a 50% win rate and amber badge", () => {
    const trades = [];
    for (let i = 0; i < 10; i += 1) trades.push({ pnl: 100, pips: 12, closeAt: at(i) });
    for (let i = 0; i < 10; i += 1) trades.push({ pnl: -50, pips: -6, closeAt: at(10 + i) });

    const score = computeProviderScore(trades);
    expect(score.winRate).toBe(0.5);
    expect(score.wins).toBe(10);
    expect(score.losses).toBe(10);
    expect(score.streakKind).toBe("loss");
    expect(score.streak).toBe(10);
    expect(score.bestTrade).toBe(100);
    expect(score.worstTrade).toBe(-50);
    expect(score.badge).toBe("amber");
  });

  test("a strong win rate above the green threshold earns a green badge", () => {
    const trades = Array.from({ length: 10 }, (_, i) => ({
      pnl: i < 8 ? 100 : -40,
      pips: i < 8 ? 10 : -4,
      closeAt: at(i),
    }));
    const score = computeProviderScore(trades);
    expect(score.winRate).toBe(0.8);
    expect(score.badge).toBe("green");
  });

  test("the score endpoint returns a neutral badge for a provider with no trades", async () => {
    const app = createApi({
      databasePath: ":memory:",
      seedDemoData: false,
      telegram: mockAdapter([]),
      telegramPollingEnabled: false,
    });
    const providerId = await setupProvider(app);
    const score = await json<{ tradeCount: number; badge: string }>(
      await app.request(`/api/providers/${providerId}/score`),
    );
    expect(score.tradeCount).toBe(0);
    expect(score.badge).toBe("neutral");

    const missing = await app.request("/api/providers/does-not-exist/score");
    expect(missing.status).toBe(404);
  });
});

describe("data export (Task 10)", () => {
  test("trades and journal endpoints return arrays; journal CSV has a header", async () => {
    const app = createApi({
      databasePath: ":memory:",
      seedDemoData: false,
      telegram: mockAdapter([]),
      telegramPollingEnabled: false,
    });
    await setupProvider(app);

    const trades = await json<{ trades: unknown[] }>(await app.request("/api/export/trades"));
    expect(Array.isArray(trades.trades)).toBe(true);

    const journal = await json<{ journal: unknown[] }>(await app.request("/api/export/journal"));
    expect(Array.isArray(journal.journal)).toBe(true);

    const csvRes = await app.request("/api/export/journal?format=csv");
    expect(csvRes.headers.get("content-type")).toContain("text/csv");
    const csv = await csvRes.text();
    expect(csv.split("\n")[0]).toContain("trade_id");
    expect(csv).toContain("realized_pnl");
  });
});

describe("volume preview (Task 7)", () => {
  test("fixed risk mode previews the configured lots directly", () => {
    const preview = computeVolumePreview({ riskMode: "fixed", riskAmount: 0.05 });
    expect(preview.lots).toBe(0.05);
    expect(preview.basis).toBe("fixed");
  });

  test("percent risk mode sizes lots from balance, SL distance and tick value", () => {
    const preview = computeVolumePreview({
      riskMode: "percent",
      riskAmount: 1, // 1% of balance
      balance: 10000,
      stopLossDistancePrice: 5, // price units
      tickSize: 0.01,
      tickValue: 1, // currency per tick per lot
    });
    // riskCurrency = 100; valuePerLot = (5 / 0.01) * 1 = 500; lots = 0.2
    expect(preview.riskCurrency).toBe(100);
    expect(preview.lots).toBe(0.2);
    expect(preview.basis).toBe("percent");
  });

  test("percent risk mode reports unavailable when broker metadata is missing", () => {
    const preview = computeVolumePreview({ riskMode: "percent", riskAmount: 1 });
    expect(preview.lots).toBeNull();
    expect(preview.basis).toBe("unavailable");
  });
});

describe("orphan reconciliation (Task 9)", () => {
  const base = {
    status: "OPEN",
    openedAtMs: 0,
    nowMs: 120_000, // 2 minutes old
    matchedInCurrentSnapshot: false,
    consecutiveMissingSnapshots: 2,
    hasCloseDealInHistory: false,
    wasExecuted: true,
  };

  test("a closed position in history transitions the trade to CLOSED", () => {
    const result = classifyReconciliation({ ...base, hasCloseDealInHistory: true });
    expect(result.action).toBe("close");
  });

  test("a never-executed trade transitions to CANCELLED", () => {
    const result = classifyReconciliation({ ...base, wasExecuted: false });
    expect(result.action).toBe("cancel");
  });

  test("an executed-but-vanished trade is flagged OUT_OF_SYNC", () => {
    const result = classifyReconciliation(base);
    expect(result.action).toBe("out_of_sync");
  });

  test("a still-matched trade is left alone", () => {
    const result = classifyReconciliation({ ...base, matchedInCurrentSnapshot: true });
    expect(result.action).toBe("none");
  });

  test("a fresh trade is not reconciled yet", () => {
    const result = classifyReconciliation({ ...base, nowMs: 30_000 });
    expect(result.action).toBe("none");
    expect(result.reason).toBe("too-fresh");
  });

  test("a single missing snapshot waits for confirmation", () => {
    const result = classifyReconciliation({ ...base, consecutiveMissingSnapshots: 1 });
    expect(result.action).toBe("none");
    expect(result.reason).toBe("needs-confirmation");
  });
});

describe("symbol metadata + unmapped alerts (Task 6)", () => {
  test("snapshot symbol metadata persists point and digits", async () => {
    const app = createApi({
      databasePath: ":memory:",
      seedDemoData: false,
      telegram: mockAdapter([]),
      telegramPollingEnabled: false,
    });
    await setupProvider(app, ["XAUUSD", "EURUSD"]);

    await app.request("/api/mt5/snapshot", {
      method: "POST",
      body: JSON.stringify({
        accountId: "mt5-63442826",
        positions: [],
        orders: [],
        symbols: [
          { symbol: "XAUUSD", bid: 2300, ask: 2300.5, point: 0.01, digits: 2 },
          { symbol: "EURUSD", bid: 1.1, ask: 1.1001, point: 0.00001, digits: 5 },
        ],
      }),
      headers: { "content-type": "application/json" },
    });

    const meta = await json<{
      symbols: Array<{ symbol: string; point: number; digits: number; pipSize: number }>;
    }>(await app.request("/api/accounts/mt5-63442826/symbol-metadata"));
    const xau = meta.symbols.find((s) => s.symbol === "XAUUSD");
    expect(xau?.point).toBe(0.01);
    expect(xau?.digits).toBe(2);
    const eur = meta.symbols.find((s) => s.symbol === "EURUSD");
    // 5-digit symbol → pip is 10 * point.
    expect(eur?.pipSize).toBeCloseTo(0.0001, 8);
  });

  test("a large broker instrument catalog does NOT raise an unmapped-symbols alert", async () => {
    const app = createApi({
      databasePath: ":memory:",
      seedDemoData: false,
      telegram: mockAdapter([]),
      telegramPollingEnabled: false,
    });
    // A real broker advertises hundreds of CFDs/indices the operator never trades.
    const catalog = ["XAUUSD", ...Array.from({ length: 200 }, (_, i) => `BROKERCFD${i}`)];
    await setupProvider(app, catalog);

    const dash = await json<{ alerts: Array<{ kind: string }> }>(
      await app.request("/api/dashboard"),
    );
    expect(dash.alerts.find((a) => a.kind === "unmapped-symbols")).toBeUndefined();
  });

  test("a provider symbol that can't be mapped raises an alert that clears once mapped", async () => {
    const app = createApi({
      databasePath: ":memory:",
      seedDemoData: false,
      telegram: mockAdapter([]),
      telegramPollingEnabled: false,
    });
    const providerId = await setupProvider(app, ["XAUUSD"]);

    const parsed = await json<{
      result?: { rawSymbol?: string; mappingStatus?: string; commandType?: string };
    }>(
      await app.request("/api/parser/parse", {
        method: "POST",
        body: JSON.stringify({
          providerId,
          accountId: "mt5-63442826",
          rawText: "SELL US30 SL 35000 TP 34000",
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    const symbol = parsed.result?.rawSymbol;
    // Precondition: the parser extracted an unmappable symbol from this signal.
    expect(symbol).toBeTruthy();
    expect(parsed.result?.mappingStatus).not.toBe("mapped");

    const before = await json<{ alerts: Array<{ kind: string; detail?: { symbols?: string[] } }> }>(
      await app.request("/api/dashboard"),
    );
    const alert = before.alerts.find((a) => a.kind === "unmapped-symbols");
    expect(alert).toBeDefined();
    expect(alert?.detail?.symbols).toContain(symbol);

    // Once the broker symbol becomes available (operator maps/adds it), the
    // symbol resolves and the alert clears.
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
        availableSymbols: ["XAUUSD", symbol],
      }),
      headers: { "content-type": "application/json" },
    });

    const after = await json<{ alerts: Array<{ kind: string }> }>(
      await app.request("/api/dashboard"),
    );
    expect(after.alerts.find((a) => a.kind === "unmapped-symbols")).toBeUndefined();
  });
});

describe("adaptive parser learning (Task 5)", () => {
  test("structuralFingerprint strips numeric levels", () => {
    expect(structuralFingerprint("BUY XAUUSD SL 2290 TP 2320")).toBe("BUY XAUUSD SL # TP #");
    expect(structuralFingerprint("buy  xauusd   sl 2310")).toBe("BUY XAUUSD SL #");
  });

  test("learnedOverrideApplies only for mapped open trades with >=3 examples", () => {
    expect(learnedOverrideApplies({ commandType: "OPEN_TRADE", mappingStatus: "mapped" }, 3)).toBe(
      true,
    );
    expect(learnedOverrideApplies({ commandType: "OPEN_TRADE", mappingStatus: "mapped" }, 2)).toBe(
      false,
    );
    expect(
      learnedOverrideApplies({ commandType: "OPEN_TRADE", mappingStatus: "unmapped" }, 5),
    ).toBe(false);
    expect(learnedOverrideApplies({ commandType: "CLOSE_TRADE", mappingStatus: "mapped" }, 5)).toBe(
      false,
    );
  });

  test("operator approvals accumulate learned patterns that reset clears", async () => {
    const app = createApi({
      databasePath: ":memory:",
      seedDemoData: false,
      telegram: mockAdapter([]),
      telegramPollingEnabled: false,
    });
    const providerId = await setupProvider(app, ["XAUUSD"]);
    const headers = { "content-type": "application/json" };

    const pushSignal = (sl: number) =>
      app.request("/api/signals/manual", {
        method: "POST",
        body: JSON.stringify({
          providerId,
          accountId: "mt5-63442826",
          direction: "BUY",
          brokerSymbol: "XAUUSD",
          canonicalSymbol: "XAUUSD",
          orderType: "MARKET",
          stopLoss: sl,
          rawText: `BUY XAUUSD SL ${sl}`,
        }),
        headers,
      });

    // Two approvals of the same structure are not yet a learned pattern.
    expect((await pushSignal(2290)).ok).toBe(true);
    expect((await pushSignal(2310)).ok).toBe(true);
    let score = await json<{ learnedPatterns: number }>(
      await app.request(`/api/providers/${providerId}/score`),
    );
    expect(score.learnedPatterns).toBe(0);

    // A third approval of the same number-stripped structure makes it a pattern.
    expect((await pushSignal(2350)).ok).toBe(true);
    score = await json<{ learnedPatterns: number }>(
      await app.request(`/api/providers/${providerId}/score`),
    );
    expect(score.learnedPatterns).toBe(1);

    // Reset clears learned examples.
    const reset = await json<{ cleared: number }>(
      await app.request(`/api/providers/${providerId}/learning`, { method: "DELETE" }),
    );
    expect(reset.cleared).toBe(3);
    score = await json<{ learnedPatterns: number }>(
      await app.request(`/api/providers/${providerId}/score`),
    );
    expect(score.learnedPatterns).toBe(0);
  });
});

describe("self-healing reconciliation audit (Task 9)", () => {
  test("an OPEN trade that vanishes from snapshots transitions and is audited", async () => {
    const app = createApi({
      databasePath: ":memory:",
      seedDemoData: true,
      telegramPollingEnabled: false,
    });
    const headers = { "content-type": "application/json" };

    // Establish the seeded demo trade as OPEN/matched to a broker position.
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
      headers,
    });

    // Now the position disappears → reconciliation transitions the trade.
    await app.request("/api/mt5/snapshot", {
      method: "POST",
      body: JSON.stringify({ accountId: "mt5-100200300", positions: [], orders: [], symbols: [] }),
      headers,
    });

    const dash = await json<{ logicalTrades: Array<{ id: string; status: string }> }>(
      await app.request("/api/dashboard"),
    );
    expect(dash.logicalTrades.find((t) => t.id === "trade-demo-1")?.status).toBe("OUT_OF_SYNC");

    const { logs } = await json<{
      logs: Array<{ eventType: string; data: { to?: string } }>;
    }>(await app.request("/api/audit-logs?event=logical-trade.*"));
    const reconciled = logs.find(
      (row) => row.eventType === "logical-trade.reconciled" && row.data.to === "OUT_OF_SYNC",
    );
    expect(reconciled).toBeDefined();
  });
});

describe("provider score breach alert (Task 8)", () => {
  test("a red badge with enough trades produces a breach alert", () => {
    const losing = Array.from({ length: 8 }, (_, i) => ({ pnl: -50, pips: -5, closeAt: at(i) }));
    const score = computeProviderScore(losing);
    expect(score.badge).toBe("red");
    const alert = providerScoreAlert("KAL VIP", score);
    expect(alert).not.toBeNull();
    expect(alert?.message).toContain("KAL VIP");
    expect(alert?.message).toContain("0%");
  });

  test("a healthy provider produces no breach alert", () => {
    const winning = Array.from({ length: 8 }, (_, i) => ({ pnl: 50, pips: 5, closeAt: at(i) }));
    expect(providerScoreAlert("Alpha", computeProviderScore(winning))).toBeNull();
  });

  test("too few trades produces no breach alert even if losing", () => {
    const few = Array.from({ length: 3 }, (_, i) => ({ pnl: -50, pips: -5, closeAt: at(i) }));
    expect(providerScoreAlert("New", computeProviderScore(few))).toBeNull();
  });
});
