import { describe, expect, test } from "bun:test";
import {
  createTelegramAdapter,
  GRAMJS_CLIENT_OPTIONS,
  type TelegramCapturedMessage,
  telegramLogLevel,
} from "./telegram";

type GramjsAdapterTestSeam = {
  clients: Map<string, unknown>;
};

async function* messagesWith(
  replyToMsgId?: string | number | bigint,
  fwdFrom?: { fromId?: unknown; fromName?: string; date?: number },
) {
  yield {
    id: 42,
    date: 1_784_344_000,
    message: "BUY XAUUSD",
    replyTo: replyToMsgId === undefined ? undefined : { replyToMsgId },
    fwdFrom,
    getReplyMessage: async () => undefined,
  };
}

function gramjsAdapterWithReply(
  replyToMsgId?: string | number | bigint,
  fwdFrom?: { fromId?: unknown; fromName?: string; date?: number },
) {
  const adapter = createTelegramAdapter("gramjs");
  const seam = adapter as unknown as GramjsAdapterTestSeam;
  seam.clients.set("session", {
    getDialogs: async () => [{ id: "dialog", entity: "dialog" }],
    iterMessages: () => messagesWith(replyToMsgId, fwdFrom),
  });
  return adapter;
}

describe("GramJS reply-link capture", () => {
  test("captures replyToMessageId from the structured reply header", async () => {
    const { messages } = await gramjsAdapterWithReply(7n).fetchRecentMessages(
      "session",
      "dialog",
      1,
    );

    expect(messages[0]).toMatchObject({ replyToMessageId: "7", quotedText: undefined });
  });

  test("leaves replyToMessageId undefined when the reply header is absent", async () => {
    const { messages } = await gramjsAdapterWithReply().fetchRecentMessages("session", "dialog", 1);

    expect(messages[0]?.replyToMessageId).toBeUndefined();
  });

  test("round-trips forwarded metadata and leaves it null for ordinary messages", async () => {
    const { messages: forwarded } = await gramjsAdapterWithReply(undefined, {
      fromId: { channelId: 991n },
      fromName: "VIP Gold",
      date: 1_784_344_000,
    }).fetchRecentMessages("session", "dialog", 1);
    const { messages: ordinary } = await gramjsAdapterWithReply().fetchRecentMessages(
      "session",
      "dialog",
      1,
    );

    expect(forwarded[0]).toMatchObject({
      forwardedFrom: { peer: "channelId:991", name: "VIP Gold" },
      forwardedDate: "2026-07-18T03:06:40.000Z",
    });
    expect(ordinary[0]?.forwardedFrom).toBeUndefined();
    expect(ordinary[0]?.forwardedDate).toBeUndefined();
  });
});

function backlog(count: number) {
  const start = Date.parse("2026-07-01T00:00:00.000Z");
  return Array.from({ length: count }, (_, index) => {
    const id = count - index;
    return { id, date: Math.floor((start + id * 1_000) / 1_000), message: `signal ${id}` };
  });
}

function gramjsAdapterWithBacklog(messages: ReturnType<typeof backlog>) {
  const calls: Array<{ limit: number; offsetDate?: number; offsetId?: number }> = [];
  const adapter = createTelegramAdapter("gramjs");
  const seam = adapter as unknown as GramjsAdapterTestSeam;
  seam.clients.set("session", {
    getDialogs: async () => [{ id: "dialog", entity: "dialog" }],
    iterMessages: (
      _entity: unknown,
      params: { limit: number; offsetDate?: number; offsetId?: number },
    ) => {
      calls.push(params);
      const start =
        params.offsetId === undefined
          ? 0
          : messages.findIndex((message) => message.id < params.offsetId!);
      return (async function* () {
        for (const message of messages.slice(
          start < 0 ? messages.length : start,
          start + params.limit,
        )) {
          yield message;
        }
      })();
    },
  });
  return { adapter, calls };
}

describe("GramJS backlog pagination", () => {
  test("drains a backlog larger than one page without duplicates", async () => {
    const { adapter } = gramjsAdapterWithBacklog(backlog(130));
    const result = await adapter.fetchRecentMessages("session", "dialog", 50, {
      dateFrom: "2026-06-30T00:00:00.000Z",
    });

    expect(result.gap).toBeUndefined();
    expect(result.messages).toHaveLength(130);
    expect(result.messages.map((message) => message.telegramMessageId)).toEqual(
      Array.from({ length: 130 }, (_, index) => String(130 - index)),
    );
    expect(new Set(result.messages.map((message) => message.telegramMessageId)).size).toBe(130);
    expect(result.messages[0]).toMatchObject({
      telegramMessageId: "130",
      rawText: "signal 130",
      messageDate: "2026-07-01T00:02:10.000Z",
    } satisfies Partial<TelegramCapturedMessage>);
  });

  test("stops paginating once it reaches dateFrom", async () => {
    const { adapter, calls } = gramjsAdapterWithBacklog(backlog(130));
    const result = await adapter.fetchRecentMessages("session", "dialog", 50, {
      dateFrom: "2026-07-01T00:01:10.000Z",
    });

    expect(result.messages.map((message) => message.telegramMessageId)).toEqual(
      Array.from({ length: 61 }, (_, index) => String(130 - index)),
    );
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual({ limit: 50, offsetId: 81 });
  });

  test("fetches exactly one page when dateFrom is undefined", async () => {
    const { adapter, calls } = gramjsAdapterWithBacklog(backlog(130));
    const result = await adapter.fetchRecentMessages("session", "dialog", 50);

    expect(result.messages.map((message) => message.telegramMessageId)).toEqual(
      Array.from({ length: 50 }, (_, index) => String(130 - index)),
    );
    expect(calls).toEqual([{ limit: 50, offsetDate: undefined }]);
  });

  test("reports a gap when the page cap truncates a drain", async () => {
    const prior = process.env.TELEGRAM_FETCH_MAX_PAGES;
    process.env.TELEGRAM_FETCH_MAX_PAGES = "2";
    try {
      const { adapter } = gramjsAdapterWithBacklog(backlog(130));
      const result = await adapter.fetchRecentMessages("session", "dialog", 50, {
        dateFrom: "2026-06-30T00:00:00.000Z",
      });

      expect(result.messages.map((message) => message.telegramMessageId)).toEqual(
        Array.from({ length: 100 }, (_, index) => String(130 - index)),
      );
      expect(result.gap).toEqual({
        fromIso: "2026-06-30T00:00:00.000Z",
        toIso: "2026-07-01T00:00:31.000Z",
        reason: "page-cap",
        resumeOffsetId: "31",
      });
    } finally {
      if (prior === undefined) delete process.env.TELEGRAM_FETCH_MAX_PAGES;
      else process.env.TELEGRAM_FETCH_MAX_PAGES = prior;
    }
  });

  test("reports a gap when a truncated drain captured no text at all", async () => {
    // A budget spent entirely on media/empty messages still walked through the
    // backlog. Without a gap the caller reads the pass as complete and clears
    // the resume cursor, skipping every older message permanently.
    const prior = process.env.TELEGRAM_FETCH_MAX_PAGES;
    process.env.TELEGRAM_FETCH_MAX_PAGES = "2";
    try {
      const mediaOnly = backlog(130).map((message) => ({ ...message, message: "" }));
      const { adapter } = gramjsAdapterWithBacklog(mediaOnly);
      const result = await adapter.fetchRecentMessages("session", "dialog", 50, {
        dateFrom: "2026-06-30T00:00:00.000Z",
      });

      expect(result.messages).toHaveLength(0);
      expect(result.gap).toEqual({
        fromIso: "2026-06-30T00:00:00.000Z",
        toIso: "2026-06-30T00:00:00.000Z",
        reason: "page-cap",
        resumeOffsetId: "31",
      });
    } finally {
      if (prior === undefined) delete process.env.TELEGRAM_FETCH_MAX_PAGES;
      else process.env.TELEGRAM_FETCH_MAX_PAGES = prior;
    }
  });

  test("returns a partial drain and resume cursor when its reply work exhausts the budget", async () => {
    const { adapter } = gramjsAdapterWithBacklog(
      backlog(50).map((message) => ({
        ...message,
        getReplyMessage: async () => await new Promise((resolve) => setTimeout(resolve, 5)),
      })),
    );
    const result = await adapter.fetchRecentMessages("session", "dialog", 50, {
      dateFrom: "2026-06-30T00:00:00.000Z",
      budgetMs: 12,
    });

    expect(result.messages.length).toBeGreaterThan(0);
    expect(result.messages.length).toBeLessThan(50);
    expect(result.gap).toMatchObject({
      reason: "time-cap",
      resumeOffsetId: result.messages.at(-1)?.telegramMessageId,
    });
  });
});

describe("GramJS logging", () => {
  test("defaults GramJS to error-only logging while accepting supported overrides", () => {
    expect(String(GRAMJS_CLIENT_OPTIONS.baseLogger.logLevel)).toBe("error");
    expect(String(telegramLogLevel("warn"))).toBe("warn");
    expect(String(telegramLogLevel("invalid"))).toBe("error");
  });

  test("passes the configured logger to every TelegramClient construction site", async () => {
    const source = await Bun.file(new URL("./telegram.ts", import.meta.url)).text();
    expect(source.match(/new TelegramClient\([\s\S]*?GRAMJS_CLIENT_OPTIONS,/g)).toHaveLength(3);
  });
});
