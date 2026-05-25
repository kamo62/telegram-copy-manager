import "./test-setup";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import packageJson from "../../../package.json";
import { App, type DashboardSnapshot } from "./App";
import { SettingsPage } from "./pages/SettingsPage";

afterEach(() => cleanup());

const snapshot: DashboardSnapshot = {
  health: { status: "ok", database: "connected", telegramAdapter: "mock" },
  appSettings: {
    defaultLotSize: 0.1,
    defaultRiskPercent: 1,
    defaultStopLossPips: 50,
    defaultTakeProfitPips: 200,
    pollingIntervalSeconds: 2,
    allowedOrderTypes: ["MARKET", "LIMIT", "STOP"],
    azureOpenAIKeyConfigured: false,
    dedupWindowSeconds: 300,
    drawdownWarnPct: 10,
    drawdownDangerPct: 20,
  },
  telegramSessions: [
    { id: "session-1", phone: "+27821234567", status: "CONNECTED", profileId: "profile-current" },
  ],
  providers: [
    {
      id: "provider-alpha",
      dialogId: "dialog-alpha",
      title: "Alpha FX Signals",
      enabled: false,
      parserMode: "deterministic",
      riskProfile: "balanced",
      lotSize: 0.1,
      lastMessageAt: "2026-05-09T08:00:00.000Z",
    },
  ],
  mt5Accounts: [
    {
      id: "mt5-demo-1",
      accountNumber: "100200300",
      server: "MetaQuotes-Demo",
      heartbeatStatus: "online",
      marginMode: "HEDGING",
      openPositionCount: 1,
      pendingOrderCount: 0,
      lastSnapshotAt: "2026-05-09T09:00:00.000Z",
    },
  ],
  parserResults: [
    {
      id: "parse-1",
      rawMessageId: "raw-1",
      classification: "entry",
      providerTitle: "Alpha FX Signals",
      rawText: "BUY EURUSD @ 1.0850",
      commandType: "OPEN_TRADE",
      canonicalSymbol: "EURUSD",
      brokerSymbol: "EURUSD.raw",
      mappingStatus: "mapped",
      confidence: 0.94,
      reviewRequired: false,
    },
  ],
  signalQueue: [
    { id: "queue-1", commandType: "OPEN_TRADE", symbol: "EURUSD.raw", status: "PENDING" },
  ],
  logicalTrades: [
    {
      id: "trade-1",
      symbol: "EURUSD.raw",
      direction: "BUY",
      status: "OPEN",
      executionMode: "VIRTUAL_TP",
      legs: [
        { leg: 1, targetPrice: 1.09, allocationPercent: 25, status: "PLANNED" },
        { leg: 2, targetPrice: 1.095, allocationPercent: 25, status: "PLANNED" },
        { leg: 3, targetPrice: 1.1, allocationPercent: 25, status: "PLANNED" },
        { leg: 4, targetPrice: 1.105, allocationPercent: 25, status: "PLANNED" },
      ],
    },
  ],
  symbolMappings: [
    {
      rawSymbol: "GOLD",
      canonicalSymbol: "XAUUSD",
      brokerSymbol: "XAUUSD.r",
      status: "mapped",
    },
  ],
  executionLogs: [
    {
      id: "log-1",
      queueItemId: "queue-1",
      retcode: 10009,
      brokerComment: "Request completed",
      status: "EXECUTED",
    },
  ],
};

function clickTab(view: ReturnType<typeof render>, label: string) {
  fireEvent.click(view.getByRole("tab", { name: label }));
}

async function clickTabAsync(view: ReturnType<typeof render>, label: string) {
  fireEvent.click(view.getByRole("tab", { name: label }));
  // Some tab changes trigger async data loads. Wait for the tab selection
  // state before asserting on the rendered panel.
  await waitFor(() =>
    expect(view.getByRole("tab", { name: label }).getAttribute("aria-selected")).toBe("true"),
  );
}

function clickSidebar(view: ReturnType<typeof render>, label: string) {
  const buttons = view.getAllByRole("button", { name: label });
  // Sidebar buttons are full-width; pick the first one (sidebar comes before tabs).
  const sidebarButton = buttons.find((button) => button.closest("aside"));
  if (!sidebarButton) throw new Error(`No sidebar button labelled ${label}`);
  fireEvent.click(sidebarButton);
}

describe("App dashboard", () => {
  test("keeps workspace pages in the initial app module to avoid stale dev-server lazy import failures", async () => {
    const source = await Bun.file(new URL("./App.tsx", import.meta.url)).text();

    expect(source).not.toContain('import("./pages/');
  });

  test("lets the operator restart Telegram login after entering the wrong phone number", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url) === "/api/telegram/start") {
        return Response.json({
          sessionId: "tg-pending",
          profileId: "profile-pending",
          status: "CODE_REQUIRED",
        });
      }
      return Response.json({ ...snapshot, telegramSessions: [] });
    }) as typeof fetch;

    const view = render(<App initialSnapshot={{ ...snapshot, telegramSessions: [] }} />);
    const phoneInput = view.getByLabelText("Phone number") as HTMLInputElement;
    phoneInput.value = "+27726308524";
    const signInForm = phoneInput.closest("form");
    if (!signInForm) throw new Error("Sign-in form not found");
    fireEvent.submit(signInForm);

    await view.findByRole("heading", { name: "Enter the verification code" });
    expect(view.getByRole("button", { name: "Wrong phone number? Start over" })).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Wrong phone number? Start over" }));

    await waitFor(() =>
      expect(calls.some((call) => call.url === "/api/telegram/disconnect")).toBe(true),
    );
    expect(view.getByRole("heading", { name: "Sign in to Telegram" })).toBeTruthy();
  });

  test("renders the usable operations dashboard as the first screen, not a marketing page", () => {
    const view = render(<App initialSnapshot={snapshot} />);

    expect(view.getByRole("heading", { name: "TG-TC · Operations" })).toBeTruthy();
    expect(view.getAllByText("Telegram Setup").length).toBeGreaterThan(0);
    expect(view.getAllByText("Linked Accounts").length).toBeGreaterThan(0);
    expect(view.getAllByText("Live").length).toBeGreaterThan(0);
    expect(view.queryByText("Get started today")).toBeNull();
    expect(view.getByRole("tab", { name: "Performance" })).toBeTruthy();
    expect(view.getByRole("tab", { name: "Providers" })).toBeTruthy();
    expect(view.getByRole("tab", { name: "Logs" })).toBeTruthy();
  });

  test("account header renders MT5 balance and equity before trading P/L windows", () => {
    const view = render(
      <App
        initialSnapshot={{
          ...snapshot,
          accountPerformance: {
            currency: "USD",
            initialBalance: 60.64,
            currentBalance: 12345.67,
            currentEquity: 15432.1,
            totalProfit: -137.5,
            realizedPnl: 61.79,
            floatingPnl: 38.82,
            netDeposits: 0,
            today: 9.04,
            thisWeek: 9.04,
            thisMonth: 9.04,
            equityCurve: [],
          },
        }}
      />,
    );

    expect(view.getByText("Balance")).toBeTruthy();
    expect(view.getByText("Equity")).toBeTruthy();
    expect(view.queryByText("Initial Balance")).toBeNull();
    expect(view.getByText(/12,345\.67/)).toBeTruthy();
    expect(view.getByText(/15,432\.10/)).toBeTruthy();
    expect(view.getByText(/137\.50/)).toBeTruthy();
  });

  test("account header does not present stale MT5 telemetry as live PnL", () => {
    const view = render(
      <App
        initialSnapshot={{
          ...snapshot,
          mt5Accounts: [{ ...snapshot.mt5Accounts[0]!, heartbeatStatus: "offline" }],
          accountPerformance: {
            accountId: "mt5-demo-1",
            currency: "USD",
            heartbeatStatus: "offline",
            lastHeartbeatAt: "2026-05-20T15:11:38.444Z",
            initialBalance: 60.64,
            currentBalance: 12345.67,
            currentEquity: 15432.1,
            totalProfit: -57.89,
            realizedPnl: -57.89,
            floatingPnl: 0,
            netDeposits: 0,
            today: -57.89,
            thisWeek: -57.89,
            thisMonth: -57.89,
            equityCurve: [],
          },
        }}
      />,
    );

    expect(view.getByText("EA OFFLINE")).toBeTruthy();
    expect(view.queryByText(/12,345\.67/)).toBeNull();
    expect(view.queryByText("Balance")).toBeTruthy();
    expect(view.queryByText("Equity")).toBeTruthy();
    expect(view.queryByText("Trading P/L")).toBeTruthy();
    expect(view.getAllByText(/57\.89/).length).toBeGreaterThanOrEqual(3);
  });

  test("shows an empty-state CTA on Live when no account is connected", () => {
    const view = render(
      <App initialSnapshot={{ ...snapshot, mt5Accounts: [], accountSlots: [] }} />,
    );

    expect(view.getByText("No MT5 account connected yet")).toBeTruthy();
    expect(view.getByRole("button", { name: "Open Linked Accounts" })).toBeTruthy();
  });

  test("scopes provider, parser, history, and symbol panels behind their tabs", async () => {
    const view = render(
      <App
        initialSnapshot={{
          ...snapshot,
          telegramSessions: [{ ...snapshot.telegramSessions[0]!, profileId: "profile-current" }],
        }}
      />,
    );

    await clickTabAsync(view, "Providers");
    expect(await view.findByText("Provider paused")).toBeTruthy();

    await clickTabAsync(view, "Logs");
    const parserLab = await view.findByTestId("parser-lab-panel");
    expect(within(parserLab).getByText("Alpha FX Signals")).toBeTruthy();
    expect(within(parserLab).getByText("94%")).toBeTruthy();
    expect(within(parserLab).getByText("EURUSD.raw")).toBeTruthy();
    expect(within(parserLab).getByRole("button", { name: "Save fixture" })).toBeTruthy();
    expect(within(parserLab).getByLabelText("Classification for Alpha FX Signals")).toBeTruthy();

    await clickTabAsync(view, "History");
    fireEvent.click(await view.findByRole("tab", { name: "Closed" }));
    // No closed trades in the seed snapshot — the Closed sub-tab should land
    // on the empty state, which proves the sub-tab swap worked.
    expect(await view.findByText("No closed trades yet")).toBeTruthy();

    await clickTabAsync(view, "Symbol Settings");
    expect(await view.findByText("XAUUSD.r")).toBeTruthy();

    clickSidebar(view, "Linked Accounts");
    expect((await view.findAllByText("positions")).length).toBeGreaterThan(0);
  });

  test("does not persist Telegram API hash, OTP code, or 2FA password in browser storage", () => {
    localStorage.clear();
    sessionStorage.clear();

    render(<App initialSnapshot={snapshot} />);

    expect(JSON.stringify(localStorage)).not.toContain("apiHash");
    expect(JSON.stringify(localStorage)).not.toContain("password");
    expect(JSON.stringify(sessionStorage)).not.toContain("22222");
  });

  test("renders Telegram dialogs for provider selection when they are supplied", async () => {
    const view = render(
      <App
        initialDialogs={[
          { id: "dialog-real", title: "Real FX Channel", type: "channel", unreadCount: 3 },
        ]}
        initialSnapshot={snapshot}
      />,
    );

    clickSidebar(view, "Telegram Setup");
    expect(await view.findByText("Available dialogs")).toBeTruthy();
    expect(view.getByText("Real FX Channel")).toBeTruthy();
    expect(view.getByRole("button", { name: "Add Real FX Channel as a provider" })).toBeTruthy();
  });

  test("lets the operator resync providers after a new Telegram session connects", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).startsWith("/api/telegram/dialogs")) {
        return Response.json({
          dialogs: [
            { id: "dialog-alpha", title: "Alpha FX Signals", type: "channel", unreadCount: 0 },
          ],
        });
      }
      if (String(url) === "/api/providers/resync-current-session") {
        return Response.json({
          rebound: [{ providerId: "provider-alpha" }],
          stillOffline: [],
        });
      }
      return Response.json(snapshot);
    }) as typeof fetch;
    const view = render(<App initialSnapshot={snapshot} />);

    clickSidebar(view, "Telegram Setup");
    fireEvent.click(view.getByRole("button", { name: "Resync providers" }));

    await waitFor(() =>
      expect(calls.some((call) => call.url === "/api/providers/resync-current-session")).toBe(true),
    );
    const resyncCall = calls.find((call) => call.url === "/api/providers/resync-current-session");
    expect(resyncCall?.init?.method).toBe("POST");
    expect(String(resyncCall?.init?.body)).toContain("profile-current");
  });

  test("lets the operator enable provider auto-copy from the dashboard", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return Response.json(snapshot);
    }) as typeof fetch;

    const view = render(<App initialSnapshot={snapshot} />);
    clickTab(view, "Providers");
    fireEvent.click(view.getByRole("button", { name: "Enable auto-copy for Alpha FX Signals" }));

    await view.findByText("Provider paused");
    const toggleCall = calls.find((call) => call.url === "/api/providers/provider-alpha");
    expect(toggleCall?.init?.method).toBe("PATCH");
    expect(JSON.parse(String(toggleCall?.init?.body))).toEqual({ enabled: true });
    expect(calls.some((call) => call.url === "/api/dashboard")).toBe(true);
  });

  test("lets the operator export provider performance from the Providers panel", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).startsWith("/api/providers/performance/export.csv")) {
        return new Response("title,enabled\nAlpha FX Signals,false\n", {
          headers: { "content-type": "text/csv" },
        });
      }
      return Response.json(snapshot);
    }) as typeof fetch;

    const view = render(<App initialSnapshot={snapshot} />);
    clickTab(view, "Providers");
    fireEvent.click(view.getByRole("button", { name: "Export provider performance" }));

    await waitFor(() =>
      expect(
        calls.some(
          (call) =>
            call.url === "/api/providers/performance/export.csv?accountId=mt5-demo-1" &&
            call.init?.method === "GET",
        ),
      ).toBe(true),
    );
  });

  test("lets the operator update provider parser mode and channel lot size from the modal", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return Response.json(snapshot);
    }) as typeof fetch;

    const view = render(<App initialSnapshot={snapshot} />);
    clickTab(view, "Providers");
    fireEvent.click(view.getByRole("button", { name: "Configure Alpha FX Signals" }));
    fireEvent.change(view.getByLabelText("Parser mode for Alpha FX Signals"), {
      target: { value: "kal-vip" },
    });
    fireEvent.change(view.getByLabelText("Channel lot size for Alpha FX Signals"), {
      target: { value: "0.2" },
    });
    fireEvent.change(view.getByLabelText("TP1 strategy action"), {
      target: { value: "no-change" },
    });
    fireEvent.click(
      view.getByRole("button", { name: "Save provider settings for Alpha FX Signals" }),
    );

    await waitFor(() => expect(calls.some((call) => call.url === "/api/dashboard")).toBe(true));
    const settingsCall = calls.find((call) => call.url === "/api/providers/provider-alpha");
    expect(settingsCall?.init?.method).toBe("PATCH");
    expect(JSON.parse(String(settingsCall?.init?.body))).toMatchObject({
      parserMode: "kal-vip",
      lotSize: 0.2,
      riskMode: "fixed",
      riskAmount: 0.2,
      takeProfitLevels: [
        { leg: 1, percentage: 25, strategy: { kind: "no-change" } },
        { leg: 2, percentage: 25 },
        { leg: 3, percentage: 25 },
        { leg: 4, percentage: 25 },
      ],
    });
  });

  test("preserves percent-risk amount when provider settings are saved without edits", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return Response.json(snapshot);
    }) as typeof fetch;

    const view = render(
      <App
        initialSnapshot={{
          ...snapshot,
          providers: [
            {
              ...snapshot.providers[0]!,
              riskMode: "percent",
              riskAmount: 1.5,
              lotSize: 0.02,
            },
          ],
        }}
      />,
    );
    clickTab(view, "Providers");
    fireEvent.click(view.getByRole("button", { name: "Configure Alpha FX Signals" }));
    fireEvent.click(
      view.getByRole("button", { name: "Save provider settings for Alpha FX Signals" }),
    );

    await waitFor(() => {
      const settingsCall = calls.find((call) => call.url === "/api/providers/provider-alpha");
      expect(settingsCall).toBeTruthy();
      expect(JSON.parse(String(settingsCall?.init?.body))).toMatchObject({
        lotSize: 0.02,
        riskMode: "percent",
        riskAmount: 1.5,
      });
    });
  });

  test("lets the operator remove every provider TP level before saving", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return Response.json(snapshot);
    }) as typeof fetch;

    const view = render(<App initialSnapshot={snapshot} />);
    clickTab(view, "Providers");
    fireEvent.click(view.getByRole("button", { name: "Configure Alpha FX Signals" }));

    for (const leg of [4, 3, 2, 1]) {
      fireEvent.click(view.getByRole("button", { name: `Delete TP${leg}` }));
    }
    fireEvent.click(
      view.getByRole("button", { name: "Save provider settings for Alpha FX Signals" }),
    );

    await waitFor(() => {
      const settingsCall = calls.find((call) => call.url === "/api/providers/provider-alpha");
      expect(settingsCall).toBeTruthy();
      expect(JSON.parse(String(settingsCall?.init?.body))).toMatchObject({
        takeProfitLevels: [],
      });
    });
  });

  test("explains scaled TP allocations without final-TP wording when a runner is configured", () => {
    const view = render(
      <App
        initialSnapshot={{
          ...snapshot,
          providers: [
            {
              ...snapshot.providers[0]!,
              riskAmount: 0.03,
              takeProfitLevels: [
                { leg: 1, percentage: 30, strategy: { kind: "set-sl-to-entry", offsetPips: 1 } },
                { leg: 2, percentage: 0, strategy: { kind: "no-change" } },
                { leg: 3, percentage: 30, strategy: { kind: "no-change" } },
              ],
              runner: {
                enabled: true,
                lotSize: 0.01,
                slBehavior: "break-even",
                trailPips: 10,
              },
            },
          ],
        }}
      />,
    );

    clickTab(view, "Providers");
    fireEvent.click(view.getByRole("button", { name: "Configure Alpha FX Signals" }));

    const modalText = view.getByRole("dialog").textContent ?? "";
    expect(modalText).toContain(
      "TP percentages total 60%; the app treats them as weights across 0.02 lots assigned to TP closes. Runner stays separate.",
    );
    expect(modalText).toContain("Runner remains open");
    expect(modalText).toContain("after TP3");
    expect(modalText).toContain("50% effective");
    expect(modalText).not.toContain("anything that isn't allocated");
    expect(modalText).not.toContain("final TP");
  });

  test("lets the operator test the current provider configuration before saving", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url) === "/api/providers/provider-alpha/test-config") {
        return Response.json({
          parsed: {
            commandType: "OPEN_TRADE",
            brokerSymbol: "EURUSD.raw",
            takeProfits: [
              { allocationPercent: 25 },
              { allocationPercent: 25 },
              { allocationPercent: 25 },
              { allocationPercent: 25 },
            ],
          },
        });
      }
      return Response.json(snapshot);
    }) as typeof fetch;

    const view = render(<App initialSnapshot={snapshot} />);
    clickTab(view, "Providers");
    fireEvent.click(view.getByRole("button", { name: "Configure Alpha FX Signals" }));
    fireEvent.input(view.getByLabelText("Provider test message for Alpha FX Signals"), {
      target: { value: "BUY EURUSD @ 1.0860\nSL 1.0810\nTP1 1.0910" },
    });
    fireEvent.click(
      view.getByRole("button", { name: "Test provider config for Alpha FX Signals" }),
    );

    expect(await view.findByText("OPEN_TRADE · EURUSD.raw · 4 TPs")).toBeTruthy();
    const testCall = calls.find((call) => call.url === "/api/providers/provider-alpha/test-config");
    expect(testCall?.init?.method).toBe("POST");
    const body = JSON.parse(String(testCall?.init?.body));
    expect(body.rawText).toBe("BUY EURUSD @ 1.0860\nSL 1.0810\nTP1 1.0910");
    expect(body.config).toMatchObject({
      riskMode: "fixed",
      riskAmount: 0.1,
    });
    expect(body.config.takeProfitLevels.map((level: { leg: number }) => level.leg)).toEqual([
      1, 2, 3, 4,
    ]);
  });

  test("lets the operator update default execution settings", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return Response.json(snapshot);
    }) as typeof fetch;

    const view = render(<App initialSnapshot={snapshot} />);
    clickSidebar(view, "Settings");
    fireEvent.change(await view.findByLabelText("Default lot size"), {
      target: { value: "0.25" },
    });
    fireEvent.change(view.getByLabelText("Default risk percent"), { target: { value: "0.75" } });
    fireEvent.change(view.getByLabelText("Polling interval (seconds)"), {
      target: { value: "5" },
    });
    fireEvent.click(view.getByLabelText("Allow limit orders"));
    fireEvent.click(view.getByLabelText("Allow stop orders"));
    fireEvent.click(view.getByRole("button", { name: "Save execution settings" }));

    await waitFor(() => expect(calls.some((call) => call.url === "/api/settings")).toBe(true));
    const settingsCall = calls.find((call) => call.url === "/api/settings");
    expect(settingsCall?.init?.method).toBe("PATCH");
    expect(JSON.parse(String(settingsCall?.init?.body))).toEqual({
      defaultLotSize: 0.25,
      defaultRiskPercent: 0.75,
      defaultStopLossPips: 50,
      defaultTakeProfitPips: 200,
      azureOpenAIApiKey: "",
      pollingIntervalSeconds: 5,
      dedupWindowSeconds: 300,
      allowedOrderTypes: ["MARKET"],
      drawdownWarnPct: 10,
      drawdownDangerPct: 20,
    });
  });

  test("per-account risk override fields resync after backend normalization", () => {
    const normalizedAccount = {
      id: "mt5-demo-1",
      accountNumber: "100200300",
      currency: "USD",
      drawdownWarnPctOverride: 5,
      drawdownDangerPctOverride: 10,
    };
    const view = render(
      <SettingsPage
        accounts={[normalizedAccount]}
        onAccountRiskThresholdsSave={() => undefined}
        onSaveForm={() => undefined}
        onSubmit={(event) => event.preventDefault()}
        settings={snapshot.appSettings}
      />,
    );

    fireEvent.change(view.getByLabelText("Warn % override for 100200300"), {
      target: { value: "20" },
    });
    fireEvent.change(view.getByLabelText("Danger % override for 100200300"), {
      target: { value: "10" },
    });

    view.rerender(
      <SettingsPage
        accounts={[
          {
            ...normalizedAccount,
            drawdownWarnPctOverride: 20,
            drawdownDangerPctOverride: 20,
          },
        ]}
        onAccountRiskThresholdsSave={() => undefined}
        onSaveForm={() => undefined}
        onSubmit={(event) => event.preventDefault()}
        settings={snapshot.appSettings}
      />,
    );

    expect((view.getByLabelText("Danger % override for 100200300") as HTMLInputElement).value).toBe(
      "20",
    );
    expect(view.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
  });

  test("lets the operator save global aliases and account symbol mappings", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return Response.json(snapshot);
    }) as typeof fetch;

    const view = render(<App initialSnapshot={snapshot} />);
    await clickTabAsync(view, "Symbol Settings");

    fireEvent.click(await view.findByRole("button", { name: "Add mapping" }));
    fireEvent.change(view.getByLabelText("Alias raw symbol"), { target: { value: "SILVER" } });
    fireEvent.change(view.getByLabelText("Alias canonical symbol"), {
      target: { value: "XAGUSD" },
    });
    fireEvent.click(view.getByRole("button", { name: "Save global alias" }));

    fireEvent.click(view.getByRole("button", { name: "Add mapping" }));
    fireEvent.click(view.getByRole("tab", { name: "Account-specific" }));
    fireEvent.change(view.getByLabelText("Mapping account ID"), {
      target: { value: "mt5-demo-1" },
    });
    fireEvent.change(view.getByLabelText("Mapping canonical symbol"), {
      target: { value: "XAGUSD" },
    });
    fireEvent.change(view.getByLabelText("Mapping broker symbol"), {
      target: { value: "XAGUSD.pro" },
    });
    fireEvent.change(view.getByLabelText("Mapping suffix"), { target: { value: ".raw" } });
    fireEvent.change(view.getByLabelText("Mapping include symbols"), {
      target: { value: "XAGUSD.pro,EURUSD.raw" },
    });
    fireEvent.change(view.getByLabelText("Mapping exclude symbols"), {
      target: { value: "US30.raw" },
    });
    fireEvent.click(view.getByRole("button", { name: "Save account mapping" }));

    await view.findByText("XAUUSD.r");
    const aliasCall = calls.find((call) => call.url === "/api/symbol-mappings/aliases");
    expect(aliasCall?.init?.method).toBe("PUT");
    expect(JSON.parse(String(aliasCall?.init?.body))).toEqual({
      scope: "global",
      rawSymbol: "SILVER",
      canonicalSymbol: "XAGUSD",
    });

    const mappingCall = calls.find(
      (call) => call.url === "/api/symbol-mappings/account/mt5-demo-1",
    );
    expect(mappingCall?.init?.method).toBe("PUT");
    expect(JSON.parse(String(mappingCall?.init?.body))).toEqual({
      accountId: "mt5-demo-1",
      canonicalOverrides: {
        XAGUSD: "XAGUSD.pro",
      },
      suffix: ".raw",
      includeSymbols: ["XAGUSD.pro", "EURUSD.raw"],
      excludeSymbols: ["US30.raw"],
    });
  });

  test("lets the operator redact parser fixture text before saving", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return Response.json(snapshot);
    }) as typeof fetch;

    const view = render(<App initialSnapshot={snapshot} />);
    await clickTabAsync(view, "Logs");
    fireEvent.change(await view.findByLabelText("Redacted fixture text for Alpha FX Signals"), {
      target: { value: "BUY EURUSD @ [redacted]" },
    });
    fireEvent.click(view.getByRole("button", { name: "Save fixture" }));

    await view.findByText("Saved fixture");
    const fixtureCall = calls.find((call) => call.url === "/api/messages/raw-1/fixture");
    expect(fixtureCall?.init?.method).toBe("POST");
    expect(JSON.parse(String(fixtureCall?.init?.body))).toEqual({
      classification: "entry",
      redacted: true,
      redactedRawText: "BUY EURUSD @ [redacted]",
    });
  });

  test("Live shows an OUT_OF_SYNC banner when a trade has drifted from the broker", () => {
    globalThis.fetch = (async (_url: string | URL | Request, _init?: RequestInit) =>
      Response.json(snapshot)) as typeof fetch;
    const view = render(
      <App
        initialSnapshot={{
          ...snapshot,
          logicalTrades: [
            {
              ...snapshot.logicalTrades[0]!,
              status: "OUT_OF_SYNC",
              outOfSyncReason: "Live broker position exists, but EA tracking comment is truncated",
              livePositionExists: true,
              matchedBrokerTickets: ["70001"],
              brokerComment: "telegram-tc-virtual-tp:trade_iQ",
              lastSnapshotAt: "2026-05-18T06:04:00.000Z",
            },
          ],
        }}
      />,
    );
    // Banner is on the default Live view — no clicking required.
    expect(view.getByText("1 trade out of sync")).toBeTruthy();
    // Detail hidden until expanded so the banner stays low-noise at rest.
    expect(
      view.queryByText("Live broker position exists, but EA tracking comment is truncated"),
    ).toBeNull();
    fireEvent.click(view.getByRole("button", { name: /trade.*out of sync/i }));
    expect(
      view.getByText("Live broker position exists, but EA tracking comment is truncated"),
    ).toBeTruthy();
    expect(view.getByText("ticket 70001")).toBeTruthy();
  });

  test("shows the History empty state when there are no closed trades", async () => {
    globalThis.fetch = (async (_url: string | URL | Request, _init?: RequestInit) =>
      Response.json(snapshot)) as typeof fetch;
    const view = render(<App initialSnapshot={{ ...snapshot, logicalTrades: [] }} />);
    await clickTabAsync(view, "History");
    clickTab(view, "Closed");
    expect(await view.findByText("No closed trades yet")).toBeTruthy();
  });

  test("History › Closed groups partial closes under a parent row and reveals per-leg detail on expand", () => {
    globalThis.fetch = (async (_url: string | URL | Request, _init?: RequestInit) =>
      Response.json(snapshot)) as typeof fetch;
    const view = render(
      <App
        initialSnapshot={{
          ...snapshot,
          mt5Accounts: [
            {
              ...snapshot.mt5Accounts[0]!,
              closedTrades: [
                {
                  tradeId: "trade_a3kZ9X",
                  shortId: "a3kZ9X",
                  ticket: "247552341",
                  symbol: "XAUUSD",
                  direction: "BUY",
                  origin: "ea",
                  volume: 0.04,
                  openPrice: 3380.5,
                  closePrice: 3388.0,
                  realizedPnl: 14,
                  result: "Mixed",
                  closeReason: "Mixed",
                  netResult: "WIN",
                  closedAt: "2026-05-18T11:14:28.000Z",
                  tpLegs: [
                    { leg: 1, targetPrice: 3392, hit: true },
                    { leg: 2, targetPrice: 3400, hit: true },
                    { leg: 3, targetPrice: 3410, hit: false },
                    { leg: 4, targetPrice: 3420, hit: false },
                  ],
                  tpHitCount: 2,
                  tpTotal: 4,
                  legs: [
                    {
                      id: "ord-tp1",
                      action: "PARTIAL_CLOSE",
                      legId: "tp1",
                      legIndex: 1,
                      targetPrice: 3392,
                      volume: 0.01,
                      price: 3392,
                      pnl: 11.5,
                      source: "tp-hit",
                      closedAt: "2026-05-18T10:42:14.000Z",
                      orderTicket: "",
                      positionTicket: "247552341",
                      dealTicket: "",
                    },
                    {
                      id: "ord-tp2",
                      action: "PARTIAL_CLOSE",
                      legId: "tp2",
                      legIndex: 2,
                      targetPrice: 3400,
                      volume: 0.01,
                      price: 3400,
                      pnl: 19.5,
                      source: "tp-hit",
                      closedAt: "2026-05-18T10:51:03.000Z",
                      orderTicket: "",
                      positionTicket: "247552341",
                      dealTicket: "",
                    },
                    {
                      id: "ord-sl",
                      action: "FULL_CLOSE",
                      legId: "trade",
                      legIndex: undefined,
                      targetPrice: undefined,
                      volume: 0.02,
                      price: 3372,
                      pnl: -17,
                      source: "sl-hit",
                      closedAt: "2026-05-18T11:14:28.000Z",
                      orderTicket: "",
                      positionTicket: "247552341",
                      dealTicket: "",
                    },
                  ],
                },
              ],
            },
          ],
        }}
      />,
    );

    clickTab(view, "History");
    clickTab(view, "Closed");

    // Parent row: counts, ticket, symbol, side, compact net result.
    expect(view.getByText(/1 closed trade/)).toBeTruthy();
    expect(view.getByText("#247552341")).toBeTruthy();
    expect(view.getByText("XAUUSD")).toBeTruthy();
    expect(view.getByText("Win")).toBeTruthy();
    expect(view.queryByText("Mixed")).toBeNull();
    expect(view.getByText("2/4 SL")).toBeTruthy();

    // Detail row hidden until expand.
    expect(view.queryByText("trade_a3kZ9X")).toBeNull();

    fireEvent.click(view.getByRole("button", { name: "Expand trade detail" }));
    expect(view.getByText("trade_a3kZ9X")).toBeTruthy();
    expect(view.getByText("Close reason: Mixed")).toBeTruthy();
    // Each close event should surface its own source label.
    expect(view.getAllByText("TP1 hit").length).toBeGreaterThan(0);
    expect(view.getAllByText("TP2 hit").length).toBeGreaterThan(0);
    expect(view.getAllByText("SL hit").length).toBeGreaterThan(0);
  });

  test("History › Closed shows manual closed trades from external MT5 history", () => {
    globalThis.fetch = (async (_url: string | URL | Request, _init?: RequestInit) =>
      Response.json(snapshot)) as typeof fetch;
    const view = render(
      <App
        initialSnapshot={{
          ...snapshot,
          mt5Accounts: [
            {
              ...snapshot.mt5Accounts[0]!,
              closedTrades: [],
              externalCloses: [
                {
                  tradeId: "external-mt5-demo-1-manual-position-1",
                  shortId: "manual-position-1",
                  ticket: "manual-position-1",
                  symbol: "XAUUSD",
                  direction: "SELL",
                  origin: "manual",
                  volume: 0.01,
                  openPrice: 4502.17,
                  closePrice: 4483.63,
                  realizedPnl: 18.54,
                  result: "Manual",
                  closeReason: "Manual",
                  netResult: "WIN",
                  closedAt: "2026-05-20T12:46:42.000Z",
                  tpLegs: [],
                  tpHitCount: 0,
                  tpTotal: 0,
                  legs: [
                    {
                      id: "manual-close-1",
                      action: "FULL_CLOSE",
                      legId: "trade",
                      volume: 0.01,
                      price: 4483.63,
                      pnl: 18.54,
                      source: "manual-mobile",
                      closedAt: "2026-05-20T12:46:42.000Z",
                      orderTicket: "",
                      positionTicket: "manual-position-1",
                      dealTicket: "manual-close-1",
                    },
                  ],
                },
              ],
            },
          ],
        }}
      />,
    );

    clickTab(view, "History");
    clickTab(view, "Closed");

    expect(view.getByText("Manual")).toBeTruthy();
    expect(view.getByText("#manual-position-1")).toBeTruthy();
    expect(view.getByText("XAUUSD")).toBeTruthy();
    expect(view.getByText("Win")).toBeTruthy();
  });

  test("History › Open is the default sub-tab and shows EA-vs-external positions", () => {
    globalThis.fetch = (async (_url: string | URL | Request, _init?: RequestInit) =>
      Response.json(snapshot)) as typeof fetch;
    const view = render(
      <App
        initialSnapshot={{
          ...snapshot,
          mt5Accounts: [
            {
              ...snapshot.mt5Accounts[0]!,
              appPositions: [
                {
                  ticket: "247552341",
                  symbol: "XAUUSD",
                  type: 0,
                  volume: 0.04,
                  openPrice: 3380.5,
                  sl: 3370.0,
                  tp: 3400.0,
                  profit: 2.6,
                  magic: 901,
                  comment: "ttc:trade-x",
                },
              ],
              externalPositions: [
                {
                  ticket: "247552999",
                  symbol: "BTCUSD",
                  type: 1,
                  volume: 0.01,
                  openPrice: 70000,
                  sl: 0,
                  tp: 0,
                  profit: -5.4,
                  magic: 0,
                  comment: "",
                },
              ],
              symbols: [
                { symbol: "XAUUSD", bid: 3382.3, ask: 3382.5 },
                { symbol: "BTCUSD", bid: 69990, ask: 70020 },
              ],
            },
          ],
        }}
      />,
    );

    clickTab(view, "History");
    // "Open" is the default sub-tab, so we should see the position table right away.
    expect(view.getByText(/2 positions open/)).toBeTruthy();
    expect(view.getByText("XAUUSD")).toBeTruthy();
    expect(view.getByText("BTCUSD")).toBeTruthy();
    expect(view.getByText("#247552341")).toBeTruthy();
    expect(view.getByText("#247552999")).toBeTruthy();
    // EA chip appears on the EA-driven row, Manual chip on the external row.
    expect(view.getAllByText(/^EA/).length).toBeGreaterThan(0);
    expect(view.getByText("Manual")).toBeTruthy();
  });

  test("History › Open labels pending MT5 order sides from order enums", () => {
    globalThis.fetch = (async (_url: string | URL | Request, _init?: RequestInit) =>
      Response.json(snapshot)) as typeof fetch;
    const view = render(
      <App
        initialSnapshot={{
          ...snapshot,
          mt5Accounts: [
            {
              ...snapshot.mt5Accounts[0]!,
              appOrders: [
                {
                  ticket: "247552509",
                  symbol: "XAUUSD",
                  type: 2,
                  volume: 0.04,
                  openPrice: 4507,
                  sl: 4501,
                  tp: 0,
                  magic: 26050901,
                  comment: "ttc:buy-limit",
                },
                {
                  ticket: "247582170",
                  symbol: "XAUUSD",
                  type: 4,
                  volume: 0.04,
                  openPrice: 4518,
                  sl: 4512,
                  tp: 0,
                  magic: 26050901,
                  comment: "ttc:buy-stop",
                },
              ],
              externalOrders: [
                {
                  ticket: "247562546",
                  symbol: "XAUUSD",
                  type: 3,
                  volume: 0.03,
                  openPrice: 4527.97,
                  sl: 4521.54,
                  tp: 0,
                  magic: 0,
                  comment: "",
                },
              ],
            },
          ],
        }}
      />,
    );

    clickTab(view, "History");
    const pending = view.getByRole("heading", { name: "Pending orders (3)" }).closest("section");
    if (!pending) throw new Error("Pending orders section not found");
    expect(within(pending).getAllByText("BUY")).toHaveLength(2);
    expect(within(pending).getAllByText("SELL")).toHaveLength(1);
  });

  test("shows the Logs empty states when queue + execution logs are empty", () => {
    globalThis.fetch = (async (_url: string | URL | Request, _init?: RequestInit) =>
      Response.json(snapshot)) as typeof fetch;
    const view = render(
      <App
        initialSnapshot={{
          ...snapshot,
          signalQueue: [],
          executionLogs: [],
          parserResults: [],
        }}
      />,
    );
    clickTab(view, "Logs");
    expect(view.getByText("Queue is empty")).toBeTruthy();
    expect(view.getByText("No MT5 reports yet")).toBeTruthy();
  });

  test("renders the SmallViewportNotice below 768px and continues anyway on click", () => {
    const originalWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 375,
    });
    window.localStorage.removeItem("tg-tc.viewport-override");
    try {
      const view = render(<App initialSnapshot={snapshot} />);
      expect(view.getByText("Use a larger screen")).toBeTruthy();
      fireEvent.click(view.getByRole("button", { name: "Continue anyway" }));
      expect(window.localStorage.getItem("tg-tc.viewport-override")).toBe("1");
      // After continue-anyway, the workspace renders.
      expect(view.getByRole("heading", { name: /TG-TC/ })).toBeTruthy();
    } finally {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: originalWidth,
      });
      window.localStorage.removeItem("tg-tc.viewport-override");
    }
  });

  test("StatusBar live-dot flips to error state when the dashboard poll fails", async () => {
    globalThis.fetch = (async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response("nope", { status: 500 })) as typeof fetch;
    const view = render(<App initialSnapshot={snapshot} />);
    fireEvent.click(view.getByRole("button", { name: "Refresh dashboard" }));
    await waitFor(() => {
      const dot = document.querySelector(".status-bar .live-dot");
      expect(dot?.className).toContain("error");
    });
  });

  test("StatusBar shows last sync and app version", () => {
    const view = render(<App initialSnapshot={snapshot} />);
    expect(view.getByText("Last sync:")).toBeTruthy();
    expect(view.getByText("Version:")).toBeTruthy();
    expect(view.getByText(packageJson.version)).toBeTruthy();
  });

  test("shows GramJS Telegram adapter as healthy when backend health is OK", () => {
    const view = render(
      <App
        initialSnapshot={{
          ...snapshot,
          health: { status: "ok", database: "connected", telegramAdapter: "gramjs" },
        }}
      />,
    );

    const telegramChip = view
      .getAllByText("gramjs")
      .find((el) => el.closest(".chip"))
      ?.closest(".chip");
    expect(telegramChip?.querySelector(".chip-dot")?.className).toContain("ok");
  });

  test("surfaces external manual MT5 positions on the Performance view", () => {
    const view = render(
      <App
        initialSnapshot={{
          ...snapshot,
          mt5Accounts: [
            {
              ...snapshot.mt5Accounts[0]!,
              externalPositionCount: 1,
              externalOrderCount: 0,
              externalPositions: [
                {
                  ticket: "247564387",
                  symbol: "XAUUSD",
                  type: 1,
                  volume: 0.01,
                  openPrice: 4553.73,
                  sl: 4560,
                  tp: 4481.29,
                  profit: 11.65,
                  magic: 0,
                  comment: "",
                },
              ],
            },
          ],
        }}
      />,
    );

    expect(view.getByText("External activity")).toBeTruthy();
    expect(view.getByText("XAUUSD")).toBeTruthy();
    expect(view.getByText(/247564387/)).toBeTruthy();
  });

  test("loads account statistics only when the Performance statistics subview is opened", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).startsWith("/api/accounts/mt5-demo-1/stats")) {
        return Response.json({
          scope: "account",
          range: "30d",
          currency: "USD",
          generatedAt: "2026-05-21T10:00:00.000Z",
          profitReturn: { totalPnl: 15, roiPercent: 0.15, bestDay: 25, worstDay: -10 },
          winLoss: {
            wins: 1,
            losses: 1,
            breakEven: 0,
            winRate: 0.5,
            averageWin: 25,
            averageLoss: -10,
          },
          riskDrawdown: {
            maxDrawdown: 10,
            maxDrawdownPct: 0.1,
            currentDrawdown: 5,
            averageActiveDrawdown: 7.5,
            recoveryFactor: 1.5,
          },
          quality: {
            profitFactor: 2.5,
            grossProfit: 25,
            grossLoss: -10,
            averageTrade: 7.5,
            expectancy: 7.5,
          },
          streaks: { current: "L1", maxWins: 1, maxLosses: 1 },
          timing: { averageTradeMinutes: 15, bestWeekday: "Thu", worstWeekday: "Fri" },
        });
      }
      return Response.json(snapshot);
    }) as typeof fetch;

    const view = render(<App initialSnapshot={snapshot} />);

    expect(calls.some((call) => call.url.includes("/stats"))).toBe(false);
    fireEvent.click(view.getByRole("tab", { name: "Statistics" }));

    await view.findByText("Profit / Return");
    expect(view.getByText("Win / Loss")).toBeTruthy();
    expect(view.getByText("Risk / Drawdown")).toBeTruthy();
    expect(view.getAllByText(/15\.00/).length).toBeGreaterThanOrEqual(1);
    expect(
      calls.some(
        (call) =>
          call.url === "/api/accounts/mt5-demo-1/stats?range=30d&scope=account" &&
          call.init?.method === "GET",
      ),
    ).toBe(true);
  });
});
