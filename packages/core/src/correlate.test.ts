import { describe, expect, test } from "bun:test";
import { correlateMessages, parseSignalText } from "./index";

interface TestMessage {
  telegramMessageId: string;
  messageDate: string;
  rawText: string;
  senderName?: string;
}

function at(secondsFromBase: number): string {
  return new Date(Date.parse("2026-06-26T12:00:00.000Z") + secondsFromBase * 1000).toISOString();
}

describe("message correlation", () => {
  test("merges a rapid SL/TP follow-up into the preceding directional anchor", () => {
    const messages: TestMessage[] = [
      { telegramMessageId: "1", messageDate: at(0), rawText: "BUY GOLD" },
      { telegramMessageId: "2", messageDate: at(5), rawText: "SL 2290 TP 2320" },
    ];

    const correlated = correlateMessages(messages, 30);

    expect(correlated).toHaveLength(1);
    expect(correlated[0]?.correlatedMessageIds).toEqual(["1", "2"]);
    expect(correlated[0]?.rawText).toBe("BUY GOLD\nSL 2290 TP 2320");

    const signal = parseSignalText(correlated[0]?.rawText ?? "");
    expect(signal.commandType).toBe("OPEN_TRADE");
    expect(signal.direction).toBe("BUY");
    expect(signal.stopLoss).toBe(2290);
    expect(signal.takeProfits.map((tp) => tp.price)).toContain(2320);
  });

  test("does NOT merge messages further apart than the window", () => {
    const messages: TestMessage[] = [
      { telegramMessageId: "1", messageDate: at(0), rawText: "BUY GOLD" },
      { telegramMessageId: "2", messageDate: at(120), rawText: "SL 2290 TP 2320" },
    ];

    const correlated = correlateMessages(messages, 30);

    expect(correlated).toHaveLength(2);
    expect(correlated[0]?.correlatedMessageIds).toEqual(["1"]);
    expect(correlated[1]?.correlatedMessageIds).toEqual(["2"]);
  });

  test("leaves a standalone complete signal untouched", () => {
    const messages: TestMessage[] = [
      { telegramMessageId: "1", messageDate: at(0), rawText: "BUY GOLD SL 2290 TP 2320" },
    ];

    const correlated = correlateMessages(messages, 30);

    expect(correlated).toHaveLength(1);
    expect(correlated[0]?.correlatedMessageIds).toEqual(["1"]);
    expect(correlated[0]?.rawText).toBe("BUY GOLD SL 2290 TP 2320");
  });

  test("does not fold a second directional message into the first", () => {
    const messages: TestMessage[] = [
      { telegramMessageId: "1", messageDate: at(0), rawText: "BUY GOLD" },
      { telegramMessageId: "2", messageDate: at(3), rawText: "SELL EURUSD" },
    ];

    const correlated = correlateMessages(messages, 30);

    expect(correlated).toHaveLength(2);
  });

  test("respects sender boundaries when folding fragments", () => {
    const messages: TestMessage[] = [
      { telegramMessageId: "1", messageDate: at(0), rawText: "BUY GOLD", senderName: "A" },
      { telegramMessageId: "2", messageDate: at(2), rawText: "SL 2290 TP 2320", senderName: "B" },
    ];

    const correlated = correlateMessages(messages, 30);

    expect(correlated).toHaveLength(2);
  });
});
