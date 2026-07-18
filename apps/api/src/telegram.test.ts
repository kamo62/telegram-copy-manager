import { describe, expect, test } from "bun:test";
import { createTelegramAdapter } from "./telegram";

type GramjsAdapterTestSeam = {
  clients: Map<string, unknown>;
};

async function* messagesWith(replyToMsgId?: string | number | bigint) {
  yield {
    id: 42,
    date: 1_784_344_000,
    message: "BUY XAUUSD",
    replyTo: replyToMsgId === undefined ? undefined : { replyToMsgId },
    getReplyMessage: async () => undefined,
  };
}

function gramjsAdapterWithReply(replyToMsgId?: string | number | bigint) {
  const adapter = createTelegramAdapter("gramjs");
  const seam = adapter as unknown as GramjsAdapterTestSeam;
  seam.clients.set("session", {
    getDialogs: async () => [{ id: "dialog", entity: "dialog" }],
    iterMessages: () => messagesWith(replyToMsgId),
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
});
