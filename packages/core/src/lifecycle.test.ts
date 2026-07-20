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

  test("keeps zero-allocation TP references and assigns tradeable volume only to closing legs", () => {
    const command = buildExecutionCommand(
      {
        ...openSignal,
        takeProfits: openSignal.takeProfits.map((target, index) => ({
          ...target,
          allocationPercent: [50, 0, 0, 50][index] ?? 0,
          strategy:
            index === 0
              ? { kind: "set-sl-to-tp" as const, tpLeg: 2, offsetPips: 0 }
              : target.strategy,
        })),
      },
      { id: "queue-kal", executionMode: "VIRTUAL_TP", volume: 0.02 },
    );

    expect(
      command.payload.takeProfits.map((target) => [
        target.leg,
        target.allocationPercent,
        target.volume,
      ]),
    ).toEqual([
      [1, 50, 0.01],
      [2, 0, undefined],
      [3, 0, undefined],
      [4, 50, 0.01],
    ]);
  });

  test("uses cent-rounded TP volumes as the executable allocation plan", () => {
    const command = buildExecutionCommand(
      {
        ...openSignal,
        takeProfits: openSignal.takeProfits.slice(0, 2).map((target, index) => ({
          ...target,
          allocationPercent: index === 0 ? 80 : 20,
        })),
      },
      { id: "queue-small", executionMode: "VIRTUAL_TP", volume: 0.02 },
    );

    expect(
      command.payload.takeProfits.map((target) => [target.volume, target.allocationPercent]),
    ).toEqual([
      [0.01, 50],
      [0.01, 50],
    ]);

    const sizedCommand = buildExecutionCommand(
      {
        ...openSignal,
        takeProfits: openSignal.takeProfits.slice(0, 2).map((target, index) => ({
          ...target,
          allocationPercent: index === 0 ? 80 : 20,
        })),
      },
      { id: "queue-weighted", executionMode: "VIRTUAL_TP", volume: 0.1 },
    );
    expect(sizedCommand.payload.takeProfits.map((target) => target.volume)).toEqual([0.08, 0.02]);
  });

  test("puts an unsplittable KAL-style trade entirely on TP1", () => {
    const command = buildExecutionCommand(
      {
        ...openSignal,
        takeProfits: openSignal.takeProfits.map((target, index) => ({
          ...target,
          allocationPercent: [50, 0, 0, 50][index] ?? 0,
        })),
      },
      { id: "queue-kal-small", executionMode: "VIRTUAL_TP", volume: 0.01 },
    );

    expect(
      command.payload.takeProfits.map((target) => [
        target.leg,
        target.volume,
        target.allocationPercent,
      ]),
    ).toEqual([
      [1, 0.01, 100],
      [2, undefined, 0],
      [3, undefined, 0],
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

  test("never falls back to a same-symbol trade when explicit provider ids disagree", () => {
    const trade = {
      ...createLogicalTradeFromSignal(openSignal, {
        id: "trade-111",
        providerId,
        accountId: "mt5-demo-1",
        executionMode: "VIRTUAL_TP",
      }),
      providerOrderId: "300424111",
    };
    const command = parseSignalText("CLOSED - EURUSD Buy # 300424222", {
      providerId,
      accountId: "mt5-demo-1",
      globalAliases: {},
      providerAliases: {},
      accountMappings: {},
    });

    expect(matchLifecycleCommandToTrade(command, [trade])).toMatchObject({
      status: "UNMATCHED",
      requiresManualReview: true,
    });
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
