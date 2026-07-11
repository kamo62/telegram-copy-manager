import { describe, expect, test } from "bun:test";
import { createApi, isTelegramDeadSessionError } from "./app";
import type { TelegramAdapter } from "./telegram";

const json = async <T>(response: Response) => (await response.json()) as T;

interface StatusSnapshot {
  connected: boolean;
  telegramSessions: Array<{ id: string; status: string }>;
}

// Adapter that logs in fine, then fails every poll with a configurable error.
// `disconnectedSessions` records which sessions the store asked to tear down,
// proving the dead client (and its session file) gets dropped on reconciliation.
function createFailingPollAdapter(pollError: Error) {
  const disconnectedSessions: string[] = [];
  const adapter: TelegramAdapter = {
    name: "gramjs",
    async startLogin() {
      return { status: "CODE_REQUIRED" as const };
    },
    async submitCode() {
      return { status: "CONNECTED" as const };
    },
    async submitPassword() {
      return { status: "CONNECTED" as const };
    },
    async disconnect(sessionId: string) {
      disconnectedSessions.push(sessionId);
    },
    async listDialogs() {
      return [
        { id: "dialog-btc", title: "Dead Session Group", type: "group" as const, unreadCount: 0 },
      ];
    },
    async fetchRecentMessages() {
      throw pollError;
    },
  };
  return { adapter, disconnectedSessions };
}

async function connectAndEnableProvider(app: ReturnType<typeof createApi>) {
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
      body: JSON.stringify({ profileId: started.profileId, dialogId: "dialog-btc" }),
      headers: { "content-type": "application/json" },
    }),
  );
  await app.request(`/api/providers/${selected.provider.id}`, {
    method: "PATCH",
    body: JSON.stringify({ enabled: true }),
    headers: { "content-type": "application/json" },
  });
  return started.sessionId;
}

describe("isTelegramDeadSessionError", () => {
  test("matches fatal auth-key errors, ignores transient ones", () => {
    expect(isTelegramDeadSessionError(new Error("AUTH_KEY_UNREGISTERED"))).toBe(true);
    expect(
      isTelegramDeadSessionError(new Error("401: AUTH_KEY_UNREGISTERED (caused by ...)")),
    ).toBe(true);
    expect(isTelegramDeadSessionError(new Error("SESSION_REVOKED"))).toBe(true);
    expect(isTelegramDeadSessionError(new Error("USER_DEACTIVATED_BAN"))).toBe(true);
    // Transient failures must NOT be treated as a dead session.
    expect(isTelegramDeadSessionError(new Error("TIMEOUT"))).toBe(false);
    expect(isTelegramDeadSessionError(new Error("ECONNRESET"))).toBe(false);
    expect(isTelegramDeadSessionError(new Error("Connection closed"))).toBe(false);
  });
});

describe("dead Telegram session reconciliation", () => {
  test("a dead auth key flips the session to DISCONNECTED so the login form returns", async () => {
    const { adapter, disconnectedSessions } = createFailingPollAdapter(
      new Error("401: AUTH_KEY_UNREGISTERED (caused by messages.GetHistory)"),
    );
    const app = createApi({
      databasePath: ":memory:",
      seedDemoData: false,
      telegram: adapter,
      telegramPollingEnabled: false,
    });
    const sessionId = await connectAndEnableProvider(app);

    const before = await json<StatusSnapshot>(await app.request("/api/telegram/status"));
    expect(before.connected).toBe(true);

    await app.runTelegramIngestionOnce();

    const after = await json<StatusSnapshot>(await app.request("/api/telegram/status"));
    expect(after.connected).toBe(false);
    expect(after.telegramSessions.find((s) => s.id === sessionId)?.status).toBe("DISCONNECTED");
    // The dead client must be torn down (this also removes the session file).
    expect(disconnectedSessions).toContain(sessionId);
  });

  test("a transient poll error leaves a live session CONNECTED", async () => {
    const { adapter, disconnectedSessions } = createFailingPollAdapter(new Error("TIMEOUT"));
    const app = createApi({
      databasePath: ":memory:",
      seedDemoData: false,
      telegram: adapter,
      telegramPollingEnabled: false,
    });
    await connectAndEnableProvider(app);

    await app.runTelegramIngestionOnce();

    const after = await json<StatusSnapshot>(await app.request("/api/telegram/status"));
    expect(after.connected).toBe(true);
    expect(disconnectedSessions).toHaveLength(0);
  });
});
