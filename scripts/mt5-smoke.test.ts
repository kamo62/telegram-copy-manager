import { describe, expect, test } from "bun:test";
import {
  buildExecutionReportPayload,
  buildHeartbeatPayload,
  parseMt5LinePayload,
} from "./mt5-smoke";

describe("MT5 smoke helpers", () => {
  test("parses the line-oriented payload consumed by the MQL5 expert advisor", () => {
    const work = parseMt5LinePayload(
      [
        "status=WORK",
        "queueItemId=queue_smoke",
        "logicalTradeId=trade_smoke",
        "commandType=OPEN_TRADE",
        "brokerSymbol=EURUSD.raw",
        "canonicalSymbol=EURUSD",
        "direction=BUY",
        "orderType=MARKET",
        "executionMode=VIRTUAL_TP",
        "pollSeconds=5",
        "volume=0.25",
        "riskPercent=0.75",
        "entryFrom=1.085",
        "stopLoss=1.081",
        "tp1=1.09",
        "",
      ].join("\n"),
    );

    expect(work).toMatchObject({
      status: "WORK",
      queueItemId: "queue_smoke",
      logicalTradeId: "trade_smoke",
      commandType: "OPEN_TRADE",
      brokerSymbol: "EURUSD.raw",
      canonicalSymbol: "EURUSD",
      direction: "BUY",
      executionMode: "VIRTUAL_TP",
      pollSeconds: "5",
      volume: "0.25",
      riskPercent: "0.75",
      entryFrom: "1.085",
      stopLoss: "1.081",
      tp1: "1.09",
    });
  });

  test("builds a retcode-aware execution report from leased work", () => {
    const report = buildExecutionReportPayload({
      accountId: "mt5-900123456",
      work: parseMt5LinePayload(
        "status=WORK\nqueueItemId=queue_smoke\nentryFrom=1.085\nvolume=0.25\n",
      ),
      ticketSuffix: "abc123",
    });

    expect(report).toEqual({
      accountId: "mt5-900123456",
      queueItemId: "queue_smoke",
      status: "EXECUTED",
      retcode: 10009,
      retcodeExternal: 0,
      brokerComment: "MT5 smoke contract accepted",
      orderTicket: "smoke-order-abc123",
      dealTicket: "smoke-deal-abc123",
      requestedPrice: 1.085,
      filledPrice: 1.085,
      volume: 0.25,
      errorText: "",
    });
  });

  test("builds an MT5 heartbeat payload with reported terminal symbols", () => {
    expect(
      buildHeartbeatPayload({
        accountId: "mt5-900123456",
        balance: 10050,
        equity: 10040,
        availableSymbols: ["EURUSD.raw", "XAUUSD.r"],
      }),
    ).toEqual({
      accountId: "mt5-900123456",
      balance: 10050,
      equity: 10040,
      availableSymbols: ["EURUSD.raw", "XAUUSD.r"],
    });
  });
});
