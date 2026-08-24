import { describe, expect, test } from "bun:test";
import { createApi } from "./app";
import {
  type TelegramAdapter,
  TelegramDialogUnavailableError,
  type TelegramFetchOptions,
  type TelegramFetchResult,
} from "./telegram";

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
    // The adapter here must behave like the real one: newest-first, honouring
    // BOTH offsetId (strictly older) and dateFrom (stop at it). A mock that
    // returns canned pages for a given offsetId regardless of dateFrom hides
    // the failure this test exists to catch, because the live pass advances the
    // watermark and a resumed backfill is then handed a cutoff newer than every
    // message it is meant to fetch.
    // Dated forward of the provider's initial watermark, which is set when the
    // provider row is created, so every message counts as new.
    const base = Date.now();
    const channel = Array.from({ length: 12 }, (_, index) => {
      const id = index + 1;
      return {
        telegramMessageId: String(id),
        messageDate: new Date(base + id * 60_000).toISOString(),
        rawText: `BUY XAUUSD ${id}`,
      };
    });
    const perPass = 4;
    const app = createApi({
      databasePath: ":memory:",
      seedDemoData: false,
      telegram: adapter(async (_sessionId, dialogId, _limit, options) => {
        if (dialogId === "dialog-slow") return { messages: [], gap: undefined };
        const from = options?.dateFrom ? Date.parse(options.dateFrom) : Number.NEGATIVE_INFINITY;
        let pool = [...channel].sort(
          (left, right) => Number(right.telegramMessageId) - Number(left.telegramMessageId),
        );
        if (options?.offsetId) {
          const cursor = Number(options.offsetId);
          pool = pool.filter((item) => Number(item.telegramMessageId) < cursor);
        }
        const page: typeof channel = [];
        let reachedFrom = false;
        for (const item of pool) {
          if (Date.parse(item.messageDate) < from) {
            reachedFrom = true;
            break;
          }
          if (page.length >= perPass) break;
          page.push(item);
        }
        const truncated = !reachedFrom && page.length >= perPass && pool.length > page.length;
        const oldest = page.at(-1);
        return {
          messages: page,
          gap:
            truncated && oldest
              ? {
                  fromIso: options?.dateFrom ?? new Date(base).toISOString(),
                  toIso: oldest.messageDate,
                  reason: "time-cap" as const,
                  resumeOffsetId: oldest.telegramMessageId,
                }
              : undefined,
        };
      }),
      telegramPollingEnabled: false,
      telegramRpcTimeoutMs: 200,
    });
    await enableProviders(app);

    const providersBefore = await json<{
      providers: Array<{ id: string; dialogId: string }>;
    }>(await app.request("/api/providers"));
    const providerId = providersBefore.providers.find(
      (provider) => provider.dialogId === "dialog-stuck",
    )!.id;

    await app.runTelegramIngestionOnce();
    const afterFirst = await json<{
      providers: Array<{ id: string; backfillCursorId?: string }>;
    }>(await app.request("/api/providers"));
    expect(
      afterFirst.providers.find((provider) => provider.id === providerId)?.backfillCursorId,
    ).toBeDefined();

    for (let poll = 0; poll < 5; poll += 1) await app.runTelegramIngestionOnce();

    const stored = await json<{ messages: Array<{ telegramMessageId: string }> }>(
      await app.request(`/api/providers/${providerId}/messages?limit=50`),
    );
    expect(
      stored.messages.map((item) => Number(item.telegramMessageId)).sort((a, b) => a - b),
    ).toEqual(Array.from({ length: 12 }, (_, index) => index + 1));

    const afterAll = await json<{
      providers: Array<{ id: string; backfillCursorId?: string; lastMessageAt: string }>;
    }>(await app.request("/api/providers"));
    const drained = afterAll.providers.find((provider) => provider.id === providerId)!;
    expect(drained.backfillCursorId).toBeUndefined();
    expect(drained.lastMessageAt).toBe(channel.at(-1)!.messageDate);

    const completed = await json<{ logs: Array<{ data: { providerId: string } }> }>(
      await app.request("/api/audit-logs?event=telegram.ingest.backfill-complete"),
    );
    expect(completed.logs.length).toBeGreaterThanOrEqual(1);
  });

  test("a fragment already folded into an anchor never returns as its own row", async () => {
    // Splitting a poll into live and backfill passes can put an anchor and its
    // correlated fragment in different batches. The raw-message primary key
    // only covers the anchor id, so without the alias check the fragment would
    // insert standalone and parse on its own.
    const base = Date.now();
    const anchor = {
      telegramMessageId: "20",
      messageDate: new Date(base).toISOString(),
      rawText: "BUY XAUUSD",
    };
    const fragment = {
      telegramMessageId: "21",
      messageDate: new Date(base + 5_000).toISOString(),
      rawText: "SL 2290 TP 2320",
    };
    let pass = 0;
    const app = createApi({
      databasePath: ":memory:",
      seedDemoData: false,
      telegram: adapter(async (_sessionId, dialogId) => {
        if (dialogId === "dialog-slow") return { messages: [], gap: undefined };
        pass += 1;
        // Anchor first: the correlator folds a following fragment into the
        // directional message ahead of it.
        if (pass === 1) return { messages: [anchor, fragment], gap: undefined };
        return { messages: pass === 2 ? [fragment] : [], gap: undefined };
      }),
      telegramPollingEnabled: false,
      telegramRpcTimeoutMs: 200,
    });
    await enableProviders(app);
    const listed = await json<{ providers: Array<{ id: string; dialogId: string }> }>(
      await app.request("/api/providers"),
    );
    const providerId = listed.providers.find(
      (provider) => provider.dialogId === "dialog-stuck",
    )!.id;

    await app.runTelegramIngestionOnce();
    const afterFold = await json<{ messages: Array<{ telegramMessageId: string }> }>(
      await app.request(`/api/providers/${providerId}/messages?limit=20`),
    );
    const foldedInto = afterFold.messages.map((item) => item.telegramMessageId);
    expect(foldedInto).toHaveLength(1);

    await app.runTelegramIngestionOnce();
    const afterReplay = await json<{ messages: Array<{ telegramMessageId: string }> }>(
      await app.request(`/api/providers/${providerId}/messages?limit=20`),
    );
    expect(afterReplay.messages.map((item) => item.telegramMessageId)).toEqual(foldedInto);
  });

  test("a second truncation keeps the older outstanding floor", async () => {
    const base = Date.now();
    const message = (id: number, offsetMs: number) => ({
      telegramMessageId: String(id),
      messageDate: new Date(base + offsetMs).toISOString(),
      rawText: `BUY XAUUSD ${id}`,
    });
    let pass = 0;
    const app = createApi({
      databasePath: ":memory:",
      seedDemoData: false,
      telegram: adapter(async (_sessionId, dialogId, _limit, options) => {
        if (dialogId === "dialog-slow") return { messages: [], gap: undefined };
        // The backfill stays truncated so the outstanding window survives into
        // the next poll; a clean finish would legitimately clear both fields.
        // On the second poll it fails outright, so the floor written by that
        // poll's live truncation is never revisited. Without that, the backfill
        // re-writes the floor from the value it read at the start of the poll
        // and repairs a wrong live floor by accident, which hides the bug.
        if (options?.offsetId) {
          if (pass >= 2) throw new Error("backfill unavailable");
          return {
            messages: [],
            gap: {
              fromIso: options.dateFrom ?? new Date(base).toISOString(),
              toIso: options.dateFrom ?? new Date(base).toISOString(),
              reason: "time-cap" as const,
              resumeOffsetId: options.offsetId,
            },
          };
        }
        pass += 1;
        if (pass > 2) return { messages: [], gap: undefined };
        const newest = pass === 1 ? message(10, 60_000) : message(20, 600_000);
        return {
          messages: [newest],
          gap: {
            fromIso: options?.dateFrom ?? new Date(base).toISOString(),
            toIso: newest.messageDate,
            reason: "time-cap" as const,
            resumeOffsetId: newest.telegramMessageId,
          },
        };
      }),
      telegramPollingEnabled: false,
      telegramRpcTimeoutMs: 200,
    });
    await enableProviders(app);

    await app.runTelegramIngestionOnce();
    const afterFirst = await json<{
      providers: Array<{ dialogId: string; backfillFloorAt?: string }>;
    }>(await app.request("/api/providers"));
    const firstFloor = afterFirst.providers.find(
      (provider) => provider.dialogId === "dialog-stuck",
    )?.backfillFloorAt;
    expect(firstFloor).toBeDefined();

    await app.runTelegramIngestionOnce();
    const afterSecond = await json<{
      providers: Array<{ dialogId: string; backfillFloorAt?: string; backfillCursorId?: string }>;
    }>(await app.request("/api/providers"));
    const drained = afterSecond.providers.find((provider) => provider.dialogId === "dialog-stuck")!;
    // The floor must still be the one the first outage opened. Taking the
    // newer watermark here would strand everything below it.
    expect(drained.backfillFloorAt).toBe(firstFloor);
    expect(drained.backfillCursorId).toBe("20");
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

  test("an unreachable channel is reported once and then backed off, not retried every tick", async () => {
    let fetchCalls = 0;
    const app = createApi({
      databasePath: ":memory:",
      seedDemoData: false,
      telegram: adapter(async (_sessionId, dialogId) => {
        if (dialogId === "dialog-stuck") {
          fetchCalls += 1;
          throw new TelegramDialogUnavailableError(dialogId);
        }
        return { messages: [], gap: undefined };
      }),
      telegramPollingEnabled: false,
    });
    await enableProviders(app);

    for (let tick = 0; tick < 5; tick += 1) await app.runTelegramIngestionOnce();

    // One attempt, then the back-off window holds it off. Before this, a channel the
    // account had left produced an error-level row on every single poll.
    expect(fetchCalls).toBe(1);
    const unreachable = await json<{
      logs: Array<{ level: string; data: { providerId: string; dialogId: string } }>;
    }>(await app.request("/api/audit-logs?event=telegram.provider.unreachable"));
    expect(unreachable.logs).toHaveLength(1);
    expect(unreachable.logs[0]).toMatchObject({ level: "error" });
    expect(unreachable.logs[0]?.data).toMatchObject({ dialogId: "dialog-stuck" });

    // The generic ingestion error must not also fire; the whole point is that this
    // reads as an access problem rather than a transport failure.
    const generic = await json<{ logs: unknown[] }>(
      await app.request("/api/audit-logs?event=telegram.ingest.error"),
    );
    expect(generic.logs).toHaveLength(0);
  });

  test("a reachable channel is never held off by the unreachable back-off", async () => {
    let stuckCalls = 0;
    let slowCalls = 0;
    const app = createApi({
      databasePath: ":memory:",
      seedDemoData: false,
      telegram: adapter(async (_sessionId, dialogId) => {
        if (dialogId === "dialog-stuck") {
          stuckCalls += 1;
          throw new TelegramDialogUnavailableError(dialogId);
        }
        slowCalls += 1;
        return { messages: [], gap: undefined };
      }),
      telegramPollingEnabled: false,
    });
    await enableProviders(app);

    for (let tick = 0; tick < 4; tick += 1) await app.runTelegramIngestionOnce();

    expect(stuckCalls).toBe(1);
    expect(slowCalls).toBe(4);
  });
});
