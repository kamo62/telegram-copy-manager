import { describe, expect, test } from "bun:test";
import { createApi } from "./app";
import {
  type TelegramAdapter,
  type TelegramCapturedMessage,
  TelegramRpcTimeoutError,
} from "./telegram";

const json = async <T>(response: Response) => (await response.json()) as T;

function adapter(
  fetchRecentMessages: (_sessionId: string, dialogId: string) => Promise<TelegramCapturedMessage[]>,
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
  test("times out a stuck provider without delaying a concurrent provider", async () => {
    let fastCalls = 0;
    const app = createApi({
      databasePath: ":memory:",
      seedDemoData: false,
      telegram: adapter(async (_sessionId, dialogId) => {
        if (dialogId === "dialog-stuck")
          return await new Promise<TelegramCapturedMessage[]>(() => {});
        fastCalls += 1;
        return [];
      }),
      telegramPollingEnabled: false,
      telegramRpcTimeoutMs: 10,
    });
    await enableProviders(app);

    const result = await app.runTelegramIngestionOnce();

    expect(fastCalls).toBe(1);
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

  test("records a timed-out provider before another provider finishes", async () => {
    let releaseSlow: (() => void) | undefined;
    const app = createApi({
      databasePath: ":memory:",
      seedDemoData: false,
      telegram: adapter(async (_sessionId, dialogId) => {
        if (dialogId === "dialog-stuck") throw new TelegramRpcTimeoutError(1);
        return await new Promise<TelegramCapturedMessage[]>((resolve) => {
          releaseSlow = () => resolve([]);
        });
      }),
      telegramPollingEnabled: false,
      telegramRpcTimeoutMs: 100,
    });
    await enableProviders(app);

    let completed = false;
    const run = app.runTelegramIngestionOnce().finally(() => {
      completed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const dashboard = await json<{
      alerts: Array<{ kind: string }>;
      telegramProviderHealth: Array<{ stalled: boolean }>;
    }>(await app.request("/api/dashboard"));
    expect(completed).toBe(false);
    expect(dashboard.telegramProviderHealth.some((health) => health.stalled)).toBe(true);
    expect(dashboard.alerts.some((alert) => alert.kind === "telegram-provider-stalled")).toBe(true);

    releaseSlow?.();
    await run;
  });
});
