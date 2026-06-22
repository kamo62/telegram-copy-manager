import { describe, expect, test } from "bun:test";
import { createApi } from "./app";
import { clientLooksDead, parseConnectionRetries } from "./telegram";

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
  test("parseConnectionRetries restores the gramjs Infinity default when unset or invalid", () => {
    expect(parseConnectionRetries(undefined)).toBe(Number.POSITIVE_INFINITY);
    expect(parseConnectionRetries("")).toBe(Number.POSITIVE_INFINITY);
    expect(parseConnectionRetries("0")).toBe(Number.POSITIVE_INFINITY);
    expect(parseConnectionRetries("-4")).toBe(Number.POSITIVE_INFINITY);
    expect(parseConnectionRetries("abc")).toBe(Number.POSITIVE_INFINITY);
  });

  test("parseConnectionRetries honours an explicit positive override", () => {
    expect(parseConnectionRetries("5")).toBe(5);
    expect(parseConnectionRetries("20")).toBe(20);
  });

  test("clientLooksDead flags only an explicitly disconnected handle", () => {
    expect(clientLooksDead({ disconnected: true })).toBe(true);
    expect(clientLooksDead({ disconnected: false })).toBe(false);
    // The unreliable gramjs `connected` getter must NOT drive liveness — reviving
    // on it caused a reconnect storm — so an unknown handle is not treated as dead.
    expect(clientLooksDead({})).toBe(false);
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
