import { describe, expect, test } from "bun:test";
import { createApi } from "./app";
import type { TelegramAdapter, TelegramFetchResult } from "./telegram";

const json = async <T>(response: Response) => (await response.json()) as T;

const RPC_TIMEOUT_MS = 50;
// Generous next to the 50ms RPC timeout, tight enough that a request which
// never settles fails the test instead of wedging the suite.
const SETTLE_BUDGET_MS = 2_000;

type StoredMessage = {
  id: string;
  telegramMessageId: string;
  rawText: string;
};

type AdapterMode = "healthy" | "throw" | "hang";

/**
 * A gramjs-named adapter whose fetch behaviour is switched from the test body.
 * Nothing here reaches into adapter internals: the route only ever sees the
 * public `fetchRecentMessages` contract.
 */
function switchableAdapter(state: { mode: AdapterMode; calls: number }): TelegramAdapter {
  const live = [
    {
      telegramMessageId: "1001",
      messageDate: new Date(Date.now() + 60_000).toISOString(),
      rawText: "BUY XAUUSD 2300 SL 2290 TP 2320",
    },
  ];
  return {
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
    async disconnect() {},
    async listDialogs() {
      return [];
    },
    fetchRecentMessages(): Promise<TelegramFetchResult> {
      state.calls += 1;
      if (state.mode === "throw") return Promise.reject(new Error("teleproto RPC failed"));
      // A wedged client: the RPC is issued and simply never comes back.
      if (state.mode === "hang") return new Promise<TelegramFetchResult>(() => {});
      return Promise.resolve({ messages: live, gap: undefined });
    },
    sessionHealth(sessionId) {
      return { sessionId, connected: true, stalled: false };
    },
  };
}

async function settleWithin<T>(label: string, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} did not settle within ${SETTLE_BUDGET_MS}ms`)),
      SETTLE_BUDGET_MS,
    );
  });
  try {
    return await Promise.race([work, guard]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function connectedProvider(telegram: TelegramAdapter) {
  const app = createApi({
    databasePath: ":memory:",
    seedDemoData: false,
    telegram,
    telegramPollingEnabled: false,
    telegramRpcTimeoutMs: RPC_TIMEOUT_MS,
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
  const { provider } = await json<{ provider: { id: string } }>(
    await app.request("/api/providers", {
      method: "POST",
      body: JSON.stringify({
        profileId: started.profileId,
        dialogId: "dialog-wedged",
        title: "Wedged Channel",
      }),
      headers: { "content-type": "application/json" },
    }),
  );
  return { app, providerId: provider.id };
}

const readMessages = (app: ReturnType<typeof createApi>, providerId: string, label: string) =>
  settleWithin(label, app.request(`/api/providers/${providerId}/messages?limit=20`));

const lastMessageAt = async (app: ReturnType<typeof createApi>, providerId: string) => {
  const listed = await json<{ providers: Array<{ id: string; lastMessageAt: string }> }>(
    await app.request("/api/providers"),
  );
  return listed.providers.find((provider) => provider.id === providerId)!.lastMessageAt;
};

describe("GET /api/providers/:id/messages against a wedged Telegram client", () => {
  test(
    "a never-settling fetch returns the same payload a thrown fetch returns",
    async () => {
      const state = { mode: "healthy" as AdapterMode, calls: 0 };
      const { app, providerId } = await connectedProvider(switchableAdapter(state));

      // Seed the store so an empty payload is distinguishable from the stored
      // fallback: a bug that quietly served cached rows would show up here.
      const seeded = await json<{ messages: StoredMessage[] }>(
        await readMessages(app, providerId, "healthy seed request"),
      );
      expect(seeded.messages.map((message) => message.telegramMessageId)).toEqual(["1001"]);
      const capturedWatermark = await lastMessageAt(app, providerId);

      state.mode = "throw";
      const thrown = await readMessages(app, providerId, "throwing fetch request");
      const thrownBody = await json<{ messages: StoredMessage[] }>(thrown);

      state.mode = "hang";
      const callsBeforeHang = state.calls;
      const hung = await readMessages(app, providerId, "wedged fetch request");
      const hungBody = await json<{ messages: StoredMessage[] }>(hung);

      // The RPC really was issued, so the timeout is what ended the request.
      expect(state.calls).toBe(callsBeforeHang + 1);
      expect(hung.status).toBe(thrown.status);
      expect(hungBody).toEqual(thrownBody);
      expect(hungBody).toEqual({ messages: [] });
      // Neither degraded path may touch the capture watermark.
      expect(await lastMessageAt(app, providerId)).toBe(capturedWatermark);
    },
    SETTLE_BUDGET_MS * 4,
  );

  test(
    "a healthy fetch still captures and returns the live messages",
    async () => {
      const state = { mode: "healthy" as AdapterMode, calls: 0 };
      const { app, providerId } = await connectedProvider(switchableAdapter(state));

      const body = await json<{ messages: StoredMessage[] }>(
        await readMessages(app, providerId, "healthy request"),
      );
      expect(state.calls).toBe(1);
      expect(body.messages).toHaveLength(1);
      expect(body.messages[0]!.rawText).toBe("BUY XAUUSD 2300 SL 2290 TP 2320");

      // Captured, not just echoed: the watermark advanced and the row survives
      // a read taken while the client is wedged.
      const watermark = await lastMessageAt(app, providerId);
      expect(Date.parse(watermark)).toBeGreaterThan(0);

      state.mode = "hang";
      const degraded = await json<{ messages: StoredMessage[] }>(
        await readMessages(app, providerId, "wedged request after healthy capture"),
      );
      expect(degraded).toEqual({ messages: [] });
      expect(await lastMessageAt(app, providerId)).toBe(watermark);
    },
    SETTLE_BUDGET_MS * 4,
  );
});
