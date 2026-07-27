import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync("mt5/TelegramTC_EA.mq5", "utf8");
const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as { version?: string };

describe("MT5 Expert Advisor source", () => {
  test("keeps the EA on the same compatible app release line", () => {
    const eaVersion = source.match(/#property\s+version\s+"([^"]+)"/)?.[1];
    expect(packageJson.version).toBeTruthy();
    expect(eaVersion).toBe("1.60.0");
    expect(eaVersion).toBe(packageJson.version);
  });

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

  test("uses the current default app link code for EA registration", () => {
    expect(source).toContain('input string LinkCode       = "-UTN4-D6";');
  });

  test("reports broker history deals for manual close reconciliation", () => {
    expect(source).toContain("SendHistoryDeals()");
    expect(source).toContain("HistorySelect(fromTime, toTime)");
    expect(source).toContain("HistoryDealsJson()");
    expect(source).toContain('HttpPostRetry("/mt5/history"');
    expect(source).toContain("DEAL_POSITION_ID");
    expect(source).toContain("DEAL_PROFIT");
    expect(source).toContain("DEAL_COMMISSION");
    expect(source).toContain("DEAL_SWAP");
    expect(source).toContain("DEAL_FEE");
    expect(source).toContain("DEAL_TIME_MSC");
    expect(source).toContain('\\"timeMsc\\":%I64d');
  });

  test("heartbeats account profit alongside balance and equity for diagnostics", () => {
    expect(source).toContain("ACCOUNT_BALANCE");
    expect(source).toContain("ACCOUNT_EQUITY");
    expect(source).toContain("ACCOUNT_PROFIT");
    expect(source).toContain('\\"profit\\":%.2f');
  });

  test("refreshes the guardian heartbeat before polling and refuses opens without a fresh quote", () => {
    const onTimer = source.match(/void OnTimer\(\)[\s\S]*?\n}/)?.[0] ?? "";
    const ensureSymbol = source.match(/bool EnsureSymbol\(string symbol\)[\s\S]*?\n}/)?.[0] ?? "";
    const open =
      source.match(/bool ExecuteOpenTrade\(SignalCommand &command\)[\s\S]*?\n}/)?.[0] ?? "";
    expect(onTimer.indexOf("SendHeartbeat()")).toBeLessThan(onTimer.indexOf("PollAndExecute()"));
    expect(ensureSymbol).toContain("no fresh tick after 2s — aborting execution");
    expect(ensureSymbol).toMatch(/no fresh tick after 2s[\s\S]*return false/);
    expect(open).toContain("ReportUnknown(command.queueItemId");
  });

  test("reports external manual history deals so account PnL can realize after close", () => {
    const historyDealsJson = source.match(
      /string HistoryDealsJson\(\)[\s\S]*?\n}\n\nbool IsTelegramTcHistoryDeal/,
    )?.[0];
    const postHistoryDeal = source.match(
      /void PostHistoryDeal\(ulong ticket\)[\s\S]*?\n}\n\nvoid PollAndExecute/,
    )?.[0];
    expect(historyDealsJson).toBeTruthy();
    expect(postHistoryDeal).toBeTruthy();
    expect(historyDealsJson).not.toContain("IsTelegramTcHistoryDeal(ticket)");
    expect(postHistoryDeal).not.toContain("if(!IsTelegramTcHistoryDeal(ticket))");
  });

  test("posts newly added MT5 deals immediately from OnTradeTransaction", () => {
    expect(source).toContain("void OnTradeTransaction");
    expect(source).toContain("TRADE_TRANSACTION_DEAL_ADD");
    expect(source).toContain("HistoryDealSelect(trans.deal)");
    expect(source).toContain("PostHistoryDeal(trans.deal)");
    expect(source).toContain('HttpPostRetry("/mt5/history"');
  });

  test("includes DEAL_REASON in the history payload so backend can distinguish TP/SL/manual closes", () => {
    expect(source).toContain("DEAL_REASON");
    expect(source).toContain('\\"reason\\":%d');
  });

  test("exposes BrokerMinLotMultiplier as a single-knob sizing override across asset classes", () => {
    expect(source).toContain("input double BrokerMinLotMultiplier");
    expect(source).toContain("SymbolInfoDouble(command.brokerSymbol, SYMBOL_VOLUME_MIN)");
    // Override path must short-circuit BEFORE the existing command.volume / risk% / DefaultLots fallback.
    expect(source).toMatch(
      /BrokerMinLotMultiplier > 0\.0[\s\S]*minVol \* BrokerMinLotMultiplier[\s\S]*command\.volume > 0\.0/,
    );
  });

  test("exposes MinStopBufferMultiplier safety to keep SL/TP outside broker SYMBOL_TRADE_STOPS_LEVEL", () => {
    expect(source).toContain("input double MinStopBufferMultiplier");
    expect(source).toContain("SafeStopPrice");
    expect(source).toContain("SYMBOL_TRADE_STOPS_LEVEL");
    // Safety must be applied to BOTH SL and TP on market orders.
    expect(source).toContain(
      "SafeStopPrice(command.brokerSymbol, referencePrice, command.stopLoss, command.direction, true)",
    );
  });

  test("includes ALL broker positions in the snapshot (not just magic-matched) with isExternal flag", () => {
    // PositionsJson / OrdersJson must no longer filter by MagicNumber. They
    // tag non-magic entries with isExternal=true so the App can show them in
    // the read-only External positions panel without conflating with app trades.
    expect(source).toContain('\\"isExternal\\":%s');
    expect(source).toContain(
      "bool isExternal = (ulong)PositionGetInteger(POSITION_MAGIC) != MagicNumber",
    );
    expect(source).toContain(
      "bool isExternal = (ulong)OrderGetInteger(ORDER_MAGIC) != MagicNumber",
    );
    // Sanity: the JSON exposes the raw magic so operators can distinguish
    // manual clicks (magic=0) from other-EA trades (some other magic).
    expect(source).toContain('\\"magic\\":%I64u');
  });

  test("keeps virtual TP ownership in the app instead of the EA", () => {
    expect(source).not.toContain("AppManagedVirtualTp");
    expect(source).not.toContain("struct VirtualTpState");
    expect(source).not.toContain("virtualTpStates");
    expect(source).not.toContain("RehydrateVirtualTpStates");
    expect(source).not.toContain("ManageVirtualTakeProfits");
    expect(source).not.toContain("CloseVirtualTpLeg");
    expect(source).not.toContain("/mt5/active-plans");
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

  test("holds lifecycle closes for reconciliation when no live position matches", () => {
    const close =
      source.match(
        /void ExecuteClose\(SignalCommand &command\)[\s\S]*?\n}\n\nbool ClosePositionTicket/,
      )?.[0] ?? "";
    expect(close).toContain("CollectPositionTickets(command, initialPositions)");
    expect(close).toContain("ReportUnknown(command.queueItemId");
    expect(close).toContain("reconcile broker snapshot/history");
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

  test("reports its version and both close capabilities on registration and heartbeat", () => {
    expect(source).toContain('#property version   "1.60.0"');
    expect(source.match(/"1\.60\.0"/g)).toHaveLength(3);
    expect(source).toContain("pending-close-flatten-v1");
    expect(source).toContain('\\"eaVersion\\"');
    expect(source).toContain('\\"eaCapabilities\\"');
    expect(source).toContain('\\"lane2-close-contract\\"');
  });

  test("rejects empty lifecycle identity and never treats it as a broker-comment wildcard", () => {
    expect(source).toContain(
      'if(IsLifecycleCommand(command.commandType) && command.logicalTradeId == "")',
    );
    expect(source).toContain(
      'ReportUnknown(command.queueItemId, "Lifecycle command rejected", "empty logicalTradeId")',
    );
    expect(source).toMatch(
      /bool MatchesLogicalTradeComment\(string brokerComment, string logicalTradeId\)[\s\S]*?if\(logicalTradeId == ""\)\s*return false;/,
    );
  });

  test("keeps partial and async closes retryable until broker state confirms the ticket is gone", () => {
    const close =
      source.match(/bool ClosePositionTicket\([\s\S]*?\n}\n\nulong FindPositionTicket/)?.[0] ?? "";
    expect(close).toContain("bool positionGone = !PositionSelectByTicket(ticket);");
    // A full close still requires the position to be gone before it is marked
    // executed, so PLACED and DONE_PARTIAL stay retryable. The partial branch is
    // covered separately: it completes on DONE because the position survives.
    expect(close).toContain(
      "result.retcode == TRADE_RETCODE_DONE && filledConfirmed && (positionGone || !fullClose)",
    );
    expect(close).toContain("bool fullClose = closeVolume >= currentVolume - 0.000001;");
    expect(close).toContain("command.runnerVolume");
    expect(close).toContain("command.runnerEnabled");
    expect(close).toContain("double observedFilledVolume");
    expect(close).toContain(
      "remainingVolume = positionGone ? 0.0 : PositionGetDouble(POSITION_VOLUME);",
    );
    expect(source).toContain(
      "result.retcode == TRADE_RETCODE_DONE_PARTIAL || result.retcode == TRADE_RETCODE_PLACED",
    );
  });

  test("logs incoming lifecycle work with ticket and trade context for MT5 Journal tracing", () => {
    expect(source).toContain("Telegram TC WORK command=%s");
    expect(source).toContain("queue=%s logicalTradeId=%s");
    expect(source).toContain("targetPosition=%I64u");
    expect(source).toContain("partialKind=%s partialValue=%.2f partialVolume=%.2f");
    expect(source).toContain("Telegram TC MODIFY_SL ticket=%I64u");
    expect(source).toContain("Telegram TC CLOSE command=%s ticket=%I64u");
    expect(source).toContain("Telegram TC TRAILING_STOP queue=%s");
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

  test("keeps trailing stops active on timer instead of applying a one-shot SL move", () => {
    expect(source).toContain("struct TrailingStopState");
    expect(source).toContain("trailingStopStates");
    expect(source).toContain("TrackTrailingStop(command");
    expect(source).toContain("ManageTrailingStops()");
    expect(source).toMatch(/void\s+OnTimer\(\)[\s\S]*ManageTrailingStops\(\)/);
    expect(source).toContain("TrailingStopImproves");
  });

  test("uses ticket-led close and modify execution across all matching broker positions and orders", () => {
    expect(source).toContain("CollectPositionTickets(command");
    expect(source).toContain("CollectPendingOrderTickets(command");
    expect(source).toContain("request.position = ticket");
    expect(source).toContain("request.action = TRADE_ACTION_SLTP");
    expect(source).toContain("request.action = TRADE_ACTION_DEAL");
    expect(source).toContain("request.action = TRADE_ACTION_REMOVE");
    expect(source).toContain("if(command.newStopLoss <= 0.0)");
  });

  test("supports TP-leg partial closes from backend payloads", () => {
    expect(source).toContain("double partialCloseVolume;");
    expect(source).toContain('ValueFor(body, "partialCloseVolume")');
    expect(source).toContain('command.partialCloseKind == "TP_LEG"');
    expect(source).toContain("No valid partial-close volume provided");
  });

  test("keeps sub-minimum partial slices as held no-ops and escalates only runner closes", () => {
    expect(source).toContain(
      "double NormalizeCloseVolume(string symbol, double requested, double currentVolume)",
    );
    expect(source).toContain("MathFloor((volume + step * 0.000001) / step) * step");
    expect(source).toContain("if(volume < minVolume || volume <= 0.0)");
    expect(source).toContain("if(volume < minVolume || volume <= 0.0)\n      return 0.0;");
    expect(source).toContain("if(closeVolume <= 0.0)\n         closeVolume = currentVolume;");
    expect(source).toContain(
      "closeVolume = NormalizeCloseVolume(symbol, currentVolume - command.targetRemainingVolume, currentVolume)",
    );
    expect(source).not.toContain(
      "closeVolume = NormalizeVolume(symbol, currentVolume * command.partialCloseValue / 100.0)",
    );
  });

  test("reports a runner remnant as executed when this pass closed its ticket", () => {
    const executeClose = source.slice(
      source.indexOf("void ExecuteClose("),
      source.indexOf("void ExecutePartialClose("),
    );
    expect(executeClose).toContain(
      "int remainingPositionMatches = CollectPositionTickets(command, remainingPositionTickets);",
    );
    expect(executeClose).toContain(
      "if(!LifecycleAlreadyExecuted(command, remainingPositionTickets[index]))",
    );
    expect(executeClose).toContain("remainingVolume");
  });

  test("reports actual open and close volumes, pending zero fills, and ticket-scoped lifecycle markers", () => {
    expect(source).toContain('\\"requestedVolume\\":%.8f');
    expect(source).toContain('\\"filledVolume\\":%.8f');
    expect(source).toContain('\\"remainingVolume\\":%.8f');
    expect(source).toContain('result.retcode == TRADE_RETCODE_DONE_PARTIAL ? "PARTIAL"');
    expect(source).toContain("request.action == TRADE_ACTION_PENDING ? 0.0 : result.volume");
    expect(source).toContain("request.action == TRADE_ACTION_PENDING\n      ? request.volume");
    expect(source).toContain("GlobalVariableCheck(LifecycleIdempotencyVariable(command, ticket))");
    expect(source).toContain("MarkLifecycleExecuted(command, ticket)");
    expect(source).toMatch(
      /for\(int index = 0; index < positionFound; index\+\+\)[\s\S]*?LifecycleAlreadyExecuted\(command, ticket\)[\s\S]*?ClosePositionTicket\(command, ticket, result, requested, filled, remaining\)/,
    );
    expect(source).toContain(
      'command.targetRemainingVolume = StringToDouble(ValueFor(body, "targetRemainingVolume"))',
    );
  });

  test("creates split child orders for each configured TP leg", () => {
    expect(source).toContain("ExecuteSplitOrders(command)");
    expect(source).toContain("for(int leg = 0; leg < 4; leg++)");
    expect(source).toContain("command.tpAllocation[leg]");
    expect(source).toContain("CompactTradeTpComment(command.logicalTradeId, leg + 1)");
    expect(source).toContain("SafeStopPrice(command.brokerSymbol, referencePrice, command.tp[leg]");
  });

  test("uses compact trade comments for app-side reconciliation", () => {
    expect(source).toContain("CompactTradeComment");
    expect(source).toContain('return "ttc:" + CompactTradeId(logicalTradeId);');
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

  test("uses backend-provided TP leg volumes for split orders", () => {
    expect(source).toContain("double tpVolume[4];");
    expect(source).toContain('ValueFor(body, "tp" + leg + "Volume")');
    expect(source).toContain("LegVolume(command, leg, baseVolume)");
  });

  test("uses the final tradeable virtual TP as a broker backstop unless a runner is enabled", () => {
    expect(source).toContain(
      'else if(command.executionMode == "VIRTUAL_TP" && !command.runnerEnabled)',
    );
    expect(source).toContain("bool hasPlannedTpVolume = false;");
    expect(source).toContain("(!hasPlannedTpVolume || command.tpVolume[index] > 0.0)");
    expect(source).toContain('command.runnerEnabled = ValueFor(body, "runnerEnabled") == "true";');
  });

  test("applies backend-provided polling interval from line payloads", () => {
    expect(source).toContain("CurrentPollSeconds");
    expect(source).toContain("ApplyPollConfig(response)");
    expect(source).toContain('ValueFor(body, "pollSeconds")');
    expect(source).toContain("EventSetTimer(CurrentPollSeconds)");
  });

  test("does not retry poll-line because polling leases queue items", () => {
    expect(source).toContain("/mt5/poll-line");
    expect(source).toMatch(/void\s+PollAndExecute\(\)[\s\S]*if\(!HttpGet\(url, response\)\)/);
    expect(source).not.toMatch(
      /void\s+PollAndExecute\(\)[\s\S]*HttpGetRetry\(url, response\)[\s\S]*ApplyPollConfig/,
    );
    expect(source).toContain("UNSAFE: /poll-line");
  });

  test("a partial close routes away from the flatten path and never cancels pending orders", () => {
    // CLOSE_TRADE and CLOSE_PARTIAL share ExecuteClose. Only the full close may
    // cancel working pending orders; a partial close that removed them would
    // destroy the remaining entries of a multi-entry setup.
    const executeClose = source.slice(source.indexOf("void ExecuteClose("));
    const partialGuard = executeClose.slice(0, executeClose.indexOf("CollectPendingOrderTickets"));
    expect(partialGuard).toContain('command.commandType != "CLOSE_TRADE"');
    expect(partialGuard).toContain("ExecutePartialClose(command);");
    expect(source).toContain("void ExecutePartialClose(SignalCommand &command)");

    const partialBody = source.slice(
      source.indexOf("void ExecutePartialClose("),
      source.indexOf("bool ClosePositionTicket("),
    );
    expect(partialBody).not.toContain("CollectPendingOrderTickets");
    expect(partialBody).not.toContain("RemovePendingOrder");
    expect(partialBody).toContain("command.targetRemainingVolume <= 0.0");
    expect(partialBody).toContain("No valid target remaining volume provided");
  });

  test("marks a partial close idempotently executed so a replay cannot close a second slice", () => {
    // A full-volume request only completes once the position is gone, while a
    // confirmed slice can complete with the runner or another position left.
    expect(source).toContain("bool filledConfirmed = filledVolume + 0.000001 >= request.volume;");
    expect(source).toContain(
      "if(sent && result.retcode == TRADE_RETCODE_DONE && filledConfirmed && (positionGone || !fullClose))",
    );
  });

  test("aggregates partial-close slices so a failed slice cannot be masked", () => {
    const partialBody = source.slice(
      source.indexOf("void ExecutePartialClose("),
      source.indexOf("bool ClosePositionTicket("),
    );
    expect(partialBody.match(/ReportWithVolumes\(/g)).toHaveLength(1);
    expect(partialBody).toContain("int attempted = 0;");
    expect(partialBody).toContain("int succeeded = 0;");
    expect(partialBody).toContain("bool partialResult = false;");
    expect(partialBody).toContain(
      "if(ClosePositionTicket(command, ticket, result, requested, filled, remaining))",
    );
    expect(partialBody).toContain("succeeded++;");
    expect(partialBody).toContain(
      "result.retcode == TRADE_RETCODE_DONE_PARTIAL || result.retcode == TRADE_RETCODE_PLACED",
    );
    expect(partialBody).toContain(
      'string status = (succeeded == attempted && !partialResult) ? "EXECUTED" : "PARTIAL";',
    );
    expect(partialBody).toContain("if(attempted == 0)");
    expect(partialBody).toContain("ReportUnknown(command.queueItemId");
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
