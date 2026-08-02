import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync("mt5/TelegramTC_EA.mq5", "utf8");
const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as { version?: string };

describe("MT5 Expert Advisor source", () => {
  test("keeps the EA on the same compatible app release line", () => {
    // Compatibility is a MAJOR.MINOR contract: capability strings and the command
    // contract move on minor bumps, so a drift there must fail. Patch releases that
    // touch only the app (a UI fix, a copy change) must NOT force an EA recompile and
    // reattach on a live terminal - that is real operational risk for no benefit, and
    // an EA nobody rebuilds is worse than one legitimately a patch behind.
    const eaVersion = source.match(/#property\s+version\s+"([^"]+)"/)?.[1];
    expect(packageJson.version).toBeTruthy();
    expect(eaVersion).toBe("1.68.0");
    const line = (version: string) => version.split(".").slice(0, 2).join(".");
    expect(line(eaVersion!)).toBe(line(packageJson.version!));
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
    expect(source).toContain('#property version   "1.68.0"');
    expect(source.match(/"1\.68\.0"/g)).toHaveLength(3);
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

  test("recycles trailing-stop slots and never drops tracking silently", () => {
    // The slot array is a lifetime budget unless finished positions give their
    // slot back. Exhausting it used to make every later trailing stop a no-op,
    // which leaves a live position with a stop nothing will ever move again.
    const track = source.match(/bool TrackTrailingStop\([\s\S]*?\n}\n/)?.[0] ?? "";
    expect(track).toBeTruthy();
    expect(track).toContain("if(freeSlot < 0 && !trailingStopStates[index].active)");
    expect(track).toContain("trailingStopStates[freeSlot].positionTicket = ticket;");
    // An existing ticket must still update in place: the reuse scan only settles
    // on a free slot after the whole occupied range failed to match the ticket.
    expect(track).toMatch(/positionTicket == ticket[\s\S]*?return true;[\s\S]*?freeSlot = index/);

    // Releasing must clear identity, or a recycled slot trails a new ticket with a
    // finished position's queue item, trade id, symbol, direction and distance.
    const release =
      source.match(/void ReleaseTrailingStopSlot\(int index\)[\s\S]*?\n}\n/)?.[0] ?? "";
    for (const cleared of [
      "active = false",
      'queueItemId = ""',
      'logicalTradeId = ""',
      'symbol = ""',
      'direction = ""',
      "positionTicket = 0",
      "distance = 0.0",
    ]) {
      expect(release).toContain(cleared);
    }

    // ManageTrailingStops walks the array by index. Slots are recycled in place and
    // the count is a high-water mark, so nothing shifts under that loop.
    const manage = source.match(/void ManageTrailingStops\(\)[\s\S]*?\n}\n/)?.[0] ?? "";
    expect(manage).toContain("ReleaseTrailingStopSlot(index);");
    expect(source).not.toContain("trailingStopStateCount--");

    // A genuinely full array is reported, not swallowed.
    const executeTrailing = source.slice(
      source.indexOf("void ExecuteTrailingStop("),
      source.indexOf("void ReleaseTrailingStopSlot("),
    );
    expect(executeTrailing).toContain("if(!TrackTrailingStop(command, tickets[index], distance))");
    expect(executeTrailing).toContain("untracked++;");
    expect(executeTrailing).toContain('"Trailing stop tracking capacity exhausted"');
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
      "int remainingPositionMatches = CollectPositionTargets(command, remainingPositionTickets, remainingPositionIdentifiers);",
    );
    expect(executeClose).toContain(
      "if(!LifecycleAlreadyExecuted(command, remainingPositionIdentifiers[index], remainingPositionTickets[index]))",
    );
    expect(executeClose).toContain("remainingVolume");
  });

  test("reports actual open and close volumes, pending zero fills, and position-scoped lifecycle markers", () => {
    expect(source).toContain('\\"requestedVolume\\":%.8f');
    expect(source).toContain('\\"filledVolume\\":%.8f');
    expect(source).toContain('\\"remainingVolume\\":%.8f');
    expect(source).toContain('result.retcode == TRADE_RETCODE_DONE_PARTIAL ? "PARTIAL"');
    expect(source).toContain("request.action == TRADE_ACTION_PENDING ? 0.0 : result.volume");
    expect(source).toContain("request.action == TRADE_ACTION_PENDING\n      ? request.volume");
    expect(source).toContain(
      "GlobalVariableCheck(LifecycleIdempotencyVariable(command, identifier))",
    );
    expect(source).toContain("MarkLifecycleExecuted(command, identifier)");
    expect(source).toMatch(
      /for\(int index = 0; index < positionFound; index\+\+\)[\s\S]*?LifecycleAlreadyExecuted\(command, positionIdentifiers\[index\], ticket\)[\s\S]*?ClosePositionTicket\(command, ticket, result, requested, filled, remaining\)/,
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

  test("offers three broker-comment modes and still records identity locally in every one", () => {
    // The operator picks what the BROKER sees. What we can reconcile must not depend on it.
    expect(source).toContain("enum TradeCommentVisibility");
    for (const mode of ["COMMENT_TAGGED", "COMMENT_HIDDEN", "COMMENT_CUSTOM"]) {
      expect(source).toContain(mode);
    }
    expect(source).toContain("input TradeCommentVisibility TradeComment = COMMENT_TAGGED;");
    expect(source).toContain("input string CustomTradeComment");

    // Identity is logged at all three write sites regardless of mode, because hiding the
    // tag removes the backend's last-resort attribution path and this log becomes it.
    const identityCalls = source.match(/LogTradeIdentity\(/g) ?? [];
    expect(identityCalls.length).toBeGreaterThanOrEqual(4); // 3 call sites + definition
    expect(source).toMatch(/void LogTradeIdentity\([^)]*\)[\s\S]{0,400}?PrintFormat/);
    for (const context of ['"open"', '"close"']) {
      expect(source).toContain(`LogTradeIdentity(command.logicalTradeId, ${context}`);
    }

    // No call site may concatenate a suffix onto the comment directly.
    expect(source).not.toMatch(/CompactTradeComment\([^)]*\)\s*\+\s*"/);

    // Suffixes are tagged-mode only: they must never corrupt a custom label or leak a
    // bare ":close" when hidden.
    for (const helper of ["CompactTradeTpComment", "CompactTradeSuffixComment"]) {
      const body = source.slice(
        source.indexOf(`string ${helper}(`),
        source.indexOf(`string ${helper}(`) + 260,
      );
      expect(body).toContain("!CommentCarriesTag()");
    }
    expect(source).toMatch(
      /bool CommentCarriesTag\(\)[\s\S]{0,120}?TradeComment == COMMENT_TAGGED/,
    );

    // A stray tag inside operator-supplied text would be parsed back as a real one.
    expect(source).toMatch(/StringReplace\(custom, "ttc:", ""\)/);

    // Identification must not depend on the comment: magic number stands alone.
    expect(source).toContain("(ulong)magic == MagicNumber ||");
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

  test("builds lifecycle idempotency names that MQL5 cannot truncate", () => {
    // MQL5 caps a global variable name at 63 characters and keeps only the first 63.
    // The old name pasted the backend's idempotency key in plaintext and cut the
    // result to 63, so a longer key would have pushed the position number out of the
    // name and made two positions share one mark - a close silently skipped on a live
    // account.
    const variable =
      source.match(
        /string LifecycleIdempotencyVariable\(SignalCommand &command, ulong positionId = 0\)[\s\S]*?\n}/,
      )?.[0] ?? "";
    expect(variable).toContain("LifecycleKeyHash(scopedKey)");
    expect(variable).toContain("LIFECYCLE_MARK_PREFIX");
    expect(variable).not.toContain("StringSubstr");
    expect(variable).not.toContain("63");
    // Fixed-width hex for both the account tag and the hash. Rendering either as
    // decimal makes the component variable-width and puts the cap back in reach.
    expect(variable).toContain('"%s%08X.%08X%08X.%I64u"');

    // 64-bit FNV-1a. Both constants matter: a wrong offset basis still hashes, it
    // just stops being the function whose collision behaviour is being relied on.
    const hash = source.match(/ulong LifecycleKeyHash\(string key\)[\s\S]*?\n}/)?.[0] ?? "";
    expect(hash).toContain("((ulong)3421674724 << 32) | (ulong)2216829733");
    expect(hash).toContain("ulong prime = 1099511628211;");
    expect(hash).toContain("hash = (hash ^ (ulong)(code & 0xFF)) * prime;");

    // 14 prefix + 8 tag + 1 + 16 hash + 1 + at most 20 digits = 60. Only the trailing
    // number varies. It is POSITION_IDENTIFIER as of 1.68.0 and was POSITION_TICKET
    // before; both are ulong, whose largest value 18446744073709551615 is 20 digits,
    // so the worst case is the same 60 and the bound did not move.
    expect(source).toContain('#define LIFECYCLE_MARK_PREFIX "TelegramTC.lc."');
    expect(String(2n ** 64n - 1n)).toHaveLength(20);
    expect("TelegramTC.lc.".length + 8 + 1 + 16 + 1 + 20).toBe(60);
    expect("TelegramTC.lc.".length + 8 + 1 + 16 + 1 + 20).toBeLessThan(64);
  });

  test("deletes only marks this session wrote, never marks it merely failed to disown", () => {
    // Terminal global variables are shared across every account the terminal logs
    // into; position tickets are not. Account B therefore sees A's still-open position
    // as absent. Detecting that from the name would rest the whole safety argument on
    // a lossy tag, so deletion is gated on ownership instead: this EA is logged into
    // one account and only writes marks for it, so anything it owns is its own.
    expect(source).toContain("bool owned;");
    const reclaim = source.match(/void ReclaimLifecycleMarks\(\)[\s\S]*?\n}\n/)?.[0] ?? "";
    expect(reclaim).toMatch(
      /if\(lifecycleMarks\[index\]\.owned\)\s*\n\s*GlobalVariableDel\(lifecycleMarks\[index\]\.variable\);/,
    );
    // Exactly one delete site, and it is the guarded one.
    expect(reclaim.match(/GlobalVariableDel/g)).toHaveLength(1);
    // Only MarkLifecycleExecuted may claim ownership.
    const mark =
      source.match(
        /void MarkLifecycleExecuted\(SignalCommand &command, ulong identifier = 0\)[\s\S]*?\n}/,
      )?.[0] ?? "";
    expect(mark).toContain(
      "RegisterLifecycleMark(variable, LifecycleAccountIdentity(), identifier, true, TimeLocal())",
    );
    const rehydrate = source.match(/void RehydrateLifecycleMarks\(\)[\s\S]*?\n}\n/)?.[0] ?? "";
    expect(rehydrate).toContain("if(RegisterLifecycleMark(name, identity, identifier, false, 0))");
    expect(rehydrate).not.toContain("GlobalVariableDel");
    // Ownership ratchets up only, so an adopted entry this session writes to becomes
    // deletable, and nothing can strip the right once granted.
    const register =
      source.match(
        /bool RegisterLifecycleMark\(string variable, string identity, ulong identifier, bool owned, datetime refreshedAt\)[\s\S]*?\n}\n/,
      )?.[0] ?? "";
    expect(register).toContain(
      "lifecycleMarks[index].owned = lifecycleMarks[index].owned || owned;",
    );
  });

  test("identifies an account by more than its number and keeps state across a switch", () => {
    // The same account number at two brokers is a real configuration, so a login-only
    // identity collides deterministically rather than rarely.
    const identity = source.match(/string LifecycleAccountIdentity\(\)[\s\S]*?\n}/)?.[0] ?? "";
    expect(identity).toContain("AccountInfoInteger(ACCOUNT_LOGIN)");
    expect(identity).toContain("AccountInfoString(ACCOUNT_SERVER)");
    expect(identity).toContain("AccountInfoString(ACCOUNT_COMPANY)");
    // The full identity, not the lossy fold, is what scopes reads.
    const variable =
      source.match(
        /string LifecycleIdempotencyVariable\(SignalCommand &command, ulong positionId = 0\)[\s\S]*?\n}/,
      )?.[0] ?? "";
    expect(variable).toContain(
      'string scopedKey = LifecycleAccountIdentity() + "|" + LifecycleCommandKey(command);',
    );
    // ...and the full identity, compared exactly, is what gates removal.
    const reclaim = source.match(/void ReclaimLifecycleMarks\(\)[\s\S]*?\n}\n/)?.[0] ?? "";
    expect(reclaim).toContain("string identity = LifecycleAccountIdentity();");
    expect(reclaim).toContain("bool sameAccount = lifecycleMarks[index].identity == identity;");
    expect(reclaim).toMatch(/if\(!connected \|\| !sameAccount\)\s*\n\s*continue;/);
    // An off-account entry must be skipped, never released: adoption cannot restore an
    // owned entry, so releasing it would strand its variable forever.
    const offAccount = reclaim.slice(
      reclaim.indexOf("if(!connected || !sameAccount)"),
      reclaim.indexOf("if(live)"),
    );
    expect(offAccount).not.toContain("ReleaseLifecycleMarkSlot");
    // An owned mark is still refreshed off-account, so a long switch cannot let a mark
    // guarding a live position expire.
    expect(reclaim).toMatch(
      /if\(\(lifecycleMarks\[index\]\.owned \|\| sameAccount\) && refreshDue[\s\S]{0,200}?GlobalVariableSet/,
    );
    // Position identifiers are issued per account, so the same number is live on two
    // accounts routinely. The account check must therefore short-circuit ahead of the
    // open-identifier lookup, or account B's position would read account A's mark as
    // live and, worse, A's absence run would never accumulate against B's numbers.
    expect(reclaim).toMatch(
      /bool live = connected && sameAccount\s*\n\s*&& HoldsPositionIdentifier\(/,
    );
  });

  test("defers adoption when there is no account login and retries until there is", () => {
    // A login of zero is not an account. Adopting against it would match every mark
    // written under the same blank identity. But OnInit is not the only chance: it runs
    // before the terminal has necessarily resolved an account, and skipping adoption
    // for the whole session leaves every prior mark unrefreshed until it expires.
    const rehydrate = source.match(/void RehydrateLifecycleMarks\(\)[\s\S]*?\n}\n/)?.[0] ?? "";
    expect(rehydrate).toMatch(
      /if\(AccountInfoInteger\(ACCOUNT_LOGIN\) == 0\)\s*\n\s*\{[\s\S]{0,240}?return;\s*\n\s*\}/,
    );
    // The guard must precede both the clearing and the adoption, or a retry with no
    // login would wipe a registry it cannot rebuild.
    expect(rehydrate.indexOf("ACCOUNT_LOGIN) == 0")).toBeLessThan(
      rehydrate.indexOf("ReleaseLifecycleMarkSlot"),
    );
    expect(rehydrate.indexOf("ACCOUNT_LOGIN) == 0")).toBeLessThan(
      rehydrate.indexOf("GlobalVariablesTotal()"),
    );
    expect(rehydrate).toContain("LifecycleMarksAdopted = untracked == 0;");
    // The timer retries while adoption has not happened.
    expect(source).toMatch(
      /void\s+OnTimer\(\)[\s\S]*if\(!LifecycleMarksAdopted\)\s*\n\s*RehydrateLifecycleMarks\(\);/,
    );

    // A retry must not destroy owned entries: re-adoption can only produce undeletable
    // ones, so clearing an owned entry would strand its variable forever.
    expect(rehydrate).toMatch(
      /if\(lifecycleMarks\[index\]\.active && !lifecycleMarks\[index\]\.owned\)\s*\n\s*ReleaseLifecycleMarkSlot\(index\);/,
    );
    expect(rehydrate).not.toContain("lifecycleMarkCount = 0;");
  });

  test("keeps refreshing marks while the terminal is disconnected", () => {
    // Rewriting a terminal global needs no server connection; only deciding a position
    // is gone does. Gating both meant a long disconnection stopped every refresh, and a
    // mark guarding a live position expired at four weeks with a replay still possible.
    const reclaim = source.match(/void ReclaimLifecycleMarks\(\)[\s\S]*?\n}\n/)?.[0] ?? "";
    expect(reclaim).toContain("bool connected = TerminalInfoInteger(TERMINAL_CONNECTED) != 0;");
    // No early return: the function must reach the refresh arm while disconnected.
    expect(reclaim).not.toMatch(/TERMINAL_CONNECTED\)[\s\S]{0,40}?\n\s*return;/);
    // Connectivity gates removal only, and it gates it together with the account check.
    expect(reclaim).toMatch(/if\(!connected \|\| !sameAccount\)\s*\n\s*continue;/);
    // The refresh arm sits before that gate.
    expect(reclaim.indexOf("GlobalVariableSet")).toBeLessThan(
      reclaim.indexOf("if(!connected || !sameAccount)"),
    );

    // TimeCurrent is the last quote's server time and stops advancing while
    // disconnected, so it cannot be the clock that decides a refresh is due.
    expect(reclaim).toContain("datetime now = TimeLocal();");
    expect(reclaim).toContain(
      "|| now - lifecycleMarks[index].refreshedAt >= LIFECYCLE_MARK_REFRESH_SECONDS;",
    );
    // An adopted mark may already be near its expiry, so it refreshes on sight rather
    // than a full interval after adoption.
    expect(reclaim).toContain("lifecycleMarks[index].refreshedAt == 0");
  });

  test("keeps every clock out of the path that deletes a mark", () => {
    // Refresh needs an advancing clock so it survives a disconnection, but the same
    // clock must not reach the destructive path: a backward NTP step or a manual
    // correction would collapse the grace and delete a mark guarding a live position.
    // A three-week refresh window absorbs a jump; a five-minute grace does not.
    const reclaim = source.match(/void ReclaimLifecycleMarks\(\)[\s\S]*?\n}\n/)?.[0] ?? "";
    const destructive = reclaim.slice(reclaim.indexOf("if(!connected || !sameAccount)"));
    expect(destructive).toContain("GlobalVariableDel");
    for (const clock of ["TimeLocal", "TimeCurrent", "now", "SECONDS"]) {
      expect(destructive).not.toContain(clock);
    }
    // The grace is a count of consecutive sweeps, which the clamped timer makes a
    // duration the EA controls without trusting any clock.
    expect(source).toContain("#define LIFECYCLE_MARK_ABSENT_PASSES 10");
    expect(source).toContain("int absentPasses;");
    expect(destructive).toContain("lifecycleMarks[index].absentPasses++;");
    expect(destructive).toContain(
      "if(lifecycleMarks[index].absentPasses < LIFECYCLE_MARK_ABSENT_PASSES)",
    );
    // A sighting must reset the run, or ten scattered absences across a month would
    // add up to a deletion.
    expect(reclaim).toMatch(
      /if\(live\)\s*\n\s*\{\s*\n\s*lifecycleMarks\[index\]\.absentPasses = 0;/,
    );

    // Where a clock does remain, a backward jump reads as due rather than not-yet.
    expect(reclaim).toContain("|| now < lifecycleMarks[index].refreshedAt");
    expect(source).toMatch(
      /\|\| now < LastLifecycleReclaimAt\s*\n\s*\|\| now - LastLifecycleReclaimAt >=/,
    );
  });

  test("reports a full registry instead of silently dropping a mark", () => {
    // A dropped registration is invisible otherwise: the variable is still written so
    // the first duplicate is still refused, but nothing refreshes it and it expires at
    // four weeks with the position still open.
    const register =
      source.match(
        /bool RegisterLifecycleMark\(string variable, string identity, ulong identifier, bool owned, datetime refreshedAt\)[\s\S]*?\n}\n/,
      )?.[0] ?? "";
    expect(register).toContain("return false;");
    expect(register).toContain("is not tracked and will not be refreshed");
    // Adoption fills the registry with previous sessions' marks; live positions never
    // will. So a mark this session wrote outranks an adopted one for the last slot.
    expect(register).toContain("if(freeSlot < 0 && owned && adoptedSlot >= 0)");
    expect(register).toMatch(
      /ReleaseLifecycleMarkSlot\(adoptedSlot\);\s*\n\s*freeSlot = adoptedSlot;/,
    );
    // Evicting an adopted entry drops tracking only; its variable is never deleted.
    const eviction = register.slice(
      register.indexOf("if(freeSlot < 0 && owned && adoptedSlot >= 0)"),
      register.indexOf("if(freeSlot < 0)\n   {"),
    );
    expect(eviction).not.toContain("GlobalVariableDel");

    // A failed adoption must not be counted as adopted, and must leave a retry open.
    const rehydrate = source.match(/void RehydrateLifecycleMarks\(\)[\s\S]*?\n}\n/)?.[0] ?? "";
    expect(rehydrate).toMatch(
      /if\(RegisterLifecycleMark\(name, identity, identifier, false, 0\)\)\s*\n\s*adopted\+\+;\s*\n\s*else\s*\n\s*untracked\+\+;/,
    );
    expect(rehydrate).toContain("LifecycleMarksAdopted = untracked == 0;");
    // The completion flag is set from the result, after the loop, not asserted up front.
    expect(rehydrate.indexOf("LifecycleMarksAdopted =")).toBeGreaterThan(
      rehydrate.indexOf("GlobalVariablesTotal()"),
    );
  });

  test("clamps the poll interval so the sweep cannot be starved", () => {
    // The timer drives the sweep, so the poll interval is the refresh cadence. The
    // backend caps what it sends but cannot correct a startup value before the first
    // timer event, and an interval beyond the four-week expiry means no sweep in time.
    expect(source).toContain("#define MAX_POLL_SECONDS 300");
    const clamp = source.match(/int ClampPollSeconds\(int seconds\)[\s\S]*?\n}/)?.[0] ?? "";
    expect(clamp).toContain("MathMax(1, MathMin(MAX_POLL_SECONDS, seconds))");
    // Both entry points clamp: the operator input at init and the backend value later.
    expect(source).toContain("CurrentPollSeconds = ClampPollSeconds(PollSeconds);");
    expect(source).toContain("CurrentPollSeconds = ClampPollSeconds(nextPollSeconds);");
    expect(source).not.toContain("CurrentPollSeconds = MathMax(1, PollSeconds);");
    expect(source).not.toContain("CurrentPollSeconds = MathMax(1, nextPollSeconds);");
  });

  test("validates every segment of a mark name before adopting it", () => {
    // Anything may use the terminal's global variables. A name that merely starts with
    // the reserved prefix is not one of ours and must not be adopted.
    //
    // These are source-text assertions, not behavioural ones: nothing here executes
    // MQL5, so a parser that kept every asserted line and still misbehaved would pass.
    // That is tolerable only because reclamation is gated on ownership rather than on
    // this parser. A wrong answer here can leak a mark or skip a refresh; it cannot
    // delete anything, because an adopted mark is never deletable.
    const parse =
      source.match(
        /bool ParseLifecycleMarkName\(string variable, string &accountTagText, ulong &identifier\)[\s\S]*?\n}\n/,
      )?.[0] ?? "";
    expect(parse).toBeTruthy();
    expect(parse).toContain("if(tagEnd != prefixLength + 8)");
    expect(parse).toContain("if(hashEnd != tagEnd + 17)");
    expect(parse).toContain('if(!IsHexRun(tagText, 8) || !IsHexRun(hashText, 16) || digits == "")');
    expect(parse).toContain("if(IntegerToString((long)identifier) != digits)");
    const isHex = source.match(/bool IsHexRun\(string text, int length\)[\s\S]*?\n}\n/)?.[0] ?? "";
    expect(isHex).toContain("if(StringLen(text) != length)");
    expect(isHex).toContain("code >= '0' && code <= '9'");
    expect(isHex).toContain("code >= 'A' && code <= 'F'");
    // Recognising the ranges is not enough; anything outside them must be rejected.
    expect(isHex).toMatch(/if\(!digit && !upper\)\s*\n\s*return false;/);
    expect(source).toContain("if(!ParseLifecycleMarkName(name, tagText, identifier))");
  });

  test("keeps reading marks written under the pre-1.67 name and never writes that name again", () => {
    // The recompile changes the name every mark is stored under. Without this read a
    // close executed just before the upgrade would lose its mark and could run twice.
    expect(source).toContain('#define LEGACY_LIFECYCLE_MARK_PREFIX "TelegramTC.lifecycle."');
    const already =
      source.match(
        /bool LifecycleAlreadyExecuted\(SignalCommand &command, ulong identifier = 0, ulong ticket = 0\)[\s\S]*?\n}/,
      )?.[0] ?? "";
    // The plaintext name was only ever keyed by the ticket, so that is what reads it.
    expect(already).toContain(
      "GlobalVariableCheck(LegacyLifecycleIdempotencyVariable(command, ticket))",
    );

    const mark =
      source.match(
        /void MarkLifecycleExecuted\(SignalCommand &command, ulong identifier = 0\)[\s\S]*?\n}/,
      )?.[0] ?? "";
    expect(mark).toContain("string variable = LifecycleIdempotencyVariable(command, identifier);");
    expect(mark).not.toContain("Legacy");
    // A legacy mark's ticket may have been truncated out of its name, so the EA cannot
    // tell whether its position is still open and must leave it to the terminal.
    expect(source).not.toContain("GlobalVariableDel(LegacyLifecycleIdempotencyVariable");
    const rehydrate = source.match(/void RehydrateLifecycleMarks\(\)[\s\S]*?\n}/)?.[0] ?? "";
    expect(rehydrate).toContain("StringFind(name, LIFECYCLE_MARK_PREFIX) != 0");
    expect(rehydrate).not.toContain("LEGACY_LIFECYCLE_MARK_PREFIX");
  });

  test("keys lifecycle marks by POSITION_IDENTIFIER, which a ticket replacement cannot move", () => {
    // MQL5 documents POSITION_TICKET as replaceable by a server service operation,
    // "for example, when charging swaps with position re-opening", while
    // POSITION_IDENTIFIER "does not change throughout its life cycle". Keying a mark by
    // the ticket meant the successor position carried a ticket no mark was written
    // against, so a redelivered close read as never executed and closed it a second
    // time. Matching already survived a replacement; only the mark did not.
    const key = source.match(/ulong PositionMarkKey\(ulong ticket\)[\s\S]*?\n}/)?.[0] ?? "";
    expect(key).toContain("PositionGetInteger(POSITION_IDENTIFIER)");
    // Zero is the command-scoped name CANCEL_PENDING writes. A position resolving to it
    // would put two positions under one command on a single mark, and the second close
    // would be recorded as already done and silently skipped.
    expect(key).toContain("return identifier == 0 ? ticket : identifier;");

    // One rule, used by the side that writes a mark and the side that reclaims it, so
    // the two cannot drift into keying by different numbers.
    expect(source.match(/PositionGetInteger\(POSITION_IDENTIFIER\)/g)).toHaveLength(1);
    const collect =
      source.match(
        /int CollectPositionTargets\(SignalCommand &command, ulong &tickets\[\], ulong &identifiers\[\]\)[\s\S]*?\n}\n/,
      )?.[0] ?? "";
    expect(collect).toContain("identifiers[next] = PositionMarkKey(ticket);");
    expect(collect).toContain("identifiers[0] = PositionMarkKey(command.targetPositionTicket);");
    // The ticket-only callers share the one matching rule rather than a second copy.
    const ticketsOnly =
      source.match(
        /int CollectPositionTickets\(SignalCommand &command, ulong &tickets\[\]\)[\s\S]*?\n}\n/,
      )?.[0] ?? "";
    expect(ticketsOnly).toContain("return CollectPositionTargets(command, tickets, identifiers);");
    expect(ticketsOnly).not.toContain("PositionsTotal()");

    // A full close removes the position, so the identifier must be read while the
    // position is still selected, before anything closes anything, and not at the
    // bottom of the function where the mark is written.
    const close =
      source.match(/bool ClosePositionTicket\([\s\S]*?\n\)\n\{[\s\S]*?\n}\n/)?.[0] ?? "";
    expect(close).toContain("ulong identifier = PositionMarkKey(ticket);");
    expect(close.indexOf("ulong identifier = PositionMarkKey(ticket);")).toBeLessThan(
      close.indexOf("OrderSend"),
    );
    expect(close.indexOf("ulong identifier = PositionMarkKey(ticket);")).toBeLessThan(
      close.indexOf("MarkLifecycleExecuted(command, identifier);"),
    );

    // Liveness during reclamation can no longer be a PositionSelectByTicket lookup:
    // that is exactly what a replaced ticket defeats. It is answered from a list of
    // the identifiers the terminal currently holds open.
    const reclaim = source.match(/void ReclaimLifecycleMarks\(\)[\s\S]*?\n}\n/)?.[0] ?? "";
    expect(reclaim).not.toContain("PositionSelectByTicket");
    expect(reclaim).toContain(
      "HoldsPositionIdentifier(openIdentifiers, openIdentifierCount, lifecycleMarks[index].positionIdentifier)",
    );
    // Collected once per sweep, not once per mark: 512 marks driving their own scans
    // would re-select every open position 512 times for the same answer.
    expect(reclaim.match(/CollectOpenPositionIdentifiers/g)).toHaveLength(1);
    // The scan is a removal-arm input, so it must not run while disconnected.
    expect(reclaim).toMatch(
      /if\(connected\)\s*\n\s*openIdentifierCount = CollectOpenPositionIdentifiers\(openIdentifiers\);/,
    );
    const scan =
      source.match(
        /int CollectOpenPositionIdentifiers\(ulong &identifiers\[\]\)[\s\S]*?\n}\n/,
      )?.[0] ?? "";
    expect(scan).toContain("identifiers[next] = PositionMarkKey(ticket);");
    // The registry holds the identifier and nothing else, so no code path can reach a
    // stored ticket and quietly key off it again. Other structures keep their own
    // positionTicket fields; this one must not.
    const markStruct = source.match(/struct LifecycleMark[\s\S]*?\n\s*\};/)?.[0] ?? "";
    expect(markStruct).toContain("ulong positionIdentifier;");
    expect(markStruct).not.toContain("positionTicket");
  });

  test("keeps a 1.67 ticket-keyed mark protecting its position through the upgrade", () => {
    // Two name formats, not three. The second read is the same format keyed by the
    // position's current ticket, which is what 1.67 wrote, and it is skipped whenever
    // the two numbers agree - which is every position the server never re-opened.
    const already =
      source.match(
        /bool LifecycleAlreadyExecuted\(SignalCommand &command, ulong identifier = 0, ulong ticket = 0\)[\s\S]*?\n}/,
      )?.[0] ?? "";
    expect(already).toBeTruthy();
    expect(already).toMatch(
      /if\(GlobalVariableCheck\(LifecycleIdempotencyVariable\(command, identifier\)\)\)\s*\n\s*return true;/,
    );
    expect(already).toMatch(
      /if\(ticket != identifier && GlobalVariableCheck\(LifecycleIdempotencyVariable\(command, ticket\)\)\)\s*\n\s*return true;/,
    );
    // The identifier is read first, so the ordinary case costs one lookup as before.
    expect(already.indexOf("command, identifier")).toBeLessThan(
      already.indexOf("ticket != identifier"),
    );

    // Reading an old key must never write one. Only the identifier is ever stored, so
    // the ticket-keyed layer drains as positions close rather than being topped up.
    const mark =
      source.match(
        /void MarkLifecycleExecuted\(SignalCommand &command, ulong identifier = 0\)[\s\S]*?\n}/,
      )?.[0] ?? "";
    expect(mark).not.toContain("ticket");
    // CANCEL_PENDING still keys on zero, and its read must not be diverted by the
    // ticket layer: identifier and ticket are both zero there, so the second read is
    // skipped and the behaviour is exactly 1.67's.
    expect(source).toContain("if(LifecycleAlreadyExecuted(command))");
    expect(source).toContain("MarkLifecycleExecuted(command);");
  });

  test("reclaims a lifecycle mark only once its position is gone for good", () => {
    // Nothing ever called GlobalVariableDel, so the mark set grew with history and
    // drained only on the terminal's four-week expiry. Dropping a mark early is the
    // worse failure though: it puts double-close back on a live account.
    const reclaim = source.match(/void ReclaimLifecycleMarks\(\)[\s\S]*?\n}\n/)?.[0] ?? "";
    expect(reclaim).toBeTruthy();
    expect(reclaim).toContain("GlobalVariableDel(lifecycleMarks[index].variable);");
    expect(reclaim).toContain("ReleaseLifecycleMarkSlot(index);");

    // A live position keeps its mark and resets the absence clock.
    expect(reclaim).toMatch(
      /HoldsPositionIdentifier\(openIdentifiers, openIdentifierCount, lifecycleMarks\[index\]\.positionIdentifier\)[\s\S]*?absentPasses = 0;/,
    );
    // A single absent reading is never enough: a reconnect can hide an open position,
    // and no removal happens at all without a connection to confirm it.
    expect(reclaim).toMatch(/if\(!connected \|\| !sameAccount\)\s*\n\s*continue;/);
    expect(reclaim).toContain("lifecycleMarks[index].absentPasses++;");
    expect(reclaim).toContain(
      "if(lifecycleMarks[index].absentPasses < LIFECYCLE_MARK_ABSENT_PASSES)",
    );
    // A mark guarding a runner that outlives the four-week expiry is rewritten, and
    // only a rewrite the terminal confirmed may advance the clock. Advancing it on a
    // failed write records a refresh that did not happen and lets the mark expire.
    expect(reclaim).toMatch(
      /&& GlobalVariableSet\(lifecycleMarks\[index\]\.variable, \(double\)TimeCurrent\(\)\) != 0\)\s*\n\s*lifecycleMarks\[index\]\.refreshedAt = now;/,
    );
    expect(source).toMatch(/void\s+OnTimer\(\)[\s\S]*ReclaimLifecycleMarks\(\)/);
  });

  test("does not reclaim command-scoped marks on a timer", () => {
    // A CANCEL_PENDING mark has no position to watch, and no age at which the EA can
    // prove the server will not ask again, so any number would be a guess. Untracked
    // means never deleted here: the terminal's expiry applies, and MQL5 renews that on
    // every read, so a mark still being consulted survives.
    const mark =
      source.match(
        /void MarkLifecycleExecuted\(SignalCommand &command, ulong identifier = 0\)[\s\S]*?\n}/,
      )?.[0] ?? "";
    expect(mark).toMatch(/if\(identifier == 0\)\s*\n\s*return;/);
    expect(source).not.toContain("LIFECYCLE_MARK_COMMAND_RETENTION_SECONDS");
    // Rehydration must not pull them back in either.
    const rehydrate = source.match(/void RehydrateLifecycleMarks\(\)[\s\S]*?\n}\n/)?.[0] ?? "";
    expect(rehydrate).toContain("if(tagText != currentTag || identifier == 0)");
    // Every tracked entry therefore has a real position number, so the sweep has no
    // zero branch left to get wrong.
    const reclaim = source.match(/void ReclaimLifecycleMarks\(\)[\s\S]*?\n}\n/)?.[0] ?? "";
    expect(reclaim).not.toContain("positionIdentifier > 0");
  });

  test("never lets mark bookkeeping stop a mark being recorded, and survives a restart", () => {
    // The global variable is what protects the account. Registry state is only how the
    // EA hands it back, so the write must come first and a full registry must not fail
    // the write.
    const mark =
      source.match(
        /void MarkLifecycleExecuted\(SignalCommand &command, ulong identifier = 0\)[\s\S]*?\n}/,
      )?.[0] ?? "";
    expect(mark).toMatch(/GlobalVariableSet\(variable[\s\S]*RegisterLifecycleMark\(variable/);
    const register =
      source.match(
        /bool RegisterLifecycleMark\(string variable, string identity, ulong identifier, bool owned, datetime refreshedAt\)[\s\S]*?\n}\n/,
      )?.[0] ?? "";
    expect(register).toContain(
      "if(freeSlot < 0 && lifecycleMarkCount < ArraySize(lifecycleMarks))",
    );
    expect(register).toContain("is not tracked and will not be refreshed");
    expect(register).toContain("if(freeSlot < 0 && !lifecycleMarks[index].active)");
    expect(register).toMatch(/variable == variable[\s\S]*?return true;[\s\S]*?freeSlot = index/);

    // Global variables outlive the process; the registry does not. Adopt what an
    // earlier session left or nothing would ever reclaim it.
    expect(source).toMatch(/int OnInit\(\)[\s\S]*RehydrateLifecycleMarks\(\)/);
    // OnDeinit must not clear marks: a reattach has to keep them.
    const deinit = source.match(/void OnDeinit\(const int reason\)[\s\S]*?\n}/)?.[0] ?? "";
    expect(deinit).not.toContain("GlobalVariable");

    const release =
      source.match(/void ReleaseLifecycleMarkSlot\(int index\)[\s\S]*?\n}\n/)?.[0] ?? "";
    for (const cleared of [
      "active = false",
      'variable = ""',
      "owned = false",
      'identity = ""',
      "positionIdentifier = 0",
      "refreshedAt = 0",
      "absentPasses = 0",
    ]) {
      expect(release).toContain(cleared);
    }
    expect(source).not.toContain("lifecycleMarkCount--");
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
