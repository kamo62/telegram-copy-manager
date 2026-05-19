import { describe, expect, test } from "bun:test";
import {
  buildExecutionCommand,
  createLogicalTradeFromSignal,
  matchLifecycleCommandToTrade,
  parseSignalText,
} from "./index";

describe("logical trade lifecycle", () => {
  const providerId = "provider-alpha";

  const openSignal = parseSignalText(
    "BUY EURUSD 1.0850\nSL 1.0810\nTP1 1.0900\nTP2 1.0950\nTP3 1.1000\nTP4 1.1050",
    {
      providerId,
      accountId: "mt5-demo-1",
      globalAliases: {},
      providerAliases: {},
      accountMappings: {
        "mt5-demo-1": {
          accountId: "mt5-demo-1",
          canonicalOverrides: {},
          suffix: ".raw",
          includeSymbols: ["EURUSD.raw"],
          excludeSymbols: [],
          availableBrokerSymbols: ["EURUSD.raw"],
        },
      },
    },
  );

  test("creates one logical trade with four TP legs and planned partial close allocation", () => {
    const trade = createLogicalTradeFromSignal(openSignal, {
      id: "trade-1",
      providerId,
      accountId: "mt5-demo-1",
      executionMode: "VIRTUAL_TP",
      allocation: [50, 25, 15, 10],
    });

    expect(trade.symbol.canonicalSymbol).toBe("EURUSD");
    expect(trade.executionMode).toBe("VIRTUAL_TP");
    expect(trade.legs.map((leg) => [leg.leg, leg.allocationPercent, leg.status])).toEqual([
      [1, 50, "PLANNED"],
      [2, 25, "PLANNED"],
      [3, 15, "PLANNED"],
      [4, 10, "PLANNED"],
    ]);
  });

  test("matches a provider management command to the correct open logical trade", () => {
    const trade = createLogicalTradeFromSignal(openSignal, {
      id: "trade-1",
      providerId,
      accountId: "mt5-demo-1",
      executionMode: "VIRTUAL_TP",
    });
    const command = parseSignalText("Move SL BE EURUSD", {
      providerId,
      accountId: "mt5-demo-1",
      globalAliases: {},
      providerAliases: {},
      accountMappings: {},
    });

    const match = matchLifecycleCommandToTrade(command, [trade]);

    expect(match.status).toBe("MATCHED");
    expect(match.tradeId).toBe("trade-1");
    expect(match.confidence).toBeGreaterThanOrEqual(0.8);
  });

  test("allows a symbol-less lifecycle command only when one active provider trade matches", () => {
    const trade = createLogicalTradeFromSignal(openSignal, {
      id: "trade-1",
      providerId,
      accountId: "mt5-demo-1",
      executionMode: "VIRTUAL_TP",
    });
    const command = parseSignalText("Close half", {
      providerId,
      accountId: "mt5-demo-1",
      globalAliases: {},
      providerAliases: {},
      accountMappings: {},
    });

    const match = matchLifecycleCommandToTrade(command, [trade]);

    expect(command.missingFields).toContain("symbol");
    expect(match.status).toBe("MATCHED");
    expect(match.tradeId).toBe("trade-1");
    expect(match.requiresManualReview).toBe(false);
  });

  test("marks ambiguous management commands for confirmation", () => {
    const first = createLogicalTradeFromSignal(openSignal, {
      id: "trade-1",
      providerId,
      accountId: "mt5-demo-1",
      executionMode: "VIRTUAL_TP",
    });
    const second = { ...first, id: "trade-2", openedAt: "2026-05-09T08:00:00.000Z" };
    const command = parseSignalText("Close half EURUSD", {
      providerId,
      accountId: "mt5-demo-1",
      globalAliases: {},
      providerAliases: {},
      accountMappings: {},
    });

    const match = matchLifecycleCommandToTrade(command, [first, second]);

    expect(match.status).toBe("AMBIGUOUS");
    expect(match.requiresManualReview).toBe(true);
  });

  test("builds queue payloads that keep backend intent separate from EA execution reality", () => {
    const trade = createLogicalTradeFromSignal(openSignal, {
      id: "trade-1",
      providerId,
      accountId: "mt5-demo-1",
      executionMode: "VIRTUAL_TP",
    });
    const queueItem = buildExecutionCommand(openSignal, {
      id: "queue-1",
      accountId: "mt5-demo-1",
      logicalTradeId: trade.id,
    });

    expect(queueItem.status).toBe("PENDING");
    expect(queueItem.payload.commandType).toBe("OPEN_TRADE");
    expect(queueItem.payload.executionMode).toBe("VIRTUAL_TP");
    expect(queueItem.payload.takeProfits).toHaveLength(4);
    expect(queueItem.payload.brokerSymbol).toBe("EURUSD.raw");
  });

  test("creates a visible logical TP leg for default-only market trades", () => {
    const defaultOnly = parseSignalText("BUY EURUSD", {
      providerId,
      accountId: "mt5-demo-1",
      accountMappings: {
        "mt5-demo-1": {
          accountId: "mt5-demo-1",
          canonicalOverrides: {},
          suffix: ".raw",
          includeSymbols: ["EURUSD.raw"],
          excludeSymbols: [],
          availableBrokerSymbols: ["EURUSD.raw"],
        },
      },
      defaultStopLoss: { value: 50, unit: "PIPS" },
      defaultTakeProfit: { value: 200, unit: "PIPS" },
    });

    const trade = createLogicalTradeFromSignal(defaultOnly, {
      id: "trade-default",
      providerId,
      accountId: "mt5-demo-1",
      executionMode: "VIRTUAL_TP",
    });
    const queueItem = buildExecutionCommand(defaultOnly, {
      id: "queue-default",
      accountId: "mt5-demo-1",
      logicalTradeId: trade.id,
      volume: 0.1,
    });

    expect(defaultOnly.takeProfits).toEqual([]);
    expect(queueItem.payload.takeProfits).toEqual([]);
    expect(queueItem.payload.defaultTakeProfit).toEqual({ value: 200, unit: "PIPS" });
    expect(trade.legs).toHaveLength(1);
    expect(trade.legs[0]).toMatchObject({
      leg: 1,
      allocationPercent: 100,
      status: "PLANNED",
      targetSource: "default-distance",
      defaultDistance: { value: 200, unit: "PIPS" },
    });
    expect((trade.legs[0] as { targetPrice?: number }).targetPrice).toBeUndefined();
  });

  test("splits channel-owned volume across TP legs before handing work to MT5", () => {
    const queueItem = buildExecutionCommand(openSignal, {
      id: "queue-1",
      accountId: "mt5-demo-1",
      logicalTradeId: "trade-1",
      volume: 0.2,
    });

    expect(queueItem.payload.volume).toBe(0.2);
    expect(queueItem.payload.takeProfits.map((target) => target.volume)).toEqual([
      0.05, 0.05, 0.05, 0.05,
    ]);
  });
});
