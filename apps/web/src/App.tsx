import { RefreshCw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { AccountHeader, type AccountHeaderData } from "./components/AccountHeader";
import { AccountRow } from "./components/AccountRow";
import { buildPlaceholderGrowth, GrowthChart } from "./components/GrowthChart";
import { CommandPalette, type PaletteCommand } from "./components/CommandPalette";
import { DialogPicker, type TelegramDialogSummary } from "./components/DialogPicker";
import { LogRow } from "./components/LogRow";
import { Panel } from "./components/Panel";
import { ParserResult } from "./components/ParserResult";
import {
  ProviderConfigModal,
  type ProviderConfigSubmission,
} from "./components/ProviderConfigModal";
import { ProvidersTable, type ProviderRowData } from "./components/ProvidersTable";
import { QueueItem } from "./components/QueueItem";
import { SetupFlow, type SetupFormState } from "./components/SetupFlow";
import { SignIn } from "./components/SignIn";
import { navItems, Sidebar } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { type TabId, tabOptions, WorkspaceTabs } from "./components/WorkspaceTabs";
import { TradeCard } from "./components/TradeCard";
import { useHotkeys } from "./hooks/useHotkeys";

export interface DashboardSnapshot {
  health: {
    status: string;
    database: string;
    telegramAdapter: string;
  };
  appSettings: {
    defaultLotSize: number;
    defaultRiskPercent: number;
    pollingIntervalSeconds: number;
    allowedOrderTypes: string[];
  };
  telegramSessions: Array<{ id: string; phone: string; status: string; profileId?: string }>;
  providers: Array<{
    id: string;
    title: string;
    enabled: boolean;
    parserMode: string;
    riskProfile: string;
    lotSize: number;
    lastMessageAt: string;
  }>;
  mt5Accounts: Array<{
    id: string;
    accountNumber: string;
    server: string;
    heartbeatStatus: string;
    marginMode: string;
    openPositionCount?: number;
    pendingOrderCount?: number;
    lastSnapshotAt?: string;
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
    legs: Array<{
      leg: number;
      targetPrice: number;
      allocationPercent: number;
      status: string;
    }>;
  }>;
  symbolMappings: Array<{
    rawSymbol: string;
    canonicalSymbol: string;
    brokerSymbol: string;
    status: string;
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

export type { TelegramDialogSummary };

const emptySnapshot: DashboardSnapshot = {
  health: { status: "loading", database: "loading", telegramAdapter: "mock" },
  appSettings: {
    defaultLotSize: 0.1,
    defaultRiskPercent: 1,
    pollingIntervalSeconds: 2,
    allowedOrderTypes: ["MARKET", "LIMIT", "STOP"],
  },
  telegramSessions: [],
  providers: [],
  mt5Accounts: [],
  parserResults: [],
  signalQueue: [],
  logicalTrades: [],
  symbolMappings: [],
  executionLogs: [],
};

export function App({
  initialDialogs = [],
  initialSnapshot,
}: {
  initialDialogs?: TelegramDialogSummary[];
  initialSnapshot?: DashboardSnapshot;
}) {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot>(initialSnapshot ?? emptySnapshot);
  const [availableDialogs, setAvailableDialogs] = useState<TelegramDialogSummary[]>(initialDialogs);
  const [, setLoading] = useState(!initialSnapshot);
  const [refreshing, setRefreshing] = useState(false);
  const [lastPollError, setLastPollError] = useState(false);
  const [activeView, setActiveView] = useState("dashboard");
  const [activeTab, setActiveTab] = useState<TabId>("performance");
  const [configProvider, setConfigProvider] = useState<ProviderRowData | null>(null);
  const [parserTab, setParserTab] = useState("Recent Parses");
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [setupStep, setSetupStep] = useState<"credentials" | "code" | "password" | "connected">(
    initialSnapshot?.telegramSessions.some((session) => session.status === "CONNECTED")
      ? "connected"
      : "credentials",
  );
  const [form, setForm] = useState<SetupFormState>({
    apiId: "",
    apiHash: "",
    phone: "",
    code: "",
    password: "",
    sessionId: "",
    profileId: "",
  });
  const [aliasForm, setAliasForm] = useState({
    rawSymbol: "",
    canonicalSymbol: "",
  });
  const [mappingForm, setMappingForm] = useState({
    accountId: snapshot.mt5Accounts[0]?.id ?? "mt5-100200300",
    canonicalSymbol: "",
    brokerSymbol: "",
    suffix: "",
    includeSymbols: "",
    excludeSymbols: "",
  });
  const [fixtureClassifications, setFixtureClassifications] = useState<
    Record<string, "entry" | "management" | "noise" | "unknown">
  >({});
  const [redactedFixtureText, setRedactedFixtureText] = useState<Record<string, string>>({});
  const [fixtureStatus, setFixtureStatus] = useState<Record<string, string>>({});

  // Fix (c): sync mappingForm.accountId when real accounts arrive
  const hasSyncedMapping = useRef(false);
  useEffect(() => {
    if (!hasSyncedMapping.current && snapshot.mt5Accounts.length > 0) {
      setMappingForm((current) =>
        current.accountId === "mt5-100200300"
          ? { ...current, accountId: snapshot.mt5Accounts[0]?.id ?? "mt5-100200300" }
          : current,
      );
      hasSyncedMapping.current = true;
    }
  }, [snapshot.mt5Accounts]);

  useEffect(() => {
    if (initialSnapshot) return;
    let active = true;
    async function load() {
      setRefreshing(true);
      try {
        const response = await fetch("/api/dashboard");
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = (await response.json()) as DashboardSnapshot;
        if (active) {
          setSnapshot(data);
          setLastPollError(false);
        }
      } catch {
        if (active) setLastPollError(true);
      } finally {
        if (active) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    }
    void load();
    const interval = window.setInterval(() => void load(), 15_000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [initialSnapshot]);

  useEffect(() => {
    const hasConnectedSession = snapshot.telegramSessions.some(
      (session) => session.status === "CONNECTED",
    );
    if (hasConnectedSession) {
      setSetupStep((current) => (current === "connected" ? current : "connected"));
    }
  }, [snapshot.telegramSessions]);

  const accountHeaderData = useMemo<AccountHeaderData>(() => {
    const primary = snapshot.mt5Accounts[0];
    const broker = primary ? primary.server.split("-")[0] || primary.server : "—";
    const accountType = primary
      ? primary.server.toLowerCase().includes("demo")
        ? "DEMO"
        : "LIVE"
      : "—";
    const eaActive = primary?.heartbeatStatus === "online";
    return {
      connectedPlatform: {
        platform: primary ? "MT5" : "—",
        broker: primary ? broker : "—",
        accountType,
        expertAdvisorVersion: eaActive ? "Active" : "Idle",
        eaActive,
      },
      kpis: {
        initialBalance: null,
        totalProfit: { amount: null, deltaPercent: null },
        thisMonth: { amount: null, deltaPercent: null },
        thisWeek: { amount: null, deltaPercent: null },
        today: { amount: null, deltaPercent: null },
      },
      currency: "$",
    };
  }, [snapshot.mt5Accounts]);

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
    if (commandPaletteOpen) return;
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

  const activeProfileId =
    form.profileId ||
    snapshot.telegramSessions.find((session) => session.status === "CONNECTED")?.profileId ||
    "";

  const queuePending = snapshot.signalQueue.filter((item) => item.status === "PENDING").length;

  async function refreshDashboard() {
    setRefreshing(true);
    try {
      const response = await fetch("/api/dashboard");
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = (await response.json()) as DashboardSnapshot;
      setSnapshot(data);
      setLastPollError(false);
    } catch {
      setLastPollError(true);
    } finally {
      setRefreshing(false);
    }
  }

  async function startTelegramConnection(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const response = await fetch("/api/telegram/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone: form.phone }),
    });
    const data = (await response.json()) as {
      sessionId: string;
      profileId: string;
      status: string;
    };
    setForm((current) => ({
      ...current,
      apiHash: "",
      sessionId: data.sessionId,
      profileId: data.profileId,
    }));
    setSetupStep(data.status === "CODE_REQUIRED" ? "code" : "connected");
    if (data.status === "CONNECTED") {
      await loadDialogs(data.profileId);
    }
  }

  async function submitCode(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const response = await fetch("/api/telegram/verify-code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: form.sessionId, code: form.code }),
    });
    const data = (await response.json()) as { status: string };
    setForm((current) => ({ ...current, code: "" }));
    setSetupStep(data.status === "PASSWORD_REQUIRED" ? "password" : "connected");
    if (data.status === "CONNECTED") {
      await loadDialogs(form.profileId);
      await refreshDashboard();
    }
  }

  async function submitPassword(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await fetch("/api/telegram/submit-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: form.sessionId, password: form.password }),
    });
    setForm((current) => ({ ...current, password: "" }));
    setSetupStep("connected");
    await loadDialogs(form.profileId);
    await refreshDashboard();
  }

  async function loadDialogs(profileId = activeProfileId) {
    if (!profileId) return;
    const response = await fetch(`/api/telegram/dialogs?profileId=${profileId}`);
    const data = (await response.json()) as { dialogs: TelegramDialogSummary[] };
    setAvailableDialogs(data.dialogs);
  }

  async function selectDialog(dialog: TelegramDialogSummary) {
    if (!activeProfileId) return;
    await fetch("/api/providers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        profileId: activeProfileId,
        dialogId: dialog.id,
        title: dialog.title,
      }),
    });
    await refreshDashboard();
  }

  async function toggleProvider(provider: DashboardSnapshot["providers"][number]) {
    await fetch(`/api/providers/${provider.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: !provider.enabled }),
    });
    await refreshDashboard();
  }

  async function saveProviderSettings(
    provider: ProviderRowData,
    payload: ProviderConfigSubmission,
  ) {
    await fetch(`/api/providers/${provider.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        parserMode: payload.parserMode,
        lotSize: payload.lotSize,
      }),
    });
    setConfigProvider(null);
    await refreshDashboard();
  }

  async function saveExecutionSettings(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await saveExecutionSettingsForm(event.currentTarget);
  }

  async function saveExecutionSettingsForm(formElement: HTMLFormElement) {
    const formData = new FormData(formElement);
    await fetch("/api/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        defaultLotSize: Number(formData.get("defaultLotSize")),
        defaultRiskPercent: Number(formData.get("defaultRiskPercent")),
        pollingIntervalSeconds: Number(formData.get("pollingIntervalSeconds")),
        allowedOrderTypes: formData.getAll("allowedOrderTypes").map(String),
      }),
    });
    await refreshDashboard();
  }

  async function parseRecentProviderMessages() {
    const providerId = snapshot.providers[0]?.id;
    if (!providerId) return;
    await fetch(`/api/providers/${providerId}/parse-recent?limit=5`, {
      method: "POST",
    });
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
    await fetch(`/api/messages/${result.rawMessageId}/classification`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ classification }),
    });
    await fetch(`/api/messages/${result.rawMessageId}/fixture`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        classification,
        redacted: Boolean(redactedText),
        redactedRawText: redactedText || undefined,
      }),
    });
    setFixtureStatus((current) => ({ ...current, [result.rawMessageId!]: "Saved fixture" }));
    await refreshDashboard();
  }

  async function saveGlobalAlias(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const rawSymbol = String(data.get("rawSymbol") ?? "");
    const canonicalSymbol = String(data.get("canonicalSymbol") ?? "");
    await fetch("/api/symbol-mappings/aliases", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope: "global",
        rawSymbol,
        canonicalSymbol,
      }),
    });
    setAliasForm({ rawSymbol: "", canonicalSymbol: "" });
    await refreshDashboard();
  }

  async function saveAccountMapping(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const accountId = String(data.get("accountId") ?? "");
    const canonicalSymbol = String(data.get("canonicalSymbol") ?? "");
    const brokerSymbol = String(data.get("brokerSymbol") ?? "");
    const suffix = String(data.get("suffix") ?? "");
    const includeSymbols = String(data.get("includeSymbols") ?? "");
    const excludeSymbols = String(data.get("excludeSymbols") ?? "");
    await fetch(`/api/symbol-mappings/account/${accountId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        accountId,
        canonicalOverrides: {
          [canonicalSymbol.trim().toUpperCase()]: brokerSymbol.trim(),
        },
        suffix: suffix.trim(),
        includeSymbols: commaList(includeSymbols),
        excludeSymbols: commaList(excludeSymbols),
      }),
    });
    await refreshDashboard();
  }

  const showDashboard = activeView === "dashboard";
  const dashTab = (id: TabId) => showDashboard && activeTab === id;
  const showTelegram = activeView === "telegram";
  const showProviders = dashTab("providers") || activeView === "providers";
  const showParser = dashTab("logs") || activeView === "parser";
  const showTrades = dashTab("history") || activeView === "trades";
  const showMt5 = activeView === "mt5";
  const showMapping = dashTab("symbols") || activeView === "mapping";
  const showLogs = dashTab("logs") || activeView === "logs";
  const showSettings = activeView === "settings";
  const showEquityGuardian = dashTab("equity-guardian");
  const showPerformance = dashTab("performance");

  function navigateSidebar(viewId: string) {
    if (viewId === "dashboard") {
      setActiveView("dashboard");
      setActiveTab("performance");
      return;
    }
    setActiveView(viewId);
  }

  if (setupStep !== "connected") {
    return (
      <SignIn
        form={form}
        setForm={setForm}
        setupStep={setupStep}
        startTelegramConnection={startTelegramConnection}
        submitCode={submitCode}
        submitPassword={submitPassword}
      />
    );
  }

  return (
    <main className="app-shell">
      <StatusBar
        database={snapshot.health.database}
        lastPollError={lastPollError}
        onCommandPalette={() => setCommandPaletteOpen(true)}
        onRefresh={refreshDashboard}
        queuePending={queuePending}
        refreshing={refreshing}
        telegramAdapter={snapshot.health.telegramAdapter}
      />

      <Sidebar activeView={activeView} onNavigate={navigateSidebar} />

      <section className="workspace">
        {showDashboard ? <AccountHeader data={accountHeaderData} /> : null}
        {showDashboard ? <WorkspaceTabs onChange={setActiveTab} value={activeTab} /> : null}

        {showPerformance ? (
          <div
            aria-labelledby="tab-performance"
            id="tabpanel-performance"
            role="tabpanel"
          >
            <GrowthChart
              data={buildPlaceholderGrowth(
                snapshot.executionLogs.filter((log) => log.status === "EXECUTED").length,
              )}
            />
          </div>
        ) : null}

        {showEquityGuardian ? (
          <div
            aria-labelledby="tab-equity-guardian"
            className="tab-empty-state"
            id="tabpanel-equity-guardian"
            role="tabpanel"
          >
            <strong>Equity Guardian</strong>
            <span>
              Per-account drawdown limits and pause-on-breach controls will live here. Backend
              support coming soon.
            </span>
          </div>
        ) : null}

        <section className="content-grid">
          {showTelegram ? (
            <Panel className="setup-panel" title="Telegram Setup">
              <SetupFlow
                form={form}
                setForm={setForm}
                setupStep={setupStep}
                startTelegramConnection={startTelegramConnection}
                submitCode={submitCode}
                submitPassword={submitPassword}
              />
              <DialogPicker
                dialogs={availableDialogs}
                onRefresh={loadDialogs}
                onSelect={selectDialog}
              />
            </Panel>
          ) : null}

          {showProviders ? (
            <Panel className="wide-panel" title="Providers">
              <ProvidersTable
                onConfigure={(provider) => setConfigProvider(provider)}
                onToggle={(provider) => void toggleProvider(provider)}
                providers={snapshot.providers}
              />
            </Panel>
          ) : null}

          {showParser ? (
            <Panel
              activeTab={parserTab}
              className="wide-panel"
              onTabChange={setParserTab}
              tabs={["Recent Parses", "Saved Fixtures"]}
              testId="parser-lab-panel"
              title="Parser Lab"
            >
              {parserTab === "Recent Parses" ? (
                <>
                  <div className="panel-toolbar">
                    <button
                      disabled={snapshot.providers.length === 0}
                      onClick={() => void parseRecentProviderMessages()}
                      title="Parse recent provider messages"
                      type="button"
                    >
                      <RefreshCw size={13} aria-hidden="true" />
                      Parse recent
                    </button>
                  </div>
                  <div className="parser-grid">
                    {snapshot.parserResults.map((result) => {
                      const rawMessageId = result.rawMessageId ?? result.id;
                      return (
                        <ParserResult
                          key={result.id}
                          fixtureClassification={fixtureClassifications[rawMessageId]}
                          onClassify={(classification) =>
                            setFixtureClassifications((current) => ({
                              ...current,
                              [rawMessageId]: classification,
                            }))
                          }
                          onRedactedChange={(value) => {
                            setRedactedFixtureText((current) => ({
                              ...current,
                              [rawMessageId]: value,
                            }));
                          }}
                          onSaveFixture={(redactedText) => {
                            void saveParserFixture(result, redactedText);
                          }}
                          redactedText={redactedFixtureText[rawMessageId] ?? ""}
                          result={result}
                          status={fixtureStatus[rawMessageId]}
                        />
                      );
                    })}
                  </div>
                </>
              ) : (
                <div className="empty-state">Saved fixtures view coming soon</div>
              )}
            </Panel>
          ) : null}

          {showTrades ? (
            <Panel title="Signal Queue">
              <div className="queue-board">
                {snapshot.signalQueue.map((item) => (
                  <QueueItem key={item.id} item={item} />
                ))}
              </div>
            </Panel>
          ) : null}

          {showTrades ? (
            <Panel className="wide-panel" title="Trade Lifecycle">
              {snapshot.logicalTrades.map((trade) => (
                <TradeCard key={trade.id} trade={trade} />
              ))}
            </Panel>
          ) : null}

          {showMt5 ? (
            <Panel title="MT5 Accounts">
              <div className="list-stack">
                {snapshot.mt5Accounts.map((account) => (
                  <AccountRow key={account.id} account={account} />
                ))}
              </div>
            </Panel>
          ) : null}

          {showMapping ? (
            <Panel title="Symbol Mapping">
              <div className="mapping-controls">
                <form className="compact-form" onSubmit={saveGlobalAlias}>
                  <label>
                    Alias raw symbol
                    <input
                      name="rawSymbol"
                      onChange={(event) =>
                        setAliasForm((current) => ({ ...current, rawSymbol: event.target.value }))
                      }
                      value={aliasForm.rawSymbol}
                    />
                  </label>
                  <label>
                    Alias canonical symbol
                    <input
                      name="canonicalSymbol"
                      onChange={(event) =>
                        setAliasForm((current) => ({
                          ...current,
                          canonicalSymbol: event.target.value,
                        }))
                      }
                      value={aliasForm.canonicalSymbol}
                    />
                  </label>
                  <button type="submit">Save global alias</button>
                </form>
                <form className="compact-form mapping-form" onSubmit={saveAccountMapping}>
                  <label>
                    Mapping account ID
                    <input
                      name="accountId"
                      onChange={(event) =>
                        setMappingForm((current) => ({ ...current, accountId: event.target.value }))
                      }
                      value={mappingForm.accountId}
                    />
                  </label>
                  <label>
                    Mapping canonical symbol
                    <input
                      name="canonicalSymbol"
                      onChange={(event) =>
                        setMappingForm((current) => ({
                          ...current,
                          canonicalSymbol: event.target.value,
                        }))
                      }
                      value={mappingForm.canonicalSymbol}
                    />
                  </label>
                  <label>
                    Mapping broker symbol
                    <input
                      name="brokerSymbol"
                      onChange={(event) =>
                        setMappingForm((current) => ({
                          ...current,
                          brokerSymbol: event.target.value,
                        }))
                      }
                      value={mappingForm.brokerSymbol}
                    />
                  </label>
                  <label>
                    Mapping suffix
                    <input
                      name="suffix"
                      onChange={(event) =>
                        setMappingForm((current) => ({ ...current, suffix: event.target.value }))
                      }
                      value={mappingForm.suffix}
                    />
                  </label>
                  <label>
                    Mapping include symbols
                    <input
                      name="includeSymbols"
                      onChange={(event) =>
                        setMappingForm((current) => ({
                          ...current,
                          includeSymbols: event.target.value,
                        }))
                      }
                      value={mappingForm.includeSymbols}
                    />
                  </label>
                  <label>
                    Mapping exclude symbols
                    <input
                      name="excludeSymbols"
                      onChange={(event) =>
                        setMappingForm((current) => ({
                          ...current,
                          excludeSymbols: event.target.value,
                        }))
                      }
                      value={mappingForm.excludeSymbols}
                    />
                  </label>
                  <button type="submit">Save account mapping</button>
                </form>
              </div>
              <div className="mapping-table">
                {snapshot.symbolMappings.map((mapping) => (
                  <div className="mapping-row" key={`${mapping.rawSymbol}-${mapping.brokerSymbol}`}>
                    <code>{mapping.rawSymbol}</code>
                    <span>{mapping.canonicalSymbol}</span>
                    <strong>{mapping.brokerSymbol}</strong>
                    <span className={`tag ${mapping.status === "mapped" ? "good" : "warn"}`}>
                      {mapping.status}
                    </span>
                  </div>
                ))}
              </div>
            </Panel>
          ) : null}

          {showLogs ? (
            <Panel className="wide-panel" title="Execution Logs">
              <div className="log-list">
                {snapshot.executionLogs.length === 0 ? (
                  <div className="empty-state">No MT5 reports yet</div>
                ) : (
                  snapshot.executionLogs.map((log) => <LogRow key={log.id} log={log} />)
                )}
              </div>
            </Panel>
          ) : null}

          {showSettings ? (
            <Panel title="Settings">
              <form className="compact-form settings-form" onSubmit={saveExecutionSettings}>
                <label>
                  Default lot size
                  <input
                    defaultValue={snapshot.appSettings.defaultLotSize}
                    min="0.01"
                    name="defaultLotSize"
                    step="0.01"
                    type="number"
                  />
                </label>
                <label>
                  Default risk percent
                  <input
                    defaultValue={snapshot.appSettings.defaultRiskPercent}
                    min="0.01"
                    name="defaultRiskPercent"
                    step="0.01"
                    type="number"
                  />
                </label>
                <label>
                  Polling interval seconds
                  <input
                    defaultValue={snapshot.appSettings.pollingIntervalSeconds}
                    min="1"
                    name="pollingIntervalSeconds"
                    step="1"
                    type="number"
                  />
                </label>
                <label className="checkbox-control">
                  <input
                    defaultChecked={snapshot.appSettings.allowedOrderTypes.includes("MARKET")}
                    name="allowedOrderTypes"
                    type="checkbox"
                    value="MARKET"
                  />
                  Allow market orders
                </label>
                <label className="checkbox-control">
                  <input
                    defaultChecked={snapshot.appSettings.allowedOrderTypes.includes("LIMIT")}
                    name="allowedOrderTypes"
                    type="checkbox"
                    value="LIMIT"
                  />
                  Allow limit orders
                </label>
                <label className="checkbox-control">
                  <input
                    defaultChecked={snapshot.appSettings.allowedOrderTypes.includes("STOP")}
                    name="allowedOrderTypes"
                    type="checkbox"
                    value="STOP"
                  />
                  Allow stop orders
                </label>
                <button
                  onClick={(event) => {
                    const formElement = event.currentTarget.form;
                    if (formElement) void saveExecutionSettingsForm(formElement);
                  }}
                  type="button"
                >
                  Save execution settings
                </button>
              </form>
            </Panel>
          ) : null}
        </section>
      </section>

      <ProviderConfigModal
        onClose={() => setConfigProvider(null)}
        onSave={saveProviderSettings}
        open={configProvider !== null}
        provider={configProvider}
      />

      <CommandPalette
        commands={paletteCommands}
        onClose={() => setCommandPaletteOpen(false)}
        open={commandPaletteOpen}
      />
    </main>
  );
}

function commaList(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function defaultClassification(commandType: string): "entry" | "management" | "noise" | "unknown" {
  if (commandType === "OPEN_TRADE") return "entry";
  if (commandType === "NO_SIGNAL") return "noise";
  if (commandType) return "management";
  return "unknown";
}
