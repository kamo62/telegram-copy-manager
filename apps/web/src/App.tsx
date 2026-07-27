import { Server } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type NavigateOptions, type To, useLocation, useNavigate } from "react-router-dom";
import { AccountHeader, type AccountHeaderData } from "./components/AccountHeader";
import {
  AlertsBanner,
  type OperationalAlert,
  visibleOperationalAlerts,
} from "./components/AlertsBanner";
import { CommandPalette, type PaletteCommand } from "./components/CommandPalette";
import { useConfirm } from "./components/ConfirmDialog";
import type { TelegramDialogSummary } from "./components/DialogPicker";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ExposurePanel } from "./components/ExposurePanel";
import { KeyboardShortcutsOverlay } from "./components/KeyboardShortcutsOverlay";
import { LiveRegion } from "./components/LiveRegion";
import {
  ManualSignalModal,
  type ManualSignalPayload,
  type ManualSignalSeed,
} from "./components/ManualSignalModal";
import { OnboardingCard } from "./components/OnboardingCard";
import { OutOfSyncBanner } from "./components/OutOfSyncBanner";
import { PendingSlotView } from "./components/PendingSlotView";
import {
  ProviderConfigModal,
  type ProviderConfigSubmission,
  type ProviderConfigTestResult,
} from "./components/ProviderConfigModal";
import type { ProviderRowData } from "./components/ProvidersTable";
import type { SetupFormState, SetupStep } from "./components/SetupFlow";
import { navItems, Sidebar } from "./components/Sidebar";
import { SignIn } from "./components/SignIn";
import { LiveStatusBar } from "./components/StatusBar";
import type { SymbolMappingSeed } from "./components/SymbolMappingModal";
import { WorkspaceHeading } from "./components/WorkspaceHeading";
import { type TabId, WorkspaceTabs } from "./components/WorkspaceTabs";
import { useToast } from "./contexts/ToastContext";
import { useAnnouncer } from "./hooks/useAnnouncer";
import { useHotkeys } from "./hooks/useHotkeys";
import {
  apiDelete,
  apiFetch,
  apiGet,
  apiPatch,
  apiPost,
  type HeldQueueItem,
  type HeldQueueItemsResponse,
  type HeldRequeueMode,
  type TradeResolutionAction,
} from "./lib/api";
import { downsample } from "./lib/downsample";
import type { ExposurePosition } from "./lib/exposure";
import { setSyncStatus } from "./lib/syncStatus";
import { EquityGuardianPage } from "./pages/EquityGuardianPage";
import { HistoryPage } from "./pages/HistoryPage";
import { LinkedAccountsPage } from "./pages/LinkedAccountsPage";
import { LogsPage } from "./pages/LogsPage";
import { OperationsPage, signalRequiresReview } from "./pages/OperationsPage";
import { PerformancePage } from "./pages/PerformancePage";
import { ProvidersPage } from "./pages/ProvidersPage";
import { SettingsPage } from "./pages/SettingsPage";
import { SymbolSettingsPage } from "./pages/SymbolSettingsPage";
import { TelegramSetupPage } from "./pages/TelegramSetupPage";

export interface ProviderPerformanceRow {
  id: string;
  currency?: string;
  pips: number;
  pnl: number;
  profit: number;
  gain: number;
  gainPct: number;
  winRate: number;
  averageDrawdown: number;
  copiedDrawdown?: number;
}

// Raw per-account provider config override (subset of provider config fields).
export type PerAccountProviderConfig = Partial<
  Pick<ProviderRowData, "riskMode" | "riskAmount" | "takeProfitLevels" | "runner" | "workFromTpLeg">
>;

type HeldReleaseResult = {
  status?: "PENDING" | "RECORDED";
  remainingTradeCount?: number;
};

export function heldReleaseToast(
  item: Pick<HeldQueueItem, "commandType" | "symbol">,
  mode: HeldRequeueMode,
  result: HeldReleaseResult,
) {
  const symbol = item.symbol.trim();
  if (result.status === "RECORDED") {
    return symbol ? `TP hit recorded for ${symbol}` : "TP hit recorded for selected trade";
  }
  if (result.remainingTradeCount && result.remainingTradeCount > 0) {
    const suffix = result.remainingTradeCount === 1 ? "trade remains" : "trades remain";
    return `Close queued for selected trade; ${result.remainingTradeCount} ${suffix} held`;
  }
  const subject = symbol || item.commandType.replaceAll("_", " ").toLowerCase();
  return mode === "market" ? `${subject} requeued at market` : `${subject} requeued`;
}

export interface AccountPerformanceSnapshot {
  accountId?: string;
  currency: string;
  heartbeatStatus?: string;
  lastHeartbeatAt?: string | null;
  initialBalance: number | null;
  currentBalance?: number | null;
  currentEquity?: number | null;
  currentProfit?: number | null;
  totalProfit: number | null;
  realizedPnl?: number | null;
  floatingPnl?: number | null;
  netDeposits?: number | null;
  today: number | null;
  thisWeek: number | null;
  thisMonth: number | null;
  equityCurve?: Array<{ x: number; equity: number; drawdown: number }>;
}

export interface DashboardSnapshot {
  health: {
    status: string;
    database: string;
    telegramAdapter: string;
  };
  appSettings: {
    defaultLotSize: number;
    defaultRiskPercent: number;
    defaultStopLossPips: number;
    defaultTakeProfitPips: number;
    pollingIntervalSeconds: number;
    allowedOrderTypes: string[];
    azureOpenAIKeyConfigured: boolean;
    dedupWindowSeconds: number;
    maxOpenTradeAgeSeconds: number;
    drawdownWarnPct: number;
    drawdownDangerPct: number;
    reportingCurrency: "USD" | "ZAR";
    usdZarRate: number;
    alertBotConfigured?: boolean;
    alertChatId?: string;
    alertOnGuardianPause?: boolean;
    alertOnEaOffline?: boolean;
    alertOnExecFailed?: boolean;
    alertOnHeld?: boolean;
    alertOnTelegramStall?: boolean;
  };
  accountPerformance?: AccountPerformanceSnapshot;
  accountPerformanceByAccount?: Record<string, AccountPerformanceSnapshot>;
  providerPerformance?: ProviderPerformanceRow[];
  // Per-account provider performance keyed by MT5 account id (used by the account-scoped
  // Providers tab); aggregate `providerPerformance` is used by the overview.
  providerPerformanceByAccount?: Record<string, ProviderPerformanceRow[]>;
  accountSlots?: Array<{
    id: string;
    name: string;
    linkCode: string;
    status: string;
    accountNumber: string;
    server: string;
    createdAt?: string;
  }>;
  accountProviderLinks?: Array<{
    accountId: string;
    providerId: string;
    enabled: boolean;
    config?: PerAccountProviderConfig;
  }>;
  equityGuardians?: Array<{
    accountId: string;
    accountNumber: string;
    threshold: number;
    currentDrawdown: number;
    paused: boolean;
    enabled: boolean;
    breaches: unknown[];
  }>;
  telegramSessions: Array<{ id: string; phone: string; status: string; profileId?: string }>;
  telegramHealth?: Array<{
    sessionId: string;
    connected: boolean;
    lastContactAt?: string;
    stalledSeconds?: number;
    stalled: boolean;
  }>;
  alerts?: Array<{
    kind: string;
    severity: "warn" | "error";
    message: string;
    accountId?: string;
    detail?: Record<string, unknown>;
  }>;
  providers: ProviderRowData[];
  mt5Accounts: Array<{
    id: string;
    accountNumber: string;
    nickname?: string | null;
    server: string;
    heartbeatStatus: string;
    marginMode: string;
    eaVersion?: string;
    eaCapabilities?: string[];
    availableSymbols?: string[];
    currency?: string;
    balance?: number;
    equity?: number;
    profit?: number;
    initialBalance?: number;
    openPositionCount?: number;
    pendingOrderCount?: number;
    externalPositionCount?: number;
    externalOrderCount?: number;
    appPositions?: ExternalBrokerPosition[];
    appOrders?: ExternalBrokerPosition[];
    externalPositions?: ExternalBrokerPosition[];
    externalOrders?: ExternalBrokerPosition[];
    symbols?: Array<{
      symbol: string;
      bid?: number;
      ask?: number;
    }>;
    closedTrades?: ClosedTradeRow[];
    externalCloses?: ClosedTradeRow[];
    lastHeartbeatAt?: string;
    lastSnapshotAt?: string;
    drawdownWarnPctOverride?: number | null;
    drawdownDangerPctOverride?: number | null;
  }>;
  parserResults: Array<{
    id: string;
    rawMessageId?: string;
    classification?: "entry" | "management" | "noise" | "unknown";
    providerTitle: string;
    rawText: string;
    commandType: string;
    rawSymbol?: string;
    canonicalSymbol: string;
    brokerSymbol: string;
    mappingStatus: string;
    mappingSource?: string;
    mappingWarnings?: string[];
    confidence: number;
    matchedPatternIds?: string[];
    missingFields?: string[];
    warnings?: string[];
    reviewRequired: boolean;
    status?: string;
    heldReason?: string;
    accountId?: string;
    providerId?: string;
    direction?: "BUY" | "SELL";
    orderType?: "MARKET" | "LIMIT" | "STOP";
    entry?: { from?: number; to?: number };
    stopLoss?: number;
    takeProfits?: Array<{ price: number } | number>;
    volume?: number;
    executionMode?: "VIRTUAL_TP" | "SPLIT_ORDER";
  }>;
  parserFixtures?: Array<{
    id: string;
    providerLabel: string;
    classification: string;
    rawText: string;
    expectedCommandType: string;
    expectedSymbol: string;
    createdAt: string;
  }>;
  signalQueue: Array<{
    id: string;
    commandType: string;
    symbol: string;
    status: string;
    volume?: number | null;
    riskPercent?: number | null;
  }>;
  logicalTrades: Array<{
    id: string;
    symbol: string;
    direction: string;
    status: string;
    executionMode: string;
    outOfSyncReason?: string;
    livePositionExists?: boolean;
    matchedBrokerTickets?: string[];
    brokerComment?: string;
    lastSnapshotAt?: string;
    legs: Array<{
      leg: number;
      targetPrice?: number;
      targetSource?: string;
      defaultDistance?: { value: number; unit: string };
      allocationPercent: number;
      volume?: number;
      status: string;
    }>;
  }>;
  symbolMappings: Array<{
    rawSymbol: string;
    canonicalSymbol: string;
    brokerSymbol: string;
    status: string;
    scope?: string;
    hint?: string;
    providerId?: string;
    accountId?: string;
  }>;
  executionLogs: Array<{
    id: string;
    queueItemId: string;
    retcode: number;
    retcodeExternal?: number;
    brokerComment: string;
    errorText?: string;
    orderTicket?: string;
    positionTicket?: string;
    dealTicket?: string;
    requestedPrice?: number;
    filledPrice?: number;
    volume?: number;
    status: string;
    timestamp?: string;
  }>;
}

interface TelegramStatusSnapshot {
  activeProfileId?: string;
  connected: boolean;
  telegramAdapter: string;
  telegramSessions: DashboardSnapshot["telegramSessions"];
}

/**
 * A position or pending order the broker sees but our EA didn't open
 * (manual MT5 click, mobile/web terminal, or another EA on the same account).
 * Surfaced read-only so the operator can see what else is competing for
 * margin / equity on their account. The app never modifies external positions.
 */
export interface ExternalBrokerPosition {
  ticket: string;
  symbol: string;
  type: number;
  volume: number;
  openPrice: number;
  sl: number;
  tp: number;
  profit?: number;
  magic: number;
  comment: string;
}

/**
 * A fully-closed signal trade rolled up for the History › Closed sub-tab.
 * Parent-level fields describe "what this trade was, overall" — entry
 * ticket / weighted-avg open & close prices / total realized P/L / why it
 * closed. The `legs[]` array carries per-close-event detail so the row can
 * be expanded for TP/SL specifics without a separate API call.
 */
export interface ClosedTradeRow {
  tradeId: string;
  shortId: string;
  ticket: string;
  symbol: string;
  direction: "BUY" | "SELL";
  origin: "ea" | "manual";
  volume: number;
  openPrice: number;
  closePrice: number;
  realizedPnl: number;
  result: string;
  closeReason?: string;
  netResult?: "WIN" | "LOSS" | "BE";
  closedAt: string;
  tpLegs: Array<{ leg: number; targetPrice?: number; hit: boolean }>;
  tpHitCount: number;
  tpTotal: number;
  legs: Array<{
    id: string;
    action: "FULL_CLOSE" | "PARTIAL_CLOSE";
    legId: string;
    legIndex?: number;
    targetPrice?: number;
    volume: number;
    price: number;
    pnl: number;
    source: string;
    closedAt: string;
    orderTicket: string;
    positionTicket: string;
    dealTicket: string;
  }>;
}

export type { TelegramDialogSummary };

const telegramAuthStorageKey = "telegram-tc.pending-auth";

const emptySnapshot: DashboardSnapshot = {
  health: { status: "loading", database: "loading", telegramAdapter: "mock" },
  appSettings: {
    defaultLotSize: 0.1,
    defaultRiskPercent: 1,
    defaultStopLossPips: 50,
    defaultTakeProfitPips: 200,
    pollingIntervalSeconds: 2,
    allowedOrderTypes: ["MARKET", "LIMIT", "STOP"],
    azureOpenAIKeyConfigured: false,
    dedupWindowSeconds: 300,
    maxOpenTradeAgeSeconds: 0,
    drawdownWarnPct: 10,
    drawdownDangerPct: 20,
    reportingCurrency: "USD",
    usdZarRate: 16,
  },
  accountPerformance: undefined,
  providerPerformance: [],
  accountSlots: [],
  accountProviderLinks: [],
  equityGuardians: [],
  telegramSessions: [],
  providers: [],
  mt5Accounts: [],
  parserResults: [],
  parserFixtures: [],
  signalQueue: [],
  logicalTrades: [],
  symbolMappings: [],
  executionLogs: [],
};

function emptySetupForm(): SetupFormState {
  return {
    apiId: "",
    apiHash: "",
    phone: "",
    code: "",
    password: "",
    sessionId: "",
    profileId: "",
  };
}

function readPendingAuth(): Partial<SetupFormState> {
  try {
    return JSON.parse(
      window.localStorage.getItem(telegramAuthStorageKey) ?? "{}",
    ) as Partial<SetupFormState>;
  } catch {
    return {};
  }
}

function writePendingAuth(form: SetupFormState) {
  window.localStorage.setItem(
    telegramAuthStorageKey,
    JSON.stringify({ phone: form.phone, sessionId: form.sessionId, profileId: form.profileId }),
  );
}

function clearPendingAuth() {
  window.localStorage.removeItem(telegramAuthStorageKey);
}

// --- URL routing ------------------------------------------------------------
// The URL is the single source of truth for which view/tab/account is active.
// Scheme:
//   /                                  → dashboard overview (no account), Performance tab
//   /:tab                              → dashboard overview, given tab (providers, history, …)
//   /accounts/:accountId/:tab          → dashboard scoped to one account, given tab
//   /telegram | /linked-accounts | /settings → global views
const TAB_IDS: TabId[] = [
  "summary",
  "performance",
  "providers",
  "history",
  "equity-guardian",
  "symbols",
  "logs",
];

const TAB_COPY: Record<TabId, { title: string; description: string }> = {
  summary: {
    title: "Operations",
    description: "Live account posture, exposure and the latest desk activity.",
  },
  performance: {
    title: "Performance",
    description: "Equity, realised results and provider attribution without invented data.",
  },
  providers: {
    title: "Providers",
    description: "Copy status, account assignments, execution rules and provider health.",
  },
  history: {
    title: "Trade ledger",
    description: "Open broker exposure, pending orders and reconciled closing history.",
  },
  "equity-guardian": {
    title: "Equity Guardian",
    description: "Opt-in drawdown protection for new opens; lifecycle management stays active.",
  },
  symbols: {
    title: "Symbol routing",
    description: "Trace aliases and account-specific broker mappings from source to execution.",
  },
  logs: {
    title: "Signals & logs",
    description: "Review parsed intent, held signals, queue state and broker execution reports.",
  },
};

interface RouteState {
  view: string;
  accountId: string | null;
  tab: TabId;
}

function parseRoute(pathname: string): RouteState {
  const seg = pathname.split("/").filter(Boolean);
  if (seg[0] === "telegram") return { view: "telegram", accountId: null, tab: "performance" };
  if (seg[0] === "linked-accounts") return { view: "mt5", accountId: null, tab: "performance" };
  if (seg[0] === "settings") return { view: "settings", accountId: null, tab: "performance" };
  if (seg[0] === "accounts" && seg[1]) {
    const requestedTab =
      seg[2] && (TAB_IDS as string[]).includes(seg[2]) ? (seg[2] as TabId) : "performance";
    const tab = requestedTab === "summary" ? "performance" : requestedTab;
    return { view: "dashboard", accountId: seg[1], tab };
  }
  if (seg[0] && (TAB_IDS as string[]).includes(seg[0])) {
    return { view: "dashboard", accountId: null, tab: seg[0] as TabId };
  }
  return { view: "dashboard", accountId: null, tab: "summary" };
}

function pathForView(viewId: string, accountId: string | null, tab: TabId): string {
  if (viewId === "telegram") return "/telegram";
  if (viewId === "mt5") return "/linked-accounts";
  if (viewId === "settings") return "/settings";
  if (viewId === "providers") return "/providers";
  if (viewId === "parser") return "/logs";
  if (viewId === "trades") return "/history";
  if (viewId === "mapping") return "/symbols";
  if (accountId) return `/accounts/${accountId}/${tab === "summary" ? "performance" : tab}`;
  return tab === "summary" ? "/" : `/${tab}`;
}

function pathForTab(accountId: string | null, tab: TabId): string {
  if (accountId) return `/accounts/${accountId}/${tab === "summary" ? "performance" : tab}`;
  return tab === "summary" ? "/" : `/${tab}`;
}

export function dashboardSnapshotsEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => dashboardSnapshotsEqual(value, right[index]))
    );
  }
  const leftKeys = Object.keys(left);
  const rightRecord = right as Record<string, unknown>;
  return (
    leftKeys.length === Object.keys(rightRecord).length &&
    leftKeys.every(
      (key) =>
        Object.hasOwn(rightRecord, key) &&
        dashboardSnapshotsEqual((left as Record<string, unknown>)[key], rightRecord[key]),
    )
  );
}

interface HeartbeatDelta {
  accountId: string;
  balance: number;
  equity: number;
  profit: number;
  heartbeatStatus: string;
  now: string;
}

function parseHeartbeatDelta(event: Event): HeartbeatDelta | null {
  try {
    const data = JSON.parse((event as MessageEvent<string>).data) as Partial<HeartbeatDelta>;
    if (
      typeof data.accountId !== "string" ||
      !data.accountId ||
      !Number.isFinite(data.balance) ||
      !Number.isFinite(data.equity) ||
      !Number.isFinite(data.profit) ||
      typeof data.heartbeatStatus !== "string" ||
      !data.heartbeatStatus ||
      typeof data.now !== "string" ||
      !Number.isFinite(Date.parse(data.now))
    ) {
      return null;
    }
    return data as HeartbeatDelta;
  } catch {
    return null;
  }
}

function applyHeartbeatDelta(
  snapshot: DashboardSnapshot,
  delta: HeartbeatDelta,
): DashboardSnapshot | null {
  const previousAccount = snapshot.mt5Accounts.find((account) => account.id === delta.accountId);
  if (!previousAccount || previousAccount.heartbeatStatus !== delta.heartbeatStatus) return null;

  const mt5Accounts = snapshot.mt5Accounts.map((account) =>
    account.id === delta.accountId
      ? {
          ...account,
          balance: delta.balance,
          equity: delta.equity,
          profit: delta.profit,
          heartbeatStatus: delta.heartbeatStatus,
          lastHeartbeatAt: delta.now,
        }
      : account,
  );
  const performanceFields = {
    currentBalance: delta.balance,
    currentEquity: delta.equity,
    currentProfit: delta.profit,
    floatingPnl: delta.profit,
    heartbeatStatus: delta.heartbeatStatus,
    lastHeartbeatAt: delta.now,
  };
  let accountPerformance = snapshot.accountPerformance;
  if (accountPerformance && accountPerformance.accountId === delta.accountId) {
    accountPerformance = { ...accountPerformance, ...performanceFields };
  } else if (accountPerformance?.accountId === "aggregate") {
    const normalizeCurrency = (currency?: string) => {
      const normalized = currency?.trim().toUpperCase();
      return normalized === "$" ? "USD" : normalized === "R" ? "ZAR" : normalized;
    };
    const sourceCurrency = normalizeCurrency(previousAccount.currency);
    const reportingCurrency = normalizeCurrency(accountPerformance.currency);
    const convert = (value: number) => {
      if (sourceCurrency === reportingCurrency) return value;
      if (sourceCurrency === "USD" && reportingCurrency === "ZAR") {
        return value * snapshot.appSettings.usdZarRate;
      }
      if (sourceCurrency === "ZAR" && reportingCurrency === "USD") {
        return value / snapshot.appSettings.usdZarRate;
      }
      return value;
    };
    const add = (current: number | null | undefined, change: number) =>
      current == null ? current : Math.round((current + convert(change)) * 100) / 100;
    const previousProfit =
      previousAccount.profit ?? (previousAccount.equity ?? 0) - (previousAccount.balance ?? 0);
    const profitChange = delta.profit - previousProfit;
    accountPerformance = {
      ...accountPerformance,
      currentBalance: add(
        accountPerformance.currentBalance,
        delta.balance - (previousAccount.balance ?? 0),
      ),
      currentEquity: add(
        accountPerformance.currentEquity,
        delta.equity - (previousAccount.equity ?? 0),
      ),
      currentProfit: add(accountPerformance.currentProfit, profitChange),
      floatingPnl: add(accountPerformance.floatingPnl, profitChange),
      heartbeatStatus: accountPerformance.heartbeatStatus,
      lastHeartbeatAt: delta.now,
    };
  }

  const perAccountPerformance = snapshot.accountPerformanceByAccount?.[delta.accountId];
  const accountPerformanceByAccount = perAccountPerformance
    ? {
        ...snapshot.accountPerformanceByAccount,
        [delta.accountId]: {
          ...perAccountPerformance,
          ...performanceFields,
        },
      }
    : snapshot.accountPerformanceByAccount;

  return {
    ...snapshot,
    mt5Accounts,
    accountPerformance,
    accountPerformanceByAccount,
  };
}

export function App({
  initialDialogs = [],
  initialSnapshot,
}: {
  initialDialogs?: TelegramDialogSummary[];
  initialSnapshot?: DashboardSnapshot;
}) {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot>(initialSnapshot ?? emptySnapshot);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const [heldItems, setHeldItems] = useState<HeldQueueItem[]>([]);
  const [availableDialogs, setAvailableDialogs] = useState<TelegramDialogSummary[]>(initialDialogs);
  const [initialLoading, setInitialLoading] = useState(!initialSnapshot);
  const [lastPollError, setLastPollError] = useState(false);
  const [mappingSeed, setMappingSeed] = useState<SymbolMappingSeed | null>(null);
  const clearMappingSeed = useCallback(() => setMappingSeed(null), []);
  useEffect(() => {
    if (initialSnapshot) setSyncStatus({ lastSyncAt: new Date().toISOString() });
  }, [initialSnapshot]);
  const location = useLocation();
  const routerNavigate = useNavigate();
  const navigate = useCallback(
    (to: To, options?: NavigateOptions) => {
      void routerNavigate(to, { ...options, flushSync: true });
    },
    [routerNavigate],
  );
  const route = useMemo(() => parseRoute(location.pathname), [location.pathname]);
  const activeView = route.view;
  const activeTab = route.tab;
  const selectedAccountId = route.accountId;
  useLayoutEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [location.pathname]);
  const dashboardUrl = selectedAccountId
    ? `/api/dashboard?accountId=${encodeURIComponent(selectedAccountId)}`
    : "/api/dashboard";
  const dashboardRequest = useRef<{ url: string; promise: Promise<DashboardSnapshot> } | undefined>(
    undefined,
  );
  const loadDashboard = useCallback(() => {
    if (dashboardRequest.current?.url === dashboardUrl) {
      return dashboardRequest.current.promise;
    }
    const promise = apiGet<DashboardSnapshot>(dashboardUrl);
    dashboardRequest.current = { url: dashboardUrl, promise };
    const clear = () => {
      if (dashboardRequest.current?.promise === promise) dashboardRequest.current = undefined;
    };
    void promise.then(clear, clear);
    return promise;
  }, [dashboardUrl]);
  const applyDashboardSnapshot = useCallback((data: DashboardSnapshot) => {
    setSnapshot((current) => (dashboardSnapshotsEqual(current, data) ? current : data));
  }, []);
  const [configProvider, setConfigProvider] = useState<ProviderRowData | null>(null);
  const [parserTab, setParserTab] = useState("Recent Parses");
  const [historyTab, setHistoryTab] = useState<"Open" | "Closed">("Open");
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [setupBusy, setSetupBusy] = useState(false);
  const [setupError, setSetupError] = useState("");
  const initialPendingAuth = useMemo(() => readPendingAuth(), []);
  const [setupStep, setSetupStep] = useState<SetupStep>(
    initialSnapshot?.telegramSessions.some((session) => session.status === "CONNECTED")
      ? "connected"
      : initialPendingAuth.sessionId
        ? "code"
        : initialSnapshot
          ? "credentials"
          : "checking",
  );
  const [form, setForm] = useState<SetupFormState>({
    ...emptySetupForm(),
    ...initialPendingAuth,
  });
  const [manualSignalOpen, setManualSignalOpen] = useState(false);
  const [manualSignalSeed, setManualSignalSeed] = useState<ManualSignalSeed | undefined>(undefined);
  const [fixtureClassifications, setFixtureClassifications] = useState<
    Record<string, "entry" | "management" | "noise" | "unknown">
  >({});
  const [redactedFixtureText, setRedactedFixtureText] = useState<Record<string, string>>({});
  const [fixtureStatus, setFixtureStatus] = useState<Record<string, string>>({});
  const [aiReviewStatus, setAiReviewStatus] = useState<Record<string, string>>({});
  const [parserActionStatus, setParserActionStatus] = useState<Record<string, string>>({});
  const [parserActionPending, setParserActionPending] = useState<Record<string, boolean>>({});
  const [parseRecentBusy, setParseRecentBusy] = useState(false);
  const [parseRecentResults, setParseRecentResults] = useState<
    Array<{
      providerId: string;
      captured: number;
      inserted: number;
      parsed: number;
      error?: string;
    }>
  >([]);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  // Pending link-slots are transient pre-account UI state (not represented in the URL);
  // selecting one clears any focused account and vice versa.
  const [selectedSlotId, setSelectedSlotId] = useState<string | null>(null);
  const refreshHeldItems = useCallback(async () => {
    const data = await apiGet<HeldQueueItemsResponse>("/api/queue-items/held");
    const items = Array.isArray(data.items) ? data.items : [];
    setHeldItems((current) => (dashboardSnapshotsEqual(current, items) ? current : items));
  }, []);

  // Navigation setters — keep the original names so existing call sites are unchanged, but
  // route changes now flow through the URL instead of local state.
  const setActiveView = useCallback(
    (viewId: string) => {
      setSelectedSlotId(null);
      navigate(pathForView(viewId, selectedAccountId, activeTab));
    },
    [navigate, selectedAccountId, activeTab],
  );
  const setActiveTab = useCallback(
    (tab: TabId) => {
      setSelectedSlotId(null);
      navigate(pathForTab(selectedAccountId, tab));
    },
    [navigate, selectedAccountId],
  );
  const setSelectedAccountId = useCallback(
    (id: string | null) => {
      setSelectedSlotId(null);
      navigate(pathForTab(id, activeTab));
    },
    [navigate, activeTab],
  );
  const selectSlot = useCallback(
    (id: string | null) => {
      setSelectedSlotId(id);
      if (id) navigate("/");
    },
    [navigate],
  );
  const announce = useAnnouncer();
  const toast = useToast();
  const { confirm, dialog: confirmDialog } = useConfirm();
  useEffect(() => {
    if (initialSnapshot) return;
    let active = true;
    async function load() {
      setSyncStatus({ refreshing: true });
      try {
        const data = await loadDashboard();
        if (active) {
          applyDashboardSnapshot(data);
          setLastPollError(false);
          setSyncStatus({ lastSyncAt: new Date().toISOString() });
          void refreshHeldItems().catch(() => undefined);
        }
      } catch {
        if (active) setLastPollError(true);
      } finally {
        setSyncStatus({ refreshing: false });
        if (active) setInitialLoading(false);
      }
    }
    void load();

    // Real-time refresh: subscribe to the server event stream and reload on any
    // delta. Polling stays as a fallback — a slow safety poll while SSE is
    // connected, reverting to the fast 15s poll if SSE is unavailable or drops.
    // EventSource is feature-detected so non-browser/test environments (which
    // lack it) keep the original polling behaviour.
    let pollMs = 15_000;
    let interval = 0;
    const startPolling = () => {
      if (interval === 0 && active) interval = window.setInterval(() => void load(), pollMs);
    };
    const stopPolling = () => {
      if (interval !== 0) {
        window.clearInterval(interval);
        interval = 0;
      }
    };

    let source: EventSource | null = null;
    let debounce = 0;
    const scheduleLoad = () => {
      window.clearTimeout(debounce);
      debounce = window.setTimeout(() => void load(), 200);
    };
    if (typeof EventSource !== "undefined") {
      try {
        source = new EventSource("/api/events");
        const onEvent = () => scheduleLoad();
        const onHeartbeat = (event: Event) => {
          const delta = parseHeartbeatDelta(event);
          const account = delta
            ? snapshotRef.current.mt5Accounts.find((item) => item.id === delta.accountId)
            : undefined;
          if (!delta || !account || account.heartbeatStatus !== delta.heartbeatStatus) {
            scheduleLoad();
            return;
          }
          setSnapshot((current) => applyHeartbeatDelta(current, delta) ?? current);
        };
        for (const type of ["queue", "trade", "snapshot", "audit", "reconciliation", "score"]) {
          source.addEventListener(type, onEvent);
        }
        source.addEventListener("heartbeat", onHeartbeat);
        source.onopen = () => {
          pollMs = 60_000;
          stopPolling();
          startPolling();
        };
        source.onerror = () => {
          pollMs = 15_000;
          stopPolling();
          startPolling();
        };
      } catch {
        source = null;
      }
    }
    startPolling();

    function handleVisibilityChange() {
      if (document.visibilityState === "hidden") {
        stopPolling();
      } else if (active) {
        void load();
        startPolling();
      }
    }
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      active = false;
      stopPolling();
      window.clearTimeout(debounce);
      source?.close();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [applyDashboardSnapshot, initialSnapshot, loadDashboard, refreshHeldItems]);

  const telegramConnected = snapshot.telegramSessions.some(
    (session) => session.status === "CONNECTED",
  );
  useEffect(() => {
    if (!telegramConnected) return;
    void refreshHeldItems().catch(() => undefined);
  }, [refreshHeldItems, telegramConnected]);

  useEffect(() => {
    if (initialSnapshot) return;
    let active = true;
    async function loadTelegramStatus() {
      try {
        const data = await apiGet<TelegramStatusSnapshot>("/api/telegram/status", {
          timeoutMs: 5_000,
        });
        if (!active) return;
        setSnapshot((current) => ({
          ...current,
          health: {
            ...current.health,
            telegramAdapter: data.telegramAdapter || current.health.telegramAdapter,
          },
          telegramSessions: data.telegramSessions,
        }));
        if (
          data.connected ||
          data.telegramSessions.some((session) => session.status === "CONNECTED")
        ) {
          setSetupStep("connected");
          clearPendingAuth();
          return;
        }
        const storedPending = readPendingAuth();
        const pending = storedPending.sessionId
          ? data.telegramSessions.find(
              (session) =>
                session.id === storedPending.sessionId &&
                (session.status === "CODE_REQUIRED" || session.status === "PASSWORD_REQUIRED"),
            )
          : undefined;
        if (pending) {
          setForm((current) => ({
            ...current,
            phone: storedPending.phone ?? pending.phone,
            sessionId: pending.id,
            profileId: pending.profileId ?? "",
          }));
          setSetupStep(pending.status === "PASSWORD_REQUIRED" ? "password" : "code");
          return;
        }
        setSetupStep((current) => (current === "checking" ? "credentials" : current));
      } catch {
        if (active) {
          setSetupStep((current) => (current === "checking" ? "credentials" : current));
        }
      }
    }
    void loadTelegramStatus();
    return () => {
      active = false;
    };
  }, [initialSnapshot]);

  useEffect(() => {
    const hasConnectedSession = snapshot.telegramSessions.some(
      (session) => session.status === "CONNECTED",
    );
    if (hasConnectedSession) {
      setSetupStep((current) => (current === "connected" ? current : "connected"));
      clearPendingAuth();
      return;
    }
    const storedPending = readPendingAuth();
    const pending = storedPending.sessionId
      ? snapshot.telegramSessions.find(
          (session) =>
            session.id === storedPending.sessionId &&
            (session.status === "CODE_REQUIRED" || session.status === "PASSWORD_REQUIRED"),
        )
      : undefined;
    if (pending && !form.sessionId) {
      setForm((current) => ({
        ...current,
        phone: storedPending.phone ?? pending.phone,
        sessionId: pending.id,
        profileId: pending.profileId ?? "",
      }));
      setSetupStep(pending.status === "PASSWORD_REQUIRED" ? "password" : "code");
    }
  }, [form.sessionId, snapshot.telegramSessions]);

  // Guard: a URL pointing at a deleted/unknown account falls back to the overview.
  useEffect(() => {
    if (!selectedAccountId || initialLoading) return;
    if (!snapshot.mt5Accounts.some((account) => account.id === selectedAccountId)) {
      navigate("/", { replace: true });
    }
  }, [selectedAccountId, initialLoading, snapshot.mt5Accounts, navigate]);

  // Account detail starts at Performance; Signals belongs to the all-account desk.
  useEffect(() => {
    const seg = location.pathname.split("/").filter(Boolean);
    if (seg[0] === "accounts" && seg[1] && (!seg[2] || seg[2] === "summary")) {
      navigate(`/accounts/${seg[1]}/performance`, { replace: true });
    }
  }, [location.pathname, navigate]);

  useEffect(() => {
    if (location.pathname === "/review") navigate("/logs", { replace: true });
  }, [location.pathname, navigate]);

  const focusedAccount = useMemo(() => {
    if (selectedAccountId) {
      return snapshot.mt5Accounts.find((account) => account.id === selectedAccountId) ?? null;
    }
    return null;
  }, [selectedAccountId, snapshot.mt5Accounts]);

  const focusedSlot = useMemo(() => {
    if (!selectedSlotId) return null;
    return (snapshot.accountSlots ?? []).find((slot) => slot.id === selectedSlotId) ?? null;
  }, [selectedSlotId, snapshot.accountSlots]);

  // Provider rows for the Providers tab. In account mode each row carries that account's
  // performance plus any per-account config override; in overview mode the aggregate.
  const providerRows = useMemo<ProviderRowData[]>(() => {
    const perf = selectedAccountId
      ? (snapshot.providerPerformanceByAccount?.[selectedAccountId] ?? [])
      : (snapshot.providerPerformance ?? []);
    return snapshot.providers.map((provider) => {
      const base = { ...provider, ...perf.find((row) => row.id === provider.id) };
      if (!selectedAccountId) return base;
      const override = (snapshot.accountProviderLinks ?? []).find(
        (link) => link.accountId === selectedAccountId && link.providerId === provider.id,
      )?.config;
      if (!override) return base;
      return {
        ...base,
        ...override,
        lotSize:
          override.riskMode === "fixed" && override.riskAmount != null
            ? override.riskAmount
            : base.lotSize,
      };
    });
  }, [
    selectedAccountId,
    snapshot.providers,
    snapshot.providerPerformance,
    snapshot.providerPerformanceByAccount,
    snapshot.accountProviderLinks,
  ]);

  const accountHeaderData = useMemo<AccountHeaderData>(() => {
    const accounts = snapshot.mt5Accounts;
    const focusedPerf = focusedAccount
      ? snapshot.accountPerformanceByAccount?.[focusedAccount.id]
      : undefined;
    const perf = focusedPerf ?? snapshot.accountPerformance;
    const onlineCount = accounts.filter((a) => a.heartbeatStatus === "online").length;
    const performanceAccount =
      (perf?.accountId ? accounts.find((account) => account.id === perf.accountId) : undefined) ??
      focusedAccount ??
      accounts[0];
    const focusedPerformanceMatches = Boolean(
      focusedAccount && perf?.accountId === focusedAccount.id,
    );
    const usePerformanceSeries = !focusedAccount || focusedPerformanceMatches;
    const performanceIsLive = focusedAccount
      ? focusedAccount.heartbeatStatus === "online"
      : perf?.heartbeatStatus
        ? perf.heartbeatStatus === "online"
        : !performanceAccount || performanceAccount.heartbeatStatus === "online";
    const headerCurrency = focusedAccount?.currency ?? perf?.currency ?? "$";
    const normalizeAccountCurrency = (currency?: string) => {
      const normalized = currency?.trim().toUpperCase();
      if (normalized === "$") return "USD";
      if (normalized === "R") return "ZAR";
      return normalized || "USD";
    };
    const nativeCurrencies = new Set(
      accounts.map((account) => normalizeAccountCurrency(account.currency)),
    );
    const useNativeCurrencyGroups = !focusedAccount && nativeCurrencies.size > 1;
    const sumComplete = (values: Array<number | null | undefined>) =>
      values.length > 0 && values.every((value): value is number => typeof value === "number")
        ? values.reduce((total, value) => total + value, 0)
        : null;
    const nativeCurrencyGroups = useNativeCurrencyGroups
      ? [...nativeCurrencies].sort().map((currency) => {
          const currencyAccounts = accounts.filter(
            (account) => normalizeAccountCurrency(account.currency) === currency,
          );
          const currencyPerformance = currencyAccounts.map(
            (account) => snapshot.accountPerformanceByAccount?.[account.id],
          );
          return {
            currency,
            accountCount: currencyAccounts.length,
            balance: sumComplete(currencyAccounts.map((account) => account.balance)),
            equity: sumComplete(currencyAccounts.map((account) => account.equity)),
            totalProfit: sumComplete(currencyPerformance.map((entry) => entry?.totalProfit)),
            today: sumComplete(currencyPerformance.map((entry) => entry?.today)),
          };
        })
      : undefined;

    let platform = "—";
    let broker = "—";
    let accountType: "DEMO" | "LIVE" | "—" = "—";
    let eaActive = false;
    let expertAdvisorVersion = "Idle";

    if (focusedAccount) {
      platform = "MT5";
      broker = focusedAccount.server.split("-")[0] || focusedAccount.server;
      accountType = focusedAccount.server.toLowerCase().includes("demo") ? "DEMO" : "LIVE";
      eaActive = focusedAccount.heartbeatStatus === "online";
      expertAdvisorVersion = eaActive ? "Active" : "Idle";
    } else if (accounts.length > 0) {
      platform = `MT5 · ${accounts.length} account${accounts.length === 1 ? "" : "s"}`;
      broker = `${onlineCount} of ${accounts.length} online`;
      const allDemo = accounts.every((a) => a.server.toLowerCase().includes("demo"));
      const allLive = accounts.every((a) => !a.server.toLowerCase().includes("demo"));
      accountType = allDemo ? "DEMO" : allLive ? "LIVE" : "—";
      eaActive = onlineCount > 0;
      expertAdvisorVersion =
        onlineCount === accounts.length ? "All active" : onlineCount === 0 ? "Idle" : "Mixed";
    }

    // Derive sparkline series from the equity curve so each KPI card shows
    // a representative trend. Balance/Equity track equity itself; the P/L
    // cards track cumulative profit (equity − initialBalance) over the
    // relevant window. Today/Week/Month slice the last N points as a cheap
    // approximation — exact per-window aggregation would need a separate
    // backend roll-up and isn't worth the round-trip for a 28px chart.
    const equityPoints = usePerformanceSeries ? (perf?.equityCurve ?? []) : [];
    const fullEquitySeries = equityPoints.map((point) => point.equity);
    const equitySeries = downsample(fullEquitySeries, 96);
    const initialBalance = perf?.initialBalance ?? null;
    const fullProfitSeries =
      initialBalance !== null && fullEquitySeries.length > 0
        ? fullEquitySeries.map((value) => value - initialBalance)
        : [];
    const profitSeries = downsample(fullProfitSeries, 96);
    const tail = (arr: number[], count: number) =>
      arr.length > count ? arr.slice(arr.length - count) : arr;
    const series: AccountHeaderData["series"] = {
      balance: equitySeries,
      equity: equitySeries,
      totalProfit: profitSeries,
      today: tail(fullProfitSeries, 12),
      thisWeek: tail(fullProfitSeries, 24),
      thisMonth: tail(fullProfitSeries, 48),
    };

    return {
      accountId: focusedAccount?.id,
      accountLabel: focusedAccount
        ? focusedAccount.nickname || focusedAccount.accountNumber || focusedAccount.id
        : undefined,
      accountNickname: focusedAccount?.nickname ?? null,
      heartbeatStatus: focusedAccount?.heartbeatStatus ?? perf?.heartbeatStatus,
      lastHeartbeatAt: focusedAccount?.lastHeartbeatAt ?? perf?.lastHeartbeatAt,
      connectedPlatform: {
        platform,
        broker,
        accountType,
        expertAdvisorVersion,
        eaActive,
      },
      kpis: {
        balance: focusedAccount ? (focusedAccount.balance ?? null) : (perf?.currentBalance ?? null),
        equity: focusedAccount ? (focusedAccount.equity ?? null) : (perf?.currentEquity ?? null),
        totalProfit: {
          amount: focusedAccount
            ? usePerformanceSeries
              ? (perf?.totalProfit ?? null)
              : null
            : performanceIsLive
              ? (perf?.totalProfit ?? null)
              : null,
          deltaPercent: null,
        },
        today: { amount: usePerformanceSeries ? (perf?.today ?? null) : null, deltaPercent: null },
        thisWeek: {
          amount: usePerformanceSeries ? (perf?.thisWeek ?? null) : null,
          deltaPercent: null,
        },
        thisMonth: {
          amount: usePerformanceSeries ? (perf?.thisMonth ?? null) : null,
          deltaPercent: null,
        },
      },
      series,
      nativeCurrencyGroups,
      currency: headerCurrency,
    };
  }, [
    focusedAccount,
    snapshot.accountPerformance,
    snapshot.accountPerformanceByAccount,
    snapshot.mt5Accounts,
  ]);

  const sidebarAccounts = useMemo(
    () =>
      snapshot.mt5Accounts.map((account) => ({
        id: account.id,
        label: account.nickname || account.accountNumber || account.id,
        broker: account.server.split("-")[0] || account.server,
        currency: account.currency,
        equity: account.equity,
        status: account.heartbeatStatus,
        online: account.heartbeatStatus === "online",
      })),
    [snapshot.mt5Accounts],
  );

  const sidebarPendingSlots = useMemo(() => {
    const linkedAccountIds = new Set(snapshot.mt5Accounts.map((account) => account.id));
    return (snapshot.accountSlots ?? [])
      .filter((slot) => !slot.accountNumber && !linkedAccountIds.has(slot.id))
      .map((slot) => ({ id: slot.id, name: slot.name, linkCode: slot.linkCode }));
  }, [snapshot.accountSlots, snapshot.mt5Accounts]);

  const guardianHeldCounts = useMemo(
    () =>
      heldItems.reduce<Record<string, number>>((counts, item) => {
        if (item.heldReason === "GUARDIAN" && item.accountId) {
          counts[item.accountId] = (counts[item.accountId] ?? 0) + 1;
        }
        return counts;
      }, {}),
    [heldItems],
  );

  const signalReviewCount = useMemo(() => {
    const parsedReviewCount = snapshot.parserResults.filter(
      (signal) => signal.status !== "HELD" && signalRequiresReview(signal),
    ).length;
    const recentHeldCount = snapshot.parserResults.filter(
      (signal) => signal.status === "HELD",
    ).length;
    return parsedReviewCount + Math.max(heldItems.length, recentHeldCount);
  }, [heldItems.length, snapshot.parserResults]);
  const operationalAlertCount = visibleOperationalAlerts(snapshot.alerts ?? []).length;

  const paletteCommands = useMemo<PaletteCommand[]>(
    () => [
      {
        id: "refresh",
        label: "Refresh dashboard",
        shortcut: "R",
        action: () => void refreshDashboard(),
      },
      ...navItems.map(([id, label], index) => ({
        id: `nav-${id}`,
        label: `Go to ${label}`,
        shortcut: String(index + 1),
        action: () => {
          if (id === "dashboard") {
            setSelectedSlotId(null);
            navigate("/");
            return;
          }
          setActiveView(id);
        },
      })),
      ...sidebarAccounts.map((account) => ({
        id: `account-${account.id}`,
        label: `Open account ${account.label}`,
        action: () => setSelectedAccountId(account.id),
      })),
      ...sidebarPendingSlots.map((slot) => ({
        id: `slot-${slot.id}`,
        label: `Open pending slot ${slot.name}`,
        action: () => selectSlot(slot.id),
      })),
      ...(snapshot.providers.length > 0
        ? [
            {
              id: "parse-recent",
              label: "Parse recent messages",
              action: () => void parseRecentProviderMessages(),
            } as PaletteCommand,
          ]
        : []),
    ],
    [sidebarAccounts, sidebarPendingSlots, snapshot.providers.length],
  );

  useHotkeys((event) => {
    if (commandPaletteOpen || shortcutsOpen) return;
    if (event.key === "?") {
      event.preventDefault();
      setShortcutsOpen(true);
      return;
    }
    if (event.key === "r" || event.key === "R") {
      event.preventDefault();
      void refreshDashboard();
      return;
    }
    if (event.key === "/") {
      event.preventDefault();
      setCommandPaletteOpen(true);
      return;
    }
    if (event.key >= "1" && event.key <= "9") {
      const index = Number(event.key) - 1;
      if (navItems[index]) {
        setActiveView(navItems[index][0]);
      }
    }
  });

  useEffect(() => {
    if (typeof document === "undefined") return;
    const view =
      activeView === "dashboard"
        ? TAB_COPY[activeTab].title
        : (navItems.find(([id]) => id === activeView)?.[1] ?? "Operations");
    document.title = `TG-TC · ${view}`;
  }, [activeTab, activeView]);

  const activeProfileId =
    form.profileId ||
    snapshot.telegramSessions.find((session) => session.status === "CONNECTED")?.profileId ||
    "";

  const queuePending = snapshot.signalQueue.filter((item) => item.status === "PENDING").length;
  const growthData = useMemo(() => {
    const performance = focusedAccount
      ? (snapshot.accountPerformanceByAccount?.[focusedAccount.id] ??
        (snapshot.accountPerformance?.accountId === focusedAccount.id
          ? snapshot.accountPerformance
          : undefined))
      : snapshot.accountPerformance;
    const series = performance?.equityCurve;
    if (!series?.length) {
      return {
        growth: [[], []] as [number[], number[]],
        drawdown: [[], []] as [number[], number[]],
        totalProfit: performance?.totalProfit ?? 0,
        numberOfTrades: 0,
      };
    }
    return {
      growth: [series.map((point) => point.x), series.map((point) => point.equity)] as [
        number[],
        number[],
      ],
      drawdown: [series.map((point) => point.x), series.map((point) => point.drawdown)] as [
        number[],
        number[],
      ],
      totalProfit: performance?.totalProfit ?? 0,
      realizedPnl: performance?.realizedPnl ?? undefined,
      floatingPnl: performance?.floatingPnl ?? undefined,
      netDeposits: performance?.netDeposits ?? undefined,
      numberOfTrades: series.length,
    };
  }, [focusedAccount, snapshot.accountPerformance, snapshot.accountPerformanceByAccount]);

  async function refreshDashboard() {
    setSyncStatus({ refreshing: true });
    try {
      const data = await loadDashboard();
      applyDashboardSnapshot(data);
      setLastPollError(false);
      setSyncStatus({ lastSyncAt: new Date().toISOString() });
    } catch {
      setLastPollError(true);
    } finally {
      setSyncStatus({ refreshing: false });
    }
  }

  const openMappingFromAlert = useCallback(
    (alert: OperationalAlert) => {
      const detail = alert.detail;
      if (
        alert.kind !== "unmapped-symbols" ||
        typeof detail?.accountId !== "string" ||
        typeof detail?.token !== "string"
      ) {
        return;
      }
      setMappingSeed({
        source: "canonical",
        sourceSymbol:
          typeof detail.canonicalSymbol === "string" && detail.canonicalSymbol.trim()
            ? detail.canonicalSymbol
            : detail.token,
        brokerSymbol:
          typeof detail.suggestedBrokerSymbol === "string"
            ? detail.suggestedBrokerSymbol
            : undefined,
      });
      navigate(pathForTab(detail.accountId, "symbols"));
    },
    [navigate],
  );

  const suppressMappingAlert = useCallback(
    async (alert: OperationalAlert) => {
      const detail = alert.detail;
      if (
        alert.kind !== "unmapped-symbols" ||
        typeof detail?.providerId !== "string" ||
        typeof detail?.token !== "string"
      ) {
        return;
      }
      await apiPost(`/api/providers/${detail.providerId}/not-an-instrument`, {
        token: detail.token,
      });
      await refreshDashboard();
    },
    [refreshDashboard],
  );

  async function exportProviderPerformance() {
    const accountId = focusedAccount?.id;
    const query = accountId ? `?accountId=${encodeURIComponent(accountId)}` : "";
    const csv = await apiFetch<string>(`/api/providers/performance/export.csv${query}`, {
      method: "GET",
      headers: { Accept: "text/csv" },
    });
    const filename = `provider-performance-${new Date().toISOString().slice(0, 10)}.csv`;
    const link = document.createElement("a");
    link.href = `data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`;
    link.download = filename;
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  async function exportTradeJournal() {
    const accountId = focusedAccount?.id;
    const query = accountId ? `?accountId=${encodeURIComponent(accountId)}` : "";
    try {
      const data = await apiGet<{ journal: unknown[] }>(`/api/export/journal${query}`);
      const filename = `trade-journal-${new Date().toISOString().slice(0, 10)}.json`;
      const link = document.createElement("a");
      link.href = `data:application/json;charset=utf-8,${encodeURIComponent(
        JSON.stringify(data.journal, null, 2),
      )}`;
      link.download = filename;
      link.style.display = "none";
      document.body.appendChild(link);
      link.click();
      link.remove();
      toast.success(`Exported ${data.journal.length} closed trades`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Export failed");
    }
  }

  async function startTelegramConnection(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const phone = String(formData.get("phone") ?? form.phone).trim();
    if (!phone) return;
    setSetupBusy(true);
    setSetupError("");
    try {
      const data = await apiPost<{
        sessionId: string;
        profileId: string;
        status: string;
        error?: string;
      }>("/api/telegram/start", { phone });
      if (data.error) throw new Error(data.error);
      const nextForm = {
        ...form,
        phone,
        apiHash: "",
        sessionId: data.sessionId,
        profileId: data.profileId,
      };
      setForm(nextForm);
      if (data.status === "CODE_REQUIRED" || data.status === "PASSWORD_REQUIRED") {
        writePendingAuth(nextForm);
      }
      setSetupStep(
        data.status === "PASSWORD_REQUIRED"
          ? "password"
          : data.status === "CODE_REQUIRED"
            ? "code"
            : "connected",
      );
      if (data.status === "CONNECTED") {
        clearPendingAuth();
        await loadDialogs(data.profileId);
      }
    } catch (error) {
      setSetupError(error instanceof Error ? error.message : "Telegram login failed");
    } finally {
      setSetupBusy(false);
    }
  }

  async function submitCode(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    let data: { status: string; error?: string };
    try {
      data = await apiPost<{ status: string; error?: string }>("/api/telegram/verify-code", {
        sessionId: form.sessionId,
        code: form.code,
      });
    } catch (error) {
      setSetupError(error instanceof Error ? error.message : "Telegram code verification failed");
      return;
    }
    if (data.error) {
      setSetupError(data.error);
      return;
    }
    setForm((current) => ({ ...current, code: "" }));
    setSetupStep(data.status === "PASSWORD_REQUIRED" ? "password" : "connected");
    if (data.status === "CONNECTED") {
      clearPendingAuth();
      await loadDialogs(form.profileId);
      await refreshDashboard();
    }
  }

  async function submitPassword(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await apiPost("/api/telegram/submit-password", {
      sessionId: form.sessionId,
      password: form.password,
    });
    setForm((current) => ({ ...current, password: "" }));
    setSetupStep("connected");
    clearPendingAuth();
    await loadDialogs(form.profileId);
    await refreshDashboard();
  }

  async function resetTelegramConnection() {
    setSetupBusy(true);
    setSetupError("");
    try {
      const sessionId =
        form.sessionId ||
        snapshot.telegramSessions.find((session) => session.status === "CONNECTED")?.id ||
        snapshot.telegramSessions.find(
          (session) => session.status === "CODE_REQUIRED" || session.status === "PASSWORD_REQUIRED",
        )?.id;
      if (sessionId) {
        await apiPost("/api/telegram/disconnect", { sessionId });
      }
    } finally {
      clearPendingAuth();
      setForm(emptySetupForm());
      setSetupStep("credentials");
      setSetupBusy(false);
      await refreshDashboard();
    }
  }

  async function loadDialogs(profileId = activeProfileId) {
    if (!profileId) return;
    const data = await apiGet<{ dialogs: TelegramDialogSummary[] }>(
      `/api/telegram/dialogs?profileId=${profileId}`,
      { timeoutMs: 30_000 },
    );
    setAvailableDialogs(data.dialogs);
  }

  async function resyncProvidersToCurrentSession() {
    if (!activeProfileId) return;
    setSetupBusy(true);
    setSetupError("");
    try {
      await apiPost("/api/providers/resync-current-session", { profileId: activeProfileId });
      await loadDialogs(activeProfileId);
      await refreshDashboard();
      announce("Provider Telegram links resynced");
    } catch (error) {
      setSetupError(error instanceof Error ? error.message : "Provider resync failed");
      setLastPollError(true);
    } finally {
      setSetupBusy(false);
    }
  }

  async function selectDialog(dialog: TelegramDialogSummary) {
    if (!activeProfileId) return;
    if (
      !(await confirm({
        title: "Add signal provider?",
        description: `Add ${dialog.title} as a signal provider?`,
        confirmLabel: "Add provider",
        destructive: false,
      }))
    )
      return;
    try {
      await apiPost("/api/providers", {
        profileId: activeProfileId,
        dialogId: dialog.id,
        title: dialog.title,
      });
    } catch {
      setLastPollError(true);
      return;
    }
    await refreshDashboard();
    setActiveView("dashboard");
    setActiveTab("providers");
  }

  async function toggleProvider(provider: DashboardSnapshot["providers"][number]) {
    await apiPatch(`/api/providers/${provider.id}`, { enabled: !provider.enabled });
    toast.success(`${provider.title} ${provider.enabled ? "disabled" : "enabled"}`);
    await refreshDashboard();
  }

  async function deleteProvider(provider: DashboardSnapshot["providers"][number]) {
    const confirmed = await confirm({
      title: "Remove provider?",
      description: `${provider.title} will be removed from configured providers.`,
      confirmLabel: "Remove provider",
    });
    if (!confirmed) return;
    try {
      await apiDelete(`/api/providers/${provider.id}`);
      toast.success(`Removed ${provider.title}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to remove provider");
    }
    await refreshDashboard();
  }

  async function deleteAccount(account: { id: string; accountNumber?: string }) {
    const label = account.accountNumber ?? account.id;
    const confirmed = await confirm({
      title: "Delete account?",
      description: `Permanently delete account ${label} and all of its history, queue items, and snapshots. This cannot be undone.`,
      confirmLabel: "Delete account",
      typeToConfirm: account.accountNumber,
    });
    if (!confirmed) return;
    try {
      await apiDelete(`/api/mt5/accounts/${account.id}`);
      toast.success(`Deleted account ${label}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete account");
    }
    await refreshDashboard();
  }

  async function renameAccount(accountId: string, nickname: string) {
    try {
      await apiPatch(`/api/mt5/accounts/${accountId}`, { nickname });
      toast.success(nickname ? "Account name saved" : "Account name cleared");
      await refreshDashboard();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save account name");
      throw error;
    }
  }

  async function saveProviderSettings(
    provider: ProviderRowData,
    payload: ProviderConfigSubmission,
  ) {
    // The Configure action is only available in account-scoped mode, so a focused account
    // means we persist a per-account override; otherwise fall back to the provider default.
    if (selectedAccountId) {
      await apiFetch(`/api/account-provider-links/${selectedAccountId}/${provider.id}`, {
        method: "PUT",
        body: {
          config: {
            lotSize: payload.lotSize,
            riskMode: payload.riskMode,
            riskAmount: payload.riskAmount,
            takeProfitLevels: payload.takeProfitLevels,
            workFromTpLeg: payload.workFromTpLeg,
            runner: payload.runner,
          },
        },
      });
      setConfigProvider(null);
      announce(`Saved configuration for ${provider.title} on this account`);
      toast.success(`Saved configuration for ${provider.title}`);
      await refreshDashboard();
      return;
    }
    await apiPatch(`/api/providers/${provider.id}`, {
      parserMode: payload.parserMode,
      lockedSymbol: payload.lockedSymbol,
      lotSize: payload.lotSize,
      riskMode: payload.riskMode,
      riskAmount: payload.riskAmount,
      takeProfitLevels: payload.takeProfitLevels,
      workFromTpLeg: payload.workFromTpLeg,
      runner: payload.runner,
    });
    setConfigProvider(null);
    announce(`Saved configuration for ${provider.title}`);
    toast.success(`Saved configuration for ${provider.title}`);
    await refreshDashboard();
  }

  async function testProviderSettings(
    provider: ProviderRowData,
    payload: ProviderConfigSubmission,
    rawText: string,
  ): Promise<ProviderConfigTestResult> {
    const data = await apiPost<{
      error?: string;
      parsed?: {
        commandType?: string;
        canonicalSymbol?: string;
        brokerSymbol?: string;
        takeProfits?: Array<{ allocationPercent?: number }>;
      };
    }>(`/api/providers/${provider.id}/test-config`, {
      rawText,
      config: {
        parserMode: payload.parserMode,
        lockedSymbol: payload.lockedSymbol,
        riskMode: payload.riskMode,
        riskAmount: payload.riskAmount,
        takeProfitLevels: payload.takeProfitLevels,
        workFromTpLeg: payload.workFromTpLeg,
        runner: payload.runner,
      },
    });
    if (data.error || !data.parsed) {
      throw new Error(data.error ?? "Provider config test failed");
    }

    const symbol = data.parsed.brokerSymbol || data.parsed.canonicalSymbol || "unmapped";
    const takeProfitCount = data.parsed.takeProfits?.length ?? 0;
    const takeProfitLabel = `${takeProfitCount} TP${takeProfitCount === 1 ? "" : "s"}`;
    return {
      ok: true,
      summary: [data.parsed.commandType ?? "UNKNOWN", symbol, takeProfitLabel].join(" · "),
    };
  }

  async function saveExecutionSettings(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await saveExecutionSettingsForm(event.currentTarget);
  }

  async function saveAccountRiskThresholds(
    accountId: string,
    warnPct: number | null,
    dangerPct: number | null,
  ) {
    await apiPatch(`/api/accounts/${accountId}/risk-thresholds`, {
      warnPct,
      dangerPct,
    });
    await refreshDashboard();
  }

  async function saveExecutionSettingsForm(formElement: HTMLFormElement) {
    const formData = new FormData(formElement);
    const alertBotToken = String(formData.get("alertBotToken") ?? "").trim();
    const defaultLotSize = Number(String(formData.get("defaultLotSize") ?? "").replace(",", "."));
    if (!Number.isFinite(defaultLotSize) || defaultLotSize <= 0) {
      toast.error("Default lot size must be a positive decimal");
      return;
    }
    await apiPatch("/api/settings", {
      defaultLotSize,
      defaultRiskPercent: Number(formData.get("defaultRiskPercent")),
      defaultStopLossPips: Number(formData.get("defaultStopLossPips")),
      defaultTakeProfitPips: Number(formData.get("defaultTakeProfitPips")),
      azureOpenAIApiKey: String(formData.get("azureOpenAIApiKey") ?? ""),
      pollingIntervalSeconds: Number(formData.get("pollingIntervalSeconds")),
      dedupWindowSeconds: Number(formData.get("dedupWindowSeconds")),
      maxOpenTradeAgeSeconds: Number(formData.get("maxOpenTradeAgeSeconds")),
      allowedOrderTypes: formData.getAll("allowedOrderTypes").map(String),
      drawdownWarnPct: Number(formData.get("drawdownWarnPct")),
      drawdownDangerPct: Number(formData.get("drawdownDangerPct")),
      reportingCurrency: String(formData.get("reportingCurrency") ?? "USD"),
      usdZarRate: Number(formData.get("usdZarRate")),
      ...(alertBotToken ? { alertBotToken } : {}),
      alertChatId: String(formData.get("alertChatId") ?? ""),
      alertOnGuardianPause: formData.has("alertOnGuardianPause"),
      alertOnEaOffline: formData.has("alertOnEaOffline"),
      alertOnExecFailed: formData.has("alertOnExecFailed"),
      alertOnHeld: formData.has("alertOnHeld"),
      alertOnTelegramStall: formData.has("alertOnTelegramStall"),
    });
    toast.success("Settings saved");
    await refreshDashboard();
  }

  async function sendAlertTest() {
    try {
      await apiPost("/api/admin/alert-test");
      toast.success("Test alert sent");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to send test alert");
    }
  }

  async function backupDatabase() {
    try {
      const data = await apiPost<{ filename: string }>("/api/admin/backup");
      toast.success(`Database backup created: ${data.filename}`);
      return data.filename;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Database backup failed");
      return "";
    }
  }

  async function parseRecentProviderMessages() {
    const providers = snapshot.providers.filter((provider) => provider.enabled);
    const providerIds = (providers.length ? providers : snapshot.providers).map(
      (provider) => provider.id,
    );
    if (providerIds.length === 0) return;
    setParseRecentBusy(true);
    try {
      const results = await Promise.all(
        providerIds.map(async (providerId) => {
          try {
            const data = await apiPost<{
              provider?: {
                providerId: string;
                captured: number;
                inserted: number;
                parsed: number;
                error?: string;
              };
            }>(`/api/providers/${providerId}/parse-recent?limit=5`);
            return data.provider ?? { providerId, captured: 0, inserted: 0, parsed: 0 };
          } catch (error) {
            return {
              providerId,
              captured: 0,
              inserted: 0,
              parsed: 0,
              error: error instanceof Error ? error.message : "Parse request failed",
            };
          }
        }),
      );
      setParseRecentResults(results);
      if (results.some((result) => result.error))
        toast.error("Some provider messages could not be parsed");
      await refreshDashboard();
    } finally {
      setParseRecentBusy(false);
    }
  }

  async function saveParserFixture(
    result: DashboardSnapshot["parserResults"][number],
    redactedRawText = "",
  ) {
    if (!result.rawMessageId) return;
    const classification =
      fixtureClassifications[result.rawMessageId] ??
      result.classification ??
      defaultClassification(result.commandType);
    const redactedText = redactedRawText.trim() || redactedFixtureText[result.rawMessageId]?.trim();
    setFixtureStatus((current) => ({ ...current, [result.rawMessageId!]: "Saving" }));
    await apiPatch(`/api/messages/${result.rawMessageId}/classification`, { classification });
    await apiPost(`/api/messages/${result.rawMessageId}/fixture`, {
      classification,
      redacted: Boolean(redactedText),
      redactedRawText: redactedText || undefined,
    });
    setFixtureStatus((current) => ({ ...current, [result.rawMessageId!]: "Saved fixture" }));
    await refreshDashboard();
  }

  async function requestAiReview(result: DashboardSnapshot["parserResults"][number]) {
    setAiReviewStatus((current) => ({ ...current, [result.id]: "Reviewing with GPT..." }));
    let data:
      | {
          review: {
            verdict: string;
            confidence: number;
            reason: string;
            shouldQueue: boolean;
            entry: string;
            stopLoss: string;
            takeProfits: string[];
          };
        }
      | { error: string };
    try {
      data = await apiPost<typeof data>(`/api/signals/${result.id}/ai-review`);
    } catch (error) {
      setAiReviewStatus((current) => ({
        ...current,
        [result.id]: error instanceof Error ? error.message : "GPT review failed",
      }));
      return;
    }
    if ("error" in data) {
      setAiReviewStatus((current) => ({ ...current, [result.id]: data.error }));
      return;
    }
    const fields = [
      data.review.entry ? `ENTRY ${data.review.entry}` : "",
      data.review.stopLoss ? `SL ${data.review.stopLoss}` : "",
      data.review.takeProfits.length ? `TP ${data.review.takeProfits.join(" / ")}` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    setAiReviewStatus((current) => ({
      ...current,
      [result.id]: `${data.review.verdict} · ${fields || data.review.reason}`,
    }));
  }

  async function approveParsedSignal(result: DashboardSnapshot["parserResults"][number]) {
    setParserActionPending((current) => ({ ...current, [result.id]: true }));
    setParserActionStatus((current) => ({ ...current, [result.id]: "Approving…" }));
    try {
      await apiPost(`/api/signals/${result.id}/approve`);
    } catch (error) {
      setParserActionStatus(({ [result.id]: _status, ...current }) => current);
      toast.error(error instanceof Error ? error.message : "Approval failed");
      await refreshDashboard();
      return;
    } finally {
      setParserActionPending((current) => ({ ...current, [result.id]: false }));
    }
    setParserActionStatus((current) => ({ ...current, [result.id]: "APPROVED" }));
    announce("Signal approved and queued for MT5");
    toast.success("Signal approved and queued");
    await refreshDashboard();
  }

  async function ignoreParsedSignal(result: DashboardSnapshot["parserResults"][number]) {
    setParserActionPending((current) => ({ ...current, [result.id]: true }));
    setParserActionStatus((current) => ({ ...current, [result.id]: "Ignoring…" }));
    try {
      await apiPost(`/api/signals/${result.id}/ignore`);
    } catch (error) {
      setParserActionStatus(({ [result.id]: _status, ...current }) => current);
      toast.error(error instanceof Error ? error.message : "Ignore failed");
      await refreshDashboard();
      return;
    } finally {
      setParserActionPending((current) => ({ ...current, [result.id]: false }));
    }
    setParserActionStatus((current) => ({ ...current, [result.id]: "IGNORED" }));
    announce("Signal ignored");
    toast.success("Signal ignored");
    await refreshDashboard();
  }

  function openManualSignal(seed?: ManualSignalSeed) {
    setManualSignalSeed(seed);
    setManualSignalOpen(true);
  }

  async function submitManualSignal(payload: ManualSignalPayload) {
    await apiPost("/api/signals/manual", payload);
    announce("Manual signal force-pushed to MT5");
    toast.success("Manual signal force-pushed to MT5");
    await refreshDashboard();
  }

  async function createAccountSlot(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    await apiPost("/api/account-slots", {
      name: String(data.get("slotName") ?? "MT5 Account Slot"),
    });
    event.currentTarget.reset();
    await refreshDashboard();
  }

  async function deleteAccountSlot(slot: { id: string; name: string }) {
    const confirmed = await confirm({
      title: "Delete link slot?",
      description: `${slot.name || "This link slot"} and its link code will be removed.`,
      confirmLabel: "Delete slot",
    });
    if (!confirmed) return;
    try {
      await apiDelete(`/api/account-slots/${slot.id}`);
      if (selectedSlotId === slot.id) selectSlot(null);
      toast.success(`Deleted ${slot.name || "link slot"}`);
      await refreshDashboard();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to delete link slot");
    }
  }

  async function requeueHeldItem(
    item: HeldQueueItem,
    mode: HeldRequeueMode,
    logicalTradeId?: string,
  ) {
    try {
      const result = await apiPost<HeldReleaseResult>(`/api/queue-items/${item.id}/requeue`, {
        mode,
        ...(logicalTradeId ? { logicalTradeId } : {}),
      });
      toast.success(heldReleaseToast(item, mode, result));
      await Promise.all([refreshHeldItems(), refreshDashboard()]);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to requeue held signal");
    }
  }

  async function dismissHeldItem(item: HeldQueueItem) {
    try {
      await apiPost(`/api/queue-items/${item.id}/dismiss`);
      toast.success(`Dismissed held ${item.symbol} signal`);
      await Promise.all([refreshHeldItems(), refreshDashboard()]);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to dismiss held signal");
    }
  }

  async function toggleAccountProviderLink(
    accountId: string,
    providerId: string,
    enabled: boolean,
  ) {
    await apiFetch(`/api/account-provider-links/${accountId}/${providerId}`, {
      method: "PUT",
      body: { enabled },
    });
    await refreshDashboard();
  }

  async function saveGuardian(accountId: string, formElement: HTMLFormElement) {
    const data = new FormData(formElement);
    await apiPatch(`/api/equity-guardian/${accountId}`, {
      threshold: Number(data.get("threshold")),
      enabled: data.get("enabled") === "on",
    });
    await refreshDashboard();
  }

  async function unpauseGuardian(accountId: string, requeueHeld: boolean) {
    await apiPost(`/api/equity-guardian/${accountId}/unpause`);
    if (requeueHeld) {
      for (const item of heldItems.filter(
        (held) => held.accountId === accountId && held.heldReason === "GUARDIAN",
      )) {
        await apiPost(`/api/queue-items/${item.id}/requeue`, { mode: "market" });
      }
    }
    announce("Equity Guardian unpaused");
    toast.success(requeueHeld ? "Guardian unpaused and held trades requeued" : "Guardian unpaused");
    await Promise.all([refreshHeldItems(), refreshDashboard()]);
  }

  async function resolveTrade(tradeId: string, action: TradeResolutionAction) {
    try {
      await apiPost(`/api/trades/${tradeId}/resolve`, { action });
      toast.success("Out-of-sync trade resolved");
      await refreshDashboard();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to resolve trade");
    }
  }

  async function saveSymbolAlias(payload: {
    rawSymbol: string;
    canonicalSymbol: string;
    providerId?: string;
  }) {
    const saved = await apiFetch<{ error?: string }>("/api/symbol-mappings/aliases", {
      method: "PUT",
      body: {
        scope: payload.providerId ? "provider" : "global",
        providerId: payload.providerId,
        rawSymbol: payload.rawSymbol,
        canonicalSymbol: payload.canonicalSymbol,
      },
    });
    if (saved.error) throw new Error(saved.error);
    await refreshDashboard();
  }

  async function deleteSymbolMapping(mapping: DashboardSnapshot["symbolMappings"][number]) {
    if (mapping.scope === "account · direct" && mapping.accountId) {
      await apiFetch(`/api/symbol-mappings/account/${mapping.accountId}/direct`, {
        method: "DELETE",
        body: { rawSymbol: mapping.rawSymbol },
      });
      await refreshDashboard();
      return;
    }
    await apiFetch("/api/symbol-mappings/aliases", {
      method: "DELETE",
      body: {
        scope: mapping.scope ?? "global",
        providerId: mapping.providerId,
        rawSymbol: mapping.rawSymbol,
      },
    });
    await refreshDashboard();
  }

  async function saveAccountMapping(payload: {
    accountId: string;
    direct?: boolean;
    rawSymbol?: string;
    canonicalSymbol?: string;
    brokerSymbol?: string;
    prefix?: string;
    suffix?: string;
    includeSymbols?: string[];
    excludeSymbols?: string[];
  }) {
    const canonicalSymbol = payload.canonicalSymbol?.trim().toUpperCase();
    const brokerSymbol = payload.brokerSymbol?.trim();
    await apiFetch(`/api/symbol-mappings/account/${payload.accountId}`, {
      method: "PUT",
      body: payload.direct
        ? {
            accountId: payload.accountId,
            rawSymbol: payload.rawSymbol,
            brokerSymbol: payload.brokerSymbol,
            direct: true,
          }
        : {
            accountId: payload.accountId,
            ...(canonicalSymbol && brokerSymbol
              ? { canonicalOverrides: { [canonicalSymbol]: brokerSymbol } }
              : {}),
            ...(payload.prefix !== undefined ? { prefix: payload.prefix } : {}),
            ...(payload.suffix !== undefined ? { suffix: payload.suffix } : {}),
            ...(payload.includeSymbols !== undefined
              ? { includeSymbols: payload.includeSymbols }
              : {}),
            ...(payload.excludeSymbols !== undefined
              ? { excludeSymbols: payload.excludeSymbols }
              : {}),
          },
    });
    await refreshDashboard();
  }

  const showDashboard = activeView === "dashboard";
  const slotFocused = showDashboard && Boolean(focusedSlot);
  const dashTab = (id: TabId) => showDashboard && !slotFocused && activeTab === id;
  const showTelegram = activeView === "telegram";
  const showProviders = dashTab("providers");
  const showParser = dashTab("logs");
  const showTrades = dashTab("history");
  const showMt5 = activeView === "mt5";
  const showMapping = dashTab("symbols");
  const showSettings = activeView === "settings";
  const showEquityGuardian = dashTab("equity-guardian");
  const showPerformance = dashTab("performance");
  const showSummary = dashTab("summary");
  const sidebarActiveView = showDashboard
    ? activeTab === "logs"
      ? "parser"
      : activeTab === "providers"
        ? "providers"
        : activeTab === "symbols"
          ? "mapping"
          : "dashboard"
    : activeView;
  const workspaceHeading = (() => {
    if (activeView === "telegram") {
      return {
        eyebrow: "Source control",
        title: "Telegram setup",
        description: "Connect the Telegram session and choose which channels enter the desk.",
      };
    }
    if (activeView === "mt5") {
      return {
        eyebrow: "Execution network",
        title: "Linked accounts",
        description: "Create link slots, inspect EA health and manage provider assignments.",
      };
    }
    if (activeView === "settings") {
      return {
        eyebrow: "Desk controls",
        title: "Settings",
        description: "Configure execution defaults, alerts, risk displays and recovery tools.",
      };
    }
    if (focusedSlot) {
      return {
        eyebrow: "Awaiting EA",
        title: focusedSlot.name || "Pending account link",
        description:
          "Use this slot's code in MT5; the account will appear as soon as the EA checks in.",
      };
    }
    const copy = TAB_COPY[activeTab];
    return {
      eyebrow: focusedAccount
        ? `Account ${focusedAccount.nickname || focusedAccount.accountNumber || focusedAccount.id}`
        : "All accounts",
      ...copy,
    };
  })();

  function navigateSidebar(viewId: string) {
    if (viewId === "dashboard") {
      setSelectedSlotId(null);
      navigate("/");
      return;
    }
    setActiveView(viewId);
  }

  const displayedSetupStep: SetupStep =
    setupStep === "connected" && initialLoading && !initialSnapshot ? "checking" : setupStep;

  if (displayedSetupStep !== "connected") {
    return (
      <SignIn
        form={form}
        busy={setupBusy}
        error={setupError}
        onReset={resetTelegramConnection}
        setForm={setForm}
        setupStep={displayedSetupStep}
        startTelegramConnection={startTelegramConnection}
        submitCode={submitCode}
        submitPassword={submitPassword}
      />
    );
  }

  return (
    <main className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <LiveRegion />
      <KeyboardShortcutsOverlay onClose={() => setShortcutsOpen(false)} open={shortcutsOpen} />
      <LiveStatusBar
        appVersion={
          (globalThis as typeof globalThis & { __APP_VERSION__?: string }).__APP_VERSION__ ?? "dev"
        }
        database={snapshot.health.database}
        lastPollError={lastPollError}
        onCommandPalette={() => setCommandPaletteOpen(true)}
        onRefresh={refreshDashboard}
        queuePending={queuePending}
        telegramAdapter={snapshot.health.telegramAdapter}
        title={workspaceHeading.title}
      />

      <Sidebar
        accounts={sidebarAccounts}
        activeView={sidebarActiveView}
        onAddAccount={() => setActiveView("mt5")}
        onNavigate={navigateSidebar}
        onSelectAccount={(id) => {
          setSelectedSlotId(null);
          navigate(id ? `/accounts/${id}/performance` : "/");
        }}
        onSelectSlot={(id) => selectSlot(id)}
        pendingSlots={sidebarPendingSlots}
        selectedAccountId={selectedAccountId}
        selectedSlotId={selectedSlotId}
        reviewCount={signalReviewCount}
      />

      <ErrorBoundary fallbackLabel="This view hit an unexpected error">
        <section
          className={`workspace ${showSummary ? "workspace-operations" : ""}`}
          id="main-content"
          tabIndex={-1}
        >
          <WorkspaceHeading {...workspaceHeading} />
          {!showSummary ? (
            <AlertsBanner
              alerts={snapshot.alerts ?? []}
              onMapUnmapped={openMappingFromAlert}
              onViewHeld={() => navigate("/logs#held")}
              onSuppressUnmapped={suppressMappingAlert}
            />
          ) : null}
          {showDashboard && focusedSlot ? (
            <PendingSlotView slot={focusedSlot} />
          ) : showDashboard ? (
            <>
              {!showSummary ? (
                <AccountHeader
                  className="account-context-secondary"
                  data={accountHeaderData}
                  key={focusedAccount?.id ?? "aggregate"}
                  loading={initialLoading}
                  onManageLink={() => navigate("/linked-accounts")}
                  onRemoveAccount={
                    focusedAccount ? () => void deleteAccount(focusedAccount) : undefined
                  }
                  onRename={
                    focusedAccount
                      ? (nickname) => renameAccount(focusedAccount.id, nickname)
                      : undefined
                  }
                />
              ) : null}
              {snapshot.providers.length === 0 &&
              snapshot.mt5Accounts.length === 0 &&
              sidebarPendingSlots.length === 0 ? (
                <OnboardingCard
                  hasAccounts={snapshot.mt5Accounts.length > 0}
                  hasProviders={snapshot.providers.length > 0}
                  onConnectTelegram={() => setActiveView("telegram")}
                  onLinkAccount={() => setActiveView("mt5")}
                  telegramConnected={Boolean(
                    snapshot.telegramSessions?.some((s) => s.status === "CONNECTED"),
                  )}
                />
              ) : null}
              <OutOfSyncBanner
                trades={snapshot.logicalTrades.filter((trade) => trade.status === "OUT_OF_SYNC")}
              />
              {focusedAccount && !showSummary ? (
                <ExposurePanel
                  accountId={focusedAccount.id}
                  className="account-context-secondary"
                  positions={[
                    ...((focusedAccount as { appPositions?: ExposurePosition[] }).appPositions ??
                      []),
                    ...((focusedAccount as { externalPositions?: ExposurePosition[] })
                      .externalPositions ?? []),
                  ]}
                />
              ) : null}
              {snapshot.mt5Accounts.length === 0 && sidebarPendingSlots.length === 0 ? (
                <section className="live-empty">
                  <div className="live-empty-glyph" aria-hidden="true">
                    <Server size={28} />
                  </div>
                  <div className="live-empty-body">
                    <strong>No MT5 account connected yet</strong>
                    <p>
                      Create a link slot in{" "}
                      <button
                        className="live-empty-link"
                        onClick={() => setActiveView("mt5")}
                        type="button"
                      >
                        Linked Accounts
                      </button>
                      , paste the code into your EA's <code>LinkCode</code> input, and the account
                      will appear here.
                    </p>
                  </div>
                  <button
                    className="btn btn-primary"
                    onClick={() => setActiveView("mt5")}
                    type="button"
                  >
                    Open Linked Accounts
                  </button>
                </section>
              ) : null}
              <WorkspaceTabs
                accountScoped={Boolean(focusedAccount)}
                onChange={setActiveTab}
                value={activeTab}
              />
            </>
          ) : null}

          <div className="route-surface">
            {showSummary ? (
              <OperationsPage
                focusedAccountId={selectedAccountId}
                onOpenPositions={() => {
                  setHistoryTab("Open");
                  setActiveTab("history");
                }}
                onOpenProviders={() => setActiveTab("providers")}
                onReviewSignals={() => {
                  setParserTab("Recent Parses");
                  setActiveTab("logs");
                }}
                onSelectAccount={(id) => navigate(`/accounts/${id}/performance`)}
                alertCount={operationalAlertCount}
                signalReviewCount={signalReviewCount}
                snapshot={snapshot}
              />
            ) : null}

            {showPerformance ? (
              <PerformancePage
                accounts={focusedAccount ? [focusedAccount] : snapshot.mt5Accounts}
                currency={accountHeaderData.currency}
                data={growthData}
                loading={initialLoading}
                providers={snapshot.providers.map((provider) => ({
                  id: provider.id,
                  title: provider.title,
                }))}
              />
            ) : null}

            {showEquityGuardian ? (
              <EquityGuardianPage
                guardianHeldCounts={guardianHeldCounts}
                guardians={(snapshot.equityGuardians ?? []).filter(
                  (guardian) => !selectedAccountId || guardian.accountId === selectedAccountId,
                )}
                onSave={(accountId, formElement) => void saveGuardian(accountId, formElement)}
                onUnpause={(accountId, requeueHeld) => void unpauseGuardian(accountId, requeueHeld)}
              />
            ) : null}

            <section className="content-grid">
              {showTelegram ? (
                <TelegramSetupPage
                  form={form}
                  busy={setupBusy}
                  error={setupError}
                  onReset={resetTelegramConnection}
                  setForm={setForm}
                  setupStep={setupStep}
                  startTelegramConnection={startTelegramConnection}
                  submitCode={submitCode}
                  submitPassword={submitPassword}
                  dialogs={availableDialogs}
                  onRefreshDialogs={loadDialogs}
                  onResyncProviders={resyncProvidersToCurrentSession}
                  onRemoveDialog={(dialog) => {
                    const provider = snapshot.providers.find((p) => p.dialogId === dialog.id);
                    if (provider) return deleteProvider(provider);
                  }}
                  onSelectDialog={selectDialog}
                  selectedDialogIds={snapshot.providers.map((provider) => provider.dialogId)}
                />
              ) : null}

              {showProviders ? (
                <ProvidersPage
                  accountId={selectedAccountId}
                  accountLabel={
                    focusedAccount
                      ? focusedAccount.nickname || focusedAccount.accountNumber || focusedAccount.id
                      : undefined
                  }
                  accounts={snapshot.mt5Accounts.map((account) => ({
                    id: account.id,
                    label: account.nickname || account.accountNumber || account.id,
                  }))}
                  currency={
                    (focusedAccount as { currency?: string } | undefined)?.currency ??
                    snapshot.appSettings.reportingCurrency
                  }
                  loading={initialLoading}
                  onConfigure={(provider) => setConfigProvider(provider)}
                  onExport={() => void exportProviderPerformance()}
                  onRemoveProvider={(provider) => void deleteProvider(provider)}
                  onToggleProvider={(provider) => void toggleProvider(provider)}
                  onToggleAccountLink={(accountId, providerId, enabled) =>
                    void toggleAccountProviderLink(accountId, providerId, enabled)
                  }
                  providerLinks={snapshot.accountProviderLinks ?? []}
                  providers={providerRows}
                />
              ) : null}

              {showParser ? (
                <LogsPage
                  parserTab={parserTab}
                  onParserTabChange={setParserTab}
                  providersLength={snapshot.providers.length}
                  onParseRecent={() => void parseRecentProviderMessages()}
                  parseRecentBusy={parseRecentBusy}
                  parseRecentResults={parseRecentResults}
                  parserLoading={initialLoading}
                  parserLoadError={lastPollError}
                  snapshot={snapshot}
                  fixtureClassifications={fixtureClassifications}
                  onClassify={(rawMessageId, classification) =>
                    setFixtureClassifications((current) => ({
                      ...current,
                      [rawMessageId]: classification,
                    }))
                  }
                  redactedFixtureText={redactedFixtureText}
                  onRedactedChange={(rawMessageId, value) =>
                    setRedactedFixtureText((current) => ({ ...current, [rawMessageId]: value }))
                  }
                  onSaveFixture={(result, redactedText) =>
                    void saveParserFixture(result, redactedText)
                  }
                  onAiReview={(result) => void requestAiReview(result)}
                  onApprove={(result) => void approveParsedSignal(result)}
                  onIgnore={(result) => void ignoreParsedSignal(result)}
                  onForcePush={openManualSignal}
                  aiReviewStatus={aiReviewStatus}
                  parserActionStatus={parserActionStatus}
                  parserActionPending={parserActionPending}
                  fixtureStatus={fixtureStatus}
                  heldItems={heldItems}
                  onHeldDismiss={dismissHeldItem}
                  onHeldRequeue={requeueHeldItem}
                />
              ) : null}

              {showTrades ? (
                <HistoryPage
                  accounts={snapshot.mt5Accounts}
                  activeTab={historyTab}
                  currency={
                    (focusedAccount as { currency?: string } | undefined)?.currency ??
                    snapshot.appSettings.reportingCurrency
                  }
                  focusedAccountId={selectedAccountId}
                  onTabChange={setHistoryTab}
                  onExportJournal={() => void exportTradeJournal()}
                  onResolveTrade={resolveTrade}
                  trades={snapshot.logicalTrades}
                />
              ) : null}

              {showMt5 ? (
                <LinkedAccountsPage
                  accounts={snapshot.mt5Accounts}
                  slots={snapshot.accountSlots ?? []}
                  onCreateSlot={(event) => void createAccountSlot(event)}
                  onDeleteAccount={(account) => void deleteAccount(account)}
                  onDeleteSlot={(slot) => void deleteAccountSlot(slot)}
                  onEditProviderLinks={() => {
                    setActiveView("dashboard");
                    setActiveTab("providers");
                  }}
                  providers={snapshot.providers}
                  providerLinks={snapshot.accountProviderLinks ?? []}
                />
              ) : null}

              {showMapping ? (
                <SymbolSettingsPage
                  availableBrokerSymbols={focusedAccount?.availableSymbols ?? []}
                  defaultAccountId={focusedAccount?.id ?? ""}
                  defaultProviderId={snapshot.providers[0]?.id}
                  loading={initialLoading}
                  mappings={snapshot.symbolMappings}
                  mappingSeed={mappingSeed}
                  onDelete={deleteSymbolMapping}
                  onMappingSeedConsumed={clearMappingSeed}
                  onSaveAccountMapping={saveAccountMapping}
                  onSaveGlobalAlias={saveSymbolAlias}
                />
              ) : null}

              {showSettings ? (
                <SettingsPage
                  accounts={snapshot.mt5Accounts.map((account) => ({
                    id: account.id,
                    accountNumber: account.accountNumber,
                    nickname: account.nickname,
                    currency: account.currency ?? "USD",
                    drawdownWarnPctOverride: account.drawdownWarnPctOverride ?? null,
                    drawdownDangerPctOverride: account.drawdownDangerPctOverride ?? null,
                  }))}
                  onAccountRiskThresholdsSave={(accountId, warnPct, dangerPct) =>
                    void saveAccountRiskThresholds(accountId, warnPct, dangerPct)
                  }
                  onSubmit={saveExecutionSettings}
                  onSaveForm={(formElement) => void saveExecutionSettingsForm(formElement)}
                  onAlertTest={sendAlertTest}
                  onBackup={backupDatabase}
                  settings={snapshot.appSettings}
                />
              ) : null}
            </section>
          </div>
        </section>
      </ErrorBoundary>

      <ProviderConfigModal
        accountLabel={
          selectedAccountId && focusedAccount
            ? focusedAccount.nickname || focusedAccount.accountNumber || focusedAccount.id
            : undefined
        }
        onClose={() => setConfigProvider(null)}
        onSave={saveProviderSettings}
        onTest={testProviderSettings}
        open={configProvider !== null}
        provider={configProvider}
      />

      <ManualSignalModal
        accounts={snapshot.mt5Accounts}
        onClose={() => setManualSignalOpen(false)}
        onSubmit={submitManualSignal}
        open={manualSignalOpen}
        seed={manualSignalSeed}
      />

      <CommandPalette
        commands={paletteCommands}
        onClose={() => setCommandPaletteOpen(false)}
        open={commandPaletteOpen}
      />

      {confirmDialog}
    </main>
  );
}

function defaultClassification(commandType: string): "entry" | "management" | "noise" | "unknown" {
  if (commandType === "OPEN_TRADE") return "entry";
  if (commandType === "NO_SIGNAL") return "noise";
  if (commandType) return "management";
  return "unknown";
}
