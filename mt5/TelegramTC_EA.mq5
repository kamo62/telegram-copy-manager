//+------------------------------------------------------------------+
//| Telegram TC Expert Advisor                                       |
//| Polls the Telegram TC backend for normalized trade instructions. |
//+------------------------------------------------------------------+
#property copyright "Telegram TC"
#property version   "1.28.0"
#property strict

input string BackendBaseUrl = "http://192.168.0.100:18787/api";
input int    PollSeconds    = 1;
input string LinkCode       = "-UTN4-D6";
input int    HistoryLookbackHours = 168;
input int    HeartbeatSeconds = 5;
input int    HistoryBackfillSeconds = 60;
input double DefaultLots    = 0.10;
input int    DeviationPoints = 20;
input ulong  MagicNumber    = 26050901;
// When > 0, every order's volume becomes SYMBOL_VOLUME_MIN × this multiplier,
// overriding DefaultLots and any per-provider lot. Useful when you want
// "smallest broker-acceptable size × N" across mixed asset classes (forex,
// gold, indices, crypto) without configuring each one separately.
// 0 = disabled (use DefaultLots / provider config / risk% as today).
input double BrokerMinLotMultiplier = 0.0;
// Safety net for stops. SYMBOL_TRADE_STOPS_LEVEL is the broker's minimum
// distance from market for SL/TP. If our requested SL/TP sits closer than
// stopsLevel × this multiplier, the EA pushes it out to that safe minimum
// rather than letting the broker reject the order with retcode 10016
// (INVALID_STOPS). 1.0 = exactly the broker minimum; 1.5 leaves a small
// buffer for spread / price drift. 0 = disabled (send stops as-is).
input double MinStopBufferMultiplier = 1.5;

struct SignalCommand
{
   string queueItemId;
   string logicalTradeId;
   string commandType;
   string brokerSymbol;
   string canonicalSymbol;
   string direction;
   string orderType;
   string executionMode;
   double volume;
   double riskPercent;
   double entryFrom;
   double entryTo;
   double stopLoss;
   double defaultStopLossValue;
   string defaultStopLossUnit;
   double newStopLoss;
   double defaultTakeProfitValue;
   string defaultTakeProfitUnit;
   double trailingStopValue;
   string trailingStopUnit;
   string partialCloseKind;
   double partialCloseValue;
   double partialCloseVolume;
   double partialCloseAllocation;
   ulong targetOrderTicket;
   ulong targetPositionTicket;
   ulong targetDealTicket;
   double tp[4];
   double tpAllocation[4];
   double tpVolume[4];
};

struct TrailingStopState
{
   bool active;
   string queueItemId;
   string logicalTradeId;
   string symbol;
   string direction;
   ulong positionTicket;
   double distance;
};

TrailingStopState trailingStopStates[100];
int trailingStopStateCount = 0;
int CurrentPollSeconds = 0;
datetime LastHeartbeatSentAt = 0;
datetime LastHistoryBackfillAt = 0;

int OnInit()
{
   CurrentPollSeconds = MathMax(1, PollSeconds);
   if(StringFind(BackendBaseUrl, "your-api-host.example.com") >= 0 || BackendBaseUrl == "")
      Print("Telegram TC: set BackendBaseUrl to your deployed API /api URL before enabling live polling.");
   if(LinkCode == "")
      Print("Telegram TC: LinkCode is empty — registrations will land in an unlabelled slot. Paste the link code from the App's Linked Accounts page.");
   EventSetTimer(CurrentPollSeconds);
   RegisterAccount();
   return(INIT_SUCCEEDED);
}

void OnDeinit(const int reason)
{
   EventKillTimer();
}

void OnTimer()
{
   datetime now = TimeLocal();
   if(LastHeartbeatSentAt == 0 || now - LastHeartbeatSentAt >= MathMax(1, HeartbeatSeconds))
   {
      SendHeartbeat();
      LastHeartbeatSentAt = now;
   }
   SendSnapshot();
   ManageTrailingStops();
   PollAndExecute();
   if(LastHistoryBackfillAt == 0 || now - LastHistoryBackfillAt >= MathMax(1, HistoryBackfillSeconds))
   {
      SendHistoryDeals();
      LastHistoryBackfillAt = now;
   }
}

void OnTradeTransaction(const MqlTradeTransaction &trans,
                        const MqlTradeRequest &request,
                        const MqlTradeResult &result)
{
   if(trans.type != TRADE_TRANSACTION_DEAL_ADD || trans.deal == 0)
      return;
   if(!HistoryDealSelect(trans.deal))
      return;
   PostHistoryDeal(trans.deal);
}

void RegisterAccount()
{
   string body = AccountPayload();
   string response = "";
   // Registration is idempotent server-side (link code matches a single slot,
   // duplicate registers just update the slot's last-known fields). Safe to
   // retry across a container restart window.
   HttpPostRetry("/mt5/register", body, response);
}

void SendHeartbeat()
{
   string body = StringFormat(
      "{\"accountId\":\"mt5-%I64d\",\"balance\":%.2f,\"equity\":%.2f,\"profit\":%.2f,\"availableSymbols\":%s,\"linkCode\":\"%s\"}",
      AccountInfoInteger(ACCOUNT_LOGIN),
      AccountInfoDouble(ACCOUNT_BALANCE),
      AccountInfoDouble(ACCOUNT_EQUITY),
      AccountInfoDouble(ACCOUNT_PROFIT),
      SymbolsJson(),
      JsonEscape(LinkCode)
   );
   string response = "";
   // Heartbeat is a pure idempotent timestamp update — safe to retry across a
   // container restart window so the slot doesn't appear stale to the App.
   HttpPostRetry("/mt5/heartbeat", body, response);
}

void SendSnapshot()
{
   string body = StringFormat(
      "{\"accountId\":\"mt5-%I64d\",\"positions\":%s,\"orders\":%s,\"symbols\":%s}",
      AccountInfoInteger(ACCOUNT_LOGIN),
      PositionsJson(),
      OrdersJson(),
      SymbolsMarketJson()
   );
   string response = "";
   HttpPostRetry("/mt5/snapshot", body, response);
}

void SendHistoryDeals()
{
   datetime toTime = TimeCurrent();
   datetime fromTime = toTime - MathMax(1, HistoryLookbackHours) * 3600;
   if(!HistorySelect(fromTime, toTime))
      return;
   string body = StringFormat(
      "{\"accountId\":\"mt5-%I64d\",\"deals\":%s}",
      AccountInfoInteger(ACCOUNT_LOGIN),
      HistoryDealsJson()
   );
   string response = "";
   // History is server-side dedup'd by deal_ticket, so retrying duplicate
   // payloads is a no-op. Safe to retry across a deploy window.
   HttpPostRetry("/mt5/history", body, response);
}

void PostHistoryDeal(ulong ticket)
{
   string body = StringFormat(
      "{\"accountId\":\"mt5-%I64d\",\"deals\":[%s]}",
      AccountInfoInteger(ACCOUNT_LOGIN),
      HistoryDealJson(ticket)
   );
   string response = "";
   HttpPostRetry("/mt5/history", body, response);
}

void PollAndExecute()
{
   string url = StringFormat("/mt5/poll-line?accountId=mt5-%I64d", AccountInfoInteger(ACCOUNT_LOGIN));
   string response = "";
   if(!HttpGet(url, response))
      return;

   ApplyPollConfig(response);

   if(StringFind(response, "status=WORK") < 0)
      return;

   SignalCommand command = {};
   if(!ParseCommand(response, command))
   {
      ReportFailure(command.queueItemId, "Could not parse poll payload", "parser");
      return;
   }

   PrintWorkCommand(command);

   if(command.commandType == "OPEN_TRADE")
      ExecuteOpenTrade(command);
   else if(command.commandType == "CANCEL_PENDING")
      ExecuteCancelPending(command);
   else if(command.commandType == "MOVE_SL_TO_BE")
      ExecuteMoveSlToBreakeven(command);
   else if(command.commandType == "MODIFY_SL")
      ExecuteModifySl(command);
   else if(command.commandType == "MODIFY_TP")
      ExecuteModifyTp(command);
   else if(command.commandType == "TRAILING_STOP")
      ExecuteTrailingStop(command);
   else if(command.commandType == "CLOSE_TRADE" || command.commandType == "CLOSE_PARTIAL")
      ExecuteClose(command);
   else
      ReportFailure(command.queueItemId, "Unsupported command type", command.commandType);
}

void PrintWorkCommand(SignalCommand &command)
{
   PrintFormat("Telegram TC WORK command=%s queue=%s logicalTradeId=%s symbol=%s direction=%s targetPosition=%I64u targetOrder=%I64u volume=%.2f newSL=%.5f partialKind=%s partialValue=%.2f partialVolume=%.2f",
      command.commandType,
      command.queueItemId,
      command.logicalTradeId,
      command.brokerSymbol,
      command.direction,
      command.targetPositionTicket,
      command.targetOrderTicket,
      command.volume,
      command.newStopLoss,
      command.partialCloseKind,
      command.partialCloseValue,
      command.partialCloseVolume);
}

ENUM_ORDER_TYPE_FILLING FillingModeForSymbol(string symbol, bool pendingOrder)
{
   if(pendingOrder)
      return ORDER_FILLING_RETURN;

   long fillingMode = SymbolInfoInteger(symbol, SYMBOL_FILLING_MODE);
   ENUM_SYMBOL_TRADE_EXECUTION execMode =
      (ENUM_SYMBOL_TRADE_EXECUTION)SymbolInfoInteger(symbol, SYMBOL_TRADE_EXEMODE);

   // Market / Exchange execution: ORDER_FILLING_RETURN is invalid for instant deals.
   // OctaFX returns retcode 10030 (Unsupported filling mode) when RETURN is used for
   // market-execution symbols such as crypto pairs. Prefer FOK, then IOC, and default
   // to FOK when the broker reports an empty mask (typical for some MetaQuotes builds).
   if(execMode == SYMBOL_TRADE_EXECUTION_MARKET || execMode == SYMBOL_TRADE_EXECUTION_EXCHANGE)
   {
      if((fillingMode & SYMBOL_FILLING_FOK) == SYMBOL_FILLING_FOK)
         return ORDER_FILLING_FOK;
      if((fillingMode & SYMBOL_FILLING_IOC) == SYMBOL_FILLING_IOC)
         return ORDER_FILLING_IOC;
      return ORDER_FILLING_FOK;
   }

   // Instant / Request execution: RETURN is the canonical choice.
   if((fillingMode & SYMBOL_FILLING_IOC) == SYMBOL_FILLING_IOC)
      return ORDER_FILLING_IOC;
   if((fillingMode & SYMBOL_FILLING_FOK) == SYMBOL_FILLING_FOK)
      return ORDER_FILLING_FOK;
   return ORDER_FILLING_RETURN;
}

bool ExecuteOpenTrade(SignalCommand &command)
{
   if(!EnsureSymbol(command.brokerSymbol))
   {
      ReportFailure(command.queueItemId, "Symbol is unavailable or has no fresh tick", command.brokerSymbol);
      return false;
   }

   if(command.executionMode == "SPLIT_ORDER")
      return ExecuteSplitOrders(command);

   MqlTradeRequest request = {};
   MqlTradeResult result = {};
   request.symbol = command.brokerSymbol;
   request.magic = MagicNumber;
   request.volume = CommandVolume(command);
   request.deviation = DeviationPoints;
   request.comment = CompactTradeComment(command.logicalTradeId);

   if(command.orderType == "LIMIT" || command.orderType == "STOP")
   {
      if(!ValidatePendingOrderPrice(command))
      {
         ReportFailure(command.queueItemId, "Invalid pending order price for current bid/ask or stop level", command.brokerSymbol);
         return false;
      }
      request.action = TRADE_ACTION_PENDING;
      request.price = command.entryFrom;
      request.type_time = ORDER_TIME_GTC;
      request.type_filling = FillingModeForSymbol(command.brokerSymbol, true);
      request.type = PendingOrderType(command.direction, command.orderType);
   }
   else
   {
      request.action = TRADE_ACTION_DEAL;
      request.type_filling = FillingModeForSymbol(command.brokerSymbol, false);
      request.type = command.direction == "BUY" ? ORDER_TYPE_BUY : ORDER_TYPE_SELL;
      request.price = MarketReferencePrice(command);
   }

   // EnsureSymbol guarantees a fresh tick, so defaults and market pricing use
   // a non-zero quote rather than opening an unprotected market position.
   double referencePrice = request.price;
   if(referencePrice <= 0.0)
      referencePrice = MarketReferencePrice(command);
   if(command.stopLoss <= 0.0)
      command.stopLoss = DefaultStopLossPrice(command, referencePrice);
   if(command.tp[0] <= 0.0)
      command.tp[0] = DefaultTakeProfitPrice(command, referencePrice);
   if(command.tp[0] > 0.0 && command.tpAllocation[0] <= 0.0)
      command.tpAllocation[0] = 100.0;

   if(command.stopLoss <= 0.0 || command.tp[0] <= 0.0)
   {
      PrintFormat("Telegram TC OPEN_TRADE WARNING %s missing protective stops: sl=%.5f tp=%.5f refPrice=%.5f (signal lacked them and defaults could not be computed)",
         command.brokerSymbol, command.stopLoss, command.tp[0], referencePrice);
   }

   request.sl = SafeStopPrice(command.brokerSymbol, referencePrice, command.stopLoss, command.direction, true);
   double rawTp = command.executionMode == "SPLIT_ORDER" ? command.tp[0] : 0.0;
   request.tp = rawTp > 0.0
      ? SafeStopPrice(command.brokerSymbol, referencePrice, rawTp, command.direction, false)
      : 0.0;

   PrintFormat("Telegram TC OPEN_TRADE symbol=%s side=%s type=%s vol=%.2f price=%.5f sl=%.5f filling=%d execMode=%d",
      command.brokerSymbol, command.direction, command.orderType,
      request.volume, request.price, request.sl,
      (int)request.type_filling,
      (int)SymbolInfoInteger(command.brokerSymbol, SYMBOL_TRADE_EXEMODE));

   bool sent = OrderSend(request, result);
   int sendErr = sent ? 0 : GetLastError();

   PrintFormat("Telegram TC OrderSend RESULT sent=%s retcode=%u (%s) deal=%I64u order=%I64u price=%.5f err=%d",
      sent ? "true" : "false",
      result.retcode, result.comment,
      result.deal, result.order, result.price, sendErr);

   Report(
      command.queueItemId,
      IsTradeSuccess(result.retcode) ? "EXECUTED" : "FAILED",
      result.retcode,
      result.retcode_external,
      result.comment,
      result.order,
      FindPositionTicket(command),
      result.deal,
      request.price,
      result.price,
      request.volume,
      sent ? "" : IntegerToString(sendErr)
   );
   bool ok = sent && IsTradeSuccess(result.retcode);
   return ok;
}

bool ExecuteSplitOrders(SignalCommand &command)
{
   bool anySent = false;
   bool allSucceeded = true;
   double baseVolume = CommandBaseVolume(command);
   double referencePrice = command.entryFrom > 0.0 ? command.entryFrom : MarketReferencePrice(command);
   if(command.stopLoss <= 0.0)
      command.stopLoss = DefaultStopLossPrice(command, referencePrice);
   if(command.tp[0] <= 0.0)
      command.tp[0] = DefaultTakeProfitPrice(command, referencePrice);

   for(int leg = 0; leg < 4; leg++)
   {
      if(command.tp[leg] <= 0.0)
         continue;

      MqlTradeRequest request = {};
      MqlTradeResult result = {};
      request.symbol = command.brokerSymbol;
      request.magic = MagicNumber;
      request.volume = LegVolume(command, leg, baseVolume);
      request.deviation = DeviationPoints;
      request.comment = CompactTradeTpComment(command.logicalTradeId, leg + 1);
      request.sl = SafeStopPrice(command.brokerSymbol, referencePrice, command.stopLoss, command.direction, true);
      request.tp = SafeStopPrice(command.brokerSymbol, referencePrice, command.tp[leg], command.direction, false);

      if(command.orderType == "LIMIT" || command.orderType == "STOP")
      {
         if(!ValidatePendingOrderPrice(command))
         {
            ReportFailure(command.queueItemId, "Invalid split pending order price for current bid/ask or stop level", command.brokerSymbol);
            return false;
         }
         request.action = TRADE_ACTION_PENDING;
         request.price = command.entryFrom;
         request.type_time = ORDER_TIME_GTC;
         request.type_filling = FillingModeForSymbol(command.brokerSymbol, true);
         request.type = PendingOrderType(command.direction, command.orderType);
      }
      else
      {
         request.action = TRADE_ACTION_DEAL;
         request.type_filling = FillingModeForSymbol(command.brokerSymbol, false);
         request.type = command.direction == "BUY" ? ORDER_TYPE_BUY : ORDER_TYPE_SELL;
         request.price = command.direction == "BUY"
            ? SymbolInfoDouble(command.brokerSymbol, SYMBOL_ASK)
            : SymbolInfoDouble(command.brokerSymbol, SYMBOL_BID);
      }

      bool sent = OrderSend(request, result);
      anySent = true;
      if(!sent || !IsTradeSuccess(result.retcode))
         allSucceeded = false;

      Report(
         command.queueItemId,
         IsTradeSuccess(result.retcode) ? "EXECUTED" : "FAILED",
         result.retcode,
         result.retcode_external,
         result.comment,
         result.order,
         FindPositionTicket(command),
         result.deal,
         request.price,
         result.price,
         request.volume,
         sent ? "" : IntegerToString(GetLastError())
      );
   }

   if(!anySent)
      ReportFailure(command.queueItemId, "No TP legs were available for split-order execution", command.commandType);

   return anySent && allSucceeded;
}

void ExecuteCancelPending(SignalCommand &command)
{
   ulong tickets[];
   int found = CollectPendingOrderTickets(command, tickets);
   if(found <= 0)
   {
      ReportFailure(command.queueItemId, "No matching pending order found", command.brokerSymbol);
      return;
   }
   for(int index = 0; index < found; index++)
      RemovePendingOrder(command, tickets[index]);
}

void RemovePendingOrder(SignalCommand &command, ulong ticket)
{
   MqlTradeRequest request = {};
   MqlTradeResult result = {};
   request.action = TRADE_ACTION_REMOVE;
   request.order = ticket;
   request.symbol = command.brokerSymbol;
   bool sent = OrderSend(request, result);
   Report(command.queueItemId, IsTradeSuccess(result.retcode) ? "EXECUTED" : "FAILED", result.retcode, result.retcode_external, result.comment, result.order, 0, result.deal, 0, result.price, 0.0, sent ? "" : IntegerToString(GetLastError()));
}

void ExecuteMoveSlToBreakeven(SignalCommand &command)
{
   ulong tickets[];
   int found = CollectPositionTickets(command, tickets);
   if(found <= 0)
   {
      ReportFailure(command.queueItemId, "No matching position found", command.brokerSymbol);
      return;
   }

   for(int index = 0; index < found; index++)
   {
      if(!PositionSelectByTicket(tickets[index]))
         continue;
      double openPrice = PositionGetDouble(POSITION_PRICE_OPEN);
      ModifyPositionSl(command, tickets[index], openPrice);
   }
}

void ExecuteModifySl(SignalCommand &command)
{
   if(command.newStopLoss <= 0.0)
   {
      ReportFailure(command.queueItemId, "No valid stop loss provided", command.commandType);
      return;
   }
   ulong tickets[];
   int found = CollectPositionTickets(command, tickets);
   if(found <= 0)
   {
      ReportFailure(command.queueItemId, "No matching position found", command.brokerSymbol);
      return;
   }
   for(int index = 0; index < found; index++)
      ModifyPositionSl(command, tickets[index], command.newStopLoss);
}

void ExecuteModifyTp(SignalCommand &command)
{
   double takeProfit = FirstTakeProfit(command);
   if(takeProfit <= 0.0)
   {
      ReportFailure(command.queueItemId, "No take profit provided", command.commandType);
      return;
   }

   ulong tickets[];
   int found = CollectPositionTickets(command, tickets);
   if(found <= 0)
   {
      ReportFailure(command.queueItemId, "No matching position found", command.brokerSymbol);
      return;
   }
   for(int index = 0; index < found; index++)
      ModifyPositionTp(command, tickets[index], takeProfit);
}

void ExecuteTrailingStop(SignalCommand &command)
{
   double distance = TrailingStopDistance(command);
   if(distance <= 0.0)
   {
      ReportFailure(command.queueItemId, "Invalid trailing stop distance", command.trailingStopUnit);
      return;
   }

   ulong tickets[];
   int found = CollectPositionTickets(command, tickets);
   if(found <= 0)
   {
      ReportFailure(command.queueItemId, "No matching position found", command.brokerSymbol);
      return;
   }

   PrintFormat("Telegram TC TRAILING_STOP queue=%s logicalTradeId=%s symbol=%s distance=%.8f tickets=%d targetPosition=%I64u",
      command.queueItemId,
      command.logicalTradeId,
      command.brokerSymbol,
      distance,
      found,
      command.targetPositionTicket);

   for(int index = 0; index < found; index++)
   {
      TrackTrailingStop(command, tickets[index], distance);
      ApplyTrailingStopToTicket(command, tickets[index], distance);
   }
}

void TrackTrailingStop(SignalCommand &command, ulong ticket, double distance)
{
   for(int index = 0; index < trailingStopStateCount; index++)
   {
      if(trailingStopStates[index].positionTicket == ticket)
      {
         trailingStopStates[index].active = true;
         trailingStopStates[index].queueItemId = command.queueItemId;
         trailingStopStates[index].logicalTradeId = command.logicalTradeId;
         trailingStopStates[index].symbol = command.brokerSymbol;
         trailingStopStates[index].direction = command.direction;
         trailingStopStates[index].distance = distance;
         return;
      }
   }

   if(trailingStopStateCount >= ArraySize(trailingStopStates))
      return;

   int slot = trailingStopStateCount;
   trailingStopStateCount++;
   trailingStopStates[slot].active = true;
   trailingStopStates[slot].queueItemId = command.queueItemId;
   trailingStopStates[slot].logicalTradeId = command.logicalTradeId;
   trailingStopStates[slot].symbol = command.brokerSymbol;
   trailingStopStates[slot].direction = command.direction;
   trailingStopStates[slot].positionTicket = ticket;
   trailingStopStates[slot].distance = distance;
}

void ManageTrailingStops()
{
   for(int index = 0; index < trailingStopStateCount; index++)
   {
      if(!trailingStopStates[index].active)
         continue;
      SignalCommand command = {};
      command.queueItemId = trailingStopStates[index].queueItemId;
      command.logicalTradeId = trailingStopStates[index].logicalTradeId;
      command.brokerSymbol = trailingStopStates[index].symbol;
      command.direction = trailingStopStates[index].direction;
      command.targetPositionTicket = trailingStopStates[index].positionTicket;
      if(!PositionSelectByTicket(trailingStopStates[index].positionTicket))
      {
         trailingStopStates[index].active = false;
         continue;
      }
      ApplyTrailingStopToTicket(command, trailingStopStates[index].positionTicket, trailingStopStates[index].distance);
   }
}

bool ApplyTrailingStopToTicket(SignalCommand &command, ulong ticket, double distance)
{
   if(!PositionSelectByTicket(ticket))
      return false;

   string symbol = PositionGetString(POSITION_SYMBOL);
   long positionType = PositionGetInteger(POSITION_TYPE);
   double currentSl = PositionGetDouble(POSITION_SL);
   double nextSl = 0.0;
   if(positionType == POSITION_TYPE_BUY)
      nextSl = SymbolInfoDouble(symbol, SYMBOL_BID) - distance;
   else
      nextSl = SymbolInfoDouble(symbol, SYMBOL_ASK) + distance;

   if(!TrailingStopImproves(positionType, currentSl, nextSl))
      return false;

   ModifyPositionSl(command, ticket, nextSl);
   return true;
}

bool TrailingStopImproves(long positionType, double currentSl, double nextSl)
{
   if(nextSl <= 0.0)
      return false;
   if(currentSl <= 0.0)
      return true;
   if(positionType == POSITION_TYPE_BUY)
      return nextSl > currentSl;
   return nextSl < currentSl;
}

void ModifyPositionSl(SignalCommand &command, ulong ticket, double stopLoss)
{
   if(stopLoss <= 0.0)
   {
      ReportFailure(command.queueItemId, "No valid stop loss provided", command.commandType);
      return;
   }
   if(!PositionSelectByTicket(ticket))
   {
      ReportFailure(command.queueItemId, "No matching position found", command.brokerSymbol);
      return;
   }

   MqlTradeRequest request = {};
   MqlTradeResult result = {};
   request.action = TRADE_ACTION_SLTP;
   request.position = ticket;
   request.symbol = PositionGetString(POSITION_SYMBOL);
   request.sl = NormalizeStopPrice(request.symbol, stopLoss);
   request.tp = PositionGetDouble(POSITION_TP);
   request.magic = MagicNumber;

   PrintFormat("Telegram TC MODIFY_SL ticket=%I64u queue=%s logicalTradeId=%s symbol=%s newSL=%.5f currentTP=%.5f",
      ticket,
      command.queueItemId,
      command.logicalTradeId,
      request.symbol,
      request.sl,
      request.tp);

   bool sent = OrderSend(request, result);
    Report(command.queueItemId, IsTradeSuccess(result.retcode) ? "EXECUTED" : "FAILED", result.retcode, result.retcode_external, result.comment, result.order, ticket, result.deal, request.sl, result.price, PositionGetDouble(POSITION_VOLUME), sent ? "" : IntegerToString(GetLastError()));
}

void ModifyPositionTp(SignalCommand &command, ulong ticket, double takeProfit)
{
   if(!PositionSelectByTicket(ticket))
   {
      ReportFailure(command.queueItemId, "No matching position found", command.brokerSymbol);
      return;
   }

   MqlTradeRequest request = {};
   MqlTradeResult result = {};
   request.action = TRADE_ACTION_SLTP;
   request.position = ticket;
   request.symbol = PositionGetString(POSITION_SYMBOL);
   request.sl = PositionGetDouble(POSITION_SL);
   request.tp = NormalizeStopPrice(request.symbol, takeProfit);
   request.magic = MagicNumber;

   bool sent = OrderSend(request, result);
    Report(command.queueItemId, IsTradeSuccess(result.retcode) ? "EXECUTED" : "FAILED", result.retcode, result.retcode_external, result.comment, result.order, ticket, result.deal, request.tp, result.price, PositionGetDouble(POSITION_VOLUME), sent ? "" : IntegerToString(GetLastError()));
}

void ExecuteClose(SignalCommand &command)
{
   ulong tickets[];
   int found = CollectPositionTickets(command, tickets);
   if(found <= 0)
   {
      ReportFailure(command.queueItemId, "No matching position found", command.brokerSymbol);
      return;
   }

   for(int index = 0; index < found; index++)
      ClosePositionTicket(command, tickets[index]);
}

void ClosePositionTicket(SignalCommand &command, ulong ticket)
{
   if(!PositionSelectByTicket(ticket))
   {
      ReportFailure(command.queueItemId, "No matching position found", command.brokerSymbol);
      return;
   }

   string symbol = PositionGetString(POSITION_SYMBOL);
   long positionType = PositionGetInteger(POSITION_TYPE);
   double currentVolume = PositionGetDouble(POSITION_VOLUME);
   double closeVolume = command.commandType == "CLOSE_PARTIAL" ? 0.0 : currentVolume;
   if(command.commandType == "CLOSE_PARTIAL" && command.partialCloseKind == "PERCENT")
      closeVolume = NormalizeVolume(symbol, currentVolume * command.partialCloseValue / 100.0);
   else if(command.commandType == "CLOSE_PARTIAL" && command.partialCloseKind == "TP_LEG")
   {
      if(command.partialCloseVolume > 0.0)
         closeVolume = NormalizeVolume(symbol, command.partialCloseVolume);
      else if(command.partialCloseAllocation > 0.0)
         closeVolume = NormalizeVolume(symbol, currentVolume * command.partialCloseAllocation / 100.0);
   }
   else if(command.commandType == "CLOSE_PARTIAL" && command.partialCloseKind == "LOTS")
      closeVolume = NormalizeVolume(symbol, command.partialCloseValue);

   if(closeVolume <= 0.0)
   {
      ReportFailure(command.queueItemId, "No valid partial-close volume provided", command.commandType);
      return;
   }

   MqlTradeRequest request = {};
   MqlTradeResult result = {};
   request.action = TRADE_ACTION_DEAL;
   request.position = ticket;
   request.symbol = symbol;
   request.volume = MathMin(closeVolume, currentVolume);
   request.deviation = DeviationPoints;
   request.magic = MagicNumber;
   request.type_filling = FillingModeForSymbol(symbol, false);
   request.type = positionType == POSITION_TYPE_BUY ? ORDER_TYPE_SELL : ORDER_TYPE_BUY;
   request.price = positionType == POSITION_TYPE_BUY
      ? SymbolInfoDouble(symbol, SYMBOL_BID)
      : SymbolInfoDouble(symbol, SYMBOL_ASK);
   request.comment = CompactTradeComment(command.logicalTradeId) + ":close";

   PrintFormat("Telegram TC CLOSE command=%s ticket=%I64u queue=%s logicalTradeId=%s symbol=%s closeVolume=%.2f currentVolume=%.2f partialKind=%s targetPosition=%I64u",
      command.commandType,
      ticket,
      command.queueItemId,
      command.logicalTradeId,
      symbol,
      request.volume,
      currentVolume,
      command.partialCloseKind,
      command.targetPositionTicket);

   bool sent = OrderSend(request, result);
    Report(command.queueItemId, IsTradeSuccess(result.retcode) ? "EXECUTED" : "FAILED", result.retcode, result.retcode_external, result.comment, result.order, ticket, result.deal, request.price, result.price, request.volume, sent ? "" : IntegerToString(GetLastError()));
}

ulong FindPositionTicket(SignalCommand &command)
{
   if(command.targetPositionTicket > 0 && PositionSelectByTicket(command.targetPositionTicket))
      return command.targetPositionTicket;
   for(int index = PositionsTotal() - 1; index >= 0; index--)
   {
      ulong ticket = PositionGetTicket(index);
      if(ticket == 0 || !PositionSelectByTicket(ticket))
         continue;
      if(!PositionMatchesCommand(command))
         continue;
      return ticket;
   }
   return 0;
}

int CollectPositionTickets(SignalCommand &command, ulong &tickets[])
{
   ArrayResize(tickets, 0);
   if(command.targetPositionTicket > 0 && PositionSelectByTicket(command.targetPositionTicket))
   {
      ArrayResize(tickets, 1);
      tickets[0] = command.targetPositionTicket;
      return 1;
   }

   for(int index = PositionsTotal() - 1; index >= 0; index--)
   {
      ulong ticket = PositionGetTicket(index);
      if(ticket == 0 || !PositionSelectByTicket(ticket))
         continue;
      if(!PositionMatchesCommand(command))
         continue;
      int next = ArraySize(tickets);
      ArrayResize(tickets, next + 1);
      tickets[next] = ticket;
   }
   return ArraySize(tickets);
}

int CollectPendingOrderTickets(SignalCommand &command, ulong &tickets[])
{
   ArrayResize(tickets, 0);
   if(command.targetOrderTicket > 0)
   {
      ArrayResize(tickets, 1);
      tickets[0] = command.targetOrderTicket;
      return 1;
   }

   for(int index = OrdersTotal() - 1; index >= 0; index--)
   {
      ulong ticket = OrderGetTicket(index);
      if(ticket == 0)
         continue;
      if(!OrderMatchesCommand(command))
         continue;
      int next = ArraySize(tickets);
      ArrayResize(tickets, next + 1);
      tickets[next] = ticket;
   }
   return ArraySize(tickets);
}

bool PositionMatchesCommand(SignalCommand &command)
{
   if(PositionGetString(POSITION_SYMBOL) != command.brokerSymbol)
      return false;
   if((ulong)PositionGetInteger(POSITION_MAGIC) != MagicNumber)
      return false;
   return MatchesLogicalTradeComment(PositionGetString(POSITION_COMMENT), command.logicalTradeId);
}

bool OrderMatchesCommand(SignalCommand &command)
{
   if(OrderGetString(ORDER_SYMBOL) != command.brokerSymbol)
      return false;
   if((ulong)OrderGetInteger(ORDER_MAGIC) != MagicNumber)
      return false;
   return MatchesLogicalTradeComment(OrderGetString(ORDER_COMMENT), command.logicalTradeId);
}

bool MatchesLogicalTradeComment(string brokerComment, string logicalTradeId)
{
   if(logicalTradeId == "")
      return true;
   if(StringFind(brokerComment, logicalTradeId) >= 0)
      return true;
   return StringFind(brokerComment, CompactTradeId(logicalTradeId)) >= 0;
}

string CompactTradeId(string logicalTradeId)
{
   if(StringFind(logicalTradeId, "trade_") == 0)
      return StringSubstr(logicalTradeId, 6);
   if(StringFind(logicalTradeId, "trade-") == 0)
      return StringSubstr(logicalTradeId, 6);
   return logicalTradeId;
}

string CompactTradeComment(string logicalTradeId)
{
   return "ttc:" + CompactTradeId(logicalTradeId);
}

string CompactTradeTpComment(string logicalTradeId, int leg)
{
   return CompactTradeComment(logicalTradeId) + ":tp" + IntegerToString(leg);
}

// Snapshot includes ALL positions, not just magic-matched. External (manual,
// other-EA, mobile-opened) positions are flagged isExternal=true so the App can:
//   1. Show them in a read-only "External positions" panel — operator sees what
//      else is competing for margin / equity in this account.
//   2. Distinguish app-attributed drawdown (only our magic) from total-equity
//      drawdown (everything) in the Equity Guardian.
//   3. Avoid mislabelling a vanished external position as "the EA closed
//      something we forgot about" in the snapshot-diff reconciler.
// The App never modifies external positions — visibility only.
string PositionsJson()
{
   string json = "[";
   bool first = true;
   for(int index = 0; index < PositionsTotal(); index++)
   {
      ulong ticket = PositionGetTicket(index);
      if(ticket == 0 || !PositionSelectByTicket(ticket))
         continue;
      bool isExternal = (ulong)PositionGetInteger(POSITION_MAGIC) != MagicNumber;

      if(!first)
         json += ",";
      first = false;

      json += StringFormat(
         "{\"ticket\":\"%I64u\",\"symbol\":\"%s\",\"type\":%d,\"volume\":%.2f,\"openPrice\":%.8f,\"sl\":%.8f,\"tp\":%.8f,\"profit\":%.2f,\"magic\":%I64u,\"isExternal\":%s,\"comment\":\"%s\"}",
         ticket,
         JsonEscape(PositionGetString(POSITION_SYMBOL)),
         (int)PositionGetInteger(POSITION_TYPE),
         PositionGetDouble(POSITION_VOLUME),
         PositionGetDouble(POSITION_PRICE_OPEN),
         PositionGetDouble(POSITION_SL),
         PositionGetDouble(POSITION_TP),
         PositionGetDouble(POSITION_PROFIT),
         (ulong)PositionGetInteger(POSITION_MAGIC),
         isExternal ? "true" : "false",
         JsonEscape(PositionGetString(POSITION_COMMENT))
      );
   }
   json += "]";
   return json;
}

string OrdersJson()
{
   string json = "[";
   bool first = true;
   for(int index = 0; index < OrdersTotal(); index++)
   {
      ulong ticket = OrderGetTicket(index);
      if(ticket == 0)
         continue;
      bool isExternal = (ulong)OrderGetInteger(ORDER_MAGIC) != MagicNumber;

      if(!first)
         json += ",";
      first = false;

      json += StringFormat(
         "{\"ticket\":\"%I64u\",\"symbol\":\"%s\",\"type\":%d,\"volume\":%.2f,\"openPrice\":%.8f,\"sl\":%.8f,\"tp\":%.8f,\"magic\":%I64u,\"isExternal\":%s,\"comment\":\"%s\"}",
         ticket,
         JsonEscape(OrderGetString(ORDER_SYMBOL)),
         (int)OrderGetInteger(ORDER_TYPE),
         OrderGetDouble(ORDER_VOLUME_CURRENT),
         OrderGetDouble(ORDER_PRICE_OPEN),
         OrderGetDouble(ORDER_SL),
         OrderGetDouble(ORDER_TP),
         (ulong)OrderGetInteger(ORDER_MAGIC),
         isExternal ? "true" : "false",
         JsonEscape(OrderGetString(ORDER_COMMENT))
      );
   }
   json += "]";
   return json;
}

string HistoryDealsJson()
{
   string json = "[";
   bool first = true;
   int total = HistoryDealsTotal();
   for(int index = 0; index < total; index++)
   {
      ulong ticket = HistoryDealGetTicket(index);
      if(ticket == 0)
         continue;

      if(!first)
         json += ",";
      first = false;
      json += HistoryDealJson(ticket);
   }
   json += "]";
   return json;
}

bool IsTelegramTcHistoryDeal(ulong ticket)
{
   string comment = HistoryDealGetString(ticket, DEAL_COMMENT);
   long magic = HistoryDealGetInteger(ticket, DEAL_MAGIC);
   return (ulong)magic == MagicNumber ||
          StringFind(comment, "telegram-tc") >= 0 ||
          StringFind(comment, "ttc:") >= 0;
}

string HistoryDealJson(ulong ticket)
{
   string comment = HistoryDealGetString(ticket, DEAL_COMMENT);
   // DEAL_REASON tells us *why* the deal happened: SL hit, TP hit, manual
   // client click, EA-driven, mobile/web close, stop-out, etc. Without it
   // the backend can't distinguish "TP hit" from "operator closed manually"
   // and every close looks the same in the History trail.
   int dealReason = (int)HistoryDealGetInteger(ticket, DEAL_REASON);
   return StringFormat(
      "{\"dealTicket\":\"%I64u\",\"orderTicket\":\"%I64u\",\"positionTicket\":\"%I64u\",\"entry\":\"%d\",\"type\":\"%d\",\"reason\":%d,\"magic\":%I64d,\"symbol\":\"%s\",\"price\":%.8f,\"volume\":%.2f,\"profit\":%.2f,\"commission\":%.2f,\"swap\":%.2f,\"fee\":%.2f,\"comment\":\"%s\",\"time\":\"%s\",\"timeMsc\":%I64d}",
      ticket,
      (ulong)HistoryDealGetInteger(ticket, DEAL_ORDER),
      (ulong)HistoryDealGetInteger(ticket, DEAL_POSITION_ID),
      (int)HistoryDealGetInteger(ticket, DEAL_ENTRY),
      (int)HistoryDealGetInteger(ticket, DEAL_TYPE),
      dealReason,
      HistoryDealGetInteger(ticket, DEAL_MAGIC),
      JsonEscape(HistoryDealGetString(ticket, DEAL_SYMBOL)),
      HistoryDealGetDouble(ticket, DEAL_PRICE),
      HistoryDealGetDouble(ticket, DEAL_VOLUME),
      HistoryDealGetDouble(ticket, DEAL_PROFIT),
      HistoryDealGetDouble(ticket, DEAL_COMMISSION),
      HistoryDealGetDouble(ticket, DEAL_SWAP),
      HistoryDealGetDouble(ticket, DEAL_FEE),
      JsonEscape(comment),
      TimeToString((datetime)HistoryDealGetInteger(ticket, DEAL_TIME), TIME_DATE|TIME_SECONDS),
      HistoryDealGetInteger(ticket, DEAL_TIME_MSC)
   );
}

string SymbolsMarketJson()
{
   string json = "[";
   bool first = true;
   int total = SymbolsTotal(true);
   for(int index = 0; index < total; index++)
   {
      string symbol = SymbolName(index, true);
      if(symbol == "")
         continue;

      if(!first)
         json += ",";
      first = false;
      json += SymbolMarketJson(symbol);
   }

   if(first && _Symbol != "")
      json += SymbolMarketJson(_Symbol);

   json += "]";
   return json;
}

string SymbolMarketJson(string symbol)
{
   MqlTick tick;
   bool hasTick = SymbolInfoTick(symbol, tick);
   double bid = hasTick ? tick.bid : SymbolInfoDouble(symbol, SYMBOL_BID);
   double ask = hasTick ? tick.ask : SymbolInfoDouble(symbol, SYMBOL_ASK);
   long timeMsc = hasTick ? tick.time_msc : 0;
   return StringFormat(
      "{\"symbol\":\"%s\",\"bid\":%.8f,\"ask\":%.8f,\"timeMsc\":%I64d,\"volumeMin\":%.2f,\"volumeMax\":%.2f,\"volumeStep\":%.2f,\"point\":%.8f,\"digits\":%d}",
      JsonEscape(symbol),
      bid,
      ask,
      timeMsc,
      SymbolInfoDouble(symbol, SYMBOL_VOLUME_MIN),
      SymbolInfoDouble(symbol, SYMBOL_VOLUME_MAX),
      SymbolInfoDouble(symbol, SYMBOL_VOLUME_STEP),
      SymbolInfoDouble(symbol, SYMBOL_POINT),
      (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS)
   );
}

double FirstTakeProfit(SignalCommand &command)
{
   for(int index = 0; index < 4; index++)
   {
      if(command.tp[index] > 0.0)
         return command.tp[index];
   }
   return 0.0;
}

bool ParseCommand(string body, SignalCommand &command)
{
   ArrayInitialize(command.tp, 0.0);
   ArrayInitialize(command.tpAllocation, 0.0);
   ArrayInitialize(command.tpVolume, 0.0);
   command.queueItemId = ValueFor(body, "queueItemId");
   command.logicalTradeId = ValueFor(body, "logicalTradeId");
   command.commandType = ValueFor(body, "commandType");
   command.brokerSymbol = ValueFor(body, "brokerSymbol");
   command.canonicalSymbol = ValueFor(body, "canonicalSymbol");
   command.direction = ValueFor(body, "direction");
   command.orderType = ValueFor(body, "orderType");
   command.executionMode = ValueFor(body, "executionMode");
   command.volume = StringToDouble(ValueFor(body, "volume"));
   command.riskPercent = StringToDouble(ValueFor(body, "riskPercent"));
   command.entryFrom = StringToDouble(ValueFor(body, "entryFrom"));
   command.entryTo = StringToDouble(ValueFor(body, "entryTo"));
   command.stopLoss = StringToDouble(ValueFor(body, "stopLoss"));
   command.defaultStopLossValue = StringToDouble(ValueFor(body, "defaultStopLossValue"));
   command.defaultStopLossUnit = ValueFor(body, "defaultStopLossUnit");
   command.newStopLoss = StringToDouble(ValueFor(body, "newStopLoss"));
   command.defaultTakeProfitValue = StringToDouble(ValueFor(body, "defaultTakeProfitValue"));
   command.defaultTakeProfitUnit = ValueFor(body, "defaultTakeProfitUnit");
   command.trailingStopValue = StringToDouble(ValueFor(body, "trailingStopValue"));
   command.trailingStopUnit = ValueFor(body, "trailingStopUnit");
   command.partialCloseKind = ValueFor(body, "partialCloseKind");
   command.partialCloseValue = StringToDouble(ValueFor(body, "partialCloseValue"));
   command.partialCloseVolume = StringToDouble(ValueFor(body, "partialCloseVolume"));
   command.partialCloseAllocation = StringToDouble(ValueFor(body, "partialCloseAllocation"));
   command.targetOrderTicket = (ulong)StringToInteger(ValueFor(body, "targetOrderTicket"));
   command.targetPositionTicket = (ulong)StringToInteger(ValueFor(body, "targetPositionTicket"));
   command.targetDealTicket = (ulong)StringToInteger(ValueFor(body, "targetDealTicket"));

   for(int index = 0; index < 4; index++)
   {
      string leg = IntegerToString(index + 1);
      command.tp[index] = StringToDouble(ValueFor(body, "tp" + leg));
      command.tpAllocation[index] = StringToDouble(ValueFor(body, "tp" + leg + "Allocation"));
      command.tpVolume[index] = StringToDouble(ValueFor(body, "tp" + leg + "Volume"));
   }
   return command.queueItemId != "" && command.commandType != "";
}

void ApplyPollConfig(string body)
{
   int nextPollSeconds = (int)StringToInteger(ValueFor(body, "pollSeconds"));
   if(nextPollSeconds <= 0 || nextPollSeconds == CurrentPollSeconds)
      return;

   CurrentPollSeconds = MathMax(1, nextPollSeconds);
   EventSetTimer(CurrentPollSeconds);
}

string ValueFor(string body, string key)
{
   string lines[];
   int count = StringSplit(body, '\n', lines);
   string prefix = key + "=";
   for(int index = 0; index < count; index++)
   {
      if(StringFind(lines[index], prefix) == 0)
         return StringSubstr(lines[index], StringLen(prefix));
   }
   return "";
}

ENUM_ORDER_TYPE PendingOrderType(string direction, string orderType)
{
   if(direction == "BUY" && orderType == "LIMIT")
      return ORDER_TYPE_BUY_LIMIT;
   if(direction == "SELL" && orderType == "LIMIT")
      return ORDER_TYPE_SELL_LIMIT;
   if(direction == "BUY" && orderType == "STOP")
      return ORDER_TYPE_BUY_STOP;
   return ORDER_TYPE_SELL_STOP;
}

bool ValidatePendingOrderPrice(SignalCommand &command)
{
   if(command.orderType != "LIMIT" && command.orderType != "STOP")
      return true;

   double price = command.entryFrom;
   double ask = SymbolInfoDouble(command.brokerSymbol, SYMBOL_ASK);
   double bid = SymbolInfoDouble(command.brokerSymbol, SYMBOL_BID);
   double point = SymbolInfoDouble(command.brokerSymbol, SYMBOL_POINT);
   long stopLevelPoints = SymbolInfoInteger(command.brokerSymbol, SYMBOL_TRADE_STOPS_LEVEL);
   double minDistance = (double)stopLevelPoints * point;

   if(price <= 0.0 || ask <= 0.0 || bid <= 0.0)
      return false;

   if(command.direction == "BUY" && command.orderType == "LIMIT")
      return price <= ask - minDistance;
   if(command.direction == "SELL" && command.orderType == "LIMIT")
      return price >= bid + minDistance;
   if(command.direction == "BUY" && command.orderType == "STOP")
      return price >= ask + minDistance;
   if(command.direction == "SELL" && command.orderType == "STOP")
      return price <= bid - minDistance;

   return false;
}

double CommandBaseVolume(SignalCommand &command)
{
   // BrokerMinLotMultiplier overrides EVERYTHING when set. Operators use this
   // when they want a single sizing knob that works across asset classes
   // (e.g., "always 2× whatever the broker's smallest order is").
   if(BrokerMinLotMultiplier > 0.0)
   {
      double minVol = SymbolInfoDouble(command.brokerSymbol, SYMBOL_VOLUME_MIN);
      if(minVol > 0.0)
         return minVol * BrokerMinLotMultiplier;
   }
   if(command.volume > 0.0)
      return command.volume;
   if(command.riskPercent > 0.0)
   {
      double riskVolume = RiskPercentVolume(command);
      if(riskVolume > 0.0)
         return riskVolume;
   }
   return DefaultLots;
}

// Pushes a requested SL/TP price out to the broker's safe minimum distance
// from market when it's too close. Without this, BTCUSD trades with a
// 50-pip ($5) SL get rejected with retcode 10016 because OctaFX's
// SYMBOL_TRADE_STOPS_LEVEL for crypto is typically ~100 points ($10).
// Returns the (possibly adjusted) safe stop price.
double SafeStopPrice(string symbol, double referencePrice, double requestedStop,
                     string direction, bool isStopLoss)
{
   if(requestedStop <= 0.0 || MinStopBufferMultiplier <= 0.0)
      return requestedStop;
   if(referencePrice <= 0.0)
      return requestedStop;

   long stopLevel = SymbolInfoInteger(symbol, SYMBOL_TRADE_STOPS_LEVEL);
   if(stopLevel <= 0)
      return requestedStop;

   double point = SymbolInfoDouble(symbol, SYMBOL_POINT);
   if(point <= 0.0)
      return requestedStop;

   double minDistance = (double)stopLevel * point * MinStopBufferMultiplier;
   double currentDistance = MathAbs(referencePrice - requestedStop);
   if(currentDistance >= minDistance)
      return requestedStop;

   // Direction of the SL/TP relative to market:
   //   BUY  → SL below price, TP above price
   //   SELL → SL above price, TP below price
   bool stopBelowPrice = (direction == "BUY" && isStopLoss) ||
                         (direction == "SELL" && !isStopLoss);
   double safe = stopBelowPrice ? referencePrice - minDistance
                                 : referencePrice + minDistance;
   PrintFormat("Telegram TC SafeStopPrice: %s %s adjusted %.5f → %.5f (broker min %ld pts × %.2f buffer = %.5f distance)",
      symbol, isStopLoss ? "SL" : "TP", requestedStop, safe,
      stopLevel, MinStopBufferMultiplier, minDistance);
   return safe;
}

double NormalizeStopPrice(string symbol, double price)
{
   if(price <= 0.0)
      return price;
   int digits = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);
   return NormalizeDouble(price, digits);
}

double CommandVolume(SignalCommand &command)
{
   return NormalizeVolume(command.brokerSymbol, CommandBaseVolume(command));
}

double LegVolume(SignalCommand &command, int leg, double baseVolume)
{
   double requested = command.tpVolume[leg] > 0.0
      ? command.tpVolume[leg]
      : baseVolume * MathMax(command.tpAllocation[leg], 1.0) / 100.0;
   return NormalizeVolume(command.brokerSymbol, requested);
}

double RiskPercentVolume(SignalCommand &command)
{
   double referencePrice = command.entryFrom > 0.0 ? command.entryFrom : MarketReferencePrice(command);
   double sl = command.stopLoss > 0.0 ? command.stopLoss : DefaultStopLossPrice(command, referencePrice);
   double stopDistance = MathAbs(referencePrice - sl);
   if(stopDistance <= 0.0)
      return 0.0;
   double tickSize = SymbolInfoDouble(command.brokerSymbol, SYMBOL_TRADE_TICK_SIZE);
   double tickValue = SymbolInfoDouble(command.brokerSymbol, SYMBOL_TRADE_TICK_VALUE);
   if(tickSize <= 0.0 || tickValue <= 0.0)
      return 0.0;
   double riskMoney = AccountInfoDouble(ACCOUNT_BALANCE) * command.riskPercent / 100.0;
   double lossPerLot = stopDistance / tickSize * tickValue;
   if(lossPerLot <= 0.0)
      return 0.0;
   return riskMoney / lossPerLot;
}

double TrailingStopDistance(SignalCommand &command)
{
   double point = SymbolInfoDouble(command.brokerSymbol, SYMBOL_POINT);
   if(point <= 0.0 || command.trailingStopValue <= 0.0)
      return 0.0;
   if(command.trailingStopUnit == "PIPS")
      return command.trailingStopValue * point * 10.0;
   return command.trailingStopValue * point;
}

double DefaultDistance(string symbol, double value, string unit)
{
   double point = SymbolInfoDouble(symbol, SYMBOL_POINT);
   if(point <= 0.0 || value <= 0.0)
      return 0.0;
   if(unit == "PIPS")
      return value * point * 10.0;
   if(unit == "POINTS")
      return value * point;
   return value;
}

double DefaultStopLossPrice(SignalCommand &command, double referencePrice)
{
   double distance = DefaultDistance(command.brokerSymbol, command.defaultStopLossValue, command.defaultStopLossUnit);
   if(referencePrice <= 0.0 || distance <= 0.0)
      return 0.0;
   if(command.direction == "BUY")
      return referencePrice - distance;
   return referencePrice + distance;
}

double DefaultTakeProfitPrice(SignalCommand &command, double referencePrice)
{
   double distance = DefaultDistance(command.brokerSymbol, command.defaultTakeProfitValue, command.defaultTakeProfitUnit);
   if(referencePrice <= 0.0 || distance <= 0.0)
      return 0.0;
   if(command.direction == "BUY")
      return referencePrice + distance;
   return referencePrice - distance;
}

double MarketReferencePrice(SignalCommand &command)
{
   if(command.direction == "BUY")
      return SymbolInfoDouble(command.brokerSymbol, SYMBOL_ASK);
   return SymbolInfoDouble(command.brokerSymbol, SYMBOL_BID);
}

bool EnsureSymbol(string symbol)
{
   if(symbol == "")
      return false;
   if(!SymbolSelect(symbol, true))
      return false;
   if(SymbolInfoInteger(symbol, SYMBOL_SELECT) == 0)
      return false;

   // SymbolSelect makes the symbol visible to SymbolInfoDouble, but for symbols
   // that aren't on any open chart (e.g. BTCUSD when the EA runs on GBPUSD),
   // BID/ASK can be 0 for the first 100–500ms until the first tick arrives.
   // Without waiting, SL/TP defaults computed off price=0 silently return 0
   // and the order goes out naked. Wait up to 2s for a real tick.
   MqlTick tick;
   for(int attempt = 0; attempt < 40; attempt++)
   {
      if(SymbolInfoTick(symbol, tick) && tick.bid > 0.0 && tick.ask > 0.0)
         return true;
      Sleep(50);
   }
   PrintFormat("Telegram TC EnsureSymbol: %s selected but no fresh tick after 2s — aborting execution",
      symbol);
   return false;
}

double NormalizeVolume(string symbol, double requested)
{
   double minVolume = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MIN);
   double maxVolume = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MAX);
   double step = SymbolInfoDouble(symbol, SYMBOL_VOLUME_STEP);
   if(step <= 0)
      step = 0.01;
   double volume = MathMax(minVolume, MathMin(maxVolume, requested));
   return NormalizeDouble(MathFloor(volume / step) * step, 2);
}

bool IsTradeSuccess(uint retcode)
{
   return retcode == TRADE_RETCODE_DONE || retcode == TRADE_RETCODE_PLACED || retcode == TRADE_RETCODE_DONE_PARTIAL;
}

void ReportFailure(string queueItemId, string brokerComment, string errorText)
{
   Report(queueItemId, "FAILED", 0, 0, brokerComment, 0, 0, 0, 0.0, 0.0, 0.0, errorText);
}

void Report(
   string queueItemId,
   string status,
   uint retcode,
   int retcodeExternal,
   string brokerComment,
   ulong orderTicket,
   ulong positionTicket,
   ulong dealTicket,
   double requestedPrice,
   double filledPrice,
   double volume,
   string errorText
)
{
   string body = StringFormat(
      "{\"accountId\":\"mt5-%I64d\",\"queueItemId\":\"%s\",\"status\":\"%s\",\"retcode\":%u,\"retcodeExternal\":%d,\"brokerComment\":\"%s\",\"orderTicket\":\"%I64u\",\"positionTicket\":\"%I64u\",\"dealTicket\":\"%I64u\",\"requestedPrice\":%.8f,\"filledPrice\":%.8f,\"volume\":%.2f,\"errorText\":\"%s\"}",
      AccountInfoInteger(ACCOUNT_LOGIN),
      JsonEscape(queueItemId),
      status,
      retcode,
      retcodeExternal,
      JsonEscape(brokerComment),
      orderTicket,
      positionTicket,
      dealTicket,
      requestedPrice,
      filledPrice,
      volume,
      JsonEscape(errorText)
   );
   string response = "";
   HttpPost("/mt5/report", body, response);
}

string AccountPayload()
{
   string marginMode = AccountInfoInteger(ACCOUNT_MARGIN_MODE) == ACCOUNT_MARGIN_MODE_RETAIL_HEDGING
      ? "HEDGING"
      : "NETTING";
   return StringFormat(
      "{\"accountNumber\":\"%I64d\",\"server\":\"%s\",\"company\":\"%s\",\"currency\":\"%s\",\"balance\":%.2f,\"equity\":%.2f,\"profit\":%.2f,\"marginMode\":\"%s\",\"availableSymbols\":%s,\"linkCode\":\"%s\"}",
      AccountInfoInteger(ACCOUNT_LOGIN),
      JsonEscape(AccountInfoString(ACCOUNT_SERVER)),
      JsonEscape(AccountInfoString(ACCOUNT_COMPANY)),
      JsonEscape(AccountInfoString(ACCOUNT_CURRENCY)),
      AccountInfoDouble(ACCOUNT_BALANCE),
      AccountInfoDouble(ACCOUNT_EQUITY),
      AccountInfoDouble(ACCOUNT_PROFIT),
      marginMode,
      SymbolsJson(),
      JsonEscape(LinkCode)
   );
}

string SymbolsJson()
{
   string json = "[";
   bool first = true;
   int total = SymbolsTotal(false);
   for(int index = 0; index < total; index++)
   {
      string symbol = SymbolName(index, false);
      if(symbol == "")
         continue;

      if(!first)
         json += ",";
      first = false;
      json += "\"" + JsonEscape(symbol) + "\"";
   }

   if(first)
      json += "\"" + JsonEscape(_Symbol) + "\"";

   json += "]";
   return json;
}

bool HttpGet(string path, string &response)
{
   char data[];
   return HttpRequest("GET", path, "", data, response);
}

// Idempotent GET with exponential backoff. Sized to ride out a 5–15 s container
// restart (200 ms + 400 + 800 + 1600 = ~3 s gap, 5 attempts = ~3 s total).
bool HttpGetRetry(string path, string &response)
{
   char data[];
   return HttpRequestRetry("GET", path, "", data, response, 5);
}

bool HttpPost(string path, string body, string &response)
{
   char data[];
   StringToCharArray(body, data, 0, WHOLE_ARRAY, CP_UTF8);
   if(ArraySize(data) > 0 && data[ArraySize(data) - 1] == 0)
      ArrayResize(data, ArraySize(data) - 1);
   return HttpRequest("POST", path, "Content-Type: application/json\r\n", data, response);
}

// Retry-safe POST for idempotent endpoints — snapshot, history, heartbeat,
// register. NEVER use for /report (an execution report must be sent exactly
// once or we risk double-attributing a fill on the backend).
bool HttpPostRetry(string path, string body, string &response)
{
   char data[];
   StringToCharArray(body, data, 0, WHOLE_ARRAY, CP_UTF8);
   if(ArraySize(data) > 0 && data[ArraySize(data) - 1] == 0)
      ArrayResize(data, ArraySize(data) - 1);
   return HttpRequestRetry("POST", path, "Content-Type: application/json\r\n", data, response, 5);
}

bool HttpRequest(string method, string path, string headers, char &data[], string &response)
{
   char result[];
   string resultHeaders = "";
   string url = BackendBaseUrl + path;
   ResetLastError();
   int status = WebRequest(method, url, headers, 8000, data, result, resultHeaders);
   int lastErr = GetLastError();
   if(status == -1)
   {
      PrintFormat("Telegram TC WebRequest CONNECT FAILED err=%d url=%s (add URL to allowed WebRequest list if err=4014/4060)",
         lastErr, url);
      return false;
   }
   response = CharArrayToString(result, 0, -1, CP_UTF8);
   if(status < 200 || status >= 300)
   {
      PrintFormat("Telegram TC HTTP %d err=%d method=%s path=%s body=%s",
         status, lastErr, method, path,
         (StringLen(response) > 0 ? response : "(empty)"));
      return false;
   }
   return true;
}

// Retry wrapper for idempotent calls. Exponential backoff (200, 400, 800,
// 1600 ms) lets the EA ride out a typical 5-15 s `docker compose up -d` swap
// without flooding the Experts tab with `HTTP 1001/1003 err=5203` noise from
// the brief connect-failures-mid-request window.
//
// SAFE: /snapshot, /history (deal-ticket dedup), /heartbeat (idem),
//       /register (link-code dedup).
// UNSAFE: /poll-line leases work server-side; /report must be sent exactly once.
bool HttpRequestRetry(string method, string path, string headers, char &data[], string &response, int maxAttempts)
{
   for(int attempt = 1; attempt <= maxAttempts; attempt++)
   {
      if(HttpRequest(method, path, headers, data, response))
         return true;
      if(attempt < maxAttempts)
      {
         int backoffMs = 200 << (attempt - 1);  // 200, 400, 800, 1600 ms
         if(backoffMs > 2000) backoffMs = 2000;
         Sleep(backoffMs);
      }
   }
   return false;
}

string JsonEscape(string value)
{
   StringReplace(value, "\\", "\\\\");
   StringReplace(value, "\"", "\\\"");
   StringReplace(value, "\r", " ");
   StringReplace(value, "\n", " ");
   return value;
}
