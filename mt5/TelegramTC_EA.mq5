//+------------------------------------------------------------------+
//| Telegram TC Expert Advisor                                       |
//| Polls the Telegram TC backend for normalized trade instructions. |
//+------------------------------------------------------------------+
#property copyright "Telegram TC"
#property version   "2.0.0"
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
   string identity;
   string symbol;
   string direction;
   ulong positionTicket;
   double distance;
   int absentPasses;
};

struct ExecutionSummary
{
   int attempted;
   int completed;
   int rejected;
   int uncertain;
   int partial;
   double requestedVolume;
   double filledVolume;
   double remainingVolume;
   uint retcode;
   int retcodeExternal;
   string brokerComment;
   ulong orderTicket;
   ulong positionTicket;
   ulong dealTicket;
   double requestedPrice;
   double filledPrice;
   string errorText;
   string executionsJson;
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
// is deliberately a count and not a duration: the sweep runs on a fixed timer, so
// counting passes buys a controlled window without trusting a clock that a backward
// NTP step or a manual correction could collapse. Refresh may use elapsed time because
// a three-week window absorbs any plausible jump; a five-minute grace would not, and
// this is the path that deletes.
#define LIFECYCLE_MARK_ABSENT_PASSES 10
#define TRAILING_PLAN_PREFIX "TelegramTC.tp."
#define TRAILING_PLAN_ABSENT_PASSES 10
// The terminal deletes a global variable four weeks after its last use, so a mark
// guarding a still-open position is rewritten well inside that window.
#define LIFECYCLE_MARK_REFRESH_SECONDS 604800
#define LIFECYCLE_MARK_SWEEP_SECONDS 30
// Clamp backend polling independently of the one-second protection timer.
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
   ulong positionTicket;   // always > 0: only ticket-scoped marks are tracked
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
ulong LastRegistrationAttemptAtMs = 0;
string RegisteredLifecycleIdentity = "";
string ActiveLifecycleIdentity = "";
bool HistoryUploadDue = false;
int LastHttpPhase = -1;
ulong LastPollAttemptAtMs = 0;
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

bool LifecycleIdentityReady()
{
   return AccountInfoInteger(ACCOUNT_LOGIN) > 0
      && AccountInfoString(ACCOUNT_SERVER) != ""
      && AccountInfoString(ACCOUNT_COMPANY) != "";
}

void UpdateLifecycleAccountContext()
{
   if(!LifecycleIdentityReady())
      return;
   string identity = LifecycleAccountIdentity();
   if(identity == ActiveLifecycleIdentity)
      return;

   ActiveLifecycleIdentity = identity;
   RegisteredLifecycleIdentity = "";
   LastRegistrationAttemptAtMs = 0;
   LastHeartbeatSentAt = 0;
   LastHistoryBackfillAt = 0;
   HistoryUploadDue = true;
   LastHttpPhase = -1;
   LastPollAttemptAtMs = 0;
   LifecycleMarksAdopted = false;
   LastLifecycleReclaimAt = 0;
   for(int index = 0; index < trailingStopStateCount; index++)
      ReleaseTrailingStopSlot(index);
   trailingStopStateCount = 0;
}

bool AccountConnected()
{
   return LifecycleIdentityReady() && TerminalInfoInteger(TERMINAL_CONNECTED) != 0;
}

bool BrokerReady()
{
   if(!AccountConnected())
      return false;
   if(!SymbolIsSynchronized(_Symbol))
      return false;
   long seriesSynchronized = 0;
   if(!SeriesInfoInteger(_Symbol, _Period, SERIES_SYNCHRONIZED, seriesSynchronized))
      return false;
   return seriesSynchronized != 0;
}

bool CanTrade()
{
   return AccountConnected()
      && ActiveLifecycleIdentity == LifecycleAccountIdentity()
      && MQLInfoInteger(MQL_TRADE_ALLOWED) != 0
      && TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) != 0
      && AccountInfoInteger(ACCOUNT_TRADE_ALLOWED) != 0;
}

int OnInit()
{
   CurrentPollSeconds = ClampPollSeconds(PollSeconds);
   if(StringFind(BackendBaseUrl, "your-api-host.example.com") >= 0 || BackendBaseUrl == "")
      Print("Telegram TC: set BackendBaseUrl to your deployed API /api URL before enabling live polling.");
   if(LinkCode == "")
      Print("Telegram TC: LinkCode is empty — registrations will land in an unlabelled slot. Paste the link code from the App's Linked Accounts page.");
   if(!EventSetTimer(1))
      return INIT_FAILED;
   UpdateLifecycleAccountContext();
   RehydrateLifecycleMarks();
   return(INIT_SUCCEEDED);
}

void OnDeinit(const int reason)
{
   EventKillTimer();
}

void OnTimer()
{
   datetime now = TimeLocal();
   UpdateLifecycleAccountContext();
   if(!LifecycleMarksAdopted)
      RehydrateLifecycleMarks();
   // now < LastLifecycleReclaimAt means the clock went backwards. Sweep instead of
   // waiting for it to catch up, or a large backward correction would stall refreshes
   // for as long as the jump.
   if(LastLifecycleReclaimAt == 0
      || now < LastLifecycleReclaimAt
      || now - LastLifecycleReclaimAt >= LIFECYCLE_MARK_SWEEP_SECONDS)
   {
      ReclaimLifecycleMarks();
      LastLifecycleReclaimAt = now;
   }

   if(AccountConnected())
      RestoreTrailingStopPlans();
   if(CanTrade())
      ManageTrailingStops();

   if(!BrokerReady())
      return;

   string identity = LifecycleAccountIdentity();
   if(RegisteredLifecycleIdentity != identity)
   {
      ulong nowMs = GetTickCount64();
      if(LastRegistrationAttemptAtMs == 0 || nowMs - LastRegistrationAttemptAtMs >= 5000)
      {
         LastRegistrationAttemptAtMs = nowMs;
         if(RegisterAccount())
            RegisteredLifecycleIdentity = identity;
      }
      return;
   }

   bool heartbeatDue = LastHeartbeatSentAt == 0
      || now < LastHeartbeatSentAt
      || now - LastHeartbeatSentAt >= MathMax(1, HeartbeatSeconds);
   bool historyDue = HistoryUploadDue
      || LastHistoryBackfillAt == 0
      || now < LastHistoryBackfillAt
      || now - LastHistoryBackfillAt >= MathMax(1, HistoryBackfillSeconds);
   int selectedPhase = -1;
   for(int offset = 1; offset <= 4; offset++)
   {
      int phase = (LastHttpPhase + offset) % 4;
      if(phase == 0 && !heartbeatDue)
         continue;
      if(phase == 2 && (!CanTrade() || (LastPollAttemptAtMs != 0
         && GetTickCount64() - LastPollAttemptAtMs < (ulong)CurrentPollSeconds * 1000)))
         continue;
      if(phase == 3 && !historyDue)
         continue;
      selectedPhase = phase;
      break;
   }
   if(selectedPhase < 0)
      return;

   LastHttpPhase = selectedPhase;
   if(selectedPhase == 0)
   {
      LastHeartbeatSentAt = now;
      SendHeartbeat();
   }
   else if(selectedPhase == 1)
      SendSnapshot();
   else if(selectedPhase == 2)
      PollAndExecute();
   else
   {
      LastHistoryBackfillAt = now;
      if(SendHistoryDeals())
         HistoryUploadDue = false;
   }
}

void OnTradeTransaction(const MqlTradeTransaction &trans,
                        const MqlTradeRequest &request,
                        const MqlTradeResult &result)
{
   if(trans.type != TRADE_TRANSACTION_DEAL_ADD || trans.deal == 0)
      return;
   HistoryUploadDue = true;
}

bool RegisterAccount()
{
   if(!BrokerReady())
      return false;
   string body = AccountPayload();
   string response = "";
   return HttpPost("/mt5/register", body, response);
}

void SendHeartbeat()
{
   if(!BrokerReady())
      return;
   string body = StringFormat(
      "{\"accountId\":\"mt5-%I64d\",\"brokerReady\":true,\"balance\":%.2f,\"equity\":%.2f,\"profit\":%.2f,\"availableSymbols\":%s,\"eaVersion\":\"%s\",\"eaCapabilities\":%s,\"linkCode\":\"%s\"}",
      AccountInfoInteger(ACCOUNT_LOGIN),
      AccountInfoDouble(ACCOUNT_BALANCE),
      AccountInfoDouble(ACCOUNT_EQUITY),
      AccountInfoDouble(ACCOUNT_PROFIT),
      SymbolsJson(),
      "2.0.0",
      EaCapabilitiesJson,
      JsonEscape(LinkCode)
   );
   string response = "";
   int httpStatus = 0;
   HttpPost("/mt5/heartbeat", body, response, httpStatus);
   if(httpStatus == 404 && StringFind(response, "MT5 account not found") >= 0)
      RegisteredLifecycleIdentity = "";
}

void SendSnapshot()
{
   if(!BrokerReady())
      return;
   string body = StringFormat(
      "{\"accountId\":\"mt5-%I64d\",\"brokerReady\":true,\"positions\":%s,\"orders\":%s,\"symbols\":%s}",
      AccountInfoInteger(ACCOUNT_LOGIN),
      PositionsJson(),
      OrdersJson(),
      SymbolsMarketJson()
   );
   string response = "";
   int httpStatus = 0;
   HttpPost("/mt5/snapshot", body, response, httpStatus);
   if(httpStatus == 404)
      RegisteredLifecycleIdentity = "";
}

bool SendHistoryDeals()
{
   datetime toTime = TimeTradeServer();
   if(toTime <= 0)
      return false;
   datetime fromTime = toTime - MathMax(1, HistoryLookbackHours) * 3600;
   if(!HistorySelect(fromTime, toTime))
      return false;
   string body = StringFormat(
      "{\"accountId\":\"mt5-%I64d\",\"deals\":%s}",
      AccountInfoInteger(ACCOUNT_LOGIN),
      HistoryDealsJson()
   );
   string response = "";
   return HttpPost("/mt5/history", body, response);
}

void PollAndExecute()
{
   if(!CanTrade())
      return;
   LastPollAttemptAtMs = GetTickCount64();
   string pollIdentity = LifecycleAccountIdentity();
   string url = StringFormat("/mt5/poll-line?accountId=mt5-%I64d", AccountInfoInteger(ACCOUNT_LOGIN));
   string response = "";
   if(!HttpGet(url, response))
      return;

   ApplyPollConfig(response);

   if(StringFind(response, "status=WORK") < 0)
      return;

   if(!CanTrade() || LifecycleAccountIdentity() != pollIdentity)
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
   if(!CanTrade())
   {
      ReportUnknown(command.queueItemId, "Trading is not ready; reconcile broker state before retry", command.brokerSymbol);
      return false;
   }
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
   if(request.volume <= 0.0)
   {
      ReportFailure(command.queueItemId, "Invalid volume or unavailable broker volume metadata", command.brokerSymbol);
      return false;
   }
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
      request.price = NormalizePriceToTick(command.brokerSymbol, command.entryFrom, PendingOrderPriceRoundsUp(command));
      if(request.price <= 0.0)
      {
         ReportFailure(command.queueItemId, "Pending order price is outside the broker tick grid", command.brokerSymbol);
         return false;
      }
      request.type_time = ORDER_TIME_GTC;
      request.type_filling = FillingModeForSymbol(command.brokerSymbol, true);
      request.type = PendingOrderType(command.direction, command.orderType);
   }
   else
   {
      request.action = TRADE_ACTION_DEAL;
      request.type_filling = FillingModeForSymbol(command.brokerSymbol, false);
      request.type = command.direction == "BUY" ? ORDER_TYPE_BUY : ORDER_TYPE_SELL;
      request.price = NormalizePriceToTick(command.brokerSymbol, MarketReferencePrice(command), command.direction == "BUY");
   }

   // EnsureSymbol guarantees a fresh tick, so defaults and market pricing use
   // a non-zero quote rather than opening an unprotected market position.
   double referencePrice = request.price;
   if(referencePrice <= 0.0)
      referencePrice = MarketReferencePrice(command);
   if(referencePrice <= 0.0)
   {
      ReportUnknown(command.queueItemId, "No fresh execution quote available; reconcile before retry", command.brokerSymbol);
      return false;
   }
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

   double stopReferencePrice = request.action == TRADE_ACTION_PENDING
      ? request.price
      : StopReferencePrice(command.brokerSymbol, command.direction);
   if(stopReferencePrice <= 0.0)
   {
      ReportUnknown(command.queueItemId, "No fresh stop reference quote available; reconcile before retry", command.brokerSymbol);
      return false;
   }
   request.sl = SafeStopPrice(command.brokerSymbol, stopReferencePrice, command.stopLoss, command.direction, true);
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
      ? SafeStopPrice(command.brokerSymbol, stopReferencePrice, rawTp, command.direction, false)
      : 0.0;
   if((command.stopLoss > 0.0 && request.sl <= 0.0) || (rawTp > 0.0 && request.tp <= 0.0))
   {
      ReportFailure(command.queueItemId, "Protective stop price is invalid for the broker quote or tick grid", command.brokerSymbol);
      return false;
   }

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

   bool confirmedDeal = sent && (result.retcode == TRADE_RETCODE_DONE || result.retcode == TRADE_RETCODE_DONE_PARTIAL);
   double filledVolume = request.action == TRADE_ACTION_PENDING || !confirmedDeal ? 0.0 : result.volume;
   double remainingVolume = request.action == TRADE_ACTION_PENDING
      ? request.volume
      : MathMax(0.0, request.volume - filledVolume);
   string executionStatus = sent && request.action == TRADE_ACTION_PENDING && result.retcode == TRADE_RETCODE_PLACED
      ? "EXECUTED" : ExecutionStatus(sent, result.retcode);
   ReportWithVolumes(
      command.queueItemId,
      executionStatus,
      result.retcode,
      result.retcode_external,
      result.comment,
      result.order,
      ResultPositionTicket(result),
      result.deal,
      request.price,
      result.price,
      request.volume,
      filledVolume,
      remainingVolume,
      sent ? "" : IntegerToString(sendErr),
      ""
   );
   return executionStatus == "EXECUTED";
}

bool ExecuteSplitOrders(SignalCommand &command)
{
   ExecutionSummary summary;
   InitExecutionSummary(summary);
   double baseVolume = CommandBaseVolume(command);
   bool pendingOrder = command.orderType == "LIMIT" || command.orderType == "STOP";
   double referencePrice = pendingOrder
      ? NormalizePriceToTick(command.brokerSymbol, command.entryFrom, PendingOrderPriceRoundsUp(command))
      : MarketReferencePrice(command);
   if(referencePrice <= 0.0)
   {
      ReportUnknown(command.queueItemId, "No fresh execution quote available; reconcile before retry", command.brokerSymbol);
      return false;
   }
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
      int legNumber = leg + 1;
      if(request.volume <= 0.0)
      {
         AddExecution(summary, "FAILED", 0, 0, "Invalid volume or unavailable broker volume metadata", 0, 0, 0,
            0.0, 0.0, request.volume, 0.0, 0.0, "Split leg volume is invalid", legNumber);
         continue;
      }
      request.deviation = DeviationPoints;
      request.comment = CompactTradeTpComment(command.logicalTradeId, leg + 1);
      LogTradeIdentity(command.logicalTradeId, "tp" + IntegerToString(leg + 1), request.comment);

      if(command.orderType == "LIMIT" || command.orderType == "STOP")
      {
         if(!ValidatePendingOrderPrice(command))
         {
            AddExecution(summary, "FAILED", 0, 0, "Invalid split pending order price", 0, 0, 0,
               command.entryFrom, 0.0, request.volume, 0.0, request.volume,
               "Pending price is invalid for current bid/ask or stop level", legNumber);
            continue;
         }
         request.action = TRADE_ACTION_PENDING;
         request.price = NormalizePriceToTick(command.brokerSymbol, command.entryFrom, PendingOrderPriceRoundsUp(command));
         if(request.price <= 0.0)
         {
            AddExecution(summary, "FAILED", 0, 0, "Invalid pending order tick grid", 0, 0, 0,
               command.entryFrom, 0.0, request.volume, 0.0, request.volume,
               "Pending price is outside the broker tick grid", legNumber);
            continue;
         }
         request.type_time = ORDER_TIME_GTC;
         request.type_filling = FillingModeForSymbol(command.brokerSymbol, true);
         request.type = PendingOrderType(command.direction, command.orderType);
      }
      else
      {
         request.action = TRADE_ACTION_DEAL;
         request.type_filling = FillingModeForSymbol(command.brokerSymbol, false);
         request.type = command.direction == "BUY" ? ORDER_TYPE_BUY : ORDER_TYPE_SELL;
         request.price = NormalizePriceToTick(command.brokerSymbol, MarketReferencePrice(command), command.direction == "BUY");
         if(request.price <= 0.0)
         {
            AddExecution(summary, "UNKNOWN", 0, 0, "No fresh execution quote", 0, 0, 0,
               0.0, 0.0, request.volume, 0.0, request.volume,
               "Fresh quote disappeared before split leg submission", legNumber);
            continue;
         }
      }

      double stopReferencePrice = request.action == TRADE_ACTION_PENDING
         ? request.price
         : StopReferencePrice(command.brokerSymbol, command.direction);
      if(stopReferencePrice <= 0.0)
      {
         AddExecution(summary, "UNKNOWN", 0, 0, "No fresh stop reference quote", 0, 0, 0,
            request.price, 0.0, request.volume, 0.0, request.volume,
            "Fresh quote disappeared before split leg submission", legNumber);
         continue;
      }
      request.sl = SafeStopPrice(command.brokerSymbol, stopReferencePrice, command.stopLoss, command.direction, true);
      request.tp = SafeStopPrice(command.brokerSymbol, stopReferencePrice, command.tp[leg], command.direction, false);
      if((command.stopLoss > 0.0 && request.sl <= 0.0) || request.tp <= 0.0)
      {
         AddExecution(summary, "FAILED", 0, 0, "Invalid protective stop price", 0, 0, 0,
            request.price, 0.0, request.volume, 0.0, request.volume, "Stop price is invalid for broker quote or tick grid", legNumber);
         continue;
      }

      bool sent = OrderSend(request, result);
      int sendErr = sent ? 0 : GetLastError();
      bool confirmedDeal = sent && (result.retcode == TRADE_RETCODE_DONE || result.retcode == TRADE_RETCODE_DONE_PARTIAL);
      double filledVolume = request.action == TRADE_ACTION_PENDING || !confirmedDeal ? 0.0 : result.volume;
      double remainingVolume = request.action == TRADE_ACTION_PENDING
         ? request.volume
         : MathMax(0.0, request.volume - filledVolume);
      AddExecution(summary,
         (sent && request.action == TRADE_ACTION_PENDING && result.retcode == TRADE_RETCODE_PLACED)
            ? "EXECUTED" : ExecutionStatus(sent, result.retcode),
         result.retcode,
         result.retcode_external,
         result.comment,
         result.order,
         ResultPositionTicket(result),
         result.deal,
         request.price,
         confirmedDeal ? result.price : 0.0,
         request.volume,
         filledVolume,
         remainingVolume,
         sent ? "" : IntegerToString(sendErr),
         legNumber);
   }

   if(summary.attempted == 0)
      ReportUnknown(command.queueItemId, "No TP legs could be submitted; reconcile execution plan", command.commandType);
   else
      ReportExecutionSummary(command, summary, "");
   return ExecutionSummaryStatus(summary) == "EXECUTED";
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
      ReportUnknown(command.queueItemId, "No matching pending order found; reconcile broker snapshot/history", command.brokerSymbol);
      return;
   }
   int removed = 0;
   int provenRejected = 0;
   int uncertain = 0;
   MqlTradeResult lastResult = {};
   for(int index = 0; index < found; index++)
   {
      MqlTradeResult result = {};
      bool requestSent = false;
      string errorText = "";
      if(RemovePendingOrder(command, tickets[index], result, requestSent, errorText))
         removed++;
      else if(IsProvenOrderRejection(result.retcode))
         provenRejected++;
      else
         uncertain++;
      lastResult = result;
   }
   if(removed == found)
   {
      MarkLifecycleExecuted(command);
      Report(command.queueItemId, "EXECUTED", lastResult.retcode, lastResult.retcode_external, lastResult.comment, lastResult.order, 0, lastResult.deal, 0, lastResult.price, 0.0, "");
      return;
   }
   string status = removed > 0 ? "PARTIAL" : (provenRejected == found && uncertain == 0 ? "FAILED" : "UNKNOWN");
   Report(command.queueItemId, status, lastResult.retcode, lastResult.retcode_external, lastResult.comment, lastResult.order, 0, lastResult.deal, 0, lastResult.price, 0.0, "Pending-order cancellation was not confirmed for every ticket; reconcile before retry");
}

bool RemovePendingOrder(SignalCommand &command, ulong ticket, MqlTradeResult &result,
   bool &requestSent, string &errorText)
{
   requestSent = false;
   errorText = "";
   if(!CanTrade())
   {
      result.comment = "Pending order removal is not ready; no request submitted";
      errorText = result.comment;
      return false;
   }
   MqlTradeRequest request = {};
   request.action = TRADE_ACTION_REMOVE;
   request.order = ticket;
   request.symbol = command.brokerSymbol;
   requestSent = OrderSend(request, result);
   int sendErr = requestSent ? 0 : GetLastError();
   if(!requestSent)
      errorText = IntegerToString(sendErr);
   else if(result.retcode != TRADE_RETCODE_DONE)
      errorText = result.comment;
   return requestSent && result.retcode == TRADE_RETCODE_DONE;
}

void ExecuteMoveSlToBreakeven(SignalCommand &command)
{
   ulong tickets[];
   int found = CollectPositionTickets(command, tickets);
   if(found <= 0)
   {
      ReportUnknown(command.queueItemId, "No matching position found; reconcile broker snapshot/history", command.brokerSymbol);
      return;
   }

   ExecutionSummary summary;
   InitExecutionSummary(summary);
   for(int index = 0; index < found; index++)
   {
      if(!PositionSelectByTicket(tickets[index]))
      {
         AddExecution(summary, "UNKNOWN", 0, 0, "Position disappeared before stop modification", 0, tickets[index], 0,
            0.0, 0.0, 0.0, 0.0, 0.0, "Reconcile broker snapshot/history");
         continue;
      }
      double openPrice = PositionGetDouble(POSITION_PRICE_OPEN);
      MqlTradeResult result = {};
      string status = "UNKNOWN";
      string errorText = "";
      double requestedPrice = 0.0;
      double requestedVolume = 0.0;
      ModifyPositionSl(command, tickets[index], openPrice, result, status, errorText, requestedPrice, requestedVolume);
      AddExecution(summary, status, result.retcode, result.retcode_external, result.comment,
         result.order, tickets[index], result.deal, requestedPrice, result.price,
         requestedVolume, 0.0, 0.0, errorText);
   }
   ReportExecutionSummary(command, summary, "");
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
      ReportUnknown(command.queueItemId, "No matching position found; reconcile broker snapshot/history", command.brokerSymbol);
      return;
   }
   ExecutionSummary summary;
   InitExecutionSummary(summary);
   for(int index = 0; index < found; index++)
   {
      MqlTradeResult result = {};
      string status = "UNKNOWN";
      string errorText = "";
      double requestedPrice = 0.0;
      double requestedVolume = 0.0;
      ModifyPositionSl(command, tickets[index], command.newStopLoss, result, status, errorText, requestedPrice, requestedVolume);
      AddExecution(summary, status, result.retcode, result.retcode_external, result.comment,
         result.order, tickets[index], result.deal, requestedPrice, result.price,
         requestedVolume, 0.0, 0.0, errorText);
   }
   ReportExecutionSummary(command, summary, "");
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
      ReportUnknown(command.queueItemId, "No matching position found; reconcile broker snapshot/history", command.brokerSymbol);
      return;
   }
   ExecutionSummary summary;
   InitExecutionSummary(summary);
   for(int index = 0; index < found; index++)
   {
      MqlTradeResult result = {};
      string status = "UNKNOWN";
      string errorText = "";
      double requestedPrice = 0.0;
      double requestedVolume = 0.0;
      ModifyPositionTp(command, tickets[index], takeProfit, result, status, errorText, requestedPrice, requestedVolume);
      AddExecution(summary, status, result.retcode, result.retcode_external, result.comment,
         result.order, tickets[index], result.deal, requestedPrice, result.price,
         requestedVolume, 0.0, 0.0, errorText);
   }
   ReportExecutionSummary(command, summary, "");
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
      ReportUnknown(command.queueItemId, "No matching position found; reconcile broker snapshot/history", command.brokerSymbol);
      return;
   }

   PrintFormat("Telegram TC TRAILING_STOP queue=%s logicalTradeId=%s symbol=%s distance=%.8f tickets=%d targetPosition=%I64u",
      command.queueItemId,
      command.logicalTradeId,
      command.brokerSymbol,
      distance,
      found,
      command.targetPositionTicket);

   ExecutionSummary summary;
   InitExecutionSummary(summary);
   for(int index = 0; index < found; index++)
   {
      ulong ticket = tickets[index];
      if(!PositionSelectByTicket(ticket))
      {
         AddExecution(summary, "UNKNOWN", 0, 0, "Position disappeared before trailing setup", 0, ticket, 0,
            0.0, 0.0, 0.0, 0.0, 0.0, "Reconcile broker snapshot/history");
         continue;
      }
      string trackError = "";
      if(!TrackTrailingStop(command, ticket, distance, trackError))
      {
         AddExecution(summary, "FAILED", 0, 0, trackError, 0, ticket, 0,
            0.0, 0.0, 0.0, 0.0, 0.0, trackError);
         continue;
      }
      MqlTradeResult result = {};
      string status = "UNKNOWN";
      string errorText = "";
      double requestedPrice = 0.0;
      double requestedVolume = 0.0;
      ApplyTrailingStopToTicket(command, ticket, distance, result, status, errorText, requestedPrice, requestedVolume);
      if(status == "FAILED")
      {
         // Tracking is durable even when the first broker adjustment is rejected.
         status = "PARTIAL";
         errorText = "Trailing plan remains active; initial stop adjustment not applied: " + errorText;
      }
      AddExecution(summary, status, result.retcode, result.retcode_external, result.comment,
         result.order, ticket, result.deal, requestedPrice, result.price,
         requestedVolume, 0.0, 0.0, errorText);
   }

   ReportExecutionSummary(command, summary, "");
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
   trailingStopStates[index].identity = "";
   trailingStopStates[index].symbol = "";
   trailingStopStates[index].direction = "";
   trailingStopStates[index].positionTicket = 0;
   trailingStopStates[index].distance = 0.0;
   trailingStopStates[index].absentPasses = 0;
}

string TrailingStopPlanVariable(string identity, ulong ticket)
{
   if(identity == "" || ticket == 0)
      return "";
   string scopedKey = identity + "|" + IntegerToString((long)ticket);
   ulong hash = LifecycleKeyHash(scopedKey);
   return StringFormat("%s%08X%08X.%I64u", TRAILING_PLAN_PREFIX,
      (uint)((hash >> 32) & 0xFFFFFFFF), (uint)(hash & 0xFFFFFFFF), ticket);
}

bool ParseTrailingStopPlanName(string name, string identity, ulong &ticket)
{
   ticket = 0;
   int prefixLength = StringLen(TRAILING_PLAN_PREFIX);
   if(StringFind(name, TRAILING_PLAN_PREFIX) != 0 || StringLen(name) <= prefixLength + 17)
      return false;
   string hashText = StringSubstr(name, prefixLength, 16);
   if(!IsHexRun(hashText, 16) || StringGetCharacter(name, prefixLength + 16) != '.')
      return false;
   string digits = StringSubstr(name, prefixLength + 17);
   if(digits == "")
      return false;
   ticket = (ulong)StringToInteger(digits);
   if(ticket == 0 || IntegerToString((long)ticket) != digits)
      return false;
   return TrailingStopPlanVariable(identity, ticket) == name;
}

int FindTrailingStopSlot(string identity, ulong ticket)
{
   for(int index = 0; index < trailingStopStateCount; index++)
      if(trailingStopStates[index].active
         && trailingStopStates[index].identity == identity
         && trailingStopStates[index].positionTicket == ticket)
         return index;
   return -1;
}

int AllocateTrailingStopSlot()
{
   for(int index = 0; index < trailingStopStateCount; index++)
      if(!trailingStopStates[index].active)
         return index;
   if(trailingStopStateCount >= ArraySize(trailingStopStates))
      return -1;
   int index = trailingStopStateCount;
   trailingStopStateCount++;
   return index;
}

void SetTrailingStopState(int slot, SignalCommand &command, string identity, ulong ticket, double distance)
{
   trailingStopStates[slot].active = true;
   trailingStopStates[slot].queueItemId = command.queueItemId;
   trailingStopStates[slot].logicalTradeId = command.logicalTradeId;
   trailingStopStates[slot].identity = identity;
   trailingStopStates[slot].symbol = command.brokerSymbol;
   trailingStopStates[slot].direction = command.direction;
   trailingStopStates[slot].positionTicket = ticket;
   trailingStopStates[slot].distance = distance;
   trailingStopStates[slot].absentPasses = 0;
}

bool PersistTrailingStopPlan(string identity, ulong ticket, double distance)
{
   string variable = TrailingStopPlanVariable(identity, ticket);
   if(variable == "" || distance <= 0.0 || identity != LifecycleAccountIdentity())
      return false;
   ResetLastError();
   if(GlobalVariableSet(variable, distance) == 0)
      return false;
   GlobalVariablesFlush();
   return GlobalVariableCheck(variable)
      && MathAbs(GlobalVariableGet(variable) - distance) <= MathMax(0.000000001, distance * 0.000000001);
}

// Store and flush before a command can be acknowledged as tracked.
bool TrackTrailingStop(SignalCommand &command, ulong ticket, double distance, string &errorText)
{
   string identity = LifecycleAccountIdentity();
   if(ticket == 0 || !CanTrade() || !LifecycleIdentityReady() || identity != ActiveLifecycleIdentity)
   {
      errorText = "Trading readiness, account identity, or position ticket is unavailable";
      return false;
   }
   int slot = FindTrailingStopSlot(identity, ticket);
   bool hadExistingState = slot >= 0;
   if(slot < 0)
      slot = AllocateTrailingStopSlot();
   if(slot < 0)
   {
      errorText = "Trailing stop tracking capacity exhausted";
      return false;
   }
   if(!PersistTrailingStopPlan(identity, ticket, distance))
   {
      if(!hadExistingState)
         ReleaseTrailingStopSlot(slot);
      errorText = "Could not persist and flush trailing stop plan";
      return false;
   }
   SetTrailingStopState(slot, command, identity, ticket, distance);
   return true;
}

void RestoreTrailingStopPlans()
{
   string identity = LifecycleAccountIdentity();
   if(!AccountConnected() || identity != ActiveLifecycleIdentity)
      return;

   int total = GlobalVariablesTotal();
   for(int index = 0; index < total; index++)
   {
      string name = GlobalVariableName(index);
      ulong ticket = 0;
      if(!ParseTrailingStopPlanName(name, identity, ticket))
         continue;
      double distance = GlobalVariableGet(name);
      if(distance <= 0.0)
         continue;
      int slot = FindTrailingStopSlot(identity, ticket);
      if(slot < 0)
      {
         slot = AllocateTrailingStopSlot();
         if(slot < 0)
         {
            PrintFormat("Telegram TC trailing plan registry full (%d slots); plan retained for ticket=%I64u",
               ArraySize(trailingStopStates), ticket);
            continue;
         }
         SignalCommand restored = {};
         SetTrailingStopState(slot, restored, identity, ticket, distance);
      }
      if(PositionSelectByTicket(ticket))
      {
         trailingStopStates[slot].symbol = PositionGetString(POSITION_SYMBOL);
         trailingStopStates[slot].direction = PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY ? "BUY" : "SELL";
         trailingStopStates[slot].absentPasses = 0;
         trailingStopStates[slot].distance = distance;
      }
   }

   for(int index = 0; index < trailingStopStateCount; index++)
   {
      if(!trailingStopStates[index].active || trailingStopStates[index].identity != identity)
         continue;
      ulong ticket = trailingStopStates[index].positionTicket;
      string variable = TrailingStopPlanVariable(identity, ticket);
      if(PositionSelectByTicket(ticket))
      {
         trailingStopStates[index].symbol = PositionGetString(POSITION_SYMBOL);
         trailingStopStates[index].direction = PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY ? "BUY" : "SELL";
         trailingStopStates[index].absentPasses = 0;
         if(GlobalVariableCheck(variable))
         {
            double persistedDistance = GlobalVariableGet(variable);
            if(persistedDistance > 0.0)
               trailingStopStates[index].distance = persistedDistance;
         }
         else if(!PersistTrailingStopPlan(identity, ticket, trailingStopStates[index].distance))
            PrintFormat("Telegram TC trailing plan refresh failed for ticket=%I64u", ticket);
         continue;
      }

      // A chart/inventory synchronisation gap is not evidence of closure.
      if(!BrokerReady())
         continue;
      trailingStopStates[index].absentPasses++;
      if(trailingStopStates[index].absentPasses < TRAILING_PLAN_ABSENT_PASSES)
         continue;
      if(GlobalVariableCheck(variable))
         GlobalVariableDel(variable);
      ReleaseTrailingStopSlot(index);
   }
}

void ManageTrailingStops()
{
   for(int index = 0; index < trailingStopStateCount; index++)
   {
      if(!trailingStopStates[index].active)
         continue;
      if(trailingStopStates[index].identity != LifecycleAccountIdentity())
         continue;
      string variable = TrailingStopPlanVariable(trailingStopStates[index].identity,
         trailingStopStates[index].positionTicket);
      if(!GlobalVariableCheck(variable)
         && !PersistTrailingStopPlan(trailingStopStates[index].identity,
            trailingStopStates[index].positionTicket, trailingStopStates[index].distance))
      {
         PrintFormat("Telegram TC trailing plan persistence unavailable for ticket=%I64u",
            trailingStopStates[index].positionTicket);
         continue;
      }
      double distance = GlobalVariableGet(variable);
      if(distance <= 0.0)
         continue;
      trailingStopStates[index].distance = distance;
      SignalCommand command = {};
      command.queueItemId = trailingStopStates[index].queueItemId;
      command.logicalTradeId = trailingStopStates[index].logicalTradeId;
      command.brokerSymbol = trailingStopStates[index].symbol;
      command.direction = trailingStopStates[index].direction;
      command.targetPositionTicket = trailingStopStates[index].positionTicket;
      if(!PositionSelectByTicket(trailingStopStates[index].positionTicket))
         continue;
      MqlTradeResult result = {};
      string status = "UNKNOWN";
      string errorText = "";
      double requestedPrice = 0.0;
      double requestedVolume = 0.0;
      ApplyTrailingStopToTicket(command, trailingStopStates[index].positionTicket,
         distance, result, status, errorText, requestedPrice, requestedVolume);
      if(status != "EXECUTED")
         PrintFormat("Telegram TC trailing adjustment ticket=%I64u status=%s error=%s",
            trailingStopStates[index].positionTicket, status, errorText);
   }
}

bool ApplyTrailingStopToTicket(SignalCommand &command, ulong ticket, double distance,
   MqlTradeResult &result, string &status, string &errorText,
   double &requestedPrice, double &requestedVolume)
{
   requestedPrice = 0.0;
   requestedVolume = 0.0;
   if(!CanTrade())
   {
      status = "UNKNOWN";
      errorText = "Trading permissions are not ready for trailing adjustment";
      return false;
   }
   if(!PositionSelectByTicket(ticket))
   {
      status = "UNKNOWN";
      errorText = "Position disappeared before trailing adjustment";
      return false;
   }

   string symbol = PositionGetString(POSITION_SYMBOL);
   long positionType = PositionGetInteger(POSITION_TYPE);
   double currentSl = PositionGetDouble(POSITION_SL);
   if(!EnsureSymbol(symbol))
   {
      status = "UNKNOWN";
      errorText = "Trailing adjustment has no fresh symbol quote";
      return false;
   }
   MqlTick tick;
   long tickAgeMs = -1;
   if(!ReadSymbolTick(symbol, tick, tickAgeMs) || tickAgeMs < -1000 || tickAgeMs > 15000)
   {
      status = "UNKNOWN";
      errorText = "Trailing adjustment has no fresh symbol quote";
      return false;
   }
   string direction = positionType == POSITION_TYPE_BUY ? "BUY" : "SELL";
   double referencePrice = positionType == POSITION_TYPE_BUY ? tick.bid : tick.ask;
   double rawStop = positionType == POSITION_TYPE_BUY ? tick.bid - distance : tick.ask + distance;
   double nextSl = SafeStopPrice(symbol, referencePrice, rawStop, direction, true);
   requestedPrice = nextSl;
   if(nextSl <= 0.0)
   {
      status = "FAILED";
      errorText = "Trailing stop is invalid for broker quote, stop level, or tick grid";
      return false;
   }

   if(!TrailingStopImproves(positionType, currentSl, nextSl))
   {
      result.retcode = TRADE_RETCODE_NO_CHANGES;
      result.comment = "Trailing stop did not improve the existing stop";
      status = "EXECUTED";
      return false;
   }

   return ModifyPositionSl(command, ticket, nextSl, result, status, errorText, requestedPrice, requestedVolume);
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

bool ModifyPositionSl(SignalCommand &command, ulong ticket, double stopLoss,
   MqlTradeResult &result, string &status, string &errorText,
   double &requestedPrice, double &requestedVolume)
{
   requestedPrice = 0.0;
   requestedVolume = 0.0;
   if(stopLoss <= 0.0)
   {
      result.comment = "No valid stop loss provided";
      status = "FAILED";
      errorText = result.comment;
      return false;
   }
   if(!PositionSelectByTicket(ticket))
   {
      result.comment = "Position disappeared before stop modification";
      status = "UNKNOWN";
      errorText = result.comment;
      return false;
   }

   string symbol = PositionGetString(POSITION_SYMBOL);
   if(!CanTrade())
   {
      result.comment = "Trading permissions are not ready for stop modification";
      status = "UNKNOWN";
      errorText = result.comment;
      return false;
   }
   long positionType = PositionGetInteger(POSITION_TYPE);
   string direction = positionType == POSITION_TYPE_BUY ? "BUY" : "SELL";
   double currentSl = PositionGetDouble(POSITION_SL);
   if(!EnsureSymbol(symbol))
   {
      result.comment = "Stop modification has no fresh symbol quote";
      status = "UNKNOWN";
      errorText = result.comment;
      return false;
   }
   MqlTick tick;
   long tickAgeMs = -1;
   if(!ReadSymbolTick(symbol, tick, tickAgeMs) || tickAgeMs < -1000 || tickAgeMs > 15000)
   {
      result.comment = "Stop modification has no fresh symbol quote";
      status = "UNKNOWN";
      errorText = result.comment;
      return false;
   }
   double referencePrice = positionType == POSITION_TYPE_BUY ? tick.bid : tick.ask;
   requestedPrice = SafeStopPrice(symbol, referencePrice, stopLoss, direction, true);
   if(requestedPrice <= 0.0)
   {
      result.comment = "Stop loss is invalid for broker quote, stop level, or tick grid";
      status = "FAILED";
      errorText = result.comment;
      return false;
   }
   if(currentSl > 0.0 && MathAbs(currentSl - requestedPrice) < SymbolInfoDouble(symbol, SYMBOL_TRADE_TICK_SIZE) * 0.000001)
   {
      result.retcode = TRADE_RETCODE_NO_CHANGES;
      result.comment = "Stop loss already matches requested value";
      status = "EXECUTED";
      return true;
   }
   MqlTradeRequest request = {};
   request.action = TRADE_ACTION_SLTP;
   request.position = ticket;
   request.symbol = symbol;
   request.sl = requestedPrice;
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
   int sendErr = sent ? 0 : GetLastError();
   status = ExecutionStatus(sent, result.retcode);
   errorText = sent ? "" : IntegerToString(sendErr);
   return status == "EXECUTED";
}

bool ModifyPositionTp(SignalCommand &command, ulong ticket, double takeProfit,
   MqlTradeResult &result, string &status, string &errorText,
   double &requestedPrice, double &requestedVolume)
{
   requestedPrice = 0.0;
   requestedVolume = 0.0;
   if(!PositionSelectByTicket(ticket))
   {
      result.comment = "Position disappeared before take-profit modification";
      status = "UNKNOWN";
      errorText = result.comment;
      return false;
   }

   string symbol = PositionGetString(POSITION_SYMBOL);
   if(!CanTrade())
   {
      result.comment = "Trading permissions are not ready for take-profit modification";
      status = "UNKNOWN";
      errorText = result.comment;
      return false;
   }
   long positionType = PositionGetInteger(POSITION_TYPE);
   string direction = positionType == POSITION_TYPE_BUY ? "BUY" : "SELL";
   double currentTp = PositionGetDouble(POSITION_TP);
   if(!EnsureSymbol(symbol))
   {
      result.comment = "Take-profit modification has no fresh symbol quote";
      status = "UNKNOWN";
      errorText = result.comment;
      return false;
   }
   MqlTick tick;
   long tickAgeMs = -1;
   if(!ReadSymbolTick(symbol, tick, tickAgeMs) || tickAgeMs < -1000 || tickAgeMs > 15000)
   {
      result.comment = "Take-profit modification has no fresh symbol quote";
      status = "UNKNOWN";
      errorText = result.comment;
      return false;
   }
   double referencePrice = positionType == POSITION_TYPE_BUY ? tick.bid : tick.ask;
   requestedPrice = SafeStopPrice(symbol, referencePrice, takeProfit, direction, false);
   if(requestedPrice <= 0.0)
   {
      result.comment = "Take profit is invalid for broker quote, stop level, or tick grid";
      status = "FAILED";
      errorText = result.comment;
      return false;
   }
   if(currentTp > 0.0 && MathAbs(currentTp - requestedPrice) < SymbolInfoDouble(symbol, SYMBOL_TRADE_TICK_SIZE) * 0.000001)
   {
      result.retcode = TRADE_RETCODE_NO_CHANGES;
      result.comment = "Take profit already matches requested value";
      status = "EXECUTED";
      return true;
   }
   MqlTradeRequest request = {};
   request.action = TRADE_ACTION_SLTP;
   request.position = ticket;
   request.symbol = symbol;
   request.sl = PositionGetDouble(POSITION_SL);
   request.tp = requestedPrice;
   request.magic = MagicNumber;

   bool sent = OrderSend(request, result);
   int sendErr = sent ? 0 : GetLastError();
   status = ExecutionStatus(sent, result.retcode);
   errorText = sent ? "" : IntegerToString(sendErr);
   return status == "EXECUTED";
}

bool ContainsTicket(ulong &tickets[], ulong ticket)
{
   for(int index = 0; index < ArraySize(tickets); index++)
      if(tickets[index] == ticket)
         return true;
   return false;
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

   ExecutionSummary summary;
   InitExecutionSummary(summary);
   for(int index = 0; index < pendingFound; index++)
   {
      MqlTradeResult result = {};
      bool requestSent = false;
      string errorText = "";
      bool removed = RemovePendingOrder(command, pendingTickets[index], result, requestSent, errorText);
      string status = removed ? "EXECUTED" : (IsProvenOrderRejection(result.retcode) ? "FAILED" : "UNKNOWN");
      AddExecution(summary, status, result.retcode, result.retcode_external, result.comment,
         pendingTickets[index], 0, result.deal, 0.0, result.price, 0.0, 0.0, 0.0, errorText);
   }

   // A pending order may fill while the remove request is in flight. Re-scan
   // after cancellation so CLOSE_TRADE handles the newly-created position too.
   ulong positionTickets[];
   int positionFound = CollectPositionTickets(command, positionTickets);
   for(int index = 0; index < positionFound; index++)
   {
      ulong ticket = positionTickets[index];
      if(LifecycleAlreadyExecuted(command, ticket))
      {
         AddExecution(summary, "UNKNOWN", 0, 0, "Lifecycle command was already executed", 0, ticket, 0,
            0.0, 0.0, 0.0, 0.0, 0.0, "Reconcile broker snapshot/history before retry");
         continue;
      }
      MqlTradeResult result = {};
      bool requestSent = false;
      double requested = 0.0;
      double filled = 0.0;
      double remaining = 0.0;
      string errorText = "";
      bool closed = ClosePositionTicket(command, ticket, result, requested, filled, remaining, requestSent, errorText);
      string status = closed ? "EXECUTED"
         : (result.retcode == TRADE_RETCODE_DONE_PARTIAL && filled > 0.0 ? "PARTIAL"
         : (IsProvenOrderRejection(result.retcode) && filled <= 0.00000001 ? "FAILED" : "UNKNOWN"));
      AddExecution(summary, status, result.retcode, result.retcode_external, result.comment,
         result.order, ticket, result.deal, 0.0, result.price, requested, filled, remaining, errorText);
   }

   ulong remainingPendingTickets[];
   ulong remainingPositionTickets[];
   int remainingPending = CollectPendingOrderTickets(command, remainingPendingTickets);
   int remainingPositionMatches = CollectPositionTickets(command, remainingPositionTickets);
   bool allRejected = ExecutionSummaryStatus(summary) == "FAILED";
   bool unexplainedRemaining = false;
   for(int index = 0; index < remainingPending; index++)
      if(!allRejected || !ContainsTicket(pendingTickets, remainingPendingTickets[index]))
         unexplainedRemaining = true;
   for(int index = 0; index < remainingPositionMatches; index++)
   {
      ulong ticket = remainingPositionTickets[index];
      if(!LifecycleAlreadyExecuted(command, ticket)
         && (!allRejected || !ContainsTicket(positionTickets, ticket)))
         unexplainedRemaining = true;
   }
   if(unexplainedRemaining)
      AddExecution(summary, "UNKNOWN", 0, 0, "Tickets remain after flatten attempt", 0, 0, 0,
         0.0, 0.0, 0.0, 0.0, 0.0, "Reconcile broker snapshot/history before retrying");
   ReportExecutionSummary(command, summary, "");
}

void ExecutePartialClose(SignalCommand &command)
{
   if(command.partialCloseKind == "PERCENT" && command.targetRemainingVolume <= 0.0)
   {
      ReportUnknown(command.queueItemId, "No valid target remaining volume provided", command.commandType);
      return;
   }
   ulong tickets[];
   int found = CollectPositionTickets(command, tickets);
   if(found <= 0)
   {
      ReportUnknown(command.queueItemId, "No matching position; reconcile broker snapshot/history", command.commandType);
      return;
   }

   ExecutionSummary summary;
   InitExecutionSummary(summary);
   for(int index = 0; index < found; index++)
   {
      ulong ticket = tickets[index];
      if(LifecycleAlreadyExecuted(command, ticket))
      {
         AddExecution(summary, "UNKNOWN", 0, 0, "Lifecycle command was already executed", 0, ticket, 0,
            0.0, 0.0, 0.0, 0.0, 0.0, "Reconcile broker snapshot/history before retry");
         continue;
      }
      MqlTradeResult result = {};
      bool requestSent = false;
      double requested = 0.0;
      double filled = 0.0;
      double remaining = 0.0;
      string errorText = "";
      bool closed = ClosePositionTicket(command, ticket, result, requested, filled, remaining, requestSent, errorText);
      string status = closed ? "EXECUTED"
         : (result.retcode == TRADE_RETCODE_DONE_PARTIAL && filled > 0.0 ? "PARTIAL"
         : (IsProvenOrderRejection(result.retcode) && filled <= 0.00000001 ? "FAILED" : "UNKNOWN"));
      AddExecution(summary, status, result.retcode, result.retcode_external, result.comment,
         result.order, ticket, result.deal, 0.0, result.price, requested, filled, remaining, errorText);
   }

   ReportExecutionSummary(command, summary,
      ExecutionSummaryStatus(summary) == "EXECUTED" ? "" : "Partial close did not complete; reconcile broker snapshot/history before retrying");
}

bool ClosePositionTicket(
   SignalCommand &command,
   ulong ticket,
   MqlTradeResult &result,
   double &requestedVolume,
   double &filledVolume,
   double &remainingVolume,
   bool &requestSent,
   string &errorText
)
{
   requestedVolume = 0.0;
   filledVolume = 0.0;
   remainingVolume = 0.0;
   requestSent = false;
   errorText = "";
   if(!PositionSelectByTicket(ticket))
   {
      result.comment = "Position disappeared before close";
      errorText = result.comment;
      return false;
   }
   if(!CanTrade())
   {
      result.comment = "Trading permissions are not ready; no close submitted";
      errorText = result.comment;
      return false;
   }

   string symbol = PositionGetString(POSITION_SYMBOL);
   long positionType = PositionGetInteger(POSITION_TYPE);
   double currentVolume = PositionGetDouble(POSITION_VOLUME);
   double closeVolume = 0.0;
   if(command.commandType == "CLOSE_TRADE" && command.runnerEnabled)
   {
      if(command.runnerVolume >= currentVolume)
      {
         result.comment = "Runner target is at least the current volume; no close submitted";
         errorText = result.comment;
         return false;
      }
      closeVolume = NormalizeCloseVolume(symbol, currentVolume - command.runnerVolume, currentVolume);
      double volumeStep = SymbolInfoDouble(symbol, SYMBOL_VOLUME_STEP);
      if(command.runnerVolume > 0.0 && closeVolume > 0.0
         && closeVolume >= currentVolume - volumeStep * 0.000001)
      {
         result.comment = "Broker volume step cannot preserve the requested runner; no close submitted";
         errorText = result.comment;
         return false;
      }
   }
   else if(command.commandType == "CLOSE_TRADE")
      closeVolume = NormalizeCloseVolume(symbol, currentVolume, currentVolume);
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
         ? "No valid partial-close volume or broker volume metadata"
         : "No valid close volume or broker volume metadata; no close submitted";
      errorText = result.comment;
      return false;
   }

   if(!EnsureSymbol(symbol))
   {
      result.comment = "Close has no fresh symbol quote; no close submitted";
      errorText = result.comment;
      return false;
   }
   MqlTick tick;
   long tickAgeMs = -1;
   if(!ReadSymbolTick(symbol, tick, tickAgeMs) || tickAgeMs < -1000 || tickAgeMs > 15000)
   {
      result.comment = "Close has no fresh symbol quote; no close submitted";
      errorText = result.comment;
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
   request.price = NormalizePriceToTick(symbol,
      positionType == POSITION_TYPE_BUY ? tick.bid : tick.ask,
      positionType != POSITION_TYPE_BUY);
   if(request.price <= 0.0)
   {
      result.comment = "Close quote is outside the broker tick grid; no close submitted";
      errorText = result.comment;
      return false;
   }
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

   requestSent = OrderSend(request, result);
   int sendErr = requestSent ? 0 : GetLastError();
   bool positionGone = !PositionSelectByTicket(ticket);
   remainingVolume = positionGone ? 0.0 : PositionGetDouble(POSITION_VOLUME);
   double observedFilledVolume = positionGone ? currentVolume : MathMax(0.0, currentVolume - remainingVolume);
   filledVolume = requestSent && (result.retcode == TRADE_RETCODE_DONE || result.retcode == TRADE_RETCODE_DONE_PARTIAL)
      ? MathMax(result.volume, observedFilledVolume)
      : observedFilledVolume;
   bool fullClose = closeVolume >= currentVolume - 0.000001;
   bool filledConfirmed = filledVolume + 0.000001 >= request.volume;
   // Full closes require the position gone. Slice closes require a DONE result
   // plus broker-confirmed volume, either from the deal or the observed delta.
   if(requestSent && result.retcode == TRADE_RETCODE_DONE && filledConfirmed && (positionGone || !fullClose))
      MarkLifecycleExecuted(command, ticket);
   requestedVolume = request.volume;
   if(!requestSent)
      errorText = IntegerToString(sendErr);
   else if(result.retcode != TRADE_RETCODE_DONE && result.retcode != TRADE_RETCODE_DONE_PARTIAL)
      errorText = result.comment;
   else if(!filledConfirmed || (fullClose && !positionGone))
      errorText = "Broker fill or full close not confirmed; reconcile before retrying";
   return requestSent && result.retcode == TRADE_RETCODE_DONE && filledConfirmed && (positionGone || !fullClose);
}

ulong ResultPositionTicket(MqlTradeResult &result)
{
   if(result.order > 0 && PositionSelectByTicket(result.order))
      return result.order;
   if(result.deal == 0 || !HistoryDealSelect(result.deal))
      return 0;
   ulong identifier = (ulong)HistoryDealGetInteger(result.deal, DEAL_POSITION_ID);
   for(int index = PositionsTotal() - 1; index >= 0; index--)
   {
      ulong ticket = PositionGetTicket(index);
      if(ticket > 0 && (ulong)PositionGetInteger(POSITION_IDENTIFIER) == identifier)
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
      "{\"ticket\":\"%I64u\",\"symbol\":\"%s\",\"type\":%d,\"volume\":%.8f,\"openPrice\":%.8f,\"sl\":%.8f,\"tp\":%.8f,\"profit\":%.2f,\"magic\":%I64u,\"isExternal\":%s,\"comment\":\"%s\"}",
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
      "{\"ticket\":\"%I64u\",\"symbol\":\"%s\",\"type\":%d,\"volume\":%.8f,\"openPrice\":%.8f,\"sl\":%.8f,\"tp\":%.8f,\"magic\":%I64u,\"isExternal\":%s,\"comment\":\"%s\"}",
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
      "{\"dealTicket\":\"%I64u\",\"orderTicket\":\"%I64u\",\"positionTicket\":\"%I64u\",\"entry\":\"%d\",\"type\":\"%d\",\"reason\":%d,\"magic\":%I64d,\"symbol\":\"%s\",\"price\":%.8f,\"volume\":%.8f,\"profit\":%.2f,\"commission\":%.2f,\"swap\":%.2f,\"fee\":%.2f,\"comment\":\"%s\",\"time\":\"%s\",\"timeMsc\":%I64d}",
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

   json += "]";
   return json;
}

string SymbolMarketJson(string symbol)
{
   MqlTick tick;
   long tickAgeMs = -1;
   bool hasTick = ReadSymbolTick(symbol, tick, tickAgeMs);
   if(hasTick && tickAgeMs >= -1000 && tickAgeMs < 0)
      tickAgeMs = 0;
   double bid = hasTick ? tick.bid : 0.0;
   double ask = hasTick ? tick.ask : 0.0;
   long timeMsc = hasTick ? tick.time_msc : 0;
   return StringFormat(
      "{\"symbol\":\"%s\",\"bid\":%.8f,\"ask\":%.8f,\"timeMsc\":%I64d,\"tickAgeMs\":%I64d,\"volumeMin\":%.8f,\"volumeMax\":%.8f,\"volumeStep\":%.8f,\"point\":%.8f,\"digits\":%d}",
      JsonEscape(symbol),
      bid,
      ask,
      timeMsc,
      tickAgeMs,
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

bool PendingOrderPriceRoundsUp(SignalCommand &command)
{
   return (command.direction == "BUY" && command.orderType == "STOP")
      || (command.direction == "SELL" && command.orderType == "LIMIT");
}

bool ValidatePendingOrderPrice(SignalCommand &command)
{
   if(command.orderType != "LIMIT" && command.orderType != "STOP")
      return true;

   MqlTick tick;
   long tickAgeMs = -1;
   if(!ReadSymbolTick(command.brokerSymbol, tick, tickAgeMs) || tickAgeMs < -1000 || tickAgeMs > 15000)
      return false;
   double price = NormalizePriceToTick(command.brokerSymbol, command.entryFrom, PendingOrderPriceRoundsUp(command));
   double ask = tick.ask;
   double bid = tick.bid;
   double point = SymbolInfoDouble(command.brokerSymbol, SYMBOL_POINT);
   long stopLevelPoints = SymbolInfoInteger(command.brokerSymbol, SYMBOL_TRADE_STOPS_LEVEL);
   if(price <= 0.0 || point <= 0.0 || stopLevelPoints < 0)
      return false;
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
   if(requestedStop <= 0.0 || referencePrice <= 0.0)
      return 0.0;
   if(direction != "BUY" && direction != "SELL")
      return 0.0;
   bool stopBelowPrice = (direction == "BUY" && isStopLoss) ||
                         (direction == "SELL" && !isStopLoss);
   double normalizedRequestedStop = NormalizePriceToTick(symbol, requestedStop, !stopBelowPrice);
   if(normalizedRequestedStop <= 0.0)
      return 0.0;
   if((stopBelowPrice && normalizedRequestedStop >= referencePrice)
      || (!stopBelowPrice && normalizedRequestedStop <= referencePrice))
      return 0.0;
   long stopLevel = SymbolInfoInteger(symbol, SYMBOL_TRADE_STOPS_LEVEL);
   double point = SymbolInfoDouble(symbol, SYMBOL_POINT);
   double tickSize = SymbolInfoDouble(symbol, SYMBOL_TRADE_TICK_SIZE);
   if(point <= 0.0 || tickSize <= 0.0 || stopLevel < 0)
      return 0.0;

   double minDistance = stopLevel > 0 && MinStopBufferMultiplier > 0.0
      ? (double)stopLevel * point * MinStopBufferMultiplier
      : 0.0;
   double safe = normalizedRequestedStop;
   if(MathAbs(referencePrice - normalizedRequestedStop) < minDistance)
      safe = stopBelowPrice ? referencePrice - minDistance : referencePrice + minDistance;
   safe = NormalizePriceToTick(symbol, safe, !stopBelowPrice);
   if(safe <= 0.0 || (stopBelowPrice && safe >= referencePrice)
      || (!stopBelowPrice && safe <= referencePrice)
      || MathAbs(referencePrice - safe) + tickSize * 0.000001 < minDistance)
      return 0.0;
   if(safe != requestedStop)
      PrintFormat("Telegram TC SafeStopPrice: %s %s adjusted %.8f to %.8f", symbol, isStopLoss ? "SL" : "TP", requestedStop, safe);
   return safe;
}

double NormalizePriceToTick(string symbol, double price, bool roundUp)
{
   if(price <= 0.0)
      return 0.0;
   double tickSize = SymbolInfoDouble(symbol, SYMBOL_TRADE_TICK_SIZE);
   if(tickSize <= 0.0)
      return 0.0;
   int digits = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);
   if(digits < 0 || digits > 8)
      return 0.0;
   double units = price / tickSize;
   double roundedUnits = roundUp ? MathCeil(units - 0.000000001) : MathFloor(units + 0.000000001);
   return NormalizeDouble(roundedUnits * tickSize, digits);
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
   MqlTick tick;
   long tickAgeMs = -1;
   if(!ReadSymbolTick(command.brokerSymbol, tick, tickAgeMs) || tickAgeMs < -1000 || tickAgeMs > 15000)
      return 0.0;
   if(command.direction == "BUY")
      return tick.ask;
   if(command.direction == "SELL")
      return tick.bid;
   return 0.0;
}

double StopReferencePrice(string symbol, string direction)
{
   MqlTick tick;
   long tickAgeMs = -1;
   if(!ReadSymbolTick(symbol, tick, tickAgeMs) || tickAgeMs < -1000 || tickAgeMs > 15000)
      return 0.0;
   if(direction == "BUY")
      return tick.bid;
   if(direction == "SELL")
      return tick.ask;
   return 0.0;
}

bool ReadSymbolTick(string symbol, MqlTick &tick, long &tickAgeMs)
{
   tickAgeMs = -1;
   if(symbol == "" || TerminalInfoInteger(TERMINAL_CONNECTED) == 0 || !SymbolIsSynchronized(symbol))
      return false;
   if(!SymbolInfoTick(symbol, tick) || tick.bid <= 0.0 || tick.ask < tick.bid || tick.time_msc <= 0)
      return false;
   datetime serverTime = TimeTradeServer();
   if(serverTime <= 0)
      return false;
   tickAgeMs = (long)serverTime * 1000 - tick.time_msc;
   return true;
}

bool EnsureSymbol(string symbol)
{
   if(symbol == "" || TerminalInfoInteger(TERMINAL_CONNECTED) == 0)
      return false;
   if(!SymbolSelect(symbol, true) || SymbolInfoInteger(symbol, SYMBOL_SELECT) == 0)
      return false;
   if(!SymbolIsSynchronized(symbol))
      return false;
   MqlTick tick;
   long tickAgeMs = -1;
   if(!ReadSymbolTick(symbol, tick, tickAgeMs))
      return false;
   return tick.bid > 0.0 && tick.ask >= tick.bid && tickAgeMs >= -1000 && tickAgeMs <= 15000;
}

double NormalizeVolume(string symbol, double requested)
{
   double minVolume = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MIN);
   double maxVolume = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MAX);
   double step = SymbolInfoDouble(symbol, SYMBOL_VOLUME_STEP);
   if(requested <= 0.0 || minVolume <= 0.0 || maxVolume < minVolume || step <= 0.0)
      return 0.0;
   double bounded = MathMax(minVolume, MathMin(maxVolume, requested));
   double volume = NormalizeDouble(MathFloor((bounded + step * 0.000001) / step) * step, VolumeDigits(step));
   if(volume < minVolume - step * 0.000001 || volume > maxVolume + step * 0.000001 || volume <= 0.0)
      return 0.0;
   double stepUnits = volume / step;
   if(MathAbs(stepUnits - MathRound(stepUnits)) > 0.000001)
      return 0.0;
   return volume;
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
   if(minVolume <= 0.0 || maxVolume < minVolume || step <= 0.0 || requested <= 0.0 || currentVolume <= 0.0)
      return 0.0;
   if(requested >= currentVolume - step * 0.000001)
   {
      double fullVolume = NormalizeDouble(currentVolume, VolumeDigits(step));
      double fullUnits = fullVolume / step;
      if(fullVolume < minVolume - step * 0.000001 || fullVolume > maxVolume + step * 0.000001
         || MathAbs(fullUnits - MathRound(fullUnits)) > 0.000001)
         return 0.0;
      return fullVolume;
   }
   double volume = MathMin(maxVolume, requested);
   volume = NormalizeDouble(MathFloor((volume + step * 0.000001) / step) * step, VolumeDigits(step));
   if(volume < minVolume - step * 0.000001 || volume > maxVolume + step * 0.000001
      || volume <= 0.0 || volume > currentVolume + step * 0.000001)
      return 0.0;
   double stepUnits = volume / step;
   if(MathAbs(stepUnits - MathRound(stepUnits)) > 0.000001)
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
   ReportWithVolumes(queueItemId, status, retcode, retcodeExternal, brokerComment, orderTicket, positionTicket, dealTicket, requestedPrice, filledPrice, volume, volume, 0.0, errorText, "");
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
   string errorText,
   string executionsJson
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
   if(executionsJson != "")
      body = StringSubstr(body, 0, StringLen(body) - 1) + ",\"executions\":" + executionsJson + "}";
   string response = "";
   HttpPost("/mt5/report", body, response);
}

bool IsProvenOrderRejection(uint retcode)
{
   return retcode == TRADE_RETCODE_REJECT
      || retcode == TRADE_RETCODE_CANCEL
      || retcode == TRADE_RETCODE_INVALID
      || retcode == TRADE_RETCODE_INVALID_VOLUME
      || retcode == TRADE_RETCODE_INVALID_PRICE
      || retcode == TRADE_RETCODE_INVALID_STOPS
      || retcode == TRADE_RETCODE_INVALID_FILL
      || retcode == TRADE_RETCODE_INVALID_ORDER
      || retcode == TRADE_RETCODE_INVALID_EXPIRATION
      || retcode == TRADE_RETCODE_INVALID_CLOSE_VOLUME
      || retcode == TRADE_RETCODE_TRADE_DISABLED
      || retcode == TRADE_RETCODE_MARKET_CLOSED
      || retcode == TRADE_RETCODE_NO_MONEY
      || retcode == TRADE_RETCODE_REQUOTE
      || retcode == TRADE_RETCODE_PRICE_CHANGED
      || retcode == TRADE_RETCODE_PRICE_OFF
      || retcode == TRADE_RETCODE_FROZEN
      || retcode == TRADE_RETCODE_TOO_MANY_REQUESTS
      || retcode == TRADE_RETCODE_LIMIT_ORDERS
      || retcode == TRADE_RETCODE_LIMIT_VOLUME
      || retcode == TRADE_RETCODE_LIMIT_POSITIONS
      || retcode == TRADE_RETCODE_LONG_ONLY
      || retcode == TRADE_RETCODE_SHORT_ONLY
      || retcode == TRADE_RETCODE_CLOSE_ONLY
      || retcode == TRADE_RETCODE_FIFO_CLOSE
      || retcode == TRADE_RETCODE_HEDGE_PROHIBITED;
}

string ExecutionStatus(bool sent, uint retcode)
{
   if(sent && (retcode == TRADE_RETCODE_DONE || retcode == TRADE_RETCODE_NO_CHANGES))
      return "EXECUTED";
   if(sent && retcode == TRADE_RETCODE_DONE_PARTIAL)
      return "PARTIAL";
   if(IsProvenOrderRejection(retcode))
      return "FAILED";
   return "UNKNOWN";
}

void InitExecutionSummary(ExecutionSummary &summary)
{
   summary.attempted = 0;
   summary.completed = 0;
   summary.rejected = 0;
   summary.uncertain = 0;
   summary.partial = 0;
   summary.requestedVolume = 0.0;
   summary.filledVolume = 0.0;
   summary.remainingVolume = 0.0;
   summary.retcode = 0;
   summary.retcodeExternal = 0;
   summary.brokerComment = "";
   summary.orderTicket = 0;
   summary.positionTicket = 0;
   summary.dealTicket = 0;
   summary.requestedPrice = 0.0;
   summary.filledPrice = 0.0;
   summary.errorText = "";
   summary.executionsJson = "";
}

void AddExecution(
   ExecutionSummary &summary,
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
   string errorText,
   int leg = 0
)
{
   string legField = leg == 0 ? "" : StringFormat(",\"leg\":%d", leg);
   if(summary.attempted > 0)
      summary.executionsJson += ",";
   summary.executionsJson += StringFormat(
      "{\"status\":\"%s\",\"retcode\":%u,\"retcodeExternal\":%d,\"brokerComment\":\"%s\",\"orderTicket\":\"%I64u\",\"positionTicket\":\"%I64u\",\"dealTicket\":\"%I64u\",\"requestedPrice\":%.8f,\"filledPrice\":%.8f,\"requestedVolume\":%.8f,\"filledVolume\":%.8f,\"remainingVolume\":%.8f,\"errorText\":\"%s\"%s}",
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
      JsonEscape(errorText),
      legField
   );
   summary.attempted++;
   if(status == "EXECUTED")
      summary.completed++;
   else if(status == "FAILED")
      summary.rejected++;
   else if(status == "PARTIAL")
      summary.partial++;
   else
      summary.uncertain++;
   summary.requestedVolume += requestedVolume;
   summary.filledVolume += filledVolume;
   summary.remainingVolume += remainingVolume;
   summary.retcode = retcode;
   summary.retcodeExternal = retcodeExternal;
   summary.brokerComment = brokerComment;
   summary.orderTicket = orderTicket;
   summary.positionTicket = positionTicket;
   summary.dealTicket = dealTicket;
   summary.requestedPrice = requestedPrice;
   summary.filledPrice = filledPrice;
   if(errorText != "")
   {
      if(summary.errorText != "")
         summary.errorText += "; ";
      summary.errorText += errorText;
   }
}

string ExecutionSummaryStatus(ExecutionSummary &summary)
{
   if(summary.attempted == 0)
      return "UNKNOWN";
   if(summary.completed == summary.attempted)
      return "EXECUTED";
   if(summary.rejected == summary.attempted && summary.filledVolume <= 0.00000001)
      return "FAILED";
   if(summary.completed > 0 || summary.partial > 0 || summary.filledVolume > 0.00000001
      || (summary.rejected > 0 && summary.uncertain > 0))
      return "PARTIAL";
   return "UNKNOWN";
}

void ReportExecutionSummary(SignalCommand &command, ExecutionSummary &summary, string errorText = "")
{
   string status = ExecutionSummaryStatus(summary);
   string reportError = errorText == "" ? summary.errorText : errorText;
   if(status == "PARTIAL" && reportError == "")
      reportError = "One or more broker operations require reconciliation";
   string executions = summary.executionsJson == "" ? "" : "[" + summary.executionsJson + "]";
   ReportWithVolumes(
      command.queueItemId,
      status,
      summary.retcode,
      summary.retcodeExternal,
      summary.brokerComment,
      summary.orderTicket,
      summary.positionTicket,
      summary.dealTicket,
      summary.requestedPrice,
      summary.filledPrice,
      summary.requestedVolume,
      summary.filledVolume,
      summary.remainingVolume,
      reportError,
      executions
   );
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
// first 63. Every component here is fixed-width except the ticket, which a ulong
// bounds at 20 digits, so the name is 60 characters at absolute worst: 14 prefix,
// 8 account tag, 16 hash, 2 separators, 20 ticket. No key the backend can send,
// however long, can move that bound or make two distinct marks share a name.
string LifecycleIdempotencyVariable(SignalCommand &command, ulong ticket = 0)
{
   string scopedKey = LifecycleAccountIdentity() + "|" + LifecycleCommandKey(command);
   ulong hash = LifecycleKeyHash(scopedKey);
   return StringFormat("%s%08X.%08X%08X.%I64u",
      LIFECYCLE_MARK_PREFIX,
      LifecycleAccountTag(),
      (uint)((hash >> 32) & 0xFFFFFFFF),
      (uint)(hash & 0xFFFFFFFF),
      ticket);
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

bool LifecycleAlreadyExecuted(SignalCommand &command, ulong ticket = 0)
{
   return GlobalVariableCheck(LifecycleIdempotencyVariable(command, ticket)) ||
          GlobalVariableCheck(LegacyLifecycleIdempotencyVariable(command, ticket));
}

void MarkLifecycleExecuted(SignalCommand &command, ulong ticket = 0)
{
   string variable = LifecycleIdempotencyVariable(command, ticket);
   datetime writtenAt = TimeCurrent();
   // Write the mark first and register it second. The mark is what stops a second
   // close on a live account, so a full registry must never prevent one being recorded.
   if(GlobalVariableSet(variable, (double)writtenAt) == 0)
   {
      PrintFormat("Telegram TC lifecycle mark NOT recorded variable=%s queue=%s ticket=%I64u error=%d",
         variable,
         command.queueItemId,
         ticket,
         GetLastError());
      return;
   }
   // Only ticket-scoped marks are tracked. A command-scoped mark (CANCEL_PENDING) has
   // nothing observable to bound it: no ticket to watch, and no age at which the EA can
   // prove the server will not ask again. It is left to the terminal's four-week expiry,
   // which renews on every read, so one still being consulted survives and one nothing
   // has asked about is discarded. That is the pre-1.67 behaviour for this one category.
   if(ticket == 0)
      return;
   // Just written, so its four-week clock starts now.
   RegisterLifecycleMark(variable, LifecycleAccountIdentity(), ticket, true, TimeLocal());
}

// Slots are recycled in place and lifecycleMarkCount is a high-water mark that only
// grows, so ReclaimLifecycleMarks can release an entry mid-pass without shifting
// anything under its own index walk.
//
// Returns false when the mark could not be tracked. The caller must not treat that as
// success: an untracked mark still guards its trade but is never refreshed, so it
// expires at four weeks even though its position may still be open.
bool RegisterLifecycleMark(string variable, string identity, ulong ticket, bool owned, datetime refreshedAt)
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
         lifecycleMarks[index].positionTicket = ticket;
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
   lifecycleMarks[freeSlot].positionTicket = ticket;
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
   lifecycleMarks[index].positionTicket = 0;
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

// A name this EA wrote is exactly prefix + 8 hex + '.' + 16 hex + '.' + decimal ticket.
// Every segment is validated rather than assumed, so a variable that merely starts with
// the reserved prefix is not adopted, and a mark is never reclaimed on a guess about
// which account or which position it belongs to.
bool ParseLifecycleMarkName(string variable, string &accountTagText, ulong &ticket)
{
   accountTagText = "";
   ticket = 0;
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
   ticket = (ulong)StringToInteger(digits);
   if(IntegerToString((long)ticket) != digits)
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
   if(!LifecycleIdentityReady())
   {
      Print("Telegram TC: full account identity is not ready; lifecycle mark adoption deferred to the next sweep");
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
      ulong ticket = 0;
      if(!ParseLifecycleMarkName(name, tagText, ticket))
         continue;
      if(tagText != currentTag || ticket == 0)
      {
         skipped++;
         continue;
      }
      // refreshedAt 0 means the first sweep rewrites it. An adopted mark may already be
      // most of the way through its four weeks, so its expiry is pushed back on sight
      // rather than a refresh interval later.
      if(RegisterLifecycleMark(name, identity, ticket, false, 0))
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
// read for a ticket CollectPositionTickets returned, and that only returns positions
// PositionSelectByTicket accepts, so once the position is gone the mark can never be
// consulted again and removing it cannot lose idempotency.
void ReclaimLifecycleMarks()
{
   string identity = LifecycleAccountIdentity();
   datetime now = TimeLocal();
   // Only deciding that a position is gone needs a live connection. Rewriting a
   // terminal global does not, and a long disconnection is precisely when a mark is
   // most at risk of expiring, so the refresh arm runs either way and only the
   // removal arm is gated.
   bool connected = TerminalInfoInteger(TERMINAL_CONNECTED) != 0;
   for(int index = 0; index < lifecycleMarkCount; index++)
   {
      if(!lifecycleMarks[index].active)
         continue;

      bool sameAccount = lifecycleMarks[index].identity == identity;
      bool live = connected && sameAccount
         && PositionSelectByTicket(lifecycleMarks[index].positionTicket);

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
      "{\"accountNumber\":\"%I64d\",\"brokerReady\":true,\"server\":\"%s\",\"company\":\"%s\",\"currency\":\"%s\",\"balance\":%.2f,\"equity\":%.2f,\"profit\":%.2f,\"marginMode\":\"%s\",\"availableSymbols\":%s,\"eaVersion\":\"%s\",\"eaCapabilities\":%s,\"linkCode\":\"%s\"}",
      AccountInfoInteger(ACCOUNT_LOGIN),
      JsonEscape(AccountInfoString(ACCOUNT_SERVER)),
      JsonEscape(AccountInfoString(ACCOUNT_COMPANY)),
      JsonEscape(AccountInfoString(ACCOUNT_CURRENCY)),
      AccountInfoDouble(ACCOUNT_BALANCE),
      AccountInfoDouble(ACCOUNT_EQUITY),
      AccountInfoDouble(ACCOUNT_PROFIT),
      marginMode,
      SymbolsJson(),
      "2.0.0",
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

   json += "]";
   return json;
}

bool HttpGet(string path, string &response)
{
   char data[];
   int httpStatus = 0;
   return HttpRequest("GET", path, "", data, response, httpStatus);
}

bool HttpPost(string path, string body, string &response)
{
   int httpStatus = 0;
   return HttpPost(path, body, response, httpStatus);
}

bool HttpPost(string path, string body, string &response, int &httpStatus)
{
   char data[];
   StringToCharArray(body, data, 0, WHOLE_ARRAY, CP_UTF8);
   if(ArraySize(data) > 0 && data[ArraySize(data) - 1] == 0)
      ArrayResize(data, ArraySize(data) - 1);
   return HttpRequest("POST", path, "Content-Type: application/json\r\n", data, response, httpStatus);
}

bool HttpRequest(string method, string path, string headers, char &data[], string &response, int &httpStatus)
{
   char result[];
   string resultHeaders = "";
   string url = BackendBaseUrl + path;
   ResetLastError();
   int status = WebRequest(method, url, headers, 2000, data, result, resultHeaders);
   httpStatus = status;
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

string JsonEscape(string value)
{
   StringReplace(value, "\\", "\\\\");
   StringReplace(value, "\"", "\\\"");
   StringReplace(value, "\r", " ");
   StringReplace(value, "\n", " ");
   return value;
}
