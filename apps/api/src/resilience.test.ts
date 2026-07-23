import { describe, expect, test } from "bun:test";
import { createApi } from "./app";
import { parseConnectionRetries, parseReconnectRetryDelay } from "./telegram";

const json = async <T>(response: Response) => (await response.json()) as T;

// Stand up an in-memory API, connect a (mock) Telegram session, create one
// enabled provider bound to a freshly registered account, and approve a parsed
// signal so there is a PENDING queue item for the account. Returns the ids.
async function setupAccountWithQueuedSignal(app: ReturnType<typeof createApi>) {
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
        dialogId: "dialog-gold",
        title: "Gold Room",
      }),
      headers: { "content-type": "application/json" },
    }),
  );
  await app.request(`/api/providers/${selected.provider.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      enabled: true,
      riskMode: "fixed",
      riskAmount: 0.04,
      takeProfitLevels: [
        { leg: 1, percentage: 50, strategy: { kind: "set-sl-to-entry", offsetPips: 0 } },
        { leg: 2, percentage: 50, strategy: { kind: "no-change" } },
      ],
    }),
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
  const parsed = await json<{ parsedSignalId: string }>(
    await app.request("/api/parser/parse", {
      method: "POST",
      body: JSON.stringify({
        providerId: selected.provider.id,
        accountId: "mt5-63442826",
        rawText: "Gold buy limit\n\n4541-40\n\nSL 4535\n\nTP 4546\nTP 4553",
      }),
      headers: { "content-type": "application/json" },
    }),
  );
  const approval = await json<{ queueItemId: string }>(
    await app.request(`/api/signals/${parsed.parsedSignalId}/approve`, { method: "POST" }),
  );
  return { accountId: "mt5-63442826", queueItemId: approval.queueItemId };
}

describe("telegram reconnect resilience helpers", () => {
  test("parseConnectionRetries keeps auto-reconnect attempts unbounded by default", () => {
    expect(parseConnectionRetries(undefined)).toBe(Number.POSITIVE_INFINITY);
    expect(parseConnectionRetries("")).toBe(Number.POSITIVE_INFINITY);
    expect(parseConnectionRetries("0")).toBe(Number.POSITIVE_INFINITY);
    expect(parseConnectionRetries("-4")).toBe(Number.POSITIVE_INFINITY);
    expect(parseConnectionRetries("abc")).toBe(Number.POSITIVE_INFINITY);
  });

  test("parseConnectionRetries honours an explicit positive override", () => {
    expect(parseConnectionRetries("20")).toBe(20);
    expect(parseConnectionRetries("2")).toBe(2);
  });

  test("reconnect delay has a ceiling", () => {
    expect(parseReconnectRetryDelay(undefined)).toBe(2000);
    expect(parseReconnectRetryDelay("250")).toBe(250);
    expect(parseReconnectRetryDelay("60000")).toBe(10000);
    expect(parseReconnectRetryDelay("invalid")).toBe(2000);
  });
});

describe("MT5 account hard delete", () => {
  test("removes the account and cascades its scoped rows", async () => {
    const app = createApi({
      databasePath: ":memory:",
      seedDemoData: false,
      telegramPollingEnabled: false,
    });
    const { accountId } = await setupAccountWithQueuedSignal(app);
    // Latch a guardian so we can prove the equity_guardians row is dropped too.
    await app.request(`/api/equity-guardian/${accountId}`, {
      method: "PATCH",
      body: JSON.stringify({ threshold: 10, paused: true }),
      headers: { "content-type": "application/json" },
    });

    const before = await json<{
      mt5Accounts: Array<{ id: string }>;
      signalQueue: Array<{ status: string }>;
      equityGuardians: Array<{ accountId: string }>;
    }>(await app.request("/api/dashboard"));
    expect(before.mt5Accounts.map((a) => a.id)).toContain(accountId);
    expect(before.signalQueue.length).toBeGreaterThan(0);
    expect(before.equityGuardians.map((g) => g.accountId)).toContain(accountId);

    const deleted = await app.request(`/api/mt5/accounts/${accountId}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);
    expect(await json<{ status: string }>(deleted)).toMatchObject({ status: "DELETED" });

    const after = await json<{
      mt5Accounts: Array<{ id: string }>;
      signalQueue: Array<{ status: string }>;
      equityGuardians: Array<{ accountId: string }>;
    }>(await app.request("/api/dashboard"));
    expect(after.mt5Accounts.map((a) => a.id)).not.toContain(accountId);
    expect(after.signalQueue).toHaveLength(0);
    expect(after.equityGuardians.map((g) => g.accountId)).not.toContain(accountId);
  });

  test("returns 404 for an unknown account", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: false });
    const response = await app.request("/api/mt5/accounts/mt5-does-not-exist", {
      method: "DELETE",
    });
    expect(response.status).toBe(404);
  });

  test("renames an account and exposes the nickname in the account DTO", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: false });
    const accountId = await registerAccount(app, "700800900");

    const renamed = await app.request(`/api/mt5/accounts/${accountId}`, {
      method: "PATCH",
      body: JSON.stringify({ nickname: "Primary gold" }),
      headers: { "content-type": "application/json" },
    });
    expect(renamed.status).toBe(200);
    expect(await json<{ account: { nickname: string } }>(renamed)).toMatchObject({
      account: { nickname: "Primary gold" },
    });

    const listed = await json<{ accounts: Array<{ id: string; nickname: string }> }>(
      await app.request("/api/mt5/accounts"),
    );
    expect(listed.accounts.find((account) => account.id === accountId)?.nickname).toBe(
      "Primary gold",
    );

    const cleared = await app.request(`/api/mt5/accounts/${accountId}`, {
      method: "PATCH",
      body: JSON.stringify({ nickname: "   " }),
      headers: { "content-type": "application/json" },
    });
    expect(cleared.status).toBe(200);
    expect(await json<{ account: { nickname: string | null } }>(cleared)).toMatchObject({
      account: { nickname: null },
    });
  });
});

async function registerAccount(app: ReturnType<typeof createApi>, accountNumber = "63442826") {
  await app.request("/api/mt5/register", {
    method: "POST",
    body: JSON.stringify({
      accountNumber,
      server: "OctaFX-Real",
      company: "OctaFX",
      currency: "USD",
      balance: 10000,
      equity: 10000,
      marginMode: "HEDGING",
      availableSymbols: ["XAUUSD", "GOLD"],
    }),
    headers: { "content-type": "application/json" },
  });
  return `mt5-${accountNumber}`;
}

describe("manual force-push", () => {
  test("queues a manually composed signal to the target account", async () => {
    const app = createApi({
      databasePath: ":memory:",
      seedDemoData: false,
      telegramPollingEnabled: false,
    });
    const accountId = await registerAccount(app);
    const res = await app.request("/api/signals/manual", {
      method: "POST",
      body: JSON.stringify({
        accountId,
        direction: "SELL",
        orderType: "LIMIT",
        brokerSymbol: "GOLD",
        entry: { from: 4214, to: 4215 },
        stopLoss: 4220,
        takeProfits: [{ price: 4209 }, { price: 4202 }],
        volume: 0.02,
      }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(200);
    const body = await json<{ status: string; queueItemId: string }>(res);
    expect(body.status).toBe("PENDING");
    expect(body.queueItemId).toBeTruthy();

    const dash = await json<{ signalQueue: Array<{ status: string; symbol: string }> }>(
      await app.request("/api/dashboard"),
    );
    const pending = dash.signalQueue.find((q) => q.status === "PENDING");
    expect(pending).toBeTruthy();
    expect(pending?.symbol).toBe("GOLD");
  });

  test("rejects a duplicate manual force-push within the retry window", async () => {
    const app = createApi({
      databasePath: ":memory:",
      seedDemoData: false,
      telegramPollingEnabled: false,
    });
    const accountId = await registerAccount(app);
    const body = {
      accountId,
      direction: "BUY",
      orderType: "MARKET",
      brokerSymbol: "GOLD",
      stopLoss: 4100,
      takeProfits: [{ price: 4200 }],
      volume: 0.01,
    };
    expect(
      (
        await app.request("/api/signals/manual", {
          method: "POST",
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request("/api/signals/manual", {
          method: "POST",
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
        })
      ).status,
    ).toBe(409);
    const dashboard = await json<{ signalQueue: unknown[] }>(await app.request("/api/dashboard"));
    expect(dashboard.signalQueue).toHaveLength(1);
  });

  test("deduplicates manual force-pushes for 10 seconds by provider and raw-message identity", async () => {
    const app = createApi({
      databasePath: ":memory:",
      seedDemoData: false,
      telegramPollingEnabled: false,
    });
    const accountId = await registerAccount(app);
    const body = {
      accountId,
      direction: "BUY" as const,
      orderType: "MARKET" as const,
      brokerSymbol: "GOLD",
      stopLoss: 4100,
      takeProfits: [{ price: 4200 }],
      volume: 0.01,
      providerId: "provider-one",
      rawMessageId: "message-one",
    };
    const push = (input = body) =>
      app.request("/api/signals/manual", {
        method: "POST",
        body: JSON.stringify(input),
        headers: { "content-type": "application/json" },
      });
    expect((await push()).status).toBe(200);
    expect((await push()).status).toBe(409);
    expect(
      (await push({ ...body, providerId: "provider-two", rawMessageId: "message-two" })).status,
    ).toBe(200);
  });

  test("a paused Equity Guardian still blocks a manual push at lease time", async () => {
    const app = createApi({
      databasePath: ":memory:",
      seedDemoData: false,
      telegramPollingEnabled: false,
    });
    const accountId = await registerAccount(app);
    await app.request(`/api/equity-guardian/${accountId}`, {
      method: "PATCH",
      body: JSON.stringify({ threshold: 10, paused: true }),
      headers: { "content-type": "application/json" },
    });
    await app.request("/api/signals/manual", {
      method: "POST",
      body: JSON.stringify({
        accountId,
        direction: "BUY",
        orderType: "MARKET",
        brokerSymbol: "GOLD",
        stopLoss: 4100,
        takeProfits: [{ price: 4200 }],
        volume: 0.01,
      }),
      headers: { "content-type": "application/json" },
    });

    // The EA poll leases pending work; a paused guardian rejects the open trade.
    const poll = await json<{ item: unknown }>(
      await app.request(`/api/mt5/poll?accountId=${accountId}`),
    );
    expect(poll.item).toBeNull();
    const dash = await json<{ signalQueue: Array<{ status: string }> }>(
      await app.request("/api/dashboard"),
    );
    expect(dash.signalQueue.some((q) => q.status === "HELD")).toBe(true);
    expect(dash.signalQueue.some((q) => q.status === "PENDING")).toBe(false);
  });

  test("rejects an unknown account and a limit order without an entry", async () => {
    const app = createApi({ databasePath: ":memory:", seedDemoData: false });
    const accountId = await registerAccount(app);
    const unknown = await app.request("/api/signals/manual", {
      method: "POST",
      body: JSON.stringify({ accountId: "mt5-nope", direction: "BUY", brokerSymbol: "GOLD" }),
      headers: { "content-type": "application/json" },
    });
    expect(unknown.status).toBe(404);
    const noEntry = await app.request("/api/signals/manual", {
      method: "POST",
      body: JSON.stringify({
        accountId,
        direction: "BUY",
        orderType: "LIMIT",
        brokerSymbol: "GOLD",
      }),
      headers: { "content-type": "application/json" },
    });
    expect(noEntry.status).toBe(422);
  });
});

describe("operational alerts", () => {
  test("surfaces a paused Equity Guardian and clears it on unpause", async () => {
    const app = createApi({
      databasePath: ":memory:",
      seedDemoData: false,
      telegramPollingEnabled: false,
    });
    const { accountId } = await setupAccountWithQueuedSignal(app);

    await app.request(`/api/equity-guardian/${accountId}`, {
      method: "PATCH",
      body: JSON.stringify({ threshold: 10, paused: true }),
      headers: { "content-type": "application/json" },
    });

    const paused = await json<{ alerts: Array<{ kind: string; accountId?: string }> }>(
      await app.request("/api/dashboard"),
    );
    expect(
      paused.alerts.some(
        (alert) => alert.kind === "guardian-paused" && alert.accountId === accountId,
      ),
    ).toBe(true);

    await app.request(`/api/equity-guardian/${accountId}/unpause`, { method: "POST" });

    const resumed = await json<{ alerts: Array<{ kind: string }> }>(
      await app.request("/api/dashboard"),
    );
    expect(resumed.alerts.some((alert) => alert.kind === "guardian-paused")).toBe(false);
  });
});
