import { describe, expect, test } from "bun:test";
import {
  createLogicalTradeFromSignal,
  MAX_TAKE_PROFIT_LEGS,
  matchLifecycleCommandToTrade,
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

  test("extracts ten labelled TP legs, including TP 10, without treating it as TP 1", () => {
    const labels = Array.from(
      { length: MAX_TAKE_PROFIT_LEGS },
      (_, index) => `TP${index + 1} ${1.2 + index / 100}`,
    );
    const result = parseSignalText(
      ["BUY EUR/USD @ 1.1000", "SL 1.0900", ...labels].join("\n"),
      context,
    );

    expect(result.takeProfits).toHaveLength(MAX_TAKE_PROFIT_LEGS);
    expect(result.takeProfits.at(-1)).toMatchObject({ leg: 10, price: 1.29 });
    expect(result.warnings).not.toContainEqual(expect.stringContaining("truncated"));

    const spaced = parseSignalText(
      "BUY EUR/USD @ 1.1000\nSL 1.0900\nTP 2: 1.2200\nTP 10: 1.3000",
      context,
    );
    expect(spaced.takeProfits).toEqual([
      { leg: 2, price: 1.22, allocationPercent: 25 },
      { leg: 10, price: 1.3, allocationPercent: 25 },
    ]);
  });

  test("keeps dash-separated targets through the ten-leg cap and warns on truncation", () => {
    const dashTargets = parseSignalText(
      "BUY EUR/USD @ 1.1000\nSL 1.0900\nTP 1.20 - 1.21 - 1.22 - 1.23 - 1.24 - 1.25",
      context,
    );
    expect(dashTargets.takeProfits.map((target) => target.price)).toEqual([
      1.2, 1.21, 1.22, 1.23, 1.24, 1.25,
    ]);

    const elevenTargets = parseSignalText(
      [
        "BUY EUR/USD @ 1.1000",
        "SL 1.0900",
        ...Array.from({ length: MAX_TAKE_PROFIT_LEGS + 1 }, (_, index) => `TP 1.${20 + index}`),
      ].join("\n"),
      context,
    );
    expect(elevenTargets.takeProfits).toHaveLength(MAX_TAKE_PROFIT_LEGS);
    expect(elevenTargets.warnings).toContainEqual(
      expect.stringMatching(/^Take-profit list was truncated/),
    );
    expect(shouldRequireManualReview(elevenTargets)).toBe(true);
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

    expect(closeHalf.commandType).toBe("CLOSE_TRADE");
    expect(closeHalf.partialClose).toBeUndefined();
    expect(closeHalfNoSymbol.commandType).toBe("CLOSE_TRADE");
    expect(closeHalfNoSymbol.partialClose).toBeUndefined();
    expect(closeTp1.partialClose).toEqual({ kind: "TP_LEG", value: 1 });
    expect(moveBe.commandType).toBe("MOVE_SL_TO_BE");
    expect(cancel.commandType).toBe("CANCEL_PENDING");
    expect(modifySl.commandType).toBe("MODIFY_SL");
    expect(modifySl.newStopLoss).toBe(1.083);
    expect(modifyTp.commandType).toBe("MODIFY_TP");
    expect(modifyTp.takeProfits[0]).toEqual({ leg: 2, price: 1.0975, allocationPercent: 25 });
  });

  test("reads remove/scrap/take-off replies on a pending order as a cancel", () => {
    const kalRemove = parseSignalText(
      "Quoted signal:\nGold sell limit \n\n4126-27\n\nSl 4132\n\nTp 4121\nTp 4114\nTp 4108\n\nComment:\nRemove … I don't like this heavy consolidation",
      context,
    );
    const scrap = parseSignalText(
      "Quoted signal:\nGold buy limit 4112 sl 4106 tp 4117\n\nComment:\nscrap it",
      context,
    );
    const takeOff = parseSignalText(
      "Quoted signal:\nGold sell limit 4126 sl 4132 tp 4121\n\nComment:\ntake it off",
      context,
    );
    const positives = [
      "pull this order",
      "delete the limit",
      "remove this pending order",
      "Take this order off.",
      "Remove pending.",
      "Remove this pending order — SL is too wide.",
    ].map((text) => parseSignalText(text, context));

    expect(kalRemove.commandType).toBe("CANCEL_PENDING");
    expect(scrap.commandType).toBe("CANCEL_PENDING");
    expect(takeOff.commandType).toBe("CANCEL_PENDING");
    for (const signal of positives) {
      expect(signal.commandType).toBe("CANCEL_PENDING");
    }
  });

  test("keeps the real KAL cancel command while rejecting its English noun as a symbol", () => {
    const signal = parseSignalText("Cancel other entries\n\nWe done today");

    expect(signal.commandType).toBe("CANCEL_PENDING");
    expect(signal.rawSymbol).toBeUndefined();
    expect(signal.canonicalSymbol).toBeUndefined();
    expect(signal.brokerSymbol).toBeUndefined();
  });

  test("does not treat SL/TP edits, partials, chatter, negation, or teaching as a cancel", () => {
    const negatives = [
      "remove your SL",
      "remove the tp",
      "take off half",
      "remove partial",
      "removed 50% at tp",
      "price will pull back to entry then continue",
      "I'll remove this later",
      "might scrap it",
      "Don't get rid of this order.",
      "Gold should remove this resistance before the next push.",
      "For example, remove this order from your chart and redraw it.",
    ];
    for (const text of negatives) {
      expect(parseSignalText(text, context).commandType).not.toBe("CANCEL_PENDING");
    }
  });

  test("does not treat conversational TP prose as a modify command", () => {
    const incident = parseSignalText(
      "I mean technically london hasn't opened yet but come on ... yesterday we waiting hours for a set up to hit Tp ... But last night we had a 500pip fly",
      context,
    );

    expect(incident.commandType).toBe("NO_SIGNAL");
    expect(incident.matchedPatternIds).not.toContain("lifecycle.modify-tp");
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
    expect(closedPositionsUpdate.commandType).toBe("CLOSE_TRADE");
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
      shorthandLevels: true,
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

  test("keeps KAL VIP short level commentary gated to the shorthand-levels capability", () => {
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

    // Capability off + reference price present -> still gated (no phantom opens).
    expect(
      parseSignalTexts(rawText, {
        ...baseContext,
        referencePrices: { XAUUSD: 4444.2 },
      }),
    ).toMatchObject([{ commandType: "NO_SIGNAL" }]);
    // Capability on but no reference price -> nothing to expand from.
    expect(
      parseSignalTexts(rawText, {
        ...baseContext,
        shorthandLevels: true,
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

  test("inherits quoted signal context for provider close replies", () => {
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

    expect(signal.commandType).toBe("CLOSE_TRADE");
    expect(signal.partialClose).toBeUndefined();
    expect(signal.canonicalSymbol).toBe("XAUUSD");
    expect(signal.brokerSymbol).toBe("XAUUSD.r");
    expect(signal.matchedPatternIds).toContain("quote.reply-context");
    expect(signal.missingFields).not.toContain("symbol");
    expect(shouldRequireManualReview(signal)).toBe(false);
  });

  test("reopens a quoted signal only on an explicit put-back and extracts wall-of-text signals", () => {
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
        shorthandLevels: true,
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

  test("maps index m and .F variants without selecting leveraged instruments", () => {
    expect(
      resolveSymbol("NAS100", {
        accountId: "mt5-exness-index",
        accountMappings: {
          "mt5-exness-index": {
            accountId: "mt5-exness-index",
            availableBrokerSymbols: ["USTEC_x100m", "USTECm"],
          },
        },
      }),
    ).toMatchObject({ canonicalSymbol: "NAS100", brokerSymbol: "USTECm", mappingStatus: "mapped" });
    expect(
      resolveSymbol("US30", {
        accountId: "mt5-exness-dow",
        accountMappings: {
          "mt5-exness-dow": {
            accountId: "mt5-exness-dow",
            availableBrokerSymbols: ["US30_x10m", "US30m"],
          },
        },
      }),
    ).toMatchObject({ canonicalSymbol: "US30", brokerSymbol: "US30m", mappingStatus: "mapped" });

    for (const [rawSymbol, availableBrokerSymbol, canonicalSymbol] of [
      ["US100", "US100.F", "NAS100"],
      ["US30", "US30.F", "US30"],
      ["US500", "US500.F", "SPX500"],
      ["DE30", "DE30m", "GER40"],
      ["GER40", "GER40.F", "GER40"],
    ] as const) {
      expect(
        resolveSymbol(rawSymbol, {
          accountId: `mt5-${rawSymbol}`,
          accountMappings: {
            [`mt5-${rawSymbol}`]: {
              accountId: `mt5-${rawSymbol}`,
              availableBrokerSymbols: [availableBrokerSymbol],
            },
          },
        }),
      ).toMatchObject({
        canonicalSymbol,
        brokerSymbol: availableBrokerSymbol,
        mappingStatus: "mapped",
      });
    }

    expect(
      resolveSymbol("NAS100", {
        accountId: "mt5-leveraged-nas",
        accountMappings: {
          "mt5-leveraged-nas": {
            accountId: "mt5-leveraged-nas",
            availableBrokerSymbols: ["USTEC_x100m"],
          },
        },
      }),
    ).toMatchObject({ mappingStatus: "unavailable" });
    expect(
      resolveSymbol("US30", {
        accountId: "mt5-leveraged-dow",
        accountMappings: {
          "mt5-leveraged-dow": {
            accountId: "mt5-leveraged-dow",
            availableBrokerSymbols: ["US30_x10m"],
          },
        },
      }),
    ).toMatchObject({ mappingStatus: "unavailable" });
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
    expect(
      parseSignalText("Ne chercher pas d'achat privilègier les ventes", context).commandType,
    ).toBe("NO_SIGNAL");
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

describe("a quoted block never re-opens except on an explicit put-back", () => {
  const quoted =
    "Quoted signal:\nNEW ORDER - XAUUSD Buy Stop\n# 300424022\n\n----------{ NEW }----------\nEntry: 4023.80 [Lots: 0.01]\nSL:    4017.80\nTP:    4035.80\n---------------------------";

  test("ordinary reply prose and empty comments do not recreate the quoted order", () => {
    // A loose BACK ON once matched "I will be back on Monday" and reopened the quoted
    // order; an empty comment fell through to the quoted payload and did the same.
    // Both recreate the phantom duplicate trade from the 2026-07-20 incident.
    for (const comment of ["I will be back on Monday", "", "thanks mate", "watching this one"]) {
      const result = parseSignalText(`${quoted}\n\nComment:\n${comment}`, context);
      expect(result.commandType).toBe("NO_SIGNAL");
      expect(result.entry).toBeUndefined();
    }
  });

  test("an explicit put-back still reinstates the quoted signal", () => {
    for (const comment of ["Put this back on", "put it back", "Reinstate this"]) {
      const result = parseSignalText(`${quoted}\n\nComment:\n${comment}`, context);
      expect(result.commandType).toBe("OPEN_TRADE");
      expect(result.matchedPatternIds).toContain("quote.reinstated-signal");
      expect(result.entry).toEqual({ from: 4023.8 });
    }
  });

  test("keeps a cancel first and parses a replacement only from the comment", () => {
    const results = parseSignalTexts(
      "Quoted signal:\nGold sell\n\n4028-29\n\nSl 4034\n\nTp 4023\nTp 4016\nTp 4010\n\nComment:\nCancel this … price dropped from 24 instead of 28 soo it's technically missed . We can sell from 4043 instead",
      context,
    );

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ commandType: "CANCEL_PENDING" });
    expect(results[1]).toMatchObject({
      commandType: "OPEN_TRADE",
      direction: "SELL",
      entry: { from: 4043 },
    });
    expect(results[1]?.matchedPatternIds).toContain("quote.comment-replacement");
  });

  test("recognizes conservative pending-order removal replies", () => {
    const removeReply = parseSignalText(
      "Quoted signal:\nGold sell limit 4126 sl 4132 tp 4121\n\nComment:\nRemove, I don't like this heavy consolidation",
      context,
    );
    expect(removeReply.commandType).toBe("CANCEL_PENDING");

    for (const text of [
      // Pronoun-only removals need real context: a quoted pending order or an order noun.
      "Quoted signal:\nGold buy limit 4112 sl 4106 tp 4117\n\nComment:\nscrap it",
      "Quoted signal:\nGold sell limit 4126 sl 4132 tp 4121\n\nComment:\ntake it off",
      "pull this order",
      "delete the limit",
    ]) {
      expect(parseSignalText(text, context).commandType).toBe("CANCEL_PENDING");
    }
  });

  test("does not treat risk or partial removal as a pending-order cancel", () => {
    for (const text of [
      "remove your SL",
      "remove the tp",
      "take off half",
      "remove partial",
      "removed 50% at tp",
    ]) {
      expect(parseSignalText(text, context).commandType).not.toBe("CANCEL_PENDING");
    }
  });
});

describe("deferred and negated prose never becomes a command", () => {
  // Providers mix banter with signals in the same channel. "Close watch on Gold"
  // previously became CLOSE_TRADE because isCloseCommand accepted any leading CLOSE,
  // which would have closed a live position.
  test("treats negated, deferred and educational prose as noise", () => {
    for (const text of [
      "Buy Gold only after confirmation — not now.",
      "Close watch on Gold today; wait for NFP.",
      "Education only: always set your SL below structure. Gold invalidation is 4000.",
      "Don't buy gold here",
      "No trade on gold today, wait for the retest",
    ]) {
      const result = parseSignalText(text, context);
      expect(result.commandType).toBe("NO_SIGNAL");
    }
  });

  test("treats typographic apostrophes the same as ASCII apostrophes", () => {
    const ascii = parseSignalText("BUY GOLD NOW - don't miss", context);
    const typographic = parseSignalText("BUY GOLD NOW - don’t miss", context);

    expect(ascii.commandType).toBe("NO_SIGNAL");
    expect(typographic.commandType).toBe(ascii.commandType);
  });

  test("still executes genuine signals that carry real levels", () => {
    const signal = parseSignalText(
      "Gold sell\n\n4028-29\n\nSl 4034\n\nTp 4023\nTp 4016\nTp 4010",
      context,
    );
    expect(signal.commandType).toBe("OPEN_TRADE");
    expect(signal.direction).toBe("SELL");
    expect(signal.entry).toEqual({ from: 4028, to: 4029 });
    expect(signal.stopLoss).toBe(4034);

    const terse = parseSignalText("Close TP1 EURUSD", context);
    expect(terse.commandType).toBe("CLOSE_PARTIAL");
  });
});

describe("VIP Gold order lifecycle formats", () => {
  test("treats activation replies as lifecycle context, never a new entry", () => {
    const result = parseSignalText(
      "Quoted signal:\nNEW ORDER - XAUUSD Buy Stop 🚀\n# 300424022\n\n----------{ NEW }----------\nEntry: 4023.80 [Lots: 0.01]\nSL:    4017.80\nTP:    4035.80\n---------------------------\n\nComment:\n🚀 Buy Stop activated 🚀\n# 300424022",
      context,
    );
    expect(result.commandType).toBe("NO_SIGNAL");
    expect(result.matchedPatternIds).toContain("quote.reply-context");
    expect(result.matchedPatternIds).toContain("lifecycle.activation");
  });

  test("classifies every quoted NEW-order status before open detection", () => {
    const statuses = [
      ["activated", "NO_SIGNAL"],
      ["triggered", "NO_SIGNAL"],
      ["filled", "NO_SIGNAL"],
      ["executed", "NO_SIGNAL"],
      ["deleted", "CANCEL_PENDING"],
      ["modified", "NO_SIGNAL"],
    ] as const;
    for (const direction of ["Buy", "Sell"] as const) {
      for (const [status, commandType] of statuses) {
        for (const emoji of ["", "🚀 "]) {
          for (const trailing of [false, true]) {
            const result = parseSignalText(
              `Quoted signal: NEW ORDER - XAUUSD ${direction} Stop # 306947863 Entry: 4051.30 SL: 4057.30 TP: 4039.30 --- Comment: ${emoji}${direction} Stop ${status} # 306947863${trailing ? " XAUUSD @ 4051.30" : ""}`,
              context,
            );
            expect(result.commandType).toBe(commandType);
            expect(result.entry).toBeUndefined();
            expect(result.providerOrderId).toBe("306947863");
          }
        }
      }
    }
  });

  test("keeps a fully valid quoted modification lifecycle command executable", () => {
    const result = parseSignalText(
      "Quoted signal: NEW ORDER - XAUUSD Buy Stop # 306947863 Entry: 4051.30 SL: 4057.30 TP: 4039.30 --- Comment: XAUUSD modified SL 4048",
      context,
    );
    expect(result).toMatchObject({ commandType: "MODIFY_SL", newStopLoss: 4048 });
    expect(result.entry).toBeUndefined();
  });

  test("treats the live Sell Stop activation with a trailing quote as lifecycle context", () => {
    const result = parseSignalText(
      "Quoted signal: NEW ORDER - XAUUSD Sell Stop 📉 # 306947863 ...{ NEW }... Entry: 4051.30 SL: 4057.30 TP: 4039.30 --- Comment: 🚀 Sell Stop activated 🚀 # 306947863 XAUUSD @ 4051.30",
      context,
    );
    expect(result).toMatchObject({
      commandType: "NO_SIGNAL",
      providerOrderId: "306947863",
      entry: undefined,
    });
    expect(result.matchedPatternIds).toContain("lifecycle.activation");
  });

  test("does not turn provider activation and fill notices into entries", () => {
    for (const text of [
      "Buy Stop activated",
      "🚀 Sell Limit triggered 🚀",
      "activated",
      "Order filled",
      "Buy Limit filled",
    ]) {
      expect(parseSignalText(text, context).commandType).toBe("NO_SIGNAL");
    }
  });

  test("recognizes prefixed activation notices without opening", () => {
    for (const text of [
      "XAUUSD Buy Stop activated #306947863 @4051.30",
      "Order filled: Buy Stop XAUUSD @4051.30",
      "XAUUSD Buy Stop executed\n# 1\nEntry: 4051.30\nSL: 4045.30\nTP: 4060.30",
      "VIP Gold: Sell Limit triggered #306947863 @4051.30",
      "Quoted signal: NEW ORDER - XAUUSD Buy Stop Entry: 4051.30 SL: 4045.30 TP: 4060.30 --- Comment: XAUUSD Buy Stop activated #306947863 @4051.30",
      "XAUUSD Buy Stop activated #306947863 @4051.30\r\n",
      "BUY XAUUSD STOP ACTIVATED #306947863 @4051.30",
      "ACTIVATED BUY XAUUSD STOP #306947863 @4051.30",
    ]) {
      const result = parseSignalText(text, context);
      expect(result.commandType).toBe("NO_SIGNAL");
      expect(result.entry).toBeUndefined();
    }
  });

  test("treats a post-block Comment activation as lifecycle context even without quote retrieval", () => {
    const result = parseSignalText(
      "NEW ORDER - XAUUSD Buy Stop\nEntry: 4051.30\nSL: 4045.30\nTP: 4060.30\nComment:\nXAUUSD Buy Stop activated\n# 306947863\nXAUUSD @ 4051.30",
      context,
    );
    expect(result.commandType).toBe("NO_SIGNAL");
    expect(result.entry).toBeUndefined();
  });

  test("lets a complete new-order block beat leading activation recap prose", () => {
    const result = parseSignalText(
      "BUY STOP FILLED yesterday, next setup below\r\nNEW ORDER - XAUUSD Buy Stop\r\n----------{ NEW }----------\r\nEntry: 4051.30\r\nSL: 4045.30\r\nTP: 4060.30",
      context,
    );
    expect(result.commandType).toBe("OPEN_TRADE");
    expect(result.entry).toEqual({ from: 4051.3 });
  });

  test("keeps LIVE entry wording while reserving LIVE and OPENED status forms", () => {
    const liveEntry = parseSignalText(
      "GOLD BUY LIMIT @ 3300 - LIVE 🔴\nSL: 3290\nTP: 3320",
      context,
    );
    expect(liveEntry.commandType).toBe("OPEN_TRADE");
    expect(shouldRequireManualReview(liveEntry)).toBe(false);

    for (const text of [
      "ORDER XAUUSD BUY STOP LIVE #306947863",
      "XAUUSD BUY STOP IS LIVE #306947863",
      "XAUUSD BUY STOP NOW LIVE #306947863",
      "ORDER XAUUSD BUY STOP OPENED #306947863",
    ]) {
      expect(parseSignalText(text, context).commandType).toBe("NO_SIGNAL");
    }
  });

  test("keeps recap prose containing BUY STOP FILLED inside a real new order executable", () => {
    const result = parseSignalText(
      "BUY XAUUSD STOP @ 4500\nSL 4490\nTP 4520\nOur BUY STOP FILLED yesterday was a different trade",
      context,
    );

    expect(result.commandType).toBe("OPEN_TRADE");
  });

  test("keeps complete entries containing lifecycle words executable", () => {
    for (const text of [
      "BUY XAUUSD NOW - setup triggered\nENTRY 4500\nSL 4490\nTP 4520",
      "BUY EURUSD 1.0850 SL 1.0800 TP 1.0950 - order filled manually",
    ]) {
      expect(parseSignalText(text, context).commandType).toBe("OPEN_TRADE");
    }
  });

  test("classifies a Deleted order as a cancel keyed to its order id, not a new open", () => {
    const result = parseSignalText("❌ Deleted Buy Stop on XAUUSD\n# 300424022", context);
    expect(result.commandType).toBe("CANCEL_PENDING");
    expect(result.canonicalSymbol).toBe("XAUUSD");
    expect(result.providerOrderId).toBe("300424022");
    // The order id must never leak into an entry price.
    expect(result.entry).toBeUndefined();
  });

  test("classifies cancelled and canceled pending orders as cancellations", () => {
    for (const text of [
      "Cancelled Sell Limit on XAUUSD\n# 300424022",
      "Canceled Buy Stop on XAUUSD\n# 300424022",
    ]) {
      expect(parseSignalText(text, context).commandType).toBe("CANCEL_PENDING");
    }
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

  test("does not promote hashtags or TP numbering into provider order ids", () => {
    expect(
      parseSignalText(
        "NEW ORDER - XAUUSD Buy Stop #1 Entry: 4051.30 SL: 4045.30 TP1: 4060.30",
        context,
      ).providerOrderId,
    ).toBeUndefined();
    expect(
      parseSignalText("BUY XAUUSD 4051.30 SL 4045.30 TP1 4060.30", context).providerOrderId,
    ).toBeUndefined();
  });

  test("classifies a provider CLOSED report as a close keyed to its order id", () => {
    const result = parseSignalText(
      "🟢 CLOSED - XAUUSD Sell 🟢\n# 298696672\n\n--------{ CLOSED }---------\nProfit: 2.01$\nProfit: 0.19%",
      context,
    );
    expect(result.commandType).toBe("CLOSE_TRADE");
    expect(result.canonicalSymbol).toBe("XAUUSD");
    expect(result.providerOrderId).toBe("298696672");
    expect(
      parseSignalText(
        "... Comment: 🟢 CLOSED - XAUUSD Sell 🟢 # 306947863 ...{ CLOSED }... Profit: 2.21$ ... Profit: 0.21%",
        context,
      ).commandType,
    ).toBe("CLOSE_TRADE");
  });

  test("maps every provider CLOSED phrasing to a full close and keeps bounded non-trade uses inert", () => {
    const quoted = (comment: string) =>
      parseSignalText(
        `Quoted signal: NEW ORDER - XAUUSD Buy Stop # 306947863 Entry: 4051.30 SL: 4045.30 TP: 4060.30\n\nComment:\n${comment}`,
        context,
      );

    for (const text of [
      "Closed half",
      "closed 50%",
      "Closed 25 percent",
      "Closed 1/2",
      "Closed most positions",
      "Partially closed at TP1",
      "Position fully CLOSED",
      "CLOSED 100%",
      "{ CLOSED }",
      "CLOSED - XAUUSD Sell",
    ]) {
      expect(quoted(text).commandType).toBe("CLOSE_TRADE");
      expect(quoted(text).partialClose).toBeUndefined();
    }
    for (const text of [
      "market closed, order not filled",
      "session closed",
      "closed for the day",
      "Closed the week with +500 pips total!",
      "Markets closed for the weekend",
      "London session is now closed",
      "Registration closed! DM me to join VIP",
      "We closed 5 winning trades this week",
      "Position closed at breakeven - market closed early today",
    ]) {
      const result = quoted(text);
      expect(result.commandType).toBe(text.startsWith("Position") ? "CLOSE_TRADE" : "NO_SIGNAL");
      if (result.commandType === "NO_SIGNAL") expect(shouldRequireManualReview(result)).toBe(true);
    }
    expect(
      parseSignalText(
        "... Comment: 🟢 CLOSED - XAUUSD Sell 🟢 # 306947863 ...{ CLOSED }... Profit: 2.21$ ... Profit: 0.21%",
        context,
      ).commandType,
    ).toBe("CLOSE_TRADE");
    expect(parseSignalText("Close TP1 EURUSD", context)).toMatchObject({
      commandType: "CLOSE_PARTIAL",
      partialClose: { kind: "TP_LEG", value: 1 },
    });
    expect(parseSignalText("Tp 1 ✅", context).commandType).toBe("MARK_TP_HIT");
    expect(parseSignalText("Cancelled Buy Stop on XAUUSD", context).commandType).toBe(
      "CANCEL_PENDING",
    );
  });

  test("holds bare CLOSED prose while preserving structural close forms", () => {
    for (const text of [
      "Closed the week with +500 pips total!",
      "Markets closed for the weekend",
      "London session is now closed",
      "Registration closed! DM me to join VIP",
      "We closed 5 winning trades this week",
    ]) {
      expect(parseSignalText(text, context).commandType).toBe("NO_SIGNAL");
    }
    for (const text of ["Closed half", "closed 50%", "Partially closed at TP1", "CLOSED"]) {
      expect(parseSignalText(text, context).commandType).toBe("CLOSE_TRADE");
    }
  });

  test("structure decides before prose and keeps close-all scoped", () => {
    const quoted = (comment: string) =>
      parseSignalText(
        `Quoted signal: NEW ORDER - XAUUSD Buy Stop # 306947863 Entry: 4051.30 SL: 4045.30 TP: 4060.30\n\nComment:\n${comment}`,
        context,
      );
    for (const text of [
      "H4 candle closed above SL, still holding",
      "Registration closed! Entry fee is $50, DM me",
      "GOLD closed below our entry",
      "The week closed above our entry",
      "Gold closed above TP2 level on the daily",
      "We closed 5 winning trades this week",
    ]) {
      expect(quoted(text).commandType).toBe("NO_SIGNAL");
      expect(quoted(text).closeAll).toBe(false);
    }
    for (const text of [
      "All positions closed",
      "All positions closed ✅",
      "Positions closed",
      "Both trades closed",
      "All trades closed",
      "Everything closed",
      "All closed",
      "Closed all positions",
      "Closed everything",
    ]) {
      expect(quoted(text)).toMatchObject({ commandType: "CLOSE_TRADE", closeAll: true });
    }
    expect(quoted("Closing all positions now")).toMatchObject({
      commandType: "CLOSE_TRADE",
      closeAll: true,
    });
    expect(quoted("Closed ✅").commandType).toBe("CLOSE_TRADE");
    expect(quoted("Closed ✅").closeAll).toBe(false);
    expect(quoted("Position closed")).toMatchObject({
      commandType: "CLOSE_TRADE",
      closeAll: false,
    });
    expect(quoted("Closed +40 pips").commandType).toBe("CLOSE_TRADE");
    expect(quoted("🟢 CLOSED - XAUUSD Sell 🟢\n{ CLOSED }\nDont chase it now").commandType).toBe(
      "CLOSE_TRADE",
    );
  });

  test("recognizes OPENED/LIVE lifecycle comments without suppressing LIVE entries", () => {
    const quoted = (comment: string) =>
      parseSignalText(
        `Quoted signal: NEW ORDER - XAUUSD Buy Stop # 306947863 Entry: 4051.30 SL: 4045.30 TP: 4060.30\n\nComment:\n${comment}`,
        context,
      );
    for (const text of ["Buy Stop opened", "Buy Stop live", "XAUUSD Buy Stop opened"]) {
      expect(quoted(text).commandType).toBe("NO_SIGNAL");
    }
    expect(
      parseSignalText("GOLD BUY LIMIT @ 3300 - LIVE\nSL: 3290\nTP: 3320", context).commandType,
    ).toBe("OPEN_TRADE");
  });

  test("does not open a prefixed activation recap containing ALREADY", () => {
    const result = parseSignalText(
      "SELL STOP ACTIVATED - already in profit!\n\nGOLD SELL @ 3305\nSL: 3310\nTP: 3290",
      context,
    );
    expect(result.commandType).toBe("NO_SIGNAL");
    expect(result.entry).toBeUndefined();
  });

  test("prefers a provider order id and ignores an out-of-sync phantom", () => {
    const opened = parseSignalText(
      "NEW ORDER - XAUUSD Buy Stop 📈\n# 300424022\nEntry: 4023.80\nSL: 4017.80\nTP: 4035.80",
      context,
    );
    const trade = createLogicalTradeFromSignal(opened, {
      id: "trade_nX8RHUbhVl",
      executionMode: "VIRTUAL_TP",
    });
    const command = parseSignalText(
      "🟢 CLOSED - XAUUSD Buy 🟢\n# 300424022\nProfit: 3.98$",
      context,
    );
    expect(
      matchLifecycleCommandToTrade(command, [
        { ...trade, id: "trade_c0I8FfiSOs", status: "OUT_OF_SYNC", providerOrderId: undefined },
        trade,
      ]),
    ).toMatchObject({ status: "MATCHED", tradeId: "trade_nX8RHUbhVl" });
  });

  test("does not match a reused provider order id across symbols", () => {
    const eurusd = createLogicalTradeFromSignal(
      parseSignalText("BUY EURUSD 1.0850\nSL 1.0800\nTP 1.0950", context),
      { id: "trade-eurusd", executionMode: "VIRTUAL_TP" },
    );
    const xauusd = createLogicalTradeFromSignal(
      parseSignalText("BUY XAUUSD 4500\nSL 4490\nTP 4520", context),
      { id: "trade-xauusd", executionMode: "VIRTUAL_TP" },
    );
    const command = parseSignalText("CLOSED - EURUSD Buy\n# 300424022", context);
    expect(
      matchLifecycleCommandToTrade(command, [
        { ...eurusd, providerOrderId: undefined },
        { ...xauusd, providerOrderId: "300424022" },
      ]),
    ).toMatchObject({ status: "MATCHED", tradeId: "trade-eurusd" });
  });
});

describe("stock index symbol recognition", () => {
  test("classifies digit-bearing index tickers as open trades", () => {
    const expectations: Array<[string, string]> = [
      // the shared test context maps US30 -> DJI30 via globalAliases (alias wins).
      ["US30 BUY 39000\nSL 38900\nTP 39200", "DJI30"],
      ["NAS100 SELL 18000\nSL 18100\nTP 17800", "NAS100"],
      // US100 is the US Tech 100, the same instrument as NAS100/USTEC/NDX. It used to
      // canonicalise to itself, which had no broker variants at all, so every US100
      // signal was unmappable by construction.
      ["US100 BUY 18000\nSL 17900\nTP 18200", "NAS100"],
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

describe("stop-loss label variations", () => {
  test("extracts a stop with no separator between label and price", () => {
    for (const sl of ["SL2286", "SL:2286", "SL=2286", "STOPLOSS2286", "S.L 2286", "S/L 2286"]) {
      const result = parseSignalText(`GOLD SELL 2281\n${sl}\nTP 2276`, context);
      expect(result.stopLoss).toBe(2286);
    }
  });

  test("ignores a pip annotation stuck to the stop price", () => {
    expect(parseSignalText("NAS100 BUY 29000\nSL 28750(250pips)\nTP 29250", context).stopLoss).toBe(
      28750,
    );
    expect(parseSignalText("XAUUSD BUY 4140\nSL 4110 (300 pips)\nTP 4170", context).stopLoss).toBe(
      4110,
    );
  });
});

describe("label followed by a parenthesised alias", () => {
  test("reads a stop and target written as 'Stop Loss (SL): 4055.00'", () => {
    const result = parseSignalText(
      "✅FXGOLDVISION VERIFIED SIGNAL\n✅ SELL  XAUUSD (GOLD) @ 4032.00\n❌ Stop Loss (SL): 4055.00\n✔️ Take Profit (TP): 3980.00",
      context,
    );
    expect(result).toMatchObject({
      commandType: "OPEN_TRADE",
      direction: "SELL",
      canonicalSymbol: "XAUUSD",
      stopLoss: 4055,
    });
    expect(result.takeProfits.map((target) => target.price)).toEqual([3980]);
    expect(result.missingFields).toEqual([]);
  });

  test("still reads the plain spellings", () => {
    expect(
      parseSignalText("GOLD SELL 4032\nStop Loss: 4055\nTake Profit: 3980", context),
    ).toMatchObject({ stopLoss: 4055 });
    expect(
      parseSignalText("GOLD SELL 4032\nStop-Loss 4055\nTake-Profit 3980", context),
    ).toMatchObject({ stopLoss: 4055 });
  });

  test("a long parenthetical does not drag in an unrelated number", () => {
    // The alias allowance is bounded, so prose in brackets cannot bridge the
    // label to whatever number happens to come next.
    expect(
      parseSignalText("GOLD SELL 4032\nSL (only if the H1 candle closes below) 4055", context)
        .stopLoss,
    ).toBeUndefined();
  });
});

describe("a priced target ladder is a new order, not a TP-hit update", () => {
  const vipSignal = [
    "🟢🟢🟢 29th July  VIP SIGNAL",
    "",
    "📈 GBPAUD BUY @ 1.91632",
    "",
    "🎯 TP1 @ 1.91832   (+20 Pips)",
    "🎯 TP2 @ 1.92132   (+50 Pips)",
    "🎯 TP3 @ 1.92632   (+100 Pips)",
    "",
    "🛑 SL  @ 1.90982   (-65 Pips)",
  ].join("\n");

  test("opens the trade instead of marking a target hit", () => {
    const result = parseSignalText(vipSignal, context);
    expect(result).toMatchObject({
      commandType: "OPEN_TRADE",
      direction: "BUY",
      canonicalSymbol: "GBPAUD",
      entry: { from: 1.91632 },
      stopLoss: 1.90982,
    });
    expect(result.takeProfits.map((target) => target.price)).toEqual([1.91832, 1.92132, 1.92632]);
  });

  test("a recap that restates the ladder is still a TP hit", () => {
    // Same ladder shape, but the targets have already been reached, so the
    // ladder rule must yield to the outcome language.
    expect(
      parseSignalText(
        "📈  Update: Scenario 1 Completed – All Targets Reached\nprice continued lower, reaching every projected downside target.\n\n🎯 TP1: 4045 ✅\n🎯 TP2: 4025 ✅",
        context,
      ).commandType,
    ).toBe("MARK_TP_HIT");
  });

  test("a bracketed running-pips result is not mistaken for leg geometry", () => {
    // Only signed annotations ("(+20 Pips)") are geometry; an unsigned figure
    // in brackets is the result itself and has to survive.
    expect(
      parseSignalText("✅ GBPNZD 4H\n🔝TP 1 touched  ( running 270 pips )", context).commandType,
    ).toBe("MARK_TP_HIT");
  });

  test("targets quoted as distances stay a lifecycle update, not an order", () => {
    // "TP1: 400 pips" is a target size, not a level; treating it as a price
    // would open a trade with a stop of 150 and a target of 400.
    expect(
      parseSignalText(
        "Anyone interested in a swing Buy setup?\n➤ Stop Loss: 150 pips\n➤ TP1: 400 pips ( R:r 1:3 )\n➤ TP2: 700 pips ( R:r 1:5 )",
        context,
      ).commandType,
    ).not.toBe("OPEN_TRADE");
  });

  test("the existing short-form TP results are untouched", () => {
    expect(parseSignalText("Tp 1 ✅", context).commandType).toBe("MARK_TP_HIT");
    expect(parseSignalText("Done tp 1", context).commandType).toBe("MARK_TP_HIT");
    expect(parseSignalText("Buy 66 full Tp 400pips ✅", context).commandType).toBe("MARK_TP_HIT");
    expect(parseSignalText("Tp 2 150pips", context).commandType).toBe("MARK_TP_HIT");
  });
});

describe("currency-cross on its own line (Elliott Wave format)", () => {
  test("resolves an FX cross that is not adjacent to the direction", () => {
    const result = parseSignalText(
      "🧑‍💻 CHFJPY 4H\n👉 Buy @ 199.280\n🔺 SL @ 198.576\n🔹 Tp 1 @ 201.923\n🔹 Tp 2 @ 207.036",
      context,
    );
    expect(result).toMatchObject({
      commandType: "OPEN_TRADE",
      direction: "BUY",
      canonicalSymbol: "CHFJPY",
      entry: { from: 199.28 },
      stopLoss: 198.576,
    });
    expect(result.takeProfits.length).toBeGreaterThanOrEqual(2);
  });

  test("does not treat a six-letter non-currency word as a pair", () => {
    // "MISSED" is six letters but not two currency codes; it must not resolve.
    expect(parseSignalText("MISSED the entry\nTP 4070", context).canonicalSymbol).toBeUndefined();
  });
});

describe("spelled-out stop/target with a pip annotation", () => {
  test("parses a signal whose take-profit carries a pip note", () => {
    const result = parseSignalText(
      "🧑‍💻 XAU/USD Sell 4042 - 4045\n📌 Stoploss : 4048\n- Take Profit : 4037 ( 70pips )\n- Take Profit : 4015 ( 350pips )",
      context,
    );
    expect(result).toMatchObject({
      commandType: "OPEN_TRADE",
      direction: "SELL",
      canonicalSymbol: "XAUUSD",
      entry: { from: 4042, to: 4045 },
      stopLoss: 4048,
    });
  });

  test("still ignores a bare pip results recap", () => {
    expect(parseSignalText("XAUUSD sell 150 pips this week", context).commandType).toBe(
      "NO_SIGNAL",
    );
    expect(parseSignalText("GBPCAD +50 pips / CHFJPY +200 pips", context).commandType).toBe(
      "NO_SIGNAL",
    );
  });
});

describe("Automatic vs Aggressive review policy", () => {
  const guessedOpen = {
    commandType: "OPEN_TRADE" as const,
    mappingStatus: "mapped" as const,
    confidence: 0.6,
    missingFields: [] as string[],
    warnings: ["Geometry-inferred direction from price levels"],
  };

  test("Aggressive executes a guessed (geometry-inferred, low-confidence) open that Automatic holds", () => {
    expect(shouldRequireManualReview(guessedOpen as never, false)).toBe(true);
    expect(shouldRequireManualReview(guessedOpen as never, true)).toBe(false);
  });

  test("Aggressive still holds on the real safety reasons", () => {
    // Unmapped symbol holds in both modes.
    expect(
      shouldRequireManualReview({ ...guessedOpen, mappingStatus: "unmapped" } as never, true),
    ).toBe(true);
    // A pending order missing its entry level holds in both modes.
    expect(
      shouldRequireManualReview(
        { ...guessedOpen, confidence: 0.9, warnings: [], missingFields: ["entry"] } as never,
        true,
      ),
    ).toBe(true);
    // Conflicting stop geometry holds in both modes.
    expect(
      shouldRequireManualReview(
        { ...guessedOpen, warnings: ["Conflicting stop-loss values"] } as never,
        true,
      ),
    ).toBe(true);
  });
});
