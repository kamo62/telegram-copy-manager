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
    pollingIntervalSeconds: 2,
    allowedOrderTypes: ["MARKET", "LIMIT", "STOP"],
  },
  telegramSessions: [{ id: "session-1", phone: "+27821234567", status: "CONNECTED" }],
  providers: [
    {
      id: "provider-alpha",
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
    expect(view.getByText("1 positions · 0 orders")).toBeTruthy();
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
    expect(view.getByText("Available Dialogs")).toBeTruthy();
    expect(view.getByText("Real FX Channel")).toBeTruthy();
    expect(view.getByRole("button", { name: "Select Real FX Channel" })).toBeTruthy();
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
    expect(JSON.parse(String(settingsCall?.init?.body))).toEqual({
      parserMode: "kal-vip",
      lotSize: 0.2,
    });
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
    fireEvent.change(view.getByLabelText("Polling interval seconds"), {
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
});
