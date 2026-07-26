import { describe, expect, test } from "bun:test";
import { createTelegramAdapter, GRAMJS_CLIENT_OPTIONS, telegramLogLevel } from "./telegram";

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
    const messages = await gramjsAdapterWithReply(7n).fetchRecentMessages("session", "dialog", 1);

    expect(messages[0]).toMatchObject({ replyToMessageId: "7", quotedText: undefined });
  });

  test("leaves replyToMessageId undefined when the reply header is absent", async () => {
    const messages = await gramjsAdapterWithReply().fetchRecentMessages("session", "dialog", 1);

    expect(messages[0]?.replyToMessageId).toBeUndefined();
  });

  test("round-trips forwarded metadata and leaves it null for ordinary messages", async () => {
    const forwarded = await gramjsAdapterWithReply(undefined, {
      fromId: { channelId: 991n },
      fromName: "VIP Gold",
      date: 1_784_344_000,
    }).fetchRecentMessages("session", "dialog", 1);
    const ordinary = await gramjsAdapterWithReply().fetchRecentMessages("session", "dialog", 1);

    expect(forwarded[0]).toMatchObject({
      forwardedFrom: { peer: "channelId:991", name: "VIP Gold" },
      forwardedDate: "2026-07-18T03:06:40.000Z",
    });
    expect(ordinary[0]?.forwardedFrom).toBeUndefined();
    expect(ordinary[0]?.forwardedDate).toBeUndefined();
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
