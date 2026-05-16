import "./test-setup";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { App, type DashboardSnapshot } from "./App";

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
  },
  telegramSessions: [{ id: "session-1", phone: "+27821234567", status: "CONNECTED" }],
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

function clickSidebar(view: ReturnType<typeof render>, label: string) {
  const buttons = view.getAllByRole("button", { name: label });
  // Sidebar buttons are full-width; pick the first one (sidebar comes before tabs).
  const sidebarButton = buttons.find((button) => button.closest("aside"));
  if (!sidebarButton) throw new Error(`No sidebar button labelled ${label}`);
  fireEvent.click(sidebarButton);
}

describe("App dashboard", () => {
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

  test("shows an empty-state CTA on Live when no account is connected", () => {
    const view = render(
      <App initialSnapshot={{ ...snapshot, mt5Accounts: [], accountSlots: [] }} />,
    );

    expect(view.getByText("No MT5 account connected yet")).toBeTruthy();
    expect(view.getByRole("button", { name: "Open Linked Accounts" })).toBeTruthy();
  });

  test("scopes provider, parser, history, and symbol panels behind their tabs", () => {
    const view = render(<App initialSnapshot={snapshot} />);

    clickTab(view, "Providers");
    expect(view.getByText("Provider paused")).toBeTruthy();

    clickTab(view, "Logs");
    const parserLab = view.getByTestId("parser-lab-panel");
    expect(within(parserLab).getByText("Alpha FX Signals")).toBeTruthy();
    expect(within(parserLab).getByText("94%")).toBeTruthy();
    expect(within(parserLab).getByText("EURUSD.raw")).toBeTruthy();
    expect(within(parserLab).getByRole("button", { name: "Save fixture" })).toBeTruthy();
    expect(within(parserLab).getByLabelText("Classification for Alpha FX Signals")).toBeTruthy();

    clickTab(view, "History");
    expect(view.getByText("TP1")).toBeTruthy();
    expect(view.getByText("1.105")).toBeTruthy();

    clickTab(view, "Symbol Settings");
    expect(view.getByText("XAUUSD.r")).toBeTruthy();

    clickSidebar(view, "Linked Accounts");
    expect(view.getAllByText("positions").length).toBeGreaterThan(0);
  });

  test("does not persist Telegram API hash, OTP code, or 2FA password in browser storage", () => {
    localStorage.clear();
    sessionStorage.clear();

    render(<App initialSnapshot={snapshot} />);

    expect(JSON.stringify(localStorage)).not.toContain("apiHash");
    expect(JSON.stringify(localStorage)).not.toContain("password");
    expect(JSON.stringify(sessionStorage)).not.toContain("22222");
  });

  test("renders Telegram dialogs for provider selection when they are supplied", () => {
    const view = render(
      <App
        initialDialogs={[
          { id: "dialog-real", title: "Real FX Channel", type: "channel", unreadCount: 3 },
        ]}
        initialSnapshot={snapshot}
      />,
    );

    clickSidebar(view, "Telegram Setup");
    expect(view.getByText("Available dialogs")).toBeTruthy();
    expect(view.getByText("Real FX Channel")).toBeTruthy();
    expect(view.getByRole("button", { name: "Add Real FX Channel as a provider" })).toBeTruthy();
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
        { leg: 1, percentage: 25 },
        { leg: 2, percentage: 25 },
        { leg: 3, percentage: 25 },
        { leg: 4, percentage: 25 },
      ],
    });
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
    fireEvent.change(view.getByLabelText("Default lot size"), { target: { value: "0.25" } });
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
      allowedOrderTypes: ["MARKET"],
    });
  });

  test("lets the operator save global aliases and account symbol mappings", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return Response.json(snapshot);
    }) as typeof fetch;

    const view = render(<App initialSnapshot={snapshot} />);
    clickTab(view, "Symbol Settings");

    fireEvent.click(view.getByRole("button", { name: "Add mapping" }));
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
    clickTab(view, "Logs");
    fireEvent.change(view.getByLabelText("Redacted fixture text for Alpha FX Signals"), {
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

  test("shows the History empty state when there are no trades", () => {
    globalThis.fetch = (async (_url: string | URL | Request, _init?: RequestInit) =>
      Response.json(snapshot)) as typeof fetch;
    const view = render(<App initialSnapshot={{ ...snapshot, logicalTrades: [] }} />);
    clickTab(view, "History");
    expect(view.getByText("No trades yet. Approved signals will appear here.")).toBeTruthy();
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

  test("shows GramJS Telegram adapter as healthy when backend health is OK", () => {
    const view = render(
      <App
        initialSnapshot={{
          ...snapshot,
          health: { status: "ok", database: "connected", telegramAdapter: "gramjs" },
        }}
      />,
    );

    const telegramChip = view.getByText("TG gramjs").closest(".chip");
    expect(telegramChip?.querySelector(".chip-dot")?.className).toContain("ok");
  });
});
