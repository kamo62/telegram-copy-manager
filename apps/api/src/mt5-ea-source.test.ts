import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync("mt5/TelegramTC_EA.mq5", "utf8");

describe("MT5 Expert Advisor source", () => {
  test("uses timer polling, WebRequest, typed MQL5 trade structures, and retcode reporting", () => {
    expect(source).toContain("EventSetTimer");
    expect(source).toContain("WebRequest");
    expect(source).toContain("MqlTradeRequest");
    expect(source).toContain("MqlTradeResult");
    expect(source).toContain("result.retcode");
    expect(source).toContain("retcode_external");
    expect(source).toContain("input string LinkCode");
    expect(source).toContain('\\"linkCode\\"');
    expect(source).toContain("input int    PollSeconds    = 1;");
    expect(source).not.toContain('input string BackendBaseUrl = "http://127.0.0.1:8787/api"');
  });

  test("reports broker history deals for manual close reconciliation", () => {
    expect(source).toContain("SendHistoryDeals()");
    expect(source).toContain("HistorySelect(fromTime, toTime)");
    expect(source).toContain("HistoryDealsJson()");
    expect(source).toContain('HttpPost("/mt5/history"');
    expect(source).toContain("DEAL_POSITION_ID");
    expect(source).toContain("DEAL_PROFIT");
  });

  test("trims the UTF-8 null terminator before POSTing JSON with WebRequest", () => {
    expect(source).toContain("StringToCharArray(body, data, 0, WHOLE_ARRAY, CP_UTF8)");
    expect(source).toContain("ArrayResize(data, ArraySize(data) - 1)");
    expect(source).toContain("data[ArraySize(data) - 1] == 0");
  });

  test("covers market, pending, cancel, SL/TP modification, close, and partial close commands", () => {
    expect(source).toContain("TRADE_ACTION_DEAL");
    expect(source).toContain("TRADE_ACTION_PENDING");
    expect(source).toContain("TRADE_ACTION_REMOVE");
    expect(source).toContain("TRADE_ACTION_SLTP");
    expect(source).toContain("ORDER_TYPE_BUY_LIMIT");
    expect(source).toContain("ORDER_TYPE_SELL_LIMIT");
    expect(source).toContain("ORDER_TYPE_BUY_STOP");
    expect(source).toContain("ORDER_TYPE_SELL_STOP");
    expect(source).toContain("CLOSE_PARTIAL");
    expect(source).toContain("MOVE_SL_TO_BE");
  });

  test("dispatches MODIFY_TP and keeps every execution report payload arity compile-safe", () => {
    expect(source).toContain('command.commandType == "MODIFY_TP"');
    expect(source).toContain("ExecuteModifyTp(command)");

    for (const report of reportCalls(source)) {
      expect(report.argumentCount).toBe(12);
    }
    expect(source).toContain("positionTicket");
  });

  test("matches broker positions and pending orders by logical trade comments", () => {
    expect(source).toContain("ulong FindPositionTicket(SignalCommand &command)");
    expect(source).toContain("OrderMatchesCommand(command)");
    expect(source).toContain("PositionMatchesCommand(command)");
    expect(source).toContain("OrderGetString(ORDER_COMMENT)");
    expect(source).toContain("PositionGetString(POSITION_COMMENT)");
    expect(source).toContain("MatchesLogicalTradeComment");
  });

  test("reports current MT5 position and pending-order snapshots to the backend", () => {
    expect(source).toContain("SendSnapshot()");
    expect(source).toContain('HttpPostRetry("/mt5/snapshot"');
    expect(source).toContain("PositionsJson()");
    expect(source).toContain("OrdersJson()");
    expect(source).toContain("POSITION_PRICE_OPEN");
    expect(source).toContain("ORDER_PRICE_OPEN");
  });

  test("reports selected symbol market metadata in MT5 snapshots", () => {
    expect(source).toContain('\\"symbols\\":%s');
    expect(source).toContain("SymbolsMarketJson()");
    expect(source).toContain("SYMBOL_BID");
    expect(source).toContain("SYMBOL_ASK");
    expect(source).toContain("SYMBOL_VOLUME_MIN");
    expect(source).toContain("SYMBOL_VOLUME_MAX");
    expect(source).toContain("SYMBOL_VOLUME_STEP");
  });

  test("reports terminal symbol inventory instead of only the chart symbol", () => {
    expect(source).toContain("SymbolsJson()");
    expect(source).toContain("SymbolsTotal(false)");
    expect(source).toContain("SymbolName(index, false)");
    expect(source).not.toContain('availableSymbols\\":[\\"%s\\"]');
  });

  test("validates pending-order prices against current bid ask and broker stop levels", () => {
    expect(source).toContain("ValidatePendingOrderPrice(command)");
    expect(source).toContain("SYMBOL_TRADE_STOPS_LEVEL");
    expect(source).toContain("SYMBOL_POINT");
    expect(source).toContain("SYMBOL_ASK");
    expect(source).toContain("SYMBOL_BID");
  });

  test("selects a broker-supported filling mode for market and close requests", () => {
    expect(source).toContain("FillingModeForSymbol");
    expect(source).toContain("SYMBOL_FILLING_MODE");
    expect(source).toContain("SYMBOL_FILLING_IOC");
    expect(source).toContain("SYMBOL_FILLING_FOK");
    expect(source).toContain("ORDER_FILLING_FOK");
    expect(source).toContain(
      "request.type_filling = FillingModeForSymbol(command.brokerSymbol, false)",
    );
    expect(source).toContain("request.type_filling = FillingModeForSymbol(symbol, false)");
  });

  test("executes trailing-stop lifecycle commands with broker point conversion", () => {
    expect(source).toContain('command.commandType == "TRAILING_STOP"');
    expect(source).toContain("ExecuteTrailingStop(command)");
    expect(source).toContain("TrailingStopDistance(command)");
    expect(source).toContain("command.trailingStopUnit");
    expect(source).toContain("SYMBOL_POINT");
  });

  test("creates split child orders for each configured TP leg", () => {
    expect(source).toContain("ExecuteSplitOrders(command)");
    expect(source).toContain("for(int leg = 0; leg < 4; leg++)");
    expect(source).toContain("command.tpAllocation[leg]");
    expect(source).toContain('StringFormat("telegram-tc:%s:tp%d"');
    expect(source).toContain("request.tp = command.tp[leg]");
  });

  test("monitors virtual TP legs and closes planned partial volumes on timer", () => {
    expect(source).toContain("ManageVirtualTakeProfits()");
    expect(source).toContain("TrackVirtualTakeProfits(command, result)");
    expect(source).toContain("struct VirtualTpState");
    expect(source).toContain("CloseVirtualTpLeg");
    expect(source).toContain("virtualTpStates");
  });

  test("uses backend-provided command volume with the EA default as fallback", () => {
    expect(source).toContain("double volume;");
    expect(source).toContain('ValueFor(body, "volume")');
    expect(source).toContain("CommandVolume(command)");
    expect(source).toContain("if(command.volume > 0.0)");
    expect(source).toContain("return DefaultLots");
  });

  test("calculates risk-percent volume from broker tick metadata before falling back to defaults", () => {
    expect(source).toContain("RiskPercentVolume(command)");
    expect(source).toContain("SYMBOL_TRADE_TICK_SIZE");
    expect(source).toContain("SYMBOL_TRADE_TICK_VALUE");
    expect(source).toContain("AccountInfoDouble(ACCOUNT_BALANCE)");
  });

  test("uses backend-provided TP leg volumes for split orders and virtual TP closes", () => {
    expect(source).toContain("double tpVolume[4];");
    expect(source).toContain('ValueFor(body, "tp" + leg + "Volume")');
    expect(source).toContain("LegVolume(command, leg, baseVolume)");
    expect(source).toContain("virtualTpStates[slot].tpVolume[leg] = command.tpVolume[leg]");
    expect(source).toContain("virtualTpStates[stateIndex].tpVolume[leg]");
  });

  test("applies backend-provided polling interval from line payloads", () => {
    expect(source).toContain("CurrentPollSeconds");
    expect(source).toContain("ApplyPollConfig(response)");
    expect(source).toContain('ValueFor(body, "pollSeconds")');
    expect(source).toContain("EventSetTimer(CurrentPollSeconds)");
  });
});

function reportCalls(text: string) {
  const calls: Array<{ argumentCount: number; snippet: string }> = [];
  let searchFrom = 0;
  while (true) {
    const index = text.indexOf("Report(", searchFrom);
    if (index === -1) break;
    if (text.slice(Math.max(0, index - 8), index) === "void ") {
      searchFrom = index + "Report(".length;
      continue;
    }
    const end = matchingParenIndex(text, index + "Report".length);
    const inside = text.slice(index + "Report(".length, end);
    calls.push({
      argumentCount: countTopLevelArguments(inside),
      snippet: text.slice(index, end + 1),
    });
    searchFrom = end + 1;
  }
  return calls;
}

function matchingParenIndex(text: string, openIndex: number) {
  let depth = 0;
  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index];
    if (char === "(") depth += 1;
    if (char === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error("Unclosed Report call");
}

function countTopLevelArguments(text: string) {
  let depth = 0;
  let count = text.trim().length ? 1 : 0;
  for (const char of text) {
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (char === "," && depth === 0) count += 1;
  }
  return count;
}
