import "./test-setup";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render as rtlRender,
  waitFor,
  within,
} from "@testing-library/react";
import { createBrowserRouter, MemoryRouter, RouterProvider } from "react-router-dom";
import packageJson from "../../../package.json";
import { App, type DashboardSnapshot, dashboardSnapshotsEqual, heldReleaseToast } from "./App";
import { SettingsPage } from "./pages/SettingsPage";

// App now reads its view/tab/account from the URL, so every render needs Router context.
const render = (ui: Parameters<typeof rtlRender>[0], options?: Parameters<typeof rtlRender>[1]) =>
  rtlRender(ui, { wrapper: MemoryRouter, ...options });

beforeEach(() => {
  (globalThis as typeof globalThis & { __APP_VERSION__?: string }).__APP_VERSION__ =
    packageJson.version;
  globalThis.fetch = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
});

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
    maxOpenTradeAgeSeconds: 0,
    drawdownWarnPct: 10,
    drawdownDangerPct: 20,
    reportingCurrency: "USD",
    usdZarRate: 16,
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
      availableSymbols: ["XAUUSD.raw", "XAUUSD.pro"],
      openPositionCount: 1,
      pendingOrderCount: 0,
      lastSnapshotAt: "2026-05-09T09:00:00.000Z",
    },
    {
      id: "mt5-live-2",
      accountNumber: "200300400",
      server: "MetaQuotes-Live",
      heartbeatStatus: "online",
      marginMode: "HEDGING",
      availableSymbols: ["XAUUSD.raw"],
      openPositionCount: 0,
      pendingOrderCount: 0,
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
      accountId: "mt5-live-2",
      providerId: "provider-alpha",
      direction: "SELL",
      orderType: "STOP",
      entry: { from: 1.081, to: 1.082 },
      stopLoss: 1.09,
      takeProfits: [{ price: 1.075 }, 1.07],
      volume: 0.25,
      executionMode: "SPLIT_ORDER",
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
  if (label === "Symbol Settings") {
    clickSidebar(view, "Symbols");
    return;
  }
  const currentLabel =
    label === "History"
      ? "Positions"
      : label === "Summary"
        ? "Signals"
        : label === "Equity Guardian"
          ? "Guardian"
          : label;
  fireEvent.click(view.getByRole("tab", { name: currentLabel }));
}

async function clickTabAsync(view: ReturnType<typeof render>, label: string) {
  if (label === "Symbol Settings") {
    clickSidebar(view, "Symbols");
    await view.findByRole("heading", { name: "Symbol routing" });
    return;
  }
  const currentLabel =
    label === "History"
      ? "Positions"
      : label === "Summary"
        ? "Signals"
        : label === "Equity Guardian"
          ? "Guardian"
          : label;
  fireEvent.click(view.getByRole("tab", { name: currentLabel }));
  // Some tab changes trigger async data loads. Wait for the tab selection
  // state before asserting on the rendered panel.
  await waitFor(() =>
    expect(view.getByRole("tab", { name: currentLabel }).getAttribute("aria-selected")).toBe(
      "true",
    ),
  );
}

function clickSidebar(view: ReturnType<typeof render>, label: string) {
  const currentLabel =
    label === "Telegram Setup" ? "Telegram" : label === "Linked Accounts" ? "Add account" : label;
  const buttons = view.getAllByRole("button", { name: currentLabel });
  // Sidebar buttons are full-width; pick the first one (sidebar comes before tabs).
  const sidebarButton = buttons.find((button) => button.closest("aside"));
  if (!sidebarButton) throw new Error(`No sidebar button labelled ${currentLabel}`);
  fireEvent.click(sidebarButton);
}

function fixtureResponse(url: string | URL | Request, payload: unknown = snapshot) {
  const requestUrl = String(url);
  if (requestUrl === "/api/queue-items/held") {
    return Response.json({ items: [] });
  }
  if (/\/api\/accounts\/[^/]+\/attribution/.test(requestUrl)) {
    return new Promise<Response>(() => {});
  }
  return Response.json(payload);
}

function installFakeEventSource() {
  const original = globalThis.EventSource;
  const instances: FakeEventSource[] = [];
  class FakeEventSource {
    onerror: (() => void) | null = null;
    onopen: (() => void) | null = null;
    private listeners = new Map<string, Array<(event: MessageEvent<string>) => void>>();

    constructor(_url: string) {
      instances.push(this);
    }

    addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }

    emit(type: string, data?: unknown) {
      const event = new MessageEvent(type, {
        data: data === undefined ? "" : JSON.stringify(data),
      });
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }

    close() {}
  }
  globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
  return {
    instances,
    restore: () => {
      globalThis.EventSource = original;
    },
  };
}

test("held release messages distinguish recorded TP hits and symbol-less close-all work", () => {
  expect(
    heldReleaseToast({ commandType: "MARK_TP_HIT", symbol: "XAUUSD.r" }, "original", {
      status: "RECORDED",
    }),
  ).toBe("TP hit recorded for XAUUSD.r");
  expect(
    heldReleaseToast({ commandType: "CLOSE_TRADE", symbol: "" }, "original", {
      status: "PENDING",
      remainingTradeCount: 2,
    }),
  ).toBe("Close queued for selected trade; 2 trades remain held");
  expect(
    heldReleaseToast({ commandType: "CLOSE_TRADE", symbol: "" }, "original", { status: "PENDING" }),
  ).toBe("close trade requeued");
});

function heartbeatDashboard(heartbeatStatus = "online"): DashboardSnapshot {
  const current = heartbeatStatus === "online";
  const performance = {
    accountId: "mt5-demo-1",
    currency: "USD",
    heartbeatStatus,
    lastHeartbeatAt: "2026-07-18T08:00:00.000Z",
    initialBalance: 100,
    currentBalance: current ? 100 : null,
    currentEquity: current ? 105 : null,
    currentProfit: current ? 5 : null,
    totalProfit: current ? 5 : null,
    realizedPnl: 0,
    floatingPnl: current ? 5 : null,
    netDeposits: current ? 0 : null,
    today: 0,
    thisWeek: 0,
    thisMonth: 0,
    equityCurve: [],
  };
  return {
    ...snapshot,
    mt5Accounts: snapshot.mt5Accounts.map((account) =>
      account.id === "mt5-demo-1"
        ? {
            ...account,
            currency: "USD",
            balance: 100,
            equity: 105,
            profit: 5,
            heartbeatStatus,
            lastHeartbeatAt: performance.lastHeartbeatAt,
          }
        : account,
    ),
    accountPerformance: performance,
    accountPerformanceByAccount: { "mt5-demo-1": performance },
  };
}

const heartbeatDelta = {
  type: "heartbeat",
  accountId: "mt5-demo-1",
  balance: 125,
  equity: 130,
  profit: 5,
  heartbeatStatus: "online",
  now: "2026-07-18T08:00:05.000Z",
};

async function renderEventSourceApp(initial: DashboardSnapshot, refreshed = initial) {
  const eventSource = installFakeEventSource();
  let dashboardLoads = 0;
  globalThis.fetch = (async (url: string | URL | Request) => {
    const requestUrl = String(url);
    if (requestUrl === "/api/dashboard") {
      dashboardLoads += 1;
      return Response.json(dashboardLoads === 1 ? initial : refreshed);
    }
    if (requestUrl === "/api/telegram/status") {
      return Response.json({
        connected: true,
        telegramAdapter: "mock",
        telegramSessions: initial.telegramSessions,
      });
    }
    return fixtureResponse(url, initial);
  }) as typeof fetch;
  const view = render(<App />);
  await view.findByRole("heading", { name: "TG-TC · Operations" });
  await waitFor(() => expect(eventSource.instances).toHaveLength(1));
  return { ...eventSource, view, dashboardLoads: () => dashboardLoads };
}

describe("App dashboard", () => {
  test("compares dashboard snapshots deeply without depending on object key order", () => {
    expect(
      dashboardSnapshotsEqual(
        { health: { status: "ok" }, queue: [1, 2] },
        {
          queue: [1, 2],
          health: { status: "ok" },
        },
      ),
    ).toBe(true);
    expect(dashboardSnapshotsEqual({ queue: [1, 2] }, { queue: [1, 3] })).toBe(false);
  });

  test("coalesces dashboard event bursts while a load is in flight", async () => {
    const { instances, restore } = installFakeEventSource();
    let resolveDashboard: (response: Response) => void = () => {};
    const dashboardResponse = new Promise<Response>((resolve) => {
      resolveDashboard = resolve;
    });
    let dashboardLoads = 0;
    globalThis.fetch = (async (url: string | URL | Request) => {
      if (String(url) === "/api/dashboard") {
        dashboardLoads += 1;
        return dashboardResponse;
      }
      if (String(url) === "/api/telegram/status") {
        return Response.json({
          connected: true,
          telegramAdapter: "mock",
          telegramSessions: snapshot.telegramSessions,
        });
      }
      return fixtureResponse(url);
    }) as typeof fetch;

    try {
      const view = render(<App />);
      await waitFor(() => expect(instances).toHaveLength(1));
      act(() => {
        instances[0]?.emit("queue");
        instances[0]?.emit("trade");
        instances[0]?.emit("heartbeat");
      });
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(dashboardLoads).toBe(1);

      resolveDashboard(Response.json(snapshot));
      await view.findByRole("heading", { name: "TG-TC · Operations" });
    } finally {
      restore();
    }
  });

  test("applies heartbeat deltas without fetching the dashboard", async () => {
    const app = await renderEventSourceApp(heartbeatDashboard());

    try {
      expect(app.dashboardLoads()).toBe(1);
      act(() => app.instances[0]?.emit("heartbeat", heartbeatDelta));

      await waitFor(() => expect(app.view.getByText(/125\.00/)).toBeTruthy());
      expect(app.view.getByText(/130\.00/)).toBeTruthy();
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(app.dashboardLoads()).toBe(1);
    } finally {
      app.restore();
    }
  });

  test("ignores another account's heartbeat in each native account card", async () => {
    const base = heartbeatDashboard();
    const primary = base.mt5Accounts.find((account) => account.id === "mt5-demo-1");
    if (!primary) throw new Error("fixture account mt5-demo-1 missing");
    const app = await renderEventSourceApp({
      ...base,
      mt5Accounts: [...base.mt5Accounts, { ...primary, id: "mt5-demo-2", accountNumber: "222" }],
    });

    try {
      expect(app.dashboardLoads()).toBe(1);
      act(() =>
        app.instances[0]?.emit("heartbeat", {
          ...heartbeatDelta,
          accountId: "mt5-demo-2",
          balance: 900,
          equity: 950,
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(app.dashboardLoads()).toBe(1);
      const accountButton = app.view.getAllByRole("button", { name: "100200300" }).at(-1);
      const accountCard = accountButton?.closest("article");
      expect(accountCard).not.toBeNull();
      expect(within(accountCard as HTMLElement).getByText(/105\.00/)).toBeTruthy();
      expect(within(accountCard as HTMLElement).queryByText(/950\.00/)).toBeNull();
    } finally {
      app.restore();
    }
  });

  test("reloads the dashboard when heartbeat status transitions", async () => {
    const app = await renderEventSourceApp(heartbeatDashboard("offline"), heartbeatDashboard());

    try {
      expect(app.dashboardLoads()).toBe(1);
      act(() => app.instances[0]?.emit("heartbeat", heartbeatDelta));
      await waitFor(() => expect(app.dashboardLoads()).toBe(2));
    } finally {
      app.restore();
    }
  });

  test("keeps queue events on the full dashboard reload path", async () => {
    const app = await renderEventSourceApp(heartbeatDashboard());

    try {
      expect(app.dashboardLoads()).toBe(1);
      act(() => app.instances[0]?.emit("queue"));
      await waitFor(() => expect(app.dashboardLoads()).toBe(2));
    } finally {
      app.restore();
    }
  });

  test("renders workspace routes eagerly while retaining the deployed asset fallback", async () => {
    const [source, apiSource, serverSource, deploySource] = await Promise.all([
      Bun.file(new URL("./App.tsx", import.meta.url)).text(),
      Bun.file(new URL("../../api/src/app.ts", import.meta.url)).text(),
      Bun.file(new URL("../../api/src/server.ts", import.meta.url)).text(),
      Bun.file(new URL("../../../scripts/deploy.sh", import.meta.url)).text(),
    ]);

    expect(source).not.toContain("lazy(() =>");
    expect(source).not.toContain("<Suspense");
    expect(apiSource).toContain('app.use(\n        "/assets/*"');
    expect(apiSource).toContain("root: options.assetArchiveRoot");
    expect(serverSource).toContain("archiveStaticAssets(staticRoot, assetArchiveRoot)");
    expect(deploySource).toContain("/app/data/asset-archive/assets");
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
    expect(view.getByRole("button", { name: "Operations" })).toBeTruthy();
    expect(view.getByRole("button", { name: "Review queue" })).toBeTruthy();
    expect(view.getByRole("button", { name: "Telegram" })).toBeTruthy();
    expect(view.queryByRole("heading", { name: "Signal ledger" })).toBeNull();
    expect(view.queryByText("Get started today")).toBeNull();
    expect(view.getByRole("tab", { name: "Signals" })).toBeTruthy();
    expect(view.getByRole("tab", { name: "Signals" }).getAttribute("aria-selected")).toBe("true");
    // The heavy growth chart now lives behind the Performance tab, not on the landing.
    expect(view.queryByLabelText("Account growth chart")).toBeNull();
    expect(view.getByRole("tab", { name: "Performance" })).toBeTruthy();
    expect(view.getByRole("tab", { name: "Providers" })).toBeTruthy();
    expect(view.getByRole("tab", { name: "Logs" })).toBeTruthy();
  });

  test("operations does not resurface an ignored signal after refresh", () => {
    const ignoredText = "BUY EURUSD @ 1.0850";
    const view = render(
      <App
        initialSnapshot={{
          ...snapshot,
          parserResults: [
            {
              ...snapshot.parserResults[0]!,
              rawText: ignoredText,
              reviewRequired: true,
              status: "IGNORED",
            },
          ],
        }}
      />,
    );

    expect(view.queryByText(ignoredText)).toBeNull();
    expect(view.queryByRole("heading", { name: "Signal ledger" })).toBeNull();
  });

  test("summarises attention counts without repeating review signals in the ledger", () => {
    const firstReviewText = "BUY XAUUSD - review price";
    const secondReviewText = "SELL EURUSD - review mapping";
    const view = render(
      <App
        initialSnapshot={{
          ...snapshot,
          alerts: [
            { kind: "telegram-stalled", severity: "error", message: "Telegram stalled" },
            { kind: "unmapped-symbols", severity: "warn", message: "One symbol is unmapped" },
          ],
          parserResults: [
            {
              ...snapshot.parserResults[0]!,
              id: "review-1",
              rawText: firstReviewText,
              reviewRequired: true,
              status: "PARSED",
            },
            {
              ...snapshot.parserResults[0]!,
              id: "review-2",
              rawText: secondReviewText,
              reviewRequired: true,
              status: "PARSED",
            },
          ],
        }}
      />,
    );

    expect(view.getByRole("status", { name: "Attention summary" })).toBeTruthy();
    expect(view.getByText("4 items need attention")).toBeTruthy();
    expect(view.getByText("2 signals · 2 alerts")).toBeTruthy();
    expect(view.queryByText(firstReviewText)).toBeNull();
    expect(view.queryByText(secondReviewText)).toBeNull();
    expect(view.getByTitle("2 signals need review").textContent).toBe("2");
  });

  test("the data router mounts clicked workspaces immediately without a refresh", async () => {
    (
      window as typeof window & {
        happyDOM?: { setURL: (url: string) => void };
      }
    ).happyDOM?.setURL("http://localhost/");
    window.history.replaceState({}, "", "http://localhost/");
    const router = createBrowserRouter([
      { path: "*", element: <App initialSnapshot={snapshot} /> },
    ]);
    const originalScrollTo = window.scrollTo;
    const scrollPositions: ScrollToOptions[] = [];
    window.scrollTo = ((options: ScrollToOptions) => {
      scrollPositions.push(options);
    }) as typeof window.scrollTo;
    const view = rtlRender(<RouterProvider router={router} />);

    scrollPositions.length = 0;
    fireEvent.click(view.getByRole("tab", { name: "Providers" }));

    await waitFor(() => expect(window.location.pathname).toBe("/providers"));
    expect(scrollPositions.at(-1)).toEqual({ top: 0, left: 0, behavior: "auto" });
    expect((await view.findAllByRole("heading", { name: "Providers" })).length).toBeGreaterThan(0);
    expect(view.queryByRole("heading", { name: "Signal ledger" })).toBeNull();

    fireEvent.click(view.getByRole("button", { name: "Operations" }));
    await waitFor(() => expect(window.location.pathname).toBe("/"));
    expect(view.queryByRole("heading", { name: "Signal ledger" })).toBeNull();

    clickSidebar(view, "100200300");
    await waitFor(() => expect(window.location.pathname).toBe("/accounts/mt5-demo-1/performance"));
    expect(view.getByRole("tab", { name: "Performance" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(view.queryByRole("tab", { name: "Signals" })).toBeNull();

    fireEvent.click(view.getByRole("tab", { name: "Positions" }));
    await waitFor(() => expect(window.location.pathname).toBe("/accounts/mt5-demo-1/history"));
    expect(await view.findByRole("heading", { name: "Trade history" })).toBeTruthy();
    expect(view.queryByRole("heading", { name: "Performance" })).toBeNull();
    router.dispose();
    window.scrollTo = originalScrollTo;
  });

  test("redirects legacy account Signals routes to Performance without exposing the tab", async () => {
    const view = rtlRender(<App initialSnapshot={snapshot} />, {
      wrapper: ({ children }) => (
        <MemoryRouter initialEntries={["/accounts/mt5-demo-1/summary"]}>{children}</MemoryRouter>
      ),
    });

    expect(view.queryByRole("tab", { name: "Signals" })).toBeNull();
    expect(view.getByRole("tab", { name: "Performance" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(view.getByRole("heading", { name: "Performance" })).toBeTruthy();
  });

  test("keeps subtle table cells in native table flow", async () => {
    const css = await Bun.file(new URL("./styles/base.css", import.meta.url)).text();

    expect(css).not.toMatch(/(?:^|\n)\.data-table-subtle\s*\{\s*display:\s*block/);
    expect(css).toMatch(/span\.data-table-subtle\s*\{\s*display:\s*block/);
  });

  test("does not show Telegram login while a saved session is confirmed before the dashboard loads", async () => {
    let resolveDashboard: (response: Response) => void = () => {};
    const dashboardResponse = new Promise<Response>((resolve) => {
      resolveDashboard = resolve;
    });
    globalThis.fetch = (async (url: string | URL | Request) => {
      const requestUrl = String(url);
      if (requestUrl === "/api/telegram/status") {
        return Response.json({
          activeProfileId: "profile-current",
          connected: true,
          telegramAdapter: "gramjs",
          telegramSessions: snapshot.telegramSessions,
        });
      }
      if (requestUrl === "/api/dashboard") {
        return dashboardResponse;
      }
      return Response.json({});
    }) as typeof fetch;

    const view = render(<App />);

    expect(view.getByRole("heading", { name: "Checking Telegram session" })).toBeTruthy();
    expect(view.queryByRole("heading", { name: "Sign in to Telegram" })).toBeNull();

    await waitFor(() =>
      expect(view.queryByRole("heading", { name: "Sign in to Telegram" })).toBeNull(),
    );
    resolveDashboard(Response.json(snapshot));
    await view.findByRole("heading", { name: "TG-TC · Operations" });
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

    clickTab(view, "Performance");

    expect(view.getByText("Balance")).toBeTruthy();
    expect(view.getByText("Equity")).toBeTruthy();
    expect(view.queryByText("Initial Balance")).toBeNull();
    expect(view.getByText(/12,345\.67/)).toBeTruthy();
    expect(view.getByText(/15,432\.10/)).toBeTruthy();
    expect(view.getAllByText(/137\.50/).length).toBeGreaterThan(0);
  });

  test("performance growth chart uses the active performance currency over the first account row", async () => {
    const view = render(
      <App
        initialSnapshot={{
          ...snapshot,
          accountPerformance: {
            currency: "USD",
            initialBalance: 60,
            currentBalance: 180.86,
            currentEquity: 244.87,
            totalProfit: 12.34,
            realizedPnl: 12.34,
            floatingPnl: 0,
            netDeposits: 0,
            today: 0,
            thisWeek: 12.34,
            thisMonth: 12.34,
            equityCurve: [
              { x: 1, equity: 180.86, drawdown: 0 },
              { x: 2, equity: 244.87, drawdown: 0 },
            ],
          },
          mt5Accounts: [
            {
              ...snapshot.mt5Accounts[0]!,
              id: "mt5-zar-old",
              accountNumber: "54870107",
              currency: "ZAR",
            },
            {
              ...snapshot.mt5Accounts[0]!,
              id: "mt5-usd-octa",
              accountNumber: "63442826",
              server: "OctaFX-Real",
              currency: "USD",
            },
          ],
        }}
      />,
    );

    clickTab(view, "Performance");
    const chart = within(await view.findByLabelText("Account growth chart"));
    expect(chart.getByText(/\$12\.34/)).toBeTruthy();
    expect(chart.queryByText(/R\s*12\.34/)).toBeNull();
  });

  test("account header keeps mixed-currency totals in their native currencies", () => {
    const view = render(
      <App
        initialSnapshot={{
          ...snapshot,
          accountPerformance: {
            accountId: "aggregate",
            currency: "USD",
            heartbeatStatus: "online",
            initialBalance: 200,
            currentBalance: 200,
            currentEquity: 220,
            totalProfit: 20,
            realizedPnl: 0,
            floatingPnl: 20,
            netDeposits: 0,
            today: 0,
            thisWeek: 20,
            thisMonth: 20,
            equityCurve: [],
          },
          mt5Accounts: [
            {
              ...snapshot.mt5Accounts[0]!,
              id: "mt5-zar-old",
              accountNumber: "54870107",
              currency: "ZAR",
              heartbeatStatus: "offline",
              balance: 1600,
              equity: 1760,
            },
            {
              ...snapshot.mt5Accounts[0]!,
              id: "mt5-usd-octa",
              accountNumber: "63442826",
              server: "OctaFX-Real",
              currency: "USD",
              heartbeatStatus: "online",
              balance: 100,
              equity: 110,
            },
          ],
          accountPerformanceByAccount: {
            "mt5-zar-old": {
              accountId: "mt5-zar-old",
              currency: "ZAR",
              initialBalance: 1440,
              totalProfit: 160,
              today: 16,
              thisWeek: 160,
              thisMonth: 160,
            },
            "mt5-usd-octa": {
              accountId: "mt5-usd-octa",
              currency: "USD",
              initialBalance: 90,
              totalProfit: 10,
              today: 1,
              thisWeek: 10,
              thisMonth: 10,
            },
          },
        }}
      />,
    );

    clickTab(view, "Performance");

    const usd = within(view.getByRole("article", { name: "USD account totals" }));
    const zar = within(view.getByRole("article", { name: "ZAR account totals" }));

    expect(usd.getByText(/\$100\.00/)).toBeTruthy();
    expect(usd.getByText(/\$110\.00/)).toBeTruthy();
    expect(zar.getByText(/R\s*1,600\.00/)).toBeTruthy();
    expect(zar.getByText(/R\s*1,760\.00/)).toBeTruthy();
    expect(view.queryByText(/200\.00/)).toBeNull();
    expect(view.getByText("Native currencies remain separate; no FX total is shown.")).toBeTruthy();
    expect(view.getByText("EA WORKING")).toBeTruthy();
  });

  test("operations keeps USD and ZAR accounts in their native currencies without a false total", () => {
    const view = render(
      <App
        initialSnapshot={{
          ...snapshot,
          mt5Accounts: [
            {
              ...snapshot.mt5Accounts[0]!,
              id: "mt5-zar",
              accountNumber: "54870107",
              currency: "ZAR",
              balance: 1600,
              equity: 1760,
            },
            {
              ...snapshot.mt5Accounts[1]!,
              id: "mt5-usd",
              accountNumber: "63442826",
              currency: "USD",
              balance: 100,
              equity: 110,
            },
          ],
        }}
      />,
    );

    const operatingState = within(view.getByRole("region", { name: "Account operating state" }));
    const zarCard = operatingState.getByRole("button", { name: "54870107" }).closest("article");
    const usdCard = operatingState.getByRole("button", { name: "63442826" }).closest("article");

    expect(zarCard?.textContent).toContain("ZAR");
    expect(zarCard?.textContent).toMatch(/1[,.\s]760/);
    expect(usdCard?.textContent).toContain("USD");
    expect(usdCard?.textContent).toMatch(/110/);
    expect(operatingState.queryByText(/1[,.\s]870/)).toBeNull();
    expect(view.queryByRole("region", { name: "Account performance" })).toBeNull();
  });

  test("account scoped pages use the selected account currency instead of reporting currency", () => {
    const routeSnapshot: DashboardSnapshot = {
      ...snapshot,
      accountPerformance: {
        accountId: "aggregate",
        currency: "USD",
        heartbeatStatus: "offline",
        initialBalance: 60,
        currentBalance: null,
        currentEquity: null,
        totalProfit: null,
        realizedPnl: -168.64,
        floatingPnl: null,
        netDeposits: null,
        today: 0,
        thisWeek: 9.65,
        thisMonth: -168.64,
        equityCurve: [],
      },
      mt5Accounts: [
        {
          ...snapshot.mt5Accounts[0]!,
          id: "mt5-54870107",
          accountNumber: "54870107",
          server: "HFMarketsSA-Live",
          currency: "ZAR",
          heartbeatStatus: "offline",
          balance: 0,
          equity: 0,
          profit: 0,
        },
        {
          ...snapshot.mt5Accounts[0]!,
          id: "mt5-63442826",
          accountNumber: "63442826",
          server: "OctaFX-Real",
          currency: "USD",
          heartbeatStatus: "offline",
          balance: 180.86,
          equity: 244.87,
          profit: 22.37,
        },
      ],
    };
    const view = rtlRender(<App initialSnapshot={routeSnapshot} />, {
      wrapper: ({ children }) => (
        <MemoryRouter initialEntries={["/accounts/mt5-54870107/logs"]}>{children}</MemoryRouter>
      ),
    });

    expect(view.getAllByText("· ZAR").length).toBeGreaterThan(0);
    expect(view.queryByText("· USD")).toBeNull();
    expect(view.queryByText(/\$168\.64/)).toBeNull();
  });

  test("account header uses focused account performance instead of heartbeat-only PnL", () => {
    const routeSnapshot: DashboardSnapshot = {
      ...snapshot,
      accountPerformance: {
        accountId: "aggregate",
        currency: "USD",
        heartbeatStatus: "online",
        initialBalance: 300,
        currentBalance: 300,
        currentEquity: 345.5,
        totalProfit: 45.5,
        realizedPnl: 45.5,
        floatingPnl: 0,
        netDeposits: 0,
        today: 45.5,
        thisWeek: 45.5,
        thisMonth: 45.5,
        equityCurve: [],
      },
      accountPerformanceByAccount: {
        "mt5-secondary": {
          accountId: "mt5-secondary",
          currency: "USD",
          heartbeatStatus: "online",
          initialBalance: 100,
          currentBalance: 100,
          currentEquity: 145.5,
          totalProfit: 45.5,
          realizedPnl: 45.5,
          floatingPnl: 0,
          netDeposits: 0,
          today: 45.5,
          thisWeek: 45.5,
          thisMonth: 45.5,
          equityCurve: [],
        },
      },
      mt5Accounts: [
        {
          ...snapshot.mt5Accounts[0]!,
          id: "mt5-primary",
          accountNumber: "100200300",
          profit: 99,
        },
        {
          ...snapshot.mt5Accounts[0]!,
          id: "mt5-secondary",
          accountNumber: "200300400",
          profit: 0,
        },
      ],
    };
    const view = rtlRender(<App initialSnapshot={routeSnapshot} />, {
      wrapper: ({ children }) => (
        <MemoryRouter initialEntries={["/accounts/mt5-secondary/performance"]}>
          {children}
        </MemoryRouter>
      ),
    });

    const header = within(view.getByLabelText("Account performance"));
    // KPI amounts render without the currency symbol (currency shown in the label).
    expect(header.getAllByText(/45\.50/).length).toBeGreaterThanOrEqual(1);
  });

  test("account growth chart uses the focused account performance series", async () => {
    const routeSnapshot: DashboardSnapshot = {
      ...snapshot,
      accountPerformance: {
        accountId: "aggregate",
        currency: "USD",
        heartbeatStatus: "online",
        initialBalance: 300,
        currentBalance: 300,
        currentEquity: 300,
        totalProfit: 0,
        realizedPnl: 0,
        floatingPnl: 0,
        netDeposits: 0,
        today: 0,
        thisWeek: 0,
        thisMonth: 0,
        equityCurve: [],
      },
      accountPerformanceByAccount: {
        "mt5-secondary": {
          accountId: "mt5-secondary",
          currency: "USD",
          heartbeatStatus: "online",
          initialBalance: 100,
          currentBalance: 100,
          currentEquity: 145.5,
          totalProfit: 45.5,
          realizedPnl: 45.5,
          floatingPnl: 0,
          netDeposits: 0,
          today: 45.5,
          thisWeek: 45.5,
          thisMonth: 45.5,
          equityCurve: [
            { x: 1_779_292_800, equity: 100, drawdown: 0 },
            { x: 1_779_296_400, equity: 145.5, drawdown: 0 },
          ],
        },
      },
      mt5Accounts: [
        {
          ...snapshot.mt5Accounts[0]!,
          id: "mt5-primary",
          accountNumber: "100200300",
        },
        {
          ...snapshot.mt5Accounts[0]!,
          id: "mt5-secondary",
          accountNumber: "200300400",
        },
      ],
    };
    const view = rtlRender(<App initialSnapshot={routeSnapshot} />, {
      wrapper: ({ children }) => (
        <MemoryRouter initialEntries={["/accounts/mt5-secondary/performance"]}>
          {children}
        </MemoryRouter>
      ),
    });

    const chart = within(await view.findByLabelText("Account growth chart"));
    expect(chart.getByText(/2 samples/)).toBeTruthy();
    expect(chart.getByText(/\$45\.50/)).toBeTruthy();
  });

  test("account header shows last-known stale MT5 telemetry", () => {
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

    clickTab(view, "Performance");

    expect(view.getByText("EA OFFLINE")).toBeTruthy();
    expect(view.getByText(/12,345\.67/)).toBeTruthy();
    expect(view.queryByText("Balance")).toBeTruthy();
    expect(view.queryByText("Equity")).toBeTruthy();
    expect(view.queryByText("Trading P/L")).toBeTruthy();
    // The windowed P/L card still shows the real (closed-trade) PnL while the
    // stale balance/equity telemetry is suppressed.
    expect(view.getAllByText(/57\.89/).length).toBeGreaterThanOrEqual(1);
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
    expect((await view.findAllByText("Provider paused")).length).toBeGreaterThan(0);

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
    expect(view.queryByRole("heading", { name: "Provider monitoring" })).toBeNull();
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
      return fixtureResponse(url);
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
      return fixtureResponse(url);
    }) as typeof fetch;

    const view = render(<App initialSnapshot={snapshot} />);
    clickTab(view, "Providers");
    fireEvent.click(view.getByRole("button", { name: "Enable auto-copy for Alpha FX Signals" }));

    expect((await view.findAllByText("Provider paused")).length).toBeGreaterThan(0);
    const toggleCall = calls.find((call) => call.url === "/api/providers/provider-alpha");
    expect(toggleCall?.init?.method).toBe("PATCH");
    expect(JSON.parse(String(toggleCall?.init?.body))).toEqual({ enabled: true });
    expect(calls.some((call) => call.url === "/api/dashboard")).toBe(true);
  });

  test("removes a provider from the Providers page after confirmation", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return fixtureResponse(url);
    }) as typeof fetch;

    const view = render(<App initialSnapshot={snapshot} />);
    clickTab(view, "Providers");
    fireEvent.click(view.getByRole("button", { name: "Remove provider Alpha FX Signals" }));

    const dialog = await view.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /^Remove provider$/ }));

    await waitFor(() =>
      expect(
        calls.some(
          (call) => call.url === "/api/providers/provider-alpha" && call.init?.method === "DELETE",
        ),
      ).toBe(true),
    );
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
      return fixtureResponse(url);
    }) as typeof fetch;

    const view = render(<App initialSnapshot={snapshot} />);
    clickTab(view, "Providers");
    fireEvent.click(view.getByRole("button", { name: "Export provider performance" }));

    await waitFor(() =>
      expect(
        calls.some(
          (call) =>
            call.url === "/api/providers/performance/export.csv" && call.init?.method === "GET",
        ),
      ).toBe(true),
    );
  });

  test("keeps aggregate copy links read-only while exposing global provider monitoring", () => {
    const linkedSnapshot: DashboardSnapshot = {
      ...snapshot,
      providers: [{ ...snapshot.providers[0]!, enabled: true }],
      accountProviderLinks: [
        { accountId: "mt5-demo-1", providerId: "provider-alpha", enabled: true },
      ],
    };
    const view = render(<App initialSnapshot={linkedSnapshot} />);
    clickTab(view, "Providers");

    expect(
      view.getByText(/Aggregated performance, health, and global provider monitoring/),
    ).toBeTruthy();
    expect(view.getByRole("heading", { name: "Provider monitoring" })).toBeTruthy();
    expect(view.getByRole("button", { name: "Configure Alpha FX Signals" })).toBeTruthy();
    expect(
      view.queryByRole("button", {
        name: /Copy Alpha FX Signals|Stop copying Alpha FX Signals/,
      }),
    ).toBeNull();
  });

  test("scopes the Providers tab to the selected account with a copy toggle and per-account configure", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return fixtureResponse(url);
    }) as typeof fetch;

    const linkedSnapshot: DashboardSnapshot = {
      ...snapshot,
      providers: [{ ...snapshot.providers[0]!, enabled: true }],
      accountProviderLinks: [
        { accountId: "mt5-demo-1", providerId: "provider-alpha", enabled: true },
      ],
    };
    const view = rtlRender(<App initialSnapshot={linkedSnapshot} />, {
      wrapper: ({ children }) => (
        <MemoryRouter initialEntries={["/accounts/mt5-demo-1/providers"]}>{children}</MemoryRouter>
      ),
    });

    // Per-account mode: single Copy toggle + per-account Configure, no global Pause/Remove.
    expect(
      view.getByRole("button", { name: "Configure Alpha FX Signals for this account" }),
    ).toBeTruthy();
    const toggle = view.getByRole("button", {
      name: "Stop copying Alpha FX Signals on this account",
    });
    fireEvent.click(toggle);

    await waitFor(() => {
      const call = calls.find(
        (c) => c.url === "/api/account-provider-links/mt5-demo-1/provider-alpha",
      );
      expect(call?.init?.method).toBe("PUT");
      expect(JSON.parse(String(call?.init?.body))).toEqual({ enabled: false });
    });
  });

  test("saves a per-account provider config override from the account-scoped modal", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return fixtureResponse(url);
    }) as typeof fetch;

    const linkedSnapshot: DashboardSnapshot = {
      ...snapshot,
      providers: [{ ...snapshot.providers[0]!, enabled: true }],
      accountProviderLinks: [
        { accountId: "mt5-demo-1", providerId: "provider-alpha", enabled: true },
      ],
    };
    const view = rtlRender(<App initialSnapshot={linkedSnapshot} />, {
      wrapper: ({ children }) => (
        <MemoryRouter initialEntries={["/accounts/mt5-demo-1/providers"]}>{children}</MemoryRouter>
      ),
    });

    fireEvent.click(
      view.getByRole("button", { name: "Configure Alpha FX Signals for this account" }),
    );
    expect(view.queryByLabelText("Parser mode for Alpha FX Signals")).toBeNull();
    fireEvent.change(view.getByLabelText("Channel lot size for Alpha FX Signals"), {
      target: { value: "0.5" },
    });
    fireEvent.click(
      view.getByRole("button", { name: "Save provider settings for Alpha FX Signals" }),
    );

    await waitFor(() => {
      const call = calls.find(
        (c) => c.url === "/api/account-provider-links/mt5-demo-1/provider-alpha",
      );
      expect(call?.init?.method).toBe("PUT");
      const body = JSON.parse(String(call?.init?.body));
      expect(body.config).toMatchObject({ riskMode: "fixed", riskAmount: 0.5, lotSize: 0.5 });
    });
  });

  test("scopes Equity Guardian controls to the selected account", async () => {
    const view = rtlRender(
      <App
        initialSnapshot={{
          ...snapshot,
          equityGuardians: [
            {
              accountId: "mt5-demo-1",
              accountNumber: "100200300",
              threshold: 10,
              currentDrawdown: 2,
              paused: false,
              enabled: true,
              breaches: [],
            },
            {
              accountId: "mt5-live-2",
              accountNumber: "200300400",
              threshold: 12,
              currentDrawdown: 3,
              paused: false,
              enabled: true,
              breaches: [],
            },
          ],
        }}
      />,
      {
        wrapper: ({ children }) => (
          <MemoryRouter initialEntries={["/accounts/mt5-demo-1/equity-guardian"]}>
            {children}
          </MemoryRouter>
        ),
      },
    );
    const headings = view.getAllByRole("heading", { name: "Equity Guardian" });
    const guardianPanel = headings.at(-1)?.closest("section");
    if (!guardianPanel) throw new Error("Equity Guardian panel not found");

    expect(within(guardianPanel).getByText("100200300")).toBeTruthy();
    expect(within(guardianPanel).queryByText("200300400")).toBeNull();
  });

  test("lets the operator update provider parser mode and channel lot size from the modal", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return fixtureResponse(url);
    }) as typeof fetch;

    const view = render(<App initialSnapshot={snapshot} />);
    clickTab(view, "Providers");
    fireEvent.click(view.getByRole("button", { name: "Configure Alpha FX Signals" }));
    fireEvent.change(view.getByLabelText("Parser mode for Alpha FX Signals"), {
      target: { value: "aggressive" },
    });
    fireEvent.input(view.getByLabelText("Locked symbol for Alpha FX Signals"), {
      target: { value: "XAUUSD" },
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
      parserMode: "aggressive",
      lockedSymbol: "XAUUSD",
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

  test("shows simplified TP strategy options and normalizes prior-TP saves", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return fixtureResponse(url);
    }) as typeof fetch;

    const view = render(<App initialSnapshot={snapshot} />);
    clickTab(view, "Providers");
    fireEvent.click(view.getByRole("button", { name: "Configure Alpha FX Signals" }));

    const dialog = view.getByRole("dialog");
    const tp1Action = within(dialog).getByLabelText("TP1 strategy action") as HTMLSelectElement;
    const tp2Action = within(dialog).getByLabelText("TP2 strategy action") as HTMLSelectElement;

    expect(Array.from(tp1Action.options).map((option) => option.textContent)).toEqual([
      "Move SL to BE",
      "Leave SL unchanged",
    ]);
    expect(Array.from(tp2Action.options).map((option) => option.textContent)).toEqual([
      "Move SL to BE",
      "Move SL to prior TP",
      "Leave SL unchanged",
    ]);
    expect(within(dialog).queryByLabelText("TP2 strategy reference TP")).toBeNull();
    expect(within(dialog).queryByLabelText("TP2 strategy offset pips")).toBeNull();

    fireEvent.change(tp2Action, { target: { value: "set-sl-to-tp" } });
    fireEvent.click(
      view.getByRole("button", { name: "Save provider settings for Alpha FX Signals" }),
    );

    await waitFor(() => {
      const settingsCall = calls.find((call) => call.url === "/api/providers/provider-alpha");
      expect(settingsCall).toBeTruthy();
      const body = JSON.parse(String(settingsCall?.init?.body));
      expect(body.takeProfitLevels[1].strategy).toEqual({
        kind: "set-sl-to-tp",
        tpLeg: 1,
        offsetPips: 0,
      });
    });
  });

  test("preserves percent-risk amount when provider settings are saved without edits", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return fixtureResponse(url);
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
      return fixtureResponse(url);
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

  test("shows invalid TP totals while retaining the runner summary", () => {
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
    expect(modalText).toContain("TP percentages must total 100% (currently 60%).");
    expect(modalText).toContain("Runner remains open");
    expect(modalText).toContain("after TP3");
    expect(modalText).toContain("50% effective");
    expect(modalText).not.toContain("anything that isn't allocated");
    expect(modalText).not.toContain("final TP");
  });

  test("blocks provider save and test actions while TP allocation inputs are invalid", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return fixtureResponse(url);
    }) as typeof fetch;

    const view = render(<App initialSnapshot={snapshot} />);
    clickTab(view, "Providers");
    fireEvent.click(view.getByRole("button", { name: "Configure Alpha FX Signals" }));

    fireEvent.input(view.getByLabelText("TP1 percentage"), { target: { value: "0" } });
    fireEvent.input(view.getByLabelText("TP2 percentage"), { target: { value: "0" } });
    fireEvent.input(view.getByLabelText("TP3 percentage"), { target: { value: "0" } });
    fireEvent.input(view.getByLabelText("TP4 percentage"), { target: { value: "0" } });

    expect(view.getByRole("alert").textContent).toContain(
      "Enter a positive percentage for at least one TP.",
    );
    expect(
      view
        .getByRole("button", { name: "Save provider settings for Alpha FX Signals" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(
      view
        .getByRole("button", { name: "Test provider config for Alpha FX Signals" })
        .hasAttribute("disabled"),
    ).toBe(true);

    expect(calls.some((call) => call.url === "/api/providers/provider-alpha")).toBe(false);
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
      return fixtureResponse(url);
    }) as typeof fetch;

    const view = render(<App initialSnapshot={snapshot} />);
    clickTab(view, "Providers");
    fireEvent.click(view.getByRole("button", { name: "Configure Alpha FX Signals" }));
    fireEvent.change(view.getByLabelText("Parser mode for Alpha FX Signals"), {
      target: { value: "aggressive" },
    });
    fireEvent.input(view.getByLabelText("Locked symbol for Alpha FX Signals"), {
      target: { value: "XAUUSD" },
    });
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
      parserMode: "aggressive",
      lockedSymbol: "XAUUSD",
      riskMode: "fixed",
      riskAmount: 0.1,
    });
    expect(body.config.takeProfitLevels.map((level: { leg: number }) => level.leg)).toEqual([
      1, 2, 3, 4,
    ]);
  });

  test("saves other settings without sending a blank alert token", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return fixtureResponse(url);
    }) as typeof fetch;

    const view = render(
      <App
        initialSnapshot={{
          ...snapshot,
          appSettings: { ...snapshot.appSettings, alertBotConfigured: true },
        }}
      />,
    );
    clickSidebar(view, "Settings");
    expect(await view.findByText(/A bot token is configured/)).toBeTruthy();
    fireEvent.change(await view.findByLabelText("Default lot size"), {
      target: { value: "0.25" },
    });
    fireEvent.change(view.getByLabelText("Default risk percent"), { target: { value: "0.75" } });
    fireEvent.change(view.getByLabelText("Polling interval (seconds)"), {
      target: { value: "5" },
    });
    fireEvent.change(view.getByLabelText("Reporting currency"), { target: { value: "ZAR" } });
    fireEvent.change(view.getByLabelText("USD/ZAR rate"), { target: { value: "18.5" } });
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
      maxOpenTradeAgeSeconds: 0,
      allowedOrderTypes: ["MARKET"],
      drawdownWarnPct: 10,
      drawdownDangerPct: 20,
      reportingCurrency: "ZAR",
      usdZarRate: 18.5,
      alertChatId: "",
      alertOnGuardianPause: false,
      alertOnEaOffline: false,
      alertOnExecFailed: false,
      alertOnHeld: false,
      alertOnTelegramStall: false,
    });
    expect(JSON.parse(String(settingsCall?.init?.body))).not.toHaveProperty("alertBotToken");
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
    expect(view.container.querySelector(".settings-panel .account-thresholds-wrap")).toBeTruthy();
  });

  test("saves global and provider aliases and guards account mappings without a focused account", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return fixtureResponse(url);
    }) as typeof fetch;

    const view = render(<App initialSnapshot={snapshot} />);
    await clickTabAsync(view, "Symbol Settings");

    fireEvent.click(await view.findByRole("button", { name: "Add mapping" }));
    expect(view.getByRole("tab", { name: "Account" }).hasAttribute("disabled")).toBe(true);
    fireEvent.change(view.getByLabelText("Provider symbol"), { target: { value: "SILVER" } });
    fireEvent.change(view.getByLabelText("Canonical symbol"), {
      target: { value: "XAGUSD" },
    });
    fireEvent.click(view.getByRole("button", { name: "Save global alias" }));
    await waitFor(() =>
      expect(calls.filter((call) => call.url === "/api/symbol-mappings/aliases")).toHaveLength(1),
    );

    fireEvent.click(await view.findByRole("button", { name: "Add mapping" }));
    fireEvent.click(view.getByLabelText("Only for one provider"));
    fireEvent.change(view.getByLabelText("Provider symbol"), { target: { value: "METAL" } });
    fireEvent.change(view.getByLabelText("Canonical symbol"), { target: { value: "XAUUSD" } });
    fireEvent.click(view.getByRole("button", { name: "Save global alias" }));

    await waitFor(() =>
      expect(calls.filter((call) => call.url === "/api/symbol-mappings/aliases")).toHaveLength(2),
    );
    const aliasCalls = calls.filter((call) => call.url === "/api/symbol-mappings/aliases");
    expect(JSON.parse(String(aliasCalls[0]?.init?.body))).toEqual({
      scope: "global",
      rawSymbol: "SILVER",
      canonicalSymbol: "XAGUSD",
    });
    expect(JSON.parse(String(aliasCalls[1]?.init?.body))).toEqual({
      scope: "provider",
      providerId: "provider-alpha",
      rawSymbol: "METAL",
      canonicalSymbol: "XAUUSD",
    });
  });

  test("saves canonical inventory selection and omits untouched account rules", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return fixtureResponse(url);
    }) as typeof fetch;

    const view = rtlRender(
      <MemoryRouter initialEntries={["/accounts/mt5-demo-1/symbols"]}>
        <App initialSnapshot={snapshot} />
      </MemoryRouter>,
    );
    fireEvent.click(await view.findByRole("button", { name: "Add mapping" }));
    fireEvent.click(view.getByRole("tab", { name: "Account" }));
    expect(view.getByLabelText("Mapping account ID").hasAttribute("readonly")).toBe(true);
    fireEvent.input(view.getByLabelText("Account source symbol"), {
      target: { value: "XAGUSD" },
    });
    fireEvent.input(view.getByLabelText("Broker symbol for this account"), {
      target: { value: "XAUUSD.pro" },
    });
    fireEvent.input(view.getByLabelText("Mapping prefix"), { target: { value: "m." } });
    fireEvent.blur(view.getByLabelText("Mapping prefix"));
    fireEvent.click(view.getByRole("button", { name: "Save account mapping" }));

    await waitFor(() =>
      expect(calls.some((call) => call.url === "/api/symbol-mappings/account/mt5-demo-1")).toBe(
        true,
      ),
    );
    const mappingCall = calls.find(
      (call) => call.url === "/api/symbol-mappings/account/mt5-demo-1",
    );
    expect(JSON.parse(String(mappingCall?.init?.body))).toEqual({
      accountId: "mt5-demo-1",
      canonicalOverrides: { XAGUSD: "XAUUSD.pro" },
      prefix: "m.",
    });
  });

  test("saves account rules without creating a symbol override", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return fixtureResponse(url);
    }) as typeof fetch;

    const view = rtlRender(
      <MemoryRouter initialEntries={["/accounts/mt5-demo-1/symbols"]}>
        <App initialSnapshot={snapshot} />
      </MemoryRouter>,
    );
    fireEvent.click(await view.findByRole("button", { name: "Add mapping" }));
    fireEvent.click(view.getByRole("tab", { name: "Account" }));
    fireEvent.change(view.getByLabelText("Account source symbol"), {
      target: { value: "XAUUSD" },
    });
    fireEvent.input(view.getByLabelText("Mapping exclude symbols"), {
      target: { value: "US30.raw" },
    });
    fireEvent.blur(view.getByLabelText("Mapping exclude symbols"));
    fireEvent.click(view.getByRole("button", { name: "Save account mapping" }));

    await waitFor(() =>
      expect(calls.some((call) => call.url === "/api/symbol-mappings/account/mt5-demo-1")).toBe(
        true,
      ),
    );
    const mappingCall = calls.find(
      (call) => call.url === "/api/symbol-mappings/account/mt5-demo-1",
    );
    expect(JSON.parse(String(mappingCall?.init?.body))).toEqual({
      accountId: "mt5-demo-1",
      excludeSymbols: ["US30.raw"],
    });
  });

  test("saves direct provider-to-broker mappings from the account tab", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return fixtureResponse(url);
    }) as typeof fetch;

    const view = rtlRender(
      <MemoryRouter initialEntries={["/accounts/mt5-demo-1/symbols"]}>
        <App initialSnapshot={snapshot} />
      </MemoryRouter>,
    );
    fireEvent.click(await view.findByRole("button", { name: "Add mapping" }));
    fireEvent.click(view.getByRole("tab", { name: "Account" }));
    fireEvent.click(view.getByLabelText("Map from provider symbol"));
    const brokerInput = view.getByLabelText("Broker symbol for this account");
    fireEvent.input(brokerInput, { target: { value: "XAUUSD.pro" } });
    fireEvent.keyDown(brokerInput, { key: "Enter" });
    fireEvent.input(view.getByLabelText("Account source symbol"), { target: { value: "GOLD" } });
    fireEvent.click(view.getByRole("button", { name: "Save account mapping" }));

    await waitFor(() =>
      expect(calls.some((call) => call.url === "/api/symbol-mappings/account/mt5-demo-1")).toBe(
        true,
      ),
    );
    const mappingCall = calls.find(
      (call) => call.url === "/api/symbol-mappings/account/mt5-demo-1",
    );
    expect(JSON.parse(String(mappingCall?.init?.body))).toEqual({
      accountId: "mt5-demo-1",
      rawSymbol: "GOLD",
      brokerSymbol: "XAUUSD.pro",
      direct: true,
    });
  });

  test("validates required mapping fields before saving", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return fixtureResponse(url);
    }) as typeof fetch;

    const globalView = render(<App initialSnapshot={snapshot} />);
    await clickTabAsync(globalView, "Symbol Settings");
    fireEvent.click(await globalView.findByRole("button", { name: "Add mapping" }));
    expect(globalView.getByLabelText("Provider symbol").hasAttribute("required")).toBe(true);
    expect(globalView.getByLabelText("Canonical symbol").hasAttribute("required")).toBe(true);
    fireEvent.click(globalView.getByRole("button", { name: "Save global alias" }));
    globalView.unmount();

    const accountView = rtlRender(
      <MemoryRouter initialEntries={["/accounts/mt5-demo-1/symbols"]}>
        <App initialSnapshot={snapshot} />
      </MemoryRouter>,
    );
    fireEvent.click(await accountView.findByRole("button", { name: "Add mapping" }));
    fireEvent.click(accountView.getByRole("tab", { name: "Account" }));
    fireEvent.click(accountView.getByLabelText("Map from provider symbol"));
    expect(accountView.getByLabelText("Account source symbol").hasAttribute("required")).toBe(true);
    fireEvent.input(accountView.getByLabelText("Broker symbol for this account"), {
      target: { value: "XAUUSD.pro" },
    });
    fireEvent.click(accountView.getByRole("button", { name: "Save account mapping" }));

    expect(calls.some((call) => call.url.startsWith("/api/symbol-mappings/"))).toBe(false);
  });

  test("maps an unmapped alert through a canonical account override", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return fixtureResponse(url);
    }) as typeof fetch;
    const view = rtlRender(
      <MemoryRouter initialEntries={["/accounts/mt5-live-2/performance"]}>
        <App
          initialSnapshot={{
            ...snapshot,
            alerts: [
              {
                kind: "unmapped-symbols",
                severity: "warn",
                message: "GOLD is unmapped",
                accountId: "mt5-live-2",
                detail: {
                  token: "GOLD",
                  canonicalSymbol: "XAUUSD",
                  providerId: "provider-alpha",
                  providerTitle: "Alpha FX Signals",
                  accountId: "mt5-live-2",
                  accountLabel: "200300400",
                  blockedSignalCount: 1,
                  suggestedBrokerSymbol: "XAUUSD.raw",
                },
              },
            ],
          }}
        />
      </MemoryRouter>,
    );

    fireEvent.click(await view.findByText("1 operational alert"));
    fireEvent.click(view.getByRole("button", { name: "Map to XAUUSD.raw" }));

    await waitFor(() => expect(view.getByRole("dialog")).toBeTruthy());
    expect((view.getByLabelText("Account source symbol") as HTMLInputElement).value).toBe("XAUUSD");
    expect((view.getByLabelText("Broker symbol for this account") as HTMLInputElement).value).toBe(
      "XAUUSD.raw",
    );
    fireEvent.click(view.getByRole("button", { name: "Save account mapping" }));
    await waitFor(() =>
      expect(calls.some((call) => call.url === "/api/symbol-mappings/account/mt5-live-2")).toBe(
        true,
      ),
    );
    const mappingCall = calls.find(
      (call) => call.url === "/api/symbol-mappings/account/mt5-live-2",
    );
    expect(JSON.parse(String(mappingCall?.init?.body))).toEqual({
      accountId: "mt5-live-2",
      canonicalOverrides: { XAUUSD: "XAUUSD.raw" },
    });
    await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
  });

  test("deletes direct mappings through the account mapping endpoint", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return fixtureResponse(url);
    }) as typeof fetch;
    const directSnapshot: DashboardSnapshot = {
      ...snapshot,
      symbolMappings: [
        ...snapshot.symbolMappings,
        {
          rawSymbol: "GOLD DIRECT",
          canonicalSymbol: "XAUUSD",
          brokerSymbol: "XAUUSD.pro",
          status: "mapped",
          scope: "account · direct",
          accountId: "mt5-demo-1",
        },
      ],
    };

    const view = render(<App initialSnapshot={directSnapshot} />);
    await clickTabAsync(view, "Symbol Settings");
    const row = view.getByText("GOLD DIRECT").closest("tr");
    expect(row).toBeTruthy();
    fireEvent.click(within(row!).getByRole("button", { name: "Delete" }));

    const deleteCall = calls.find(
      (call) => call.url === "/api/symbol-mappings/account/mt5-demo-1/direct",
    );
    expect(deleteCall?.init?.method).toBe("DELETE");
    expect(JSON.parse(String(deleteCall?.init?.body))).toEqual({ rawSymbol: "GOLD DIRECT" });
  });

  test("lets the operator redact parser fixture text before saving", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return fixtureResponse(url);
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
    globalThis.fetch = (async (url: string | URL | Request, _init?: RequestInit) =>
      fixtureResponse(url)) as typeof fetch;
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
    globalThis.fetch = (async (url: string | URL | Request, _init?: RequestInit) =>
      fixtureResponse(url)) as typeof fetch;
    const view = render(<App initialSnapshot={{ ...snapshot, logicalTrades: [] }} />);
    await clickTabAsync(view, "History");
    clickTab(view, "Closed");
    expect(await view.findByText("No closed trades yet")).toBeTruthy();
  });

  test("History › Closed groups partial closes under a parent row and reveals per-leg detail on expand", () => {
    globalThis.fetch = (async (url: string | URL | Request, _init?: RequestInit) =>
      fixtureResponse(url)) as typeof fetch;
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
    globalThis.fetch = (async (url: string | URL | Request, _init?: RequestInit) =>
      fixtureResponse(url)) as typeof fetch;
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
    globalThis.fetch = (async (url: string | URL | Request, _init?: RequestInit) =>
      fixtureResponse(url)) as typeof fetch;
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
    globalThis.fetch = (async (url: string | URL | Request, _init?: RequestInit) =>
      fixtureResponse(url)) as typeof fetch;
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
    globalThis.fetch = (async (url: string | URL | Request, _init?: RequestInit) =>
      fixtureResponse(url)) as typeof fetch;
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

  test("renders the workspace and account navigation directly on phone widths", () => {
    const originalWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 375,
    });
    try {
      const view = render(<App initialSnapshot={snapshot} />);
      expect(view.queryByText("Use a larger screen")).toBeNull();
      expect(view.getByRole("heading", { name: /TG-TC/ })).toBeTruthy();
      const menu = view.getByRole("button", { name: "Open command palette" });
      expect(menu.textContent).toContain("Menu");
    } finally {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: originalWidth,
      });
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

  test("StatusBar shows last sync and keeps the app version on the brand tooltip", () => {
    const view = render(<App initialSnapshot={snapshot} />);
    expect(view.getByText("Last sync:")).toBeTruthy();
    expect(view.getByRole("heading", { name: "TG-TC · Operations" }).getAttribute("title")).toBe(
      `Version ${packageJson.version}`,
    );
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
      .find((el) => el.closest(".status-chip"))
      ?.closest(".status-chip");
    expect(telegramChip?.querySelector(".chip-dot")?.className).toContain("ok");
  });

  test("surfaces external manual MT5 positions in the History tab", () => {
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

    clickTab(view, "History");
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
      return fixtureResponse(url);
    }) as typeof fetch;

    const view = render(<App initialSnapshot={snapshot} />);

    expect(calls.some((call) => call.url.includes("/stats"))).toBe(false);
    clickTab(view, "Performance");
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

  test("held signals can be requeued in both modes or dismissed with lifecycle warnings", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const heldItem = {
      id: "held-1",
      heldReason: "GUARDIAN",
      accountId: "mt5-demo-1",
      providerId: "provider-alpha",
      commandType: "OPEN_TRADE",
      symbol: "EURUSD.raw",
      originalEntry: 1.085,
      currentPrice: 1.087,
      driftPct: 0.184,
      droppedLifecycleCount: 2,
      droppedLifecycle: ["MARK_TP_HIT", "MOVE_SL"],
      createdAt: "2026-07-11T08:00:00.000Z",
    };
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url) === "/api/queue-items/held") return Response.json({ items: [heldItem] });
      return fixtureResponse(url);
    }) as typeof fetch;

    const view = render(<App initialSnapshot={snapshot} />);
    await view.findByTitle("1 signal needs review");
    await clickTabAsync(view, "Logs");
    const heldPanel = within(view.getByTestId("held-signals-panel"));
    expect(heldPanel.getByText("GUARDIAN")).toBeTruthy();
    expect(heldPanel.getByText("2")).toBeTruthy();

    fireEvent.click(heldPanel.getByRole("button", { name: "Market" }));
    expect(view.getByText(/2 lifecycle commands arrived while held/)).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Requeue at market" }));
    await waitFor(() =>
      expect(
        calls.some(
          (call) =>
            call.url === "/api/queue-items/held-1/requeue" &&
            JSON.parse(String(call.init?.body)).mode === "market",
        ),
      ).toBe(true),
    );

    fireEvent.click(heldPanel.getByRole("button", { name: "Original" }));
    fireEvent.click(view.getByRole("button", { name: "Requeue original" }));
    await waitFor(() =>
      expect(
        calls.some(
          (call) =>
            call.url === "/api/queue-items/held-1/requeue" &&
            JSON.parse(String(call.init?.body)).mode === "original",
        ),
      ).toBe(true),
    );

    fireEvent.click(heldPanel.getByRole("button", { name: "Dismiss EURUSD.raw" }));
    fireEvent.click(view.getByRole("button", { name: "Dismiss signal" }));
    await waitFor(() =>
      expect(calls.some((call) => call.url === "/api/queue-items/held-1/dismiss")).toBe(true),
    );
  });

  test("waiting account slots can be deleted after confirmation", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return fixtureResponse(url);
    }) as typeof fetch;
    const view = render(
      <App
        initialSnapshot={{
          ...snapshot,
          accountSlots: [
            {
              id: "slot-retry",
              name: "Demo retry",
              linkCode: "ABC123",
              status: "waiting",
              accountNumber: "",
              server: "",
              createdAt: new Date().toISOString(),
            },
          ],
        }}
      />,
    );

    clickSidebar(view, "Linked Accounts");
    expect(await view.findByText(/Expires in 24h/)).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Delete slot Demo retry" }));
    fireEvent.click(view.getByRole("button", { name: "Delete slot" }));
    await waitFor(() => {
      const call = calls.find((item) => item.url === "/api/account-slots/slot-retry");
      expect(call?.init?.method).toBe("DELETE");
    });
  });

  test("guardian unpause prompt can unpause and requeue guardian-held trades", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url) === "/api/queue-items/held") {
        return Response.json({
          items: [
            {
              id: "held-guardian",
              heldReason: "GUARDIAN",
              accountId: "mt5-demo-1",
              providerId: "provider-alpha",
              commandType: "OPEN_TRADE",
              symbol: "EURUSD.raw",
              originalEntry: 1.085,
              currentPrice: 1.086,
              driftPct: 0.09,
              droppedLifecycleCount: 0,
              droppedLifecycle: [],
              createdAt: "2026-07-11T08:00:00.000Z",
            },
          ],
        });
      }
      return fixtureResponse(url);
    }) as typeof fetch;
    const view = render(
      <App
        initialSnapshot={{
          ...snapshot,
          equityGuardians: [
            {
              accountId: "mt5-demo-1",
              accountNumber: "100200300",
              threshold: 10,
              currentDrawdown: 12,
              paused: true,
              enabled: true,
              breaches: [],
            },
          ],
        }}
      />,
    );

    await view.findByTitle("1 signal needs review");
    await clickTabAsync(view, "Equity Guardian");
    fireEvent.click(view.getByRole("button", { name: "Unpause" }));
    expect(view.getByRole("button", { name: "Unpause only" })).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Unpause and requeue 1 held trade" }));

    await waitFor(() => {
      expect(calls.some((call) => call.url === "/api/equity-guardian/mt5-demo-1/unpause")).toBe(
        true,
      );
      const requeue = calls.find((call) => call.url === "/api/queue-items/held-guardian/requeue");
      expect(JSON.parse(String(requeue?.init?.body))).toEqual({ mode: "market" });
    });
  });

  test("Correct and push threads every parsed trade field into the manual modal", async () => {
    globalThis.fetch = (async (url: string | URL | Request, _init?: RequestInit) =>
      fixtureResponse(url)) as typeof fetch;
    const view = render(<App initialSnapshot={snapshot} />);

    await clickTabAsync(view, "Logs");
    fireEvent.click(view.getByRole("button", { name: "Correct & push" }));
    expect((view.getByLabelText("Account") as HTMLSelectElement).value).toBe("mt5-live-2");
    expect((view.getByLabelText("Account") as HTMLSelectElement).disabled).toBe(true);
    expect((view.getByLabelText("Symbol") as HTMLInputElement).value).toBe("XAUUSD.raw");
    expect((view.getByLabelText("Direction") as HTMLSelectElement).value).toBe("SELL");
    expect((view.getByLabelText("Order type") as HTMLSelectElement).value).toBe("STOP");
    expect((view.getByLabelText("Entry from") as HTMLInputElement).value).toBe("1.081");
    expect((view.getByLabelText("Entry to (optional)") as HTMLInputElement).value).toBe("1.082");
    expect((view.getByLabelText("Stop loss") as HTMLInputElement).value).toBe("1.09");
    expect((view.getByLabelText("Volume (lots)") as HTMLInputElement).value).toBe("0.25");
    expect((view.getByLabelText("Execution") as HTMLSelectElement).value).toBe("SPLIT_ORDER");
    expect((view.getByPlaceholderText("TP1 price") as HTMLInputElement).value).toBe("1.075");
    expect((view.getByPlaceholderText("TP2 price") as HTMLInputElement).value).toBe("1.07");
  });

  test("disables conflicting parser actions while approval is in flight and reflects approval", async () => {
    let resolveApproval: (response: Response) => void = () => {};
    const approval = new Promise<Response>((resolve) => {
      resolveApproval = resolve;
    });
    const calls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      const requestUrl = String(url);
      calls.push(requestUrl);
      if (requestUrl === "/api/signals/parse-1/approve") return approval;
      return fixtureResponse(url);
    }) as typeof fetch;
    const view = render(<App initialSnapshot={snapshot} />);

    await clickTabAsync(view, "Logs");
    fireEvent.click(view.getByRole("button", { name: "Approve" }));
    expect(view.getByRole("button", { name: "Approve" }).hasAttribute("disabled")).toBe(true);
    expect(view.getByRole("button", { name: "Ignore" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(view.getByRole("button", { name: "Ignore" }));
    expect(calls).not.toContain("/api/signals/parse-1/ignore");

    resolveApproval(Response.json({ status: "PENDING" }));
    expect(await view.findByText("APPROVED")).toBeTruthy();
    expect(view.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(view.queryByRole("button", { name: "Ignore" })).toBeNull();
  });

  test("keeps Parse recent busy and surfaces a provider parse failure", async () => {
    let resolveParse: (response: Response) => void = () => {};
    const parseResponse = new Promise<Response>((resolve) => {
      resolveParse = resolve;
    });
    globalThis.fetch = (async (url: string | URL | Request) => {
      if (String(url).includes("/parse-recent?limit=5")) return parseResponse;
      return fixtureResponse(url);
    }) as typeof fetch;
    const view = render(<App initialSnapshot={snapshot} />);

    await clickTabAsync(view, "Logs");
    fireEvent.click(view.getByRole("button", { name: "Parse recent" }));
    expect(view.getByRole("button", { name: "Parsing…" }).hasAttribute("disabled")).toBe(true);

    resolveParse(
      Response.json({
        parsed: [],
        provider: {
          providerId: "provider-alpha",
          captured: 0,
          inserted: 0,
          parsed: 0,
          error: "Telegram fetch failed",
        },
      }),
    );
    expect(await view.findByText(/Telegram fetch failed/)).toBeTruthy();
  });

  test("Settings sends alert tests and shows the returned database backup filename", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url) === "/api/admin/backup") {
        return Response.json({ filename: "telegram-tc-2026-07-11T120000Z.db" });
      }
      return fixtureResponse(url);
    }) as typeof fetch;
    const view = render(<App initialSnapshot={snapshot} />);

    clickSidebar(view, "Settings");
    fireEvent.click(await view.findByRole("button", { name: "Send test message" }));
    await waitFor(() =>
      expect(calls.some((call) => call.url === "/api/admin/alert-test")).toBe(true),
    );
    fireEvent.click(view.getByRole("button", { name: "Back up database now" }));
    expect(await view.findByText("telegram-tc-2026-07-11T120000Z.db")).toBeTruthy();
    const backupCall = calls.find((call) => call.url === "/api/admin/backup");
    expect(backupCall?.init?.method).toBe("POST");
  });

  test("History resolves an out-of-sync trade through the pinned action contract", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return fixtureResponse(url);
    }) as typeof fetch;
    const view = render(
      <App
        initialSnapshot={{
          ...snapshot,
          logicalTrades: [
            {
              ...snapshot.logicalTrades[0]!,
              status: "OUT_OF_SYNC",
              outOfSyncReason: "Candidate broker position found",
              matchedBrokerTickets: ["70001"],
            },
          ],
        }}
      />,
    );

    await clickTabAsync(view, "History");
    fireEvent.click(view.getByText("Resolve"));
    fireEvent.click(view.getByRole("button", { name: "Re-adopt position" }));
    fireEvent.click(view.getByRole("button", { name: "Re-adopt broker position" }));
    await waitFor(() => {
      const call = calls.find((item) => item.url === "/api/trades/trade-1/resolve");
      expect(call?.init?.method).toBe("POST");
      expect(JSON.parse(String(call?.init?.body))).toEqual({ action: "readopt" });
    });
  });
});
