import { describe, expect, test } from "bun:test";
import {
  type ParserContext,
  parseSignalText,
  parseSignalTexts,
  resolveSymbol,
  shouldRequireManualReview,
} from "./index";

const context: ParserContext = {
  providerId: "provider-alpha",
  accountId: "mt5-demo-1",
  globalAliases: {
    GOLD: "XAUUSD",
    "EUR/USD": "EURUSD",
    US30: "DJI30",
  },
  providerAliases: {
    "provider-alpha": {
      GOLD: "XAUUSD",
    },
  },
  accountMappings: {
    "mt5-demo-1": {
      accountId: "mt5-demo-1",
      canonicalOverrides: {
        XAUUSD: "XAUUSD.r",
      },
      prefix: "",
      suffix: ".raw",
      includeSymbols: ["EURUSD.raw", "XAUUSD.r", "DJI30.raw"],
      excludeSymbols: [],
      availableBrokerSymbols: ["EURUSD.raw", "XAUUSD.r", "DJI30.raw"],
    },
  },
};

describe("deterministic signal parser", () => {
  test("parses a noisy multi-line open trade with TP1-TP4 and symbol mapping evidence", () => {
    const result = parseSignalText(
      [
        "🔥 VIP SIGNAL",
        "BUY EUR/USD @ 1.0850",
        "Entry 1.0850 - 1.0860",
        "SL 1.0810",
        "TP1 1.0900",
        "TP2 1.0950",
        "TP3 1.1000",
        "TP4 1.1050",
      ].join("\n"),
      context,
    );

    expect(result.commandType).toBe("OPEN_TRADE");
    expect(result.direction).toBe("BUY");
    expect(result.orderType).toBe("MARKET");
    expect(result.rawSymbol).toBe("EUR/USD");
    expect(result.canonicalSymbol).toBe("EURUSD");
    expect(result.brokerSymbol).toBe("EURUSD.raw");
    expect(result.mappingStatus).toBe("mapped");
    expect(result.entry).toEqual({ from: 1.085, to: 1.086 });
    expect(result.stopLoss).toBe(1.081);
    expect(result.takeProfits.map((target) => target.price)).toEqual([1.09, 1.095, 1.1, 1.105]);
    expect(result.matchedPatternIds).toContain("open.direction-symbol-entry");
    expect(result.confidence).toBeGreaterThanOrEqual(0.85);
    expect(shouldRequireManualReview(result)).toBe(false);
  });

  test("maps provider-specific Gold text through an account override before prefix or suffix fallback", () => {
    const result = parseSignalText("Buy Gold now\nSL 2355\nTake Profit: 2375", context);

    expect(result.commandType).toBe("OPEN_TRADE");
    expect(result.rawSymbol).toBe("Gold");
    expect(result.canonicalSymbol).toBe("XAUUSD");
    expect(result.brokerSymbol).toBe("XAUUSD.r");
    expect(result.mappingStatus).toBe("mapped");
    expect(result.orderType).toBe("MARKET");
    expect(result.takeProfits[0]?.price).toBe(2375);
    expect(result.warnings).not.toContain("No broker symbol mapping found");
  });

  test("parses common provider entry formats without relying on one message layout", () => {
    const symbolFirst = parseSignalText("EURUSD BUY 1.0850\nSL 1.0810\nTP1 1.0900", context);
    const pendingLimit = parseSignalText("XAUUSD SELL LIMIT 2365\nSL 2375\nTP1 2350", context);
    const marketNow = parseSignalText("Buy Gold now\nSL 2355\nTP1 2375", context);

    expect(symbolFirst).toMatchObject({
      commandType: "OPEN_TRADE",
      direction: "BUY",
      rawSymbol: "EURUSD",
      entry: { from: 1.085 },
      brokerSymbol: "EURUSD.raw",
    });
    expect(pendingLimit).toMatchObject({
      commandType: "OPEN_TRADE",
      direction: "SELL",
      orderType: "LIMIT",
      rawSymbol: "XAUUSD",
      entry: { from: 2365 },
      brokerSymbol: "XAUUSD.r",
    });
    expect(marketNow).toMatchObject({
      commandType: "OPEN_TRADE",
      direction: "BUY",
      orderType: "MARKET",
      rawSymbol: "Gold",
      entry: undefined,
      brokerSymbol: "XAUUSD.r",
    });
  });

  test("disambiguates STOP order tokens from stop-loss labels without using an SL price as entry", () => {
    const stopLoss = parseSignalText("BUY GOLD STOP LOSS 2290 TP 2320", context);
    expect(stopLoss).toMatchObject({
      commandType: "OPEN_TRADE",
      direction: "BUY",
      orderType: "MARKET",
      entry: undefined,
      stopLoss: 2290,
    });
    expect(shouldRequireManualReview(stopLoss)).toBe(false);

    for (const [text, entry] of [
      ["BUY GOLD LIMIT SL 2290 TP 2320 ENTRY 2310", { from: 2310 }],
      ["BUY GOLD LIMIT SL 2290 TP 2320 ENTRY 2310-2312", { from: 2310, to: 2312 }],
      ["BUY GOLD LIMIT SL 2290 TP 2320 @2310", { from: 2310 }],
    ] as const) {
      const signal = parseSignalText(text, context);
      expect(signal).toMatchObject({ orderType: "LIMIT", entry });
      expect(signal.missingFields).not.toContain("entry");
      expect(shouldRequireManualReview(signal)).toBe(false);
    }

    for (const orderType of ["LIMIT", "STOP"] as const) {
      const missingPendingEntry = parseSignalText(`BUY GOLD ${orderType} SL 2290 TP 2320`, context);
      expect(missingPendingEntry).toMatchObject({ orderType, entry: undefined });
      expect(missingPendingEntry.missingFields).toContain("entry");
      expect(shouldRequireManualReview(missingPendingEntry)).toBe(true);
    }

    for (const [text, entry] of [
      ["BUY STOP 2290", 2290],
      ["SELL STOP @1.2345", 1.2345],
      ["BUY GOLD STOP 2310 SL 2290", 2310],
      ["BUY GOLD @ 2310 ORDER TYPE: STOP SL 2290", 2310],
    ] as const) {
      expect(parseSignalText(text, context)).toMatchObject({
        orderType: "STOP",
        entry: { from: entry },
      });
    }
    expect(parseSignalText("BUY STOP LIMIT", context).orderType).toBe("LIMIT");
    expect(parseSignalText("BUY STOPLOSSUSD 2290", context).orderType).toBe("MARKET");

    for (const text of ["SL 2290", "S/L: 2290", "StopLoss 2290", "STOP-LOSS 2290"]) {
      expect(parseSignalText(`BUY GOLD ${text} TP 2320`, context)).toMatchObject({
        entry: undefined,
        stopLoss: 2290,
      });
    }

    const conflicting = parseSignalText("BUY GOLD STOP LOSS 2290 SL 2280 TP 2320", context);
    expect(conflicting.stopLoss).toBe(2290);
    expect(shouldRequireManualReview(conflicting)).toBe(true);
  });

  test("extracts optional lot size and risk percent from open trade text", () => {
    const result = parseSignalText(
      "BUY EURUSD @ 1.0850\nSL 1.0810\nTP1 1.0900\nLot 0.25\nRisk 0.75%",
      context,
    );

    expect(result.commandType).toBe("OPEN_TRADE");
    expect(result.lotSize).toBe(0.25);
    expect(result.riskPercent).toBe(0.75);
  });

  test("parses lifecycle management commands without queueing blind open trades", () => {
    const closeHalf = parseSignalText("Close 50% Gold", context);
    const closeHalfNoSymbol = parseSignalText("Close half", context);
    const closeTp1 = parseSignalText("Close TP1 EURUSD", context);
    const moveBe = parseSignalText("Move SL to BE XAUUSD", context);
    const cancel = parseSignalText("Cancel pending EURUSD", context);
    const modifySl = parseSignalText("EURUSD update SL 1.0830", context);
    const modifyTp = parseSignalText("Modify TP2 EURUSD 1.0975", context);

    expect(closeHalf.commandType).toBe("CLOSE_PARTIAL");
    expect(closeHalf.partialClose).toEqual({ kind: "PERCENT", value: 50 });
    expect(closeHalfNoSymbol.commandType).toBe("CLOSE_PARTIAL");
    expect(closeHalfNoSymbol.partialClose).toEqual({ kind: "PERCENT", value: 50 });
    expect(closeHalfNoSymbol.missingFields).toContain("symbol");
    expect(closeTp1.partialClose).toEqual({ kind: "TP_LEG", value: 1 });
    expect(moveBe.commandType).toBe("MOVE_SL_TO_BE");
    expect(cancel.commandType).toBe("CANCEL_PENDING");
    expect(modifySl.commandType).toBe("MODIFY_SL");
    expect(modifySl.newStopLoss).toBe(1.083);
    expect(modifyTp.commandType).toBe("MODIFY_TP");
    expect(modifyTp.takeProfits[0]).toEqual({ leg: 2, price: 1.0975, allocationPercent: 25 });
  });

  test("preserves trailing stop pips and points for broker-side conversion", () => {
    const trailPips = parseSignalText("Trail stop Gold by 50 pips", context);
    const trailPoints = parseSignalText("XAUUSD trailing SL 500 points", context);
    const trailWithoutDistance = parseSignalText("Trail stop Gold", context);

    expect(trailPips.commandType).toBe("TRAILING_STOP");
    expect(trailPips.trailingStop).toEqual({ value: 50, unit: "PIPS" });
    expect(shouldRequireManualReview(trailPips)).toBe(false);
    expect(trailPoints.commandType).toBe("TRAILING_STOP");
    expect(trailPoints.trailingStop).toEqual({ value: 500, unit: "POINTS" });
    expect(trailPoints.warnings).not.toContain(
      "Trailing stop pips/points must be converted using the broker symbol point size",
    );
    expect(trailWithoutDistance.commandType).toBe("TRAILING_STOP");
    expect(trailWithoutDistance.missingFields).toContain("trailingStop");
    expect(shouldRequireManualReview(trailWithoutDistance)).toBe(true);
  });

  test("requires review for modify-SL lifecycle commands that do not include a stop price", () => {
    const missingPrice = parseSignalText("Modify SL EURUSD", context);
    const validPrice = parseSignalText("Modify SL EURUSD 1.0830", context);

    expect(missingPrice.commandType).toBe("MODIFY_SL");
    expect(missingPrice.newStopLoss).toBeUndefined();
    expect(missingPrice.missingFields).toContain("newStopLoss");
    expect(shouldRequireManualReview(missingPrice)).toBe(true);

    expect(validPrice.commandType).toBe("MODIFY_SL");
    expect(validPrice.newStopLoss).toBe(1.083);
    expect(validPrice.missingFields).not.toContain("newStopLoss");
    expect(shouldRequireManualReview(validPrice)).toBe(false);
  });

  test("parses KAL VIP style gold limit signals and ignores result chatter", () => {
    const kalContext: ParserContext = {
      providerId: "kal-vip",
      accountId: "mt5-demo-1",
      globalAliases: { GOLD: "XAUUSD" },
      providerDefaultSymbols: { "kal-vip": "XAUUSD" },
      accountMappings: context.accountMappings,
    };
    const signal = parseSignalText(
      "Gold sell limit\n\n4743-44\n\nSl 4749\n\nTp 4738\nTp 4731\nTp 4723\nTp 4700",
      kalContext,
    );
    const resultUpdate = parseSignalText("Sell 58 190pips", kalContext);
    const closedPositionsUpdate = parseSignalText(
      "Buy 4966 200pips ✅\n\nClosed most positions . Holding 1/2 for the next Tp level ✅\n\nNot a bad trade for the first set up of the week😊✅",
      kalContext,
    );
    const tpUpdate = parseSignalText("Done tp 1", kalContext);

    expect(signal).toMatchObject({
      commandType: "OPEN_TRADE",
      direction: "SELL",
      orderType: "LIMIT",
      rawSymbol: "Gold",
      canonicalSymbol: "XAUUSD",
      brokerSymbol: "XAUUSD.r",
      entry: { from: 4743, to: 4744 },
      stopLoss: 4749,
    });
    expect(signal.takeProfits.map((target) => target.price)).toEqual([4738, 4731, 4723, 4700]);
    expect(shouldRequireManualReview(signal)).toBe(false);
    expect(resultUpdate.commandType).toBe("NO_SIGNAL");
    expect(closedPositionsUpdate.commandType).toBe("NO_SIGNAL");
    expect(tpUpdate.commandType).toBe("MARK_TP_HIT");
  });

  test("applies provider defaults for market gold signals without explicit SL or TP", () => {
    const kalContext: ParserContext = {
      providerId: "kal-vip",
      accountId: "mt5-demo-1",
      globalAliases: { GOLD: "XAUUSD" },
      providerDefaultSymbols: { "kal-vip": "XAUUSD" },
      accountMappings: context.accountMappings,
      defaultStopLoss: { value: 50, unit: "PIPS" },
      defaultTakeProfit: { value: 200, unit: "PIPS" },
    };

    const signal = parseSignalText("Buy Gold now", kalContext);

    expect(signal.commandType).toBe("OPEN_TRADE");
    expect(signal.direction).toBe("BUY");
    expect(signal.orderType).toBe("MARKET");
    expect(signal.brokerSymbol).toBe("XAUUSD.r");
    expect(signal.defaultStopLoss).toEqual({ value: 50, unit: "PIPS" });
    expect(signal.defaultTakeProfit).toEqual({ value: 200, unit: "PIPS" });
    expect(signal.missingFields).not.toContain("stopLoss");
    expect(signal.missingFields).not.toContain("takeProfit");
    expect(shouldRequireManualReview(signal)).toBe(false);
  });

  test("splits directional zone posts into one defaulted pending limit per price line", () => {
    const kalContext: ParserContext = {
      providerId: "kal-vip",
      accountId: "mt5-demo-1",
      globalAliases: { GOLD: "XAUUSD" },
      providerDefaultSymbols: { "kal-vip": "XAUUSD" },
      accountMappings: context.accountMappings,
      defaultStopLoss: { value: 50, unit: "PIPS" },
      defaultTakeProfit: { value: 200, unit: "PIPS" },
    };

    const signals = parseSignalTexts("4512 \n4500 \n4580\n\nBuy zones", kalContext);

    expect(signals).toHaveLength(3);
    expect(signals.map((signal) => signal.entry?.from)).toEqual([4512, 4500, 4580]);
    expect(new Set(signals.map((signal) => signal.fingerprint)).size).toBe(3);
    for (const signal of signals) {
      expect(signal.commandType).toBe("OPEN_TRADE");
      expect(signal.direction).toBe("BUY");
      expect(signal.orderType).toBe("LIMIT");
      expect(signal.rawSymbol).toBe("XAUUSD");
      expect(signal.brokerSymbol).toBe("XAUUSD.r");
      expect(signal.defaultStopLoss).toEqual({ value: 50, unit: "PIPS" });
      expect(signal.defaultTakeProfit).toEqual({ value: 200, unit: "PIPS" });
      expect(signal.matchedPatternIds).toContain("open.directional-entry-zones");
      expect(shouldRequireManualReview(signal)).toBe(false);
    }

    const replyChatter = parseSignalTexts(
      [
        "Quoted signal:",
        "4512 ",
        "4500 ",
        "4580",
        "",
        "Buy zones",
        "",
        "Comment:",
        "Usually Sl depends on the entry model",
      ].join("\n"),
      kalContext,
    );
    expect(replyChatter).toHaveLength(1);
    expect(replyChatter[0]!.commandType).toBe("NO_SIGNAL");
  });

  test("expands KAL VIP extended short level commentary from a current symbol reference price", () => {
    const kalContext: ParserContext = {
      providerId: "kal-vip",
      accountId: "mt5-demo-1",
      globalAliases: { GOLD: "XAUUSD" },
      providerDefaultSymbols: { "kal-vip": "XAUUSD" },
      accountMappings: context.accountMappings,
      parserMode: "kal-vip-extended",
      referencePrices: { XAUUSD: 4444.2 },
      defaultStopLoss: { value: 50, unit: "PIPS" },
      defaultTakeProfit: { value: 200, unit: "PIPS" },
    };

    const signals = parseSignalTexts(
      [
        "First sell zone is the head on the pinbar",
        "",
        "Around 41 level",
        "",
        "Second sell is 56",
        "",
        "The 03 level can be a buy",
      ].join("\n"),
      kalContext,
    );

    expect(signals).toHaveLength(3);
    expect(signals.map((signal) => signal.direction)).toEqual(["SELL", "SELL", "BUY"]);
    expect(signals.map((signal) => signal.entry?.from)).toEqual([4441, 4456, 4403]);
    expect(new Set(signals.map((signal) => signal.fingerprint)).size).toBe(3);
    for (const signal of signals) {
      expect(signal.commandType).toBe("OPEN_TRADE");
      expect(signal.orderType).toBe("LIMIT");
      expect(signal.rawSymbol).toBe("XAUUSD");
      expect(signal.brokerSymbol).toBe("XAUUSD.r");
      expect(signal.defaultStopLoss).toEqual({ value: 50, unit: "PIPS" });
      expect(signal.defaultTakeProfit).toEqual({ value: 200, unit: "PIPS" });
      expect(signal.matchedPatternIds).toContain("open.kal-vip-extended-level");
      expect(shouldRequireManualReview(signal)).toBe(false);
    }
  });

  test("keeps KAL VIP short level commentary gated to extended mode with a reference price", () => {
    const baseContext: ParserContext = {
      providerId: "kal-vip",
      accountId: "mt5-demo-1",
      globalAliases: { GOLD: "XAUUSD" },
      providerDefaultSymbols: { "kal-vip": "XAUUSD" },
      accountMappings: context.accountMappings,
      defaultStopLoss: { value: 50, unit: "PIPS" },
      defaultTakeProfit: { value: 200, unit: "PIPS" },
    };
    const rawText = [
      "First sell zone is the head on the pinbar",
      "",
      "Around 41 level",
      "",
      "Second sell is 56",
      "",
      "The 03 level can be a buy",
    ].join("\n");

    expect(
      parseSignalTexts(rawText, {
        ...baseContext,
        parserMode: "deterministic",
        referencePrices: { XAUUSD: 4444.2 },
      }),
    ).toMatchObject([{ commandType: "NO_SIGNAL" }]);
    expect(
      parseSignalTexts(rawText, {
        ...baseContext,
        parserMode: "kal-vip-extended",
      }),
    ).toMatchObject([{ commandType: "NO_SIGNAL" }]);
  });

  test("parses broker copier NEW ORDER blocks without treating ticket numbers as entries", () => {
    const result = parseSignalText(
      [
        "NEW ORDER - XAUUSD Buy Stop 📈",
        "# 218981501",
        "",
        "----------{ NEW }----------",
        "Entry: 4723.00 [Lots: 0.01]",
        "SL:    4717.00",
        "TP:    4735.00",
        "---------------------------",
      ].join("\n"),
      {
        accountId: "mt5-demo-1",
        accountMappings: {
          "mt5-demo-1": {
            accountId: "mt5-demo-1",
            availableBrokerSymbols: ["XAUUSD"],
          },
        },
      },
    );

    expect(result.commandType).toBe("OPEN_TRADE");
    expect(result.rawSymbol).toBe("XAUUSD");
    expect(result.direction).toBe("BUY");
    expect(result.orderType).toBe("STOP");
    expect(result.entry).toEqual({ from: 4723 });
    expect(result.stopLoss).toBe(4717);
    expect(result.takeProfits.map((target) => target.price)).toEqual([4735]);
    expect(result.lotSize).toBe(0.01);
    expect(shouldRequireManualReview(result)).toBe(false);
  });

  test("inherits quoted signal context for close-half replies", () => {
    const kalContext: ParserContext = {
      providerId: "kal-vip",
      accountId: "mt5-demo-1",
      globalAliases: { GOLD: "XAUUSD" },
      providerDefaultSymbols: { "kal-vip": "XAUUSD" },
      accountMappings: context.accountMappings,
    };

    const signal = parseSignalText(
      "Quoted signal:\nGold buy limit 4105\nSL 4100\nTP 4115\n\nComment:\nClose half",
      kalContext,
    );

    expect(signal.commandType).toBe("CLOSE_PARTIAL");
    expect(signal.partialClose).toEqual({ kind: "PERCENT", value: 50 });
    expect(signal.canonicalSymbol).toBe("XAUUSD");
    expect(signal.brokerSymbol).toBe("XAUUSD.r");
    expect(signal.matchedPatternIds).toContain("quote.reply-context");
    expect(signal.missingFields).not.toContain("symbol");
    expect(shouldRequireManualReview(signal)).toBe(false);
  });

  test("uses Telegram quote context for put-this-back comments and extracts wall-of-text signals", () => {
    const kalContext: ParserContext = {
      providerId: "kal-vip",
      accountId: "mt5-demo-1",
      globalAliases: { GOLD: "XAUUSD" },
      providerDefaultSymbols: { "kal-vip": "XAUUSD" },
      accountMappings: context.accountMappings,
    };
    const reinstated = parseSignalText(
      "Quoted signal:\nGold buy limit 4688-87 Sl 4682 Tp 4693 Tp 4700 Tp 4708 Tp 4723\n\nComment:\nPut this back some boring news",
      kalContext,
    );
    const wallOfText = parseSignalText(
      [
        "Market Structure",
        "We had strong impulsive buying into the 4755-4760 area.",
        "Execution Model",
        "Sweep of 4700 , reversal",
        "Entry -4700-4690",
        "Sl below 4680",
        "Tp 4740-4759-4776-4797",
        "If gold starts holding below 4680 with displacement, the bullish idea weakens hard.",
      ].join("\n"),
      kalContext,
    );

    expect(reinstated.commandType).toBe("OPEN_TRADE");
    expect(reinstated.matchedPatternIds).toContain("quote.reinstated-signal");
    expect(reinstated.entry).toEqual({ from: 4688, to: 4687 });
    expect(reinstated.takeProfits.map((target) => target.price)).toEqual([4693, 4700, 4708, 4723]);
    expect(wallOfText.commandType).toBe("OPEN_TRADE");
    expect(wallOfText.direction).toBe("BUY");
    expect(wallOfText.matchedPatternIds).toContain("analysis.execution-block");
    expect(wallOfText.entry).toEqual({ from: 4700, to: 4690 });
    expect(wallOfText.stopLoss).toBe(4680);
    expect(wallOfText.takeProfits.map((target) => target.price)).toEqual([4740, 4759, 4776, 4797]);
  });

  test("separates KAL VIP education, result updates, and lifecycle updates", () => {
    const kalContext: ParserContext = {
      providerId: "kal-vip",
      accountId: "mt5-demo-1",
      globalAliases: { GOLD: "XAUUSD" },
      providerDefaultSymbols: { "kal-vip": "XAUUSD" },
      accountMappings: context.accountMappings,
    };
    const education = parseSignalText(
      "I know nobody took this trade. Pinbar valid entry. Next candle bullish. Buy on 50% of the wick. I will not provide signals for these.",
      kalContext,
    );
    const result = parseSignalText("Buy 66 full Tp 400pips ✅", kalContext);
    const lifecycle = parseSignalText("Tp 1 ✅", kalContext);
    const notReached = parseSignalText("Tp not reached yet\n\nContinue to monitor ✅", kalContext);
    const conditionalPlan = parseSignalText(
      "PRE-NFP SELL SCALPS\nOnly if price spikes up before news:\nEntry: 5076 - 5079\nSL: 5083 - 5085\nTP: 5066 - 5063\n\nPRE-NFP BUY SCALP\nIf price dumps to sweep lows first:\nEntry: 5054 - 5056\nSL: 5048 - 5049\nTP: 5066 - 5070\nAgain: reaction-based only, no blind entries.",
      kalContext,
    );
    const executable = parseSignalText(
      "Gold buy limit\n\n4522-21\n\nSl 4516\n\nTp 4527\nTp 4534\nTp 4542\nTp 4577",
      kalContext,
    );

    expect(education.commandType).toBe("NO_SIGNAL");
    expect(education.matchedPatternIds).toContain("noise.education-analysis");
    expect(result.commandType).toBe("MARK_TP_HIT");
    expect(lifecycle.commandType).toBe("MARK_TP_HIT");
    expect(lifecycle.brokerSymbol).toBe("XAUUSD.r");
    expect(lifecycle.missingFields).not.toContain("symbol");
    expect(notReached.commandType).toBe("NO_SIGNAL");
    expect(notReached.matchedPatternIds).toContain("noise.tp-not-reached");
    expect(conditionalPlan.commandType).toBe("TRADE_SETUP");
    expect(conditionalPlan.matchedPatternIds).toContain("setup.conditional-or-multi-scenario");
    expect(conditionalPlan.brokerSymbol).toBe("XAUUSD.r");
    expect(shouldRequireManualReview(conditionalPlan)).toBe(true);
    expect(executable.commandType).toBe("OPEN_TRADE");
    expect(executable.orderType).toBe("LIMIT");
    expect(executable.direction).toBe("BUY");
    expect(shouldRequireManualReview(executable)).toBe(false);
  });

  test("keeps KAL VIP buy and sell commentary as reviewable gold trade setups", () => {
    const kalContext: ParserContext = {
      providerId: "kal-vip",
      accountId: "mt5-demo-1",
      globalAliases: { GOLD: "XAUUSD" },
      providerDefaultSymbols: { "kal-vip": "XAUUSD" },
      accountMappings: context.accountMappings,
    };
    const setup = parseSignalText(
      "Execution Plan\nBuy: Range Low Sweep\nEntry: 4312-4315\nSL: 4306-4308\nTP1: 4326\nTP2: 4338\n\nSell: Range High Rejection\nEntry: 4338-4342\nSL: 4345-4347\nTP1: 4328\nTP2: 4315\n\nBreakout Trades wait for confirmation",
      kalContext,
    );

    expect(setup.commandType).toBe("TRADE_SETUP");
    expect(setup.canonicalSymbol).toBe("XAUUSD");
    expect(setup.brokerSymbol).toBe("XAUUSD.r");
    expect(setup.matchedPatternIds).toContain("setup.conditional-or-multi-scenario");
    expect(shouldRequireManualReview(setup)).toBe(true);
  });

  test("requires confirmation when execution-critical fields are missing or symbols are unmapped", () => {
    const result = parseSignalText("SELL UNKNOWNPAIR now\nTP1 1.1000", context);

    expect(result.commandType).toBe("OPEN_TRADE");
    expect(result.mappingStatus).toBe("unmapped");
    expect(result.missingFields).toContain("stopLoss");
    expect(result.warnings).toContain("Symbol could not be mapped to a broker symbol");
    expect(shouldRequireManualReview(result)).toBe(true);
  });

  test("infers locked-symbol geometry and holds the incident when it also references stops", () => {
    const incident = [
      "You can still place stops for 60 ",
      "",
      "And limits here ",
      "",
      "4023-22",
      "",
      "Sl 4017",
      "",
      "Tp 4028",
      "Tp 4035",
      "Tp 4041",
    ].join("\n");
    const geometryContext: ParserContext = {
      ...context,
      providerId: "kal-vip",
      geometryInferenceSymbol: "XAUUSD",
      referencePrices: { XAUUSD: 4050 },
    };
    const held = parseSignalText(incident, geometryContext);
    const clean = parseSignalText(
      incident.replace("You can still place stops for 60 \n\n", ""),
      geometryContext,
    );

    expect(held).toMatchObject({
      commandType: "OPEN_TRADE",
      direction: "BUY",
      orderType: "LIMIT",
      entry: { from: 4023, to: 4022 },
      stopLoss: 4017,
      canonicalSymbol: "XAUUSD",
    });
    expect(held.takeProfits.map((target) => target.price)).toEqual([4028, 4035, 4041]);
    expect(held.matchedPatternIds).toContain("open.geometry-inferred");
    expect(held.warnings).toContain(
      "Geometry-inferred signal also references pending stops at 4060",
    );
    expect(shouldRequireManualReview(held)).toBe(true);
    expect(clean).toMatchObject({
      commandType: "OPEN_TRADE",
      direction: "BUY",
      orderType: "LIMIT",
    });
    expect(shouldRequireManualReview(clean)).toBe(false);
  });

  test("fails closed around geometry inference ambiguity and quoted or recap text", () => {
    const geometryContext: ParserContext = {
      ...context,
      providerId: "kal-vip",
      providerDefaultSymbols: { "kal-vip": "XAUUSD" },
      geometryInferenceSymbol: "XAUUSD",
      referencePrices: { XAUUSD: 4050 },
    };
    const sell = parseSignalText(
      "And limits here\n\n4077-78\n\nSL 4083\n\nTP 4072\nTP 4065\nTP 4058",
      geometryContext,
    );
    const inconsistent = parseSignalText(
      "And limits here\n\n4023-22\n\nSL 4025\n\nTP 4028\nTP 4019",
      geometryContext,
    );
    const unlocked = parseSignalText("And limits here\n\n4023-22\n\nSL 4017\n\nTP 4028", {
      ...geometryContext,
      geometryInferenceSymbol: undefined,
    });
    const quoted = parseSignalText(
      "Quoted signal:\nAnd limits here\n\n4023-22\n\nSL 4017\n\nTP 4028\n\nComment:\n",
      geometryContext,
    );
    const recap = parseSignalText("we got 50 pips… entry 4023 sl 4017 tp 4028", geometryContext);

    expect(sell).toMatchObject({
      commandType: "OPEN_TRADE",
      direction: "SELL",
      orderType: "LIMIT",
      entry: { from: 4077, to: 4078 },
      stopLoss: 4083,
    });
    expect(sell.takeProfits.map((target) => target.price)).toEqual([4072, 4065, 4058]);
    expect(shouldRequireManualReview(sell)).toBe(false);
    expect(inconsistent.commandType).toBe("NO_SIGNAL");
    expect(unlocked.commandType).toBe("NO_SIGNAL");
    expect(quoted.commandType).toBe("NO_SIGNAL");
    expect(recap.commandType).toBe("NO_SIGNAL");
  });

  test("keeps stop-loss distinct from plural pending stops and infers missing order types safely", () => {
    const geometryContext: ParserContext = {
      ...context,
      providerId: "kal-vip",
      geometryInferenceSymbol: "XAUUSD",
      referencePrices: { XAUUSD: 4050 },
    };
    const stopLoss = parseSignalText("4023-22\nSTOP LOSS 4017\nTP 4028", geometryContext);
    const pluralStop = parseSignalText("STOPS FOR 60\n4023-22\nSL 4017\nTP 4028", geometryContext);
    const noReference = parseSignalText("4023-22\nSL 4017\nTP 4028", {
      ...geometryContext,
      referencePrices: {},
    });
    const conflictingLimit = parseSignalText(
      "LIMITS HERE\n4060-61\nSL 4055\nTP 4068",
      geometryContext,
    );

    expect(stopLoss.orderType).toBe("LIMIT");
    expect(pluralStop.orderType).toBe("STOP");
    expect(shouldRequireManualReview(pluralStop)).toBe(true);
    expect(noReference.orderType).toBeUndefined();
    expect(noReference.missingFields).toContain("orderType");
    expect(shouldRequireManualReview(noReference)).toBe(true);
    expect(conflictingLimit.orderType).toBe("LIMIT");
    expect(shouldRequireManualReview(conflictingLimit)).toBe(true);
  });

  test("expands short levels to the nearest hundred block", () => {
    for (const [referencePrice, level, expected] of [
      [4050, "60", 4060],
      [4095, "5", 4105],
      [4005, "95", 3995],
    ] as const) {
      const [signal] = parseSignalTexts(`Buy is at ${level}`, {
        providerId: "kal-vip",
        parserMode: "kal-vip-extended",
        providerDefaultSymbols: { "kal-vip": "XAUUSD" },
        referencePrices: { XAUUSD: referencePrice },
      });
      expect(signal?.entry?.from).toBe(expected);
    }
  });
});

describe("symbol resolver", () => {
  test("applies provider alias, account override, global alias, prefix/suffix, then fallback in order", () => {
    expect(resolveSymbol("GOLD", context)).toMatchObject({
      rawSymbol: "GOLD",
      canonicalSymbol: "XAUUSD",
      brokerSymbol: "XAUUSD.r",
      mappingStatus: "mapped",
    });

    expect(resolveSymbol("US30", context)).toMatchObject({
      canonicalSymbol: "DJI30",
      brokerSymbol: "DJI30.raw",
      mappingStatus: "mapped",
    });
  });

  test("maps direct provider-to-broker overrides before the canonical recognition gate", () => {
    expect(
      resolveSymbol("GOLD", {
        accountId: "mt5-direct",
        globalAliases: { GOLD: "XAUUSD.RAW" },
        accountMappings: {
          "mt5-direct": {
            accountId: "mt5-direct",
            directBrokerOverrides: { GOLD: "XAUUSD.raw" },
            availableBrokerSymbols: ["XAUUSD.raw", "XAUUSD.pro"],
          },
        },
      }),
    ).toMatchObject({
      canonicalSymbol: "XAUUSD",
      brokerSymbol: "XAUUSD.raw",
      mappingStatus: "mapped",
      mappingSource: "account_direct",
    });
  });

  test("applies account safety checks to direct provider-to-broker overrides", () => {
    const accountId = "mt5-direct-safe";
    const direct = {
      accountId,
      directBrokerOverrides: { GOLD: "XAUUSD.raw" },
      availableBrokerSymbols: ["XAUUSD.raw"],
    };

    expect(
      resolveSymbol("GOLD", {
        accountId,
        accountMappings: { [accountId]: { ...direct, excludeSymbols: ["XAUUSD.raw"] } },
      }),
    ).toMatchObject({ mappingStatus: "excluded", mappingSource: "account_direct" });
    expect(
      resolveSymbol("GOLD.", {
        accountId,
        accountMappings: {
          [accountId]: { ...direct, availableBrokerSymbols: ["XAUUSD.pro"] },
        },
      }),
    ).toMatchObject({ mappingStatus: "unavailable", mappingSource: "account_direct" });
  });

  test("marks excluded and unavailable mapped symbols distinctly", () => {
    const excluded = resolveSymbol("EURUSD", {
      ...context,
      accountMappings: {
        "mt5-demo-1": {
          ...context.accountMappings!["mt5-demo-1"]!,
          excludeSymbols: ["EURUSD.raw"],
        },
      },
    });
    expect(excluded.mappingStatus).toBe("excluded");

    const unavailable = resolveSymbol("EURUSD", {
      ...context,
      accountMappings: {
        "mt5-demo-1": {
          ...context.accountMappings!["mt5-demo-1"]!,
          availableBrokerSymbols: ["XAUUSD.r"],
        },
      },
    });
    expect(unavailable.mappingStatus).toBe("unavailable");
  });

  test("prefers EA-reported exact broker symbols over configured suffixes", () => {
    const octaContext: ParserContext = {
      accountId: "mt5-octa",
      accountMappings: {
        "mt5-octa": {
          accountId: "mt5-octa",
          suffix: ".raw",
          availableBrokerSymbols: ["BTCUSD", "XAUUSD", "EURUSD"],
        },
      },
    };

    expect(resolveSymbol("BTCUSD", octaContext)).toMatchObject({
      canonicalSymbol: "BTCUSD",
      brokerSymbol: "BTCUSD",
      mappingStatus: "mapped",
    });
    expect(resolveSymbol("GOLD", octaContext)).toMatchObject({
      canonicalSymbol: "XAUUSD",
      brokerSymbol: "XAUUSD",
      mappingStatus: "mapped",
    });
  });

  test("maps known broker variants only when the EA reports those symbols", () => {
    const variantContext: ParserContext = {
      accountId: "mt5-variant",
      accountMappings: {
        "mt5-variant": {
          accountId: "mt5-variant",
          availableBrokerSymbols: ["BTCUSDm", "BTCUSD.raw", "GOLD#"],
        },
      },
    };

    expect(resolveSymbol("BTCUSD", variantContext)).toMatchObject({
      canonicalSymbol: "BTCUSD",
      brokerSymbol: "BTCUSDm",
      mappingStatus: "mapped",
    });
    expect(resolveSymbol("GOLD", variantContext)).toMatchObject({
      canonicalSymbol: "XAUUSD",
      brokerSymbol: "GOLD#",
      mappingStatus: "mapped",
    });

    const unavailable = resolveSymbol("XAUUSD", {
      accountId: "mt5-no-gold",
      accountMappings: {
        "mt5-no-gold": {
          accountId: "mt5-no-gold",
          availableBrokerSymbols: ["BTCUSDm"],
        },
      },
    });
    expect(unavailable.mappingStatus).toBe("unavailable");
  });

  test("maps HF-style XAUUSDr gold symbols from the EA inventory", () => {
    const hfContext: ParserContext = {
      accountId: "mt5-hf",
      accountMappings: {
        "mt5-hf": {
          accountId: "mt5-hf",
          availableBrokerSymbols: ["XAUUSDr", "EURUSDr"],
        },
      },
    };

    expect(resolveSymbol("GOLD", hfContext)).toMatchObject({
      canonicalSymbol: "XAUUSD",
      brokerSymbol: "XAUUSDr",
      mappingStatus: "mapped",
    });

    const signal = parseSignalText("Gold buy limit\n\n4487-86\n\nSL 4481\n\nTP 4492", hfContext);
    expect(signal.brokerSymbol).toBe("XAUUSDr");
    expect(shouldRequireManualReview(signal)).toBe(false);
  });

  test("uses configured prefix and suffix after exact and known-variant matching", () => {
    const suffixContext: ParserContext = {
      accountId: "mt5-suffix",
      accountMappings: {
        "mt5-suffix": {
          accountId: "mt5-suffix",
          prefix: "m.",
          suffix: ".pro",
          availableBrokerSymbols: ["m.EURUSD.pro"],
        },
      },
    };

    expect(resolveSymbol("EURUSD", suffixContext)).toMatchObject({
      canonicalSymbol: "EURUSD",
      brokerSymbol: "m.EURUSD.pro",
      mappingStatus: "mapped",
    });
  });
});

describe("French vocabulary normalization", () => {
  test("parses a symbol-first French buy signal", () => {
    const result = parseSignalText("XAUUSD ACHAT 5062 SL 5048 TP 5073 TP 5080 TP 5110", context);
    expect(result).toMatchObject({
      commandType: "OPEN_TRADE",
      direction: "BUY",
      canonicalSymbol: "XAUUSD",
      entry: { from: 5062 },
      stopLoss: 5048,
    });
  });

  test("parses a verb-first French sell signal with article, filler and comma decimals", () => {
    const result = parseSignalText(
      "VENDRE L'EURNZD MAINTENANT À 1,99190 SL À 1,99700 TP À 1,98600 TP À 1,98000",
      context,
    );
    expect(result).toMatchObject({
      commandType: "OPEN_TRADE",
      direction: "SELL",
      canonicalSymbol: "EURNZD",
      entry: { from: 1.9919 },
      stopLoss: 1.997,
    });
  });

  test("does not open a trade on French market commentary with no levels", () => {
    expect(parseSignalText("GOLD Je patiente pour une vente", context).commandType).not.toBe(
      "OPEN_TRADE",
    );
    expect(parseSignalText("Ne chercher pas d'achat privilègier les ventes", context).commandType).toBe(
      "NO_SIGNAL",
    );
  });

  test("leaves English signals byte-identical (no French tokens present)", () => {
    const english = "SELL EURUSD 1.0850\nSL 1.0900\nTP1 1.0800";
    const before = parseSignalText(english, context);
    expect(before).toMatchObject({
      commandType: "OPEN_TRADE",
      direction: "SELL",
      canonicalSymbol: "EURUSD",
      entry: { from: 1.085 },
      stopLoss: 1.09,
    });
  });
});

describe("WTI / crude oil recognition", () => {
  test("classifies a WTI signal as an open trade mapped to USOIL", () => {
    const result = parseSignalText("WTI SELL 58.05\nSL 58.80\nTP 57.40\nTP 57.00", context);
    expect(result).toMatchObject({
      commandType: "OPEN_TRADE",
      direction: "SELL",
      canonicalSymbol: "USOIL",
      entry: { from: 58.05 },
      stopLoss: 58.8,
    });
    expect(result.takeProfits.length).toBeGreaterThan(0);
  });

  test("recognises the USOIL and CRUDE aliases as the same instrument", () => {
    for (const raw of ["USOIL", "CRUDE"]) {
      expect(parseSignalText(`${raw} BUY 59.70\nSL 58.30\nTP 60.50`, context)).toMatchObject({
        commandType: "OPEN_TRADE",
        direction: "BUY",
        canonicalSymbol: "USOIL",
      });
    }
  });
});

describe("VIP Gold order lifecycle formats", () => {
  test("classifies a Deleted order as a cancel keyed to its order id, not a new open", () => {
    const result = parseSignalText("❌ Deleted Buy Stop on XAUUSD\n# 297968962", context);
    expect(result.commandType).toBe("CANCEL_PENDING");
    expect(result.canonicalSymbol).toBe("XAUUSD");
    expect(result.providerOrderId).toBe("297968962");
    // The order id must never leak into an entry price.
    expect(result.entry).toBeUndefined();
  });

  test("still parses a NEW ORDER as an open and captures its order id", () => {
    const result = parseSignalText(
      "NEW ORDER - XAUUSD Sell Stop 📉\n# 299490138\n\n----------{ NEW }----------\nEntry: 3989.90 [Lots: 0.01]\nSL:    3995.90\nTP:    3977.90\n---------------------------",
      context,
    );
    expect(result).toMatchObject({
      commandType: "OPEN_TRADE",
      direction: "SELL",
      canonicalSymbol: "XAUUSD",
      entry: { from: 3989.9 },
      stopLoss: 3995.9,
      providerOrderId: "299490138",
    });
  });

  test("classifies a provider CLOSED report as a close keyed to its order id", () => {
    const result = parseSignalText(
      "🟢 CLOSED - XAUUSD Sell 🟢\n# 298696672\n\n--------{ CLOSED }---------\nProfit: 2.01$\nProfit: 0.19%",
      context,
    );
    expect(result.commandType).toBe("CLOSE_TRADE");
    expect(result.canonicalSymbol).toBe("XAUUSD");
    expect(result.providerOrderId).toBe("298696672");
  });
});

describe("stock index symbol recognition", () => {
  test("classifies digit-bearing index tickers as open trades", () => {
    const expectations: Array<[string, string]> = [
      // the shared test context maps US30 -> DJI30 via globalAliases (alias wins).
      ["US30 BUY 39000\nSL 38900\nTP 39200", "DJI30"],
      ["NAS100 SELL 18000\nSL 18100\nTP 17800", "NAS100"],
      ["US100 BUY 18000\nSL 17900\nTP 18200", "US100"],
      ["SPX500 SELL 5100\nSL 5130\nTP 5050", "SPX500"],
      ["GER40 BUY 18500\nSL 18400\nTP 18700", "GER40"],
      ["UK100 BUY 8100\nSL 8050\nTP 8200", "UK100"],
    ];
    for (const [text, sym] of expectations) {
      expect(parseSignalText(text, context)).toMatchObject({
        commandType: "OPEN_TRADE",
        canonicalSymbol: sym,
      });
    }
  });

  test("maps common index aliases to their canonical instrument", () => {
    expect(parseSignalText("SP500 SELL 5100\nSL 5130\nTP 5050", context).canonicalSymbol).toBe(
      "SPX500",
    );
    expect(parseSignalText("DAX BUY 18500\nSL 18400\nTP 18700", context).canonicalSymbol).toBe(
      "GER40",
    );
    expect(parseSignalText("NASDAQ SELL 18000\nSL 18100\nTP 17800", context).canonicalSymbol).toBe(
      "NAS100",
    );
  });
});

describe("symbol not adjacent to the direction word", () => {
  test("extracts a ticker from its own line / tag / slash pair", () => {
    const cases: Array<[string, string]> = [
      ["XAUUSD (ELVIS)\nBuy limit @ 4140\nSL 4110\nTP 4170", "XAUUSD"],
      ["Nas100/US100 (ELVIS)\nBuy limit @ 29000\nSL 28750\nTP 29250", "NAS100"],
      ["NZDUSD (ELVIS)\nBuy limit @ 0.56592\nTP 0.56995\nSL 0.56175", "NZDUSD"],
      ["XAUUSD/GOLD\nBuy limit @4036\nTP 4066\nSL 4000", "XAUUSD"],
    ];
    for (const [text, sym] of cases) {
      expect(parseSignalText(text, context)).toMatchObject({
        commandType: "OPEN_TRADE",
        canonicalSymbol: sym,
      });
    }
  });

  test("does not treat commentary words as tickers", () => {
    const result = parseSignalText("BUY OPPORTUNITY 4050\nSL 4040\nTP 4070", context);
    expect(result.canonicalSymbol).not.toBe("OPPORTUNITY");
  });
});
