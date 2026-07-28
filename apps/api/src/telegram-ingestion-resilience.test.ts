import { describe, expect, test } from "bun:test";
import { createApi } from "./app";
import type { TelegramAdapter, TelegramFetchOptions, TelegramFetchResult } from "./telegram";

const json = async <T>(response: Response) => (await response.json()) as T;

function adapter(
  fetchRecentMessages: (
    _sessionId: string,
    dialogId: string,
    limit: number,
    options?: TelegramFetchOptions,
  ) => Promise<TelegramFetchResult>,
): TelegramAdapter {
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
    fetchRecentMessages,
    sessionHealth(sessionId) {
      return { sessionId, connected: true, stalled: false };
    },
  };
}

async function enableProviders(app: ReturnType<typeof createApi>) {
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
  for (const [dialogId, title] of [
    ["dialog-stuck", "A Stuck"],
    ["dialog-slow", "B Slow"],
  ]) {
    const { provider } = await json<{ provider: { id: string } }>(
      await app.request("/api/providers", {
        method: "POST",
        body: JSON.stringify({ profileId: started.profileId, dialogId, title }),
        headers: { "content-type": "application/json" },
      }),
    );
    await app.request(`/api/providers/${provider.id}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: true }),
      headers: { "content-type": "application/json" },
    });
  }
}

describe("Telegram ingestion resilience", () => {
  test("drains a resumable backlog without starving live messages or regressing its watermark", async () => {
    const startedAt = Date.now();
    const message = (id: number) => ({
      telegramMessageId: String(id),
      messageDate: new Date(startedAt + id * 60_000).toISOString(),
      rawText: `BUY XAUUSD ${id}`,
    });
    let livePasses = 0;
    const app = createApi({
      databasePath: ":memory:",
      seedDemoData: false,
      telegram: adapter(async (_sessionId, dialogId, _limit, options) => {
        if (dialogId === "dialog-slow") return { messages: [], gap: undefined };
        if (!options?.offsetId) {
          livePasses += 1;
          if (livePasses === 1) {
            return {
              messages: [message(6), message(5)],
              gap: {
                fromIso: new Date(startedAt - 1_000).toISOString(),
                toIso: message(5).messageDate,
                reason: "time-cap",
                resumeOffsetId: "5",
              },
            };
          }
          return livePasses === 2
            ? { messages: [message(7)], gap: undefined }
            : { messages: [], gap: undefined };
        }
        if (options.offsetId === "5") {
          return {
            messages: [message(4), message(3)],
            gap: {
              fromIso: new Date(startedAt - 1_000).toISOString(),
              toIso: message(3).messageDate,
              reason: "time-cap",
              resumeOffsetId: "3",
            },
          };
        }
        return { messages: [message(2), message(1)], gap: undefined };
      }),
      telegramPollingEnabled: false,
      telegramRpcTimeoutMs: 100,
    });
    await enableProviders(app);

    const first = await app.runTelegramIngestionOnce();
    const afterFirst = await json<{
      providers: Array<{
        id: string;
        dialogId: string;
        backfillCursorId?: string;
        lastMessageAt: string;
      }>;
    }>(await app.request("/api/providers"));
    const firstProvider = afterFirst.providers.find(
      (provider) => provider.dialogId === "dialog-stuck",
    )!;
    expect(first).toMatchObject({ captured: 4 });
    expect(firstProvider).toMatchObject({
      backfillCursorId: "3",
      lastMessageAt: message(6).messageDate,
    });

    const second = await app.runTelegramIngestionOnce();
    const afterSecond = await json<{
      providers: Array<{
        id: string;
        dialogId: string;
        backfillCursorId?: string;
        lastMessageAt: string;
      }>;
    }>(await app.request("/api/providers"));
    const secondProvider = afterSecond.providers.find(
      (provider) => provider.dialogId === "dialog-stuck",
    )!;
    expect(second).toMatchObject({ captured: 3 });
    expect(secondProvider.backfillCursorId).toBeUndefined();
    expect(secondProvider.lastMessageAt).toBe(message(7).messageDate);

    const stored = await json<{ messages: Array<{ telegramMessageId: string }> }>(
      await app.request(`/api/providers/${firstProvider.id}/messages?limit=20`),
    );
    expect(stored.messages.map((item) => item.telegramMessageId).sort()).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
    ]);
    const completed = await json<{ logs: Array<{ data: { providerId: string } }> }>(
      await app.request("/api/audit-logs?event=telegram.ingest.backfill-complete"),
    );
    expect(completed.logs).toHaveLength(1);
  });

  test("waits for an active ingestion run before stopping", async () => {
    const releases: Array<() => void> = [];
    let started: (() => void) | undefined;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    const app = createApi({
      databasePath: ":memory:",
      seedDemoData: false,
      telegram: adapter(
        async () =>
          await new Promise<TelegramFetchResult>((resolve) => {
            started?.();
            releases.push(() => resolve({ messages: [], gap: undefined }));
          }),
      ),
      telegramPollingEnabled: false,
    });
    await enableProviders(app);

    const run = app.runTelegramIngestionOnce();
    await began;
    let stopped = false;
    const stop = app.stopTelegramIngestion().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stopped).toBe(false);

    for (const release of releases) release();
    await Promise.all([run, stop]);
    expect(stopped).toBe(true);
  });

  test("marks a provider stalled only after consecutive timed-out ingestions", async () => {
    let fastCalls = 0;
    const app = createApi({
      databasePath: ":memory:",
      seedDemoData: false,
      telegram: adapter(async (_sessionId, dialogId) => {
        if (dialogId === "dialog-stuck") return await new Promise<TelegramFetchResult>(() => {});
        fastCalls += 1;
        return { messages: [], gap: undefined };
      }),
      telegramPollingEnabled: false,
      telegramRpcTimeoutMs: 10,
    });
    await enableProviders(app);

    const first = await app.runTelegramIngestionOnce();
    const dashboardAfterFirst = await json<{
      telegramProviderHealth: Array<{ stalled: boolean; consecutiveFailures: number }>;
    }>(await app.request("/api/dashboard"));
    const result = await app.runTelegramIngestionOnce();

    expect(fastCalls).toBe(2);
    expect(first).toMatchObject({ providers: 2, errors: 1 });
    expect(
      dashboardAfterFirst.telegramProviderHealth.some(
        (health) => !health.stalled && health.consecutiveFailures === 1,
      ),
    ).toBe(true);
    expect(result).toMatchObject({ providers: 2, errors: 1 });
    const dashboard = await json<{
      telegramProviderHealth: Array<{ stalled: boolean; error?: string }>;
    }>(await app.request("/api/dashboard"));
    expect(
      dashboard.telegramProviderHealth.some(
        (health) => health.stalled && health.error === "Telegram RPC timed out after 10ms",
      ),
    ).toBe(true);
  });

  test("a slow RPC that recovers does not raise an error-level provider stall", async () => {
    let attempts = 0;
    const app = createApi({
      databasePath: ":memory:",
      seedDemoData: false,
      telegram: adapter(async (_sessionId, dialogId) => {
        if (dialogId === "dialog-stuck" && attempts++ === 0) {
          return await new Promise<TelegramFetchResult>((resolve) =>
            setTimeout(() => resolve({ messages: [], gap: undefined }), 20),
          );
        }
        return { messages: [], gap: undefined };
      }),
      telegramPollingEnabled: false,
      telegramRpcTimeoutMs: 10,
    });
    await enableProviders(app);

    await app.runTelegramIngestionOnce();
    await app.runTelegramIngestionOnce();

    const stalled = await json<{ logs: Array<{ level: string }> }>(
      await app.request("/api/audit-logs?event=telegram.provider.stalled"),
    );
    expect(stalled.logs.filter((log) => log.level === "error")).toHaveLength(0);
  });
});
