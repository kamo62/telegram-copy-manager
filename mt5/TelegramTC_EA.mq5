//+------------------------------------------------------------------+
//| Telegram TC Expert Advisor                                       |
//| Polls the Telegram TC backend for normalized trade instructions. |
//+------------------------------------------------------------------+
#property copyright "Telegram TC"
#property version   "1.001"
#property strict

input string BackendBaseUrl = "https://your-api-host.example.com/api";
input int    PollSeconds    = 1;
input string LinkCode       = "";
input int    HistoryLookbackHours = 168;
input double DefaultLots    = 0.10;
input int    DeviationPoints = 20;
input ulong  MagicNumber    = 26050901;

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
   ulong targetOrderTicket;
   ulong targetPositionTicket;
   ulong targetDealTicket;
   double tp[4];
   double tpAllocation[4];
   double tpVolume[4];
};

struct VirtualTpState
{
   bool active;
   string queueItemId;
   string logicalTradeId;
   string symbol;
   string direction;
   double baseVolume;
   double tp[4];
   double tpAllocation[4];
   double tpVolume[4];
   bool closed[4];
};

VirtualTpState virtualTpStates[100];
int virtualTpStateCount = 0;
int CurrentPollSeconds = 0;

int OnInit()
{
   CurrentPollSeconds = MathMax(1, PollSeconds);
   if(StringFind(BackendBaseUrl, "your-api-host.example.com") >= 0 || BackendBaseUrl == "")
      Print("Telegram TC: set BackendBaseUrl to your deployed API /api URL before enabling live polling.");
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
   SendHeartbeat();
   SendSnapshot();
   SendHistoryDeals();
   ManageVirtualTakeProfits();
   PollAndExecute();
}

void RegisterAccount()
{
   string body = AccountPayload();
   string response = "";
   HttpPost("/mt5/register", body, response);
}

void SendHeartbeat()
{
   string body = StringFormat(
      "{\"accountId\":\"mt5-%I64d\",\"balance\":%.2f,\"equity\":%.2f,\"availableSymbols\":%s,\"linkCode\":\"%s\"}",
      AccountInfoInteger(ACCOUNT_LOGIN),
      AccountInfoDouble(ACCOUNT_BALANCE),
      AccountInfoDouble(ACCOUNT_EQUITY),
      SymbolsJson(),
      JsonEscape(LinkCode)
   );
   string response = "";
   HttpPost("/mt5/heartbeat", body, response);
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
   HttpPost("/mt5/snapshot", body, response);
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
   HttpPost("/mt5/history", body, response);
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

   SignalCommand command;
   if(!ParseCommand(response, command))
   {
      ReportFailure(command.queueItemId, "Could not parse poll payload", "parser");
      return;
   }

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
      ReportFailure(command.queueItemId, "Symbol is not available in Market Watch", command.brokerSymbol);
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
   request.comment = StringFormat("telegram-tc:%s", command.logicalTradeId);

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
      request.price = command.direction == "BUY"
         ? SymbolInfoDouble(command.brokerSymbol, SYMBOL_ASK)
         : SymbolInfoDouble(command.brokerSymbol, SYMBOL_BID);
   }

   if(command.stopLoss <= 0.0)
      command.stopLoss = DefaultStopLossPrice(command, request.price);
   if(command.tp[0] <= 0.0)
      command.tp[0] = DefaultTakeProfitPrice(command, request.price);

   request.sl = command.stopLoss;
   request.tp = command.executionMode == "SPLIT_ORDER" ? command.tp[0] : 0.0;

   bool sent = OrderSend(request, result);
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
   bool ok = sent && IsTradeSuccess(result.retcode);
   if(ok)
      TrackVirtualTakeProfits(command, result);
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
      request.comment = StringFormat("telegram-tc:%s:tp%d", command.logicalTradeId, leg + 1);
      request.sl = command.stopLoss;
      request.tp = command.tp[leg];

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
   if(command.targetOrderTicket > 0)
   {
      RemovePendingOrder(command, command.targetOrderTicket);
      return;
   }
   bool found = false;
   for(int index = OrdersTotal() - 1; index >= 0; index--)
   {
      ulong ticket = OrderGetTicket(index);
      if(ticket == 0)
         continue;
      if(!OrderMatchesCommand(command))
         continue;

      found = true;
      RemovePendingOrder(command, ticket);
      return;
   }

   if(!found)
      ReportFailure(command.queueItemId, "No matching pending order found", command.brokerSymbol);
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
   ulong ticket = FindPositionTicket(command);
   if(ticket == 0 || !PositionSelectByTicket(ticket))
   {
      ReportFailure(command.queueItemId, "No matching position found", command.brokerSymbol);
      return;
   }

   double openPrice = PositionGetDouble(POSITION_PRICE_OPEN);
   ModifyPositionSl(command, ticket, openPrice);
}

void ExecuteModifySl(SignalCommand &command)
{
   ulong ticket = FindPositionTicket(command);
   if(ticket == 0)
   {
      ReportFailure(command.queueItemId, "No matching position found", command.brokerSymbol);
      return;
   }
   ModifyPositionSl(command, ticket, command.newStopLoss);
}

void ExecuteModifyTp(SignalCommand &command)
{
   ulong ticket = FindPositionTicket(command);
   if(ticket == 0)
   {
      ReportFailure(command.queueItemId, "No matching position found", command.brokerSymbol);
      return;
   }

   double takeProfit = FirstTakeProfit(command);
   if(takeProfit <= 0.0)
   {
      ReportFailure(command.queueItemId, "No take profit provided", command.commandType);
      return;
   }

   ModifyPositionTp(command, ticket, takeProfit);
}

void ExecuteTrailingStop(SignalCommand &command)
{
   ulong ticket = FindPositionTicket(command);
   if(ticket == 0 || !PositionSelectByTicket(ticket))
   {
      ReportFailure(command.queueItemId, "No matching position found", command.brokerSymbol);
      return;
   }

   string symbol = PositionGetString(POSITION_SYMBOL);
   long positionType = PositionGetInteger(POSITION_TYPE);
   double currentSl = PositionGetDouble(POSITION_SL);
   double distance = TrailingStopDistance(command);
   if(distance <= 0.0)
   {
      ReportFailure(command.queueItemId, "Invalid trailing stop distance", command.trailingStopUnit);
      return;
   }

   double nextSl = 0.0;
   if(positionType == POSITION_TYPE_BUY)
   {
      nextSl = SymbolInfoDouble(symbol, SYMBOL_BID) - distance;
      if(currentSl > 0.0 && nextSl <= currentSl)
      {
         ReportFailure(command.queueItemId, "Trailing stop would not improve current SL", command.trailingStopUnit);
         return;
      }
   }
   else
   {
      nextSl = SymbolInfoDouble(symbol, SYMBOL_ASK) + distance;
      if(currentSl > 0.0 && nextSl >= currentSl)
      {
         ReportFailure(command.queueItemId, "Trailing stop would not improve current SL", command.trailingStopUnit);
         return;
      }
   }

   ModifyPositionSl(command, ticket, nextSl);
}

void ModifyPositionSl(SignalCommand &command, ulong ticket, double stopLoss)
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
   request.sl = stopLoss;
   request.tp = PositionGetDouble(POSITION_TP);
   request.magic = MagicNumber;

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
   request.tp = takeProfit;
   request.magic = MagicNumber;

   bool sent = OrderSend(request, result);
    Report(command.queueItemId, IsTradeSuccess(result.retcode) ? "EXECUTED" : "FAILED", result.retcode, result.retcode_external, result.comment, result.order, ticket, result.deal, request.tp, result.price, PositionGetDouble(POSITION_VOLUME), sent ? "" : IntegerToString(GetLastError()));
}

void ExecuteClose(SignalCommand &command)
{
   ulong ticket = FindPositionTicket(command);
   if(ticket == 0 || !PositionSelectByTicket(ticket))
   {
      ReportFailure(command.queueItemId, "No matching position found", command.brokerSymbol);
      return;
   }

   string symbol = PositionGetString(POSITION_SYMBOL);
   long positionType = PositionGetInteger(POSITION_TYPE);
   double currentVolume = PositionGetDouble(POSITION_VOLUME);
   double closeVolume = currentVolume;
   if(command.commandType == "CLOSE_PARTIAL" && command.partialCloseKind == "PERCENT")
      closeVolume = NormalizeVolume(symbol, currentVolume * command.partialCloseValue / 100.0);

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
   request.comment = StringFormat("telegram-tc-close:%s", command.logicalTradeId);

   bool sent = OrderSend(request, result);
    Report(command.queueItemId, IsTradeSuccess(result.retcode) ? "EXECUTED" : "FAILED", result.retcode, result.retcode_external, result.comment, result.order, ticket, result.deal, request.price, result.price, request.volume, sent ? "" : IntegerToString(GetLastError()));
}

void TrackVirtualTakeProfits(SignalCommand &command, MqlTradeResult &result)
{
   if(command.executionMode != "VIRTUAL_TP")
      return;

   if(virtualTpStateCount >= ArraySize(virtualTpStates))
      return;

   bool hasTp = false;
   for(int leg = 0; leg < 4; leg++)
   {
      if(command.tp[leg] > 0.0)
         hasTp = true;
   }
   if(!hasTp)
      return;

   int slot = virtualTpStateCount;
   virtualTpStateCount++;
   virtualTpStates[slot].active = true;
   virtualTpStates[slot].queueItemId = command.queueItemId;
   virtualTpStates[slot].logicalTradeId = command.logicalTradeId;
   virtualTpStates[slot].symbol = command.brokerSymbol;
   virtualTpStates[slot].direction = command.direction;
   virtualTpStates[slot].baseVolume = result.volume > 0.0 ? result.volume : CommandVolume(command);

   for(int leg = 0; leg < 4; leg++)
   {
      virtualTpStates[slot].tp[leg] = command.tp[leg];
      virtualTpStates[slot].tpAllocation[leg] = command.tpAllocation[leg];
      virtualTpStates[slot].tpVolume[leg] = command.tpVolume[leg];
      virtualTpStates[slot].closed[leg] = false;
   }
}

void ManageVirtualTakeProfits()
{
   for(int index = 0; index < virtualTpStateCount; index++)
   {
      if(!virtualTpStates[index].active)
         continue;
      if(!EnsureSymbol(virtualTpStates[index].symbol))
         continue;

      double price = virtualTpStates[index].direction == "BUY"
         ? SymbolInfoDouble(virtualTpStates[index].symbol, SYMBOL_BID)
         : SymbolInfoDouble(virtualTpStates[index].symbol, SYMBOL_ASK);

      for(int leg = 0; leg < 4; leg++)
      {
         if(virtualTpStates[index].closed[leg] || virtualTpStates[index].tp[leg] <= 0.0)
            continue;
         bool hit = virtualTpStates[index].direction == "BUY"
            ? price >= virtualTpStates[index].tp[leg]
            : price <= virtualTpStates[index].tp[leg];
         if(hit && CloseVirtualTpLeg(index, leg))
            virtualTpStates[index].closed[leg] = true;
      }
   }
}

bool CloseVirtualTpLeg(int stateIndex, int leg)
{
   SignalCommand command;
   command.queueItemId = virtualTpStates[stateIndex].queueItemId;
   command.logicalTradeId = virtualTpStates[stateIndex].logicalTradeId;
   command.brokerSymbol = virtualTpStates[stateIndex].symbol;

   ulong ticket = FindPositionTicket(command);
   if(ticket == 0 || !PositionSelectByTicket(ticket))
      return false;

   string symbol = PositionGetString(POSITION_SYMBOL);
   long positionType = PositionGetInteger(POSITION_TYPE);
   double currentVolume = PositionGetDouble(POSITION_VOLUME);
   double requestedVolume = virtualTpStates[stateIndex].tpVolume[leg] > 0.0
      ? virtualTpStates[stateIndex].tpVolume[leg]
      : virtualTpStates[stateIndex].baseVolume * virtualTpStates[stateIndex].tpAllocation[leg] / 100.0;
   double closeVolume = NormalizeVolume(
      symbol,
      requestedVolume
   );
   if(closeVolume <= 0.0)
      return false;

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
   request.comment = StringFormat("telegram-tc-virtual-tp:%s:tp%d", virtualTpStates[stateIndex].logicalTradeId, leg + 1);

   bool sent = OrderSend(request, result);
   Report(
      virtualTpStates[stateIndex].queueItemId,
      IsTradeSuccess(result.retcode) ? "EXECUTED" : "FAILED",
      result.retcode,
      result.retcode_external,
      result.comment,
      result.order,
      ticket,
      result.deal,
      request.price,
      result.price,
      request.volume,
      sent ? "" : IntegerToString(GetLastError())
   );
   return sent && IsTradeSuccess(result.retcode);
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
   return StringFind(brokerComment, logicalTradeId) >= 0;
}

string PositionsJson()
{
   string json = "[";
   bool first = true;
   for(int index = 0; index < PositionsTotal(); index++)
   {
      ulong ticket = PositionGetTicket(index);
      if(ticket == 0 || !PositionSelectByTicket(ticket))
         continue;
      if((ulong)PositionGetInteger(POSITION_MAGIC) != MagicNumber)
         continue;

      if(!first)
         json += ",";
      first = false;

      json += StringFormat(
         "{\"ticket\":\"%I64u\",\"symbol\":\"%s\",\"type\":%d,\"volume\":%.2f,\"openPrice\":%.8f,\"sl\":%.8f,\"tp\":%.8f,\"profit\":%.2f,\"comment\":\"%s\"}",
         ticket,
         JsonEscape(PositionGetString(POSITION_SYMBOL)),
         (int)PositionGetInteger(POSITION_TYPE),
         PositionGetDouble(POSITION_VOLUME),
         PositionGetDouble(POSITION_PRICE_OPEN),
         PositionGetDouble(POSITION_SL),
         PositionGetDouble(POSITION_TP),
         PositionGetDouble(POSITION_PROFIT),
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
      if((ulong)OrderGetInteger(ORDER_MAGIC) != MagicNumber)
         continue;

      if(!first)
         json += ",";
      first = false;

      json += StringFormat(
         "{\"ticket\":\"%I64u\",\"symbol\":\"%s\",\"type\":%d,\"volume\":%.2f,\"openPrice\":%.8f,\"sl\":%.8f,\"tp\":%.8f,\"comment\":\"%s\"}",
         ticket,
         JsonEscape(OrderGetString(ORDER_SYMBOL)),
         (int)OrderGetInteger(ORDER_TYPE),
         OrderGetDouble(ORDER_VOLUME_CURRENT),
         OrderGetDouble(ORDER_PRICE_OPEN),
         OrderGetDouble(ORDER_SL),
         OrderGetDouble(ORDER_TP),
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
      string comment = HistoryDealGetString(ticket, DEAL_COMMENT);
      long magic = HistoryDealGetInteger(ticket, DEAL_MAGIC);
      if((ulong)magic != MagicNumber && StringFind(comment, "telegram-tc") < 0)
         continue;

      if(!first)
         json += ",";
      first = false;
      json += StringFormat(
         "{\"dealTicket\":\"%I64u\",\"orderTicket\":\"%I64u\",\"positionTicket\":\"%I64u\",\"entry\":\"%d\",\"type\":\"%d\",\"symbol\":\"%s\",\"price\":%.8f,\"volume\":%.2f,\"profit\":%.2f,\"commission\":%.2f,\"swap\":%.2f,\"comment\":\"%s\",\"time\":\"%s\"}",
         ticket,
         (ulong)HistoryDealGetInteger(ticket, DEAL_ORDER),
         (ulong)HistoryDealGetInteger(ticket, DEAL_POSITION_ID),
         (int)HistoryDealGetInteger(ticket, DEAL_ENTRY),
         (int)HistoryDealGetInteger(ticket, DEAL_TYPE),
         JsonEscape(HistoryDealGetString(ticket, DEAL_SYMBOL)),
         HistoryDealGetDouble(ticket, DEAL_PRICE),
         HistoryDealGetDouble(ticket, DEAL_VOLUME),
         HistoryDealGetDouble(ticket, DEAL_PROFIT),
         HistoryDealGetDouble(ticket, DEAL_COMMISSION),
         HistoryDealGetDouble(ticket, DEAL_SWAP),
         JsonEscape(comment),
         TimeToString((datetime)HistoryDealGetInteger(ticket, DEAL_TIME), TIME_DATE|TIME_SECONDS)
      );
   }
   json += "]";
   return json;
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
   return StringFormat(
      "{\"symbol\":\"%s\",\"bid\":%.8f,\"ask\":%.8f,\"volumeMin\":%.2f,\"volumeMax\":%.2f,\"volumeStep\":%.2f,\"point\":%.8f,\"digits\":%d}",
      JsonEscape(symbol),
      SymbolInfoDouble(symbol, SYMBOL_BID),
      SymbolInfoDouble(symbol, SYMBOL_ASK),
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
   return SymbolInfoInteger(symbol, SYMBOL_SELECT) != 0;
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
      "{\"accountNumber\":\"%I64d\",\"server\":\"%s\",\"company\":\"%s\",\"currency\":\"%s\",\"balance\":%.2f,\"equity\":%.2f,\"marginMode\":\"%s\",\"availableSymbols\":%s,\"linkCode\":\"%s\"}",
      AccountInfoInteger(ACCOUNT_LOGIN),
      JsonEscape(AccountInfoString(ACCOUNT_SERVER)),
      JsonEscape(AccountInfoString(ACCOUNT_COMPANY)),
      JsonEscape(AccountInfoString(ACCOUNT_CURRENCY)),
      AccountInfoDouble(ACCOUNT_BALANCE),
      AccountInfoDouble(ACCOUNT_EQUITY),
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

bool HttpPost(string path, string body, string &response)
{
   char data[];
   StringToCharArray(body, data, 0, WHOLE_ARRAY, CP_UTF8);
   if(ArraySize(data) > 0 && data[ArraySize(data) - 1] == 0)
      ArrayResize(data, ArraySize(data) - 1);
   return HttpRequest("POST", path, "Content-Type: application/json\r\n", data, response);
}

bool HttpRequest(string method, string path, string headers, char &data[], string &response)
{
   char result[];
   string resultHeaders = "";
   string url = BackendBaseUrl + path;
   ResetLastError();
   int status = WebRequest(method, url, headers, 8000, data, result, resultHeaders);
   if(status == -1)
   {
      PrintFormat("Telegram TC WebRequest failed: %d. Add %s to allowed WebRequest URLs.", GetLastError(), BackendBaseUrl);
      return false;
   }
   response = CharArrayToString(result, 0, -1, CP_UTF8);
   if(status < 200 || status >= 300)
   {
      PrintFormat("Telegram TC HTTP %d: %s", status, response);
      return false;
   }
   return true;
}

string JsonEscape(string value)
{
   StringReplace(value, "\\", "\\\\");
   StringReplace(value, "\"", "\\\"");
   StringReplace(value, "\r", " ");
   StringReplace(value, "\n", " ");
   return value;
}
