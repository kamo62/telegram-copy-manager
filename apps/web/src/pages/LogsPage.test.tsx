import "../test-setup";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import type { DashboardSnapshot } from "../App";
import { LogsPage } from "./LogsPage";

afterEach(() => cleanup());

describe("LogsPage", () => {
  test("keeps the last parser rows visible when refresh fails", () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async () => Response.json({ logs: [] })) as unknown as typeof fetch;

    const snapshot = {
      providers: [],
      mt5Accounts: [],
      parserResults: [
        {
          id: "parse-1",
          providerTitle: "Alpha",
          rawText: "BUY EURUSD",
          commandType: "OPEN_TRADE",
          canonicalSymbol: "EURUSD",
          brokerSymbol: "EURUSD.raw",
          mappingStatus: "mapped",
          confidence: 0.9,
          reviewRequired: false,
        },
      ],
      parserFixtures: [],
      signalQueue: [],
      executionLogs: [],
    } as unknown as DashboardSnapshot;

    try {
      const view = render(
        <LogsPage
          aiReviewStatus={{}}
          dashboardLoadError
          fixtureClassifications={{}}
          fixtureStatus={{}}
          heldItems={[]}
          onAiReview={() => {}}
          onApprove={() => {}}
          onClassify={() => {}}
          onForcePush={() => {}}
          onHeldDismiss={() => {}}
          onHeldDismissAll={() => {}}
          onHeldRequeue={() => {}}
          onIgnore={() => {}}
          onParseRecent={() => {}}
          onParserTabChange={() => {}}
          onRedactedChange={() => {}}
          onSaveFixture={() => {}}
          parseRecentBusy={false}
          parseRecentResults={[]}
          parserActionPending={{}}
          parserActionStatus={{}}
          parserLoading={false}
          parserTab="Recent Parses"
          providersLength={0}
          redactedFixtureText={{}}
          snapshot={snapshot}
        />,
      );

      expect(view.getByText("Refresh failed; showing last loaded results.")).toBeTruthy();
      expect(view.getByText("BUY EURUSD")).toBeTruthy();
      expect(view.queryByText("ParseLab could not be loaded. Retry refresh.")).toBeNull();
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});
