import { Server } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import packageJson from "../../../package.json";
import { AccountHeader, type AccountHeaderData } from "./components/AccountHeader";
import { AccountsOverview } from "./components/AccountsOverview";
import { CommandPalette, type PaletteCommand } from "./components/CommandPalette";
import type { TelegramDialogSummary } from "./components/DialogPicker";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { buildPlaceholderGrowth } from "./components/GrowthChart";
import { KeyboardShortcutsOverlay } from "./components/KeyboardShortcutsOverlay";
import { LiveRegion } from "./components/LiveRegion";
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
import { SmallViewportNotice } from "./components/SmallViewportNotice";
import { StatusBar } from "./components/StatusBar";
import { SymbolMappingModal } from "./components/SymbolMappingModal";
import { type TabId, WorkspaceTabs } from "./components/WorkspaceTabs";
import { useAnnouncer } from "./hooks/useAnnouncer";
import { useHotkeys } from "./hooks/useHotkeys";
import { apiDelete, apiFetch, apiGet, apiPatch, apiPost } from "./lib/api";
import { EquityGuardianPage } from "./pages/EquityGuardianPage";
import { HistoryPage } from "./pages/HistoryPage";
import { LinkedAccountsPage } from "./pages/LinkedAccountsPage";
import { LogsPage } from "./pages/LogsPage";
import { PerformancePage } from "./pages/PerformancePage";
import { ProvidersPage } from "./pages/ProvidersPage";
import { SettingsPage } from "./pages/SettingsPage";
import { SymbolSettingsPage } from "./pages/SymbolSettingsPage";
import { TelegramSetupPage } from "./pages/TelegramSetupPage";

export interface ProviderPerformanceRow {
  id: string;
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
  Pick<ProviderRowData, "riskMode" | "riskAmount" | "takeProfitLevels" | "runner">
>;

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
    breaches: unknown[];
  }>;
  telegramSessions: Array<{ id: string; phone: string; status: string; profileId?: string }>;
  providers: ProviderRowData[];
  mt5Accounts: Array<{
    id: string;
    accountNumber: string;
    server: string;
    heartbeatStatus: string;
    marginMode: string;
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
    canonicalSymbol: string;
    brokerSymbol: string;
    mappingStatus: string;
    confidence: number;
    reviewRequired: boolean;
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
      status: string;
    }>;
  }>;
  symbolMappings: Array<{
    rawSymbol: string;
    canonicalSymbol: string;
    brokerSymbol: string;
    status: string;
    scope?: string;
    providerId?: string;
    accountId?: string;
  }>;
  executionLogs: Array<{
    id: string;
    queueItemId: string;
    retcode: number;
    brokerComment: string;
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
  "performance",
  "providers",
  "history",
  "equity-guardian",
  "symbols",
  "logs",
];

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
    const tab =
      seg[2] && (TAB_IDS as string[]).includes(seg[2]) ? (seg[2] as TabId) : "performance";
    return { view: "dashboard", accountId: seg[1], tab };
  }
  if (seg[0] && (TAB_IDS as string[]).includes(seg[0])) {
    return { view: "dashboard", accountId: null, tab: seg[0] as TabId };
  }
  return { view: "dashboard", accountId: null, tab: "performance" };
}

function pathForView(viewId: string, accountId: string | null, tab: TabId): string {
  if (viewId === "telegram") return "/telegram";
  if (viewId === "mt5") return "/linked-accounts";
  if (viewId === "settings") return "/settings";
  if (accountId) return `/accounts/${accountId}/${tab}`;
  return tab === "performance" ? "/" : `/${tab}`;
}

function pathForTab(accountId: string | null, tab: TabId): string {
  if (accountId) return `/accounts/${accountId}/${tab}`;
  return tab === "performance" ? "/" : `/${tab}`;
}

export function App({
  initialDialogs = [],
  initialSnapshot,
}: {
  initialDialogs?: TelegramDialogSummary[];
  initialSnapshot?: DashboardSnapshot;
}) {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot>(initialSnapshot ?? emptySnapshot);
  const [availableDialogs, setAvailableDialogs] = useState<TelegramDialogSummary[]>(initialDialogs);
  const [initialLoading, setInitialLoading] = useState(!initialSnapshot);
  const [refreshing, setRefreshing] = useState(false);
  const [lastPollError, setLastPollError] = useState(false);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(
    initialSnapshot ? new Date().toISOString() : null,
  );
  const location = useLocation();
  const navigate = useNavigate();
  const route = useMemo(() => parseRoute(location.pathname), [location.pathname]);
  const activeView = route.view;
  const activeTab = route.tab;
  const selectedAccountId = route.accountId;
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
  const [mappingModalOpen, setMappingModalOpen] = useState(false);
  const [fixtureClassifications, setFixtureClassifications] = useState<
    Record<string, "entry" | "management" | "noise" | "unknown">
  >({});
  const [redactedFixtureText, setRedactedFixtureText] = useState<Record<string, string>>({});
  const [fixtureStatus, setFixtureStatus] = useState<Record<string, string>>({});
  const [aiReviewStatus, setAiReviewStatus] = useState<Record<string, string>>({});
  const [parserActionStatus, setParserActionStatus] = useState<Record<string, string>>({});
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  // Pending link-slots are transient pre-account UI state (not represented in the URL);
  // selecting one clears any focused account and vice versa.
  const [selectedSlotId, setSelectedSlotId] = useState<string | null>(null);

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
  const [viewportTooSmall, setViewportTooSmall] = useState(() => {
    if (typeof window === "undefined") return false;
    if (window.localStorage.getItem("tg-tc.viewport-override") === "1") return false;
    return window.innerWidth < 768;
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.localStorage.getItem("tg-tc.viewport-override") === "1") return;
    let frame = 0;
    function check() {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        setViewportTooSmall(window.innerWidth < 768);
      });
    }
    window.addEventListener("resize", check);
    return () => {
      window.removeEventListener("resize", check);
      window.cancelAnimationFrame(frame);
    };
  }, []);

  useEffect(() => {
    if (initialSnapshot) return;
    let active = true;
    async function load() {
      setRefreshing(true);
      try {
        const data = await apiGet<DashboardSnapshot>("/api/dashboard");
        if (active) {
          setSnapshot(data);
          setLastPollError(false);
          setLastSyncAt(new Date().toISOString());
        }
      } catch {
        if (active) setLastPollError(true);
      } finally {
        if (active) {
          setInitialLoading(false);
          setRefreshing(false);
        }
      }
    }
    void load();
    let interval = window.setInterval(() => void load(), 15_000);
    function handleVisibilityChange() {
      if (document.visibilityState === "hidden") {
        window.clearInterval(interval);
        interval = 0;
      } else if (interval === 0 && active) {
        void load();
        interval = window.setInterval(() => void load(), 15_000);
      }
    }
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      active = false;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [initialSnapshot]);

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

  // Canonicalize a bare /accounts/:id to its default tab.
  useEffect(() => {
    const seg = location.pathname.split("/").filter(Boolean);
    if (seg[0] === "accounts" && seg[1] && !seg[2]) {
      navigate(`/accounts/${seg[1]}/performance`, { replace: true });
    }
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
    const equitySeries = equityPoints.map((point) => point.equity);
    const initialBalance = perf?.initialBalance ?? null;
    const profitSeries =
      initialBalance !== null && equitySeries.length > 0
        ? equitySeries.map((value) => value - initialBalance)
        : [];
    const tail = (arr: number[], count: number) =>
      arr.length > count ? arr.slice(arr.length - count) : arr;
    const series: AccountHeaderData["series"] = {
      balance: equitySeries,
      equity: equitySeries,
      totalProfit: profitSeries,
      today: tail(profitSeries, 12),
      thisWeek: tail(profitSeries, 24),
      thisMonth: tail(profitSeries, 48),
    };

    return {
      connectedPlatform: {
        platform,
        broker,
        accountType,
        expertAdvisorVersion,
        eaActive,
      },
      kpis: {
        balance: focusedAccount
          ? performanceIsLive
            ? (focusedAccount.balance ?? null)
            : null
          : performanceIsLive
            ? (perf?.currentBalance ?? null)
            : null,
        equity: focusedAccount
          ? performanceIsLive
            ? (focusedAccount.equity ?? null)
            : null
          : performanceIsLive
            ? (perf?.currentEquity ?? null)
            : null,
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
        label: account.accountNumber || account.id,
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
        action: () => setActiveView(id),
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
    [snapshot.providers.length],
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
    const view = navItems.find(([id]) => id === activeView)?.[1] ?? "Operations";
    document.title = `TG-TC · ${view}`;
  }, [activeView]);

  const activeProfileId =
    form.profileId ||
    snapshot.telegramSessions.find((session) => session.status === "CONNECTED")?.profileId ||
    "";

  const queuePending = snapshot.signalQueue.filter((item) => item.status === "PENDING").length;
  const growthData = useMemo(() => {
    const usePerformanceSeries =
      !focusedAccount || snapshot.accountPerformance?.accountId === focusedAccount.id;
    const series = usePerformanceSeries ? snapshot.accountPerformance?.equityCurve : undefined;
    if (!series?.length) {
      return buildPlaceholderGrowth(
        snapshot.executionLogs.filter((log) => log.status === "EXECUTED").length,
      );
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
      totalProfit: usePerformanceSeries ? (snapshot.accountPerformance?.totalProfit ?? 0) : 0,
      realizedPnl: usePerformanceSeries
        ? (snapshot.accountPerformance?.realizedPnl ?? undefined)
        : undefined,
      floatingPnl: usePerformanceSeries
        ? (snapshot.accountPerformance?.floatingPnl ?? undefined)
        : undefined,
      netDeposits: usePerformanceSeries
        ? (snapshot.accountPerformance?.netDeposits ?? undefined)
        : undefined,
      numberOfTrades: series.length,
    };
  }, [focusedAccount, snapshot.accountPerformance, snapshot.executionLogs]);

  async function refreshDashboard() {
    setRefreshing(true);
    try {
      const data = await apiGet<DashboardSnapshot>("/api/dashboard");
      setSnapshot(data);
      setLastPollError(false);
      setLastSyncAt(new Date().toISOString());
    } catch {
      setLastPollError(true);
    } finally {
      setRefreshing(false);
    }
  }

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
    if (!window.confirm(`Add ${dialog.title} as a signal provider?`)) return;
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
    await refreshDashboard();
  }

  async function deleteProvider(provider: DashboardSnapshot["providers"][number]) {
    if (!window.confirm(`Remove ${provider.title} from configured providers?`)) return;
    await apiDelete(`/api/providers/${provider.id}`);
    await refreshDashboard();
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
            runner: payload.runner,
          },
        },
      });
      setConfigProvider(null);
      announce(`Saved configuration for ${provider.title} on this account`);
      await refreshDashboard();
      return;
    }
    await apiPatch(`/api/providers/${provider.id}`, {
      parserMode: payload.parserMode,
      lotSize: payload.lotSize,
      riskMode: payload.riskMode,
      riskAmount: payload.riskAmount,
      takeProfitLevels: payload.takeProfitLevels,
      runner: payload.runner,
    });
    setConfigProvider(null);
    announce(`Saved configuration for ${provider.title}`);
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
        riskMode: payload.riskMode,
        riskAmount: payload.riskAmount,
        takeProfitLevels: payload.takeProfitLevels,
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
    await apiPatch("/api/settings", {
      defaultLotSize: Number(formData.get("defaultLotSize")),
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
    });
    await refreshDashboard();
  }

  async function parseRecentProviderMessages() {
    const providers = snapshot.providers.filter((provider) => provider.enabled);
    const providerIds = (providers.length ? providers : snapshot.providers).map(
      (provider) => provider.id,
    );
    if (providerIds.length === 0) return;
    await Promise.all(
      providerIds.map((providerId) => apiPost(`/api/providers/${providerId}/parse-recent?limit=5`)),
    );
    await refreshDashboard();
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
    setParserActionStatus((current) => ({ ...current, [result.id]: "Approving..." }));
    try {
      await apiPost(`/api/signals/${result.id}/approve`);
    } catch (error) {
      setParserActionStatus((current) => ({
        ...current,
        [result.id]: error instanceof Error ? error.message : "Approval failed",
      }));
      return;
    }
    setParserActionStatus((current) => ({ ...current, [result.id]: "Queued" }));
    announce("Signal approved and queued for MT5");
    await refreshDashboard();
  }

  async function ignoreParsedSignal(result: DashboardSnapshot["parserResults"][number]) {
    setParserActionStatus((current) => ({ ...current, [result.id]: "Ignoring..." }));
    await apiPost(`/api/signals/${result.id}/ignore`);
    setParserActionStatus((current) => ({ ...current, [result.id]: "Ignored" }));
    announce("Signal ignored");
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
    });
    await refreshDashboard();
  }

  async function unpauseGuardian(accountId: string) {
    await apiPost(`/api/equity-guardian/${accountId}/unpause`);
    announce("Equity Guardian unpaused");
    await refreshDashboard();
  }

  async function saveSymbolAlias(payload: {
    rawSymbol: string;
    canonicalSymbol: string;
    providerId?: string;
  }) {
    await apiFetch("/api/symbol-mappings/aliases", {
      method: "PUT",
      body: {
        scope: payload.providerId ? "provider" : "global",
        providerId: payload.providerId,
        rawSymbol: payload.rawSymbol,
        canonicalSymbol: payload.canonicalSymbol,
      },
    });
    setMappingModalOpen(false);
    await refreshDashboard();
  }

  async function deleteSymbolMapping(mapping: DashboardSnapshot["symbolMappings"][number]) {
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
    canonicalSymbol: string;
    brokerSymbol: string;
    prefix: string;
    suffix: string;
    includeSymbols: string[];
    excludeSymbols: string[];
  }) {
    await apiFetch(`/api/symbol-mappings/account/${payload.accountId}`, {
      method: "PUT",
      body: {
        accountId: payload.accountId,
        canonicalOverrides: {
          [payload.canonicalSymbol.trim().toUpperCase()]: payload.brokerSymbol.trim(),
        },
        prefix: payload.prefix,
        suffix: payload.suffix,
        includeSymbols: payload.includeSymbols,
        excludeSymbols: payload.excludeSymbols,
      },
    });
    setMappingModalOpen(false);
    await refreshDashboard();
  }

  const showDashboard = activeView === "dashboard";
  const slotFocused = showDashboard && Boolean(focusedSlot);
  const dashTab = (id: TabId) => showDashboard && !slotFocused && activeTab === id;
  const showTelegram = activeView === "telegram";
  const showProviders = dashTab("providers") || activeView === "providers";
  const showParser = dashTab("logs") || activeView === "parser";
  const showTrades = dashTab("history") || activeView === "trades";
  const showMt5 = activeView === "mt5";
  const showMapping = dashTab("symbols") || activeView === "mapping";
  const showSettings = activeView === "settings";
  const showEquityGuardian = dashTab("equity-guardian");
  const showPerformance = dashTab("performance");

  function navigateSidebar(viewId: string) {
    if (viewId === "dashboard") {
      setSelectedSlotId(null);
      navigate(selectedAccountId ? `/accounts/${selectedAccountId}/performance` : "/");
      return;
    }
    setActiveView(viewId);
  }

  if (viewportTooSmall) {
    return (
      <SmallViewportNotice
        onContinueAnyway={() => {
          if (typeof window !== "undefined") {
            window.localStorage.setItem("tg-tc.viewport-override", "1");
          }
          setViewportTooSmall(false);
        }}
      />
    );
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
      <StatusBar
        appVersion={packageJson.version}
        database={snapshot.health.database}
        lastPollError={lastPollError}
        lastSyncAt={lastSyncAt}
        onCommandPalette={() => setCommandPaletteOpen(true)}
        onRefresh={refreshDashboard}
        queuePending={queuePending}
        refreshing={refreshing}
        telegramAdapter={snapshot.health.telegramAdapter}
      />

      <Sidebar
        accounts={sidebarAccounts}
        activeView={activeView}
        onAddAccount={() => setActiveView("mt5")}
        onNavigate={navigateSidebar}
        onSelectAccount={(id) => setSelectedAccountId(id)}
        onSelectSlot={(id) => selectSlot(id)}
        pendingSlots={sidebarPendingSlots}
        selectedAccountId={selectedAccountId}
        selectedSlotId={selectedSlotId}
      />

      <ErrorBoundary fallbackLabel="This view hit an unexpected error">
        <section className="workspace" id="main-content" tabIndex={-1}>
          {showDashboard && focusedSlot ? (
            <PendingSlotView slot={focusedSlot} />
          ) : showDashboard ? (
            <>
              <AccountHeader data={accountHeaderData} loading={initialLoading} />
              <OutOfSyncBanner
                trades={snapshot.logicalTrades.filter((trade) => trade.status === "OUT_OF_SYNC")}
              />
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
              {!selectedAccountId && snapshot.mt5Accounts.length > 0 ? (
                <AccountsOverview
                  accounts={snapshot.mt5Accounts}
                  onSelectAccount={(id) => setSelectedAccountId(id)}
                />
              ) : null}
              <WorkspaceTabs onChange={setActiveTab} value={activeTab} />
            </>
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
              guardians={snapshot.equityGuardians ?? []}
              onSave={(accountId, formElement) => void saveGuardian(accountId, formElement)}
              onUnpause={(accountId) => void unpauseGuardian(accountId)}
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
                providers={snapshot.providers.map((provider) => ({
                  id: provider.id,
                  title: provider.title,
                  enabled: provider.enabled,
                }))}
                onToggleProvider={(provider) => {
                  const full = snapshot.providers.find((p) => p.id === provider.id);
                  if (full) void toggleProvider(full);
                }}
                onRemoveProvider={(provider) => {
                  const full = snapshot.providers.find((p) => p.id === provider.id);
                  if (full) void deleteProvider(full);
                }}
                onConfigureProvider={(provider) => {
                  const full = snapshot.providers.find((p) => p.id === provider.id);
                  if (full) setConfigProvider(full);
                }}
              />
            ) : null}

            {showProviders ? (
              <ProvidersPage
                accountId={selectedAccountId}
                accountLabel={
                  focusedAccount ? focusedAccount.accountNumber || focusedAccount.id : undefined
                }
                accounts={snapshot.mt5Accounts.map((account) => ({
                  id: account.id,
                  label: account.accountNumber || account.id,
                }))}
                currency={
                  (focusedAccount as { currency?: string } | undefined)?.currency ??
                  (snapshot.mt5Accounts[0] as { currency?: string } | undefined)?.currency
                }
                loading={initialLoading}
                onConfigure={(provider) => setConfigProvider(provider)}
                onExport={() => void exportProviderPerformance()}
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
                aiReviewStatus={aiReviewStatus}
                parserActionStatus={parserActionStatus}
                fixtureStatus={fixtureStatus}
              />
            ) : null}

            {showTrades ? (
              <HistoryPage
                accounts={snapshot.mt5Accounts}
                activeTab={historyTab}
                currency={
                  (focusedAccount as { currency?: string } | undefined)?.currency ??
                  (snapshot.mt5Accounts[0] as { currency?: string } | undefined)?.currency
                }
                focusedAccountId={selectedAccountId}
                onTabChange={setHistoryTab}
              />
            ) : null}

            {showMt5 ? (
              <LinkedAccountsPage
                accounts={snapshot.mt5Accounts}
                slots={snapshot.accountSlots ?? []}
                onCreateSlot={(event) => void createAccountSlot(event)}
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
                loading={initialLoading}
                mappings={snapshot.symbolMappings}
                onAdd={() => setMappingModalOpen(true)}
                onDelete={deleteSymbolMapping}
              />
            ) : null}

            {showSettings ? (
              <SettingsPage
                accounts={snapshot.mt5Accounts.map((account) => ({
                  id: account.id,
                  accountNumber: account.accountNumber,
                  currency: account.currency ?? "USD",
                  drawdownWarnPctOverride: account.drawdownWarnPctOverride ?? null,
                  drawdownDangerPctOverride: account.drawdownDangerPctOverride ?? null,
                }))}
                onAccountRiskThresholdsSave={(accountId, warnPct, dangerPct) =>
                  void saveAccountRiskThresholds(accountId, warnPct, dangerPct)
                }
                onSubmit={saveExecutionSettings}
                onSaveForm={(formElement) => void saveExecutionSettingsForm(formElement)}
                settings={snapshot.appSettings}
              />
            ) : null}
          </section>
        </section>
      </ErrorBoundary>

      <ProviderConfigModal
        accountLabel={
          selectedAccountId && focusedAccount
            ? focusedAccount.accountNumber || focusedAccount.id
            : undefined
        }
        onClose={() => setConfigProvider(null)}
        onSave={saveProviderSettings}
        onTest={testProviderSettings}
        open={configProvider !== null}
        provider={configProvider}
      />

      <SymbolMappingModal
        defaultAccountId={snapshot.mt5Accounts[0]?.id ?? ""}
        defaultProviderId={snapshot.providers[0]?.id}
        onClose={() => setMappingModalOpen(false)}
        onSaveAccountMapping={saveAccountMapping}
        onSaveGlobalAlias={saveSymbolAlias}
        open={mappingModalOpen}
      />

      <CommandPalette
        commands={paletteCommands}
        onClose={() => setCommandPaletteOpen(false)}
        open={commandPaletteOpen}
      />
    </main>
  );
}

function defaultClassification(commandType: string): "entry" | "management" | "noise" | "unknown" {
  if (commandType === "OPEN_TRADE") return "entry";
  if (commandType === "NO_SIGNAL") return "noise";
  if (commandType) return "management";
  return "unknown";
}
