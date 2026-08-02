//+------------------------------------------------------------------+
//| Telegram TC Expert Advisor                                       |
//| Polls the Telegram TC backend for normalized trade instructions. |
//+------------------------------------------------------------------+
#property copyright "Telegram TC"
#property version   "1.67.0"
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
// What the BROKER sees in the order comment. The logical trade id is always written
// to the Experts log and always reported to the backend regardless of this setting,
// so hiding it changes what the broker sees, never what we can reconcile.
enum TradeCommentVisibility
  {
   COMMENT_TAGGED = 0,  // Tagged - broker sees ttc:<id>
   COMMENT_HIDDEN = 1,  // Hidden - broker sees no comment
   COMMENT_CUSTOM = 2   // Custom - broker sees CustomTradeComment
  };
input TradeCommentVisibility TradeComment = COMMENT_TAGGED;
input string CustomTradeComment = "";    // Used only when TradeComment = Custom
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
   double targetRemainingVolume;
   string idempotencyKey;
   bool runnerEnabled;
   double runnerVolume;
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

// Lifecycle idempotency marks live in terminal global variables so a redelivered
// close cannot execute a second time, including after a terminal restart. This
// registry is the bookkeeping that lets the EA hand those variables back; the
// variables themselves remain the source of truth.
#define LIFECYCLE_MARK_PREFIX "TelegramTC.lc."
#define LEGACY_LIFECYCLE_MARK_PREFIX "TelegramTC.lifecycle."
// How long a mark whose position has vanished is held before reclamation. Covers a
// reconnect window in which PositionSelectByTicket can fail on a position that is
// still open at the broker.
// Consecutive sweeps a position must be absent for before its mark is reclaimed. This
// is deliberately a count and not a duration: the sweep runs on a clamped timer, so
// counting passes buys a controlled window without trusting a clock that a backward
// NTP step or a manual correction could collapse. Refresh may use elapsed time because
// a three-week window absorbs any plausible jump; a five-minute grace would not, and
// this is the path that deletes.
#define LIFECYCLE_MARK_ABSENT_PASSES 10
// The terminal deletes a global variable four weeks after its last use, so a mark
// guarding a still-open position is rewritten well inside that window.
#define LIFECYCLE_MARK_REFRESH_SECONDS 604800
#define LIFECYCLE_MARK_SWEEP_SECONDS 30
// The timer drives the sweep, so the poll interval is also the refresh cadence. The
// backend caps what it sends at 30 seconds but cannot correct a startup value before
// the first timer event, and an interval beyond the four-week expiry would mean the
// sweep never runs in time to save a mark.
#define MAX_POLL_SECONDS 300

struct LifecycleMark
{
   bool active;
   // Written by this EA instance in this session. Only an owned mark may ever be
   // deleted, which is what makes cross-account deletion structurally impossible
   // rather than something the EA has to keep proving from a name.
   bool owned;
   string variable;
   string identity;        // full account identity this entry was registered under
   // POSITION_IDENTIFIER, never POSITION_TICKET. MQL5 documents the ticket as
   // replaceable by a server service operation, swaps charged with a position
   // re-opening being the named case, while the identifier "does not change
   // throughout its life cycle". A mark keyed by the ticket therefore stopped
   // matching its own position the moment the server replaced it, and a redelivered
   // close read as never executed and closed the position a second time.
   ulong positionIdentifier;  // always > 0: only position-scoped marks are tracked
   // Both clocks are TimeLocal. TimeCurrent is the last quote's server time and stops
   // advancing while the terminal is disconnected, which is exactly when a mark most
   // needs its expiry pushed back, so it cannot be what drives the refresh.
   datetime refreshedAt;   // 0 = never refreshed by this session, refresh on sight
   int absentPasses;       // consecutive sweeps the position was absent, no clock involved
};

TrailingStopState trailingStopStates[100];
int trailingStopStateCount = 0;
LifecycleMark lifecycleMarks[512];
int lifecycleMarkCount = 0;
int CurrentPollSeconds = 0;
datetime LastHeartbeatSentAt = 0;
datetime LastHistoryBackfillAt = 0;
datetime LastLifecycleReclaimAt = 0;
bool LifecycleMarksAdopted = false;
string LastLifecycleAdoptionReport = "";
string EaCapabilitiesJson = "[\"lane2-close-contract\",\"pending-close-flatten-v1\"]";

int ClampPollSeconds(int seconds)
{
   int clamped = MathMax(1, MathMin(MAX_POLL_SECONDS, seconds));
   if(clamped != seconds)
      PrintFormat("Telegram TC: poll interval %d s clamped to %d s", seconds, clamped);
   return clamped;
}

int OnInit()
{
   CurrentPollSeconds = ClampPollSeconds(PollSeconds);
   if(StringFind(BackendBaseUrl, "your-api-host.example.com") >= 0 || BackendBaseUrl == "")
      Print("Telegram TC: set BackendBaseUrl to your deployed API /api URL before enabling live polling.");
   if(LinkCode == "")
      Print("Telegram TC: LinkCode is empty — registrations will land in an unlabelled slot. Paste the link code from the App's Linked Accounts page.");
   EventSetTimer(CurrentPollSeconds);
   RehydrateLifecycleMarks();
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
   // now < LastLifecycleReclaimAt means the clock went backwards. Sweep instead of
   // waiting for it to catch up, or a large backward correction would stall refreshes
   // for as long as the jump.
   if(LastLifecycleReclaimAt == 0
      || now < LastLifecycleReclaimAt
      || now - LastLifecycleReclaimAt >= LIFECYCLE_MARK_SWEEP_SECONDS)
   {
      // OnInit runs before the terminal has necessarily resolved an account, and it is
      // the only other caller, so adoption has to be able to catch up here. Without
      // this a startup with no login left the registry empty for the whole session and
      // every mark from the previous one unrefreshed.
      if(!LifecycleMarksAdopted)
         RehydrateLifecycleMarks();
      ReclaimLifecycleMarks();
      LastLifecycleReclaimAt = now;
   }
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
      "{\"accountId\":\"mt5-%I64d\",\"balance\":%.2f,\"equity\":%.2f,\"profit\":%.2f,\"availableSymbols\":%s,\"eaVersion\":\"%s\",\"eaCapabilities\":%s,\"linkCode\":\"%s\"}",
      AccountInfoInteger(ACCOUNT_LOGIN),
      AccountInfoDouble(ACCOUNT_BALANCE),
      AccountInfoDouble(ACCOUNT_EQUITY),
      AccountInfoDouble(ACCOUNT_PROFIT),
      SymbolsJson(),
      "1.67.0",
      EaCapabilitiesJson,
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
      ReportUnknown(command.queueItemId, "Could not parse poll payload", "parser");
      return;
   }
   if(IsLifecycleCommand(command.commandType) && command.logicalTradeId == "")
   {
      ReportUnknown(command.queueItemId, "Lifecycle command rejected", "empty logicalTradeId");
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
      ReportUnknown(command.queueItemId, "Symbol is unavailable or has no fresh tick; reconcile quote before retry", command.brokerSymbol);
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
   LogTradeIdentity(command.logicalTradeId, "open", request.comment);

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
   double rawTp = 0.0;
   if(command.executionMode == "SPLIT_ORDER")
      rawTp = command.tp[0];
   else if(command.executionMode == "VIRTUAL_TP" && !command.runnerEnabled)
   {
      bool hasPlannedTpVolume = false;
      for(int index = 0; index < 4; index++)
      {
         if(command.tpVolume[index] > 0.0)
            hasPlannedTpVolume = true;
      }
      for(int index = 0; index < 4; index++)
      {
         if(command.tp[index] > 0.0 && command.tpAllocation[index] > 0.0 &&
            (!hasPlannedTpVolume || command.tpVolume[index] > 0.0))
            rawTp = command.tp[index];
      }
   }
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

   double filledVolume = request.action == TRADE_ACTION_PENDING ? 0.0 : result.volume;
   double remainingVolume = request.action == TRADE_ACTION_PENDING
      ? request.volume
      : MathMax(0.0, request.volume - filledVolume);
   ReportWithVolumes(
      command.queueItemId,
      result.retcode == TRADE_RETCODE_DONE_PARTIAL ? "PARTIAL" : (IsTradeSuccess(result.retcode) ? "EXECUTED" : "FAILED"),
      result.retcode,
      result.retcode_external,
      result.comment,
      result.order,
      FindPositionTicket(command),
      result.deal,
      request.price,
      result.price,
      request.volume,
      filledVolume,
      remainingVolume,
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
      LogTradeIdentity(command.logicalTradeId, "tp" + IntegerToString(leg + 1), request.comment);
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
   if(LifecycleAlreadyExecuted(command))
   {
      ReportUnknown(command.queueItemId, "Lifecycle command was already executed; reconcile broker snapshot/history", command.commandType);
      return;
   }
   ulong tickets[];
   int found = CollectPendingOrderTickets(command, tickets);
   if(found <= 0)
   {
      ReportFailure(command.queueItemId, "No matching pending order found", command.brokerSymbol);
      return;
   }
   int removed = 0;
   MqlTradeResult lastResult = {};
   for(int index = 0; index < found; index++)
   {
      MqlTradeResult result = {};
      if(RemovePendingOrder(command, tickets[index], result))
         removed++;
      lastResult = result;
   }
   if(removed == found)
   {
      MarkLifecycleExecuted(command);
      Report(command.queueItemId, "EXECUTED", lastResult.retcode, lastResult.retcode_external, lastResult.comment, lastResult.order, 0, lastResult.deal, 0, lastResult.price, 0.0, "");
      return;
   }
   Report(command.queueItemId, removed > 0 ? "PARTIAL" : "FAILED", lastResult.retcode, lastResult.retcode_external, lastResult.comment, lastResult.order, 0, lastResult.deal, 0, lastResult.price, 0.0, "Pending-order cancellation was not confirmed for every ticket");
}

bool RemovePendingOrder(SignalCommand &command, ulong ticket, MqlTradeResult &result)
{
   MqlTradeRequest request = {};
   request.action = TRADE_ACTION_REMOVE;
   request.order = ticket;
   request.symbol = command.brokerSymbol;
   bool sent = OrderSend(request, result);
   return sent && IsTradeSuccess(result.retcode);
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

   int untracked = 0;
   for(int index = 0; index < found; index++)
   {
      if(!TrackTrailingStop(command, tickets[index], distance))
         untracked++;
      ApplyTrailingStopToTicket(command, tickets[index], distance);
   }

   // Every slot holds a live trailing position. The one-shot stop above still went
   // in, but nothing will ever move it again, so this must not pass silently: an
   // untracked trailing stop is an unmanaged position. The report lands after the
   // per-ticket ones and the last report wins, so the queue item reads FAILED.
   if(untracked > 0)
   {
      PrintFormat("Telegram TC TRAILING_STOP capacity exhausted queue=%s logicalTradeId=%s untracked=%d of %d slots=%d",
         command.queueItemId,
         command.logicalTradeId,
         untracked,
         found,
         ArraySize(trailingStopStates));
      ReportFailure(
         command.queueItemId,
         "Trailing stop tracking capacity exhausted",
         StringFormat("%d of %d position(s) left holding a one-shot stop; all %d trailing slots hold live positions",
            untracked,
            found,
            ArraySize(trailingStopStates)));
   }
}

// A slot is free when active is false. Releasing clears every field, so a recycled
// slot cannot carry a finished position's queue item, trade id, symbol, direction
// or distance into a new ticket, and clearing the ticket stops the reuse scan in
// TrackTrailingStop from matching a slot that no longer owns one.
void ReleaseTrailingStopSlot(int index)
{
   trailingStopStates[index].active = false;
   trailingStopStates[index].queueItemId = "";
   trailingStopStates[index].logicalTradeId = "";
   trailingStopStates[index].symbol = "";
   trailingStopStates[index].direction = "";
   trailingStopStates[index].positionTicket = 0;
   trailingStopStates[index].distance = 0.0;
}

// Returns false only when every slot holds a live trailing position. Slots are
// recycled in place and never compacted: trailingStopStateCount is a high-water
// mark that only grows, so ManageTrailingStops can release an entry mid-pass
// without any index shifting underneath its loop.
bool TrackTrailingStop(SignalCommand &command, ulong ticket, double distance)
{
   if(ticket == 0)
      return false;

   int freeSlot = -1;
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
         return true;
      }
      if(freeSlot < 0 && !trailingStopStates[index].active)
         freeSlot = index;
   }

   if(freeSlot < 0)
   {
      if(trailingStopStateCount >= ArraySize(trailingStopStates))
         return false;
      freeSlot = trailingStopStateCount;
      trailingStopStateCount++;
   }

   trailingStopStates[freeSlot].active = true;
   trailingStopStates[freeSlot].queueItemId = command.queueItemId;
   trailingStopStates[freeSlot].logicalTradeId = command.logicalTradeId;
   trailingStopStates[freeSlot].symbol = command.brokerSymbol;
   trailingStopStates[freeSlot].direction = command.direction;
   trailingStopStates[freeSlot].positionTicket = ticket;
   trailingStopStates[freeSlot].distance = distance;
   return true;
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
         PrintFormat("Telegram TC TRAILING_STOP released slot=%d ticket=%I64u logicalTradeId=%s (position gone)",
            index,
            trailingStopStates[index].positionTicket,
            trailingStopStates[index].logicalTradeId);
         ReleaseTrailingStopSlot(index);
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
   // CLOSE_PARTIAL only reduces an open position: it must never cancel working
   // pending orders, and the position surviving with a smaller volume is the
   // expected result rather than an incomplete flatten. Only CLOSE_TRADE runs
   // the flatten path below.
   if(command.commandType != "CLOSE_TRADE")
   {
      ExecutePartialClose(command);
      return;
   }

   ulong pendingTickets[];
   int pendingFound = CollectPendingOrderTickets(command, pendingTickets);
   ulong initialPositions[];
   int initialPositionCount = CollectPositionTickets(command, initialPositions);
   if(pendingFound <= 0 && initialPositionCount <= 0)
   {
      ReportUnknown(command.queueItemId, "No matching pending order or position; reconcile broker snapshot/history", command.commandType);
      return;
   }

   int pendingRemoved = 0;
   int pendingFailures = 0;
   MqlTradeResult lastResult = {};
   ulong lastOrderTicket = 0;
   ulong lastPositionTicket = 0;
   ulong lastDealTicket = 0;
   for(int index = 0; index < pendingFound; index++)
   {
      MqlTradeResult result = {};
      if(RemovePendingOrder(command, pendingTickets[index], result))
         pendingRemoved++;
      else
         pendingFailures++;
      lastResult = result;
      lastOrderTicket = pendingTickets[index];
   }

   // A pending order may fill while the remove request is in flight. Re-scan
   // after cancellation so CLOSE_TRADE handles the newly-created position too.
   ulong positionTickets[];
   ulong positionIdentifiers[];
   int positionFound = CollectPositionTargets(command, positionTickets, positionIdentifiers);
   int positionsClosed = 0;
   int positionFailures = 0;
   bool partialResult = false;
   double requestedVolume = 0.0;
   double filledVolume = 0.0;
   double remainingVolume = 0.0;
   for(int index = 0; index < positionFound; index++)
   {
      ulong ticket = positionTickets[index];
      if(LifecycleAlreadyExecuted(command, positionIdentifiers[index], ticket))
      {
         positionFailures++;
         lastPositionTicket = ticket;
         continue;
      }
      MqlTradeResult result = {};
      double requested = 0.0;
      double filled = 0.0;
      double remaining = 0.0;
      if(ClosePositionTicket(command, ticket, result, requested, filled, remaining))
         positionsClosed++;
      else
         positionFailures++;
      if(result.retcode == TRADE_RETCODE_DONE_PARTIAL || result.retcode == TRADE_RETCODE_PLACED)
         partialResult = true;
      requestedVolume += requested;
      filledVolume += filled;
      remainingVolume += remaining;
      lastResult = result;
      lastPositionTicket = ticket;
      lastDealTicket = result.deal;
   }

   ulong remainingPendingTickets[];
   ulong remainingPositionTickets[];
   ulong remainingPositionIdentifiers[];
   int remainingPending = CollectPendingOrderTickets(command, remainingPendingTickets);
   int remainingPositionMatches = CollectPositionTargets(command, remainingPositionTickets, remainingPositionIdentifiers);
   int remainingPositions = 0;
   for(int index = 0; index < remainingPositionMatches; index++)
      if(!LifecycleAlreadyExecuted(command, remainingPositionIdentifiers[index], remainingPositionTickets[index]))
         remainingPositions++;
   string status = "UNKNOWN";
   if(remainingPending == 0 && remainingPositions == 0 && pendingFailures == 0 && positionFailures == 0 && !partialResult)
      status = "EXECUTED";
   else if(pendingRemoved > 0 || positionsClosed > 0)
      status = "PARTIAL";

   string evidence = status == "EXECUTED"
      ? "Pending orders and positions flattened"
      : "Flatten incomplete; reconcile broker snapshot/history before retrying";
   ReportWithVolumes(
      command.queueItemId,
      status,
      lastResult.retcode,
      lastResult.retcode_external,
      lastResult.comment,
      lastOrderTicket,
      lastPositionTicket,
      lastDealTicket,
      0.0,
      lastResult.price,
      requestedVolume,
      filledVolume,
      remainingVolume,
      evidence
   );
}

void ExecutePartialClose(SignalCommand &command)
{
   if(command.partialCloseKind == "PERCENT" && command.targetRemainingVolume <= 0.0)
   {
      ReportUnknown(command.queueItemId, "No valid target remaining volume provided", command.commandType);
      return;
   }
   ulong tickets[];
   ulong identifiers[];
   int found = CollectPositionTargets(command, tickets, identifiers);
   if(found <= 0)
   {
      ReportUnknown(command.queueItemId, "No matching position; reconcile broker snapshot/history", command.commandType);
      return;
   }

   // One aggregated report per command. Reporting per ticket would let a later
   // EXECUTED slice overwrite an earlier failed one (last write wins on the
   // queue item), leaving the command marked done while a slice never retried.
   int attempted = 0;
   int succeeded = 0;
   bool partialResult = false;
   double requestedVolume = 0.0;
   double filledVolume = 0.0;
   double remainingVolume = 0.0;
   MqlTradeResult lastResult = {};
   ulong lastPositionTicket = 0;
   ulong lastDealTicket = 0;
   for(int index = 0; index < found; index++)
   {
      ulong ticket = tickets[index];
      if(LifecycleAlreadyExecuted(command, identifiers[index], ticket))
         continue;
      attempted++;
      MqlTradeResult result = {};
      double requested = 0.0;
      double filled = 0.0;
      double remaining = 0.0;
      if(ClosePositionTicket(command, ticket, result, requested, filled, remaining))
         succeeded++;
      if(result.retcode == TRADE_RETCODE_DONE_PARTIAL || result.retcode == TRADE_RETCODE_PLACED)
         partialResult = true;
      requestedVolume += requested;
      filledVolume += filled;
      remainingVolume += remaining;
      lastResult = result;
      lastPositionTicket = ticket;
      lastDealTicket = result.deal;
   }

   if(attempted > 0)
   {
      // Anything short of every attempted slice completing stays PARTIAL, which
      // the server holds for review rather than treating as terminal.
      string status = (succeeded == attempted && !partialResult) ? "EXECUTED" : "PARTIAL";
      ReportWithVolumes(
         command.queueItemId,
         status,
         lastResult.retcode,
         lastResult.retcode_external,
         lastResult.comment,
         lastResult.order,
         lastPositionTicket,
         lastDealTicket,
         0.0,
         lastResult.price,
         requestedVolume,
         filledVolume,
         remainingVolume,
         status == "EXECUTED" ? "" : "Partial close did not complete; reconcile broker snapshot/history"
      );
   }

   if(attempted == 0)
      ReportUnknown(command.queueItemId, "Lifecycle command was already executed; reconcile broker snapshot/history", command.commandType);
}

bool ClosePositionTicket(
   SignalCommand &command,
   ulong ticket,
   MqlTradeResult &result,
   double &requestedVolume,
   double &filledVolume,
   double &remainingVolume
)
{
   requestedVolume = 0.0;
   filledVolume = 0.0;
   remainingVolume = 0.0;
   if(!PositionSelectByTicket(ticket))
   {
      result.comment = "Position disappeared before close";
      return false;
   }

   // Captured here, before anything closes anything. The mark is written at the bottom
   // of this function, by which point a full close has removed the position and there
   // is no identifier left to read: PositionGetInteger would answer from whatever was
   // selected last. The select above is the only moment this value is reliable.
   ulong identifier = PositionMarkKey(ticket);
   string symbol = PositionGetString(POSITION_SYMBOL);
   long positionType = PositionGetInteger(POSITION_TYPE);
   double currentVolume = PositionGetDouble(POSITION_VOLUME);
   double closeVolume = command.commandType == "CLOSE_PARTIAL" ? 0.0 : currentVolume;
   if(command.commandType == "CLOSE_TRADE" && command.runnerEnabled)
   {
      closeVolume = command.runnerVolume >= currentVolume
         ? currentVolume
         : NormalizeCloseVolume(symbol, currentVolume - command.runnerVolume, currentVolume);
      if(closeVolume <= 0.0)
         closeVolume = currentVolume;
   }
   else if(command.commandType == "CLOSE_PARTIAL" && command.partialCloseKind == "PERCENT")
      closeVolume = NormalizeCloseVolume(symbol, currentVolume - command.targetRemainingVolume, currentVolume);
   else if(command.commandType == "CLOSE_PARTIAL" && command.partialCloseKind == "TP_LEG")
   {
      if(command.partialCloseVolume > 0.0)
         closeVolume = NormalizeCloseVolume(symbol, command.partialCloseVolume, currentVolume);
      else if(command.partialCloseAllocation > 0.0)
         closeVolume = NormalizeCloseVolume(symbol, currentVolume * command.partialCloseAllocation / 100.0, currentVolume);
   }
   else if(command.commandType == "CLOSE_PARTIAL" && command.partialCloseKind == "LOTS")
      closeVolume = NormalizeCloseVolume(symbol, command.partialCloseValue, currentVolume);

   if(closeVolume <= 0.0)
   {
      result.comment = command.commandType == "CLOSE_PARTIAL"
         ? "No valid partial-close volume provided"
         : "No valid close volume provided";
      return false;
   }

   MqlTradeRequest request = {};
   request.action = TRADE_ACTION_DEAL;
   request.position = ticket;
   request.symbol = symbol;
   request.volume = closeVolume;
   request.deviation = DeviationPoints;
   request.magic = MagicNumber;
   request.type_filling = FillingModeForSymbol(symbol, false);
   request.type = positionType == POSITION_TYPE_BUY ? ORDER_TYPE_SELL : ORDER_TYPE_BUY;
   request.price = positionType == POSITION_TYPE_BUY
      ? SymbolInfoDouble(symbol, SYMBOL_BID)
      : SymbolInfoDouble(symbol, SYMBOL_ASK);
   request.comment = CompactTradeSuffixComment(command.logicalTradeId, ":close");
   LogTradeIdentity(command.logicalTradeId, "close", request.comment);

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
   bool positionGone = !PositionSelectByTicket(ticket);
   remainingVolume = positionGone ? 0.0 : PositionGetDouble(POSITION_VOLUME);
   double observedFilledVolume = positionGone ? currentVolume : MathMax(0.0, currentVolume - remainingVolume);
   filledVolume = MathMax(result.volume, observedFilledVolume);
   bool fullClose = closeVolume >= currentVolume - 0.000001;
   bool filledConfirmed = filledVolume + 0.000001 >= request.volume;
   // Full closes require the position gone. Slice closes require a DONE result
   // plus broker-confirmed volume, either from the deal or the observed delta.
   if(sent && result.retcode == TRADE_RETCODE_DONE && filledConfirmed && (positionGone || !fullClose))
      MarkLifecycleExecuted(command, identifier);
   requestedVolume = request.volume;
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

// The one rule that turns a selected position into the number its mark is keyed by,
// so the write side and the reclaim side cannot drift apart. A position with no
// readable identifier falls back to its ticket, which is exactly the pre-1.68 key, so
// the worst case is the behaviour this version replaces rather than something new.
// Zero is never the answer: zero is the command-scoped name CANCEL_PENDING writes, so
// two positions under one command would share a single mark and the second close would
// be recorded as already done and silently skipped.
ulong PositionMarkKey(ulong ticket)
{
   ulong identifier = (ulong)PositionGetInteger(POSITION_IDENTIFIER);
   return identifier == 0 ? ticket : identifier;
}

// Both numbers for a matched position, taken while it is selected. The ticket is what
// a trade request addresses; the identifier is what a mark is keyed by, and the two
// stop agreeing the moment the server replaces a ticket. Reading the identifier back
// later would mean re-selecting a position that a close may already have removed, so
// it is captured here, once, at the same instant as the ticket.
int CollectPositionTargets(SignalCommand &command, ulong &tickets[], ulong &identifiers[])
{
   ArrayResize(tickets, 0);
   ArrayResize(identifiers, 0);
   if(command.targetPositionTicket > 0 && PositionSelectByTicket(command.targetPositionTicket))
   {
      ArrayResize(tickets, 1);
      ArrayResize(identifiers, 1);
      tickets[0] = command.targetPositionTicket;
      identifiers[0] = PositionMarkKey(command.targetPositionTicket);
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
      ArrayResize(identifiers, next + 1);
      tickets[next] = ticket;
      identifiers[next] = PositionMarkKey(ticket);
   }
   return ArraySize(tickets);
}

// Ticket-only view for the callers that address positions and never key a mark:
// MOVE_SL_TO_BE, MODIFY_SL, MODIFY_TP and TRAILING_STOP. One implementation, so a
// matching rule can never differ between the paths that mark and the paths that do not.
int CollectPositionTickets(SignalCommand &command, ulong &tickets[])
{
   ulong identifiers[];
   return CollectPositionTargets(command, tickets, identifiers);
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
      return false;
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

// The ttc: tag is written into the broker-visible order comment. It is the FIRST key
// used to map a broker deal back to a logical trade, but not the only one: the server
// falls back to the position ticket and then the order ticket recorded in broker_orders,
// and this EA identifies its own deals by MagicNumber independently. So hiding it is
// safe for normal operation. The cost is losing the last-resort attribution path, so a
// deal whose ticket was never recorded (a report lost in flight) can no longer be
// recovered by comment and will look external. Leave it on unless the broker comment
// needs to stay clean.
// Always record the mapping locally, whatever the broker is shown. The ttc: tag is the
// FIRST key the backend uses to map a broker deal to a logical trade, but not the only
// one: it falls back to the position ticket then the order ticket from broker_orders,
// and this EA identifies its own deals by MagicNumber. Hiding the tag removes the
// last-resort attribution path, so this log line IS that path - it is how an operator
// re-attaches a deal by hand when a report was lost in flight.
void LogTradeIdentity(string logicalTradeId, string context, string brokerComment)
{
   PrintFormat("Telegram TC IDENTITY logicalTradeId=%s ttc=%s context=%s brokerComment=\"%s\"",
      logicalTradeId,
      CompactTradeId(logicalTradeId),
      context,
      brokerComment);
}

// MT5 truncates order comments around 31 chars and a stray "ttc:" inside a custom
// string would be parsed back as a real tag, so the custom text is sanitised.
string SanitizedCustomComment()
{
   string custom = CustomTradeComment;
   StringReplace(custom, "ttc:", "");
   StringTrimLeft(custom);
   StringTrimRight(custom);
   if(StringLen(custom) > 31)
      custom = StringSubstr(custom, 0, 31);
   return custom;
}

string CompactTradeComment(string logicalTradeId)
{
   if(TradeComment == COMMENT_HIDDEN)
      return "";
   if(TradeComment == COMMENT_CUSTOM)
      return SanitizedCustomComment();
   return "ttc:" + CompactTradeId(logicalTradeId);
}

// Suffixes belong to the tagged form only. Appending ":close" to a hidden comment
// would leak a bare marker that explains nothing to the broker and matches nothing
// coming back; appending it to a custom label would corrupt the operator's own text.
bool CommentCarriesTag()
{
   return TradeComment == COMMENT_TAGGED;
}

string CompactTradeTpComment(string logicalTradeId, int leg)
{
   string base = CompactTradeComment(logicalTradeId);
   if(!CommentCarriesTag() || base == "")
      return base;
   return base + ":tp" + IntegerToString(leg);
}

string CompactTradeSuffixComment(string logicalTradeId, string suffix)
{
   string base = CompactTradeComment(logicalTradeId);
   if(!CommentCarriesTag() || base == "")
      return base;
   return base + suffix;
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
   command.targetRemainingVolume = StringToDouble(ValueFor(body, "targetRemainingVolume"));
   command.idempotencyKey = ValueFor(body, "idempotencyKey");
   command.runnerEnabled = ValueFor(body, "runnerEnabled") == "true";
   command.runnerVolume = StringToDouble(ValueFor(body, "runnerVolume"));
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

bool IsLifecycleCommand(string commandType)
{
   return commandType == "CANCEL_PENDING" ||
          commandType == "MOVE_SL_TO_BE" ||
          commandType == "MODIFY_SL" ||
          commandType == "MODIFY_TP" ||
          commandType == "TRAILING_STOP" ||
          commandType == "CLOSE_TRADE" ||
          commandType == "CLOSE_PARTIAL";
}

void ApplyPollConfig(string body)
{
   int nextPollSeconds = (int)StringToInteger(ValueFor(body, "pollSeconds"));
   if(nextPollSeconds <= 0 || nextPollSeconds == CurrentPollSeconds)
      return;

   CurrentPollSeconds = ClampPollSeconds(nextPollSeconds);
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

int VolumeDigits(double step)
{
   for(int digits = 0; digits < 8; digits++)
      if(MathAbs(step - NormalizeDouble(step, digits)) < 0.000000001)
         return digits;
   return 8;
}

double NormalizeCloseVolume(string symbol, double requested, double currentVolume)
{
   double minVolume = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MIN);
   double maxVolume = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MAX);
   double step = SymbolInfoDouble(symbol, SYMBOL_VOLUME_STEP);
   if(step <= 0.0 || requested <= 0.0 || currentVolume <= 0.0)
      return 0.0;
   if(requested >= currentVolume - step * 0.000001)
      return currentVolume;
   double volume = MathMin(maxVolume, requested);
   volume = NormalizeDouble(MathFloor((volume + step * 0.000001) / step) * step, VolumeDigits(step));
   if(volume < minVolume || volume <= 0.0)
      return 0.0;
   return volume;
}

bool IsTradeSuccess(uint retcode)
{
   return retcode == TRADE_RETCODE_DONE || retcode == TRADE_RETCODE_PLACED || retcode == TRADE_RETCODE_DONE_PARTIAL;
}

void ReportFailure(string queueItemId, string brokerComment, string errorText)
{
   Report(queueItemId, "FAILED", 0, 0, brokerComment, 0, 0, 0, 0.0, 0.0, 0.0, errorText);
}

void ReportUnknown(string queueItemId, string brokerComment, string errorText)
{
   Report(queueItemId, "UNKNOWN", 0, 0, brokerComment, 0, 0, 0, 0.0, 0.0, 0.0, errorText);
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
   ReportWithVolumes(queueItemId, status, retcode, retcodeExternal, brokerComment, orderTicket, positionTicket, dealTicket, requestedPrice, filledPrice, volume, volume, 0.0, errorText);
}

void ReportWithVolumes(
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
   double requestedVolume,
   double filledVolume,
   double remainingVolume,
   string errorText
)
{
   string body = StringFormat(
      "{\"accountId\":\"mt5-%I64d\",\"queueItemId\":\"%s\",\"status\":\"%s\",\"retcode\":%u,\"retcodeExternal\":%d,\"brokerComment\":\"%s\",\"orderTicket\":\"%I64u\",\"positionTicket\":\"%I64u\",\"dealTicket\":\"%I64u\",\"requestedPrice\":%.8f,\"filledPrice\":%.8f,\"requestedVolume\":%.8f,\"filledVolume\":%.8f,\"remainingVolume\":%.8f,\"errorText\":\"%s\"}",
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
      requestedVolume,
      filledVolume,
      remainingVolume,
      JsonEscape(errorText)
   );
   string response = "";
   HttpPost("/mt5/report", body, response);
}

string LifecycleCommandKey(SignalCommand &command)
{
   return command.idempotencyKey == "" ? command.queueItemId : command.idempotencyKey;
}

// FNV-1a, 64-bit. The offset basis is assembled from its two 32-bit halves so the
// value never depends on how the compiler types a 20-digit unsigned literal.
ulong LifecycleKeyHash(string key)
{
   ulong hash = ((ulong)3421674724 << 32) | (ulong)2216829733;
   ulong prime = 1099511628211;
   int length = StringLen(key);
   for(int index = 0; index < length; index++)
   {
      ushort code = StringGetCharacter(key, index);
      hash = (hash ^ (ulong)(code & 0xFF)) * prime;
      hash = (hash ^ (ulong)((code >> 8) & 0xFF)) * prime;
   }
   return hash;
}

// Terminal global variables are shared by every account the terminal logs into, but
// position tickets are not, so a mark has to say which account it belongs to. The
// login alone is not an identity: the same account number at two brokers is a real
// configuration, and this app is built for multiple accounts. Server and company
// make it unique.
string LifecycleAccountIdentity()
{
   return IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN)) + "|" +
          AccountInfoString(ACCOUNT_SERVER) + "|" +
          AccountInfoString(ACCOUNT_COMPANY);
}

// A fixed-width fold of that identity, used only to decide which marks are worth
// adopting for refresh after a restart. It is 64-to-32 and therefore lossy, which is
// tolerable precisely because nothing destructive reads it: adoption grants the right
// to extend a mark's life, never to end it.
uint LifecycleAccountTag()
{
   ulong hash = LifecycleKeyHash(LifecycleAccountIdentity());
   return (uint)((hash ^ (hash >> 32)) & 0xFFFFFFFF);
}

// MQL5 caps a global variable name at 63 characters and silently keeps only the
// first 63. Every component here is fixed-width except the trailing position number,
// which a ulong bounds at 20 digits, so the name is 60 characters at absolute worst:
// 14 prefix, 8 account tag, 16 hash, 2 separators, 20 digits. No key the backend can
// send, however long, can move that bound or make two distinct marks share a name.
//
// That number is POSITION_IDENTIFIER as of 1.68.0 and was POSITION_TICKET before it.
// Both are ulong, so the bound is unchanged. It stays a bare number rather than
// gaining a kind marker because the two agree for every position the server never
// re-opened: an identifier is the ticket of the order that opened the position, so a
// 1.67 name and a 1.68 name are the same string in the ordinary case and the upgrade
// costs nothing.
string LifecycleIdempotencyVariable(SignalCommand &command, ulong positionId = 0)
{
   string scopedKey = LifecycleAccountIdentity() + "|" + LifecycleCommandKey(command);
   ulong hash = LifecycleKeyHash(scopedKey);
   return StringFormat("%s%08X.%08X%08X.%I64u",
      LIFECYCLE_MARK_PREFIX,
      LifecycleAccountTag(),
      (uint)((hash >> 32) & 0xFFFFFFFF),
      (uint)(hash & 0xFFFFFFFF),
      positionId);
}

// Marks written before this version used the truncated plaintext name. Nothing
// writes that name any more; it stays readable so a close executed just before the
// recompile is still recognised. These names carry no account, so they are never
// adopted, refreshed or deleted here: acting on one would mean acting on a mark that
// may belong to another account, which is the failure this version exists to remove.
// MQL5 renews a variable's four-week life on every read, so a legacy mark still being
// consulted stays alive and one nothing has asked about for four weeks is discarded.
string LegacyLifecycleIdempotencyVariable(SignalCommand &command, ulong ticket = 0)
{
   return StringSubstr(LEGACY_LIFECYCLE_MARK_PREFIX + LifecycleCommandKey(command) + "." + IntegerToString(ticket), 0, 63);
}

// Three reads across two name formats, not three formats.
//
// The first is the name this version writes, keyed by the position identifier. The
// second is that same format keyed by the position's current ticket, which is what
// 1.67 wrote. The two numbers are equal for a position the server never re-opened, so
// the second read is skipped entirely in the ordinary case and only does work after a
// replacement. It cannot answer for the wrong position: MT5 issues order tickets from
// one never-reused sequence per account and an identifier is a ticket from that same
// sequence, so no live position's ticket can equal another's identifier. Both are
// scoped to this account and this command before they are hashed.
//
// The third is the pre-1.67 plaintext name, unchanged.
//
// The second read can be dropped once no mark a 1.67 EA wrote can still be live, which
// is four weeks after the last terminal on 1.67 is rebuilt.
bool LifecycleAlreadyExecuted(SignalCommand &command, ulong identifier = 0, ulong ticket = 0)
{
   if(GlobalVariableCheck(LifecycleIdempotencyVariable(command, identifier)))
      return true;
   if(ticket != identifier && GlobalVariableCheck(LifecycleIdempotencyVariable(command, ticket)))
      return true;
   return GlobalVariableCheck(LegacyLifecycleIdempotencyVariable(command, ticket));
}

void MarkLifecycleExecuted(SignalCommand &command, ulong identifier = 0)
{
   string variable = LifecycleIdempotencyVariable(command, identifier);
   datetime writtenAt = TimeCurrent();
   // Write the mark first and register it second. The mark is what stops a second
   // close on a live account, so a full registry must never prevent one being recorded.
   if(GlobalVariableSet(variable, (double)writtenAt) == 0)
   {
      PrintFormat("Telegram TC lifecycle mark NOT recorded variable=%s queue=%s position=%I64u error=%d",
         variable,
         command.queueItemId,
         identifier,
         GetLastError());
      return;
   }
   // Only position-scoped marks are tracked. A command-scoped mark (CANCEL_PENDING) has
   // nothing observable to bound it: no position to watch, and no age at which the EA
   // can prove the server will not ask again. It is left to the terminal's four-week
   // expiry, which renews on every read, so one still being consulted survives and one
   // nothing has asked about is discarded. That is the pre-1.67 behaviour for this one
   // category.
   if(identifier == 0)
      return;
   // Just written, so its four-week clock starts now.
   RegisterLifecycleMark(variable, LifecycleAccountIdentity(), identifier, true, TimeLocal());
}

// Slots are recycled in place and lifecycleMarkCount is a high-water mark that only
// grows, so ReclaimLifecycleMarks can release an entry mid-pass without shifting
// anything under its own index walk.
//
// Returns false when the mark could not be tracked. The caller must not treat that as
// success: an untracked mark still guards its trade but is never refreshed, so it
// expires at four weeks even though its position may still be open.
bool RegisterLifecycleMark(string variable, string identity, ulong identifier, bool owned, datetime refreshedAt)
{
   int freeSlot = -1;
   int adoptedSlot = -1;
   for(int index = 0; index < lifecycleMarkCount; index++)
   {
      if(lifecycleMarks[index].active && lifecycleMarks[index].variable == variable)
      {
         // Ownership only ever ratchets up. An adopted entry that this session then
         // writes to becomes owned; nothing may take that right away again.
         lifecycleMarks[index].owned = lifecycleMarks[index].owned || owned;
         lifecycleMarks[index].identity = identity;
         lifecycleMarks[index].positionIdentifier = identifier;
         lifecycleMarks[index].refreshedAt = refreshedAt;
         lifecycleMarks[index].absentPasses = 0;
         return true;
      }
      if(freeSlot < 0 && !lifecycleMarks[index].active)
         freeSlot = index;
      if(adoptedSlot < 0 && lifecycleMarks[index].active && !lifecycleMarks[index].owned)
         adoptedSlot = index;
   }
   if(freeSlot < 0 && lifecycleMarkCount < ArraySize(lifecycleMarks))
   {
      freeSlot = lifecycleMarkCount;
      lifecycleMarkCount++;
   }
   // Adoption can fill the registry with marks from previous sessions; live positions
   // never will. So a mark this session just wrote outranks an adopted one and takes
   // its slot. Releasing an adopted entry stops its refresh and nothing else, since
   // nothing may delete an adopted mark's variable anyway.
   if(freeSlot < 0 && owned && adoptedSlot >= 0)
   {
      PrintFormat("Telegram TC lifecycle mark registry full (%d slots). Dropped refresh tracking for adopted %s to track owned %s",
         ArraySize(lifecycleMarks),
         lifecycleMarks[adoptedSlot].variable,
         variable);
      ReleaseLifecycleMarkSlot(adoptedSlot);
      freeSlot = adoptedSlot;
   }
   if(freeSlot < 0)
   {
      // Degrades to the pre-1.67 behaviour for this one mark: it still guards the
      // trade, it just waits for the terminal's four-week expiry instead of the sweep.
      PrintFormat("Telegram TC lifecycle mark registry full (%d slots). %s is not tracked and will not be refreshed",
         ArraySize(lifecycleMarks),
         variable);
      return false;
   }
   lifecycleMarks[freeSlot].active = true;
   lifecycleMarks[freeSlot].owned = owned;
   lifecycleMarks[freeSlot].variable = variable;
   lifecycleMarks[freeSlot].identity = identity;
   lifecycleMarks[freeSlot].positionIdentifier = identifier;
   lifecycleMarks[freeSlot].refreshedAt = refreshedAt;
   lifecycleMarks[freeSlot].absentPasses = 0;
   return true;
}

void ReleaseLifecycleMarkSlot(int index)
{
   lifecycleMarks[index].active = false;
   lifecycleMarks[index].owned = false;
   lifecycleMarks[index].variable = "";
   lifecycleMarks[index].identity = "";
   lifecycleMarks[index].positionIdentifier = 0;
   lifecycleMarks[index].refreshedAt = 0;
   lifecycleMarks[index].absentPasses = 0;
}

bool IsHexRun(string text, int length)
{
   if(StringLen(text) != length)
      return false;
   for(int index = 0; index < length; index++)
   {
      ushort code = StringGetCharacter(text, index);
      bool digit = code >= '0' && code <= '9';
      bool upper = code >= 'A' && code <= 'F';
      if(!digit && !upper)
         return false;
   }
   return true;
}

// A name this EA wrote is exactly prefix + 8 hex + '.' + 16 hex + '.' + a decimal
// position identifier. Every segment is validated rather than assumed, so a variable
// that merely starts with the reserved prefix is not adopted, and a mark is never
// reclaimed on a guess about which account or which position it belongs to.
//
// A name a 1.67 EA wrote parses identically and yields a ticket where this reads an
// identifier. That is harmless: the two are the same number unless the server replaced
// the ticket, and an adopted entry is never deletable, so the worst outcome is that
// such a mark stops being refreshed and falls back to the terminal's own expiry.
bool ParseLifecycleMarkName(string variable, string &accountTagText, ulong &identifier)
{
   accountTagText = "";
   identifier = 0;
   int prefixLength = StringLen(LIFECYCLE_MARK_PREFIX);
   int tagEnd = StringFind(variable, ".", prefixLength);
   if(tagEnd != prefixLength + 8)
      return false;
   int hashEnd = StringFind(variable, ".", tagEnd + 1);
   if(hashEnd != tagEnd + 17)
      return false;
   string tagText = StringSubstr(variable, prefixLength, 8);
   string hashText = StringSubstr(variable, tagEnd + 1, 16);
   string digits = StringSubstr(variable, hashEnd + 1);
   if(!IsHexRun(tagText, 8) || !IsHexRun(hashText, 16) || digits == "")
      return false;
   identifier = (ulong)StringToInteger(digits);
   if(IntegerToString((long)identifier) != digits)
      return false;
   accountTagText = tagText;
   return true;
}

// A terminal restart, a recompile and an account switch all keep the global variables
// and lose this registry. Marks left by an earlier session are adopted so the weekly
// refresh keeps covering them, because a requeued command replays the original
// idempotency key at any age and a mark guarding a still-open position must outlive
// the terminal's four-week expiry.
//
// Adoption grants the right to extend a mark's life and nothing else. Adopted entries
// are not owned, so no path here can ever delete one. That is why matching on the
// lossy tag is safe: the worst a wrong match can do is keep a stranger's mark alive
// a while longer.
void RehydrateLifecycleMarks()
{
   // A login of zero means the terminal has not resolved an account yet. Adopting
   // against that identity would match every mark written under the same blank, so
   // nothing is adopted and nothing is cleared: the timer retries until a real login
   // appears. This runs before any clearing so a retry cannot destroy a good registry.
   if(AccountInfoInteger(ACCOUNT_LOGIN) == 0)
   {
      Print("Telegram TC: no account login yet, lifecycle mark adoption deferred to the next sweep");
      return;
   }

   // Drop adopted entries and rebuild them, so an account switch cannot carry the
   // previous account's guesses into this one. Owned entries are kept: this session
   // wrote them, re-adoption could only downgrade them to undeletable, and the
   // per-pass identity check already neutralises any that belong to another account.
   for(int index = 0; index < lifecycleMarkCount; index++)
      if(lifecycleMarks[index].active && !lifecycleMarks[index].owned)
         ReleaseLifecycleMarkSlot(index);

   string currentTag = StringFormat("%08X", LifecycleAccountTag());
   string identity = LifecycleAccountIdentity();
   int total = GlobalVariablesTotal();
   int adopted = 0;
   int skipped = 0;
   int untracked = 0;
   for(int index = 0; index < total; index++)
   {
      string name = GlobalVariableName(index);
      if(StringFind(name, LIFECYCLE_MARK_PREFIX) != 0)
         continue;
      string tagText = "";
      ulong identifier = 0;
      if(!ParseLifecycleMarkName(name, tagText, identifier))
         continue;
      if(tagText != currentTag || identifier == 0)
      {
         skipped++;
         continue;
      }
      // refreshedAt 0 means the first sweep rewrites it. An adopted mark may already be
      // most of the way through its four weeks, so its expiry is pushed back on sight
      // rather than a refresh interval later.
      if(RegisterLifecycleMark(name, identity, identifier, false, 0))
         adopted++;
      else
         untracked++;
   }

   // Only a pass that tracked everything it found counts as done. Anything dropped for
   // want of a slot must be retried, because a mark nothing refreshes expires at four
   // weeks whether or not its position is still open.
   LifecycleMarksAdopted = untracked == 0;

   string report = StringFormat("Telegram TC lifecycle marks: adopted %d for refresh under tag %s, left %d untouched, %d untracked",
      adopted,
      currentTag,
      skipped,
      untracked);
   // The retry re-runs this every sweep, so only say something when it changed.
   if((adopted > 0 || skipped > 0 || untracked > 0) && report != LastLifecycleAdoptionReport)
   {
      Print(report);
      LastLifecycleAdoptionReport = report;
   }
}

// Reclamation is positive: a mark is deleted only when this EA instance wrote it in
// this session and can see that its position is gone. It is never deleted because the
// EA failed to prove it belonged to somebody else.
//
// That matters because terminal global variables are shared across accounts while
// position tickets are not, so a live position on account A reads as absent while the
// terminal is on account B. Trying to detect that from the name would put the whole
// safety argument on an account tag that is a lossy 64-to-32 fold, and on a hash that
// no reader can verify. Requiring ownership instead makes cross-account deletion
// impossible by construction: this EA is logged into one account and only ever writes
// marks for that account, so anything it owns is its own.
//
// Within an account the old argument still carries the rest: a tracked mark is only
// read for a position CollectPositionTargets returned, and that only returns positions
// the terminal still holds open, so once the position is gone the mark can never be
// consulted again and removing it cannot lose idempotency.

// MQL5 offers no select-by-identifier, and PositionSelectByTicket is exactly what a
// replaced ticket defeats, so liveness is answered from a list instead of a lookup.
// Collected once per sweep rather than once per mark: 512 marks driving their own scans
// would re-select every open position 512 times for the same answer.
int CollectOpenPositionIdentifiers(ulong &identifiers[])
{
   ArrayResize(identifiers, 0);
   int total = PositionsTotal();
   for(int index = 0; index < total; index++)
   {
      ulong ticket = PositionGetTicket(index);
      if(ticket == 0 || !PositionSelectByTicket(ticket))
         continue;
      int next = ArraySize(identifiers);
      ArrayResize(identifiers, next + 1);
      // The same rule the mark was written under, so the two sides cannot drift.
      identifiers[next] = PositionMarkKey(ticket);
   }
   return ArraySize(identifiers);
}

bool HoldsPositionIdentifier(ulong &identifiers[], int count, ulong identifier)
{
   for(int index = 0; index < count; index++)
      if(identifiers[index] == identifier)
         return true;
   return false;
}

void ReclaimLifecycleMarks()
{
   string identity = LifecycleAccountIdentity();
   datetime now = TimeLocal();
   // Only deciding that a position is gone needs a live connection. Rewriting a
   // terminal global does not, and a long disconnection is precisely when a mark is
   // most at risk of expiring, so the refresh arm runs either way and only the
   // removal arm is gated.
   bool connected = TerminalInfoInteger(TERMINAL_CONNECTED) != 0;
   // Read only by the removal arm, which a disconnection stops anyway.
   ulong openIdentifiers[];
   int openIdentifierCount = 0;
   if(connected)
      openIdentifierCount = CollectOpenPositionIdentifiers(openIdentifiers);
   for(int index = 0; index < lifecycleMarkCount; index++)
   {
      if(!lifecycleMarks[index].active)
         continue;

      bool sameAccount = lifecycleMarks[index].identity == identity;
      bool live = connected && sameAccount
         && HoldsPositionIdentifier(openIdentifiers, openIdentifierCount, lifecycleMarks[index].positionIdentifier);

      // Anything this EA believes is its own gets its expiry pushed back, whether or
      // not the position can be seen right now. Refreshing only ever extends a mark's
      // life, so a wrong guess here leaks; refusing to refresh loses a live guard.
      // Only a rewrite the terminal confirmed may advance the clock: recording a
      // refresh that did not happen would let the mark quietly expire anyway.
      // A clock that jumped backwards makes elapsed time negative. Read that as due
      // rather than as not-yet: refreshing early costs nothing, refreshing late loses
      // the mark.
      bool refreshDue = lifecycleMarks[index].refreshedAt == 0
         || now < lifecycleMarks[index].refreshedAt
         || now - lifecycleMarks[index].refreshedAt >= LIFECYCLE_MARK_REFRESH_SECONDS;
      if((lifecycleMarks[index].owned || sameAccount) && refreshDue
         && GlobalVariableSet(lifecycleMarks[index].variable, (double)TimeCurrent()) != 0)
         lifecycleMarks[index].refreshedAt = now;

      // Everything below removes something. None of it may run without a connection to
      // confirm the position is gone, nor against an account this entry was not
      // registered under. The entry is kept rather than released so returning to that
      // account resumes exactly where it left off, with no reinitialisation required.
      if(!connected || !sameAccount)
         continue;
      if(live)
      {
         lifecycleMarks[index].absentPasses = 0;
         continue;
      }
      // One absent reading is not proof. The position must be absent on this many
      // consecutive sweeps, which a reconnect blip cannot span. Counting passes rather
      // than seconds keeps every clock out of the only path that deletes anything.
      lifecycleMarks[index].absentPasses++;
      if(lifecycleMarks[index].absentPasses < LIFECYCLE_MARK_ABSENT_PASSES)
         continue;

      // The whole safety argument reduces to this line. Only a mark this session
      // wrote is deleted, so no name, tag or hash has to be trusted to decide whose
      // a variable is. An adopted entry loses its tracking and nothing else, and the
      // terminal's four-week expiry remains its owner's backstop.
      if(lifecycleMarks[index].owned)
         GlobalVariableDel(lifecycleMarks[index].variable);
      ReleaseLifecycleMarkSlot(index);
   }
}

string AccountPayload()
{
   string marginMode = AccountInfoInteger(ACCOUNT_MARGIN_MODE) == ACCOUNT_MARGIN_MODE_RETAIL_HEDGING
      ? "HEDGING"
      : "NETTING";
   return StringFormat(
      "{\"accountNumber\":\"%I64d\",\"server\":\"%s\",\"company\":\"%s\",\"currency\":\"%s\",\"balance\":%.2f,\"equity\":%.2f,\"profit\":%.2f,\"marginMode\":\"%s\",\"availableSymbols\":%s,\"eaVersion\":\"%s\",\"eaCapabilities\":%s,\"linkCode\":\"%s\"}",
      AccountInfoInteger(ACCOUNT_LOGIN),
      JsonEscape(AccountInfoString(ACCOUNT_SERVER)),
      JsonEscape(AccountInfoString(ACCOUNT_COMPANY)),
      JsonEscape(AccountInfoString(ACCOUNT_CURRENCY)),
      AccountInfoDouble(ACCOUNT_BALANCE),
      AccountInfoDouble(ACCOUNT_EQUITY),
      AccountInfoDouble(ACCOUNT_PROFIT),
      marginMode,
      SymbolsJson(),
      "1.67.0",
      EaCapabilitiesJson,
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
